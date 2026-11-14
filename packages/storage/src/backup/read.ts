// Reading a backup's two files for a restore (A1 3.18 "Restore", steps 1 and 2). A reader holds
// what it reads: it opens BOTH files, the `.db.gz` and its sidecar, before it reads either, and
// reads only through those descriptors until it is done. Retention or a person may remove the
// files meanwhile: the reader still reads the files it opened (a removed file's data stays while a
// descriptor holds it, on Linux and on Windows, where Node opens every file with delete sharing),
// and never a file that took the name after it looked. A backup that is gone before both files are
// open is refused (SPACE_NOT_FOUND, or BACKUP_INVALID without its sidecar), and a caller choosing
// among backups skips it. No lease and no cross-process protocol: the descriptors are the hold.
//
// 1. The backup is the `.db.gz` named like a backup, beside its sidecar. Each is opened only as the
//    regular file its path names, never through a link: the path is looked at without following a
//    link, opened (with O_NOFOLLOW where the OS has it), and the opened file must be the one looked
//    at (its identity on its volume).
// 2. The sidecar is read through its descriptor, at most the policy's limit for any other file, and
//    must agree with the name. The `.db.gz` must have the size the sidecar records.
// 3. The size the sidecar promises must fit the policy and the free disk space, less the reserve.
// 4. Decompression streams from the data's descriptor into a new file and stops as soon as the
//    output passes the policy's limit (BUNDLE_LIMIT_EXCEEDED) or the sidecar's size
//    (BACKUP_INVALID). The sizes and SHA-256 of both sides must equal the sidecar's.
// What the unpacked database must then be is the restore's to check (restore/unpack.ts), and a
// backup is verified only by a restore that ran to its first write (restore/restore.ts).
import { constants, fstatSync, lstatSync, openSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { StorageError } from "../errors.ts";
import { closeQuietly, errnoCode, fsCall, fsError, readOpenBounded } from "../files.ts";
import {
  checkDatabaseSize,
  checkFreeSpace,
  freeBytes,
  inflateFile,
  type BundlePolicy,
} from "./policy.ts";
import {
  DATA_SUFFIX,
  parseBackupName,
  parseSidecar,
  SIDECAR_SUFFIX,
  sidecarMatchesName,
  type BackupSidecar,
} from "./sidecar.ts";

const invalid = (why: string): StorageError => new StorageError("BACKUP_INVALID", why);

/** POSIX's refusal to open a link; Windows has no such flag, so the identity check covers it. */
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

/**
 * Opens the regular file at `path` for reading, never through a link (step 1). Undefined when
 * nothing is there; BACKUP_INVALID for anything but a regular file, or a file that changed between
 * the look and the open.
 */
function openRegular(path: string): number | undefined {
  const before = fsCall(() => lstatSync(path, { bigint: true, throwIfNoEntry: false }));
  if (before === undefined) return undefined;
  if (!before.isFile()) throw invalid("The backup is not a regular file");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw invalid("The backup is not a regular file");
    throw fsError(error);
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw invalid("The backup changed while it was opened");
    }
  } catch (error) {
    closeQuietly(fd);
    throw error instanceof StorageError ? error : fsError(error);
  }
  return fd;
}

/** A backup's two files, open, and what its sidecar says. Close it when done. */
export interface HeldBackup {
  readonly sidecar: BackupSidecar;
  /** The `.db.gz`'s descriptor: read from its start (policy.ts inflateFile). */
  readonly data: number;
  close(): void;
}

/** Opens both files of the backup `backupFile` before reading either, then reads its sidecar. */
export function holdBackup(backupFile: string, policy: BundlePolicy): HeldBackup {
  const name = basename(backupFile);
  if (!name.endsWith(DATA_SUFFIX)) throw invalid("The file is not named like a backup");
  const base = name.slice(0, -DATA_SUFFIX.length);
  const parts = parseBackupName(base);
  if (parts === undefined) throw invalid("The file is not named like a backup");
  const data = openRegular(backupFile);
  if (data === undefined) throw new StorageError("SPACE_NOT_FOUND", "The backup file is missing");
  let side: number | undefined;
  try {
    side = openRegular(join(dirname(backupFile), `${base}${SIDECAR_SUFFIX}`));
    if (side === undefined) throw invalid("The backup has no sidecar");
    // Both are open: from here on only the descriptors are read.
    const read = readOpenBounded(side, policy.maxOtherFileBytes);
    const sidecar = read.state === "ok" ? parseSidecar(read.bytes) : undefined;
    if (sidecar === undefined || !sidecarMatchesName(sidecar, parts)) {
      throw invalid("The backup's sidecar is not valid");
    }
    if (fsCall(() => fstatSync(data).size) !== sidecar.compressed_size) {
      throw invalid("The backup file's size differs from its sidecar's");
    }
    const sideFd = side;
    let open = true;
    return {
      sidecar,
      data,
      close: () => {
        if (!open) return;
        open = false;
        closeQuietly(data);
        closeQuietly(sideFd);
      },
    };
  } catch (error) {
    closeQuietly(data);
    if (side !== undefined) closeQuietly(side);
    throw error;
  }
}

export interface InflateBackupOptions {
  policy: BundlePolicy;
  /** Free bytes for a folder. Default: the file system's. */
  freeBytes?: (folder: string) => number;
}

/**
 * Steps 3 and 4: decompresses the held backup into the new file `dest` (in a folder that exists)
 * and checks it against the sidecar. The caller owns `dest`, on success and on failure.
 */
export async function inflateBackup(
  held: HeldBackup,
  dest: string,
  options: InflateBackupOptions,
): Promise<void> {
  const { sidecar } = held;
  const { policy } = options;
  checkDatabaseSize(sidecar.size, policy);
  checkFreeSpace(sidecar.size, (options.freeBytes ?? freeBytes)(dirname(dest)), policy);
  const digests = await inflateFile(held.data, dest, {
    maxBytes: policy.maxDatabaseBytes,
    expectedBytes: sidecar.size,
  });
  if (
    digests.size !== sidecar.size ||
    digests.sha256 !== sidecar.sha256 ||
    digests.compressedSize !== sidecar.compressed_size ||
    digests.compressedSha256 !== sidecar.compressed_sha256 ||
    fsCall(() => statSync(dest).size) !== sidecar.size
  ) {
    throw invalid("The backup's content differs from its sidecar");
  }
}
