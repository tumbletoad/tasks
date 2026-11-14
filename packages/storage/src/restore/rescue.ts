// The two ways out of a space whose database fails its check (A1 3.2), beside the restore of a
// chosen backup:
//
// - restoreLatest: `tasks space restore latest --to <folder>` restores the newest complete backup
//   of the space that restores into a new folder, as a read-only copy. The candidates are
//   restored directly, newest first: a restore verifies its backup in full (backup/verify.ts), so
//   a newer one that does not verify, or that went away since the listing (retention, the
//   person), is skipped and kept, never removed, and nothing is unpacked twice.
// - rescueSpace ("Rescue readable data"): every row that can still be read, through a read-only
//   connection, into `exchange/rescued/rescued-<utc>.jsonl` in the space folder, for review
//   (bundle/jsonl.ts's format). A table that fails partway keeps the rows read before the failure
//   and is named in the report. Nothing in the space is changed: the file is new, created
//   exclusively, and `exchange/` is the folder meant for files people look at (A1 3.1).
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StorageError } from "../errors.ts";
import { fsCall } from "../files.ts";
import type { Id } from "../ids.ts";
import { DATABASE_FILE } from "../manifest.ts";
import { openReader } from "../open.ts";
import { inRange } from "../rows.ts";
import { checkSpacePath } from "../space-path.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { makeDurableFolder } from "../backup/backup.ts";
import { listBackups } from "../backup/list.ts";
import { utcStamp } from "../backup/sidecar.ts";
import { writeJsonl, type JsonlReport } from "../bundle/jsonl.ts";
import {
  restoreBackupWith,
  type RestoredSpace,
  type RestoreOptions,
  type RestoreSeams,
} from "./restore.ts";

/** Codes that say a candidate backup does not restore: the next one is tried. */
const NOT_THIS_BACKUP: ReadonlySet<string> = new Set([
  "BACKUP_INVALID",
  "BUNDLE_LIMIT_EXCEEDED",
  "SPACE_INVALID",
  "SPACE_NOT_FOUND",
  "SPACE_TOO_NEW",
  "SPACE_VERSION_UNKNOWN",
  "STORAGE_CORRUPT",
]);

/**
 * Restores the newest complete backup of `spaceId` in `backupDir` that restores into the new folder
 * `target` (see the header), and names it. The target is checked first, so a failure of a
 * candidate is the candidate's. BACKUP_INVALID when none restores, or the newest candidate's
 * BUNDLE_LIMIT_EXCEEDED (the disk is too full for any).
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
  let first: StorageError | undefined;
  for (const backup of listBackups(backupDir, seams.policy).backups) {
    if (backup.state !== "ok" || backup.sidecar?.space_id !== spaceId) continue;
    let restored: RestoredSpace;
    try {
      restored = await restoreBackupWith(checked, backup.file, folder, options, seams);
    } catch (error) {
      if (!(error instanceof StorageError) || !NOT_THIS_BACKUP.has(error.code)) throw error;
      first ??= error;
      continue;
    }
    // The sidecar was read again by the restore: one that names another space since the listing
    // leaves its read-only copy for the person, never taken for this space's.
    if (restored.space.spaceId !== spaceId) {
      throw new StorageError("SPACE_ID_MISMATCH", "The backup is of another space");
    }
    return { restored, backup: backup.name };
  }
  if (first?.code === "BUNDLE_LIMIT_EXCEEDED") throw first;
  throw new StorageError("BACKUP_INVALID", "No backup of the space verifies");
}

/** The folder of rescued rows, inside the space folder. */
export const RESCUED_FOLDER = ["exchange", "rescued"] as const;

export interface RescueRecord extends JsonlReport {
  /** The JSON lines file the rows went into. */
  file: string;
}

/**
 * Writes every row of the space at `folder` that can still be read into a new JSON lines file
 * under `exchange/rescued/`. A database that does not open at all is refused with its error.
 */
export function rescueSpace(
  checked: CheckedDriver,
  folder: string,
  options: { now?: () => number; busyTimeoutMs?: number } = {},
): RescueRecord {
  const dir = checkSpacePath(folder);
  const db = join(dir, DATABASE_FILE);
  if (!fsCall(() => existsSync(db))) {
    throw new StorageError("SPACE_NOT_FOUND", "No space found: the database is missing");
  }
  const now = (options.now ?? Date.now)();
  if (!inRange(now, "instant"))
    throw new StorageError("STORAGE_MISUSE", "The clock is out of range");
  const conn = openReader(
    checked,
    db,
    options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs },
  );
  try {
    const out = join(dir, ...RESCUED_FOLDER);
    makeDurableFolder(out);
    const file = join(out, `rescued-${utcStamp(now)}.jsonl`);
    // Created exclusively: a file already there is refused and stays. One cut short by a failure
    // stays too, with the rows it holds: nothing a rescue wrote is removed.
    return { file, ...writeJsonl(conn, file, { tolerant: true }) };
  } finally {
    conn.close();
  }
}
