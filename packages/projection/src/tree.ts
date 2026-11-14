// The projection's files on disk (A1 3.13 steps 3 and 4): every file it writes, removes or rescues,
// and its record of them. Nothing here reads the database.
//
// Rules:
// - **Only inside its folder.** Every path is relative, `/`-separated and matches the tree's
//   grammar (isTreePath) before it is joined to the folder, also a path read back from the record,
//   so neither a title nor an edited record can reach outside it. Every read, removal and write
//   first checks each folder of the path with lstat: a link (a junction included) or a file where a
//   folder belongs is never followed. A write rescues it and makes the folder; a read or a removal
//   finds nothing there. Either way the folder is reported lost (lostFolders): the files the record
//   placed in it are no longer in the tree, and the projector rebuilds (projector.ts).
// - **A person's edit is never lost.** The record (`.projection-files.json`, what A1 3.4 calls
//   `projection_files`) holds the SHA-256 of each file as written. A file that is replaced or
//   removed must hash to a value the caller knows as its own; anything else at that path (an edited
//   file, a file of the person's, a folder, a link) is moved to the space's
//   `exchange/rescued/<stamp>/` under its path in the tree first, and counted. Best effort, as A1
//   says: a save between the hash and the rename is lost.
// - **Read-only.** A file is created with mode 0400 (POSIX) or the read-only attribute (Windows),
//   through @tasks/files' exact-mode create, and renamed over the old one. Windows refuses a rename
//   over a read-only file, so the old one is made writable just before, and read-only again when
//   the rename fails.
// - **Crash-safe.** A file is written to `.<name>.tmp-<16 hex>` beside its place and renamed; a
//   kill leaves the old file or the new one and at most a temporary file, which `cleanTemps`
//   removes at start. The record and the journal are written atomically and flushed. A projected
//   file is not flushed: it is derived, and one a power cut tore fails its hash and is rendered
//   again (rescued first, as an unknown file is), so a rebuild of 55,000 files does not pay one
//   flush each (A1 3.20).
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWrite, createFile, makeDir, removeStaleTemps } from "@tasks/files";
import {
  FORMAT,
  LIFECYCLES,
  type CatalogEntry,
  type Lifecycle,
  type SpaceIdentity,
} from "./render.ts";

/** The record of the files the projection wrote (A1 3.4's `projection_files`). */
export const RECORD_FILE = ".projection-files.json";
/** What a batch is about to write, so a kill in the middle loses nothing (projector.ts). */
export const JOURNAL_FILE = ".projection-journal.json";

/** The files at the tree's root besides the tasks', in the order a publish writes them. */
export const ROOT_FILES = ["README.md", "index.md", "catalog.jsonl", ".projection.json"] as const;

const TASK_FILE =
  /^(open|completed\/[0-9]{4}|archived\/[0-9]{4})\/[A-Z]{1,6}-[1-9][0-9]{0,9}-[a-z0-9-]{1,48}\.md$/;
const TEMP = /^\..+\.tmp-[0-9a-f]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A file larger than this is no file the projection wrote: a task's file is far smaller. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** A record or a journal larger than this is not read (a design-scale record is about 30 MB). */
const MAX_RECORD_BYTES = 256 * 1024 * 1024;
const FILE_MODE = 0o400;
const FOLDER_MODE = 0o700;
/** A1 3.13 step 4: a rename is tried 5 times over 1 s on Windows sharing violations. */
const RENAME_TRIES = 5;
const RENAME_PAUSE_MS = 200;

/** Whether `path` is a path the projection writes: a task's file or a root file. */
export const isTreePath = (path: string): boolean =>
  TASK_FILE.test(path) || (ROOT_FILES as readonly string[]).includes(path);

export const sha256 = (text: string | Uint8Array): string =>
  createHash("sha256").update(text).digest("hex");

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

/** A task's place in the tree, as the record keeps it. */
export interface TaskRecord {
  readonly path: string;
  readonly sha256: string;
  /** Its catalogue line as rendered: the catalogue is assembled from these (A1 3.13 step 6). */
  readonly entry: CatalogEntry;
}

/** The record of a tree (A1 3.13): what it was written for, and every file of it. */
export interface TreeRecord {
  readonly identity: SpaceIdentity;
  /** A full rebuild runs: the tree claims nothing (no `.projection.json`) until it ends. */
  rebuilding: boolean;
  /** During a rebuild: every task was queued. */
  queued: boolean;
  /** The watermark last published. */
  watermark: number;
  readonly tasks: Map<string, TaskRecord>;
  /** The root files: path to hash. */
  readonly files: Map<string, string>;
  /** Files of the tree no longer in use, removed once verified (an older tree's, a failed removal). */
  readonly retired: Map<string, string>;
}

/** What a batch is about to do: each task's new record, or null when its file goes. */
export interface Journal {
  readonly tasks: ReadonlyMap<string, TaskRecord | null>;
  readonly files: ReadonlyMap<string, string>;
}

export const newRecord = (identity: SpaceIdentity): TreeRecord => ({
  identity,
  rebuilding: true,
  queued: false,
  watermark: 0,
  tasks: new Map(),
  files: new Map(),
  retired: new Map(),
});

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** A catalogue line read back, or undefined when any part of it is not one. */
function entryOf(value: unknown, path: string): CatalogEntry | undefined {
  if (!isRecordObject(value)) return undefined;
  const e = value;
  const labels = e["labels"];
  if (
    !isText(e["ref"]) ||
    !isText(e["id"]) ||
    !isText(e["title"]) ||
    !isText(e["summary"]) ||
    !isText(e["status"]) ||
    !(LIFECYCLES as readonly unknown[]).includes(e["lifecycle"]) ||
    !isCount(e["priority"]) ||
    !isTextOrNull(e["effort"]) ||
    !isTextOrNull(e["due"]) ||
    !isTextOrNull(e["area"]) ||
    !isTextOrNull(e["project"]) ||
    !Array.isArray(labels) ||
    !labels.every(isText) ||
    e["path"] !== path ||
    !isCount(e["version"])
  ) {
    return undefined;
  }
  return {
    ref: e["ref"],
    id: e["id"],
    title: e["title"],
    summary: e["summary"],
    status: e["status"],
    lifecycle: e["lifecycle"] as Lifecycle,
    priority: e["priority"],
    effort: e["effort"],
    due: e["due"],
    area: e["area"],
    project: e["project"],
    labels,
    path,
    version: e["version"],
  };
}

function taskRecordOf(value: unknown): TaskRecord | undefined {
  if (!isRecordObject(value)) return undefined;
  const { path, sha256: hash, entry } = value;
  if (typeof path !== "string" || !TASK_FILE.test(path)) return undefined;
  if (typeof hash !== "string" || !SHA256.test(hash)) return undefined;
  const read = entryOf(entry, path);
  return read === undefined ? undefined : { path, sha256: hash, entry: read };
}

/** A map of tree paths to hashes, or undefined when one entry is not. */
function hashesOf(value: unknown): Map<string, string> | undefined {
  if (!isRecordObject(value)) return undefined;
  const map = new Map<string, string>();
  for (const [path, hash] of Object.entries(value)) {
    if (!isTreePath(path) || typeof hash !== "string" || !SHA256.test(hash)) return undefined;
    map.set(path, hash);
  }
  return map;
}

/** Sorted keys, so the same record is the same bytes. */
const sorted = <V>(map: ReadonlyMap<string, V>): Record<string, V> =>
  Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const isBusy = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
};

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** What is at a path: nothing, a regular file and its hash, or anything else. */
type Found =
  { kind: "missing" } | { kind: "file"; sha256: string; stats: Stats } | { kind: "other" };

/** The named points a batch's file work passes, for the crash tests (projector.ts). */
export type FilePoint = "rename" | "renamed";

export interface TreeOptions {
  /** The space's folder: rescued files go to its `exchange/rescued/`. */
  readonly spaceFolder: string;
  /** The projection's folder, checked by the caller (checkProjectionDir). */
  readonly dir: string;
  readonly now: () => number;
  readonly platform?: NodeJS.Platform;
  /** Tests only: called before and after each rename. A promise that never settles is a kill. */
  readonly at?: (point: FilePoint, path: string) => Promise<void> | void;
}

/** The projection's folder on disk. */
export class Tree {
  readonly #dir: string;
  readonly #space: string;
  readonly #now: () => number;
  readonly #win: boolean;
  readonly #at: TreeOptions["at"];
  /** Folders found real in this batch, or made by it. */
  #folders = new Set<string>();
  /** Folders of the tree found missing, or not real (a link, a file), in this batch. */
  #lost = new Set<string>();
  /** This batch's rescue folder, relative to the space's folder, once one was made. */
  #box: string | undefined;
  #rescued = 0;

  constructor(options: TreeOptions) {
    this.#dir = options.dir;
    this.#space = options.spaceFolder;
    this.#now = options.now;
    this.#win = (options.platform ?? process.platform) === "win32";
    this.#at = options.at;
  }

  /** Starts a batch: folders are checked again, and rescues go to a new folder. */
  newBatch(): void {
    this.#folders = new Set();
    this.#lost = new Set();
    this.#box = undefined;
    this.#rescued = 0;
  }

  /** What this batch rescued: how many, and where (relative to the space's folder). */
  get rescued(): { files: number; folder?: string } {
    return this.#box === undefined
      ? { files: this.#rescued }
      : { files: this.#rescued, folder: this.#box };
  }

  /** The folders of the tree this batch found missing or not real: what the record had there is gone. */
  get lostFolders(): ReadonlySet<string> {
    return this.#lost;
  }

  #abs(path: string): string {
    if (!isTreePath(path)) throw new ProjectionError("EINVAL", "Not a path of the projection");
    return join(this.#dir, ...path.split("/"));
  }

  /**
   * Creates the projection's folder when it is missing, and says so: whatever the record says is in
   * it is gone. A link or a file there is refused.
   */
  prepare(): boolean {
    const stats = lstatSync(this.#dir, { throwIfNoEntry: false });
    if (stats === undefined) {
      makeDir(this.#dir, FOLDER_MODE);
      return true;
    }
    if (!stats.isDirectory()) {
      throw new ProjectionError("ENOTDIR", "The projection's folder is not a folder");
    }
    return false;
  }

  /**
   * Whether any of `folders` (relative, `/`-separated, each with its parents listed too), or the
   * projection's folder itself, is not a real folder now: missing, a link or a file. Only lstat,
   * so nothing is followed.
   */
  missing(folders: Iterable<string>): boolean {
    if (lstatSync(this.#dir, { throwIfNoEntry: false })?.isDirectory() !== true) return true;
    for (const folder of folders) {
      const abs = join(this.#dir, ...folder.split("/"));
      if (lstatSync(abs, { throwIfNoEntry: false })?.isDirectory() !== true) return true;
    }
    return false;
  }

  /**
   * Whether every folder of `path` is a real folder of the tree, each checked with lstat. The first
   * that is not (missing, a link, a file) is reported lost, and nothing below it is looked at.
   */
  #inTree(path: string): boolean {
    let rel = "";
    for (const part of path.split("/").slice(0, -1)) {
      rel = rel === "" ? part : `${rel}/${part}`;
      if (this.#folders.has(rel)) continue;
      const stats = lstatSync(join(this.#dir, ...rel.split("/")), { throwIfNoEntry: false });
      if (stats?.isDirectory() !== true) {
        this.#lost.add(rel);
        return false;
      }
      this.#folders.add(rel);
    }
    return true;
  }

  /**
   * Removes the temporary files a kill left in the tree's folders (A1 3.7 "Crash behaviour"): the
   * projected files' `.<name>.tmp-<hex>`, and the record's and the journal's atomic-write leftovers.
   * Only those names, only regular files, only in the folders the tree writes.
   */
  cleanTemps(): number {
    let removed = removeStaleTemps(this.#dir, [RECORD_FILE, JOURNAL_FILE]);
    const folders = [this.#dir, join(this.#dir, "open")];
    for (const state of ["completed", "archived"]) {
      const parent = join(this.#dir, state);
      for (const year of this.#list(parent)) {
        if (/^[0-9]{4}$/.test(year)) folders.push(join(parent, year));
      }
    }
    for (const folder of folders) {
      for (const name of this.#list(folder)) {
        if (!TEMP.test(name)) continue;
        const path = join(folder, name);
        if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
        this.#unlink(path);
        removed += 1;
      }
    }
    return removed;
  }

  /** The entries of a real folder, or none. */
  #list(folder: string): string[] {
    const stats = lstatSync(folder, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isDirectory()) return [];
    return readdirSync(folder);
  }

  #look(abs: string): Found {
    const stats = lstatSync(abs, { throwIfNoEntry: false });
    if (stats === undefined) return { kind: "missing" };
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return { kind: "other" };
    return { kind: "file", sha256: sha256(readFileSync(abs)), stats };
  }

  /**
   * The hash of the file at `path`, undefined when nothing is there (a folder of it that is not a
   * real folder included), `other` for anything else.
   */
  hashOf(path: string): string | undefined {
    const abs = this.#abs(path);
    if (!this.#inTree(path)) return undefined;
    const found = this.#look(abs);
    return found.kind === "missing" ? undefined : found.kind === "file" ? found.sha256 : "other";
  }

  /**
   * Makes sure every folder of `folder` (relative, `/`-separated) is a real folder of the tree. A
   * file or a link where one belongs is rescued, then the folder is made with mode 0700. A folder
   * that was missing or rescued is reported lost.
   */
  #folder(folder: string): void {
    let rel = "";
    for (const part of folder.split("/")) {
      rel = rel === "" ? part : `${rel}/${part}`;
      if (this.#folders.has(rel)) continue;
      const abs = join(this.#dir, ...rel.split("/"));
      const stats = lstatSync(abs, { throwIfNoEntry: false });
      // lstat: a link, a junction included, is never a folder here.
      const real = stats?.isDirectory() === true;
      if (!real) this.#lost.add(rel);
      if (stats !== undefined && !real) this.#rescueAt(rel, abs);
      if (!real) makeDir(abs, FOLDER_MODE, { recursive: false });
      this.#folders.add(rel);
    }
  }

  /**
   * Writes `content` at `path`, read-only. What is there is replaced only when its hash is one
   * `ours` accepts or the new content's own; anything else is rescued first. Returns whether it
   * wrote (`same`: the file already held exactly this).
   */
  async place(
    path: string,
    content: string,
    ours: (hash: string) => boolean,
  ): Promise<"written" | "same"> {
    const abs = this.#abs(path);
    const slash = path.lastIndexOf("/");
    if (slash > 0) this.#folder(path.slice(0, slash));
    const data = Buffer.from(content, "utf8");
    const hash = sha256(data);
    const found = this.#look(abs);
    if (found.kind === "file" && found.sha256 === hash) {
      this.#markReadOnly(abs, found.stats);
      return "same";
    }
    const replacing = found.kind === "file" && ours(found.sha256);
    if (found.kind !== "missing" && !replacing) this.#rescueAt(path, abs);
    const temp = join(dirname(abs), `.${basename(abs)}.tmp-${hex()}`);
    // Exclusive and read-only from the start: the creating descriptor still writes (POSIX), and
    // Windows sets the read-only attribute on the new file.
    const fd = createFile(temp, FILE_MODE);
    try {
      let offset = 0;
      while (offset < data.length) {
        const n = writeSync(fd, data, offset, data.length - offset);
        if (n <= 0) throw new ProjectionError("EIO", "A projected file's write made no progress");
        offset += n;
      }
    } catch (error) {
      closeSync(fd);
      this.#unlink(temp);
      throw error;
    }
    closeSync(fd);
    try {
      await this.#at?.("rename", path);
      if (replacing) this.#writable(abs);
      await this.#rename(temp, abs);
    } catch (error) {
      this.#unlink(temp);
      if (replacing && lstatSync(abs, { throwIfNoEntry: false })?.isFile() === true) {
        this.#readOnlyAgain(abs);
      }
      throw error;
    }
    await this.#at?.("renamed", path);
    return "written";
  }

  /**
   * Removes the file at `path` when its hash is one `ours` accepts; rescues anything else there.
   * Nothing there is fine, and so is a folder of it that is not a real folder: what is behind it is
   * not in the tree, and is never touched.
   */
  remove(path: string, ours: (hash: string) => boolean): "removed" | "rescued" | "missing" {
    const abs = this.#abs(path);
    if (!this.#inTree(path)) return "missing";
    const found = this.#look(abs);
    if (found.kind === "missing") return "missing";
    if (found.kind === "file" && ours(found.sha256)) {
      this.#unlink(abs);
      return "removed";
    }
    this.#rescueAt(path, abs);
    return "rescued";
  }

  async #rename(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        renameSync(from, to);
        return;
      } catch (error) {
        if (!this.#win || !isBusy(error) || attempt >= RENAME_TRIES) throw error;
        await pause(RENAME_PAUSE_MS);
      }
    }
  }

  /** Removes a file. Windows refuses to delete a read-only one, so its attribute goes first. */
  #unlink(abs: string): void {
    if (this.#win) {
      try {
        chmodSync(abs, 0o600);
      } catch {
        // Gone already, or not ours to change: the removal below says which.
      }
    }
    rmSync(abs, { force: true });
  }

  #writable(abs: string): void {
    if (this.#win) chmodSync(abs, 0o600);
  }

  #readOnlyAgain(abs: string): void {
    if (!this.#win) return;
    try {
      chmodSync(abs, 0o444);
    } catch {
      // The file stays writable: its hash still guards it.
    }
  }

  /** Marks a file that already holds the right bytes read-only again, if a person changed that. */
  #markReadOnly(abs: string, stats: Stats): void {
    const writable = this.#win ? (stats.mode & 0o200) !== 0 : (stats.mode & 0o777) !== FILE_MODE;
    if (!writable) return;
    try {
      chmodSync(abs, this.#win ? 0o444 : FILE_MODE);
    } catch {
      // Its hash still guards it.
    }
  }

  /** This batch's rescue folder, `exchange/rescued/<stamp>/` in the space's folder, made once. */
  #rescueBox(): string {
    if (this.#box !== undefined) return join(this.#space, ...this.#box.split("/"));
    const exchange = join(this.#space, "exchange");
    const rescued = join(exchange, "rescued");
    for (const folder of [exchange, rescued]) {
      const stats = lstatSync(folder, { throwIfNoEntry: false });
      if (stats === undefined) makeDir(folder, FOLDER_MODE, { recursive: false });
      else if (!stats.isDirectory()) {
        throw new ProjectionError("ENOTDIR", "The space's exchange folder is not a folder");
      }
    }
    const stamp = new Date(this.#now()).toISOString().replace(/[-:.]/g, "");
    for (let n = 1; n <= 100; n += 1) {
      const name = n === 1 ? stamp : `${stamp}-${String(n)}`;
      try {
        makeDir(join(rescued, name), FOLDER_MODE, { recursive: false });
      } catch (error) {
        if ((error as { code?: unknown }).code === "EEXIST") continue;
        throw error;
      }
      this.#box = `exchange/rescued/${name}`;
      return join(rescued, name);
    }
    throw new ProjectionError("EEXIST", "No free rescue folder");
  }

  /**
   * Moves what is at `abs` (tree path `path`) into this batch's rescue folder under the same path,
   * and makes a rescued file writable: it is the person's now (A1 3.13 step 3). The destination's
   * folders in the rescue folder must be real folders and the destination free: a link rescued
   * earlier in the batch is never moved into, and nothing rescued is replaced. Across volumes a
   * file is copied, then removed, and the copy goes again when the original cannot; anything else
   * there fails the move.
   */
  #rescueAt(path: string, abs: string): void {
    const box = this.#rescueBox();
    let at = box;
    for (const part of path.split("/").slice(0, -1)) {
      at = join(at, part);
      const stats = lstatSync(at, { throwIfNoEntry: false });
      if (stats === undefined) break;
      if (!stats.isDirectory()) {
        throw new ProjectionError("ENOTDIR", "A rescued link stands where a rescue goes");
      }
    }
    const dest = join(box, ...path.split("/"));
    makeDir(dirname(dest), FOLDER_MODE);
    if (lstatSync(dest, { throwIfNoEntry: false }) !== undefined) {
      throw new ProjectionError("EEXIST", "Something was rescued there already");
    }
    const stats = lstatSync(abs);
    try {
      renameSync(abs, dest);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EXDEV" || !stats.isFile()) throw error;
      copyFileSync(abs, dest, constants.COPYFILE_EXCL);
      try {
        this.#unlink(abs);
      } catch (failed) {
        // The original stays where it was: a second copy would be made at every retry.
        this.#unlink(dest);
        throw failed;
      }
    }
    if (stats.isFile()) chmodSync(dest, 0o600);
    this.#rescued += 1;
  }

  // -------------------------------------------------------------------------------------------
  // The record and the journal

  #readJson(name: string): unknown {
    const abs = join(this.#dir, name);
    const stats = lstatSync(abs, { throwIfNoEntry: false });
    if (stats === undefined) return undefined;
    if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) return null;
    try {
      return JSON.parse(readFileSync(abs, "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  /** The tree's record: undefined when there is none, null when it cannot be trusted. */
  readRecord(): TreeRecord | undefined | null {
    const value = this.#readJson(RECORD_FILE);
    if (value === undefined || value === null) return value;
    if (!isRecordObject(value) || value["format"] !== FORMAT) return null;
    const { space_id, epoch, incarnation, rebuilding, queued, watermark } = value;
    const files = hashesOf(value["files"]);
    const retired = hashesOf(value["retired"]);
    const tasks = new Map<string, TaskRecord>();
    if (!isRecordObject(value["tasks"])) return null;
    for (const [id, item] of Object.entries(value["tasks"])) {
      const record = taskRecordOf(item);
      if (record === undefined || record.entry.id !== id) return null;
      tasks.set(id, record);
    }
    if (
      typeof space_id !== "string" ||
      !isCount(epoch) ||
      typeof incarnation !== "string" ||
      typeof rebuilding !== "boolean" ||
      typeof queued !== "boolean" ||
      !isCount(watermark) ||
      files === undefined ||
      retired === undefined ||
      [...files.keys()].some((p) => TASK_FILE.test(p))
    ) {
      return null;
    }
    return {
      identity: { spaceId: space_id, epoch, incarnation },
      rebuilding,
      queued,
      watermark,
      tasks,
      files,
      retired,
    };
  }

  writeRecord(record: TreeRecord): void {
    const value = {
      format: FORMAT,
      space_id: record.identity.spaceId,
      epoch: record.identity.epoch,
      incarnation: record.identity.incarnation,
      rebuilding: record.rebuilding,
      queued: record.queued,
      watermark: record.watermark,
      tasks: sorted(record.tasks),
      files: sorted(record.files),
      retired: sorted(record.retired),
    };
    atomicWrite(join(this.#dir, RECORD_FILE), `${JSON.stringify(value)}\n`, 0o600);
  }

  /**
   * The journal a kill left: undefined when there is none, null when there is one that cannot be
   * read. That one may name files a reported batch placed, so the record cannot be trusted.
   */
  readJournal(): Journal | undefined | null {
    const value = this.#readJson(JOURNAL_FILE);
    if (value === undefined) return undefined;
    if (!isRecordObject(value) || value["format"] !== FORMAT) return null;
    const files = hashesOf(value["files"]);
    if (files === undefined || !isRecordObject(value["tasks"])) return null;
    const tasks = new Map<string, TaskRecord | null>();
    for (const [id, item] of Object.entries(value["tasks"])) {
      if (item === null) {
        tasks.set(id, null);
        continue;
      }
      const record = taskRecordOf(item);
      if (record === undefined || record.entry.id !== id) return null;
      tasks.set(id, record);
    }
    return { tasks, files };
  }

  writeJournal(journal: Journal): void {
    const value = { format: FORMAT, tasks: sorted(journal.tasks), files: sorted(journal.files) };
    atomicWrite(join(this.#dir, JOURNAL_FILE), `${JSON.stringify(value)}\n`, 0o600);
  }

  dropJournal(): void {
    rmSync(join(this.#dir, JOURNAL_FILE), { force: true });
  }
}

const hex = (): string => randomBytes(8).toString("hex");
