// What this machine keeps about each space, outside every space folder (A1 3.1 "Machine-local
// state"): `<state>/spaces/<space_id>.json`. These entries matter to the service now:
//
// - `backup.dir`: the machine-local backup folder (A1 3.18). The service only reads it: no command
//   writes it. Default: `<backups>/<space ID>`, beside the TTasks home (backupsFolderOf).
// - `projection_rescues`: each batch of the projection that moved entries a person made or edited
//   aside (A1 3.13 rule 3): when, how many, and the stem of its rescue folders relative to the
//   space's folder (`exchange/rescued/<stem>`, each rescue in `<stem>-<n>`: a time stamp, never a
//   task's name). The UI shows each once and removes it (A5). The newest MAX_RESCUES are kept.
// - `seen`: A6 3.5's `spaces_seen` entry, `{epoch, incarnation}`: the highest epoch this machine
//   has seen for the space. A claim and a restore in place go above it (A1 3.18,
//   `knownEpochs`). The service records it when a writer opens the space as its authority and
//   after a claim or a restore. A6's stale-restore detection adds `last_seq` with its step.
// - `synced_folder_confirmed`: the folder the person confirmed is excluded from sync (A1 3.2, "It
//   is excluded, open anyway"), by its canonical real path, and when. Per machine and per path: a
//   space in another folder (renamed, or restored there) asks again.
// - `writer_folder`: the folder of the copy that last opened as this machine's writer, by its
//   canonical real path, and when (A2 3.1). Copies of one space (a restored copy, claimed) share
//   this file, and at a start the copy in this folder opens first, so the copy the person last
//   wrote to keeps the writer when another copy could take it. Written at every writer open and by
//   `space open` of the copy that writes; when its folder is not listed, `seen` decides (spaces.ts).
// - `failed_migrations`: the migrations that failed on this machine (A1 3.17), each with the
//   product build that tried, the revision it was to reach, the state of the database it was tried
//   on (its revision, epoch, incarnation and last_seq), its code, its barrier backup's name and
//   when. No path and no text of the person. A later open by the same build on the same state does
//   not try again (spaces.ts). A list rather than one entry: two folders can hold one space (a
//   restored copy, claimed), and each state that failed is remembered on its own. Only the newest
//   MAX_FAILED_MIGRATIONS of the current build are kept. An entry that does not read back whole is
//   no entry: the open then tries again, behind a new barrier backup, which is the safe direction.
// - `last_migration`: the newest migration that succeeded here: its revisions, when, and its
//   barrier backup's name and folder. The space list and doctor show it, so a person who misses
//   something after an update knows what changed and which backup is from just before.
//
// Beside this file, in the same folder, the projection keeps its trusted state for each folder
// that holds the space (`<space_id>.<folder key>.projection.json` and
// `….projection-journal.json`, A1 3.13 rule 1; projectionStateOf): the projection's worker of
// that folder writes them, nothing else. Per folder, because the record says what was placed in
// one folder's `view/`: two folders that hold one space (a restored copy, claimed) never share one.
//
// Fields this module does not know are kept when it writes the file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  isId,
  makeDurableFolder,
  NODE_IO,
  type FileIo,
  type Id,
  type MigrationAttempt,
} from "@ttasks/storage";
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
  readonly seen?: Seen;
  /** The canonical folder the person confirmed is excluded from sync (A1 3.2). */
  readonly syncedFolderConfirmed?: string;
  /** The canonical folder of the copy that last opened as this machine's writer (A2 3.1). */
  readonly writerFolder?: string;
  /** The migrations that failed here and read back whole, oldest first. */
  readonly failedMigrations?: readonly FailedMigration[];
  /** The newest migration this machine ran on the space. */
  readonly lastMigration?: LastMigration;
}

/**
 * A migration that succeeded here: the revisions (`major.minor`), when, and the barrier backup
 * taken just before it, by name, so a person who misses something knows there is one to go back to.
 */
export interface LastMigration {
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly backup?: string;
  /** The folder that backup went to. A record written before folders were recorded has none. */
  readonly backup_folder?: string;
}

/**
 * Where a space's backups are written on this machine: `backup.dir` when this machine set one
 * (`set`: a person's choice, maybe on a drive that is away, so never made here and never cleaned),
 * else `<backups>/<space ID>` beside the TTasks home (paths.ts), which this service alone writes.
 * The space's own `backups/` (storage's backupsFolder), where backups went before, is only read.
 */
export function backupsFolderOf(
  settings: SpaceSettings,
  backups: string,
  spaceId: Id<"sp">,
): { readonly dir: string; readonly set: boolean } {
  return settings.backupDir === undefined
    ? { dir: join(backups, spaceId), set: false }
    : { dir: settings.backupDir, set: true };
}

/**
 * The folder a backup is about to be written to. The default is made here with each new folder's
 * entry synced in its parent, so a power loss cannot keep an upgrade and lose the folder of the
 * backup from before it. When that fails: undefined, and the backups folder is not there. Only an
 * upgrade then goes on, behind a backup in the space's own `backups/` (storage's migrate runner).
 */
export function readyBackupsFolder(
  folder: { readonly dir: string; readonly set: boolean },
  io: FileIo = NODE_IO,
): string | undefined {
  if (folder.set) return folder.dir;
  try {
    makeDurableFolder(folder.dir, io);
    return folder.dir;
  } catch {
    return undefined;
  }
}

const fileOf = (state: string, spaceId: Id<"sp">): string =>
  join(state, SPACES_FOLDER, `${spaceId}.json`);

/**
 * The key of a space's folder for its projection's state: the start of the SHA-256 of its full
 * path, compared as the service compares folders (without case on Windows and macOS). No path is
 * stored, so the state folder never holds one.
 */
export function folderKey(folder: string, platform: NodeJS.Platform = process.platform): string {
  const full = resolve(folder);
  const text = platform === "win32" || platform === "darwin" ? full.toLowerCase() : full;
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * The projection's trusted state for the space in `folder` (A1 3.13 rule 1): its record and its
 * journal, one pair per folder that holds the space.
 */
export const projectionStateOf = (
  state: string,
  spaceId: Id<"sp">,
  folder: string,
): { readonly record: string; readonly journal: string } => {
  const stem = `${spaceId}.${folderKey(folder)}`;
  return {
    record: join(state, SPACES_FOLDER, `${stem}.projection.json`),
    journal: join(state, SPACES_FOLDER, `${stem}.projection-journal.json`),
  };
};

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

/** `last_migration`, or undefined when any part of it is missing or wrong. */
function lastMigrationOf(value: unknown): LastMigration | undefined {
  if (!isRecord(value)) return undefined;
  const { from, to, at, backup, backup_folder: folder } = value;
  const fromRevision = revisionOf(from);
  const toRevision = revisionOf(to);
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    fromRevision === undefined ||
    toRevision === undefined ||
    toRevision <= fromRevision ||
    typeof at !== "string" ||
    !Number.isFinite(Date.parse(at)) ||
    (backup !== undefined && (typeof backup !== "string" || !BACKUP_NAME.test(backup)))
  ) {
    return undefined;
  }
  return {
    from,
    to,
    at: new Date(Date.parse(at)).toISOString(),
    ...(backup === undefined ? {} : { backup }),
    ...(backup !== undefined &&
    typeof folder === "string" &&
    folder.length <= MAX_PATH &&
    isAbsolute(folder)
      ? { backup_folder: folder }
      : {}),
  };
}

/**
 * Records a migration that succeeded on this machine: from and to (user_version values), its
 * barrier backup's name and folder. Other fields are kept.
 */
export function recordMigration(
  state: string,
  spaceId: Id<"sp">,
  migration: {
    readonly from: number;
    readonly to: number;
    readonly backup?: string;
    readonly backupFolder?: string;
  },
  now: Date = new Date(),
): void {
  const path = fileOf(state, spaceId);
  const record = readRecord(path);
  makeDir(join(state, SPACES_FOLDER), 0o700);
  const next = {
    format: 1,
    ...record,
    last_migration: {
      from: revisionText(migration.from),
      to: revisionText(migration.to),
      at: now.toISOString(),
      ...(migration.backup === undefined ? {} : { backup: migration.backup }),
      ...(migration.backupFolder === undefined ? {} : { backup_folder: migration.backupFolder }),
    },
  };
  atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
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
  const seen = record["seen"];
  const epoch = isRecord(seen) ? seen["epoch"] : undefined;
  const incarnation = isRecord(seen) ? seen["incarnation"] : undefined;
  const confirmed = record["synced_folder_confirmed"];
  const confirmedPath = isRecord(confirmed) ? confirmed["path"] : undefined;
  const writer = record["writer_folder"];
  const writerPath = isRecord(writer) ? writer["path"] : undefined;
  const failed = failedMigrationsOf(record["failed_migrations"]);
  const migrated = lastMigrationOf(record["last_migration"]);
  return {
    ...(typeof dir === "string" && dir.length <= MAX_PATH && isAbsolute(dir)
      ? { backupDir: dir }
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
    ...(typeof writerPath === "string" && writerPath.length <= MAX_PATH && isAbsolute(writerPath)
      ? { writerFolder: writerPath }
      : {}),
    ...(failed.length === 0 ? {} : { failedMigrations: failed }),
    ...(migrated === undefined ? {} : { lastMigration: migrated }),
  };
}

/**
 * Records that the copy in the folder `canonicalPath` (canonicalFolder in spaces.ts) opened as this
 * machine's writer. Writes only when another folder was recorded; other fields are kept. Returns
 * whether the file changed.
 */
export function recordWriterFolder(
  state: string,
  spaceId: Id<"sp">,
  canonicalPath: string,
  now: Date = new Date(),
): boolean {
  if (readSpaceSettings(state, spaceId).writerFolder === canonicalPath) return false;
  const path = fileOf(state, spaceId);
  const record = readRecord(path);
  makeDir(join(state, SPACES_FOLDER), 0o700);
  const next = {
    format: 1,
    ...record,
    writer_folder: { path: canonicalPath, at: now.toISOString() },
  };
  atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  return true;
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

/** A batch's rescue stem as the projection names it, relative to the space's folder. */
const RESCUE_STEM = /^exchange\/rescued\/[0-9]{8}T[0-9]{9}Z-[0-9a-f]{4}$/;

/**
 * The file's object for a change that must keep every other field: an empty one only when the file
 * is not there. One that is there and does not read back whole throws (`EIO`), so nothing written
 * over it can lose what it held (A1 3.13 rule 1): the caller tries again later.
 */
function readForChange(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = text.length > MAX_BYTES ? undefined : (JSON.parse(text) as unknown);
  } catch {
    value = undefined;
  }
  if (!isRecord(value)) {
    throw Object.assign(new Error("The space's settings do not read back whole"), { code: "EIO" });
  }
  return value;
}

/**
 * Records that a batch of the projection moved `files` entries a person made or edited into the
 * folders `<stem>-<n>` (relative to the space's folder), for the UI to show once (A1 3.13 rule 3).
 * One entry per stem: the projection tells a batch's rescues at least once, so a stem listed
 * already is not listed again. Other fields are kept. Returns once the file is written, and throws
 * when it could not be (a full volume, a file locked by another program, one that does not read
 * back whole): the projection then tells the rescue again.
 */
export function recordProjectionRescue(
  state: string,
  spaceId: Id<"sp">,
  rescue: { readonly stem: string; readonly files: number },
  now: Date = new Date(),
): void {
  if (!RESCUE_STEM.test(rescue.stem) || !isCount(rescue.files)) return;
  const path = fileOf(state, spaceId);
  const record = readForChange(path);
  const listed: unknown = record["projection_rescues"];
  const kept = (Array.isArray(listed) ? (listed as unknown[]) : []).filter(
    (entry) =>
      isRecord(entry) &&
      typeof entry["stem"] === "string" &&
      RESCUE_STEM.test(entry["stem"]) &&
      isCount(entry["files"]) &&
      typeof entry["at"] === "string",
  );
  if (kept.some((entry) => isRecord(entry) && entry["stem"] === rescue.stem)) return;
  makeDir(join(state, SPACES_FOLDER), 0o700);
  const next = {
    format: 1,
    ...record,
    projection_rescues: [
      ...kept,
      { at: now.toISOString(), stem: rescue.stem, files: rescue.files },
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
