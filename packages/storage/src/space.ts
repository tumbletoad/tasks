// Creating and opening a space folder (A1 3.1, 3.4, 3.17). These run where the connection lives:
// in a storage worker in the service, or directly in tests and scripts. They never run on the
// service's event loop (A1 3.9).
//
// Create builds the whole space in a hidden staging folder `.<slug>.creating-<random>` next to its
// final place: the database with every schema step in one transaction, the space row with epoch 1
// and a new random authority incarnation, the human and system actors, then space.json. Only then
// is the folder renamed into place, so a space folder either exists complete or not at all. A
// failure removes the staging folder. A crash, or a removal that fails, leaves it behind under that
// name, for M1.10's cleanup (A1 3.1).
//
// The rename does not replace an existing folder on Windows. On Linux and macOS, rename(2)
// replaces an EMPTY folder, and Node has no rename that refuses to replace one, so an empty folder
// that appears at the space's path between create's check and its rename is replaced by the new
// space. A folder with anything in it, such as another space, makes the rename fail (SPACE_EXISTS).
//
// Open runs in two phases (A1 3.1).
// 1. Inspection. space.json is read first: a newer manifest, or a valid min_reader above this
//    build, is refused before SQLite opens the database. Then the file-system checks
//    (checkFilesBeforeSqlite): a rollback journal beside the database is SPACE_NEEDS_RECOVERY, an
//    empty database file SPACE_INVALID. Then the database opens READ-ONLY with the reader's
//    pragmas, none of which writes, and one read transaction reads the application_id, the schema
//    revision and the space row, and checks the row's format against the step registered for
//    that revision. From these and space.json's safety fields comes the verdict: a refusal, or
//    the read-only reasons. A reader stops here and keeps this connection. An older revision that
//    a registered step produced is the reason older_revision: the writer refuses it with
//    SPACE_NEEDS_MIGRATION, unless its opener allows it and migrates first (the storage worker's
//    writer, migrate/runner.ts). A read-only copy, a backup restored into a new folder, is the
//    reason read_only_copy: the writer refuses it with SPACE_READ_ONLY_COPY until it is claimed.
// 2. The writer, only when the verdict has no reason. Its connection opens read-write, and
//    openWriter's `inspect` hook runs before journal_mode=WAL, the first writer pragma that
//    persists. In the hook, space.json must read as it did, the file-system checks run again, and
//    then the first read on this connection must find the application_id, revision and space ID
//    that phase 1 saw. Then the writer's pragmas, and space.json is rebuilt from the database when
//    it is missing or stale. beginSpaceWriter stops after SQLite's open, before the hook, so a
//    storage worker can claim the file SQLite opened before anything runs on the connection.
//
// What open guarantees, and what it does not:
// - A refusal decided in phase 1 changes nothing in the database: space.db, and its -wal and
//   -journal when they exist, keep their bytes, the journal mode stays, and no file is removed. A
//   refusal from space.json or the file-system checks comes before SQLite and leaves nothing at
//   all. After that, the read-only connection leaves what SQLite's read-only connections leave on
//   a WAL database, and cannot remove: a 0-byte space.db-wal when there was none, and a 32 KiB
//   space.db-shm, created, or rebuilt from the -wal after a crash.
// - A refusal decided in phase 2 is decided before any persistent pragma. Where a file-system
//   check can decide it (space.json, the rollback journal, an empty file), it is decided before
//   the first read on the writable connection, otherwise at that first read.
// - Not guaranteed: a file replaced in a window between a check and what it guards. The four
//   windows run from phase 1's file-system checks to its first read, from phase 1's end to phase
//   2's file-system checks, from those checks to phase 2's first read, and from phase 2's
//   inspection to the rename of space.json. In a window SQLite itself may touch the replaced file
//   before open refuses it. At the first read it plays back a hot rollback journal (a writable
//   connection only), rebuilds the -shm from a -wal, or deletes a -wal beside an empty file. When
//   a refused writable connection closes, it checkpoints the -wal into the file and removes the
//   -wal and -shm. Or it does nothing. Open cannot close these windows. One writer per space
//   (M1.04's worker, A2's service lock) and no outside replacement of a live space do.
// Measured with node:sqlite (SQLite 3.54.1) on Windows, and by the tests on the Ubuntu CI runner.
import { existsSync, lstatSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SCHEMA_STEPS } from "../migrations/index.ts";
import { seedTreeRoot, TREE_STEP, TREE_USER_VERSION } from "./tree/schema.ts";
import type { Connection, Row } from "./driver.ts";
import { misuse, StorageError } from "./errors.ts";
import {
  createEmptyFile,
  errnoCode,
  FILE_MODE,
  FOLDER_MODE,
  fsCall,
  fsError,
  fsyncFolder,
  makeDirExact,
  NODE_IO,
  removeQuietly,
  temporaryTag,
  type FileIo,
} from "./files.ts";
import { isId, newId, osRandom, type Id, type RandomSource } from "./ids.ts";
import {
  compareAppVersions,
  DATABASE_FILE,
  isAppVersion,
  manifestFor,
  readManifest,
  sameManifest,
  writeManifest,
  type ManifestRead,
  type SpaceManifest,
} from "./manifest.ts";
import { stepPosition } from "./migrate/steps.ts";
import {
  configureConnection,
  openReader,
  openUnconfigured,
  openWriter,
  type PragmaSetting,
  type Role,
} from "./open.ts";
import { defaultRefPrefix } from "./refs.ts";
import {
  decodeSpaceRow,
  inRange,
  isSpaceName,
  REF_PREFIX,
  type Lineage,
  type SpaceFormat,
  type SpaceRow,
} from "./rows.ts";
import {
  APP_ID,
  decodeRevision,
  encodeRevision,
  type Revision,
  type SchemaStep,
} from "./schema.ts";
import { checkSpacePath } from "./space-path.ts";
import type { CheckedDriver } from "./startup-check.ts";

/** The app version of a build run from source, until release builds stamp theirs (M1.13). */
export const SOURCE_APP_VERSION = "0.0.0";

const LATEST_STEP: SchemaStep = (() => {
  const last = SCHEMA_STEPS.at(-1);
  if (last === undefined) throw new Error("No schema step is registered");
  return last;
})();

/** The schema revision this build creates and writes. */
export const LATEST_REVISION: Revision = LATEST_STEP.revision;

/** Set on a new database before journal_mode, which fixes it (A1 3.4). */
export const AUTO_VACUUM_INCREMENTAL: PragmaSetting = {
  name: "auto_vacuum",
  value: "INCREMENTAL",
  expect: 2,
};

/** The system actor's label. */
const SYSTEM_LABEL = "System";

export interface CreateSpaceOptions {
  /** The space's display name, such as "Mira". */
  name: string;
  /** 1 to 6 upper-case letters. Default: from the name, avoiding `takenPrefixes` (A1 3.3). */
  refPrefix?: string;
  /** The prefixes of the other spaces on this machine. */
  takenPrefixes?: Iterable<string>;
  /** This machine's ID, from machine.json (A6 3.4). It becomes the authority. */
  machineId: Id<"m">;
  /** The label of the space's human actor, the `user` of A3 3.7.4. */
  ownerLabel: string;
  appVersion?: string;
  /** Milliseconds since 1970. Default: Date.now. */
  now?: () => number;
  /** The source of every ID the space starts with. Default: the OS. */
  random?: RandomSource;
  /** A tree space (tree/schema.ts), which only tests and trial spaces are until the switch. */
  tree?: boolean;
}

/** The actors every space starts with. Other actors join as they first act. */
export interface SpaceActors {
  human: Id<"ac">;
  system: Id<"ac">;
}

export interface CreatedSpace {
  folder: string;
  space: SpaceRow;
  actors: SpaceActors;
  manifest: SpaceManifest;
}

/** Why a space opens read-only on this build. */
export type ReadOnlyReason =
  /** The schema revision is newer than this build's (A1 3.17: an older build never writes it). */
  | "newer_revision"
  /** space.json's min_writer is newer than this build. */
  | "newer_writer"
  /** space.json names another space than the database (A1 3.1). */
  | "space_id_mismatch"
  /** space.json is not a manifest, or a safety field is missing or invalid (A1 3.1). */
  | "manifest_damaged"
  /**
   * A read-only copy (A1 3.18 "Restore" step 3, A6 3.5's role `read_only_copy`): a backup restored
   * into a new folder holds no authority until it is claimed. The database itself carries the
   * mark, in `space.transfer` (restore/restore.ts), so a copy of the folder or of the database
   * keeps it, and space.json, which only describes the database, can neither add nor remove it. A
   * claim (restore/claim.ts) clears it in the claim's own transaction. Until M3 adds the transfer
   * states, any value in `space.transfer` makes a space read-only.
   */
  | "read_only_copy"
  /**
   * The schema revision is older than this build's: the writer waits for the migration runner
   * (A1 3.17). A failed migration leaves the space here, readable (migrate/runner.ts).
   */
  | "older_revision";

export interface OpenSpaceOptions {
  role: Role;
  appVersion?: string;
  busyTimeoutMs?: number;
}

export interface OpenedSpace {
  folder: string;
  role: Role;
  conn: Connection;
  space: SpaceRow;
  revision: Revision;
  /**
   * A reader's reasons. For a writer, the reasons its opener allowed (SpaceSeams.allow) that the
   * space has: empty for every other writer, which refuses to open otherwise.
   */
  readOnlyReasons: readonly ReadOnlyReason[];
  /** The writer wrote space.json again from the database. */
  manifestRebuilt: boolean;
}

/**
 * What tests inject. Not part of the package's interface: index.ts exports createSpace and
 * openSpace, which use the defaults.
 */
export interface SpaceSeams {
  /** The file calls for space.json and cleanup. Default: node:fs. */
  io?: FileIo;
  /** Runs between open's inspection and the writer's open. */
  betweenPhases?: () => void;
  /** The registered schema steps. Default: SCHEMA_STEPS. Tests pass stand-in steps (M1.06). */
  steps?: readonly SchemaStep[];
  /**
   * Read-only reasons that do not refuse this writer, because the opener resolves them before
   * anything else writes: `older_revision` for the migration runner (migrate/runner.ts), and
   * `read_only_copy` too for a claim (restore/claim.ts). Every other refusal stands. The writer's
   * OpenedSpace lists the allowed reasons it found, so the write path refuses to attach to it until
   * the opener resolved them (write/writer.ts).
   */
  allow?: readonly ReadOnlyReason[];
}

const notFound = (what: string): StorageError =>
  new StorageError("SPACE_NOT_FOUND", `No space found: ${what}`);

const isDirectory = (path: string): boolean =>
  fsCall(() => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true);

function checkAppVersion(value: string | undefined): string {
  const version = value ?? SOURCE_APP_VERSION;
  if (!isAppVersion(version)) throw misuse("An app version is major.minor.patch");
  return version;
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Renames the staging folder into place. On Windows a scanner can hold a file of a folder that
 * was just closed for a moment, so a sharing failure is retried for about half a second.
 */
function moveIntoPlace(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = errnoCode(error);
      if (existsSync(to)) throw new StorageError("SPACE_EXISTS", "A space folder is already there");
      const sharing = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (process.platform === "win32" && sharing && attempt < 20) {
        sleepSync(25);
        continue;
      }
      throw fsError(error);
    }
  }
}

/** Creates a space folder at `folder`, whose name is the space's slug. */
export function createSpace(
  checked: CheckedDriver,
  folder: string,
  options: CreateSpaceOptions,
): CreatedSpace {
  return createSpaceWith(checked, folder, options, {});
}

/** createSpace with test seams. */
export function createSpaceWith(
  checked: CheckedDriver,
  folder: string,
  options: CreateSpaceOptions,
  seams: SpaceSeams,
): CreatedSpace {
  const io = seams.io ?? NODE_IO;
  const dir = checkSpacePath(folder);
  const appVersion = checkAppVersion(options.appVersion);
  const { name, ownerLabel, machineId } = options;
  if (!isSpaceName(name)) throw misuse("A space name is one line of 1 to 100 characters");
  if (!isSpaceName(ownerLabel)) throw misuse("An actor label is one line of 1 to 100 characters");
  if (!isId(machineId, "m")) throw misuse("The machine ID is not an m_ ID");
  const refPrefix = options.refPrefix ?? defaultRefPrefix(name, options.takenPrefixes);
  if (!REF_PREFIX.test(refPrefix)) throw misuse("A reference prefix is 1 to 6 upper-case letters");
  const now = (options.now ?? Date.now)();
  if (!inRange(now, "instant")) throw misuse("The clock gave an instant outside its range");
  const random = options.random ?? osRandom;
  // The steps the space is built with: this build's, or a test's chain (an older revision's, to
  // build the fixture of a released revision, or one with stand-in steps).
  const steps = options.tree === true ? [TREE_STEP] : (seams.steps ?? SCHEMA_STEPS);
  const last = steps.at(-1);
  if (last === undefined) throw misuse("No schema step is registered");

  const parent = dirname(dir);
  if (!isDirectory(parent)) throw notFound("the folder for spaces does not exist");
  if (existsSync(dir)) throw new StorageError("SPACE_EXISTS", "A space folder is already there");

  const staging = join(parent, `.${basename(dir)}.creating-${temporaryTag()}`);
  fsCall(() => {
    makeDirExact(staging, FOLDER_MODE);
  });
  let conn: Connection | undefined;
  try {
    // The file exists before SQLite opens it, so it is owner-only from the first byte. SQLite gives
    // its -wal and -shm files the same permissions.
    const dbPath = join(staging, DATABASE_FILE);
    fsCall(() => {
      createEmptyFile(dbPath, FILE_MODE);
    });
    const db = openWriter(checked, dbPath, { formatPragmas: [AUTO_VACUUM_INCREMENTAL] });
    conn = db;
    const ids = {
      space: newId("sp", random),
      incarnation: newId("ai", random),
      human: newId("ac", random),
      system: newId("ac", random),
    };
    const lineage: Lineage = {
      forked_from: null,
      incarnations: [
        {
          incarnation: ids.incarnation,
          epoch: 1,
          kind: "create",
          parent: null,
          machine_id: machineId,
          at: now,
        },
      ],
    };
    db.transaction("immediate", () => {
      db.pragma("application_id", APP_ID);
      let current = 0;
      for (const step of steps) {
        if (step.from !== current) throw misuse("The schema steps do not form a chain");
        step.up(db);
        step.verify(db);
        current = encodeRevision(step.revision);
        db.pragma("user_version", current);
      }
      db.prepare(
        `INSERT INTO space (one, space_id, name, ref_prefix, format_major, format_minor,
           last_seq, next_ref, authority_machine, authority_epoch, authority_incarnation,
           authority_since, lineage, transfer, undo_floor_seq, created_at)
         VALUES (1, $space_id, $name, $ref_prefix, $format_major, $format_minor,
           0, 1, $machine, 1, $incarnation, 0, $lineage, NULL, 0, $now)`,
      ).run({
        space_id: ids.space,
        name,
        ref_prefix: refPrefix,
        format_major: last.format.major,
        format_minor: last.format.minor,
        machine: machineId,
        incarnation: ids.incarnation,
        lineage: JSON.stringify(lineage),
        now,
      });
      const actor = db.prepare(
        "INSERT INTO actors (id, kind, label, instance_id, routine_id, created_at) " +
          "VALUES ($id, $kind, $label, NULL, NULL, $now)",
      );
      actor.run({ id: ids.human, kind: "human", label: ownerLabel, now });
      actor.run({ id: ids.system, kind: "system", label: SYSTEM_LABEL, now });
      if (options.tree === true) {
        seedTreeRoot(
          db,
          {
            spaceId: ids.space,
            name,
            system: ids.system,
            incarnation: ids.incarnation,
            machineId,
            at: now,
          },
          random,
        );
      }
    });
    if (db.pragma("application_id") !== APP_ID || db.pragma("auto_vacuum") !== 2) {
      throw new StorageError("STORAGE_UNSUPPORTED", "The new database did not keep its format");
    }
    const space = decodeSpaceRow(db.prepare("SELECT * FROM space WHERE one = 1").get());
    db.close();
    conn = undefined;
    const manifest = manifestFor(space, last, appVersion);
    writeManifest(staging, manifest, io);
    moveIntoPlace(staging, dir);
    fsyncFolder(parent);
    return { folder: dir, space, actors: { human: ids.human, system: ids.system }, manifest };
  } catch (error) {
    // Cleanup never replaces the error that got us here, and its own errors carry paths. A
    // staging folder that cannot be removed stays for M1.10's cleanup, which finds it by its name.
    if (conn !== undefined) closeQuietly(conn);
    removeQuietly(staging, io);
    throw error;
  }
}

/** What inspection found in the database, read in one read transaction. */
interface DatabaseFacts {
  userVersion: number;
  revision: Revision;
  /** The registered step that produced the revision. Undefined for a revision newer than this build. */
  step: SchemaStep | undefined;
  /** The steps from the revision to this build's latest. Empty when current or newer. */
  pending: readonly SchemaStep[];
  space: SpaceRow;
}

const sameFormat = (a: SpaceFormat | undefined, b: SpaceFormat): boolean =>
  a !== undefined && a.major === b.major && a.minor === b.minor;

/**
 * Reads and checks the database's identity on `conn`, in one read transaction: the
 * application_id, the schema revision, the space row, and for a revision this build knows, the
 * row's format against the registered step's. Writes nothing.
 */
function inspectDatabase(conn: Connection, steps: readonly SchemaStep[]): DatabaseFacts {
  return conn.transaction("deferred", () => {
    if (conn.pragma("application_id") !== APP_ID) {
      throw new StorageError("SPACE_INVALID", "The database is not a space database");
    }
    const userVersion = conn.pragma("user_version");
    const revision = decodeRevision(userVersion);
    if (revision === undefined || typeof userVersion !== "number") {
      throw new StorageError("SPACE_VERSION_UNKNOWN", "The database has no schema revision");
    }
    // A revision a registered step produced, newer than every step, or one this build never had.
    // An older known revision opens for a reader, and for the migration runner's writer.
    // A tree space's database is built by the tree's step, outside the chain until the switch.
    const position = stepPosition(
      userVersion === TREE_USER_VERSION ? [TREE_STEP] : steps,
      userVersion,
    );
    if (position.state === "unknown") {
      throw new StorageError("SPACE_VERSION_UNKNOWN", "The schema revision is unknown");
    }
    const step = position.state === "known" ? position.step : undefined;
    const pending = position.state === "known" ? position.pending : [];
    let row: Row | undefined;
    try {
      row = conn.prepare("SELECT * FROM space WHERE one = 1").get();
    } catch (error) {
      if (error instanceof StorageError && error.code === "STORAGE_SQL") {
        throw new StorageError("SPACE_INVALID", "The database has no readable space table");
      }
      throw error;
    }
    const space = decodeSpaceRow(row);
    // The database's own format must be what its revision's step registered. The database holds
    // no min_reader or min_writer: those come from the step.
    if (step !== undefined && !sameFormat(step.format, space.format)) {
      throw new StorageError(
        "SPACE_INVALID",
        "The space format does not match its schema revision",
      );
    }
    return { userVersion, revision, step, pending, space };
  });
}

/**
 * The verdict of inspection: the read-only reasons, or a refusal for both roles. A writer opens
 * only when there are no reasons.
 */
function judge(read: ManifestRead, facts: DatabaseFacts, appVersion: string): ReadOnlyReason[] {
  const present = read.state === "present" ? read : undefined;
  const safety = present?.safety ?? {};
  const reasons: ReadOnlyReason[] = [];
  if (facts.step === undefined) {
    // A newer schema is read only with a manifest that vouches for it: undamaged, naming this
    // space and the database's format, with a min_reader this build meets (checked before SQLite
    // opened). A stale manifest's min_reader speaks for an older format.
    if (
      present === undefined ||
      present.damaged ||
      safety.space_id !== facts.space.spaceId ||
      !sameFormat(safety.format, facts.space.format)
    ) {
      throw new StorageError("SPACE_TOO_NEW", "The schema is newer than this build reads");
    }
    reasons.push("newer_revision");
  }
  if (safety.space_id !== undefined && safety.space_id !== facts.space.spaceId) {
    reasons.push("space_id_mismatch");
  }
  if (present?.damaged === true) reasons.push("manifest_damaged");
  if (safety.min_writer !== undefined && compareAppVersions(appVersion, safety.min_writer) < 0) {
    reasons.push("newer_writer");
  }
  if (facts.space.transfer !== null) reasons.push("read_only_copy");
  if (facts.pending.length > 0) reasons.push("older_revision");
  return reasons;
}

const tooNewToWrite = (): StorageError =>
  new StorageError("SPACE_TOO_NEW", "This space needs a newer app version to write it");

/**
 * Every read-only reason's refusal of the writer, in the order the person must fix them. The type
 * makes it complete: a new reason does not compile without its refusal here, so no reason can let
 * a writer in by being forgotten.
 */
const WRITER_REFUSALS: { readonly [R in ReadOnlyReason]: () => StorageError } = {
  space_id_mismatch: () => new StorageError("SPACE_ID_MISMATCH", "space.json names another space"),
  manifest_damaged: () =>
    new StorageError("SPACE_MANIFEST_DAMAGED", "space.json is damaged: repair or remove it"),
  newer_revision: tooNewToWrite,
  newer_writer: tooNewToWrite,
  read_only_copy: () =>
    new StorageError(
      "SPACE_READ_ONLY_COPY",
      "This space is a restored copy and opens read-only until it is claimed",
    ),
  older_revision: () =>
    new StorageError("SPACE_NEEDS_MIGRATION", "The space's schema needs a migration"),
};

/**
 * The writer's refusal for the first reason, in order of what the person must fix first, leaving
 * out the reasons its opener allowed (SpaceSeams.allow).
 */
function writerRefusal(
  reasons: readonly ReadOnlyReason[],
  allow: readonly ReadOnlyReason[],
): StorageError | undefined {
  for (const reason of Object.keys(WRITER_REFUSALS) as ReadOnlyReason[]) {
    if (!reasons.includes(reason) || allow.includes(reason)) continue;
    return WRITER_REFUSALS[reason]();
  }
  return undefined;
}

/** The reasons an opener may allow: each is resolved by the opener before anything writes. */
const ALLOWABLE: readonly ReadOnlyReason[] = ["read_only_copy", "older_revision"];

function checkAllow(allow: readonly ReadOnlyReason[] | undefined): readonly ReadOnlyReason[] {
  const list = allow ?? [];
  if (list.some((reason) => !ALLOWABLE.includes(reason))) {
    throw misuse("Only a read-only copy and an older revision can be allowed to a writer");
  }
  return list;
}

/** The refusals space.json decides alone, before SQLite opens the database (A1 3.1, 3.17). */
function manifestRefusal(read: ManifestRead, appVersion: string): StorageError | undefined {
  if (read.state === "newer") {
    return new StorageError("SPACE_TOO_NEW", "space.json has a newer format than this build reads");
  }
  const minReader = read.state === "present" ? read.safety.min_reader : undefined;
  if (minReader !== undefined && compareAppVersions(appVersion, minReader) < 0) {
    return new StorageError("SPACE_TOO_NEW", "This space needs a newer app version to read it");
  }
  return undefined;
}

/** What judgeAsWriter accepted. */
export interface WriterVerdict {
  space: SpaceRow;
  revision: Revision;
  /** The registered step that produced the revision. */
  step: SchemaStep;
}

/**
 * Judges the database file `dbPath` as phase 1 of a writer's open judges a space, beside the
 * space.json that `read` holds: the same refusals in the same order, leaving out the reasons in
 * `allow` as a writer opened with them does. Opens the file read-only, writes nothing, and closes
 * it. Recovery (restore/recover.ts) judges its private copy against the live space.json with this,
 * so it can never accept a space that open refuses for a reason other than the journal.
 */
export function judgeAsWriter(
  checked: CheckedDriver,
  dbPath: string,
  read: ManifestRead,
  options: {
    appVersion?: string;
    busyTimeoutMs?: number;
    steps?: readonly SchemaStep[];
    allow?: readonly ReadOnlyReason[];
  },
): WriterVerdict {
  const appVersion = checkAppVersion(options.appVersion);
  const allow = checkAllow(options.allow);
  const early = manifestRefusal(read, appVersion);
  if (early !== undefined) throw early;
  checkFilesBeforeSqlite(dbPath);
  const timeout =
    options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs };
  const probe = openReader(checked, dbPath, timeout);
  try {
    const facts = inspectDatabase(probe, options.steps ?? SCHEMA_STEPS);
    const refusal = writerRefusal(judge(read, facts, appVersion), allow);
    if (refusal !== undefined) throw refusal;
    // A newer revision is the reason newer_revision, refused above.
    if (facts.step === undefined) throw misuse("A writer's judgement accepted a newer schema");
    return { space: facts.space, revision: facts.revision, step: facts.step };
  } finally {
    closeQuietly(probe);
  }
}

const sameRead = (a: ManifestRead, b: ManifestRead): boolean =>
  a.state === b.state && (a.state !== "present" || (b.state === "present" && a.text === b.text));

/**
 * What the file system shows about the database, checked before SQLite reads it, in each phase.
 * SQLite acts on these files at a connection's first read, before open could refuse anything.
 * - A rollback journal. A space database is created in WAL mode and stays there, so a
 *   space.db-journal beside it never belongs to a healthy space. At the first read, a writable
 *   connection plays a hot one back into the file and removes it, and a read-only connection
 *   fails on it. Any entry by that name is refused, an empty or cold one too. Recovery is M1.06's.
 * - An empty database file. A space database never is one: create writes its header. At the first
 *   read SQLite deletes a -wal beside an empty file, on a read-only connection too.
 * SQLite reaches a super-journal only through a rollback journal, so the first check covers it. A
 * -wal beside a database with content is read as that database's: at the first read SQLite
 * rebuilds the -shm from it and writes nothing else, which is what a crashed space's own -wal
 * needs.
 */
function checkFilesBeforeSqlite(dbPath: string): void {
  if (fsCall(() => lstatSync(`${dbPath}-journal`, { throwIfNoEntry: false })) !== undefined) {
    throw new StorageError(
      "SPACE_NEEDS_RECOVERY",
      "The space's database has a rollback journal beside it and needs recovery",
    );
  }
  const db = fsCall(() => statSync(dbPath, { throwIfNoEntry: false }));
  if (db === undefined) throw notFound("the folder has no database");
  if (db.size === 0) throw new StorageError("SPACE_INVALID", "The database file is empty");
}

/** Opens a space folder as its writer or as a reader. The caller closes `conn`. */
export function openSpace(
  checked: CheckedDriver,
  folder: string,
  options: OpenSpaceOptions,
): OpenedSpace {
  return openSpaceWith(checked, folder, options, {});
}

/** openSpace with test seams. */
export function openSpaceWith(
  checked: CheckedDriver,
  folder: string,
  options: OpenSpaceOptions,
  seams: SpaceSeams,
): OpenedSpace {
  const found = inspectSpace(checked, folder, options, seams);
  if (found.role === "writer") return beginWriter(checked, found, seams).finish();
  return {
    folder: found.dir,
    role: "reader",
    conn: found.probe,
    space: found.facts.space,
    revision: found.facts.revision,
    readOnlyReasons: found.reasons,
    manifestRebuilt: false,
  };
}

/**
 * A space's writer between SQLite's open of its database and the first statement on that
 * connection: nothing has run on it. A storage worker stops here to take the identity of the file
 * SQLite opened, and goes on only once its process's claim holds that file (worker/client.ts).
 */
export interface SpaceWriterOpening {
  /** The path SQLite opened the database by. */
  readonly dbPath: string;
  /** The space ID phase 1 read from the database. Phase 2 refuses another (SPACE_CHANGED). */
  readonly spaceId: Id<"sp">;
  /**
   * Phase 2: the inspection hook, the writer's pragmas and space.json. A refusal or failure
   * closes the connection.
   */
  finish(): OpenedSpace;
  /** Closes the connection unused. */
  abandon(): void;
}

/**
 * openSpace as the writer, up to SQLite's open of the database in phase 2. `allow` and `steps` are
 * SpaceSeams' (the storage worker's writer allows `older_revision` and migrates first, a claim
 * allows `read_only_copy` too).
 */
export function beginSpaceWriter(
  checked: CheckedDriver,
  folder: string,
  options: Omit<OpenSpaceOptions, "role">,
  extra: Pick<SpaceSeams, "allow" | "steps"> = {},
): SpaceWriterOpening {
  const seams: SpaceSeams = {
    ...(extra.allow === undefined ? {} : { allow: extra.allow }),
    ...(extra.steps === undefined ? {} : { steps: extra.steps }),
  };
  return beginWriter(
    checked,
    inspectSpace(checked, folder, { ...options, role: "writer" }, seams),
    seams,
  );
}

/** What phase 1 found. `probe` is its read-only connection, still open. */
interface Inspection {
  role: Role;
  dir: string;
  dbPath: string;
  io: FileIo;
  appVersion: string;
  timeout: { busyTimeoutMs?: number };
  steps: readonly SchemaStep[];
  read: ManifestRead;
  facts: DatabaseFacts;
  reasons: ReadOnlyReason[];
  probe: Connection;
}

/** The checks before SQLite, then phase 1 on a read-only connection, which stays open. */
function inspectSpace(
  checked: CheckedDriver,
  folder: string,
  options: OpenSpaceOptions,
  seams: SpaceSeams,
): Inspection {
  const io = seams.io ?? NODE_IO;
  const steps = seams.steps ?? SCHEMA_STEPS;
  const dir = checkSpacePath(folder);
  const appVersion = checkAppVersion(options.appVersion);
  const { role } = options;
  // The role can come from another thread, so it is checked at run time too.
  if (!(["writer", "reader"] as const).includes(role)) {
    throw misuse("A space opens as writer or reader");
  }
  if (!isDirectory(dir)) throw notFound("the folder does not exist");
  const dbPath = join(dir, DATABASE_FILE);
  if (!fsCall(() => existsSync(dbPath))) throw notFound("the folder has no database");
  const timeout =
    options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs };

  // Phase 1, inspection. space.json first: a newer format is refused before SQLite opens the file
  // (A1 3.1, 3.17), and so is a valid min_reader above this build, whatever else the file holds.
  const read = readManifest(dir, io);
  const early = manifestRefusal(read, appVersion);
  if (early !== undefined) throw early;
  checkFilesBeforeSqlite(dbPath);
  const probe = openReader(checked, dbPath, timeout);
  try {
    const facts = inspectDatabase(probe, steps);
    const reasons = judge(read, facts, appVersion);
    return { role, dir, dbPath, io, appVersion, timeout, steps, read, facts, reasons, probe };
  } catch (error) {
    closeQuietly(probe);
    throw error;
  }
}

/** Refuses or closes phase 1, then opens the writer's connection: phase 2 up to SQLite's open. */
function beginWriter(
  checked: CheckedDriver,
  found: Inspection,
  seams: SpaceSeams,
): SpaceWriterOpening {
  const { dir, dbPath, io, appVersion, steps, read, facts, probe } = found;
  let allow: readonly ReadOnlyReason[];
  try {
    allow = checkAllow(seams.allow);
    const refusal = writerRefusal(found.reasons, allow);
    if (refusal !== undefined) throw refusal;
  } catch (error) {
    closeQuietly(probe);
    throw error;
  }
  probe.close();
  seams.betweenPhases?.();

  // Phase 2, the writer. Every refusal of this phase is decided in the inspection hook, before
  // journal_mode=WAL: first what the file system shows, then the first read on this connection.
  // The file-system checks come last before that read, to keep the window between them short.
  const seen: { facts?: DatabaseFacts; step?: SchemaStep; reasons?: ReadOnlyReason[] } = {};
  const settings = {
    ...found.timeout,
    inspect: (c: Connection) => {
      if (!sameRead(readManifest(dir, io), read)) {
        throw new StorageError("SPACE_CHANGED", "space.json changed while the space was opening");
      }
      checkFilesBeforeSqlite(dbPath);
      const again = inspectDatabase(c, steps);
      if (again.userVersion !== facts.userVersion || again.space.spaceId !== facts.space.spaceId) {
        throw new StorageError("SPACE_CHANGED", "The space changed while it was opening");
      }
      // Phase 1 refused a newer revision, and the revision is the same.
      if (again.step === undefined) throw misuse("A writer opened a newer schema");
      // The database's own reasons on this connection: a mark that appeared since phase 1, such
      // as a read-only copy's, refuses here too.
      const reasons = judge(read, again, appVersion);
      const refusal = writerRefusal(reasons, allow);
      if (refusal !== undefined) throw refusal;
      seen.facts = again;
      seen.step = again.step;
      seen.reasons = reasons;
    },
  };
  const conn = openUnconfigured(checked, dbPath, "writer", settings);
  let state: "open" | "finished" | "closed" = "open";
  return {
    dbPath,
    spaceId: facts.space.spaceId,
    finish: () => {
      if (state !== "open") throw misuse("This writer's open has already finished or closed");
      state = "finished";
      configureConnection(conn, "writer", settings);
      try {
        const { facts: again, step, reasons } = seen;
        if (again === undefined || step === undefined || reasons === undefined) {
          throw misuse("The writer opened without its inspection");
        }
        const { space } = again;
        // The writer meets every safety field here, so the database wins on the rest (A1 3.1): a
        // missing manifest, an invalid description or a stale value is rebuilt from it.
        const current = read.state === "present" ? read.manifest : undefined;
        const fresh = manifestFor(space, step, appVersion);
        let manifestRebuilt = false;
        if (current === undefined || !sameManifest(current, fresh)) {
          writeManifest(dir, fresh, io);
          manifestRebuilt = true;
        }
        return {
          folder: dir,
          role: "writer",
          conn,
          space,
          revision: again.revision,
          // Only reasons the opener allowed are left: it resolves them before anything writes.
          readOnlyReasons: reasons,
          manifestRebuilt,
        };
      } catch (error) {
        closeQuietly(conn);
        throw error;
      }
    },
    abandon: () => {
      if (state !== "open") return;
      state = "closed";
      closeQuietly(conn);
    },
  };
}

/** Closes a connection on the way out with an error, which stays the one thrown. */
function closeQuietly(conn: Connection): void {
  try {
    conn.close();
  } catch {
    // The first error explains what went wrong.
  }
}
