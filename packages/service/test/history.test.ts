// history.undo and history.redo through the request path (A1 3.10.1, A3 3.2.3, 3.5; A5 3.12; A7
// 3.10 M3.02): the user's only, the tasks a change changed back, A1's undo codes as the registry's,
// and a change someone else's newer work keeps, named with who. A service in this process,
// fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { RUN_LIMITS } from "@ttasks/contracts/runs";
import { SpaceExecutionStore } from "@ttasks/launch";
import { RunMachine } from "@ttasks/runs";
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
      // A priority is no step: it neither ends the redo nor is undone.
      await call("history.undo", { request_id: rid() });
      await set(task, { priority: 2 });
      await call("history.redo", { request_id: rid() });
      expect(await show(task)).toMatchObject({ summary: "Fixture summary", priority: 2 });
      // A new step of the user's ends the redo.
      await call("history.undo", { request_id: rid() });
      await set(task, { summary: "Fixture other summary" });
      expect(await refusal("history.redo", { request_id: rid() })).toMatchObject({
        code: "not_found",
        data: { cause: "NOTHING_TO_REDO", op: 0 },
      });
    },
    LONG,
  );

  test(
    "another actor's change keeps the user's step as they left it: the answer names who, a retry replays it, and the next undo reaches the step before",
    async () => {
      const task = await add("Fixture task with a summary");
      await set(task, { title: "Fixture task, renamed" });
      await set(task, { summary: "Fixture next step" });
      await set(task, { summary: "Fixture script's step" }, SCRIPT);
      const request_id = rid();
      const kept = await call("history.undo", { request_id });
      expect(kept).toMatchObject({
        result: "kept",
        tasks: [task],
        newer_work: [{ task, by: "script" }],
      });
      expect((await show(task))["summary"]).toBe("Fixture script's step");
      expect(await call("history.undo", { request_id })).toEqual({ ...kept, replayed: true });
      expect(await call("receipt.get", { request: request_id })).toMatchObject({
        found: true,
        status: "unchanged",
        kept: true,
      });
      const undone = await call("history.undo", { request_id: rid() });
      expect(undone).toMatchObject({ result: "undone", tasks: [task] });
      expect((await show(task))["title"]).toBe("Fixture task with a summary");
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
    "a redo of a removal after an agent's note keeps the task, naming who; one removal moves it",
    async () => {
      const task = await add("Fixture task removed and brought back");
      await call("task.delete", { tasks: [task], base: await asOf(), request_id: rid() });
      await call("history.undo", { request_id: rid() });
      for (let i = 0; i < 3; i += 1) {
        const text = `Fixture note ${String(i)}.`;
        await call("entry.add", { task, kind: "note", text, request_id: rid() }, SCRIPT);
      }
      const kept = await call("history.redo", { request_id: rid() });
      // The task and its author once, however many notes.
      expect(kept).toMatchObject({ result: "kept" });
      expect(kept["newer_work"]).toEqual([
        { task, by: "script", at: expect.any(String) as unknown },
      ]);
      expect((await show(task))["ref"]).toBe(task);
      const removed = await call("task.delete", {
        tasks: [task],
        base: await asOf(),
        request_id: rid(),
      });
      expect(removed["commit"]).toMatch(/^op_/);
      expect(
        await refusal(
          "entry.add",
          { task, kind: "note", text: "Fixture note after.", request_id: rid() },
          SCRIPT,
        ),
      ).toMatchObject({ data: { reason: "in_trash" } });
    },
    LONG,
  );

  test(
    "a kept redo leaves the stack: the next redo reaches the change undone before it",
    async () => {
      const a = await add("Fixture task removed first");
      const b = await add("Fixture task edited after");
      await set(b, { summary: "Fixture summary after" });
      await call("task.delete", { tasks: [a], base: await asOf(), request_id: rid() });
      await call("history.undo", { request_id: rid() });
      await call("history.undo", { request_id: rid() });
      await set(b, { summary: "Fixture script's summary" }, SCRIPT);
      expect(await call("history.redo", { request_id: rid() })).toMatchObject({
        result: "kept",
        tasks: [b],
      });
      expect(await call("history.redo", { request_id: rid() })).toMatchObject({
        result: "redone",
        tasks: [a],
      });
      expect((await show(b))["summary"]).toBe("Fixture script's summary");
    },
    LONG,
  );
});

describe("[A1.5.history.runs] runs beside Undo, through the request path", () => {
  test(
    "a run the person queued and stopped is theirs and keeps no Undo from checking the task off again; a run that started does, named as the run",
    async () => {
      const served = w.service.ops.spaces().find((s) => s.writer !== undefined);
      const writer = served?.writer;
      if (writer === undefined) throw new Error("no writer");
      const machineId = w.service.ops.machine.id;
      // The run machine over the store the service gives it: the person, in the runs' own scope.
      const machine = new RunMachine({
        machine: machineId,
        store: new SpaceExecutionStore({
          writer,
          spaceId: w.space,
          credential: {
            scope_id: `runs:${machineId}`,
            principal_id: await writer.actor("human", "user"),
            actor_kind: "human",
            machine_id: machineId,
            origin: "ui",
          },
        }),
      });
      /** A task checked off and reopened, with a run queued on it. */
      const queuedOn = async (title: string) => {
        const task = await add(title);
        await call("task.finish", { task, base: await asOf(), request_id: rid() });
        await call("task.reopen", { task, base: await asOf(), request_id: rid() });
        const run = await machine.queue(
          {
            task: String((await show(task))["id"]),
            routine: null,
            instance: "codex-work",
            adapter: "codex",
            place: null,
            request: "Fixture instruction.",
            briefHash: "a1b2c3d4".repeat(8),
            permission: "full-access",
            limits: RUN_LIMITS.task,
          },
          rid(),
        );
        return { task, run: run.id };
      };
      // No round of the service's runs takes these records while the test moves them.
      const hold = w.service.runs.hold();
      try {
        const stopped = await queuedOn("Fixture task whose run the user stops");
        expect((await machine.cancel(stopped.run)).run?.state).toBe("cancelled");
        await call("history.undo", { request_id: rid() });
        expect((await show(stopped.task))["lifecycle"]).toBe("completed");

        const started = await queuedOn("Fixture task whose run starts");
        expect((await machine.begin(started.run)).began).toBe(true);
        expect(await call("history.undo", { request_id: rid() })).toMatchObject({
          result: "kept",
          newer_work: [{ task: started.task, by: "run" }],
        });
        expect((await show(started.task))["lifecycle"]).toBe("active");

        // In the Trash and back, then a run queued that starts and answers: the Redo keeps it.
        const answered = await add("Fixture task whose run answers");
        await call("task.delete", { tasks: [answered], base: await asOf(), request_id: rid() });
        await call("history.undo", { request_id: rid() });
        const run = await machine.queue(
          {
            task: String((await show(answered))["id"]),
            routine: null,
            instance: "codex-work",
            adapter: "codex",
            place: null,
            request: "Fixture instruction.",
            briefHash: "a1b2c3d4".repeat(8),
            permission: "full-access",
            limits: RUN_LIMITS.task,
          },
          rid(),
        );
        expect((await machine.begin(run.id)).began).toBe(true);
        expect((await machine.started(run.id, 4242, 1))?.state).toBe("running");
        const end = await machine.settle(run.id, {
          kind: "exited",
          result: {
            ok: true,
            outcome: "success",
            exitCode: 0,
            signal: null,
            nativeId: null,
            text: "Fixture answer.",
            error: null,
            usage: null,
            appTools: null,
            declined: 0,
            permissionDenials: 0,
            durationMs: 1,
          },
        });
        expect(end?.state).toBe("succeeded");
        expect(await call("history.redo", { request_id: rid() })).toMatchObject({
          result: "kept",
          newer_work: [{ task: answered, by: "run" }],
        });
        expect((await show(answered))["ref"]).toBe(answered);
      } finally {
        hold.release();
      }
    },
    LONG,
  );
});
