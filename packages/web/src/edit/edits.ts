// A person's edits, check-offs, undo and redo (A5 3.11, 3.12): the one code path for "a person
// changes a field", whatever control they used (the star, the title, a fact, "Restore mine").
// Plain code without React, one per live session (`editsOf`), so every view of the tab shares it
// and what it holds survives a switch of view, a collapsed card and a fresh snapshot.
//
// What it protects, in this order (PLAN D27):
// - What the person chose is never lost. An edit the service refused stays here, per task and
//   field, with the person's value ready to apply again with one click: after a conflict ("Changed
//   by Codex just now · Apply mine") and after a failed call ("Not saved · Try again"). Nothing is
//   overwritten silently: "Apply mine" and "Restore mine" are the person's explicit choice.
// - A check-off by mistake is undone with one action. The row stays, checked and struck through,
//   for the hold (4 s), its toast's Undo names its own commit, and clicking the box again during
//   the hold undoes it too.
// - Two windows, or a person and an agent, on one task: every edit carries a base (A1 3.5), so the
//   service refuses a write over a change the person did not see, and the conflict names who made it.
//
// Bases. A control's edit takes the applied cursor when the person acts; an editor that stays open
// while the person types (the title, a date) takes it when it opens. That is what the person saw.
// Edits of one task go out one after another: the next waits for the answer to the one before, and
// for an undo or redo asked before it. A base moves past what the screen showed only over the
// tab's own commits that directly follow it, or to the tab's own newest write of every field the
// edit writes (one commit that wrote them all), so the person's quick choices never conflict with
// each other, and a change someone else made to any of those fields meanwhile still does.
// Writes go through the live store, so each shows at once as an overlay and settles only through
// the feed (A5 3.15 item 4).
//
// The queue waits for outcomes, never for ever: a request that gets no answer is asked about by
// its own ID, and what waits behind a request whose outcome cannot be learned stays with the
// person as not saved, never sent out of order (calls.ts, A5 3.11 "No request holds the queue").
import type { Client } from "@ttasks/contracts/generated/client.ts";
import { newerSaid, type NewerWorkEntry, type ShortList } from "@ttasks/contracts/newer-work";
import type { Msg } from "../row/model.ts";
import type { Change as FeedChange } from "../store/core.ts";
import type { Overlay } from "../store/pending.ts";
import { questionsWaiting, type TaskRow } from "../store/rows.ts";
import type { Changes, Sent } from "../store/store.ts";
import {
  allOf,
  ASK_MS,
  Call,
  NotSent,
  Unanswered,
  type Decision,
  type Found,
  type Timers,
  type Turn,
} from "./calls.ts";
import { joinChanges, restoreChange, type Change, type Field } from "./change.ts";
import { readOnlyReason, readOnlyWhy } from "./read-only.ts";

/** What a toast says of a write the space refused because it takes no change; else undefined. */
function readOnlyText(error: unknown): Msg | undefined {
  const reason = readOnlyReason(error);
  return reason === undefined
    ? undefined
    : { id: "edit.notSavedReadOnly", values: { why: readOnlyWhy(reason) } };
}

/** How long a checked-off row stays where it is (A5 3.12). */
export const HOLD_MS = 4_000;
/** Then it collapses (A5 3.12, 3.20). */
export const COLLAPSE_MS = 180;
/** A row whose undo answered waits this long at most for the feed to bring it back. */
const RETURN_MS = 10_000;

export type ToastKind = "undo" | "info" | "error";

/** One toast: a short sentence and at most one action (A5 3.12). */
export interface Toast {
  readonly key: number;
  readonly kind: ToastKind;
  readonly text: Msg;
  readonly action?: { readonly label: Msg; readonly run: () => void };
}

/** An edit the service did not take: the person's value waits here (A5 3.11 "Writes"). */
export interface Unsaved {
  /**
   * Its own, until a save of it is acknowledged: a Try again refused again keeps it, and two tabs
   * whose edits of one field are both refused keep two (unsent.ts).
   */
  readonly id: string;
  readonly task: string;
  readonly ref: string;
  readonly field: Field;
  readonly change: Change;
  readonly reason: "conflict" | "failed";
  /**
   * What the screen showed when the person made it: Try again sends it with this base, so a change
   * someone made since is a conflict, never overwritten. Apply mine takes the screen's now.
   */
  readonly base?: string;
  /** Who changed the field since (a conflict): the actor's label, `user` or `import`. */
  readonly by?: string;
  readonly at?: number;
}

/** A row that leaves its view and stays for the hold (A5 3.12). */
export interface Leaving {
  readonly row: TaskRow;
  /** Checked and struck through; false once its check-off was undone. */
  readonly done: boolean;
  /** The hold is over: the row collapses. */
  readonly out: boolean;
  /** Who completed it, when it was not this tab (an agent, another window). */
  readonly by?: string;
  readonly at?: number;
}

/** Where the edits that wait are kept across a reload (unsent.ts). */
export interface UnsavedKeeper {
  /** The space's kept edits, each once. */
  load(): Unsaved[];
  /** The tab's edits that wait now, as the edits' state holds them (one under each field). */
  save(unsaved: ReadonlyMap<string, Unsaved>): void;
  /** Tells of each edit this tab kept or read that the browser holds no more: let go elsewhere. */
  onGone(listener: (unsaved: Unsaved) => void): () => void;
}

export interface EditState {
  readonly unsaved: ReadonlyMap<string, Unsaved>;
  /**
   * The kept edits sent again by Try again or Apply mine, by task and field, until their request
   * is decided: the browser keeps them meanwhile, so a page that goes before the answer loses none.
   */
  readonly retrying: ReadonlyMap<string, Unsaved>;
  readonly leaving: ReadonlyMap<string, Leaving>;
}

/** Someone else changed a field while an editor was open (A5 3.15 item 9). */
export interface Remote {
  readonly by: string;
  readonly kind: string;
  readonly mark: number;
}

export interface EditDeps {
  readonly client: Pick<Client, "task" | "history" | "receipt">;
  readonly write: <T>(send: (request: string) => Promise<T>, overlay?: Overlay) => Sent<T>;
  /** The applied cursor as an `as_of`: what the rows on screen show. */
  readonly asOf: () => string | undefined;
  /** The service refused the token or the build: the page's state says so already. */
  readonly failed: (error: unknown) => boolean;
  readonly onChanges: (listener: (changes: Changes) => void) => () => void;
  /** The live row of a task, by its reference (a conflict names tasks by reference). */
  readonly rowOf: (ref: string) => TaskRow | undefined;
  readonly newRequest: () => string;
  /** False once the tab's session stopped: an unanswered request is not asked about any more. */
  readonly alive?: () => boolean;
  readonly timers?: Timers;
  readonly keeper?: UnsavedKeeper;
  /** Resolves when the page goes away (`pageGone`). */
  readonly leaving?: () => Promise<unknown>;
}

/** An undo's commit: named, or the commit of the tab's own write, resolved in the undo's turn. */
export type Named = string | Pick<Sent<unknown>, "commit" | "request">;

/** The call that carries a request once it is sent (none when it was not). */
type Carried<T> = Promise<Pick<Call<T>, "decided"> | undefined>;

/** A write of the tab's, with its call. */
type Write<T> = Sent<T> & { readonly call: Carried<T> };

/** Where an outcome's toast goes (`#outcome`); undefined takes away the toast it showed. */
type Say = (toast: Omit<Toast, "key"> | undefined) => void;

/** A toast's write whose commit the page cannot learn: its Undo says so and changes nothing. */
class UnknownCommit extends Error {}

/**
 * The codes of a refusal that is no decision: the request may still be decided (A1 3.8: busy,
 * a timeout, a space that is opening). `internal` is a bug, refused the same way every time.
 */
const UNDECIDED = new Set(["service_unavailable", "space_unavailable"]);

/** A receipt's conflict as an error's (the service's `resultFailure`): who by a label. */
const byOf = (by: { kind: string; label: string; origin?: string | undefined }): string =>
  by.origin === "import" ? "import" : by.kind === "human" ? "user" : by.label;

/** A receipt that is no success, as the error the service's answer would have carried. */
function receiptError(found: Found): Error {
  return Object.assign(new Error(found.error?.message ?? "Refused"), {
    code: found.status === "conflict" ? "conflict" : "refused",
    data: {
      cause: found.error?.cause ?? "",
      // A receipt keeps a conflict without its values (A1 3.10.1): no Restore mine from it.
      conflicts: (found.conflicts ?? []).map((c) => ({
        ...(c.ref === undefined ? {} : { task: c.ref }),
        ...(c.entity === "tasks" ? {} : { entity: c.entity, id: c.id }),
        field: c.field,
        version: c.version,
        by: byOf(c.by),
        at: c.at,
      })),
      ...(found.target === undefined ? {} : { commit: found.target }),
      ...(found.passed_over === undefined ? {} : { passed_over: found.passed_over }),
      ...(found.newer_work === undefined ? {} : { newer_work: found.newer_work }),
    },
  });
}

/** A write's answer learned from its receipt: where it landed, and whether it changed anything. */
export interface WriteReceipt {
  readonly result: "updated" | "no_change";
  readonly as_of: string;
  readonly receipt: true;
}

/** The results of a write that made no commit: another project had the folder, or nothing changed. */
const WROTE_NOTHING: ReadonlySet<string> = new Set(["no_change", "exists"]);

/** A write's receipt as its answer: where it landed, and whether it changed anything. */
function writeOf(found: Found): Decision<Omit<WriteReceipt, "receipt">> {
  if (found.status === "applied" || found.status === "proposed") {
    return { ok: true, value: { result: "updated", as_of: found.as_of } };
  }
  if (found.status === "unchanged") {
    return { ok: true, value: { result: "no_change", as_of: found.as_of } };
  }
  return { ok: false, error: receiptError(found) };
}

/** A conflict as the service names it (A3 3.5, A1 3.10.1). */
interface Conflict {
  readonly task?: string;
  readonly entity?: string;
  readonly field: string;
  /** What is there now, what the change wrote, and what undoing it would set back. */
  readonly value?: unknown;
  readonly wrote?: unknown;
  readonly restore?: unknown;
  readonly by: string;
  readonly at: string;
}

interface Problem {
  readonly code: string;
  readonly cause: string;
  readonly conflicts: readonly Conflict[];
  /** The commit an undo or redo meant, which its UNDO_CONFLICT names (A1 3.10.1). */
  readonly commit?: string;
  /** An undo's or a redo's: who changed which task since. */
  readonly newer: readonly NewerWorkEntry[];
  /** A refused redo's: every change it tried. */
  readonly passed: readonly string[];
}

/**
 * Resolves when the page goes away: a reload, a close, another site, the back-forward cache. A
 * page that comes back from that cache waits anew. A switch to another tab is no leaving.
 */
let pageGone: Promise<void> = new Promise(() => undefined);
if (typeof window !== "undefined") {
  let go: () => void = () => undefined;
  const arm = () => {
    pageGone = new Promise((resolve) => {
      go = resolve;
    });
  };
  arm();
  window.addEventListener("pagehide", () => {
    go();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) arm();
  });
}

/**
 * Whether a refusal says the part's value is already there: a conflict on each of its fields
 * whose present value is the one the part writes.
 */
function inPlace(part: Change, error: unknown): boolean {
  const problem = problemOf(error);
  if (problem?.code !== "conflict") return false;
  return part.fields.every((field) => {
    const conflict = problem.conflicts.find((c) => c.field === field);
    if (conflict === undefined || !Object.hasOwn(conflict, "value")) return false;
    const there = restoreChange(field, conflict.value);
    return there !== undefined && effectOf(there) === effectOf(part);
  });
}

/** An error the service sent (the generated client's AppError), read by its shape. */
function problemOf(error: unknown): Problem | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, data } = error as Error & { code?: unknown; data?: unknown };
  if (typeof code !== "string") return undefined;
  const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const list = Array.isArray(record["conflicts"]) ? record["conflicts"] : [];
  const conflicts = list.filter(
    (c): c is Conflict =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as Conflict).field === "string" &&
      typeof (c as Conflict).by === "string" &&
      typeof (c as Conflict).at === "string",
  );
  const commit = record["commit"];
  return {
    code,
    cause: typeof record["cause"] === "string" ? record["cause"] : "",
    conflicts,
    ...(typeof commit === "string" && commit !== "" ? { commit } : {}),
    newer: newerOf(record["newer_work"]),
    passed: Array.isArray(record["passed_over"]) ? record["passed_over"].map(String) : [],
  };
}

/** An answer's newer work, read by its shape. */
function newerOf(value: unknown): NewerWorkEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (w): w is NewerWorkEntry =>
      typeof w === "object" &&
      w !== null &&
      typeof (w as NewerWorkEntry).by === "string" &&
      typeof (w as NewerWorkEntry).at === "string",
  );
}

type HistoryResult =
  Awaited<ReturnType<Client["history"]["undo"]>> | Awaited<ReturnType<Client["history"]["redo"]>>;

/**
 * An undo's or redo's receipt as its answer. The commit it moved is its operation's result; the
 * tasks it changed are not in a receipt, so a row in its hold waits for the feed instead.
 */
function historyOf(kind: "undo" | "redo", found: Found): Decision<HistoryResult> | undefined {
  if (found.status !== "applied") return { ok: false, error: receiptError(found) };
  const commit = found.results[0]?.id;
  if (commit === undefined) return undefined;
  const partial = kind === "undo" && (found.conflicts?.length ?? 0) > 0;
  const value = {
    result: kind === "redo" ? "redone" : partial ? "partial" : "undone",
    commit,
    tasks: [],
    task_count: 0,
    as_of: found.as_of,
    ...(found.passed_over === undefined ? {} : { passed_over: found.passed_over }),
    ...(found.newer_work === undefined ? {} : { newer_work: found.newer_work }),
  };
  return { ok: true, value: value as HistoryResult };
}

const AS_OF = /^(\d+)\.(\d+)\.([0-9a-z]+)$/u;

/** The later of two `as_of`s of one authority; the store's when they differ in authority. */
function newer(store: string | undefined, answer: string | undefined): string | undefined {
  if (answer === undefined) return store;
  if (store === undefined) return answer;
  const a = AS_OF.exec(store);
  const b = AS_OF.exec(answer);
  if (a === null || b === null || a[1] !== b[1] || a[3] !== b[3]) return store;
  return Number(b[2]) > Number(a[2]) ? answer : store;
}

/**
 * Whether `base` is of the history the screen shows at `now`: one epoch and incarnation. A base a
 * little ahead of the screen is of it (an answer's as-of comes before the feed applies it).
 */
function sameHistory(base: string, now: string): boolean {
  const a = AS_OF.exec(base);
  const b = AS_OF.exec(now);
  return a !== null && b !== null && a[1] === b[1] && a[3] === b[3];
}

/** A one-field change's effect on the row, the same for one value however it was made. */
const effectOf = (change: Change): string =>
  JSON.stringify([
    Object.entries(change.overlay.set).sort(([a], [b]) => (a < b ? -1 : 1)),
    [...(change.overlay.clear ?? [])].sort(),
  ]);

type Restored = NonNullable<Awaited<ReturnType<Client["task"]["delete"]>>["restored"]>[number];

/** The list a status's open task is in: its own view, or Open for a status of the space's own. */
const STATUS_LIST: Readonly<Record<string, Msg["id"]>> = {
  open: "nav.open",
  waiting: "nav.waiting",
  review: "nav.review",
  backlog: "nav.backlog",
};

/**
 * Where a restored task is back, as its toast says it: the list, its area and project, and why it
 * moved there or which task kept one of its sources.
 */
function backIn(task: Restored): Msg {
  const place: Msg = {
    id:
      task.lifecycle !== "active"
        ? "nav.completed"
        : task.inbox
          ? "nav.inbox"
          : (STATUS_LIST[task.status] ?? "nav.open"),
  };
  const holder = task.held?.[0]?.by;
  if (holder !== undefined) {
    return { id: "toast.restoredHeld", values: { ref: task.ref, place, holder } };
  }
  if (task.regrouped === "inbox") return { id: "toast.restoredInbox", values: { ref: task.ref } };
  const group = [task.area, task.project].filter((name) => name !== undefined).join(" / ");
  if (task.regrouped === "area") {
    return { id: "toast.restoredArea", values: { ref: task.ref, place, group } };
  }
  return group === ""
    ? { id: "toast.restoredIn", values: { ref: task.ref, place } }
    : { id: "toast.restoredInGroup", values: { ref: task.ref, place, group } };
}

/** The key of a task's field in the maps of unsaved edits and others' changes. */
export const keyOf = (task: string, field: string) => `${task}\u0000${field}`;

/** "the due date", "the priority": a field as a toast or a button names it. */
const FIELD_WORDS: Readonly<Record<string, Msg["id"]>> = {
  title: "field.title",
  summary: "field.summary",
  status: "field.status",
  inbox: "field.inbox",
  priority: "field.priority",
  effort: "field.effort",
  due: "field.due",
  waiting_on: "field.waitingOn",
  grouping: "field.grouping",
  focus: "field.focus",
  lifecycle: "field.lifecycle",
  wrap: "field.lifecycle",
};

export const fieldWords = (field: string): Msg["id"] => FIELD_WORDS[field] ?? "field.other";

/**
 * Who changed it, as a message's values: `who` selects the person elsewhere (`user`), an import,
 * or an actor named by its label (`by`).
 */
export const whoOf = (by: string): { who: string; by: string } => ({
  who: by === "user" || by === "import" ? by : "other",
  by,
});

/** A short list as a message: "A", "A and B", "A, B and C", "A, B and 4 more". */
function listText({ shown, more }: ShortList, name: (item: string) => string | Msg): Msg {
  const [a = "", b = "", c = ""] = shown.map(name);
  return { id: "toast.list", values: { count: shown.length + more, a, b, c, rest: more } };
}

/**
 * What Restore mine writes over, as its toast says it (A5 3.12): who changed the one field and
 * when, and for a field whose values read as words, what the person's change wrote, what is there
 * now and what Restore mine puts back. A title's values stay out: a long title does not fit a toast.
 */
function restoreText(conflict: Conflict): Msg {
  const values = {
    ...whoOf(conflict.by),
    field: { id: fieldWords(conflict.field) } as Msg,
    at: Date.parse(conflict.at),
  };
  const shown = (key: "value" | "wrote" | "restore") =>
    Object.hasOwn(conflict, key) ? restoreChange(conflict.field, conflict[key])?.shown : undefined;
  const now = shown("value");
  const wrote = shown("wrote");
  const back = shown("restore");
  if (
    conflict.field === "title" ||
    now === undefined ||
    wrote === undefined ||
    back === undefined
  ) {
    return { id: "toast.conflict", values };
  }
  return { id: "toast.conflictValues", values: { ...values, now, wrote, restore: back } };
}

/**
 * Who changed which tasks since, as the toast of a refused undo or redo, or of a redo that passed
 * over older changes, says it (A5 3.12): the tasks by their numbers and the authors by their names,
 * as the command line says it (newerSaid). With no one else's work, the person's own earlier
 * change holds it back.
 */
function newerValues(work: readonly NewerWorkEntry[]): { who: Msg; tasks: Msg } | undefined {
  if (work.length === 0) return undefined;
  const { who, tasks } = newerSaid(work);
  return {
    who: listText(who, (by) => ({ id: "toast.whoName", values: { by } })),
    tasks: tasks.shown.length === 0 ? { id: "toast.it" } : listText(tasks, (ref) => ref),
  };
}

interface EditOptions {
  readonly base?: string | undefined;
  readonly refused?: (why: Msg) => Msg;
  /**
   * The service holds the change, or this tab keeps it as not saved (a refusal, no answer): the
   * caller's own copy of the words can go.
   */
  readonly settled?: () => void;
}

export class Edits {
  readonly #deps: EditDeps;
  readonly #listeners = new Set<() => void>();
  readonly #toastListeners = new Set<(toast: Toast | undefined) => void>();
  #state: EditState = { unsaved: new Map(), retrying: new Map(), leaving: new Map() };
  /** The newest write's turn per task, until its outcome is known: the next edit waits for it. */
  readonly #chains = new Map<string, Turn>();
  /**
   * Per task and field, the `as_of` of the tab's own newest write of it that changed something:
   * how far a later edit's base may move past what the screen showed (`#baseFor`).
   */
  readonly #own = new Map<string, string>();
  /** The `as_of` of every commit the tab made itself (edits, check-offs, undo, redo). */
  readonly #ownCommits = new Set<string>();
  /** The undo or redo on its way: edits made after it go out after it (`#history`). */
  #gate: Turn | undefined;
  /** The requests whose decision the page has not seen: the feed naming one is news (`Call.heard`). */
  readonly #calls = new Map<string, Call<unknown>>();
  /** Per task and field, the number of the person's newest edit of it: an older one's refusal is moot. */
  readonly #latest = new Map<string, number>();
  #edits = 0;
  /** The commit each redo made, by task reference: a click on a redone row's box undoes it. */
  readonly #redone = new Map<string, string>();
  /** This tab's own request IDs: their feed events are not someone else's change. */
  readonly #mine = new Set<string>();
  /** The fields each own commit wrote, for the undo conflict's choice (A5 3.12). */
  readonly #fieldsOf = new Map<string, readonly string[]>();
  /** The last change to each field by someone else, for an editor that is open. */
  readonly #remote = new Map<string, Remote>();
  /** The timers of the rows that leave, per task. */
  readonly #holds = new Map<string, unknown[]>();
  /**
   * Per task and field, the newest edit of the tab's whose value the screen shows until its write
   * settles, with what it was made against: a newer value behind it is not on the screen.
   */
  readonly #showing = new Map<
    string,
    { readonly number: number; readonly seen: string | undefined }
  >();
  #marks = 0;
  #toasts = 0;
  /** Kept edits let go elsewhere while they are sent again from here: a refusal keeps none. */
  readonly #letGo = new Set<Unsaved>();

  constructor(deps: EditDeps) {
    this.#deps = deps;
    // What waited when the page was last closed or reloaded waits again, each under its fields.
    const restored = new Map<string, Unsaved>();
    for (const unsaved of deps.keeper?.load() ?? []) {
      for (const field of unsaved.change.fields) restored.set(keyOf(unsaved.task, field), unsaved);
    }
    if (restored.size > 0) this.#state = { ...this.#state, unsaved: restored };
    // Let go in another tab or at the foot of the Trash: the line goes here too, if it still shows.
    deps.keeper?.onGone((line) => {
      if (this.unsaved(line.task, line.field) === line) this.#forget(line.task, line.field);
      else if ([...this.#state.retrying.values()].includes(line)) this.#letGo.add(line);
    });
    deps.onChanges(({ changes }) => {
      this.#heard(changes);
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getState = (): EditState => this.#state;

  /** The toast to show; undefined takes it away. One at a time: a new one replaces the old. */
  onToast(listener: (toast: Toast | undefined) => void): () => void {
    this.#toastListeners.add(listener);
    return () => {
      this.#toastListeners.delete(listener);
    };
  }

  unsaved(task: string, field: Field): Unsaved | undefined {
    return this.#state.unsaved.get(keyOf(task, field));
  }

  /** A mark for an editor that opens now: `changedSince` names later changes by others. */
  mark(): number {
    return this.#marks;
  }

  /** Who else changed the field after `mark`, if anyone did. */
  changedSince(task: string, field: Field, mark: number): Remote | undefined {
    const remote = this.#remote.get(keyOf(task, field));
    return remote !== undefined && remote.mark > mark ? remote : undefined;
  }

  /**
   * A person's edit of a task (A5 3.11): shown at once, sent with a base, and on a refusal kept
   * with the person's value. `base` is what the person saw when they chose: an editor's, taken
   * when it opened; a control leaves it out. `refused` says a refusal after what came before it.
   */
  edit(task: TaskRow, change: Change, options: EditOptions = {}): void {
    const { settled } = options;
    void this.#edit(task, change, options).finally(settled);
  }

  /**
   * The base of an edit of the task's fields the person begins now: what the screen shows of them.
   * While an edit of theirs is on its way its value shows, and a newer one behind it does not, so
   * it is what that edit was made against; otherwise the screen's now.
   */
  seen(task: string, fields: readonly Field[]): string | undefined {
    for (const field of fields) {
      const own = this.#showing.get(keyOf(task, field));
      if (own !== undefined) return own.seen;
    }
    return this.#deps.asOf();
  }

  /** Whether a write of the task's is on its way from this tab. */
  sending(task: string): boolean {
    return this.#chains.has(task);
  }

  /** `edit`, resolved once its request is decided, or kept as not saved for want of an answer. */
  #edit(
    task: TaskRow,
    change: Change,
    options: EditOptions,
    retried: readonly Unsaved[] = [],
  ): Promise<void> {
    // A new edit of the field takes the place of a line sent again before it.
    const retrying = new Map(this.#state.retrying);
    for (const field of change.fields) {
      const key = keyOf(task.id, field);
      const sending = retrying.get(key);
      if (sending !== undefined && !retried.includes(sending)) retrying.delete(key);
    }
    if (retrying.size !== this.#state.retrying.size) this.#set({ ...this.#state, retrying });
    for (const field of change.fields) this.#forget(task.id, field);
    this.#edits += 1;
    const number = this.#edits;
    for (const field of change.fields) this.#latest.set(keyOf(task.id, field), number);
    // What the person saw: the editor's base, or what the screen shows of the fields now.
    const seen = options.base ?? this.seen(task.id, change.fields);
    const sent = this.#send(task.id, change, seen);
    for (const field of change.fields) this.#showing.set(keyOf(task.id, field), { number, seen });
    const shown = () => {
      for (const field of change.fields) {
        const key = keyOf(task.id, field);
        if (this.#showing.get(key)?.number === number) this.#showing.delete(key);
      }
    };
    void sent.settled.then(shown, shown);
    const saved: Omit<Toast, "key"> = {
      kind: "undo",
      text: change.said,
      action: {
        label: { id: "toast.undo" },
        run: () => {
          void this.undo(sent);
        },
      },
    };
    const toast = this.#toast(saved);
    void sent.commit.then((commit) => {
      if (commit !== undefined) this.#fieldsOf.set(commit, change.fields);
    });
    // The parts kept for want of an answer, each with its line: a later decision settles only the
    // ones still showing it, so a part the person edited, applied or discarded since stays theirs.
    let interim: ReadonlyMap<Change, Unsaved> = new Map();
    const stillShown = () =>
      [...interim]
        .filter(([part, line]) => this.unsaved(task.id, part.fields[0] ?? "title") === line)
        .map(([part]) => part);
    return this.#outcome(
      sent.answer,
      sent.call,
      (decision, say, late) => {
        if (decision.ok) {
          // Saved after all (a late answer, or the feed named it): the parts still waiting go.
          if (late) {
            for (const part of stillShown()) this.#forget(task.id, part.fields[0] ?? "title");
          }
          // Nothing changed (the value was already so): there is nothing to undo.
          if ((decision.value as { result?: unknown }).result === "no_change") say(undefined);
          else if (late) say(saved);
          return;
        }
        // Kept part by part: a part whose field the person edited again since gives way to that
        // newer choice, and the others still wait for the person.
        const waiting = late
          ? stillShown()
          : (change.parts ?? [change]).filter((part) =>
              part.fields.every((field) => this.#latest.get(keyOf(task.id, field)) === number),
            );
        // A conflict with the person's own value (saved after all, before a reload or from
        // another tab) is no conflict: that part is saved.
        const there = waiting.filter((part) => inPlace(part, decision.error));
        if (late) for (const part of there) this.#forget(task.id, part.fields[0] ?? "title");
        const kept = waiting.filter((part) => !there.includes(part));
        if (kept.length > 0) {
          interim = this.#refused(
            task,
            kept,
            seen,
            decision.error,
            (toast) => {
              say(
                toast === undefined || options.refused === undefined
                  ? toast
                  : { ...toast, text: options.refused(toast.text) },
              );
            },
            retried,
          );
        } else if (late || there.length > 0) say(undefined);
      },
      toast,
    );
  }

  /**
   * Whether a kept edit was made against a history the screen no longer shows: its base is of
   * another history (the space was restored since), or a failed edit has none (kept by an earlier
   * build). No base makes sending it again an informed choice, so it is not sent:
   * its value can be copied or discarded.
   */
  restored(unsaved: Unsaved): boolean {
    if (unsaved.base === undefined) return unsaved.reason === "failed";
    const now = this.#deps.asOf();
    return now !== undefined && !sameHistory(unsaved.base, now);
  }

  /** "Apply mine" or "Try again": this tab's kept value of the field, sent again (`#again`). */
  apply(task: string, field: Field): void {
    const unsaved = this.unsaved(task, field);
    if (unsaved === undefined || this.restored(unsaved)) return;
    this.#again({ id: unsaved.task, ref: unsaved.ref }, unsaved.change, [unsaved]);
  }

  /** Whether a kept edit of this tab's is on its way: sent again and not decided yet. */
  sendingKept(id: string): boolean {
    return [...this.#state.retrying.values()].some((line) => line.id === id);
  }

  /**
   * Kept values sent again: after a conflict (Apply mine) over the other value the screen shows
   * now; after a failure (Try again) with the base the person made it at. The lines move to
   * the ones on their way, so the browser keeps them as they are until the request is decided,
   * and then lets go of only what it still holds of them: another tab's newer value stays.
   */
  #again(task: Pick<TaskRow, "id" | "ref">, change: Change, lines: readonly Unsaved[]): void {
    const row = this.#deps.rowOf(task.ref) ?? ({ ...task } as TaskRow);
    const kept = lines[0];
    const base = kept?.reason === "failed" ? kept.base : undefined;
    const keys = lines.flatMap((line) =>
      line.change.fields.map((field) => [keyOf(line.task, field), line] as const),
    );
    this.#set({ ...this.#state, retrying: new Map([...this.#state.retrying, ...keys]) });
    const decided = this.#edit(row, change, base === undefined ? {} : { base }, lines);
    void decided.then(() => {
      const retrying = new Map(this.#state.retrying);
      for (const [key, line] of keys) if (retrying.get(key) === line) retrying.delete(key);
      for (const line of lines) this.#letGo.delete(line);
      this.#set({ ...this.#state, retrying });
    });
  }

  /** The person keeps the other value: their own goes. */
  dismiss(task: string, field: Field): void {
    this.#forget(task, field);
  }

  /**
   * Check-off (D12, A5 3.12): final at once, no model. The row stays checked and struck through
   * for the hold, then collapses; the toast's Undo names the commit.
   */
  checkOff(task: TaskRow): void {
    const entry = this.#state.leaving.get(task.id);
    if (entry?.done === true) return;
    // Checked again after its undo: the row that waited to come back holds again.
    if (entry !== undefined) this.#drop(task.id);
    this.#leave(task, {});
    const sent = this.#sendWith(task.id, ["lifecycle"], this.#deps.asOf(), (base, request) =>
      this.#deps.client.task.finish({ task: task.id, base: base ?? "", request_id: request }),
    );
    this.#checks.set(task.id, sent);
    const done: Omit<Toast, "key"> = {
      kind: "undo",
      text: { id: "toast.done" },
      action: {
        label: { id: "toast.undo" },
        run: () => {
          void this.undo(sent);
        },
      },
    };
    const toast = this.#toast(done);
    void sent.commit.then((commit) => {
      if (commit !== undefined) this.#fieldsOf.set(commit, ["lifecycle", "wrap"]);
    });
    void this.#outcome(
      sent.answer,
      sent.call,
      (decision, say, late) => {
        // Done after all: the feed takes the row away, and the toast offers its Undo again.
        if (decision.ok) {
          if (late) say(done);
          return;
        }
        // The row came back when no answer came; a hold since is the person's new check-off.
        if (!late) this.#drop(task.id);
        if (this.#deps.failed(decision.error)) return;
        const conflict = problemOf(decision.error)?.conflicts[0];
        say({
          kind: "error",
          text:
            readOnlyText(decision.error) ??
            (conflict === undefined
              ? { id: "toast.checkFailed" }
              : { id: "toast.checkConflict", values: whoOf(conflict.by) }),
        });
      },
      toast,
    );
  }

  /**
   * Reopen a finished task (the facts' Reopen): one action, with a base, and an Undo that
   * finishes it again by its own commit. Its earlier outcome and learnings stay with it.
   */
  reopen(task: TaskRow): void {
    const sent = this.#sendWith(task.id, ["lifecycle"], this.#deps.asOf(), (base, request) =>
      this.#deps.client.task.reopen({
        task: task.id,
        base: base ?? "",
        request_id: request,
      }),
    );
    const reopened: Omit<Toast, "key"> = {
      kind: "undo",
      text: { id: "toast.reopened" },
      action: {
        label: { id: "toast.undo" },
        run: () => {
          void this.undo(sent);
        },
      },
    };
    const toast = this.#toast(reopened);
    void sent.commit.then((commit) => {
      if (commit !== undefined) this.#fieldsOf.set(commit, ["lifecycle"]);
    });
    void this.#outcome(
      sent.answer,
      sent.call,
      (decision, say, late) => {
        if (decision.ok) {
          if (decision.value.result === "no_change") say(undefined);
          else if (late) say(reopened);
          return;
        }
        if (this.#deps.failed(decision.error)) return;
        const conflict = problemOf(decision.error)?.conflicts[0];
        say({
          kind: "error",
          text:
            readOnlyText(decision.error) ??
            (conflict === undefined
              ? { id: "toast.reopenFailed" }
              : { id: "toast.reopenConflict", values: whoOf(conflict.by) }),
        });
      },
      toast,
    );
  }

  /**
   * Move to Trash (the card's button): in the task's turn, so this tab's edit of it still on its
   * way lands first, with a base, and an Undo that takes back this change and no other. A run that
   * works on the task goes on: the toast says so.
   */
  trash(task: TaskRow): void {
    const sent = this.#sendWith(task.id, ["deleted"], this.#deps.asOf(), (base, request) =>
      this.#deps.client.task.delete({ tasks: [task.id], base: base ?? "", request_id: request }),
    );
    const moved: Omit<Toast, "key"> = {
      kind: "undo",
      text: {
        id: task.run?.state === "working" ? "toast.trashedWorking" : "toast.trashed",
        values: { ref: task.ref },
      },
      action: {
        label: { id: "toast.undo" },
        run: () => {
          void this.undo(sent);
        },
      },
    };
    const toast = this.#toast(moved);
    void sent.commit.then((commit) => {
      if (commit !== undefined) this.#fieldsOf.set(commit, ["deleted"]);
    });
    void this.#outcome(
      sent.answer,
      sent.call,
      (decision, say, late) => {
        if (decision.ok) {
          if (decision.value.result === "no_change") say(undefined);
          else if (late) say(moved);
          return;
        }
        if (this.#deps.failed(decision.error)) return;
        // Someone changed the task since the person looked: nothing moved, and the card shows the
        // task as it is now, with Move to Trash.
        const conflict = problemOf(decision.error)?.conflicts[0];
        say({
          kind: "error",
          text:
            readOnlyText(decision.error) ??
            (conflict === undefined
              ? { id: "toast.trashFailed", values: { ref: task.ref } }
              : { id: "toast.trashConflict", values: { ref: task.ref, ...whoOf(conflict.by) } }),
        });
      },
      toast,
    );
  }

  /**
   * Restore from the Trash: one action, with a base, and an Undo that moves it back by its own
   * commit. The toast names where it is back, once the service said.
   */
  restore(task: Pick<TaskRow, "id" | "ref">): void {
    const sent = this.#sendWith(task.id, ["deleted"], this.#deps.asOf(), (base, request) =>
      this.#deps.client.task.delete({
        tasks: [task.id],
        restore: true,
        base: base ?? "",
        request_id: request,
      }),
    );
    const undo = {
      label: { id: "toast.undo" },
      run: () => {
        void this.undo(sent);
      },
    } as const;
    const toast = this.#toast({
      kind: "undo",
      text: { id: "toast.restoredTask", values: { ref: task.ref } },
      action: undo,
    });
    void sent.commit.then((commit) => {
      if (commit !== undefined) this.#fieldsOf.set(commit, ["deleted"]);
    });
    void this.#outcome(
      sent.answer,
      sent.call,
      (decision, say) => {
        if (decision.ok) {
          const value = decision.value;
          if (value.result === "no_change") {
            say({ kind: "info", text: { id: "toast.restoredAlready", values: { ref: task.ref } } });
            return;
          }
          const back = "restored" in value ? value.restored?.[0] : undefined;
          say({
            kind: "undo",
            text:
              back === undefined
                ? { id: "toast.restoredTask", values: { ref: task.ref } }
                : backIn(back),
            action: undo,
          });
          return;
        }
        if (this.#deps.failed(decision.error)) return;
        say({
          kind: "error",
          text: readOnlyText(decision.error) ?? {
            id: "toast.restoreFailed",
            values: { ref: task.ref },
          },
        });
      },
      toast,
    );
  }

  /**
   * The person sets aside the questions agents asked on a task without answering them: one
   * action, gone from the row at once, and an Undo that brings them back. It names `newest`, the
   * newest question the row showed: one asked after it still waits. The service decides the mark
   * from its own read and never moves it back, so it needs no base: another tab's dismissal in
   * between is no conflict.
   */
  dismissQuestions(task: TaskRow, newest: string): void {
    const count = questionsWaiting(task);
    const sent = this.#sendWith(
      task.id,
      ["reviewed_at"],
      undefined,
      (_base, request) =>
        this.#deps.client.task.update({
          task: task.id,
          set: { reviewed: newest },
          request_id: request,
        }),
      { tasks: [{ id: task.id, set: {}, clear: ["questions", "questions_more"] }] },
    );
    const dismissed: Omit<Toast, "key"> = {
      kind: "undo",
      text: { id: "toast.questionDismissed", values: { count } },
      action: {
        label: { id: "toast.undo" },
        run: () => {
          void this.undo(sent);
        },
      },
    };
    const toast = this.#toast(dismissed);
    void sent.commit.then((commit) => {
      if (commit !== undefined) this.#fieldsOf.set(commit, ["reviewed_at"]);
    });
    void this.#outcome(
      sent.answer,
      sent.call,
      (decision, say, late) => {
        if (decision.ok) {
          if (late) say(dismissed);
          return;
        }
        if (this.#deps.failed(decision.error)) return;
        say({ kind: "error", text: { id: "toast.dismissFailed", values: { count } } });
      },
      toast,
    );
  }

  /** The check-offs of this tab still in their hold, with their writes. */
  readonly #checks = new Map<string, Named>();

  /**
   * The box clicked again during the hold: the check-off is undone, by its commit, or for a redone
   * check-off by the redo's commit. Never the person's newest change unnamed: that may be another
   * task's edit. A hold whose commit the tab does not know says so and changes nothing.
   */
  uncheck(task: string): void {
    const leaving = this.#state.leaving.get(task);
    if (leaving === undefined || !leaving.done || leaving.by !== undefined) return;
    const named = this.#checks.get(task) ?? this.#redone.get(leaving.row.ref);
    if (named === undefined) {
      this.#toast({ kind: "info", text: { id: "toast.undoUnknown" } });
      return;
    }
    void this.undo(named);
  }

  /** Whether a feed event is one of this tab's own writes. */
  isMine(request: string): boolean {
    return this.#mine.has(request);
  }

  /**
   * A task the view shows was completed by a write the tab did not hold yet (A5 3.12): another
   * actor's (it strikes through, says who, and leaves after the hold), or the tab's own redo.
   */
  hold(row: TaskRow, by: string | undefined, at: number): void {
    const entry = this.#state.leaving.get(row.id);
    if (entry?.done === true) return;
    // A row back from an undo that is completed again (a redo) holds again, checked.
    if (entry !== undefined) this.#drop(row.id);
    this.#leave(row, by === undefined ? {} : { by, at });
  }

  /**
   * Undo (A5 3.12): the person's newest change, or the one a toast names. It takes its place in
   * the queue at once, when the person acts, and a toast's write's commit is resolved there. A
   * commit the page cannot learn (the write was refused) is not guessed: the person uses Ctrl+Z.
   */
  undo(commit?: Named, partial = false): Promise<void> {
    const asked: { commit?: string } = {};
    const { answer, call } = this.#history("undo", commit, partial, asked);
    return this.#outcome(answer, call, (decision, say) => {
      if (!decision.ok) {
        if (decision.error instanceof UnknownCommit) {
          say({ kind: "info", text: { id: "toast.undoUnknown" } });
        } else {
          this.#historyFailed("undo", decision.error, asked.commit, say);
        }
        return;
      }
      const result = decision.value;
      this.#undone(result.tasks ?? [], true);
      say({
        kind: "undo",
        text: { id: result.result === "partial" ? "toast.undoneRest" : "toast.undone" },
        action: {
          label: { id: "toast.redo" },
          run: () => {
            void this.redo(result.commit);
          },
        },
      });
    });
  }

  redo(commit?: string): Promise<void> {
    const { answer, call } = this.#history("redo", commit, false);
    return this.#outcome(answer, call, (decision, say) => {
      if (!decision.ok) {
        this.#historyFailed("redo", decision.error, commit, say);
        return;
      }
      const result = decision.value;
      for (const ref of result.tasks ?? []) this.#redone.set(ref, result.commit);
      this.#undone(result.tasks ?? [], false);
      // Older changes it passed over stay for the next Redo: who changed which tasks since.
      const passed = (result as { passed_over?: readonly string[] }).passed_over ?? [];
      const newer = newerValues(newerOf(result.newer_work));
      say({
        kind: "undo",
        text:
          passed.length === 0
            ? { id: "toast.redone" }
            : newer === undefined
              ? { id: "toast.redonePassedOwn" }
              : { id: "toast.redonePassed", values: newer },
        action: {
          label: { id: "toast.undo" },
          run: () => {
            void this.undo(result.commit);
          },
        },
      });
    });
  }

  /**
   * A person's write that is no field of one task (a new project, a folder): in turn after the
   * writes already on their way, and before any made after it. Once it changed something, its
   * toast says `said` and its Undo names its own commit; Ctrl+Z takes it back as the newest change.
   * The caller reads the answer, a refusal included, and says what a refusal means. Its base is
   * `base`, what a dialog showed when it opened, or else the screen's now, moved past the tab's own
   * commits since. When the answer was lost and its receipt decided it, the caller gets only the
   * receipt's word (`WriteReceipt`).
   */
  write<T extends { as_of?: string; result?: unknown }>(
    send: (request: string, base: string | undefined) => Promise<T>,
    said: (value: T | WriteReceipt) => Msg | undefined,
    options: { readonly base?: string | undefined } = {},
  ): Promise<T | WriteReceipt> {
    const seen = options.base ?? this.#deps.asOf();
    const ahead = allOf(this.#ahead());
    const { turn, made } = this.#turn<T | WriteReceipt>(ahead);
    const sent = this.#deps.write(async (request) => {
      try {
        if (!(await ahead.wait())) throw new NotSent();
        // The same base for a second send with the same request ID: one intent, sent again.
        const base = this.#ownRun(seen);
        const one = this.#call<T | WriteReceipt>(
          request,
          () => send(request, base),
          (found) => {
            const decided = writeOf(found);
            return decided.ok
              ? { ok: true, value: { ...decided.value, receipt: true as const } }
              : decided;
          },
          (result) => {
            // `as_of` of an answer that wrote nothing is only the head, which may be another's.
            if (typeof result.as_of === "string" && !WROTE_NOTHING.has(String(result.result))) {
              this.#ownCommits.add(result.as_of);
            }
          },
        );
        made(one);
        return await one.answer;
      } catch (error) {
        made(undefined);
        throw error;
      }
    });
    this.#mine.add(sent.request);
    this.#gate = turn;
    this.#release(sent.answer, () => {
      if (this.#gate === turn) this.#gate = undefined;
    });
    return sent.answer.then((value) => {
      // A write that changed nothing has nothing to undo.
      const text = WROTE_NOTHING.has(String(value.result)) ? undefined : said(value);
      if (text !== undefined) {
        this.#toast({
          kind: "undo",
          text,
          action: {
            label: { id: "toast.undo" },
            run: () => {
              void this.undo(sent);
            },
          },
        });
      }
      return value;
    });
  }

  // -------------------------------------------------------------------------------------------

  /**
   * An undo or redo, in the order the person asked: after the edits already on their way (Ctrl+Z
   * takes back the newest of them, never one before it while the newest is still to be sent), and
   * before any edit made after it, which waits for it (`#sendWith`), so an unnamed undo never takes
   * back a change the person made after pressing it.
   */
  #history(
    kind: "undo" | "redo",
    commit: Named | undefined,
    partial: boolean,
    asked: { commit?: string } = {},
  ): { answer: Promise<HistoryResult>; call: Carried<HistoryResult> } {
    const ahead = allOf(this.#ahead());
    const { turn, made, call: carried } = this.#turn<HistoryResult>(ahead);
    const run = (async (): Promise<HistoryResult> => {
      try {
        // Behind a request whose outcome is unknown, an unnamed undo could take back the wrong
        // change: nothing is sent.
        if (!(await ahead.wait())) throw new NotSent();
        const named = await this.#commitOf(commit);
        if (commit !== undefined && named === undefined) throw new UnknownCommit();
        if (named !== undefined) asked.commit = named;
        const request = this.#deps.newRequest();
        this.#mine.add(request);
        const input = {
          ...(named === undefined ? {} : { commit: named }),
          request_id: request,
        };
        const call = this.#call<HistoryResult>(
          request,
          (): Promise<HistoryResult> =>
            kind === "undo"
              ? this.#deps.client.history.undo({ ...input, ...(partial ? { partial: true } : {}) })
              : this.#deps.client.history.redo(input),
          (found) => historyOf(kind, found),
          (result) => {
            this.#ownCommits.add(result.as_of);
          },
        );
        made(call);
        return await call.answer;
      } catch (error) {
        made(undefined);
        throw error;
      }
    })();
    this.#gate = turn;
    this.#release(run, () => {
      if (this.#gate === turn) this.#gate = undefined;
    });
    return { answer: run, call: carried };
  }

  /** What an undo or redo waits for: every task's newest write, and the undo or redo before it. */
  #ahead(): Turn[] {
    return [...this.#chains.values(), ...(this.#gate === undefined ? [] : [this.#gate])];
  }

  /**
   * A place in the queue behind `ahead`, for a request made once `ahead` is known: its call's
   * outcome, or, when nothing was sent, `ahead`'s again.
   */
  #turn<T>(ahead: Turn): {
    turn: Turn;
    made: (call: Call<T> | undefined) => void;
    call: Promise<Call<T> | undefined>;
  } {
    let made!: (call: Call<T> | undefined) => void;
    const call = new Promise<Call<T> | undefined>((resolve) => {
      made = resolve;
    });
    const turn: Turn = {
      wait: async () => {
        const sent = await call;
        return sent === undefined ? ahead.wait() : sent.wait();
      },
    };
    return { turn, made, call };
  }

  /** Runs `free` once `answer` has an outcome; a request whose outcome is unknown keeps its place. */
  #release(answer: Promise<unknown>, free: () => void): void {
    answer.then(free, (error: unknown) => {
      if (!(error instanceof Unanswered) && !(error instanceof NotSent)) free();
    });
  }

  /**
   * A request's outcome, the one place that acts on it (A5 3.11 "No request holds the queue").
   * `settle` runs once for `answer`: the decision, or, when no answer came (`Unanswered`), the
   * interim outcome the person sees as not saved. A decision that comes after that interim runs
   * `settle` once more (`late`), and only then: `Call` decides once, so a second answer or receipt
   * of the same request changes nothing. The late run reconciles against what the page showed:
   * its toast replaces the interim one only while that is still the one shown (the person has moved
   * on otherwise), and `settle` keeps what the person did since. `shown` is a toast shown before
   * the answer (an edit's Undo). Resolves once the first run is done.
   */
  #outcome<T>(
    answer: Promise<T>,
    call: Carried<T>,
    settle: (decision: Decision<T>, say: Say, late: boolean) => void,
    shown?: Toast,
  ): Promise<void> {
    let current = shown;
    const sayer =
      (late: boolean): Say =>
      (toast) => {
        const showing = current !== undefined && current.key === this.#toasts;
        if (toast === undefined) {
          if (showing && current !== undefined) this.#untoast(current);
          return;
        }
        if (late && !showing) return;
        current = this.#toast(toast);
      };
    return answer.then(
      (value) => {
        settle({ ok: true, value }, sayer(false), false);
      },
      (error: unknown) => {
        settle({ ok: false, error }, sayer(false), false);
        if (!(error instanceof Unanswered)) return;
        void call.then(async (sent) => {
          const decision = await sent?.decided;
          if (decision !== undefined) settle(decision, sayer(true), true);
        });
      },
    );
  }

  /**
   * One request through `Call`: its answer, else its outcome by its ID (calls.ts). `note` reads the
   * decided success once, before anything that waits for the request goes on, so a later base can
   * move past it; a later answer or receipt of the same request is not read again.
   */
  #call<T>(
    request: string,
    post: () => Promise<T>,
    fromReceipt: (found: Found) => Decision<T> | undefined,
    note: (value: T) => void,
  ): Call<T> {
    const call = new Call<T>(
      {
        receipt: (id) => this.#deps.client.receipt.get({ request: id }),
        timers: this.#timers,
        decided: (error) => this.#decided(error),
        alive: () => this.#deps.alive?.() ?? true,
      },
      request,
      post,
      fromReceipt,
      (decision) => {
        if (decision.ok) note(decision.value);
      },
    );
    this.#calls.set(request, call as Call<unknown>);
    void call.decided.then(() => {
      this.#calls.delete(request);
    });
    return call;
  }

  /** Whether an error carries the service's decision (or the page's state says what happened). */
  #decided(error: unknown): boolean {
    if (this.#deps.failed(error)) return true;
    const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
    return typeof code === "string" && !UNDECIDED.has(code);
  }

  /**
   * The commit an undo names, in its turn: a string as it is; a toast's write's from the feed, else
   * from the write's receipt (the feed did not name it in time, or a fresh snapshot covered it).
   */
  async #commitOf(named: Named | undefined): Promise<string | undefined> {
    if (named === undefined || typeof named === "string") return named;
    const fromFeed = await this.#within(named.commit);
    if (fromFeed !== undefined) return fromFeed;
    try {
      const receipt = await this.#within(this.#deps.client.receipt.get({ request: named.request }));
      return receipt?.found === true ? receipt.commit : undefined;
    } catch {
      return undefined;
    }
  }

  /** `promise`'s value, or undefined after `ASK_MS`. */
  async #within<T>(promise: Promise<T>): Promise<T | undefined> {
    let handle: unknown;
    const timeout = new Promise<undefined>((resolve) => {
      handle = this.#timers.set(() => {
        resolve(undefined);
      }, ASK_MS);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      this.#timers.clear(handle);
    }
  }

  /**
   * An undo or redo the service refused. A conflict says who changed which tasks since and offers
   * the one action that fits (A5 3.12): "Restore mine" when it would write one field of one
   * change, which its toast names with the values, "Undo the rest" when only some of an undo's
   * fields conflict. Anything wider the person settles on the task: one click never writes over
   * several changes of others. A redo has no partial form.
   */
  #historyFailed(
    kind: "undo" | "redo",
    error: unknown,
    asked: string | undefined,
    say: Say = (toast) => {
      if (toast !== undefined) say(toast);
    },
  ): void {
    if (this.#deps.failed(error)) return;
    const problem = problemOf(error);
    const readOnly = readOnlyText(error);
    if (problem === undefined || readOnly !== undefined) {
      say({ kind: "error", text: readOnly ?? { id: "toast.undoFailed" } });
      return;
    }
    // The commit it met, named: Restore mine and Undo the rest act on that one only, never on
    // whatever is newest by the time the person chooses (a change made since in another window).
    const commit = asked ?? problem.commit;
    switch (problem.cause) {
      case "NOTHING_TO_UNDO":
        say({ kind: "info", text: { id: "toast.nothingToUndo" } });
        return;
      case "NOTHING_TO_REDO":
        say({ kind: "info", text: { id: "toast.nothingToRedo" } });
        return;
      case "INVALID_TRANSITION":
        say({ kind: "info", text: { id: "toast.newerFirst" } });
        return;
      // The named change is not in the space now: nothing was undone, whatever is newest.
      case "NOT_FOUND":
        say({ kind: "info", text: { id: "toast.undoGone" } });
        return;
      case "UNDO_CONFLICT":
        break;
      default:
        say({ kind: "error", text: { id: "toast.undoFailed" } });
        return;
    }
    const conflicts = problem.conflicts;
    const first = conflicts[0];
    if (first === undefined) {
      say({ kind: "error", text: { id: "toast.undoFailed" } });
      return;
    }
    const fields = new Set(conflicts.map((c) => c.field));
    const one = conflicts.length === 1 && problem.passed.length <= 1;
    const restore = one ? this.#restoreOf(conflicts) : undefined;
    const known = commit === undefined ? undefined : this.#fieldsOf.get(commit);
    // Only some of the change's fields conflict: the rest can be undone and the others kept.
    const some = kind === "undo" && known !== undefined && known.some((f) => !fields.has(f));
    const newer = newerValues(problem.newer);
    const text: Msg =
      newer === undefined
        ? { id: "toast.notDoneOwn", values: { kind } }
        : { id: "toast.notDone", values: { kind, ...newer } };
    // Undo the rest, for a commit the page can name: the fields that pass are undone, the others
    // stay as the other actor set them.
    const undoRest =
      kind === "undo" && commit !== undefined
        ? {
            action: {
              label: { id: "toast.undoRest" } as Msg,
              run: () => {
                void this.undo(commit, true);
              },
            },
          }
        : {};
    if (some || restore === undefined) {
      // Or nothing a hand edit can put back (a lifecycle, a due time): the person decides.
      say({ kind: "error", text, ...undoRest });
      return;
    }
    say({
      kind: "error",
      text: restoreText(first),
      action: {
        label: { id: "toast.restoreMine" },
        run: () => {
          void this.#restore(kind, restore, commit);
        },
      },
    });
  }

  /** Each task's restorable values as one edit, or undefined when any field cannot be restored. */
  #restoreOf(conflicts: readonly Conflict[]): Map<string, Change> | undefined {
    const byTask = new Map<string, Change[]>();
    for (const conflict of conflicts) {
      // A child row (a note, a link) or a task the conflict does not name: no hand edit for it.
      if (conflict.task === undefined || conflict.entity !== undefined) return undefined;
      if (!Object.hasOwn(conflict, "restore")) return undefined;
      const change = restoreChange(conflict.field, conflict.restore);
      if (change === undefined) return undefined;
      const list = byTask.get(conflict.task) ?? [];
      list.push(change);
      byTask.set(conflict.task, list);
    }
    const out = new Map<string, Change>();
    for (const [task, list] of byTask) {
      const joined = joinChanges(list);
      if (joined === undefined) return undefined;
      out.set(task, joined);
    }
    return out;
  }

  /**
   * "Restore mine" (A5 3.12): the person's values as a new edit of theirs, with a fresh base. After
   * an undo, the change is first undone as far as it can be (a partial undo), so the stack moves on
   * past it and the next Ctrl+Z reaches the change below, not this conflict again. Only for a
   * commit it can name: unnamed, a partial undo could take a newer change instead.
   */
  #restore(
    kind: "undo" | "redo",
    restore: ReadonlyMap<string, Change>,
    commit: string | undefined,
  ): Promise<void> {
    const put = (base: string | undefined) => {
      for (const [ref, change] of restore) {
        const row = this.#deps.rowOf(ref);
        const fresh = newer(this.#deps.asOf(), base);
        this.edit(
          row ?? ({ id: ref, ref } as TaskRow),
          change,
          fresh === undefined ? {} : { base: fresh },
        );
      }
    };
    if (kind !== "undo" || commit === undefined) {
      put(undefined);
      return Promise.resolve();
    }
    // A partial undo decided late still puts the values back: the person chose it, and each edit
    // carries its base, so nothing changed since is overwritten.
    const { answer, call } = this.#history("undo", commit, true);
    return this.#outcome(answer, call, (decision, say) => {
      if (decision.ok) put(decision.value.as_of);
      else this.#historyFailed("undo", decision.error, commit, say);
    });
  }

  /** Sends one `task.update` after the task's earlier writes have answered. */
  #send(task: string, change: Change, seen: string | undefined): Write<unknown> {
    const { set, clear } = change.overlay;
    return this.#sendWith(
      task,
      change.fields,
      seen,
      (base, request) =>
        this.#deps.client.task.update({
          task,
          ...(change.set === undefined ? {} : { set: change.set }),
          ...(change.clear === undefined ? {} : { clear: [...change.clear] }),
          ...(base === undefined ? {} : { base }),
          request_id: request,
        }),
      { tasks: [{ id: task, set, ...(clear === undefined ? {} : { clear }) }] },
    );
  }

  /**
   * The base of an edit of `fields` the person made seeing `seen`: the later of two points, each
   * of which nobody else wrote those fields after.
   * - The end of the run of the tab's own commits that directly follow `seen` (seq + 1, + 2, ...):
   *   every commit in between is the tab's, so nobody else wrote anything.
   * - The tab's own newest write of those fields, when one commit wrote them all: that write
   *   passed its own base check, so nobody else wrote them between what the person saw and it.
   * Otherwise it stays `seen`, so a change the person did not see is a conflict, never overwritten.
   */
  #baseFor(task: string, fields: readonly string[], seen: string | undefined): string | undefined {
    return newer(this.#ownRun(seen), this.#ownWrite(task, fields));
  }

  #ownRun(seen: string | undefined): string | undefined {
    const parts = seen === undefined ? null : AS_OF.exec(seen);
    if (parts === null) return seen;
    const [, epoch, seq, tag] = parts;
    let at = Number(seq);
    while (this.#ownCommits.has(`${String(epoch)}.${String(at + 1)}.${String(tag)}`)) at += 1;
    return `${String(epoch)}.${String(at)}.${String(tag)}`;
  }

  #ownWrite(task: string, fields: readonly string[]): string | undefined {
    let own: string | undefined;
    for (const field of fields) {
      const at = this.#own.get(keyOf(task, field));
      if (at === undefined || (own !== undefined && at !== own)) return undefined;
      own = at;
    }
    return own;
  }

  /**
   * A write of one task through the store, in turn after the task's earlier writes. `call` gets the
   * base (`#baseFor`, decided when it is sent) and the store's request ID.
   */
  #sendWith<T extends { as_of?: string; result?: unknown }>(
    task: string,
    fields: readonly string[],
    seen: string | undefined,
    call: (base: string | undefined, request: string) => Promise<T>,
    overlay?: Overlay,
  ): Write<T> {
    // Sent once the task's earlier writes and any undo or redo before it have their outcome.
    const waits = [this.#chains.get(task), this.#gate].filter((turn) => turn !== undefined);
    const ahead = allOf(waits);
    const { turn, made, call: mine } = this.#turn<T>(ahead);
    const note = (result: T) => {
      // A write that changed nothing wrote no field: its `as_of` is only the head.
      if (typeof result.as_of !== "string" || result.result === "no_change") return;
      this.#ownCommits.add(result.as_of);
      // The task's writes answer in turn, so this is its newest.
      for (const field of fields) this.#own.set(keyOf(task, field), result.as_of);
    };
    const sent = this.#deps.write(async (request) => {
      try {
        // The page going away ends the wait as not sent: the edit is kept as not saved and offered
        // after the reload. Sent now, it could arrive before the edit it waits for.
        if (waits.length > 0) {
          const gone = (this.#deps.leaving ?? (() => pageGone))().then(() => false);
          if (!(await Promise.race([ahead.wait(), gone]))) throw new NotSent();
        }
        // The same base for a second send with the same request ID: one intent, sent again.
        const base = this.#baseFor(task, fields, seen);
        const one = this.#call(
          request,
          () => call(base, request),
          (found) => writeOf(found) as Decision<T>,
          note,
        );
        made(one);
        return await one.answer;
      } catch (error) {
        made(undefined);
        throw error;
      }
    }, overlay);
    this.#mine.add(sent.request);
    this.#chains.set(task, turn);
    this.#release(sent.answer, () => {
      if (this.#chains.get(task) === turn) this.#chains.delete(task);
    });
    return { ...sent, call: mine };
  }

  /**
   * Keeps refused parts as not saved and says so; returns each part's line. A part of a kept edit
   * sent again (`retried`) stays that edit, with its ID and the base it was made at.
   */
  #refused(
    task: TaskRow,
    parts: readonly Change[],
    seen: string | undefined,
    error: unknown,
    say: Say,
    retried: readonly Unsaved[] = [],
  ): ReadonlyMap<Change, Unsaved> {
    const signedOut = this.#deps.failed(error);
    const problem = problemOf(error);
    const conflictOf = (change: Change) =>
      problem?.code === "conflict"
        ? (problem.conflicts.find((c) => change.fields.some((f) => f === c.field)) ??
          problem.conflicts[0])
        : undefined;
    // Each part under each field it writes: the control of any of them shows it, and a newer edit
    // of one field drops only its own part.
    const next = new Map(this.#state.unsaved);
    const lines = new Map<Change, Unsaved>();
    const sentAgain = (change: Change) =>
      retried.find((line) => line.change.fields.some((f) => change.fields.includes(f)));
    // Discarded elsewhere while it was on its way: the person let those words go.
    const discarded = (change: Change) => {
      const before = sentAgain(change);
      return before !== undefined && this.#letGo.has(before);
    };
    if (parts.length > 0 && parts.every(discarded)) {
      say(undefined);
      return lines;
    }
    parts = parts.filter((change) => !discarded(change));
    for (const change of parts) {
      const conflict = conflictOf(change);
      const before = sentAgain(change);
      const base = before === undefined ? seen : before.base;
      const unsaved: Unsaved = {
        id: before?.id ?? crypto.randomUUID(),
        task: task.id,
        ref: task.ref,
        field: change.fields[0] ?? "title",
        change,
        reason: conflict === undefined ? "failed" : "conflict",
        ...(base === undefined ? {} : { base }),
        ...(conflict === undefined ? {} : { by: conflict.by, at: Date.parse(conflict.at) }),
      };
      lines.set(change, unsaved);
      for (const each of change.fields) next.set(keyOf(task.id, each), unsaved);
    }
    this.#set({ ...this.#state, unsaved: next });
    if (signedOut) return lines;
    const first = parts[0];
    if (first === undefined) return lines;
    const conflict = conflictOf(first);
    const field = first.fields[0] ?? "title";
    const words = FIELD_WORDS[field];
    const text: Msg =
      conflict === undefined
        ? { id: "toast.notSaved", values: { field: { id: words ?? "field.other" } } }
        : {
            id: "toast.changedBy",
            values: { ...whoOf(conflict.by), field: { id: words ?? "field.other" } },
          };
    // A finished task takes no edit until it is reopened, nor a deleted one until it is restored,
    // nor a space that takes no change at all: no action that would only fail again. The value
    // waits under its fact or the title, with Copy (Facts.tsx, Row.tsx, Unsaved.tsx).
    const readOnly = readOnlyText(error);
    if (readOnly !== undefined) {
      say({ kind: "error", text: readOnly });
      return lines;
    }
    if (problem?.cause === "TASK_NOT_ACTIVE" || problem?.cause === "DELETED") {
      say({ kind: "error", text });
      return lines;
    }
    say({
      kind: "error",
      text,
      action: {
        label: { id: conflict === undefined ? "toast.tryAgain" : "toast.applyMine" },
        run: () => {
          // Every part that still waits as this refusal kept it, as one edit again.
          const waiting = parts.filter(
            (part) => this.unsaved(task.id, part.fields[0] ?? "title") === lines.get(part),
          );
          const again = joinChanges(waiting);
          const kept = waiting.flatMap((part) => lines.get(part) ?? []);
          if (again === undefined || kept.length === 0) return;
          if (kept.some((line) => this.restored(line))) return;
          this.#again(task, again, kept);
        },
      },
    });
    return lines;
  }

  /** Drops the unsaved edit of a field, under every field it was kept for. */
  #forget(task: string, field: Field): void {
    const unsaved = this.#state.unsaved.get(keyOf(task, field));
    if (unsaved === undefined) return;
    const next = new Map(this.#state.unsaved);
    for (const each of unsaved.change.fields) next.delete(keyOf(task, each));
    next.delete(keyOf(task, field));
    this.#set({ ...this.#state, unsaved: next });
  }

  #leave(row: TaskRow, who: { by?: string; at?: number }): void {
    const leaving = new Map(this.#state.leaving);
    leaving.set(row.id, { row, done: true, out: false, ...who });
    this.#set({ ...this.#state, leaving });
    const timers = this.#timers;
    const out = timers.set(() => {
      const entry = this.#state.leaving.get(row.id);
      if (entry?.done !== true) return;
      const next = new Map(this.#state.leaving);
      next.set(row.id, { ...entry, out: true });
      this.#set({ ...this.#state, leaving: next });
    }, HOLD_MS);
    const gone = timers.set(() => {
      if (this.#state.leaving.get(row.id)?.done === true) this.#drop(row.id);
    }, HOLD_MS + COLLAPSE_MS);
    this.#holds.set(row.id, [out, gone]);
  }

  /** The deps' timers, or the window's. */
  get #timers(): NonNullable<EditDeps["timers"]> {
    return (
      this.#deps.timers ?? {
        set: (run: () => void, ms: number) => setTimeout(run, ms),
        clear: (handle: unknown) => {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        },
      }
    );
  }

  #drop(task: string): void {
    for (const handle of this.#holds.get(task) ?? []) this.#timers.clear(handle);
    this.#holds.delete(task);
    this.#checks.delete(task);
    if (!this.#state.leaving.has(task)) return;
    const next = new Map(this.#state.leaving);
    next.delete(task);
    this.#set({ ...this.#state, leaving: next });
  }

  /**
   * An undo or redo answered for these tasks (by reference). A row in its hold comes back
   * unchecked at once and stays until the feed brings its row back; a redone check-off holds
   * again.
   */
  #undone(refs: readonly string[], undone: boolean): void {
    const wanted = new Set(refs);
    for (const [id, entry] of this.#state.leaving) {
      if (!wanted.has(entry.row.ref)) continue;
      if (!undone) continue;
      // The feed brought the row back before the answer came: the live row shows it.
      if (this.#deps.rowOf(entry.row.ref)?.lifecycle === "active") {
        this.#drop(id);
        continue;
      }
      const next = new Map(this.#state.leaving);
      next.set(id, { ...entry, done: false, out: false });
      this.#set({ ...this.#state, leaving: next });
      for (const handle of this.#holds.get(id) ?? []) this.#timers.clear(handle);
      const back = this.#timers.set(() => {
        if (this.#state.leaving.get(id)?.done === false) this.#drop(id);
      }, RETURN_MS);
      this.#holds.set(id, [back]);
      this.#checks.delete(id);
    }
  }

  /** What the feed brought: others' changes for open editors, and rows back from an undo. */
  #heard(changes: readonly FeedChange[]): void {
    for (const change of changes) {
      // A request of this tab's whose outcome was unknown is decided: its outcome can be read.
      this.#calls.get(change.request_id)?.heard();
      if (change.type !== "task" || change.task === undefined) continue;
      const leaving = this.#state.leaving.get(change.task);
      const after = change.after as TaskRow | undefined;
      if (leaving !== undefined && !leaving.done && after?.lifecycle === "active") {
        this.#drop(change.task);
      }
      if (this.#mine.has(change.request_id)) continue;
      this.#marks += 1;
      for (const field of change.changed) {
        this.#remote.set(keyOf(change.task, field), {
          by: change.actor.label,
          kind: change.actor.kind,
          mark: this.#marks,
        });
      }
    }
  }

  /** Hands the browser what waits: the lines shown, and those sent again until decided. */
  #keep(): void {
    if (this.#deps.keeper === undefined) return;
    const { unsaved, retrying } = this.#state;
    this.#deps.keeper.save(retrying.size === 0 ? unsaved : new Map([...retrying, ...unsaved]));
  }

  #toast(toast: Omit<Toast, "key">): Toast {
    this.#toasts += 1;
    const shown: Toast = { ...toast, key: this.#toasts };
    for (const listener of this.#toastListeners) listener(shown);
    return shown;
  }

  /** Takes a toast away, if it is still the one shown. */
  #untoast(toast: Toast): void {
    if (toast.key !== this.#toasts) return;
    for (const listener of this.#toastListeners) listener(undefined);
  }

  #set(state: EditState): void {
    const before = this.#state;
    this.#state = state;
    if (state.unsaved !== before.unsaved || state.retrying !== before.retrying) this.#keep();
    for (const listener of this.#listeners) listener();
  }
}
