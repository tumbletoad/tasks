// Listing a space's backups (A1 3.18, `ttasks space backups list` in M1.10). The listing reads each
// sidecar and checks that its `.db.gz` is there with the size the sidecar records. It does not
// decompress anything, and it verifies nothing: a restore checks the backup in full before it uses
// it, and retention keeps the newest backup that a trial restore verified (verifyBackup).
//
// Files the listing does not recognise are never touched. LEFTOVERS are only a backup's own
// temporary files, by their exact names (isBackupTemporary), which a crash can leave and
// removeBackupLeftovers deletes. A `.db.gz` without its sidecar is listed as a backup in the state
// `missing_sidecar`, never as a leftover: a crash between the publication of the two files leaves
// one, and so does a person who copied or moved the pair apart, and the two cannot be told apart.
// It holds the whole database, so it stays for a person. A leftover is a regular file, never a
// folder or a link, and is removed only once it has not changed for an hour: a younger one may
// belong to a backup in progress, in this process or in another (a backups folder that two spaces
// share), whose files look exactly the same. A running backup refreshes its files' times well
// within that hour (backup.ts). The age is no lock: A1 3.18 names the window that remains, and
// M1.08 cleans only folders it alone writes.
//
// A backup's two files are looked up by their paths, as a restore looks them up, not matched by the
// names the folder lists: on a file system that ignores case, `X.JSON` is the sidecar of `X.db.gz`
// for a restore, so it must be for the listing too.
import { lstatSync, readdirSync, rmSync, type Dirent, type Stats } from "node:fs";
import { join } from "node:path";
import { errnoCode, fsCall, fsError } from "../files.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { BUNDLE_POLICY, type BundlePolicy } from "./policy.ts";
import {
  DATA_SUFFIX,
  isBackupTemporary,
  parseBackupName,
  readSidecar,
  SIDECAR_SUFFIX,
  sidecarMatchesName,
  type BackupSidecar,
} from "./sidecar.ts";
import { verifyBackupFile, type VerifyOptions } from "../restore/restore.ts";

export type { VerifyOptions };

export type ListedState =
  /** The sidecar is valid and its `.db.gz` is there with the recorded size. */
  | "ok"
  /** The sidecar is valid, but its `.db.gz` is missing or is not a regular file. */
  | "missing_data"
  /** The `.db.gz` differs in size from what the sidecar records. */
  | "size_mismatch"
  /** The sidecar is not a regular file, too large, unreadable as a sidecar, or names another backup. */
  | "invalid_sidecar"
  /** The `.db.gz` is there without a sidecar: whose it is, and whether it is whole, is not known. */
  | "missing_sidecar";

export interface ListedBackup {
  name: string;
  /** When the backup began, by its name: known also when its sidecar is not. */
  createdAt: number;
  /** The epoch of the incarnation it holds, by its name. */
  epoch: number;
  /** The last commit it holds, by its name. */
  seq: number;
  /** The `.db.gz` file (it may be missing: see `state`). */
  file: string;
  sidecarFile: string;
  state: ListedState;
  /** Undefined when the sidecar is invalid. */
  sidecar: BackupSidecar | undefined;
}

export interface BackupListing {
  folder: string;
  /** Newest first (newestFirst). */
  backups: ListedBackup[];
  /** Names of a backup's temporary files: a crash left them, or a backup is writing them now. */
  leftovers: string[];
}

function readFolder(folder: string): Dirent[] {
  try {
    return readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw fsError(error);
  }
}

/**
 * Orders backups newest first by the work they hold, never by the clock alone: a later
 * incarnation (each claim and restore in place takes an epoch above every one the machine knows),
 * then within one the later commit, and only for the same commit the later time. A clock set back
 * between two backups gives the later work the earlier time, and it is still the newer one.
 */
export function compareNewest(
  a: Pick<ListedBackup, "name" | "createdAt" | "epoch" | "seq">,
  b: Pick<ListedBackup, "name" | "createdAt" | "epoch" | "seq">,
): number {
  return (
    b.epoch - a.epoch ||
    b.seq - a.seq ||
    b.createdAt - a.createdAt ||
    (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)
  );
}

/** `backups` newest first (compareNewest), as a new array. */
export const newestFirst = <T extends Pick<ListedBackup, "name" | "createdAt" | "epoch" | "seq">>(
  backups: readonly T[],
): T[] => [...backups].sort(compareNewest);

/** What is at `path`, without following a link. */
const look = (path: string): Stats | undefined =>
  fsCall(() => lstatSync(path, { throwIfNoEntry: false }));

/** Lists the backups in `backupDir`. A missing folder holds none. */
export function listBackups(
  backupDir: string,
  policy: BundlePolicy = BUNDLE_POLICY,
): BackupListing {
  // The base names that appear with a backup's exact suffixes, and the temporary files.
  const bases = new Set<string>();
  const leftovers: string[] = [];
  for (const entry of readFolder(backupDir)) {
    const { name } = entry;
    if (isBackupTemporary(name)) {
      if (entry.isFile()) leftovers.push(name);
      continue;
    }
    const base = name.endsWith(DATA_SUFFIX)
      ? name.slice(0, -DATA_SUFFIX.length)
      : name.endsWith(SIDECAR_SUFFIX)
        ? name.slice(0, -SIDECAR_SUFFIX.length)
        : undefined;
    if (base !== undefined && parseBackupName(base) !== undefined) bases.add(base);
  }
  const backups: ListedBackup[] = [];
  for (const base of bases) {
    const parts = parseBackupName(base);
    if (parts === undefined) continue;
    const file = join(backupDir, `${base}${DATA_SUFFIX}`);
    const sidecarFile = join(backupDir, `${base}${SIDECAR_SUFFIX}`);
    const data = look(file);
    const listed = {
      name: base,
      createdAt: parts.createdAt,
      epoch: parts.epoch,
      seq: parts.seq,
      file,
      sidecarFile,
    };
    if (look(sidecarFile) === undefined) {
      // No sidecar under any name the file system matches.
      if (data?.isFile() === true) {
        backups.push({ ...listed, state: "missing_sidecar", sidecar: undefined });
      }
      continue;
    }
    const read = readSidecar(sidecarFile, policy.maxOtherFileBytes);
    const sidecar =
      read.state === "ok" && sidecarMatchesName(read.sidecar, parts) ? read.sidecar : undefined;
    let state: ListedState;
    if (sidecar === undefined) state = "invalid_sidecar";
    else if (data?.isFile() !== true) state = "missing_data";
    else state = data.size === sidecar.compressed_size ? "ok" : "size_mismatch";
    backups.push({ ...listed, state, sidecar });
  }
  return {
    folder: backupDir,
    backups: newestFirst(backups),
    leftovers: leftovers.sort(),
  };
}

/** How long a leftover stays untouched before it is removed: younger, it may be in progress. */
export const LEFTOVER_MIN_AGE_MS = 3_600_000;

/**
 * Removes the leftovers a listing found that have not changed for `minAgeMs` (default an hour)
 * before `now`. Run it at the service's start (A1 3.7) and before a daily backup. Each is looked
 * at again first: only a backup's own temporary file goes, as a regular file, never a folder or a
 * link's target. Returns the names it removed.
 */
export function removeBackupLeftovers(
  listing: BackupListing,
  options: { now?: number; minAgeMs?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const minAge = options.minAgeMs ?? LEFTOVER_MIN_AGE_MS;
  const removed: string[] = [];
  for (const name of listing.leftovers) {
    const path = join(listing.folder, name);
    try {
      const stats = look(path);
      if (!isBackupTemporary(name) || stats?.isFile() !== true) continue;
      if (now - stats.mtimeMs < minAge) continue;
      // Not recursive: a leftover is one file.
      rmSync(path, { force: true });
      removed.push(name);
    } catch {
      // A leftover that cannot be removed now is found again by the next listing.
    }
  }
  return removed;
}

/**
 * Verifies a listed backup by a trial restore (restore/restore.ts verifyBackupFile): the restore's
 * own steps, its first write included, on a scratch copy beside the backup, which is removed again.
 * The files are read again from disk, both held open while they are read. Returns the sidecar it
 * verified, or undefined when any step fails. It needs the database's size in free disk space.
 */
export async function verifyBackup(
  checked: CheckedDriver,
  backup: ListedBackup,
  options: VerifyOptions = {},
): Promise<BackupSidecar | undefined> {
  if (backup.state !== "ok" || backup.sidecar === undefined) return undefined;
  return verifyBackupFile(checked, backup.file, options);
}
