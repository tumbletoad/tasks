// What this machine keeps about each space, outside every space folder (A1 3.1 "Machine-local
// state"): `<state>/spaces/<space_id>.json`. These entries matter to the service now:
//
// - `backup.dir`: the machine-local backup folder (A1 3.18). The service only reads it: a later
//   step that owns the space's settings writes it. Default: the space's own `backups/`.
// - `projection.dir`: the machine-local folder of the projection (A1 3.13), read like `backup.dir`
//   and written by the preferences step (M3.11). Default: the space's own `view/`.
// - `projection_rescues`: each batch of the projection that moved files a person edited aside
//   (A1 3.13 step 3): when, how many and the rescue folder relative to the space's folder (a time
//   stamp, never a task's name). The UI shows each once and removes it (A5). The newest
//   MAX_RESCUES are kept.
// - `seen`: A6 3.5's `spaces_seen` entry, `{epoch, incarnation}`: the highest epoch this machine
//   has seen for the space. A claim and a restore in place go above it (A1 3.18,
//   `knownEpochs`). The service records it when a writer opens the space as its authority and
//   after a claim or a restore. A6's stale-restore detection adds `last_seq` with its step.
// - `synced_folder_confirmed`: the folder the person confirmed is excluded from sync (A1 3.2, "It
//   is excluded, open anyway"), by its canonical real path, and when. Per machine and per path: a
//   space in another folder (renamed, or restored there) asks again.
// - `failed_migrations`: the migrations that failed on this machine (A1 3.17), each with the
//   product build that tried, the revision it was to reach, the state of the database it was tried
//   on (its revision, epoch, incarnation and last_seq), its code, its barrier backup's name and
//   when. No path and no text of the person. A later open by the same build on the same state does
//   not try again (spaces.ts). A list rather than one entry: two folders can hold one space (a
//   restored copy, claimed), and each state that failed is remembered on its own. Only the newest
//   MAX_FAILED_MIGRATIONS of the current build are kept. An entry that does not read back whole is
//   no entry: the open then tries again, behind a new barrier backup, which is the safe direction.
//
// Fields this module does not know are kept when it writes the file.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isId, type Id, type MigrationAttempt } from "@tasks/storage";
import { atomicWrite, makeDir } from "./files.ts";

export const SPACES_FOLDER = "spaces";
const MAX_BYTES = 64 * 1024;
const MAX_PATH = 4096;
/** The failed migrations kept for a space: the newest, all of one build. */
export const MAX_FAILED_MIGRATIONS = 8;

export interface Seen {
  readonly epoch: number;
  readonly incarnation: Id<"ai">;
}

/** A product build: its version and its build label (hub/build.ts). */
export interface BuildIdentity {
  readonly version: string;
  readonly build: string;
}

/**
 * A migration that failed on this machine (A1 3.17): the build that tried it, and the state
 * of the database it was tried on as the migration runner reported it (MigrationAttempt).
 * Revisions are user_version values.
 */
export interface FailedMigration {
  readonly build: BuildIdentity;
  readonly from: number;
  readonly to: number;
  readonly epoch: number;
  readonly incarnation: Id<"ai">;
  readonly lastSeq: number;
  /** The code it failed with, one of FAILED_MIGRATION_CODES. */
  readonly code: string;
  /** The barrier backup's name, when one was taken. */
  readonly backup?: string;
}

/** The codes of a failed migration: the writer's refusals the hub serves as migration_failed. */
export const FAILED_MIGRATION_CODES: readonly string[] = [
  "BACKUP_FAILED",
  "BUNDLE_LIMIT_EXCEEDED",
  "MIGRATION_FAILED",
  "SPACE_CHANGED",
];

export interface SpaceSettings {
  /** The machine-local backup folder, when one is set and is an absolute path. */
  readonly backupDir?: string;
  /** The machine-local projection folder, when one is set and is an absolute path. */
  readonly projectionDir?: string;
  readonly seen?: Seen;
  /** The canonical folder the person confirmed is excluded from sync (A1 3.2). */
  readonly syncedFolderConfirmed?: string;
  /** The migrations that failed here and read back whole, oldest first. */
  readonly failedMigrations?: readonly FailedMigration[];
}

const fileOf = (state: string, spaceId: Id<"sp">): string =>
  join(state, SPACES_FOLDER, `${spaceId}.json`);

/** The file's object, or an empty one when it is missing, too large or not an object. */
function readRecord(path: string): Record<string, unknown> {
  try {
    const text = readFileSync(path, "utf8");
    if (text.length > MAX_BYTES) return {};
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A build's version or label: short and plain (scripts/build checks the real ones). */
const BUILD_WORD = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
/** A revision as A1 writes it, `major.minor` (schema.ts encodes it as major × 1000 + minor). */
const REVISION = /^(0|[1-9][0-9]{0,6})\.(0|[1-9][0-9]{0,2})$/;
/** A barrier backup's name (storage's backup names), never a path. */
const BACKUP_NAME = /^pre-migrate-[0-9A-Za-z.-]{1,100}$/;

const revisionText = (userVersion: number): string =>
  `${String(Math.floor(userVersion / 1000))}.${String(userVersion % 1000)}`;

function revisionOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = REVISION.exec(value);
  if (match === null) return undefined;
  const userVersion = Number(match[1]) * 1000 + Number(match[2]);
  return userVersion > 0 ? userVersion : undefined;
}

/** One `failed_migrations` entry, or undefined when any part of it is missing or wrong. */
function failedMigrationOf(value: unknown): FailedMigration | undefined {
  if (!isRecord(value)) return undefined;
  const build = value["build"];
  const version = isRecord(build) ? build["version"] : undefined;
  const label = isRecord(build) ? build["build"] : undefined;
  const from = revisionOf(value["from"]);
  const to = revisionOf(value["to"]);
  const { epoch, incarnation, code, backup } = value;
  const lastSeq = value["last_seq"];
  if (
    typeof version !== "string" ||
    !BUILD_WORD.test(version) ||
    typeof label !== "string" ||
    !BUILD_WORD.test(label) ||
    from === undefined ||
    to === undefined ||
    to <= from ||
    !isCount(epoch) ||
    !isId(incarnation, "ai") ||
    !isCount(lastSeq) ||
    typeof code !== "string" ||
    !FAILED_MIGRATION_CODES.includes(code) ||
    (backup !== undefined && (typeof backup !== "string" || !BACKUP_NAME.test(backup)))
  ) {
    return undefined;
  }
  return {
    build: { version, build: label },
    from,
    to,
    epoch,
    incarnation,
    lastSeq,
    code,
    ...(backup === undefined ? {} : { backup }),
  };
}

/** The entries of `failed_migrations` that read back whole, at most MAX_FAILED_MIGRATIONS. */
function failedMigrationsOf(value: unknown): FailedMigration[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_FAILED_MIGRATIONS)
    .map(failedMigrationOf)
    .filter((entry) => entry !== undefined);
}

/** A space's machine-local settings, each field checked; a bad field is left out. */
export function readSpaceSettings(state: string, spaceId: Id<"sp">): SpaceSettings {
  const record = readRecord(fileOf(state, spaceId));
  const backup = record["backup"];
  const dir = isRecord(backup) ? backup["dir"] : undefined;
  const projection = record["projection"];
  const viewDir = isRecord(projection) ? projection["dir"] : undefined;
  const seen = record["seen"];
  const epoch = isRecord(seen) ? seen["epoch"] : undefined;
  const incarnation = isRecord(seen) ? seen["incarnation"] : undefined;
  const confirmed = record["synced_folder_confirmed"];
  const confirmedPath = isRecord(confirmed) ? confirmed["path"] : undefined;
  const failed = failedMigrationsOf(record["failed_migrations"]);
  return {
    ...(typeof dir === "string" && dir.length <= MAX_PATH && isAbsolute(dir)
      ? { backupDir: dir }
      : {}),
    ...(typeof viewDir === "string" && viewDir.length <= MAX_PATH && isAbsolute(viewDir)
      ? { projectionDir: viewDir }
      : {}),
    ...(typeof epoch === "number" &&
    Number.isSafeInteger(epoch) &&
    epoch >= 0 &&
    isId(incarnation, "ai")
      ? { seen: { epoch, incarnation } }
      : {}),
    ...(typeof confirmedPath === "string" &&
    confirmedPath.length <= MAX_PATH &&
    isAbsolute(confirmedPath)
      ? { syncedFolderConfirmed: confirmedPath }
      : {}),
    ...(failed.length === 0 ? {} : { failedMigrations: failed }),
  };
}

/**
 * Records that the person confirmed the folder `canonicalPath` (canonicalFolder in spaces.ts) is
 * excluded from sync, for this space on this machine. Other fields are kept.
 */
export function recordSyncedConfirmed(
  state: string,
  spaceId: Id<"sp">,
  canonicalPath: string,
  now: Date = new Date(),
): void {
  const path = fileOf(state, spaceId);
  const record = readRecord(path);
  makeDir(join(state, SPACES_FOLDER), 0o700);
  const next = {
    format: 1,
    ...record,
    synced_folder_confirmed: { path: canonicalPath, at: now.toISOString() },
  };
  atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** The projection's rescues kept for the UI. */
export const MAX_RESCUES = 20;

/** A rescue folder as the projection names it, relative to the space's folder. */
const RESCUE_FOLDER = /^exchange\/rescued\/[0-9]{8}T[0-9]{9}Z(-[0-9]{1,3})?$/;

/**
 * Records that the projection moved `files` files a person edited into `folder` (relative to the
 * space's folder), for the UI to show once (A1 3.13 step 3). Other fields are kept.
 */
export function recordProjectionRescue(
  state: string,
  spaceId: Id<"sp">,
  rescue: { readonly folder: string; readonly files: number },
  now: Date = new Date(),
): void {
  if (!RESCUE_FOLDER.test(rescue.folder) || !isCount(rescue.files)) return;
  const path = fileOf(state, spaceId);
  const record = readRecord(path);
  const listed: unknown = record["projection_rescues"];
  const kept = (Array.isArray(listed) ? (listed as unknown[]) : []).filter(
    (entry) =>
      isRecord(entry) &&
      typeof entry["folder"] === "string" &&
      RESCUE_FOLDER.test(entry["folder"]) &&
      isCount(entry["files"]) &&
      typeof entry["at"] === "string",
  );
  makeDir(join(state, SPACES_FOLDER), 0o700);
  const next = {
    format: 1,
    ...record,
    projection_rescues: [
      ...kept,
      { at: now.toISOString(), folder: rescue.folder, files: rescue.files },
    ].slice(-MAX_RESCUES),
  };
  atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** The epochs to pass a claim or a restore in place as `knownEpochs`. */
export const knownEpochs = (settings: SpaceSettings): number[] =>
  settings.seen === undefined ? [] : [settings.seen.epoch];

/**
 * Records an authority this machine has seen for the space, when its epoch is at least the one
 * recorded: the highest epoch only ever goes up. Returns whether the file changed.
 */
export function recordSeen(state: string, spaceId: Id<"sp">, seen: Seen): boolean {
  const path = fileOf(state, spaceId);
  const record = readRecord(path);
  const known = readSpaceSettings(state, spaceId).seen;
  if (known !== undefined) {
    if (known.epoch > seen.epoch) return false;
    if (known.epoch === seen.epoch && known.incarnation === seen.incarnation) return false;
  }
  makeDir(join(state, SPACES_FOLDER), 0o700);
  const next = {
    format: 1,
    ...record,
    seen: { epoch: seen.epoch, incarnation: seen.incarnation },
  };
  atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

/** The state of a database a migration was tried on: what a failed migration's entry names. */
export interface TriedState {
  readonly from: number;
  readonly epoch: number;
  readonly incarnation: string;
  readonly lastSeq: number;
}

const sameBuild = (a: BuildIdentity, b: BuildIdentity): boolean =>
  a.version === b.version && a.build === b.build;

/** Whether `failure` records a migration that `build` tried on the state `on`. */
export const failedOn = (failure: FailedMigration, build: BuildIdentity, on: TriedState): boolean =>
  sameBuild(failure.build, build) &&
  failure.from === on.from &&
  failure.epoch === on.epoch &&
  failure.incarnation === on.incarnation &&
  failure.lastSeq === on.lastSeq;

/**
 * Records that `build` tried to migrate the space on the state `attempt` names and that it failed
 * with `code` (A1 3.17). The entries of other builds go, an entry for the same state is
 * replaced, and the newest MAX_FAILED_MIGRATIONS stay. Other fields are kept.
 */
export function recordFailedMigration(
  state: string,
  spaceId: Id<"sp">,
  build: BuildIdentity,
  attempt: MigrationAttempt,
  code: string,
  now: Date = new Date(),
): void {
  const path = fileOf(state, spaceId);
  const record = readRecord(path);
  const listed: unknown = record["failed_migrations"];
  const entries: readonly unknown[] = Array.isArray(listed) ? (listed as unknown[]) : [];
  // Kept as they are, with the time each was recorded.
  const kept = entries.filter((value) => {
    const entry = failedMigrationOf(value);
    return entry !== undefined && sameBuild(entry.build, build) && !failedOn(entry, build, attempt);
  });
  const entry = {
    build: { version: build.version, build: build.build },
    from: revisionText(attempt.from),
    to: revisionText(attempt.to),
    epoch: attempt.epoch,
    incarnation: attempt.incarnation,
    last_seq: attempt.lastSeq,
    code,
    ...(attempt.backup === undefined ? {} : { backup: attempt.backup }),
    at: now.toISOString(),
  };
  makeDir(join(state, SPACES_FOLDER), 0o700);
  const next = {
    format: 1,
    ...record,
    failed_migrations: [...kept, entry].slice(-MAX_FAILED_MIGRATIONS),
  };
  atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Forgets the space's failed migrations: after a successful migration or a restore in place
 * (A1 3.17). Writes only when the file names some; other fields are kept. Returns whether
 * the file changed.
 */
export function clearFailedMigrations(state: string, spaceId: Id<"sp">): boolean {
  const path = fileOf(state, spaceId);
  const record = readRecord(path);
  if (!Object.hasOwn(record, "failed_migrations")) return false;
  const next = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "failed_migrations"),
  );
  atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}
