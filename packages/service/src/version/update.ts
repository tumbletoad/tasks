// `tasks update --from <archive>`, `--rollback` and `--repair` (A2 3.12.6, the subset of A7 3.13
// M6.12: a local archive, no hosted channel). The installed version replaces itself, in this order:
//   1. update.lock for the whole update (A2 3.2.3). A second update waits for it; then any journal
//      it finds is an interrupted update, which is finished or rolled back first (repair.ts).
//   2. The release is verified with the keys the INSTALLED version carries (UPDATE_KEYS in lib/):
//      the raw Ed25519 signature of SHA256SUMS beside the archive, then the archive's SHA-256 against
//      its line there (release.ts). Nothing of the archive is unpacked, loaded or run before that.
//   3. The archive's entries pass the install scripts' rule (archive.ts checkEntries) before
//      anything is written; the journal names the staging folder before it is made.
//   4. The archive is unpacked into `versions/.staging-<random>`, every file is checked against its
//      manifest.json, and the folder is renamed to `versions/<v>`, or a folder already there must
//      equal it (A2 3.12.4 step 7).
//   5. The candidate's self-test runs through its own version-local launcher
//      (`versions/<v>/bin/tasks doctor --self-test --json`): integrity, the runtime gate and the
//      candidate's checks. Authenticity was settled in step 2; this is the functional half.
//   6. The journal records each stable launcher the switch changes, with its old and new SHA-256
//      (phase `staged`), and on Windows each one is staged as `bin\<name>.new` (checked, flushed)
//      before `current` changes (A2 3.12.6 step 8). Then `current` is switched atomically
//      (`switched`), then each changed launcher is swapped for its staged copy, one at a time,
//      `tasks.exe` first: by one rename where Windows allows it, else by renaming the running one
//      aside and the new one in (switch.ts placeLauncher; `launchers_done`), and install.json
//      records the version.
//   7. The service is restarted through the OS (A2 3.12.6 step 11): a supervised service is asked
//      for `service/shutdown {restart: true}` and its manager starts it again from the new current;
//      one nobody supervises is stopped and started. The update waits up to 30 s for a handshake
//      that names the new version. Sessions keep running in their own processes and reconnect
//      (A2 3.11). Background runs end with the service, so before anything changes the update
//      holds new runs back, waits up to 15 minutes for the running ones, and then asks: stop them,
//      or give the update up (waitForRuns).
//   8. The journal goes and the lock is let go. A failure after the switch rolls back (A2 3.12.6
//      step 13) through the same repair: phase `rolling_back`, current and the launchers back, the
//      old service again, the reason in install.json for doctor.
// It never removes a version folder and never touches a person's data: spaces, `<config>` and
// `<state>` beyond its own files (update.lock, update.json, install.json, and the self-test's
// folders in `<state>/tmp/`). A migration, if the new version needs one, runs later, when the new
// version opens a space, behind its verified backup (A1).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { PRODUCT_ID, PRODUCT_NAME } from "@tasks/brand";
import { createFile, ensurePrivateDir, judgePath, makeDir } from "../hub/files.ts";
import { acquireLock, LockBusy, type HeldLock } from "../hub/lock.ts";
import { unsafeMessage } from "../hub/permissions.ts";
import {
  canonicalStatePath,
  LayoutError,
  resolveLayout,
  type HostFacts,
  type Layout,
} from "../hub/paths.ts";
import { delegateUnit, startService, stopService } from "../install/commands.ts";
import {
  holdRuns,
  requestRestart,
  type Env,
  type HeldRun,
  type RunsHold,
  type ServiceContext,
} from "../install/context.ts";
import { ServiceCommandError } from "../install/errors.ts";
import { checkEntries, readTarGz, readZip, type ReadEntry } from "./archive.ts";
import { checkVersionFolder, isVersionName, MANIFEST_FILE, readVersionManifest } from "./folder.ts";
import {
  readJournal,
  removeJournal,
  writeJournal,
  type Journal,
  type LauncherChange,
} from "./journal.ts";
import { hostPlatform, ReleaseError, verifyRelease, type VerifiedRelease } from "./release.ts";
import {
  repairLocked,
  supervisorReplaced,
  type RepairOutcome,
  type RepairSeams,
} from "./repair.ts";
import {
  checkStable,
  cleanLaunchers,
  currentFor,
  currentVersion,
  digestOf,
  exists,
  InstallError,
  isInstalled,
  placeLauncher,
  placeStable,
  readInstallRecord,
  stagedPath,
  stageLauncher,
  stablePlan,
  UPDATE_LOCK,
  VERSIONS,
  WINDOWS_LAUNCHERS,
  writeCurrent,
  writeInstallRecord,
  type LauncherPoint,
} from "./switch.ts";

/** How long a second update waits for the first (A7 3.13 M6.12: "a second concurrent update waits"). */
export const LOCK_WAIT_MS = 10 * 60_000;
/** How long the update waits for the restarted service to name the new version (A2 3.12.6 step 12). */
export const RESTART_WAIT_MS = 30_000;
/** How long the update waits for running background runs before it asks what to do. */
export const RUNS_WAIT_MS = 15 * 60_000;
/** The self-test's bound: a space, an endpoint and the bridge, each in a folder of its own. */
export const SELF_TEST_MS = 180_000;

/** The doctor rows a candidate must pass (A2 3.12.6 step 6). */
export const SELF_TEST_ROWS = [
  "integrity",
  "runtime",
  "candidate-space",
  "candidate-endpoint",
  "candidate-bridge",
] as const;

/** Why an update was reverted, as install.json and doctor name it. A closed list. */
export const UPDATE_FAILURES = ["interrupted", "switch_failed", "restart_failed"] as const;
export type UpdateFailure = (typeof UPDATE_FAILURES)[number];

/** Where an update can be cut off, for the crash tests (tests/update/). Off in the product. */
export type UpdatePoint =
  | "locked"
  | "prepared"
  | "unpacked"
  | "placed"
  | "tested"
  | "staged"
  | "current"
  | "switched"
  | "launcher"
  | "launchers_done"
  | "recorded"
  | "restarted"
  | "done"
  | "rolling_back";

/**
 * The seams of an update: its own steps, the repair's, and each launcher's (`staged` once its
 * `.new` is written, then the swap's `aside` and `placed`, with the launcher's name).
 */
export interface UpdateSeams extends Partial<RepairSeams> {
  readonly update?: (point: UpdatePoint) => void | Promise<void>;
}

export { InstallError as UpdateError } from "./switch.ts";

// ---------------------------------------------------------------------------------------------
// The service, through the OS

/** The running service as an update sees it. */
export interface RunningService {
  readonly version: string;
  readonly manager: string;
}

/**
 * How an update reaches this install's service: through the service install's context (M1.12),
 * whose places and tools tests replace with stand-ins, so no test restarts a real service.
 */
export interface ServiceControl {
  running(): Promise<RunningService | undefined>;
  /**
   * Brings the service back on what current names now: a supervised one by a restart request (its
   * manager starts it again), else by a stop and a start. One that is not running is started.
   * `supervisorChanged`: the supervisor itself changed (Windows' tasksw.exe), so it is stopped and
   * started too, and the new supervisor runs.
   */
  restart(options: { readonly supervisorChanged: boolean }): Promise<void>;
  /** Waits until the service answers ready and names `version`. */
  waitFor(version: string, timeoutMs: number): Promise<boolean>;
  /**
   * Holds new background runs back while the hold is open, and says which runs a restart would
   * cut short. Undefined when no service runs, or one that hosts no runs; `silent` when the
   * service did not say which runs it has in time.
   */
  holdRuns?(): Promise<RunsHold | "silent" | undefined>;
  /**
   * Linux: adds `Delegate=yes`, which background runs need, to the service's unit when an earlier
   * version wrote it without; the restart then runs the service with it. True when it changed.
   */
  delegateUnit?(): Promise<boolean>;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** The service control of the service install's context: systemd, tasksw.exe, launchd or none. */
export function osServiceControl(ctx: ServiceContext, env: Env): ServiceControl {
  // A service started by hand on Linux, where no unit of this install is installed, is started
  // by hand again: `tasks service start` does that itself (A2 3.3.3).
  const start = async (): Promise<void> => {
    await startService(ctx);
  };
  return {
    running: async () => {
      const probe = await ctx.probe();
      return probe.answers
        ? { version: probe.status.version, manager: probe.status.manager }
        : undefined;
    },
    restart: async ({ supervisorChanged }) => {
      const probe = await ctx.probe();
      if (!probe.answers) {
        await start();
        return;
      }
      if (probe.status.manager !== "manual" && !supervisorChanged) {
        const asked = await requestRestart(ctx.layout.state, ctx.installId, env);
        if (asked === "restarting") return;
      }
      await stopService(ctx);
      await start();
    },
    waitFor: async (version, timeoutMs) => {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const left = end - Date.now();
        if (left <= 0) return false;
        const probe = await ctx.probe(Math.min(left, 5_000));
        if (probe.answers && probe.status.state === "ready" && probe.status.version === version) {
          return true;
        }
        await pause(Math.min(250, Math.max(0, end - Date.now())));
      }
    },
    holdRuns: () => holdRuns(ctx.layout.state, ctx.installId, env),
    delegateUnit: () => delegateUnit(ctx),
  };
}

// ---------------------------------------------------------------------------------------------
// The candidate's self-test

export interface SelfTestResult {
  readonly ok: boolean;
  /** The rows that did not pass, with doctor's words. */
  readonly failed: readonly string[];
}

export type SelfTest = (versionFolder: string) => Promise<SelfTestResult>;

/** The version-local launcher of a version folder (A2 3.12.3). */
export const versionLauncher = (folder: string, platform: NodeJS.Platform): string =>
  join(folder, "bin", platform === "win32" ? `${PRODUCT_ID}.exe` : PRODUCT_ID);

/**
 * The self-test through the candidate's own version-local launcher: `doctor --self-test --json`,
 * so the candidate's runtime and bundle check themselves, with `current` still naming the old
 * version (A2 3.12.3, 3.12.6 step 6). The launcher sets TASKS_HOME from its own location.
 */
export function launcherSelfTest(env: Env, platform: NodeJS.Platform): SelfTest {
  return (folder) =>
    new Promise((resolve) => {
      const clean: Record<string, string> = {};
      for (const [name, value] of Object.entries(env)) {
        if (value !== undefined) clean[name] = value;
      }
      const child = spawn(versionLauncher(folder, platform), ["doctor", "--self-test", "--json"], {
        env: clean,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        if (out.length < 1_000_000) out += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, SELF_TEST_MS);
      const done = (result: SelfTestResult) => {
        clearTimeout(timer);
        resolve(result);
      };
      child.once("error", () => {
        done({ ok: false, failed: ["the version's launcher did not start"] });
      });
      child.once("close", () => {
        let checks: { id?: unknown; status?: unknown; detail?: unknown }[] = [];
        try {
          const line = out.trim().split("\n").at(-1) ?? "";
          const parsed = JSON.parse(line) as { checks?: unknown };
          if (Array.isArray(parsed.checks)) checks = parsed.checks as typeof checks;
        } catch {
          // No JSON: every row below is missing.
        }
        const failed: string[] = [];
        for (const row of SELF_TEST_ROWS) {
          const check = checks.find((c) => c.id === row);
          if (check?.status !== "ok") {
            failed.push(
              check === undefined ? `${row}: no answer` : `${row}: ${String(check.detail)}`,
            );
          }
        }
        done({ ok: failed.length === 0, failed });
      });
    });
}

// ---------------------------------------------------------------------------------------------
// The install, the lock, the release

export interface UpdateOptions {
  readonly facts: HostFacts;
  /** The release keys the updater trusts: its own build's (UPDATE_KEYS). */
  readonly keys: readonly string[];
  /**
   * The version folder the updater runs from. It must be the one current names: the installed
   * version vouches for its successor, never another one. Undefined from source (tests only).
   */
  readonly self?: string;
  /** The service. Without it the update leaves the service alone. */
  readonly control?: ServiceControl;
  readonly selfTest: SelfTest;
  readonly seams?: UpdateSeams;
  /** Progress for people, one line at a time. */
  readonly say?: (line: string) => void;
  readonly lockWaitMs?: number;
  readonly restartWaitMs?: number;
  readonly now?: () => Date;
  /**
   * What to do about background runs a restart would cut short, once the wait for them is over:
   * stop them, or give the update up. Without it they are not waited for.
   */
  readonly runs?: {
    readonly decide: (blocking: readonly HeldRun[]) => Promise<"stop" | "give_up">;
    /** Default: RUNS_WAIT_MS. */
    readonly waitMs?: number;
  };
}

export type UpdateResult =
  | { readonly outcome: "updated"; readonly from: string; readonly to: string }
  | { readonly outcome: "current"; readonly version: string }
  | { readonly outcome: "repaired"; readonly repair: RepairOutcome; readonly current: string };

interface Install {
  readonly layout: Layout;
  readonly root: string;
  readonly state: string;
  readonly platform: NodeJS.Platform;
}

function openInstall(facts: HostFacts): Install {
  let layout: Layout;
  try {
    layout = resolveLayout(facts);
  } catch (error) {
    if (!(error instanceof LayoutError)) throw error;
    throw new InstallError(`${error.message}.`, 2);
  }
  const record = readInstallRecord(layout.state);
  if (record === undefined || !exists(join(layout.root, VERSIONS))) {
    throw new InstallError(
      `${PRODUCT_NAME} is not installed here by its install script, so there is nothing to update.`,
      3,
    );
  }
  if (record["method"] !== "script") {
    // A2 3.12.5: another channel's updater owns the install.
    throw new InstallError(
      `This install came through ${String(record["method"])}: update it there, so two updaters never fight.`,
      5,
    );
  }
  return { layout, root: layout.root, state: layout.state, platform: facts.platform };
}

const say = (options: UpdateOptions, line: string) => {
  options.say?.(line);
};

/**
 * Takes update.lock, waiting while another update holds it (A7 3.13 M6.12): one line says whose it
 * is, from that update's journal. After `waitMs` it gives up with nothing changed.
 */
async function lockForUpdate(install: Install, options: UpdateOptions): Promise<HeldLock> {
  const judged = ensurePrivateDir(install.state, install.platform);
  if (judged !== undefined) {
    throw new InstallError(
      unsafeMessage(
        [{ name: `${PRODUCT_NAME}'s state folder`, ...judged }],
        `Whoever can change it could change what ${PRODUCT_NAME} records and runs, so the update does not start`,
      ),
      5,
    );
  }
  const waitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  const end = Date.now() + waitMs;
  let told = false;
  for (;;) {
    try {
      return await acquireLock(join(install.state, UPDATE_LOCK));
    } catch (error) {
      if (!(error instanceof LockBusy)) throw error;
    }
    if (!told) {
      const read = readJournal(install.state);
      const pid = read.kind === "journal" ? ` (PID ${String(read.journal.pid)})` : "";
      say(
        options,
        `Another update of this install is running${pid}. This one waits for it to finish.`,
      );
      told = true;
    }
    if (Date.now() >= end) {
      throw new InstallError(
        `Another update of this install is still running after ${String(Math.round(waitMs / 60_000))} minutes. Nothing was changed.`,
        4,
      );
    }
    await pause(Math.min(500, Math.max(1, end - Date.now())));
  }
}

/** Reports a repair the update had to make before it could begin. */
function sayRepair(options: UpdateOptions, repair: RepairOutcome): void {
  switch (repair.kind) {
    case "rolled_forward":
      say(options, `An interrupted update to ${repair.journal.to} was finished.`);
      return;
    case "rolled_back":
      say(
        options,
        `An interrupted update to ${repair.journal.to} was rolled back to ${repair.journal.from}.`,
      );
      return;
    case "kept":
      say(options, `An unreadable update journal was removed; ${repair.current} stays current.`);
      return;
    case "stuck":
      throw new InstallError(
        `An interrupted update cannot be finished or rolled back: ${repair.problems.join("; ")}. Nothing else was changed.`,
        1,
      );
    case "nothing":
      return;
  }
}

/** Whether a journal records a change of tasksw.exe, the Windows supervisor (A2 3.12.6 step 11). */
const supervisorIn = (journal: Journal): boolean =>
  journal.launchers.some((l) => l.name === WINDOWS_LAUNCHERS[1]);

/**
 * Brings the service back on `version` after a repair or a rollback, as a step of an update:
 * a failure, thrown or a timeout, is an update error with exit 6 that says what to do.
 */
async function bringBack(
  control: ServiceControl,
  options: UpdateOptions,
  version: string,
  supervisorChanged: boolean,
): Promise<void> {
  let back: boolean;
  try {
    await control.restart({ supervisorChanged });
    back = await control.waitFor(version, options.restartWaitMs ?? RESTART_WAIT_MS);
  } catch (error) {
    // A service command's message is fixed text for a person (install/errors.ts).
    const why = error instanceof ServiceCommandError ? error.message : codeOf(error);
    throw new InstallError(
      `The service could not be started on ${version} (${why}). Start it with ${PRODUCT_ID} service start.`,
      6,
    );
  }
  if (!back) {
    throw new InstallError(
      `The service did not come back on ${version}. Start it with ${PRODUCT_ID} service start.`,
      6,
    );
  }
}

/**
 * Finishes or rolls back an interrupted update (repair.ts), with update.lock held, and brings the
 * service back on what current names when that update had found it running (its journal's
 * `service`) and it does not run that version now, or when the repair may have replaced the
 * supervisor (tasksw.exe, repair.ts supervisorReplaced), which an old supervisor may have outlived
 * even when the service it restarted names current; with `always`, also a service that runs
 * another version than current without any journal. The journal goes only after that, so a kill
 * before it leaves the next run what it needs to bring the service back. A `stuck` outcome
 * changes nothing and is returned for the caller to report.
 */
async function repairFirst(
  install: Install,
  options: UpdateOptions,
  always: boolean,
): Promise<RepairOutcome> {
  const repair = repairLocked({
    root: install.root,
    state: install.state,
    platform: install.platform,
    ...repairSeams(options),
    keepJournal: true,
  });
  if (repair.kind === "stuck") return repair;
  const journaled = repair.kind === "rolled_forward" || repair.kind === "rolled_back";
  const supervisorChanged = supervisorReplaced(repair);
  try {
    const control = options.control;
    const current = currentVersion(install.root, install.platform);
    if (
      control !== undefined &&
      current !== undefined &&
      (journaled || always || supervisorChanged)
    ) {
      const running = await control.running();
      const wanted = running !== undefined || (journaled && repair.journal.service);
      if (wanted && (running?.version !== current || supervisorChanged)) {
        // A service that runs may have started runs since the update was cut off: they are
        // waited for, or stopped once the person says so, as before any restart.
        const held = running === undefined ? undefined : await heldForRepair(options, current);
        try {
          await bringBack(control, options, current, supervisorChanged);
        } finally {
          held?.release();
        }
      }
    }
  } finally {
    // Brought back, or tried: the install is complete either way.
    if (journaled) removeJournal(install.state);
  }
  return repair;
}

/**
 * waitForRuns before a repair restarts the service. The repair itself is done by then, so giving
 * up leaves the service on its version until a later `--repair`, which the message says.
 */
async function heldForRepair(
  options: UpdateOptions,
  current: string,
): Promise<RunsHold | undefined> {
  try {
    return await waitForRuns(options);
  } catch (error) {
    if (error instanceof InstallError && error.exitCode === 2) {
      throw new InstallError(
        `The service was not restarted on ${current} while background runs still run. Run ${PRODUCT_ID} update --repair once they finished, or with --stop-runs.`,
        2,
      );
    }
    throw error;
  }
}

/** The version current names, which must be installed. */
function currentInstalled(install: Install): string {
  const from = currentVersion(install.root, install.platform);
  if (from === undefined || !isInstalled(install.root, from)) {
    throw new InstallError(
      "current names no installed version: install again with the install script.",
      1,
    );
  }
  return from;
}

/**
 * The updater must run from the version current names (`from`): an installed version vouches for
 * its successor, never another one. A second update that waited for the first runs the version
 * that was current when it started, and stops here before it changes anything.
 */
function checkSelf(install: Install, options: UpdateOptions, from: string): void {
  if (options.self === undefined) return;
  const own = canonicalStatePath(realpathSync.native(options.self), install.platform);
  const named = canonicalStatePath(
    realpathSync.native(join(install.root, VERSIONS, from)),
    install.platform,
  );
  if (own !== named) {
    throw new InstallError(
      `Run the update with this install's own command, which runs the current version (${from}).`,
      5,
    );
  }
}

/**
 * Whether another account could change anything in `folder`, or anything in it is not this user's
 * plain folder or file (Linux, macOS; A2 3.12.4): every folder and file judged by the
 * state folder's rule (hub/permissions.ts), no link followed.
 */
function othersCanChange(folder: string): boolean {
  if (process.platform === "win32" || process.getuid === undefined) return false;
  const walk = (dir: string): boolean => {
    if (judgePath(dir, "folder", { followLink: false }) !== undefined) return true;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(path)) return true;
      } else if (judgePath(path, "file", { followLink: false }) !== undefined) {
        return true;
      }
    }
    return false;
  };
  return walk(folder);
}

/**
 * Unpacks checked entries into the new folder `dir`, creating every folder and file exclusively
 * with exactly its mode, whatever the umask (@tasks/files, A2 3.2.2 rule 5).
 */
function unpack(entries: readonly ReadEntry[], dir: string, platform: NodeJS.Platform): void {
  makeDir(dir, 0o755, { recursive: false, platform });
  for (const entry of entries) {
    const path = join(dir, ...entry.path.split("/"));
    if (entry.type === "directory") {
      makeDir(path, 0o755, { platform });
      continue;
    }
    makeDir(dirname(path), 0o755, { platform });
    const mode = platform === "win32" ? 0o644 : (entry.mode & 0o111) !== 0 ? 0o755 : 0o644;
    const fd = createFile(path, mode);
    try {
      for (let at = 0; at < entry.data.length;) {
        at += writeSync(fd, entry.data, at, entry.data.length - at);
      }
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Puts the verified staging folder in place as `versions/<v>`, or, when that folder is there
 * already, requires it to be exactly this release (A2 3.12.4 step 7): a plain folder no other
 * account can change, its manifest.json byte for byte the staged one, every file checked against
 * it. The staging folder is gone afterwards either way.
 */
function place(staging: string, target: string): void {
  if (!exists(target)) {
    try {
      renameSync(staging, target);
      return;
    } catch (error) {
      // Another install put the same version there in between: compared below.
      if (!exists(target)) throw error;
    }
  }
  const refuse = (why: string) =>
    new InstallError(
      `${VERSIONS}/${basename(target)} already exists but is not this signed release: ${why}. It was left as it is and nothing in it ran.`,
      4,
    );
  try {
    const stat = lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw refuse("it is not a plain folder");
    if (othersCanChange(target)) throw refuse("another account can change it");
    const own = readFileSync(join(target, MANIFEST_FILE));
    if (!own.equals(readFileSync(join(staging, MANIFEST_FILE)))) {
      throw refuse("its manifest.json is not the signed one");
    }
    const problems = checkVersionFolder(target);
    if (problems.length > 0) throw refuse(problems.slice(0, 3).join("; "));
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** The launchers the switch to `target` changes (Windows), with their old and new SHA-256. */
function launcherChanges(
  root: string,
  target: string,
  platform: NodeJS.Platform,
): LauncherChange[] {
  if (platform !== "win32") return [];
  const changes: LauncherChange[] = [];
  for (const name of WINDOWS_LAUNCHERS) {
    const next = digestOf(join(target, "bin", name));
    if (next === null) throw new InstallError(`The new version has no bin/${name}.`, 1);
    const old = digestOf(join(root, "bin", name));
    if (old !== next) changes.push({ name, old, new: next });
  }
  return changes;
}

// ---------------------------------------------------------------------------------------------
// Background runs

/** What a run's state means to a person waiting for it. */
const RUN_STATE_WORDS: Readonly<Record<string, string>> = {
  starting: "starting",
  running: "running",
  waiting_for_input: "waiting",
  cancelling: "stopping",
  reconciling: "being checked",
  unknown: "not confirmed ended",
};

const runLine = (run: HeldRun): string => {
  const where = run.space_name === null ? "" : ` in ${run.space_name}`;
  return `  ${run.task ?? "A routine's run"}${where}: ${RUN_STATE_WORDS[run.state] ?? run.state}`;
};

const runsCount = (n: number): string => (n === 1 ? "1 run" : `${String(n)} runs`);

/**
 * Before anything changes, while the service runs: holds new runs back, so they wait in the queue,
 * and waits up to RUNS_WAIT_MS for the runs the restart would cut short. If some still run, the
 * person decides: stop them (each keeps its answer so far) or give the update up, with nothing
 * changed. Returns the hold, which the caller lets go once the update is over; its connection goes
 * with the updater, so an updater that dies lets go of it too.
 */
async function waitForRuns(options: UpdateOptions): Promise<RunsHold | undefined> {
  const runs = options.runs;
  const control = options.control;
  if (runs === undefined || control?.holdRuns === undefined) return undefined;
  const take = async (): Promise<RunsHold | undefined> => {
    const taken = await control.holdRuns?.();
    if (taken === "silent") {
      throw new InstallError(
        "The service did not say which background runs it has, so it was not restarted. Nothing was changed.",
        1,
      );
    }
    return taken;
  };
  let hold = await take();
  if (hold === undefined) return undefined;
  try {
    let blocking = hold.blocking();
    if (blocking.length === 0) return hold;
    const waitMs = runs.waitMs ?? RUNS_WAIT_MS;
    say(options, `The restart would cut short ${runsCount(blocking.length)}:`);
    for (const run of blocking) say(options, runLine(run));
    say(
      options,
      `New runs wait in the queue meanwhile. The update waits up to ${String(Math.round(waitMs / 60_000))} minutes for these to finish.`,
    );
    const end = Date.now() + waitMs;
    for (;;) {
      if (!hold.held) {
        // The service ended meanwhile, and its runs with it. One that started again holds runs
        // of its own, which may have started since: the update holds and asks that one.
        hold.release();
        const again = await take();
        if (again === undefined) {
          say(options, "The service stopped meanwhile, and its runs with it.");
          return undefined;
        }
        hold = again;
      }
      blocking = hold.blocking();
      if (blocking.length === 0 || Date.now() >= end) break;
      await Promise.race([hold.changed(), pause(Math.max(1, Math.min(5_000, end - Date.now())))]);
    }
    if (blocking.length === 0) {
      say(options, "The runs finished.");
      return hold;
    }
    if ((await runs.decide(blocking)) === "give_up") {
      throw new InstallError(
        `The update was given up while ${runsCount(blocking.length)} still ${blocking.length === 1 ? "runs" : "run"}. Nothing was changed.`,
        2,
      );
    }
    say(options, "Stopping the runs. Each keeps its answer so far.");
    const left = await hold.stopAll();
    if (left.length > 0) {
      say(options, `The restart ends what did not stop in time: ${runsCount(left.length)}.`);
    }
    return hold;
  } catch (error) {
    hold.release();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// The switch, shared by an update and a rollback

interface Switch {
  readonly install: Install;
  readonly options: UpdateOptions;
  journal: Journal;
}

const at = async (options: UpdateOptions, point: UpdatePoint): Promise<void> => {
  await options.seams?.update?.(point);
};

/**
 * From a candidate that passed its self-test to the complete new version, or back to the complete
 * old one. The journal is written before each step that a repair needs it for.
 */
async function switchTo(run: Switch): Promise<UpdateResult> {
  const { install, options } = run;
  const { root, state, platform } = install;
  const { from, to } = run.journal;
  const target = join(root, VERSIONS, to);
  const write = (journal: Journal) => {
    run.journal = journal;
    writeJournal(state, journal);
  };
  const plan = stablePlan(root, target, platform);
  let launchers: LauncherChange[];
  try {
    // A stable command that is not what an install writes stops the update before current
    // changes, and nothing is left to repair.
    checkStable(plan);
    launchers = launcherChanges(root, target, platform);
  } catch (error) {
    removeJournal(state);
    throw error;
  }
  // The candidate passed its self-test before switchTo (an update's, or --rollback's own).
  write({ ...run.journal, phase: "staged", tested: true, launchers });
  const bin = (name: string) => join(root, "bin", name);
  const seam = (name: string) => (point: LauncherPoint) => {
    options.seams?.launcher?.(point, name);
  };
  // A2 3.12.6 step 8: each changed launcher is staged beside the stable one, checked and flushed,
  // all before current changes. A failure here is a failure before the switch: nothing changed.
  try {
    for (const launcher of launchers) {
      stageLauncher(bin(launcher.name), join(target, "bin", launcher.name), launcher.new);
      seam(launcher.name)("staged");
    }
  } catch (error) {
    for (const launcher of launchers) {
      try {
        rmSync(stagedPath(bin(launcher.name)), { force: true });
      } catch {
        // Not a file of the update's (a folder at the name): left as it is.
      }
    }
    removeJournal(state);
    if (error instanceof InstallError) throw error;
    throw new InstallError(
      `The new launchers could not be staged in bin (${codeOf(error)}). current was not changed.`,
      1,
    );
  }
  await at(options, "staged");
  let restarted = false;
  try {
    writeCurrent(root, currentFor(to, platform), platform);
    await at(options, "current");
    write({ ...run.journal, phase: "switched" });
    await at(options, "switched");
    // One at a time, tasks.exe first: at every instant at least one stable launcher exists
    // (A2 3.12.6 step 10), and where Windows allows it (a launcher that is not running) its path
    // never goes missing. The old one can be found again in its version folder, so a rollback
    // needs no aside copy of it. Linux and macOS: the stable link names current and never
    // changes; one that is missing is made again.
    for (const launcher of launchers) {
      placeLauncher(bin(launcher.name), stagedPath(bin(launcher.name)), launcher.new, {
        keptIn: [join(root, VERSIONS, from, "bin", launcher.name)],
        at: seam(launcher.name),
      });
      await at(options, "launcher");
    }
    if (platform !== "win32") placeStable(root, plan, []);
    write({ ...run.journal, phase: "launchers_done" });
    await at(options, "launchers_done");
    // `previous` changes only once the switch has completed (below, or in a repair that rolls
    // forward): an update that is rolled back keeps the version `--rollback` goes back to.
    writeInstallRecord(state, root, platform, { installed: to });
    await at(options, "recorded");
    const control = options.control;
    // A unit an earlier version wrote gets what background runs need, also when the service is
    // stopped now, so a person never meets runs turned off for a line only a reinstall would have
    // added. Not a reason to stop the update: `service status` and doctor say what is missing.
    if (await control?.delegateUnit?.().catch(() => false)) {
      say(options, "The service's systemd unit now has Delegate=yes, which background runs need.");
    }
    if (control !== undefined && (run.journal.service || (await control.running()) !== undefined)) {
      write({ ...run.journal, phase: "restarted" });
      restarted = true;
      say(options, `Restarting the service on ${to}. Sessions keep running and reconnect.`);
      await control.restart({
        supervisorChanged: launchers.some((l) => l.name === WINDOWS_LAUNCHERS[1]),
      });
      await at(options, "restarted");
      if (!(await control.waitFor(to, options.restartWaitMs ?? RESTART_WAIT_MS))) {
        throw new UpdateStepError(
          "restart_failed",
          `The service did not come back on ${to} within ${String(Math.round((options.restartWaitMs ?? RESTART_WAIT_MS) / 1000))} s.`,
        );
      }
    }
  } catch (error) {
    return await rollBack(run, error, restarted);
  }
  writeInstallRecord(state, root, platform, {
    previous: from,
    lastUpdate: {
      kind: run.journal.kind,
      outcome: "completed",
      from,
      to,
      at: (options.now?.() ?? new Date()).toISOString(),
    },
  });
  removeJournal(state);
  await at(options, "done");
  cleanLaunchers(root);
  return { outcome: "updated", from, to };
}

/** A step of the switch that failed, with the reason install.json records. */
class UpdateStepError extends Error {
  override readonly name = "UpdateStepError";
  readonly reason: UpdateFailure;
  constructor(reason: UpdateFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Why a file operation failed, for a message: its code, never a path or a text. */
const codeOf = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "an error";
};

/**
 * Rolls a failed switch back (A2 3.12.6 step 13) with the repair's own steps: phase
 * `rolling_back` first, then current and the launchers, then the old service again. The journal
 * goes only after the service was brought back, so a kill before that leaves the next run what it
 * needs to bring it back (repairFirst).
 */
async function rollBack(run: Switch, error: unknown, restarted: boolean): Promise<never> {
  const { install, options } = run;
  const reason: UpdateFailure = error instanceof UpdateStepError ? error.reason : "switch_failed";
  const why = error instanceof Error ? error.message : String(error);
  writeJournal(install.state, { ...run.journal, phase: "rolling_back" });
  await at(options, "rolling_back");
  let repair: RepairOutcome;
  try {
    repair = repairLocked({
      root: install.root,
      state: install.state,
      platform: install.platform,
      ...repairSeams(options),
      reason,
      keepJournal: true,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (cut) {
    throw new InstallError(
      `The update to ${run.journal.to} failed (${why}), and rolling it back did not finish (${codeOf(cut)}). ${PRODUCT_ID} update --repair, or the service's next start, finishes it.`,
      1,
    );
  }
  // The version current names now: the old one, or the new one when the old one was not complete.
  const now =
    repair.kind === "rolled_back" || repair.kind === "rolled_forward"
      ? repair.current
      : run.journal.from;
  let service = "";
  try {
    if (restarted && options.control !== undefined) {
      try {
        // When the update changed tasksw.exe, the one that runs now is the new one: it goes too.
        await options.control.restart({ supervisorChanged: supervisorIn(run.journal) });
        service = (await options.control.waitFor(now, options.restartWaitMs ?? RESTART_WAIT_MS))
          ? ` The service runs ${now} again.`
          : ` The service did not come back on ${now}: start it with ${PRODUCT_ID} service start.`;
      } catch {
        service = ` The service could not be started again: start it with ${PRODUCT_ID} service start.`;
      }
    }
  } finally {
    if (repair.kind === "rolled_back" || repair.kind === "rolled_forward") {
      removeJournal(install.state);
    }
  }
  const back =
    repair.kind === "rolled_back"
      ? `${run.journal.from} is current again.`
      : `It could not be rolled back completely (${repair.kind === "stuck" ? repair.problems.join("; ") : repair.kind}).`;
  throw new InstallError(
    `The update to ${run.journal.to} failed (${why}). ${back}${service}`,
    reason === "restart_failed" ? 6 : 1,
  );
}

// ---------------------------------------------------------------------------------------------
// The commands

/** `tasks update --from <archive>`. */
export async function updateFromArchive(
  archive: string,
  options: UpdateOptions,
): Promise<UpdateResult> {
  const install = openInstall(options.facts);
  const platform = hostPlatform(install.platform);
  if (platform === undefined)
    throw new InstallError(`${PRODUCT_NAME} has no build for this machine.`, 1);
  const lock = await lockForUpdate(install, options);
  try {
    await at(options, "locked");
    sayRepair(options, await repairFirst(install, options, false));
    const from = currentInstalled(install);
    let release: VerifiedRelease;
    try {
      release = verifyRelease(archive, options.keys, platform);
    } catch (error) {
      if (error instanceof ReleaseError) {
        throw new InstallError(error.message, error.reason === "missing_file" ? 3 : 5);
      }
      throw error;
    }
    if (!isVersionName(release.version)) {
      throw new InstallError(`${release.version} is not a version name.`, 5);
    }
    // Already current (also what a second update finds once the first made it so): nothing to do.
    if (release.version === from) {
      say(options, `${PRODUCT_NAME} ${from} is installed and current already.`);
      return { outcome: "current", version: from };
    }
    checkSelf(install, options, from);
    let entries: ReadEntry[];
    try {
      entries = (platform === "win-x64" ? readZip : readTarGz)(release.bytes);
    } catch {
      throw new InstallError(`${release.archive} is signed but cannot be read as an archive.`, 5);
    }
    const problems = checkEntries(entries, install.platform === "win32");
    if (problems.length > 0) {
      throw new InstallError(
        `${release.archive} holds entries a release may not hold (${problems.slice(0, 3).join("; ")}). Nothing from it was unpacked or run.`,
        5,
      );
    }
    const held = await waitForRuns(options);
    try {
      const control = options.control;
      const journal: Journal = {
        format: 1,
        kind: "update",
        from,
        to: release.version,
        phase: "prepare",
        pid: process.pid,
        started_at: (options.now?.() ?? new Date()).toISOString(),
        staging: `.staging-${randomBytes(8).toString("hex")}`,
        service: control !== undefined && (await control.running()) !== undefined,
        tested: false,
        launchers: [],
      };
      writeJournal(install.state, journal);
      await at(options, "prepared");
      const target = join(install.root, VERSIONS, release.version);
      const staging = join(install.root, VERSIONS, journal.staging ?? "");
      try {
        unpack(entries, staging, install.platform);
        const manifest = readVersionManifest(staging);
        if (manifest.version !== release.version || manifest.platform !== platform) {
          throw new InstallError(
            `${release.archive}'s manifest.json names another version or platform.`,
            5,
          );
        }
        const unpacked = checkVersionFolder(staging);
        if (unpacked.length > 0) {
          throw new InstallError(
            `The unpacked files do not match manifest.json (${unpacked.slice(0, 3).join("; ")}). Nothing from them ran.`,
            5,
          );
        }
        await at(options, "unpacked");
        place(staging, target);
        writeJournal(install.state, { ...journal, staging: null });
        await at(options, "placed");
        say(options, `Self-test of ${release.version} through its own launcher:`);
        const tested = await options.selfTest(target);
        if (!tested.ok) {
          throw new InstallError(
            `${release.version} failed its self-test (${tested.failed.join("; ")}), so current was not changed.`,
            1,
          );
        }
        await at(options, "tested");
      } catch (error) {
        // Nothing was switched: the staging folder and the journal go, current stays.
        rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        removeJournal(install.state);
        if (error instanceof InstallError) throw error;
        throw new InstallError(
          `${release.archive} could not be put in place (${(error as Error).message}). current was not changed.`,
          1,
        );
      }
      return await switchTo({ install, options, journal: { ...journal, staging: null } });
    } finally {
      held?.release();
    }
  } finally {
    lock.release();
  }
}

/** `tasks update --rollback`: current back to the version it named before the last switch. */
export async function rollbackUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const install = openInstall(options.facts);
  const lock = await lockForUpdate(install, options);
  try {
    await at(options, "locked");
    sayRepair(options, await repairFirst(install, options, false));
    const from = currentInstalled(install);
    checkSelf(install, options, from);
    const previous = readInstallRecord(install.state)?.["previous"];
    if (typeof previous !== "string" || previous === from || !isInstalled(install.root, previous)) {
      throw new InstallError("There is no previous version to go back to.", 3);
    }
    const target = join(install.root, VERSIONS, previous);
    if (checkVersionFolder(target).length > 0) {
      throw new InstallError(
        `${previous} no longer matches its manifest.json: install it again instead.`,
        1,
      );
    }
    say(options, `Self-test of ${previous} through its own launcher:`);
    const tested = await options.selfTest(target);
    if (!tested.ok) {
      throw new InstallError(
        `${previous} failed its self-test (${tested.failed.join("; ")}), so current was not changed.`,
        1,
      );
    }
    const held = await waitForRuns(options);
    try {
      const control = options.control;
      const journal: Journal = {
        format: 1,
        kind: "rollback",
        from,
        to: previous,
        phase: "prepare",
        pid: process.pid,
        started_at: (options.now?.() ?? new Date()).toISOString(),
        staging: null,
        service: control !== undefined && (await control.running()) !== undefined,
        // Its self-test ran above.
        tested: true,
        launchers: [],
      };
      writeJournal(install.state, journal);
      await at(options, "prepared");
      return await switchTo({ install, options, journal });
    } finally {
      held?.release();
    }
  } finally {
    lock.release();
  }
}

/**
 * `tasks update --repair`: finishes or rolls back an interrupted update, then brings the service
 * back on what current names when it runs another version, or ran when the update began.
 */
export async function repairUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const install = openInstall(options.facts);
  const lock = await lockForUpdate(install, options);
  try {
    await at(options, "locked");
    const repair = await repairFirst(install, options, true);
    if (repair.kind === "stuck") sayRepair(options, repair);
    const current = currentVersion(install.root, install.platform);
    if (current === undefined) throw new InstallError("current names no installed version.", 1);
    if (repair.kind === "nothing") cleanLaunchers(install.root);
    return { outcome: "repaired", repair, current };
  } finally {
    lock.release();
  }
}

function repairSeams(options: UpdateOptions): { seams?: RepairSeams } {
  const point = options.seams?.at;
  const launcher = options.seams?.launcher;
  if (point === undefined && launcher === undefined) return {};
  return {
    seams: {
      at: point ?? (() => undefined),
      ...(launcher === undefined ? {} : { launcher }),
    },
  };
}
