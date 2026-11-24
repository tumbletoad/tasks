// The switch of `ttasks install --finish` (A2 3.12.4 step 4 on Linux, step 5 on Windows): an
// install script has verified a version and renamed it into `<root>/versions/<v>/`, and runs this
// through that version's own launcher. The CLI's `install` command first runs the self-test
// (doctor's integrity, runtime and candidate rows); only when every row passed does it call
// finishInstall, which
//   1. takes `<state>/update.lock` (A2 3.2.3, 3.12.6), so two installs or an update never switch at
//      once: the second stops with nothing changed,
//   2. finishes or rolls back an update that was interrupted (repair.ts), so an install never
//      switches under a journal that would later undo it,
//   3. over another version, writes an install's journal (journal.ts), so a cut from here on is
//      finished like a cut-off update and keeps the version before it as the way back,
//   4. points `current` at the version (switch.ts),
//   5. puts the stable command in place: `<root>/bin/ttasks` (Linux, macOS), or copies of the
//      version's `ttasks.exe` and `ttasksw.exe` in `<root>\bin\` (Windows),
//   6. writes `<state>/install.json` (A2 3.2.3): the method, the root, the install ID, the versions
//      installed, the version current named before, and what the installer created, so an
//      uninstall can remove exactly that; then the journal goes.
// M1.14 makes separate installs only (A2 3.2.2 rule 3): the launcher's TTASKS_HOME must be this
// version's install root, which holds home.marker. Nothing is written outside the root.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PRODUCT_ID, PRODUCT_NAME } from "@ttasks/brand";
import { ensurePrivateDir, judgePath } from "../hub/files.ts";
import { acquireLock, LockBusy } from "../hub/lock.ts";
import { unsafeMessage, type UnsafeThing } from "../hub/permissions.ts";
import { readUmask, umaskRefusal, type UmaskRead } from "../hub/umask.ts";
import {
  canonicalStatePath,
  TTASKS_HOME,
  resolveLayout,
  type HostFacts,
  type Layout,
} from "../hub/paths.ts";
import { isVersionName, readVersionManifest, type VersionManifest } from "./folder.ts";
import { JOURNAL_FORMAT, removeJournal, writeJournal, type Journal } from "./journal.ts";
import { repairLocked } from "./repair.ts";
import {
  checkStable,
  currentFor,
  HOME_MARKER,
  InstallError,
  launcherChanges,
  placeStable,
  readCurrent,
  stableFiles,
  stablePlan,
  UPDATE_LOCK,
  writeCurrent,
  writeInstallRecord,
  type InstallRecord,
  type Undo,
} from "./switch.ts";

export {
  HOME_MARKER,
  INSTALL_FILE,
  INSTALL_FORMAT,
  InstallError,
  UPDATE_LOCK,
  type InstallRecord,
  type Undo,
} from "./switch.ts";

/** What the install script may say it created in this run. */
export function scriptCreations(version: string): readonly string[] {
  return [".", "versions", `versions/${version}`, HOME_MARKER];
}

export interface InstallTarget {
  readonly root: string;
  readonly version: string;
  readonly manifest: VersionManifest;
  readonly layout: Layout;
}

const sameFolder = (a: string, b: string, platform: NodeJS.Platform): boolean => {
  try {
    const real = (p: string) => canonicalStatePath(realpathSync.native(p), platform);
    return real(a) === real(b);
  } catch {
    return false;
  }
};

/**
 * The install a version folder belongs to, checked: it sits in `<root>/versions/` under its own
 * version's name, and the launcher that started this process set TTASKS_HOME to that root, which
 * holds home.marker. Throws InstallError otherwise.
 */
export function installTarget(versionFolder: string, facts: HostFacts): InstallTarget {
  const refuse = (why: string) =>
    new InstallError(
      `${PRODUCT_ID} install --finish runs only from an install script, through the new version's own launcher: ${why}`,
      5,
    );
  const versions = dirname(versionFolder);
  if (basename(versions) !== "versions") throw refuse("this version is not in a versions folder.");
  const root = dirname(versions);
  let manifest: VersionManifest;
  try {
    manifest = readVersionManifest(versionFolder);
  } catch {
    throw refuse("this version's manifest.json cannot be read.");
  }
  if (basename(versionFolder) !== manifest.version) {
    throw refuse("the version folder's name is not its version.");
  }
  const layout = resolveLayout(facts);
  if (layout.home === undefined || !existsSync(join(root, HOME_MARKER))) {
    throw refuse(`this build installs separate installs only (${TTASKS_HOME}, home.marker).`);
  }
  if (!sameFolder(layout.home, root, facts.platform)) {
    throw refuse(`${TTASKS_HOME} is not this version's install root.`);
  }
  return { root: layout.home, version: manifest.version, manifest, layout };
}

/** Why the state folder must be no one else's, after what is wrong with it (permissions.ts). */
const STATE_WHY = `Whoever can change it could change what ${PRODUCT_NAME} records and runs, so the install does not finish`;

/**
 * What `install --finish` refuses before its self-test writes anything (A2 3.2.2 rule 5): a umask
 * that takes away the person's own bits, or that cannot be read, and a state folder, or the `tmp`
 * in it where the self-test works, that another user can change (A2 3.2.2 rule 5). The install
 * scripts set their own umask (077) before they hand over, so only a run by other means can meet
 * the first. Throws InstallError (5) with the line a person reads, built in permissions.ts; changes
 * nothing. Windows has no umask, and its folders are doctor's to check.
 */
export function refuseBeforeFinish(
  target: InstallTarget,
  platform: NodeJS.Platform,
  umask: () => UmaskRead = () => readUmask(platform),
): void {
  const line = umaskRefusal(umask(), "the install does not finish");
  if (line !== undefined) throw new InstallError(line, 5);
  const state = target.layout.state;
  const failed: { thing: UnsafeThing; hidden: string[] }[] = [];
  for (const [dir, name] of [
    [state, "state folder"],
    [join(state, "tmp"), "temporary folder"],
  ] as const) {
    const named = `${PRODUCT_NAME}'s ${name}`;
    const judged = judgePath(dir, "folder", { followLink: true });
    if (judged === "unseen") {
      const parent = failed.at(-1);
      if (parent === undefined) {
        throw new InstallError(`${named} cannot be looked at, so the install does not finish.`, 5);
      }
      parent.hidden.push(named);
    } else if (judged !== undefined) {
      failed.push({ thing: { name: named, ...judged }, hidden: [] });
    }
  }
  if (failed.length > 0) {
    throw new InstallError(
      unsafeMessage(
        failed.map(({ thing, hidden }) =>
          hidden.length === 0 ? thing : { ...thing, hides: hidden.join(" and ") },
        ),
        STATE_WHY,
      ),
      5,
    );
  }
}

export interface FinishOptions {
  readonly versionFolder: string;
  readonly facts: HostFacts;
  /** What the install script created in this run, root-relative (scriptCreations). */
  readonly created?: readonly string[];
  /**
   * Whether this run of `install --finish` made `<state>`: its self-test runs first and works in
   * `<state>/tmp/`, so by the time finishInstall looks, the folder is there either way.
   */
  readonly stateCreated?: boolean;
  /**
   * The version this install's service answered with before the finish, if one runs: recorded as
   * seen working, so a later switch keeps it as the way back (switch.ts writeInstallRecord).
   */
  readonly seen?: string;
  /**
   * Tests only: runs once current and the stable command have changed, before install.json is
   * written, as a client starting the new stable command at that moment would.
   */
  readonly afterSwitch?: () => void | Promise<void>;
  /**
   * Tests only: runs after each launcher of the stable command is put in place and after each step
   * of an undo, as a stable launcher started at that moment would (its sibling repair, launcher.c).
   */
  readonly afterStep?: () => void;
}

export interface Finished {
  readonly root: string;
  readonly version: string;
  readonly build: string;
  readonly installId: string;
  /** The stable command: `<root>/bin/ttasks`, or `<root>\bin\ttasks.exe`. */
  readonly command: string;
  readonly record: InstallRecord;
}

/**
 * Takes update.lock, finishes an interrupted update, switches current, puts the stable command in
 * place and writes install.json. Call it only after the version's self-test passed. Throws
 * InstallError, having changed nothing when the lock is held, the stable command or current is
 * not an install's, or `created` names something the script cannot create. A failure after the
 * switch puts current and the stable command back as they were before it throws; only a crash can
 * leave current switched, and the install scripts then keep the version folder that current names.
 */
export async function finishInstall(options: FinishOptions): Promise<Finished> {
  const { facts } = options;
  const platform = facts.platform;
  const target = installTarget(options.versionFolder, facts);
  const allowed = scriptCreations(target.version);
  const fromScript = options.created ?? [];
  for (const path of fromScript) {
    if (!allowed.includes(path)) {
      throw new InstallError(`--created names something an install script does not create.`, 2);
    }
  }
  const state = target.layout.state;
  const stateExisted =
    options.stateCreated === undefined ? existsSync(state) : !options.stateCreated;
  // Judged again: the self-test ran in between, and update.lock and install.json go here.
  const judged = ensurePrivateDir(state, platform);
  if (judged !== undefined) {
    throw new InstallError(
      unsafeMessage([{ name: `${PRODUCT_NAME}'s state folder`, ...judged }], STATE_WHY),
      5,
    );
  }
  let lock;
  try {
    lock = await acquireLock(join(state, UPDATE_LOCK));
  } catch (error) {
    if (error instanceof LockBusy) {
      throw new InstallError(
        "Another install or update of this install is running. Nothing was changed: run the installer again once it has finished.",
        4,
      );
    }
    throw error;
  }
  try {
    // An update that was cut off is finished or rolled back first (A2 3.12.6): switching under its
    // journal would let a later repair undo this install. One that can be neither (no complete
    // version on either side) is superseded by this complete, verified one: its journal goes once
    // this install has finished.
    let repair: ReturnType<typeof repairLocked>;
    try {
      repair = repairLocked({ root: target.root, state, platform });
    } catch (error) {
      throw new InstallError(
        `An update of this install was cut off, and finishing it failed (${(error as NodeJS.ErrnoException).code ?? "an error"}). Nothing was changed: run the installer again.`,
        1,
      );
    }
    const plan = stablePlan(target.root, options.versionFolder, platform);
    checkStable(plan);
    const before = readCurrent(target.root, platform);
    const previous =
      before.kind === "value"
        ? platform === "win32"
          ? before.value
          : basename(before.value)
        : undefined;
    // An install over another version is journalled like an update before current changes:
    // wherever it is cut off from here, whoever of this version or later takes update.lock next
    // (this installer run again, an update, the running service) finishes it, and install.json
    // then names the version before it as the way back. A service of a version from before this
    // journal never reads it, so it keeps serving and is not restarted unasked. A first install
    // has no way back to keep, and a journal no repair could finish stays as it is.
    const journal: Journal | undefined =
      previous !== undefined &&
      previous !== target.version &&
      isVersionName(previous) &&
      repair.kind !== "stuck"
        ? {
            format: JOURNAL_FORMAT,
            kind: "install",
            from: previous,
            to: target.version,
            phase: "staged",
            pid: process.pid,
            started_at: new Date().toISOString(),
            staging: null,
            // An install never restarts the service.
            service: false,
            tested: true,
            launchers: launcherChanges(target.root, options.versionFolder, platform),
          }
        : undefined;
    if (journal !== undefined) writeJournal(state, journal);
    // Right before the switch: a launcher that appears after it was put there by a stable
    // launcher's sibling repair (launcher.c, while a stuck update's journal is there), from the
    // version this install switches to.
    const stableBefore = stableFiles(plan);
    // From the switch on, all or nothing: a failure puts back current and the stable command, so
    // the install script can remove the new version and leave the previous install working.
    // current goes back first: from then on a stable launcher's sibling repair copies from the
    // version current named before, or with none from nothing, and never brings back a launcher
    // the undo removes.
    const putBackCurrent: Undo = {
      what: "current",
      run: () => {
        writeCurrent(target.root, before, platform);
      },
    };
    const undo: Undo[] = [];
    try {
      writeCurrent(target.root, currentFor(target.version, platform), platform);
      const placed = placeStable(target.root, plan, undo, {
        before: stableBefore,
        ...(options.afterStep === undefined ? {} : { afterStep: options.afterStep }),
      });
      await options.afterSwitch?.();
      const record = writeInstallRecord(state, target.root, platform, {
        installed: target.version,
        created: [
          ...fromScript,
          ...(stateExisted ? [] : ["state"]),
          ...(before.kind === "none" ? ["current"] : []),
          ...placed,
        ],
        seen: [options.seen],
        ...(previous !== undefined && previous !== target.version
          ? { switched: { from: previous, to: target.version } }
          : {}),
      });
      // Complete: an install's journal this run wrote, or one left by an install an older version
      // then switched past, and a journal no repair could finish, are all done with.
      removeJournal(state, "install");
      if (repair.kind === "stuck") removeJournal(state);
      return {
        root: target.root,
        version: target.version,
        build: target.manifest.build,
        installId: record.install_id,
        command: plan[0]?.path ?? join(target.root, "bin", PRODUCT_ID),
        record,
      };
    } catch (error) {
      const left: string[] = [];
      for (const step of [putBackCurrent, ...undo.reverse()]) {
        try {
          step.run();
          options.afterStep?.();
        } catch (undoError) {
          left.push(`${step.what}: ${(undoError as NodeJS.ErrnoException).code ?? "an error"}`);
        }
      }
      // All put back: nothing is left to finish. Otherwise the journal stays, and the next run
      // takes the install the rest of the way back.
      if (journal !== undefined && left.length === 0) removeJournal(state, "install");
      const why =
        error instanceof InstallError ? error.message : (error as Error).message || "an error";
      throw new InstallError(
        left.length === 0
          ? `The install did not finish (${why}). current and the stable command were put back as they were.`
          : `The install did not finish (${why}), and these could not be put back as they were: ${left.join("; ")}. Run the installer again.`,
        error instanceof InstallError ? error.exitCode : 1,
      );
    }
  } finally {
    lock.release();
  }
}
