// Paged queries and how the feed invalidates them (A5 3.13, 3.15 "Paged queries"). Completed
// tasks, search results and Trash are not in the live store: they are read in pages, and the
// store's changes invalidate them by query, not only by the rows they show:
//
// | Query     | Invalidated by                                             | Then                    |
// |-----------|------------------------------------------------------------|-------------------------|
// | Completed | a lifecycle change, completion date, wrap state, deletion  | restarts from page 1    |
// | Trash     | deletion and restore                                       | restarts from page 1    |
// | Search    | searchable text, a field it filters or sorts on, creation, | frozen: "Results        |
// |           | lifecycle and deletion                                     | changed · Refresh"      |
//
// The feed names a task's logical fields (A1 3.4: `lifecycle` holds the completion date, `wrap` the
// wrap state and outcome, `deleted` the deletion), so the table is written in them too.
//
// A restart reads on to the last row shown, so a row that joins above pushes none of them out,
// and only the newest read applies. A row a query
// already shows takes the feed's row in place, without a restart, and so does a row a read brings
// back after the feed changed it: a read that left before a change can answer after it. A snapshot
// (after a gap) means the changes in between are unknown: every query counts as changed.
//
// The read itself is injected (`PageSource`): the service's paged reads (`task.search`,
// `task.finished`); this module is the part that decides when they read again.
import type { Change } from "./core.ts";
import { withTaskRow } from "./rows.ts";
import type { Changes } from "./store.ts";

export type QueryKind = "completed" | "trash" | "search";

export interface QueryDef {
  readonly kind: QueryKind;
  /**
   * The task fields a search filters or sorts on (A3's query language), besides its text, by their
   * logical names (A1 3.4: `due`, `grouping`, `priority`), or `area` and `project` for their titles.
   */
  readonly fields?: readonly string[];
}

/** The task fields whose change can move a task into or out of Completed, or reorder it. */
const COMPLETED_FIELDS = ["lifecycle", "wrap", "deleted"];
const TRASH_FIELDS = ["deleted"];
/** A task's searchable text (the outcome is `wrap`'s) and the fields every search depends on. */
const SEARCH_FIELDS = ["title", "summary", "context", "wrap", "lifecycle", "deleted"];
/** Children whose text a search reads: notes, log entries, sources and their links, learnings. */
const SEARCH_CHILDREN = new Set(["note", "log", "source", "link", "learning"]);

const touches = (change: Change, fields: readonly string[]): boolean =>
  // A change that names no field (a whole-row change) may have changed any of them.
  change.changed.length === 0 || change.changed.some((field) => fields.includes(field));

/** Whether a change could alter which tasks a query holds or their order. */
export function affects(def: QueryDef, change: Change): boolean {
  switch (def.kind) {
    case "completed":
      if (change.type !== "task") return false;
      if (change.created)
        return (change.after as { lifecycle?: string } | undefined)?.lifecycle !== "active";
      return touches(change, COMPLETED_FIELDS);
    case "trash":
      return change.type === "task" && !change.created && touches(change, TRASH_FIELDS);
    case "search": {
      if (SEARCH_CHILDREN.has(change.type)) return true;
      const fields = def.fields ?? [];
      if (change.type === "area" || change.type === "project") {
        return fields.includes(change.type) && touches(change, ["title", "slug", "deleted"]);
      }
      if (change.type !== "task") return false;
      return change.created || touches(change, [...SEARCH_FIELDS, ...fields]);
    }
  }
}

/** One page of a paged read: rows in order, and the cursor of the next page if there is one. */
export interface Page<R> {
  readonly rows: readonly R[];
  readonly next?: string;
}

export type PageSource<R> = (request: {
  readonly after: string | undefined;
  readonly limit: number;
  /**
   * A restart's end: the cursor after the last row shown, or null when every row was shown. A
   * source that can place it reads on to it whatever `limit` says, so a row that joins above
   * pushes none of the shown rows out of the list; another reads `limit` rows.
   */
  readonly through?: string | null;
}) => Promise<Page<R>>;

export interface QueryState<R> {
  readonly rows: readonly R[];
  readonly phase: "idle" | "loading" | "ready" | "failed";
  /** A frozen search whose results may have changed: the page shows "Results changed · Refresh". */
  readonly changed: boolean;
  readonly more: boolean;
  /** Why the last read failed, while `phase` is `failed`. */
  readonly error?: unknown;
}

export const PAGE_SIZE = 50;

export interface QueryOptions {
  readonly pageSize?: number;
  /**
   * Whether a failed next page means its cursor expired (a search's, after a restart or 15
   * minutes): the query then reads from page 1 again, the rows shown and one page more.
   */
  readonly expired?: (error: unknown) => boolean;
}

export class PagedQuery<R extends { readonly id: string }> {
  readonly def: QueryDef;
  readonly #source: PageSource<R>;
  readonly #pageSize: number;
  readonly #expired: (error: unknown) => boolean;
  readonly #listeners = new Set<() => void>();
  #state: QueryState<R> = { rows: [], phase: "idle", changed: false, more: false };
  #next: string | undefined;
  /** A read has answered: from then on a restart reads on to where the shown rows end. */
  #answered = false;
  /** Only the newest read applies: an older one that answers late is dropped. */
  #generation = 0;
  /** A frozen query was invalidated while a read was on its way: that read may predate it. */
  #stale = false;
  /**
   * The newest feed row of each task the feed changed since the newest read left: that read may
   * answer with older values, which these replace (`withTaskRow` keeps whichever is newer).
   */
  #during = new Map<string, Readonly<Record<string, unknown>>>();

  constructor(def: QueryDef, source: PageSource<R>, options: QueryOptions = {}) {
    this.def = def;
    this.#source = source;
    this.#pageSize = options.pageSize ?? PAGE_SIZE;
    this.#expired = options.expired ?? (() => false);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getState = (): QueryState<R> => this.#state;

  /** A frozen query restarts only when asked; the others restart by themselves. */
  get frozen(): boolean {
    return this.def.kind === "search";
  }

  #set(patch: Partial<QueryState<R>>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** A read leaves: from now on the feed's changes are kept for its answer. */
  #read(): number {
    this.#during = new Map();
    return ++this.#generation;
  }

  /** The rows a read answered with, brought up to the feed's changes made while it was away. */
  #current(rows: readonly R[]): readonly R[] {
    if (this.#during.size === 0) return rows;
    return rows.map((row) => {
      const after = this.#during.get(row.id);
      return after === undefined ? row : withTaskRow(row, after);
    });
  }

  /**
   * Reads from page 1 again, on to the last row shown (at least one page): the first read, a
   * restart, and the explicit Refresh of a frozen search.
   */
  refresh(): Promise<void> {
    return this.#restart(
      Math.max(this.#pageSize, this.#state.rows.length),
      this.#answered ? (this.#next ?? null) : undefined,
    );
  }

  #restart(limit: number, through?: string | null): Promise<void> {
    const generation = this.#read();
    this.#stale = false;
    this.#set({ phase: "loading" });
    return this.#source({
      after: undefined,
      limit,
      ...(through === undefined ? {} : { through }),
    }).then(
      (page) => {
        if (generation !== this.#generation) return;
        this.#answered = true;
        this.#next = page.next;
        this.#set({
          rows: this.#current(page.rows),
          phase: "ready",
          changed: this.#stale,
          more: page.next !== undefined,
          error: undefined,
        });
      },
      (error: unknown) => {
        if (generation === this.#generation) this.#set({ phase: "failed", error });
      },
    );
  }

  /** The next page, after the rows shown. */
  more(): Promise<void> {
    const after = this.#next;
    if (after === undefined || this.#state.phase === "loading") return Promise.resolve();
    const generation = this.#read();
    this.#set({ phase: "loading" });
    return this.#source({ after, limit: this.#pageSize }).then(
      (page) => {
        if (generation !== this.#generation) return;
        this.#answered = true;
        this.#next = page.next;
        const seen = new Set(this.#state.rows.map((r) => r.id));
        this.#set({
          rows: [...this.#state.rows, ...this.#current(page.rows.filter((r) => !seen.has(r.id)))],
          phase: "ready",
          more: page.next !== undefined,
          error: undefined,
        });
      },
      async (error: unknown) => {
        if (generation !== this.#generation) return;
        if (this.#expired(error)) {
          await this.#restart(this.#state.rows.length + this.#pageSize);
          return;
        }
        this.#set({ phase: "failed", error });
      },
    );
  }

  /** One frame's changes from the live store. */
  apply({ changes, reset }: Changes): void {
    if (this.#state.phase === "idle") return;
    let invalid = reset;
    let rows: R[] | undefined;
    for (const change of changes) {
      if (!invalid && affects(this.def, change)) invalid = true;
      // A row the query shows takes the feed's row in place (A5 3.13, 3.15); a read on its way
      // takes it when it answers.
      if (change.after === undefined || change.type !== "task") continue;
      const after = change.after as unknown as Readonly<Record<string, unknown>>;
      if (this.#state.phase === "loading") this.#during.set(change.id, after);
      const at = (rows ?? this.#state.rows).findIndex((r) => r.id === change.id);
      if (at < 0) continue;
      rows ??= [...this.#state.rows];
      const row = rows[at];
      if (row !== undefined) rows[at] = withTaskRow(row, after);
    }
    if (rows !== undefined) this.#set({ rows });
    if (!invalid) return;
    if (this.frozen) {
      this.#stale = true;
      if (!this.#state.changed) this.#set({ changed: true });
    } else {
      void this.refresh();
    }
  }
}
