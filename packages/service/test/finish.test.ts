// complete_task through the request path (A3 3.4.8; A1 3.11; A7 3.10 M3.04): done and dropped,
// learnings, the wrap-up of a task the user checked off, a task wrapped already, follow-ups after a
// wrap-up, and replays, with the learnings read back in get_task's outcome section. A service in
// this process, fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, TaskFinishResult, TaskGetResult, type ErrorBody } from "@tasks/contracts";
import { renderResult } from "../src/mcp/render.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;
let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("finish");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** An agent's script and the user at the terminal. */
const AGENT: Caller = { class: "cli-script", env: {} };
const USER: Caller = { class: "cli-interactive", env: {} };

async function call(op: string, input: Json, caller: Caller = AGENT): Promise<Json> {
  return (await opCall(w.service.ops, caller, { op, input })) as Json;
}
async function refusal(op: string, input: Json, caller: Caller = AGENT): Promise<ErrorBody> {
  const error = await call(op, input, caller).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`${op} was not refused`);
  return error.toBody();
}

let n = 0;
const rid = () => `fixture-finish-${String((n += 1)).padStart(6, "0")}`;
const asOf = async () => (await call("space.status", {}))["as_of"] as string;

async function add(title: string, extra: Json = {}): Promise<string> {
  const added = await call("task.add", { tasks: [{ title, ...extra }], request_id: rid() }, USER);
  return String((added["tasks"] as Json[])[0]?.["ref"]);
}
const finish = async (input: Json, caller: Caller = AGENT) =>
  TaskFinishResult.parse(
    await call("task.finish", { base: await asOf(), request_id: rid(), ...input }, caller),
  );
const outcomeOf = async (task: string) => {
  const read = TaskGetResult.parse(await call("task.get", { task, sections: ["outcome"] }));
  if (read.view !== "sections") throw new Error("not a sections read");
  return { task: read.task, outcome: read.sections.outcome };
};

describe("[A3.3.4.finish.lifecycle] complete_task: done, dropped, learnings and the wrap-up", () => {
  test(
    "done with learnings completes and wraps up in one commit, and get_task reads the learnings back",
    async () => {
      const task = await add("Fixture task done with learnings");
      const done = await finish({
        task,
        outcome: "Times are stored as UTC plus the zone ID.",
        learnings: ["Store UTC plus the zone ID.", "Convert once, at the edge."],
      });
      expect(done).toMatchObject({
        result: "completed",
        task,
        lifecycle: "completed",
        wrap_state: "wrapped",
        learnings: 2,
        follow_ups: [],
      });
      expect(await outcomeOf(task)).toEqual({
        task: expect.objectContaining({ ref: task, lifecycle: "completed" }) as unknown,
        outcome: {
          outcome: "Times are stored as UTC plus the zone ID.",
          wrap_state: "wrapped",
          learnings: ["Store UTC plus the zone ID.", "Convert once, at the edge."],
        },
      });
    },
    LONG,
  );

  test(
    "dropped archives the task and wraps it up; the user's drop without an outcome leaves no wrap-up",
    async () => {
      const task = await add("Fixture task dropped by an agent");
      expect(
        await finish({ task, status: "dropped", outcome: "The clinic moved to the new system." }),
      ).toMatchObject({
        result: "completed",
        lifecycle: "archived",
        wrap_state: "wrapped",
        learnings: 0,
      });
      expect((await outcomeOf(task)).outcome).toMatchObject({
        outcome: "The clinic moved to the new system.",
        wrap_state: "wrapped",
      });
      const mine = await add("Fixture task the user drops");
      const dropped = await finish({ task: mine, status: "dropped" }, USER);
      expect(dropped).toMatchObject({ result: "completed", lifecycle: "archived", learnings: 0 });
      expect(dropped.wrap_state).toBeUndefined();
    },
    LONG,
  );

  test(
    "a task the user checked off is wrapped up; wrapped already, it is no_change with the same outcome and a conflict naming the stored outcome otherwise",
    async () => {
      const task = await add("Fixture task the user checks off");
      expect(await finish({ task }, USER)).toMatchObject({
        result: "completed",
        lifecycle: "completed",
        wrap_state: "pending",
      });
      const wrap = { task, outcome: "Answered the clinic.", learnings: ["Ask before exporting."] };
      const wrapped = await finish(wrap);
      expect(wrapped).toMatchObject({
        result: "completed",
        lifecycle: "completed",
        wrap_state: "wrapped",
        learnings: 1,
      });
      // The same call again, with a new request ID: nothing to change.
      expect(await finish(wrap)).toMatchObject({
        result: "no_change",
        lifecycle: "completed",
        wrap_state: "wrapped",
        learnings: 0,
      });
      // The user's check-off of a finished task changes nothing either.
      expect(await finish({ task }, USER)).toMatchObject({ result: "no_change" });
      // Another outcome is a conflict that shows the stored one, whatever the base.
      const body = await refusal("task.finish", {
        task,
        outcome: "Answered the clinic twice.",
        base: await asOf(),
        request_id: rid(),
      });
      expect(body).toMatchObject({
        code: "conflict",
        data: {
          cause: "VERSION_CONFLICT",
          conflicts: [
            {
              task,
              field: "wrap",
              value: expect.objectContaining({ outcome: "Answered the clinic." }) as unknown,
            },
          ],
        },
      });
      expect((await outcomeOf(task)).outcome).toEqual({
        outcome: "Answered the clinic.",
        wrap_state: "wrapped",
        learnings: ["Ask before exporting."],
      });
    },
    LONG,
  );

  test(
    "only complete_task's held wrap-up is called wrapped up already: a stale base or an undo that meets a change to wrap alone keeps its own message",
    async () => {
      const ALREADY = "already_wrapped";
      // complete_task: another outcome, or the same one with a new learning, is held whatever the
      // base, and says so.
      const task = await add("Fixture task wrapped up once");
      await finish({ task, outcome: "Fixture first outcome." });
      for (const again of [
        { outcome: "Fixture second outcome." },
        { outcome: "Fixture first outcome.", learnings: ["Fixture new learning."] },
      ]) {
        const held = await refusal("task.finish", {
          task,
          ...again,
          base: await asOf(),
          request_id: rid(),
        });
        expect(held).toMatchObject({ code: "conflict", data: { reason: ALREADY } });
        expect(held.message).toBe(
          "The task is already wrapped up with another outcome or other learnings, so nothing was changed.",
        );
        expect(held.hint).toContain("reopen_task");
      }

      // reopen_task with a base from before the task's wrap-up: a change since the base, so read
      // again, never "reopen it first".
      const checked = await add("Fixture task reopened from a stale base");
      await finish({ task: checked }, USER);
      const stale = await asOf();
      await finish({ task: checked, outcome: "Fixture outcome after the base." });
      const reopen = await refusal("task.reopen", {
        task: checked,
        reason: "Fixture reason.",
        base: stale,
        request_id: rid(),
      });
      expect(reopen).toMatchObject({ code: "conflict", data: { conflicts: [{ field: "wrap" }] } });
      expect(reopen.data?.["reason"]).toBeUndefined();
      expect(reopen.message).not.toContain("already wrapped up");
      expect(reopen.hint).not.toContain("reopen_task");

      // The person's undo of a wrap-up that a script reopened since: the undo's own conflict.
      const undone = await add("Fixture task whose wrap-up is undone");
      await finish({ task: undone }, USER);
      await finish({ task: undone, outcome: "Fixture wrap-up to undo." }, USER);
      await call("task.reopen", {
        task: undone,
        reason: "Fixture script reopens it.",
        base: await asOf(),
        request_id: rid(),
      });
      const undo = await refusal("history.undo", { request_id: rid() }, USER);
      expect(undo).toMatchObject({ code: "conflict", data: { conflicts: [{ field: "wrap" }] } });
      expect(undo.data?.["reason"]).toBeUndefined();
      expect(undo.message).not.toContain("already wrapped up");
      expect(undo.hint).not.toContain("reopen_task");
    },
    LONG,
  );

  test(
    "the outcome section pages a long outcome with many learnings: every character and every learning once, and no MCP page is cut",
    async () => {
      /** Every page of a sections read: the outcome's parts, the learnings and the pages' MCP text. */
      const pagesOf = async (task: string, sections: string[]) => {
        const parts: string[] = [];
        const seen: string[] = [];
        const texts: string[] = [];
        const tokens: string[] = [];
        let before: string | undefined;
        do {
          const result = await call("task.get", {
            task,
            sections,
            ...(before === undefined ? {} : { before }),
          });
          const read = TaskGetResult.parse(result);
          if (read.view !== "sections") throw new Error("not a sections read");
          parts.push(read.sections.outcome?.outcome ?? "");
          seen.push(...(read.sections.outcome?.learnings ?? []));
          texts.push(renderResult("task.get", result));
          before = read.before;
          if (before !== undefined) tokens.push(before);
        } while (before !== undefined && texts.length < 20);
        expect(before).toBeUndefined();
        // A page fits the agent's budget whole (A3 3.4.4): nothing it holds is cut.
        for (const text of texts) {
          expect(text).not.toMatch(/cut to fit|\(\+\d+ chars\)|not shown/);
        }
        return { outcome: parts.join(""), learnings: seen, pages: texts.length, tokens };
      };
      const task = await add("Fixture task with a long wrap-up");
      const outcome = Array.from({ length: 64 }, (_, k) => `Line ${String(k)} of the outcome.`)
        .join("\n")
        .padEnd(4_000, ".");
      const learnings = Array.from({ length: 20 }, (_, k) => `${String(k)} `.padEnd(1_000, "l"));
      expect(await finish({ task, outcome, learnings }, USER)).toMatchObject({ learnings: 20 });
      const read = await pagesOf(task, ["outcome"]);
      expect(read).toMatchObject({ outcome, learnings });
      expect(read.pages).toBeGreaterThan(5);

      // A short outcome after a long context: the page ends after the outcome's text, and the
      // learnings go on from the first. Learnings without an outcome page the same way.
      const short = await add("Fixture task with a short outcome", {
        context: "Fixture context. ".repeat(180),
      });
      await finish(
        { task: short, outcome: "Short outcome.", learnings: learnings.slice(0, 5) },
        USER,
      );
      const after = await pagesOf(short, ["context", "outcome"]);
      expect(after).toMatchObject({
        outcome: "Short outcome.",
        learnings: learnings.slice(0, 5),
      });
      expect(after.tokens[0]).toBe("o0");
      const bare = await add("Fixture task with learnings only");
      await finish({ task: bare, learnings: learnings.slice(5, 12) }, USER);
      expect(await pagesOf(bare, ["outcome"])).toMatchObject({
        outcome: "",
        learnings: learnings.slice(5, 12),
      });
    },
    LONG,
  );

  test(
    "a follow-up of the task's own ticket after a wrap-up is new work, and a replay answers as the first call did",
    async () => {
      const ticket = { key: "jira:LUM-901", kind: "ticket", title: "Export times" };
      const task = await add("Fixture task with a ticket", { sources: [ticket] });
      await finish({ task }, USER);
      const input = {
        task,
        outcome: "Fixed the export.",
        learnings: ["Check the mobile export too."],
        follow_ups: [{ title: "Fixture follow-up on the same ticket", sources: [ticket] }],
        base: await asOf(),
        request_id: rid(),
      };
      const first = TaskFinishResult.parse(await call("task.finish", input));
      expect(first).toMatchObject({
        result: "completed",
        lifecycle: "completed",
        wrap_state: "wrapped",
        learnings: 1,
        follow_ups: [{ result: "created" }],
      });
      expect(first.follow_ups[0]?.ref).not.toBe(task);
      // The task moves on: reopened and checked off again, its wrap-up waits once more.
      await call("task.reopen", {
        task,
        reason: "Fixture reason.",
        base: await asOf(),
        request_id: rid(),
      });
      await finish({ task }, USER);
      expect(TaskFinishResult.parse(await call("task.finish", input))).toEqual({
        ...first,
        replayed: true,
      });
    },
    LONG,
  );
});
