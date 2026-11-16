// A write that has applied is answered as applied, whatever a read for its answer does. The reads
// fail through stand-ins for read.ts's readCommit and readCommitTasks. A service in this process,
// fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  HistoryRedoResult,
  HistoryUndoResult,
  TaskFinishResult,
  TaskReopenResult,
  TaskUpdateResult,
} from "@tasks/contracts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

const gate = vi.hoisted(() => ({ fail: false }));

vi.mock("../src/ops/read.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ops/read.ts")>();
  return {
    ...real,
    readCommit: async (...args: Parameters<typeof real.readCommit>) => {
      if (gate.fail) throw new Error("Fixture: the space closed before the answer was read");
      return real.readCommit(...args);
    },
    readCommitTasks: async (...args: Parameters<typeof real.readCommitTasks>) => {
      if (gate.fail) throw new Error("Fixture: the space closed before the answer was read");
      return real.readCommitTasks(...args);
    },
  };
});

type Json = Record<string, unknown>;
let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("readafter");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const USER: Caller = { class: "cli-interactive", env: {} };

const call = async (op: string, input: Json): Promise<Json> =>
  (await opCall(w.service.ops, USER, { op, input })) as Json;

let n = 0;
const rid = () => `fixture-readafter-${String((n += 1)).padStart(6, "0")}`;
const asOf = async () => (await call("space.status", {}))["as_of"] as string;
const show = async (task: string): Promise<Json> =>
  (await call("task.get", { task }))["task"] as Json;

/** Runs `write` while every read for a write's answer fails. */
async function unread(write: () => Promise<Json>): Promise<Json> {
  gate.fail = true;
  try {
    return await write();
  } finally {
    gate.fail = false;
  }
}

async function add(title: string): Promise<string> {
  const added = await call("task.add", { tasks: [{ title }], request_id: rid() });
  return String((added["tasks"] as Json[])[0]?.["ref"]);
}

describe("[A3.3.4.write.applied-answer] a write whose answer cannot be read after it applied", () => {
  test(
    "undo, redo, update, finish and reopen each report what they applied, never a failure",
    async () => {
      const task = await add("Fixture task for the answers");

      const updated = await unread(async () =>
        call("task.update", {
          task,
          set: { summary: "Fixture summary" },
          base: await asOf(),
          request_id: rid(),
        }),
      );
      expect(TaskUpdateResult.parse(updated)).toMatchObject({
        result: "updated",
        task,
        fields: ["summary"],
      });
      expect((await show(task))["summary"]).toBe("Fixture summary");

      // The undo applied once: a second plain undo is never needed to learn that.
      const undoId = rid();
      const undone = await unread(() => call("history.undo", { request_id: undoId }));
      expect(HistoryUndoResult.parse(undone)).toMatchObject({ result: "undone" });
      expect(undone).not.toHaveProperty("tasks");
      expect((await show(task))["summary"]).toBe("");
      expect((await show(task))["title"]).toBe("Fixture task for the answers");

      const redone = await unread(() => call("history.redo", { request_id: rid() }));
      expect(HistoryRedoResult.parse(redone)).toMatchObject({
        result: "redone",
        commit: undone["commit"],
      });
      expect((await show(task))["summary"]).toBe("Fixture summary");

      const finished = await unread(async () =>
        call("task.finish", {
          task,
          outcome: "Fixture outcome",
          learnings: ["Fixture learning"],
          base: await asOf(),
          request_id: rid(),
        }),
      );
      expect(TaskFinishResult.parse(finished)).toMatchObject({
        result: "completed",
        lifecycle: "completed",
        learnings: 1,
      });
      expect((await show(task))["lifecycle"]).toBe("completed");

      const reopened = await unread(async () =>
        call("task.reopen", {
          task,
          reason: "Fixture reason",
          base: await asOf(),
          request_id: rid(),
        }),
      );
      expect(TaskReopenResult.parse(reopened)).toMatchObject({
        result: "reopened",
        lifecycle: "active",
      });
      expect((await show(task))["lifecycle"]).toBe("active");

      // A task completed before, then dropped with an outcome: only the wrap-up applies, and the
      // answer does not call it archived.
      const other = await add("Fixture task finished twice");
      await call("task.finish", { task: other, base: await asOf(), request_id: rid() });
      const wrapped = await unread(async () =>
        call("task.finish", {
          task: other,
          status: "dropped",
          outcome: "Fixture outcome",
          base: await asOf(),
          request_id: rid(),
        }),
      );
      expect(wrapped).toMatchObject({ result: "completed", lifecycle: "completed" });
      expect((await show(other))["lifecycle"]).toBe("completed");

      // With the reads back, a replay of the undo answers with its tasks.
      expect(await call("history.undo", { request_id: undoId })).toMatchObject({
        result: "undone",
        commit: undone["commit"],
        replayed: true,
        tasks: [task],
      });
    },
    LONG,
  );
});
