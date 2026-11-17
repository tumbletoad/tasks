// A change made only behind a backup that is proven to restore (A1 3.17, 3.18): an upgrade of a
// space's data format (migrate/runner.ts). The backup is taken, then trial restored (restore.ts
// trialRestore), before the change's transaction starts. A backup that does not restore stops the
// change: BACKUP_FAILED, or BUNDLE_LIMIT_EXCEEDED for a full disk, and nothing is written to the
// space. A backup that was published stays, as every backup does.
import { trialRestore } from "../restore/restore.ts";
import { StorageError } from "../errors.ts";
import type { CheckedDriver } from "../startup-check.ts";
import {
  backupSpaceWith,
  type BackupRecord,
  type BackupSeams,
  type SpaceBackupOptions,
} from "./backup.ts";

/**
 * Takes a backup of the space at `folder` and trial restores it. Throws as backupSpace does, and
 * when the trial restore fails: BUNDLE_LIMIT_EXCEEDED when the disk has no room for it, else
 * BACKUP_FAILED with the cause's code. The trial restore needs the database's size in free disk
 * space beside the backup, on top of the backup itself, and takes about as long as the backup.
 */
export async function provenBackup(
  checked: CheckedDriver,
  folder: string,
  options: SpaceBackupOptions,
  seams: BackupSeams = {},
): Promise<BackupRecord> {
  const backup = await backupSpaceWith(checked, folder, options, seams);
  try {
    await trialRestore(checked, backup.file, {
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
      ...(seams.steps === undefined ? {} : { steps: seams.steps }),
      ...(seams.policy === undefined ? {} : { policy: seams.policy }),
      ...(seams.freeBytes === undefined ? {} : { freeBytes: seams.freeBytes }),
    });
  } catch (error) {
    if (error instanceof StorageError && error.code === "BUNDLE_LIMIT_EXCEEDED") throw error;
    const cause = error instanceof StorageError ? error.code : "an unexpected error";
    throw new StorageError("BACKUP_FAILED", `The backup does not restore (${cause})`);
  }
  return backup;
}
