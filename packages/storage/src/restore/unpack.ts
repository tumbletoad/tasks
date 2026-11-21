// Unpacking a backup or an export bundle into a new database file (A1 3.18 "Restore", steps 1 to 3),
// with every check a restore makes before its first write. Nothing is used before every check
// passed. No space.json is written here: the restore writes it from the database after its first
// write (restore.ts), because the database wins and a bundle's is checked, never kept.
//
// A backup (`.db.gz` beside its sidecar) is read through both files held open (backup/read.ts:
// the files, the sidecar, the BundlePolicy while it streams, both digests). An export bundle
// (`.zip`) is read with bundle/read.ts, which checks the archive, its layout and every file against
// export.json while it streams; `space.db` and the attachments are unpacked, everything else only
// verified, and its space.json must name the space its database holds.
//
// Then one function decides for both (acceptRestored): the database passes integrity_check and
// agrees with what its source records (space, epoch, incarnation, last commit, revision, rows per
// table), its space row holds at most SPACE_ROW_MAX_BYTES, the revision is one this build knows and
// not newer, the space's format is its
// revision's, and its tables, indexes and views are exactly its revision's (backup/snapshot.ts
// requireOwnSchema). A bundle's live attachment rows must each have their blob, with the row's size.
import { join } from "node:path";
import { misuse, StorageError } from "../errors.ts";
import { removeQuietly } from "../files.ts";
import { DATABASE_FILE, MANIFEST_FILE } from "../manifest.ts";
import { stepPosition } from "../migrate/steps.ts";
import { openReader } from "../open.ts";
import type { SpaceRow } from "../rows.ts";
import type { Revision, SchemaStep } from "../schema.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { SCHEMA_STEPS } from "../../migrations/index.ts";
import { BUNDLE_POLICY, type BundlePolicy } from "../backup/policy.ts";
import { holdBackup, inflateBackup } from "../backup/read.ts";
import type { BackupSidecar } from "../backup/sidecar.ts";
import { checkSnapshot, requireOwnSchema, type SnapshotFacts } from "../backup/snapshot.ts";
import type { ExportManifest } from "../bundle/export-file.ts";
import { bundleInvalid, readBundle } from "../bundle/read.ts";

export interface UnpackSeams {
  policy?: BundlePolicy;
  steps?: readonly SchemaStep[];
  /** Free bytes for the folder. Default: the file system's. */
  freeBytes?: (folder: string) => number;
  /**
   * Runs once a backup's two files are both open, before either is read (backup/read.ts): a test
   * removes them there, as retention could.
   */
  held?: (backupFile: string) => void | Promise<void>;
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

export interface UnpackOptions {
  busyTimeoutMs?: number;
}

/**
 * Where an unpacked copy goes: its new database file, and for a bundle the folder its attachments
 * go to, which is the database's own folder (`db` is `<folder>/space.db`).
 */
export interface CopyPlace {
  db: string;
  folder: string;
}

/** A copy's place in a staging folder: `<staging>/space.db`. */
export const inFolder = (staging: string): CopyPlace => ({
  db: join(staging, DATABASE_FILE),
  folder: staging,
});

/** Whether a file is an export bundle, by its name: a backup is a `.db.gz`. */
export const isBundleFile = (file: string): boolean => /\.zip$/i.test(file);

/**
 * Unpacks the backup or bundle `file` into `place` and verifies it. On failure the caller removes
 * what it unpacked: the database and its side files, and a bundle's attachments.
 */
export async function unpackAny(
  checked: CheckedDriver,
  file: string,
  place: CopyPlace,
  options: UnpackOptions,
  seams: UnpackSeams = {},
): Promise<Unpacked> {
  return isBundleFile(file)
    ? unpackBundle(checked, file, place, options, seams)
    : unpackBackup(checked, file, place.db, options, seams);
}

const backupInvalid = (why: string): StorageError =>
  new StorageError("BACKUP_INVALID", `The backup does not verify: ${why}`);

const busy = (options: UnpackOptions): { busyTimeoutMs?: number } =>
  options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs };

/**
 * Unpacks the backup `backupFile` (a `.db.gz` beside its sidecar) into the new database file `db`,
 * its two files held open until it is done.
 */
export async function unpackBackup(
  checked: CheckedDriver,
  backupFile: string,
  db: string,
  options: UnpackOptions,
  seams: UnpackSeams = {},
): Promise<Unpacked> {
  const policy = seams.policy ?? BUNDLE_POLICY;
  const held = holdBackup(backupFile, policy);
  try {
    await seams.held?.(backupFile);
    await inflateBackup(held, db, {
      policy,
      ...(seams.freeBytes === undefined ? {} : { freeBytes: seams.freeBytes }),
    });
    const { sidecar } = held;
    const facts = factsOf(checked, db, options, backupInvalid);
    const step = acceptRestored(checked, facts, sidecar, seams.steps ?? SCHEMA_STEPS, {
      noun: "backup",
      record: "its sidecar",
      invalid: backupInvalid,
    });
    return {
      space: facts.space,
      revision: step.revision,
      step,
      source: { kind: "backup", sidecar },
    };
  } finally {
    held.close();
  }
}

/** Unpacks the export bundle `bundleFile` (a `.zip`) into `place`. */
export async function unpackBundle(
  checked: CheckedDriver,
  bundleFile: string,
  place: CopyPlace,
  options: UnpackOptions,
  seams: UnpackSeams = {},
): Promise<Unpacked> {
  if (place.db !== join(place.folder, DATABASE_FILE)) {
    throw misuse("A bundle unpacks its database into its attachments' folder");
  }
  const policy = seams.policy ?? BUNDLE_POLICY;
  const { db, folder } = place;
  const { manifest, kept } = await readBundle(bundleFile, policy, {
    extractTo: (name, kind) =>
      kind === "database"
        ? db
        : kind === "attachment"
          ? join(folder, ...name.split("/"))
          : undefined,
    keep: [MANIFEST_FILE],
    freeFolder: folder,
    ...(seams.freeBytes === undefined ? {} : { freeBytes: seams.freeBytes }),
  });
  if (!Object.hasOwn(manifest.files, DATABASE_FILE)) throw bundleInvalid("it holds no space.db");
  const spaceJson = kept.get(MANIFEST_FILE);
  if (spaceJson === undefined) throw bundleInvalid("it holds no space.json");

  const facts = factsOf(checked, db, options, bundleInvalid);
  const step = acceptRestored(
    checked,
    facts,
    {
      space_id: manifest.space_id,
      epoch: manifest.epoch,
      incarnation: manifest.incarnation,
      seq: manifest.seq,
      user_version: manifest.user_version,
      counts: manifest.counts,
    },
    seams.steps ?? SCHEMA_STEPS,
    { noun: "bundle", record: "export.json", invalid: bundleInvalid },
  );
  let named: unknown;
  try {
    named = (JSON.parse(UTF8.decode(spaceJson)) as Record<string, unknown> | null)?.["space_id"];
  } catch {
    named = undefined;
  }
  if (named !== facts.space.spaceId) throw bundleInvalid("its space.json names another space");
  checkAttachments(checked, db, manifest, options);
  return {
    space: facts.space,
    revision: step.revision,
    step,
    source: { kind: "bundle", manifest },
  };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The unpacked database's facts; a database that does not check is the source's fault. */
function factsOf(
  checked: CheckedDriver,
  db: string,
  options: UnpackOptions,
  invalid: (why: string) => StorageError,
): SnapshotFacts {
  try {
    return checkSnapshot(checked, db, options.busyTimeoutMs);
  } catch (error) {
    // Its bytes matched what the source records, so a failing check means it was bad when written.
    const cause = error instanceof StorageError ? error.code : "an unexpected error";
    throw invalid(`its database does not check (${cause})`);
  }
}

/** What a backup's sidecar or a bundle's export.json records of the database. */
interface Recorded {
  space_id: string;
  epoch: number;
  incarnation: string;
  seq: number;
  user_version: number;
  counts: Record<string, number>;
}

const sameCounts = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
};

/**
 * The most a space row may hold for a restore to take it (A1 3.18 "Bundle limits"): the restore's
 * first write rewrites the row, twice with its trial claim, so the log and the growth of that write
 * stay a few MiB, which the free-space reserve covers. TTasks' own writes keep the row far smaller:
 * a name of at most 100 characters and about 260 bytes of lineage per claim.
 */
export const SPACE_ROW_MAX_BYTES = 1024 * 1024;

/**
 * The checks every restore makes of an unpacked database before it writes to it, for a backup and
 * a bundle alike (see the header). Returns the revision's step.
 */
export function acceptRestored(
  checked: CheckedDriver,
  facts: SnapshotFacts,
  recorded: Recorded,
  steps: readonly SchemaStep[],
  source: { noun: string; record: string; invalid: (why: string) => StorageError },
): SchemaStep {
  const { space } = facts;
  if (
    facts.userVersion !== recorded.user_version ||
    space.spaceId !== recorded.space_id ||
    space.authority.epoch !== recorded.epoch ||
    space.authority.incarnation !== recorded.incarnation ||
    space.lastSeq !== recorded.seq ||
    !sameCounts(facts.counts, recorded.counts)
  ) {
    throw source.invalid(`its database differs from ${source.record}`);
  }
  if (facts.spaceRowBytes > SPACE_ROW_MAX_BYTES) {
    throw source.invalid("its space row is larger than a space's");
  }
  const position = stepPosition(steps, facts.userVersion);
  if (position.state === "newer") {
    throw new StorageError(
      "SPACE_TOO_NEW",
      `The ${source.noun}'s schema is newer than this build writes`,
    );
  }
  if (position.state === "unknown") {
    throw new StorageError(
      "SPACE_VERSION_UNKNOWN",
      `The ${source.noun}'s schema revision is unknown`,
    );
  }
  const { step } = position;
  if (space.format.major !== step.format.major || space.format.minor !== step.format.minor) {
    throw new StorageError("SPACE_INVALID", "The space format does not match its schema revision");
  }
  try {
    requireOwnSchema(checked, facts.schema, facts.userVersion, steps);
  } catch (error) {
    if (!(error instanceof StorageError) || error.code !== "SPACE_SCHEMA_FOREIGN") throw error;
    throw source.invalid("its database's schema is not its revision's");
  }
  return step;
}

/**
 * Every live attachment row's blob is in the bundle, with the row's size (read.ts checked that
 * each blob's content is the hash its name and its row carry).
 */
function checkAttachments(
  checked: CheckedDriver,
  db: string,
  manifest: ExportManifest,
  options: UnpackOptions,
): void {
  const conn = openReader(checked, db, busy(options));
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

/** Removes an unpacked database file and the files SQLite keeps beside it. */
export function removeDatabase(db: string): void {
  for (const path of [db, `${db}-wal`, `${db}-shm`, `${db}-journal`]) removeQuietly(path);
}
