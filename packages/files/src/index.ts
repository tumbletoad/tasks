// Files and folders created with exactly the mode the plan names, whatever the umask (A2 3.2.2
// rule 5). This is the one implementation the service,
// storage, launch and the CLI's shim create through. It is a package of its own because launch and
// the shim may import neither the service nor storage (A7 3.2), and it depends on nothing in the
// repository, so every package may use it.
//
// The mode given to open or mkdir is masked by the process's umask, which differs per system (002
// on a desktop with user private groups, 022 elsewhere, 077 on a hardened one). So the mode is set
// on the new object itself, through a descriptor, which ignores the umask and follows no link. A
// file or folder that was already there keeps its mode: it may be the person's choice. Windows keeps
// the ACL the object inherited (A2 3.2.2 rule 5), so no mode is set there. Node's errors pass
// through with their code; callers map them.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import {
  mkdir as mkdirAsync,
  open as openAsync,
  rename as renameAsync,
  rm as rmAsync,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/**
 * Sets the mode of the file or folder open at `fd` to exactly `mode` (POSIX). Windows keeps the
 * ACL the object inherited, so nothing happens there.
 */
export function setModeOf(fd: number, mode: number, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") fchmodSync(fd, mode);
}

/** The flags a new file is created with: always exclusive. `wx+` also reads back. */
export type CreateFlags = "wx" | "ax" | "wx+";

/**
 * Creates `path` as a new file (exclusively, so never through a link or over anything) with
 * exactly `mode`, and returns its open descriptor. When the mode cannot be set, the new file is
 * removed and the error thrown.
 */
export function createFile(path: string, mode: number, flags: CreateFlags = "wx"): number {
  const fd = openSync(path, flags, mode);
  try {
    setModeOf(fd, mode);
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  return fd;
}

/** Opens an existing file for appending: never creates one, never through a link (POSIX). */
const APPEND_EXISTING =
  constants.O_WRONLY |
  constants.O_APPEND |
  ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);

/** How often a file that keeps going away between the create and the open is tried again. */
const APPEND_TRIES = 3;

const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException | null)?.code;

/**
 * Opens `path` for appending. A file that is not there is created exclusively with exactly
 * `mode`. One that is keeps its mode, and is opened by flags that cannot create it: removed in
 * between (a rotation), it is created again, exclusively, rather than by the append's open, whose
 * new file would take its mode from the umask.
 */
function openForAppend(path: string, mode: number): number {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return createFile(path, mode, "ax");
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
    }
    try {
      return openSync(path, APPEND_EXISTING);
    } catch (error) {
      if (codeOf(error) !== "ENOENT" || attempt >= APPEND_TRIES) throw error;
    }
  }
}

/**
 * Writes every byte of `data` (a string as UTF-8) at `fd`'s position, or throws (A2 3.2.2 rule 5,
 * "whole writes"). One write may take fewer bytes than it was given (a full volume, a signal, a
 * network file system), so the count each returns is followed until nothing is left; a write that
 * takes none throws EIO rather than spin. Every write of durable state goes through this.
 */
export function writeAll(fd: number, data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!(n > 0)) {
      throw Object.assign(new Error("A write made no progress"), { code: "EIO" });
    }
    offset += n;
  }
}

/**
 * Appends `text` to `path`. A file that is not there yet is created with exactly `mode`; one that
 * is keeps its mode. A link in its place is not followed.
 */
export function appendPrivate(path: string, text: string, mode = 0o600): void {
  const fd = openForAppend(path, mode);
  try {
    writeAll(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * Gives the folder this call's mkdir just made exactly `mode` (POSIX). It is opened without
 * following a link (O_NOFOLLOW) and only as a folder (O_DIRECTORY), and its descriptor must show a
 * folder of this user before the mode is set on that descriptor. What remains is the moment
 * between the mkdir and the open, in which a process of this same user could put another folder
 * of its own there (A2 3.2.2 rule 5): another user cannot, since every folder Tasks creates in sits
 * in a parent others cannot write.
 */
function setNewFolderMode(folder: string, mode: number): void {
  const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const uid = process.getuid?.();
    if (uid !== undefined && fstatSync(fd).uid !== uid) {
      throw Object.assign(new Error("A folder this call made belongs to another user"), {
        code: "EPERM",
      });
    }
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

const isFolder = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

export interface MakeDirOptions {
  /**
   * True (the default): every missing folder above `dir` is made too, and an existing `dir` that
   * is a folder (or a link to one) is fine, as with `mkdir -p`. False: only `dir` itself, whose
   * folder must exist, and anything already at `dir` throws EEXIST, as mkdir does.
   */
  readonly recursive?: boolean;
  readonly platform?: NodeJS.Platform;
}

/**
 * Creates `dir`, one folder at a time and never with mkdir's recursive flag. A folder whose mkdir
 * this call saw succeed gets exactly `mode`, or with `"umask"` what a plain mkdir gives it under the
 * process's umask: a person's own folder, such as a checkout, not one of the product's. One that was
 * already there (EEXIST), or that another process made first, is someone's choice and keeps its
 * mode. A file where a folder belongs throws EEXIST. Returns the folders this call made, outermost
 * first.
 */
export function makeDir(
  dir: string,
  mode: number | "umask" = 0o700,
  options: MakeDirOptions = {},
): string[] {
  const recursive = options.recursive ?? true;
  const platform = options.platform ?? process.platform;
  const exact = mode === "umask" ? undefined : mode;
  const made: string[] = [];
  const makeOne = (folder: string, top: boolean): void => {
    try {
      mkdirSync(folder, { mode: exact ?? 0o777 });
    } catch (error) {
      if (!recursive && top) throw error;
      const code = codeOf(error);
      if (code === "EEXIST" && isFolder(folder)) return;
      const parent = dirname(folder);
      if (code !== "ENOENT" || parent === folder) throw error;
      makeOne(parent, false);
      try {
        mkdirSync(folder, { mode: exact ?? 0o777 });
      } catch (again) {
        if (codeOf(again) === "EEXIST" && isFolder(folder)) return;
        throw again;
      }
    }
    made.push(folder);
    if (platform !== "win32" && exact !== undefined) setNewFolderMode(folder, exact);
  };
  makeOne(resolve(dir), true);
  return made;
}

/** The prefix of the temporary files atomicWrite makes for `name`. */
const tempPrefix = (name: string) => `.${name}.`;
const TEMP_SUFFIX = ".tmp";

const RENAME_TRIES = 5;
const RENAME_PAUSE_MS = 20;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Replaces `path` with `text` atomically: a new temporary file beside it
 * (`.<name>.<pid>.<random>.tmp`, exactly `mode`), written whole (writeAll) and flushed, then renamed
 * over it. Readers see the old file or the new one, never a part. On Windows a rename over a file that
 * another process has open without delete sharing fails for a moment, so it is tried a few times.
 * A failed write leaves no temporary file. `beforeRename` runs once the new file is written and
 * flushed, just before each rename attempt: it throws to give up, and the temporary file is removed
 * (a caller's last check that the file is still the one it read).
 */
export function atomicWrite(
  path: string,
  text: string,
  mode = 0o600,
  beforeRename?: () => void,
): void {
  const temp = join(
    dirname(path),
    `${tempPrefix(basename(path))}${String(process.pid)}.${randomBytes(4).toString("hex")}${TEMP_SUFFIX}`,
  );
  const fd = createFile(temp, mode);
  try {
    try {
      writeAll(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    for (let attempt = 1; ; attempt += 1) {
      // Before every attempt: a retry's pause is time in which the file can change.
      beforeRename?.();
      try {
        renameSync(temp, path);
        return;
      } catch (error) {
        const code = codeOf(error);
        const busy = code === "EPERM" || code === "EBUSY" || code === "EACCES";
        if (!busy || attempt >= RENAME_TRIES) throw error;
        pause(RENAME_PAUSE_MS);
      }
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

// The same writes for a person's own folders, which may be on a volume that stops answering (a
// network share): they never hold the process while it waits, so a caller can stop waiting.

/** As makeDir with `recursive: false`: only `dir`, in a folder that exists; EEXIST when taken. */
export async function makeDirAsync(
  dir: string,
  mode: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await mkdirAsync(dir, { mode });
  if (platform === "win32") return;
  const handle = await openAsync(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const uid = process.getuid?.();
    if (uid !== undefined && (await handle.stat()).uid !== uid) {
      throw Object.assign(new Error("A folder this call made belongs to another user"), {
        code: "EPERM",
      });
    }
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

/** As createFile: a new file, exclusively, with exactly `mode`; the open handle. */
export async function createFileAsync(
  path: string,
  mode: number,
  platform: NodeJS.Platform = process.platform,
): Promise<FileHandle> {
  const handle = await openAsync(path, "wx", mode);
  try {
    if (platform !== "win32") await handle.chmod(mode);
  } catch (error) {
    await handle.close();
    await rmAsync(path, { force: true });
    throw error;
  }
  return handle;
}

/** As atomicWrite: a temporary file beside `path`, written whole and flushed, renamed over it. */
export async function atomicWriteAsync(path: string, text: string, mode: number): Promise<void> {
  const temp = join(
    dirname(path),
    `${tempPrefix(basename(path))}${String(process.pid)}.${randomBytes(4).toString("hex")}${TEMP_SUFFIX}`,
  );
  const handle = await createFileAsync(temp, mode);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await renameAsync(temp, path);
        return;
      } catch (error) {
        const code = codeOf(error);
        const busy = code === "EPERM" || code === "EBUSY" || code === "EACCES";
        if (!busy || attempt >= RENAME_TRIES) throw error;
        await sleep(RENAME_PAUSE_MS);
      }
    }
  } catch (error) {
    await rmAsync(temp, { force: true });
    throw error;
  }
}

/**
 * Removes the temporary files a crash left beside `names` in `dir` (atomicWrite's
 * `.<name>.<pid>.<random>.tmp`). Only a process that no other writes these files beside (the
 * holder of service.lock) calls it. Returns how many it removed.
 */
export function removeStaleTemps(dir: string, names: readonly string[]): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(TEMP_SUFFIX)) continue;
    if (!names.some((name) => entry.startsWith(tempPrefix(name)))) continue;
    try {
      rmSync(join(dir, entry), { force: true });
      removed += 1;
    } catch {
      // Still held by something: the next start tries again.
    }
  }
  return removed;
}
