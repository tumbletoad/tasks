// Repair after a killed updater or supervisor (A2 3.12.6): an update journal found by a process
// that holds update.lock belongs to an update whose updater is gone (the updater holds the lock
// for the whole update, and the OS lets go of a lock on any exit). The first to find it finishes
// it or rolls it back: any `tasks update` (also `--repair`), `tasks install --finish`, and the
// service at its start and every 10 s while it runs.
//
// It decides from what is on disk, not from how far the journal says the update came:
//   - it rolls forward when the journal is not rolling back, `current` already names the new
//     version, and that version's folder matches its manifest (so the launchers in it are the
//     verified ones): the stable launchers are brought to their new SHA-256 and install.json
//     records the version;
//   - otherwise it rolls back: phase `rolling_back` is written first, so a repair cut off after
//     that never rolls forward, then `current` names the old version again and each stable
//     launcher gets its old SHA-256 back from its `.old-<n>` copy or a version folder;
//   - but it never goes back to an old version that is gone or no longer matches its manifest:
//     then a complete new version that passed its self-test (the journal's `tested`) is kept, and
//     with neither nothing changes (`stuck`).
// Either way it removes the staging folder the journal names, then the journal (an updater that
// brings the service back removes the journal itself, after that): the install is the complete old
// version or the complete new one. Each step does nothing when it is already done, so a repair cut
// off at any point is finished by the next. It never removes a version folder: a
// process may still run from it (A2 3.12.6), and retiring versions needs version-use leases.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, LockBusy } from "../hub/lock.ts";
import { checkVersionFolder } from "./folder.ts";
import {
  readJournal,
  removeJournal,
  UPDATE_JOURNAL,
  writeJournal,
  type Journal,
} from "./journal.ts";
import {
  asideCopies,
  cleanAsideLaunchers,
  currentFor,
  currentVersion,
  digestOf,
  ensureLauncher,
  exists,
  isInstalled,
  removePlaced,
  UPDATE_LOCK,
  VERSIONS,
  WINDOWS_LAUNCHERS,
  writeCurrent,
  writeInstallRecord,
} from "./switch.ts";

/**
 * The service's repair (A2 3.12.6): at its start (`clean`: also the launchers renamed aside, which
 * only an update leaves) and every 10 s while a journal is there. It takes update.lock without
 * waiting: a live update holds it, and then there is nothing to repair. Returns undefined when the
 * lock was held, else what it did.
 */
export async function repairIfIdle(
  options: RepairOptions & { readonly clean?: boolean },
): Promise<RepairOutcome | undefined> {
  if (!options.clean && !existsSync(join(options.state, UPDATE_JOURNAL)))
    return { kind: "nothing" };
  if (!existsSync(join(options.root, VERSIONS))) return { kind: "nothing" };
  let lock;
  try {
    lock = await acquireLock(join(options.state, UPDATE_LOCK));
  } catch (error) {
    if (error instanceof LockBusy) return undefined;
    throw error;
  }
  try {
    const outcome = repairLocked(options);
    if (options.clean === true && outcome.kind === "nothing") cleanAsideLaunchers(options.root);
    return outcome;
  } finally {
    lock.release();
  }
}

/** Where a repair can be cut off, for the crash tests (tests/update/). Off in the product. */
export type RepairPoint =
  "repair:decided" | "repair:current" | "repair:launchers" | "repair:record" | "repair:done";

export interface RepairSeams {
  readonly at: (point: RepairPoint) => void;
}

export interface RepairOptions {
  readonly root: string;
  readonly state: string;
  readonly platform: NodeJS.Platform;
  readonly seams?: RepairSeams;
  /** Why a rollback goes back, as install.json records it. Default: `interrupted`. */
  readonly reason?: string;
  /** The clock of the record's `at`. */
  readonly now?: () => Date;
  /**
   * Leave the journal of a finished or rolled-back update for the caller to remove: an updater
   * that brings the service back removes it only after that, so a kill in between leaves the next
   * run the journal's `service`, and it brings the service back instead (update.ts repairFirst).
   */
  readonly keepJournal?: boolean;
}

export type RepairOutcome =
  /** No journal: nothing was interrupted. */
  | { readonly kind: "nothing" }
  | {
      readonly kind: "rolled_forward" | "rolled_back";
      readonly journal: Journal;
      /** The version current names now. */
      readonly current: string;
    }
  /** A journal no updater of this build wrote: current's version, intact, was kept. */
  | { readonly kind: "kept"; readonly current: string }
  /** Neither side is complete: the journal stays, and doctor names the problems. */
  | { readonly kind: "stuck"; readonly problems: readonly string[] };

const intact = (root: string, version: string): boolean =>
  isInstalled(root, version) && checkVersionFolder(join(root, VERSIONS, version)).length === 0;

/** Brings each stable launcher of `version` to its own copy in that version folder (Windows). */
function launchersOf(root: string, version: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [];
  const problems: string[] = [];
  for (const name of WINDOWS_LAUNCHERS) {
    const source = join(root, VERSIONS, version, "bin", name);
    const want = digestOf(source);
    const path = join(root, "bin", name);
    if (want === null || !ensureLauncher(path, want, [source])) {
      problems.push(`bin/${name} cannot be brought to ${version}'s`);
    }
  }
  return problems;
}

/**
 * Reconciles an interrupted update. Call it only while holding `<state>/update.lock`: then a
 * journal is one whose updater is gone. Returns what it did; throws only when a file operation
 * fails, leaving the journal for the next repair.
 */
export function repairLocked(options: RepairOptions): RepairOutcome {
  const { root, state, platform } = options;
  const at = (point: RepairPoint) => {
    options.seams?.at(point);
  };
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const read = readJournal(state);
  if (read.kind === "none") return { kind: "nothing" };
  if (read.kind === "invalid") {
    // Not a journal this build wrote: keep what current names when it is a complete version.
    const current = currentVersion(root, platform);
    if (current === undefined || !intact(root, current)) {
      return { kind: "stuck", problems: ["the update journal cannot be read"] };
    }
    const problems = launchersOf(root, current, platform);
    if (problems.length > 0) return { kind: "stuck", problems };
    removeJournal(state);
    return { kind: "kept", current };
  }
  let journal = read.journal;
  const named = currentVersion(root, platform);
  const toIntact = intact(root, journal.to);
  let forward = journal.phase !== "rolling_back" && named === journal.to && toIntact;
  // The old version is gone or no longer matches its manifest: going back would leave current
  // naming nothing, or a version that cannot run. A complete new version that passed its self-test
  // is the only good one left (its journal then names the launchers it changes); otherwise
  // nothing is changed.
  if (!forward && !intact(root, journal.from)) {
    if (!toIntact || !journal.tested) {
      return {
        kind: "stuck",
        problems: [
          `${journal.from} is not complete, and ${journal.to} is not ${toIntact ? "tested" : "complete"}`,
        ],
      };
    }
    forward = true;
  }
  at("repair:decided");

  const bin = (name: string) => join(root, "bin", name);
  const problems: string[] = [];
  if (forward) {
    if (named !== journal.to) {
      writeCurrent(root, currentFor(journal.to, platform), platform);
    }
    at("repair:current");
    for (const launcher of journal.launchers) {
      const path = bin(launcher.name);
      const sources = [
        join(root, VERSIONS, journal.to, "bin", launcher.name),
        ...asideCopies(path),
      ];
      if (!ensureLauncher(path, launcher.new, sources)) {
        problems.push(`bin/${launcher.name} cannot be brought to ${journal.to}'s`);
      }
    }
    at("repair:launchers");
    if (problems.length > 0) return { kind: "stuck", problems };
    writeInstallRecord(state, root, platform, {
      installed: journal.to,
      previous: journal.from,
      lastUpdate: {
        kind: journal.kind,
        outcome: "completed",
        from: journal.from,
        to: journal.to,
        at: now(),
      },
    });
  } else {
    if (journal.phase !== "rolling_back") {
      journal = { ...journal, phase: "rolling_back" };
      writeJournal(state, journal);
    }
    if (named !== journal.from) {
      writeCurrent(root, currentFor(journal.from, platform), platform);
    }
    at("repair:current");
    for (const launcher of journal.launchers) {
      const path = bin(launcher.name);
      if (launcher.old === null) {
        // There was none before: one the update placed goes (aside, if it runs).
        if (exists(path) && digestOf(path) === launcher.new) removePlaced(path);
        continue;
      }
      const sources = [
        ...asideCopies(path),
        join(root, VERSIONS, journal.from, "bin", launcher.name),
      ];
      if (!ensureLauncher(path, launcher.old, sources)) {
        problems.push(`bin/${launcher.name} cannot be brought back to ${journal.from}'s`);
      }
    }
    at("repair:launchers");
    if (problems.length > 0) return { kind: "stuck", problems };
    writeInstallRecord(state, root, platform, {
      lastUpdate: {
        kind: journal.kind,
        outcome: "reverted",
        from: journal.from,
        to: journal.to,
        at: now(),
        reason: options.reason ?? "interrupted",
      },
    });
  }
  at("repair:record");
  if (journal.staging !== null) {
    rmSync(join(root, VERSIONS, journal.staging), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  if (options.keepJournal !== true) removeJournal(state);
  at("repair:done");
  return {
    kind: forward ? "rolled_forward" : "rolled_back",
    journal,
    current: forward ? journal.to : journal.from,
  };
}
