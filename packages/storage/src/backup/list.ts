// Listing a space's backups (A1 3.18, `tasks space backups list` in M1.10). The listing reads each
// sidecar and checks that its `.db.gz` is there with the size the sidecar records. It does not
// decompress anything: a restore verifies the backup in full before it uses it, and so does
// retention for the backup it keeps as the newest verified one (verifyBackup, with the restore's
// own checks, verify.ts).
//
// Files the listing does not recognise are never touched. A crash leaves two kinds of LEFTOVERS,
// which the listing names and removeBackupLeftovers deletes: a backup's own temporary files, by
// their exact names (isBackupTemporary), and a `.db.gz` whose sidecar was never written. Both are
// regular files: a folder or a link is never a leftover. A leftover is removed only once it has
// not changed for an hour: a younger one may belong to a backup in progress, in this process or
// in another (a backups folder that two spaces share), whose files look exactly the same. A
// running backup refreshes its files' times well within that hour (backup.ts). The age is no lock:
// A1 3.18 names the window that remains, and M1.08 cleans only folders it alone writes.
//
// A backup's two files are looked up by their paths, as a restore looks them up, not matched by the
// names the folder lists: on a file system that ignores case, `X.JSON` is the sidecar of `X.db.gz`
// for a restore, so it must be for the listing too, or cleanup would delete restorable data.
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
import { verifyBackupFile, type VerifyOptions } from "./verify.ts";

export type ListedState =
  /** The sidecar is valid and its `.db.gz` is there with the recorded size. */
  | "ok"
  /** The sidecar is valid, but its `.db.gz` is missing or is not a regular file. */
  | "missing_data"
  /** The `.db.gz` differs in size from what the sidecar records. */
  | "size_mismatch"
  /** The sidecar is not a regular file, too large, unreadable as a sidecar, or names another backup. */
  | "invalid_sidecar";

export interface ListedBackup {
  name: string;
  /** The `.db.gz` file (it may be missing: see `state`). */
  file: string;
  sidecarFile: string;
  state: ListedState;
  /** Undefined when the sidecar is invalid. */
  sidecar: BackupSidecar | undefined;
}

export interface BackupListing {
  folder: string;
  /** Newest first, by the time each backup began. */
  backups: ListedBackup[];
  /** Names of files a crash left: a backup's temporary files and `.db.gz` files without a sidecar. */
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
    if (look(sidecarFile) === undefined) {
      // No sidecar under any name the file system matches: the data is a crash's leftover.
      if (data?.isFile() === true) leftovers.push(`${base}${DATA_SUFFIX}`);
      continue;
    }
    const read = readSidecar(sidecarFile, policy.maxOtherFileBytes);
    const sidecar =
      read.state === "ok" && sidecarMatchesName(read.sidecar, parts) ? read.sidecar : undefined;
    let state: ListedState;
    if (sidecar === undefined) state = "invalid_sidecar";
    else if (data?.isFile() !== true) state = "missing_data";
    else state = data.size === sidecar.compressed_size ? "ok" : "size_mismatch";
    backups.push({ name: base, file, sidecarFile, state, sidecar });
  }
  backups.sort((a, b) => {
    const at = (x: ListedBackup): number => parseBackupName(x.name)?.createdAt ?? 0;
    return at(b) - at(a) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
  });
  return { folder: backupDir, backups, leftovers: leftovers.sort() };
}

/** How long a leftover stays untouched before it is removed: younger, it may be in progress. */
export const LEFTOVER_MIN_AGE_MS = 3_600_000;

/**
 * Removes the leftovers a listing found that have not changed for `minAgeMs` (default an hour)
 * before `now`. Run it at the service's start (A1 3.7) and before a daily backup. Each is looked
 * at again first: only a regular file goes, never a folder or a link's target, and a `.db.gz`
 * stays when its sidecar has appeared since the listing. Returns the names it removed.
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
      if (stats?.isFile() !== true || now - stats.mtimeMs < minAge) continue;
      if (name.endsWith(DATA_SUFFIX) && !isBackupTemporary(name)) {
        const sidecar = `${name.slice(0, -DATA_SUFFIX.length)}${SIDECAR_SUFFIX}`;
        if (look(join(listing.folder, sidecar)) !== undefined) continue;
      }
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
 * Verifies a listed backup in full, exactly as a restore would before using it (verify.ts): the
 * files, the sidecar read again from disk, both digests, integrity_check of the unpacked database
 * and every fact of the sidecar against it, the revision and the format. Returns the sidecar it
 * verified, or undefined when any check fails. It unpacks into a temporary file beside the backup
 * and removes it again, so it needs the database's size in free disk space.
 */
export async function verifyBackup(
  checked: CheckedDriver,
  backup: ListedBackup,
  options: VerifyOptions = {},
): Promise<BackupSidecar | undefined> {
  if (backup.state !== "ok" || backup.sidecar === undefined) return undefined;
  return verifyBackupFile(checked, backup.file, options);
}
