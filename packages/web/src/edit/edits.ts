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
import type { Client } from "@tasks/contracts/generated/client.ts";
import type { Msg } from "../row/model.ts";
import type { Change as FeedChange } from "../store/core.ts";
import type { Overlay } from "../store/pending.ts";
import type { TaskRow } from "../store/rows.ts";
import type { Changes, Sent } from "../store/store.ts";
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
  readonly client: Pick<Client, "task" | "history">;
  readonly write: <T>(send: (request: string) => Promise<T>, overlay?: Overlay) => Sent<T>;
  /** The applied cursor as an `as_of`: what the rows on screen show. */
  readonly asOf: () => string | undefined;
  /** The service refused the token or the build: the page's state says so already. */
  readonly failed: (error: unknown) => boolean;
  readonly onChanges: (listener: (changes: Changes) => void) => () => void;
  /** The live row of a task, by its reference (a conflict names tasks by reference). */
  readonly rowOf: (ref: string) => TaskRow | undefined;
  readonly newRequest: () => string;
  readonly timers?: {
    readonly set: (run: () => void, ms: number) => unknown;
    readonly clear: (handle: unknown) => void;
  };
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
  /** The newest write's answer per task, while it is on its way: the next edit waits for it. */
  readonly #chains = new Map<string, Promise<unknown>>();
  /**
   * Per task and field, the `as_of` of the tab's own newest write of it that changed something:
   * how far a later edit's base may move past what the screen showed (`#baseFor`).
   */
  readonly #own = new Map<string, string>();
  /** The `as_of` of every commit the tab made itself (edits, check-offs, undo, redo). */
  readonly #ownCommits = new Set<string>();
  /** The undo or redo on its way: edits made after it go out after it (`#history`). */
  #gate: Promise<unknown> | undefined;
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
    const toast = this.#toast({
      kind: "undo",
      text: change.said,
      action: {
        label: { id: "toast.undo" },
        run: () => {
          void this.undo(sent.commit);
        },
      },
    });
    void sent.commit.then((commit) => {
      if (commit !== undefined) this.#fieldsOf.set(commit, change.fields);
    });
    sent.answer.then(
      (result) => {
        // Nothing changed (the value was already so): there is nothing to undo.
        if ((result as { result?: unknown }).result === "no_change") this.#untoast(toast);
      },
      (error: unknown) => {
        // Kept part by part: a part whose field the person edited again since gives way to that
        // newer choice, and the others still wait for the person.
        const kept = (change.parts ?? [change]).filter((part) =>
          part.fields.every((field) => this.#latest.get(keyOf(task.id, field)) === number),
        );
        if (kept.length > 0) this.#refused(task, kept, error);
      },
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
    this.#checks.set(task.id, sent.commit);
    this.#toast({
      kind: "undo",
      text: { id: "toast.done" },
      action: {
        label: { id: "toast.undo" },
        run: () => {
          void this.undo(sent.commit);
        },
      },
    });
    void sent.commit.then((commit) => {
      if (commit !== undefined) this.#fieldsOf.set(commit, ["lifecycle", "wrap"]);
    });
    sent.answer.catch((error: unknown) => {
      this.#drop(task.id);
      if (this.#deps.failed(error)) return;
      const problem = problemOf(error);
      const conflict = problem?.conflicts[0];
      this.#toast({
        kind: "error",
        text:
          conflict === undefined
            ? { id: "toast.checkFailed" }
            : { id: "toast.checkConflict", values: whoOf(conflict.by) },
      });
    });
  }

  /**
   * Reopen a finished task (the facts' Reopen): one action, with a base, and an Undo that
   * finishes it again by its own commit. Its earlier outcome and learnings stay with it.
   */
  reopen(task: TaskRow): void {
    const sent = this.#sendWith(task.id, ["lifecycle"], this.#deps.asOf(), (base, request) =>
      this.#deps.client.task.reopen({
        task: task.id,
        reason: "",
        base: base ?? "",
        request_id: request,
      }),
    );
    const toast = this.#toast({
      kind: "undo",
      text: { id: "toast.reopened" },
      action: {
        label: { id: "toast.undo" },
        run: () => {
          void this.undo(sent.commit);
        },
      },
    });
    void sent.commit.then((commit) => {
      if (commit !== undefined) this.#fieldsOf.set(commit, ["lifecycle"]);
    });
    sent.answer.then(
      (result) => {
        if (result.result === "no_change") this.#untoast(toast);
      },
      (error: unknown) => {
        if (this.#deps.failed(error)) return;
        const conflict = problemOf(error)?.conflicts[0];
        this.#toast({
          kind: "error",
          text:
            conflict === undefined
              ? { id: "toast.reopenFailed" }
              : { id: "toast.reopenConflict", values: whoOf(conflict.by) },
        });
      },
    );
  }

  /** The check-offs of this tab still in their hold, with their commits. */
  readonly #checks = new Map<string, Promise<string | undefined>>();

  /**
   * The box clicked again during the hold: the check-off is undone, by its commit, or for a redone
   * check-off by the redo's commit. Never the person's newest change unnamed: that may be another
   * task's edit. A hold whose commit the tab does not know says so and changes nothing.
   */
  uncheck(task: string): void {
    const leaving = this.#state.leaving.get(task);
    if (leaving === undefined || !leaving.done || leaving.by !== undefined) return;
    void this.undo(this.#checks.get(task) ?? Promise.resolve(this.#redone.get(leaving.row.ref)));
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
   * Undo (A5 3.12): the person's newest change, or the one a toast names. A commit the toast
   * cannot name (its write was confirmed without one) is not guessed: the person uses Ctrl+Z.
   */
  async undo(commit?: Promise<string | undefined> | string, partial = false): Promise<void> {
    const named = typeof commit === "object" ? await commit : commit;
    if (commit !== undefined && named === undefined) {
      this.#toast({ kind: "info", text: { id: "toast.undoUnknown" } });
      return;
    }
    let result;
    try {
      result = await this.#history("undo", named, partial);
    } catch (error) {
      this.#historyFailed("undo", error, named);
      return;
    }
    this.#undone(result.tasks, true);
    this.#toast({
      kind: "undo",
      text: { id: result.result === "partial" ? "toast.undoneRest" : "toast.undone" },
      action: {
        label: { id: "toast.redo" },
        run: () => {
          void this.redo(result.commit);
        },
      },
    });
  }

  async redo(commit?: string): Promise<void> {
    let result;
    try {
      result = await this.#history("redo", commit, false);
    } catch (error) {
      this.#historyFailed("redo", error, commit);
      return;
    }
    for (const ref of result.tasks) this.#redone.set(ref, result.commit);
    this.#undone(result.tasks, false);
    this.#toast({
      kind: "undo",
      text: { id: "toast.redone" },
      action: {
        label: { id: "toast.undo" },
        run: () => {
          void this.undo(result.commit);
        },
      },
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
    commit: string | undefined,
    partial: boolean,
  ): Promise<HistoryResult> {
    const ahead = Promise.all([...this.#chains.values(), this.#gate]);
    const run = ahead.then((): Promise<HistoryResult> => {
      const request = this.#deps.newRequest();
      this.#mine.add(request);
      const input = {
        ...(commit === undefined ? {} : { commit }),
        request_id: request,
      };
      return kind === "undo"
        ? this.#deps.client.history.undo({ ...input, ...(partial ? { partial: true } : {}) })
        : this.#deps.client.history.redo(input);
    });
    const gate: Promise<unknown> = run.then(
      (result) => {
        this.#ownCommits.add(result.as_of);
      },
      () => undefined,
    );
    this.#gate = gate;
    void gate.then(() => {
      if (this.#gate === gate) this.#gate = undefined;
    });
    return run;
  }

  /**
   * An undo or redo the service refused. A conflict says who changed what and offers the one
   * action that fits: "Restore mine" when every field of the change conflicts, "Undo the rest"
   * when only some do (A5 3.12). A redo has no partial form.
   */
  #historyFailed(kind: "undo" | "redo", error: unknown, asked: string | undefined): void {
    if (this.#deps.failed(error)) return;
    const problem = problemOf(error);
    if (problem === undefined) {
      this.#toast({ kind: "error", text: { id: "toast.undoFailed" } });
      return;
    }
    // The commit it met, named: Restore mine and Undo the rest act on that one only, never on
    // whatever is newest by the time the person chooses (a change made since in another window).
    const commit = asked ?? problem.commit;
    switch (problem.cause) {
      case "NOTHING_TO_UNDO":
        this.#toast({ kind: "info", text: { id: "toast.nothingToUndo" } });
        return;
      case "NOTHING_TO_REDO":
        this.#toast({ kind: "info", text: { id: "toast.nothingToRedo" } });
        return;
      case "INVALID_TRANSITION":
        this.#toast({ kind: "info", text: { id: "toast.newerFirst" } });
        return;
      case "UNDO_CONFLICT":
        break;
      default:
        this.#toast({ kind: "error", text: { id: "toast.undoFailed" } });
        return;
    }
    const conflicts = problem.conflicts;
    const first = conflicts[0];
    if (first === undefined) {
      this.#toast({ kind: "error", text: { id: "toast.undoFailed" } });
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
      this.#toast({ kind: "error", text, ...undoRest });
      return;
    }
    this.#toast({
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
  async #restore(
    kind: "undo" | "redo",
    restore: ReadonlyMap<string, Change>,
    commit: string | undefined,
  ): Promise<void> {
    let base: string | undefined;
    if (kind === "undo" && commit !== undefined) {
      try {
        const partial = await this.#history("undo", commit, true);
        base = partial.as_of;
      } catch (error) {
        this.#historyFailed("undo", error, commit);
        return;
      }
    }
    for (const [ref, change] of restore) {
      const row = this.#deps.rowOf(ref);
      const fresh = newer(this.#deps.asOf(), base);
      this.edit(
        row ?? ({ id: ref, ref } as TaskRow),
        change,
        fresh === undefined ? {} : { base: fresh },
      );
    }
  }

  /** Sends one `task.update` after the task's earlier writes have answered. */
  #send(task: string, change: Change, seen: string | undefined): Sent<unknown> {
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
  ): Sent<T> {
    // Sent at once when nothing of the task's and no undo or redo is on its way, else after them.
    const waits = [this.#chains.get(task), this.#gate].filter((p) => p !== undefined);
    const before = waits.length === 0 ? undefined : Promise.all(waits);
    const sent = this.#deps.write((request) => {
      const send = () => call(this.#baseFor(task, fields, seen), request);
      return before === undefined ? send() : before.then(send);
    }, overlay);
    this.#mine.add(sent.request);
    const answered = sent.answer.then((result) => {
      // A write that changed nothing wrote no field: its `as_of` is only the head.
      if (typeof result.as_of !== "string" || result.result === "no_change") return;
      this.#ownCommits.add(result.as_of);
      // The task's writes answer in turn, so this is its newest.
      for (const field of fields) this.#own.set(keyOf(task, field), result.as_of);
    });
    const chain = answered.catch(() => undefined);
    this.#chains.set(task, chain);
    void chain.then(() => {
      if (this.#chains.get(task) === chain) this.#chains.delete(task);
    });
    return sent;
  }

  #refused(task: TaskRow, parts: readonly Change[], error: unknown): void {
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
      for (const each of change.fields) next.set(keyOf(task.id, each), unsaved);
    }
    this.#set({ ...this.#state, unsaved: next });
    if (signedOut) return;
    const first = parts[0];
    if (first === undefined) return;
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
    // A finished task takes no edit until it is reopened: no action that would only fail again.
    // The value waits under its fact, with Copy (Facts.tsx).
    if (problem?.cause === "TASK_NOT_ACTIVE") {
      this.#toast({ kind: "error", text });
      return;
    }
    this.#toast({
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
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
