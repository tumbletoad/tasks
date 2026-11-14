// The projection's trusted state (A1 3.13 rule 1): the record of what it placed in the tree, and
// the journal of the batch in progress. Both live in the product's machine state for the space
// (`<state>/spaces/<space_id>.projection.json` and `….projection-journal.json`, beside the
// space's machine-local settings), never in the tree: nothing a person can edit there, and nothing
// a person is expected to touch, authorizes a write, an overwrite or a delete.
//
// - **The record**: for every file the projection placed and still holds as its own, its path in
//   the tree, its SHA-256, its size and the task it belongs to (none for a root file); for every
//   task with a file, its catalogue line as rendered (the catalogue is assembled from these); the
//   space it was made for; and the watermark last published. A file whose task no longer names it
//   (the task moved or is gone) is retired: removed after the next publish, when it is still ours.
// - **The journal** names, before a batch acts, the temporary files it may create and every file
//   it is about to place with its hash, and the stem of its rescue folders. A kill leaves it; the
//   next start plays it forward against the disk (projector.ts) and removes the temporary files it
//   names.
//
// A record or a journal that is missing or does not read back whole is no record: the tree is then
// reconciled from scratch, and nothing is deleted on its word. Every path in it is checked against
// the tree's grammar before it is used. Both are written atomically, flushed, with mode 0600,
// through @tasks/files.
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { atomicWrite, makeDir, removeStaleTemps } from "@tasks/files";
import {
  FORMAT,
  LIFECYCLES,
  type CatalogEntry,
  type Lifecycle,
  type SpaceIdentity,
} from "./render.ts";
import { isTempPath, isTreePath, TASK_FILE, type Hook } from "./tree.ts";

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
  /** Every file the projection placed and holds as its own, by its path in the tree. */
  readonly files: Map<string, FileRecord>;
  /** Each task with a file: its catalogue line as rendered, whose `path` is in `files`. */
  readonly entries: Map<string, CatalogEntry>;
}

/** One file a batch is about to place. */
export interface Placing extends FileRecord {
  readonly entry?: CatalogEntry;
}

export interface Journal {
  /** Rescue folders of this batch are `exchange/rescued/<stem>-<n>`. */
  readonly stem: string;
  /** Temporary files this batch may create, by their path in the tree. */
  readonly temps: readonly string[];
  readonly placing: ReadonlyMap<string, Placing>;
  /** The watermark the batch publishes, when it publishes. */
  readonly watermark?: number;
}

export const newRecord = (identity: SpaceIdentity): TrustedRecord => ({
  identity,
  watermark: 0,
  files: new Map(),
  entries: new Map(),
});

const SHA256 = /^[0-9a-f]{64}$/;
/** A rescue stem as the projector makes it: a time stamp and 16 random bits. */
export const STEM = /^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{4}$/;
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

export interface TrustedStateOptions {
  /** The record's file, in the product's machine state. */
  readonly record: string;
  /** The journal's file, beside it. */
  readonly journal: string;
  /** Tests only: called before every write, with what is written. Throwing is a kill. */
  readonly at?: Hook;
}

/** The record and the journal on disk. */
export class TrustedState {
  readonly #record: string;
  readonly #journal: string;
  readonly #at: Hook | undefined;

  constructor(options: TrustedStateOptions) {
    this.#record = options.record;
    this.#journal = options.journal;
    this.#at = options.at;
  }

  /** Makes the folder they live in, and removes what a kill left of an atomic write there. */
  prepare(): void {
    const folder = dirname(this.#record);
    makeDir(folder, 0o700);
    removeStaleTemps(folder, [basename(this.#record), basename(this.#journal)]);
  }

  #read(path: string): unknown {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile() || stats.size > MAX_BYTES) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  /** The record, or undefined when there is none or it does not read back whole. */
  readRecord(): TrustedRecord | undefined {
    const value = this.#read(this.#record);
    if (!isObject(value) || value["format"] !== FORMAT) return undefined;
    const { space_id, epoch, incarnation, watermark } = value;
    if (
      typeof space_id !== "string" ||
      !isCount(epoch) ||
      typeof incarnation !== "string" ||
      !isCount(watermark) ||
      !isObject(value["files"]) ||
      !isObject(value["entries"])
    ) {
      return undefined;
    }
    const files = new Map<string, FileRecord>();
    for (const [path, item] of Object.entries(value["files"])) {
      const file = fileOf(path, item);
      if (file === undefined) return undefined;
      files.set(path, file);
    }
    const entries = new Map<string, CatalogEntry>();
    for (const [id, item] of Object.entries(value["entries"])) {
      const entry = entryOf(item);
      // A task's line names a file of the record that belongs to that task.
      if (entry === undefined || entry.id !== id || files.get(entry.path)?.task !== id) {
        return undefined;
      }
      entries.set(id, entry);
    }
    return { identity: { spaceId: space_id, epoch, incarnation }, watermark, files, entries };
  }

  writeRecord(record: TrustedRecord): void {
    const value = {
      format: FORMAT,
      space_id: record.identity.spaceId,
      epoch: record.identity.epoch,
      incarnation: record.identity.incarnation,
      watermark: record.watermark,
      files: sorted(record.files),
      entries: sorted(record.entries),
    };
    this.#at?.("record", "");
    atomicWrite(this.#record, `${JSON.stringify(value)}\n`, 0o600);
  }

  /** The journal a kill left, or undefined when there is none or it does not read back whole. */
  readJournal(): Journal | undefined {
    const value = this.#read(this.#journal);
    if (!isObject(value) || value["format"] !== FORMAT) return undefined;
    const { stem, temps, watermark } = value;
    if (
      typeof stem !== "string" ||
      !STEM.test(stem) ||
      !Array.isArray(temps) ||
      !temps.every((t) => typeof t === "string" && isTempPath(t)) ||
      (watermark !== undefined && !isCount(watermark)) ||
      !isObject(value["placing"])
    ) {
      return undefined;
    }
    const placing = new Map<string, Placing>();
    for (const [path, item] of Object.entries(value["placing"])) {
      const file = fileOf(path, item);
      if (file === undefined || !isObject(item)) return undefined;
      if (file.task === undefined) {
        placing.set(path, file);
        continue;
      }
      const entry = entryOf(item["entry"]);
      if (entry === undefined || entry.id !== file.task || entry.path !== path) return undefined;
      placing.set(path, { ...file, entry });
    }
    return {
      stem,
      temps: temps as string[],
      placing,
      ...(watermark === undefined ? {} : { watermark }),
    };
  }

  writeJournal(journal: Journal): void {
    const value = {
      format: FORMAT,
      stem: journal.stem,
      temps: journal.temps,
      placing: sorted(journal.placing),
      ...(journal.watermark === undefined ? {} : { watermark: journal.watermark }),
    };
    this.#at?.("journal", "");
    atomicWrite(this.#journal, `${JSON.stringify(value)}\n`, 0o600);
  }

  dropJournal(): void {
    this.#at?.("journal-drop", "");
    rmSync(this.#journal, { force: true });
  }
}
