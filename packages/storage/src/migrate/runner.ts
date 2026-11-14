// The migration runner on PRAGMA user_version (A1 3.17), behind the barrier backup of A1 3.18.
//
// Where it runs. A space is migrated only by its own writer, before that writer takes any request:
// the storage worker's openSpaceWriter (worker/client.ts, worker/host.ts) claims the space for its
// process, opens the writer, and when the space's revision is older than the build's, runs
// migrateOpened on that writer's connection before it attaches the write path. So a migration
// never runs beside the space's writer, and M1.08's hub has one call that opens a space for writing
// and migrates it first. migrateSpace opens its own writer in the calling thread, without a claim,
// as openSpace does: for tests and tools that work on a closed space.
//
// When a space's revision is older than the build's latest:
// 1. The runner notes PRAGMA data_version on the writer's connection, then takes the barrier backup
//    through a separate read-only connection and verifies it. If that fails, nothing starts: the
//    outcome is `failed` at the `backup` stage with BACKUP_FAILED, and the space stays as it was.
// 2. PRAGMA foreign_keys = OFF (it cannot change inside a transaction), then BEGIN IMMEDIATE. Inside,
//    the runner first proves the backup is the state it is about to change: data_version is as
//    noted (no other connection committed since before the snapshot), and user_version, last_seq,
//    the space ID and the incarnation equal the sidecar's. Otherwise SPACE_CHANGED, and nothing ran.
// 3. Each pending step in order: its `up`, its `verify`, one system commit (kind `migration`,
//    origin `migration`, written by the writer's writeSystemCommit), the space row's format,
//    undo_floor_seq when the step sets `undoFloor`, and user_version. A step's `verify` runs right
//    after its own `up`, because it checks the schema that step promises, which a later step may
//    extend.
// 4. PRAGMA foreign_key_check (no row), integrity_check ("ok") and the domain invariants (the space
//    row decodes, its format is the last step's, last_seq is the newest commit). Any failure rolls
//    the whole transaction back: the space stays at its revision, MIGRATION_FAILED.
// 5. COMMIT, foreign_keys = ON, and space.json rewritten for the new revision. If that rewrite
//    fails, the space is migrated anyway and the next writer's open rebuilds space.json (A1 3.1).
//
// Every attempt takes its own barrier backup: the runner never lists, reuses or removes one. A
// failure's error carries the state it was tried on (`attempt`: the revisions, epoch, incarnation,
// last_seq and the backup's name), so the service can leave that state alone until something that
// could change the outcome has changed (A1 3.17).
//
// All steps share one transaction, so a crash at any point inside it leaves the old revision: WAL
// frames of an uncommitted transaction are never read. A crash after COMMIT leaves the new revision
// with a stale space.json, which the next writer rebuilds and a reader reads past. The barrier
// backup's own crash windows are in backup/backup.ts.
import { SCHEMA_STEPS } from "../../migrations/index.ts";
import { backupSpaceWith, type BackupRecord, type BackupSeams } from "../backup/backup.ts";
import type { Connection } from "../driver.ts";
import { misuse, StorageError, type MigrationAttempt } from "../errors.ts";
import { osRandom, type RandomSource } from "../ids.ts";
import { manifestFor, writeManifest } from "../manifest.ts";
import { decodeSpaceRow, inRange } from "../rows.ts";
import {
  decodeRevision,
  encodeRevision,
  formatRevision,
  type Revision,
  type SchemaStep,
} from "../schema.ts";
import { openSpaceWith, SOURCE_APP_VERSION, type OpenedSpace } from "../space.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { writeSystemCommit } from "../write/writer.ts";
import { stepPosition } from "./steps.ts";

export interface MigrateOptions {
  appVersion?: string;
  busyTimeoutMs?: number;
  /** Where the barrier backup goes. Default: the space's backups folder. */
  backupDir?: string;
  /** Milliseconds since 1970. Default: Date.now. */
  now?: () => number;
  /** The source of commit IDs. Default: the OS. */
  random?: RandomSource;
}

/** The points M1.07's crash harness kills at. Tests also throw there. */
export type MigrationPoint =
  /** The barrier backup is complete and verified. Nothing has started. */
  | "backed-up"
  /** A step's `up`, `verify` and commit ran, inside the transaction. */
  | "step-applied"
  /** Every check passed, just before COMMIT. */
  | "checked"
  /** COMMIT returned. space.json is not rewritten yet. A throw here is not a failed migration. */
  | "committed";

/** What tests inject. Not part of the package's interface. */
export interface MigrateSeams {
  /** The registered schema steps. Default: SCHEMA_STEPS. Tests pass stand-in steps. */
  steps?: readonly SchemaStep[];
  backup?: BackupSeams;
  at?: (point: MigrationPoint, step?: SchemaStep) => void;
}

export type MigrationOutcome =
  /** The space was at the latest revision already. */
  | { state: "current"; revision: Revision }
  | {
      state: "migrated";
      from: Revision;
      to: Revision;
      backup: BackupRecord;
      /** The seq of each step's system commit, in order. */
      seqs: number[];
      /** False when space.json could not be rewritten: the next writer's open does it. */
      manifestWritten: boolean;
    }
  | {
      state: "failed";
      /** `backup`: the barrier backup failed and nothing started. `migration`: rolled back. */
      stage: "backup" | "migration";
      from: Revision;
      to: Revision;
      /**
       * BACKUP_FAILED, BUNDLE_LIMIT_EXCEEDED, MIGRATION_FAILED or SPACE_CHANGED. Its message names
       * both revisions, the cause's code and, after the backup, the barrier backup's name (A1
       * 3.17), never a path.
       */
      error: StorageError;
      /** The verified barrier backup, when it was taken. */
      backup: BackupRecord | undefined;
    };

const causeOf = (error: unknown): string =>
  error instanceof StorageError ? error.code : "an unexpected error";

/**
 * Moves the space at `folder` to the build's latest schema revision, behind a verified barrier
 * backup, on a writer it opens in this thread (for tests and tools: the service migrates through
 * the storage worker's openSpaceWriter). Refusals of the open itself (a missing folder, a damaged
 * space.json, a newer space, a read-only copy) are thrown as open throws them. A failure of the
 * backup or of a step is the outcome `failed`.
 */
export async function migrateSpace(
  checked: CheckedDriver,
  folder: string,
  options: MigrateOptions = {},
): Promise<MigrationOutcome> {
  return migrateSpaceWith(checked, folder, options, {});
}

/** migrateSpace with test seams. */
export async function migrateSpaceWith(
  checked: CheckedDriver,
  folder: string,
  options: MigrateOptions,
  seams: MigrateSeams,
): Promise<MigrationOutcome> {
  const opened = openSpaceWith(
    checked,
    folder,
    {
      role: "writer",
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    },
    { ...(seams.steps === undefined ? {} : { steps: seams.steps }), allow: ["older_revision"] },
  );
  try {
    return await migrateOpened(checked, opened, options, seams);
  } finally {
    opened.conn.close();
  }
}

/**
 * Migrates the space that `opened` holds as its writer, on that writer's connection, which stays
 * open: the caller owns it. `opened` is the writer's open of the space with the reason
 * `older_revision` allowed (space.ts), and nothing else may write through the connection while
 * this runs. The storage worker calls this before it attaches the write path.
 */
export async function migrateOpened(
  checked: CheckedDriver,
  opened: OpenedSpace,
  options: MigrateOptions,
  seams: MigrateSeams,
): Promise<MigrationOutcome> {
  if (opened.role !== "writer") throw misuse("A space is migrated by its writer");
  const steps = seams.steps ?? SCHEMA_STEPS;
  const appVersion = options.appVersion ?? SOURCE_APP_VERSION;
  const now = options.now ?? Date.now;
  const random = options.random ?? osRandom;
  const { conn } = opened;
  const position = stepPosition(steps, encodeRevision(opened.revision));
  if (position.state !== "known") throw misuse("The writer opened a revision it does not know");
  const last = position.pending.at(-1);
  if (last === undefined) return { state: "current", revision: opened.revision };
  const from = opened.revision;
  const to = last.revision;
  const stays = `The space stays at ${formatRevision(from)}`;
  // The state this attempt is tried on, read by the writer's open under the space's lock: a failure
  // reports it, so the caller can tell a later open on the same state (A1 3.17).
  const attempt = (backup?: BackupRecord): MigrationAttempt => ({
    from: encodeRevision(from),
    to: encodeRevision(to),
    epoch: opened.space.authority.epoch,
    incarnation: opened.space.authority.incarnation,
    lastSeq: opened.space.lastSeq,
    ...(backup === undefined ? {} : { backup: backup.name }),
  });

  // Another connection's commit after this point changes data_version (checked inside BEGIN).
  const dataVersion = conn.pragma("data_version");
  let backup: BackupRecord;
  try {
    backup = await backupSpaceWith(
      checked,
      opened.folder,
      {
        kind: "pre-migrate",
        appVersion,
        now,
        ...(options.backupDir === undefined ? {} : { backupDir: options.backupDir }),
        ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
      },
      { ...seams.backup, steps },
    );
  } catch (error) {
    const code =
      error instanceof StorageError && error.code === "BUNDLE_LIMIT_EXCEEDED"
        ? "BUNDLE_LIMIT_EXCEEDED"
        : "BACKUP_FAILED";
    // A StorageError's message names codes and limits, never a path or a value.
    const detail = error instanceof StorageError ? ` ${error.message}` : "";
    const failure = new StorageError(
      code,
      `The barrier backup before the migration to ${formatRevision(to)} failed, so nothing ` +
        `was migrated. ${stays}.${detail}`,
      { attempt: attempt() },
    );
    return { state: "failed", stage: "backup", from, to, error: failure, backup: undefined };
  }

  let seqs: number[];
  try {
    seams.at?.("backed-up");
    seqs = runSteps(conn, position.pending, {
      dataVersion,
      backup,
      now: now(),
      random,
      machine: opened.space.authority.machineId,
      at: seams.at,
    });
  } catch (error) {
    const changed = error instanceof StorageError && error.code === "SPACE_CHANGED";
    const failure = new StorageError(
      changed ? "SPACE_CHANGED" : "MIGRATION_FAILED",
      `${
        changed
          ? "The space changed after its barrier backup, so the migration did not start"
          : `Migration to ${formatRevision(to)} failed (${causeOf(error)}). Your data is unchanged`
      }. ${stays}. Backup: ${backup.name}`,
      { attempt: attempt(backup) },
    );
    return { state: "failed", stage: "migration", from, to, error: failure, backup };
  }
  // The database committed. A failure from here on is no failed migration: it throws, and the
  // owner closes the connection.
  foreignKeysOn(conn);
  seams.at?.("committed");

  // A failed rewrite of space.json is repaired by the next writer's open.
  let manifestWritten = true;
  try {
    const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
    writeManifest(opened.folder, manifestFor(space, last, appVersion));
  } catch {
    manifestWritten = false;
  }
  return { state: "migrated", from, to, backup, seqs, manifestWritten };
}

interface StepRun {
  dataVersion: unknown;
  backup: BackupRecord;
  now: number;
  random: RandomSource;
  machine: OpenedSpace["space"]["authority"]["machineId"];
  at: MigrateSeams["at"];
}

/** Runs the pending steps in one transaction (A1 3.17). Returns each commit's seq. */
function runSteps(conn: Connection, pending: readonly SchemaStep[], run: StepRun): number[] {
  conn.pragma("foreign_keys", "OFF");
  try {
    if (conn.pragma("foreign_keys") !== 0) {
      throw new StorageError("STORAGE_UNSUPPORTED", "PRAGMA foreign_keys did not turn off");
    }
    return conn.transaction("immediate", () => {
      const { sidecar } = run.backup;
      const start = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
      if (
        conn.pragma("data_version") !== run.dataVersion ||
        conn.pragma("user_version") !== sidecar.user_version ||
        start.lastSeq !== sidecar.seq ||
        start.spaceId !== sidecar.space_id ||
        start.authority.incarnation !== sidecar.incarnation
      ) {
        throw new StorageError("SPACE_CHANGED", "The space changed after its barrier backup");
      }
      const seqs: number[] = [];
      let current = sidecar.user_version;
      for (const step of pending) {
        if (step.from !== current) throw misuse("The schema steps do not form a chain");
        step.up(conn);
        step.verify(conn);
        const next = encodeRevision(step.revision);
        const { seq } = writeSystemCommit(conn, {
          kind: "migration",
          origin: "migration",
          // One migration to a revision per incarnation: a lower revision comes back only through a
          // restore, and a restore is claimed (a new incarnation) before anything writes to it.
          request: `migrate-${String(next)}-${start.authority.incarnation.slice(3)}`,
          ops: [
            {
              v: 1,
              op: "schema.migrate",
              target: start.spaceId,
              input: {
                step: step.id,
                from: formatRevision(decodeRevision(current) ?? { major: 0, minor: 0 }),
                to: formatRevision(step.revision),
              },
            },
          ],
          epoch: start.authority.epoch,
          incarnation: start.authority.incarnation,
          machine: run.machine,
          now: run.now,
          random: run.random,
        });
        conn
          .prepare("UPDATE space SET format_major = $major, format_minor = $minor WHERE one = 1")
          .run({ major: step.format.major, minor: step.format.minor });
        if (step.undoFloor) {
          conn.prepare("UPDATE space SET undo_floor_seq = $seq WHERE one = 1").run({ seq });
        }
        current = next;
        conn.pragma("user_version", current);
        seqs.push(seq);
        run.at?.("step-applied", step);
      }
      checkAfter(conn, pending, seqs);
      run.at?.("checked");
      return seqs;
    });
  } catch (error) {
    // Rolled back: the connection goes back to how the writer configured it.
    try {
      conn.pragma("foreign_keys", "ON");
    } catch {
      // The rollback's cause is the error to report. A connection that cannot take a pragma is
      // closed by its owner after a failed migration.
    }
    throw error;
  }
}

/** Foreign keys back on after COMMIT, before the writer takes requests on the connection. */
function foreignKeysOn(conn: Connection): void {
  conn.pragma("foreign_keys", "ON");
  if (conn.pragma("foreign_keys") !== 1) {
    throw new StorageError("STORAGE_UNSUPPORTED", "PRAGMA foreign_keys did not turn on");
  }
}

/** A1 3.17: the checks after every step ran, inside the transaction. */
function checkAfter(
  conn: Connection,
  pending: readonly SchemaStep[],
  seqs: readonly number[],
): void {
  const last = pending.at(-1);
  if (last === undefined) return;
  if (conn.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new StorageError("STORAGE_CONSTRAINT", "The migrated space breaks a foreign key");
  }
  if (conn.pragma("integrity_check") !== "ok") {
    throw new StorageError("STORAGE_CORRUPT", "The migrated space fails its integrity check");
  }
  const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
  const newest = conn.prepare("SELECT max(seq) AS seq FROM commits").get()?.["seq"];
  if (
    space.format.major !== last.format.major ||
    space.format.minor !== last.format.minor ||
    !inRange(newest, "seq") ||
    space.lastSeq !== newest ||
    space.lastSeq !== seqs.at(-1) ||
    conn.pragma("user_version") !== encodeRevision(last.revision)
  ) {
    throw new StorageError("SPACE_INVALID", "The migrated space breaks a domain invariant");
  }
}
