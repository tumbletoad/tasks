// Dedupe by source key (A1 3.6, R4; A3 3.4.5, 3.11.1): which task a draft's keys name. The writer's
// staging (writer.ts) asks this module for each `task.create` and tells it what the request itself
// does, so a draft sees the request's earlier work the way execution will:
//
// - A key's holders are the tasks linked to the live source with that key by a live link, that
//   are not deleted: those at the start of the request, read once for every key the request names,
//   and those the request links before the draft. A draft the request creates holds its own keys
//   from its create on, so two drafts of one request with one key are one task, whatever the order
//   of their source operations.
// - A holder's lifecycle and tombstone are its own at the start, or what the request's earlier
//   operations left: `task.complete`, `task.archive` and `task.reopen` move its lifecycle, and
//   `task.delete` and `task.restore` its tombstone, so a task the request deletes no longer holds
//   its keys and one it restores holds them again. A task the request itself completes, archives
//   or wraps up finished last of all and is no match: a draft after it is new work, as
//   complete_task's follow-up of the same ticket is (A3 3.4.8), so it is created, never matched
//   to an earlier finish either. That holds also when the operation finds the task finished or
//   wrapped already (`if_active`, `once`): the request says it is done before the draft.
// - One active holder is the match, and the draft's entries follow it. Several are ambiguous: the
//   first by reference is named, the rest listed, and nothing follows. With none, a holder finished
//   within `tasks.dedupe_window_days` of the request's instant is the match, the one finished last,
//   and nothing follows: the caller decides whether to reopen it or create anew.
//
// A task finished at its `completed_at`, else at the instant of the commit whose write its
// lifecycle holds (an archived task has no completion time): its provenance, so an undo or redo
// that sets a finish back keeps the finish's own instant (A1 3.10). Commit instants never go back,
// so two finishes can share one: the later commit is the one finished last. A removed link or a
// deleted task never matches, so an undone create holds no key. Everything is read inside the
// writer's transaction, so two requests never both create a task for one key: the single writer
// decides them one after the other (A1 3.9).
//
// The start-state read follows `task_sources` from each source, and `task_sources` has no index on
// `source_id` in schema 0.2, so it scans the links once per request that names a key that exists.
// It reads deleted tasks' links too, so a task the request restores holds its keys again.
import type { Connection } from "../driver.ts";
import type { Id } from "../ids.ts";
import { inRange, invalidValue, RowReader } from "../rows.ts";
import { DEDUPE_WINDOW_DAYS, type Operation, type TaskLifecycle } from "./request.ts";

const DAY_MS = 86_400_000;

/** The longest window a space may set, in days: ten years. */
const WINDOW_DAYS_MAX = 3_650;

const SQL = {
  sourceByKey: "SELECT id FROM sources WHERE source_key = $key AND deleted_at IS NULL",
  holders:
    "SELECT source_id, task_id FROM task_sources WHERE removed_at IS NULL " +
    "AND source_id IN (SELECT value FROM json_each($sources))",
  task: "SELECT ref, lifecycle, completed_at, deleted_at, created_seq, fp FROM tasks WHERE id = $id",
  commitAt: "SELECT at FROM commits WHERE seq = $seq",
  window: "SELECT value FROM preferences WHERE key = 'tasks.dedupe_window_days'",
} as const;

/** What a draft's keys matched (A1 3.6). */
export interface Match {
  /** The one active match, the first of several by reference, or the finished one. */
  task: Id<"t">;
  lifecycle: TaskLifecycle;
  /** Several active matches, the named one first, in reference order. */
  ambiguous?: Id<"t">[];
  /**
   * Whether the draft's later operations may follow it: only to one active match. Which of them
   * do is the writer's rebinding rule (writer.ts: follows).
   */
  follows: boolean;
  /** The draft's sources follow it too (`link_sources`, A3's `add_sources`). */
  linkSources: boolean;
}

/** A task as dedupe compares it. */
interface Holder {
  lifecycle: TaskLifecycle;
  /**
   * When it finished: the instant, and the commit whose write its lifecycle holds. Null while it
   * is active. A task the request completes finished at the request's instant, after every commit.
   */
  finished: { at: number; seq: number } | null;
  /** The request completed, archived or wrapped it up: a draft after it is new work (A1 3.6). */
  here: boolean;
  /** Its tombstone, as the request has staged it: a deleted task holds no key. */
  deleted: boolean;
  /** Reference order: existing tasks by reference, then the request's drafts as created. */
  rank: readonly [number, number];
}

const byRank = (a: Holder, b: Holder): number => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1];

/** The one finished last first: by instant, then by commit, then by reference, highest first. */
const byFinish = (a: Holder, b: Holder): number =>
  (b.finished?.at ?? 0) - (a.finished?.at ?? 0) ||
  (b.finished?.seq ?? 0) - (a.finished?.seq ?? 0) ||
  byRank(b, a);

/**
 * The commit whose write a task's lifecycle holds: its provenance (`fp`, A1 3.10), else its
 * create. Not the commit that last wrote it (`fv`): an undo of a reopen writes the lifecycle back,
 * and the task finished when the write it holds again was made, as its `completed_at` says.
 */
function lifecycleSeq(r: RowReader): number {
  const fp = r.json("fp");
  const held =
    typeof fp === "object" && fp !== null && !Array.isArray(fp)
      ? (fp as Record<string, unknown>)["lifecycle"]
      : undefined;
  const seq = held === undefined ? r.int("created_seq", "seq") : held;
  if (!inRange(seq, "seq")) throw invalidValue("tasks", "fp");
  return seq;
}

/**
 * One request's dedupe state, against the start state and the request's own staged work. Without a
 * keyed source in the request it reads nothing.
 */
export class Dedupe {
  readonly #conn: Connection;
  /** The request's instant: a task finished in the request finished then. */
  readonly #at: number;
  /** Every key the request's `source.add` operations name. */
  readonly #keys: ReadonlySet<string>;
  /** The keys of the `source.add` operations that name each task reference, in request order. */
  readonly #named = new Map<string, string[]>();
  /** The start-state holders of each key, read on the first match. */
  #start: Map<string, Id<"t">[]> | undefined;
  #windowMs: number | undefined;
  readonly #holders = new Map<Id<"t">, Holder>();
  /** The tasks the request links each key to, so far. */
  readonly #links = new Map<string, Set<Id<"t">>>();
  #drafts = 0;

  constructor(conn: Connection, ops: readonly Operation[], at: number) {
    this.#conn = conn;
    this.#at = at;
    const keys = new Set<string>();
    for (const op of ops) {
      if (op.kind !== "source.add" || op.source.key === undefined) continue;
      keys.add(op.source.key);
      const named = this.#named.get(op.task) ?? [];
      if (!named.includes(op.source.key)) named.push(op.source.key);
      this.#named.set(op.task, named);
    }
    this.#keys = keys;
  }

  /**
   * A draft's keys: those of the request's `source.add` operations that name its ID. One that
   * stands before the draft's create cannot resolve the ID, which refuses the request first.
   */
  keysOf(id: Id<"t">): readonly string[] {
    return this.#named.get(id) ?? [];
  }

  /** A draft the request creates: active, ranked after every existing task, holding its keys. */
  created(id: Id<"t">, keys: readonly string[]): void {
    if (this.#keys.size === 0) return;
    this.#holders.set(id, {
      lifecycle: "active",
      finished: null,
      here: false,
      deleted: false,
      rank: [1, (this.#drafts += 1)],
    });
    for (const key of keys) this.link(key, id);
  }

  /** The request links `key` to `task`. */
  link(key: string, task: Id<"t">): void {
    if (this.#keys.size === 0) return;
    const tasks = this.#links.get(key) ?? new Set();
    tasks.add(task);
    this.#links.set(key, tasks);
  }

  /**
   * The request completes (`completed`), archives (`archived`) or reopens (`active`) `task`. A
   * task it completes or archives finished last of all, which keeps a later draft from matching it
   * or any earlier finish. One that is finished already (`if_active`) keeps its own lifecycle.
   */
  lifecycle(task: Id<"t">, lifecycle: TaskLifecycle): void {
    if (this.#keys.size === 0) return;
    const holder = this.#holder(task);
    if (lifecycle === "active") {
      holder.lifecycle = "active";
      holder.here = false;
      holder.finished = null;
      return;
    }
    if (holder.lifecycle === "active") holder.lifecycle = lifecycle;
    this.#finishedHere(holder);
  }

  /** The request wraps `task` up: like a finish, a draft after it is new work (A3 3.4.8). */
  wrapped(task: Id<"t">): void {
    if (this.#keys.size === 0) return;
    this.#finishedHere(this.#holder(task));
  }

  /** The request deletes (`true`) or restores (`false`) `task`: only a live task holds keys. */
  deleted(task: Id<"t">, deleted: boolean): void {
    if (this.#keys.size === 0) return;
    this.#holder(task).deleted = deleted;
  }

  #finishedHere(holder: Holder): void {
    holder.here = true;
    holder.finished = { at: this.#at, seq: Number.MAX_SAFE_INTEGER };
  }

  /**
   * What the keys of a draft match: every active holder in reference order, and the match by A1
   * 3.6's rules, if any. `linkSources` is the draft's `link_sources`.
   */
  match(keys: readonly string[], linkSources: boolean): { active: Id<"t">[]; match?: Match } {
    const found = new Set<Id<"t">>();
    for (const key of keys) {
      for (const task of this.#startHolders().get(key) ?? []) found.add(task);
      for (const task of this.#links.get(key) ?? []) found.add(task);
    }
    const holders = [...found].map((id) => ({ id, ...this.#holder(id) })).filter((h) => !h.deleted);
    const active = holders
      .filter((h) => h.lifecycle === "active")
      .sort(byRank)
      .map((h) => h.id);
    const [first] = active;
    if (first !== undefined) {
      return active.length === 1
        ? { active, match: { task: first, lifecycle: "active", follows: true, linkSources } }
        : {
            active,
            match: {
              task: first,
              lifecycle: "active",
              ambiguous: active,
              follows: false,
              linkSources: false,
            },
          };
    }
    const since = this.#at - this.#window();
    const [last] = holders
      .filter((h) => h.finished !== null && h.finished.at >= since)
      .sort(byFinish);
    // The task finished last was completed by this request: the draft is new work after it.
    if (last === undefined || last.here) return { active };
    return {
      active,
      match: { task: last.id, lifecycle: last.lifecycle, follows: false, linkSources: false },
    };
  }

  /** The start-state holders of every key of the request: one read of the links per request. */
  #startHolders(): Map<string, Id<"t">[]> {
    if (this.#start !== undefined) return this.#start;
    const sources = new Map<string, string>();
    for (const key of this.#keys) {
      const row = this.#conn.prepare(SQL.sourceByKey).get({ key });
      if (row !== undefined) sources.set(new RowReader("sources", row).id("id", "s"), key);
    }
    const holders = new Map<string, Id<"t">[]>();
    if (sources.size > 0) {
      const rows = this.#conn
        .prepare(SQL.holders)
        .all({ sources: JSON.stringify([...sources.keys()]) });
      for (const row of rows) {
        const r = new RowReader("task_sources", row);
        const key = sources.get(r.id("source_id", "s"));
        if (key === undefined) throw invalidValue("task_sources", "source_id");
        // Appended in place: a source many tasks share costs one pass, not one copy per link.
        const tasks = holders.get(key);
        if (tasks === undefined) holders.set(key, [r.id("task_id", "t")]);
        else tasks.push(r.id("task_id", "t"));
      }
    }
    this.#start = holders;
    return holders;
  }

  /** A task's state as the request has staged it: its own at the start until the request moves it. */
  #holder(id: Id<"t">): Holder {
    const known = this.#holders.get(id);
    if (known !== undefined) return known;
    const row = this.#conn.prepare(SQL.task).get({ id });
    if (row === undefined) throw invalidValue("task_sources", "task_id");
    const r = new RowReader("tasks", row);
    const lifecycle = r.oneOf("lifecycle", ["active", "completed", "archived"]);
    let finished: Holder["finished"] = null;
    if (lifecycle !== "active") {
      const seq = lifecycleSeq(r);
      finished = { at: r.optInt("completed_at", "instant") ?? this.#commitAt(seq), seq };
    }
    const holder: Holder = {
      lifecycle,
      finished,
      here: false,
      deleted: r.optInt("deleted_at", "instant") !== null,
      rank: [0, r.int("ref", "taskRef")],
    };
    this.#holders.set(id, holder);
    return holder;
  }

  /** The instant of a commit. */
  #commitAt(seq: number): number {
    const commit = this.#conn.prepare(SQL.commitAt).get({ seq });
    if (commit === undefined) throw invalidValue("tasks", "fv");
    return new RowReader("commits", commit).int("at", "instant");
  }

  /** `tasks.dedupe_window_days` in milliseconds, or its default when unset or not a valid count. */
  #window(): number {
    if (this.#windowMs !== undefined) return this.#windowMs;
    let days = DEDUPE_WINDOW_DAYS;
    const text = this.#conn.prepare(SQL.window).get()?.["value"];
    if (typeof text === "string") {
      try {
        const value: unknown = JSON.parse(text);
        if (
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= WINDOW_DAYS_MAX
        ) {
          days = value;
        }
      } catch {
        // A value that is not JSON is ignored for the default, as listPreference does.
      }
    }
    this.#windowMs = days * DAY_MS;
    return this.#windowMs;
  }
}
