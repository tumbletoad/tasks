// The projection's consumer of the outbox (A1 3.13 "Regeneration"): one batch at a time, from a
// reader connection of the space and through the space's writer, which alone writes the outbox.
//
// A batch, in this order:
// 1. One read transaction at snapshot T (read.ts): up to 200 dirty tasks, oldest `first_seq`
//    first, with what the projection shows of each.
// 2. Each task is rendered (render.ts). The journal records every file the batch is about to
//    place, then the files change (tree.ts): placed read-only by a rename, a file that is not the
//    projection's own rescued first. A file the task left (it moved, or the task is gone) is
//    retired, not removed: the catalogue on disk still names it.
// 3. The writer marks the tasks whose files are in place (write/outbox.ts) and answers the
//    watermark W: only through a fully rendered prefix. A task that failed keeps its row, so W stays
//    below it, and the next batch takes it first.
// 4. Unless a rebuild runs, the root files are written from the record's catalogue lines, which are
//    exactly what was rendered: README.md, index.md, catalog.jsonl and, last, .projection.json, both
//    headers with seq W. W never moves backwards. Only then do the retired files go, each when it
//    still holds what was written (rescued otherwise), so every path the catalogue names exists at
//    every moment.
// 5. The record is written and the journal dropped. Then `*` is reported, when it was dirty.
//
// **The record describes the disk.** A record that could not be written fails the batch, keeps its
// journal, and is written before anything else: no batch starts, and no journal is replaced, while
// the record on disk is behind. A retired file that could not be removed is a failure of the batch,
// and is tried again at the next publish until it goes. And when the record may no longer describe
// the disk, the tree is rebuilt: a journal that cannot be read (it may name files a reported batch
// placed), or a folder of the tree the record has files in that is missing or not a real folder
// (tree.ts never follows it). The folders are checked before every batch and at every look at the
// outbox, so a folder removed while nothing changes is noticed too.
//
// A kill anywhere leaves at most temporary files (removed at start) and a journal. At start the
// journal is played forward against what is on disk: a file that reached its place is taken into
// the record, and the path it replaced is retired, as is the file of a task the batch found gone.
// Then the outbox, which the writer marked only for tasks whose files were in place, renders the
// rest, and `*`, reported only after a publish, publishes again. So a kill never makes the
// projection rescue its own files, never loses a person's file, and never moves W past an
// unrendered commit.
//
// A full rebuild (no record, a record of another space, epoch, incarnation or format, an unreadable
// journal, a lost folder) removes `.projection.json` first, so the folder claims nothing, then the
// catalogue and the index, which name the old tree, queues every task through the writer and
// renders them as batches like any other. The old tree's files are retired: each is removed when it
// still holds what was written, rescued otherwise, once the rebuild ends. It runs in place, not in
// a `view.new/` beside the folder, because `projection.dir` may be a folder the person chose.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Connection, ProjectedBatch } from "@tasks/storage";
import { PROJECTION_ALL, PROJECTION_BATCH } from "@tasks/storage";
import { readBatch, readPending, type BatchRead } from "./read.ts";
import {
  catalogText,
  indexText,
  projectionJson,
  README_TEXT,
  renderTask,
  type SpaceIdentity,
  type Watermark,
} from "./render.ts";
import {
  codeOf,
  newRecord,
  ProjectionError,
  sha256,
  Tree,
  type FilePoint,
  type Journal,
  type TaskRecord,
  type TreeRecord,
} from "./tree.ts";

/** What the projection needs of the space's writer (storage's SpaceWriterHandle has both). */
export interface ProjectionWriter {
  projected(batch: ProjectedBatch): Promise<number>;
  queueProjection(): Promise<number>;
}

/** The named points of a batch, for the crash tests: a promise that never settles is a kill. */
export type ProjectionPoint = FilePoint | "journal" | "reported" | "record";

export interface ProjectorOptions {
  /** A reader connection of the space. The projector never writes through it. */
  readonly conn: Connection;
  readonly spaceFolder: string;
  /** The projection's folder (projectionFolder). */
  readonly dir: string;
  readonly writer: ProjectionWriter;
  /** Default: this machine's. Dates and the year folders follow it. */
  readonly timeZone?: string;
  readonly now?: () => number;
  /** Tasks per batch. Default: A1's 200. */
  readonly batch?: number;
  /** Tests only. */
  readonly at?: (point: ProjectionPoint, path?: string) => Promise<void> | void;
  readonly platform?: NodeJS.Platform;
}

/** What one batch did. Counts and codes only: no path, no text. */
export interface StepReport {
  /** The batch's snapshot T. */
  readonly seq: number;
  /** The watermark the writer answered. */
  readonly watermark: number;
  /** Task rows at or below T still wait: the next batch runs at once. */
  readonly backlog: boolean;
  readonly written: number;
  readonly removed: number;
  /** Tasks whose files could not all be placed: their rows wait. */
  readonly failed: number;
  /** The code of the first failure. */
  readonly code?: string;
  readonly rescued: number;
  /** Where this batch's rescued files are, relative to the space's folder. */
  readonly rescuedFolder?: string;
  readonly published: boolean;
  readonly rebuilding: boolean;
}

export interface StartReport {
  /** A full rebuild began. */
  readonly rebuild: boolean;
  /** Temporary files a kill left, removed. */
  readonly temps: number;
  /** A journal a kill left was played forward. */
  readonly recovered: boolean;
  readonly rescued: number;
  readonly rescuedFolder?: string;
}

/**
 * Where `path` is on disk: its nearest folder that exists, resolved through links, junctions and
 * other names of a folder (a Windows short name, another case), then the rest of the path.
 */
function physical(path: string): string {
  const rest: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync.native(at), ...rest);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new ProjectionError(codeOf(error), "projection.dir cannot be checked");
      }
      const parent = dirname(at);
      if (parent === at) return path;
      rest.unshift(basename(at));
      at = parent;
    }
  }
}

/**
 * The projection's folder: the space's `view/`, or the machine-local `projection.dir` (A1 3.13).
 * That one must be an absolute path outside the space's folder that does not contain it, so the
 * projection never writes among the space's own files: checked as written and where the folders
 * are on disk, so a link or another name of a folder on the way changes nothing. Throws EINVAL
 * otherwise.
 */
export function projectionFolder(
  spaceFolder: string,
  dir?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const space = resolve(spaceFolder);
  const view = join(space, "view");
  if (dir === undefined) return view;
  if (!isAbsolute(dir)) throw new ProjectionError("EINVAL", "projection.dir is not absolute");
  const target = resolve(dir);
  const fold = (path: string): string =>
    platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;
  const within = (inner: string, outer: string): boolean => {
    const rel = relative(fold(outer), fold(inner));
    // Only a `..` component is the way up: `..fixture` is a name inside.
    return rel === "" || (!/^\.\.([\\/]|$)/.test(rel) && !isAbsolute(rel));
  };
  const realSpace = physical(space);
  for (const [s, t] of [
    [space, target],
    [realSpace, physical(target)],
  ] as const) {
    if (within(s, t)) {
      throw new ProjectionError("EINVAL", "projection.dir holds the space's folder");
    }
    if (within(t, s) && fold(t) !== fold(join(s, "view"))) {
      throw new ProjectionError("EINVAL", "projection.dir is inside the space's folder");
    }
  }
  return target;
}

const sameIdentity = (a: SpaceIdentity, b: SpaceIdentity): boolean =>
  a.spaceId === b.spaceId && a.epoch === b.epoch && a.incarnation === b.incarnation;

/** The root files a rebuild removes first, the claim first of all: they describe the old tree. */
const OLD_TREE_FILES = [".projection.json", "catalog.jsonl", "index.md"] as const;

/** Every folder the record's task files are in, each with its parents: `completed`, `completed/2026`. */
function foldersOf(record: TreeRecord): Set<string> {
  const folders = new Set<string>();
  for (const { path } of record.tasks.values()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  }
  return folders;
}

/** One task's work in a batch: its record before, and its new record or null when it goes. */
interface Plan {
  readonly key: string;
  readonly old: TaskRecord | undefined;
  readonly next: TaskRecord | null;
  readonly content: string;
}

export class Projector {
  readonly #conn: Connection;
  readonly #writer: ProjectionWriter;
  readonly #tree: Tree;
  readonly #timeZone: string;
  readonly #now: () => number;
  readonly #batch: number;
  readonly #at: ProjectorOptions["at"];
  #record: TreeRecord | undefined;
  /** The record on disk is behind this one: it is written before anything else (see the header). */
  #unsaved = false;
  /** foldersOf(the record), kept for the look at the outbox every 100 ms. */
  #folders = new Set<string>();

  constructor(options: ProjectorOptions) {
    this.#conn = options.conn;
    this.#writer = options.writer;
    this.#timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.#now = options.now ?? Date.now;
    this.#batch = options.batch ?? PROJECTION_BATCH;
    if (!Number.isSafeInteger(this.#batch) || this.#batch < 1 || this.#batch > PROJECTION_BATCH) {
      throw new ProjectionError("EINVAL", "A batch holds 1 to 200 tasks");
    }
    this.#at = options.at;
    this.#tree = new Tree({
      spaceFolder: options.spaceFolder,
      dir: options.dir,
      now: this.#now,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.at === undefined ? {} : { at: options.at }),
    });
  }

  get #rec(): TreeRecord {
    if (this.#record === undefined)
      throw new ProjectionError("EINVAL", "The projector has not started");
    return this.#record;
  }

  /**
   * Makes the folder ready: removes a kill's temporary files, plays a kill's journal forward, and
   * begins a full rebuild when the tree is not this space's as it is now.
   */
  async start(): Promise<StartReport> {
    this.#tree.prepare();
    this.#tree.newBatch();
    const temps = this.#tree.cleanTemps();
    const found = this.#tree.readRecord();
    const journal = this.#tree.readJournal();
    let recovered = false;
    if (found !== undefined && found !== null && journal !== undefined && journal !== null) {
      this.#recover(found, journal);
      this.#tree.writeRecord(found);
      recovered = true;
    }
    const pending = readPending(this.#conn);
    const rebuild =
      found === undefined ||
      found === null ||
      // A journal that cannot be read may name files a reported batch placed (see the header).
      journal === null ||
      !sameIdentity(found.identity, pending) ||
      found.watermark > pending.lastSeq ||
      this.#tree.lostFolders.size > 0 ||
      this.#tree.missing(foldersOf(found));
    if (rebuild) await this.#rebuild(found ?? undefined, pending);
    else {
      this.#record = found;
      if (found.rebuilding && !found.queued) await this.#queue();
    }
    // Only now: until the record above is written, the journal is what a next start plays.
    this.#tree.dropJournal();
    this.#unsaved = false;
    this.#useFolders(foldersOf(this.#rec));
    const rescued = this.#tree.rescued;
    return {
      rebuild,
      temps,
      recovered,
      rescued: rescued.files,
      ...(rescued.folder === undefined ? {} : { rescuedFolder: rescued.folder }),
    };
  }

  /**
   * Plays a journal forward against the disk (see the header). A placed file is taken in, its old
   * path retired; a planned removal is finished; a file that did not reach its place leaves the
   * task's record as it was, and its outbox row renders it again.
   */
  #recover(record: TreeRecord, journal: Journal): void {
    for (const [id, next] of journal.tasks) {
      const old = record.tasks.get(id);
      if (next === null) {
        // A planned removal: the task was gone at the batch's snapshot. Its file goes at the next
        // publish, once the catalogue no longer names it.
        if (old === undefined) continue;
        record.retired.set(old.path, old.sha256);
        record.tasks.delete(id);
        continue;
      }
      const disk = this.#tree.hashOf(next.path);
      const oldThere = old !== undefined && this.#tree.hashOf(old.path) !== undefined;
      if (disk === next.sha256 || (!oldThere && disk !== undefined)) {
        record.tasks.set(id, next);
        record.retired.delete(next.path);
        if (old !== undefined && old.path !== next.path) record.retired.set(old.path, old.sha256);
      } else if (old !== undefined && !oldThere && disk === undefined) {
        // Neither file is there: no catalogue line may name a path that does not exist.
        record.tasks.delete(id);
      }
    }
    for (const [path, hash] of journal.files) {
      if (this.#tree.hashOf(path) === hash) {
        record.files.set(path, hash);
        record.retired.delete(path);
      }
    }
  }

  /** Begins a full rebuild for the space as it is now (see the header). */
  async #rebuild(old: TreeRecord | undefined, identity: SpaceIdentity): Promise<void> {
    const record = newRecord({
      spaceId: identity.spaceId,
      epoch: identity.epoch,
      incarnation: identity.incarnation,
    });
    if (old !== undefined) {
      for (const task of old.tasks.values()) record.retired.set(task.path, task.sha256);
      for (const [path, hash] of old.files) record.retired.set(path, hash);
      for (const [path, hash] of old.retired) record.retired.set(path, hash);
    }
    // First the claim goes, so a reader never trusts the old tree's watermark for the new one. Then
    // the catalogue and the index, which name the old tree's files: a removal that fails leaves
    // them retired, and the rebuild's first publish replaces them.
    for (const name of OLD_TREE_FILES) {
      const hash = record.retired.get(name);
      try {
        this.#tree.remove(name, (found) => hash === found);
        record.retired.delete(name);
      } catch (error) {
        if (name === ".projection.json") throw error;
      }
    }
    this.#record = record;
    // The new record has no task yet: no folder of the old tree is looked for again.
    this.#useFolders(foldersOf(record));
    this.#save();
    await this.#queue();
  }

  async #queue(): Promise<void> {
    await this.#writer.queueProjection();
    this.#rec.queued = true;
    this.#save();
  }

  /**
   * Writes the record. One that cannot be written leaves the projector unsaved: the journal stays,
   * and the next batch writes the record before anything else (see the header).
   */
  #save(): void {
    this.#unsaved = true;
    this.#tree.writeRecord(this.#rec);
    this.#unsaved = false;
  }

  /**
   * The folders the record has files in: pending() looks for them, and a write never makes one of
   * them again (tree.ts setKnownFolders), so a lost folder stays lost until the rebuild.
   */
  #useFolders(folders: Set<string>): void {
    this.#folders = folders;
    this.#tree.setKnownFolders(folders);
  }

  /**
   * Whether a batch has work, and a mark that changes whenever the outbox or the space does. Work
   * is also a record not yet written, a retired file still there, and a folder of the tree that is
   * missing or not a real folder (a few lstat calls).
   */
  pending(): { dirty: boolean; mark: string } {
    const p = readPending(this.#conn);
    const record = this.#rec;
    const dirty =
      this.#unsaved ||
      !sameIdentity(record.identity, p) ||
      record.rebuilding ||
      p.rows > 0 ||
      p.lastSeq > record.watermark ||
      record.retired.size > 0 ||
      this.#tree.missing(this.#folders);
    return { dirty, mark: `${String(p.rows)}:${String(p.newest)}:${String(p.lastSeq)}` };
  }

  /** One batch (see the header). Throws when the batch could not run, or its record not be written. */
  async step(): Promise<StepReport> {
    // The folder first: nothing, the record included, is written where a link stands, and a folder
    // made again holds no record to bring up to date: the tree is rebuilt.
    const made = this.#tree.prepare();
    if (this.#unsaved && !made) {
      this.#save();
      this.#tree.dropJournal();
    }
    const read = readBatch(this.#conn, this.#batch);
    this.#tree.newBatch();
    if (
      made ||
      !sameIdentity(this.#rec.identity, read.space) ||
      this.#tree.missing(this.#folders)
    ) {
      await this.#rebuild(this.#rec, read.space);
      return this.#report(read.seq, 0, true, { written: 0, removed: 0, failed: 0 }, false);
    }
    if (this.#rec.rebuilding && !this.#rec.queued) await this.#queue();
    const record = this.#rec;
    const plans = read.keys.flatMap((key) => this.#plan(read, key));
    const journalTasks = new Map(plans.map((plan) => [plan.key, plan.next]));
    this.#tree.writeJournal({ tasks: journalTasks, files: new Map() });
    await this.#at?.("journal");
    const counts = { written: 0, removed: 0, failed: 0 };
    let code: string | undefined;
    let published = false;
    let lost: boolean;
    let watermark: number;
    let unsaved: Error | undefined;
    try {
      const done = read.keys.filter((key) => !plans.some((plan) => plan.key === key));
      for (const plan of plans) {
        try {
          await this.#apply(plan, counts);
          done.push(plan.key);
        } catch (error) {
          counts.failed += 1;
          code ??= codeOf(error);
        }
      }
      // A folder the batch found missing or not real, where the record has files it did not place
      // now: those files are gone, so no catalogue may name them. The tree is rebuilt instead.
      const placed = new Set(plans.flatMap((plan) => (plan.next === null ? [] : [plan.next.path])));
      lost = [...record.tasks.values()].some(
        ({ path }) =>
          !placed.has(path) &&
          [...this.#tree.lostFolders].some((folder) => path.startsWith(`${folder}/`)),
      );
      watermark = await this.#writer.projected({ seq: read.seq, keys: done });
      await this.#at?.("reported");
      const backlog = watermark < read.seq;
      if (record.rebuilding && !backlog) {
        record.rebuilding = false;
        record.queued = false;
      }
      if (
        !lost &&
        !record.rebuilding &&
        watermark >= record.watermark &&
        (read.all || done.length > 0 || watermark > record.watermark || record.retired.size > 0)
      ) {
        const outcome = await this.#publish(read, watermark, journalTasks);
        counts.removed = outcome.removed;
        counts.failed += outcome.failed;
        code ??= outcome.code;
        published = true;
      }
    } finally {
      // Whatever happened is what the record says now. A kill skips this: start() plays the journal.
      try {
        this.#save();
      } catch (error) {
        // The journal stays: the next start plays it forward, and the next batch writes the record
        // first. The batch fails, so the loop pauses.
        unsaved = new ProjectionError(codeOf(error), "The projection's record was not written");
      }
      if (unsaved === undefined) {
        await this.#at?.("record");
        try {
          this.#tree.dropJournal();
        } catch {
          // The record is written: the next batch's journal replaces this one.
        }
      }
    }
    if (unsaved !== undefined) throw unsaved;
    this.#useFolders(foldersOf(record));
    if (lost) {
      await this.#rebuild(record, read.space);
      return this.#report(read.seq, watermark, true, counts, false, code);
    }
    if (published && read.all) {
      await this.#writer.projected({ seq: read.seq, keys: [PROJECTION_ALL] });
    }
    return this.#report(read.seq, watermark, record.rebuilding, counts, published, code);
  }

  #report(
    seq: number,
    watermark: number,
    rebuilding: boolean,
    counts: { written: number; removed: number; failed: number },
    published: boolean,
    code?: string,
  ): StepReport {
    const rescued = this.#tree.rescued;
    return {
      seq,
      watermark,
      backlog: watermark < seq,
      ...counts,
      ...(code === undefined ? {} : { code }),
      rescued: rescued.files,
      ...(rescued.folder === undefined ? {} : { rescuedFolder: rescued.folder }),
      published,
      rebuilding,
    };
  }

  /** What one dirty key asks for: nothing when it has no file and gets none. */
  #plan(read: BatchRead, key: string): Plan[] {
    const old = this.#rec.tasks.get(key);
    const task = read.tasks.get(key);
    if (task === undefined) return old === undefined ? [] : [{ key, old, next: null, content: "" }];
    const rendered = renderTask(read.space, task, this.#timeZone);
    const next = { path: rendered.path, sha256: sha256(rendered.content), entry: rendered.entry };
    return [{ key, old, next, content: rendered.content }];
  }

  /**
   * Places a task's file. The file it replaces at another path is retired, not removed: the
   * catalogue on disk still names it until the next publish, which removes it after the new
   * catalogue is in place, so a path the catalogue names exists at every moment. Throws when the
   * new file is not placed.
   */
  async #apply(plan: Plan, counts: { written: number }): Promise<void> {
    const record = this.#rec;
    const { old, next } = plan;
    if (next !== null) {
      const ours = (hash: string): boolean =>
        (old?.path === next.path && old.sha256 === hash) || record.retired.get(next.path) === hash;
      if ((await this.#tree.place(next.path, plan.content, ours)) === "written")
        counts.written += 1;
      record.retired.delete(next.path);
      record.tasks.set(plan.key, next);
    } else {
      record.tasks.delete(plan.key);
    }
    if (old !== undefined && old.path !== next?.path) record.retired.set(old.path, old.sha256);
  }

  /**
   * The root files, from the record's catalogue lines, with the watermark, then the retired files
   * the new catalogue no longer names (see the header). Returns the files removed, and the retired
   * files that could not be: they stay retired, and the next publish tries again.
   */
  async #publish(
    read: BatchRead,
    watermark: number,
    journalTasks: ReadonlyMap<string, TaskRecord | null>,
  ): Promise<{ removed: number; failed: number; code?: string }> {
    const record = this.#rec;
    const entries = [...record.tasks.values()].map((task) => task.entry);
    const mark: Watermark = {
      ...record.identity,
      seq: watermark,
      generatedAt: new Date(this.#now()).toISOString(),
    };
    const contents: [string, string][] = [
      ["README.md", README_TEXT],
      ["index.md", indexText(entries, read.groups)],
      ["catalog.jsonl", catalogText(mark, entries)],
      [".projection.json", projectionJson(mark)],
    ];
    const files = new Map(contents.map(([path, content]) => [path, sha256(content)]));
    this.#tree.writeJournal({ tasks: journalTasks, files });
    for (const [path, content] of contents) {
      await this.#tree.place(
        path,
        content,
        (hash) => record.files.get(path) === hash || record.retired.get(path) === hash,
      );
      record.files.set(path, files.get(path) ?? "");
      record.retired.delete(path);
    }
    record.watermark = watermark;
    let removed = 0;
    let failed = 0;
    let code: string | undefined;
    const used = new Set([...record.tasks.values()].map((task) => task.path));
    for (const [path, hash] of [...record.retired]) {
      if (used.has(path) || record.files.has(path)) {
        record.retired.delete(path);
        continue;
      }
      try {
        if (this.#tree.remove(path, (found) => found === hash) === "removed") removed += 1;
        record.retired.delete(path);
      } catch (error) {
        // Kept for the next publish, which pending() asks for.
        failed += 1;
        code ??= codeOf(error);
      }
    }
    return { removed, failed, ...(code === undefined ? {} : { code }) };
  }
}
