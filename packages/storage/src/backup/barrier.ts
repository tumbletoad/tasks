// A request decided behind a verified barrier backup (A1 3.14, 3.18; A7 3.15.5): the import of the
// earlier prototype. The backup is taken and verified by a trial restore before the request's
// transaction starts, and the request is decided only on the state the backup holds:
//
//   a retry that its receipt answers → replayed, no backup
//   backup (its own read-only connection) → trial restore → submit(request, snapshot) → result
//
// The barrier is the writer's queue: the storage worker serves one request at a time (worker/
// host.ts), so no write of this process runs between the snapshot and the request, and writer.lock
// keeps every other process out. The writer still checks, inside its transaction, that the space
// stands at the backup's seq and incarnation (SubmitOptions.snapshot), so a write the barrier did
// not hold fails the request undecided instead of applying it on a state no backup holds.
//
// A failed or unverified backup stops the request before its transaction: BACKUP_FAILED, or
// BUNDLE_LIMIT_EXCEEDED for a full disk, and nothing is written to the space. A backup that was
// published stays, as every backup does.
import { verifyBackupFile } from "../restore/restore.ts";
import { StorageError } from "../errors.ts";
import type { CheckedDriver } from "../startup-check.ts";
import type { WriteResult } from "../write/request.ts";
import type { SpaceWriter } from "../write/writer.ts";
import { backupSpaceWith, type BackupRecord, type BackupSeams } from "./backup.ts";

export interface BarrierOptions {
  /** The space's folder: the backup opens it through its own read-only connection. */
  folder: string;
  /** The machine-local `backup.dir`, when set. */
  backupDir?: string;
  appVersion?: string;
  busyTimeoutMs?: number;
}

export interface BarrierResult {
  result: WriteResult;
  /** The verified barrier backup. Absent for a retry its receipt answered. */
  backup?: BackupRecord;
}

/** Decides `request` on `writer` behind a verified `pre-import` backup (the module header). */
export async function submitBehindBackup(
  checked: CheckedDriver,
  writer: SpaceWriter,
  request: unknown,
  options: BarrierOptions,
  seams: BackupSeams = {},
): Promise<BarrierResult> {
  // A retry of a decided request takes no second backup: its receipt answers it.
  if (writer.decided(request)) return { result: writer.submit(request) };
  const backup = await backupSpaceWith(
    checked,
    options.folder,
    {
      kind: "pre-import",
      ...(options.backupDir === undefined ? {} : { backupDir: options.backupDir }),
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    },
    seams,
  );
  // Verified means a trial restore (A1 3.18): the restore's own steps on a scratch copy.
  const verified = await verifyBackupFile(checked, backup.file, {
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  if (verified === undefined) {
    throw new StorageError("BACKUP_FAILED", "The backup before the import does not restore");
  }
  const result = writer.submit(request, {
    snapshot: { seq: backup.sidecar.seq, incarnation: backup.sidecar.incarnation },
  });
  return { result, backup };
}
