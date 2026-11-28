// Backup names and sidecars (A1 3.18). A backup is two files in a space's backups folder:
//
//   <kind>-<utc>-e<epoch>-s<seq>.db.gz   the compressed snapshot of space.db
//   <kind>-<utc>-e<epoch>-s<seq>.json    its sidecar
//
// The sidecar is renamed into place last: it is the backup's commit point. A `.db.gz` without its
// sidecar is a crash's leftover, never a backup. The sidecar records what the snapshot holds, read
// from the copy itself: the space, its authority epoch and incarnation, the last commit, the schema
// revision, the size and SHA-256 of the database and of the compressed file, and the rows per
// table. `<utc>` is the moment the backup began, to the millisecond, as 20261113T031500.123Z.
import { lstatSync } from "node:fs";
import { errnoCode, fsError, readBounded, type FileIo, NODE_IO } from "../files.ts";
import { isId, type Id } from "../ids.ts";
import { isAppVersion } from "../manifest.ts";
import { inRange } from "../rows.ts";

/** Why a backup was taken. Each kind has its own retention (retention.ts). */
export const BACKUP_KINDS = ["daily", "manual", "pre-migrate"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

/** The marker of a sidecar, and its version. A format constant, like space.json's marker. */
export const SIDECAR_MARKER = "tasks_backup";
export const SIDECAR_VERSION = 1;

export const DATA_SUFFIX = ".db.gz";
export const SIDECAR_SUFFIX = ".json";

/** What a sidecar holds. */
export interface BackupSidecar {
  [SIDECAR_MARKER]: typeof SIDECAR_VERSION;
  kind: BackupKind;
  /** When the backup began, in milliseconds since 1970. Also in the name. */
  created_at: number;
  space_id: Id<"sp">;
  epoch: number;
  incarnation: Id<"ai">;
  /** The snapshot's `space.last_seq`. */
  seq: number;
  /** The snapshot's PRAGMA user_version (A1 3.17's encoding). */
  user_version: number;
  /** The uncompressed database. */
  size: number;
  sha256: string;
  /** The `.db.gz` file. */
  compressed_size: number;
  compressed_sha256: string;
  /** Rows per table in the snapshot, by table name. */
  counts: Record<string, number>;
  /** The app version that wrote the backup. */
  written_by: string;
}

/** The parts of a backup's name. */
export interface BackupNameParts {
  kind: BackupKind;
  createdAt: number;
  epoch: number;
  seq: number;
}

const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/;
const NAME = new RegExp(
  `^(${BACKUP_KINDS.join("|")})-(\\d{8}T\\d{6}\\.\\d{3}Z)-e([1-9]\\d{0,9})-s(0|[1-9]\\d{0,14})$`,
);

/** A UTC instant as `20261113T031500.123Z`. */
export function utcStamp(ms: number): string {
  if (!inRange(ms, "instant")) throw new RangeError("An instant outside its range");
  return new Date(ms).toISOString().replaceAll("-", "").replaceAll(":", "");
}

/** The instant of a stamp, or undefined when it is not one. */
export function parseUtcStamp(stamp: string): number | undefined {
  const m = STAMP.exec(stamp);
  if (m === null) return undefined;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const value = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  // A name comes from disk: an instant outside the range is no stamp, never an error. Date.UTC
  // rolls an invalid date over (Feb 30 is March 2): only a stamp that reads back is one.
  if (!inRange(value, "instant")) return undefined;
  return utcStamp(value) === stamp ? value : undefined;
}

/** The prefix of the temporary files a backup writes in its folder, before its random tag. */
export const BACKUP_TEMP_PREFIX = ".backup.tmp-";

/** A backup's own temporary files: the copy with SQLite's files beside it, and the `.db.gz`. */
const BACKUP_TEMPORARY = /^\.backup\.tmp-[0-9a-f]{16}\.(?:db|db-journal|db-wal|db-shm|db\.gz)$/;
/** The temporary file of a sidecar's atomic write (files.ts writeFileAtomic). */
const SIDECAR_TEMPORARY = /^\.(.+)\.json\.tmp-[0-9a-f]{16}$/;

/**
 * Whether `name` is a temporary file that a backup writes, by its exact pattern. Only these and a
 * `.db.gz` without its sidecar are ever removed as leftovers: a backups folder can be shared with
 * other programs (a synced folder), and their files are never TTasks's to delete.
 */
export function isBackupTemporary(name: string): boolean {
  if (BACKUP_TEMPORARY.test(name)) return true;
  const sidecar = SIDECAR_TEMPORARY.exec(name);
  return sidecar !== null && parseBackupName(sidecar[1] ?? "") !== undefined;
}

/** The base name of a backup, without a suffix. */
export function backupName(parts: BackupNameParts): string {
  return `${parts.kind}-${utcStamp(parts.createdAt)}-e${String(parts.epoch)}-s${String(parts.seq)}`;
}

/** The parts of a base name, or undefined when it is not a backup's. */
export function parseBackupName(name: string): BackupNameParts | undefined {
  const m = NAME.exec(name);
  if (m === null) return undefined;
  const createdAt = parseUtcStamp(m[2] ?? "");
  const epoch = Number(m[3]);
  const seq = Number(m[4]);
  if (createdAt === undefined || !inRange(epoch, "epoch") || !inRange(seq, "seq")) return undefined;
  return { kind: m[1] as BackupKind, createdAt, epoch, seq };
}

/** The sidecar's text: two-space JSON with a final newline. */
export const sidecarText = (sidecar: BackupSidecar): string =>
  `${JSON.stringify(sidecar, null, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SHA256 = /^[0-9a-f]{64}$/;
const TABLE = /^[a-z_][a-z0-9_]{0,63}$/;

/** Decodes a sidecar's JSON value, or undefined when any field breaks its shape. */
export function decodeSidecar(json: unknown): BackupSidecar | undefined {
  if (!isRecord(json) || json[SIDECAR_MARKER] !== SIDECAR_VERSION) return undefined;
  const { kind, created_at, space_id, epoch, incarnation, seq, user_version, size, sha256 } = json;
  const { compressed_size, compressed_sha256, counts, written_by } = json;
  if (!BACKUP_KINDS.includes(kind as BackupKind)) return undefined;
  if (!inRange(created_at, "instant") || !isId(space_id, "sp") || !isId(incarnation, "ai")) {
    return undefined;
  }
  if (!inRange(epoch, "epoch") || !inRange(seq, "seq") || !inRange(user_version, "count")) {
    return undefined;
  }
  if (!Number.isSafeInteger(size) || (size as number) < 1) return undefined;
  if (!Number.isSafeInteger(compressed_size) || (compressed_size as number) < 1) return undefined;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return undefined;
  if (typeof compressed_sha256 !== "string" || !SHA256.test(compressed_sha256)) return undefined;
  if (!isAppVersion(written_by) || !isRecord(counts)) return undefined;
  const tableCounts: Record<string, number> = {};
  for (const [table, count] of Object.entries(counts)) {
    if (!TABLE.test(table) || !inRange(count, "seq")) return undefined;
    tableCounts[table] = count;
  }
  return {
    [SIDECAR_MARKER]: SIDECAR_VERSION,
    kind: kind as BackupKind,
    created_at,
    space_id,
    epoch,
    incarnation,
    seq,
    user_version,
    size: size as number,
    sha256,
    compressed_size: compressed_size as number,
    compressed_sha256,
    counts: tableCounts,
    written_by,
  };
}

/** Whether a sidecar agrees with the name it is stored under. */
export const sidecarMatchesName = (sidecar: BackupSidecar, parts: BackupNameParts): boolean =>
  sidecar.kind === parts.kind &&
  sidecar.created_at === parts.createdAt &&
  sidecar.epoch === parts.epoch &&
  sidecar.seq === parts.seq;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type SidecarRead =
  | { state: "missing" }
  /** Not a regular file (a link, a folder), too large, or not a valid sidecar. */
  | { state: "invalid" }
  | { state: "ok"; sidecar: BackupSidecar };

/**
 * Reads a sidecar, at most `maxBytes` of it (the policy's limit for any other file). A link or
 * anything but a regular file is invalid: a restore never follows one (A1 3.18).
 */
export function readSidecar(path: string, maxBytes: number, io: FileIo = NODE_IO): SidecarRead {
  let isFile: boolean;
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (stats === undefined) return { state: "missing" };
    isFile = stats.isFile();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { state: "missing" };
    throw fsError(error);
  }
  if (!isFile) return { state: "invalid" };
  const read = readBounded(path, maxBytes, io);
  if (read.state === "missing") return { state: "missing" };
  if (read.state === "too_large") return { state: "invalid" };
  const sidecar = parseSidecar(read.bytes);
  return sidecar === undefined ? { state: "invalid" } : { state: "ok", sidecar };
}

/** A sidecar's bytes decoded, or undefined when they are not UTF-8 JSON of a valid sidecar. */
export function parseSidecar(bytes: Uint8Array): BackupSidecar | undefined {
  try {
    return decodeSidecar(JSON.parse(UTF8.decode(bytes)));
  } catch {
    return undefined;
  }
}
