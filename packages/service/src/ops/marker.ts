// The marker TTasks leaves in a project's or a task's folder: `.ttasks-marker/` with the IDs of the
// space and of each project or task whose folder it is, and a `.gitignore` holding `*`, so a
// checkout's `git status` stays clean without a change to the repository's own ignore files. It
// holds no task text. A launch reads it just before an agent starts: a folder this machine marked
// for the owner whose marker is now gone or names others only is not opened without the person's
// word, so an old task never opens unseen in an unrelated repository made at the same path later.
//
// What this machine has marked is kept in its own state (`FolderMarks`), by owner and path: an
// undo may give an owner back a folder, and only a folder that was marked for that owner can have
// lost its marker. With each mark it keeps what identifies the folder itself (`identityFrom`), so a
// marker that went while the folder stayed (`git clean -x`), or that another owner's write lost,
// is put back without a question, and a folder made again at the path (a fresh clone) still asks.
// A write slower than its bound counts as marked when the folder's identity is known, so a busy
// machine keeps the protection. A folder TTasks cannot write to (read-only, a share) gets no
// marker and is opened as before: that is the limit of the protection, not a refusal.
import { readFileSync } from "node:fs";
import { lstat, readFile, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FOLDER_MARKER, PRODUCT_NAME } from "@ttasks/brand";
import {
  atomicWrite,
  atomicWriteAsync,
  createFileAsync,
  makeDir,
  makeDirAsync,
} from "@ttasks/files";
import { folderKey } from "@ttasks/storage";
import { bounded, openPath, osOf } from "./folders.ts";

/** A project or a task of a space, as a marker names it. */
export interface MarkerOwner {
  readonly space: string;
  readonly kind: "project" | "task";
  readonly id: string;
}

/** The file of the marker that names its owners. */
export const MARKER_OWNERS = "owners.json";

/** The file in the machine's state folder that keeps what this machine marked (FolderMarks). */
export const MARKS_FILE = "folder-marks.json";

const ABOUT = `${PRODUCT_NAME} keeps this folder to know which project or task this folder belongs to. Clearing the folder in ${PRODUCT_NAME} removes it.`;

/**
 * What a folder's marker says: no marker, its owners, an owners file that is not one TTasks writes
 * (`malformed`), or a marker this machine cannot read or should not touch (`unreadable`: a read
 * error, or a link where the marker's folder belongs).
 */
export type MarkerRead =
  | { readonly state: "none" }
  | { readonly state: "owners"; readonly owners: readonly MarkerOwner[] }
  | { readonly state: "malformed" }
  | { readonly state: "unreadable" };

const same = (a: MarkerOwner, b: MarkerOwner): boolean =>
  a.space === b.space && a.kind === b.kind && a.id === b.id;

function ownersOf(text: string): MarkerOwner[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const list = (parsed as { owners?: unknown } | null)?.owners;
  if (!Array.isArray(list)) return undefined;
  const owners: MarkerOwner[] = [];
  for (const item of list as unknown[]) {
    const entry = item as Record<string, unknown> | null;
    const space = entry?.["space"];
    const project = entry?.["project"];
    const task = entry?.["task"];
    if (typeof space !== "string") return undefined;
    if (typeof project === "string") owners.push({ space, kind: "project", id: project });
    else if (typeof task === "string") owners.push({ space, kind: "task", id: task });
    else return undefined;
  }
  return owners;
}

const textOf = (owners: readonly MarkerOwner[]): string =>
  `${JSON.stringify(
    {
      about: ABOUT,
      owners: owners.map((o) => ({ space: o.space, [o.kind]: o.id })),
    },
    null,
    2,
  )}\n`;

/** The marker of the folder at `absolute`, read now. */
export async function readMarker(absolute: string): Promise<MarkerRead> {
  const dir = join(absolute, FOLDER_MARKER);
  let text: string;
  try {
    // A link or a junction there leads out of the person's folder: it is never read or written.
    if ((await lstat(dir)).isSymbolicLink()) return { state: "unreadable" };
    text = await readFile(join(dir, MARKER_OWNERS), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "none" } : { state: "unreadable" };
  }
  const owners = ownersOf(text);
  return owners === undefined ? { state: "malformed" } : { state: "owners", owners };
}

const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException | null)?.code;

/** Whether `dir` is a folder itself, not a link to one. */
async function isOwnFolder(dir: string): Promise<boolean> {
  try {
    return (await lstat(dir)).isDirectory();
  } catch {
    return false;
  }
}

const IGNORE_ALL = "*\n";

/**
 * Adds `owner` to the marker of the folder at `absolute`, making the marker when there is none.
 * An owners file that is not one TTasks writes is written over: it is in the marker's own folder.
 * False when the folder takes no marker: it cannot be written, or something that is not a folder
 * has the marker's name.
 */
async function addOwnerNow(
  absolute: string,
  owner: MarkerOwner,
  before: MarkerRead,
): Promise<boolean> {
  if (before.state === "unreadable") return false;
  const dir = join(absolute, FOLDER_MARKER);
  try {
    await makeDirAsync(dir, 0o755);
  } catch (error) {
    if (codeOf(error) !== "EEXIST" || !(await isOwnFolder(dir))) return false;
  }
  try {
    const handle = await createFileAsync(join(dir, ".gitignore"), 0o644);
    try {
      await handle.writeFile(IGNORE_ALL, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (codeOf(error) !== "EEXIST") return false;
  }
  const owners = before.state === "owners" ? before.owners : [];
  if (owners.some((o) => same(o, owner))) return true;
  try {
    await atomicWriteAsync(join(dir, MARKER_OWNERS), textOf([...owners, owner]), 0o644);
    return true;
  } catch {
    return false;
  }
}

/** Takes `owner` off the marker at `absolute`; the marker goes when no owner is left. */
async function removeOwnerNow(
  absolute: string,
  owner: MarkerOwner,
  before: MarkerRead,
): Promise<void> {
  if (before.state !== "owners") return;
  const dir = join(absolute, FOLDER_MARKER);
  const left = before.owners.filter((o) => !same(o, owner));
  if (left.length === before.owners.length || !(await isOwnFolder(dir))) return;
  try {
    if (left.length > 0) {
      await atomicWriteAsync(join(dir, MARKER_OWNERS), textOf(left), 0o644);
      return;
    }
    await rm(join(dir, MARKER_OWNERS), { force: true });
    // An ignore file with other words in it is the person's, and stays.
    const ignore = join(dir, ".gitignore");
    const words = await readFile(ignore, "utf8").catch(() => undefined);
    if (words === IGNORE_ALL) await rm(ignore, { force: true });
    // Only when nothing else is in it: a file a person put there stays, and so does the folder.
    await rmdir(dir);
  } catch {
    // A marker that cannot be changed stays as it is: it names an owner, and harms nothing.
  }
}

/**
 * What identifies a folder itself, whatever its path, from its stat: its volume, its file number
 * and the instant it was made. A rename keeps them and so does `git clean`; a folder made again at
 * the path (a fresh clone, a checkout moved aside and another made) has others on Windows and
 * Linux alike. Undefined when the file system keeps no creation time (zero) or no file number that
 * fits (zero, or all ones on ReFS): an inode used again could then pass.
 */
export function identityFrom(found: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}): string | undefined {
  // All ones reads as -1 where the number is signed.
  const noFileId = found.ino <= 0n || found.ino === 2n ** 64n - 1n;
  if (noFileId || found.birthtimeNs <= 0n) return undefined;
  return `${found.dev.toString()}:${found.ino.toString()}:${found.birthtimeNs.toString()}`;
}

/**
 * What this machine marked: the owner and the folder by its key, with the folder's identity when
 * it was read, so an owner given back a folder that was marked for it (an undo) still knows its
 * marker should be there. Kept in the machine's own state; without a file it keeps nothing, and a
 * missing marker is then marked again quietly.
 */
export class FolderMarks {
  readonly #file: string | undefined;
  #marks: Map<string, string | undefined> | undefined;

  constructor(file?: string) {
    this.#file = file;
  }

  #load(): Map<string, string | undefined> {
    if (this.#marks !== undefined) return this.#marks;
    const marks = new Map<string, string | undefined>();
    if (this.#file !== undefined) {
      try {
        const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as {
          marked?: unknown;
          ids?: unknown;
        };
        const ids =
          typeof parsed.ids === "object" && parsed.ids !== null
            ? (parsed.ids as Record<string, unknown>)
            : {};
        if (Array.isArray(parsed.marked)) {
          for (const key of parsed.marked) {
            if (typeof key !== "string") continue;
            const id = Object.hasOwn(ids, key) ? ids[key] : undefined;
            marks.set(key, typeof id === "string" ? id : undefined);
          }
        }
      } catch {
        marks.clear();
      }
    }
    this.#marks = marks;
    return marks;
  }

  #save(): void {
    if (this.#file === undefined || this.#marks === undefined) return;
    const ids: Record<string, string> = {};
    for (const [key, id] of this.#marks) if (id !== undefined) ids[key] = id;
    try {
      makeDir(dirname(this.#file), 0o700);
      atomicWrite(
        this.#file,
        `${JSON.stringify({ marked: [...this.#marks.keys()], ids })}\n`,
        0o600,
      );
    } catch {
      // Kept in memory: the next change tries the file again.
    }
  }

  has(key: string): boolean {
    return this.#load().has(key);
  }

  /** The identity of the folder as it was when marked; undefined when not known. */
  identity(key: string): string | undefined {
    return this.#load().get(key);
  }

  /** Marks or unmarks; a mark without an identity keeps the one it had. */
  set(key: string, on: boolean, identity?: string): void {
    const marks = this.#load();
    if (!on) {
      if (marks.delete(key)) this.#save();
      return;
    }
    const id = identity ?? marks.get(key);
    if (marks.has(key) && marks.get(key) === id) return;
    marks.set(key, id);
    this.#save();
  }
}

/** What a launch's look at its folder's marker found (FolderMarkers.check). */
export type MarkerCheck =
  /** The marker names this owner, the folder took a marker just now, or it takes none. */
  | { readonly kind: "ok" }
  /** This machine marked the folder for this owner, and the marker is gone. */
  | { readonly kind: "missing" }
  /** This machine marked the folder for this owner, and another folder there names others only. */
  | { readonly kind: "other"; readonly owners: readonly MarkerOwner[] };

/**
 * How long a look at a marker, or a change to one, is waited for. A folder on a share that stops
 * answering holds only its own write, never the service.
 */
const MARKER_MS = 2_000;

/**
 * The markers of this machine's folders: written by the service when a folder becomes an owner's,
 * taken off when it is cleared, and checked by a launch. Every change runs one at a time, so two
 * owners of one folder never write its marker over each other.
 */
export class FolderMarkers {
  readonly #marks: FolderMarks;
  readonly #home: string | undefined;
  readonly #platform: NodeJS.Platform;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    readonly file?: string;
    readonly home?: string;
    readonly platform?: NodeJS.Platform;
  }) {
    this.#marks = new FolderMarks(options.file);
    this.#home = options.home;
    this.#platform = options.platform ?? process.platform;
  }

  #key(owner: MarkerOwner, stored: string): string {
    return [owner.space, owner.kind, owner.id, folderKey(stored, osOf(this.#platform))].join("\n");
  }

  #turn<T>(work: () => Promise<T>): Promise<T> {
    const mine = this.#queue.then(work, work);
    this.#queue = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  }

  /** Whether the stored folder is a folder here now, where it opens, and its identity. */
  async #folder(stored: string): Promise<{ open: string; identity?: string } | undefined> {
    const open = openPath(stored, this.#home, this.#platform);
    if (open === undefined) return undefined;
    const found = await bounded(async () => {
      try {
        const folder = await stat(open, { bigint: true });
        return folder.isDirectory() ? (identityFrom(folder) ?? true) : false;
      } catch {
        return false;
      }
    }, MARKER_MS);
    if (found === false || found === "not_answering") return undefined;
    return found === true ? { open } : { open, identity: found };
  }

  /** Marks the folder `stored` as `owner`'s. False when it takes no marker. */
  mark(owner: MarkerOwner, stored: string): Promise<boolean> {
    return this.#turn(async () => {
      const folder = await this.#folder(stored);
      if (folder === undefined) return false;
      const { open, identity } = folder;
      const before = await bounded(() => readMarker(open), MARKER_MS);
      return this.#write(this.#key(owner, stored), open, owner, before, identity);
    });
  }

  /**
   * Adds `owner` to the marker of the folder at `open`, and keeps what this machine marked. A write
   * that did not answer within the bound may still land, and the folder answered as itself: known
   * by its identity, it stays this owner's, so a folder made at the path meanwhile still asks.
   */
  async #write(
    key: string,
    open: string,
    owner: MarkerOwner,
    before: MarkerRead | "not_answering",
    identity: string | undefined,
  ): Promise<boolean> {
    const written =
      before === "not_answering"
        ? before
        : await bounded(() => addOwnerNow(open, owner, before), MARKER_MS);
    if (written === true || (written === "not_answering" && identity !== undefined)) {
      this.#marks.set(key, true, identity);
    }
    return written === true;
  }

  /** Takes `owner` off the folder `stored`: its folder there was cleared. */
  unmark(owner: MarkerOwner, stored: string): Promise<void> {
    return this.#turn(async () => {
      this.#marks.set(this.#key(owner, stored), false);
      const open = (await this.#folder(stored))?.open;
      if (open === undefined) return;
      const before = await bounded(() => readMarker(open), MARKER_MS);
      if (before !== "not_answering") {
        await bounded(() => removeOwnerNow(open, owner, before), MARKER_MS);
      }
    });
  }

  /**
   * A folder that moved with another: its marker moved with it, inside it, so what this machine
   * marked follows too. The old place stays marked: an undo gives the owner that place back, and
   * an unrelated folder made there since is still noticed.
   */
  moved(owner: MarkerOwner, from: string, to: string): void {
    const key = this.#key(owner, from);
    if (this.#marks.has(key))
      this.#marks.set(this.#key(owner, to), true, this.#marks.identity(key));
  }

  /**
   * The look a launch takes at its folder just before an agent starts. A folder that is not
   * there, or does not answer, is the launch's own check to report, and one whose marker cannot
   * be read opens as before. Only a folder this machine marked for this owner can say it is not
   * that folder any more, and the very folder that was marked has its marker put back. One
   * it never marked for this owner (set before markers, before the folder was there, or given back
   * by an undo of a clear) is marked now, quietly, whatever its marker names: nothing tells it from
   * the folder that was set.
   */
  check(owner: MarkerOwner, stored: string): Promise<MarkerCheck> {
    return this.#turn(async (): Promise<MarkerCheck> => {
      const folder = await this.#folder(stored);
      if (folder === undefined) return { kind: "ok" };
      const { open, identity } = folder;
      const read = await bounded(() => readMarker(open), MARKER_MS);
      if (read === "not_answering" || read.state === "unreadable") return { kind: "ok" };
      const key = this.#key(owner, stored);
      if (read.state === "owners" && read.owners.some((o) => same(o, owner))) {
        this.#marks.set(key, true, identity);
        return { kind: "ok" };
      }
      const unchanged = identity !== undefined && this.#marks.identity(key) === identity;
      if (this.#marks.has(key) && !unchanged) {
        if (read.state === "none") return { kind: "missing" };
        return { kind: "other", owners: read.state === "owners" ? read.owners : [] };
      }
      await this.#write(key, open, owner, read, identity);
      return { kind: "ok" };
    });
  }
}
