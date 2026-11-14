// Putting a rebuilt space folder in the place of a live one (A1 3.18 "Restore in place"): restore
// in place and the recovery of a space with a rollback journal both build the new folder complete
// beside the live one, then swap the two by name. No OS renames a folder over a folder that holds
// files, so the swap is two renames, and the names say how far it got:
//
//   .<slug>.restoring-<T>   the new folder, complete before the swap starts (or a failed build)
//   <slug>.replaced-<T>     the live folder, moved aside: kept, never deleted
//   <slug>                  the space
//
// 1. Rename `<slug>` to `<slug>.replaced-<T>`, then sync the parent folder.
// 2. Rename `.<slug>.restoring-<T>` to `<slug>`, then sync the parent folder.
// 3. Move the replaced folder's `backups/` into the new folder, when the new one has none, so the
//    space's backups stay listed with it (one rename, best effort).
//
// A crash leaves one of these states, and each is either the old space, the new one, or clearly
// incomplete and recoverable:
// - Before 1: the live space is untouched. `.<slug>.restoring-<T>` is a leftover.
// - Between 1 and 2: no `<slug>`, so the space is not found (SPACE_NOT_FOUND), never a wrong one.
//   `<slug>.replaced-<T>` and a complete `.<slug>.restoring-<T>` with the same T are both there.
//   finishInterruptedRestore completes the swap.
// - Between 2 and 3: the new space is in place. Its backups are still in the replaced folder, and
//   finishInterruptedRestore moves them.
// The new folder is complete, claimed and verified before step 1, so no crash exposes a half-built
// or unclaimed space under the space's name. M1.08 runs finishInterruptedRestore before it opens a
// space, and M1.10's leftover cleanup lists the other names.
//
// A swap the caller rejects after step 1 (SwapHooks.afterMoveAside: on Windows the space was
// written while the writer.lock had ended for the swap) moves the live folder back. When that
// rename fails too, the new folder is marked rejected (a `rejected` file in it, then its space.json
// removed), and finishInterruptedRestore moves the live folder back instead of completing the
// swap. A crash between step 1 and that check completes the swap as any crash there does.
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { StorageError } from "../errors.ts";
import {
  createEmptyFile,
  errnoCode,
  FILE_MODE,
  fsCall,
  fsError,
  fsyncFolder,
  removeQuietly,
} from "../files.ts";
import { DATABASE_FILE, MANIFEST_FILE } from "../manifest.ts";
import { parseUtcStamp, utcStamp, BACKUPS_FOLDER } from "../backup/sidecar.ts";
import { checkSpacePath } from "../space-path.ts";

/** The names of a swap at the moment `stamp`. */
export interface SwapNames {
  parent: string;
  slug: string;
  stamp: string;
  live: string;
  staging: string;
  replaced: string;
}

/**
 * The space folder a swap renames, checked: a space path that is not itself a link. A swap renames
 * the entry by this name. Through a link (a symbolic link, or a junction on Windows) it would
 * rename the link and leave the folder it names, which the space's claim and the copy read, in
 * place: so the folder itself is named, never a link to it.
 */
export function checkSwapPath(folder: string): string {
  const live = checkSpacePath(folder);
  if (fsCall(() => lstatSync(live, { throwIfNoEntry: false })?.isSymbolicLink() === true)) {
    throw new StorageError(
      "SPACE_PATH_INVALID",
      "A restore or a recovery names the space folder itself, not a link to it",
    );
  }
  return live;
}

export function swapNames(folder: string, now: number): SwapNames {
  const live = checkSwapPath(folder);
  const parent = dirname(live);
  const slug = basename(live);
  const stamp = utcStamp(now);
  return {
    parent,
    slug,
    stamp,
    live,
    staging: join(parent, `.${slug}.restoring-${stamp}`),
    replaced: join(parent, `${slug}.replaced-${stamp}`),
  };
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Renames a folder. On Windows a scanner can hold a file of a folder that was just closed for a
 * moment, so a sharing failure is retried for about half a second, as create does. A folder at
 * `to` is SPACE_EXISTS.
 */
export function renameFolder(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (existsSync(to)) throw new StorageError("SPACE_EXISTS", "A folder is already there");
      const code = errnoCode(error);
      const sharing = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (process.platform === "win32" && sharing && attempt < 20) {
        sleepSync(25);
        continue;
      }
      throw fsError(error);
    }
  }
}

/** The file that marks a new folder whose swap was rejected after the live folder moved aside. */
export const REJECTED_MARK = "rejected";

/** Marks a new folder rejected: the mark first, then its space.json, so it is never completed. */
function markRejected(staging: string): void {
  try {
    createEmptyFile(join(staging, REJECTED_MARK), FILE_MODE);
  } catch {
    // The manifest's removal below is enough to keep it from being completed.
  }
  try {
    rmSync(join(staging, MANIFEST_FILE), { force: true });
    fsyncFolder(staging);
  } catch {
    // Nothing more can be done here; the mark alone keeps finishInterruptedRestore from it.
  }
}

const isDirectory = (path: string): boolean =>
  fsCall(() => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true);

/** The points M1.07's crash harness kills at. */
export type SwapPoint = "moved-aside" | "moved-into-place" | "backups-carried";

export interface SwapResult {
  /** The live folder's new name. */
  replaced: string;
  /** Whether the replaced folder's backups now sit in the new folder. */
  backupsCarried: boolean;
}

/**
 * What the caller of a swap checks around its first rename: the storage worker's writer.lock guard
 * (writer-lock.ts swapGuard). `beforeSwap` runs before anything is renamed; `afterMoveAside` runs
 * once the live folder is moved aside, and when it throws the live folder is moved back.
 */
export interface SwapHooks {
  beforeSwap?(): void;
  afterMoveAside?(replaced: string): void;
}

/**
 * Swaps the complete folder `names.staging` in for `names.live`. A failure before the live folder
 * moved leaves both as they were and throws. A failure of the second rename moves the live folder
 * back when it can, and otherwise leaves the state that finishInterruptedRestore completes.
 */
export function swapIntoPlace(
  names: SwapNames,
  at?: (point: SwapPoint) => void,
  hooks: SwapHooks = {},
): SwapResult {
  if (fsCall(() => existsSync(names.replaced))) {
    throw new StorageError("SPACE_EXISTS", "A replaced folder with this time already exists");
  }
  hooks.beforeSwap?.();
  renameFolder(names.live, names.replaced);
  fsyncFolder(names.parent);
  try {
    hooks.afterMoveAside?.(names.replaced);
  } catch (error) {
    try {
      renameFolder(names.replaced, names.live);
      fsyncFolder(names.parent);
    } catch {
      // Not back: the new folder must never be completed in its place. Marked rejected, so
      // finishInterruptedRestore moves the live folder back when it can.
      markRejected(names.staging);
    }
    throw error;
  }
  at?.("moved-aside");
  try {
    renameFolder(names.staging, names.live);
  } catch (error) {
    try {
      renameFolder(names.replaced, names.live);
    } catch {
      // Both folders stay: finishInterruptedRestore completes the swap.
    }
    throw error;
  }
  fsyncFolder(names.parent);
  at?.("moved-into-place");
  const backupsCarried = carryBackups(names.replaced, names.live);
  at?.("backups-carried");
  return { replaced: names.replaced, backupsCarried };
}

/**
 * Moves `<from>/backups` to `<to>/backups` when `to` has none: one rename, so the backups are in
 * one folder or the other, never split. Best effort: on failure they stay where they were, still
 * restorable by path. Returns whether they moved.
 */
export function carryBackups(from: string, to: string): boolean {
  const source = join(from, BACKUPS_FOLDER);
  const target = join(to, BACKUPS_FOLDER);
  try {
    if (!isDirectory(source) || existsSync(target)) return false;
    renameSync(source, target);
    fsyncFolder(to);
    fsyncFolder(from);
    return true;
  } catch {
    return false;
  }
}

export interface ResumeReport {
  /** The stamp of a swap this call completed, if any. */
  completed: string | undefined;
  /** The stamp of a rejected swap this call undid (the live folder moved back), if any. */
  undone?: string;
  /** The stamps whose backups this call moved into the space. */
  backupsCarried: string[];
}

const REPLACED = /^(.+)\.replaced-(\d{8}T\d{6}\.\d{3}Z)$/;

/**
 * Completes a restore in place or a recovery that a crash interrupted (see above), for the space
 * at `folder`: a missing space folder whose complete new folder and replaced folder are both
 * there is moved into place, and backups left in a replaced folder join the space. Anything else
 * is left alone. Run it before the space opens, while nothing else works on it.
 */
export function finishInterruptedRestore(folder: string): ResumeReport {
  const live = checkSpacePath(folder);
  const parent = dirname(live);
  const slug = basename(live);
  const report: ResumeReport = { completed: undefined, backupsCarried: [] };
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return report;
    throw fsError(error);
  }
  const stamps = entries
    .map((name) => REPLACED.exec(name))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === slug)
    .map((m) => m[2] ?? "")
    .filter((stamp) => parseUtcStamp(stamp) !== undefined)
    .sort();
  for (const stamp of stamps) {
    const replaced = join(parent, `${slug}.replaced-${stamp}`);
    const staging = join(parent, `.${slug}.restoring-${stamp}`);
    const rejected = isDirectory(staging) && fsCall(() => existsSync(join(staging, REJECTED_MARK)));
    if (rejected) {
      // A swap its caller rejected after the live folder moved aside: the live folder goes back,
      // and the new folder is removed. Never completed.
      if (!fsCall(() => existsSync(live)) && isDirectory(replaced)) {
        renameFolder(replaced, live);
        fsyncFolder(parent);
        report.undone = stamp;
      }
      if (fsCall(() => existsSync(live))) removeQuietly(staging);
      continue;
    }
    if (
      !fsCall(() => existsSync(live)) &&
      isDirectory(staging) &&
      fsCall(
        () => existsSync(join(staging, DATABASE_FILE)) && existsSync(join(staging, MANIFEST_FILE)),
      )
    ) {
      renameFolder(staging, live);
      fsyncFolder(parent);
      report.completed = stamp;
    }
    if (isDirectory(live) && carryBackups(replaced, live)) report.backupsCarried.push(stamp);
  }
  return report;
}
