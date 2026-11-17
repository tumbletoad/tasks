// What a service command works with: the install it serves (its folders, install ID, entry names
// and the program its OS entry starts), the places it writes, and the tools it runs.
//
// defaultServiceContext() gives the real ones: this user's install, ~/.config/systemd/user,
// ~/Library/LaunchAgents, HKCU's Run key, and the OS's own systemctl, launchctl and reg.exe. Every
// writer takes these as a parameter: tests build a ServiceContext of their own with a scratch
// registry key, temporary folders and stand-in tools, so no test reaches a place that starts
// programs on the machine.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import { PRODUCT_NAME } from "@tasks/brand";
import {
  isAgentMarker,
  isObject,
  LocalError,
  openRpc,
  parseKey,
  RPC_ERROR,
  RpcError,
  rpcContextEnv,
  type ClientInfo,
  type RpcSession,
} from "@tasks/bridge/protocol";
import type { ServiceStatus } from "../hub/endpoint.ts";
import { detectIdentity, packageIdentity, system32, type Identity } from "../hub/identity.ts";
import { KEY_FILE } from "../hub/key.ts";
import type { UmaskRead } from "../hub/umask.ts";
import {
  canonicalStatePath,
  homeFolder,
  hostFacts,
  installId,
  LayoutError,
  resolveLayout,
  type HostFacts,
  type Layout,
} from "../hub/paths.ts";
import { BUILD, SERVICE_FILE } from "../hub/service.ts";
import { ServiceCommandError } from "./errors.ts";
import { runProcess, startDetached, type Runner } from "./process.ts";
import { NO_REGISTRY, RegExe, type Registry } from "./registry.ts";
import {
  defaultProgram,
  isServicePlatform,
  REGISTRY_ROOT,
  serviceNames,
  type ServiceNames,
  type ServicePlatform,
} from "./render.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** Where the OS entries live. Tests pass temporary folders and a scratch key. */
export interface ServiceRoots {
  /** Linux: the systemd user unit folder, `~/.config/systemd/user`. */
  readonly unitDir: string;
  /** macOS: `~/Library/LaunchAgents`. */
  readonly launchAgentsDir: string;
  /** Windows: the key that holds `Run` and `Explorer\StartupApproved\Run` (REGISTRY_ROOT). */
  readonly registryRoot: string;
}

/** The install a command serves. */
export interface InstallFacts {
  readonly platform: ServicePlatform;
  readonly layout: Layout;
  readonly installId: string;
  readonly names: ServiceNames;
  /** The program the OS entry starts (render.ts defaultProgram, or the build's own path). */
  readonly program: string;
  /** The user's home folder by A2 3.2.2 rule 1. */
  readonly home: string;
  /** The user's UID on Linux and macOS (launchd's `gui/<uid>` domain, loginctl). */
  readonly uid: number | undefined;
}

/**
 * Why a probe got no answer:
 * - `not_running`: no service.json, or one whose process has ended, or no endpoint to connect to;
 * - `starting`: service.json says starting, its process lives, and it has no endpoint yet;
 * - `stopping`: service.json says draining and its process lives;
 * - `restart_session`, `service_too_old`: the service speaks another protocol (A2 3.6.6);
 * - `unreachable`, `untrusted_endpoint`, `other_install`: as the transport and service.json say.
 */
export type ProbeReason =
  | "not_running"
  | "starting"
  | "stopping"
  | "unreachable"
  | "untrusted_endpoint"
  | "other_install"
  | "restart_session"
  | "service_too_old";

/** Whether this install's service answers on its endpoint (tasks-local/1, `service/status`). */
export type Probe =
  | { readonly answers: true; readonly status: ServiceStatus }
  | { readonly answers: false; readonly reason: ProbeReason };

/** What `service/shutdown {restart: false}` got. */
export type ShutdownResult = "stopping" | "not_running" | "forbidden" | "failed";

/** The fields of service.json (A2 3.2.3) a service command reads. Never trusted without a check. */
export interface ServiceRecord {
  readonly pid: number;
  readonly instance: string;
  readonly state: string;
  readonly installId: string;
  /** The socket or pipe, once the service listens. */
  readonly endpoint: string | undefined;
  /** How long ago the file was last written: the service rewrites it at each change of state. */
  readonly ageMs: number;
}

/**
 * How long a service may say `starting` or `draining`. Both are short (a start binds its endpoint;
 * a drain is bounded by its own timeouts), so a record older than this in either state is what a
 * crash left, and its PID may by now belong to another process.
 */
export const STALE_STATE_MS = 60_000;

/**
 * Whether a service.json names a service that still runs: its PID exists, and it is not a
 * `starting` or `draining` record older than STALE_STATE_MS. The PID alone cannot prove more: a
 * crashed service's PID can be reused. Its endpoint and handshake do (probeService).
 */
export function liveRecord(record: ServiceRecord, alive: (pid: number) => boolean): boolean {
  const transient = record.state === "starting" || record.state === "draining";
  return alive(record.pid) && !(transient && record.ageMs > STALE_STATE_MS);
}

/** System32's tools and Explorer, by their absolute paths. */
export interface WindowsTools {
  readonly reg: string;
  readonly tasklist: string;
  readonly explorer: string;
}

export interface ServiceContext extends InstallFacts {
  readonly roots: ServiceRoots;
  readonly run: Runner;
  /** process.ts startDetached; `cwd` is where the program runs when that folder exists. */
  readonly startDetached: (
    file: string,
    args: readonly string[],
    options?: { readonly cwd?: string },
  ) => void;
  readonly registry: Registry;
  /** Undefined when System32 cannot be found (and on Linux and macOS). */
  readonly windows: WindowsTools | undefined;
  readonly identity: () => Identity;
  /** This process's umask (hub/umask.ts readUmask, which never sets it). Tests pass another. */
  readonly umask?: () => UmaskRead;
  /**
   * Whether this command runs in an agent's shell: an agent marker in its environment, which the
   * service would class `cli-agent` (A2 3.6.5). Such a shell may read status and start the service,
   * not change whether and how it runs.
   */
  readonly agentShell: boolean;
  /** This install's service.json, or undefined. */
  readonly record: () => ServiceRecord | undefined;
  /** Whether a process with this PID exists. */
  readonly alive: (pid: number) => boolean;
  /**
   * When the process with this PID started, as the OS words it, where the OS gives it without a
   * tool: Linux (`/proc/<pid>/stat`). Undefined elsewhere and for a PID that does not exist. Two
   * readings that differ mean the PID now belongs to another process.
   */
  readonly processStart: (pid: number) => string | undefined;
  /** One probe, taking at most about `budgetMs` (default: the transport's own timeouts). */
  readonly probe: (budgetMs?: number) => Promise<Probe>;
  /** `service/shutdown {restart: false}`, taking at most about `budgetMs`. */
  readonly shutdown: (budgetMs?: number) => Promise<ShutdownResult>;
  readonly sleep: (ms: number) => Promise<void>;
  /** How long start waits for a ready service: A2 3.3.5, 15 s (20 s on Windows). */
  readonly readyTimeoutMs: number;
  /** How long stop waits for the service to end. */
  readonly stopTimeoutMs: number;
  /** Between two probes while waiting. */
  readonly pollMs: number;
}

/**
 * `path` with every part that exists resolved (`fs.realpathSync.native`) and the rest appended, so
 * a state folder that does not exist yet gets the ID it will have once the service creates it.
 */
export function resolvedPath(path: string): string {
  const rest: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync.native(at), ...rest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(at);
      if (parent === at) return path;
      rest.unshift(basename(at));
      at = parent;
    }
  }
}

/** The install this process belongs to: TASKS_HOME's, else the user's daily one. */
export function describeInstall(facts: HostFacts, program?: string): InstallFacts {
  const { platform } = facts;
  if (!isServicePlatform(platform)) {
    throw new ServiceCommandError(
      "internal",
      "unsupported_platform",
      `${PRODUCT_NAME}'s service install supports Linux, Windows and macOS only.`,
    );
  }
  let layout: Layout;
  let home: string;
  try {
    layout = resolveLayout(facts);
    home = homeFolder(facts);
  } catch (error) {
    if (!(error instanceof LayoutError)) throw error;
    throw new ServiceCommandError("usage", "invalid_install", `${error.message}.`);
  }
  const id = installId(canonicalStatePath(resolvedPath(layout.state), platform));
  return {
    platform,
    layout,
    installId: id,
    names: serviceNames(id, layout.home !== undefined),
    program: program ?? defaultProgram(platform, layout),
    home,
    uid: facts.uid,
  };
}

/** Whether a stream is a terminal. Node leaves `isTTY` undefined, not false, when it is not. */
export const isTty = (stream: { readonly isTTY?: boolean | undefined }): boolean =>
  stream.isTTY === true;

/** The client a service command presents in its bind frame (A2 3.6.3): the CLI. */
function cliClient(env: Env): ClientInfo {
  return {
    kind: "cli",
    version: BUILD.version,
    build: BUILD.build,
    pid: process.pid,
    package: packageIdentity(env),
    tty: { stdin: isTty(process.stdin), stdout: isTty(process.stdout) },
  };
}

const CONNECT_TIMEOUT_MS = 2_000;
const PROBE_TIMEOUT_MS = 5_000;

/** This install's service.json at `state`, or undefined when it is missing or not one. */
export function readServiceRecord(state: string): ServiceRecord | undefined {
  let record: unknown;
  let ageMs: number;
  try {
    const file = join(state, SERVICE_FILE);
    ageMs = Math.max(0, Date.now() - statSync(file).mtimeMs);
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(record)) return undefined;
  const { pid, instance, state: at, install_id: installId, endpoint } = record;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof instance !== "string" ||
    typeof at !== "string" ||
    typeof installId !== "string"
  ) {
    return undefined;
  }
  const path =
    isObject(endpoint) && typeof endpoint["path"] === "string" ? endpoint["path"] : undefined;
  return { pid, instance, state: at, installId, endpoint: path, ageMs };
}

/** Whether a process with this PID exists (EPERM: it does, as another user's). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A process's start time on Linux: field 22 of `/proc/<pid>/stat`, in clock ticks since boot. The
 * command name in field 2 may hold spaces and parentheses, so the fields are counted after its
 * last `)`. Undefined on other systems and when the process does not exist.
 */
export function processStartTime(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return start !== undefined && /^\d+$/.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

/** The transport's reasons a probe reports as they are; every other failure is `unreachable`. */
const TRANSPORT_PROBE_REASONS: ReadonlySet<string> = new Set([
  "not_running",
  "untrusted_endpoint",
  "restart_session",
  "service_too_old",
]);

/**
 * An rpc session with this install's service, or why there is none. service.json only says where
 * to look: a service is trusted after the handshake, and a record whose process has ended is stale.
 */
async function openSession(
  state: string,
  id: string,
  env: Env,
  end: number,
): Promise<{ session: RpcSession } | { reason: ProbeReason }> {
  const record = readServiceRecord(state);
  if (record === undefined) return { reason: "not_running" };
  if (record.installId !== id) return { reason: "other_install" };
  if (!liveRecord(record, processAlive)) return { reason: "not_running" };
  if (record.state === "draining") return { reason: "stopping" };
  if (record.endpoint === undefined) {
    return { reason: record.state === "starting" ? "starting" : "not_running" };
  }
  let key: Buffer;
  try {
    key = parseKey(readFileSync(join(state, KEY_FILE), "utf8"));
  } catch {
    // The record names a live process: a key that cannot be read does not make it absent.
    return { reason: "unreachable" };
  }
  // Both timeouts together stay within the time left.
  const left = Math.max(2, end - Date.now());
  const connectTimeoutMs = Math.min(CONNECT_TIMEOUT_MS, Math.ceil(left / 2));
  try {
    const session = await openRpc({
      path: record.endpoint,
      key,
      client: cliClient(env),
      context: { env: rpcContextEnv(env) },
      connectTimeoutMs,
      handshakeTimeoutMs: Math.min(PROBE_TIMEOUT_MS, Math.max(1, left - connectTimeoutMs)),
    });
    return { session };
  } catch (error) {
    if (error instanceof LocalError && TRANSPORT_PROBE_REASONS.has(error.reason)) {
      return { reason: error.reason as ProbeReason };
    }
    return { reason: "unreachable" };
  }
}

const isStatus = (value: unknown): value is ServiceStatus =>
  isObject(value) &&
  typeof value["state"] === "string" &&
  typeof value["pid"] === "number" &&
  typeof value["install_id"] === "string";

/** The end of a probe that may take `budgetMs`, by default the transport's own timeouts. */
const probeEnd = (budgetMs: number | undefined): number =>
  Date.now() + (budgetMs ?? CONNECT_TIMEOUT_MS + 2 * PROBE_TIMEOUT_MS);

/**
 * Asks this install's service for `service/status`, within `budgetMs`. A service is only trusted
 * after the handshake.
 */
export async function probeService(
  state: string,
  id: string,
  env: Env,
  budgetMs?: number,
): Promise<Probe> {
  const end = probeEnd(budgetMs);
  const opened = await openSession(state, id, env, end);
  if ("reason" in opened) return { answers: false, reason: opened.reason };
  try {
    const status = await opened.session.call(
      "service/status",
      {},
      { timeoutMs: Math.min(PROBE_TIMEOUT_MS, Math.max(1, end - Date.now())) },
    );
    if (!isStatus(status)) return { answers: false, reason: "unreachable" };
    if (status.install_id !== id) return { answers: false, reason: "other_install" };
    return { answers: true, status };
  } catch {
    // A service that began to drain answers new requests with service_unavailable.
    return {
      answers: false,
      reason: readServiceRecord(state)?.state === "draining" ? "stopping" : "unreachable",
    };
  } finally {
    opened.session.close();
  }
}

/** `service/shutdown {restart: false}` (A2 3.3.5): how a stop reaches a service on Windows. */
export async function shutdownService(
  state: string,
  id: string,
  env: Env,
  budgetMs?: number,
): Promise<ShutdownResult> {
  const end = probeEnd(budgetMs);
  const opened = await openSession(state, id, env, end);
  if ("reason" in opened) return opened.reason === "not_running" ? "not_running" : "failed";
  try {
    await opened.session.call(
      "service/shutdown",
      { restart: false, reason: "stop" },
      { timeoutMs: Math.min(PROBE_TIMEOUT_MS, Math.max(1, end - Date.now())) },
    );
    return "stopping";
  } catch (error) {
    if (error instanceof RpcError && isObject(error.data) && error.data["code"] === "forbidden") {
      return "forbidden";
    }
    return "failed";
  } finally {
    opened.session.close();
  }
}

/** What `service/shutdown {restart: true}` got. */
export type RestartResult = "restarting" | "not_running" | "forbidden" | "failed";

/**
 * `service/shutdown {restart: true}` (A2 3.12.6 step 11): the service drains and exits 75, and
 * its manager (tasksw.exe, systemd, the launchd wrapper) starts it again at once, from what
 * `current` names then. A service nobody supervises just ends.
 */
export async function requestRestart(
  state: string,
  id: string,
  env: Env,
  budgetMs?: number,
): Promise<RestartResult> {
  const end = probeEnd(budgetMs);
  const opened = await openSession(state, id, env, end);
  if ("reason" in opened) return opened.reason === "not_running" ? "not_running" : "failed";
  try {
    await opened.session.call(
      "service/shutdown",
      { restart: true, reason: "update" },
      { timeoutMs: Math.min(PROBE_TIMEOUT_MS, Math.max(1, end - Date.now())) },
    );
    return "restarting";
  } catch (error) {
    if (error instanceof RpcError && isObject(error.data) && error.data["code"] === "forbidden") {
      return "forbidden";
    }
    return "failed";
  } finally {
    opened.session.close();
  }
}

/** A run an update would cut short, as the service names it (`runs/blocking`). */
export interface HeldRun {
  readonly space_name: string | null;
  /** The task's reference, or null for a routine's run. */
  readonly task: string | null;
  readonly state: string;
}

/** An update's hold on new runs, open as long as its connection is. */
export interface RunsHold {
  /** The runs the update would cut short, as the service said last. */
  blocking(): readonly HeldRun[];
  /** Resolves once what blocks changed, or the hold ended. */
  changed(): Promise<void>;
  /** False once the hold ended: the service stopped, or the connection closed. */
  readonly held: boolean;
  /** Stops every blocking run; resolves with those that did not end in time. */
  stopAll(): Promise<readonly HeldRun[]>;
  release(): void;
}

const heldRuns = (value: unknown): HeldRun[] =>
  isObject(value) && Array.isArray(value["runs"])
    ? value["runs"].filter(isObject).map((run) => ({
        space_name: typeof run["space_name"] === "string" ? run["space_name"] : null,
        task: typeof run["task"] === "string" ? run["task"] : null,
        state: typeof run["state"] === "string" ? run["state"] : "running",
      }))
    : [];

/**
 * How long the service may take to say what blocks an update. Its hold is in force from the
 * request on; a service that says nothing for this long is not one an update should restart.
 */
export const HOLD_ANSWER_MS = 120_000;
/** How long stopping the runs may take: their grace, confirmation and drain, and some. */
const STOP_HELD_MS = 120_000;

/** Reasons a probe gives that say no service of this install runs, or one that hosts no runs. */
const NO_RUNS: ReadonlySet<ProbeReason> = new Set([
  "not_running",
  "other_install",
  "service_too_old",
]);

/**
 * `runs/hold`: no new run starts while the hold's connection is open, and the service says which
 * runs the update would cut short. Undefined when no service of this install runs, or one of an
 * earlier version that hosts no runs. A service that may run but does not answer, or does not say
 * which runs it has, is asked again until `answerMs` passed: then `silent`.
 */
export async function holdRuns(
  state: string,
  id: string,
  env: Env,
  answerMs: number = HOLD_ANSWER_MS,
): Promise<RunsHold | "silent" | undefined> {
  const end = Date.now() + answerMs;
  for (;;) {
    const tried = await tryHold(state, id, env, end);
    if (tried !== "again") return tried;
    const left = end - Date.now();
    if (left <= 0) return "silent";
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, left)));
  }
}

async function tryHold(
  state: string,
  id: string,
  env: Env,
  end: number,
): Promise<RunsHold | "again" | undefined> {
  const opened = await openSession(state, id, env, probeEnd(undefined));
  if ("reason" in opened) return NO_RUNS.has(opened.reason) ? undefined : "again";
  const session = opened.session;
  const live = { held: true, said: false, unsupported: false, runs: [] as HeldRun[] };
  const waiters: (() => void)[] = [];
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  let told: () => void = () => undefined;
  const first = new Promise<"told">((resolve) => {
    told = () => {
      resolve("told");
    };
  });
  session.onNotification = (method, params) => {
    if (method !== "runs/blocking") return;
    live.runs = heldRuns(params);
    live.said = true;
    told();
    wake();
  };
  void session
    .call("runs/hold", {})
    .then(
      (value) => {
        // Answered before it said anything: a service that hosts no runs.
        live.unsupported = !live.said && isObject(value) && value["held"] === false;
      },
      (error: unknown) => {
        // A service of an earlier version, which hosts no runs, does not know the request.
        live.unsupported = error instanceof RpcError && error.code === RPC_ERROR.methodNotFound;
      },
    )
    .finally(() => {
      live.held = false;
      told();
      wake();
    });
  const answered = await Promise.race([
    first,
    new Promise<"late">((resolve) => {
      setTimeout(
        () => {
          resolve("late");
        },
        Math.max(0, end - Date.now()),
      ).unref();
    }),
  ]);
  if (answered === "late" || !live.held) {
    session.close();
    return live.unsupported ? undefined : "again";
  }
  return {
    blocking: () => live.runs,
    changed: () =>
      live.held
        ? new Promise<void>((resolve) => {
            waiters.push(resolve);
          })
        : Promise.resolve(),
    get held() {
      return live.held;
    },
    stopAll: async () =>
      heldRuns(await session.call("runs/stop_held", {}, { timeoutMs: STOP_HELD_MS })),
    release: () => {
      session.close();
    },
  };
}

/** System32's tools, from the folder identity.ts finds, never through SystemRoot. */
function windowsTools(): WindowsTools | undefined {
  const folder = system32();
  if (folder === undefined) return undefined;
  return {
    reg: win32.join(folder, "reg.exe"),
    tasklist: win32.join(folder, "tasklist.exe"),
    explorer: win32.join(win32.dirname(folder), "explorer.exe"),
  };
}

export interface DefaultContextOptions {
  readonly env?: Env;
  /** The program the OS entry starts. The default follows A2's layout (render.ts defaultProgram). */
  readonly program?: string;
}

/** The real context: this user's install, the real entry locations and the OS's tools. */
export function defaultServiceContext(options: DefaultContextOptions = {}): ServiceContext {
  const env = options.env ?? process.env;
  const facts = hostFacts(env, process.platform);
  const install = describeInstall(facts, options.program);
  const windows = install.platform === "win32" ? windowsTools() : undefined;
  const registry =
    windows === undefined
      ? NO_REGISTRY
      : new RegExe({ regExe: windows.reg, scratch: install.layout.tmp, run: runProcess });
  return {
    ...install,
    roots: {
      unitDir: join(install.home, ".config", "systemd", "user"),
      launchAgentsDir: join(install.home, "Library", "LaunchAgents"),
      registryRoot: REGISTRY_ROOT,
    },
    run: runProcess,
    startDetached,
    registry,
    windows,
    identity: () => detectIdentity(env, install.platform),
    // What the service would see in the bind context (A2 3.6.5).
    agentShell: Object.keys(rpcContextEnv(env)).some(isAgentMarker),
    record: () => readServiceRecord(install.layout.state),
    alive: processAlive,
    processStart: processStartTime,
    probe: (budgetMs) => probeService(install.layout.state, install.installId, env, budgetMs),
    shutdown: (budgetMs) => shutdownService(install.layout.state, install.installId, env, budgetMs),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readyTimeoutMs: install.platform === "win32" ? 20_000 : 15_000,
    stopTimeoutMs: 15_000,
    pollMs: 250,
  };
}
