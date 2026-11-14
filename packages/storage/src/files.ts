// File system helpers for the space folder. A Node file system error's message holds the path,
// and a path holds the user's name, so these errors pass on their errno code only. Cleanup after a
// failure never replaces the failure: its own errors are dropped, so the first error is the one
// the caller sees, and no native message gets out on the way.
//
// Modes: every file and folder storage creates gets exactly the mode A1 names (folders 0700, files
// 0600), set on the new object by descriptor after it is created: the mode given to open or mkdir
// is masked by the process's umask, which differs per system, and a descriptor follows no link.
// A file or folder that was already there keeps its mode. Windows keeps the inherited ACL.
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { makeDir, type CreateFlags } from "@tasks/files";
import { StorageError, type StorageErrorCode } from "./errors.ts";
import { osRandom } from "./ids.ts";

const ERRNO = /^E[A-Z0-9]{1,20}$/;

/** The errno code of a Node file system error, or undefined. */
export function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERRNO.test(code) ? code : undefined;
}

/** A StorageError for a file system failure, with the errno code and no path. */
export function fsError(error: unknown, code?: StorageErrorCode): StorageError {
  if (error instanceof StorageError) return error;
  const errno = errnoCode(error);
  const mapped: StorageErrorCode =
    code ??
    (errno === "ENOSPC" || errno === "EIO" || errno === "EDQUOT"
      ? "DURABILITY_FAILED"
      : errno === "ENOENT"
        ? "SPACE_NOT_FOUND"
        : errno === "EEXIST"
          ? "SPACE_EXISTS"
          : "STORAGE_CANT_OPEN");
  return new StorageError(mapped, `File system error (${errno ?? "unknown"})`);
}

/** Runs a file system call and turns its failure into a StorageError without the path. */
export function fsCall<T>(fn: () => T, code?: StorageErrorCode): T {
  try {
    return fn();
  } catch (error) {
    throw fsError(error, code);
  }
}

/**
 * The file system calls the space folder code makes. Production code uses NODE_IO. Tests pass
 * their own to inject a short write or a failure, without replacing node:fs for everyone.
 */
export interface FileIo {
  openSync(path: string, flags: string, mode?: number): number;
  /** Writes up to `length` bytes of `buffer` from `offset`, and returns how many it wrote. */
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: null): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { recursive?: boolean; force: boolean }): void;
  /** Sets the mode of the open file `fd` (POSIX; never called on Windows). */
  fchmodSync(fd: number, mode: number): void;
}

export const NODE_IO: FileIo = {
  openSync: (path, flags, mode) => openSync(path, flags, mode),
  fchmodSync: (fd, mode) => {
    fchmodSync(fd, mode);
  },
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  readSync: (fd, buffer, offset, length, position) =>
    readSync(fd, buffer, offset, length, position),
  fsyncSync: (fd) => {
    fsyncSync(fd);
  },
  closeSync: (fd) => {
    closeSync(fd);
  },
  renameSync: (from, to) => {
    renameSync(from, to);
  },
  rmSync: (path, options) => {
    rmSync(path, options);
  },
};

/**
 * Removes a file or folder left by a failed step, and drops any error doing so: the step's own
 * error is the one that matters. A leftover is named so that M1.10's start-up cleanup finds it.
 */
export function removeQuietly(path: string, io: FileIo = NODE_IO): void {
  try {
    io.rmSync(path, { recursive: true, force: true });
  } catch {
    // The caller is already on its way out with the first error.
  }
}

/** Runs `fn`; when it fails, runs `cleanup` (whose own errors are dropped) and throws the first. */
function withCleanup<T>(fn: () => T, cleanup: () => void): T {
  try {
    return fn();
  } catch (error) {
    try {
      cleanup();
    } catch {
      // The first error is the one the caller sees.
    }
    throw error;
  }
}

/** Flushes a folder's entries (a rename or a new file) to disk. Windows has no folder fsync. */
export function fsyncFolder(folder: string, io: FileIo = NODE_IO): void {
  if (process.platform === "win32") return;
  fsCall(() => {
    const fd = io.openSync(folder, "r");
    try {
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
  });
}

/** A1 3.x: space folders and the folders storage makes in or beside them. */
export const FOLDER_MODE = 0o700;
/** A1: database files and every other file storage writes. */
export const FILE_MODE = 0o600;

/**
 * Creates `path` as a new file (exclusively: never through a link, never over anything) with
 * exactly `mode`, and returns its open descriptor. When the mode cannot be set the new file is
 * removed and the error thrown. Node's errors pass through: the caller maps them (fsCall). The
 * same rule as @tasks/files' createFile, through `io`, the seam storage's tests inject failures
 * at.
 */
export function createFileExact(
  path: string,
  mode: number = FILE_MODE,
  io: FileIo = NODE_IO,
  flags: CreateFlags = "wx",
): number {
  const fd = io.openSync(path, flags, mode);
  if (process.platform !== "win32") {
    try {
      io.fchmodSync(fd, mode);
    } catch (error) {
      closeQuietly(fd, io);
      removeQuietly(path, io);
      throw error;
    }
  }
  return fd;
}

/** Creates `path` as a new empty file with exactly `mode` (createFileExact), and closes it. */
export function createEmptyFile(path: string, mode: number = FILE_MODE): void {
  closeSync(createFileExact(path, mode));
}

/**
 * Creates `dir`, and with `recursive` every missing folder above it, through @tasks/files: one
 * folder at a time, never with mkdir's recursive flag. A folder whose mkdir this call saw succeed
 * gets exactly `mode`, set on an O_NOFOLLOW descriptor of this user's folder; one that was already
 * there (EEXIST), or that another process made first, keeps its mode. Without `recursive`, an
 * existing `dir` throws EEXIST as mkdir does; with it, an existing folder is fine. Node's errors
 * pass through.
 */
export function makeDirExact(
  dir: string,
  mode: number = FOLDER_MODE,
  options: { recursive: boolean } = { recursive: false },
): void {
  makeDir(dir, mode, { recursive: options.recursive });
}

const randomHex = (): string => {
  const bytes = new Uint8Array(8);
  osRandom(bytes);
  return Buffer.from(bytes).toString("hex");
};

/** Writes every byte of `data`. A write may take fewer bytes than asked; this loops until done. */
function writeAll(io: FileIo, fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const written = io.writeSync(fd, data, offset, data.length - offset);
    // A write that takes nothing would loop for ever: treat it as the I/O error it is.
    if (!Number.isSafeInteger(written) || written <= 0 || written > data.length - offset) {
      throw new StorageError("DURABILITY_FAILED", "A file write made no progress");
    }
    offset += written;
  }
}

/**
 * Writes `name` in `folder` atomically (A1 3.1): the UTF-8 bytes to a temporary file
 * `.<name>.tmp-<random>`, every byte written, fsync, rename over the old file, fsync of the folder.
 * A crash leaves the old file or the new one, never a part, and at most a temporary file, which
 * M1.10's start-up cleanup removes. A failure removes the temporary file and throws the first error.
 */
export function writeFileAtomic(
  folder: string,
  name: string,
  text: string,
  io: FileIo = NODE_IO,
): void {
  const temporary = join(folder, `.${name}.tmp-${randomHex()}`);
  const data = Buffer.from(text, "utf8");
  const fd = fsCall(() => createFileExact(temporary, FILE_MODE, io));
  let open = true;
  withCleanup(
    () => {
      fsCall(() => {
        writeAll(io, fd, data);
        io.fsyncSync(fd);
        // Marked closed before the call: a failed close leaves the descriptor in an unknown state,
        // and closing it again could close another file's.
        open = false;
        io.closeSync(fd);
        io.renameSync(temporary, join(folder, name));
      });
    },
    () => {
      if (open) closeQuietly(fd, io);
      removeQuietly(temporary, io);
    },
  );
  fsyncFolder(folder, io);
}

function closeQuietly(fd: number, io: FileIo): void {
  try {
    io.closeSync(fd);
  } catch {
    // Only reached on the way out with an earlier error.
  }
}

/** What a bounded read found. */
export type BoundedRead =
  | { state: "missing" }
  /** The file holds more than the limit. Only the limit and one byte more were read. */
  | { state: "too_large" }
  | { state: "ok"; bytes: Uint8Array };

/**
 * Reads at most `limit` bytes of a file, so a huge or endless file cannot exhaust memory. A file
 * with more is reported as too large without reading the rest.
 */
export function readBounded(path: string, limit: number, io: FileIo = NODE_IO): BoundedRead {
  let fd: number;
  try {
    fd = io.openSync(path, "r");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { state: "missing" };
    throw fsError(error);
  }
  let open = true;
  return withCleanup(
    () =>
      fsCall((): BoundedRead => {
        const buffer = new Uint8Array(limit + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = io.readSync(fd, buffer, length, buffer.length - length, null);
          if (read <= 0) break;
          length += read;
        }
        open = false;
        io.closeSync(fd);
        return length > limit
          ? { state: "too_large" }
          : { state: "ok", bytes: buffer.slice(0, length) };
      }),
    () => {
      if (open) closeQuietly(fd, io);
    },
  );
}

/** A short random name part for temporary files and folders. */
export const temporaryTag = randomHex;
