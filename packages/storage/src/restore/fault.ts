// Whose fault a failed restore or trial restore is: the backup's, or nobody's that is known. One
// function (backupFault) decides it for the trial restore, `restore latest`, a restore by name and
// the upkeep, because each other answer makes one of them restore older work as if it were the
// newest, or count a sound backup as bad.
//
// A backup is DAMAGED only for a named finding about its own content: its files are not the pair
// its sidecar describes (size, checksum, not a regular file), it does not decompress, SQLite says
// its database is not one or is corrupt (by the result code the driver keeps), its integrity check
// fails, or its space or schema is not what its sidecar says or not one this build restores. A
// backup whose files went away before the restore held them is no longer there to restore, and
// counts the same. EVERYTHING ELSE is "could not be checked": no memory, I/O, busy, a full disk, a
// permission, a size limit or the free-space reserve, a bug. A restore stops and says it, and
// retention removes nothing on its account.
import { existsSync } from "node:fs";
import { StorageError, type StorageErrorCode } from "../errors.ts";

/** The SQLite primary result codes that say a database's own bytes are wrong. */
const SQLITE_CONTENT: ReadonlySet<number> = new Set([
  11, // SQLITE_CORRUPT
  26, // SQLITE_NOTADB
]);

/**
 * The codes TTasks gives its own findings about a backup's content: BACKUP_INVALID (its files or
 * its database differ from its sidecar, or it does not decompress), STORAGE_CORRUPT from the
 * integrity check, and what the checks of a space say of a database that is not one this build
 * restores. None of them comes from the surroundings.
 */
const OWN_FINDINGS: ReadonlySet<StorageErrorCode> = new Set([
  "BACKUP_INVALID",
  "STORAGE_CORRUPT",
  "SPACE_INVALID",
  "SPACE_SCHEMA_FOREIGN",
  "SPACE_VERSION_UNKNOWN",
  "SPACE_TOO_NEW",
]);

export type BackupFault = "damaged" | "unchecked";

/**
 * What `error`, from restoring or trial restoring the backup `file` (or checking its unpacked
 * database), says of the backup (see the header). An error SQLite raised is judged by its result
 * code alone, whatever StorageError code it maps to.
 */
export function backupFault(error: unknown, file?: string): BackupFault {
  if (!(error instanceof StorageError)) return "unchecked";
  if (error.sqliteCode !== undefined) {
    return SQLITE_CONTENT.has(error.sqliteCode & 0xff) ? "damaged" : "unchecked";
  }
  if (OWN_FINDINGS.has(error.code)) return "damaged";
  // The backup went away before the restore held its files (retention, a person).
  if (error.code === "SPACE_NOT_FOUND" && file !== undefined) {
    try {
      return existsSync(file) ? "unchecked" : "damaged";
    } catch {
      return "unchecked";
    }
  }
  return "unchecked";
}
