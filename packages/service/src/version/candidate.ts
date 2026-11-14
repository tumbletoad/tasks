// The candidate's own checks (A2 3.12.6 step 6): what a version must manage on this
// machine before it may become `current`, beyond its files (doctor's integrity row) and its runtime
// (the runtime gate). `tasks install --finish` runs them before it switches current (M1.14), and so
// does `tasks doctor --self-test` from a version folder, the build's gate included.
//
//   candidate-space     a temporary space through A1's adapter: created by the space-admin worker,
//                       one task written through a writer in a storage worker, then a backup whose
//                       copy passes its integrity check
//   candidate-endpoint  a temporary tasks-local/1 endpoint of this version (a socket beside the
//                       service's own, or a pipe of this install), a full handshake with a random
//                       key, and one rpc call that names the endpoint's instance
//   candidate-bridge    this version's own `tasks mcp` in an empty home of its own, so with no
//                       service: initialize and tools/list must be answered from its
//                       lib/mcp-offline.json, with MCP frames only on stdout
//
// Each check works in a folder of its own below `<state>/tmp/` (A2 3.2.1) and removes it. None
// touches a running service, its socket, its spaces or its files, so an update (M6) can test its
// candidate while the old version still serves. Details name codes and fixed sentences only, never
// a path or a value of the environment.
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ENV_PREFIX } from "@tasks/brand";
import { startHelper, type Helper } from "@tasks/launch/helpers";
import { openRpc } from "@tasks/bridge/protocol";
import {
  DEFAULT_DRIVER,
  newId,
  StorageWorker,
  type MachineInfo,
  type WriteRequest,
} from "@tasks/storage";
import { ensurePrivateDir, isPrivateDir, makeDir } from "../hub/files.ts";
import {
  canonicalStatePath,
  hostFacts,
  installId,
  TASKS_HOME,
  resolveLayout,
  runtimeNames,
  type HostFacts,
} from "../hub/paths.ts";
import { runAdmin } from "../hub/space-admin.ts";
import { serve } from "../local/index.ts";

export type CandidateId = "candidate-space" | "candidate-endpoint" | "candidate-bridge";

export interface CandidateCheck {
  readonly id: CandidateId;
  readonly status: "ok" | "fail" | "skip";
  readonly detail: string;
}

export interface CandidateOptions {
  /** The install's state folder: the checks work below its `tmp/`. */
  readonly state: string;
  /** The version and build under test, as its manifest names them. */
  readonly build: { readonly version: string; readonly build: string };
  /**
   * How to run this version's entry: the runtime and its arguments up to the entry file, for
   * example `[runtime/node, --report-exclude-env, lib/tasks.mjs]`. Without it the bridge row is
   * skipped (a run from source has no version folder).
   */
  readonly entry?: readonly string[];
  /** The offline answers the bridge must give: the version's lib/mcp-offline.json. */
  readonly offline?: string;
  /** The host facts the endpoint's names come from. Default: this process's. */
  readonly facts?: HostFacts;
  /** The environment the bridge runs in, besides its own TASKS_HOME. Default: this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Each check's deadline. */
  readonly timeoutMs?: number;
}

export const CANDIDATE_TIMEOUT_MS = 60_000;

/**
 * The folder each check works in: `<state>/tmp/candidate-<random>`, exactly 0700 whatever the umask
 * (A2 3.2.2 rule 5). `<state>` and its `tmp` are made 0700 when missing and judged first: a check
 * writes nothing into a folder another user can change (`unsafe_permissions`; `tasks install
 * --finish` has said which and how to fix it before it runs the checks).
 */
function scratch(state: string): string {
  const tmp = join(state, "tmp");
  for (const dir of [state, tmp]) {
    if (ensurePrivateDir(dir) !== undefined) {
      throw Object.assign(new Error("A folder of the check is not private"), {
        code: "unsafe_permissions",
      });
    }
  }
  const dir = join(tmp, `candidate-${randomBytes(6).toString("hex")}`);
  makeDir(dir, 0o700, { recursive: false });
  return dir;
}

const remove = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "an error";
};

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error("timed out"), { code: "TIMEOUT" }));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const OS: Readonly<Partial<Record<NodeJS.Platform, MachineInfo["os"]>>> = {
  linux: "linux",
  win32: "windows",
  darwin: "macos",
};

/** A temporary space through A1's adapter, in the version's own worker threads. */
export async function spaceCheck(options: CandidateOptions): Promise<CandidateCheck> {
  const id = "candidate-space";
  let dir: string;
  try {
    dir = scratch(options.state);
  } catch (error) {
    return { id, status: "fail", detail: `No temporary folder for the check: ${codeOf(error)}.` };
  }
  const folder = join(dir, "space");
  const machine: MachineInfo = {
    id: newId("m"),
    name: "candidate",
    os: OS[process.platform] ?? "linux",
  };
  let worker: StorageWorker | undefined;
  try {
    const run = async (): Promise<CandidateCheck> => {
      const created = await runAdmin({
        kind: "create",
        folder,
        name: "Candidate check",
        refPrefix: "C",
        takenPrefixes: [],
        machineId: machine.id,
        ownerLabel: "candidate",
      });
      if (created.kind !== "create") return { id, status: "fail", detail: "No space was made." };
      worker = await StorageWorker.start({ driver: DEFAULT_DRIVER });
      const writer = await worker.openSpaceWriter(folder, { machine });
      let seq: number;
      try {
        const human = await writer.actor("human", "candidate");
        const request: WriteRequest = {
          space_id: created.spaceId,
          request_id: `candidate-${randomBytes(8).toString("hex")}`,
          actor: {
            scope_id: `candidate:${machine.id}`,
            principal_id: human,
            actor_kind: "human",
            machine_id: machine.id,
            origin: "cli",
          },
          ops: [{ kind: "task.create", title: "Candidate check" }],
        };
        const result = await writer.submit(request);
        if (result.status !== "applied") {
          return {
            id,
            status: "fail",
            detail: `A write to a temporary space was ${result.status}${result.error === undefined ? "" : ` (${result.error.code})`}.`,
          };
        }
        seq = result.seq;
      } finally {
        await writer.close();
      }
      const backup = await runAdmin({ kind: "backup", folder });
      if (backup.kind !== "backup" || backup.backup.seq !== seq) {
        return {
          id,
          status: "fail",
          detail: "The temporary space's backup does not hold its write.",
        };
      }
      return {
        id,
        status: "ok",
        detail:
          "A temporary space was created, written through a writer and backed up with its integrity check.",
      };
    };
    return await within(run(), options.timeoutMs ?? CANDIDATE_TIMEOUT_MS);
  } catch (error) {
    return { id, status: "fail", detail: `A temporary space failed: ${codeOf(error)}.` };
  } finally {
    await worker?.close().catch(() => undefined);
    remove(dir);
  }
}

/**
 * Where the temporary endpoint listens: on Windows a pipe of this install's prefix with a random
 * name; on Linux and macOS a socket in a private folder beside the folder the service's own socket
 * uses (A2 3.2.1), so a path that would be too long for the service is too long here as well.
 */
function endpointPath(
  options: CandidateOptions,
  facts: HostFacts,
): { path: string; dir: string | undefined } {
  const layout = resolveLayout(facts);
  const id = installId(canonicalStatePath(realpathSync.native(options.state), facts.platform));
  const names = runtimeNames(layout, id, facts, isPrivateDir);
  const random = randomBytes(4).toString("hex");
  if (names.endpoint.kind === "pipe") {
    return { path: `${names.endpoint.prefix}candidate-${random}`, dir: undefined };
  }
  const dir = join(
    dirname(names.endpoint.dir),
    `${basename(names.endpoint.dir)}-candidate-${random}`,
  );
  return { path: join(dir, "c.sock"), dir };
}

/** A temporary tasks-local/1 endpoint of this version, a handshake and one call. */
export async function endpointCheck(options: CandidateOptions): Promise<CandidateCheck> {
  const id = "candidate-endpoint";
  const facts = options.facts ?? hostFacts();
  let place: { path: string; dir: string | undefined };
  try {
    place = endpointPath(options, facts);
  } catch (error) {
    return {
      id,
      status: "fail",
      detail: `The endpoint's place could not be found: ${codeOf(error)}.`,
    };
  }
  const key = randomBytes(32);
  const instance = randomBytes(16).toString("hex");
  try {
    const run = async (): Promise<CandidateCheck> => {
      // Beside the service's socket folder, never above it: exactly 0700 (A2 3.2.2 rule 5).
      if (place.dir !== undefined) makeDir(place.dir, 0o700, { recursive: false });
      const server = await serve({
        path: place.path,
        key,
        instance,
        service: options.build,
        handlers: { "service/status": () => ({ instance, state: "ready" }) },
      });
      try {
        const session = await openRpc({
          path: place.path,
          key,
          client: {
            kind: "cli",
            version: options.build.version,
            build: options.build.build,
            pid: process.pid,
            package: null,
            tty: { stdin: false, stdout: false },
          },
          context: { env: {} },
          connectTimeoutMs: 10_000,
        });
        try {
          const status = (await session.call("service/status", {}, { timeoutMs: 10_000 })) as {
            instance?: unknown;
          };
          if (session.bound.service.instance !== instance || status.instance !== instance) {
            return {
              id,
              status: "fail",
              detail: "The temporary endpoint answered as another instance.",
            };
          }
        } finally {
          session.close();
        }
      } finally {
        await server.close();
      }
      return {
        id,
        status: "ok",
        detail: `A temporary ${place.dir === undefined ? "pipe" : "socket"} took a tasks-local/1 handshake and a call.`,
      };
    };
    return await within(run(), options.timeoutMs ?? CANDIDATE_TIMEOUT_MS);
  } catch (error) {
    return { id, status: "fail", detail: `A temporary endpoint failed: ${codeOf(error)}.` };
  } finally {
    if (place.dir !== undefined) remove(place.dir);
  }
}

/** The environment of the bridge under test: no Tasks variable but its own home. */
function bridgeEnv(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.toUpperCase().startsWith(ENV_PREFIX)) out[name] = value;
  }
  out[TASKS_HOME] = home;
  return out;
}

type Message = Record<string, unknown>;

/** This version's `tasks mcp` with no service: initialize and tools/list from its offline file. */
export async function bridgeCheck(options: CandidateOptions): Promise<CandidateCheck> {
  const id = "candidate-bridge";
  const [file, ...args] = options.entry ?? [];
  if (file === undefined || options.offline === undefined) {
    return {
      id,
      status: "skip",
      detail: "Run from source: the bridge is checked in a version folder.",
    };
  }
  let expected: string;
  try {
    const offline = JSON.parse(readFileSync(options.offline, "utf8")) as {
      tools_list?: { result?: unknown };
    };
    expected = JSON.stringify(offline.tools_list?.result);
  } catch {
    return { id, status: "fail", detail: "lib/mcp-offline.json cannot be read." };
  }
  let dir: string;
  try {
    dir = scratch(options.state);
  } catch (error) {
    return { id, status: "fail", detail: `No temporary folder for the check: ${codeOf(error)}.` };
  }
  // A helper of the runner (@tasks/launch helpers.ts, A3 3.14), as every program doctor starts: it
  // ends with what it started at its deadline and when this process exits.
  let helper: Helper;
  try {
    helper = startHelper([file, ...args, "mcp"], {
      env: bridgeEnv(options.env ?? process.env, join(dir, "home")),
      cwd: dir,
      deadlineMs: (options.timeoutMs ?? CANDIDATE_TIMEOUT_MS) + 5_000,
      stdin: true,
      stdout: true,
      stderr: true,
    });
  } catch (error) {
    remove(dir);
    return { id, status: "fail", detail: `The bridge check failed: ${codeOf(error)}.` };
  }
  const { child } = helper;
  const { stdin, stdout, stderr } = child;
  const exit = helper.ended;
  if (stdin === null || stdout === null || stderr === null) {
    // Asked for as pipes, so never: the check fails rather than guess.
    helper.stop();
    await exit;
    remove(dir);
    return { id, status: "fail", detail: "The bridge check failed: no_pipes." };
  }
  try {
    const run = async (): Promise<CandidateCheck> => {
      const replies = new Map<unknown, Message>();
      const waiting = new Map<unknown, () => void>();
      const seen = { stray: false };
      let pending = "";
      stderr.resume();
      stdout.setEncoding("utf8").on("data", (chunk: string) => {
        pending += chunk;
        for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
          const line = pending.slice(0, end).replace(/\r$/, "");
          pending = pending.slice(end + 1);
          let message: Message | undefined;
          try {
            message = JSON.parse(line) as Message;
          } catch {
            message = undefined;
          }
          if (message?.["jsonrpc"] !== "2.0") {
            seen.stray = true;
            continue;
          }
          if ("id" in message && !("method" in message)) {
            replies.set(message["id"], message);
            waiting.get(message["id"])?.();
          }
        }
      });
      stdin.on("error", () => undefined);
      const ask = async (message: Message): Promise<Message | undefined> => {
        const replied =
          message["id"] === undefined
            ? Promise.resolve()
            : new Promise<void>((resolve) => waiting.set(message["id"], resolve));
        stdin.write(`${JSON.stringify(message)}\n`);
        await Promise.race([replied, exit]);
        return replies.get(message["id"]);
      };
      const init = await ask({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "candidate-check", version: options.build.version },
        },
      });
      await ask({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      stdin.end();
      const code = await exit;
      if (init?.["result"] === undefined) {
        return { id, status: "fail", detail: "The bridge did not answer initialize." };
      }
      if (JSON.stringify(tools?.["result"]) !== expected) {
        return { id, status: "fail", detail: "The bridge's tools/list is not its offline answer." };
      }
      if (seen.stray || pending !== "") {
        return {
          id,
          status: "fail",
          detail: "The bridge wrote something other than MCP frames to stdout.",
        };
      }
      if (code !== 0)
        return { id, status: "fail", detail: `The bridge exited with ${String(code)}.` };
      return {
        id,
        status: "ok",
        detail:
          "This version's tasks mcp answered initialize and tools/list from its offline file.",
      };
    };
    return await within(run(), options.timeoutMs ?? CANDIDATE_TIMEOUT_MS);
  } catch (error) {
    return { id, status: "fail", detail: `The bridge check failed: ${codeOf(error)}.` };
  } finally {
    if (child.exitCode === null && child.signalCode === null) helper.stop();
    await exit;
    remove(dir);
  }
}

/** Every candidate check, in order. */
export async function candidateChecks(options: CandidateOptions): Promise<CandidateCheck[]> {
  return [await spaceCheck(options), await endpointCheck(options), await bridgeCheck(options)];
}
