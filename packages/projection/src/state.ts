// The projection's trusted state: the record of what it placed in the tree, and
// the journal of the batch in progress. Both live in the product's machine state for the space, one
// pair per folder that holds it (`<state>/spaces/<space_id>.<folder key>.projection.json` and
// `….projection-journal.json`, beside the space's machine-local settings), never in the tree:
// nothing a person can edit there, and nothing a person is expected to touch, authorizes a write,
// an overwrite or a delete.
//
// - **The record**: for every file the projection placed and still holds as its own, its path in
//   the tree, its SHA-256, its size and the task it belongs to (none for a root file); for every
//   task with a file, its catalogue line as rendered (the catalogue is assembled from these); the
//   space it was made for; the watermark last published; and the rescue stems told (rule 3). A
//   file whose task no longer names it (the task moved or is gone) is retired: removed after the
//   next publish, when it is still ours.
// - **The journal** names, before a batch acts, the temporary files it may create, every file it
//   is about to place with its hash, and the tasks it found gone. A kill leaves it; the next start
//   plays it forward against the disk (projector.ts) and removes the temporary files it names.
//
// **Only a file that is not there is no state**. A record or a journal that is
// there and does not read back whole (cut short, of another format, failing its own checks, not a
// file) is `unreadable`, never `none`: nobody knows what it would have said, so the start rebuilds
// every task (projector.ts). Each is one JSON object, so one cut short does not parse. Every path
// in them is checked against the tree's grammar before it is used. Both are written atomically,
// whole (writeAll) and flushed, with mode 0600, through @ttasks/files.
//
// **Not a file there** (a folder, a link: a mistaken restore, a slip) is never the projection's,
// which writes only files there, and may be a person's: it is never removed, written through or
// written over. Before its path is written, or the journal dropped, it is moved aside once by one
// rename of the entry itself, never followed, to `<its name>.moved-aside-<time>` beside it, and
// told (onAside). A start that found it read it as unknown and sent its rebuild's queue through
// the writer before either (projector.ts); a running projector holds its state in memory.
import { lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { atomicWrite, makeDir, removeStaleTemps } from "@ttasks/files";
import {
  FORMAT,
  LIFECYCLES,
  RENDERER,
  type CatalogEntry,
  type Lifecycle,
  type SpaceIdentity,
} from "./render.ts";
import { isTempPath, isTreePath, STEM, TASK_FILE, type Hook } from "./tree.ts";

/** A file the projection placed: what it holds, and the task it belongs to (none: a root file). */
export interface FileRecord {
  readonly sha256: string;
  readonly size: number;
  readonly task?: string;
}

export interface TrustedRecord {
  identity: SpaceIdentity;
  /** The watermark last published: it never moves backwards within one identity. */
  watermark: number;
  /** The renderer its files were made by (render.ts RENDERER); 1 before records said. */
  renderer: number;
  /** Every file the projection placed and holds as its own, by its path in the tree. */
  readonly files: Map<string, FileRecord>;
  /** Each task with a file: its catalogue line as rendered, whose `path` is in `files`. */
  readonly entries: Map<string, CatalogEntry>;
  /**
   * The stems of the rescue folders on disk whose rescues were told (rule 3): a stem leaves it
   * when its folders are gone. A rescue folder whose stem is not here is told at the next start or
   * batch, so a record lost tells again, never less.
   */
  readonly told: Set<string>;
}

/** One file a batch is about to place. */
export interface Placing extends FileRecord {
  readonly entry?: CatalogEntry;
}

export interface Journal {
  /** Temporary files this batch may create, by their path in the tree. */
  readonly temps: readonly string[];
  readonly placing: ReadonlyMap<string, Placing>;
  /** Tasks the batch found gone: their lines go, their files retire. */
  readonly gone: readonly string[];
  /** The watermark the batch publishes, when it publishes. */
  readonly watermark?: number;
}

/**
 * A file of the trusted state read back: `none` only when it is not there; `unreadable` when it is
 * there and does not read back whole, which means "unknown", never "nothing".
 */
export type Read<T> =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "read"; readonly value: T };

const NONE = { kind: "none" } as const;
const UNREADABLE = { kind: "unreadable" } as const;

export const newRecord = (identity: SpaceIdentity): TrustedRecord => ({
  identity,
  watermark: 0,
  renderer: RENDERER,
  files: new Map(),
  entries: new Map(),
  told: new Set(),
});

const SHA256 = /^[0-9a-f]{64}$/;
/** A task's ID. */
const TASK_ID = /^t_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
/** A record larger than this is not read (a design-scale record is about 30 MB). */
const MAX_BYTES = 256 * 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** A catalogue line read back, or undefined when any part of it is not one. */
function entryOf(value: unknown): CatalogEntry | undefined {
  if (!isObject(value)) return undefined;
  const e = value;
  const labels = e["labels"];
  const path = e["path"];
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
    typeof path !== "string" ||
    !TASK_FILE.test(path) ||
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

/** A file record read back for `path`, or undefined. A task's file names its task; a root file none. */
function fileOf(path: string, value: unknown): FileRecord | undefined {
  if (!isTreePath(path) || !isObject(value)) return undefined;
  const { sha256, size, task } = value;
  if (typeof sha256 !== "string" || !SHA256.test(sha256) || !isCount(size)) return undefined;
  const taskFile = TASK_FILE.test(path);
  if (taskFile !== (typeof task === "string" && task !== "")) return undefined;
  return taskFile ? { sha256, size, task: task as string } : { sha256, size };
}

/** Sorted keys, so one record is one string of bytes. */
const sorted = <V>(map: ReadonlyMap<string, V>): Record<string, V> =>
  Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Which file of the trusted state. */
export type StateFile = "record" | "journal";

export interface TrustedStateOptions {
  /** The record's file, in the product's machine state. */
  readonly record: string;
  /** The journal's file, beside it. */
  readonly journal: string;
  /** Tests only: called before every write, with what is written. Throwing is a kill. */
  readonly at?: Hook;
  /** Each entry that was not a file at the record's or the journal's path, once moved aside. */
  readonly onAside?: (file: StateFile) => void;
  /** Default: Date.now. The time in a moved-aside entry's name. */
  readonly now?: () => number;
}

/** The record and the journal on disk. */
export class TrustedState {
  readonly #record: string;
  readonly #journal: string;
  readonly #at: Hook | undefined;
  readonly #onAside: ((file: StateFile) => void) | undefined;
  readonly #now: () => number;

  constructor(options: TrustedStateOptions) {
    this.#record = options.record;
    this.#journal = options.journal;
    this.#at = options.at;
    this.#onAside = options.onAside;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Moves aside what is at `file`'s path when it is there and not a regular file (see the header):
   * one rename beside it to `<name>.moved-aside-<time>`, `-<n>` added while that name is taken, so
   * nothing is renamed over. Returns whether it moved something.
   */
  #aside(file: StateFile): boolean {
    const path = file === "record" ? this.#record : this.#journal;
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (stats === undefined || stats.isFile()) return false;
    const stamp = new Date(this.#now()).toISOString().replace(/[-:.]/g, "");
    for (let n = 1; ; n += 1) {
      const to = `${path}.moved-aside-${stamp}${n === 1 ? "" : `-${String(n)}`}`;
      if (lstatSync(to, { throwIfNoEntry: false }) !== undefined) continue;
      this.#at?.("aside", "");
      renameSync(path, to);
      this.#onAside?.(file);
      return true;
    }
  }

  /** Makes the folder they live in, and removes what a kill left of an atomic write there. */
  prepare(): void {
    const folder = dirname(this.#record);
    makeDir(folder, 0o700);
    removeStaleTemps(folder, [basename(this.#record), basename(this.#journal)]);
  }

  /**
   * The JSON object at `path`: none only when nothing is there (ENOENT); unreadable when what is
   * there is not a file, too large, does not parse or is not an object of this format. Any other
   * error of the look (a folder that cannot be read) throws: that is not knowing either.
   */
  #read(path: string): Read<Record<string, unknown>> {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (stats === undefined) return NONE;
    if (!stats.isFile() || stats.size > MAX_BYTES) return UNREADABLE;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      // Gone between the look and the read: nothing is there.
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return NONE;
      return UNREADABLE;
    }
    return isObject(value) && value["format"] === FORMAT ? { kind: "read", value } : UNREADABLE;
  }

  /** The record (see the header: `unreadable` is never `none`). */
  readRecord(): Read<TrustedRecord> {
    const read = this.#read(this.#record);
    if (read.kind !== "read") return read;
    const value = read.value;
    const { space_id, epoch, incarnation, watermark, told } = value;
    const renderer = value["renderer"] ?? 1;
    if (
      typeof space_id !== "string" ||
      !isCount(renderer) ||
      !isCount(epoch) ||
      typeof incarnation !== "string" ||
      !isCount(watermark) ||
      !isObject(value["files"]) ||
      !isObject(value["entries"]) ||
      !Array.isArray(told) ||
      !told.every((stem) => typeof stem === "string" && STEM.test(stem))
    ) {
      return UNREADABLE;
    }
    const files = new Map<string, FileRecord>();
    for (const [path, item] of Object.entries(value["files"])) {
      const file = fileOf(path, item);
      if (file === undefined) return UNREADABLE;
      files.set(path, file);
    }
    const entries = new Map<string, CatalogEntry>();
    for (const [id, item] of Object.entries(value["entries"])) {
      const entry = entryOf(item);
      // A task's line names a file of the record that belongs to that task.
      if (entry === undefined || entry.id !== id || files.get(entry.path)?.task !== id) {
        return UNREADABLE;
      }
      entries.set(id, entry);
    }
    return {
      kind: "read",
      value: {
        identity: { spaceId: space_id, epoch, incarnation },
        watermark,
        renderer,
        files,
        entries,
        told: new Set(told as string[]),
      },
    };
  }

  writeRecord(record: TrustedRecord): void {
    const value = {
      format: FORMAT,
      space_id: record.identity.spaceId,
      epoch: record.identity.epoch,
      incarnation: record.identity.incarnation,
      watermark: record.watermark,
      renderer: record.renderer,
      files: sorted(record.files),
      entries: sorted(record.entries),
      told: [...record.told].sort(),
    };
    this.#aside("record");
    this.#at?.("record", "");
    atomicWrite(this.#record, `${JSON.stringify(value)}\n`, 0o600);
  }

  /** The journal a kill left (see the header: `unreadable` is never `none`). */
  readJournal(): Read<Journal> {
    const read = this.#read(this.#journal);
    if (read.kind !== "read") return read;
    const value = read.value;
    const { temps, watermark, gone } = value;
    if (
      !Array.isArray(temps) ||
      !Array.isArray(gone) ||
      !gone.every((id) => typeof id === "string" && TASK_ID.test(id)) ||
      !temps.every((t) => typeof t === "string" && isTempPath(t)) ||
      (watermark !== undefined && !isCount(watermark)) ||
      !isObject(value["placing"])
    ) {
      return UNREADABLE;
    }
    const placing = new Map<string, Placing>();
    for (const [path, item] of Object.entries(value["placing"])) {
      const file = fileOf(path, item);
      if (file === undefined || !isObject(item)) return UNREADABLE;
      if (file.task === undefined) {
        placing.set(path, file);
        continue;
      }
      const entry = entryOf(item["entry"]);
      if (entry === undefined || entry.id !== file.task || entry.path !== path) return UNREADABLE;
      placing.set(path, { ...file, entry });
    }
    return {
      kind: "read",
      value: {
        temps: temps as string[],
        gone: gone as string[],
        placing,
        ...(watermark === undefined ? {} : { watermark }),
      },
    };
  }

  writeJournal(journal: Journal): void {
    const value = {
      format: FORMAT,
      temps: journal.temps,
      gone: journal.gone,
      placing: sorted(journal.placing),
      ...(journal.watermark === undefined ? {} : { watermark: journal.watermark }),
    };
    this.#aside("journal");
    this.#at?.("journal", "");
    atomicWrite(this.#journal, `${JSON.stringify(value)}\n`, 0o600);
  }

  /** Removes the journal: a file only. Anything else there is moved aside (see the header). */
  dropJournal(): void {
    if (this.#aside("journal")) return;
    this.#at?.("journal-drop", "");
    rmSync(this.#journal, { force: true });
  }
}
