// Restoring a backup or an export bundle (A1 3.18, `ttasks space restore <backup>` in M1.10), into
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
// own steps up to and with its first write (unpack with every check, then the read-only mark, whose
// transaction runs a claim of the copy and takes it back, mark.ts), ran to its end on a scratch copy
// (trialRestore). So a verified backup restores into a new folder, can be claimed there, and
// restores in place, whose first write is that claim. There is no second checker to drift from
// what a restore does: retention keeps the newest backup verified this way (backup/retention.ts),
// and `restore latest` restores its candidates directly (rescue.ts).
//
// In place (disaster recovery): the restored copy is claimed in its staging folder first, with a
// new epoch and a new incarnation (claim.ts), then swapped in for the live space, whose folder
// becomes `<slug>.replaced-<utc>`: kept, never deleted (folders.ts has the steps and the crash
// windows). The replaced folder is the barrier: the state before the restore stays there byte for
// byte, so the restore takes no separate barrier backup (A1 3.18). The claim raises the restored
// counter of task references to the live space's (and to the caller's `refFloor`), so a task made
// after the restore never gets a reference that a task made after the backup had.
//
// One writer per space (A1 3.9): every writable connection here is on a new file in a new
// staging folder (`.<slug>.restoring-<utc>`) that is not a space yet: the unpacked database, the
// mark and the restore claim. A restore in place also moves the live folder, so the storage
// worker's restoreInPlace (worker/client.ts) holds the live space's claim for the whole restore: a
// writer of this process that has the space open refuses it, and none opens meanwhile.
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
import { openReader } from "../open.ts";
import { inRange, RANGES, type SpaceRow } from "../rows.ts";
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
import { SCHEMA_STEPS } from "../../migrations/index.ts";
import { firstWrite, markCopy, prepareCopy } from "./mark.ts";
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

export { dropUnchecked, markReadOnlyCopy, prepareCopy, READ_ONLY_COPY } from "./mark.ts";

export interface RestoreOptions {
  appVersion?: string;
  busyTimeoutMs?: number;
  /** Milliseconds since 1970. Default: Date.now. */
  now?: () => number;
  /**
   * The space the backup must be of, when the caller knows it: a backup of another space is
   * refused (SPACE_ID_MISMATCH) before anything takes the target's name.
   */
  spaceId?: Id<"sp">;
}

export interface RestoreInPlaceOptions extends RestoreOptions {
  /** This machine's ID: the restored copy's new authority. */
  machineId: Id<"m">;
  /** Epochs this machine knows for the space besides the backup's and the live space's. */
  knownEpochs?: readonly number[];
  /**
   * A next task reference this machine reached in the space besides the live space's own (other
   * copies of it). The restored space gives no reference below the highest of these and its own.
   */
  refFloor?: number;
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
    const copy = await restoreCopy(
      checked,
      backupFile,
      inFolder(names.staging),
      now,
      options,
      seams,
    );
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
  options: { busyTimeoutMs?: number; spaceId?: Id<"sp"> },
  seams: RestoreSeams,
): Promise<Unpacked> {
  const unpacked = await unpackAny(checked, file, place, busy(options), seams);
  seams.at?.("unpacked");
  refuseOtherSpace(unpacked.space.spaceId, [options.spaceId]);
  const invalid = isBundleFile(file) ? bundleInvalid : backupInvalid;
  const space = markCopy(
    checked,
    place.db,
    now,
    busy(options),
    invalid,
    seams.steps ?? SCHEMA_STEPS,
    basename(file),
  );
  return { ...unpacked, space };
}

const backupInvalid = (why: string): StorageError =>
  new StorageError("BACKUP_INVALID", `The backup does not verify: ${why}`);

/** SPACE_ID_MISMATCH unless the unpacked space is each of the expected ones that is known. */
function refuseOtherSpace(unpacked: Id<"sp">, expected: readonly (Id<"sp"> | undefined)[]): void {
  if (expected.some((id) => id !== undefined && id !== unpacked)) {
    throw new StorageError("SPACE_ID_MISMATCH", "The backup is of another space");
  }
}

/** What a verification takes: a restore's seams, and its connections' busy timeout. */
export interface VerifyOptions extends UnpackSeams {
  busyTimeoutMs?: number;
}

/**
 * A trial restore of the backup `backupFile` (see the header): restoreCopy on a scratch copy beside
 * it, under a backup's own temporary name (`.backup.tmp-<random>.db`), so a crash leaves only a
 * leftover that the listing names and cleanup removes. The scratch copy is removed again. Throws
 * what the restore threw: BUNDLE_LIMIT_EXCEEDED when the database's size, with the free-space
 * reserve, does not fit on the disk.
 */
export async function trialRestore(
  checked: CheckedDriver,
  backupFile: string,
  options: VerifyOptions = {},
): Promise<RestoreSource> {
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
    return copy.source;
  } finally {
    removeDatabase(scratch);
  }
}

/** Codes that say a backup itself does not restore, whatever disk it is restored to. */
const BACKUPS_OWN: ReadonlySet<string> = new Set([
  "BACKUP_INVALID",
  "SPACE_INVALID",
  "SPACE_TOO_NEW",
  "SPACE_VERSION_UNKNOWN",
]);

/**
 * Whether a restore of the backup `file` failed for the backup's own sake: its files or its
 * database are not what a restore takes, or it went away before the restore held it (its `.db.gz`
 * is gone). Any other failure (the disk restored to, its free space, a size limit, a bug) says
 * nothing about the backup.
 */
export function isBackupsOwnFailure(error: unknown, file: string): boolean {
  if (!(error instanceof StorageError)) return false;
  if (error.code === "SPACE_NOT_FOUND") return !fsCall(() => existsSync(file));
  return BACKUPS_OWN.has(error.code);
}

/** What a trial restore found. */
export type TrialVerdict =
  /** The restore ran to its end: the backup restores. */
  | { readonly state: "verified"; readonly sidecar: BackupSidecar }
  /** The backup does not restore (isBackupsOwnFailure). */
  | { readonly state: "failed" }
  /**
   * The trial stopped for a reason that is not the backup's: too little free space beside it for
   * the trial (BUNDLE_LIMIT_EXCEEDED), a failing disk, a bug (no code). Nothing is known of it.
   */
  | { readonly state: "unchecked"; readonly code?: string };

/** Verifies the backup `backupFile` by a trial restore (trialRestore). */
export async function verifyBackupFile(
  checked: CheckedDriver,
  backupFile: string,
  options: VerifyOptions = {},
): Promise<TrialVerdict> {
  try {
    const source = await trialRestore(checked, backupFile, options);
    return source.kind === "backup"
      ? { state: "verified", sidecar: source.sidecar }
      : { state: "failed" };
  } catch (error) {
    if (isBackupsOwnFailure(error, backupFile)) return { state: "failed" };
    return error instanceof StorageError
      ? { state: "unchecked", code: error.code }
      : { state: "unchecked" };
  }
}

const busy = (options: { busyTimeoutMs?: number }): { busyTimeoutMs?: number } =>
  options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs };

const pick = (u: { space: SpaceRow; revision: Revision; source: RestoreSource }) => ({
  space: u.space,
  revision: u.revision,
  source: u.source,
});

/**
 * What can be read of the live space: its ID, every epoch it knows, and its next task reference,
 * which the restored space never goes below.
 */
interface LiveIdentity {
  spaceId: Id<"sp"> | undefined;
  epochs: number[];
  nextRef: number | undefined;
}

/**
 * Reads what it can of the live space's identity: through a reader open when the space opens,
 * else from space.json's safety fields and the database's space row read as it is. A space that
 * gives neither gives nothing: it is the one being recovered.
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
      nextRef: space.nextRef,
    };
  } catch {
    const nextRef = rawNextRef(checked, folder, options);
    try {
      const read = readManifest(folder);
      if (read.state !== "present") return { spaceId: undefined, epochs: [], nextRef };
      const epochs = read.manifest
        ? [read.manifest.authority.epoch, ...read.manifest.lineage.incarnations.map((e) => e.epoch)]
        : [];
      return { spaceId: read.safety.space_id, epochs, nextRef };
    } catch {
      return { spaceId: undefined, epochs: [], nextRef };
    }
  }
}

/**
 * The live database's next task reference when the space does not open (a space row that fails its
 * checks, say): read-only, from that one column. Undefined when even that cannot be read.
 */
function rawNextRef(
  checked: CheckedDriver,
  folder: string,
  options: RestoreOptions,
): number | undefined {
  try {
    const conn = openReader(checked, join(folder, DATABASE_FILE), busy(options));
    try {
      const value = conn.prepare("SELECT next_ref FROM space WHERE one = 1").get()?.["next_ref"];
      return isNextRef(value) ? value : undefined;
    } finally {
      conn.close();
    }
  } catch {
    return undefined;
  }
}

const isNextRef = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= RANGES.taskRef.min &&
  value <= RANGES.taskRef.max + 1;

/**
 * Restores `backupFile` in place of the space at `folder` and claims it with a new epoch and a new
 * incarnation. The live folder is moved aside to `<slug>.replaced-<utc>`, never deleted. A backup
 * of another space than `options.spaceId`, or than the live space's ID when it can be read, is
 * refused (SPACE_ID_MISMATCH).
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
  if (options.refFloor !== undefined && !isNextRef(options.refFloor)) {
    throw misuse("A reference floor is a next task reference");
  }
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
    // The live files may no longer say which space they were: the caller's ID still does.
    refuseOtherSpace(unpacked.space.spaceId, [options.spaceId, live.spaceId]);
    // The claim happens in the staging folder, before the copy takes the space's name: no crash
    // can leave an unclaimed old incarnation in place of the live space. It is this restore's
    // first write (mark.ts firstWrite), after the copy is prepared (prepareCopy).
    const claim: Claim = firstWrite(
      checked,
      join(names.staging, DATABASE_FILE),
      busy(options),
      isBundleFile(backupFile) ? bundleInvalid : backupInvalid,
      (conn) => {
        conn.transaction("immediate", () => {
          prepareCopy(checked, conn, seams.steps ?? SCHEMA_STEPS);
        });
        const floors = [live.nextRef, options.refFloor].filter(isNextRef);
        return claimSpace(conn, {
          kind: "restore_claim",
          machineId: options.machineId,
          knownEpochs: [...live.epochs, ...(options.knownEpochs ?? [])],
          ...(floors.length === 0 ? {} : { refFloor: Math.max(...floors) }),
          now,
          random: options.random ?? osRandom,
        });
      },
    );
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
