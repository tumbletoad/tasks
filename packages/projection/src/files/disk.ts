// The readable files' acts on disk, in the tree's root (the space's `view/`). Nothing here reads the
// database or the record: the caller hands in the hashes the record holds for a path.
//
// - **Ours** is a regular file with one link whose bytes hash to a hash the caller allows for its
//   path (what was placed there, and what a pass meant to place). It is decided right before the
//   act, through one descriptor checked to be the entry lstat saw, with no await in between.
// - **Not ours** is never written through, overwritten or deleted. Where a pass needs its path, it
//   is moved aside by one rename, never followed, into `rescued/<stem>/<path>` in the space's
//   folder, a folder made fresh for that pass. At a path no longer used it is left where it is.
// - **A placement** writes a temporary file beside its place, read-only from its creation, and
//   renames it over the path. Windows refuses a rename over a read-only file, so the attribute of
//   a file proven ours is cleared through the descriptor that proved it. A path held by another
//   program fails at once: the pass goes on with the others and is tried again.
// - **Temporary files prove themselves**: `.<name>.<32 hex>.<8 hex>.tmp`, the start of the
//   content's SHA-256 and the pass's tag. Clean-up removes one only when its content hashes to its
//   name, or when it is empty (a kill between its creation and its write): a person's words in a
//   leftover keep it.
//
// Not covered: a program that swaps a folder of the tree for a link between the check and the act
// (the runtime has no handle-anchored file operations), and a save that lands between the check
// and the rename.
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
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createFile, makeDir, writeAll } from "@ttasks/files";
import { ProjectionError, sha256, type Hook } from "../tree.ts";

/** A file's bytes as the record holds them. */
export interface Owned {
  readonly sha256: string;
  readonly size: number;
}

/** What is at a path, looked at without acting. */
export type Look =
  | { readonly kind: "missing" }
  | {
      readonly kind: "file";
      readonly sha256: string;
      readonly size: number;
      readonly links: number;
    }
  /** A folder, a link, a folder on the way that is not a real folder: never a file of ours. */
  | { readonly kind: "other" }
  /** Held by another program (Windows): what it holds is unknown for now. */
  | { readonly kind: "busy" };

const FILE_MODE = 0o400;
const FOLDER_MODE = 0o700;
const CHUNK = 1024 * 1024;
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const TEMP_NAME = /^\.(.+)\.([0-9a-f]{32})\.([0-9a-f]{8})\.tmp$/;

const codeIs = (error: unknown, ...codes: string[]): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && codes.includes(code);
};

/** A pass's tag for its temporary files. */
export const newTag = (): string => randomBytes(4).toString("hex");

/** A pass's rescue folder name: its time, and 16 random bits so two in one millisecond differ. */
export const newStem = (now: number): string =>
  `${new Date(now).toISOString().replace(/[-:.]/g, "")}-${randomBytes(2).toString("hex")}`;

/** The temporary file of `path` for content hashing to `hash`, in a pass tagged `tag`. */
export function tempPathOf(path: string, hash: string, tag: string): string {
  const slash = path.lastIndexOf("/");
  const name = `.${path.slice(slash + 1)}.${hash.slice(0, 32)}.${tag}.tmp`;
  return slash < 0 ? name : `${path.slice(0, slash)}/${name}`;
}

/** The folders from the root to `path`'s folder, the root ("") first. */
export function foldersOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

interface Opened {
  readonly fd: number;
  readonly sha256: string;
  readonly size: number;
  readonly links: number;
}

function hashOf(fd: number): { sha256: string; size: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK);
  let size = 0;
  for (;;) {
    const n = readSync(fd, buffer, 0, CHUNK, size);
    if (n === 0) break;
    hash.update(buffer.subarray(0, n));
    size += n;
  }
  return { sha256: hash.digest("hex"), size };
}

/** One pass's rescues: a folder made fresh for the pass the first time it needs one. */
export class Rescue {
  readonly #space: string;
  readonly #stem: string;
  #made = false;
  count = 0;
  constructor(spaceFolder: string, stem: string) {
    this.#space = spaceFolder;
    this.#stem = stem;
  }
  /** Relative to the space's folder, once something was rescued. */
  get folder(): string | undefined {
    return this.count === 0 ? undefined : `rescued/${this.#stem}`;
  }
  /** Where `rel` goes, its folders made. */
  target(rel: string, act: (path: string) => void): string {
    const rescued = join(this.#space, "rescued");
    const box = join(rescued, this.#stem);
    if (!this.#made) {
      const stats = lstatSync(rescued, { throwIfNoEntry: false });
      if (stats !== undefined && !stats.isDirectory()) {
        throw new ProjectionError("ENOTDIR", "The space's rescued folder is not a real folder");
      }
      act("mkdir");
      if (stats === undefined) makeDir(rescued, FOLDER_MODE, { recursive: false });
      // Exclusive: a folder made before is never reused.
      makeDir(box, FOLDER_MODE, { recursive: false });
      this.#made = true;
    }
    const parts = rel.split("/");
    if (parts.length > 1) {
      act("mkdir");
      makeDir(join(box, ...parts.slice(0, -1)), FOLDER_MODE);
    }
    return join(box, ...parts);
  }
}

export interface DiskOptions {
  /** The tree's root. */
  readonly dir: string;
  /** The space's folder: rescues go to its `rescued/`. */
  readonly spaceFolder: string;
  readonly platform?: NodeJS.Platform;
  /** Tests only: runs before every act on disk; throwing is a kill. */
  readonly at?: Hook;
}

/** The tree's files on disk. */
export class Disk {
  readonly #dir: string;
  readonly #win: boolean;
  readonly #at: Hook | undefined;

  constructor(options: DiskOptions) {
    this.#dir = options.dir;
    this.#win = (options.platform ?? process.platform) === "win32";
    this.#at = options.at;
  }

  #abs(path: string): string {
    return path === "" ? this.#dir : join(this.#dir, ...path.split("/"));
  }

  #act(act: Parameters<Hook>[0], path: string): void {
    this.#at?.(act, path);
  }

  #realFolder(rel: string): boolean {
    return lstatSync(this.#abs(rel), { throwIfNoEntry: false })?.isDirectory() === true;
  }

  #reachable(path: string): boolean {
    return foldersOf(path).every((rel) => this.#realFolder(rel));
  }

  /** A regular file at `path` through one descriptor that is the entry lstat saw, left open. */
  #open(path: string): { kind: "missing" } | { kind: "other" } | ({ kind: "file" } & Opened) {
    const abs = this.#abs(path);
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
      return { kind: "file", fd, ...hashOf(fd), links: Number(stats.nlink) };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  /** What is at `path`, without acting. */
  look(path: string): Look {
    if (!this.#reachable(path)) return { kind: "other" };
    try {
      const found = this.#open(path);
      if (found.kind !== "file") return found;
      closeSync(found.fd);
      return { kind: "file", sha256: found.sha256, size: found.size, links: found.links };
    } catch (error) {
      return codeIs(error, "EBUSY", "EPERM", "EACCES") ? { kind: "busy" } : { kind: "other" };
    }
  }

  /** Makes the tree's root when it is not there. */
  root(): void {
    if (this.#realFolder("")) return;
    this.#act("mkdir", "");
    makeDir(this.#dir, FOLDER_MODE);
  }

  /**
   * Places `content` at `path`. What is there is replaced only when it is ours by `allowed`;
   * anything else is rescued first. "same" when the path already holds exactly these bytes.
   * Throws when the file is not placed; a rescue that happened stays done.
   */
  place(
    path: string,
    content: string,
    allowed: readonly Owned[],
    rescue: Rescue,
    tag: string,
  ): "written" | "same" {
    const data = Buffer.from(content, "utf8");
    const hash = sha256(data);
    this.#folders(path, rescue);
    const temp = tempPathOf(path, hash, tag);
    const tempAbs = this.#abs(temp);
    this.#act("temp", temp);
    const fd = createFile(tempAbs, FILE_MODE);
    try {
      try {
        this.#act("write", temp);
        writeAll(fd, data);
      } finally {
        closeSync(fd);
      }
      return this.#swap(path, temp, { sha256: hash, size: data.length }, allowed, rescue);
    } catch (error) {
      this.#dropTemp(temp);
      throw error;
    }
  }

  #swap(
    path: string,
    temp: string,
    next: Owned,
    allowed: readonly Owned[],
    rescue: Rescue,
  ): "written" | "same" {
    const abs = this.#abs(path);
    const tempAbs = this.#abs(temp);
    if (!this.#reachable(path)) {
      throw new ProjectionError("ENOTDIR", "A folder of the tree is not a real folder");
    }
    const found = this.#open(path);
    if (found.kind === "file") {
      let ours: boolean;
      try {
        if (found.links === 1 && found.sha256 === next.sha256) {
          this.#dropTemp(temp);
          return "same";
        }
        ours =
          found.links === 1 &&
          allowed.some((own) => own.size === found.size && own.sha256 === found.sha256);
        if (ours && this.#win) {
          this.#act("chmod", path);
          fchmodSync(found.fd, 0o600);
        }
      } finally {
        closeSync(found.fd);
      }
      if (!ours) this.#rescue(path, rescue);
    } else if (found.kind === "other") {
      this.#rescue(path, rescue);
    }
    this.#act("rename", path);
    renameSync(tempAbs, abs);
    return "written";
  }

  /** Removes a temporary file this placement made, while its folder is still a real one. */
  #dropTemp(temp: string): void {
    try {
      if (!this.#reachable(temp)) return;
      const stats = lstatSync(this.#abs(temp), { throwIfNoEntry: false });
      if (stats?.isFile() !== true || stats.nlink !== 1) return;
      this.#act("unlink", temp);
      unlinkSync(this.#abs(temp));
    } catch {
      // Left: its content proves it ours at the next clean-up.
    }
  }

  /** Makes each folder on the way to `path` a real folder; anything else there is rescued first. */
  #folders(path: string, rescue: Rescue): void {
    for (const rel of foldersOf(path)) {
      const stats = lstatSync(this.#abs(rel), { throwIfNoEntry: false });
      if (stats?.isDirectory() === true) continue;
      if (stats !== undefined) {
        if (rel === "") throw new ProjectionError("ENOTDIR", "The tree's root is not a folder");
        this.#rescue(rel, rescue);
      }
      this.#act("mkdir", rel);
      makeDir(this.#abs(rel), FOLDER_MODE, { recursive: false });
    }
  }

  /** Moves the entry at `rel` aside by one rename, never followed, never copied. */
  #rescue(rel: string, rescue: Rescue): void {
    const target = rescue.target(rel, (path) => {
      this.#act("mkdir", path);
    });
    this.#act("rescue", rel);
    renameSync(this.#abs(rel), target);
    rescue.count += 1;
  }

  /**
   * Removes the file at `path` when it is ours by `allowed`. Anything else is left where it is:
   * nothing needs that name any more. Throws when a file of ours could not be removed (held).
   */
  remove(path: string, allowed: readonly Owned[]): "removed" | "left" | "missing" {
    if (!this.#reachable(path)) return "left";
    const found = this.#open(path);
    if (found.kind === "missing") return "missing";
    if (found.kind !== "file") return "left";
    let ours: boolean;
    try {
      ours =
        found.links === 1 &&
        allowed.some((own) => own.size === found.size && own.sha256 === found.sha256);
    } finally {
      closeSync(found.fd);
    }
    if (!ours) return "left";
    // Node's unlink on Windows clears a read-only attribute through its own handle.
    this.#act("unlink", path);
    unlinkSync(this.#abs(path));
    return "removed";
  }

  /** Removes each of `folders` that is an empty real folder, the deepest first; never the root. */
  prune(folders: Iterable<string>): void {
    const sorted = [...new Set(folders)].filter((f) => f !== "");
    sorted.sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1));
    for (const rel of sorted) {
      try {
        if (!this.#reachable(`${rel}/x`) || readdirSync(this.#abs(rel)).length > 0) continue;
        this.#act("rmdir", rel);
        rmdirSync(this.#abs(rel));
      } catch {
        // Held, or no longer empty: left.
      }
    }
  }

  /** Of `paths`, those not in their folder's listing: one listing per folder. */
  absent(paths: Iterable<string>): string[] {
    const byFolder = new Map<string, string[]>();
    for (const path of paths) {
      const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), path]);
    }
    const out: string[] = [];
    for (const [folder, inFolder] of byFolder) {
      let names: Set<string> | undefined;
      try {
        if (this.#reachable(inFolder[0] ?? "")) names = new Set(readdirSync(this.#abs(folder)));
      } catch {
        names = undefined;
      }
      for (const path of inFolder) {
        if (names?.has(path.slice(path.lastIndexOf("/") + 1)) !== true) out.push(path);
      }
    }
    return out;
  }

  /**
   * Removes the temporary files a kill left, in every real folder of the tree: those whose content
   * hashes to their name, and empty ones. Returns how many went.
   */
  cleanTemps(): number {
    let removed = 0;
    const visit = (rel: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(this.#abs(rel));
      } catch {
        return;
      }
      for (const name of entries) {
        const path = rel === "" ? name : `${rel}/${name}`;
        const stats = lstatSync(this.#abs(path), { throwIfNoEntry: false });
        if (stats?.isDirectory() === true) {
          visit(path);
          continue;
        }
        const match = TEMP_NAME.exec(name);
        if (match === null || stats?.isFile() !== true) continue;
        try {
          const found = this.#open(path);
          if (found.kind !== "file") continue;
          let ours: boolean;
          try {
            ours =
              found.links === 1 && (found.size === 0 || found.sha256.startsWith(match[2] ?? "-"));
          } finally {
            closeSync(found.fd);
          }
          if (!ours) continue;
          this.#act("unlink", path);
          unlinkSync(this.#abs(path));
          removed += 1;
        } catch {
          // Held, or gone: the next start looks again.
        }
      }
    };
    if (this.#realFolder("")) visit("");
    return removed;
  }
}
