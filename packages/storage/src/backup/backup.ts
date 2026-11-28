// Taking a backup of a space (A1 3.18, the minimal backup set of MIL-02).
//
// 0. Before anything is written, the free disk space, less the shared policy's reserve, must hold
//    the backup's peak (backupPeak): BUNDLE_LIMIT_EXCEEDED otherwise.
// 1. A separate READ-ONLY connection copies the database with the driver's backup API in ONE step
//    (pagesPerStep = SINGLE_STEP), so the copy is one consistent snapshot taken inside one read
//    transaction, and WAL lets the writer go on meanwhile. node:sqlite restarts a multi-step backup
//    whenever another connection writes, so a single step is required (A1 3.18).
// 2. The copy opens read-only and passes PRAGMA integrity_check. The sidecar's facts (space, epoch,
//    incarnation, last_seq, user_version, rows per table) are read from the copy itself, so they
//    describe exactly the snapshot, whatever the writer did meanwhile.
// 3. Compression with Node's zlib into a temporary file, flushed to disk, then read back through
//    the bounded decompression and compared, so a write that went wrong is caught now. That makes
//    no backup verified: only a trial restore does (restore/restore.ts verifyBackupFile).
// 4. The `.db.gz` is PUBLISHED under its name and the folder synced, then the sidecar is written to
//    a temporary file, flushed, and published the same way. The sidecar is the commit point.
//
// PUBLISHING NEVER REPLACES (A1 3.18): a name is taken by a hard link from the temporary file, or
// where the file system makes none by a new file created exclusively and filled with a copy
// (files.ts publishExclusive), never by a rename, which replaces whatever is at its target. Two
// backups that want one name (the same kind, time, epoch and seq, for example two spaces whose
// backup.dir is one folder), or a pair another program put there, cannot both have it: the later
// one fails with BACKUP_FAILED and replaces nothing.
//
// Crash windows (each leaves the space untouched, because a backup only reads it):
// - Before the data's publication: temporary files `.backup.tmp-*` only. A listing reports them as
//   leftovers, and removeBackupLeftovers deletes them when no backup runs (A1 3.7: at start).
// - After it, before the sidecar's: a `.db.gz` without its sidecar. It is never a complete
//   backup: the listing names it `missing_sidecar` and keeps it, because a pair a person moved
//   apart looks the same.
// - After the sidecar's: a complete backup. Its folder fsync makes it durable.
// A failure (not a crash) before the sidecar is published removes the `.db.gz` while it is still
// this backup's own file. Once the sidecar is published the pair is a backup like any other: a
// failure of the last check (the data is no longer the file this backup published) fails the
// backup and removes nothing, so the reader's checks (list.ts, verify.ts) judge the pair. A running
// backup keeps its files younger than cleanup's age rule (list.ts).
//
// One writer per space (A1 3.9): the backup reads the live space through a read-only
// connection only, and writes only new files of its own, by names no space has: the copy, which
// the driver's backup creates exclusively (it refuses an existing destination), and the files
// derived from it. The migration runner calls this from the space's writer, under its claim.
//
// Named seams (`BackupSeams.at`) mark each point for M1.07's crash harness.
import { existsSync, lstatSync, statSync, utimesSync, type BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Connection } from "../driver.ts";
import { misuse, StorageError } from "../errors.ts";
import {
  errnoCode,
  FOLDER_MODE,
  fsCall,
  fsError,
  fsyncFolder,
  makeDirExact,
  publishExclusive,
  removeQuietly,
  temporaryTag,
  writeFileExclusive,
  NODE_IO,
  type FileIo,
} from "../files.ts";
import { isAppVersion } from "../manifest.ts";
import { inRange } from "../rows.ts";
import type { SchemaStep } from "../schema.ts";
import { remakeCopyIndex } from "../search/remake.ts";
import { openSpaceWith, SOURCE_APP_VERSION } from "../space.ts";
import { SCHEMA_STEPS } from "../../migrations/index.ts";
import { checkSpacePath } from "../space-path.ts";
import type { CheckedDriver } from "../startup-check.ts";
import {
  BUNDLE_POLICY,
  checkFreeSpace,
  compressFile,
  freeBytes,
  inflateFile,
  type BundlePolicy,
} from "./policy.ts";
import {
  BACKUP_KINDS,
  BACKUP_TEMP_PREFIX,
  backupName,
  DATA_SUFFIX,
  SIDECAR_MARKER,
  SIDECAR_SUFFIX,
  SIDECAR_VERSION,
  sidecarText,
  type BackupKind,
  type BackupSidecar,
} from "./sidecar.ts";
import { checkSnapshot, copySnapshot, databaseBytes, type SnapshotFacts } from "./snapshot.ts";

export { BACKUP_TEMP_PREFIX };

export interface SpaceBackupOptions {
  kind: BackupKind;
  /** The backups folder, which must be there (hub/space-settings.ts backupsFolderOf). */
  backupDir: string;
  appVersion?: string;
  /** Milliseconds since 1970. Default: Date.now. */
  now?: () => number;
  busyTimeoutMs?: number;
}

/** A complete backup: its two files and what its sidecar says. */
export interface BackupRecord {
  /** The base name, such as `daily-20261113T031500.123Z-e1-s42`. */
  name: string;
  /** The `.db.gz` file. */
  file: string;
  sidecarFile: string;
  sidecar: BackupSidecar;
  /**
   * The space's search index failed the copy's check and was made again in the copy: the space's
   * own index is damaged and needs the same.
   */
  searchIndexRemade?: true;
}

/** The points M1.07's crash harness kills at, in order. Tests also throw there. */
export type BackupPoint =
  /** The snapshot is in its temporary file. */
  | "copied"
  /** The snapshot passed integrity_check and its facts were read. */
  | "checked"
  /** The `.db.gz` temporary file is written, flushed and read back. */
  | "compressed"
  /** The `.db.gz` is published under its name. No sidecar yet. */
  | "data-published"
  /** The sidecar is published under its name: the backup exists. */
  | "sidecar-published";

/** What tests inject. Not part of the package's interface. */
export interface BackupSeams {
  at?: (point: BackupPoint) => void;
  /** The registered schema steps, for opening the space. Default: SCHEMA_STEPS. */
  steps?: readonly SchemaStep[];
  policy?: BundlePolicy;
  io?: FileIo;
  /** Free bytes for a folder. Default: the file system's. */
  freeBytes?: (folder: string) => number;
}

/**
 * The space's backups folder is not there: a drive that is not connected, a folder moved. No backup
 * makes it, so none lands on whatever disk holds the path, where nobody looks and from where the
 * next backups would go on without a word.
 */
export class BackupsFolderAway extends StorageError {
  constructor() {
    super("BACKUP_FAILED", "The space's backups folder is not there");
  }
}

/**
 * Takes a verified backup of the space at `folder` through its own read-only connection. Opening
 * the space refuses as a reader's open does. Any later failure is BACKUP_FAILED (the cause's code
 * in the message), or BUNDLE_LIMIT_EXCEEDED for a database larger than the policy allows.
 */
export async function backupSpace(
  checked: CheckedDriver,
  folder: string,
  options: SpaceBackupOptions,
): Promise<BackupRecord> {
  return backupSpaceWith(checked, folder, options, {});
}

/** backupSpace with test seams. */
export async function backupSpaceWith(
  checked: CheckedDriver,
  folder: string,
  options: SpaceBackupOptions,
  seams: BackupSeams,
): Promise<BackupRecord> {
  const dir = checkSpacePath(folder);
  const opened = openSpaceWith(
    checked,
    dir,
    {
      role: "reader",
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    },
    seams.steps === undefined ? {} : { steps: seams.steps },
  );
  try {
    return await writeBackup(checked, opened.conn, options, seams);
  } finally {
    opened.conn.close();
  }
}

/** A failure on the way, as the backup's error. A limit refusal keeps its own code. */
function backupFailed(error: unknown): StorageError {
  if (error instanceof StorageError && error.code === "BUNDLE_LIMIT_EXCEEDED") return error;
  if (error instanceof StorageError && error.code === "BACKUP_FAILED") return error;
  const cause = error instanceof StorageError ? error.code : "an unexpected error";
  return new StorageError("BACKUP_FAILED", `The backup failed (${cause})`);
}

/**
 * The backup pipeline from an open connection to the space database: copy, check, compress, read
 * back, rename, sidecar. `source` should be a read-only connection that holds no transaction.
 */
async function writeBackup(
  checked: CheckedDriver,
  source: Connection,
  options: SpaceBackupOptions,
  seams: BackupSeams = {},
): Promise<BackupRecord> {
  const { backupDir } = options;
  const policy = seams.policy ?? BUNDLE_POLICY;
  const io = seams.io ?? NODE_IO;
  const appVersion = options.appVersion ?? SOURCE_APP_VERSION;
  if (!isAppVersion(appVersion)) throw misuse("An app version is major.minor.patch");
  if (!BACKUP_KINDS.includes(options.kind)) throw misuse("Unknown backup kind");
  const createdAt = (options.now ?? Date.now)();
  if (!inRange(createdAt, "instant")) throw misuse("The clock gave an instant outside its range");
  const tag = temporaryTag();
  const copy = join(backupDir, `${BACKUP_TEMP_PREFIX}${tag}.db`);
  const packed = join(backupDir, `${BACKUP_TEMP_PREFIX}${tag}${DATA_SUFFIX}`);
  // The data this backup published under its final name, with its identity on disk, until the
  // sidecar is published: removed again if the backup fails before then, while still its own.
  let data: { path: string; id: BigIntStats } | undefined;
  // Every file this backup owns before its sidecar lands looks like a leftover to a cleanup in
  // another process, which removes only what has been untouched for LEFTOVER_MIN_AGE_MS (list.ts).
  // So the backup keeps them fresh: at each step, and on a timer while it streams.
  const own = [copy, packed];
  const refresh = (): void => {
    const now = new Date();
    for (const path of own) {
      try {
        utimesSync(path, now, now);
      } catch {
        // Not there (yet, or any more): nothing to keep fresh.
      }
    }
    // The published data's recorded state follows its new time while it is still the same file.
    if (data !== undefined && sameIdentity(data.path, data.id)) {
      data.id = identity(data.path) ?? data.id;
    }
  };
  const timer = setInterval(refresh, FRESH_INTERVAL_MS);
  timer.unref();
  try {
    // Never made here: it may be on a drive that is away, and a backup there is lost.
    if (!fsCall(() => statSync(backupDir, { throwIfNoEntry: false }))?.isDirectory()) {
      throw new BackupsFolderAway();
    }
    // Before anything is written: the free disk space, less the policy's reserve, holds the
    // backup's peak (backupPeak).
    checkFreeSpace(
      backupPeak(databaseBytes(source)),
      (seams.freeBytes ?? freeBytes)(backupDir),
      policy,
    );
    // The driver writes only a new file (A1 3.18): it creates the copy exclusively and
    // owner-only under this backup's random temporary name, so the copy is owner-only from its
    // first byte and no other file, a live space's least of all, can be written by mistake.
    await copySnapshot(checked, source, copy, policy);
    refresh();
    seams.at?.("copied");

    let facts: SnapshotFacts;
    let searchIndexRemade = false;
    try {
      facts = checkSnapshot(checked, copy, options.busyTimeoutMs);
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "STORAGE_CORRUPT") throw error;
      // The search index is derived from the tasks: damage in it alone must not cost a backup.
      // The copy is this backup's own, so its index is made again and the copy checked once more.
      // Damage anywhere else still fails the check.
      remakeCopyIndex(checked, copy, options.busyTimeoutMs, seams.steps ?? SCHEMA_STEPS);
      facts = checkSnapshot(checked, copy, options.busyTimeoutMs);
      searchIndexRemade = true;
    }
    refresh();
    seams.at?.("checked");

    const name = backupName({
      kind: options.kind,
      createdAt,
      epoch: facts.space.authority.epoch,
      seq: facts.space.lastSeq,
    });
    const file = join(backupDir, `${name}${DATA_SUFFIX}`);
    const sidecarFile = join(backupDir, `${name}${SIDECAR_SUFFIX}`);
    // Checked early, to fail before the work: the publications below are what guarantee it. A
    // sidecar left without its data (a removal cut short) would be taken for this backup's.
    if (fsCall(() => existsSync(file) || existsSync(sidecarFile))) {
      throw taken();
    }

    const digests = await compressFile(copy, packed);
    // Read the stored file back as a restore would, so a write that went wrong is caught now.
    const again = await inflateFile(packed, undefined, {
      maxBytes: policy.maxDatabaseBytes,
      expectedBytes: digests.size,
    });
    if (
      again.size !== digests.size ||
      again.sha256 !== digests.sha256 ||
      again.compressedSha256 !== digests.compressedSha256
    ) {
      throw new StorageError("BACKUP_FAILED", "The compressed backup does not read back");
    }
    // The snapshot is done once its compressed form reads back: it goes before the publication,
    // whose copy (where the file system makes no hard link) is a second compressed file. A removal
    // that fails leaves it: backupPeak counts it anyway.
    for (const path of databaseFiles(copy)) removeQuietly(path, io);
    own.splice(0, own.length, packed);
    refresh();
    seams.at?.("compressed");

    const sidecar: BackupSidecar = {
      [SIDECAR_MARKER]: SIDECAR_VERSION,
      kind: options.kind,
      created_at: createdAt,
      space_id: facts.space.spaceId,
      epoch: facts.space.authority.epoch,
      incarnation: facts.space.authority.incarnation,
      seq: facts.space.lastSeq,
      user_version: facts.userVersion,
      size: digests.size,
      sha256: digests.sha256,
      compressed_size: digests.compressedSize,
      compressed_sha256: digests.compressedSha256,
      counts: facts.counts,
      written_by: appVersion,
    };
    const text = sidecarText(sidecar);
    if (Buffer.byteLength(text, "utf8") > policy.maxOtherFileBytes) {
      throw new StorageError("BUNDLE_LIMIT_EXCEEDED", "The sidecar passes the bundle limit");
    }

    // Fresh, so the data is young when it takes its name.
    refresh();
    data = { path: file, id: publish(() => publishExclusive(packed, file, io).id) };
    // The data holds its name: the temporary file is done, and only the data is kept fresh.
    removeQuietly(packed, io);
    own.splice(0, own.length, file);
    fsyncFolder(backupDir, io);
    seams.at?.("data-published");

    // A cleanup that judged the data a leftover (a backup stopped for over an hour) would leave a
    // sidecar without data, and a migration would commit behind a backup that is not there.
    if (!sameFile(file, data.id, digests.compressedSize)) throw dataGone();
    const published = data.id;
    const pairPublished = (): void => {
      data = undefined;
      own.length = 0;
    };
    try {
      // The pair is published the moment the sidecar takes its name, before the folder's sync:
      // from then on nothing of it is removed, whatever fails.
      writeFileExclusive(backupDir, `${name}${SIDECAR_SUFFIX}`, text, io, pairPublished);
    } catch (error) {
      // Only another file at the name (EEXIST) means this backup's sidecar is not there. After any
      // other failure its sidecar may be, complete or cut short (a copy that could not be removed
      // again), so the data stays with it for the reader's checks; without one it is a leftover
      // that cleanup removes after an hour (list.ts).
      if (errnoCode(error) !== "EEXIST") pairPublished();
      throw errnoCode(error) === "EEXIST" ? taken() : fsError(error);
    }
    seams.at?.("sidecar-published");
    // The backup exists only if its data is still the file it published. If not, the pair stays
    // for the reader's checks, which list it by state and never restore it.
    if (!sameFile(file, published, digests.compressedSize)) throw dataGone();
    return {
      name,
      file,
      sidecarFile,
      sidecar,
      ...(searchIndexRemade ? { searchIndexRemade } : {}),
    };
  } catch (error) {
    // The data goes while it is no backup yet, and only while it is still the file this backup
    // published: another file that took its name since (a sync, another backup) stays as it is.
    if (data !== undefined && isStill(data.path, data.id)) removeQuietly(data.path, io);
    throw backupFailed(error);
  } finally {
    clearInterval(timer);
    for (const path of [...databaseFiles(copy), packed]) removeQuietly(path, io);
  }
}

/**
 * How often a running backup refreshes the times of its files: well inside the hour after which
 * cleanup takes an untouched file for a leftover (list.ts LEFTOVER_MIN_AGE_MS).
 */
export const FRESH_INTERVAL_MS = 5 * 60_000;

/**
 * What a backup needs on disk at its peak, from the database's size D (its pages times their
 * size): every file it makes, counted at once, since a removal can fail (a scanner holding the
 * file on Windows) and the backup goes on: the snapshot (D), its compressed form (at most about D:
 * gzip adds a few bytes per block to data it cannot compress), and, where the file system makes no
 * hard link, the published copy of the compressed form (D). The snapshot is removed once its
 * compressed form reads back, so the disk usually holds less. The read-back writes nothing, and the
 * sidecar is a few hundred bytes.
 */
export const backupPeak = (databaseSize: number): number => 3 * databaseSize;

/** A database file and the files SQLite keeps beside it. */
const databaseFiles = (db: string): string[] => [db, `${db}-wal`, `${db}-shm`, `${db}-journal`];

/** Whether `path` is still the regular file `before` described (same identity where known), of `size`. */
function sameFile(path: string, before: BigIntStats, size: number): boolean {
  let now: BigIntStats | undefined;
  try {
    now = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  } catch {
    return false;
  }
  if (now?.isFile() !== true || now.size !== BigInt(size)) return false;
  // Where the file system gives file numbers, the renamed file keeps its own, and its time (a
  // number alone can be a new file's: Linux reuses a removed file's number at once).
  return (
    before.ino === 0n ||
    (now.ino === before.ino && now.dev === before.dev && now.mtimeNs === before.mtimeNs)
  );
}

/** Whether `path` is a regular file with `before`'s identity on its volume. */
function sameIdentity(path: string, before: BigIntStats): boolean {
  try {
    const now = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return now?.isFile() === true && now.ino === before.ino && now.dev === before.dev;
  } catch {
    return false;
  }
}

/** The identity of the regular file at `path`, or undefined where the file system has none. */
function identity(path: string): BigIntStats | undefined {
  try {
    const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return stats?.isFile() === true && stats.ino !== 0n ? stats : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `path` is still the regular file `before` described: the same identity on its volume,
 * size and modification time. The file number alone is not enough: Linux file systems give a
 * removed file's number to the next new file at once. A rename keeps the modification time.
 */
function isStill(path: string, before: BigIntStats): boolean {
  try {
    const now = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return (
      now?.isFile() === true &&
      now.ino === before.ino &&
      now.dev === before.dev &&
      now.size === before.size &&
      now.mtimeNs === before.mtimeNs
    );
  } catch {
    return false;
  }
}

/**
 * Makes a folder for backups or bundles, and every missing folder above it, owner-only, and syncs each new
 * folder's entry into its parent: on POSIX a new folder is durable only once its parent is synced,
 * and a migration must not commit while its barrier backup's folder could still vanish. The
 * backups folder's own entries are synced after each file lands in it.
 */
export function makeDurableFolder(dir: string, io: FileIo = NODE_IO): void {
  // The folders missing now, from the backups folder up. (mkdirSync's own answer, the first folder
  // it made, comes back as `\\?\C:\...` on Windows, so it is not compared with paths here.)
  const missing: string[] = [];
  for (let current = resolve(dir); !fsCall(() => existsSync(current)); current = dirname(current)) {
    missing.push(current);
    if (dirname(current) === current) break;
  }
  fsCall(() => {
    makeDirExact(dir, FOLDER_MODE, { recursive: true });
  });
  // Each new folder's entry is in its parent, deepest first.
  for (const folder of missing) fsyncFolder(dirname(folder), io);
}

const taken = (): StorageError =>
  new StorageError("BACKUP_FAILED", "A backup with this name already exists");

const dataGone = (): StorageError =>
  new StorageError("BACKUP_FAILED", "The backup's data went away before it was complete");

/**
 * Runs one publication (files.ts publishExclusive). Anything already at the name, another backup's
 * or a file another program put there, is BACKUP_FAILED and stays untouched.
 */
function publish<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (errnoCode(error) === "EEXIST") throw taken();
    throw fsError(error);
  }
}
