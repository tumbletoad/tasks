// The edits controller (edits.ts) with the real live store and a fake service: one path for every
// person's edit, bases, refusals that keep the person's value, the check-off's hold, and undo and
// redo with their conflicts. The store is fed by hand, as the feed would (fake frames).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LiveStore } from "../store/store.ts";
import type { BatchMessage, SnapshotMessage, TaskRow } from "@ttasks/client/store";
import { FakeFrames } from "../../test/fake-frames.ts";
import {
  dueChange,
  effortChange,
  groupingChange,
  joinChanges,
  priorityChange,
  statusChange,
  titleChange,
  triageChange,
  waitingChange,
} from "./change.ts";
import { createIntl } from "react-intl";
import { newerText } from "@ttasks/contracts/newer-work";
import { CATALOGUE, SOURCE_LOCALE } from "../i18n/intl.tsx";
import type { Msg } from "../row/model.ts";
import { sayMsg } from "../row/say.ts";
import { ASK_MS } from "./calls.ts";
import {
  Edits,
  HOLD_MS,
  COLLAPSE_MS,
  type Toast,
  type Unsaved,
  type UnsavedKeeper,
} from "./edits.ts";

/** A step a toast names, as its Undo or Redo does. */
const STEP = `op_${"9".padStart(26, "0")}`;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const INCARNATION = "ai_0123456789abcdefghjkmnpq";
const TAG = "01234567";

function task(n: number, fields: Partial<TaskRow> = {}): TaskRow {
  return {
    id: `t_${String(n).padStart(5, "0")}`,
    ref: `M-${String(n)}`,
    title: `Task ${String(n)}`,
    status: "open",
    inbox: false,
    lifecycle: "active",
    position: `p${String(n)}`,
    created_at: Date.UTC(2026, 10, 1),
    version: 1,
    parent: SPACE.id,
    ...fields,
  };
}

/** An error as the generated client throws it: a code and its data. */
function appError(code: string, data: Record<string, unknown>): Error {
  return Object.assign(new Error("refused"), { code, data });
}

/** A keeper of the test's own: nothing is let go elsewhere unless it says so. */
type Keeper = Omit<UnsavedKeeper, "onGone"> & Partial<Pick<UnsavedKeeper, "onGone">>;

class World {
  readonly frames = new FakeFrames();
  readonly store: LiveStore;
  readonly edits: Edits;
  readonly calls: { name: string; input: Record<string, unknown> }[] = [];
  readonly toasts: (Toast | undefined)[] = [];
  /** What the next call of each entry answers: a result, or an error to throw. */
  readonly answers = new Map<string, ((input: Record<string, unknown>) => unknown)[]>();
  seq = 10;
  /** The effort levels the screen shows, as a kept size remembers them. */
  levels = "levels-a";

  constructor(rows: readonly TaskRow[], keeper?: Keeper, leaving?: () => Promise<unknown>) {
    this.store = new LiveStore({
      space: SPACE.id,
      frames: this.frames,
      onResnapshot: () => undefined,
    });
    const snapshot: SnapshotMessage = {
      type: "snapshot",
      space: SPACE,
      cursor: { epoch: 1, incarnation: INCARNATION, seq: this.seq },
      tasks: rows,
      nodes: [],
      instances: [],
    };
    this.store.push(snapshot);
    this.store.flush();
    let requests = 0;
    const call = (name: string) => (input: Record<string, unknown>) => {
      this.calls.push({ name, input });
      const next = this.answers.get(name)?.shift();
      try {
        if (next === undefined) throw new Error(`no answer for ${name}`);
        return Promise.resolve(next(input));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const client = {
      task: {
        update: call("task.update"),
        finish: call("task.finish"),
        reopen: call("task.reopen"),
      },
      history: { undo: call("history.undo"), redo: call("history.redo") },
      receipt: { get: call("receipt.get") },
    } as unknown as ConstructorParameters<typeof Edits>[0]["client"];
    this.edits = new Edits({
      client,
      write: (send, overlay) => this.store.write(send, overlay),
      asOf: () => this.store.asOf,
      failed: () => false,
      onChanges: (listener) => this.store.onChanges(listener),
      rowOf: (ref) => [...this.store.getState().tasks.values()].find((t) => t.ref === ref),
      space: () => SPACE.id,
      levels: () => this.levels,
      newRequest: () => `rq-${String((requests += 1))}`,
      ...(keeper === undefined ? {} : { keeper: { onGone: () => () => undefined, ...keeper } }),
      ...(leaving === undefined ? {} : { leaving }),
    });
    this.edits.onToast((t) => this.toasts.push(t));
  }

  answer(name: string, run: (input: Record<string, unknown>) => unknown): void {
    const list = this.answers.get(name) ?? [];
    list.push(run);
    this.answers.set(name, list);
  }

  asOf(seq: number): string {
    return `1.${String(seq)}.${TAG}`;
  }

  /** The feed brings a commit: the rows as they are after it, its request and its commit ID. */
  feed(
    rows: readonly TaskRow[],
    request: string,
    changed: readonly string[],
    kind = "human",
  ): void {
    this.seq += 1;
    const batch: BatchMessage = {
      type: "batch",
      space_id: SPACE.id,
      epoch: 1,
      incarnation: INCARNATION,
      from: this.seq - 1,
      through: this.seq,
      events: [
        {
          seq: this.seq,
          op_id: `op_${String(this.seq).padStart(26, "0")}`,
          request_id: request,
          actor: { kind, label: kind === "agent" ? "Codex" : "Mira" },
          kind: "task.update",
          entities: rows.map((row) => ({
            type: "task",
            id: row.id,
            row: row as unknown as Record<string, unknown>,
            changed,
            created: false,
          })),
        },
      ],
    };
    this.store.push(batch);
    this.store.flush();
  }

  row(id: string): TaskRow | undefined {
    return this.store.getState().tasks.get(id);
  }

  lastToast(): Toast | undefined {
    return this.toasts.at(-1);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
};

describe("[A5.3.11.web.edits] one path for a person's edit: base, overlay, refusals kept, undo by commit", () => {
  test("an edit shows at once and carries the applied cursor as its base; a title's toast's Undo names its commit, a priority shows no toast", async () => {
    const w = new World([task(1)]);
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(11),
      warnings: [],
    }));
    w.edits.edit(task(1), priorityChange(1));
    expect(w.row("t_00001")?.priority).toBe(1);
    expect(w.calls[0]?.input).toMatchObject({
      task: "t_00001",
      set: { priority: 1 },
      base: w.asOf(10),
    });
    expect(w.toasts).toEqual([]);
    await flush();
    w.feed([task(1, { priority: 1, version: 2 })], String(w.calls[0]?.input["request_id"]), [
      "priority",
    ]);
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["title"],
      as_of: w.asOf(12),
      warnings: [],
    }));
    w.edits.edit(task(1, { priority: 1, version: 2 }), titleChange("Order the lamps"));
    expect(w.row("t_00001")?.title).toBe("Order the lamps");
    expect(w.lastToast()).toMatchObject({ kind: "undo", action: { label: { id: "toast.undo" } } });
    await flush();
    w.feed(
      [task(1, { priority: 1, title: "Order the lamps", version: 3 })],
      String(w.calls[1]?.input["request_id"]),
      ["title"],
    );
    w.answer("history.undo", () => ({
      result: "undone",
      commit: "op_x",
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(13),
    }));
    w.lastToast()?.action?.run();
    await flush();
    expect(w.calls[2]).toMatchObject({
      name: "history.undo",
      input: { commit: `op_${"12".padStart(26, "0")}` },
    });
    // Undone: Undo keeps its place, with nothing older to take back, and Redo is beside it.
    expect(w.lastToast()).toMatchObject({
      text: { id: "toast.undone" },
      action: { label: { id: "toast.undo" }, disabled: true },
      second: { label: { id: "toast.redo" } },
    });
    expect(w.lastToast()?.second?.disabled).toBeUndefined();
  });

  test("two quick edits of one task go out in turn: the second waits for the first's answer and takes its as_of", async () => {
    const w = new World([task(1)]);
    let answerFirst!: (value: unknown) => void;
    w.answer("task.update", () => new Promise((resolve) => (answerFirst = resolve)));
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(12),
      warnings: [],
    }));
    w.edits.edit(task(1), priorityChange(1));
    w.edits.edit(task(1), priorityChange(2));
    await flush();
    expect(w.calls).toHaveLength(1);
    // The second shows at once all the same.
    expect(w.row("t_00001")?.priority).toBe(2);
    answerFirst({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(11),
      warnings: [],
    });
    await flush();
    expect(w.calls).toHaveLength(2);
    expect(w.calls[1]?.input).toMatchObject({ set: { priority: 2 }, base: w.asOf(11) });
  });

  test("an agent's change to the second field between two quick edits is a conflict, never overwritten by a base the first edit's answer moved", async () => {
    const w = new World([task(1)]);
    let answerFirst!: (value: unknown) => void;
    w.answer("task.update", () => new Promise((resolve) => (answerFirst = resolve)));
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["effort"],
      as_of: w.asOf(13),
      warnings: [],
    }));
    // The person sets the priority, then the effort, seeing the screen at seq 10.
    w.edits.edit(task(1), priorityChange(1));
    w.edits.edit(task(1), effortChange("M", w.levels));
    await flush();
    // An agent's effort change (seq 11) lands before the priority commit (seq 12); the feed has
    // not brought either yet.
    answerFirst({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(12),
      warnings: [],
    });
    await flush();
    // The effort edit keeps what the person saw: the service refuses it over the agent's change.
    expect(w.calls[1]?.input).toMatchObject({ set: { effort: "M" }, base: w.asOf(10) });
    // A second priority edit may move past the person's own first one.
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(14),
      warnings: [],
    }));
    w.edits.edit(task(1), priorityChange(2));
    await flush();
    expect(w.calls[2]?.input).toMatchObject({ set: { priority: 2 }, base: w.asOf(12) });
  });

  test("a refusal of an edit the person has since replaced is not offered again", async () => {
    const w = new World([task(1)]);
    let failFirst!: (error: Error) => void;
    w.answer(
      "task.update",
      () => new Promise((_resolve, reject: (error: Error) => void) => (failFirst = reject)),
    );
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(11),
      warnings: [],
    }));
    w.edits.edit(task(1), priorityChange(1));
    w.edits.edit(task(1), priorityChange(2));
    await flush();
    const toasts = w.toasts.length;
    // A refusal the service decided (a failure on the way is asked about by its ID instead).
    failFirst(appError("invalid_input", { cause: "VALIDATION_FAILED" }));
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toBeUndefined();
    expect(w.toasts.slice(toasts).some((t) => t?.kind === "error")).toBe(false);
    expect(w.calls[1]?.input).toMatchObject({ set: { priority: 2 } });
  });

  test("a refused change of several fields is kept field by field: a newer edit of one leaves the others waiting", async () => {
    const w = new World([task(1)]);
    let failFirst!: (error: Error) => void;
    w.answer(
      "task.update",
      () => new Promise((_resolve, reject: (error: Error) => void) => (failFirst = reject)),
    );
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(11),
      warnings: [],
    }));
    const both = joinChanges([titleChange("My title"), priorityChange(1)]);
    if (both === undefined) throw new Error("no change");
    w.edits.edit(task(1), both);
    // The person picks another priority while the first edit is on its way; then it fails.
    w.edits.edit(task(1), priorityChange(2));
    await flush();
    failFirst(appError("invalid_input", { cause: "VALIDATION_FAILED" }));
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toBeUndefined();
    expect(w.edits.unsaved("t_00001", "title")?.change.set).toEqual({ title: "My title" });
    // A later edit of the priority leaves the title's value waiting too.
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(12),
      warnings: [],
    }));
    w.edits.edit(task(1), priorityChange(3));
    expect(w.edits.unsaved("t_00001", "title")).toBeDefined();
  });

  test("Ctrl+Z waits for the person's edits on their way, and takes back the newest step by its commit", async () => {
    const w = new World([task(1)]);
    let answerFirst!: (value: unknown) => void;
    w.answer("task.update", () => new Promise((resolve) => (answerFirst = resolve)));
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["title"],
      as_of: w.asOf(12),
      warnings: [],
    }));
    w.answer("history.undo", () => ({
      result: "undone",
      commit: "op_e",
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(13),
    }));
    w.edits.edit(task(1), titleChange("First"));
    w.edits.edit(task(1), titleChange("Second"));
    const undone = w.edits.undo();
    await flush();
    expect(w.calls.map((c) => c.name)).toEqual(["task.update"]);
    answerFirst({
      result: "updated",
      task: "M-1",
      fields: ["title"],
      as_of: w.asOf(11),
      warnings: [],
    });
    await flush();
    w.feed([task(1, { title: "First", version: 2 })], String(w.calls[0]?.input["request_id"]), [
      "title",
    ]);
    w.feed([task(1, { title: "Second", version: 3 })], String(w.calls[1]?.input["request_id"]), [
      "title",
    ]);
    await undone;
    expect(w.calls.map((c) => c.name)).toEqual(["task.update", "task.update", "history.undo"]);
    expect(w.calls[2]?.input).toMatchObject({ commit: `op_${"12".padStart(26, "0")}` });
  });

  test("an edit made after Ctrl+Z waits for the undo, so the undo never takes back that newer edit", async () => {
    const w = new World([task(1), task(2)]);
    let answerFirst!: (value: unknown) => void;
    w.answer("task.update", () => new Promise((resolve) => (answerFirst = resolve)));
    w.answer("history.undo", () => ({
      result: "undone",
      commit: "op_u",
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(12),
    }));
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-2",
      fields: ["effort"],
      as_of: w.asOf(13),
      warnings: [],
    }));
    w.edits.edit(task(1), titleChange("First"));
    const undone = w.edits.undo();
    // Another task's edit, after Ctrl+Z: it shows at once and goes out after the undo.
    w.edits.edit(task(2), effortChange("M", w.levels));
    expect(w.row("t_00002")?.effort).toBe("M");
    await flush();
    expect(w.calls.map((c) => c.name)).toEqual(["task.update"]);
    answerFirst({
      result: "updated",
      task: "M-1",
      fields: ["title"],
      as_of: w.asOf(11),
      warnings: [],
    });
    await flush();
    w.feed([task(1, { title: "First", version: 2 })], String(w.calls[0]?.input["request_id"]), [
      "title",
    ]);
    await undone;
    await flush();
    expect(w.calls.map((c) => [c.name, c.input["task"]])).toEqual([
      ["task.update", "t_00001"],
      ["history.undo", undefined],
      ["task.update", "t_00002"],
    ]);
  });

  test("Move to Open right after choosing a status moves past the person's own status change, never over someone else's", async () => {
    const inbox = task(1, { inbox: true });
    const w = new World([inbox]);
    let answerFirst!: (value: unknown) => void;
    w.answer("task.update", () => new Promise((resolve) => (answerFirst = resolve)));
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["inbox", "status"],
      as_of: w.asOf(12),
      warnings: [],
    }));
    // Waiting, then Move to Open at once, both seeing seq 10; the feed brings neither yet.
    w.edits.edit(inbox, statusChange("waiting"));
    w.edits.edit(inbox, triageChange());
    await flush();
    // The Waiting commit is seq 11, the next after what the person saw: nobody else wrote between.
    answerFirst({
      result: "updated",
      task: "M-1",
      fields: ["status"],
      as_of: w.asOf(11),
      warnings: [],
    });
    await flush();
    expect(w.calls[1]?.input).toMatchObject({
      set: { inbox: false, status: "open" },
      base: w.asOf(11),
    });

    // The same, with another actor's commit (seq 13) before the person's own (seq 14): the
    // Inbox field keeps what the person saw, so a change by someone else is never overwritten.
    const w2 = new World([inbox]);
    let answerOwn!: (value: unknown) => void;
    w2.answer("task.update", () => new Promise((resolve) => (answerOwn = resolve)));
    w2.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["inbox", "status"],
      as_of: w2.asOf(15),
      warnings: [],
    }));
    w2.edits.edit(inbox, statusChange("waiting"));
    w2.edits.edit(inbox, triageChange());
    await flush();
    answerOwn({
      result: "updated",
      task: "M-1",
      fields: ["status"],
      as_of: w2.asOf(12),
      warnings: [],
    });
    await flush();
    expect(w2.calls[1]?.input).toMatchObject({ base: w2.asOf(10) });
  });

  test("an edit right after the person's own undo moves past that undo", async () => {
    const w = new World([task(1)]);
    w.answer("history.undo", () => ({
      result: "undone",
      commit: "op_u",
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(11),
    }));
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(12),
      warnings: [],
    }));
    await w.edits.undo("op_u");
    // The feed has not brought the undo yet: the screen is still at seq 10.
    w.edits.edit(task(1), priorityChange(2));
    await flush();
    expect(w.calls[1]?.input).toMatchObject({ set: { priority: 2 }, base: w.asOf(11) });
  });

  test("an editor's base is the one it opened with: a conflict keeps the person's value with who changed it, and Apply mine sends it again with a fresh base", async () => {
    const w = new World([task(1)]);
    const opened = w.store.asOf ?? "";
    w.feed([task(1, { title: "Their title", version: 2 })], "agent-1", ["title"], "agent");
    w.answer("task.update", () => {
      throw appError("conflict", {
        cause: "VERSION_CONFLICT",
        conflicts: [
          {
            task: "M-1",
            field: "title",
            value: "Their title",
            version: 11,
            by: "Codex",
            at: "2026-11-12T09:40:00.000Z",
          },
        ],
      });
    });
    w.edits.edit(task(1), titleChange("My title"), { base: opened });
    expect(w.calls[0]?.input).toMatchObject({ base: opened, set: { title: "My title" } });
    await flush();
    // Nothing overwritten: the row shows theirs, the person's value waits with the reason.
    expect(w.row("t_00001")?.title).toBe("Their title");
    const unsaved = w.edits.unsaved("t_00001", "title");
    expect(unsaved).toMatchObject({ reason: "conflict", by: "Codex" });
    expect(unsaved?.change.set).toEqual({ title: "My title" });
    expect(w.lastToast()?.action?.label).toEqual({ id: "toast.applyMine" });
    // An update from the feed keeps it.
    w.feed(
      [task(1, { title: "Their title", summary: "x", version: 3 })],
      "agent-2",
      ["summary"],
      "agent",
    );
    expect(w.edits.unsaved("t_00001", "title")).toBeDefined();
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["title"],
      as_of: w.asOf(13),
      warnings: [],
    }));
    w.edits.apply("t_00001", "title");
    expect(w.edits.unsaved("t_00001", "title")).toBeUndefined();
    await flush();
    expect(w.calls[1]?.input).toMatchObject({ set: { title: "My title" }, base: w.asOf(12) });
  });

  test("a failed call keeps the person's value too, with Try again", async () => {
    const w = new World([task(1)]);
    w.answer("task.update", () => {
      throw new Error("network");
    });
    w.edits.edit(task(1), dueChange("2026-11-20", "Fri 20 Nov"));
    await flush();
    expect(w.row("t_00001")?.due_date).toBeUndefined();
    expect(w.edits.unsaved("t_00001", "due")).toMatchObject({ reason: "failed" });
    expect(w.lastToast()).toMatchObject({
      kind: "error",
      action: { label: { id: "toast.tryAgain" } },
    });
    w.edits.dismiss("t_00001", "due");
    expect(w.edits.unsaved("t_00001", "due")).toBeUndefined();
  });

  test("what waits is handed to the keeper as it changes, and what the keeper held waits again in a new page's edits", async () => {
    const kept: (readonly Unsaved[])[] = [];
    const keeper: Keeper = {
      load: () => [],
      save: (unsaved) => {
        kept.push([...new Set(unsaved.values())]);
      },
    };
    const w = new World([task(1)], keeper);
    w.answer("task.update", () => {
      throw new Error("network");
    });
    w.edits.edit(task(1), effortChange("M", w.levels));
    await flush();
    expect(kept.at(-1)?.map((u) => [u.task, u.field, u.reason])).toEqual([
      ["t_00001", "effort", "failed"],
    ]);
    // A reload: the next page's edits start with it, under its field, ready for Try again.
    const held = kept.at(-1) ?? [];
    const next = new World([task(1)], { load: () => [...held], save: () => undefined });
    expect(next.edits.unsaved("t_00001", "effort")).toMatchObject({ reason: "failed" });
    next.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["effort"],
      as_of: next.asOf(11),
      warnings: [],
    }));
    next.edits.apply("t_00001", "effort");
    await flush();
    expect(next.calls[0]?.input).toMatchObject({ set: { effort: "M" } });
    expect(next.edits.unsaved("t_00001", "effort")).toBeUndefined();
    // Discarded in the first page, it is no longer handed on.
    w.edits.dismiss("t_00001", "effort");
    expect(kept.at(-1)).toEqual([]);
  });

  test("an edit the keeper says was let go elsewhere leaves this page too, and `settled` follows the refusal that keeps it, never comes before it", async () => {
    let gone: (unsaved: Unsaved) => void = () => undefined;
    let held: readonly Unsaved[] = [];
    const keeper: Keeper = {
      load: () => [],
      save: (unsaved) => {
        held = [...new Set(unsaved.values())];
      },
      onGone: (listener) => {
        gone = listener;
        return () => undefined;
      },
    };
    const w = new World([task(1)], keeper);
    w.answer("task.update", () => {
      throw new Error("network");
    });
    const order: string[] = [];
    w.edits.edit(task(1), titleChange("Oil the gate"), {
      settled: () => order.push(`settled with ${String(held.length)} kept`),
    });
    expect(order).toEqual([]);
    await flush();
    expect(order).toEqual(["settled with 1 kept"]);
    const line = w.edits.unsaved("t_00001", "title");
    expect(line).toBeDefined();
    // Another tab's Discard, or the foot of the Trash: the line goes here too.
    if (line !== undefined) gone(line);
    expect(w.edits.unsaved("t_00001", "title")).toBeUndefined();
  });

  test("an edit still waiting behind another when the page goes is kept with the base it was made at: after a reload Try again sends that base, and someone's change since is a conflict with Apply mine", async () => {
    let held: readonly Unsaved[] = [];
    const keeper: Keeper = {
      load: () => [],
      save: (unsaved) => {
        held = [...new Set(unsaved.values())];
      },
    };
    let go: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => (go = resolve));
    const w = new World([task(1)], keeper, () => gone);
    // The rename's answer never comes in this page: the priority waits behind it.
    w.answer("task.update", () => new Promise(() => undefined));
    w.edits.edit(task(1), titleChange("Oil the gate"));
    w.edits.edit(task(1), priorityChange(1));
    await flush();
    expect(w.calls).toHaveLength(1);
    go();
    await flush();
    expect(w.calls).toHaveLength(1);
    expect(held.map((u) => [u.field, u.reason, u.base])).toEqual([
      ["priority", "failed", w.asOf(10)],
    ]);
    // The next page: the rename landed, then someone else set the priority.
    const next = new World([task(1)], { load: () => [...held], save: () => undefined });
    next.feed([task(1, { title: "Oil the gate", version: 2 })], "rq-1", ["title"]);
    next.feed(
      [task(1, { title: "Oil the gate", priority: 2, version: 3 })],
      "agent-1",
      ["priority"],
      "agent",
    );
    next.answer("task.update", () => {
      throw appError("conflict", {
        cause: "VERSION_CONFLICT",
        conflicts: [
          {
            task: "M-1",
            field: "priority",
            value: 2,
            version: 12,
            by: "Codex",
            at: "2026-11-12T09:40:00.000Z",
          },
        ],
      });
    });
    next.edits.apply("t_00001", "priority");
    await flush();
    expect(next.calls[0]?.input).toMatchObject({ set: { priority: 1 }, base: w.asOf(10) });
    expect(next.row("t_00001")?.priority).toBe(2);
    expect(next.edits.unsaved("t_00001", "priority")).toMatchObject({
      reason: "conflict",
      by: "Codex",
    });
    expect(next.lastToast()?.action?.label).toEqual({ id: "toast.applyMine" });
    // Apply mine is the person's choice over theirs: it goes with the base the screen shows now.
    next.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: next.asOf(13),
      warnings: [],
    }));
    next.edits.apply("t_00001", "priority");
    await flush();
    expect(next.calls[1]?.input).toMatchObject({ set: { priority: 1 }, base: next.asOf(12) });
  });

  test("Try again after a failed call keeps the base the edit was made at, also from its toast: a change someone made since is a conflict", async () => {
    const w = new World([task(1)]);
    w.answer("task.update", () => {
      throw appError("internal", {});
    });
    w.edits.edit(task(1), effortChange("M", w.levels));
    await flush();
    const tryAgain = w.lastToast()?.action;
    expect(tryAgain?.label).toEqual({ id: "toast.tryAgain" });
    w.feed([task(1, { effort: "L", version: 2 })], "agent-1", ["effort"], "agent");
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["effort"],
      as_of: w.asOf(12),
      warnings: [],
    }));
    w.edits.apply("t_00001", "effort");
    await flush();
    expect(w.calls[1]?.input).toMatchObject({ set: { effort: "M" }, base: w.asOf(10) });
    w.feed([task(1, { effort: "M", version: 3 })], String(w.calls[1]?.input["request_id"]), [
      "effort",
    ]);
    w.answer("task.update", () => {
      throw appError("internal", {});
    });
    w.edits.edit(w.row("t_00001") ?? task(1), priorityChange(3));
    await flush();
    w.feed([task(1, { effort: "M", priority: 2, version: 4 })], "agent-2", ["priority"], "agent");
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(14),
      warnings: [],
    }));
    w.lastToast()?.action?.run();
    await flush();
    expect(w.calls[3]?.input).toMatchObject({ set: { priority: 3 }, base: w.asOf(12) });
  });

  test("an edit waiting behind another goes out in its turn while the page stays, is kept as not saved when the page goes, and waits in its turn again once the page is back", async () => {
    let gone: Promise<void> = new Promise(() => undefined);
    let go: () => void = () => undefined;
    const arm = () => {
      gone = new Promise<void>((resolve) => (go = resolve));
    };
    arm();
    const w = new World([task(1)], undefined, () => gone);
    const updated = (seq: number) => ({
      result: "updated",
      task: "M-1",
      fields: [],
      as_of: w.asOf(seq),
      warnings: [],
    });
    let answer: (value: unknown) => void = () => undefined;
    w.answer("task.update", () => new Promise((resolve) => (answer = resolve)));
    w.answer("task.update", () => updated(12));
    // A switch of tabs is no leaving: the priority waits for the rename and then goes.
    w.edits.edit(task(1), titleChange("Oil the gate"));
    w.edits.edit(task(1), priorityChange(1));
    await flush();
    answer(updated(11));
    await flush();
    expect(w.calls.map((c) => c.input["set"])).toEqual([
      { title: "Oil the gate" },
      { priority: 1 },
    ]);
    expect(w.calls[1]?.input).toMatchObject({ base: w.asOf(11) });
    // Into the back-forward cache with a priority waiting: it is kept as not saved there.
    w.answer("task.update", () => new Promise((resolve) => (answer = resolve)));
    w.edits.edit(task(1), titleChange("Oil the gates"));
    w.edits.edit(task(1), priorityChange(2));
    await flush();
    go();
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toMatchObject({
      reason: "failed",
      base: w.asOf(10),
    });
    // Back from the cache, the rename's answer arrives; the next edit waits for its turn again.
    arm();
    answer(updated(13));
    await flush();
    w.answer("task.update", () => new Promise((resolve) => (answer = resolve)));
    w.answer("task.update", () => updated(15));
    w.edits.edit(task(1), titleChange("Oil all gates"));
    w.edits.edit(task(1), effortChange("S", w.levels));
    await flush();
    expect(w.calls).toHaveLength(4);
    answer(updated(14));
    await flush();
    expect(w.calls.map((c) => c.input["set"]).at(-1)).toEqual({ effort: "S" });
    expect(w.edits.unsaved("t_00001", "effort")).toBeUndefined();
  });

  test("a kept edit made against a history the screen no longer shows (a restore since, or no base) is not sent again, and nothing of it is rewritten", async () => {
    const kept = (base: string | undefined): Unsaved => ({
      id: crypto.randomUUID(),
      task: "t_00001",
      ref: "M-1",
      field: "priority",
      change: priorityChange(1),
      reason: "failed",
      ...(base === undefined ? {} : { base }),
    });
    const saves: (readonly Unsaved[])[] = [];
    const restored = new World([task(1)], {
      load: () => [kept("1.10.01234567")],
      save: (unsaved) => {
        saves.push([...new Set(unsaved.values())]);
      },
    });
    const line = restored.edits.unsaved("t_00001", "priority");
    if (line === undefined) throw new Error("the kept edit was not loaded");
    // Of the screen's history, not ahead of it: Try again sends it with its base.
    expect(restored.edits.restored(line)).toBe(false);
    // The space was restored: its history is another epoch and incarnation.
    restored.store.push({
      type: "snapshot",
      space: SPACE,
      cursor: { epoch: 2, incarnation: "ai_zzzzzzzzzzzzzzzzzzzzzzzzzz", seq: 4 },
      tasks: [task(1)],
      nodes: [],
      instances: [],
    });
    restored.store.flush();
    expect(restored.edits.restored(line)).toBe(true);
    restored.edits.apply("t_00001", "priority");
    await flush();
    expect(restored.calls).toEqual([]);
    expect(restored.edits.unsaved("t_00001", "priority")).toBe(line);
    expect(saves).toEqual([]);
    // A failed edit kept with no base alike.
    const old = new World([task(1)], { load: () => [kept(undefined)], save: () => undefined });
    const none = old.edits.unsaved("t_00001", "priority");
    expect(none === undefined ? undefined : old.edits.restored(none)).toBe(true);
    old.edits.apply("t_00001", "priority");
    await flush();
    expect(old.calls).toEqual([]);
  });

  test("Try again on a value that is already there is saved: the conflict that names the person's own value shows no line and no toast", async () => {
    const kept: Unsaved = {
      id: crypto.randomUUID(),
      task: "t_00001",
      ref: "M-1",
      field: "priority",
      change: priorityChange(1),
      reason: "failed",
      base: "1.10.01234567",
    };
    // The edit was saved after all, before the reload: the row shows the person's value.
    const w = new World([task(1, { priority: 1, version: 2 })], {
      load: () => [kept],
      save: () => undefined,
    });
    w.answer("task.update", () => {
      throw appError("conflict", {
        cause: "VERSION_CONFLICT",
        conflicts: [
          {
            task: "M-1",
            field: "priority",
            value: 1,
            version: 11,
            by: "user",
            at: "2026-11-12T09:40:00.000Z",
          },
        ],
      });
    });
    w.edits.apply("t_00001", "priority");
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toBeUndefined();
    expect(w.toasts.some((t) => t?.text.id === "toast.changedBy")).toBe(false);
    expect(w.lastToast()).toBeUndefined();
    // A conflict on another value is still the person's choice.
    w.answer("task.update", () => {
      throw appError("conflict", {
        cause: "VERSION_CONFLICT",
        conflicts: [
          {
            task: "M-1",
            field: "priority",
            value: 2,
            version: 12,
            by: "Codex",
            at: "2026-11-12T09:41:00.000Z",
          },
        ],
      });
    });
    w.edits.edit(task(1, { priority: 1 }), priorityChange(3), { base: w.asOf(10) });
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toMatchObject({
      reason: "conflict",
      by: "Codex",
    });
  });

  test("Try again keeps the stored copy until its request is decided: a page that goes before the answer leaves it for the next", async () => {
    let held: readonly Unsaved[] = [];
    const kept: Unsaved = {
      id: crypto.randomUUID(),
      task: "t_00001",
      ref: "M-1",
      field: "effort",
      change: effortChange("M", "levels-a"),
      reason: "failed",
      base: "1.10.01234567",
    };
    const w = new World([task(1)], {
      load: () => [kept],
      save: (unsaved) => {
        held = [...new Set(unsaved.values())];
      },
    });
    let answer: (value: unknown) => void = () => undefined;
    w.answer("task.update", () => new Promise((resolve) => (answer = resolve)));
    w.edits.apply("t_00001", "effort");
    await flush();
    // The row shows the value on its way, and the browser still holds the copy.
    expect(w.row("t_00001")?.effort).toBe("M");
    expect(w.edits.unsaved("t_00001", "effort")).toBeUndefined();
    expect(held.map((u) => [u.field, u.base])).toEqual([["effort", "1.10.01234567"]]);
    answer({ result: "updated", task: "M-1", fields: ["effort"], as_of: w.asOf(11), warnings: [] });
    await flush();
    expect(held).toEqual([]);
  });

  test("an edit refused because someone finished the task meanwhile keeps the value, and its toast offers no Try again", async () => {
    const w = new World([task(1, { status: "waiting" })]);
    w.answer("task.update", () => {
      // An agent completed the task before the edit arrived.
      w.feed([task(1, { status: "waiting", lifecycle: "completed", version: 2 })], "agent-1", [
        "lifecycle",
      ]);
      throw appError("wrong_tool", { cause: "TASK_NOT_ACTIVE" });
    });
    w.edits.edit(task(1, { status: "waiting" }), waitingChange("Ana Reyes"));
    await flush();
    expect(w.edits.unsaved("t_00001", "waiting_on")?.change.set).toEqual({
      waiting_on: "Ana Reyes",
    });
    expect(w.lastToast()?.kind).toBe("error");
    expect(w.lastToast()?.action).toBeUndefined();
  });

  test("an edit or a check-off the space refuses because it takes no change keeps the value and says why, with no Try again", async () => {
    const w = new World([task(1), task(2)]);
    const readOnly = () => {
      throw appError("read_only", { reason: "read_only_copy", retryable: false });
    };
    w.answer("task.update", readOnly);
    w.edits.edit(task(1), titleChange("Words the person typed"));
    await flush();
    expect(w.edits.unsaved("t_00001", "title")?.change.set).toEqual({
      title: "Words the person typed",
    });
    const why = {
      id: "edit.notSavedReadOnly",
      values: { why: { id: "space.readOnlyWhy", values: { reason: "read_only_copy" } } },
    };
    expect(w.lastToast()).toMatchObject({ kind: "error", text: why });
    expect(w.lastToast()?.action).toBeUndefined();

    w.answer("task.finish", readOnly);
    w.edits.checkOff(task(2));
    await flush();
    expect(w.lastToast()).toMatchObject({ kind: "error", text: why });
    expect(w.lastToast()?.action).toBeUndefined();
  });

  test("an editor hears who else changed a field after it opened, never the tab's own writes", async () => {
    const w = new World([task(1)]);
    const mark = w.edits.mark();
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["due"],
      as_of: w.asOf(11),
      warnings: [],
    }));
    w.edits.edit(task(1), dueChange("2026-11-20", "Fri 20 Nov"));
    await flush();
    w.feed(
      [task(1, { due_date: "2026-11-20", version: 2 })],
      String(w.calls[0]?.input["request_id"]),
      ["due"],
    );
    expect(w.edits.changedSince("t_00001", "due", mark)).toBeUndefined();
    w.feed([task(1, { due_date: "2026-11-25", version: 3 })], "agent-1", ["due"], "agent");
    expect(w.edits.changedSince("t_00001", "due", mark)).toMatchObject({ by: "Codex" });
  });
});

describe("[A5.3.12.web.undo] check-off with its hold, undo and redo, and their conflicts", () => {
  /** An answer's newer work: one author who changed one task since. */
  const work = (task: string | undefined, by: string) => ({
    ...(task === undefined ? {} : { task }),
    by,
    at: "2026-11-12T10:42:00.000Z",
  });
  const intl = createIntl({ locale: SOURCE_LOCALE, messages: CATALOGUE });
  const said = (text: string | Msg | undefined): string =>
    text === undefined || typeof text === "string"
      ? String(text)
      : sayMsg((id, values) => intl.formatMessage({ id }, values), text);

  test("a check-off shows the row checked for a moment and then it leaves, never open again while its write is on its way; clicking again during the hold undoes it", async () => {
    const w = new World([task(1), task(2)]);
    let answer!: (value: unknown) => void;
    w.answer("task.finish", () => new Promise((resolve) => (answer = resolve)));
    w.edits.checkOff(task(1));
    expect(w.calls[0]).toMatchObject({
      name: "task.finish",
      input: { task: "t_00001", base: w.asOf(10) },
    });
    expect(w.edits.getState().leaving.get("t_00001")).toMatchObject({ done: true, out: false });
    expect(w.lastToast()).toMatchObject({ kind: "undo", text: { id: "toast.done" } });
    // The store's row goes at once: only the hold shows it, checked, and every view of the task
    // shows it finished until the write is confirmed.
    expect(w.row("t_00001")).toBeUndefined();
    expect(w.edits.getState().finishing.get("t_00001")?.lifecycle).toBe("completed");
    expect(HOLD_MS + COLLAPSE_MS).toBeLessThan(600);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(w.edits.getState().leaving.get("t_00001")?.out).toBe(true);
    await vi.advanceTimersByTimeAsync(COLLAPSE_MS);
    expect(w.edits.getState().leaving.has("t_00001")).toBe(false);
    // The answer and the feed come late: the row stays gone, and the feed holds it no second time.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.row("t_00001")).toBeUndefined();
    answer({
      result: "completed",
      task: "M-1",
      lifecycle: "completed",
      learnings: 0,
      follow_ups: [],
      as_of: w.asOf(11),
    });
    await flush();
    expect(w.row("t_00001")).toBeUndefined();
    const request = String(w.calls[0]?.input["request_id"]);
    expect(w.edits.getState().finishing.has("t_00001")).toBe(true);
    w.feed([task(1, { lifecycle: "completed", version: 2 })], request, ["lifecycle"]);
    await flush();
    expect(w.edits.getState().finishing.has("t_00001")).toBe(false);
    w.edits.hold(task(1), undefined, 0, request);
    expect(w.row("t_00001")).toBeUndefined();
    expect(w.edits.getState().leaving.has("t_00001")).toBe(false);

    // The second one: the box clicked again during its hold is its undo, by its commit.
    w.answer("task.finish", () => ({
      result: "completed",
      task: "M-2",
      lifecycle: "completed",
      learnings: 0,
      follow_ups: [],
      as_of: w.asOf(12),
    }));
    w.edits.checkOff(task(2));
    await flush();
    w.feed(
      [task(2, { lifecycle: "completed", version: 2 })],
      String(w.calls[1]?.input["request_id"]),
      ["lifecycle"],
    );
    w.answer("history.undo", () => ({
      result: "undone",
      commit: "op_y",
      tasks: ["M-2"],
      lifecycles: ["M-2"],
      task_count: 1,
      as_of: w.asOf(13),
    }));
    w.edits.uncheck("t_00002");
    await flush();
    expect(w.calls[2]).toMatchObject({
      name: "history.undo",
      input: { commit: `op_${"12".padStart(26, "0")}` },
    });
    // Unchecked at once, and kept until the feed brings the row back.
    expect(w.edits.getState().leaving.get("t_00002")).toMatchObject({ done: false });
    w.feed([task(2, { version: 3 })], String(w.calls[2]?.input["request_id"]), ["lifecycle"]);
    expect(w.edits.getState().leaving.has("t_00002")).toBe(false);
    expect(w.row("t_00002")?.lifecycle).toBe("active");
  });

  test("Reopen brings a finished task back with a base, and its toast's Undo finishes it again by its commit", async () => {
    const w = new World([]);
    const done = task(7, { lifecycle: "completed", completed_at: Date.UTC(2026, 10, 3) });
    w.answer("task.reopen", () => ({
      result: "reopened",
      task: "M-7",
      lifecycle: "active",
      status: "open",
      as_of: w.asOf(11),
    }));
    w.edits.reopen(done);
    expect(w.calls[0]).toMatchObject({
      name: "task.reopen",
      // The store does not hold a finished task: its row shows it as of its own version.
      input: { task: "t_00007", base: w.asOf(1) },
    });
    // A person's click has no reason to give, and sends none.
    expect(w.calls[0]?.input).not.toHaveProperty("reason");
    expect(w.lastToast()).toMatchObject({ kind: "undo", text: { id: "toast.reopened" } });
    await flush();
    w.feed([task(7, { version: 2 })], String(w.calls[0]?.input["request_id"]), ["lifecycle"]);
    expect(w.row("t_00007")?.lifecycle).toBe("active");
    w.answer("history.undo", () => ({
      result: "undone",
      commit: "op_r",
      tasks: ["M-7"],
      lifecycles: ["M-7"],
      task_count: 1,
      as_of: w.asOf(12),
    }));
    w.lastToast()?.action?.run();
    await flush();
    expect(w.calls[1]).toMatchObject({
      name: "history.undo",
      input: { commit: `op_${"11".padStart(26, "0")}` },
    });

    // A refusal says so, and offers nothing that would only fail again.
    w.answer("task.reopen", () => {
      throw appError("TASK_NOT_ACTIVE", {});
    });
    w.edits.reopen(task(8, { lifecycle: "archived" }));
    await flush();
    expect(w.lastToast()).toEqual(
      expect.objectContaining({ kind: "error", text: { id: "toast.reopenFailed" } }),
    );
    expect(w.lastToast()?.action).toBeUndefined();
  });

  test("an undo someone's newer work kept says who changed which task, offers no action and sends nothing more", async () => {
    const w = new World([task(1)]);
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["due"],
      as_of: w.asOf(11),
      warnings: [],
    }));
    w.edits.edit(task(1), dueChange("2026-11-13", "Fri 13 Nov"));
    await flush();
    w.feed(
      [task(1, { due_date: "2026-11-13", version: 2 })],
      String(w.calls[0]?.input["request_id"]),
      ["due"],
    );
    w.feed([task(1, { due_date: "2026-11-22", version: 3 })], "agent-1", ["due"], "agent");
    w.answer("history.undo", () => ({
      result: "kept",
      commit: `op_${"11".padStart(26, "0")}`,
      tasks: ["M-1"],
      task_count: 1,
      newer_work: [{ task: "M-1", by: "Codex", at: "2026-11-12T10:42:00.000Z" }],
      as_of: w.asOf(12),
    }));
    await w.edits.undo(STEP);
    const sent = w.calls.length;
    const shown = w.lastToast();
    expect(said(shown?.text)).toBe("Not undone: Codex changed M-1 since, so it stays as it is");
    expect(shown?.kind).toBe("error");
    expect(shown?.action).toBeUndefined();
    await flush();
    expect(w.calls.length).toBe(sent);
  });

  test("a redone check-off's box undoes the redo's commit, never the person's newest change elsewhere", async () => {
    const w = new World([task(1), task(2)]);
    w.answer("task.finish", () => ({
      result: "completed",
      task: "M-1",
      lifecycle: "completed",
      learnings: 0,
      follow_ups: [],
      as_of: w.asOf(11),
    }));
    w.edits.checkOff(task(1));
    await flush();
    w.feed(
      [task(1, { lifecycle: "completed", version: 2 })],
      String(w.calls[0]?.input["request_id"]),
      ["lifecycle"],
    );
    const checked = `op_${"11".padStart(26, "0")}`;
    // Undo: the feed brings the row back before the answer comes.
    w.answer("history.undo", (input) => {
      w.feed([task(1, { version: 3 })], String(input["request_id"]), ["lifecycle"]);
      return {
        result: "undone",
        commit: checked,
        tasks: ["M-1"],
        lifecycles: ["M-1"],
        task_count: 1,
        as_of: w.asOf(12),
      };
    });
    await w.edits.undo(checked);
    await flush();
    // Nothing waits for a row the live rows already show.
    expect(w.edits.getState().leaving.has("t_00001")).toBe(false);
    // Redo: the row is completed again and holds, checked.
    w.answer("history.redo", () => ({
      result: "redone",
      commit: checked,
      tasks: ["M-1"],
      lifecycles: ["M-1"],
      task_count: 1,
      as_of: w.asOf(14),
    }));
    await w.edits.redo(checked);
    const redoRequest = String(w.calls.at(-1)?.input["request_id"]);
    w.feed([task(1, { lifecycle: "completed", version: 4 })], redoRequest, ["lifecycle"]);
    w.edits.hold(task(1), undefined, 0);
    expect(w.edits.getState().leaving.get("t_00001")).toMatchObject({ done: true });
    // Meanwhile the person edits another task.
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-2",
      fields: ["priority"],
      as_of: w.asOf(15),
      warnings: [],
    }));
    w.edits.edit(task(2), priorityChange(1));
    await flush();
    // The box of the redone row undoes the redo's commit by name.
    w.answer("history.undo", () => ({
      result: "undone",
      commit: checked,
      tasks: ["M-1"],
      lifecycles: ["M-1"],
      task_count: 1,
      as_of: w.asOf(16),
    }));
    w.edits.uncheck("t_00001");
    await flush();
    expect(w.calls.at(-1)).toMatchObject({ name: "history.undo", input: { commit: checked } });
  });

  test("a kept undo or redo says which tasks and who, each list short, as the command line says it, and offers nothing", async () => {
    const w = new World([task(1)]);
    const newer = [
      work("M-1", "Codex · work"),
      work("M-2", "run"),
      work("M-1", "Claude · work"),
      work("M-3", "user"),
      work("M-4", "Claude · work"),
    ];
    const kept = (n: number, newer_work: unknown[]) => () => ({
      result: "kept",
      commit: `op_${String(n).padStart(26, "0")}`,
      tasks: [],
      task_count: 0,
      newer_work,
      as_of: w.asOf(n),
    });
    w.answer("history.redo", kept(11, newer));
    await w.edits.redo(STEP);
    const shown = w.lastToast();
    expect(said(shown?.text)).toBe(`Not redone: ${String(newerText(newer))}, so it stays as it is`);
    expect(said(shown?.text)).toBe(
      "Not redone: Codex · work, a run and 2 more changed M-1, M-2 and 2 more since, so it stays as it is",
    );
    expect(shown?.action).toBeUndefined();
    // A group's change names no task.
    w.answer("history.undo", kept(12, [work(undefined, "import")]));
    await w.edits.undo(STEP);
    expect(said(w.lastToast()?.text)).toBe(
      "Not undone: the import changed it since, so it stays as it is",
    );
  });

  test("nothing to undo, a newer change first, and a toast whose commit is unknown each say so and change nothing", async () => {
    const w = new World([task(1)]);
    w.answer("history.undo", () => {
      throw appError("not_found", { cause: "NOTHING_TO_UNDO" });
    });
    await w.edits.undo(STEP);
    expect(w.lastToast()?.text).toEqual({ id: "toast.nothingToUndo" });
    w.answer("history.undo", () => {
      throw appError("conflict", { cause: "INVALID_TRANSITION" });
    });
    await w.edits.undo("op_old");
    expect(w.lastToast()?.text).toEqual({ id: "toast.newerFirst" });
    // A toast's write the feed confirmed without its commit, and whose receipt names none (it was
    // refused): nothing is undone.
    w.answer("receipt.get", () => ({ found: false }));
    await w.edits.undo({ commit: Promise.resolve(undefined), request: "rq-gone" });
    expect(w.calls.map((c) => c.name).filter((n) => n.startsWith("history"))).toHaveLength(2);
    expect(w.lastToast()?.text).toEqual({ id: "toast.undoUnknown" });
  });
});

describe("[A5.3.12.web.undo-steps] Undo for the steps worth it, and Redo beside it", () => {
  const commitAt = (seq: number) => `op_${String(seq).padStart(26, "0")}`;
  /** A check-off of `n` that lands at `seq`, the feed confirming it. */
  async function checkedOff(w: World, n: number, seq: number): Promise<void> {
    w.answer("task.finish", () => ({
      result: "completed",
      task: `M-${String(n)}`,
      lifecycle: "completed",
      learnings: 0,
      follow_ups: [],
      as_of: w.asOf(seq),
    }));
    w.edits.checkOff(task(n));
    await flush();
    w.feed(
      [task(n, { lifecycle: "completed", version: 2 })],
      String(w.calls.at(-1)?.input["request_id"]),
      ["lifecycle"],
    );
  }
  const undone = (w: World, commit: string, seq: number) => () => ({
    result: "undone",
    commit,
    tasks: [],
    task_count: 0,
    as_of: w.asOf(seq),
  });
  const history = (w: World) => w.calls.filter((c) => c.name.startsWith("history"));

  test("a priority change after a check-off shows no toast, takes the check-off's Undo away, and Ctrl+Z then undoes nothing", async () => {
    const w = new World([task(1), task(2)]);
    await checkedOff(w, 1, 11);
    expect(w.lastToast()).toMatchObject({ text: { id: "toast.done" } });
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-2",
      fields: ["priority"],
      as_of: w.asOf(12),
      warnings: [],
    }));
    w.edits.edit(task(2), priorityChange(1));
    expect(w.lastToast()).toBeUndefined();
    await flush();
    await w.edits.undo();
    expect(history(w)).toEqual([]);
    expect(w.lastToast()?.text).toEqual({ id: "toast.nothingToUndo" });
  });

  test("an Undo toast keeps its button while the feed brings changes of every kind, and its Undo goes to the service, which may refuse it with its reason", async () => {
    const w = new World([task(1), task(2)]);
    await checkedOff(w, 1, 11);
    const offered = w.lastToast();
    expect(offered).toMatchObject({
      text: { id: "toast.done" },
      action: { label: { id: "toast.undo" } },
    });
    // An agent's change, a session's record under the person's name, and the person's change in
    // another tab.
    w.feed([task(2, { priority: 2, version: 2 })], "agent-1", ["priority"], "agent");
    w.seq += 1;
    w.store.push({
      type: "batch",
      space_id: SPACE.id,
      epoch: 1,
      incarnation: INCARNATION,
      from: w.seq - 1,
      through: w.seq,
      events: [
        {
          seq: w.seq,
          op_id: `op_${String(w.seq).padStart(26, "0")}`,
          request_id: "launch-1",
          actor: { kind: "human", label: "Mira" },
          kind: "ops",
          entities: [
            {
              type: "launch",
              id: "la_1",
              task: "t_00002",
              row: null,
              changed: ["state"],
              created: false,
            },
          ],
        },
      ],
    });
    w.store.flush();
    w.feed([task(2, { priority: 3, version: 4 })], "other-window", ["priority"]);
    expect(w.lastToast()).toBe(offered);
    // The service refuses it: the person's newer change elsewhere comes first, and the toast says so.
    w.answer("history.undo", () => {
      throw appError("conflict", { cause: "INVALID_TRANSITION" });
    });
    await w.edits.undo();
    expect(history(w).at(-1)?.input).toMatchObject({ commit: commitAt(11) });
    expect(w.lastToast()?.text).toEqual({ id: "toast.newerFirst" });
  });

  test("a change whose old value the page cannot choose again keeps Undo: out of the Inbox, and a first area; a move between areas does not", async () => {
    const w = new World([task(1, { inbox: true }), task(2), task(3, { parent: "a_home" })]);
    const answered = (ref: string) => () => ({
      result: "updated",
      task: ref,
      fields: [],
      as_of: w.asOf(11),
      warnings: [],
    });
    w.answer("task.update", answered("M-1"));
    w.edits.edit(task(1, { inbox: true }), triageChange());
    expect(w.lastToast()).toMatchObject({ kind: "undo", action: { label: { id: "toast.undo" } } });
    w.answer("task.update", answered("M-2"));
    w.edits.edit(task(2), groupingChange({ id: "a_home", title: "Home" }, undefined));
    expect(w.lastToast()).toMatchObject({ kind: "undo", action: { label: { id: "toast.undo" } } });
    w.answer("task.update", answered("M-3"));
    w.edits.edit(
      task(3, { parent: "a_home" }),
      groupingChange({ id: "a_yard", title: "Yard" }, undefined),
    );
    expect(w.lastToast()).toBeUndefined();
    await flush();
  });

  test("Ctrl+Z takes back a run of steps newest first, by their commits", async () => {
    const w = new World([task(1), task(2)]);
    await checkedOff(w, 1, 11);
    await checkedOff(w, 2, 12);
    w.answer("history.undo", undone(w, commitAt(12), 13));
    w.answer("history.undo", undone(w, commitAt(11), 14));
    await w.edits.undo();
    await w.edits.undo();
    expect(history(w).map((c) => c.input["commit"])).toEqual([commitAt(12), commitAt(11)]);
    await w.edits.undo();
    expect(history(w)).toHaveLength(2);
  });

  test("Undo then Redo of a check-off: Undo and Redo side by side, Redo by its commit, and another change ends Redo", async () => {
    const w = new World([task(1), task(2)]);
    await checkedOff(w, 1, 11);
    w.answer("history.undo", undone(w, commitAt(11), 12));
    w.lastToast()?.action?.run();
    await flush();
    const after = w.lastToast();
    expect(after).toMatchObject({
      kind: "undo",
      text: { id: "toast.undone" },
      action: { label: { id: "toast.undo" }, disabled: true },
      second: { label: { id: "toast.redo" } },
    });
    expect(after?.second?.disabled).toBeUndefined();
    w.answer("history.redo", () => ({
      result: "redone",
      commit: commitAt(11),
      tasks: ["M-1"],
      lifecycles: ["M-1"],
      task_count: 1,
      as_of: w.asOf(13),
    }));
    after?.second?.run();
    await flush();
    expect(history(w).at(-1)).toMatchObject({
      name: "history.redo",
      input: { commit: commitAt(11) },
    });
    expect(w.lastToast()).toMatchObject({
      text: { id: "toast.redone" },
      action: { label: { id: "toast.undo" } },
      second: { label: { id: "toast.redo" }, disabled: true },
    });
    expect(w.lastToast()?.action?.disabled).toBeUndefined();
    // Undone once more, then another change: nothing is left to redo.
    w.answer("history.undo", undone(w, commitAt(11), 14));
    await w.edits.undo();
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-2",
      fields: ["priority"],
      as_of: w.asOf(15),
      warnings: [],
    }));
    w.edits.edit(task(2), priorityChange(1));
    await flush();
    const sent = history(w).length;
    await w.edits.redo();
    expect(history(w)).toHaveLength(sent);
    expect(w.lastToast()?.text).toEqual({ id: "toast.nothingToRedo" });
  });
});

describe("[A5.3.12.web.undo-late] Undo and Redo when answers come late, or not at all", () => {
  const commitAt = (seq: number) => `op_${String(seq).padStart(26, "0")}`;
  const history = (w: World) => w.calls.filter((c) => c.name.startsWith("history"));
  const network = () => {
    throw new Error("network");
  };
  async function checkedOff(w: World, n: number, seq: number): Promise<void> {
    w.answer("task.finish", () => ({
      result: "completed",
      task: `M-${String(n)}`,
      lifecycle: "completed",
      learnings: 0,
      follow_ups: [],
      as_of: w.asOf(seq),
    }));
    w.edits.checkOff(task(n));
    await flush();
    w.feed(
      [task(n, { lifecycle: "completed", version: 2 })],
      String(w.calls.at(-1)?.input["request_id"]),
      ["lifecycle"],
    );
  }

  test("the feed naming the tab's own step before its answer leaves the step and its toast", async () => {
    const w = new World([task(1)]);
    let answer!: (value: { result: string; as_of: string }) => void;
    let request = "";
    const written = w.edits.write(
      (sent) => {
        request = sent;
        return new Promise<{ result: string; as_of: string }>((resolve) => (answer = resolve));
      },
      () => ({ id: "toast.noteRemoved", values: { ref: "M-1" } }),
      { undo: true },
    );
    await flush();
    w.feed([task(1, { version: 2 })], request, []);
    answer({ result: "updated", as_of: w.asOf(11) });
    await written;
    expect(w.lastToast()).toMatchObject({ kind: "undo", action: { label: { id: "toast.undo" } } });
    w.answer("history.undo", () => ({
      result: "undone",
      commit: commitAt(11),
      tasks: [],
      task_count: 0,
      as_of: w.asOf(12),
    }));
    await w.edits.undo();
    expect(history(w).at(-1)?.input).toMatchObject({ commit: commitAt(11) });
  });

  test("Ctrl+Shift+Z pressed before the undo's answer redoes the step that undo took back", async () => {
    const w = new World([task(1), task(2)]);
    await checkedOff(w, 1, 11);
    await checkedOff(w, 2, 12);
    w.answer("history.undo", () => ({
      result: "undone",
      commit: commitAt(12),
      tasks: [],
      task_count: 0,
      as_of: w.asOf(13),
    }));
    w.answer("history.redo", () => ({
      result: "redone",
      commit: commitAt(12),
      tasks: [],
      task_count: 0,
      as_of: w.asOf(14),
    }));
    const undone = w.edits.undo();
    const redone = w.edits.redo();
    await Promise.all([undone, redone]);
    expect(history(w).map((c) => [c.name, c.input["commit"]])).toEqual([
      ["history.undo", commitAt(12)],
      ["history.redo", commitAt(12)],
    ]);
  });

  test("a field edit made while an undo or a redo is on its way is sent after it, and saved", async () => {
    const w = new World([task(1), task(2)]);
    await checkedOff(w, 1, 11);
    let undone!: (value: unknown) => void;
    w.answer("history.undo", () => new Promise((resolve) => (undone = resolve)));
    void w.edits.undo();
    await flush();
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-2",
      fields: ["priority"],
      as_of: w.asOf(13),
      warnings: [],
    }));
    w.edits.edit(task(2), priorityChange(1));
    expect(w.row("t_00002")?.priority).toBe(1);
    undone({
      result: "undone",
      commit: commitAt(11),
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(12),
    });
    await flush();
    expect(w.calls.filter((c) => c.name === "task.update")).toHaveLength(1);

    // The same behind a redo.
    let redone!: (value: unknown) => void;
    w.answer("history.redo", () => new Promise((resolve) => (redone = resolve)));
    void w.edits.redo(commitAt(11));
    await flush();
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-2",
      fields: ["priority"],
      as_of: w.asOf(15),
      warnings: [],
    }));
    w.edits.edit(task(2, { priority: 1, version: 2 }), priorityChange(2));
    redone({
      result: "redone",
      commit: commitAt(11),
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(14),
    });
    await flush();
    expect(w.calls.filter((c) => c.name === "task.update")).toHaveLength(2);
    expect(w.edits.unsaved("t_00002", "priority")).toBeUndefined();
  });

  test("an undo that got no answer keeps its step: Ctrl+Z tries the same step again", async () => {
    const w = new World([task(1)]);
    await checkedOff(w, 1, 11);
    w.answer("history.undo", network);
    w.answer("history.undo", network);
    w.answer("receipt.get", network);
    const failed = w.edits.undo();
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await failed;
    expect(w.lastToast()?.text).toEqual({ id: "toast.undoFailed" });
    w.answer("history.undo", () => ({
      result: "undone",
      commit: commitAt(11),
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(12),
    }));
    await w.edits.undo();
    expect(history(w).at(-1)?.input).toMatchObject({ commit: commitAt(11) });
    expect(w.lastToast()?.text).toEqual({ id: "toast.undone" });
  });

  test("a late answer offers nothing the person has moved past: no Undo after a priority, no Redo after a check-off", async () => {
    const w = new World([task(1), task(2), task(3)]);
    // A note removed, a priority chosen before the removal's answer: its toast comes with no Undo.
    let answer!: (value: { result: string; as_of: string }) => void;
    const written = w.edits.write(
      () => new Promise<{ result: string; as_of: string }>((resolve) => (answer = resolve)),
      () => ({ id: "toast.noteRemoved", values: { ref: "M-1" } }),
      { undo: true },
    );
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-2",
      fields: ["priority"],
      as_of: w.asOf(12),
      warnings: [],
    }));
    w.edits.edit(task(2), priorityChange(1));
    await flush();
    answer({ result: "updated", as_of: w.asOf(11) });
    await written;
    await flush();
    expect(w.lastToast()).toMatchObject({ kind: "info", text: { id: "toast.noteRemoved" } });
    expect(w.lastToast()?.action).toBeUndefined();

    // An undo still on its way when another task is checked off: its answer offers no Redo.
    await checkedOff(w, 1, 13);
    let undone!: (value: unknown) => void;
    w.answer("history.undo", () => new Promise((resolve) => (undone = resolve)));
    const asked = w.edits.undo();
    await flush();
    w.answer("task.finish", () => ({
      result: "completed",
      task: "M-3",
      lifecycle: "completed",
      learnings: 0,
      follow_ups: [],
      as_of: w.asOf(15),
    }));
    w.edits.checkOff(task(3));
    undone({
      result: "undone",
      commit: commitAt(13),
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(14),
    });
    await asked;
    await flush();
    const sent = history(w).length;
    await w.edits.redo();
    expect(history(w)).toHaveLength(sent);
    expect(w.lastToast()?.text).toEqual({ id: "toast.nothingToRedo" });
  });
});

describe("[A5.3.12.web.undo-levels] the effort levels beside Undo: a checked row and a kept size", () => {
  test("a checked row's box undoes the check-off that checked it, whatever was redone since", async () => {
    const w = new World([task(1), task(2)]);
    // The check-off, redone: its row holds, checked.
    w.answer("history.redo", () => ({
      result: "redone",
      commit: "op_check",
      tasks: ["M-1"],
      task_count: 1,
      lifecycles: ["M-1"],
      as_of: w.asOf(12),
    }));
    await w.edits.redo(STEP);
    w.edits.hold(task(1), undefined, 0);
    // The swap of two sizes, redone after it: it names the task too, and checks nothing off.
    w.answer("history.redo", () => ({
      result: "redone",
      commit: "op_swap",
      tasks: ["M-1", "M-2"],
      task_count: 2,
      levels: { list: false, tasks: 2 },
      as_of: w.asOf(13),
    }));
    await w.edits.redo(STEP);
    expect(w.edits.getState().leaving.get("t_00001")).toMatchObject({ done: true });
    w.answer("history.undo", () => ({
      result: "undone",
      commit: "op_check",
      tasks: ["M-1"],
      task_count: 1,
      lifecycles: ["M-1"],
      as_of: w.asOf(14),
    }));
    w.edits.uncheck("t_00001");
    await flush();
    expect(w.calls.at(-1)).toMatchObject({ name: "history.undo", input: { commit: "op_check" } });
  });

  test("a size kept unsent is not sent again, by its line or its toast, once the levels changed", async () => {
    const w = new World([task(1)]);
    w.answer("task.update", () => {
      throw appError("internal", {});
    });
    w.edits.edit(task(1), effortChange("M", w.levels));
    await flush();
    const tryAgain = w.lastToast()?.action;
    expect(tryAgain?.label).toEqual({ id: "toast.tryAgain" });
    w.levels = "levels-b";
    tryAgain?.run();
    w.edits.apply("t_00001", "effort");
    await flush();
    expect(w.calls.filter((c) => c.name === "task.update")).toHaveLength(1);
    expect(w.edits.unsaved("t_00001", "effort")?.change.set).toEqual({ effort: "M" });
  });
});

describe("[A5.3.11.web.edit-queue] no request holds the edit queue for ever", () => {
  const never = () => new Promise(() => undefined);
  const undone = (w: World, seq: number, commit = "op_c") => ({
    result: "undone",
    commit,
    tasks: [],
    task_count: 0,
    as_of: w.asOf(seq),
  });
  const updated = (w: World, seq: number) => ({
    result: "updated",
    task: "M-1",
    fields: [],
    as_of: w.asOf(seq),
    warnings: [],
  });
  /** A receipt for an applied request: where it landed, and the commit its operation moved. */
  const applied = (w: World, request: string, seq: number, id = "op_c") => ({
    found: true,
    request,
    status: "applied",
    decided_at: "2026-11-12T10:00:00.000Z",
    as_of: w.asOf(seq),
    incarnation: INCARNATION,
    commit: `op_${String(seq).padStart(26, "0")}`,
    results: [{ i: 0, status: "updated", id, version: seq }],
    warnings: [],
  });
  const names = (w: World) => w.calls.map((c) => c.name);
  const requestOf = (w: World, name: string, nth = 0) =>
    String(w.calls.filter((c) => c.name === name)[nth]?.input["request_id"]);
  const down = () => {
    throw new Error("network");
  };

  test("an undo that gets no answer holds later edits until its receipt says what it did; they then go out with a base past it", async () => {
    const w = new World([task(1), task(2)]);
    w.answer("history.undo", never);
    w.answer("history.undo", never);
    void w.edits.undo(STEP);
    // The person edits two tasks after Ctrl+Z: each shows at once, and waits for the undo.
    w.edits.edit(task(2), effortChange("M", w.levels));
    w.edits.edit(task(1), priorityChange(1));
    expect(w.row("t_00002")?.effort).toBe("M");
    expect(w.row("t_00001")?.priority).toBe(1);
    await flush();
    expect(names(w)).toEqual(["history.undo"]);
    const undo = requestOf(w, "history.undo");
    w.answer("receipt.get", (input) => applied(w, String(input["request"]), 11));
    w.answer("task.update", () => updated(w, 12));
    w.answer("task.update", () => updated(w, 13));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    // Asked by the undo's own ID, and sent again with the same ID, which applies it at most once.
    expect(w.calls.find((c) => c.name === "receipt.get")?.input).toEqual({ request: undo });
    expect(requestOf(w, "history.undo", 1)).toBe(undo);
    // The undo's commit (seq 11) directly follows what the person saw: the bases move past it.
    expect(w.calls.filter((c) => c.name === "task.update").map((c) => c.input)).toEqual([
      expect.objectContaining({ task: "t_00002", base: w.asOf(11) }),
      expect.objectContaining({ task: "t_00001", base: w.asOf(11) }),
    ]);
    expect(w.toasts.some((t) => t?.text.id === "toast.undone")).toBe(true);
    expect(w.edits.getState().unsaved.size).toBe(0);
  });

  test("an undo the service has not decided yet is sent again with its own ID, and that answer lets the queue go on", async () => {
    const w = new World([task(1), task(2)]);
    w.answer("history.undo", never);
    w.answer("history.undo", () => undone(w, 11));
    w.answer("receipt.get", () => ({ found: false }));
    w.answer("task.update", () => updated(w, 12));
    void w.edits.undo(STEP);
    w.edits.edit(task(2), effortChange("M", w.levels));
    await flush();
    expect(names(w)).toEqual(["history.undo"]);
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    expect(requestOf(w, "history.undo", 1)).toBe(requestOf(w, "history.undo"));
    expect(w.calls.find((c) => c.name === "task.update")?.input).toMatchObject({
      task: "t_00002",
      base: w.asOf(11),
    });
  });

  test("a slow answer that comes after the page asked is still taken: no third send, and the edit goes out once", async () => {
    const w = new World([task(1), task(2)]);
    let answerFirst!: (value: unknown) => void;
    w.answer("history.undo", () => new Promise((resolve) => (answerFirst = resolve)));
    w.answer("history.undo", never);
    w.answer("receipt.get", () => ({ found: false }));
    w.answer("task.update", () => updated(w, 12));
    void w.edits.undo(STEP);
    w.edits.edit(task(2), effortChange("M", w.levels));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    expect(names(w)).toEqual(["history.undo", "history.undo", "receipt.get"]);
    answerFirst(undone(w, 11));
    await flush();
    expect(names(w)).toEqual(["history.undo", "history.undo", "receipt.get", "task.update"]);
    expect(w.toasts.filter((t) => t?.text.id === "toast.undone")).toHaveLength(1);
  });

  test("when the outcome cannot be learned, the waiting edits are kept as not saved and never sent; Try again asks again first", async () => {
    const w = new World([task(1), task(2)]);
    w.answer("history.undo", never);
    // The service is down: the receipt and the second send fail on the way.
    w.answer("history.undo", down);
    w.answer("receipt.get", down);
    void w.edits.undo(STEP);
    w.edits.edit(task(2), effortChange("M", w.levels));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    // Nothing went out after the undo, and nothing of the person's is lost.
    expect(names(w).filter((n) => n === "task.update")).toEqual([]);
    expect(w.row("t_00002")?.effort).toBeUndefined();
    expect(w.edits.unsaved("t_00002", "effort")).toMatchObject({ reason: "failed" });
    expect(w.toasts.some((t) => t?.text.id === "toast.undoFailed")).toBe(true);
    expect(w.lastToast()).toMatchObject({
      kind: "error",
      action: { label: { id: "toast.tryAgain" } },
    });
    // A later edit asks again first, and is kept too: Ctrl+Z might still take back the newest.
    w.answer("history.undo", down);
    w.answer("receipt.get", down);
    w.edits.edit(task(1), priorityChange(1));
    await flush();
    expect(names(w).filter((n) => n === "task.update")).toEqual([]);
    expect(w.edits.unsaved("t_00001", "priority")).toMatchObject({ reason: "failed" });
    // The service is back: Try again first learns what the undo did, then sends the edit.
    const undo = requestOf(w, "history.undo");
    w.answer("history.undo", never);
    w.answer("receipt.get", (input) => applied(w, String(input["request"]), 11));
    w.answer("task.update", () => updated(w, 12));
    w.edits.apply("t_00002", "effort");
    expect(w.row("t_00002")?.effort).toBe("M");
    await flush();
    expect(w.calls.filter((c) => c.name === "receipt.get").at(-1)?.input).toEqual({
      request: undo,
    });
    expect(w.calls.filter((c) => c.name === "task.update").map((c) => c.input)).toEqual([
      expect.objectContaining({ task: "t_00002", set: { effort: "M" }, base: w.asOf(11) }),
    ]);
  });

  test.each(["answer", "receipt"])(
    "a stalled page handles the ready answer before the overdue %s deadline",
    async (stage) => {
      const row = task(1);
      const w = new World([row]);
      const first = Promise.withResolvers<ReturnType<typeof updated>>();
      w.answer("task.update", () => first.promise);
      w.edits.edit(row, priorityChange(1));
      w.edits.edit(row, effortChange("M", w.levels));
      if (stage === "receipt") {
        w.answer("task.update", never);
        w.answer("receipt.get", never);
        await vi.advanceTimersByTimeAsync(ASK_MS);
      }
      const sent = w.calls.length;
      const reply = updated(w, 11);
      // The service has answered. On resume the overdue timer runs before the response callback.
      vi.setSystemTime(Date.now() + 30_000);
      await vi.advanceTimersToNextTimerAsync();
      w.answer("task.update", () => updated(w, 12));
      first.resolve(reply);
      await flush();

      expect(w.calls.slice(sent)).toMatchObject([
        { name: "task.update", input: { set: { effort: "M" }, base: w.asOf(11) } },
      ]);
      expect(w.toasts).toEqual([]);
      expect(w.edits.getState().unsaved.size).toBe(0);
    },
  );

  test("a late receipt deadline gives an unanswered edit only one more wait, even if the page stalls again", async () => {
    const row = task(1);
    const w = new World([row]);
    w.answer("task.update", never);
    w.answer("task.update", never);
    w.answer("receipt.get", never);
    w.edits.edit(row, priorityChange(1));
    await vi.advanceTimersByTimeAsync(ASK_MS);

    vi.setSystemTime(Date.now() + 30_000);
    await vi.advanceTimersToNextTimerAsync();
    expect(w.edits.unsaved(row.id, "priority")).toBeUndefined();
    vi.setSystemTime(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(ASK_MS);
    expect(w.edits.unsaved(row.id, "priority")).toMatchObject({ reason: "failed" });
    expect(w.lastToast()?.action?.label.id).toBe("toast.tryAgain");
  });

  test.each(["effort", "check-off"])(
    "an unanswered priority restores the row and keeps the queued %s from going out",
    async (next) => {
      const row = task(1);
      const w = new World([row]);
      w.answer("task.update", never);
      w.answer("task.update", never);
      w.answer("receipt.get", never);
      w.edits.edit(row, priorityChange(1));
      if (next === "effort") {
        w.edits.edit(row, effortChange("M", w.levels));
        expect(w.row(row.id)?.effort).toBe("M");
      } else {
        w.edits.checkOff(row);
        expect(w.row(row.id)).toBeUndefined();
      }
      await vi.advanceTimersByTimeAsync(2 * ASK_MS);

      expect(names(w)).toEqual(["task.update", "task.update", "receipt.get"]);
      expect(w.calls[1]).toEqual(w.calls[0]);
      expect(w.edits.unsaved(row.id, "priority")).toMatchObject({ reason: "failed" });
      expect(w.row(row.id)).toMatchObject({ lifecycle: "active", status: "open" });
      if (next === "effort") {
        expect(w.edits.unsaved(row.id, "effort")).toMatchObject({ reason: "failed" });
        expect(w.row(row.id)?.effort).toBeUndefined();
        expect(w.lastToast()?.action?.label.id).toBe("toast.tryAgain");
      }
    },
  );

  test("an edit without an answer: the next edit of the task waits for its receipt, and its base moves past it", async () => {
    const w = new World([task(1)]);
    w.answer("task.update", never);
    w.answer("task.update", never);
    w.edits.edit(task(1), priorityChange(1));
    w.edits.edit(task(1), priorityChange(2));
    await flush();
    expect(names(w)).toEqual(["task.update"]);
    const first = requestOf(w, "task.update");
    w.answer("receipt.get", (input) => applied(w, String(input["request"]), 11));
    w.answer("task.update", () => updated(w, 12));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    const updates = w.calls.filter((c) => c.name === "task.update").map((c) => c.input);
    // The first sent again with its own ID and base, then the second with a base past the first.
    expect(updates[1]).toEqual(updates[0]);
    expect(updates[2]).toMatchObject({ set: { priority: 2 }, base: w.asOf(11) });
    expect(updates[2]?.["request_id"]).not.toBe(first);
    expect(w.edits.getState().unsaved.size).toBe(0);
  });

  test("an edit kept as not saved because no answer came goes once the feed shows it was saved", async () => {
    const w = new World([task(1)]);
    w.answer("task.update", never);
    w.answer("task.update", down);
    w.answer("receipt.get", down);
    w.edits.edit(task(1), priorityChange(1));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toMatchObject({ reason: "failed" });
    // It had reached the service: the feed brings it, and its receipt says so.
    w.answer("receipt.get", (input) => applied(w, String(input["request"]), 11));
    w.answer("task.update", never);
    w.feed([task(1, { priority: 1, version: 2 })], requestOf(w, "task.update"), ["priority"]);
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toBeUndefined();
  });

  test("a toast's Undo clicked before the feed names the commit takes its place at once: an edit made after it goes out after it", async () => {
    const w = new World([task(1), task(2)]);
    w.answer("task.update", () => updated(w, 11));
    w.answer("history.undo", () => undone(w, 12));
    w.answer("task.update", () => updated(w, 13));
    w.edits.edit(task(1), titleChange("Renamed"));
    await flush();
    // The answer came; the feed has not named the commit yet. Undo, then another task's edit.
    w.lastToast()?.action?.run();
    w.edits.edit(task(2), effortChange("M", w.levels));
    await flush();
    expect(names(w)).toEqual(["task.update"]);
    w.feed([task(1, { title: "Renamed", version: 2 })], requestOf(w, "task.update"), ["title"]);
    await flush();
    expect(w.calls.map((c) => [c.name, c.input["task"] ?? c.input["commit"]])).toEqual([
      ["task.update", "t_00001"],
      ["history.undo", `op_${"11".padStart(26, "0")}`],
      ["task.update", "t_00002"],
    ]);
  });

  test("a toast's Undo whose commit the feed never names takes it from the write's receipt", async () => {
    const w = new World([task(1), task(2)]);
    w.answer("task.update", () => updated(w, 11));
    w.answer("history.undo", () => undone(w, 12));
    w.answer("task.update", () => updated(w, 13));
    w.edits.edit(task(1), titleChange("Renamed"));
    await flush();
    const write = requestOf(w, "task.update");
    w.answer("receipt.get", (input) => applied(w, String(input["request"]), 11));
    w.lastToast()?.action?.run();
    w.edits.edit(task(2), effortChange("M", w.levels));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    expect(
      w.calls.map((c) => [c.name, c.input["task"] ?? c.input["commit"] ?? c.input["request"]]),
    ).toEqual([
      ["task.update", "t_00001"],
      ["receipt.get", write],
      ["history.undo", `op_${"11".padStart(26, "0")}`],
      ["task.update", "t_00002"],
    ]);
  });
});

describe("[A5.3.11.web.edit-queue] an outcome is decided once, and what arrives later is reconciled against it", () => {
  const updated = (w: World, seq: number) => ({
    result: "updated",
    task: "M-1",
    fields: [],
    as_of: w.asOf(seq),
    warnings: [],
  });
  const down = () => {
    throw new Error("network");
  };
  const conflict = appError("conflict", {
    cause: "VERSION_CONFLICT",
    conflicts: [
      {
        task: "M-1",
        field: "priority",
        value: 3,
        version: 11,
        by: "Codex",
        at: "2026-11-12T09:40:00.000Z",
      },
    ],
  });
  /**
   * The first send of the next request of `name` hangs until the test settles it, and the page
   * cannot learn its outcome (the replay and the receipt fail on the way): it shows as not saved.
   */
  const hanging = (w: World, name: string) => {
    const first: { resolve?: (value: unknown) => void; reject?: (error: Error) => void } = {};
    w.answer(
      name,
      () =>
        new Promise((resolve, reject: (error: Error) => void) => {
          first.resolve = resolve;
          first.reject = reject;
        }),
    );
    w.answer(name, down);
    w.answer("receipt.get", down);
    return first;
  };
  const updates = (w: World) => w.calls.filter((c) => c.name === "task.update").map((c) => c.input);

  test("the original answer of a request its replay decided moves no base back past the tab's own later write", async () => {
    const w = new World([task(1)]);
    let answerFirst!: (value: unknown) => void;
    w.answer("task.update", () => new Promise((resolve) => (answerFirst = resolve)));
    // The replay with the same request ID answers: the edit landed at 11.
    w.answer("task.update", () => updated(w, 11));
    w.answer("receipt.get", () => ({ found: false }));
    w.edits.edit(task(1), priorityChange(1));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    // The feed is stalled at 10. Another window changes another field at 12; this tab's next
    // priority edit commits at 13.
    w.answer("task.update", () => updated(w, 13));
    w.edits.edit(task(1), priorityChange(2));
    await flush();
    expect(updates(w)[2]).toMatchObject({ set: { priority: 2 }, base: w.asOf(11) });
    // The first send's own answer comes at last, with the same as_of as its replay.
    answerFirst(updated(w, 11));
    await flush();
    w.answer("task.update", () => updated(w, 14));
    w.edits.edit(task(1), priorityChange(3));
    await flush();
    expect(updates(w)[3]).toMatchObject({ set: { priority: 3 }, base: w.asOf(13) });
  });

  test("a conflict decided after the edit showed as not saved replaces Try again with who changed it and Apply mine", async () => {
    const w = new World([task(1)]);
    const first = hanging(w, "task.update");
    w.edits.edit(task(1), priorityChange(1));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toMatchObject({ reason: "failed" });
    expect(w.lastToast()?.action?.label).toEqual({ id: "toast.tryAgain" });
    first.reject?.(conflict);
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toMatchObject({
      reason: "conflict",
      by: "Codex",
    });
    expect(w.lastToast()).toMatchObject({
      kind: "error",
      text: { id: "toast.changedBy" },
      action: { label: { id: "toast.applyMine" } },
    });
  });

  test("a finished task's refusal decided late leaves no Try again that would only fail again", async () => {
    const w = new World([task(1)]);
    const first = hanging(w, "task.update");
    w.edits.edit(task(1), priorityChange(1));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    first.reject?.(appError("wrong_tool", { cause: "TASK_NOT_ACTIVE" }));
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toMatchObject({ reason: "failed" });
    expect(w.lastToast()).toMatchObject({ kind: "error" });
    expect(w.lastToast()?.action).toBeUndefined();
  });

  test("a kept edit discarded in another tab while it is sent again from here stays gone when that request is refused", async () => {
    let gone: (unsaved: Unsaved) => void = () => undefined;
    let held: readonly Unsaved[] = [];
    const keeper: Keeper = {
      load: () => [],
      save: (unsaved) => {
        held = [...new Set(unsaved.values())];
      },
      onGone: (listener) => {
        gone = listener;
        return () => undefined;
      },
    };
    const w = new World([task(1)], keeper);
    w.answer("task.update", () => {
      throw new Error("network");
    });
    w.edits.edit(task(1), titleChange("Oil the gate"), { base: w.asOf(10) });
    await flush();
    const line = w.edits.unsaved("t_00001", "title");
    if (line === undefined) throw new Error("the refused edit was not kept");
    hanging(w, "task.update");
    w.edits.apply("t_00001", "title");
    await flush();
    expect(w.edits.sendingKept(line.id)).toBe(true);
    expect(held).toEqual([line]);
    // The other tab's Discard arrives while the request is on its way, and no answer comes.
    gone(line);
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    expect(w.edits.unsaved("t_00001", "title")).toBeUndefined();
    expect(held).toEqual([]);
    expect(w.lastToast()).toBeUndefined();
  });

  test("a late refusal keeps the person's newer choices: a discarded value stays gone, a newer edit stands, and a newer toast stays", async () => {
    const w = new World([task(1), task(2)]);
    const one = hanging(w, "task.update");
    w.edits.edit(task(1), priorityChange(1));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    // Discarded: the late conflict brings nothing back, and takes the stale Try again away.
    w.edits.dismiss("t_00001", "priority");
    one.reject?.(conflict);
    await flush();
    expect(w.edits.unsaved("t_00001", "priority")).toBeUndefined();
    expect(w.lastToast()).toBeUndefined();

    // Another edit's toast took the place of the edit's Try again: the late refusal updates the
    // line under the field and leaves the newer toast alone.
    const two = hanging(w, "task.update");
    w.edits.edit(task(2), effortChange("M", w.levels));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    w.answer("task.update", () => updated(w, 12));
    w.edits.edit(task(1), titleChange("Renamed"));
    await flush();
    const newer = w.lastToast();
    expect(newer?.text.id).toBe("toast.title");
    two.reject?.(conflict);
    await flush();
    expect(w.lastToast()).toBe(newer);
    expect(w.edits.unsaved("t_00002", "effort")).toMatchObject({ reason: "conflict" });

    // Try again, clicked before the late decision, is the person's newer edit: it stands.
    const three = hanging(w, "task.update");
    w.edits.edit(task(2), effortChange("S", w.levels), { base: w.asOf(12) });
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    w.answer("task.update", () => new Promise(() => undefined));
    w.answer("receipt.get", () => ({ found: false }));
    w.lastToast()?.action?.run();
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    const retried = w.edits.unsaved("t_00002", "effort");
    expect(retried).toMatchObject({ reason: "failed", change: { set: { effort: "S" } } });
    const shown = w.lastToast();
    three.reject?.(conflict);
    await flush();
    expect(w.edits.unsaved("t_00002", "effort")).toBe(retried);
    expect(w.lastToast()).toBe(shown);
  });

  test("a success decided late takes the not-saved line and its Try again away, and the toast offers Undo again", async () => {
    const w = new World([task(1)]);
    const first = hanging(w, "task.update");
    w.edits.edit(task(1), titleChange("Renamed"));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    expect(w.lastToast()?.action?.label).toEqual({ id: "toast.tryAgain" });
    first.resolve?.(updated(w, 11));
    await flush();
    expect(w.edits.unsaved("t_00001", "title")).toBeUndefined();
    expect(w.lastToast()).toMatchObject({
      kind: "undo",
      text: { id: "toast.title" },
      action: { label: { id: "toast.undo" } },
    });
  });

  test("an undo that said it failed for want of an answer, and then turns out done, says so with Redo", async () => {
    const w = new World([task(1)]);
    const first = hanging(w, "history.undo");
    const done = w.edits.undo(STEP);
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await done;
    expect(w.lastToast()?.text).toEqual({ id: "toast.undoFailed" });
    first.resolve?.({
      result: "undone",
      commit: "op_c",
      tasks: [],
      task_count: 0,
      as_of: w.asOf(11),
    });
    await flush();
    expect(w.lastToast()).toMatchObject({
      text: { id: "toast.undone" },
      second: { label: { id: "toast.redo" } },
    });
  });

  test("a check-off that said it failed for want of an answer, and then turns out done, offers its Undo again", async () => {
    const w = new World([task(1)]);
    const first = hanging(w, "task.finish");
    w.edits.checkOff(task(1));
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    expect(w.lastToast()?.text).toEqual({ id: "toast.checkFailed" });
    first.resolve?.({ result: "completed", task: "M-1", as_of: w.asOf(11), warnings: [] });
    await flush();
    expect(w.lastToast()).toMatchObject({
      text: { id: "toast.done" },
      action: { label: { id: "toast.undo" } },
    });
  });
});

describe("[A7.3.12.m5-14.web-write] a write that is no field of a task: in turn, a step's toast's Undo names its commit, a refusal is the caller's", () => {
  test("waits for the edit before it, shows its toast once it applied, and a step's Undo names its own commit; a folder's toast offers no Undo", async () => {
    const w = new World([task(1)]);
    let answerEdit!: (value: unknown) => void;
    w.answer("task.update", () => new Promise((resolve) => (answerEdit = resolve)));
    w.edits.edit(task(1), priorityChange(1));
    const sent: string[] = [];
    const written = w.edits.write(
      (request) => {
        sent.push(request);
        return Promise.resolve({ result: "set", as_of: w.asOf(12) });
      },
      () => ({ id: "toast.noteRemoved", values: { ref: "M-1" } }),
      { undo: true },
    );
    await flush();
    // The folder write waits for the edit made before it.
    expect(sent).toEqual([]);
    answerEdit({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(11),
      warnings: [],
    });
    await flush();
    expect(sent).toHaveLength(1);
    expect(await written).toEqual({ result: "set", as_of: w.asOf(12) });
    expect(w.lastToast()).toMatchObject({ kind: "undo", text: { id: "toast.noteRemoved" } });
    w.feed([task(1, { version: 2 })], sent[0] ?? "", []);
    w.answer("history.undo", () => ({
      result: "undone",
      commit: "op_x",
      tasks: [],
      task_count: 0,
      as_of: w.asOf(13),
    }));
    w.lastToast()?.action?.run();
    await flush();
    expect(w.calls.at(-1)).toMatchObject({
      name: "history.undo",
      input: { commit: `op_${"11".padStart(26, "0")}` },
    });
    // A folder is set again by hand: its toast says what happened and offers nothing.
    await w.edits.write(
      () => Promise.resolve({ result: "cleared", as_of: w.asOf(14) }),
      () => ({ id: "toast.folderCleared" }),
    );
    expect(w.lastToast()).toMatchObject({ kind: "info", text: { id: "toast.folderCleared" } });
    expect(w.lastToast()?.action).toBeUndefined();
  });

  test("a refusal reaches the caller and shows no toast; a write that changed nothing offers no Undo, whatever its caller would say", async () => {
    const w = new World([task(1)]);
    const refused = w.edits.write(
      () => Promise.reject(appError("conflict", { reason: "folder_taken" })),
      () => ({ id: "toast.folderCleared" }),
    );
    await expect(refused).rejects.toMatchObject({ code: "conflict" });
    expect(w.toasts).toEqual([]);
    for (const result of ["no_change", "exists"]) {
      await w.edits.write(
        () => Promise.resolve({ result, as_of: w.asOf(10) }),
        () => ({ id: "archived.back", values: { name: "Loft" } }),
      );
    }
    expect(w.toasts).toEqual([]);
  });

  test("goes out with the base a dialog opened at, past the tab's own commits only", async () => {
    const w = new World([task(1)]);
    const bases: (string | undefined)[] = [];
    const send =
      (answer: { result: string; as_of: string }) =>
      (_request: string, base: string | undefined) => {
        bases.push(base);
        return Promise.resolve(answer);
      };
    // The dialog opened at 10; the tab's own write lands at 11.
    await w.edits.write(send({ result: "set", as_of: w.asOf(11) }), () => undefined);
    await w.edits.write(send({ result: "set", as_of: w.asOf(12) }), () => undefined, {
      base: w.asOf(10),
    });
    expect(bases).toEqual([w.asOf(10), w.asOf(11)]);
    // Another project had the folder: nothing was written at 13, which another may have made.
    await w.edits.write(send({ result: "exists", as_of: w.asOf(13) }), () => undefined);
    await w.edits.write(send({ result: "set", as_of: w.asOf(14) }), () => undefined, {
      base: w.asOf(12),
    });
    expect(bases.at(-1)).toBe(w.asOf(12));
  });

  test("an answer that was lost and found by its receipt reaches the caller as the receipt's word", async () => {
    const w = new World([task(1)]);
    let request = "";
    w.answer("receipt.get", () => ({
      found: true,
      request,
      status: "applied",
      decided_at: "2026-11-12T10:00:00.000Z",
      as_of: w.asOf(11),
      incarnation: INCARNATION,
      commit: `op_${"11".padStart(26, "0")}`,
      results: [{ i: 0, status: "updated", id: "p_1", version: 11 }],
      warnings: [],
    }));
    const written = w.edits.write(
      (sent) => {
        request = sent;
        return new Promise<{ result: string; as_of: string }>(() => undefined);
      },
      (value) => ("receipt" in value ? { id: "toast.folderCleared" } : undefined),
    );
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await flush();
    expect(await written).toEqual({ result: "updated", as_of: w.asOf(11), receipt: true });
    expect(w.lastToast()).toMatchObject({ text: { id: "toast.folderCleared" } });
  });
});
