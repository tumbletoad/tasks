// Restoring a backup or an export bundle (A1 3.18, `tasks space restore <backup>` in M1.10), into
// a new folder or in place. Both build the restored folder complete and verified next to its final
// place first (unpack.ts), so a restore never exposes a half-built space under a space's name. A
// bundle restores as a backup does, whatever its mode: what a transfer or a fork bundle becomes on
// import is M3.08's, and until then a bundle restored into a new folder is a read-only copy too.
//
// Into a new folder: the copy keeps the backup's identity (space ID, epoch, incarnation), so it is
// a READ-ONLY COPY (A1 3.18 "Restore" step 3, A6 3.5): before the folder takes its name, the copy's
// database is marked in `space.transfer` (mark.ts), and every open of it is then read-only
// with the reason `read_only_copy` until it is claimed (claim.ts, through the storage worker's
// claimSpace), which gives it a new epoch and incarnation and clears the mark in one transaction.
// The mark is in the database, so it survives a copy of the folder or of the database alone, and
// space.json, which only describes the database, cannot remove it. Without it, two folders on one
// machine could write under one authority. The live space, if any, is not touched.
//
// VERIFIED MEANS A TRIAL RESTORE (A1 3.18). A backup is verified when restoreCopy, the restore's
// own steps up to and with its first write (unpack with every check, then the read-only mark), ran
// to its end on a scratch copy (verifyBackupFile). There is no second checker to drift from what a
// restore does: retention keeps the newest backup verified this way (backup/retention.ts), and
// `restore latest` restores its candidates directly (rescue.ts).
//
// In place (disaster recovery): the restored copy is claimed in its staging folder first, with a
// new epoch and a new incarnation (claim.ts), then swapped in for the live space, whose folder
// becomes `<slug>.replaced-<utc>`: kept, never deleted (folders.ts has the steps and the crash
// windows). The replaced folder is the barrier: the state before the restore stays there byte for
// byte, so the restore takes no separate barrier backup (A1 3.18).
//
// One writer per space (A1 3.9): every writable connection here is on a new file in a new
// staging folder (`.<slug>.restoring-<utc>`) that is not a space yet: the unpacked database, the
// mark and the restore claim. A restore in place also moves the live folder, so the storage
// worker's restoreInPlace (worker/client.ts) holds the live space's claim for the whole restore: a
// writer of this process that has the space open refuses it, and none opens meanwhile.
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { misuse, StorageError } from "../errors.ts";
import {
  FOLDER_MODE,
  fsCall,
  fsyncFolder,
  makeDirExact,
  removeQuietly,
  temporaryTag,
} from "../files.ts";
import { isId, osRandom, type Id, type RandomSource } from "../ids.ts";
import {
  DATABASE_FILE,
  isAppVersion,
  manifestFor,
  readManifest,
  writeManifest,
} from "../manifest.ts";
import { openWriter } from "../open.ts";
import { inRange, type SpaceRow } from "../rows.ts";
import type { Revision, SchemaStep } from "../schema.ts";
import { openSpaceWith, SOURCE_APP_VERSION } from "../space.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { BACKUP_TEMP_PREFIX, type BackupSidecar } from "../backup/sidecar.ts";
import { bundleInvalid } from "../bundle/read.ts";
import { claimSpace, type Claim } from "./claim.ts";
import {
  renameFolder,
  swapIntoPlace,
  swapNames,
  type SwapHooks,
  type SwapNames,
  type SwapPoint,
} from "./folders.ts";
import { dropTriggers, markCopy } from "./mark.ts";
import {
  inFolder,
  isBundleFile,
  removeDatabase,
  unpackAny,
  type CopyPlace,
  type RestoreSource,
  type Unpacked,
  type UnpackSeams,
} from "./unpack.ts";

export { dropTriggers, markReadOnlyCopy, READ_ONLY_COPY } from "./mark.ts";

export interface RestoreOptions {
  appVersion?: string;
  busyTimeoutMs?: number;
  /** Milliseconds since 1970. Default: Date.now. */
  now?: () => number;
}

export interface RestoreInPlaceOptions extends RestoreOptions {
  /** This machine's ID: the restored copy's new authority. */
  machineId: Id<"m">;
  /** Epochs this machine knows for the space besides the backup's and the live space's. */
  knownEpochs?: readonly number[];
  /** The source of the new incarnation and commit IDs. Default: the OS. */
  random?: RandomSource;
  /**
   * The storage worker's checks around the swap's first rename, for its writer.lock
   * (writer-lock.ts swapGuard).
   */
  swap?: SwapHooks;
}

/**
 * The points M1.07's crash harness kills at: `unpacked` and `claimed` or, into a new folder,
 * `marked` (the copy is marked read-only and its space.json written, still in staging).
 */
export type RestorePoint = "unpacked" | "marked" | "claimed" | SwapPoint;

/** What tests inject. Not part of the package's interface. */
export interface RestoreSeams extends UnpackSeams {
  at?: (point: RestorePoint) => void;
}

export interface RestoredSpace {
  folder: string;
  space: SpaceRow;
  revision: Revision;
  /** The backup's sidecar or the bundle's export.json. */
  source: RestoreSource;
}

export interface RestoredInPlace extends RestoredSpace {
  /** The live folder's new name, `<slug>.replaced-<utc>`. */
  replaced: string;
  claim: Claim;
  /** Whether the replaced folder's backups moved into the restored space. */
  backupsCarried: boolean;
}

function settings(options: RestoreOptions): { appVersion: string; now: number } {
  const appVersion = options.appVersion ?? SOURCE_APP_VERSION;
  if (!isAppVersion(appVersion)) throw misuse("An app version is major.minor.patch");
  const now = (options.now ?? Date.now)();
  if (!inRange(now, "instant")) throw misuse("The clock gave an instant outside its range");
  return { appVersion, now };
}

const isDirectory = (path: string): boolean =>
  fsCall(() => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true);

/** Removes a staging folder after a failure, unless a swap needs it to be finished. */
function cleanUp(names: SwapNames): void {
  const midSwap = existsSync(names.replaced) && !existsSync(names.live);
  if (!midSwap) removeQuietly(names.staging);
}

/**
 * Restores `backupFile` (a `.db.gz` beside its sidecar, or an export bundle `.zip`) into the new
 * space folder `target`.
 */
export async function restoreBackup(
  checked: CheckedDriver,
  backupFile: string,
  target: string,
  options: RestoreOptions = {},
): Promise<RestoredSpace> {
  return restoreBackupWith(checked, backupFile, target, options, {});
}

/** restoreBackup with test seams. */
export async function restoreBackupWith(
  checked: CheckedDriver,
  backupFile: string,
  target: string,
  options: RestoreOptions,
  seams: RestoreSeams,
): Promise<RestoredSpace> {
  const { appVersion, now } = settings(options);
  const names = swapNames(target, now);
  if (!isDirectory(names.parent)) {
    throw new StorageError(
      "SPACE_NOT_FOUND",
      "No space found: the folder for spaces does not exist",
    );
  }
  if (fsCall(() => existsSync(names.live))) {
    throw new StorageError("SPACE_EXISTS", "A space folder is already there");
  }
  fsCall(() => {
    makeDirExact(names.staging, FOLDER_MODE);
  });
  try {
    // The copy is read-only before it takes a name any open could find.
    const copy = await restoreCopy(checked, backupFile, inFolder(names.staging), now, options, seams);
    writeManifest(names.staging, manifestFor(copy.space, copy.step, appVersion));
    fsyncFolder(names.staging);
    seams.at?.("marked");
    renameFolder(names.staging, names.live);
    fsyncFolder(names.parent);
    return { folder: names.live, ...pick(copy) };
  } catch (error) {
    removeQuietly(names.staging);
    throw error;
  }
}

/**
 * The restore's own steps for a read-only copy, up to and with its first write: `file` unpacked into
 * `place` with every check a restore makes (unpack.ts), then the read-only mark (mark.ts). A
 * restore into a new folder runs them in its staging folder; a verification runs exactly these on a
 * scratch copy (verifyBackupFile). The caller removes `place` on failure.
 */
export async function restoreCopy(
  checked: CheckedDriver,
  file: string,
  place: CopyPlace,
  now: number,
  options: { busyTimeoutMs?: number },
  seams: RestoreSeams,
): Promise<Unpacked> {
  const unpacked = await unpackAny(checked, file, place, busy(options), seams);
  seams.at?.("unpacked");
  const invalid = isBundleFile(file) ? bundleInvalid : backupInvalid;
  const space = markCopy(checked, place.db, now, busy(options), invalid);
  return { ...unpacked, space };
}

const backupInvalid = (why: string): StorageError =>
  new StorageError("BACKUP_INVALID", `The backup does not verify: ${why}`);

/** What a verification takes: a restore's seams, and its connections' busy timeout. */
export interface VerifyOptions extends UnpackSeams {
  busyTimeoutMs?: number;
}

/**
 * Verifies the backup `backupFile` by a trial restore (see the header): restoreCopy on a scratch
 * copy beside it, under a backup's own temporary name (`.backup.tmp-<random>.db`), so a crash leaves
 * only a leftover that the listing names and cleanup removes. The scratch copy is removed again.
 * Returns the backup's sidecar when the restore ran to its end, undefined when any step failed.
 * Never throws for the backup's sake. It needs the database's size in free disk space.
 */
export async function verifyBackupFile(
  checked: CheckedDriver,
  backupFile: string,
  options: VerifyOptions = {},
): Promise<BackupSidecar | undefined> {
  const scratch = join(dirname(backupFile), `${BACKUP_TEMP_PREFIX}${temporaryTag()}.db`);
  try {
    const copy = await restoreCopy(
      checked,
      backupFile,
      { db: scratch, folder: dirname(scratch) },
      Date.now(),
      options,
      options,
    );
    return copy.source.kind === "backup" ? copy.source.sidecar : undefined;
  } catch {
    return undefined;
  } finally {
    removeDatabase(scratch);
  }
}

const busy = (options: { busyTimeoutMs?: number }): { busyTimeoutMs?: number } =>
  options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs };

const pick = (u: { space: SpaceRow; revision: Revision; source: RestoreSource }) => ({
  space: u.space,
  revision: u.revision,
  source: u.source,
});

/** What can be read of the live space: its ID, and every epoch it knows. */
interface LiveIdentity {
  spaceId: Id<"sp"> | undefined;
  epochs: number[];
}

/**
 * Reads what it can of the live space's identity: through a reader open when the space opens,
 * else from space.json's safety fields. A space that opens for neither gives nothing: it is the
 * one being recovered.
 */
function liveIdentity(
  checked: CheckedDriver,
  folder: string,
  options: RestoreOptions,
  steps: readonly SchemaStep[] | undefined,
): LiveIdentity {
  try {
    const opened = openSpaceWith(
      checked,
      folder,
      { role: "reader", ...busy(options) },
      steps === undefined ? {} : { steps },
    );
    opened.conn.close();
    const { space } = opened;
    return {
      spaceId: space.spaceId,
      epochs: [space.authority.epoch, ...space.lineage.incarnations.map((e) => e.epoch)],
    };
  } catch {
    try {
      const read = readManifest(folder);
      if (read.state !== "present") return { spaceId: undefined, epochs: [] };
      const epochs = read.manifest
        ? [read.manifest.authority.epoch, ...read.manifest.lineage.incarnations.map((e) => e.epoch)]
        : [];
      return { spaceId: read.safety.space_id, epochs };
    } catch {
      return { spaceId: undefined, epochs: [] };
    }
  }
}

/**
 * Restores `backupFile` in place of the space at `folder` and claims it with a new epoch and a new
 * incarnation. The live folder is moved aside to `<slug>.replaced-<utc>`, never deleted. A backup
 * of another space is refused (SPACE_ID_MISMATCH) when the live space's ID can be read.
 */
export async function restoreInPlace(
  checked: CheckedDriver,
  backupFile: string,
  folder: string,
  options: RestoreInPlaceOptions,
): Promise<RestoredInPlace> {
  return restoreInPlaceWith(checked, backupFile, folder, options, {});
}

/** restoreInPlace with test seams. */
export async function restoreInPlaceWith(
  checked: CheckedDriver,
  backupFile: string,
  folder: string,
  options: RestoreInPlaceOptions,
  seams: RestoreSeams,
): Promise<RestoredInPlace> {
  const { appVersion, now } = settings(options);
  if (!isId(options.machineId, "m")) throw misuse("The machine ID is not an m_ ID");
  const names = swapNames(folder, now);
  if (!isDirectory(names.live)) {
    throw new StorageError("SPACE_NOT_FOUND", "No space found: the folder does not exist");
  }
  const live = liveIdentity(checked, names.live, options, seams.steps);
  fsCall(() => {
    makeDirExact(names.staging, FOLDER_MODE);
  });
  try {
    const unpacked = await unpackAny(
      checked,
      backupFile,
      inFolder(names.staging),
      busy(options),
      seams,
    );
    seams.at?.("unpacked");
    if (live.spaceId !== undefined && live.spaceId !== unpacked.space.spaceId) {
      throw new StorageError("SPACE_ID_MISMATCH", "The backup is of another space");
    }
    // The claim happens in the staging folder, before the copy takes the space's name: no crash
    // can leave an unclaimed old incarnation in place of the live space.
    const conn = openWriter(checked, join(names.staging, DATABASE_FILE), busy(options));
    let claim: Claim;
    try {
      conn.transaction("immediate", () => {
        dropTriggers(conn);
      });
      claim = claimSpace(conn, {
        kind: "restore_claim",
        machineId: options.machineId,
        knownEpochs: [...live.epochs, ...(options.knownEpochs ?? [])],
        now,
        random: options.random ?? osRandom,
      });
    } finally {
      // The last connection to close checkpoints the -wal into the file and removes it.
      conn.close();
    }
    writeManifest(names.staging, manifestFor(claim.space, unpacked.step, appVersion));
    fsyncFolder(names.staging);
    seams.at?.("claimed");
    const swapped = swapIntoPlace(names, seams.at, options.swap);
    return {
      folder: names.live,
      ...pick({ ...unpacked, space: claim.space }),
      replaced: swapped.replaced,
      claim,
      backupsCarried: swapped.backupsCarried,
    };
  } catch (error) {
    cleanUp(names);
    throw error;
  }
}
