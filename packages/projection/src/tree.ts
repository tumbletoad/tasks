// The projection's acts on its tree, the space's `view/` (A1 3.13 rules 2, 3, 4 and 6). Nothing
// here reads the database or the trusted state: the caller hands in what the record holds for a
// path (state.ts).
//
// - **One proof of ownership** (rule 2), for every replace and every delete, decided right before
//   the act in one synchronous stretch, with no await between the check and the act: each folder
//   from the tree's root to the entry is a real folder (lstat: a link or a junction is not), and the
//   entry is a regular file with exactly one link whose bytes, read through one descriptor that is
//   checked to be the entry lstat saw, hash to what the record holds for that path. Anything else
//   is not ours. A file that already holds exactly the bytes about to be placed is left as it is:
//   nothing is replaced, so nothing can be lost.
// - **What is not ours** is never written through, overwritten, deleted, and its mode never changed
//   (rule 3). Where the projection needs its path, it is rescued by one rename of the entry itself
//   (never followed) into a folder made for that one rescue: `exchange/rescued/<stem>-<n>/view/` in
//   the space's folder, under its path in the tree. `exchange/` and `exchange/rescued/` must be
//   real folders, checked first; the rescue folder is made exclusively, never reused. The rename
//   happened or it did not.
// - **A placement** (rule 6): the folders on the way are made (a non-folder there is rescued), the
//   new content goes to a temporary file beside its place, ownership of what is at the path is
//   decided, what is not ours is rescued, and the temporary file is renamed to the path. A file is
//   read-only from its creation (0400, or the Windows read-only attribute). Windows refuses a
//   rename over a read-only file, so the attribute of a proven file of ours is cleared through the
//   descriptor that proved it; on a sharing violation the check and the act run again, up to 5
//   times over 1 s.
// - **Temporary files prove themselves** (rule 4): `.<name>.<32 hex>.<8 hex>.tmp`, the first part
//   the start of the content's SHA-256, the second a random tag of the batch. Clean-up removes one
//   only when its content hashes to its name, or when it is empty and the trusted journal names it
//   (a name alone proves nothing: a person may type into a leftover); any other leftover stays.
//
// Not covered, and the contract says so (A1 3.13): a program that replaces a folder of the tree
// with a link between the check and the act (the runtime has no handle-anchored file operations),
// and a save that lands between the ownership check and the rename.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createFile, makeDir, writeAll } from "@tasks/files";

/** The files at the tree's root besides the tasks', in the order a publish places them. */
export const ROOT_FILES = ["README.md", "index.md", "catalog.jsonl", ".projection.json"] as const;

/** A task's file: `open/`, `completed/<year>/` or `archived/<year>/`, then `<ref>-<slug>.md`. */
export const TASK_FILE =
  /^(open|completed\/[0-9]{4}|archived\/[0-9]{4})\/[A-Z]{1,6}-[1-9][0-9]{0,9}-[a-z0-9-]{1,48}\.md$/;
const TASK_FOLDER = /^(open|completed\/[0-9]{4}|archived\/[0-9]{4})$/;
/** A temporary file's name: the file's own, the start of the content's hash, the batch's tag. */
const TEMP_NAME = /^\.(.+)\.([0-9a-f]{32})\.([0-9a-f]{8})\.tmp$/;
/** A file is hashed in parts of this size: a generated file has no size limit. */
const CHUNK_BYTES = 1024 * 1024;
const FILE_MODE = 0o400;
const FOLDER_MODE = 0o700;
/** A1 3.13: on a Windows sharing violation the check and the act run again, 5 times over 1 s. */
const TRIES = 5;
const PAUSE_MS = 200;
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** Whether `path` is a path the projection writes: a task's file or a root file. */
export const isTreePath = (path: string): boolean =>
  TASK_FILE.test(path) || (ROOT_FILES as readonly string[]).includes(path);

const split = (path: string): { folder: string; name: string } => {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { folder: "", name: path }
    : { folder: path.slice(0, slash), name: path.slice(slash + 1) };
};

/** Whether `path` is a temporary file of a path the projection writes. */
export function isTempPath(path: string): boolean {
  const { folder, name } = split(path);
  const match = TEMP_NAME.exec(name);
  if (match === null) return false;
  const inner = match[1] ?? "";
  return isTreePath(folder === "" ? inner : `${folder}/${inner}`);
}

/** The temporary file of `path` for content hashing to `sha256`, in a batch tagged `tag`. */
export function tempPathOf(path: string, sha256: string, tag: string): string {
  const { folder, name } = split(path);
  const temp = `.${name}.${sha256.slice(0, 32)}.${tag}.tmp`;
  return folder === "" ? temp : `${folder}/${temp}`;
}

export const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** A failure with an errno-style code and no path: a path holds a task's title. */
export class ProjectionError extends Error {
  override readonly name = "ProjectionError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const ERRNO = /^E[A-Z0-9]{1,20}$/;

/** The errno code of a file system error, else `code`. Never the message, which holds the path. */
export function codeOf(error: unknown, code = "EIO"): string {
  if (error instanceof ProjectionError) return error.code;
  const found = (error as { code?: unknown } | null)?.code;
  return typeof found === "string" && (ERRNO.test(found) || /^[A-Z_]{3,40}$/.test(found))
    ? found
    : code;
}

const codeIs = (error: unknown, ...codes: string[]): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && codes.includes(code);
};

/** The SHA-256 and size of what `fd` holds, read in parts from its start. */
function hashOf(fd: number): { sha256: string; size: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let size = 0;
  for (;;) {
    const n = readSync(fd, buffer, 0, CHUNK_BYTES, size);
    if (n === 0) break;
    hash.update(buffer.subarray(0, n));
    size += n;
  }
  return { sha256: hash.digest("hex"), size };
}

const pauseSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Every act on disk, named for the crash tests: a hook runs before each. */
export type Act =
  | "mkdir"
  | "temp"
  | "write"
  | "chmod"
  | "rename"
  | "rescue"
  | "unlink"
  | "rmdir"
  | "record"
  | "journal"
  | "journal-drop"
  /** Not a file at the record's or the journal's path, moved aside (state.ts). */
  | "aside";

/** Tests only: runs before every act on disk. Throwing is a kill: the act does not happen. */
export type Hook = (act: Act, path: string) => void;

/** What the record holds for a path: what the projection placed there. */
export interface Owned {
  readonly sha256: string;
  readonly size: number;
}

/** What is at a path of the tree, looked at without acting. */
export type Look =
  | { readonly kind: "missing" }
  /** A folder on the way is not a real folder: nothing behind it is the tree's. */
  | { readonly kind: "unreachable" }
  | {
      readonly kind: "file";
      readonly sha256: string;
      readonly size: number;
      readonly links: number;
    }
  /** A folder, a link, a file that could not be read: never a file of the projection's. */
  | { readonly kind: "other" }
  /**
   * Held open by another program that shares nothing (Windows: an editor, a scanner, a backup
   * tool): what it holds is unknown for now, and it may well still be the projection's.
   */
  | { readonly kind: "busy" };

/** A regular file read through one descriptor, still open. */
interface Opened {
  readonly kind: "file";
  readonly fd: number;
  readonly sha256: string;
  readonly size: number;
  readonly links: number;
  readonly ino: bigint;
  readonly dev: bigint;
}

/** The rescue folders of one batch: `exchange/rescued/<stem>-<n>`, each made for one rescue. */
export class Rescues {
  readonly stem: string;
  /** The rescue folders that hold what was rescued, relative to the space's folder. */
  readonly made: string[] = [];
  #n = 0;
  constructor(stem: string) {
    this.stem = stem;
  }
  next(): string {
    this.#n += 1;
    return `${this.stem}-${String(this.#n)}`;
  }
}

/** A rescue stem as the projector makes it: a time stamp and 16 random bits. */
export const STEM = /^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{4}$/;
/** One rescue folder: `<stem>-<n>`. */
const RESCUE_FOLDER = /^([0-9]{8}T[0-9]{9}Z-[0-9a-f]{4})-[1-9][0-9]{0,5}$/;

/** A new batch's rescue stem: the time, and 16 random bits so two batches in one millisecond differ. */
export const newStem = (now: number): string =>
  `${new Date(now).toISOString().replace(/[-:.]/g, "")}-${randomBytes(2).toString("hex")}`;

/** A new batch's tag for its temporary files. */
export const newTag = (): string => randomBytes(4).toString("hex");

export interface TreeOptions {
  /** The space's folder: rescued entries go to its `exchange/rescued/`. */
  readonly spaceFolder: string;
  /** The tree's root: the space's `view/`. */
  readonly dir: string;
  readonly platform?: NodeJS.Platform;
  readonly at?: Hook;
}

/** The outcome of a placement. */
export type Placed = "written" | "same";

/** The projection's tree on disk. */
export class Tree {
  readonly #dir: string;
  readonly #space: string;
  readonly #win: boolean;
  readonly #at: Hook | undefined;
  #troubled = false;

  constructor(options: TreeOptions) {
    this.#dir = options.dir;
    this.#space = options.spaceFolder;
    this.#win = (options.platform ?? process.platform) === "win32";
    this.#at = options.at;
  }

  /**
   * Since the last newBatch, a folder of the tree was found missing or not a real folder: files the
   * record holds below it may be gone, so the projector reconciles (projector.ts).
   */
  get troubled(): boolean {
    return this.#troubled;
  }

  newBatch(): void {
    this.#troubled = false;
  }

  #act(act: Act, path: string): void {
    this.#at?.(act, path);
  }

  /** A path of the tree on disk; "" is the root. Only paths of the tree's grammar reach here. */
  #abs(path: string): string {
    return path === "" ? this.#dir : join(this.#dir, ...path.split("/"));
  }

  /** The folders from the root to `path`'s folder, the root ("") first. */
  static foldersOf(path: string): string[] {
    const parts = path.split("/").slice(0, -1);
    return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
  }

  #realFolder(rel: string): boolean {
    return lstatSync(this.#abs(rel), { throwIfNoEntry: false })?.isDirectory() === true;
  }

  /** Whether every folder on the way to `path` is a real folder now. lstat: nothing is followed. */
  #reachable(path: string): boolean {
    return Tree.foldersOf(path).every((rel) => this.#realFolder(rel));
  }

  /**
   * What a regular file at `abs` holds, read through one descriptor that is checked to be the entry
   * lstat saw (the same device and file), so a link swapped in between is never read as ours. The
   * descriptor stays open for the caller. A file whose size `wanted` refuses is not read: it can
   * hold none of the bytes it is compared with (its `sha256` is then empty).
   */
  #open(
    abs: string,
    wanted?: (size: number) => boolean,
  ): { kind: "missing" } | { kind: "other" } | Opened {
    const seen = lstatSync(abs, { bigint: true, throwIfNoEntry: false });
    if (seen === undefined) return { kind: "missing" };
    if (!seen.isFile()) return { kind: "other" };
    let fd: number;
    try {
      fd = openSync(abs, constants.O_RDONLY | NOFOLLOW);
    } catch (error) {
      if (codeIs(error, "ENOENT")) return { kind: "missing" };
      if (codeIs(error, "ELOOP", "EISDIR")) return { kind: "other" };
      throw error;
    }
    try {
      const stats = fstatSync(fd, { bigint: true });
      if (!stats.isFile() || stats.ino !== seen.ino || stats.dev !== seen.dev) {
        closeSync(fd);
        return { kind: "other" };
      }
      const known = { links: Number(stats.nlink), ino: stats.ino, dev: stats.dev };
      if (wanted !== undefined && !wanted(Number(stats.size))) {
        return { kind: "file", fd, sha256: "", size: Number(stats.size), ...known };
      }
      return { kind: "file", fd, ...hashOf(fd), ...known };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  /**
   * What is at `path`, without acting: for the reconciliation and the start. `folders` caches the
   * look at each folder for one pass: no act depends on it, every act checks again. A file of
   * another `size` than the one it is compared with is not read (its `sha256` is empty).
   */
  look(path: string, folders?: Map<string, boolean>, size?: number): Look {
    for (const rel of Tree.foldersOf(path)) {
      let real = folders?.get(rel);
      if (real === undefined) {
        real = this.#realFolder(rel);
        folders?.set(rel, real);
      }
      if (!real) return { kind: "unreachable" };
    }
    try {
      const found = this.#open(
        this.#abs(path),
        size === undefined ? undefined : (seen) => seen === size,
      );
      if (found.kind !== "file") return found;
      closeSync(found.fd);
      return { kind: "file", sha256: found.sha256, size: found.size, links: found.links };
    } catch (error) {
      return codeIs(error, "EBUSY") ? { kind: "busy" } : { kind: "other" };
    }
  }

  /**
   * Places `content` at `path` (rule 6). `owned` is what the record holds for the path, if
   * anything: only a file that proves itself ours by it is replaced; anything else is rescued
   * first. Throws when the file is not placed; a rescue that happened stays done, and counted in
   * `rescues`.
   */
  place(
    path: string,
    content: string,
    owned: Owned | undefined,
    rescues: Rescues,
    tag: string,
  ): Placed {
    const data = Buffer.from(content, "utf8");
    const hash = sha256(data);
    const abs = this.#abs(path);
    this.#folders(path, rescues);
    const temp = tempPathOf(path, hash, tag);
    const tempAbs = this.#abs(temp);
    this.#act("temp", temp);
    // Exclusive: an entry already there is never written through, replaced or removed.
    const fd = createFile(tempAbs, FILE_MODE);
    try {
      try {
        this.#act("write", temp);
        writeAll(fd, data);
      } finally {
        closeSync(fd);
      }
      for (let attempt = 1; ; attempt += 1) {
        try {
          const next = { sha256: hash, size: data.length };
          return this.#swap(path, abs, temp, tempAbs, next, owned, rescues);
        } catch (error) {
          if (!this.#win || !codeIs(error, "EPERM", "EBUSY", "EACCES") || attempt >= TRIES) {
            throw error;
          }
          pauseSync(PAUSE_MS);
        }
      }
    } catch (error) {
      this.#dropTemp(temp, tempAbs);
      throw error;
    }
  }

  /** The check and the act of a placement: one synchronous stretch (see the header). */
  #swap(
    path: string,
    abs: string,
    temp: string,
    tempAbs: string,
    next: Owned,
    owned: Owned | undefined,
    rescues: Rescues,
  ): Placed {
    if (!this.#reachable(path)) {
      this.#troubled = true;
      throw new ProjectionError("ENOTDIR", "A folder of the tree is not a real folder");
    }
    // Only a file of the new content's size or the recorded one can hold either.
    const found = this.#open(abs, (size) => size === next.size || size === owned?.size);
    if (found.kind === "missing") {
      this.#act("rename", path);
      renameSync(tempAbs, abs);
      return "written";
    }
    if (found.kind === "file") {
      let ours: boolean;
      try {
        if (found.links === 1 && found.size === next.size && found.sha256 === next.sha256) {
          this.#dropTemp(temp, tempAbs);
          return "same";
        }
        ours =
          found.links === 1 &&
          owned !== undefined &&
          found.size === owned.size &&
          found.sha256 === owned.sha256;
        if (ours && this.#win) {
          // Windows refuses a rename over a read-only file: the attribute of this file, the one
          // just proved ours, goes through its own descriptor, never through the path.
          this.#act("chmod", path);
          fchmodSync(found.fd, 0o600);
        }
      } finally {
        closeSync(found.fd);
      }
      if (ours) {
        try {
          this.#act("rename", path);
          renameSync(tempAbs, abs);
        } catch (error) {
          this.#readOnlyAgain(abs, found);
          throw error;
        }
        return "written";
      }
    }
    // Not ours: one rename takes it aside, then the new file takes its place.
    this.#rescue(path, abs, rescues);
    this.#act("rename", path);
    renameSync(tempAbs, abs);
    return "written";
  }

  /** Windows: a proven file of ours whose replacement failed gets its read-only attribute back. */
  #readOnlyAgain(abs: string, proved: Opened): void {
    if (!this.#win) return;
    try {
      const fd = openSync(abs, constants.O_RDONLY);
      try {
        const stats = fstatSync(fd, { bigint: true });
        if (stats.ino === proved.ino && stats.dev === proved.dev) {
          this.#act("chmod", "");
          fchmodSync(fd, 0o444);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // It stays writable: its hash still guards it.
    }
  }

  /**
   * Removes a temporary file this placement made, in the synchronous stretch that made it (no
   * await since): a regular file with one link, while its folder is still a real one of the tree.
   */
  #dropTemp(temp: string, tempAbs: string): void {
    try {
      if (!this.#reachable(temp)) return;
      const stats = lstatSync(tempAbs, { throwIfNoEntry: false });
      if (stats?.isFile() !== true || stats.nlink !== 1) return;
      this.#act("unlink", temp);
      unlinkSync(tempAbs);
    } catch {
      // Left: the journal names it, and its content proves it ours at the next clean-up.
    }
  }

  /**
   * Makes each folder from the root to `path`'s folder a real folder: a missing one is made with
   * mode 0700, anything else there (a file, a link, a junction) is rescued first. Either way the
   * tree was not what the record says, so it is reported (troubled).
   */
  #folders(path: string, rescues: Rescues): void {
    for (const rel of Tree.foldersOf(path)) {
      const abs = this.#abs(rel);
      const stats = lstatSync(abs, { throwIfNoEntry: false });
      if (stats?.isDirectory() === true) continue;
      this.#troubled = true;
      if (stats !== undefined) this.#rescue(rel, abs, rescues);
      this.#act("mkdir", rel);
      makeDir(abs, FOLDER_MODE, { recursive: false });
    }
  }

  /**
   * Moves the entry at `abs` (tree path `rel`, "" for the root) by one rename into a rescue folder
   * made for it: `exchange/rescued/<stem>-<n>/view/<rel>` (rule 3). Never followed, never copied,
   * its mode never changed. Throws when it did not move; the folders made for it go again.
   */
  #rescue(rel: string, abs: string, rescues: Rescues): void {
    const exchange = join(this.#space, "exchange");
    const rescued = join(exchange, "rescued");
    for (const folder of [exchange, rescued]) {
      const stats = lstatSync(folder, { throwIfNoEntry: false });
      if (stats === undefined) {
        this.#act("mkdir", "");
        makeDir(folder, FOLDER_MODE, { recursive: false });
      } else if (!stats.isDirectory()) {
        throw new ProjectionError("ENOTDIR", "The space's rescue folder is not a real folder");
      }
    }
    const name = this.#freshFolder(rescued, rescues);
    const box = join(rescued, name);
    const made = [box];
    try {
      let at = join(box, "view");
      if (rel !== "") {
        this.#act("mkdir", "");
        makeDir(at, FOLDER_MODE, { recursive: false });
        made.push(at);
        for (const part of rel.split("/").slice(0, -1)) {
          at = join(at, part);
          this.#act("mkdir", "");
          makeDir(at, FOLDER_MODE, { recursive: false });
          made.push(at);
        }
        at = join(at, rel.split("/").at(-1) ?? "");
      }
      this.#act("rescue", rel);
      renameSync(abs, at);
    } catch (error) {
      for (const folder of made.reverse()) {
        try {
          this.#act("rmdir", "");
          rmdirSync(folder);
        } catch {
          // Not empty, or gone: left.
        }
      }
      throw error;
    }
    rescues.made.push(`exchange/rescued/${name}`);
  }

  /** Makes the next rescue folder of the batch in `rescued`, exclusively: never one made before. */
  #freshFolder(rescued: string, rescues: Rescues): string {
    for (let tries = 1; ; tries += 1) {
      const name = rescues.next();
      try {
        this.#act("mkdir", "");
        makeDir(join(rescued, name), FOLDER_MODE, { recursive: false });
        return name;
      } catch (error) {
        if (!codeIs(error, "EEXIST") || tries >= 100) throw error;
      }
    }
  }

  /**
   * Removes the file at `path` when it proves itself ours by `owned` (rule 2), in one synchronous
   * stretch. Anything else is not ours and is left where it is; a folder on the way that is not a
   * real folder means nothing behind it is the tree's.
   */
  remove(path: string, owned: Owned): "removed" | "not-ours" | "missing" {
    const abs = this.#abs(path);
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (!this.#reachable(path)) {
          this.#troubled = true;
          return "not-ours";
        }
        const found = this.#open(abs, (size) => size === owned.size);
        if (found.kind === "missing") return "missing";
        if (found.kind !== "file") return "not-ours";
        let ours: boolean;
        try {
          ours = found.links === 1 && found.size === owned.size && found.sha256 === owned.sha256;
        } finally {
          closeSync(found.fd);
        }
        if (!ours) return "not-ours";
        // Node's unlink on Windows clears a read-only attribute through its own handle, opened
        // without following a link.
        this.#act("unlink", path);
        unlinkSync(abs);
        return "removed";
      } catch (error) {
        if (!this.#win || !codeIs(error, "EPERM", "EBUSY", "EACCES") || attempt >= TRIES) {
          throw error;
        }
        pauseSync(PAUSE_MS);
      }
    }
  }

  /**
   * Removes the temporary files a kill left (rule 4): in every folder the tree writes, those whose
   * content hashes to their name, and of those the trusted journal `named`, also an empty one (a
   * kill between its creation and its write). A name alone proves nothing: a person may have typed
   * into a leftover. Each must be a regular file with one link, reached through real folders.
   * Anything else stays. Returns how many went.
   */
  cleanTemps(named: readonly string[]): number {
    let removed = 0;
    const journalled = new Set(named.filter((temp) => isTempPath(temp)));
    const tryRemove = (temp: string, prefix: string): void => {
      if (!this.#reachable(temp)) return;
      const abs = this.#abs(temp);
      try {
        const found = this.#open(abs);
        if (found.kind !== "file") return;
        let ours: boolean;
        try {
          ours =
            found.links === 1 &&
            (found.sha256.startsWith(prefix) || (found.size === 0 && journalled.has(temp)));
        } finally {
          closeSync(found.fd);
        }
        if (!ours) return;
        this.#act("unlink", temp);
        unlinkSync(abs);
        removed += 1;
      } catch {
        // Held, or gone: the next clean-up looks again.
      }
    };
    for (const folder of this.#tempFolders()) {
      let names: string[];
      try {
        names = readdirSync(this.#abs(folder));
      } catch {
        continue;
      }
      for (const name of names) {
        const temp = folder === "" ? name : `${folder}/${name}`;
        const match = TEMP_NAME.exec(name);
        if (match === null || !isTempPath(temp)) continue;
        tryRemove(temp, match[2] ?? "");
      }
    }
    return removed;
  }

  /** The folders the tree writes, where they are real folders: the root, open/, the year folders. */
  #tempFolders(): string[] {
    if (!this.#realFolder("")) return [];
    const folders = [""];
    if (this.#realFolder("open")) folders.push("open");
    for (const state of ["completed", "archived"]) {
      if (!this.#realFolder(state)) continue;
      for (const year of readdirSync(this.#abs(state))) {
        const rel = `${state}/${year}`;
        if (TASK_FOLDER.test(rel) && this.#realFolder(rel)) folders.push(rel);
      }
    }
    return folders;
  }

  /**
   * The projection's rescue folders on disk (rule 3), by their batch's stem, oldest first, with
   * how many each stem has: every real folder `exchange/rescued/<stem>-<n>` with a `view` in it,
   * reached through real folders. They are the evidence of what was rescued, whatever the trusted
   * state says, so a rescue is told until it is (projector.ts). Read only, nothing followed.
   */
  rescueFolders(): Map<string, number> {
    const found = new Map<string, number>();
    const exchange = join(this.#space, "exchange");
    const rescued = join(exchange, "rescued");
    for (const folder of [exchange, rescued]) {
      if (lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() !== true) return found;
    }
    for (const name of readdirSync(rescued).sort()) {
      const match = RESCUE_FOLDER.exec(name);
      const stem = match?.[1];
      if (stem === undefined) continue;
      if (lstatSync(join(rescued, name), { throwIfNoEntry: false })?.isDirectory() !== true) {
        continue;
      }
      if (lstatSync(join(rescued, name, "view"), { throwIfNoEntry: false }) === undefined) continue;
      found.set(stem, (found.get(stem) ?? 0) + 1);
    }
    return found;
  }
}
