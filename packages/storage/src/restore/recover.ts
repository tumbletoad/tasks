// Recovering a space that open refuses with SPACE_NEEDS_RECOVERY (A1 3.18): a rollback
// journal (`space.db-journal`) lies beside its database. A space database is in WAL mode, so the
// journal comes from a crash while another tool had the database in a rollback mode, or from a
// stray file. Open refuses before SQLite could play it back into the live file.
//
// Recovery never touches the live files. It copies `space.db`, its journal and its `-wal` into a
// new folder next to the space, and opens the COPY read-write: at the first read SQLite plays a hot
// journal back into it (the copy returns to its last committed state), and ignores a cold or empty
// one. The copy is switched to WAL and passes integrity_check.
//
// Then the copy is judged against the LIVE space.json exactly as a writer's open judges the space
// (space.ts judgeAsWriter): the same refusals for space.json's safety fields (a newer format,
// min_reader, min_writer, the space ID, a damaged file), the revision and the format. Recovery is
// not a way around a refusal that has nothing to do with the journal: a gate stays a gate, and a
// damaged space.json stays the person's to repair (A1 3.1). Only an older known revision is
// accepted, as the storage worker's writer accepts it and migrates it behind its barrier backup,
// and a read-only copy, whose mark is in the database and so stays. Accepted, the copy gets the
// space.json its database implies, as a writer's open writes it.
//
// The copy's files are flushed, then the folder is swapped in for the live one exactly as a
// restore in place is (folders.ts). The live folder, journal and all, is kept as
// `<slug>.replaced-<utc>`. The space keeps its incarnation: this is its own last committed state,
// not an older copy, so there is nothing to claim.
//
// One writer per space (A1 3.9): the only writable connection is the playback's, on the
// private copy in the new staging folder, which is not a space yet. The swap moves the live folder,
// so the storage worker's recoverSpace (worker/client.ts) holds the space's claim for the whole
// recovery: a writer of this process that has the space open refuses it, and none opens meanwhile.
//
// If the copy does not verify or does not open, recovery fails and changes nothing: the way out is
// a restore in place from the newest backup (restoreInPlace), which works whatever the live folder
// holds.
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { misuse, StorageError } from "../errors.ts";
import { FOLDER_MODE, fsCall, fsyncFolder, makeDirExact, removeQuietly } from "../files.ts";
import {
  DATABASE_FILE,
  isAppVersion,
  manifestFor,
  readManifest,
  writeManifest,
} from "../manifest.ts";
import { inRange, type SpaceRow } from "../rows.ts";
import { APP_ID, type Revision, type SchemaStep } from "../schema.ts";
import { judgeAsWriter, SOURCE_APP_VERSION } from "../space.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { swapIntoPlace, swapNames, type SwapHooks, type SwapPoint } from "./folders.ts";

export interface RecoverOptions {
  appVersion?: string;
  busyTimeoutMs?: number;
  /** Milliseconds since 1970. Default: Date.now. */
  now?: () => number;
  /** The storage worker's checks around the swap's first rename (restore.ts). */
  swap?: SwapHooks;
}

/** The points M1.07's crash harness kills at. */
export type RecoverPoint = "recovered" | SwapPoint;

/** What tests inject. Not part of the package's interface. */
export interface RecoverSeams {
  steps?: readonly SchemaStep[];
  at?: (point: RecoverPoint) => void;
}

export interface RecoveredSpace {
  folder: string;
  space: SpaceRow;
  revision: Revision;
  /** The live folder's new name, `<slug>.replaced-<utc>`: the original files, journal included. */
  replaced: string;
  backupsCarried: boolean;
}

const isFile = (path: string): boolean =>
  fsCall(() => lstatSync(path, { throwIfNoEntry: false })?.isFile() === true);

/** Recovers the space at `folder` from the rollback journal beside its database. */
export function recoverSpace(
  checked: CheckedDriver,
  folder: string,
  options: RecoverOptions = {},
): RecoveredSpace {
  return recoverSpaceWith(checked, folder, options, {});
}

/** recoverSpace with test seams. */
export function recoverSpaceWith(
  checked: CheckedDriver,
  folder: string,
  options: RecoverOptions,
  seams: RecoverSeams,
): RecoveredSpace {
  const appVersion = options.appVersion ?? SOURCE_APP_VERSION;
  if (!isAppVersion(appVersion)) throw misuse("An app version is major.minor.patch");
  const now = (options.now ?? Date.now)();
  if (!inRange(now, "instant")) throw misuse("The clock gave an instant outside its range");
  const names = swapNames(folder, now);
  const db = join(names.live, DATABASE_FILE);
  if (fsCall(() => statSync(names.live, { throwIfNoEntry: false })?.isDirectory() !== true)) {
    throw new StorageError("SPACE_NOT_FOUND", "No space found: the folder does not exist");
  }
  if (!isFile(db))
    throw new StorageError("SPACE_NOT_FOUND", "No space found: the folder has no database");
  if (fsCall(() => lstatSync(`${db}-journal`, { throwIfNoEntry: false })) === undefined) {
    throw misuse("The space has no rollback journal to recover from");
  }
  // space.json as open reads it: the copy is judged against it.
  const read = readManifest(names.live);

  fsCall(() => {
    makeDirExact(names.staging, FOLDER_MODE);
  });
  try {
    const copy = join(names.staging, DATABASE_FILE);
    fsCall(() => {
      // New files in the new staging folder, never written over: nothing else can know them.
      copyFileSync(db, copy, constants.COPYFILE_EXCL);
      // A journal that is not a regular file (a folder by that name) is no journal SQLite reads.
      for (const suffix of ["-journal", "-wal"]) {
        if (isFile(`${db}${suffix}`)) {
          copyFileSync(`${db}${suffix}`, `${copy}${suffix}`, constants.COPYFILE_EXCL);
        }
      }
    });
    playBack(checked, copy, options.busyTimeoutMs);
    const { space, revision, step } = judgeAsWriter(checked, copy, read, {
      appVersion,
      // The journal is all recovery fixes. An older revision is migrated by the next writer's
      // open, and a read-only copy keeps its mark, which lives in the database.
      allow: ["older_revision", "read_only_copy"],
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
      ...(seams.steps === undefined ? {} : { steps: seams.steps }),
    });
    writeManifest(names.staging, manifestFor(space, step, appVersion));
    settle(names.staging);
    fsyncFolder(names.staging);
    seams.at?.("recovered");
    const swapped = swapIntoPlace(names, seams.at, options.swap);
    return {
      folder: names.live,
      space,
      revision,
      replaced: swapped.replaced,
      backupsCarried: swapped.backupsCarried,
    };
  } catch (error) {
    if (!(existsSync(names.replaced) && !existsSync(names.live))) removeQuietly(names.staging);
    throw error;
  }
}

/**
 * Opens the private copy read-write, so SQLite plays a hot journal back at the first read, and
 * puts it in WAL mode. Closing it, as the only connection, checkpoints and removes the -wal and
 * -shm. A cold journal SQLite left in place is removed: it is the copy's, and the space must not
 * keep one.
 */
function playBack(checked: CheckedDriver, copy: string, busyTimeoutMs = 5000): void {
  const conn = checked.driver.open(copy, { readOnly: false, busyTimeoutMs });
  try {
    if (conn.pragma("application_id") !== APP_ID) {
      throw new StorageError("SPACE_INVALID", "The database is not a space database");
    }
    if (conn.pragma("journal_mode", "WAL") !== "wal") {
      throw new StorageError("STORAGE_UNSUPPORTED", "The recovered copy did not take WAL mode");
    }
    if (conn.pragma("integrity_check") !== "ok") {
      throw new StorageError("STORAGE_CORRUPT", "The recovered copy fails its integrity check");
    }
  } finally {
    conn.close();
  }
  removeQuietly(`${copy}-journal`);
  if (isFile(`${copy}-journal`)) {
    throw new StorageError("STORAGE_CANT_OPEN", "The copy's journal could not be removed");
  }
}

/**
 * After the copy's last connection closed: the -shm and an empty -wal that the read-only judgement
 * left go, and the database is flushed to disk before the swap. copyFileSync does not flush, and
 * when nothing was played back SQLite wrote nothing it would flush itself. A -wal that still holds
 * frames stays beside the database: it is part of it. space.json was written atomically.
 */
function settle(staging: string): void {
  const copy = join(staging, DATABASE_FILE);
  removeQuietly(`${copy}-shm`);
  if (fsCall(() => statSync(`${copy}-wal`, { throwIfNoEntry: false })?.size) === 0) {
    removeQuietly(`${copy}-wal`);
  }
  for (const path of [copy, `${copy}-wal`]) {
    if (!isFile(path)) continue;
    fsCall(() => {
      // Read and write: Windows flushes a file only through a handle that may write it.
      const fd = openSync(path, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    });
  }
}
