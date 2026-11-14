// The projection's consumer of the outbox (A1 3.13 "Regeneration"): one batch at a time, from a
// reader connection of the space and through the space's writer, which alone writes the outbox.
//
// A batch, in this order:
// 1. One read transaction at snapshot T (read.ts): up to 200 dirty tasks, oldest `first_seq`
//    first, with what the projection shows of each.
// 2. Each task is rendered (render.ts). The journal records every file the batch is about to place
//    or remove, then the files change (tree.ts): placed read-only by a rename, the old path removed
//    when the task moved, a file that is not the projection's own rescued first.
// 3. The writer marks the tasks whose files are all in place (write/outbox.ts) and answers the
//    watermark W: only through a fully rendered prefix. A task that failed keeps its row, so W stays
//    below it, and the next batch takes it first.
// 4. Unless a rebuild runs, the root files are written from the record's catalogue lines, which are
//    exactly what was rendered, so the catalogue names only paths that exist: README.md, index.md,
//    catalog.jsonl and, last, .projection.json, both headers with seq W. W never moves backwards.
// 5. The record is written and the journal dropped. Then `*` is reported, when it was dirty.
//
// A kill anywhere leaves at most temporary files (removed at start) and a journal. At start the
// journal is played forward against what is on disk: a file that reached its place is taken into
// the record, and the old path it replaced is retired; a removal the batch decided is finished.
// Then the outbox, which the writer marked only for tasks whose files were all in place, renders
// the rest. So a kill never makes the projection rescue its own files, never loses a person's file,
// and never moves W past an unrendered commit.
//
// A full rebuild (no record, a record of another space, epoch, incarnation or format) removes
// `.projection.json` first, so the folder claims nothing, queues every task through the writer and
// renders them as batches like any other. The old tree's files are retired: each is removed when it
// still holds what was written, rescued otherwise, once the rebuild ends. It runs in place, not in
// a `view.new/` beside the folder, because `projection.dir` may be a folder the person chose.
import { isAbsolute, join, relative, resolve } from "node:path";
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
 * The projection's folder: the space's `view/`, or the machine-local `projection.dir` (A1 3.13).
 * That one must be an absolute path outside the space's folder that does not contain it, so the
 * projection never writes among the space's own files. Throws EINVAL otherwise.
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
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (within(space, target)) {
    throw new ProjectionError("EINVAL", "projection.dir holds the space's folder");
  }
  if (within(target, space) && fold(target) !== fold(view)) {
    throw new ProjectionError("EINVAL", "projection.dir is inside the space's folder");
  }
  return target;
}

const sameIdentity = (a: SpaceIdentity, b: SpaceIdentity): boolean =>
  a.spaceId === b.spaceId && a.epoch === b.epoch && a.incarnation === b.incarnation;

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
    if (this.#record === undefined) throw new ProjectionError("EINVAL", "The projector has not started");
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
    if (found !== undefined && found !== null && journal !== undefined) {
      this.#recover(found, journal);
      this.#tree.writeRecord(found);
      recovered = true;
    }
    this.#tree.dropJournal();
    const pending = readPending(this.#conn);
    const rebuild =
      found === undefined ||
      found === null ||
      !sameIdentity(found.identity, pending) ||
      found.watermark > pending.lastSeq;
    if (rebuild) await this.#rebuild(found ?? undefined, pending);
    else {
      this.#record = found;
      if (found.rebuilding && !found.queued) await this.#queue();
    }
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
        if (old === undefined) continue;
        try {
          this.#tree.remove(old.path, (hash) => hash === old.sha256);
        } catch {
          record.retired.set(old.path, old.sha256);
        }
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
    // First the claim goes, so a reader never trusts the old tree's watermark for the new one.
    const claim = ".projection.json";
    this.#tree.remove(claim, (hash) => record.retired.get(claim) === hash);
    record.retired.delete(claim);
    this.#record = record;
    this.#tree.writeRecord(record);
    await this.#queue();
  }

  async #queue(): Promise<void> {
    await this.#writer.queueProjection();
    this.#rec.queued = true;
    this.#tree.writeRecord(this.#rec);
  }

  /** Whether a batch has work, and a mark that changes whenever the outbox or the space does. */
  pending(): { dirty: boolean; mark: string } {
    const p = readPending(this.#conn);
    const record = this.#rec;
    const dirty =
      !sameIdentity(record.identity, p) ||
      record.rebuilding ||
      p.rows > 0 ||
      p.lastSeq > record.watermark;
    return { dirty, mark: `${String(p.rows)}:${String(p.newest)}:${String(p.lastSeq)}` };
  }

  /** One batch (see the header). Throws only when the batch could not run at all. */
  async step(): Promise<StepReport> {
    const read = readBatch(this.#conn, this.#batch);
    this.#tree.newBatch();
    if (!sameIdentity(this.#rec.identity, read.space)) {
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
    let watermark: number;
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
      watermark = await this.#writer.projected({ seq: read.seq, keys: done });
      await this.#at?.("reported");
      const backlog = watermark < read.seq;
      if (record.rebuilding && !backlog) {
        record.rebuilding = false;
        record.queued = false;
      }
      if (
        !record.rebuilding &&
        watermark >= record.watermark &&
        (read.all || done.length > 0 || watermark > record.watermark)
      ) {
        await this.#publish(read, watermark, journalTasks);
        published = true;
      }
    } finally {
      // Whatever happened is what the record says now. A kill skips this: start() plays the journal.
      try {
        this.#tree.writeRecord(record);
        await this.#at?.("record");
        this.#tree.dropJournal();
      } catch {
        // The journal stays, and the next start plays it forward.
      }
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

  /** Places a task's file and removes the one it replaces. Throws when the new file is not placed. */
  async #apply(
    plan: Plan,
    counts: { written: number; removed: number },
  ): Promise<void> {
    const record = this.#rec;
    const { old, next } = plan;
    if (next !== null) {
      const ours = (hash: string): boolean =>
        (old?.path === next.path && old.sha256 === hash) || record.retired.get(next.path) === hash;
      if ((await this.#tree.place(next.path, plan.content, ours)) === "written") counts.written += 1;
      record.retired.delete(next.path);
      record.tasks.set(plan.key, next);
    } else {
      record.tasks.delete(plan.key);
    }
    if (old !== undefined && old.path !== next?.path) {
      try {
        if (this.#tree.remove(old.path, (hash) => hash === old.sha256) === "removed") {
          counts.removed += 1;
        }
      } catch {
        // Its catalogue line is gone; the file goes at a later publish (retired).
        record.retired.set(old.path, old.sha256);
      }
    }
  }

  /** The root files, from the record's catalogue lines, with the watermark (see the header). */
  async #publish(
    read: BatchRead,
    watermark: number,
    journalTasks: ReadonlyMap<string, TaskRecord | null>,
  ): Promise<void> {
    const record = this.#rec;
    const used = new Set([...record.tasks.values()].map((task) => task.path));
    for (const [path, hash] of [...record.retired]) {
      if (used.has(path) || record.files.has(path)) {
        record.retired.delete(path);
        continue;
      }
      try {
        this.#tree.remove(path, (found) => found === hash);
        record.retired.delete(path);
      } catch {
        // Kept for a later publish.
      }
    }
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
  }
}
