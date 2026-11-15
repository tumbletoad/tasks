// The live store (A5 3.15, 3.24 "a small liveStore module on useSyncExternalStore"): the one place
// in the page that holds task data. It joins the core (core.ts: snapshot, batches, cursor), the
// own writes (pending.ts: overlays until the feed confirms them) and per-frame batching
// (frame.ts), and hands every view one immutable state through a small subscription interface.
// No React here: hooks.ts puts React on top.
//
// What a frame does with the messages that came since the last one, in their order:
// - applies each through the core; a snapshot supersedes what came before it;
// - settles the own writes the applied events named or the new cursor covers;
// - publishes one new state, so listeners hear once per frame;
// - tells the views which tasks the frame touched (an expanded task refetches its thread) and
//   what changed, row by row, for paged queries (queries.ts).
import type { Instance } from "../api.ts";
import { LiveCore, type Change, type ResnapshotReason } from "./core.ts";
import { FrameQueue, type FrameClock } from "./frame.ts";
import { incarnationTag, landedOf, Pending, type Overlay, type Settled } from "./pending.ts";
import type {
  AreaRow,
  BatchMessage,
  Cursor,
  ProjectRow,
  SnapshotMessage,
  SpaceHead,
  TaskRow,
} from "./rows.ts";

export type Phase = "starting" | "connecting" | "live" | "offline" | "signed_out" | "no_space";

export interface LiveState {
  readonly phase: Phase;
  /** The service runs another build: the page offers a reload. */
  readonly stale: boolean;
  readonly space: SpaceHead | undefined;
  /** The open tasks: the confirmed rows with this tab's pending writes on top. */
  readonly tasks: ReadonlyMap<string, TaskRow>;
  readonly areas: ReadonlyMap<string, AreaRow>;
  readonly projects: ReadonlyMap<string, ProjectRow>;
  readonly instances: readonly Instance[];
}

/** What one frame touched besides rows: tasks whose thread or row changed, and launches. */
export interface Touched {
  readonly tasks: ReadonlySet<string>;
  readonly launches: boolean;
  /**
   * A snapshot replaced the working set: what changed before it is unknown, so a view of a task
   * the working set does not hold (a completed one) reads it again too.
   */
  readonly reset: boolean;
}

/**
 * What one frame changed, for paged queries. `reset` means a snapshot replaced the working set:
 * the changes before it are unknown, so every query treats itself as changed.
 */
export interface Changes {
  readonly changes: readonly Change[];
  readonly reset: boolean;
}

/** A message the store applies at the next frame. */
export type Queued =
  | SnapshotMessage
  | BatchMessage
  | { readonly type: "unreadable" }
  | { readonly type: "error"; readonly code: string };

export interface StoreOptions {
  /** The tab's space, from its route; a tab opened without one takes the first snapshot's. */
  readonly space?: string | undefined;
  readonly frames: FrameClock;
  /** The core asks for a fresh snapshot: the transport subscribes again without a cursor. */
  readonly onResnapshot: (reason: ResnapshotReason) => void;
  /** The first snapshot named the tab's space. */
  readonly onSpace?: (space: string) => void;
  /** A fresh request ID (A1 3.8). */
  readonly newRequest?: () => string;
}

/** A write sent through the store. */
export interface Sent<T> {
  readonly request: string;
  /** The service's answer, or its refusal. */
  readonly answer: Promise<T>;
  /** How the write settled: confirmed by the feed, or refused. */
  readonly settled: Promise<Settled>;
  /**
   * The commit the write made (its `op_` ID), once the feed confirmed it with an event that names
   * it. Undefined when it was refused, made no commit, or was confirmed without such an event (a
   * fresh snapshot that covers it): then the page does not know which commit is its own.
   */
  readonly commit: Promise<string | undefined>;
}

const EMPTY: Overlay = { tasks: [] };

export class LiveStore {
  readonly #options: StoreOptions;
  readonly #core: LiveCore;
  readonly #pending = new Pending();
  readonly #queue: FrameQueue<Queued>;
  readonly #listeners = new Set<() => void>();
  readonly #touchListeners = new Set<(touched: Touched) => void>();
  readonly #changeListeners = new Set<(changes: Changes) => void>();
  /** The commit IDs the feed named for own writes still pending, until each write settles. */
  readonly #commits = new Map<string, string>();
  #stopped = false;
  /** The confirmed open tasks, without overlays. */
  #confirmed: ReadonlyMap<string, TaskRow> = new Map();
  #state: LiveState = {
    phase: "starting",
    stale: false,
    space: undefined,
    tasks: new Map(),
    areas: new Map(),
    projects: new Map(),
    instances: [],
  };

  constructor(options: StoreOptions) {
    this.#options = options;
    this.#core = new LiveCore(options.space);
    this.#queue = new FrameQueue(options.frames, (items) => {
      this.#drain(items);
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getState = (): LiveState => this.#state;

  onTouched(listener: (touched: Touched) => void): () => void {
    this.#touchListeners.add(listener);
    return () => {
      this.#touchListeners.delete(listener);
    };
  }

  onChanges(listener: (changes: Changes) => void): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  /** The tab's space ID, once known. */
  get space(): string | undefined {
    return this.#core.space;
  }

  /**
   * The applied cursor as an `as_of` (A1 3.5: `epoch.seq.tag`): what the rows on screen show, and
   * so the base of an edit made from them. None before the first snapshot.
   */
  get asOf(): string | undefined {
    const cursor = this.#core.cursor;
    if (cursor === undefined) return undefined;
    return `${String(cursor.epoch)}.${String(cursor.seq)}.${incarnationTag(cursor.incarnation)}`;
  }

  /** How many own writes wait for the feed. */
  get pending(): number {
    return this.#pending.size;
  }

  /**
   * The cursor a new subscription resumes from: everything queued is applied first, so it is the
   * newest the tab has. None before the first snapshot or while a fresh one is awaited.
   */
  resumeFrom(): Cursor | undefined {
    this.#queue.flush();
    return this.#core.resumeFrom;
  }

  /** A message from the feed, applied at the next frame in arrival order. */
  push(message: Queued): void {
    if (this.#stopped) return;
    this.#queue.push(message);
  }

  /** Applies what is queued now. */
  flush(): void {
    this.#queue.flush();
  }

  /** Asks for a fresh snapshot for the transport's own reason (it subscribes without a cursor). */
  resnapshot(): void {
    this.#core.resnapshot();
  }

  /** The transport's phase and the reload bar. Heard at once, not at the next frame. */
  set(patch: { readonly phase?: Phase; readonly stale?: boolean }): void {
    if (
      (patch.phase === undefined || patch.phase === this.#state.phase) &&
      (patch.stale === undefined || patch.stale === this.#state.stale)
    ) {
      return;
    }
    this.#state = { ...this.#state, ...patch };
    this.#emit();
  }

  /** The tab stops (closed, or signed out): queued messages are dropped and no more are taken. */
  stop(): void {
    this.#stopped = true;
    this.#queue.clear();
  }

  /**
   * Sends a write: `send` makes the call with the request ID it is given. `overlay` shows at once
   * and stays until the feed confirms the write, or goes when it is refused.
   */
  write<T>(send: (request: string) => Promise<T>, overlay: Overlay = EMPTY): Sent<T> {
    const request = (this.#options.newRequest ?? (() => crypto.randomUUID()))();
    let settle!: (settled: Settled) => void;
    const settled = new Promise<Settled>((resolve) => {
      settle = resolve;
    });
    this.#pending.add(request, overlay, settle);
    if (overlay.tasks.length > 0) this.#view();
    let answer: Promise<T>;
    try {
      answer = send(request);
    } catch (error) {
      answer = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const answered = answer.then(
      (result) => {
        if (this.#pending.answered(request, landedOf(result), this.#core.cursor)) this.#view();
        return result;
      },
      (error: unknown) => {
        if (this.#pending.refused(request)) this.#view();
        throw error;
      },
    );
    const commit = settled.then((how) => {
      const id = this.#commits.get(request);
      this.#commits.delete(request);
      return how === "confirmed" ? id : undefined;
    });
    return { request, answer: answered, settled, commit };
  }

  #drain(items: readonly Queued[]): void {
    let changes: Change[] = [];
    const requests: string[] = [];
    let reset = false;
    let applied = false;
    let phase: Phase | undefined;
    const before = this.#core.space;
    for (const item of items) {
      if (item.type === "error") {
        phase = "no_space";
        continue;
      }
      const outcome = this.#core.receive(item);
      switch (outcome.kind) {
        case "snapshot":
          // What came before a snapshot is superseded by it.
          changes = [];
          reset = true;
          applied = true;
          phase = "live";
          break;
        case "applied":
          changes.push(...outcome.changes);
          requests.push(...outcome.requests);
          for (const [request, commit] of outcome.commits) {
            if (this.#pending.has(request)) this.#commits.set(request, commit);
          }
          applied = true;
          break;
        case "resnapshot":
          this.#options.onResnapshot(outcome.reason);
          break;
        case "ignored":
          break;
      }
    }
    const space = this.#core.space;
    if (space !== undefined && space !== before) this.#options.onSpace?.(space);
    // The cursor moved (a heartbeat moves only the cursor): own writes it covers settle.
    const settled = applied && this.#pending.feed(requests, this.#core.cursor);
    if (!reset && changes.length === 0 && !settled) {
      if (phase !== undefined) this.set({ phase });
      return;
    }
    const held = this.#core.publish();
    if (held !== undefined) {
      this.#confirmed = held.tasks;
      this.#state = {
        ...this.#state,
        ...(phase === undefined ? {} : { phase }),
        space: held.space,
        tasks: this.#pending.view(held.tasks),
        areas: held.areas,
        projects: held.projects,
        instances: held.instances,
      };
    }
    this.#emit();
    if (reset || changes.length > 0) {
      const touched = new Set<string>();
      let launches = reset;
      if (reset) for (const id of this.#state.tasks.keys()) touched.add(id);
      for (const change of changes) {
        if (change.task !== undefined) touched.add(change.task);
        if (change.type === "launch") launches = true;
      }
      for (const listener of this.#touchListeners) listener({ tasks: touched, launches, reset });
      for (const listener of this.#changeListeners) listener({ changes, reset });
    }
  }

  /** The pending overlays changed: the tasks the views see are made again. */
  #view(): void {
    const tasks = this.#pending.view(this.#confirmed);
    if (tasks === this.#state.tasks) return;
    this.#state = { ...this.#state, tasks };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
