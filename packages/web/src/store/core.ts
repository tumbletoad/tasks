// The live store's core (A5 3.15; A1 3.7 "Change feed (X8)"): the tab's open working set and the
// rule that moves it forward. Plain code with no clock, socket or React, so every interleaving of
// the feed's messages can be tested against a model of the service.
//
// - A snapshot replaces everything: rows, instances, the space's scales and the applied-through
//   cursor `(epoch, incarnation, seq)`.
// - A batch covers `(from, through]`. It applies when it reaches past the cursor without a gap:
//   `from <= cursor.seq < through` in the same epoch and incarnation. Its events at or below the
//   cursor are skipped (A1 3.7: they were applied before), the rest apply, and the cursor moves to
//   `through` in one step. An empty batch only moves the cursor. Gaps are judged by coverage,
//   never by consecutive `seq` values, because a filtered feed leaves out commits.
// - A batch wholly at or behind the cursor is a repeat: nothing happens.
// - A gap (`from` beyond the cursor), another epoch or incarnation, a withheld row (`row: null`
//   for a task, area or project: A5 3.15), a changed status or effort scale (its value comes with
//   a snapshot) or a batch the page cannot read asks for a fresh snapshot. Until it arrives, every
//   batch waits for it and is dropped; the rows stay on screen.
// - Each batch applies whole or not at all: it is checked first, then applied.
// - The one value the core works out itself is a task's `touched` when a child row of it (a note,
//   a log entry, a source) changed: A1 3.5 makes it the commit's seq, and the feed carries the
//   child without the task's row.
//
// Rows are held in maps the core changes in place. `publish()` hands out new maps for the kinds
// that changed since the last call, so a frame that applies many batches copies each map once.
import type { Instance } from "../api.ts";
import {
  DEFAULT_SCALES,
  inWorkingSet,
  isRowType,
  ROW_OF,
  type AnyRow,
  type AreaRow,
  type BatchMessage,
  type Cursor,
  type ProjectRow,
  type RowType,
  type Scales,
  type SnapshotMessage,
  type SpaceHead,
  type TaskRow,
} from "./rows.ts";

/** What one entity of an applied event did to the working set, for views and paged queries. */
export interface Change {
  readonly type: string;
  readonly id: string;
  /** The task this change belongs to: the task itself, or a child's task. */
  readonly task?: string;
  /** The working set's row before the change; undefined when the set did not hold it. */
  readonly before?: AnyRow;
  /** The post-change row the event carried, for a task, area or project. */
  readonly after?: AnyRow;
  readonly changed: readonly string[];
  readonly created: boolean;
  readonly kind: string;
  readonly actor: { readonly kind: string; readonly label: string };
  readonly request_id: string;
}

export type ResnapshotReason = "gap" | "authority" | "withheld" | "unreadable" | "preference";

/** The preferences the page holds the value of (`Scales`); the others it does not read. */
const SCALE_KEYS: ReadonlySet<string> = new Set(["tasks.statuses", "tasks.effort_scale"]);

export type Outcome =
  /** A snapshot replaced the working set. */
  | { readonly kind: "snapshot" }
  /**
   * A batch moved the cursor; `changes` and `requests` are those of its new events, and
   * `commits` each request's commit ID where the event named one.
   */
  | {
      readonly kind: "applied";
      readonly changes: readonly Change[];
      readonly requests: readonly string[];
      readonly commits: ReadonlyMap<string, string>;
    }
  /** A repeat, another space's message, or a batch while a snapshot is awaited: nothing changed. */
  | { readonly kind: "ignored" }
  /** The core asks for a fresh snapshot; nothing of the batch applied. */
  | { readonly kind: "resnapshot"; readonly reason: ResnapshotReason }
  /**
   * A snapshot of another copy of the space than the one this tab loaded (a claim, a restore,
   * another folder of it opened): nothing of it applied. `was` is the copy the tab shows.
   */
  | { readonly kind: "replaced"; readonly was: SpaceHead; readonly now: SpaceHead };

/** What the working set looks like to a reader: immutable maps. */
export interface Held {
  readonly space: SpaceHead;
  readonly cursor: Cursor;
  readonly tasks: ReadonlyMap<string, TaskRow>;
  readonly areas: ReadonlyMap<string, AreaRow>;
  readonly projects: ReadonlyMap<string, ProjectRow>;
  readonly instances: readonly Instance[];
  readonly scales: Scales;
}

interface Maps {
  task: Map<string, AnyRow>;
  area: Map<string, AnyRow>;
  project: Map<string, AnyRow>;
}

function mapOf(type: RowType, rows: readonly AnyRow[]): Map<string, AnyRow> {
  const map = new Map<string, AnyRow>();
  for (const row of rows) if (inWorkingSet(type, row)) map.set(row.id, row);
  return map;
}

export class LiveCore {
  /** The tab's space: from its route, or the first snapshot's. */
  #space: string | undefined;
  /** The copy of the space the tab loaded: its first snapshot's, for the tab's whole life. */
  #copy: string | undefined;
  #head: SpaceHead | undefined;
  #cursor: Cursor | undefined;
  #instances: readonly Instance[] = [];
  #scales: Scales = DEFAULT_SCALES;
  #maps: Maps | undefined;
  /** A fresh snapshot was asked for: batches wait for it. */
  #awaiting = false;
  readonly #dirty = new Set<RowType>();
  #published: Held | undefined;

  constructor(space?: string) {
    this.#space = space;
  }

  get space(): string | undefined {
    return this.#space;
  }

  /** The copy of the space the tab loaded, once its first snapshot named it. */
  get copy(): string | undefined {
    return this.#copy;
  }

  /** Whether a fresh snapshot was asked for and has not arrived. */
  get awaiting(): boolean {
    return this.#awaiting;
  }

  /** The cursor the held rows are as of (also while a fresh snapshot is awaited). */
  get cursor(): Cursor | undefined {
    return this.#cursor;
  }

  /** The cursor a new subscription resumes from: none before a snapshot or while one is awaited. */
  get resumeFrom(): Cursor | undefined {
    return this.#awaiting ? undefined : this.#cursor;
  }

  /** Asks for a fresh snapshot (a gap, or the transport's own reason). */
  resnapshot(): void {
    this.#awaiting = true;
  }

  receive(message: SnapshotMessage | BatchMessage | { readonly type: "unreadable" }): Outcome {
    switch (message.type) {
      case "snapshot":
        return this.#snapshot(message);
      case "batch":
        return this.#batch(message);
      case "unreadable":
        return this.#ask("unreadable");
    }
  }

  #ask(reason: ResnapshotReason): Outcome {
    if (this.#awaiting) return { kind: "ignored" };
    this.#awaiting = true;
    return { kind: "resnapshot", reason };
  }

  #snapshot(message: SnapshotMessage): Outcome {
    // Another space's snapshot never lands in this tab, nor another copy's of its space.
    if (this.#space !== undefined && message.space.id !== this.#space) return { kind: "ignored" };
    const was = this.#head;
    if (was !== undefined && message.space.copy !== this.#copy) {
      return { kind: "replaced", was, now: message.space };
    }
    this.#copy ??= message.space.copy;
    this.#space = message.space.id;
    this.#head = message.space;
    this.#cursor = message.cursor;
    this.#instances = message.instances;
    this.#scales = message.scales ?? DEFAULT_SCALES;
    this.#maps = {
      task: mapOf("task", message.tasks),
      area: mapOf("area", message.areas),
      project: mapOf("project", message.projects),
    };
    this.#awaiting = false;
    this.#dirty.add("task").add("area").add("project");
    this.#published = undefined;
    return { kind: "snapshot" };
  }

  #batch(batch: BatchMessage): Outcome {
    const cursor = this.#cursor;
    const maps = this.#maps;
    if (this.#awaiting || cursor === undefined || maps === undefined) return { kind: "ignored" };
    // Another space's batch never lands in this tab (a subscription the tab replaced).
    if (batch.space_id !== this.#head?.id) return { kind: "ignored" };
    if (batch.epoch !== cursor.epoch || batch.incarnation !== cursor.incarnation) {
      return this.#ask("authority");
    }
    if (batch.through < batch.from) return this.#ask("unreadable");
    if (batch.from > cursor.seq) return this.#ask("gap");
    if (batch.through <= cursor.seq) return { kind: "ignored" };

    // Check the whole batch before any of it applies.
    let last = batch.from;
    const rows = new Map<string, AnyRow>();
    for (const event of batch.events) {
      if (event.seq <= last || event.seq > batch.through) return this.#ask("unreadable");
      last = event.seq;
      if (event.seq <= cursor.seq) continue;
      for (const entity of event.entities) {
        // A scale's preference comes without its value: a snapshot carries it.
        if (entity.type === "preference" && SCALE_KEYS.has(entity.id)) {
          return this.#ask("preference");
        }
        if (!isRowType(entity.type)) continue;
        if (entity.row === null) return this.#ask("withheld");
        const row = ROW_OF[entity.type](entity.row);
        if (row?.id !== entity.id) return this.#ask("unreadable");
        rows.set(`${entity.type}:${entity.id}`, row);
      }
    }

    const changes: Change[] = [];
    const requests: string[] = [];
    const commits = new Map<string, string>();
    for (const event of batch.events) {
      if (event.seq <= cursor.seq) continue;
      if (event.request_id !== "") {
        requests.push(event.request_id);
        if (event.op_id !== undefined) commits.set(event.request_id, event.op_id);
      }
      for (const entity of event.entities) {
        const base = {
          type: entity.type,
          id: entity.id,
          changed: entity.changed,
          created: entity.created,
          kind: event.kind,
          actor: event.actor,
          request_id: event.request_id,
        };
        if (!isRowType(entity.type)) {
          if (entity.task === undefined) {
            changes.push(base);
            continue;
          }
          changes.push({ ...base, task: entity.task });
          // A1 3.5: a task's `touched` becomes the commit's seq when a child row changes, and
          // nothing else of the task does. The feed carries the child, not the task's row, so the
          // held row takes the mark here. A launch or a run is no child (it moves no `touched`).
          const held =
            entity.type === "launch" || entity.type === "run"
              ? undefined
              : maps.task.get(entity.task);
          if (held !== undefined && ((held as TaskRow).touched ?? 0) < event.seq) {
            maps.task.set(entity.task, { ...held, touched: event.seq });
            this.#dirty.add("task");
          }
          continue;
        }
        const type = entity.type;
        const after = rows.get(`${type}:${entity.id}`);
        if (after === undefined) continue;
        const map = maps[type];
        const before = map.get(entity.id);
        if (inWorkingSet(type, after)) map.set(entity.id, after);
        else map.delete(entity.id);
        this.#dirty.add(type);
        changes.push({
          ...base,
          ...(type === "task" ? { task: entity.id } : {}),
          ...(before === undefined ? {} : { before }),
          after,
        });
      }
    }
    this.#cursor = { epoch: cursor.epoch, incarnation: cursor.incarnation, seq: batch.through };
    return { kind: "applied", changes, requests, commits };
  }

  /** The working set as immutable maps: new maps only for the kinds that changed since last time. */
  publish(): Held | undefined {
    const maps = this.#maps;
    const head = this.#head;
    const cursor = this.#cursor;
    if (maps === undefined || head === undefined || cursor === undefined) return undefined;
    const before = this.#published;
    const copy = <T extends AnyRow>(type: RowType, old: ReadonlyMap<string, T> | undefined) =>
      old !== undefined && !this.#dirty.has(type)
        ? old
        : (new Map(maps[type]) as unknown as ReadonlyMap<string, T>);
    const held: Held = {
      space: head,
      cursor,
      tasks: copy<TaskRow>("task", before?.tasks),
      areas: copy<AreaRow>("area", before?.areas),
      projects: copy<ProjectRow>("project", before?.projects),
      instances: this.#instances,
      scales: this.#scales,
    };
    this.#dirty.clear();
    this.#published = held;
    return held;
  }
}
