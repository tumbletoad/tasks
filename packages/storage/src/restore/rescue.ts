// The two ways out of a space whose database fails its check (A1 3.2), beside the restore of a
// chosen backup:
//
// - newestVerifiedBackup: the newest complete backup of the space that passes every check a
//   restore makes (backup/verify.ts), which `tasks space restore latest --to <folder>` then
//   restores into a new folder as a read-only copy. A newer one that does not verify is skipped,
//   never removed.
// - rescueSpace ("Rescue readable data"): every row that can still be read, through a read-only
//   connection, into `exchange/rescued/rescued-<utc>.jsonl` in the space folder, for review
//   (bundle/jsonl.ts's format). A table that fails partway keeps the rows read before the failure
//   and is named in the report. Nothing in the space is changed: the file is new, created
//   exclusively, and `exchange/` is the folder meant for files people look at (A1 3.1).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StorageError } from "../errors.ts";
import { fsCall } from "../files.ts";
import type { Id } from "../ids.ts";
import { DATABASE_FILE } from "../manifest.ts";
import { openReader } from "../open.ts";
import { inRange } from "../rows.ts";
import { checkSpacePath } from "../space-path.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { makeDurableFolder } from "../backup/backup.ts";
import { listBackups, verifyBackup, type ListedBackup } from "../backup/list.ts";
import { utcStamp } from "../backup/sidecar.ts";
import type { VerifyOptions } from "../backup/verify.ts";
import { writeJsonl, type JsonlReport } from "../bundle/jsonl.ts";

/**
 * The newest complete backup of `spaceId` in `backupDir` that verifies in full, or undefined when
 * none does. Each is verified as a restore would (it unpacks into a temporary file beside it).
 */
export async function newestVerifiedBackup(
  checked: CheckedDriver,
  backupDir: string,
  spaceId: Id<"sp">,
  options: VerifyOptions = {},
): Promise<ListedBackup | undefined> {
  const listing = listBackups(backupDir, options.policy);
  for (const backup of listing.backups) {
    if (backup.state !== "ok" || backup.sidecar?.space_id !== spaceId) continue;
    if ((await verifyBackup(checked, backup, options))?.space_id === spaceId) return backup;
  }
  return undefined;
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
