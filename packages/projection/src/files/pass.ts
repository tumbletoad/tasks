// The readable files of a tree space, kept equal to a fresh render of its latest snapshot.
//
// A pass reads one snapshot, renders every file, and compares each file's hash with the record.
// Only a path whose bytes differ, or whose file went missing or was found edited, is written; only
// a recorded path the snapshot no longer renders is removed; then folders left empty go. The
// README, which says which commit the files show, is placed last and only when every other file
// was, so it never claims more than is there. A path that could not be written (held by another
// program) keeps its record and is tried at the next pass, which the loop runs soon without
// waiting for a commit.
//
// **A kill.** Before a pass acts, the record gains each new hash as pending; after, it keeps what
// was placed. The next start looks at what reached the disk before it drops either hash: a path
// that holds the pending bytes has them placed, one that holds the old bytes keeps those, one that
// holds neither is a person's. Only then does it read a snapshot, so nothing of its own is rescued
// and nothing of a person's is taken for its own.
//
// **A person's files.** A file a person adds at a path the record does not know stays. A file of
// ours that a person changed is rescued when a pass must replace it, and left where it is when its
// path is no longer used. Edits are found at the start, before a file is replaced, and by a full
// check (`rebuild`); a file that went missing is found by its folder's listing before every pass
// and whenever the loop sweeps.
import type { Connection } from "@ttasks/storage";
import { sha256, type Hook } from "../tree.ts";
import { Disk, foldersOf, newStem, newTag, Rescue, type Owned } from "./disk.ts";
import { allowedOf, FilesRecord } from "./record.ts";
import { renderTree } from "./render.ts";
import { readSnapshot } from "./snapshot.ts";

const README = "README.md";

export interface FilesOptions {
  /** A connection of the tree space; the projector only reads through it. */
  readonly conn: Connection;
  /** This machine: its folders are the ones shown. */
  readonly machine: string;
  /** The tree's root: the space's `view/`. */
  readonly dir: string;
  /** The space's folder: what a person changed is rescued to its `rescued/`. */
  readonly spaceFolder: string;
  /** The record's file, in the product's machine state. */
  readonly record: string;
  readonly timeZone?: string;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  /** Tests only: runs before every act on disk; throwing is a kill. */
  readonly at?: Hook;
}

/** What a start found. Counts only. */
export interface StartReport {
  /** Paths whose pending bytes were found placed after a kill. */
  readonly recovered: number;
  /** Temporary files a kill left, removed. */
  readonly temps: number;
  /** Files of the record found changed or missing. */
  readonly suspect: number;
}

/** What one pass did. Counts and a code only: no path, no text. */
export interface PassReport {
  /** The snapshot's commit. */
  readonly seq: number;
  readonly written: number;
  readonly removed: number;
  /** Entries a person changed, moved aside. */
  readonly rescued: number;
  /** Relative to the space's folder, when something was rescued. */
  readonly rescueFolder?: string;
  /** Paths that could not be written or removed: the next pass tries them again. */
  readonly failed: number;
  readonly code?: string;
  /** The README now says the files show `seq`. */
  readonly stamped: boolean;
}

const same = (a: Owned | undefined, b: Owned | undefined): boolean =>
  a !== undefined && b !== undefined && a.sha256 === b.sha256 && a.size === b.size;

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_0-9]{2,40}$/.test(code) ? code : "EIO";
};

export class FilesProjector {
  readonly #options: FilesOptions;
  readonly #disk: Disk;
  #record = new FilesRecord();
  /** Paths whose file on disk is not what the record says: written at the next pass. */
  readonly #suspect = new Set<string>();

  constructor(options: FilesOptions) {
    this.#options = options;
    this.#disk = new Disk({
      dir: options.dir,
      spaceFolder: options.spaceFolder,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.at === undefined ? {} : { at: options.at }),
    });
  }

  #save(): void {
    this.#options.at?.("record", "");
    this.#record.save(this.#options.record);
  }

  /** The space's latest commit, the one a pass would show. */
  seq(): number {
    return Number(
      this.#options.conn.prepare("SELECT last_seq FROM space").get()?.["last_seq"] ?? 0,
    );
  }

  /**
   * Before the first pass: what a kill left is settled from the disk, temporary files go, and
   * every recorded file is checked.
   */
  start(): StartReport {
    this.#record = FilesRecord.load(this.#options.record);
    let recovered = 0;
    let changed = false;
    for (const [path, entry] of this.#record.files) {
      if (entry.pending === undefined) continue;
      const found = this.#disk.look(path);
      // Held by another program: both hashes stay ours until it can be read.
      if (found.kind === "busy") continue;
      const bytes = found.kind === "file" ? { sha256: found.sha256, size: found.size } : undefined;
      if (same(bytes, entry.pending)) {
        entry.placed = entry.pending;
        recovered += 1;
      }
      delete entry.pending;
      if (entry.placed === undefined) this.#record.files.delete(path);
      changed = true;
    }
    if (changed) this.#save();
    const temps = this.#disk.cleanTemps();
    return { recovered, temps, suspect: this.check() };
  }

  /** Every recorded file read: one changed or missing is written at the next pass. */
  check(): number {
    for (const [path, entry] of this.#record.files) {
      const found = this.#disk.look(path);
      if (found.kind === "busy") continue;
      const ok =
        found.kind === "file" &&
        found.links === 1 &&
        allowedOf(entry).some((own) => own.sha256 === found.sha256 && own.size === found.size);
      if (!ok) this.#suspect.add(path);
    }
    return this.#suspect.size;
  }

  /** Recorded files not in their folder's listing. They are written at the next pass. */
  missing(): number {
    const gone = this.#disk.absent(this.#record.files.keys());
    for (const path of gone) this.#suspect.add(path);
    return gone.length;
  }

  /** One pass, from the snapshot as it is now. */
  pass(): PassReport {
    const { conn, machine, timeZone } = this.#options;
    const snapshot = readSnapshot(conn, machine);
    const files = renderTree(
      snapshot,
      timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    this.missing();
    this.#disk.root();

    const wanted = new Map<string, { content: string; own: Owned }>();
    for (const [path, content] of files) {
      wanted.set(path, {
        content,
        own: { sha256: sha256(content), size: Buffer.byteLength(content) },
      });
    }
    const due = (path: string): boolean => {
      const entry = this.#record.files.get(path);
      const own = wanted.get(path)?.own;
      return this.#suspect.has(path) || entry?.pending !== undefined || !same(entry?.placed, own);
    };
    const writes = [...wanted.keys()].filter((path) => path !== README && due(path)).sort();
    const retired = [...this.#record.files.keys()].filter((path) => !wanted.has(path)).sort();

    let written = 0;
    let removed = 0;
    let failed = 0;
    let code: string | undefined;
    const fail = (error: unknown): void => {
      failed += 1;
      code ??= codeOf(error);
    };
    const rescue = new Rescue(
      this.#options.spaceFolder,
      newStem((this.#options.now ?? Date.now)()),
    );
    const tag = newTag();
    const place = (path: string): boolean => {
      const want = wanted.get(path);
      if (want === undefined) return false;
      const entry = this.#record.files.get(path) ?? {};
      try {
        if (this.#disk.place(path, want.content, allowedOf(entry), rescue, tag) === "written") {
          written += 1;
        }
        this.#record.files.set(path, { placed: want.own });
        this.#suspect.delete(path);
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    };

    if (writes.length > 0) {
      for (const path of writes) {
        const entry = this.#record.files.get(path) ?? {};
        const own = wanted.get(path)?.own;
        if (own !== undefined && !same(entry.placed, own)) entry.pending = own;
        this.#record.files.set(path, entry);
      }
      this.#save();
    }
    for (const path of writes) place(path);

    const emptied: string[] = [];
    for (const path of retired) {
      try {
        const done = this.#disk.remove(path, allowedOf(this.#record.files.get(path)));
        if (done === "removed") removed += 1;
        this.#record.files.delete(path);
        this.#suspect.delete(path);
        emptied.push(...foldersOf(path));
      } catch (error) {
        fail(error);
      }
    }
    const needed = new Set([...wanted.keys()].flatMap((path) => foldersOf(path)));
    this.#disk.prune(emptied.filter((folder) => !needed.has(folder)));

    let stamped = false;
    let readme = false;
    if (failed === 0) {
      readme = due(README);
      if (readme) {
        const own = wanted.get(README)?.own;
        const entry = this.#record.files.get(README) ?? {};
        if (own !== undefined) entry.pending = own;
        this.#record.files.set(README, entry);
        this.#save();
        stamped = place(README);
      } else {
        stamped = true;
      }
    }
    if (writes.length > 0 || retired.length > 0 || failed > 0 || readme) this.#save();
    return {
      seq: snapshot.seq,
      written,
      removed,
      rescued: rescue.count,
      ...(rescue.folder === undefined ? {} : { rescueFolder: rescue.folder }),
      failed,
      ...(code === undefined ? {} : { code }),
      stamped,
    };
  }
}
