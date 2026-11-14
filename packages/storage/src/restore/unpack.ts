// Unpacking a backup or an export bundle into a new folder (A1 3.18 "Restore", steps 1 and 2).
// Nothing is used before every check passed. Then space.json is written from the database: a
// backup holds none (A1 3.1), and a bundle's is checked, never kept, because the database wins.
//
// A backup (`.db.gz` beside its sidecar) is unpacked as `space.db` and verified with the checks
// that define a verified backup (backup/verify.ts: the files, the sidecar, the BundlePolicy while
// it streams, both digests, integrity_check, the sidecar's facts, the revision and the format).
//
// An export bundle (`.zip`) is read with bundle/read.ts, which checks the archive, its layout and
// every file against export.json while it streams. `space.db` and the attachments are unpacked,
// everything else only verified. Then the database must pass integrity_check and agree with
// export.json (space, epoch, incarnation, last commit, revision, rows per table), space.json must
// name the same space, the revision must be one this build knows and not newer, its tables,
// indexes and views must be exactly its revision's (snapshot.ts hasOwnSchema), and every live
// attachment row's blob must be in the bundle.
import { join } from "node:path";
import { StorageError } from "../errors.ts";
import { DATABASE_FILE, MANIFEST_FILE, manifestFor, writeManifest } from "../manifest.ts";
import { stepPosition } from "../migrate/steps.ts";
import { openReader } from "../open.ts";
import type { SpaceRow } from "../rows.ts";
import type { Revision, SchemaStep } from "../schema.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { removeQuietly } from "../files.ts";
import { SCHEMA_STEPS } from "../../migrations/index.ts";
import { BUNDLE_POLICY, type BundlePolicy } from "../backup/policy.ts";
import type { BackupSidecar } from "../backup/sidecar.ts";
import { checkSnapshot, hasOwnSchema, type SnapshotFacts } from "../backup/snapshot.ts";
import { unpackVerified } from "../backup/verify.ts";
import type { ExportManifest } from "../bundle/export-file.ts";
import { bundleInvalid, readBundle } from "../bundle/read.ts";

export interface UnpackSeams {
  policy?: BundlePolicy;
  steps?: readonly SchemaStep[];
  /** Free bytes for the folder. Default: the file system's. */
  freeBytes?: (folder: string) => number;
}

/** What a restore came from: a backup with its sidecar, or a bundle with its export.json. */
export type RestoreSource =
  { kind: "backup"; sidecar: BackupSidecar } | { kind: "bundle"; manifest: ExportManifest };

export interface Unpacked {
  space: SpaceRow;
  revision: Revision;
  step: SchemaStep;
  source: RestoreSource;
}

interface UnpackOptions {
  appVersion: string;
  busyTimeoutMs?: number;
}

/** Whether a file is an export bundle, by its name: a backup is a `.db.gz`. */
export const isBundleFile = (file: string): boolean => /\.zip$/i.test(file);

/**
 * Unpacks the backup or bundle `file` into the empty folder `staging` as `space.db` with its
 * `space.json`, and verifies it. On failure the caller removes `staging`.
 */
export async function unpackAny(
  checked: CheckedDriver,
  file: string,
  staging: string,
  options: UnpackOptions,
  seams: UnpackSeams = {},
): Promise<Unpacked> {
  return isBundleFile(file)
    ? unpackBundle(checked, file, staging, options, seams)
    : unpackBackup(checked, file, staging, options, seams);
}

/** Unpacks the backup `backupFile` (a `.db.gz` beside its sidecar). */
export async function unpackBackup(
  checked: CheckedDriver,
  backupFile: string,
  staging: string,
  options: UnpackOptions,
  seams: UnpackSeams = {},
): Promise<Unpacked> {
  const verified = await unpackVerified(checked, backupFile, join(staging, DATABASE_FILE), {
    ...seams,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  // checkSnapshot removed the -wal and -shm its read-only open left, so the folder holds the
  // database and, next, space.json.
  writeManifest(staging, manifestFor(verified.space, verified.step, options.appVersion));
  const { space, revision, step, sidecar } = verified;
  return { space, revision, step, source: { kind: "backup", sidecar } };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const sameCounts = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
};

/** Unpacks the export bundle `bundleFile` (a `.zip`). */
export async function unpackBundle(
  checked: CheckedDriver,
  bundleFile: string,
  staging: string,
  options: UnpackOptions,
  seams: UnpackSeams = {},
): Promise<Unpacked> {
  const policy = seams.policy ?? BUNDLE_POLICY;
  const db = join(staging, DATABASE_FILE);
  const { manifest, kept } = await readBundle(bundleFile, policy, {
    extractTo: (name, kind) =>
      kind === "database"
        ? db
        : kind === "attachment"
          ? join(staging, ...name.split("/"))
          : undefined,
    keep: [MANIFEST_FILE],
    freeFolder: staging,
    ...(seams.freeBytes === undefined ? {} : { freeBytes: seams.freeBytes }),
  });
  if (!Object.hasOwn(manifest.files, DATABASE_FILE)) throw bundleInvalid("it holds no space.db");
  const spaceJson = kept.get(MANIFEST_FILE);
  if (spaceJson === undefined) throw bundleInvalid("it holds no space.json");

  let facts: SnapshotFacts;
  try {
    facts = checkSnapshot(checked, db, options.busyTimeoutMs);
  } catch (error) {
    const cause = error instanceof StorageError ? error.code : "an unexpected error";
    throw bundleInvalid(`its database does not verify (${cause})`);
  }
  const { space } = facts;
  if (
    space.spaceId !== manifest.space_id ||
    space.authority.epoch !== manifest.epoch ||
    space.authority.incarnation !== manifest.incarnation ||
    space.lastSeq !== manifest.seq ||
    facts.userVersion !== manifest.user_version ||
    !sameCounts(facts.counts, manifest.counts)
  ) {
    throw bundleInvalid("its database differs from export.json");
  }
  let named: unknown;
  try {
    named = (JSON.parse(UTF8.decode(spaceJson)) as Record<string, unknown> | null)?.["space_id"];
  } catch {
    named = undefined;
  }
  if (named !== space.spaceId) throw bundleInvalid("its space.json names another space");

  const position = stepPosition(seams.steps ?? SCHEMA_STEPS, facts.userVersion);
  if (position.state === "newer") {
    throw new StorageError("SPACE_TOO_NEW", "The bundle's schema is newer than this build writes");
  }
  if (position.state === "unknown") {
    throw new StorageError("SPACE_VERSION_UNKNOWN", "The bundle's schema revision is unknown");
  }
  const { step } = position;
  if (space.format.major !== step.format.major || space.format.minor !== step.format.minor) {
    throw new StorageError("SPACE_INVALID", "The space format does not match its schema revision");
  }
  if (!hasOwnSchema(checked, facts, seams.steps ?? SCHEMA_STEPS)) {
    throw bundleInvalid("its database's schema is not its revision's");
  }
  checkAttachments(checked, db, manifest, options.busyTimeoutMs);
  writeManifest(staging, manifestFor(space, step, options.appVersion));
  return { space, revision: step.revision, step, source: { kind: "bundle", manifest } };
}

/**
 * Every live attachment row's blob is in the bundle, with the row's size (read.ts checked that
 * each blob's content is the hash its name and its row carry).
 */
function checkAttachments(
  checked: CheckedDriver,
  db: string,
  manifest: ExportManifest,
  busyTimeoutMs: number | undefined,
): void {
  const conn = openReader(checked, db, busyTimeoutMs === undefined ? {} : { busyTimeoutMs });
  try {
    const has =
      conn
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'attachments'",
        )
        .get()?.["n"] === 1;
    if (!has) return;
    for (const row of conn
      .prepare("SELECT DISTINCT sha256, size FROM attachments WHERE deleted_at IS NULL")
      .iterate<{ sha256: unknown; size: unknown }>()) {
      const hash = String(row.sha256);
      const path = `attachments/sha256/${hash.slice(0, 2)}/${hash}`;
      if (!Object.hasOwn(manifest.files, path)) {
        throw bundleInvalid("an attachment of the space is missing from it");
      }
      if (manifest.files[path]?.size !== row.size) {
        throw bundleInvalid("an attachment differs from its row");
      }
    }
  } finally {
    conn.close();
    for (const path of [`${db}-wal`, `${db}-shm`]) removeQuietly(path);
  }
}
