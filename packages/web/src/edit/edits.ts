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
// Bases. A control's edit takes the applied cursor when it is sent; an editor that stays open while
// the person types (the title, a date) takes it when it opens. Edits of one task go out one after
// another: the next waits for the answer to the one before, and its base is that answer's `as_of`
// when the feed has not caught up yet, so two quick edits of one field never conflict with each
// other. Writes go through the live store, so each shows at once as an overlay and settles only
// through the feed (A5 3.15 item 4).
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
  readonly restore?: unknown;
  readonly by: string;
  readonly at: string;
}

interface Problem {
  readonly code: string;
  readonly cause: string;
  readonly conflicts: readonly Conflict[];
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
  return {
    code,
    cause: typeof record["cause"] === "string" ? record["cause"] : "",
    conflicts,
  };
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

const keyOf = (task: string, field: string) => `${task}\u0000${field}`;

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

const timeOf = (at: string | number): Msg => ({
  id: "edit.time",
  values: { at: typeof at === "number" ? at : Date.parse(at) },
});

export class Edits {
  readonly #deps: EditDeps;
  readonly #listeners = new Set<() => void>();
  readonly #toastListeners = new Set<(toast: Toast | undefined) => void>();
  #state: EditState = { unsaved: new Map(), leaving: new Map() };
  /** The newest write's answer per task, while it is on its way: the next edit waits for it. */
  readonly #chains = new Map<string, Promise<unknown>>();
  /** The `as_of` of the newest answer per task: the next base when the feed is behind it. */
  readonly #answers = new Map<string, string>();
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
    const sent = this.#send(task.id, change, options.base);
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
        this.#refused(task, change, error);
      },
    );
  }

  /** "Apply mine" or "Try again": the person's kept value, sent again with a fresh base. */
  apply(task: string, field: Field): void {
    const unsaved = this.unsaved(task, field);
    if (unsaved === undefined) return;
    const row = this.#deps.rowOf(unsaved.ref);
    this.edit(row ?? { id: unsaved.task, ref: unsaved.ref } as TaskRow, unsaved.change);
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
    if (this.#state.leaving.has(task.id)) return;
    this.#leave(task, {});
    const sent = this.#sendWith(task.id, (base, request) =>
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

  /** The check-offs of this tab still in their hold, with their commits. */
  readonly #checks = new Map<string, Promise<string | undefined>>();

  /** The box clicked again during the hold: the check-off is undone. */
  uncheck(task: string): void {
    const commit = this.#checks.get(task);
    const leaving = this.#state.leaving.get(task);
    if (commit === undefined || leaving === undefined || !leaving.done) return;
    void this.undo(commit);
  }

  /**
   * Another actor completed a task this tab shows (A5 3.12): it strikes through, says who, and
   * leaves after the hold.
   */
  hold(row: TaskRow, by: string, at: number): void {
    if (this.#state.leaving.has(row.id)) return;
    this.#leave(row, { by, at });
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

  async #history(kind: "undo" | "redo", commit: string | undefined, partial: boolean) {
    const request = this.#deps.newRequest();
    this.#mine.add(request);
    const input = {
      ...(commit === undefined ? {} : { commit }),
      request_id: request,
    };
    return kind === "undo"
      ? this.#deps.client.history.undo({ ...input, ...(partial ? { partial: true } : {}) })
      : this.#deps.client.history.redo(input);
  }

  /**
   * An undo or redo the service refused. A conflict says who changed what and offers the one
   * action that fits: "Restore mine" when every field of the change conflicts, "Undo the rest"
   * when only some do (A5 3.12). A redo has no partial form.
   */
  #historyFailed(kind: "undo" | "redo", error: unknown, commit: string | undefined): void {
    if (this.#deps.failed(error)) return;
    const problem = problemOf(error);
    if (problem === undefined) {
      this.#toast({ kind: "error", text: { id: "toast.undoFailed" } });
      return;
    }
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
    const words = FIELD_WORDS[first.field];
    const text: Msg = {
      id: fields.size === 1 && words !== undefined ? "toast.conflict" : "toast.conflictMany",
      values: {
        ...whoOf(first.by),
        field: words === undefined ? { id: "field.other" } : { id: words },
        count: fields.size,
        time: timeOf(first.at),
      },
    };
    const restore = this.#restoreOf(conflicts);
    const known = commit === undefined ? undefined : this.#fieldsOf.get(commit);
    // Only some of the change's fields conflict: the rest can be undone and the others kept.
    const some = kind === "undo" && known !== undefined && known.some((f) => !fields.has(f));
    if (some) {
      this.#toast({
        kind: "error",
        text,
        action: {
          label: { id: "toast.undoRest" },
          run: () => {
            void this.undo(commit, true);
          },
        },
      });
      return;
    }
    if (restore === undefined) {
      // Nothing a hand edit can put back (a lifecycle, a due time): the person decides in the task.
      this.#toast({
        kind: "error",
        text,
        ...(kind === "undo"
          ? {
              action: {
                label: { id: "toast.undoRest" },
                run: () => {
                  void this.undo(commit, true);
                },
              },
            }
          : {}),
      });
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
   * past it and the next Ctrl+Z reaches the change below, not this conflict again.
   */
  async #restore(
    kind: "undo" | "redo",
    restore: ReadonlyMap<string, Change>,
    commit: string | undefined,
  ): Promise<void> {
    let base: string | undefined;
    if (kind === "undo") {
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
      this.edit(row ?? ({ id: ref, ref } as TaskRow), change, fresh === undefined ? {} : { base: fresh });
    }
  }

  /** Sends one `task.update` after the task's earlier writes have answered. */
  #send(task: string, change: Change, base: string | undefined): Sent<unknown> {
    const { set, clear } = change.overlay;
    return this.#sendWith(
      task,
      (fresh, request) => {
        const chosen = base ?? fresh;
        return this.#deps.client.task.update({
          task,
          ...(change.set === undefined ? {} : { set: change.set }),
          ...(change.clear === undefined ? {} : { clear: [...change.clear] }),
          ...(chosen === undefined ? {} : { base: chosen }),
          request_id: request,
        });
      },
      { tasks: [{ id: task, set, ...(clear === undefined ? {} : { clear }) }] },
    );
  }

  /**
   * A write of one task through the store, in turn after the task's earlier writes. `call` gets the
   * base to use (the store's cursor, or the newest answer when the feed is behind it) and the
   * store's request ID.
   */
  #sendWith<T extends { as_of?: string }>(
    task: string,
    call: (base: string | undefined, request: string) => Promise<T>,
    overlay?: Overlay,
  ): Sent<T> {
    const before = this.#chains.get(task) ?? Promise.resolve();
    const sent = this.#deps.write(async (request) => {
      await before.catch(() => undefined);
      return call(newer(this.#deps.asOf(), this.#answers.get(task)), request);
    }, overlay);
    this.#mine.add(sent.request);
    const answered = sent.answer.then((result) => {
      if (typeof result.as_of === "string") {
        this.#answers.set(task, newer(this.#answers.get(task), result.as_of) ?? result.as_of);
      }
    });
    const chain = answered.catch(() => undefined);
    this.#chains.set(task, chain);
    void chain.then(() => {
      if (this.#chains.get(task) === chain) this.#chains.delete(task);
    });
    return sent;
  }


  #refused(task: TaskRow, change: Change, error: unknown): void {
    const signedOut = this.#deps.failed(error);
    const problem = problemOf(error);
    const conflict =
      problem?.code === "conflict"
        ? problem.conflicts.find((c) => change.fields.some((f) => f === c.field)) ??
          problem.conflicts[0]
        : undefined;
    const field = change.fields[0] ?? "title";
    const unsaved: Unsaved = {
      task: task.id,
      ref: task.ref,
      field,
      change,
      reason: conflict === undefined ? "failed" : "conflict",
      ...(conflict === undefined ? {} : { by: conflict.by, at: Date.parse(conflict.at) }),
    };
    const next = new Map(this.#state.unsaved);
    next.set(keyOf(task.id, field), unsaved);
    this.#set({ ...this.#state, unsaved: next });
    if (signedOut) return;
    const words = FIELD_WORDS[field];
    this.#toast({
      kind: "error",
      text:
        conflict === undefined
          ? { id: "toast.notSaved", values: { field: { id: words ?? "field.other" } } }
          : {
              id: "toast.changedBy",
              values: { ...whoOf(conflict.by), field: { id: words ?? "field.other" } },
            },
      action: {
        label: { id: conflict === undefined ? "toast.tryAgain" : "toast.applyMine" },
        run: () => {
          this.apply(task.id, field);
        },
      },
    });
  }

  #forget(task: string, field: Field): void {
    const key = keyOf(task, field);
    if (!this.#state.unsaved.has(key)) return;
    const next = new Map(this.#state.unsaved);
    next.delete(key);
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
