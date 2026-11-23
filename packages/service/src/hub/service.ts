// The service's lifecycle: starting → binding → ready → draining → stopped.
//
//   starting  Refuse root, an elevated Administrator and package identity (64) before anything is
//             written. Create the state folder user-only and refuse one that others can write (64).
//             Take service.lock: another holder means exit 73, and nothing of the running
//             service's is touched. Then, as the holder only: machine.json, ipc.key, service.json
//             with state "starting". An update cut off by a crash is finished or rolled back
//             first (version/repair.ts); when current then names another version, exit 75.
//   binding   Pick the endpoint, remove a stale socket file from this install's own
//             socket folder, listen. A Windows pipe name that is taken gets a new instance ID,
//             three tries in all, then exit 70.
//   ready     service.json says "ready". Spaces open in parallel after it (STARTUP below).
//   draining  End the background runs (their containers are killed), stop accepting
//             connections, let them finish for up to 5 s, close each space within its bound (an
//             open in progress is not waited for past it), release the writer locks, remove
//             service.json if it is still ours, release service.lock. Then the exit: 0, 75 for a
//             requested restart, 70 after lost ownership. A step that fails is skipped, so the
//             drain always ends with its exit code.
//
// A crash at any point leaves what the next start recovers from: a lock the OS released, a stale
// service.json, a stale socket file, a temporary file of an atomic write. A start that fails after
// the lock removes its own service.json.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { CLI_NAME, envVar, PRODUCT_NAME } from "@ttasks/brand";
import { nodeDetectHost, type Instance } from "@ttasks/launch";
import { StorageError, type Id, type SpaceWriterHandle } from "@ttasks/storage";
import {
  DEFAULT_CONFIG,
  fatalProblems,
  loadMachineConfig,
  sectionOf,
  type MachineConfig,
} from "../config/machine-toml.ts";
import { configRefusal, unsafeConfigMessage } from "../config/messages.ts";
import {
  openGrants,
  startHttp,
  type DurableGrants,
  type HttpStart,
  type RunningHttp,
  type ServiceDb,
} from "../http/index.ts";
import {
  listenEndpoint,
  logHttp,
  PROTOCOLS,
  type EndpointServer,
  type EndpointUi,
  type ListenEndpoint,
  type ServiceStatus,
} from "./endpoint.ts";
import { writeOfflineCache } from "../mcp/offline.ts";
import { BUILD } from "./build.ts";
import { errorCode, errorType } from "./crash.ts";
import { EXIT, ServiceExit, type ExitCode, type Refusal } from "./exit.ts";
import {
  atomicWrite,
  ensurePrivateDir,
  isPrivateDir,
  judgePath,
  removeStaleTemps,
  type Judged,
} from "./files.ts";
import { detectIdentity, type Identity } from "./identity.ts";
import { unsafeMessage, type UnsafeThing } from "./permissions.ts";
import { readUmask, umaskRefusal, type UmaskRead } from "./umask.ts";
import { KEY_FILE, loadOrCreateKey } from "./key.ts";
import {
  acquireLock,
  identityOf,
  LockBusy,
  watchOwnership,
  type OwnershipCheck,
  type OwnershipLoss,
  type OwnershipWatch,
} from "./lock.ts";
import { Logger, MANAGERS, type Level, type Manager } from "./log.ts";
import { DefaultSpace } from "./default-space.ts";
import { MachineSettings } from "./machine-settings.ts";
import { loadOrCreateMachine, MACHINE_FILE, MachineFileInvalid } from "./machine.ts";
import { Maintenance } from "./maintenance.ts";
import {
  canonicalStatePath,
  homeFolder,
  hostFacts,
  installId,
  LayoutError,
  MAX_SOCKET_PATH_BYTES,
  pipeName,
  resolveLayout,
  RUN_USER_BASE,
  runtimeNames,
  type Layout,
  type RuntimeNames,
} from "./paths.ts";
import { SPACES_FOLDER } from "./space-settings.ts";
import {
  SPACE_OPEN_TIMEOUT_MS,
  SpaceManager,
  type SpaceEntry,
  type SpaceManagerOptions,
  type SpaceView,
} from "./spaces.ts";
import { personSpace, type OpsHost, type ServedSpace } from "../ops/index.ts";
import { FolderMarkers, MARKS_FILE } from "../ops/marker.ts";
import { MemoryGrants, type GrantStore } from "../local/index.ts";
import {
  defaultShimCommand,
  LaunchService,
  type LaunchOptions,
  type OpenTaskRequest,
} from "../launch/index.ts";
import { runsWith } from "../runs/agent.ts";
import { RunService, type RunOptions } from "../runs/service.ts";
import { Bridges, sessionPort, type BindingEvent } from "../binding/index.ts";
import { repairIfIdle, supervisorReplaced, type RepairOutcome } from "../version/repair.ts";
import { UPDATE_JOURNAL } from "../version/journal.ts";
import { currentVersion } from "../version/switch.ts";
import { t3Files, t3FileNames, t3HomeOf, t3Host, T3_STATE_DIR } from "./t3.ts";
import { homeGate } from "./home-gate.ts";
import { homeRows } from "./home-rows.ts";
import { namedBy } from "./named.ts";
import { SeenCalls } from "./agent-homes.ts";
import { agentAppVerbs, personEnv } from "./agent-apps.ts";
import { findMonitor, Monitor, MONITOR_VARIABLE, type MonitorCommand } from "../monitor/index.ts";
import { pageFolderVerbs } from "./page-folders.ts";
import { pageSpaceVerbs } from "./page-spaces.ts";
import { within } from "./wait.ts";

/** A2 3.12.6: while it runs, the service looks for an interrupted update every 10 s. */
export const UPDATE_CHECK_MS = 10_000;

/**
 * Logs what a repair of an interrupted update did, and whether the service must restart so its
 * manager starts what the install now is: when current names another version than this build's
 * own, or when the repair may have replaced the Windows supervisor (ttasksw.exe, repair.ts
 * supervisorReplaced) and this service runs under it. That supervisor may still run from the old
 * file, renamed aside; before it starts the service again (after this exit 75, or after any other
 * exit, should this one die first) it sees that bin\ttasksw.exe is another file and starts that
 * one in its place (launcher.c hand_over). A service run from source names no version and never
 * restarts for this.
 */
function afterRepair(log: Logger, outcome: RepairOutcome | undefined, manager: Manager): boolean {
  if (outcome === undefined || outcome.kind === "nothing") return false;
  if (outcome.kind === "stuck") {
    log.log("update.repaired", { outcome: "stuck" });
    return false;
  }
  log.log(
    "update.repaired",
    outcome.kind === "kept"
      ? { outcome: "kept", to: outcome.current }
      : { outcome: outcome.kind, from: outcome.journal.from, to: outcome.journal.to },
  );
  // The build stamps its own label (scripts/build/bundle.ts); from source it stays "source".
  const build: string = BUILD.build;
  if (build === "source") return false;
  if (outcome.current !== BUILD.version) {
    log.log("update.restart", { version: outcome.current, why: "version" });
    return true;
  }
  if (manager !== "ttasksw" || !supervisorReplaced(outcome)) return false;
  log.log("update.restart", { version: outcome.current, why: "supervisor" });
  return true;
}

export const SERVICE_FILE = "service.json";
export const SERVICE_LOCK = "service.lock";
export const SERVICE_FORMAT = 1;
/** A2 3.3.1: in-flight work gets up to 5 s when the service drains. */
export const DRAIN_MS = 5_000;
/** After the drain's grace, the connections still open are destroyed: this long at most. */
const ENDPOINT_CLOSE_MS = 2_000;
/** A2 3.4: a taken pipe name gets a new instance ID, three tries in all, then exit 70. */
export const ENDPOINT_TRIES = 3;
/**
 * After lost ownership of service.lock the spaces get this long to close (their writer.lock files
 * are still theirs), so the exit 70 comes within the Verify line's 10 s of the loss (A7 3.8
 * M1.08) when change notifications report it. A space that does not close keeps its writer.lock
 * until the exit releases it. A lost writer.lock ends the process at once instead (spaces.ts).
 */
export const LOST_SPACE_CLOSE_MS = 2_000;

export const TTASKS_SERVICE_MANAGER = envVar("SERVICE_MANAGER");

export { BUILD };

export type Env = Readonly<Record<string, string | undefined>>;

export interface StartOptions {
  readonly env?: Env;
  /** Who the process runs as. Tests inject one: the real check is detectIdentity(). */
  readonly identity?: () => Identity;
  /** The process's umask. Tests inject one: the real read is readUmask(), which never sets it. */
  readonly umask?: () => UmaskRead;
  /** The space manager's worker start and bounds. Tests pass others. */
  readonly spaceOptions?: Pick<
    SpaceManagerOptions,
    | "startWorker"
    | "openTimeoutMs"
    | "closeTimeoutMs"
    | "now"
    | "syncHost"
    | "build"
    | "recheckDelaysMs"
  >;
  /**
   * False: no backup upkeep and no projection for the spaces (tests that look at a space folder's
   * files). Both are A1 3.9's maintenance worker's.
   */
  readonly maintenance?: boolean;
  /** The local endpoint. The default is the M1.09 seam in endpoint.ts. */
  readonly listen?: ListenEndpoint;
  /** Linux's per-user runtime folders. Tests pass another. */
  readonly runUserBase?: string;
  /** Overrides machine.toml's `[log] level`. */
  readonly logLevel?: Level;
  readonly ownershipCheckMs?: number;
  /** Writes the line a person reads for a refusal or a lock held elsewhere. Default: stderr. */
  readonly say?: (line: string) => void;
  /** Called once the log exists, so a crash while starting can write its crash file. */
  readonly attach?: (context: { readonly log: Logger; readonly crashDir: string }) => void;
  /** Launching (launch/): clocks, the process probe and the terminal's start, for tests and M2.09. */
  readonly launch?: LaunchOptions;
  /**
   * The UI's HTTP listener (A2 3.8, M2.12), with the grants table in service.sqlite. `runServe()`
   * passes the product's settings; without it the service runs no listener and keeps its grants
   * in memory, so a test that does not ask for HTTP never binds a port of 7713 to 7733.
   */
  readonly http?: HttpStart;
  /** Background runs: the containers, ttasks-run.exe and the host's times, for tests. */
  readonly runs?: RunOptions;
  /**
   * The page's agent apps: the environment and home folder they are looked for in, and the home
   * the page shows as `~`, for tests. Default: the person's own, as Open's agents get them.
   */
  readonly agentApps?: { readonly env?: Env; readonly home?: string };
  /** The Agent Monitor to start, for tests. Default: `ttam` on the person's PATH. */
  readonly monitor?: { readonly command: () => Promise<MonitorCommand> };
}

export type StopReason = "signal" | "request";

export interface RunningService {
  readonly layout: Layout;
  readonly installId: string;
  readonly instance: string;
  readonly endpoint: { readonly kind: "unix" | "pipe"; readonly path: string };
  readonly runtime: RuntimeNames;
  readonly log: Logger;
  /** machine.toml as this start read it (A2 3.2.4). Reloading on change is a later step's. */
  readonly config: MachineConfig;
  status(): ServiceStatus;
  spaces(): SpaceView[];
  /**
   * The registered spaces' manager: close one, restore one in place, claim a read-only copy
   * (A1 3.18). M1.10's handlers call these through the handler table.
   */
  readonly spaceManager: Pick<SpaceManager, "open" | "close" | "restoreInPlace" | "claim">;
  /**
   * The request path's host (ops/): this machine and the spaces it serves. The local endpoint's
   * `op/call` uses it; so do MCP (M2.02) and HTTP (M2.12), and the contract suite in-process.
   */
  readonly ops: OpsHost;
  /** Launching (A4 3.6.3, 3.9): each open space's launch machine and the shim's methods. */
  readonly launches: LaunchService;
  /** The bridge connections and their bindings. */
  readonly bridges: Bridges;
  /** Background runs: the containers' probe, each open space's run host and its recovery. */
  readonly runs: RunService;
  /** Resolves when the registered spaces have each opened or become unavailable. */
  readonly spacesSettled: Promise<void>;
  /** The UI's HTTP listener (M2.12) when the service runs one. */
  readonly http: RunningHttp | undefined;
  /** The Agent Monitor's child, started by the first ask, ended with the service. */
  readonly monitor: Monitor;
  /** Drains and stops. Resolves with the exit code: 0, or 75 when a restart was asked for. */
  stop(options?: { restart?: boolean; reason?: StopReason }): Promise<ExitCode>;
  /** Resolves with the exit code once the service has stopped, by stop() or by itself (70). */
  readonly exited: Promise<ExitCode>;
}

const managerOf = (env: Env): Manager => {
  const value = env[TTASKS_SERVICE_MANAGER] ?? "";
  return (MANAGERS as readonly string[]).includes(value) ? (value as Manager) : "manual";
};

const sayToStderr = (line: string): void => {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // Nothing else to tell.
  }
};

/** A field of the service.json at `state`, or undefined. Never trusted for a decision. */
function serviceJsonField(state: string, field: "pid" | "instance"): unknown {
  try {
    const record = JSON.parse(readFileSync(join(state, SERVICE_FILE), "utf8")) as unknown;
    return typeof record === "object" && record !== null
      ? (record as Record<string, unknown>)[field]
      : undefined;
  } catch {
    return undefined;
  }
}

/** At most this many machine.toml problems are logged at one start. */
const MAX_LOGGED_PROBLEMS = 50;

export { configRefusal, unsafeConfigMessage };

/** Whether `path` is inside the folder `folder` (not the folder itself). */
const isInside = (path: string, folder: string): boolean => {
  const rel = relative(folder, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const refuse = (say: (line: string) => void, refusal: Refusal, line: string): ServiceExit => {
  say(line);
  return new ServiceExit(EXIT.refused, "refused", refusal);
};

/**
 * ensurePrivateDir, with the failures no restart can mend refused (64) instead of crashing (70),
 * so a service manager does not restart into them: a file where the folder belongs, or a place the
 * user cannot create it. The line names no path.
 */
function privateDir(
  dir: string,
  platform: NodeJS.Platform,
  say: (line: string) => void,
  what: string,
  need: "folder" | "private_folder" = "folder",
): Judged | undefined {
  try {
    return ensurePrivateDir(dir, platform, need);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR") {
      throw refuse(say, "invalid_config", `${PRODUCT_NAME}'s ${what} is a file, not a folder.`);
    }
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw refuse(say, "invalid_config", `${PRODUCT_NAME}'s ${what} cannot be created there.`);
    }
    throw error;
  }
}

/**
 * Starts the service and returns once it is ready, or throws ServiceExit with the exit code of a
 * refusal (64), a lock held elsewhere (73) or a failure while starting (70).
 */
export async function startService(options: StartOptions = {}): Promise<RunningService> {
  const startedAt = Date.now();
  const t0 = performance.now();
  const env = options.env ?? process.env;
  const platform = process.platform;
  const say = options.say ?? sayToStderr;
  const facts = hostFacts(env, platform);

  // --- starting: who runs, checked before anything is written
  const identity = (options.identity ?? (() => detectIdentity(env, platform)))();
  if (identity.root || identity.elevated === true) {
    throw refuse(
      say,
      identity.root ? "root" : "elevated",
      `${PRODUCT_NAME}'s service does not run as root or as an elevated administrator: the agents it starts would inherit those rights.`,
    );
  }
  if (identity.elevated === undefined) {
    throw refuse(
      say,
      "elevation_unknown",
      `${PRODUCT_NAME}'s service could not check whether it runs elevated, so it does not start.`,
    );
  }
  // A umask that takes away the person's own bits, or one that cannot be read: refused before any
  // folder is made (umask.ts).
  const umaskLine = umaskRefusal(
    (options.umask ?? (() => readUmask(platform)))(),
    `${PRODUCT_NAME}'s service does not start`,
  );
  if (umaskLine !== undefined) throw refuse(say, "unsafe_umask", umaskLine);

  let layout: Layout;
  try {
    layout = resolveLayout(facts);
  } catch (error) {
    if (!(error instanceof LayoutError)) throw error;
    throw refuse(say, "invalid_config", `${PRODUCT_NAME}'s service: ${error.message}.`);
  }
  // A folder another user can change is never written to: the refusal goes to stderr only. They
  // are judged together, so that one command fixes all of them: in a folder that fails, nothing is
  // made, and a folder that is there is judged too (or named as not seen).
  const failed: { thing: UnsafeThing; hidden: string[] }[] = [];
  for (const [dir, name] of [
    [layout.state, "state folder"],
    [layout.logs, "log folder"],
    [layout.crash, "crash folder"],
  ] as const) {
    const named = `${PRODUCT_NAME}'s ${name}`;
    const parent = failed.find((f) => isInside(dir, f.thing.facts.path));
    const judged =
      parent === undefined
        ? privateDir(dir, platform, say, name)
        : judgePath(dir, "folder", { followLink: true });
    if (judged === "unseen") parent?.hidden.push(named);
    else if (judged !== undefined) failed.push({ thing: { name: named, ...judged }, hidden: [] });
  }
  // The folders of its own in `<state>` that hold what the service acts on, when they are there:
  // each space's settings (its backup folder), the pairing with T3, and the temporary folder. Each
  // is made when it is first needed, so here it is only judged, with the three above and in the
  // same line (A2 3.2.2 rule 5).
  for (const [dir, name] of [
    [layout.tmp, "temporary folder"],
    [join(layout.state, SPACES_FOLDER), "folder of space settings"],
    [join(layout.state, T3_STATE_DIR), "T3 folder"],
  ] as const) {
    const named = `${PRODUCT_NAME}'s ${name}`;
    const judged = judgePath(dir, "folder", { followLink: true });
    if (judged === "unseen") {
      failed.find((f) => isInside(dir, f.thing.facts.path))?.hidden.push(named);
    } else if (judged !== undefined) {
      failed.push({ thing: { name: named, ...judged }, hidden: [] });
    }
  }
  if (failed.length > 0) {
    throw refuse(
      say,
      "unsafe_permissions",
      unsafeMessage(
        failed.map(({ thing, hidden }) =>
          hidden.length === 0 ? thing : { ...thing, hides: hidden.join(" and ") },
        ),
        `Whoever can change ${failed.length > 1 ? "them" : "it"} could change what ${PRODUCT_NAME} records and runs, so the service does not start`,
      ),
    );
  }
  const canonical = canonicalStatePath(realpathSync.native(layout.state), platform);
  const install = installId(canonical);
  // machine.toml is read before the log, which takes its level. Its problems are acted on after
  // the lock, so a second start still exits 73 whatever the file holds.
  const machineToml = loadMachineConfig(layout.config, platform);
  const config = machineToml.config;
  const log = new Logger({ dir: layout.logs, level: options.logLevel ?? config.log.level });
  options.attach?.({ log, crashDir: layout.crash });
  const manager = managerOf(env);
  log.log("service.starting", {
    manager,
    version: BUILD.version,
    build: BUILD.build,
    separate: layout.home !== undefined,
  });
  if (identity.package !== null) {
    log.log("service.refused", { reason: "packaged" });
    throw refuse(
      say,
      "packaged",
      `${PRODUCT_NAME}'s service cannot run inside another app's package. Start it from the Start menu or a normal terminal.`,
    );
  }

  // --- the service lock (A2 3.4)
  const lock = await acquireLock(join(layout.state, SERVICE_LOCK)).catch((error: unknown) => {
    if (error instanceof LockBusy) {
      const pid = serviceJsonField(layout.state, "pid");
      const holder = typeof pid === "number" && Number.isSafeInteger(pid) ? pid : undefined;
      log.log("service.locked", holder === undefined ? {} : { holder });
      say(
        `A ${PRODUCT_NAME} service already runs for this state folder${holder === undefined ? "" : ` (PID ${String(holder)})`}.`,
      );
      throw new ServiceExit(EXIT.locked, "locked");
    }
    log.log("service.lock_failed", error instanceof StorageError ? { code: error.code } : {});
    throw new ServiceExit(EXIT.crashed, "lock_failed");
  });
  log.own();
  log.log("service.lock_acquired", { ms: Math.round(performance.now() - t0) });

  // From here this process owns the install. A failure releases what it took and exits 70 (or 64).
  let endpointServer: EndpointServer | undefined;
  let httpRunning: RunningHttp | undefined;
  let grantsDb: { db: ServiceDb; grants: DurableGrants } | undefined;
  // The grants table the endpoint and `setup/*` use: service.sqlite's when the UI listener runs
  // (M2.12), else one in memory for this start.
  let grantStore: GrantStore | undefined;
  const grantsOf = (): GrantStore => (grantStore ??= grantsDb?.grants ?? new MemoryGrants());
  let ownRuntime: RuntimeNames | undefined;
  try {
    // machine.toml (A2 3.2.4): each problem is logged by section and code; one in the file itself
    // or in [[spaces]] refuses the start (64), naming the key and code but never a value.
    for (const problem of machineToml.problems.slice(0, MAX_LOGGED_PROBLEMS)) {
      log.log("config.problem", {
        section: sectionOf(problem),
        code: problem.code,
        severity: problem.severity,
      });
    }
    const fatal = fatalProblems(machineToml.problems);
    if (machineToml.unsafe !== undefined) {
      // The log names the code only; the person reads which file or folder, and the fix.
      log.log("service.refused", { reason: "unsafe_permissions" });
      throw refuse(say, "unsafe_permissions", unsafeConfigMessage(machineToml.unsafe));
    }
    if (fatal.length > 0) {
      log.log("service.refused", { reason: "invalid_config" });
      throw refuse(say, "invalid_config", configRefusal(fatal));
    }
    log.log("config.loaded", {
      present: machineToml.present,
      spaces: config.spaces.length,
      instances: config.instances.length,
      problems: machineToml.problems.length,
    });

    // An update that was cut off (A2 3.12.6): finished or rolled back before the service binds,
    // unless an updater still holds update.lock. The launchers an update renamed aside go too.
    // When current then names another version than this one, the service exits 75 so its manager
    // starts the one current names.
    const updateRepair = { root: layout.root, state: layout.state, platform } as const;
    const atStart = await repairIfIdle({ ...updateRepair, clean: true }).catch((error: unknown) => {
      const code = errorCode(error);
      log.log("update.repair_failed", code === undefined ? {} : { code });
      return undefined;
    });
    if (afterRepair(log, atStart, manager)) throw new ServiceExit(EXIT.restart, "restart");
    // An update that can be neither finished nor rolled back restarts nothing: its journal then
    // holds no run back.
    let repairStuck = atStart?.kind === "stuck";

    const temps = removeStaleTemps(layout.state, [
      SERVICE_FILE,
      KEY_FILE,
      MACHINE_FILE,
      MARKS_FILE,
    ]);
    // T3's machine state (M2.11) is written the same way, in its own folder.
    const t3Temps = removeStaleTemps(join(layout.state, T3_STATE_DIR), t3FileNames());
    if (temps + t3Temps > 0) {
      log.log("service.stale_removed", { what: "temp_file", count: temps + t3Temps });
    }

    let machine;
    try {
      const loaded = loadOrCreateMachine(layout.state, platform);
      machine = loaded.machine;
      if (loaded.created) log.log("service.machine_created");
    } catch (error) {
      if (!(error instanceof MachineFileInvalid)) throw error;
      log.log("service.refused", { reason: "invalid_config" });
      throw refuse(say, "invalid_config", `${PRODUCT_NAME}'s machine.json is damaged.`);
    }
    // Background runs: the probe starts now, before the service starts any other process, since on
    // Linux it moves the service into its unit's `main` cgroup. Each space's recovery waits for it.
    // The queue's limits are read from machine.toml at each round: a change applies without a
    // restart, which would end the runs.
    let runSettings = config.runs;
    let runHome: string | undefined;
    try {
      runHome = homeFolder(facts);
    } catch {
      runHome = undefined;
    }
    const runs = new RunService({
      ...options.runs,
      machine: machine.id,
      stateDir: layout.state,
      platform,
      spaces: () => made.spaces?.served() ?? [],
      log,
      settings: () => {
        // A file that cannot be used as a whole, one saved halfway for one, keeps the last
        // settings read: the person's limits do not fall back to the defaults meanwhile.
        const loaded = loadMachineConfig(layout.config, platform);
        if (!loaded.present || loaded.config !== DEFAULT_CONFIG) runSettings = loaded.config.runs;
        return runSettings;
      },
      instances: () => instances,
      // What a run starts, from its record: the folder a launch would work in, the person's
      // environment as Open's agents get it, and TTasks's own command for the bridge its agent is given.
      agents: {
        platform,
        home: runHome,
        version: BUILD.version,
        instances: () => instances,
        folder: async (space, folder) =>
          (await launching.service?.runFolder(space, folder)) ?? { refused: "folder_missing" },
        base: async () => launching.service?.environment.base(),
        command: () =>
          options.launch?.shimCommand ??
          defaultShimCommand({ commandFolder: layout.bin, platform }),
      },
      folderUsable: async (space, folder) => {
        const service = launching.service;
        if (service === undefined) return true;
        return service.folderUsable(space, folder);
      },
      // From the journal's write to its removal an update may restart the service, a repair
      // included, whether or not its updater still holds the queue.
      updating: () => !repairStuck && existsSync(join(layout.state, UPDATE_JOURNAL)),
    });
    void runs.probe();

    const { key, replaced } = loadOrCreateKey(layout.state, platform);
    if (replaced !== undefined) log.log("service.key_created", { reason: replaced });

    let instance = randomBytes(16).toString("hex");
    const runtime = runtimeNames(
      layout,
      install,
      facts,
      isPrivateDir,
      options.runUserBase ?? RUN_USER_BASE,
    );
    ownRuntime = runtime;
    let endpoint: { kind: "unix" | "pipe"; path: string } | null = null;
    let state: ServiceStatus["state"] = "starting";
    // The space manager is made once the instance ID is final (a taken pipe name changes it).
    const made: { spaces?: SpaceManager } = {};

    const status = (): ServiceStatus => ({
      state,
      pid: process.pid,
      instance,
      install_id: install,
      version: BUILD.version,
      build: BUILD.build,
      uptime_ms: Date.now() - startedAt,
      manager,
      protocol: PROTOCOLS,
      endpoint,
      spaces: made.spaces?.described().filter((space) => space.forgotten !== true) ?? [],
      http: httpRunning?.status() ?? null,
      runs: runs.status(),
    });
    const serviceJson = join(layout.state, SERVICE_FILE);
    /** `beforeRename`: a last check right before the new file replaces the old (atomicWrite). */
    const writeServiceJson = (beforeRename?: () => void): void => {
      const record = {
        format: SERVICE_FORMAT,
        instance,
        install_id: install,
        pid: process.pid,
        state,
        started_at: new Date(startedAt).toISOString(),
        version: BUILD.version,
        build: BUILD.build,
        protocol: PROTOCOLS,
        endpoint,
        // The UI's HTTP listener (A2 3.2.3): host, port, persisted port, moved, blocked.
        http: httpRunning?.status() ?? null,
        manager,
        package: null,
      };
      atomicWrite(serviceJson, `${JSON.stringify(record, null, 2)}\n`, 0o600, beforeRename);
    };
    writeServiceJson();

    // --- binding. M6.13: reconcile an unfinished update journal (A2 3.12.6) before listening.
    let stopEarly: { restart: boolean } | undefined;
    let onStopRequest = (o: { restart: boolean }): void => {
      stopEarly = o;
    };
    // The space manager exists once the endpoint is bound; a call that comes before finds no space.
    const spaceManager = (): SpaceManager => {
      if (made.spaces === undefined) {
        throw new StorageError("STORAGE_MISUSE", "The service is still starting");
      }
      return made.spaces;
    };
    // The instances Open uses: machine.toml's at start, then what `ttasks setup instances` writes.
    let instances: readonly Instance[] = config.instances;
    // The machine's default space (A2 3.1): machine.toml's at start, then what Make default and
    // `ttasks space use` write (default-space.ts).
    const defaults = new DefaultSpace({
      configDir: layout.config,
      log,
      initial: config.service.defaultSpace,
      known: () => made.spaces?.served() ?? [],
    });
    // Made before the endpoint listens (its handler table takes the shim's methods), once the
    // socket folder, which holds the launch folders on Linux, has been checked below.
    const launching: { service?: LaunchService } = {};
    // The registered spaces as the binds and the request path read them: the space manager's once
    // the configuration's are handed to it, and until then those of the configuration, opening,
    // beside any the manager has already. So a bind during startup settles the default and the only
    // space by registered ID, and a call right after it is told that space is still opening.
    const spacesHanded = { done: false };
    const knownSpaces = (): ServedSpace[] => {
      const served = made.spaces?.served() ?? [];
      if (spacesHanded.done) return served;
      const has = new Set(served.map((space) => space.id ?? space.registered));
      return [
        ...served,
        ...config.spaces.filter((space) => space.enabled && !has.has(space.id)).map(openingEntry),
      ];
    };
    // The grant gate: an agent home's calls reach only the spaces its live agent-home rows name,
    // read from the grants table at each call.
    const homes = homeGate({
      grants: grantsOf,
      spaces: knownSpaces,
      defaultSpace: () => defaults.get(),
    });
    // Who an agent's connection is (binding/): the launch or run its values name, from machine state
    // and the runs this start holds, and its home's rows. No space has to be open.
    const sessions = sessionPort({
      named: (values) => namedBy({ launches: () => launching.service?.host, runs }, values),
      rows: (app, home) => homeRows({ grants: grantsOf, platform }, app, home),
      runAllows: (instance, space, run) => runs.allows(instance, space, run),
      machineDefault: () => homes.machineDefault(),
      live: (space) => {
        const counts = new Map(launching.service?.host.liveSessions(space) ?? []);
        for (const [task, count] of runs.liveSessions(space)) {
          counts.set(task, (counts.get(task) ?? 0) + count);
        }
        return counts;
      },
      log: (event: BindingEvent) => {
        const { ev, ...fields } = event;
        log.log(ev, fields);
      },
    });
    const bridges = new Bridges({
      sessions,
      spaces: knownSpaces,
      defaultSpace: () => defaults.get(),
    });
    // What `~` means in a folder here, and TTasks's own data, where no folder is bound.
    let personHome: string | undefined;
    try {
      personHome = homeFolder(facts);
    } catch {
      personHome = undefined;
    }
    // The markers in projects' and tasks' folders, which the writes leave and a launch checks.
    const markers = new FolderMarkers({
      file: join(layout.state, MARKS_FILE),
      platform,
      ...(personHome === undefined ? {} : { home: personHome }),
    });
    // The person's own `ttam`, looked for in their environment as Open's agents get it.
    const monitorHome = personHome ?? layout.state;
    const monitorIn = (found: Env): Promise<MonitorCommand> =>
      options.monitor?.command() ??
      Promise.resolve(
        findMonitor(
          nodeDetectHost({ platform, env: found, home: monitorHome }),
          monitorHome,
          env[MONITOR_VARIABLE],
        ),
      );
    const monitor = new Monitor({
      command: async () => {
        const source = launching.service?.environment;
        return monitorIn(source === undefined ? env : await personEnv(source).catch(() => env));
      },
      log: (event, fields) => {
        log.log(event, fields);
      },
    });
    const hub = {
      status,
      requestStop: (o: { restart: boolean }) => {
        onStopRequest(o);
      },
      log,
      ui: undefined as EndpointUi | undefined,
      ops: {
        machine,
        spaces: knownSpaces,
        platform,
        ...(personHome === undefined ? {} : { home: personHome }),
        dataFolder: layout.data,
        skillsFolder: layout.skills,
        markers,
        sessions,
        defaultSpace: () => defaults.get(),
        homes,
        resultMismatch: (entry: string) => {
          log.log("service.result_mismatch", { entry });
        },
        // `launch.open` (A4 3.4, 3.15): the one launch machine per space this service keeps.
        launches: {
          openTask: (request: OpenTaskRequest) => {
            const service = launching.service;
            if (service === undefined) {
              throw new StorageError("STORAGE_MISUSE", "The service is still starting");
            }
            return service.openTask(request);
          },
          connected: (
            space: string,
            writer: SpaceWriterHandle,
            launch: string,
            at: number,
            folder: string | undefined,
          ) => {
            const service = launching.service;
            if (service === undefined) return Promise.reject(new Error("Launching is not ready"));
            return service.connected(space, writer, launch, at, folder);
          },
        },
      },
      bridges,
      defaults,
      runs,
      runVerbs: {
        runs,
        space: (named: string | undefined) =>
          personSpace(
            {
              machine,
              spaces: knownSpaces,
              platform,
              defaultSpace: () => defaults.get(),
            },
            named,
          ),
      },
      instances: {
        configDir: layout.config,
        stateDir: layout.state,
        platform,
        log,
        set: (next: readonly Instance[]) => {
          instances = next;
        },
      },
      launches: {
        handlers: () => launching.service?.handlers() ?? {},
        // `doctor/launch` (A3 3.14): the launch service's own scope probe and environment check,
        // and the monitor row, found in the environment that check read: TTAM's hello only.
        doctor: async (take: boolean) => {
          const service = launching.service;
          if (service === undefined) return undefined;
          const { facts, env: found } = await service.doctor(take);
          return { ...facts, monitor: await monitor.probe(await monitorIn(found)) };
        },
      },
      // `ttasks setup t3` (M2.11): T3's routes over `<state>/t3`, the paired one and the CLI
      // fallback (M6.10). Launching through them is a later step's.
      t3: t3Host({
        log,
        home: t3HomeOf(env, facts),
        files: t3Files(layout.state, platform),
        platform,
        env,
        instances: config.instances,
      }),
      // `ttasks setup agents` (M2.14): the agent-home rows of the grants table.
      agentHomes: {
        log,
        platform,
        grants: grantsOf,
        spaces: () => made.spaces?.served() ?? [],
        seen: new SeenCalls(),
      },
      spaces: {
        machine,
        settingsDir: layout.state,
        defaultSpace: () => defaults.get(),
        clearDefault: (id: string) => defaults.clear(id),
        // What the space verbs do is recorded in machine.toml's [[spaces]] (space-records.ts).
        records: { configDir: layout.config, platform, log },
        manager: {
          list: () => spaceManager().described(),
          open: (path: string, id?: Id<"sp">, options?: { readonly retryMigration?: boolean }) =>
            spaceManager().open(path, id, options),
          checkFolder: (folder: string) => spaceManager().checkFolder(folder),
          confirmExcluded: (entry: number) => spaceManager().confirmExcluded(entry),
          close: (entry: number) => spaceManager().close(entry),
          forget: (entry: number) => {
            spaceManager().forget(entry);
          },
          forgettable: (entry: number) => spaceManager().forgettable(entry),
          claim: (entry: number) => spaceManager().claim(entry),
          restoreInPlace: (entry: number, file: string) =>
            spaceManager().restoreInPlace(entry, file),
          recover: (entry: number) => spaceManager().recover(entry),
          folderOf: (entry: number) => spaceManager().folderOf(entry),
          rebuildView: (entry: number) => spaceManager().rebuildView(entry),
          repairSearch: (entry: number) => {
            spaceManager().repairSearch(entry);
          },
          backedUp: (entry: number, at: number) => {
            spaceManager().backedUp(entry, at);
          },
        },
      },
    };
    const plan = runtime.endpoint;
    if (plan.kind === "unix") {
      if (Buffer.byteLength(plan.path) > MAX_SOCKET_PATH_BYTES) {
        log.log("service.refused", { reason: "invalid_config" });
        throw refuse(
          say,
          "invalid_config",
          `${PRODUCT_NAME}'s socket path is longer than ${String(MAX_SOCKET_PATH_BYTES)} bytes.`,
        );
      }
      // The socket file's own mode follows the umask (listen gives it 0777 masked by it). What
      // keeps other users from the socket is this folder, which lets no one else in: one this
      // start made is exactly 0700 (makeDir), and one that was already there must be too (the
      // `private_folder` rule, judged whole so that its one command makes the next start pass).
      // So no mode is ever set on the socket by its path, which could follow a link
      // (A2 3.2.2 rule 5).
      let judged: Judged | undefined;
      try {
        judged = privateDir(plan.dir, platform, say, "socket folder", "private_folder");
      } catch (error) {
        if (error instanceof ServiceExit) log.log("service.refused", { reason: "invalid_config" });
        throw error;
      }
      if (judged !== undefined) {
        log.log("service.refused", { reason: "unsafe_permissions" });
        throw refuse(
          say,
          "unsafe_permissions",
          unsafeMessage(
            [{ name: `${PRODUCT_NAME}'s socket folder`, ...judged }],
            "Whoever can change or open it could reach the service's socket or put their own in its place, so the service does not start",
          ),
        );
      }
    }
    // The grants table in service.sqlite (A2 3.2.5), before the endpoint, which uses it too.
    const httpLog = (event: Parameters<typeof logHttp>[1]) => {
      logHttp(log, event);
    };
    if (options.http !== undefined) grantsDb = await openGrants(layout.state, httpLog);

    // The launch folders hold each launch's plan, the command a shim starts (A4 3.6.3): their root
    // is judged before anything is read from it or made in it (A2 3.2.2 rule 5). On Linux it is in
    // the socket folder judged above; elsewhere it is in `<state>`.
    const launchRoot = judgePath(runtime.launch, "folder", { followLink: true });
    if (launchRoot !== undefined) {
      log.log("service.refused", { reason: "unsafe_permissions" });
      const why = `Whoever can change it could choose what ${PRODUCT_NAME} starts as you, so the service does not start`;
      throw refuse(
        say,
        "unsafe_permissions",
        launchRoot === "unseen"
          ? `${PRODUCT_NAME}'s launch folder cannot be looked at. ${why}.`
          : unsafeMessage([{ name: `${PRODUCT_NAME}'s launch folder`, ...launchRoot }], why),
      );
    }

    // Launching (A4 3.6.3): this install's launch folders, read once; the machines come with the
    // spaces.
    let accountHome: string | undefined;
    try {
      accountHome = homeFolder(facts);
    } catch {
      accountHome = undefined; // No home: the snapshot's shell runs in the state folder.
    }
    const launches = new LaunchService({
      ...options.launch,
      machine: machine.id,
      root: runtime.launch,
      stateDir: layout.state,
      platform,
      env,
      spaces: () => made.spaces?.served() ?? [],
      log,
      terminalSettings: config.terminal,
      instances: () => instances,
      install,
      commandFolder: layout.bin,
      markers,
      ...(accountHome === undefined ? {} : { home: accountHome }),
      // The grant gate's rule for the session the click starts: its home's live row names its
      // space (binding/decide.ts standing).
      registeredElsewhere: (app, home, space) => {
        if (home === undefined) return undefined;
        const rows = homeRows({ grants: grantsOf, platform }, app, home);
        const live = rows.kind === "rows" ? rows.rows.find((row) => row.live) : undefined;
        return live === undefined || live.spaces.includes(space) ? undefined : live.spaces[0];
      },
    });
    launching.service = launches;
    // Settings for this machine (M5.11): the page's theme and keys, and Open's terminal.
    const machineSettings = new MachineSettings({
      configDir: layout.config,
      platform,
      log,
      preferences: config.preferences,
      terminal: {
        view: () => launches.terminalView(),
        settings: () => launches.terminals.settings,
        apply: (next) => {
          launches.terminals.settings = next;
        },
      },
    });
    const listen = options.listen ?? listenEndpoint;
    let bound: { kind: "unix" | "pipe"; path: string } | undefined;
    let socketIdentity: { dev: bigint; ino: bigint } | undefined;
    for (let attempt = 1; bound === undefined; attempt += 1) {
      const path = plan.kind === "pipe" ? pipeName(plan, instance) : plan.path;
      // The lock is ours and the socket folder is this install's own and private, so a socket
      // file at our path is stale (A2 3.4).
      if (plan.kind === "unix" && removeStaleSocket(path)) {
        log.log("service.stale_removed", { what: "socket", count: 1 });
      }
      try {
        endpointServer = await listen({
          path,
          key,
          instance,
          service: BUILD,
          protocols: PROTOCOLS,
          hub,
          grants: grantsOf(),
        });
        bound = { kind: plan.kind, path };
        if (plan.kind === "unix") {
          const stat = lstatSync(path, { bigint: true });
          socketIdentity = { dev: stat.dev, ino: stat.ino };
        }
        log.log("service.endpoint_bound", {
          kind: plan.kind,
          runtime: plan.kind === "pipe" ? "pipe" : plan.runtime,
          attempts: attempt,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" || attempt >= ENDPOINT_TRIES) throw error;
        log.log("service.endpoint_retry", { attempt, code });
        // A taken pipe name: a new instance ID makes a new name (A2 3.4).
        if (plan.kind === "pipe") instance = randomBytes(16).toString("hex");
      }
    }
    const where: { kind: "unix" | "pipe"; path: string } = bound;
    endpoint = where;
    // Set below, once the exit exists: a space's lost writer.lock ends the service at once.
    let lockLost = (): void => undefined;
    const hosted = new SpaceManager({
      ...options.spaceOptions,
      machine,
      instance,
      stateDir: canonical,
      settingsDir: layout.state,
      log,
      // The maintenance worker's work (A1 3.9): the backups, and each open space's projection.
      ...(options.maintenance === false
        ? {}
        : { maintenance: new Maintenance(), projection: true }),
      ...(options.ownershipCheckMs === undefined
        ? {}
        : { ownershipCheckMs: options.ownershipCheckMs }),
      onLockLost: () => {
        lockLost();
      },
    });
    made.spaces = hosted;

    // --- binding, the UI's HTTP listener (A2 3.3.1: "endpoint + HTTP bound" before ready). A
    // port that another user holds or held leaves it blocked: no UI, every UI token revoked, and
    // the socket or pipe goes on serving agents and the CLI (A2 3.8.2).
    if (options.http !== undefined && grantsDb !== undefined) {
      // The page's New space, Open folder and agent apps: the sign-in is the person (`ui`).
      const pageSpaces = pageSpaceVerbs({
        layout,
        userHome: options.agentApps?.home ?? personHome,
        spaces: hub.spaces,
      });
      const apps = agentAppVerbs({
        platform,
        configDir: layout.config,
        stateDir: layout.state,
        root: layout.root,
        tasks: join(layout.bin, platform === "win32" ? `${CLI_NAME}.exe` : CLI_NAME),
        userHome: options.agentApps?.home ?? personHome,
        env: async () =>
          options.agentApps?.env ?? (await personEnv(launches.environment).catch(() => env)),
        homes: hub.agentHomes,
        instances: hub.instances,
        spaceName: (id) => made.spaces?.served().find((s) => s.id === id)?.name,
      });
      const pageFolders = pageFolderVerbs({ ops: hub.ops });
      const running = await startHttp({
        ...options.http,
        installed:
          options.http.installed ??
          (() => {
            const installed = currentVersion(layout.root, platform);
            return installed === BUILD.version ? undefined : installed;
          }),
        stateDir: layout.state,
        configDir: layout.config,
        configured: config.http.port,
        key,
        instance,
        build: BUILD,
        ops: hub.ops,
        defaults,
        machine: machineSettings,
        spaces: {
          propose: (input) => pageSpaces.propose(input, "ui"),
          create: (input) => pageSpaces.create(input, "ui"),
          open: (input) => pageSpaces.open(input, "ui"),
        },
        apps: {
          view: (input) => apps.view(input, "ui"),
          apply: (input) => apps.apply(input, "ui"),
        },
        folders: {
          list: (input, space) => pageFolders.list(input, "ui", space),
          make: (input) => pageFolders.make(input, "ui"),
          project: (input, space) => pageFolders.project(input, "ui", space),
        },
        db: grantsDb.db,
        grants: grantsDb.grants,
        log: httpLog,
        // The page's tiles open through the same launch machines as the shim's claims.
        launch: launches,
        // The page's Run starts the same background runs as `ttasks run`, with any instance that
        // can run.
        runs: {
          queueTask: (space, asked) => runs.queueTask(space, asked),
          list: (space, task) => runs.list(space, task),
          stop: (space, run) => runs.stop(space, run),
          live: (run) => runs.live(run),
          runnable: (key) => {
            const instance = instances.find((i) => i.id === key);
            return instance !== undefined && runsWith(instance);
          },
        },
        onChange: () => {
          try {
            writeServiceJson();
          } catch {
            // The next write carries the change.
          }
        },
      });
      httpRunning = running;
      const ui: EndpointUi = {
        mintCode: () => running.mintCode(),
        setPort: (port, reuse) => running.setPort(port, reuse),
      };
      hub.ui = ui;
    }

    // --- ready
    state = "ready";
    writeServiceJson();
    log.log("service.ready", { ms: Math.round(performance.now() - t0), install, instance });
    // The bridge's offline answers for this build (A2 3.7.3: at every start). A failure leaves the
    // build's own lib/mcp-offline.json in use, which holds the same answers.
    const o0 = performance.now();
    await writeOfflineCache(layout.cache).then(
      (result) => {
        log.log("mcp.offline_written", { result, ms: Math.round(performance.now() - o0) });
      },
      (error: unknown) => {
        const code = errorCode(error);
        log.log("mcp.offline_failed", {
          type: errorType(error),
          ...(code === undefined ? {} : { code }),
        });
      },
    );

    let resolveExited: (code: ExitCode) => void = () => undefined;
    const exited = new Promise<ExitCode>((resolve) => {
      resolveExited = resolve;
    });
    let draining: Promise<ExitCode> | undefined;
    // The update check's timer (below), cleared by the drain.
    const update: { timer?: NodeJS.Timeout } = {};

    // --- ownership of service.lock (A2 3.4). A loss is latched: once service.lock is not the file
    // this start locked, another start may own the install, and nothing of the install's shared
    // paths is touched again. The watch runs until the lock is released, through the drain.
    let ownershipLost = false;
    const loseOwnership = (what: OwnershipLoss, via: OwnershipCheck | "drain"): void => {
      if (ownershipLost) return;
      ownershipLost = true;
      log.log("service.ownership_lost", { what, via });
    };
    const watch: OwnershipWatch = watchOwnership(
      lock,
      (what, via) => {
        loseOwnership(what, via);
        void drain(EXIT.crashed, "ownership_lost");
      },
      options.ownershipCheckMs === undefined ? {} : { intervalMs: options.ownershipCheckMs },
    );
    /**
     * Whether this start still owns the install, read now: no loss latched, and service.lock is
     * still the file it locked. Asked right before each stop step that touches a path another
     * start of this install would use. A lock file it cannot read for another reason is not
     * owned for that step, which is skipped, but no loss is latched (the next start recovers what
     * a crash leaves).
     */
    const stillOwned = (): boolean => {
      if (ownershipLost) return false;
      try {
        const now = identityOf(lock.path);
        if (now.dev === lock.identity.dev && now.ino === lock.identity.ino) return true;
        loseOwnership("replaced", "drain");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") loseOwnership("missing", "drain");
      }
      return false;
    };

    /** Whether the socket file at our path is still the one this start bound (A2 3.4). */
    const socketStillOurs = (): boolean => {
      if (socketIdentity === undefined) return true;
      try {
        const now = lstatSync(where.path, { bigint: true });
        return now.dev === socketIdentity.dev && now.ino === socketIdentity.ino;
      } catch {
        return false;
      }
    };

    /** One step of the drain: a failure is skipped, so the drain always ends with its code. */
    const step = (work: () => void): void => {
      try {
        work();
      } catch {
        // What it left behind is what a crash leaves; the next start recovers from it.
      }
    };

    const drain = (code: ExitCode, reason: StopReason | "ownership_lost"): Promise<ExitCode> => {
      draining ??= (async () => {
        const d0 = performance.now();
        clearInterval(update.timer);
        log.log("service.stopping", { reason, restart: code === EXIT.restart });
        // The ownership watch keeps running: a loss during the drain is latched, and every step
        // below that touches a path another start of this install would use (service.json's
        // draining write, the socket, the runtime folder) asks `stillOwned()` right before it, so a
        // start that took a replaced service.lock meanwhile keeps what it made; service.json's
        // removal checks the file's own instance instead. The steps between are this start's own:
        // its connections, its spaces (their writer.lock files are theirs), service.sqlite's
        // connection, the lock it holds. Exit codes stay those of the stop that began.
        launches.stop();
        // A run's processes end with the service: its containers are killed, and the next start
        // settles the runs.
        await within(Promise.all([runs.close(), monitor.close()]), DRAIN_MS).catch(() => undefined);
        // A drain for a loss (service.lock's, or a space's writer.lock in this process) starts
        // latched.
        if (reason === "ownership_lost") ownershipLost = true;
        if (stillOwned()) {
          state = "draining";
          // Asked again right before the new file replaces the old one.
          step(() => {
            writeServiceJson(() => {
              if (!stillOwned()) throw new Error("ownership lost");
            });
          });
        }
        // The UI first: no new browser request starts work while the service drains.
        if (httpRunning !== undefined && !(await within(httpRunning.close(), ENDPOINT_CLOSE_MS))) {
          log.log("service.drain_timeout", { stage: "endpoint" });
        }
        // Stop accepting. libuv removes a Unix socket's file when its server closes, whatever
        // file is at the path by then, so the server is closed only while the path is still the
        // socket this start bound and the install still this start's. Otherwise it stays open
        // until the process exits.
        if (endpointServer !== undefined && stillOwned() && socketStillOurs()) {
          // Each connection finishes for up to DRAIN_MS (its requests in flight answered), then
          // what is left is closed.
          if (!(await within(endpointServer.close(DRAIN_MS), DRAIN_MS + ENDPOINT_CLOSE_MS))) {
            log.log("service.drain_timeout", { stage: "endpoint" });
          }
        }
        // Bounded, an open in progress included: the drain never waits for a whole open.
        await hosted
          .closeAll(ownershipLost ? LOST_SPACE_CLOSE_MS : undefined)
          .catch(() => undefined);
        // The grants' last uses are written, then service.sqlite closes.
        if (grantsDb !== undefined) {
          const { db, grants } = grantsDb;
          await within(
            grants.close().then(() => db.close()),
            ENDPOINT_CLOSE_MS,
          ).catch(() => undefined);
        }
        // A clean stop leaves nothing of its own in the per-user runtime folder (A2 3.2.1). Once
        // ownership is lost the folder may be another start's, made and not yet bound: left alone.
        // Asked here, right before, and nothing is awaited in between.
        if (stillOwned()) {
          step(() => {
            removeIdleRuntime(runtime);
          });
        }
        // service.json names its owner: it goes only while it names this start's instance, read
        // right before. After a loss that is this start's stale record (a new start's names its own
        // instance and stays); the read and the removal are adjacent calls.
        step(() => {
          if (serviceJsonField(layout.state, "instance") === instance) {
            rmSync(serviceJson, { force: true });
          }
        });
        watch.stop();
        step(() => {
          lock.release();
        });
        log.log("service.stopped", { code, ms: Math.round(performance.now() - d0) });
        resolveExited(code);
        return code;
      })();
      return draining;
    };

    onStopRequest = (o) => {
      void drain(o.restart ? EXIT.restart : EXIT.ok, "request");
    };

    // A space's writer.lock was deleted or replaced (A2 3.4). Its writer, or an open in progress,
    // may still write while another service locks a new file, and only the end of the process
    // stops a worker for certain. So the exit is 70 at once, with nothing closed first: the OS
    // releases every lock, and the next start recovers what a crash leaves. In this process (tests)
    // stop() still drains, to release what the service holds.
    let aborted = false;
    lockLost = () => {
      if (aborted) return;
      aborted = true;
      clearInterval(update.timer);
      watch.stop();
      log.log("service.stopping", { reason: "ownership_lost", restart: false });
      resolveExited(EXIT.crashed);
    };

    // --- STARTUP: the start-up sequence for spaces, after ready (A2 3.3.1 step 3), each space in
    // parallel, in the order of spaces.ts (A2 3.1): finish an interrupted restore in place or
    // recovery; open the writer, which migrates an older revision under the space's writer.lock
    // and claim, with the machine-local backup folder; a refusal that leaves the space readable is
    // read_only with its reason; then, for a space open as this machine's, remove backup leftovers
    // in its own backups folder, take the daily backup when due and apply retention, in a
    // maintenance worker. A restore in place or a claim closes the space through the manager first
    // and goes above the epochs this machine has seen (SpaceManager.restoreInPlace, claim).
    // The registered spaces are machine.toml's [[spaces]], in the file's order, which the space
    // verbs keep (space-records.ts): the enabled ones open, the others are listed closed. Each
    // opens only as the space its entry's ID names (spaces.ts): another space there, or none, is
    // unavailable with its reason, and its entry stays.
    const spacesOpening = hosted.openAll(
      config.spaces.map((space): SpaceEntry => ({
        id: space.id,
        path: space.path,
        enabled: space.enabled,
      })),
    );
    // openAll put the entries in the manager before its first wait: it answers for them now.
    spacesHanded.done = true;

    // Once the registered spaces have settled, each open one gets its launch machine and its
    // recovery (A4 3.9.3), and the sweep and the PID check run every 30 s, and so do the runs'
    // rounds. A migration has no bound, so the other spaces wait at most an open's bound for it:
    // a space that opens later joins at the next round.
    const upkeepAfter = new Promise<void>((resolve) => {
      setTimeout(resolve, options.spaceOptions?.openTimeoutMs ?? SPACE_OPEN_TIMEOUT_MS).unref();
    });
    void Promise.race([spacesOpening, upkeepAfter]).then(() => {
      if (draining === undefined && !aborted) {
        launches.start();
        runs.watch();
      }
    });

    // While it runs, an update journal whose updater is gone is finished or rolled back within
    // 10 s (A2 3.12.6). A live updater holds update.lock, and then nothing is done. An update
    // that cannot be repaired (stuck) or a repair that fails is logged once, not every 10 s.
    let repairing = false;
    let reported: string | undefined;
    update.timer = setInterval(() => {
      if (repairing || draining !== undefined || aborted) return;
      repairing = true;
      void repairIfIdle(updateRepair)
        .then(
          (outcome) => {
            if (outcome !== undefined) repairStuck = outcome.kind === "stuck";
            if (outcome?.kind === "stuck") {
              if (reported === "stuck") return;
              reported = "stuck";
            } else if (outcome !== undefined) reported = undefined;
            if (afterRepair(log, outcome, manager) && draining === undefined && !aborted) {
              void drain(EXIT.restart, "request");
            }
          },
          (error: unknown) => {
            const code = errorCode(error);
            if (reported === `failed ${code ?? ""}`) return;
            reported = `failed ${code ?? ""}`;
            log.log("update.repair_failed", code === undefined ? {} : { code });
          },
        )
        .finally(() => {
          repairing = false;
        });
    }, UPDATE_CHECK_MS);
    update.timer.unref();

    const service: RunningService = {
      layout,
      installId: install,
      instance,
      endpoint: where,
      runtime,
      log,
      config,
      status,
      spaces: () => hosted.list(),
      spaceManager: hosted,
      ops: hub.ops,
      launches,
      bridges,
      runs,
      spacesSettled: spacesOpening,
      http: httpRunning,
      monitor,
      stop: (o = {}) =>
        aborted
          ? drain(EXIT.crashed, "ownership_lost")
          : drain(o.restart === true ? EXIT.restart : EXIT.ok, o.reason ?? "request"),
      exited,
    };
    if (stopEarly !== undefined) void service.stop({ restart: stopEarly.restart });
    return service;
  } catch (error) {
    if (httpRunning !== undefined) await within(httpRunning.close(), DRAIN_MS);
    if (endpointServer !== undefined) await within(endpointServer.close(), DRAIN_MS);
    if (grantsDb !== undefined) await within(grantsDb.db.close(), DRAIN_MS);
    // A service.json that names this process says "starting" for a service that never ran. This
    // process holds the lock, so no other start of this install writes it.
    try {
      if (serviceJsonField(layout.state, "pid") === process.pid) {
        rmSync(join(layout.state, SERVICE_FILE), { force: true });
      }
    } catch {
      // It cannot be removed: the next start replaces it.
    }
    // The runtime folder goes when it is empty, as at a clean stop, while the lock is this
    // start's: once it is not, the folder may be another start's, made and not yet bound.
    try {
      const now = identityOf(lock.path);
      if (
        ownRuntime !== undefined &&
        now.dev === lock.identity.dev &&
        now.ino === lock.identity.ino
      ) {
        removeIdleRuntime(ownRuntime);
      }
    } catch {
      // The lock is gone: the folder is left alone.
    }
    lock.release();
    if (error instanceof ServiceExit) throw error;
    const code = errorCode(error);
    log.log("service.start_failed", {
      type: errorType(error),
      ...(code === undefined ? {} : { code }),
    });
    throw new ServiceExit(EXIT.crashed, "start_failed");
  }
}

/**
 * A space of the configuration as binds and calls see it before the space manager has it:
 * opening, known by the ID and the folder its entry names, with no ID or name of its own yet.
 */
export function openingEntry(space: { readonly id: string; readonly path: string }): ServedSpace {
  return {
    id: undefined,
    registered: space.id,
    name: undefined,
    folder: space.path,
    state: "opening",
    writer: undefined,
    reader: undefined,
  };
}

/**
 * At a clean stop, the per-user runtime folder (`/run/user/<uid>/ttasks-<install>/`, Linux) goes
 * when nothing is left in it: the socket went with the server, and the launch root goes when it
 * holds no launch folder. A launch folder is a launch the next start still needs (a live shim
 * reattaches with it, recovery reads it), so a runtime folder that holds one stays, whole. Only
 * empty folders are removed (rmdir), so nothing in them can be lost; anything else there (a socket
 * that is not this start's) keeps the folder too. The fallback under `<state>` is the home's own.
 */
export function removeIdleRuntime(runtime: Pick<RuntimeNames, "launch" | "runtimeDir">): void {
  const dir = runtime.runtimeDir;
  if (dir === undefined) return;
  for (const folder of [runtime.launch, dir]) {
    try {
      rmdirSync(folder);
    } catch (error) {
      // Not empty, or not removable: everything stays.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
  }
}

/** Removes a stale socket file before listening. A folder at the path is refused (exit 64). */
function removeStaleSocket(path: string): boolean {
  let isDirectory: boolean;
  try {
    isDirectory = lstatSync(path).isDirectory();
  } catch {
    return false;
  }
  if (isDirectory) {
    throw new ServiceExit(EXIT.refused, "refused", "invalid_config");
  }
  rmSync(path, { force: true });
  return true;
}
