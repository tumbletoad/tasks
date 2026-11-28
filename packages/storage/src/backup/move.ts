// Moving a space's old backups, made into its own `backups/` before backups went to a folder beside
// the TTasks home, into its backups folder. Every listing reads both folders as one (list.ts
// listBackupsIn), so a backup on its way is listed once, wherever it stands.
//
// The move is two steps, in two runs, and what is on disk says which one a backup is at:
// 1. A complete backup only in the old folder gets a copy: its data under a backup's temporary
//    name, then under its own name, which never replaces a file (files.ts publishExclusive), then
//    its sidecar. Nothing is removed.
// 2. A backup in both folders whose copy was written over SETTLED_MS ago is read back from disk:
//    the data's size and SHA-256 against the sidecar, and the sidecar's bytes equal. Only then is
//    the original removed, its data first. So a power cut, a full disk or a drive taken away
//    between the two steps costs nothing: the original stays until a copy that has reached the
//    disk reads back.
// A daily backup's original goes only once its name is in the backups folder's record of old
// daily backups (OLD_DAILIES_FILE), which retention keeps wherever they stand: written, synced and
// read back before any removal, so a failed write leaves the originals for the next start. Beside
// the backups, it serves every machine that shares the folder.
// Whatever does not read back, is incomplete, or finds another file at its name stays where it is,
// both copies if need be, and the result says why. The service runs this at its start, under the
// space's writer.lock, and stops the run before it releases the lock (hub/spaces.ts).
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  errnoCode,
  NODE_IO,
  publishExclusive,
  readBounded,
  removeQuietly,
  temporaryTag,
  writeFileAtomic,
  writeFileExclusive,
  type FileIo,
} from "../files.ts";
import type { Id } from "../ids.ts";
import { listBackups } from "./list.ts";
import { BUNDLE_POLICY, checkFreeSpace, freeBytes, type BundlePolicy } from "./policy.ts";
import {
  BACKUP_TEMP_PREFIX,
  BACKUPS_FOLDER,
  DATA_SUFFIX,
  SIDECAR_SUFFIX,
  type BackupSidecar,
} from "./sidecar.ts";

/** How long a copy stands before its original goes: long enough for any disk to have written it. */
export const SETTLED_MS = 3_600_000;

/**
 * Why a backup stays in the old folder: `unverified`, its copy does not read back; `taken`,
 * another file has its name in the backups folder; `incomplete`, its own files are not whole;
 * `no_room`, the backups folder's disk is too full; `failed`, the copy could not be written.
 */
export type StayReason = "unverified" | "taken" | "incomplete" | "no_room" | "failed";

export interface MoveResult {
  /** Backups that got a copy in this run. */
  readonly copied: string[];
  /** Backups whose original went in this run. */
  readonly finished: string[];
  readonly stayed: { readonly name: string; readonly why: StayReason }[];
}

export interface MoveSeams {
  policy?: BundlePolicy;
  io?: FileIo;
  freeBytes?: (folder: string) => number;
  /** Runs after each step of one backup: tests stop there as a crash would. */
  at?: (point: "data-copied" | "data-published" | "copied" | "data-removed") => void;
}

type FolderId = { readonly dev: bigint; readonly ino: bigint };

/** A folder's identity on its volume, or undefined when it is not a folder or has none. */
function folderId(path: string): FolderId | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return stats.isDirectory() && stats.ino !== 0n ? { dev: stats.dev, ino: stats.ino } : undefined;
  } catch {
    return undefined;
  }
}

const same = (a: FolderId | undefined, b: FolderId | undefined): boolean =>
  a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;

/**
 * The identities of the old folder and the backups folder, when a move between them is sure to
 * move: two folders, the backups folder neither the space nor inside it (a restore swaps the whole
 * space), each followed through links, junctions and case. Undefined when that is not certain.
 */
function folders(space: string, to: string): { from: FolderId; to: FolderId } | undefined {
  const spaceId = folderId(space);
  const fromId = folderId(join(space, BACKUPS_FOLDER));
  const toId = folderId(to);
  if (spaceId === undefined || fromId === undefined || toId === undefined) return undefined;
  if (same(fromId, toId)) return undefined;
  let dir: string;
  try {
    dir = realpathSync.native(to);
  } catch {
    return undefined;
  }
  for (;;) {
    const id = folderId(dir);
    if (id === undefined || same(id, spaceId)) return undefined;
    if (dirname(dir) === dir) return { from: fromId, to: toId };
    dir = dirname(dir);
  }
}

/** Whether the regular file at `path` has the sidecar's compressed size and SHA-256. */
async function readsBack(path: string, sidecar: BackupSidecar): Promise<boolean> {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (stats?.isFile() !== true || stats.size !== sidecar.compressed_size) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex") === sidecar.compressed_sha256;
  } catch {
    return false;
  }
}

const bytesOf = (path: string, policy: BundlePolicy): Buffer | undefined => {
  const read = readBounded(path, policy.maxOtherFileBytes);
  return read.state === "ok" ? Buffer.from(read.bytes) : undefined;
};

const exists = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

const isNoRoom = (error: unknown): boolean => {
  const code = errnoCode(error) ?? (error as { code?: unknown } | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT" || code === "BUNDLE_LIMIT_EXCEEDED";
};

/**
 * The daily backups of the space `spaceId` in its old folder, when that is not its backups folder
 * `to`. Where the two are one folder, its backups are the ordinary ones, and none is old.
 */
export function oldDailies(space: string, to: string, spaceId: Id<"sp">): string[] {
  if (folders(space, to) === undefined) return [];
  return listBackups(join(space, BACKUPS_FOLDER))
    .backups.filter((b) => b.sidecar?.kind === "daily" && b.sidecar.space_id === spaceId)
    .map((b) => b.name);
}

/** The record, in a backups folder, of the space's daily backups made into its own folder. */
const oldDailiesFile = (spaceId: Id<"sp">): string => `.old-dailies-${spaceId}.json`;

/**
 * The names in the backups folder `to`'s record of the space's old daily backups: none when there
 * is no record, undefined when one is there and does not read.
 */
export function recordedOldDailies(
  to: string,
  spaceId: Id<"sp">,
  policy: BundlePolicy = BUNDLE_POLICY,
): string[] | undefined {
  try {
    const read = readBounded(join(to, oldDailiesFile(spaceId)), policy.maxOtherFileBytes);
    if (read.state === "missing") return [];
    if (read.state !== "ok") return undefined;
    const names = (JSON.parse(Buffer.from(read.bytes).toString("utf8")) as { names?: unknown })
      .names;
    return Array.isArray(names) && names.every((n) => typeof n === "string") ? names : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds `names` to the record; whether the record holds every one of them when it returns. A record
 * that does not read is never written over.
 */
function recordOldDailies(
  to: string,
  spaceId: Id<"sp">,
  names: readonly string[],
  policy: BundlePolicy,
  io: FileIo,
): boolean {
  const known = recordedOldDailies(to, spaceId, policy);
  if (known === undefined) return false;
  if (names.every((n) => known.includes(n))) return true;
  const all = [...known, ...names.filter((n) => !known.includes(n))];
  try {
    const text = `${JSON.stringify({ format: 1, names: all })}\n`;
    writeFileAtomic(to, oldDailiesFile(spaceId), text, io);
  } catch {
    return false;
  }
  const again = recordedOldDailies(to, spaceId, policy);
  return again !== undefined && names.every((n) => again.includes(n));
}

/**
 * Takes each backup of the space `spaceId` in `<space>/backups` one step on its way into `to`
 * (see the header), one backup at a time. Nothing moves when the two folders are not sure to be
 * two (folders). `now` decides which copies have stood long enough.
 */
export async function moveOldBackups(
  space: string,
  to: string,
  spaceId: Id<"sp">,
  now: number,
  seams: MoveSeams = {},
): Promise<MoveResult> {
  const result: MoveResult = { copied: [], finished: [], stayed: [] };
  const ids = folders(space, to);
  if (ids === undefined) return result;
  const from = join(space, BACKUPS_FOLDER);
  const policy = seams.policy ?? BUNDLE_POLICY;
  const io = seams.io ?? NODE_IO;
  const stay = (name: string, why: StayReason): void => {
    result.stayed.push({ name, why });
  };
  // Once the disk is full, no further copy is tried in this run.
  let full = false;
  const recorded = recordOldDailies(to, spaceId, oldDailies(space, to, spaceId), policy, io);
  for (const b of listBackups(from, policy).backups) {
    if (b.sidecar === undefined) {
      // A `.db.gz` without a sidecar that reads: nothing says what it should hold.
      stay(b.name, "incomplete");
      continue;
    }
    if (b.sidecar.space_id !== spaceId) continue;
    const text = bytesOf(b.sidecarFile, policy);
    if (text === undefined) {
      stay(b.name, "incomplete");
      continue;
    }
    const data = join(to, `${b.name}${DATA_SUFFIX}`);
    const sidecar = join(to, `${b.name}${SIDECAR_SUFFIX}`);
    try {
      if (exists(sidecar)) {
        if (!text.equals(bytesOf(sidecar, policy) ?? Buffer.alloc(0))) {
          stay(b.name, "taken");
        } else if (!(await readsBack(data, b.sidecar))) {
          stay(b.name, "unverified");
        } else if (b.sidecar.kind === "daily" && !recorded) {
          stay(b.name, "failed");
        } else if (now - statSync(sidecar).mtimeMs >= SETTLED_MS) {
          // Step 2. The folders are looked at again right before each removal.
          for (const original of [b.file, b.sidecarFile]) {
            if (!same(folderId(from), ids.from) || !same(folderId(to), ids.to)) return result;
            rmSync(original, { force: true });
            if (original === b.file) seams.at?.("data-removed");
          }
          result.finished.push(b.name);
        }
        continue;
      }
      if (b.state !== "ok") {
        stay(b.name, "incomplete");
        continue;
      }
      // Step 1. Data a crash left under its name without a sidecar is taken up when it is this
      // backup's; anything else there stays, and so does the original.
      if (exists(data)) {
        if (!(await readsBack(data, b.sidecar))) {
          stay(b.name, "taken");
          continue;
        }
      } else if (full) {
        stay(b.name, "no_room");
        continue;
      } else {
        // Room for two copies at once: where the backups folder's file system makes no hard
        // link, its own publication is a copy of the temporary file.
        checkFreeSpace(2 * b.sidecar.compressed_size, (seams.freeBytes ?? freeBytes)(to), policy);
        const temporary = join(to, `${BACKUP_TEMP_PREFIX}${temporaryTag()}${DATA_SUFFIX}`);
        try {
          publishExclusive(b.file, temporary, io);
          seams.at?.("data-copied");
          publishExclusive(temporary, data, io);
        } finally {
          removeQuietly(temporary, io);
        }
        seams.at?.("data-published");
      }
      writeFileExclusive(to, `${b.name}${SIDECAR_SUFFIX}`, text.toString("utf8"), io);
      result.copied.push(b.name);
      seams.at?.("copied");
    } catch (error) {
      const noRoom = isNoRoom(error);
      full ||= noRoom;
      stay(b.name, noRoom ? "no_room" : errnoCode(error) === "EEXIST" ? "taken" : "failed");
    }
  }
  // An empty old folder goes, never one that holds anything.
  try {
    if (readdirSync(from).length === 0) rmdirSync(from);
  } catch {
    // It stays: the next start looks again.
  }
  return result;
}
