// The marker Tasks leaves in a project's or a task's folder: `.tasks-marker/` with the IDs of the
// space and of each project or task whose folder it is, and a `.gitignore` holding `*`, so a
// checkout's `git status` stays clean without a change to the repository's own ignore files. It
// holds no task text. A launch reads it just before an agent starts: a folder that names another
// owner, or whose marker this machine wrote and is now gone, is not opened without the person's
// word, so an old task never opens unseen in an unrelated repository made at the same path later.
//
// What this machine has marked is kept in its own state (`FolderMarks`), by owner and path: an
// undo may give an owner back a folder, and only a folder that was marked for that owner can have
// lost its marker. A folder Tasks cannot write to (read-only, a share) gets no marker and is
// opened as before: that is the limit of the protection, not a refusal.
import { closeSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FOLDER_MARKER, PRODUCT_NAME } from "@tasks/brand";
import { atomicWrite, createFile, makeDir, writeAll } from "@tasks/files";
import { folderKey } from "@tasks/storage";
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

/** What a folder's marker says: no marker, its owners, or a marker that cannot be read. */
export type MarkerRead =
  | { readonly state: "none" }
  | { readonly state: "owners"; readonly owners: readonly MarkerOwner[] }
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
  let text: string;
  try {
    text = await readFile(join(absolute, FOLDER_MARKER, MARKER_OWNERS), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "none" } : { state: "unreadable" };
  }
  const owners = ownersOf(text);
  return owners === undefined ? { state: "unreadable" } : { state: "owners", owners };
}

const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException | null)?.code;

/**
 * Adds `owner` to the marker of the folder at `absolute`, making the marker when there is none.
 * False when the folder takes no marker: it cannot be written, or something that is not Tasks'
 * marker has the marker's name.
 */
function addOwnerNow(absolute: string, owner: MarkerOwner, before: MarkerRead): boolean {
  if (before.state === "unreadable") return false;
  const dir = join(absolute, FOLDER_MARKER);
  try {
    makeDir(dir, 0o755, { recursive: false });
  } catch (error) {
    if (codeOf(error) !== "EEXIST") return false;
  }
  try {
    const fd = createFile(join(dir, ".gitignore"), 0o644);
    try {
      writeAll(fd, "*\n");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (codeOf(error) !== "EEXIST") return false;
  }
  const owners = before.state === "owners" ? before.owners : [];
  if (owners.some((o) => same(o, owner))) return true;
  try {
    atomicWrite(join(dir, MARKER_OWNERS), textOf([...owners, owner]), 0o644);
    return true;
  } catch {
    return false;
  }
}

/** Takes `owner` off the marker at `absolute`; the marker goes when no owner is left. */
function removeOwnerNow(absolute: string, owner: MarkerOwner, before: MarkerRead): void {
  if (before.state !== "owners") return;
  const dir = join(absolute, FOLDER_MARKER);
  const left = before.owners.filter((o) => !same(o, owner));
  if (left.length === before.owners.length) return;
  try {
    if (left.length > 0) {
      atomicWrite(join(dir, MARKER_OWNERS), textOf(left), 0o644);
      return;
    }
    rmSync(join(dir, MARKER_OWNERS), { force: true });
    rmSync(join(dir, ".gitignore"), { force: true });
    // Only when nothing else is in it: a file a person put there stays, and so does the folder.
    rmdirSync(dir);
  } catch {
    // A marker that cannot be changed stays as it is: it names an owner, and harms nothing.
  }
}

/**
 * What this machine marked: the owner and the folder by its key, so an owner given back a folder
 * that was marked for it (an undo) still knows its marker should be there. Kept in the machine's
 * own state; without a file it keeps nothing, and a missing marker is then marked again quietly.
 */
export class FolderMarks {
  readonly #file: string | undefined;
  #keys: Set<string> | undefined;

  constructor(file?: string) {
    this.#file = file;
  }

  #load(): Set<string> {
    if (this.#keys !== undefined) return this.#keys;
    let keys: string[] = [];
    if (this.#file !== undefined) {
      try {
        const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as { marked?: unknown };
        if (Array.isArray(parsed.marked)) {
          keys = parsed.marked.filter((k): k is string => typeof k === "string");
        }
      } catch {
        keys = [];
      }
    }
    this.#keys = new Set(keys);
    return this.#keys;
  }

  #save(): void {
    if (this.#file === undefined || this.#keys === undefined) return;
    try {
      makeDir(dirname(this.#file), 0o700);
      atomicWrite(this.#file, `${JSON.stringify({ marked: [...this.#keys] })}\n`, 0o600);
    } catch {
      // Kept in memory: the next change tries the file again.
    }
  }

  has(key: string): boolean {
    return this.#load().has(key);
  }

  set(key: string, on: boolean): void {
    const keys = this.#load();
    if (keys.has(key) === on) return;
    if (on) keys.add(key);
    else keys.delete(key);
    this.#save();
  }
}

/** What a launch's look at its folder's marker found (FolderMarkers.check). */
export type MarkerCheck =
  /** The marker names this owner, the folder took a marker just now, or it takes none. */
  | { readonly kind: "ok" }
  /** This machine marked the folder for this owner, and the marker is gone. */
  | { readonly kind: "missing" }
  /** The marker names other owners only, or cannot be read. */
  | { readonly kind: "other"; readonly owners: readonly MarkerOwner[] };

/** How long a look at a marker, or a change to one, may take. */
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

  /** Whether the stored folder is a folder here now, and where it opens. */
  async #folder(stored: string): Promise<string | undefined> {
    const open = openPath(stored, this.#home, this.#platform);
    if (open === undefined) return undefined;
    const found = await bounded(async () => {
      try {
        return (await stat(open)).isDirectory();
      } catch {
        return false;
      }
    }, MARKER_MS);
    return found === true ? open : undefined;
  }

  /** Marks the folder `stored` as `owner`'s. False when it takes no marker. */
  mark(owner: MarkerOwner, stored: string): Promise<boolean> {
    return this.#turn(async () => {
      const open = await this.#folder(stored);
      if (open === undefined) return false;
      const before = await bounded(() => readMarker(open), MARKER_MS);
      if (before === "not_answering") return false;
      const done = addOwnerNow(open, owner, before);
      if (done) this.#marks.set(this.#key(owner, stored), true);
      return done;
    });
  }

  /** Takes `owner` off the folder `stored`: its folder there was cleared. */
  unmark(owner: MarkerOwner, stored: string): Promise<void> {
    return this.#turn(async () => {
      this.#marks.set(this.#key(owner, stored), false);
      const open = await this.#folder(stored);
      if (open === undefined) return;
      const before = await bounded(() => readMarker(open), MARKER_MS);
      if (before !== "not_answering") removeOwnerNow(open, owner, before);
    });
  }

  /**
   * A folder that moved with another: its marker moved with it, inside it, so what this machine
   * marked follows too.
   */
  moved(owner: MarkerOwner, from: string, to: string): void {
    if (!this.#marks.has(this.#key(owner, from))) return;
    this.#marks.set(this.#key(owner, from), false);
    this.#marks.set(this.#key(owner, to), true);
  }

  /**
   * The look a launch takes at its folder just before an agent starts. A folder that is not
   * there, or does not answer, is the launch's own check to report. A folder without a marker that
   * this machine never marked for this owner is marked now, quietly: it was set before markers.
   */
  check(owner: MarkerOwner, stored: string): Promise<MarkerCheck> {
    return this.#turn(async (): Promise<MarkerCheck> => {
      const open = await this.#folder(stored);
      if (open === undefined) return { kind: "ok" };
      const read = await bounded(() => readMarker(open), MARKER_MS);
      if (read === "not_answering") return { kind: "ok" };
      const key = this.#key(owner, stored);
      if (read.state === "unreadable") return { kind: "other", owners: [] };
      if (read.state === "owners") {
        if (!read.owners.some((o) => same(o, owner))) return { kind: "other", owners: read.owners };
        this.#marks.set(key, true);
        return { kind: "ok" };
      }
      if (this.#marks.has(key)) return { kind: "missing" };
      if (addOwnerNow(open, owner, read)) this.#marks.set(key, true);
      return { kind: "ok" };
    });
  }
}
