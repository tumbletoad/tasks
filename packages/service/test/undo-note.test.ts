// An undo whose optional note cannot be read (A3 3.7.4): the undo has applied, so its answer says
// so, without the note, and a second plain undo is never needed to learn that. The note's read
// fails through a stand-in for read.ts's readScriptChange. A service in this process, fixture
// text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { HistoryUndoResult } from "@ttasks/contracts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

const gate = vi.hoisted(() => ({ fail: false }));

vi.mock("../src/ops/read.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ops/read.ts")>();
  return {
    ...real,
    readScriptChange: async (...args: Parameters<typeof real.readScriptChange>) => {
      if (gate.fail) throw new Error("Fixture: the space closed before the note was read");
      return real.readScriptChange(...args);
    },
  };
});

type Json = Record<string, unknown>;
let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("undonote");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const USER: Caller = { class: "cli-interactive", env: {} };
const SCRIPT: Caller = { class: "cli-script", env: {} };

const call = async (op: string, input: Json, caller: Caller = USER): Promise<Json> =>
  (await opCall(w.service.ops, caller, { op, input })) as Json;

let n = 0;
const rid = () => `fixture-undonote-${String((n += 1)).padStart(6, "0")}`;
const asOf = async () => (await call("space.status", {}))["as_of"] as string;
const set = async (task: string, values: Json, caller: Caller = USER): Promise<Json> =>
  call("task.update", { task, set: values, base: await asOf(), request_id: rid() }, caller);
const show = async (task: string): Promise<Json> =>
  (await call("task.get", { task }))["task"] as Json;

async function add(title: string): Promise<string> {
  const added = await call("task.add", { tasks: [{ title }], request_id: rid() });
  return String((added["tasks"] as Json[])[0]?.["ref"]);
}

describe("[A3.3.7.actors.script-undo-note.unread] an undo whose note cannot be read", () => {
  test(
    "reports the undo it applied, leaves the note out, and a replay answers the same",
    async () => {
      const mine = await add("Fixture task the person changes");
      const scripts = await add("Fixture task a script changes");
      await set(mine, { summary: "Fixture summary to undo" });
      await set(scripts, { summary: "Fixture summary by a script" }, SCRIPT);

      gate.fail = true;
      const request_id = rid();
      let undone: Json;
      try {
        undone = await call("history.undo", { request_id });
      } finally {
        gate.fail = false;
      }
      expect(HistoryUndoResult.parse(undone)).toMatchObject({ result: "undone", tasks: [mine] });
      expect(undone).not.toHaveProperty("script_change");
      expect((await show(mine))["summary"]).toBe("");
      // The script's change stands, and the person's earlier add was not undone a second time.
      expect((await show(scripts))["summary"]).toBe("Fixture summary by a script");
      expect((await show(mine))["title"]).toBe("Fixture task the person changes");
      // The same request again replays the undo, now with the note it can read.
      expect(await call("history.undo", { request_id })).toMatchObject({
        result: "undone",
        commit: undone["commit"],
        replayed: true,
        script_change: { task: scripts },
      });
    },
    LONG,
  );
});

describe("[A3.3.7.actors.script-undo-check] an undo that checks for a newer change by a script", () => {
  test(
    "undoes nothing and names both changes; the named commit undoes it; a retry of an applied undo replays it",
    async () => {
      const mine = await add("Fixture task the person checks");
      const scripts = await add("Fixture task a script checks");
      await set(mine, { summary: "Fixture summary kept" });
      await set(scripts, { summary: "Fixture summary by a script, checked" }, SCRIPT);

      const refused = await call("history.undo", { check_script: true, request_id: rid() }).then(
        () => undefined,
        (e: unknown) => (e as { toBody: () => Json }).toBody(),
      );
      expect(refused).toMatchObject({
        code: "conflict",
        data: {
          reason: "script_change_after",
          tasks: [mine],
          task_count: 1,
          change: "task.patch",
          script_change: { task: scripts, change: "task.patch" },
        },
      });
      // Nothing was undone.
      expect((await show(mine))["summary"]).toBe("Fixture summary kept");

      const commit = (refused?.["data"] as Json)["commit"];
      const request_id = rid();
      const undone = await call("history.undo", { commit, request_id });
      expect(undone).toMatchObject({ result: "undone", commit, tasks: [mine] });
      expect((await show(mine))["summary"]).toBe("");
      // A person's change newer than the script's: nothing to ask.
      await set(mine, { summary: "Fixture summary after the script" });
      const checked = rid();
      const applied = await call("history.undo", { check_script: true, request_id: checked });
      expect(applied).toMatchObject({ result: "undone", tasks: [mine] });
      // A script changes something after it; a retry of that undo replays it, and is not refused.
      await set(scripts, { summary: "Fixture summary by a script, later" }, SCRIPT);
      expect(await call("history.undo", { check_script: true, request_id: checked })).toMatchObject(
        { replayed: true, commit: applied["commit"] },
      );
    },
    LONG,
  );

  test(
    "asks about the change an undo takes, the one applied last, when B was redone before A",
    async () => {
      const a = await add("Fixture task edited first");
      const b = await add("Fixture task edited second");
      const scripts = await add("Fixture task a script changes last");
      await set(a, { summary: "Fixture summary first" });
      await set(b, { summary: "Fixture summary second" });
      const second = await call("history.undo", { request_id: rid() });
      const first = await call("history.undo", { request_id: rid() });
      // B by its name, then A: A is applied last.
      await call("history.redo", { commit: second["commit"], request_id: rid() });
      expect(await call("history.redo", { request_id: rid() })).toMatchObject({ tasks: [a] });
      await set(scripts, { summary: "Fixture summary by a script, last" }, SCRIPT);
      const refused = await call("history.undo", { check_script: true, request_id: rid() }).then(
        () => undefined,
        (e: unknown) => (e as { toBody: () => Json }).toBody(),
      );
      // The question names the change an undo takes, and confirming it undoes that change.
      expect(refused).toMatchObject({
        code: "conflict",
        data: { reason: "script_change_after", commit: first["commit"], tasks: [a] },
      });
      const confirmed = await call("history.undo", {
        commit: (refused?.["data"] as Json)["commit"],
        request_id: rid(),
      });
      expect(confirmed).toMatchObject({ result: "undone", commit: first["commit"] });
      expect((await show(a))["summary"]).toBe("");
      expect((await show(b))["summary"]).toBe("Fixture summary second");
    },
    LONG,
  );

  test(
    "a script's change before a redo brought the person's change back is not after it: nothing to ask",
    async () => {
      const mine = await add("Fixture task redone after a script");
      const scripts = await add("Fixture task a script changes between");
      await set(mine, { summary: "Fixture summary redone" });
      await call("history.undo", { request_id: rid() });
      await set(scripts, { summary: "Fixture summary by a script, between" }, SCRIPT);
      await call("history.redo", { request_id: rid() });
      const undone = await call("history.undo", { check_script: true, request_id: rid() });
      expect(undone).toMatchObject({ result: "undone", tasks: [mine] });
      expect(undone).not.toHaveProperty("script_change");
    },
    LONG,
  );
});
