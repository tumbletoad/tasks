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
import type { Client } from "@tasks/contracts/generated/client.ts";
import type { Msg } from "../row/model.ts";
import type { Change as FeedChange } from "../store/core.ts";
import type { Overlay } from "../store/pending.ts";
import type { TaskRow } from "../store/rows.ts";
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
  readonly task: string;
  readonly ref: string;
  readonly field: Field;
  readonly change: Change;
  readonly reason: "conflict" | "failed";
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

/** Where the edits that wait are kept across a reload (keep.ts). */
export interface UnsavedKeeper {
  /** The space's kept edits, each once. */
  load(): Unsaved[];
  /** The tab's edits that wait now, as the edits' state holds them (one under each field). */
  save(unsaved: ReadonlyMap<string, Unsaved>): void;
}

export interface EditState {
  readonly unsaved: ReadonlyMap<string, Unsaved>;
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
  };
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

/** The key of a task's field in the maps of unsaved edits and others' changes. */
export const keyOf = (task: string, field: string) => `${task}\u0000${field}`;

/** "the due date", "the priority": a field as the toast names it. */
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

/**
 * Who changed it, as a message's values: `who` selects the person elsewhere (`user`), an import,
 * or an actor named by its label (`by`).
 */
export const whoOf = (by: string): { who: string; by: string } => ({
  who: by === "user" || by === "import" ? by : "other",
  by,
});

/**
 * What an undo or redo conflict says (A5 3.12): who changed which field and when, and for one field
 * whose values read as words and that Restore mine can put back, what the person's change wrote,
 * what is there now and what Restore mine would put back. A title's values stay out: a long title
 * does not fit a toast.
 */
function conflictText(
  conflicts: readonly Conflict[],
  fields: ReadonlySet<string>,
  restorable: boolean,
): Msg {
  const first = conflicts[0];
  if (first === undefined) return { id: "toast.undoFailed" };
  const words = FIELD_WORDS[first.field];
  const values = {
    ...whoOf(first.by),
    field: { id: words ?? "field.other" } as Msg,
    count: fields.size,
    at: Date.parse(first.at),
  };
  if (fields.size !== 1 || words === undefined) return { id: "toast.conflictMany", values };
  const shown = (key: "value" | "wrote" | "restore") =>
    Object.hasOwn(first, key) ? restoreChange(first.field, first[key])?.shown : undefined;
  const now = shown("value");
  const wrote = shown("wrote");
  const back = shown("restore");
  if (
    !restorable ||
    first.field === "title" ||
    now === undefined ||
    wrote === undefined ||
    back === undefined
  ) {
    return { id: "toast.conflict", values };
  }
  return { id: "toast.conflictValues", values: { ...values, now, wrote, restore: back } };
}

export class Edits {
  readonly #deps: EditDeps;
  readonly #listeners = new Set<() => void>();
  readonly #toastListeners = new Set<(toast: Toast | undefined) => void>();
  #state: EditState = { unsaved: new Map(), leaving: new Map() };
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
  #marks = 0;
  #toasts = 0;

  constructor(deps: EditDeps) {
    this.#deps = deps;
    // What waited when the page was last closed or reloaded waits again, each under its fields.
    const restored = new Map<string, Unsaved>();
    for (const unsaved of deps.keeper?.load() ?? []) {
      for (const field of unsaved.change.fields) restored.set(keyOf(unsaved.task, field), unsaved);
    }
    if (restored.size > 0) this.#state = { ...this.#state, unsaved: restored };
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
   * with the person's value. `base` is the editor's, taken when it opened; a control leaves it out.
   */
  edit(task: TaskRow, change: Change, options: { readonly base?: string } = {}): void {
    for (const field of change.fields) this.#forget(task.id, field);
    this.#edits += 1;
    const number = this.#edits;
    for (const field of change.fields) this.#latest.set(keyOf(task.id, field), number);
    // What the person saw: the editor's base, or the screen's now.
    const sent = this.#send(task.id, change, options.base ?? this.#deps.asOf());
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
    void this.#outcome(
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
        const kept = late
          ? stillShown()
          : (change.parts ?? [change]).filter((part) =>
              part.fields.every((field) => this.#latest.get(keyOf(task.id, field)) === number),
            );
        if (kept.length > 0) interim = this.#refused(task, kept, decision.error, say);
        else if (late) say(undefined);
      },
      toast,
    );
  }

  /** "Apply mine" or "Try again": the person's kept value, sent again with a fresh base. */
  apply(task: string, field: Field): void {
    const unsaved = this.unsaved(task, field);
    if (unsaved === undefined) return;
    const row = this.#deps.rowOf(unsaved.ref);
    this.edit(row ?? ({ id: unsaved.task, ref: unsaved.ref } as TaskRow), unsaved.change);
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
            conflict === undefined
              ? { id: "toast.checkFailed" }
              : { id: "toast.checkConflict", values: whoOf(conflict.by) },
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
            conflict === undefined
              ? { id: "toast.reopenFailed" }
              : { id: "toast.reopenConflict", values: whoOf(conflict.by) },
        });
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
      say({
        kind: "undo",
        text: { id: "toast.redone" },
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
      const text = said(value);
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
   * An undo or redo the service refused. A conflict says who changed what and offers the one
   * action that fits: "Restore mine" when every field of the change conflicts, "Undo the rest"
   * when only some do (A5 3.12). A redo has no partial form.
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
    if (problem === undefined) {
      say({ kind: "error", text: { id: "toast.undoFailed" } });
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
    const restore = this.#restoreOf(conflicts);
    const known = commit === undefined ? undefined : this.#fieldsOf.get(commit);
    // Only some of the change's fields conflict: the rest can be undone and the others kept.
    const some = kind === "undo" && known !== undefined && known.some((f) => !fields.has(f));
    const text = conflictText(conflicts, fields, !some && restore !== undefined);
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
      text,
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
        if (waits.length > 0 && !(await ahead.wait())) throw new NotSent();
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

  /** Keeps refused parts as not saved and says so; returns each part's line. */
  #refused(
    task: TaskRow,
    parts: readonly Change[],
    error: unknown,
    say: Say,
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
    for (const change of parts) {
      const conflict = conflictOf(change);
      const unsaved: Unsaved = {
        task: task.id,
        ref: task.ref,
        field: change.fields[0] ?? "title",
        change,
        reason: conflict === undefined ? "failed" : "conflict",
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
    // A finished task takes no edit until it is reopened, nor a deleted one until it is restored:
    // no action that would only fail again. The value waits under its fact or the title, with
    // Copy (Facts.tsx, Row.tsx).
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
          // Every part that still waits, as one edit again.
          const waiting = parts
            .map((part) => this.unsaved(task.id, part.fields[0] ?? "title")?.change)
            .filter((change): change is Change => change !== undefined);
          const again = joinChanges(waiting);
          if (again === undefined) return;
          const row = this.#deps.rowOf(task.ref);
          this.edit(row ?? task, again);
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
    if (state.unsaved !== before.unsaved) this.#deps.keeper?.save(state.unsaved);
    for (const listener of this.#listeners) listener();
  }
}
