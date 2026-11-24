// `ttasks update --from <archive>`, `--rollback` and `--repair`: from a local archive, no hosted
// channel. The installed version replaces itself, in this order:
//   1. update.lock for the whole update. A second update waits for it; then any journal it finds
//      is an interrupted update, which is finished or rolled back first (repair.ts).
//   2. The release is verified with the keys the INSTALLED version carries (UPDATE_KEYS in lib/):
//      the raw Ed25519 signature of SHA256SUMS beside the archive, then the archive's SHA-256 against
//      its line there (release.ts). Nothing of the archive is unpacked, loaded or run before that.
//   3. The archive's entries pass the install scripts' rule (archive.ts checkEntries) before
//      anything is written. A service that runs is restarted only on the person's decision, taken
//      once and before anything is held or stopped (Decision): declined, nothing is changed.
//      Background runs end with the service, so while it runs the update now holds new runs back,
//      waits up to 15 minutes for the running ones, and then asks: stop them, or give the update
//      up with nothing changed (waitForRuns). Then the journal is written; it names the staging
//      folder before that folder is made.
//   4. The archive is unpacked into `versions/.staging-<random>`, every file is checked against its
//      manifest.json, and the folder is renamed to `versions/<v>`, or a folder already there must
//      equal it.
//   5. The candidate's self-test runs through its own version-local launcher
//      (`versions/<v>/bin/ttasks doctor --self-test --json`): integrity, the runtime gate and the
//      candidate's checks. Authenticity was settled in step 2; this is the functional half.
//   6. The journal records each stable launcher the switch changes, with its old and new SHA-256
//      (phase `staged`), and on Windows each one is staged as `bin\<name>.new` (checked, flushed).
//   7. Right before `current` changes, the restart is decided on what is so then: a service that
//      runs without the person's agreement stops the update here, with the unpacked version
//      removed and nothing changed; one that runs with it has its runs held and waited for. The
//      spaces of the service the update restarts are noted then, in memory only, as late as can
//      be: the note only leaves out of the report a space that was so already. Then `current` is
//      switched atomically
//      (`switched`), then each changed launcher is swapped for its staged copy, one at a time,
//      `ttasks.exe` first: by one rename where Windows allows it, else by renaming the running one
//      aside and the new one in (switch.ts placeLauncher; `launchers_done`), and install.json
//      records the version.
//   8. The service is restarted through the OS: a supervised service is asked for
//      `service/shutdown {restart: true}` and its manager starts it again from the new current;
//      one nobody supervises is stopped and started. The update waits up to 30 s for a handshake
//      that names the new version. Sessions keep running in their own processes and reconnect;
//      background runs were settled in step 3.
//   9. The journal goes. A failure after the switch rolls back through the same repair: phase
//      `rolling_back`, current and the launchers back, the old service again, the reason in
//      install.json for doctor.
//  10. Every update ends, also one that finds its version current already or a repair, by asking
//      the service that runs the current version for its spaces, up to SETTLE_MS until each has
//      opened or failed to: the result names each that is not usable now, in the service's words
//      (checkSpaces). Then the lock is let go.
// It never removes a version folder and never touches a person's data: spaces, `<config>` and
// `<state>` beyond its own files (update.lock, update.json, install.json, and the self-test's
// folders in `<state>/tmp/`). A migration, if the new version needs one, runs later, when the new
// version opens a space, behind its verified backup.
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
import { PRODUCT_ID, PRODUCT_NAME } from "@ttasks/brand";
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
  type UpdateJournal,
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
  exists,
  InstallError,
  isInstalled,
  launcherChanges,
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
/**
 * How long the update waits, once the restarted service names the new version, for every space
 * it served before to open or fail to: a migration behind its backup can take a while.
 */
export const SETTLE_MS = 120_000;
/** How often the update asks the restarted service how its spaces are while it waits. */
const SETTLE_POLL_MS = 500;
/** After this long waiting for the spaces, the update says that it waits, and how long at most. */
const SETTLE_TELL_MS = 5_000;
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

/**
 * A space's entry as the service's status names it (hub/spaces.ts SpaceView): its state and the
 * service's own words for it, which doctor and the page show too. Its name is for people, never
 * the log.
 */
export interface SpaceNote {
  /** The entry's index in machine.toml's list: the same before and after a restart. */
  readonly entry?: number;
  /** The ID its entry names: the same before and after a restart. */
  readonly registered?: string;
  readonly id?: string;
  readonly name?: string;
  readonly state: string;
  readonly reason?: string;
  /** Why it is read-only or unavailable, and what to run (hub/space-ways.ts). */
  readonly message?: string;
  /** The barrier backup of the space's failed migration, which `message` names too. */
  readonly migration_backup?: string;
}

/** The running service as an update sees it. */
export interface RunningService {
  readonly version: string;
  readonly manager: string;
  /** Its spaces, as its status names them. */
  readonly spaces: readonly SpaceNote[];
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
   * `supervisorChanged`: the supervisor itself changed (Windows' ttasksw.exe), so it is stopped and
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

/** The service control of the service install's context: systemd, ttasksw.exe, launchd or none. */
export function osServiceControl(ctx: ServiceContext, env: Env): ServiceControl {
  // A service started by hand on Linux, where no unit of this install is installed, is started
  // by hand again: `ttasks service start` does that itself (A2 3.3.3).
  const start = async (): Promise<void> => {
    await startService(ctx);
  };
  return {
    running: async () => {
      const probe = await ctx.probe();
      return probe.answers
        ? {
            version: probe.status.version,
            manager: probe.status.manager,
            spaces: spaceNotes(probe.status.spaces),
          }
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

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The spaces of a status, which another version's service may have written: checked here. */
export function spaceNotes(value: unknown): SpaceNote[] {
  if (!Array.isArray(value)) return [];
  const notes: SpaceNote[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const state = text(row["state"]);
    if (state === undefined) continue;
    const entry = row["entry"];
    const fields: [string, string | undefined][] = [
      ["registered", text(row["registered"])],
      ["id", text(row["id"])],
      ["name", text(row["name"])],
      ["reason", text(row["reason"])],
      ["message", text(row["message"])],
      ["migration_backup", text(row["migration_backup"])],
    ];
    notes.push({
      state,
      ...(Number.isSafeInteger(entry) ? { entry: entry as number } : {}),
      ...Object.fromEntries(fields.filter(([, v]) => v !== undefined)),
    });
  }
  return notes;
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
 * version (A2 3.12.3, 3.12.6 step 6). The launcher sets TTASKS_HOME from its own location.
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
  /** How long the update waits for the restarted service's spaces. Default: SETTLE_MS. */
  readonly settleWaitMs?: number;
  /**
   * Whether the person agrees to restart the service, asked when one runs and a restart needs the
   * answer: before anything is held or stopped, at the switch, or before a repair restarts it.
   * The update asks it at most once and keeps the answer (Decision). Without it a service that
   * runs is restarted, as the caller decided already.
   */
  readonly agreeRestart?: () => Promise<boolean>;
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

/** How a space is at the end of an update, by what the service says of it then. */
export type SpaceVerdict =
  /** Open, or read-only as it is meant to be: a restored copy, another machine's space. */
  | "usable"
  /** Not usable, and so already, for the same reason, in the note from right before the switch. */
  | "as_before"
  /** Read-only otherwise (its migration failed, its folder), or unavailable. */
  | "not_usable"
  /** Still opening or closing when the bound ran out, or not listed. */
  | "unsettled";

export interface SpaceAtEnd {
  readonly id: string;
  /** Its name, else its ID. For people, never the log. */
  readonly name: string;
  readonly verdict: SpaceVerdict;
  /**
   * The entry the space is judged by, as the service last named it: the folder that serves it,
   * else the one that served it before. Undefined when the service did not list it.
   */
  readonly now: SpaceNote | undefined;
  /** The same space in the note from right before the switch; undefined without one. */
  readonly before: SpaceNote | undefined;
}

/** The spaces of the service that runs the current version, at the end of an update. */
export interface SpacesReport {
  /** How long the update waited at most for them to open or fail to. */
  readonly boundMs: number;
  /** Whether a note from right before the switch was there to leave out what was so already. */
  readonly noted: boolean;
  /** False when the service stopped answering while the update watched: `now` is what it said last. */
  readonly checked: boolean;
  /** The version `ttasks update --rollback` goes back to, when there is one. */
  readonly wayBack: string | undefined;
  readonly spaces: readonly SpaceAtEnd[];
}

/** `spaces`: undefined when no service of the current version runs, or it serves no space. */
export type UpdateResult =
  | {
      readonly outcome: "updated";
      readonly from: string;
      readonly to: string;
      readonly spaces?: SpacesReport;
    }
  | { readonly outcome: "current"; readonly version: string; readonly spaces?: SpacesReport }
  | {
      readonly outcome: "repaired";
      readonly repair: RepairOutcome;
      readonly current: string;
      readonly spaces?: SpacesReport;
    };

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
 * The person's decision about restarting the service, for one run of a command: asked at most
 * once, when a service runs and a restart needs the answer, and kept. Apart from any look at the
 * service: a service that comes and goes changes what is restarted, never what was agreed.
 */
interface Decision {
  agreed?: boolean;
}

async function agree(options: UpdateOptions, decision: Decision): Promise<boolean> {
  decision.agreed ??= (await options.agreeRestart?.()) ?? true;
  return decision.agreed;
}

const NOT_AGREED =
  "Restarting the service was not agreed, so the update stopped before the switch. Nothing was changed. Run it again; with --yes it restarts the service without a question.";

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

const what = (journal: Journal): string =>
  journal.kind === "install" ? `install of ${journal.to}` : `update to ${journal.to}`;

/** Reports a repair the update had to make before it could begin. */
function sayRepair(options: UpdateOptions, repair: RepairOutcome): void {
  switch (repair.kind) {
    case "rolled_forward":
      say(options, `An interrupted ${what(repair.journal)} was finished.`);
      return;
    case "rolled_back":
      say(
        options,
        `An interrupted ${what(repair.journal)} was rolled back to ${repair.journal.from}.`,
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

/** Whether a journal records a change of ttasksw.exe, the Windows supervisor (A2 3.12.6 step 11). */
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
 * service back on what current names when it does not run that version now, or when the repair
 * may have replaced the supervisor (ttasksw.exe, repair.ts supervisorReplaced), which an old
 * supervisor may have outlived even when the service it restarted names current; with `always`,
 * also a service that runs another version than current without any journal. A service that is
 * not running is started only when the person agreed in the update that was cut off (its
 * journal's `service`); one that runs is restarted on that agreement, or on the person's decision
 * now, and otherwise runs on: the repaired version takes effect at its next start. The journal
 * goes only after that, so a kill before it leaves the next run what it needs to bring the service
 * back. A `stuck` outcome changes nothing and is returned for the caller to report.
 */
async function repairFirst(
  install: Install,
  options: UpdateOptions,
  always: boolean,
  decision: Decision,
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
  const agreedThen = journaled && repair.journal.service;
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
      const due =
        running === undefined ? agreedThen : running.version !== current || supervisorChanged;
      if (due && running !== undefined && !agreedThen && !(await agree(options, decision))) {
        const what = running.version === current ? `The new ${WINDOWS_LAUNCHERS[1]}` : current;
        say(
          options,
          `The service was not restarted and runs ${running.version}: ${what} takes effect at its next start (${PRODUCT_ID} service restart).`,
        );
      } else if (due) {
        // A service that runs may have started runs since the update was cut off: they are
        // waited for, or stopped once the person says so, as before any restart.
        const held = running === undefined ? undefined : await heldForRepair(options, current);
        try {
          await bringBack(control, options, current, supervisorChanged);
        } finally {
          held?.release();
        }
        writeInstallRecord(install.state, install.root, install.platform, { seen: [current] });
      }
    }
  } finally {
    // Brought back, tried, or left as the person decided: the install is complete either way.
    if (repair.kind === "rolled_forward" || repair.kind === "rolled_back") {
      removeJournal(install.state, repair.journal.kind);
    }
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
 * with exactly its mode, whatever the umask (@ttasks/files, A2 3.2.2 rule 5).
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
 * it. The staging folder is gone afterwards either way. True when this update put the folder there.
 */
function place(staging: string, target: string): boolean {
  if (!exists(target)) {
    try {
      renameSync(staging, target);
      return true;
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
  return false;
}

/**
 * Takes away a version folder this update put in place and that never became current, once the
 * update stops before the switch: nothing ran from it but its self-test, which has ended. It is
 * renamed aside first, so a removal that fails halfway never leaves a partial `versions/<v>` that
 * the next update of that version would refuse. One that cannot be renamed stays whole.
 */
function discard(target: string): void {
  const aside = join(dirname(target), `.discard-${randomBytes(8).toString("hex")}`);
  try {
    renameSync(target, aside);
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
  journal: UpdateJournal;
  readonly decision: Decision;
  /** The hold on the service's runs; the caller lets it go once the update is over. */
  held: RunsHold | undefined;
  /** The version folder this update put in place: taken away again if it stops before the switch. */
  readonly placed: string | undefined;
}

/**
 * Right before `current` changes, on what is so then: a service that runs is restarted only on
 * the person's agreement (asked now if it was not yet), its runs held and waited for first; one
 * that ran when the journal was written, on the person's agreement, and has stopped since is
 * brought back. Otherwise a service that runs stops the update here. Returns the journal with
 * that decision, and the spaces of the service it restarts, noted after every wait: the report
 * leaves out a space that was so already.
 */
async function decideAtSwitch(run: Switch): Promise<{
  journal: UpdateJournal;
  note: readonly SpaceNote[] | undefined;
  /** The version the service that runs answered with. */
  seen: string | undefined;
}> {
  const { options } = run;
  const running = await options.control?.running();
  if (running === undefined) return { journal: run.journal, note: undefined, seen: undefined };
  if (!run.journal.service && !(await agree(options, run.decision))) {
    throw new InstallError(NOT_AGREED, 2);
  }
  if (run.held !== undefined && !run.held.held) {
    // The service that was held has ended since: the one that runs now holds runs of its own.
    run.held.release();
    run.held = undefined;
  }
  run.held ??= await waitForRuns(options);
  const noted = await options.control?.running();
  return {
    journal: { ...run.journal, service: true },
    note: noted?.spaces,
    seen: running.version,
  };
}

const duration = (ms: number): string =>
  ms >= 60_000
    ? `${String(Math.round(ms / 60_000))} minutes`
    : `${String(Math.round(ms / 1000))} s`;

/** A space by the ID its entry names: the same before and after a restart, for each copy. */
const idOf = (space: SpaceNote): string | undefined => space.registered ?? space.id;

/** Whether an entry serves its space now, or is on its way there or back. */
const serves = (space: SpaceNote): boolean =>
  space.state !== "unavailable" && space.state !== "closed";

/** Read-only as a space is meant to be: a restored copy to look inside, another machine's space. */
const MEANT_READ_ONLY: readonly (string | undefined)[] = ["read_only_copy", "not_authority"];

/**
 * The entry a space is judged by: the folder that serves it, else the one that served it before,
 * else one that is not closed. A closed copy never stands in for the space.
 */
const judgedEntry = (
  entries: readonly SpaceNote[],
  before: SpaceNote | undefined,
): SpaceNote | undefined =>
  entries.find(serves) ??
  entries.find(
    (e) => before?.entry !== undefined && e.entry === before.entry && e.state !== "closed",
  ) ??
  entries.find((e) => e.state !== "closed");

function verdictOf(now: SpaceNote | undefined, before: SpaceNote | undefined): SpaceVerdict {
  if (now === undefined || now.state === "opening" || now.state === "closing") return "unsettled";
  if (now.state === "open" || (now.state === "read_only" && MEANT_READ_ONLY.includes(now.reason))) {
    return "usable";
  }
  return before?.state === now.state && before.reason === now.reason ? "as_before" : "not_usable";
}

/**
 * Every space the service lists, and every one the note lists, judged by what the service says of
 * it now. A space whose every entry is closed is closed by the person and is left out.
 */
function judge(listed: readonly SpaceNote[], note: readonly SpaceNote[] | undefined): SpaceAtEnd[] {
  const ids: string[] = [];
  for (const space of [...listed, ...(note ?? [])]) {
    const id = idOf(space);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids.flatMap((id): SpaceAtEnd[] => {
    const entries = listed.filter((space) => idOf(space) === id);
    const noted = (note ?? []).filter((space) => idOf(space) === id);
    const closed = (list: readonly SpaceNote[]) => list.every((space) => space.state === "closed");
    if (entries.length > 0 ? closed(entries) : closed(noted)) return [];
    const before = judgedEntry(noted, undefined) ?? noted[0];
    const now = judgedEntry(entries, before);
    const name = [now, before, ...entries, ...noted].find((s) => s?.name !== undefined)?.name ?? id;
    return [{ id, name, verdict: verdictOf(now, before), now, before }];
  });
}

/**
 * The end of every update: asks the service that runs `version` for its spaces until each one it
 * lists, and each one in the note, has opened or failed to, at most `settleWaitMs`, and judges
 * them. With a note (the update restarted the service) a service that does not answer is waited
 * for too; without one, undefined when no service of `version` runs. Also undefined when it
 * answers and serves no space.
 */
async function checkSpaces(
  install: Install,
  options: UpdateOptions,
  version: string,
  note: readonly SpaceNote[] | undefined,
): Promise<SpacesReport | undefined> {
  const control = options.control;
  if (control === undefined) return undefined;
  const boundMs = options.settleWaitMs ?? SETTLE_MS;
  const start = Date.now();
  let told = false;
  let listed: readonly SpaceNote[] | undefined;
  for (;;) {
    const running = await control.running().catch(() => undefined);
    const answers = running?.version === version;
    if (answers) listed = running.spaces;
    if (listed === undefined && note === undefined) return undefined;
    const spaces = judge(listed ?? [], note);
    const settled = answers && spaces.every((space) => space.verdict !== "unsettled");
    if (settled || Date.now() - start >= boundMs) {
      if (answers && spaces.length === 0) return undefined;
      return {
        boundMs,
        noted: note !== undefined,
        checked: answers,
        wayBack: wayBackOf(install, version),
        spaces,
      };
    }
    if (!told && Date.now() - start >= SETTLE_TELL_MS) {
      say(options, `Waiting up to ${duration(boundMs)} for the spaces to open.`);
      told = true;
    }
    await pause(Math.max(1, Math.min(SETTLE_POLL_MS, start + boundMs - Date.now())));
  }
}

/** The version `--rollback` goes to from `current`, when install.json names an installed one. */
function wayBackOf(install: Install, current: string): string | undefined {
  const previous = readInstallRecord(install.state)?.["previous"];
  return typeof previous === "string" && previous !== current && isInstalled(install.root, previous)
    ? previous
    : undefined;
}

const at = async (options: UpdateOptions, point: UpdatePoint): Promise<void> => {
  await options.seams?.update?.(point);
};

/**
 * From a candidate that passed its self-test to the complete new version, or back to the complete
 * old one. The journal is written before each step that a repair needs it for. Whatever stops the
 * update before `current` changes leaves nothing of it: the staged launchers, the journal and the
 * version folder this update put in place go.
 */
async function switchTo(run: Switch): Promise<UpdateResult> {
  const { install, options } = run;
  const { root, state, platform } = install;
  const { from, to } = run.journal;
  const target = join(root, VERSIONS, to);
  const write = (journal: UpdateJournal) => {
    run.journal = journal;
    writeJournal(state, journal);
  };
  const bin = (name: string) => join(root, "bin", name);
  const seam = (name: string) => (point: LauncherPoint) => {
    options.seams?.launcher?.(point, name);
  };
  const plan = stablePlan(root, target, platform);
  let launchers: LauncherChange[] = [];
  let note: readonly SpaceNote[] | undefined;
  let seen: string | undefined;
  try {
    // A stable command that is not what an install writes stops the update before current
    // changes.
    checkStable(plan);
    launchers = launcherChanges(root, target, platform);
    // The candidate passed its self-test before switchTo (an update's, or --rollback's own).
    write({ ...run.journal, phase: "staged", tested: true, launchers });
    // A2 3.12.6 step 8: each changed launcher is staged beside the stable one, checked and
    // flushed, all before current changes.
    try {
      for (const launcher of launchers) {
        stageLauncher(bin(launcher.name), join(target, "bin", launcher.name), launcher.new);
        seam(launcher.name)("staged");
      }
    } catch (error) {
      if (error instanceof InstallError) throw error;
      throw new InstallError(
        `The new launchers could not be staged in bin (${codeOf(error)}). current was not changed.`,
        1,
      );
    }
    await at(options, "staged");
    const decided = await decideAtSwitch(run);
    note = decided.note;
    seen = decided.seen;
    if (decided.journal.service !== run.journal.service) write(decided.journal);
  } catch (error) {
    for (const launcher of launchers) {
      try {
        rmSync(stagedPath(bin(launcher.name)), { force: true });
      } catch {
        // Not a file of the update's (a folder at the name): left as it is.
      }
    }
    removeJournal(state);
    if (run.placed !== undefined) discard(run.placed);
    throw error;
  }
  let restarted = false;
  try {
    writeCurrent(root, currentFor(to, platform), platform);
    await at(options, "current");
    write({ ...run.journal, phase: "switched" });
    await at(options, "switched");
    // One at a time, ttasks.exe first: at every instant at least one stable launcher exists
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
    if (control !== undefined && run.journal.service) {
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
    } else {
      // Started after the decision: it is not restarted unasked. The probe says which version.
      const late = await control?.running();
      if (late !== undefined && late.version !== to) {
        say(
          options,
          `The service started during the update and still runs ${late.version}. To run ${to}, restart it: ${PRODUCT_ID} service restart`,
        );
      }
    }
  } catch (error) {
    return await rollBack(run, error, restarted);
  }
  // The service ran `from` at the switch, and answered on `to` after its restart: both are seen
  // working, and the way back follows (switch.ts writeInstallRecord).
  writeInstallRecord(state, root, platform, {
    switched: { from, to },
    seen: [seen, restarted ? to : undefined],
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
  const spaces = await checkSpaces(install, options, to, restarted ? note : undefined);
  return { outcome: "updated", from, to, ...(spaces === undefined ? {} : { spaces }) };
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
        // When the update changed ttasksw.exe, the one that runs now is the new one: it goes too.
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

/**
 * Before anything is held or stopped: a service that runs is restarted only on the person's
 * decision, and declined, the update stops with nothing changed. True when one runs.
 */
async function decideFirst(options: UpdateOptions, decision: Decision): Promise<boolean> {
  if ((await options.control?.running()) === undefined) return false;
  if (!(await agree(options, decision))) throw new InstallError(NOT_AGREED, 2);
  return true;
}

/** `ttasks update --from <archive>`. */
export async function updateFromArchive(
  archive: string,
  options: UpdateOptions,
): Promise<UpdateResult> {
  const install = openInstall(options.facts);
  const platform = hostPlatform(install.platform);
  if (platform === undefined)
    throw new InstallError(`${PRODUCT_NAME} has no build for this machine.`, 1);
  const lock = await lockForUpdate(install, options);
  const decision: Decision = {};
  try {
    await at(options, "locked");
    sayRepair(options, await repairFirst(install, options, false, decision));
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
      const spaces = await checkSpaces(install, options, from, undefined);
      return { outcome: "current", version: from, ...(spaces === undefined ? {} : { spaces }) };
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
    const ran = await decideFirst(options, decision);
    const held = ran ? await waitForRuns(options) : undefined;
    let run: Switch | undefined;
    try {
      const journal: UpdateJournal = {
        format: 1,
        kind: "update",
        from,
        to: release.version,
        phase: "prepare",
        pid: process.pid,
        started_at: (options.now?.() ?? new Date()).toISOString(),
        staging: `.staging-${randomBytes(8).toString("hex")}`,
        service: ran && (await options.control?.running()) !== undefined,
        tested: false,
        launchers: [],
      };
      writeJournal(install.state, journal);
      await at(options, "prepared");
      const target = join(install.root, VERSIONS, release.version);
      const staging = join(install.root, VERSIONS, journal.staging ?? "");
      let placed: string | undefined;
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
        if (place(staging, target)) placed = target;
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
        // Nothing was switched: the staging folder, the version folder this update put in place
        // and the journal go, current stays.
        rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (placed !== undefined) discard(placed);
        removeJournal(install.state);
        if (error instanceof InstallError) throw error;
        throw new InstallError(
          `${release.archive} could not be put in place (${(error as Error).message}). current was not changed.`,
          1,
        );
      }
      run = { install, options, journal: { ...journal, staging: null }, decision, held, placed };
      return await switchTo(run);
    } finally {
      if (run === undefined) held?.release();
      else run.held?.release();
    }
  } finally {
    lock.release();
  }
}

/** `ttasks update --rollback`: current back to the version it named before the last switch. */
export async function rollbackUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const install = openInstall(options.facts);
  const lock = await lockForUpdate(install, options);
  const decision: Decision = {};
  try {
    await at(options, "locked");
    sayRepair(options, await repairFirst(install, options, false, decision));
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
    const ran = await decideFirst(options, decision);
    const held = ran ? await waitForRuns(options) : undefined;
    let run: Switch | undefined;
    try {
      const journal: UpdateJournal = {
        format: 1,
        kind: "rollback",
        from,
        to: previous,
        phase: "prepare",
        pid: process.pid,
        started_at: (options.now?.() ?? new Date()).toISOString(),
        staging: null,
        service: ran && (await options.control?.running()) !== undefined,
        // Its self-test ran above.
        tested: true,
        launchers: [],
      };
      writeJournal(install.state, journal);
      await at(options, "prepared");
      run = { install, options, journal, decision, held, placed: undefined };
      return await switchTo(run);
    } finally {
      if (run === undefined) held?.release();
      else run.held?.release();
    }
  } finally {
    lock.release();
  }
}

/**
 * `ttasks update --repair`: finishes or rolls back an interrupted update, then brings the service
 * back on what current names when it runs another version and the person agrees, or ran when the
 * update began and the person agreed then.
 */
export async function repairUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const install = openInstall(options.facts);
  const lock = await lockForUpdate(install, options);
  try {
    await at(options, "locked");
    const repair = await repairFirst(install, options, true, {});
    if (repair.kind === "stuck") sayRepair(options, repair);
    const current = currentVersion(install.root, install.platform);
    if (current === undefined) throw new InstallError("current names no installed version.", 1);
    if (repair.kind === "nothing") cleanLaunchers(install.root);
    const spaces = await checkSpaces(install, options, current, undefined);
    return { outcome: "repaired", repair, current, ...(spaces === undefined ? {} : { spaces }) };
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
