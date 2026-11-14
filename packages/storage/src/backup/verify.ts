// What "a verified backup" means, in one place: everything a restore checks before it uses a
// backup (A1 3.18 "Restore", steps 1 and 2). A restore unpacks with it (restore/unpack.ts), and
// retention verifies the backup it keeps as the newest verified one with it (retention.ts), so a
// backup that retention calls verified is one that restores.
//
// 1. The backup is the `.db.gz` named like a backup, beside its sidecar. Both must be regular
//    files: a link, a folder or a device is refused, never followed.
// 2. The sidecar is read (at most the policy's limit for any other file) and must agree with the
//    name. The `.db.gz` must have the size the sidecar records.
// 3. The size the sidecar promises must fit the policy and the free disk space, less the reserve.
// 4. Decompression streams into a new file and stops as soon as the output passes the policy's
//    limit (BUNDLE_LIMIT_EXCEEDED) or the sidecar's size (BACKUP_INVALID). The sizes and SHA-256
//    of both sides must equal the sidecar's.
// 5. The database opens read-only: integrity_check, the application_id, the user_version, the
//    space row, and the space ID, epoch, incarnation, last_seq and rows per table, against the
//    sidecar. A revision newer than this build, or one it never had, is refused, and the row's
//    format must be its revision's.
// 6. Its tables, indexes and views are exactly those of its revision (snapshot.ts hasOwnSchema):
//    a restore writes to it next, and nothing a foreign definition does may run on that write.
import { lstatSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SCHEMA_STEPS } from "../../migrations/index.ts";
import { StorageError } from "../errors.ts";
import { fsCall, removeQuietly, temporaryTag } from "../files.ts";
import { stepPosition } from "../migrate/steps.ts";
import type { SpaceRow } from "../rows.ts";
import type { Revision, SchemaStep } from "../schema.ts";
import type { CheckedDriver } from "../startup-check.ts";
import {
  BUNDLE_POLICY,
  checkDatabaseSize,
  checkFreeSpace,
  freeBytes,
  inflateFile,
  type BundlePolicy,
} from "./policy.ts";
import {
  BACKUP_TEMP_PREFIX,
  DATA_SUFFIX,
  parseBackupName,
  readSidecar,
  SIDECAR_SUFFIX,
  sidecarMatchesName,
  type BackupSidecar,
} from "./sidecar.ts";
import { checkSnapshot, hasOwnSchema, type SnapshotFacts } from "./snapshot.ts";

const invalid = (why: string): StorageError => new StorageError("BACKUP_INVALID", why);

export interface VerifyOptions {
  policy?: BundlePolicy;
  /** The registered schema steps. Default: SCHEMA_STEPS. Tests pass stand-in steps. */
  steps?: readonly SchemaStep[];
  /** Free bytes for a folder. Default: the file system's. */
  freeBytes?: (folder: string) => number;
  busyTimeoutMs?: number;
}

/** What a verified backup holds. */
export interface VerifiedBackup {
  space: SpaceRow;
  revision: Revision;
  step: SchemaStep;
  sidecar: BackupSidecar;
}

/** The sidecar of a backup file, checked against the file's name, size and type (steps 1 and 2). */
export function readBackupFile(backupFile: string, policy: BundlePolicy): BackupSidecar {
  const name = basename(backupFile);
  if (!name.endsWith(DATA_SUFFIX)) throw invalid("The file is not named like a backup");
  const base = name.slice(0, -DATA_SUFFIX.length);
  const parts = parseBackupName(base);
  if (parts === undefined) throw invalid("The file is not named like a backup");
  const data = fsCall(() => lstatSync(backupFile, { throwIfNoEntry: false }));
  if (data === undefined) throw new StorageError("SPACE_NOT_FOUND", "The backup file is missing");
  if (!data.isFile()) throw invalid("The backup is not a regular file");
  const read = readSidecar(
    join(dirname(backupFile), `${base}${SIDECAR_SUFFIX}`),
    policy.maxOtherFileBytes,
  );
  if (read.state === "missing") throw invalid("The backup has no sidecar");
  if (read.state === "invalid" || !sidecarMatchesName(read.sidecar, parts)) {
    throw invalid("The backup's sidecar is not valid");
  }
  if (data.size !== read.sidecar.compressed_size) {
    throw invalid("The backup file's size differs from its sidecar's");
  }
  return read.sidecar;
}

const sameCounts = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = Object.keys(a).sort();
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
};

/**
 * Steps 1 to 5: verifies `backupFile` by unpacking it into the new file `dest` (in a folder that
 * exists), and returns what it holds. Throws the first check that fails. The caller owns `dest`
 * and the -wal and -shm beside it, on success and on failure.
 */
export async function unpackVerified(
  checked: CheckedDriver,
  backupFile: string,
  dest: string,
  options: VerifyOptions = {},
): Promise<VerifiedBackup> {
  const policy = options.policy ?? BUNDLE_POLICY;
  const sidecar = readBackupFile(backupFile, policy);
  checkDatabaseSize(sidecar.size, policy);
  checkFreeSpace(sidecar.size, (options.freeBytes ?? freeBytes)(dirname(dest)), policy);

  const digests = await inflateFile(backupFile, dest, {
    maxBytes: policy.maxDatabaseBytes,
    expectedBytes: sidecar.size,
  });
  if (
    digests.size !== sidecar.size ||
    digests.sha256 !== sidecar.sha256 ||
    digests.compressedSize !== sidecar.compressed_size ||
    digests.compressedSha256 !== sidecar.compressed_sha256 ||
    fsCall(() => statSync(dest).size) !== sidecar.size
  ) {
    throw invalid("The backup's content differs from its sidecar");
  }

  let facts: SnapshotFacts;
  try {
    facts = checkSnapshot(checked, dest, options.busyTimeoutMs);
  } catch (error) {
    // The bytes matched the sidecar, so a failing check means the backup was bad when written.
    const cause = error instanceof StorageError ? error.code : "an unexpected error";
    throw invalid(`The restored database does not verify (${cause})`);
  }
  const { space } = facts;
  if (
    facts.userVersion !== sidecar.user_version ||
    space.spaceId !== sidecar.space_id ||
    space.authority.epoch !== sidecar.epoch ||
    space.authority.incarnation !== sidecar.incarnation ||
    space.lastSeq !== sidecar.seq ||
    !sameCounts(facts.counts, sidecar.counts)
  ) {
    throw invalid("The restored database differs from its sidecar");
  }
  const position = stepPosition(options.steps ?? SCHEMA_STEPS, facts.userVersion);
  if (position.state === "newer") {
    throw new StorageError("SPACE_TOO_NEW", "The backup's schema is newer than this build writes");
  }
  if (position.state === "unknown") {
    throw new StorageError("SPACE_VERSION_UNKNOWN", "The backup's schema revision is unknown");
  }
  const { step } = position;
  if (space.format.major !== step.format.major || space.format.minor !== step.format.minor) {
    throw new StorageError("SPACE_INVALID", "The space format does not match its schema revision");
  }
  if (!hasOwnSchema(checked, facts, options.steps ?? SCHEMA_STEPS)) {
    throw invalid("The restored database's schema is not its revision's");
  }
  return { space, revision: step.revision, step, sidecar };
}

/**
 * Verifies the backup `backupFile` in full, as a restore would, by unpacking it into a temporary
 * file beside it (a backup's own temporary name, so a crash leaves only a leftover that the
 * listing names) and removing that again. Returns its sidecar when every check passes, undefined
 * when any fails. Never throws for the backup's sake.
 */
export async function verifyBackupFile(
  checked: CheckedDriver,
  backupFile: string,
  options: VerifyOptions = {},
): Promise<BackupSidecar | undefined> {
  const copy = join(dirname(backupFile), `${BACKUP_TEMP_PREFIX}${temporaryTag()}.db`);
  try {
    return (await unpackVerified(checked, backupFile, copy, options)).sidecar;
  } catch {
    return undefined;
  } finally {
    for (const path of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) removeQuietly(path);
  }
}
