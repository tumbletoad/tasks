// The forwarder conformance suite's harness (A2 3.7.6). The forwarder under test runs as a real
// child process: the binary in TTASKS_BRIDGE_BIN when it is set (a native forwarder takes the
// same arguments as `ttasks mcp`), otherwise the Node bridge from packages/bridge. Services run as
// real child processes too: the scripted peer of peer.ts, or the real hub. Every process a test
// starts is recorded and stopped by that test, and every folder is removed by its full name.
// Tests use fixture data and temporary folders only.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeRuntimeDirOf } from "../../packages/service/test/harness.ts";
import type { PeerConfig } from "./peer.ts";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));
export const NODE_BRIDGE = join(REPO, "packages", "bridge", "src", "mcp", "main.ts");
/** The Node bridge naming the protocol after this build's: a bridge newer than the service. */
export const NEWER_BRIDGE = fileURLToPath(new URL("./newer-bridge.ts", import.meta.url));
export const PEER = fileURLToPath(new URL("./peer.ts", import.meta.url));
export const HUB = join(REPO, "packages", "service", "test", "serve-entry.ts");
/** The build's offline file. A native forwarder ships the same file. */
export const LIB_OFFLINE = join(REPO, "packages", "bridge", "lib", "mcp-offline.json");

/** Generous bounds: a loaded runner must not fail a test that is only slow. */
export const START_MS = 60_000;
export const REPLY_MS = 60_000;

export type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns a value other than undefined, or fails after `ms`. */
export async function waitFor<T>(check: () => T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------------------------
// Homes and endpoints

/**
 * A TTASKS_HOME of its own: `<home>/state` with an ipc.key, and a place for endpoints (a short
 * folder on Unix, where socket paths hold about 100 bytes; unique pipe names on Windows).
 */
export interface Home {
  readonly root: string;
  readonly state: string;
  readonly cache: string;
  readonly key: Buffer;
  /** A fresh endpoint name. */
  endpoint(): string;
  writeKey(key: Buffer): void;
  /** service.json pointing at `path`, as the hub writes it. */
  writeServiceFile(path: string): void;
  removeServiceFile(): void;
  remove(): void;
}

export function makeHome(label: string): Home {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `kf-${label}-`)));
  const state = join(root, "state");
  const cache = join(root, "cache");
  // User-only, as the product makes them: the hub refuses a state folder its group may change.
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  const tag = randomBytes(5).toString("hex");
  let count = 0;
  const home: Home = {
    root,
    state,
    cache,
    key,
    endpoint: () => {
      count += 1;
      return process.platform === "win32"
        ? `\\\\.\\pipe\\ttasks-fwd-${tag}-${String(count)}`
        : join(root, `e${String(count)}.sock`);
    },
    writeKey: (k) => {
      writeFileSync(join(state, "ipc.key"), k.toString("base64url"), { mode: 0o600 });
    },
    writeServiceFile: (path) => {
      writeFileSync(
        join(state, "service.json"),
        JSON.stringify({
          format: 1,
          instance: "fake0instance",
          pid: process.pid,
          state: "ready",
          endpoint: { kind: process.platform === "win32" ? "pipe" : "unix", path },
          protocol: { min: 1, max: 1 },
        }),
      );
    },
    removeServiceFile: () => {
      rmSync(join(state, "service.json"), { force: true });
    },
    remove: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
  home.writeKey(key);
  return home;
}

/** Every bind context the peer recorded, in order. */
export function peerBinds(
  home: Home,
): { pid: number; kind: string; client: Json; context: Json }[] {
  let text: string;
  try {
    text = readFileSync(join(home.state, "peer-binds.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { pid: number; kind: string; client: Json; context: Json });
}

/** A listener whose behaviour the test scripts per connection. Records each connection's bytes. */
export async function fakeEndpoint(
  path: string,
  onConnection: (socket: net.Socket) => void,
): Promise<{ received: Buffer[]; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const index = received.length;
    received.push(Buffer.alloc(0));
    socket.on("data", (chunk: Buffer) => {
      received[index] = Buffer.concat([received[index] ?? Buffer.alloc(0), chunk]);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        for (const socket of sockets) socket.destroy();
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// Processes

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface Proc {
  readonly pid: number;
  readonly child: ChildProcess;
  readonly exit: Promise<Exit>;
  stderr(): string;
}

/**
 * The environment of a process under test: this process's, without any TTasks variable or agent
 * marker (the suite may itself run inside an agent session), plus `extra`.
 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const marker = /^(TTASKS_|CLAUDE|CODEX_|T3CODE_)/i;
  for (const [name, value] of Object.entries(process.env)) {
    if (!marker.test(name)) env[name] = value;
  }
  return { ...env, ...extra };
}

/** The command that runs the forwarder under test. */
export function forwarderCommand(args: readonly string[]): { file: string; args: string[] } {
  const bin = process.env["TTASKS_BRIDGE_BIN"];
  return bin === undefined || bin === ""
    ? { file: process.execPath, args: [NODE_BRIDGE, ...args] }
    : { file: bin, args: [...args] };
}

export const DEFAULT_ARGS = ["--space", "sp_test", "--instance", "test-agent", "--app", "test"];

/** Starts, tracks and stops processes. Every process it started is stopped by `stopAll`. */
export class Procs {
  readonly #all: Proc[] = [];
  /** The homes the real hub ran in: their runtime folders go at stopAll. */
  readonly #hubHomes = new Set<string>();

  spawn(file: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string): Proc {
    const child = spawn(file, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(cwd === undefined ? {} : { cwd }),
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("the process did not start");
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.stdin.on("error", () => undefined);
    const exit = new Promise<Exit>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    const proc: Proc = { pid, child, exit, stderr: () => err };
    this.#all.push(proc);
    return proc;
  }

  /**
   * The forwarder under test, with its stdio driven by an McpClient. `newer`: the Node bridge
   * naming a protocol after this build's, which no native forwarder can stand in for.
   */
  bridge(
    home: Home,
    options: {
      args?: readonly string[];
      env?: Record<string, string>;
      cwd?: string;
      newer?: boolean;
    } = {},
  ): Bridge {
    const args = options.args ?? DEFAULT_ARGS;
    const command =
      options.newer === true
        ? { file: process.execPath, args: [NEWER_BRIDGE, ...args] }
        : forwarderCommand(args);
    const proc = this.spawn(
      command.file,
      command.args,
      cleanEnv({ TTASKS_HOME: home.root, ...options.env }),
      options.cwd,
    );
    return new Bridge(proc);
  }

  /** The scripted peer service. Resolves once it listens and service.json names it. */
  async peer(home: Home, config: Partial<PeerConfig> = {}): Promise<Proc> {
    const full: PeerConfig = {
      state: home.state,
      path: config.path ?? home.endpoint(),
      offline: LIB_OFFLINE,
      ...config,
    };
    const proc = this.spawn(process.execPath, [PEER, JSON.stringify(full)], cleanEnv());
    const stdout = proc.child.stdout;
    if (stdout === null) throw new Error("no stdout");
    let out = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    await waitFor(() => (out.includes("ready\n") ? true : undefined), START_MS, "peer ready");
    return proc;
  }

  /**
   * The real hub (`ttasks serve` through the service's test entry), in `home`. It hosts the spaces
   * of `<home>/config/machine.toml` (A2 3.2.4): `hubSpace` registers one. `stop` on its stdin
   * stops it gracefully.
   */
  hub(home: Home): Proc {
    this.#hubHomes.add(home.root);
    return this.spawn(process.execPath, [HUB], cleanEnv({ TTASKS_HOME: home.root }));
  }

  /** Hard-kills one process and waits for its exit. */
  async kill(proc: Proc): Promise<Exit> {
    if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill("SIGKILL");
    return proc.exit;
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.#all.map((proc) => this.kill(proc)));
    this.#all.length = 0;
    // The runtime folder each hub caused (Linux, `/run/user/<uid>/ttasks-<install>`), by its full
    // name: a hub that was killed or stopped halfway leaves it behind.
    for (const home of this.#hubHomes) removeRuntimeDirOf(home);
    this.#hubHomes.clear();
  }
}

/** Whether a process with this PID is alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------------------------------------
// The agent app's side: an MCP client on the forwarder's stdio

/**
 * Drives one forwarder's stdin and reads its stdout. Every stdout line must be one JSON-RPC
 * message, and every response must answer a request this client sent and has not had answered:
 * anything else is recorded in `stray`, which the suite expects to stay empty. So each test that
 * checks `stray` also checks that every request was answered at most once.
 */
export class Bridge {
  readonly proc: Proc;
  /** Every stdout line, in order. */
  readonly lines: string[] = [];
  /** stdout lines that were not a JSON-RPC message, or a second or unasked-for response. */
  readonly stray: string[] = [];
  /** Messages with a method: notifications and requests from the server. */
  readonly notifications: Json[] = [];
  /** Requests sent and not answered yet, by ID key. */
  readonly #open = new Set<string>();
  readonly #waiting = new Map<string, (message: Json) => void>();
  readonly #replies = new Map<string, Json>();
  #nextId = 1;
  #partial = "";

  constructor(proc: Proc) {
    this.proc = proc;
    const stdout = proc.child.stdout;
    if (stdout === null) throw new Error("no stdout");
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      this.#partial += chunk;
      for (let at = this.#partial.indexOf("\n"); at !== -1; at = this.#partial.indexOf("\n")) {
        const line = this.#partial.slice(0, at);
        this.#partial = this.#partial.slice(at + 1);
        this.#line(line);
      }
    });
    stdout.on("end", () => {
      if (this.#partial !== "") this.stray.push(this.#partial);
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  #line(line: string): void {
    this.lines.push(line);
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.stray.push(line);
      return;
    }
    if (!isObject(message) || message["jsonrpc"] !== "2.0") {
      this.stray.push(line);
      return;
    }
    const id = message["id"];
    if (typeof message["method"] === "string") {
      this.notifications.push(message);
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      this.stray.push(line);
      return;
    }
    const key = `${typeof id}:${String(id)}`;
    // A response to nothing open: a duplicate, or an answer to a request never sent.
    if (!this.#open.delete(key)) {
      this.stray.push(line);
      return;
    }
    const waiter = this.#waiting.get(key);
    if (waiter !== undefined) {
      this.#waiting.delete(key);
      waiter(message);
    } else {
      this.#replies.set(key, message);
    }
  }

  /** Writes raw text to stdin. */
  write(text: string): void {
    this.proc.child.stdin?.write(text);
  }

  send(message: Json): void {
    const id = message["id"];
    if (
      typeof message["method"] === "string" &&
      (typeof id === "string" || typeof id === "number")
    ) {
      this.#open.add(`${typeof id}:${String(id)}`);
    }
    this.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params: Json = {}): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** The reply to `id`, when it comes. */
  reply(id: string | number, ms = REPLY_MS): Promise<Json> {
    const key = `${typeof id}:${String(id)}`;
    const ready = this.#replies.get(key);
    if (ready !== undefined) {
      this.#replies.delete(key);
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(key);
        reject(new Error(`no reply to ${key}; stderr: ${this.proc.stderr()}`));
      }, ms);
      this.#waiting.set(key, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  /** Sends a request and waits for its reply. */
  request(method: string, params: Json = {}, id: string | number = this.#nextId++): Promise<Json> {
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.reply(id);
  }

  /** A legacy-era initialize, then notifications/initialized. */
  async initialize(version = "2025-11-25"): Promise<Json> {
    const reply = await this.request("initialize", {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: "conformance", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return reply;
  }

  /** A tools/call; resolves with the reply. */
  call(name: string, args: Json = {}, id?: string | number): Promise<Json> {
    return this.request("tools/call", { name, arguments: args }, id);
  }

  /** Closes stdin, as an agent app does to end the session. */
  end(): void {
    this.proc.child.stdin?.end();
  }
}

/** The text of a tools/call result, or undefined. */
export function textOf(reply: Json): string | undefined {
  const result = reply["result"];
  if (!isObject(result)) return undefined;
  const content = result["content"];
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  return isObject(first) && typeof first["text"] === "string" ? first["text"] : undefined;
}

/** Whether a tools/call reply is the offline error with `key`'s text. */
export function isOfflineText(reply: Json, key: string): boolean {
  const content = JSON.parse(readFileSync(LIB_OFFLINE, "utf8")) as { texts: Json };
  const result = reply["result"];
  return isObject(result) && result["isError"] === true && textOf(reply) === content.texts[key];
}

/** The build's offline content, parsed. */
export function libOffline(): Json {
  return JSON.parse(readFileSync(LIB_OFFLINE, "utf8")) as Json;
}
