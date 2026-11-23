// Moving tasks to the Trash and back through real requests: the person at a terminal calls the
// request path in this process, an agent's shell is refused, and an agent reads the MCP text. The
// Trash lists what was removed on purpose, grouped by the change; an undone creation stays on Redo.
// A restore names where each task is back and a link another task took meanwhile. Fixture text
// only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { RUN_LIMITS } from "@ttasks/contracts/runs";
import { SpaceExecutionStore } from "@ttasks/launch";
import { renderResult } from "../src/mcp/index.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;
interface Row {
  ref: string;
  title: string;
  area?: string;
  project?: string;
  removed: { id: string; by: string; count: number; at: string; reason?: string };
}

let w: ContractWorld & { root: string };
const LONG = 180_000;

beforeAll(async () => {
  w = await contractWorld("trash");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const PERSON: Caller = { class: "cli-interactive", env: {} };
/** An agent's shell: the agent audience. */
const AGENT: Caller = { class: "cli-script", env: {} };

let n = 0;
const rid = () => `fixture-trash-${String((n += 1)).padStart(6, "0")}`;
const call = async (op: string, input: Json, who: Caller = PERSON): Promise<Json> =>
  (await opCall(w.service.ops, who, { op, input })) as Json;
async function refusal(op: string, input: Json, who: Caller = PERSON): Promise<ErrorBody> {
  const error = await call(op, input, who).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`${op} was not refused`);
  return error.toBody();
}
const asOf = async () => (await call("space.status", {}))["as_of"] as string;
async function add(draft: Json, who: Caller = PERSON): Promise<string> {
  const added = await call("task.add", { tasks: [draft], request_id: rid() }, who);
  return (added["tasks"] as { ref: string }[])[0]?.ref ?? "";
}
const remove = async (tasks: string[], extra: Json = {}) =>
  call("task.delete", { tasks, base: await asOf(), request_id: rid(), ...extra });
const restore = async (input: Json) =>
  call("task.delete", { restore: true, base: await asOf(), request_id: rid(), ...input });
const trash = async (input: Json = {}): Promise<{ rows: Row[]; cursor?: string }> =>
  (await call("task.trash", { limit: 200, ...input })) as unknown as {
    rows: Row[];
    cursor?: string;
  };
const refs = (rows: readonly Row[]) => rows.map((r) => r.ref);
const ticket = (key: string) => ({ kind: "ticket", key, title: `Fixture ticket ${key}` });

/** A background run of the task with ID `task`, started and working; `end` ends it with its answer. */
async function startRun(task: string): Promise<{ id: string; end: () => Promise<void> }> {
  const served = w.service.ops.spaces().find((s) => s.id === w.space);
  const writer = served?.writer;
  if (writer === undefined) throw new Error("the space is not open");
  const machine = w.service.ops.machine.id;
  const store = new SpaceExecutionStore({
    writer,
    spaceId: w.space,
    credential: {
      scope_id: `trash:${machine}`,
      principal_id: await writer.actor("human", "user"),
      actor_kind: "human",
      machine_id: machine,
      origin: "ui",
    },
  });
  // No round of the service's runs takes this record while the test moves it.
  const hold = w.service.runs.hold();
  const queued = await store.createRun(
    {
      task,
      routine: null,
      machine,
      instance: "codex-work",
      adapter: "codex",
      place: null,
      request: "Fixture request",
      briefHash: "0123456789abcdef".repeat(4),
      permission: "full-access",
      limits: RUN_LIMITS.task,
    },
    rid(),
  );
  const starting = await store.transitionRun(
    queued.id,
    { state: "queued", version: queued.version },
    "starting",
  );
  const running = await store.transitionRun(
    starting.id,
    { state: "starting", version: starting.version },
    "running",
  );
  return {
    id: running.id,
    end: async () => {
      await store.transitionRun(
        running.id,
        { state: "running", version: running.version },
        "succeeded",
        {
          result: {
            ok: true,
            outcome: "success",
            exitCode: 0,
            signal: null,
            nativeId: null,
            text: "Fixture answer",
            error: null,
            usage: null,
            appTools: null,
            declined: 0,
            permissionDenials: 0,
            durationMs: 1,
          },
        },
      );
      hold.release();
    },
  };
}

describe("[A3.trash] the Trash through real requests", () => {
  test("delete moves tasks as one change, a second delete is no change, and the Trash groups them by that change", async () => {
    const [a, b] = [
      await add({ title: "Fixture trash one" }),
      await add({ title: "Fixture trash two" }),
    ];
    // A task named twice is moved once and named once.
    const moved = await remove([a, b, a], { reason: "Duplicates of the clinic thread" });
    expect(moved["already"]).toBeUndefined();
    expect(moved).toMatchObject({ result: "moved", moved: [a, b] });
    expect(moved["commit"]).toMatch(/^op_/u);
    const again = await remove([a]);
    expect(again).toMatchObject({ result: "no_change", moved: [], already: [a] });
    const listed = (await trash()).rows.filter((r) => [a, b].includes(r.ref));
    expect(refs(listed)).toEqual([a, b]);
    for (const row of listed) {
      expect(row.removed).toMatchObject({
        id: moved["commit"],
        by: "user",
        count: 2,
        reason: "Duplicates of the clinic thread",
      });
    }
    // Neither is in a list any more, and a read names who moved it there.
    const search = await call("task.search", { q: "Fixture trash", scope: "all" });
    expect((search["rows"] as Json[]).map((r) => r["ref"])).not.toContain(a);
    const read = await call("task.get", { task: a });
    expect((read["task"] as Json)["deleted"]).toMatchObject({
      by: "user",
      change: moved["commit"],
    });
  });

  test("a reference or words of a title find a task anywhere in the Trash; pages go on from the cursor without a gap", async () => {
    const tasks: string[] = [];
    for (let i = 0; i < 5; i += 1)
      tasks.push(await add({ title: `Fixture paged trash ${String(i)}` }));
    await remove(tasks);
    const [third] = tasks.slice(2);
    expect(refs((await trash({ q: third })).rows)).toEqual([third]);
    expect(refs((await trash({ q: "PAGED trash 4" })).rows)).toEqual([tasks[4]]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await trash({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...refs(page.rows));
      cursor = page.cursor;
    } while (cursor !== undefined);
    expect(seen.filter((ref) => tasks.includes(ref))).toEqual(tasks);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("an undone creation is not in the Trash and Redo brings it back whole; a delete undone and redone is its first change", async () => {
    const made = await call("task.add", {
      tasks: [{ title: "Fixture undone creation", sources: [ticket("fix:TR-1")] }],
      request_id: rid(),
    });
    const created = (made["tasks"] as { ref: string }[])[0]?.ref ?? "";
    await call("history.undo", { request_id: rid() });
    expect(refs((await trash()).rows)).not.toContain(created);
    expect(await refusal("task.get", { task: created })).toMatchObject({ code: "not_found" });
    await call("history.redo", { request_id: rid() });
    const back = await call("task.get", { task: created, sections: ["sources"] });
    expect(((back["sections"] as Json)["sources"] as Json[]).map((s) => s["key"])).toEqual([
      "fix:TR-1",
    ]);

    const gone = await add({ title: "Fixture undone delete" });
    const first = (await remove([gone]))["commit"];
    await call("history.undo", { request_id: rid() });
    await call("history.redo", { request_id: rid() });
    expect((await trash({ q: gone })).rows[0]?.removed.id).toBe(first);
  });

  test("restoring a change brings back what is still there from it and names the rest; a change the space does not have, or one that moved nothing there, restores nothing", async () => {
    const tasks = [
      await add({ title: "Fixture change one" }),
      await add({ title: "Fixture change two" }),
      await add({ title: "Fixture change three" }),
    ];
    const [one, two, three] = tasks as [string, string, string];
    const change = (await remove(tasks))["commit"] as string;
    await restore({ tasks: [two] });
    const later = (await remove([two]))["commit"];
    await restore({ tasks: [three] });
    const result = await call("task.delete", { restore: true, change, request_id: rid() });
    // Two was restored and moved to the Trash again: it is there, with the later change.
    expect(result).toMatchObject({
      result: "restored",
      moved: [one],
      already: [three],
      later: [two],
    });
    expect((await trash({ q: two })).rows[0]?.removed.id).toBe(later);
    const gone = await refusal("task.delete", {
      restore: true,
      change: "op_00000000000000000000000000",
      request_id: rid(),
    });
    expect(gone).toMatchObject({ code: "not_found", data: { reason: "change_gone" } });
    // A change that moved nothing there, such as a restore, says so.
    const four = await add({ title: "Fixture change four" });
    await remove([four]);
    const back = (await restore({ tasks: [four] }))["commit"] as string;
    const none = await refusal("task.delete", { restore: true, change: back, request_id: rid() });
    expect(none).toMatchObject({ code: "invalid_input" });
    expect(none.message).toContain("This change moved nothing to the Trash");
  });

  test("a restore says where each task is back, and a key another task took meanwhile stays there", async () => {
    const a = await add({ title: "Fixture held key", sources: [ticket("fix:TR-9")] });
    await remove([a]);
    const b = await add({ title: "Fixture new holder", sources: [ticket("fix:TR-9")] });
    expect(b).not.toBe(a);
    const back = await restore({ tasks: [a] });
    expect(back).toMatchObject({
      result: "restored",
      moved: [a],
      restored: [{ ref: a, lifecycle: "active", held: [{ by: b }] }],
    });
    // The card's line reads it from the data: the link is removed, and captures go to the holder.
    const read = await call("task.get", { task: a, sections: ["sources"] });
    const [link] = (read["sections"] as Json)["sources"] as Json[];
    expect(link).toMatchObject({ key: "fix:TR-9", captures_to: [b] });
    expect(link?.["removed"]).toBeDefined();
    // A capture of the item goes on to the holder.
    expect(await add({ title: "Fixture capture", sources: [ticket("fix:TR-9")] })).toBe(b);
  });

  test("a retry replays the first answer; a delete with a base from before someone restored the task changes nothing", async () => {
    const a = await add({ title: "Fixture replayed delete" });
    const id = rid();
    const input = { tasks: [a], base: await asOf(), request_id: id };
    const first = await call("task.delete", input);
    expect(await call("task.delete", input)).toEqual({ ...first, replayed: true });
    const seen = await asOf();
    await restore({ tasks: [a] });
    const stale = await refusal("task.delete", { tasks: [a], base: seen, request_id: rid() });
    expect(stale).toMatchObject({
      code: "conflict",
      data: { conflicts: [{ task: a, field: "deleted" }] },
    });
    expect(refs((await trash({ q: a })).rows)).toEqual([]);
  });

  test("an agent's shell is refused in words that say removal is the user's; an agent writing to a removed task is told who removed it", async () => {
    const a = await add({ title: "Fixture agent and trash" });
    const refused = await refusal("task.delete", { tasks: [a], request_id: rid() }, AGENT);
    expect(refused).toMatchObject({ code: "forbidden", data: { rule: "user_only" } });
    expect(refused.message).toContain("agents cannot remove tasks yet");
    await remove([a]);
    const write = await refusal(
      "entry.add",
      { task: a, kind: "progress", text: "Fixture progress.", request_id: rid() },
      AGENT,
    );
    expect(write).toMatchObject({ code: "not_found", data: { reason: "in_trash", task: a } });
    expect(write.message).toMatch(
      new RegExp(`^${a} is in the Trash: the user moved it there at `, "u"),
    );
    expect(write.hint).toBe("Tell the user. Do not add it again or restore it yourself.");
    // A person is told how to bring it back.
    const person = await refusal("task.reopen", { task: a, base: await asOf(), request_id: rid() });
    expect(person.hint).toBe(`Restore it first: ttasks restore ${a}.`);
    // An agent's read says it first.
    const text = renderResult("task.get", await call("task.get", { task: a }, AGENT));
    expect(text.split("\n")[0]).toMatch(
      /^In the Trash: the user moved it there .*do not add it again/u,
    );
  });

  test("a restore says where each task is back: a finished one in Completed, one in a project with its area", async () => {
    await call("group.manage", {
      action: "create",
      path: "Fixture trash area/Fixture trash project",
      request_id: rid(),
    });
    const filed = await add({ title: "Fixture filed", project: "Fixture trash project" });
    const done = await add({ title: "Fixture finished" });
    await call("task.finish", { task: done, base: await asOf(), request_id: rid() });
    await remove([filed, done]);
    const back = await restore({ tasks: [filed, done] });
    expect(back["restored"]).toMatchObject([
      {
        ref: filed,
        lifecycle: "active",
        area: "Fixture trash area",
        project: "Fixture trash project",
      },
      { ref: done, lifecycle: "completed" },
    ]);
  });

  test("a restore or a removal of a task whose creation was undone is refused for the whole request, naming it, and Redo brings it back with its sources and log", async () => {
    const live = await add({ title: "Fixture live beside an undone one" });
    await remove([live]);
    // Made before the undo: a change after it would take the Redo.
    const beside = await add({ title: "Fixture live, named with an undone one" });
    const made = await call("task.add", {
      tasks: [
        {
          title: "Fixture undone with sources",
          sources: [ticket("fix:TR-21")],
          log: "Fixture log entry.",
        },
      ],
      request_id: rid(),
    });
    const undone = (made["tasks"] as { ref: string; id: string }[])[0];
    await call("history.undo", { request_id: rid() });
    for (const [named, restoring] of [
      [[undone?.ref], true],
      [[undone?.id], true],
      [[live, undone?.ref], true],
      [[undone?.ref], false],
      [[beside, undone?.ref], false],
    ] as const) {
      const refused = await refusal("task.delete", {
        tasks: named,
        ...(restoring ? { restore: true } : {}),
        base: await asOf(),
        request_id: rid(),
      });
      expect(refused).toMatchObject({ code: "not_found", data: { reason: "creation_undone" } });
      expect(refused.message).toContain(`${undone?.ref ?? ""}'s creation was undone`);
      expect(refused.hint).toContain("Redo");
    }
    // Nothing moved, the live ones included, and Redo brings the task back whole.
    expect(refs((await trash({ q: live })).rows)).toEqual([live]);
    expect(refs((await trash({ q: beside })).rows)).toEqual([]);
    await call("history.redo", { request_id: rid() });
    const back = await call("task.get", { task: undone?.ref, sections: ["sources", "log"] });
    const sections = back["sections"] as Json;
    expect((sections["sources"] as Json[]).map((s) => s["key"])).toEqual(["fix:TR-21"]);
    expect((sections["log"] as Json[]).map((l) => l["text"])).toEqual(["Fixture log entry."]);
  });

  test("a removal with a base from before any change to one of its tasks is a conflict that names it, and nothing moves", async () => {
    const [a, b] = [
      await add({ title: "Fixture stale removal one" }),
      await add({ title: "Fixture stale removal two" }),
    ];
    const seen = await asOf();
    await call("task.update", {
      task: b,
      set: { title: "Fixture repurposed meanwhile" },
      base: seen,
      request_id: rid(),
    });
    const stale = await refusal("task.delete", { tasks: [a, b], base: seen, request_id: rid() });
    expect(stale).toMatchObject({ code: "conflict" });
    const conflicts = (stale.data as { conflicts: Json[] }).conflicts;
    expect(conflicts.map((c) => c["task"])).toEqual([b]);
    expect(refs((await trash({ q: "Fixture stale removal" })).rows)).toEqual([]);
  });

  test("the same request ID answers what the first answer said, whatever happened since", async () => {
    const a = await add({ title: "Fixture replayed restore" });
    await remove([a]);
    const input = { tasks: [a], restore: true, base: await asOf(), request_id: rid() };
    const first = await call("task.delete", input);
    expect(first["restored"]).toMatchObject([{ ref: a, lifecycle: "active" }]);
    await call("task.finish", { task: a, base: await asOf(), request_id: rid() });
    const again = await call("task.delete", input);
    expect(again["restored"]).toEqual(first["restored"]);
    expect(again).toMatchObject({ replayed: true, result: "restored", moved: [a] });
  });

  test("a reference and its ID in one request are one task; a later change's removal is not 'back already'; Find honours the prefix", async () => {
    const tasks = [
      await add({ title: "Fixture counted one" }),
      await add({ title: "Fixture counted two" }),
    ];
    const [one, two] = tasks as [string, string];
    const id = ((await call("task.get", { task: one }))["task"] as Json)["id"] as string;
    const moved = await remove([one, id]);
    expect(moved).toMatchObject({ result: "moved", moved: [one] });
    expect(moved["already"]).toBeUndefined();
    await remove([two]);
    const change = moved["commit"] as string;
    await restore({ tasks: [one] });
    await remove([one]);
    // Every task of the change is in the Trash from a later one now: none was back already.
    const result = await call("task.delete", { restore: true, change, request_id: rid() });
    expect(result).toMatchObject({ result: "no_change", moved: [], later: [one] });
    expect(result["already"]).toBeUndefined();
    const number = one.slice(one.indexOf("-") + 1);
    expect(refs((await trash({ q: `M-${number}` })).rows)).toEqual([one]);
    expect(refs((await trash({ q: `Z-${number}` })).rows)).toEqual([]);
  });

  test("the Agents page reads a removed task as it places a live one: by the run its row shows, and by the agents the monitor links, with no cut of its own", async () => {
    const a = await add({ title: "Fixture run goes on" });
    const terminal = await add({ title: "Fixture agent in a terminal" });
    const quiet = await add({ title: "Fixture nobody on it" });
    const live = await add({ title: "Fixture live beside them" });
    const ids = new Map<string, string>();
    for (const ref of [a, terminal, quiet, live]) {
      ids.set(ref, ((await call("task.get", { task: ref }))["task"] as Json)["id"] as string);
    }
    const run = await startRun(ids.get(a) ?? "");
    await w.launch(terminal);
    await remove([a, terminal, quiet]);
    // A working run shows on the row, as on a live task's.
    const working = await trash({ working: true });
    expect(refs(working.rows)).toEqual([a]);
    expect(working.rows[0]).toMatchObject({ run: { state: "working" } });
    // Once it ended with its answer the row shows no run, as a live task's does not; the monitor's
    // link to its session reads it still, as it reads the terminal agent's, marked as removed.
    await run.end();
    expect(refs((await trash({ working: true })).rows)).toEqual([]);
    const named = await trash({ tasks: [ids.get(a), ids.get(terminal), ids.get(live)] });
    expect(refs(named.rows).sort()).toEqual([a, terminal].sort());
    expect(named.rows.map((r) => r.removed.by)).toEqual(["user", "user"]);
    // Restore changes nothing but the mark: the run and its answer are the task's as they were.
    await restore({ tasks: [a] });
    const runs = await w.service.runs.list(w.space, a);
    expect(runs.map((r) => [r.run.id, r.run.state])).toEqual([[run.id, "succeeded"]]);
  });
});
