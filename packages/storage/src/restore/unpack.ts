// Unpacking a backup into a new folder (A1 3.18 "Restore", steps 1 and 2): the backup is unpacked
// as `space.db` and verified in full with the checks that define a verified backup
// (backup/verify.ts: the files, the sidecar, the BundlePolicy while the `.db.gz` streams, both
// digests, integrity_check, the sidecar's facts, the revision and the format). Nothing is used
// before every check passed. Then space.json is written from the database (backups do not hold
// it, A1 3.1).
import { join } from "node:path";
import { DATABASE_FILE, manifestFor, writeManifest } from "../manifest.ts";
import type { SpaceRow } from "../rows.ts";
import type { Revision, SchemaStep } from "../schema.ts";
import type { CheckedDriver } from "../startup-check.ts";
import type { BundlePolicy } from "../backup/policy.ts";
import type { BackupSidecar } from "../backup/sidecar.ts";
import { unpackVerified } from "../backup/verify.ts";

export interface UnpackSeams {
  policy?: BundlePolicy;
  steps?: readonly SchemaStep[];
  /** Free bytes for the folder. Default: the file system's. */
  freeBytes?: (folder: string) => number;
}

export interface Unpacked {
  space: SpaceRow;
  revision: Revision;
  step: SchemaStep;
  sidecar: BackupSidecar;
}

/**
 * Unpacks the backup `backupFile` into the empty folder `staging` as `space.db` with its
 * `space.json`, and verifies it. On failure the caller removes `staging`.
 */
export async function unpackBackup(
  checked: CheckedDriver,
  backupFile: string,
  staging: string,
  options: { appVersion: string; busyTimeoutMs?: number },
  seams: UnpackSeams = {},
): Promise<Unpacked> {
  const verified = await unpackVerified(checked, backupFile, join(staging, DATABASE_FILE), {
    ...seams,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  // checkSnapshot removed the -wal and -shm its read-only open left, so the folder holds the
  // database and, next, space.json.
  writeManifest(staging, manifestFor(verified.space, verified.step, options.appVersion));
  return verified;
}
