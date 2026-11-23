// The two ways out of a space whose database fails its check (A1 3.2), beside the restore of a
// chosen backup:
//
// - restoreLatest: `ttasks space restore latest --to <folder>` restores the newest complete backup
//   of the space that restores into a new folder, as a read-only copy. The candidates are
//   restored directly, newest first by the work they hold (backup/list.ts compareNewest), never by
//   the clock alone: a restore checks its backup in full and runs its first write
//   (restore.ts), so a newer one that does not restore, or that went away before the restore held
//   its files (retention, the person), is skipped and kept, never removed, and nothing is unpacked
//   twice.
// - rescueSpace ("Rescue readable data"): every row that can still be read into
//   `exchange/rescued/rescued-<utc>.jsonl` in the space folder, for review (bundle/jsonl.ts's
//   format). RESCUE NEVER OPENS THE DAMAGED ORIGINAL: opening a database, read-only too, can delete
//   a write-ahead log beside it or play a rollback journal back, and either can be the last
//   recovery material. So the database file and its side files (`-wal`, `-shm`, `-journal`) are
//   copied byte for byte, by plain file reads that never go through SQLite, into a private scratch
//   folder `exchange/rescued/.rescue.tmp-<random>`, and only that copy is opened. Every file that
//   was in the space folder is the same afterwards; the one new file is the rescued one, created
//   exclusively, and `exchange/` is the folder meant for files people look at (A1 3.1). The scratch
//   folder is removed by its full name; a crash's is listed by `ttasks space list`. The space may
//   be open meanwhile, so the files are copied again when a writer changed one of them during the
//   copy (fileStates): a database from before a checkpoint beside a log from after it would lose
//   the rows the checkpoint moved, with every table read in full.
//   The rows are read by the product's own tables and columns at the database's revision
//   (backup/snapshot.ts productTables), so the report names only those: a table that fails partway
//   keeps the rows read before the failure and is named by its product name.
import {
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import {
  closeQuietly,
  createFileExact,
  errnoCode,
  FILE_MODE,
  FOLDER_MODE,
  fsCall,
  fsError,
  makeDirExact,
  removeQuietly,
  temporaryTag,
} from "../files.ts";
import { isId, type Id } from "../ids.ts";
import { DATABASE_FILE } from "../manifest.ts";
import { stepPosition } from "../migrate/steps.ts";
import { applyPragmas, BUSY_TIMEOUT_MS, openUnconfigured } from "../open.ts";
import { inRange } from "../rows.ts";
import type { SchemaStep } from "../schema.ts";
import { checkSpacePath } from "../space-path.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { SCHEMA_STEPS } from "../../migrations/index.ts";
import { makeDurableFolder } from "../backup/backup.ts";
import { listBackups } from "../backup/list.ts";
import { BUNDLE_POLICY, checkFreeSpace, existingFolder, freeBytes } from "../backup/policy.ts";
import { utcStamp } from "../backup/sidecar.ts";
import { productTables, type ProductTable } from "../backup/snapshot.ts";
import { writeJsonl, type JsonlReport } from "../bundle/jsonl.ts";
import {
  isBackupsOwnFailure,
  restoreBackupWith,
  type RestoredSpace,
  type RestoreOptions,
  type RestoreSeams,
} from "./restore.ts";

/**
 * Restores the newest complete backup of `spaceId` in `backupDir` that restores into the new folder
 * `target` (see the header), and names it. Only a candidate's own failure (restore.ts
 * isBackupsOwnFailure) moves on to the next older one. Any other stops the restore with its own
 * code, and nothing older is tried: the candidate may be whole, and an older one would bring back
 * older work as if it were the newest (BUNDLE_LIMIT_EXCEEDED for the free space or a size limit,
 * DURABILITY_FAILED for a failing disk). BACKUP_INVALID when none restores.
 */
export async function restoreLatest(
  checked: CheckedDriver,
  backupDir: string,
  spaceId: Id<"sp">,
  target: string,
  options: RestoreOptions = {},
  seams: RestoreSeams = {},
): Promise<{ restored: RestoredSpace; backup: string }> {
  const folder = resolve(target);
  if (fsCall(() => !existsSync(dirname(folder)) || !statSync(dirname(folder)).isDirectory())) {
    throw new StorageError(
      "SPACE_NOT_FOUND",
      "No space found: the folder for spaces does not exist",
    );
  }
  if (fsCall(() => existsSync(folder))) {
    throw new StorageError("SPACE_EXISTS", "A space folder is already there");
  }
  for (const backup of listBackups(backupDir, seams.policy).backups) {
    if (backup.state !== "ok" || backup.sidecar?.space_id !== spaceId) continue;
    let restored: RestoredSpace;
    try {
      // The backup is read again by the restore, and must still be of this space.
      restored = await restoreBackupWith(
        checked,
        backup.file,
        folder,
        { ...options, spaceId },
        seams,
      );
    } catch (error) {
      if (!isBackupsOwnFailure(error, backup.file)) throw error;
      continue;
    }
    return { restored, backup: backup.name };
  }
  throw new StorageError("BACKUP_INVALID", "No backup of the space verifies");
}

/** The folder of rescued rows, inside the space folder. */
export const RESCUED_FOLDER = ["exchange", "rescued"] as const;

/** The prefix of a rescue's private scratch folder in RESCUED_FOLDER, before its random tag. */
export const RESCUE_TEMP_PREFIX = ".rescue.tmp-";

/** The files of a space's database a rescue copies: the database, then its side files. */
const DATABASE_FILES = ["", "-wal", "-shm", "-journal"] as const;

/** How often a rescue copies the files again when a writer changed them during the copy. */
const COPY_ATTEMPTS = 3;

/**
 * The identity, size and modification time of the files whose content a copy must take from one
 * moment. The shared-memory index is left out: readers write it, and SQLite rebuilds it from the
 * log when the copy opens alone.
 */
function fileStates(db: string): string {
  return ["", "-wal", "-journal"]
    .map((suffix) => {
      const s = fsCall(() => lstatSync(`${db}${suffix}`, { bigint: true, throwIfNoEntry: false }));
      return s === undefined ? "-" : `${String(s.ino)}:${String(s.size)}:${String(s.mtimeNs)}`;
    })
    .join(" ");
}

export interface RescueRecord extends JsonlReport {
  /** The JSON lines file the rows went into. */
  file: string;
  /**
   * `confirmed`: the database's space row names the space the rescue was for. `unconfirmed`: damage
   * keeps it from saying which space it holds, so the rows may be another space's.
   */
  identity: "confirmed" | "unconfirmed";
}

export interface RescueOptions {
  /** The space the folder is registered as. A database that names another one is refused. */
  spaceId?: Id<"sp">;
  now?: () => number;
  busyTimeoutMs?: number;
  /** The registered schema steps. Default: SCHEMA_STEPS. Tests pass stand-in steps. */
  steps?: readonly SchemaStep[];
  /** Free bytes for a folder. Default: the file system's. */
  freeBytes?: (folder: string) => number;
  /** Tests: runs after each of the database's files (`""`, `-wal`, ...) was copied. */
  copied?: (suffix: string) => void;
}

/** The first bytes of a rollback journal's header (SQLite's file format, "The Rollback Journal"). */
const JOURNAL_MAGIC = Buffer.from("d9d505f920a163d7", "hex");

/**
 * The size SQLite gives a database when it plays back the rollback journal at `journal`: the page
 * count before the transaction times the page size, both from the journal's header. 0 when there
 * is no journal, or no header SQLite would play back. Read by plain file reads, never by SQLite.
 */
function journalledSize(journal: string): number {
  let fd: number;
  try {
    fd = openSync(journal, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw fsError(error);
  }
  try {
    const header = Buffer.alloc(28);
    const read = fsCall(() => readSync(fd, header, 0, header.length, 0));
    if (read < header.length || !header.subarray(0, 8).equals(JOURNAL_MAGIC)) return 0;
    return header.readUInt32BE(16) * header.readUInt32BE(24);
  } finally {
    closeQuietly(fd);
  }
}

/**
 * What a rescue's private copy may take on disk (A1 3.18 "Bundle limits"): the database files as
 * they are; the log once more, which SQLite may play back into the copy of the database; and the
 * growth of the database to the size its rollback journal records, which a playback restores.
 * SQLite's shared-memory file and its own few pages of log are the reserve's to cover.
 */
function copyBytes(db: string): number {
  const sizes = DATABASE_FILES.map((suffix) => {
    const stats = fsCall(() => lstatSync(`${db}${suffix}`, { throwIfNoEntry: false }));
    return stats?.isFile() === true ? stats.size : 0;
  });
  const [main = 0, wal = 0, shm = 0, journal = 0] = sizes;
  const growth = Math.max(0, journalledSize(`${db}-journal`) - main);
  return main + 2 * wal + shm + journal + growth;
}

const notRegular = (): StorageError =>
  new StorageError("SPACE_INVALID", "A file of the database is not a regular file");

/** POSIX's refusal to open a link; on Windows the identity check covers it. */
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

/**
 * Copies the regular file at `from` into the new file `to` (owner-only, exclusive) by plain reads
 * of the descriptor it opened, never through a link and never through SQLite. Returns false when
 * nothing is at `from`.
 */
function copyPlain(from: string, to: string): boolean {
  const before = fsCall(() => lstatSync(from, { bigint: true, throwIfNoEntry: false }));
  if (before === undefined) return false;
  if (!before.isFile()) throw notRegular();
  let input: number;
  try {
    input = openSync(from, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw fsError(error);
  }
  try {
    const opened = fsCall(() => fstatSync(input, { bigint: true }));
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw notRegular();
    }
    const out = fsCall(() => createFileExact(to, FILE_MODE));
    try {
      const buffer = new Uint8Array(4 * 1024 * 1024);
      let position = 0;
      for (;;) {
        const read = fsCall(() => readSync(input, buffer, 0, buffer.length, position));
        if (read <= 0) break;
        let written = 0;
        while (written < read) {
          const chunk = buffer.subarray(written, read);
          written += fsCall(() => writeSync(out, chunk, 0, chunk.length));
        }
        position += read;
      }
    } finally {
      closeQuietly(out);
    }
  } finally {
    closeQuietly(input);
  }
  return true;
}

/**
 * Opens the private copy `db` for reading only: its own connection, which may play the copy's
 * journal back or rebuild its WAL index (the copy is this rescue's), with the schema's functions
 * untrusted and every write refused.
 */
function openCopy(checked: CheckedDriver, db: string, busyTimeoutMs: number): Connection {
  const conn = openUnconfigured(checked, db, "writer", { busyTimeoutMs });
  try {
    applyPragmas(conn, [
      { name: "busy_timeout", value: busyTimeoutMs, expect: busyTimeoutMs },
      { name: "trusted_schema", value: "OFF", expect: 0 },
      { name: "query_only", value: 1, expect: 1 },
    ]);
  } catch (error) {
    closeQuietlyConn(conn);
    throw error;
  }
  return conn;
}

function closeQuietlyConn(conn: Connection): void {
  try {
    conn.close();
  } catch {
    // The first error is the one the caller sees.
  }
}

/** The product's tables at the revision the copy records, the names a rescue may give. */
function rescueTables(
  checked: CheckedDriver,
  conn: Connection,
  steps: readonly SchemaStep[],
): readonly ProductTable[] {
  const userVersion = conn.pragma("user_version");
  const position = inRange(userVersion, "count")
    ? stepPosition(steps, userVersion)
    : { state: "unknown" as const };
  if (position.state === "newer") {
    throw new StorageError("SPACE_TOO_NEW", "The database is newer than this build reads");
  }
  if (position.state !== "known" || typeof userVersion !== "number") {
    throw new StorageError("SPACE_VERSION_UNKNOWN", "The database's schema revision is unknown");
  }
  const tables = productTables(checked, steps, userVersion);
  if (tables === undefined) {
    throw new StorageError("SPACE_VERSION_UNKNOWN", "The database's schema revision is unknown");
  }
  return tables;
}

/**
 * Whether the database on `conn` names `expected` as its space: "confirmed" when its space row
 * reads and names it, SPACE_ID_MISMATCH when it reads and names another space, "unconfirmed" when
 * damage keeps it from saying (or no space was expected).
 */
function identityOf(conn: Connection, expected: Id<"sp"> | undefined): RescueRecord["identity"] {
  let named: unknown;
  try {
    named = conn.prepare("SELECT space_id FROM space WHERE one = 1").get()?.["space_id"];
  } catch {
    return "unconfirmed";
  }
  if (expected === undefined || !isId(named, "sp")) return "unconfirmed";
  if (named !== expected) {
    throw new StorageError("SPACE_ID_MISMATCH", "The folder holds another space's database");
  }
  return "confirmed";
}

/**
 * Writes every row of the space at `folder` that can still be read into a new JSON lines file
 * under `exchange/rescued/`, from a private copy of its database files (see the header). A copy that
 * does not open at all is refused with its error, and the space folder stays as it was. A copy
 * whose space row names another space than `options.spaceId` is refused (SPACE_ID_MISMATCH) before
 * any row is written.
 */
export function rescueSpace(
  checked: CheckedDriver,
  folder: string,
  options: RescueOptions = {},
): RescueRecord {
  const dir = checkSpacePath(folder);
  const db = join(dir, DATABASE_FILE);
  if (fsCall(() => lstatSync(db, { throwIfNoEntry: false })) === undefined) {
    throw new StorageError("SPACE_NOT_FOUND", "No space found: the database is missing");
  }
  const now = (options.now ?? Date.now)();
  if (!inRange(now, "instant"))
    throw new StorageError("STORAGE_MISUSE", "The clock is out of range");
  const out = join(dir, ...RESCUED_FOLDER);
  // A writer keeps the free-space reserve: the copy must fit before anything is written, and the
  // rows file may then hold what is left, counted as it is written (bundle/jsonl.ts).
  const copying = copyBytes(db);
  const free = (options.freeBytes ?? freeBytes)(existingFolder(out));
  checkFreeSpace(copying, free, BUNDLE_POLICY);
  makeDurableFolder(out);
  const scratch = join(out, `${RESCUE_TEMP_PREFIX}${temporaryTag()}`);
  fsCall(() => {
    makeDirExact(scratch, FOLDER_MODE);
  });
  try {
    const copy = join(scratch, DATABASE_FILE);
    for (let attempt = 1; ; attempt += 1) {
      const before = fileStates(db);
      for (const suffix of DATABASE_FILES) {
        const copied = copyPlain(`${db}${suffix}`, `${copy}${suffix}`);
        if (suffix === "" && !copied) {
          throw new StorageError("SPACE_NOT_FOUND", "No space found: the database is missing");
        }
        options.copied?.(suffix);
      }
      if (fileStates(db) === before) break;
      // A writer committed or checkpointed while the files were copied one after another: the
      // copy may hold the database from before and the log from after, and lose what moved.
      for (const suffix of DATABASE_FILES) removeQuietly(`${copy}${suffix}`);
      if (attempt === COPY_ATTEMPTS) {
        throw new StorageError("SPACE_CHANGED", "The space kept changing while it was copied");
      }
    }
    // An empty database file is never a space's (A1 3.1), and SQLite would delete the copied -wal.
    if (fsCall(() => statSync(copy).size) === 0) {
      throw new StorageError("SPACE_INVALID", "The database file is empty");
    }
    const conn = openCopy(checked, copy, options.busyTimeoutMs ?? BUSY_TIMEOUT_MS);
    try {
      const identity = identityOf(conn, options.spaceId);
      const tables = rescueTables(checked, conn, options.steps ?? SCHEMA_STEPS);
      const file = join(out, `rescued-${utcStamp(now)}.jsonl`);
      // Created exclusively: a file already there is refused and stays. One cut short by a failure
      // stays too, with the rows it holds: nothing a rescue wrote is removed.
      const maxBytes = free - BUNDLE_POLICY.freeSpaceReserveBytes - copying;
      return { file, identity, ...writeJsonl(conn, file, tables, { tolerant: true, maxBytes }) };
    } finally {
      closeQuietlyConn(conn);
    }
  } finally {
    // This rescue's own scratch folder, by its full name.
    removeQuietly(scratch);
  }
}
