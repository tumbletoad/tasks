// The projection's consumer of the outbox (A1 3.13 "Regeneration"): one batch at a time, from a
// reader connection of the space and through the space's writer, which alone writes the outbox.
// What the projection placed, and the journal of the batch in progress, are its trusted state in
// the product's machine state (state.ts), never in the tree.
//
// A batch, in this order:
// 1. One read transaction at snapshot T (read.ts): up to 200 dirty tasks, oldest `first_seq`
//    first, none that waits its pause, with what the projection shows of each. Each is rendered
//    (render.ts).
// 2. The journal names every temporary file and every file the batch is about to place. Then each
//    task's file is placed (tree.ts, rule 6). A task whose file could not be placed keeps its old
//    file and line, stays queued and waits a pause of its own (RETRY_FIRST_MS doubling up to
//    RETRY_MAX_MS) before a batch reads it again: it never stops the tasks after it.
// 3. The writer marks the tasks whose files are in place (write/outbox.ts) and answers the
//    watermark W: only through a fully rendered prefix (rule 7).
// 4. When the batch took every dirty task it could read (fewer than 200), or W moved: the root
//    files, from the record's catalogue lines, which are exactly what was placed: README.md,
//    index.md, catalog.jsonl and, last, .projection.json, both headers with the larger of W and
//    the watermark last published, so it never moves backwards. The journal names them first. Only
//    once all four are placed do the retired files go, each only by the proof of ownership: the
//    catalogue that no longer names them is in place.
// 5. The rescues not told yet are told (rule 3), the record is written, then the journal dropped;
//    then `*` is reported, when it was dirty.
//
// **Unknown is never nothing** (rule 1): a record or a journal that is there and does not read back
// whole starts like a missing record, with every task queued: only a file that is not there means
// that nothing is pending.
//
// **Rescues are told from their folders**: every real `exchange/rescued/<stem>-<n>` with a `view`
// in it is a rescue, whatever the trusted state says. The record keeps the stems told; a stem not
// in it is told at the next start and after every batch that rescued or could not tell, until the
// receiver returns. So a failure tells again, never less.
//
// **Reconciliation** (rule 5), file by file: at start, after a batch with a failure or one that
// found a folder of the tree missing or not real, and when asked (`tasks view rebuild`, which also
// queues every task). Each file of the record is looked at on disk: a task's file that is missing,
// or whose size or hash differs, is queued for rendering again (through the writer, from commit 1,
// so the watermark the writer answers stays below it); a root file so is placed again at the next
// publish; a retired file that is gone or no longer ours is forgotten, never touched again. A file
// on disk the record does not hold is left alone.
//
// **Evidence goes last** (A1 3.13): the journal is dropped, and a record that no longer says why
// something must still happen is written, only once what depends on it is durable elsewhere: the
// writer's outbox for tasks to render again, the receiver's answer for a stem told. A kill in
// between finds the evidence and does the work again; each is safe to repeat.
//
// **A kill** leaves temporary files and the journal. The next start plays the journal forward: a
// file that reached its place with the journal's bytes goes into the record; a task whose file is
// not there as the journal meant it, or that the batch found gone, is queued again, since the writer
// may have marked it rendered.
// Then it removes the temporary files (tree.ts, rule 4), writes the record, drops the journal and
// reconciles. A record that is missing or does not read back whole, or of another format, starts
// the reconciliation from scratch with every task queued: nothing is deleted on its word. The
// record and journal are this folder's alone (the service keys them by folder), so one made for
// another identity of the space (a restore in place, a claim) still says what was placed in this
// `view/`: its files stay the proof, by their bytes, and every task is queued with W from 0.
import type { Connection, ProjectedBatch } from "@tasks/storage";
import { PROJECTION_ALL, PROJECTION_BATCH, PROJECTION_QUEUE_KEYS } from "@tasks/storage";
import { missingTasks, readBatch, readPending, type BatchRead } from "./read.ts";
import {
  catalogText,
  indexText,
  projectionJson,
  README_TEXT,
  renderTask,
  type CatalogEntry,
  type SpaceIdentity,
  type Watermark,
} from "./render.ts";
import {
  newRecord,
  TrustedState,
  type Placing,
  type StateFile,
  type TrustedRecord,
} from "./state.ts";
import {
  codeOf,
  newStem,
  newTag,
  ProjectionError,
  Rescues,
  sha256,
  tempPathOf,
  Tree,
  type Hook,
} from "./tree.ts";

/** What the projection needs of the space's writer (storage's SpaceWriterHandle has both). */
export interface ProjectionWriter {
  projected(batch: ProjectedBatch): Promise<number>;
  queueProjection(keys?: readonly string[]): Promise<number>;
}

export interface ProjectorOptions {
  /** A reader connection of the space. The projector never writes through it. */
  readonly conn: Connection;
  readonly spaceFolder: string;
  /** The tree's root: the space's `view/` (tests render a fresh tree elsewhere). */
  readonly dir: string;
  /** The trusted record's file, in the product's machine state (state.ts). */
  readonly record: string;
  /** The trusted journal's file, beside it. */
  readonly journal: string;
  readonly writer: ProjectionWriter;
  /** Default: this machine's. Dates and the year folders follow it. */
  readonly timeZone?: string;
  readonly now?: () => number;
  /** Tasks per batch. Default: A1's 200. */
  readonly batch?: number;
  /** Tests only: runs before every act on disk; throwing is a kill (tree.ts). */
  readonly at?: Hook;
  readonly platform?: NodeJS.Platform;
  /** Each reconciliation, as soon as it has run: `tasks view rebuild` is answered by a full one. */
  readonly onReconciled?: (reconciled: Reconciled) => void;
  /**
   * Each batch's rescues (rule 3), for the record of rescues the UI shows (A1 3.13): once per stem
   * of the rescue folders on disk, told at least once. The rescue folders are the evidence: a stem
   * whose telling throws or rejects stays untold and is told again at the next batch and the next
   * start, and one told is kept in the record only once the receiver returned, so the receiver
   * returns only once the rescue is saved, and keeps one entry per stem.
   */
  readonly onRescued?: (rescue: Rescued) => void | Promise<void>;
  /**
   * Something that was not a file at the record's or the journal's path, a folder or a link a
   * person left there, was moved aside beside it, once (state.ts), for the log.
   */
  readonly onAside?: (file: StateFile) => void;
}

/** Entries one batch moved aside: each in a folder `<stem>-<n>` (relative to the space's folder). */
export interface Rescued {
  readonly stem: string;
  readonly files: number;
}

/** What one reconciliation found. Counts only. */
export interface Reconciled {
  /** Every task was queued too: a full rebuild. */
  readonly full: boolean;
  /** Files of the record looked at. */
  readonly checked: number;
  /** Tasks queued for rendering again (every task for a full one). */
  readonly queued: number;
  /** Retired files that were gone or no longer the projection's, forgotten. */
  readonly forgotten: number;
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
  /** Files that could not be placed or removed: their tasks wait, or they are tried again. */
  readonly failed: number;
  /**
   * Of those, tasks' files that could not be placed: each task waits a pause of its own (rule 7),
   * so they never pause the worker. Any other failure does (loop.ts).
   */
  readonly blocked: number;
  /** The code of the first failure. */
  readonly code?: string;
  /** Entries rescued: each in a folder `<rescueStem>-<n>` (relative to the space's folder). */
  readonly rescued: number;
  readonly rescueStem?: string;
  readonly published: boolean;
  /** A reconciliation that ran before the batch. */
  readonly reconciled?: Reconciled;
}

export interface StartReport {
  /** Every task was queued: no record, or one of another identity or format. */
  readonly rebuild: boolean;
  /** Temporary files a kill left, removed. */
  readonly temps: number;
  /** A journal a kill left was played forward. */
  readonly recovered: boolean;
  /** Entries of rescue folders this start told: rescues a batch made and had not told (rule 3). */
  readonly rescued: number;
  readonly reconciled: Reconciled;
}

/**
 * A1 3.13 rule 7: a task whose file could not be placed waits a pause of its own before it is read
 * again, doubling from this up to RETRY_MAX_MS, so tasks that cannot be placed never fill every
 * batch. A full reconciliation (`tasks view rebuild`) ends every pause.
 */
export const RETRY_FIRST_MS = 500;
export const RETRY_MAX_MS = 30_000;

const sameIdentity = (a: SpaceIdentity, b: SpaceIdentity): boolean =>
  a.spaceId === b.spaceId && a.epoch === b.epoch && a.incarnation === b.incarnation;

const identityOf = (s: SpaceIdentity): SpaceIdentity => ({
  spaceId: s.spaceId,
  epoch: s.epoch,
  incarnation: s.incarnation,
});

/** One task's work in a batch: its new file and line, or null when it has none any more. */
interface Plan {
  readonly key: string;
  readonly next: (Placing & { readonly path: string; readonly entry: CatalogEntry }) | null;
  readonly content: string;
}

export class Projector {
  readonly #conn: Connection;
  readonly #writer: ProjectionWriter;
  readonly #tree: Tree;
  readonly #state: TrustedState;
  readonly #timeZone: string;
  readonly #now: () => number;
  readonly #batch: number;
  readonly #onReconciled: ProjectorOptions["onReconciled"];
  readonly #onRescued: ProjectorOptions["onRescued"];
  #record: TrustedRecord | undefined;
  /** The record on disk is behind this one: it is written before anything else. */
  #unsaved = false;
  /** A reconciliation the next step runs first: of the record's files, or full. */
  #reconcile: "none" | "files" | "full" = "none";
  /** A root file was found missing or different: the next batch publishes. */
  #republish = false;
  /** Files of the record that no task's line and no root file names any more. */
  #retired = new Set<string>();
  /** A telling of rescues failed: the next batch tells again, rescued or not (rule 3). */
  #untold = false;
  /** Tasks whose file could not be placed: read again once `until` has passed (rule 7). */
  readonly #waiting = new Map<string, { until: number; pause: number }>();

  constructor(options: ProjectorOptions) {
    this.#conn = options.conn;
    this.#writer = options.writer;
    this.#timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.#now = options.now ?? Date.now;
    this.#batch = options.batch ?? PROJECTION_BATCH;
    this.#onReconciled = options.onReconciled;
    this.#onRescued = options.onRescued;
    if (!Number.isSafeInteger(this.#batch) || this.#batch < 1 || this.#batch > PROJECTION_BATCH) {
      throw new ProjectionError("EINVAL", "A batch holds 1 to 200 tasks");
    }
    this.#tree = new Tree({
      spaceFolder: options.spaceFolder,
      dir: options.dir,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.at === undefined ? {} : { at: options.at }),
    });
    this.#state = new TrustedState({
      record: options.record,
      journal: options.journal,
      now: this.#now,
      ...(options.at === undefined ? {} : { at: options.at }),
      ...(options.onAside === undefined ? {} : { onAside: options.onAside }),
    });
  }

  get #rec(): TrustedRecord {
    if (this.#record === undefined) {
      throw new ProjectionError("EINVAL", "The projector has not started");
    }
    return this.#record;
  }

  /** Asks for a full rebuild (`tasks view rebuild`): the next step reconciles with every task queued. */
  rebuild(): void {
    this.#reconcile = "full";
  }

  /**
   * Makes the projection ready (see the header): plays a kill's journal forward, removes its
   * temporary files, and reconciles the record with the disk.
   */
  async start(): Promise<StartReport> {
    this.#state.prepare();
    const journalRead = this.#state.readJournal();
    const recordRead = this.#state.readRecord();
    const journal = journalRead.kind === "read" ? journalRead.value : undefined;
    const found = recordRead.kind === "read" ? recordRead.value : undefined;
    const pending = readPending(this.#conn);
    const record = found ?? newRecord(identityOf(pending));
    let recovered = false;
    /** Tasks of the killed batch whose outcome the record may not hold: queued again. */
    const unverified = new Set<string>();
    if (found !== undefined && journal !== undefined) {
      for (const [path, placing] of journal.placing) {
        const look = this.#tree.look(path, undefined, placing.size);
        if (
          look.kind !== "file" ||
          look.links !== 1 ||
          look.size !== placing.size ||
          look.sha256 !== placing.sha256
        ) {
          if (placing.task !== undefined) unverified.add(placing.task);
          continue;
        }
        record.files.set(path, {
          sha256: placing.sha256,
          size: placing.size,
          ...(placing.task === undefined ? {} : { task: placing.task }),
        });
        if (placing.task !== undefined && placing.entry !== undefined) {
          record.entries.set(placing.task, placing.entry);
        }
        if (path === ".projection.json" && journal.watermark !== undefined) {
          record.watermark = Math.max(record.watermark, journal.watermark);
        }
      }
      // A task the batch found gone may be marked rendered while the record still has its line.
      for (const id of journal.gone) unverified.add(id);
      recovered = true;
    }
    const temps = this.#tree.cleanTemps(journal?.temps ?? []);
    // Unknown is never nothing (rule 1): a record or a journal that is there and does not read
    // back whole may hide what a batch did (a task it found gone, a file it placed), so every task
    // is rendered again, and the record's files still prove nothing but by their bytes.
    let full = found === undefined || journalRead.kind === "unreadable";
    const other = !sameIdentity(record.identity, pending) || record.watermark > pending.lastSeq;
    if (other) full = true;
    // Before the record that no longer says why: a kill after it must find every task queued.
    if (full) await this.#queueAll(record);
    record.identity = identityOf(pending);
    // The writer's W holds back until every queued task is rendered; the claim last published
    // stays the record's, which has none without a record of this identity.
    if (other) record.watermark = 0;
    this.#record = record;
    this.#republish = false;
    // Rescues a batch made and could not tell (a kill, a failed telling): before the record that
    // keeps the stems told, so a kill in between tells them again (rule 3).
    const rescued = await this.#tell();
    this.#save();
    // The writer may have marked them rendered before the kill: they are queued again, so the
    // watermark never covers a task whose file is not on disk and in the record (rule 7).
    await this.#queue([...unverified]);
    // Only now: until the record is written and they are queued, the journal is what a next start
    // plays.
    this.#state.dropJournal();
    const reconciled = await this.#reconcileNow(full);
    return { rebuild: full, temps, recovered, rescued, reconciled };
  }

  /**
   * Looks at every file of the record on disk (see the header) and queues what is missing or
   * different; `full` queues every task too, and the tasks the record names that the space no
   * longer has, so their files retire.
   */
  async #reconcileNow(full: boolean): Promise<Reconciled> {
    const record = this.#rec;
    const folders = new Map<string, boolean>();
    const queue = new Set<string>();
    let checked = 0;
    let forgotten = 0;
    for (const [path, file] of [...record.files]) {
      checked += 1;
      const look = this.#tree.look(path, folders, file.size);
      if (
        look.kind === "file" &&
        look.links === 1 &&
        look.size === file.size &&
        look.sha256 === file.sha256
      ) {
        continue;
      }
      if (file.task === undefined) this.#republish = true;
      else if (record.entries.get(file.task)?.path === path) queue.add(file.task);
      else if (look.kind === "busy") {
        // Retired and held open: likely still ours, so it stays retired and its removal is tried
        // again. Forgotten, it would stay in the folder for good.
        continue;
      } else {
        // Retired, and gone or no longer ours: never touched again.
        record.files.delete(path);
        forgotten += 1;
      }
    }
    this.#countRetired();
    if (forgotten > 0) this.#save();
    let queued = 0;
    if (full) {
      queued += await this.#queueAll(record);
      queue.clear();
    }
    queued += await this.#queue([...queue]);
    const reconciled = { full, checked, queued, forgotten };
    this.#onReconciled?.(reconciled);
    return reconciled;
  }

  /**
   * A full rebuild's queue, through the writer, whose outbox is durable: every task, and the tasks
   * `record` names that the space no longer has, so their files retire. It goes before any record
   * that would no longer say why (a new one, another identity's), so a kill in between finds every
   * task still queued. Every task's pause ends too: a person who fixed what blocked a task need not
   * wait for it.
   */
  async #queueAll(record: TrustedRecord): Promise<number> {
    this.#waiting.clear();
    const all = await this.#writer.queueProjection();
    return all + (await this.#queue(missingTasks(this.#conn, [...record.entries.keys()])));
  }

  /** Queues `ids` for rendering again through the writer, in parts. Returns how many it queued. */
  async #queue(ids: readonly string[]): Promise<number> {
    let queued = 0;
    for (let i = 0; i < ids.length; i += PROJECTION_QUEUE_KEYS) {
      queued += await this.#writer.queueProjection(ids.slice(i, i + PROJECTION_QUEUE_KEYS));
    }
    return queued;
  }

  /** Recounts the retired files: those of a task whose line names another path, or of no task. */
  #countRetired(): void {
    const record = this.#rec;
    this.#retired = new Set(
      [...record.files]
        .filter(
          ([path, file]) => file.task !== undefined && record.entries.get(file.task)?.path !== path,
        )
        .map(([path]) => path),
    );
  }

  /** Writes the record. One that cannot be written leaves the projector unsaved (see the header). */
  #save(): void {
    this.#unsaved = true;
    this.#state.writeRecord(this.#rec);
    this.#unsaved = false;
  }

  /**
   * Whether a batch has work, and a mark that changes whenever the outbox or the space does. Work
   * is also a record not yet written, a reconciliation asked for, a root file to place again, and a
   * retired file still there.
   */
  pending(): { dirty: boolean; mark: string } {
    const p = readPending(this.#conn, this.#waitingNow());
    const record = this.#rec;
    const dirty =
      this.#unsaved ||
      this.#reconcile !== "none" ||
      this.#republish ||
      !sameIdentity(record.identity, p) ||
      p.rows > 0 ||
      // A task waiting its pause holds W below it: no batch could move it until the pause ends.
      (p.held === 0 && p.lastSeq > record.watermark) ||
      this.#retired.size > 0;
    return { dirty, mark: `${String(p.rows)}:${String(p.newest)}:${String(p.lastSeq)}` };
  }

  /**
   * One batch (see the header). Throws when it could not run, or its record not be written. A batch
   * that failed, thrown or counted, has the next one reconcile first (rule 5).
   */
  async step(): Promise<StepReport> {
    try {
      return await this.#step();
    } catch (error) {
      if (this.#reconcile === "none") this.#reconcile = "files";
      throw error;
    }
  }

  async #step(): Promise<StepReport> {
    // A record the last batch could not write goes first: no journal replaces the one it covers.
    if (this.#unsaved) {
      this.#save();
      this.#state.dropJournal();
    }
    let reconciled: Reconciled | undefined;
    const asked = this.#reconcile;
    if (asked !== "none") {
      reconciled = await this.#reconcileNow(asked === "full");
      // Only once it ran: one cut off by a failure is tried again, and a rebuild asked for while it
      // ran stays asked for.
      if (this.#reconcile === asked) this.#reconcile = "none";
    }
    // Tasks that failed before: those still in their pause are not read, the others only after
    // every task that did not fail, so tasks that cannot be placed never fill a batch (rule 7).
    const waiting = this.#waitingNow();
    const retried = new Set(this.#waiting.keys());
    const read = readBatch(this.#conn, this.#batch, waiting, [...retried]);
    const record = this.#rec;
    const rescues = new Rescues(newStem(this.#now()));
    if (!sameIdentity(record.identity, read.space)) {
      // Another identity of the space (a restore, a claim): every task again, queued before the
      // record that no longer says why. Nothing is removed on its word.
      await this.#queueAll(record);
      record.identity = identityOf(read.space);
      record.watermark = 0;
      this.#save();
      reconciled = await this.#reconcileNow(true);
      return this.#report(
        read.seq,
        0,
        { written: 0, removed: 0, failed: 0, blocked: 0 },
        rescues,
        false,
        reconciled,
      );
    }
    this.#tree.newBatch();
    const tag = newTag();
    const plans = read.keys.flatMap((key) => this.#plan(read, key));
    const placing = new Map<string, Placing>();
    const temps: string[] = [];
    const gone: string[] = [];
    for (const plan of plans) {
      if (plan.next === null) {
        gone.push(plan.key);
        continue;
      }
      placing.set(plan.next.path, plan.next);
      temps.push(tempPathOf(plan.next.path, plan.next.sha256, tag));
    }
    this.#state.writeJournal({ temps, placing, gone });
    const counts = { written: 0, removed: 0, failed: 0, blocked: 0 };
    let code: string | undefined;
    let published = false;
    let watermark: number;
    let unsaved: Error | undefined;
    try {
      const planned = new Set(plans.map((plan) => plan.key));
      const done = read.keys.filter((key) => !planned.has(key));
      for (const plan of plans) {
        if (plan.next === null) {
          // Gone at T: its line goes now, its file after the next publish.
          this.#retire(plan.key);
          done.push(plan.key);
          continue;
        }
        const next = plan.next;
        try {
          const placed = this.#tree.place(
            next.path,
            plan.content,
            record.files.get(next.path),
            rescues,
            tag,
          );
          if (placed === "written") counts.written += 1;
          this.#retire(plan.key);
          record.files.set(next.path, { sha256: next.sha256, size: next.size, task: plan.key });
          record.entries.set(plan.key, next.entry);
          this.#retired.delete(next.path);
          done.push(plan.key);
        } catch (error) {
          counts.failed += 1;
          counts.blocked += 1;
          code ??= codeOf(error);
          this.#wait(plan.key);
        }
      }
      for (const key of done) this.#waiting.delete(key);
      watermark = await this.#writer.projected({ seq: read.seq, keys: done });
      // Every task it could read: fewer than a batch, or room left for a task that failed before.
      const drained = read.keys.length < this.#batch || read.keys.some((key) => retried.has(key));
      const moved = watermark > record.watermark;
      if (
        (drained || moved) &&
        (moved || done.length > 0 || read.all || this.#republish || this.#retired.size > 0)
      ) {
        const outcome = this.#publish(read, Math.max(watermark, record.watermark), {
          rescues,
          tag,
          temps,
          placing,
          gone,
        });
        counts.removed = outcome.removed;
        counts.failed += outcome.failed;
        code ??= outcome.code;
        published = outcome.published;
      }
    } finally {
      // What the batch moved aside, also when it failed: its rescue folders hold it either way.
      // Before the record, which keeps the stems told (rule 3).
      if (rescues.made.length > 0 || this.#untold) await this.#tell();
      // Whatever happened is what the record says now. A kill skips this: start() plays the journal.
      try {
        this.#save();
      } catch (error) {
        // The journal stays, and the next batch writes the record before anything else.
        unsaved = new ProjectionError(codeOf(error), "The projection's record was not written");
      }
      if (unsaved === undefined) {
        try {
          this.#state.dropJournal();
        } catch {
          // The record holds what it says: the next batch's journal replaces this one.
        }
      }
    }
    if (unsaved !== undefined) throw unsaved;
    // Never over a rebuild asked for while the batch waited on the writer: it stays a full one.
    if ((counts.failed > 0 || this.#tree.troubled) && this.#reconcile === "none") {
      this.#reconcile = "files";
    }
    if (published && read.all) {
      await this.#writer.projected({ seq: read.seq, keys: [PROJECTION_ALL] });
    }
    return this.#report(read.seq, watermark, counts, rescues, published, reconciled, code);
  }

  /** The tasks still waiting their pause now. */
  #waitingNow(): string[] {
    const now = this.#now();
    return [...this.#waiting].filter(([, wait]) => wait.until > now).map(([key]) => key);
  }

  /** `key`'s file could not be placed: it waits a pause twice its last, from RETRY_FIRST_MS. */
  #wait(key: string): void {
    const before = this.#waiting.get(key);
    const pause = before === undefined ? RETRY_FIRST_MS : Math.min(RETRY_MAX_MS, before.pause * 2);
    this.#waiting.set(key, { until: this.#now() + pause, pause });
  }

  /**
   * Tells onRescued of each rescue folder's stem on disk that the record has not told (rule 3),
   * oldest first, and forgets the told stems whose folders are gone. The folders are the evidence:
   * a stem is told until a telling succeeds, and one that fails is told again at the next batch and
   * the next start. Never throws. Returns how many entries it told.
   */
  async #tell(): Promise<number> {
    const record = this.#rec;
    let found: Map<string, number>;
    try {
      found = this.#tree.rescueFolders();
    } catch {
      this.#untold = true;
      return 0;
    }
    for (const stem of record.told) if (!found.has(stem)) record.told.delete(stem);
    let told = 0;
    for (const [stem, files] of found) {
      if (record.told.has(stem)) continue;
      try {
        await this.#onRescued?.({ stem: `exchange/rescued/${stem}`, files });
      } catch {
        // Not recorded: the folders stay the evidence, and the next batch or start tells again.
        this.#untold = true;
        return told;
      }
      record.told.add(stem);
      told += files;
    }
    this.#untold = false;
    return told;
  }

  /** A task's line goes or moves: the file its old line named is retired, if no root file. */
  #retire(key: string): void {
    const record = this.#rec;
    const old = record.entries.get(key);
    record.entries.delete(key);
    if (old !== undefined && record.files.get(old.path)?.task === key) this.#retired.add(old.path);
  }

  #report(
    seq: number,
    watermark: number,
    counts: { written: number; removed: number; failed: number; blocked: number },
    rescues: Rescues,
    published: boolean,
    reconciled?: Reconciled,
    code?: string,
  ): StepReport {
    return {
      seq,
      watermark,
      backlog: watermark < seq,
      ...counts,
      ...(code === undefined ? {} : { code }),
      rescued: rescues.made.length,
      ...(rescues.made.length === 0 ? {} : { rescueStem: `exchange/rescued/${rescues.stem}` }),
      published,
      ...(reconciled === undefined ? {} : { reconciled }),
    };
  }

  /** What one dirty key asks for: nothing when it has no file and gets none. */
  #plan(read: BatchRead, key: string): Plan[] {
    const task = read.tasks.get(key);
    if (task === undefined) {
      return this.#rec.entries.has(key) ? [{ key, next: null, content: "" }] : [];
    }
    const rendered = renderTask(read.space, task, this.#timeZone);
    const data = Buffer.from(rendered.content, "utf8");
    return [
      {
        key,
        next: {
          path: rendered.path,
          sha256: sha256(data),
          size: data.length,
          task: key,
          entry: rendered.entry,
        },
        content: rendered.content,
      },
    ];
  }

  /**
   * The root files at watermark `seq`, from the record's catalogue lines, then the retired files
   * the new catalogue no longer names (see the header). The journal names the root files first.
   */
  #publish(
    read: BatchRead,
    seq: number,
    batch: {
      readonly rescues: Rescues;
      readonly tag: string;
      readonly temps: readonly string[];
      readonly placing: ReadonlyMap<string, Placing>;
      readonly gone: readonly string[];
    },
  ): { removed: number; failed: number; code?: string; published: boolean } {
    const record = this.#rec;
    const entries = [...record.entries.values()];
    const mark: Watermark = {
      ...record.identity,
      seq,
      generatedAt: new Date(this.#now()).toISOString(),
    };
    const contents: [string, string][] = [
      ["README.md", README_TEXT],
      ["index.md", indexText(entries, read.groups)],
      ["catalog.jsonl", catalogText(mark, entries)],
      [".projection.json", projectionJson(mark)],
    ];
    const placing = new Map(batch.placing);
    const temps = [...batch.temps];
    const sizes = new Map<string, { sha256: string; size: number }>();
    for (const [path, content] of contents) {
      const data = Buffer.from(content, "utf8");
      const file = { sha256: sha256(data), size: data.length };
      sizes.set(path, file);
      placing.set(path, file);
      temps.push(tempPathOf(path, file.sha256, batch.tag));
    }
    this.#state.writeJournal({
      temps,
      placing,
      gone: batch.gone,
      watermark: seq,
    });
    for (const [path, content] of contents) {
      try {
        this.#tree.place(path, content, record.files.get(path), batch.rescues, batch.tag);
      } catch (error) {
        // The claim comes last: it is never placed after a root file failed.
        return { removed: 0, failed: 1, code: codeOf(error), published: false };
      }
      const file = sizes.get(path);
      if (file !== undefined) record.files.set(path, file);
    }
    this.#republish = false;
    record.watermark = seq;
    let removed = 0;
    let failed = 0;
    let code: string | undefined;
    for (const path of [...this.#retired]) {
      const file = record.files.get(path);
      if (file === undefined) {
        this.#retired.delete(path);
        continue;
      }
      try {
        if (this.#tree.remove(path, file) === "removed") removed += 1;
        record.files.delete(path);
        this.#retired.delete(path);
      } catch (error) {
        // Kept for the next publish, which pending() asks for.
        failed += 1;
        code ??= codeOf(error);
      }
    }
    return { removed, failed, ...(code === undefined ? {} : { code }), published: true };
  }
}
