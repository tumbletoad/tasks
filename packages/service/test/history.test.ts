// history.undo and history.redo through the request path (A1 3.10.1, A3 3.2.3, 3.5; A5 3.12; A7
// 3.10 M3.02): the user's only, the tasks a change changed back, A1's undo codes as the registry's,
// with the values "Restore mine" needs in a conflict, and a partial undo's unresolved fields. A
// service in this process, fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, type ErrorBody } from "@tasks/contracts";
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
      const partial = await call("history.undo", { partial: true, request_id: rid() });
      expect(partial).toMatchObject({
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
});
