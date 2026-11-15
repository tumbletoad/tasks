// The edits controller (edits.ts) with the real live store and a fake service: one path for every
// person's edit, bases, refusals that keep the person's value, the check-off's hold, and undo and
// redo with their conflicts. The store is fed by hand, as the feed would (fake frames).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LiveStore } from "../store/store.ts";
import type { BatchMessage, SnapshotMessage, TaskRow } from "../store/rows.ts";
import { FakeFrames } from "../../test/fake-frames.ts";
import {
  dueChange,
  effortChange,
  joinChanges,
  priorityChange,
  restoreChange,
  statusChange,
  titleChange,
  triageChange,
  waitingChange,
} from "./change.ts";
import { Edits, HOLD_MS, COLLAPSE_MS, type Toast } from "./edits.ts";

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
    ...fields,
  };
}

/** An error as the generated client throws it: a code and its data. */
function appError(code: string, data: Record<string, unknown>): Error {
  return Object.assign(new Error("refused"), { code, data });
}

class World {
  readonly frames = new FakeFrames();
  readonly store: LiveStore;
  readonly edits: Edits;
  readonly calls: { name: string; input: Record<string, unknown> }[] = [];
  readonly toasts: (Toast | undefined)[] = [];
  /** What the next call of each entry answers: a result, or an error to throw. */
  readonly answers = new Map<string, ((input: Record<string, unknown>) => unknown)[]>();
  seq = 10;

  constructor(rows: readonly TaskRow[]) {
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
      areas: [],
      projects: [],
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
      task: { update: call("task.update"), finish: call("task.finish") },
      history: { undo: call("history.undo"), redo: call("history.redo") },
    } as unknown as ConstructorParameters<typeof Edits>[0]["client"];
    this.edits = new Edits({
      client,
      write: (send, overlay) => this.store.write(send, overlay),
      asOf: () => this.store.asOf,
      failed: () => false,
      onChanges: (listener) => this.store.onChanges(listener),
      rowOf: (ref) => [...this.store.getState().tasks.values()].find((t) => t.ref === ref),
      newRequest: () => `rq-${String((requests += 1))}`,
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
};

describe("[A5.3.11.web.edits] one path for a person's edit: base, overlay, refusals kept, undo by commit", () => {
  test("an edit shows at once, carries the applied cursor as its base, and its toast's Undo names its commit", async () => {
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
    expect(w.lastToast()?.text).toEqual({
      id: "toast.priority",
      values: { value: { id: "row.priority", values: { level: 1 } } },
    });
    await flush();
    w.feed([task(1, { priority: 1, version: 2 })], String(w.calls[0]?.input["request_id"]), [
      "priority",
    ]);
    w.answer("history.undo", () => ({
      result: "undone",
      commit: "op_x",
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(12),
    }));
    w.lastToast()?.action?.run();
    await flush();
    expect(w.calls[1]).toMatchObject({
      name: "history.undo",
      input: { commit: `op_${"11".padStart(26, "0")}` },
    });
    expect(w.lastToast()?.text).toEqual({ id: "toast.undone" });
    expect(w.lastToast()?.action?.label).toEqual({ id: "toast.redo" });
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
    w.edits.edit(task(1), effortChange("M"));
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
    failFirst(new Error("network"));
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
    failFirst(new Error("network"));
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

  test("Ctrl+Z waits for the person's edits on their way, so it takes back the newest", async () => {
    const w = new World([task(1)]);
    let answerFirst!: (value: unknown) => void;
    w.answer("task.update", () => new Promise((resolve) => (answerFirst = resolve)));
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["effort"],
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
    w.edits.edit(task(1), priorityChange(1));
    w.edits.edit(task(1), effortChange("M"));
    const undone = w.edits.undo();
    await flush();
    expect(w.calls.map((c) => c.name)).toEqual(["task.update"]);
    answerFirst({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(11),
      warnings: [],
    });
    await undone;
    expect(w.calls.map((c) => c.name)).toEqual(["task.update", "task.update", "history.undo"]);
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
    w.edits.edit(task(1), priorityChange(1));
    const undone = w.edits.undo();
    // Another task's edit, after Ctrl+Z: it shows at once and goes out after the undo.
    w.edits.edit(task(2), effortChange("M"));
    expect(w.row("t_00002")?.effort).toBe("M");
    await flush();
    expect(w.calls.map((c) => c.name)).toEqual(["task.update"]);
    answerFirst({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(11),
      warnings: [],
    });
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
    await w.edits.undo();
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

describe("[A5.3.12.web.undo] check-off with its hold, undo and redo, and the Restore mine conflict", () => {
  test("a check-off holds the row checked for 4 s, then it collapses and leaves; clicking again during the hold undoes it", async () => {
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
    expect(w.calls[0]).toMatchObject({
      name: "task.finish",
      input: { task: "t_00001", base: w.asOf(10) },
    });
    expect(w.edits.getState().leaving.get("t_00001")).toMatchObject({ done: true, out: false });
    expect(w.lastToast()).toMatchObject({ kind: "undo", text: { id: "toast.done" } });
    await flush();
    w.feed(
      [task(1, { lifecycle: "completed", version: 2 })],
      String(w.calls[0]?.input["request_id"]),
      ["lifecycle"],
    );
    // It left the working set; the hold keeps its row.
    expect(w.row("t_00001")).toBeUndefined();
    expect(w.edits.getState().leaving.get("t_00001")?.row.title).toBe("Task 1");
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(w.edits.getState().leaving.get("t_00001")?.out).toBe(true);
    await vi.advanceTimersByTimeAsync(COLLAPSE_MS);
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

  test("an undo whose every field an agent changed since offers Restore mine: a partial undo, then the person's value with a fresh base", async () => {
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
    const mine = `op_${"11".padStart(26, "0")}`;
    w.answer("history.undo", () => {
      throw appError("conflict", {
        cause: "UNDO_CONFLICT",
        // The service names the commit the undo met, so Restore mine acts on that one.
        commit: mine,
        conflicts: [
          {
            task: "M-1",
            field: "due",
            value: { due_date: "2026-11-22", due_at: null, due_tz: null },
            wrote: { due_date: "2026-11-13", due_at: null, due_tz: null },
            restore: { due_date: "2026-11-17", due_at: null, due_tz: null },
            version: 12,
            by: "Codex",
            at: "2026-11-12T10:42:00.000Z",
          },
        ],
      });
    });
    await w.edits.undo();
    const shown = w.lastToast();
    // What the change wrote, what is there now, and what Restore mine puts back.
    expect(shown?.text).toMatchObject({
      id: "toast.conflictValues",
      values: {
        who: "other",
        by: "Codex",
        field: { id: "field.due" },
        wrote: "2026-11-13",
        now: "2026-11-22",
        restore: "2026-11-17",
      },
    });
    expect(shown?.action?.label).toEqual({ id: "toast.restoreMine" });
    w.answer("history.undo", () => ({
      result: "partial",
      commit: "op_z",
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(13),
      unresolved: [],
    }));
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["due"],
      as_of: w.asOf(14),
      warnings: [],
    }));
    shown?.action?.run();
    await flush();
    expect(w.calls.at(-2)).toMatchObject({
      name: "history.undo",
      input: { partial: true, commit: mine },
    });
    expect(w.calls.at(-1)).toMatchObject({
      name: "task.update",
      input: { task: "t_00001", set: { due: "2026-11-17" }, base: w.asOf(13) },
    });
  });

  test("a conflict whose commit is not named never acts on whatever is newest: Restore mine only sets the value, and no Undo the rest", async () => {
    const w = new World([task(1, { priority: 2 })]);
    const conflict = {
      task: "M-1",
      field: "priority",
      value: 2,
      wrote: 1,
      restore: 3,
      version: 12,
      by: "Codex",
      at: "2026-11-12T10:42:00.000Z",
    };
    w.answer("history.undo", () => {
      throw appError("conflict", { cause: "UNDO_CONFLICT", conflicts: [conflict] });
    });
    await w.edits.undo();
    expect(w.lastToast()?.action?.label).toEqual({ id: "toast.restoreMine" });
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority"],
      as_of: w.asOf(11),
      warnings: [],
    }));
    const before = w.calls.length;
    w.lastToast()?.action?.run();
    await flush();
    expect(w.calls.slice(before).map((c) => c.name)).toEqual(["task.update"]);
    expect(w.calls.at(-1)?.input).toMatchObject({ set: { priority: 3 } });
    // A value no hand edit can set, unnamed: the toast says so and offers nothing to run.
    w.answer("history.undo", () => {
      throw appError("conflict", {
        cause: "UNDO_CONFLICT",
        conflicts: [{ ...conflict, field: "lifecycle", restore: { lifecycle: "active" } }],
      });
    });
    await w.edits.undo();
    expect(w.lastToast()).toMatchObject({ kind: "error" });
    expect(w.lastToast()?.action).toBeUndefined();
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
      task_count: 1,
      as_of: w.asOf(16),
    }));
    w.edits.uncheck("t_00001");
    await flush();
    expect(w.calls.at(-1)).toMatchObject({ name: "history.undo", input: { commit: checked } });
  });

  test("an undo where only some fields conflict offers Undo the rest; a value no hand edit can set offers no Restore mine", async () => {
    const w = new World([task(1)]);
    w.answer("task.update", () => ({
      result: "updated",
      task: "M-1",
      fields: ["priority", "due"],
      as_of: w.asOf(11),
      warnings: [],
    }));
    w.edits.edit(task(1), { ...priorityChange(1), fields: ["priority", "due"] });
    await flush();
    w.feed([task(1, { priority: 1, version: 2 })], String(w.calls[0]?.input["request_id"]), [
      "priority",
      "due",
    ]);
    const conflict = {
      task: "M-1",
      field: "due",
      restore: { due_date: null, due_at: 1, due_tz: "UTC" },
      version: 12,
      by: "Codex",
      at: "2026-11-12T10:42:00.000Z",
    };
    w.answer("history.undo", () => {
      throw appError("conflict", { cause: "UNDO_CONFLICT", conflicts: [conflict] });
    });
    await w.edits.undo(`op_${"11".padStart(26, "0")}`);
    expect(w.lastToast()?.action?.label).toEqual({ id: "toast.undoRest" });
    w.answer("history.undo", () => ({
      result: "partial",
      commit: "op_z",
      tasks: ["M-1"],
      task_count: 1,
      as_of: w.asOf(13),
      unresolved: [],
    }));
    w.lastToast()?.action?.run();
    await flush();
    expect(w.calls.at(-1)).toMatchObject({
      name: "history.undo",
      input: { partial: true, commit: `op_${"11".padStart(26, "0")}` },
    });
    expect(w.lastToast()?.text).toEqual({ id: "toast.undoneRest" });
    // A due time cannot be set by hand: no Restore mine.
    expect(restoreChange("due", conflict.restore)).toBeUndefined();
    expect(restoreChange("lifecycle", { lifecycle: "active" })).toBeUndefined();
    expect(restoreChange("priority", null)?.set).toEqual({ priority: 4 });
  });

  test("nothing to undo, a newer change first, and a toast whose commit is unknown each say so and change nothing", async () => {
    const w = new World([task(1)]);
    w.answer("history.undo", () => {
      throw appError("not_found", { cause: "NOTHING_TO_UNDO" });
    });
    await w.edits.undo();
    expect(w.lastToast()?.text).toEqual({ id: "toast.nothingToUndo" });
    w.answer("history.undo", () => {
      throw appError("conflict", { cause: "INVALID_TRANSITION" });
    });
    await w.edits.undo("op_old");
    expect(w.lastToast()?.text).toEqual({ id: "toast.newerFirst" });
    const calls = w.calls.length;
    await w.edits.undo(Promise.resolve(undefined));
    expect(w.calls).toHaveLength(calls);
    expect(w.lastToast()?.text).toEqual({ id: "toast.undoUnknown" });
  });
});
