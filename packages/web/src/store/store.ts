// The live store (A5 3.15, 3.24 "a small liveStore module on useSyncExternalStore"): the one place
// in the page that holds task data. It joins @ttasks/client/store's core (LiveCore: snapshot,
// batches, cursor) and own writes (Pending: overlays until the feed confirms them) with per-frame
// batching (frame.ts), and hands every view one immutable state through a small subscription
// interface. No React here: hooks.ts puts React on top.
//
// What a frame does with the messages that came since the last one, in their order:
// - applies each through the core; a snapshot supersedes what came before it;
// - settles the own writes the applied events named or the new cursor covers;
// - publishes one new state, so listeners hear once per frame;
// - tells the views which tasks the frame touched (an expanded task refetches its thread) and
//   what changed, row by row, for paged queries (queries.ts).
import type { Instance } from "@ttasks/contracts/runs";
import {
  LiveCore,
  type Change,
  type ResnapshotReason,
  incarnationTag,
  landedOf,
  Pending,
  type Overlay,
  type Settled,
  DEFAULT_SCALES,
  type AgentChange,
  type AreaRow,
  type BatchMessage,
  type Cursor,
  type PageRow,
  type ProjectRow,
  type Scales,
  type SnapshotMessage,
  type SpaceHead,
  type TaskRow,
} from "@ttasks/client/store";
import { FrameQueue, type FrameClock } from "./frame.ts";

export type Phase = "starting" | "connecting" | "live" | "offline" | "signed_out" | "no_space";

/**
 * What happened to the copy of the space a tab loaded, so the tab saves nothing more: it was
 * closed, or another copy is served now (claimed, restored in place, a restored copy, another
 * folder), or the service refused a call for another copy (`replaced`, nothing more known).
 */
export type GoneWhy =
  "closed" | "claimed" | "restored" | "restored_copy" | "other_folder" | "replaced";

export interface Gone {
  readonly why: GoneWhy;
  /** The folder the space is open from now, as the person reads it, when that is known. */
  readonly folder?: string;
}

/**
 * What a snapshot of `now` says happened to the copy `was` a tab loaded; a tab that loaded nothing
 * yet was opened for another copy than `now`.
 */
export function goneOf(was: SpaceHead | undefined, now: SpaceHead): Gone {
  if (was === undefined) return { why: "replaced" };
  const folder = now.folder === undefined ? {} : { folder: now.folder };
  if (now.restored !== undefined) return { why: "restored_copy", ...folder };
  if (was.folder !== now.folder) return { why: "other_folder", ...folder };
  return { why: was.restored !== undefined ? "claimed" : "restored", ...folder };
}

export interface LiveState {
  readonly phase: Phase;
  /** The service runs another build: the page offers a reload. */
  readonly stale: boolean;
  /**
   * Another version is installed than the one the service runs (and this page came from): a
   * restart of the service switches to it.
   */
  readonly installed: { readonly version: string; readonly running: string } | undefined;
  readonly space: SpaceHead | undefined;
  /**
   * The copy of the space this tab loaded is no longer served: the tab shows it as it was, saves
   * nothing more, and offers to load what the space is now.
   */
  readonly gone: Gone | undefined;
  /** The open tasks: the confirmed rows with this tab's pending writes on top. */
  readonly tasks: ReadonlyMap<string, TaskRow>;
  /** The finished and dropped tasks a question waits on, as `tasks` is made. */
  readonly asking: ReadonlyMap<string, TaskRow>;
  readonly areas: ReadonlyMap<string, AreaRow>;
  readonly projects: ReadonlyMap<string, ProjectRow>;
  /** The pages shown, without their bodies. */
  readonly pages: ReadonlyMap<string, PageRow>;
  readonly instances: readonly Instance[];
  /** The space's statuses and effort scale. */
  readonly scales: Scales;
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
  /** With `reset`: the tasks agents changed lately, as of the snapshot, before `changes`. */
  readonly agentChanges?: readonly AgentChange[];
}

/** A message the store applies at the next frame. */
export type Queued =
  | SnapshotMessage
  | BatchMessage
  | { readonly type: "unreadable" }
  | { readonly type: "error"; readonly code: string; readonly reason?: string };

export interface StoreOptions {
  /** The tab's space, from its route; a tab opened without one takes the first snapshot's. */
  readonly space?: string | undefined;
  /**
   * The copy of the space the tab was opened for: the one the person's Open folder answered. Any
   * other copy served by its first snapshot is not shown.
   */
  readonly copy?: string | undefined;
  readonly frames: FrameClock;
  /** The core asks for a fresh snapshot: the transport subscribes again without a cursor. */
  readonly onResnapshot: (reason: ResnapshotReason) => void;
  /** The first snapshot named the tab's space. */
  readonly onSpace?: (space: string) => void;
  /** A fresh request ID (A1 3.8). */
  readonly newRequest?: () => string;
  /** The copy the tab loaded is gone (LiveState `gone`): the feed has nothing more to give. */
  readonly onGone?: () => void;
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
  #confirmedAsking: ReadonlyMap<string, TaskRow> = new Map();
  #confirmedScales: Scales = DEFAULT_SCALES;
  #state: LiveState = {
    phase: "starting",
    stale: false,
    installed: undefined,
    space: undefined,
    gone: undefined,
    tasks: new Map(),
    asking: new Map(),
    areas: new Map(),
    projects: new Map(),
    pages: new Map(),
    instances: [],
    scales: DEFAULT_SCALES,
  };

  constructor(options: StoreOptions) {
    this.#options = options;
    this.#core = new LiveCore(options.space, options.copy);
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

  /** The installed version when the service runs `running`; undefined: the same, or not known. */
  setInstalled(version: string | undefined, running: string | undefined): void {
    const next =
      version === undefined || running === undefined || version === running
        ? undefined
        : { version, running };
    const now = this.#state.installed;
    if (next?.version === now?.version && next?.running === now?.running) return;
    this.#state = { ...this.#state, installed: next };
    this.#emit();
  }

  /** The tab stops (closed, or signed out): queued messages are dropped and no more are taken. */
  stop(): void {
    this.#stopped = true;
    this.#queue.clear();
  }

  /** The copy of the space the tab loaded, or was opened for. */
  get copy(): string | undefined {
    return this.#core.copy;
  }

  /** Whether a snapshot of the space was applied. */
  get loaded(): boolean {
    return this.#core.loaded;
  }

  /**
   * The copy the tab loaded is gone: the rows stay as they were, no message of the feed applies
   * any more, and the tab says what happened.
   */
  gone(gone: Gone): void {
    if (this.#state.gone !== undefined) return;
    this.stop();
    this.#state = { ...this.#state, gone };
    this.#emit();
    this.#options.onGone?.();
  }

  /**
   * Sends a write: `send` makes the call with the request ID it is given, `request` when the caller
   * sends the same write again. `overlay` shows at once and stays until the feed confirms the
   * write, or goes when it is refused.
   */
  write<T>(
    send: (request: string) => Promise<T>,
    overlay: Overlay = EMPTY,
    request: string = (this.#options.newRequest ?? (() => crypto.randomUUID()))(),
  ): Sent<T> {
    let settle!: (settled: Settled) => void;
    const settled = new Promise<Settled>((resolve) => {
      settle = resolve;
    });
    this.#pending.add(request, overlay, settle);
    if (overlay.tasks.length > 0 || overlay.efforts !== undefined) this.#view();
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
    let ended: Gone | undefined;
    try {
      ended = this.#apply(items);
    } finally {
      // What came before applies first; then the tab learns its copy is gone.
      if (ended !== undefined) this.gone(ended);
    }
  }

  /** Applies `items` in order, up to one that says the tab's copy is gone: what it says. */
  #apply(items: readonly Queued[]): Gone | undefined {
    let changes: Change[] = [];
    const requests: string[] = [];
    let reset = false;
    let agentChanges: readonly AgentChange[] | undefined;
    let applied = false;
    let phase: Phase | undefined;
    let ended: Gone | undefined;
    const before = this.#core.space;
    for (const item of items) {
      if (item.type === "error") {
        // A tab that showed its space, or was opened for one copy of it, is told it was closed or
        // that another copy is served, and keeps what it shows.
        if (this.#core.copy !== undefined) {
          ended = { why: item.reason === "replaced" ? "replaced" : "closed" };
          break;
        }
        phase = "no_space";
        continue;
      }
      const outcome = this.#core.receive(item);
      if (outcome.kind === "replaced") {
        ended = goneOf(outcome.was, outcome.now);
        break;
      }
      switch (outcome.kind) {
        case "snapshot":
          // What came before a snapshot is superseded by it.
          changes = [];
          reset = true;
          agentChanges = outcome.agentChanges;
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
      return ended;
    }
    const held = this.#core.publish();
    if (held !== undefined) {
      this.#confirmed = held.tasks;
      this.#confirmedAsking = held.asking;
      this.#confirmedScales = held.scales;
      this.#state = {
        ...this.#state,
        ...(phase === undefined ? {} : { phase }),
        space: held.space,
        tasks: this.#pending.view(held.tasks),
        asking: this.#pending.view(held.asking),
        areas: held.areas,
        projects: held.projects,
        pages: held.pages,
        instances: held.instances,
        scales: this.#pending.scales(held.scales),
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
      const frame =
        agentChanges === undefined ? { changes, reset } : { changes, reset, agentChanges };
      for (const listener of this.#changeListeners) listener(frame);
    }
    return ended;
  }

  /** The pending overlays changed: the tasks and the scales the views see are made again. */
  #view(): void {
    const tasks = this.#pending.view(this.#confirmed);
    const asking = this.#pending.view(this.#confirmedAsking);
    const made = this.#pending.scales(this.#confirmedScales);
    const scales = made.efforts === this.#state.scales.efforts ? this.#state.scales : made;
    if (
      tasks === this.#state.tasks &&
      asking === this.#state.asking &&
      scales === this.#state.scales
    ) {
      return;
    }
    this.#state = { ...this.#state, tasks, asking, scales };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
