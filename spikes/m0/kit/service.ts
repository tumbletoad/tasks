// The stand-in service of the M0 spike kit (A7 3.7, M0.02): a user-only Unix socket or named pipe
// with the `ttasks-local/1` handshake (A2 3.6), a stub MCP endpoint in mcp mode, rpc methods for
// the shims and the lab, and the browser listener of A2 3.8 with its token bootstrap, a WebSocket
// echo and a fixture-only Reveal action. It exercises the real OS mechanisms at spike level. It is
// not the protocol.
//
// Every event goes to `<state>/events.jsonl`: kinds, methods, routes and statuses, never tokens,
// codes, tickets, briefs or task text.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, extname, join, sep } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { STUB_INSTRUCTIONS, STUB_TOOLS, createMcpResponder, textResult } from "./mcp-stub.ts";
import { APP_JS, indexHtml } from "./page.ts";
import { assertPrivate, isPrivateDir, setUserOnlyAcl, type InspectOptions } from "./perms.ts";
import {
  KitError,
  LineReader,
  PROTOCOL,
  SPACE_ID,
  SPIKE_BUILD,
  SPIKE_VERSION,
  asObject,
  b64url,
  bindMac,
  boundMac,
  clientProof,
  httpProbeProof,
  nonce,
  parseObject,
  sameText,
  serverProof,
  sessionKey,
  sha256Hex,
  textOf,
  transcript,
  writeLine,
  type HandshakeIds,
  type Json,
  type JsonObject,
  type ServiceInfo,
} from "./wire.ts";
import { acceptWebSocket } from "./ws.ts";
import { E01_TOOLS, TOOL_NAME, buildSnapshot, inheritedSnapshot } from "./snapshot.ts";

export interface KitEvent {
  [key: string]: Json;
  t: number;
  kind: string;
}

/**
 * Where the Unix socket lives (A2 3.2.1): `auto` uses `/run/user/<uid>/ttasks-<install>/` when that
 * per-user runtime folder exists and is private, else `<state>/run/`. `run-user` and `state` force
 * one, so row E02 can run against both.
 */
export type SocketDirChoice = "auto" | "run-user" | "state";

export interface RevealResult {
  /** The program that was started, for the report. */
  opener: string;
  ok: boolean;
}

export interface ServiceOptions {
  /** The state folder. Created user-only when missing, refused when another user can open it. */
  state: string;
  /** The HTTP port to try first. Busy: an OS-chosen port, and `http.moved` is true. */
  port?: number;
  socketDir?: SocketDirChoice;
  /** The folder that holds the per-user runtime folders. `/run/user` except in tests. */
  runUserBase?: string;
  /** A `kit tree` container whose folders the page may reveal. Default: `<state>/scratch/`. */
  tree?: string;
  /**
   * A built spike UI folder (`spikes/m0/ui`, step M0.08): its `index.html` is served at `/` in
   * place of the kit's own page, with the per-response nonce filled in, and its hashed files under
   * `/assets/`. The CSP is the same either way.
   */
  ui?: string;
  /** Opens a folder in the file manager. The self-test passes a fake, so no window opens. */
  opener?: (dir: string) => Promise<RevealResult>;
  onEvent?: (event: KitEvent) => void;
  /** Tests only: how the Windows permission check runs (see perms.ts `InspectOptions`). */
  inspect?: InspectOptions;
  /**
   * Tests only: delays the reply to an RPC method by this many ms (a slow service, finding D).
   * Called with "tasks/bind" for the handshake's bind reply (a slow handshake, M0.07 review).
   */
  replyDelayMs?: (method: string) => number;
}

export interface RunningService {
  info: ServiceInfo;
  key: Buffer;
  events: KitEvent[];
  /** Resolves once the service has closed, for any reason. */
  closed: Promise<void>;
  close(): Promise<void>;
}

class RpcError extends Error {
  readonly code: number;
  readonly text: string;
  constructor(code: number, message: string, text: string = message) {
    super(message);
    this.code = code;
    this.text = text;
  }
}

const notPermitted = () => new RpcError(-32003, "not_permitted");
const cpuMsSince = (start: NodeJS.CpuUsage): number => {
  const used = process.cpuUsage(start);
  return Math.round((used.user + used.system) / 1000);
};
const now = () => performance.timeOrigin + performance.now();
const hash = (secret: string) => sha256Hex(secret);

interface Ticket {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  title: string;
  /** A background run (A4 3.11): only `kit run-shim` may claim it. */
  run: boolean;
  /** The run's brief, written to the agent's stdin. Never logged. */
  brief: string;
  expires: number;
  claimed: boolean;
}

const CSP_BASE =
  "default-src 'self'; script-src 'self'; img-src 'self' data:; worker-src 'none'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; " +
  "require-trusted-types-for 'script'";

/** On Linux, the UID that owns the peer's end of a loopback TCP connection (A2 3.8.4). */
function peerUid(socket: net.Socket): number | undefined {
  const peerPort = socket.remotePort;
  const ourPort = socket.localPort;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const row of text.split("\n").slice(1)) {
      const cols = row.trim().split(/\s+/);
      const local = cols[1]?.split(":")[1];
      const remote = cols[2]?.split(":")[1];
      if (local === undefined || remote === undefined || cols[7] === undefined) continue;
      if (parseInt(local, 16) === peerPort && parseInt(remote, 16) === ourPort) {
        return Number(cols[7]);
      }
    }
  }
  return undefined;
}

/** Takes the service lock as A2 3.4 does: an exclusive SQLite transaction held for life. */
function takeLock(state: string): DatabaseSync {
  const lock = new DatabaseSync(join(state, "service.lock"));
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch {
    lock.close();
    throw new KitError("locked", "A stand-in service already runs for this state folder.");
  }
  return lock;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

async function readJsonBody(req: http.IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new RpcError(413, "body_too_large");
    chunks.push(chunk);
  }
  const body = parseObject(Buffer.concat(chunks).toString("utf8"));
  if (body === undefined) throw new RpcError(400, "bad_json");
  return body;
}

/** The `Sec-Fetch-Site` rule of A2 3.8.3, for `/api/*` requests and WebSocket upgrades alike. */
export function crossSite(req: http.IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site !== undefined && site !== "same-origin" && site !== "none";
}

/**
 * Picks the socket folder (A2 3.2.1). The per-user runtime folder comes from the UID, never from
 * XDG_RUNTIME_DIR (A2 3.2.2 rule 2). `usable` says whether `<base>/<uid>` may hold it.
 */
export function selectSocketDir(options: {
  choice: SocketDirChoice;
  state: string;
  install: string;
  uid: number | undefined;
  runUserBase: string;
  usable: (dir: string) => boolean;
}): { dir: string; kind: "run-user" | "state" } {
  const { choice, state, install, uid, runUserBase, usable } = options;
  const fallback = { dir: join(state, "run"), kind: "state" as const };
  if (choice === "state") return fallback;
  const userDir = uid === undefined ? undefined : join(runUserBase, String(uid));
  const ok = userDir !== undefined && usable(userDir);
  if (ok) return { dir: join(userDir, `ttasks-${install}`), kind: "run-user" };
  if (choice === "run-user") {
    throw new KitError(
      "runtime_dir_unavailable",
      `The per-user runtime folder ${userDir ?? `${runUserBase}/<uid>`} is missing or not private.`,
    );
  }
  return fallback;
}

/** Opens a folder in the file manager: Explorer, or GNOME's `gio open` with `xdg-open` after it. */
export function openFolder(dir: string): Promise<RevealResult> {
  const candidates: [string, string[]][] =
    process.platform === "win32"
      ? [[join(process.env["SystemRoot"] ?? "C:\\Windows", "explorer.exe"), [dir]]]
      : process.platform === "darwin"
        ? [["open", [dir]]]
        : [
            ["gio", ["open", dir]],
            ["xdg-open", [dir]],
          ];
  const attempt = (index: number): Promise<RevealResult> => {
    const entry = candidates[index];
    if (entry === undefined) return Promise.resolve({ opener: "none", ok: false });
    const [file, args] = entry;
    return new Promise((resolve) => {
      const child = spawn(file, args, { detached: true, stdio: "ignore", shell: false });
      child.once("error", () => {
        resolve(attempt(index + 1));
      });
      child.once("spawn", () => {
        child.unref();
        resolve({ opener: file.split(/[\\/]/).at(-1) ?? file, ok: true });
      });
    });
  };
  return attempt(0);
}

/** The folders the page may reveal: those of a `kit tree` container, or `<state>/scratch/`. */
function revealTargets(state: string, tree: string | undefined): { label: string; dir: string }[] {
  if (tree === undefined) {
    const dir = join(state, "scratch");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return [{ label: "scratch", dir }];
  }
  const root = realpathSync.native(tree);
  const listed = parseObject(readFileSync(join(root, "tree.json"), "utf8")) ?? {};
  const targets: { label: string; dir: string }[] = [];
  for (const [label, path] of Object.entries(listed)) {
    if (typeof path !== "string" || !existsSync(path) || !statSync(path).isDirectory()) continue;
    const real = realpathSync.native(path);
    if (real === root || real.startsWith(root + sep)) targets.push({ label, dir: real });
  }
  return targets;
}

/** The placeholder the spike UI's `index.html` carries where the per-response nonce goes. */
export const UI_NONCE_PLACEHOLDER = "__TTASKS_NONCE__";

/** Media types of the files a built spike UI holds. Anything else is not served. */
export const UI_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

interface SpikeUi {
  index: string;
  /** Files by URL path: `/assets/<name>` and the root files of the build. */
  files: Map<string, { path: string; type: string }>;
}

/** Reads a built spike UI folder once, at start. Only plain files with a known type are served. */
function loadSpikeUi(dir: string): SpikeUi {
  const root = realpathSync.native(dir);
  const index = readFileSync(join(root, "index.html"), "utf8");
  if (!index.includes(UI_NONCE_PLACEHOLDER)) {
    throw new KitError("ui_invalid", `${join(root, "index.html")} has no nonce placeholder.`);
  }
  const files = new Map<string, { path: string; type: string }>();
  const add = (folder: string, prefix: string) => {
    if (!existsSync(folder)) return;
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const type = UI_TYPES[extname(name)];
      if (type !== undefined && statSync(path).isFile())
        files.set(`${prefix}${name}`, { path, type });
    }
  };
  add(root, "/");
  add(join(root, "assets"), "/assets/");
  return { index, files };
}

export async function startService(options: ServiceOptions): Promise<RunningService> {
  const { state } = options;
  const spikeUi = options.ui === undefined ? undefined : loadSpikeUi(options.ui);
  const created = !existsSync(state);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const keyPath = join(state, "ipc.key");

  // A2 3.2.2 rule 5 and A6 3.16.6: refuse a state folder or key another user can open, before
  // anything else is written. A folder the service creates gets a user-only ACL on Windows.
  const userSid = assertPrivate(
    [
      ...(created ? [] : [{ path: state, kind: "dir" as const, what: "state folder" }]),
      { path: keyPath, kind: "key", what: "key" },
    ],
    options.inspect,
  );
  if (created && userSid !== undefined) setUserOnlyAcl(state, userSid, "dir");
  const targets = revealTargets(state, options.tree);

  const lock = takeLock(state);
  let key: Buffer;
  try {
    if (!existsSync(keyPath)) {
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
      if (userSid !== undefined) setUserOnlyAcl(keyPath, userSid, "key");
    }
    key = readFileSync(keyPath);
  } catch (error) {
    lock.close();
    throw error;
  }
  const instance = b64url(randomBytes(16));
  const install = sha256Hex(realpathSync.native(state)).slice(0, 16);
  const events: KitEvent[] = [];
  const eventsPath = join(state, "events.jsonl");

  const emit = (kind: string, fields: JsonObject = {}, t = now()) => {
    const event: KitEvent = { t, kind, ...fields };
    events.push(event);
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    options.onEvent?.(event);
  };

  // --- Endpoint (A2 3.2.1, 3.4 endpoint exclusivity, 3.6.1)
  let endpoint: ServiceInfo["endpoint"];
  let runtime: "run-user" | "state" | "pipe" = "pipe";
  try {
    if (process.platform === "win32") {
      endpoint = { kind: "pipe", path: `\\\\.\\pipe\\ttasks-spike-${install}-${instance}` };
    } else {
      const choice = options.socketDir ?? "auto";
      const selected = selectSocketDir({
        choice: process.platform === "linux" || choice !== "auto" ? choice : "state",
        state,
        install,
        uid: process.getuid?.(),
        runUserBase: options.runUserBase ?? "/run/user",
        usable: isPrivateDir,
      });
      runtime = selected.kind;
      mkdirSync(selected.dir, { recursive: true, mode: 0o700 });
      assertPrivate([{ path: selected.dir, kind: "dir", what: "socket folder" }], options.inspect);
      const path = join(selected.dir, "ttasks.sock");
      if (Buffer.byteLength(path) > 100) {
        throw new KitError("socket_path_too_long", `Socket path too long: ${path}`);
      }
      // We hold the lock and the folder is ours, so a socket file at our path is stale (A2 3.4).
      rmSync(path, { force: true });
      endpoint = { kind: "unix", path };
    }
  } catch (error) {
    lock.close();
    throw error;
  }

  const codes = new Map<string, { expires: number }>();
  const tokens = new Map<string, { session: string }>();
  const wsTickets = new Map<string, number>();
  const tickets = new Map<string, Ticket>();
  /** Run shims by run reference, for `spike.cancel_run` (A4 3.11.8 step 1). */
  const runs = new Map<string, net.Socket>();
  const sockets = new Set<net.Socket | Duplex>();
  const opener = options.opener ?? openFolder;
  let redeemWindow = { start: Date.now(), count: 0 };
  let port = 0;
  let closing: Promise<void> | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  // Row B05: event-loop delay and CPU since start or the last `spike.loop_reset`, reported by
  // `service/status`, so the lab can see a stall over 100 ms while bridges hammer the service.
  const LOOP_RESOLUTION_MS = 10;
  const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loop.enable();
  let loopSince = { at: now(), cpu: process.cpuUsage() };
  const nsToMs = (ns: number) => Math.round((Number.isFinite(ns) ? ns : 0) / 1e4) / 100;

  /** The numbers and short labels a shim may report. Nothing else reaches the event log. */
  function reported(params: JsonObject): JsonObject {
    const fields: JsonObject = {};
    for (const name of [
      "run",
      "pid",
      "pgid",
      "code",
      "signal",
      "duration_ms",
      "reason",
      "stdout_lines",
      "method",
      "status",
    ]) {
      const value = params[name];
      if (typeof value === "number" || value === null || typeof value === "boolean") {
        fields[name] = value;
      } else if (typeof value === "string") fields[name] = value.slice(0, 40);
    }
    return fields;
  }

  // --- rpc mode (A2 3.6.4) and the spike's own methods
  function rpc(
    method: string,
    params: JsonObject,
    kind: string,
    socket: net.Socket,
    received: number,
  ): Json | Promise<Json> {
    switch (method) {
      case "service/status":
        return {
          instance,
          install,
          pid: process.pid,
          port,
          protocol: PROTOCOL,
          runtime,
          uptime_ms: Math.round(process.uptime() * 1000),
          connections: sockets.size,
          memory: { rss: process.memoryUsage.rss() },
          loop: {
            since_ms: Math.round(now() - loopSince.at),
            samples: loop.count,
            max_ms: nsToMs(loop.max),
            p99_ms: nsToMs(loop.percentile(99)),
            mean_ms: nsToMs(loop.mean),
            cpu_ms: cpuMsSince(loopSince.cpu),
            // max_ms and the others are the raw histogram: they include this resolution.
            resolution_ms: LOOP_RESOLUTION_MS,
          },
        };
      case "spike.loop_reset":
        // B05: start a new event-loop window at the start of a burst.
        if (kind !== "cli") throw notPermitted();
        loop.reset();
        loopSince = { at: now(), cpu: process.cpuUsage() };
        return { ok: true };
      case "service/shutdown":
        if (kind !== "cli") throw notPermitted();
        setImmediate(() => void close());
        return { ok: true };
      case "ui/mint_code": {
        if (kind !== "cli") throw notPermitted();
        const code = b64url(randomBytes(32));
        codes.set(hash(code), { expires: Date.now() + 60_000 });
        return { code, port };
      }
      case "spike.mint_ticket": {
        if (kind !== "cli") throw notPermitted();
        const argv = params["argv"];
        const cwd = params["cwd"];
        if (
          !Array.isArray(argv) ||
          argv.length === 0 ||
          !argv.every((a) => typeof a === "string")
        ) {
          throw new RpcError(-32602, "argv must be a non-empty list of strings");
        }
        if (typeof cwd !== "string") throw new RpcError(-32602, "cwd must be a folder");
        const env = asObject(params["env"]) ?? {};
        const ticket = `kt_${b64url(randomBytes(24))}`;
        const run = params["run"] === true;
        tickets.set(hash(ticket), {
          argv,
          cwd: realpathSync.native(cwd),
          env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, textOf(v)])),
          title: typeof params["title"] === "string" ? params["title"] : "Tasks launch",
          run,
          brief: typeof params["brief"] === "string" ? params["brief"].slice(0, 64_000) : "",
          expires: Date.now() + 120_000,
          claimed: false,
        });
        emit("ticket", { ticket: hash(ticket).slice(0, 12), run });
        return { ticket, run: run ? hash(ticket).slice(0, 12) : null };
      }
      case "spike.spawn": {
        // Starts a process for the lab (a terminal command line, a scope or a detached run:
        // rows L01, S01, S04). Never through a shell.
        if (kind !== "cli") throw notPermitted();
        const argv = params["argv"];
        if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string") || !argv[0]) {
          throw new RpcError(-32602, "argv must be a non-empty list of strings");
        }
        const [file, ...args] = argv;
        const cwd = typeof params["cwd"] === "string" ? params["cwd"] : state;
        const detached = params["detached"] === true;
        const child = spawn(file, args, {
          cwd,
          detached,
          stdio: "ignore",
          shell: false,
          windowsHide: params["hidden"] === true,
        });
        child.on("error", () => {
          emit("spawn_failed");
        });
        child.unref();
        emit("spawn", { pid: child.pid ?? null, detached });
        return { pid: child.pid ?? null };
      }
      case "spike.cancel_run": {
        // A4 3.11.8 step 1: the service sends `cancel` to the run shim over its connection.
        if (kind !== "cli") throw notPermitted();
        const run = params["run"];
        const shim = typeof run === "string" ? runs.get(run) : undefined;
        if (shim === undefined || typeof run !== "string") {
          throw new RpcError(-32602, "unknown_run", "No run shim is attached for that run.");
        }
        writeLine(shim, { jsonrpc: "2.0", method: "cancel", params: { run } });
        emit("cancel_sent", { run });
        return { sent: true };
      }
      case "spike.env_snapshot": {
        // E01 (A4 3.8): the environment this service would build for an agent, and what its own
        // inherited environment finds. Counts, times and found or not found only.
        if (kind !== "cli") throw notPermitted();
        const extra = Array.isArray(params["tools"]) ? params["tools"] : [];
        const tools = [...E01_TOOLS];
        for (const name of extra) {
          if (typeof name !== "string" || !TOOL_NAME.test(name)) {
            throw new RpcError(-32602, "tools must be short command names");
          }
          if (!tools.includes(name)) tools.push(name);
        }
        emit("env_snapshot");
        return buildSnapshot({ tools }).then((built) => ({
          built: { ...built },
          inherited: { ...inheritedSnapshot(tools) },
        })) as Promise<Json>;
      }
      case "launch.claim": {
        // A4 3.6.3 step 3: one claim per ticket, within its window. `received` is the moment the
        // claim arrived, before any logging, so B07 does not time the event log's disk write.
        if (kind !== "shim") throw notPermitted();
        const ticket = params["ticket"];
        const record = typeof ticket === "string" ? tickets.get(hash(ticket)) : undefined;
        const role = params["role"] === "run" ? "run" : "shim";
        if (
          record === undefined ||
          record.claimed ||
          Date.now() > record.expires ||
          record.run !== (role === "run")
        ) {
          emit("claim_refused");
          throw new RpcError(
            1001,
            "launch_expired",
            "This launch expired. Press Open again in TTasks.",
          );
        }
        record.claimed = true;
        const tag = hash(ticket as string).slice(0, 12);
        emit("claim", { ticket: tag, role, pid: params["pid"] ?? null }, received);
        return {
          argv: record.argv,
          cwd: record.cwd,
          env: record.env,
          title: record.title,
          after_exit: "close",
          protocol: PROTOCOL,
          credential: b64url(randomBytes(32)),
          ...(record.run ? { run: tag, brief: record.brief } : {}),
        };
      }
      case "launch.started":
      case "launch.settled":
      case "launch.exited":
      case "launch.failed":
      case "run.started":
      case "run.attach":
      case "run.cancel":
      case "run.signal":
      case "run.exited": {
        // A4 3.6.3 and 3.11. `run.attach` re-registers a run shim after a service restart (A4
        // 3.11.9). At spike level it carries no credential: the product checks one.
        if (kind !== "shim") throw notPermitted();
        const fields = reported(params);
        const run = params["run"];
        if (typeof run === "string" && (method === "run.started" || method === "run.attach")) {
          runs.set(run, socket);
        }
        if (typeof run === "string" && method === "run.exited") runs.delete(run);
        emit(method, fields);
        return {};
      }
      default:
        throw new RpcError(-32601, "Method not found");
    }
  }

  function serveRpc(socket: net.Socket, reader: LineReader, kind: string): void {
    reader.pipe((line) => {
      const received = now();
      const msg = parseObject(line);
      const method = msg?.["method"];
      if (msg === undefined || typeof method !== "string") return;
      const id = msg["id"];
      emit("rpc", { method: method.slice(0, 60) });
      const delay = options.replyDelayMs?.(method) ?? 0;
      const reply = (message: JsonObject) => {
        if (delay <= 0) writeLine(socket, message);
        else
          setTimeout(() => {
            if (!socket.destroyed) writeLine(socket, message);
          }, delay);
      };
      const failed = (error: unknown) => {
        if (id === undefined) return;
        const e = error instanceof RpcError ? error : new RpcError(-32603, "internal_error");
        reply({
          jsonrpc: "2.0",
          id,
          error: { code: e.code, message: e.message, data: { text: e.text } },
        });
      };
      try {
        const result = rpc(method, asObject(msg["params"]) ?? {}, kind, socket, received);
        if (result instanceof Promise) {
          // An rpc method that takes time (spike.env_snapshot) answers when it is done.
          result.then((value) => {
            if (id !== undefined) reply({ jsonrpc: "2.0", id, result: value });
          }, failed);
        } else if (id !== undefined) reply({ jsonrpc: "2.0", id, result });
      } catch (error) {
        failed(error);
      }
    });
    socket.once("close", () => {
      for (const [run, holder] of runs) if (holder === socket) runs.delete(run);
    });
  }

  function serveMcp(socket: net.Socket, reader: LineReader, context: JsonObject): void {
    const respond = createMcpResponder({
      name: "ttasks-stand-in",
      instructions: STUB_INSTRUCTIONS,
      tools: STUB_TOOLS,
      call: (name, args) =>
        name === "echo"
          ? textResult(typeof args["text"] === "string" ? args["text"] : "")
          : textResult(JSON.stringify({ service: "stand-in", space: SPACE_ID, instance })),
      onRequest: (info) => {
        emit("mcp", { method: info.method, era: info.era, version: info.version });
      },
    });
    const init = asObject(context["mcp_init"]);
    if (init !== undefined) respond(init); // A2 3.6.4: rebuild state, no reply.
    reader.pipe((line) => {
      const msg = parseObject(line);
      if (msg === undefined) {
        writeLine(socket, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }
      const reply = respond(msg);
      if (reply !== null) writeLine(socket, reply);
    });
  }

  // --- The handshake, server side (A2 3.6.3)
  function refuse(socket: net.Socket, reason: string): void {
    emit("handshake_refused", { reason });
    setTimeout(() => socket.destroy(), 200);
  }

  async function serveConnection(socket: net.Socket): Promise<void> {
    const reader = new LineReader(socket);
    reader.onTooLarge = () => {
      socket.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "frame_too_large" } })}\n`,
      );
    };
    const ns = nonce();
    writeLine(socket, {
      jsonrpc: "2.0",
      method: "tasks/challenge",
      params: { nonce: ns, instance, protocols: [PROTOCOL] },
    });
    const hello = parseObject(await reader.next());
    const hp = asObject(hello?.["params"]);
    const mode = hp?.["mode"];
    if (
      hello?.["method"] !== "tasks/hello" ||
      hello["id"] !== 0 ||
      hp?.["protocol"] !== PROTOCOL ||
      (mode !== "rpc" && mode !== "mcp") ||
      typeof hp["nonce"] !== "string" ||
      typeof hp["proof"] !== "string"
    ) {
      refuse(socket, "bad_hello");
      return;
    }
    const ids: HandshakeIds = { instance, protocol: PROTOCOL, mode, ns, nc: hp["nonce"] };
    if (!sameText(hp["proof"], clientProof(key, ids))) {
      refuse(socket, "bad_proof");
      return;
    }
    writeLine(socket, { jsonrpc: "2.0", id: 0, result: { proof: serverProof(key, ids) } });

    const bind = parseObject(await reader.next());
    const bp = asObject(bind?.["params"]);
    if (
      bind?.["method"] !== "tasks/bind" ||
      bind["id"] !== 1 ||
      bp === undefined ||
      bp["protocol"] !== ids.protocol ||
      bp["mode"] !== ids.mode
    ) {
      refuse(socket, "bad_bind");
      return;
    }
    const { mac, ...body } = bp;
    const t = transcript(ids, [PROTOCOL], body);
    const ks = sessionKey(key, ids);
    if (typeof mac !== "string" || !sameText(mac, bindMac(ks, t))) {
      refuse(socket, "bad_bind_mac");
      return;
    }
    const client = asObject(body["client"]) ?? {};
    const context = asObject(body["context"]) ?? {};
    const kind = typeof client["kind"] === "string" ? client["kind"] : "unknown";
    const result: JsonObject = {
      protocol: PROTOCOL,
      service: { version: SPIKE_VERSION, build: SPIKE_BUILD, instance },
      capabilities: mode === "mcp" ? ["mcp"] : ["op.call", "spike"],
      spaces: [{ id: SPACE_ID, state: "open" }],
      binding:
        mode === "mcp"
          ? {
              handle: `bh_${b64url(randomBytes(16))}`,
              space: typeof context["space"] === "string" ? context["space"] : SPACE_ID,
              state: "bound",
            }
          : null,
    };
    // Tests only: a slow handshake, the bind reply comes late ("tasks/bind").
    const bindDelay = options.replyDelayMs?.("tasks/bind") ?? 0;
    if (bindDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, bindDelay));
      if (socket.destroyed) return;
    }
    writeLine(socket, {
      jsonrpc: "2.0",
      id: 1,
      result: { ...result, mac: boundMac(ks, t, result) },
    });
    emit("bind", { mode, client: kind, package: client["package"] ?? null });
    if (mode === "mcp") serveMcp(socket, reader, context);
    else serveRpc(socket, reader, kind);
  }

  const ipcServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    serveConnection(socket).catch(() => socket.destroy());
  });

  // --- HTTP and WebSocket (A2 3.8)
  const origins = () => [`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`];
  const hostOk = (host: string | undefined) =>
    host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`;

  /**
   * The response headers of A2 3.8.3. Documents get a style nonce, other responses the same policy
   * without one. Hashed assets are immutable, everything else `no-store`.
   */
  function headers(type: string, styleNonce?: string, immutable = false): http.OutgoingHttpHeaders {
    const style = styleNonce === undefined ? "'self'" : `'self' 'nonce-${styleNonce}'`;
    return {
      "content-type": type,
      "content-security-policy": `${CSP_BASE}; style-src ${style}; connect-src 'self' ws://127.0.0.1:${String(port)} ws://localhost:${String(port)}`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    };
  }

  function send(
    res: http.ServerResponse,
    status: number,
    body: string | JsonObject,
    type = "application/json",
  ): void {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, headers(`${type}; charset=utf-8`));
    res.end(text);
  }

  function bearer(req: http.IncomingMessage): { session: string } | undefined {
    const value = req.headers.authorization;
    if (value?.startsWith("Bearer ") !== true) return undefined;
    return tokens.get(hash(value.slice(7)));
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<number> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";
    if (!hostOk(req.headers.host)) return reply(421, { error: "misdirected" });
    if (method === "OPTIONS") return reply(403, { error: "forbidden" });
    const origin = req.headers.origin;
    const originOk = origin !== undefined && origins().includes(origin);
    if (path.startsWith("/api/") && crossSite(req)) return reply(403, { error: "cross_site" });
    if (method !== "GET" && method !== "HEAD") {
      const probeWithoutOrigin = path === "/api/v1/auth/probe" && origin === undefined;
      if (!originOk && !probeWithoutOrigin) return reply(403, { error: "origin" });
      if (req.headers["content-type"]?.startsWith("application/json") !== true) {
        return reply(415, { error: "content_type" });
      }
    }

    if (method === "GET" && path === "/") {
      const styleNonce = randomBytes(16).toString("base64");
      res.writeHead(200, headers("text/html; charset=utf-8", styleNonce));
      res.end(
        spikeUi === undefined
          ? indexHtml(styleNonce)
          : spikeUi.index.replaceAll(UI_NONCE_PLACEHOLDER, styleNonce),
      );
      return 200;
    }
    const file = method === "GET" ? spikeUi?.files.get(path) : undefined;
    if (file !== undefined) {
      // Read first, so a file removed since start gets a clean 404, not a half-sent 200.
      let bytes: Buffer;
      try {
        bytes = readFileSync(file.path);
      } catch {
        return reply(404, { error: "not_found" });
      }
      // Hashed assets never change under one name. The root files (manifest, icon) may.
      res.writeHead(200, headers(file.type, undefined, path.startsWith("/assets/")));
      res.end(bytes);
      return 200;
    }
    if (method === "GET" && path === "/app.js") {
      send(res, 200, APP_JS, "text/javascript");
      return 200;
    }
    if (method === "GET" && path === "/healthz") return reply(200, "ok", "text/plain");
    if (method === "GET" && path === "/.well-known/ttasks") {
      return reply(200, { app: "ttasks", protocol: PROTOCOL });
    }
    if (method === "POST" && path === "/api/v1/auth/probe") {
      const body = await readJsonBody(req);
      if (typeof body["nonce"] !== "string") return reply(400, { error: "nonce" });
      return reply(200, { proof: httpProbeProof(key, instance, port, body["nonce"]) });
    }
    if (method === "POST" && path === "/api/v1/auth/redeem") {
      if (Date.now() - redeemWindow.start > 60_000) redeemWindow = { start: Date.now(), count: 0 };
      if (++redeemWindow.count > 10) return reply(429, { error: "rate_limited" });
      const body = await readJsonBody(req);
      const code = body["code"];
      const record = typeof code === "string" ? codes.get(hash(code)) : undefined;
      if (typeof code === "string") codes.delete(hash(code));
      if (record === undefined || Date.now() > record.expires) {
        return reply(401, { error: "code_invalid" });
      }
      const token = `ttasks_u_${b64url(randomBytes(32))}`;
      const session = `us_${b64url(randomBytes(8))}`;
      tokens.set(hash(token), { session });
      return reply(200, { token, session_id: session });
    }
    if (path.startsWith("/api/")) {
      const auth = bearer(req);
      if (auth === undefined) return reply(401, { error: "unauthenticated" });
      if (method === "GET" && path === "/api/v1/session") {
        return reply(200, { session_id: auth.session });
      }
      if (method === "POST" && path === "/api/v1/ws-ticket") {
        const ticket = b64url(randomBytes(24));
        wsTickets.set(hash(ticket), Date.now() + 30_000);
        return reply(200, { ticket });
      }
      if (method === "POST" && path === "/api/v1/spike/report") {
        const body = await readJsonBody(req);
        const checks = asObject(body["checks"]) ?? {};
        const clean: JsonObject = {};
        for (const [name, value] of Object.entries(checks).slice(0, 60)) {
          clean[name.slice(0, 60)] = textOf(value).slice(0, 80);
        }
        // The spike UI's measurements (U05, U07): finite numbers and booleans only, by name.
        const metrics: JsonObject = {};
        for (const [name, value] of Object.entries(asObject(body["metrics"]) ?? {}).slice(0, 300)) {
          if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
            metrics[name.slice(0, 60)] = value;
          }
        }
        const run = typeof body["run"] === "string" ? body["run"].slice(0, 40) : null;
        emit("page_report", {
          checks: clean,
          ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
          ...(run === null ? {} : { run }),
        });
        return reply(200, {});
      }
      if (method === "GET" && path === "/api/v1/spike/reveal-targets") {
        return reply(200, { targets: targets.map((t, index) => ({ index, label: t.label })) });
      }
      if (method === "POST" && path === "/api/v1/spike/reveal") {
        // U06 (A5 place.reveal at spike level): the request names an index into the folders the
        // service already knows, never a path.
        const index = (await readJsonBody(req))["index"];
        if (typeof index !== "number" || !Number.isInteger(index)) {
          return reply(400, { error: "unknown_target" });
        }
        const target = targets[index];
        if (target === undefined) return reply(400, { error: "unknown_target" });
        const result = await opener(target.dir);
        emit("reveal", { index, label: target.label, opener: result.opener, ok: result.ok });
        return reply(result.ok ? 200 : 502, { opened: result.ok, label: target.label });
      }
    }
    return reply(404, { error: "not_found" });

    function reply(status: number, body: string | JsonObject, type?: string): number {
      send(res, status, body, type);
      return status;
    }
  }

  const httpServer = http.createServer(
    { headersTimeout: 10_000, keepAliveTimeout: 5_000, requestTimeout: 30_000 },
    (req, res) => {
      const started = now();
      route(req, res)
        .then((status) => {
          emit("http", {
            method: req.method ?? "",
            route: new URL(req.url ?? "/", "http://x").pathname.slice(0, 60),
            status,
            ms: Math.round(now() - started),
          });
        })
        .catch((error: unknown) => {
          const status = error instanceof RpcError && error.code < 600 ? error.code : 500;
          if (!res.headersSent) send(res, status, { error: "request_failed" });
          emit("http", { method: req.method ?? "", status });
        });
    },
  );
  httpServer.on("connection", (socket: net.Socket) => {
    if (process.platform !== "linux") return;
    const uid = peerUid(socket);
    if (uid !== process.getuid?.()) {
      emit("peer_refused", { found: uid === undefined ? "missing" : "other_uid" });
      socket.destroy();
    }
  });
  httpServer.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const ticket = url.searchParams.get("ticket") ?? "";
    const expires = wsTickets.get(hash(ticket));
    wsTickets.delete(hash(ticket));
    const originOk = req.headers.origin !== undefined && origins().includes(req.headers.origin);
    if (
      url.pathname !== "/api/v1/ws" ||
      !hostOk(req.headers.host) ||
      !originOk ||
      crossSite(req) ||
      expires === undefined ||
      Date.now() > expires
    ) {
      emit("ws_refused");
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const peer = acceptWebSocket(req, socket, head, (text, p) => {
      p.sendText(text);
    });
    if (peer !== undefined) {
      emit("ws_open");
      peer.sendText(JSON.stringify({ type: "hello", build: SPIKE_BUILD }));
    }
  });

  // --- Start
  await new Promise<void>((resolve, reject) => {
    ipcServer.once("error", reject);
    ipcServer.listen(endpoint.path, () => {
      ipcServer.off("error", reject);
      resolve();
    });
  }).catch((error: unknown) => {
    lock.close();
    throw error;
  });

  let moved = false;
  const listen = (p: number) =>
    new Promise<number>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(p, "127.0.0.1", () => {
        httpServer.off("error", reject);
        const address = httpServer.address();
        resolve(typeof address === "object" && address !== null ? address.port : p);
      });
    });
  try {
    port = await listen(options.port ?? 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (options.port === undefined || (code !== "EADDRINUSE" && code !== "EACCES")) throw error;
    moved = true;
    port = await listen(0);
  }

  const info: ServiceInfo = {
    format: 1,
    instance,
    install,
    pid: process.pid,
    state: "ready",
    endpoint,
    runtime,
    http: { port, moved },
    protocols: [PROTOCOL],
  };
  writeAtomic(join(state, "service.json"), `${JSON.stringify(info, null, 2)}\n`);
  emit("ready", { endpoint: endpoint.kind, runtime, port, moved });

  function close(): Promise<void> {
    closing ??= (async () => {
      emit("stopping");
      loop.disable();
      for (const socket of sockets) socket.destroy();
      httpServer.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => ipcServer.close(resolve)),
        new Promise((resolve) => httpServer.close(resolve)),
      ]);
      rmSync(join(state, "service.json"), { force: true });
      if (endpoint.kind === "unix") {
        rmSync(endpoint.path, { force: true });
        // The folder under the per-user runtime folder is this install's own: a clean stop leaves
        // nothing there. rmdir refuses a folder that holds anything.
        if (runtime === "run-user") {
          try {
            rmdirSync(dirname(endpoint.path));
          } catch {
            // Not empty, or already gone.
          }
        }
      }
      lock.exec("ROLLBACK");
      lock.close();
      resolveClosed();
    })();
    return closing;
  }

  return { info, key, events, closed, close };
}
