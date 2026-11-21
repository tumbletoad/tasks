// history.undo and history.redo through the request path (A1 3.10.1, A3 3.2.3, 3.5; A5 3.12; A7
// 3.10 M3.02): the user's only, the tasks a change changed back, A1's undo codes as the registry's,
// with the values "Restore mine" needs in a conflict, and a partial undo's unresolved fields. A
// service in this process, fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;
let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("history");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const USER: Caller = { class: "cli-interactive", env: {} };
const SCRIPT: Caller = { class: "cli-script", env: {} };

async function call(op: string, input: Json, caller: Caller = USER): Promise<Json> {
  return (await opCall(w.service.ops, caller, { op, input })) as Json;
}
async function refusal(op: string, input: Json, caller: Caller = USER): Promise<ErrorBody> {
  const error = await call(op, input, caller).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`${op} was not refused`);
  return error.toBody();
}

let n = 0;
const rid = () => `fixture-history-${String((n += 1)).padStart(6, "0")}`;
const asOf = async () => (await call("space.status", {}))["as_of"] as string;
const set = async (task: string, values: Json, caller: Caller = USER): Promise<Json> =>
  call("task.update", { task, set: values, base: await asOf(), request_id: rid() }, caller);
const show = async (task: string): Promise<Json> =>
  (await call("task.get", { task }))["task"] as Json;

async function add(title: string): Promise<string> {
  const added = await call("task.add", { tasks: [{ title }], request_id: rid() });
  return String((added["tasks"] as Json[])[0]?.["ref"]);
}

describe("[A3.3.2.3.history] undo and redo through the request path", () => {
  test(
    "the user undoes and redoes; an agent is refused as for every user-only entry",
    async () => {
      const task = await add("Fixture task to undo");
      await set(task, { summary: "Fixture summary" });
      expect(await refusal("history.undo", { request_id: rid() }, SCRIPT)).toMatchObject({
        code: "forbidden",
        data: { rule: "user_only" },
      });
      const request_id = rid();
      const undone = await call("history.undo", { request_id });
      expect(undone).toMatchObject({
        result: "undone",
        tasks: [task],
        task_count: 1,
      });
      expect(undone["commit"]).toMatch(/^op_[0-9a-hjkmnp-tv-z]{26}$/);
      expect(undone).not.toHaveProperty("unresolved");
      expect((await show(task))["summary"]).toBe("");
      // A retry replays: it never undoes a second change.
      expect(await call("history.undo", { request_id })).toEqual({ ...undone, replayed: true });
      const redone = await call("history.redo", { request_id: rid() });
      expect(redone).toMatchObject({
        result: "redone",
        commit: undone["commit"],
        tasks: [task],
        task_count: 1,
      });
      expect((await show(task))["summary"]).toBe("Fixture summary");
      // A new change of the user's ends the redo.
      await call("history.undo", { request_id: rid() });
      await set(task, { priority: 2 });
      expect(await refusal("history.redo", { request_id: rid() })).toMatchObject({
        code: "not_found",
        data: { cause: "NOTHING_TO_REDO", op: 0 },
      });
    },
    LONG,
  );

  test(
    "another actor's change: conflict with what each side wrote, then a partial undo",
    async () => {
      const task = await add("Fixture task with a due date");
      await set(task, { due: "2026-11-20", summary: "Fixture next step" });
      await set(task, { due: "2026-11-27" }, SCRIPT);
      const conflict = await refusal("history.undo", { request_id: rid() });
      expect(conflict).toMatchObject({
        code: "conflict",
        data: {
          cause: "UNDO_CONFLICT",
          conflicts: [
            {
              task,
              field: "due",
              value: { due_date: "2026-11-27", due_at: null, due_tz: null },
              wrote: { due_date: "2026-11-20", due_at: null, due_tz: null },
              restore: { due_date: null, due_at: null, due_tz: null },
              by: "script",
            },
          ],
        },
      });
      expect(conflict.hint).toMatch(/partial/);
      expect(conflict.data?.["conflicts"]).toEqual([
        expect.not.objectContaining({ entity: expect.anything() as unknown }),
      ]);
      // The commit it met is named, so the next step can name it too (A1 3.10.1).
      const met = conflict.data?.["commit"];
      expect(met).toMatch(/^op_[0-9a-hjkmnp-tv-z]{26}$/);
      const partial = await call("history.undo", {
        partial: true,
        commit: met,
        request_id: rid(),
      });
      expect(partial).toMatchObject({
        commit: met,
        result: "partial",
        tasks: [task],
        task_count: 1,
        unresolved: [{ entity: "tasks", task, field: "due", by: "script" }],
      });
      expect(await show(task)).toMatchObject({ due: "2026-11-27" });
      expect((await show(task))["summary"]).toBe("");
    },
    LONG,
  );

  test(
    "a malformed commit is refused before the writer; another one than the newest is a conflict",
    async () => {
      const task = await add("Fixture task for the named commit");
      await set(task, { summary: "Fixture first" });
      const named = await call("history.undo", { request_id: rid() });
      await call("history.redo", { request_id: rid() });
      await set(task, { summary: "Fixture second" });
      expect(await refusal("history.undo", { commit: "M-1", request_id: rid() })).toMatchObject({
        code: "invalid_input",
        data: { issues: [{ path: "commit" }] },
      });
      expect(
        await refusal("history.undo", { commit: named["commit"], request_id: rid() }),
      ).toMatchObject({
        code: "conflict",
        data: { cause: "INVALID_TRANSITION", field: "commit" },
      });
      expect((await show(task))["summary"]).toBe("Fixture second");
    },
    LONG,
  );

  test(
    "a redo blocked by another's source names that row, with a redo's own words",
    async () => {
      const task = await add("Fixture task with a ticket");
      const source = { key: "fixture:history:redo", kind: "ticket", title: "Fixture ticket" };
      const update = async (caller: Caller): Promise<Json> =>
        call(
          "task.update",
          { task, add_sources: [source], base: await asOf(), request_id: rid() },
          caller,
        );
      await update(USER);
      await call("history.undo", { request_id: rid() });
      // The key is free again, and the script's source takes it.
      await update(SCRIPT);
      const conflict = await refusal("history.redo", { request_id: rid() });
      expect(conflict).toMatchObject({
        code: "conflict",
        data: {
          cause: "UNDO_CONFLICT",
          conflicts: [{ entity: "sources", field: "deleted", value: null, by: "script" }],
        },
      });
      // A source belongs to no one task: its ID is what names it.
      const [blocking] = conflict.data?.["conflicts"] as Json[];
      expect(blocking?.["id"]).toMatch(/^s_[0-9a-hjkmnp-tv-z]{26}$/);
      // A redo is all or nothing: neither the message nor the hint offers an undo.
      expect(conflict.message).not.toMatch(/undo/i);
      expect(conflict.hint).not.toMatch(/undo|partial/i);
    },
    LONG,
  );

  test(
    "an agent's log entry keeps the user's new task; receipt.get reads both outcomes",
    async () => {
      const task = await add("Fixture task an agent logs on");
      await call(
        "entry.add",
        { task, kind: "progress", text: "Fixture progress.", request_id: rid() },
        SCRIPT,
      );
      const refused = rid();
      expect(await refusal("history.undo", { request_id: refused })).toMatchObject({
        code: "conflict",
        data: {
          cause: "UNDO_CONFLICT",
          conflicts: [{ task, entity: "log_entries", field: "deleted", value: null, by: "script" }],
        },
      });
      expect(await call("receipt.get", { request: refused })).toMatchObject({
        found: true,
        status: "conflict",
        conflicts: [{ entity: "log_entries", ref: task, field: "deleted" }],
        error: { cause: "UNDO_CONFLICT" },
      });
      // Keep it: a partial undo changes nothing here, and the change leaves the stack.
      const kept = rid();
      const partial = await call("history.undo", { partial: true, request_id: kept });
      expect(partial).toMatchObject({
        result: "partial",
        tasks: [],
        task_count: 0,
        unresolved: [{ entity: "log_entries", task, field: "deleted", by: "script" }],
      });
      // A row other than the task is named by its ID too.
      expect((partial["unresolved"] as Json[])[0]?.["id"]).toEqual(
        expect.stringMatching(/^[a-z]{1,2}_[0-9a-hjkmnp-tv-z]{26}$/),
      );
      expect(await call("receipt.get", { request: kept })).toMatchObject({
        found: true,
        status: "applied",
        results: [{ i: 0, status: "updated", id: partial["commit"] }],
      });
      expect((await show(task))["ref"]).toBe(task);
    },
    LONG,
  );
});

describe("[A1.5.history.runs] a run keeps its task's create, through the request path", () => {
  test(
    "the conflict and a partial undo's unresolved name the run, and receipt.get reads it",
    async () => {
      const task = await add("Fixture task the user runs");
      const id = String((await show(task))["id"]);
      // The run as the launch path writes it (A4 3.16): the person, in the launch's own scope.
      const served = w.service.ops.spaces().find((s) => s.writer !== undefined);
      const writer = served?.writer;
      if (writer === undefined) throw new Error("no writer");
      const machine = w.service.ops.machine.id;
      const created = await writer.submit({
        space_id: w.space,
        request_id: rid(),
        actor: {
          scope_id: `launch:${machine}`,
          principal_id: await writer.actor("human", "user"),
          actor_kind: "human",
          machine_id: machine as `m_${string}`,
          origin: "ui",
        },
        ops: [
          {
            kind: "run.create",
            task: id as `t_${string}`,
            instance: "codex-work",
            adapter: "codex",
            place: null,
            request: "Fixture instruction.",
            brief_hash: "a1b2c3d4".repeat(8),
            permission: "full-access",
            limits: { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 },
          },
        ],
      });
      expect(created.status).toBe("applied");
      const run = String(created.results[0]?.id);
      const refused = rid();
      expect(await refusal("history.undo", { request_id: refused })).toMatchObject({
        code: "conflict",
        data: {
          cause: "UNDO_CONFLICT",
          conflicts: [{ task, entity: "runs", id: run, field: "state", value: null, by: "user" }],
        },
      });
      expect(await call("receipt.get", { request: refused })).toMatchObject({
        found: true,
        status: "conflict",
        conflicts: [{ entity: "runs", id: run, ref: task, field: "state" }],
      });
      const partial = await call("history.undo", { partial: true, request_id: rid() });
      expect(partial).toMatchObject({
        result: "partial",
        tasks: [],
        unresolved: [{ entity: "runs", id: run, task, field: "state", by: "user" }],
      });
      expect((await show(task))["ref"]).toBe(task);
    },
    LONG,
  );
});
