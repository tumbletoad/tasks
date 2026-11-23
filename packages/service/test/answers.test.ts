// What an agent is told about its write is what happened: a retry with the same request ID gets
// the answer the first call got, also for a write that changed nothing; an import makes groups only
// for the drafts it adds; a task's history holds that task's changes, every one of them; a source's
// date is a real date, and the answer shows what was stored. A service in this process, fixture
// text and temporary folders only.
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, findEntry, parseInput, type ErrorBody } from "@ttasks/contracts";
import { intentFingerprint, newId, type Id } from "@ttasks/storage";
import { toolCaller } from "../src/mcp/index.ts";
import { opCall, principalOf, type Binding, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;
let w: ContractWorld & { root: string };
const LONG = 180_000;

beforeAll(async () => {
  w = await contractWorld("answers");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** An agent's shell, and the person at a terminal, whose changes Undo takes back. */
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
/** What an agent reads back from a tool. */
async function tool(name: string, args: Json): Promise<string> {
  const binding: Binding = { kind: "none", space: w.space, named: false };
  const result = await toolCaller({
    ops: w.service.ops,
    context: { space: null },
    conn: 1,
    binding,
  })(name, args);
  return result.content[0].text;
}

let n = 0;
const rid = () => `fixture-answers-${String((n += 1)).padStart(6, "0")}`;
const asOf = async () => (await call("space.status", {}))["as_of"] as string;

/** A folder of this test, made with its parents. */
function folder(...parts: string[]): string {
  const path = join(w.root, "work", "answers", ...parts);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** Every area's and project's name in the space. */
async function groupNames(): Promise<string[]> {
  const listed = (await call("group.manage", { action: "list" })) as {
    areas: { name: string; projects: { name: string }[] }[];
    projects: { name: string }[];
  };
  return [
    ...listed.areas.flatMap((a) => [a.name, ...a.projects.map((p) => p.name)]),
    ...listed.projects.map((p) => p.name),
  ];
}

describe("[A3.answers.replay] a retry gets the answer the first call got", () => {
  test("a create of a group that exists, sent again after Undo removed the group, still changes nothing", async () => {
    const made = await call(
      "group.manage",
      { action: "create", path: "Shed", request_id: rid() },
      USER,
    );
    expect(made).toMatchObject({ result: "created", group: { kind: "area", name: "Shed" } });
    const again = { action: "create", path: "Shed", request_id: rid() };
    const first = await call("group.manage", again);
    expect(first).toMatchObject({ result: "no_change", group: { name: "Shed" } });
    await call("history.undo", { request_id: rid() }, USER);
    expect(await groupNames()).not.toContain("Shed");
    // The answer was lost on the way, so the agent sends the same request again.
    const retry = await call("group.manage", again);
    expect(retry).toMatchObject({
      result: "no_change",
      replayed: true,
      group: (first as { group: Json }).group,
    });
    expect(await groupNames()).not.toContain("Shed");
  });

  test("a project made for a folder another project has, sent again, names that project as before", async () => {
    const at = folder("held");
    const holder = await call(
      "folder.manage",
      { action: "add_project", project: "Holder", folder: at, request_id: rid() },
      USER,
    );
    const again = { action: "add_project", project: "Second", folder: at, request_id: rid() };
    const first = await call("folder.manage", again, USER);
    expect(first).toMatchObject({
      result: "exists",
      owner: { id: (holder["owner"] as Json)["id"] },
    });
    const retry = await call("folder.manage", again, USER);
    expect(retry).toEqual({ ...first, replayed: true });
  });

  test("a folder change sent again names the folders that moved along with it, as the first answer did", async () => {
    const old = folder("before");
    const made = await call(
      "folder.manage",
      { action: "add_project", project: "Moving", folder: old, request_id: rid() },
      USER,
    );
    const owner = made["owner"] as { id: string };
    const markers = w.service.ops.markers;
    // A marker that a loaded disk did not take in time is taken at the next look.
    while (
      markers !== undefined &&
      !(await markers.mark(
        { space: w.space, kind: "project", id: owner.id },
        String(made["folder"]),
      ))
    );
    const added = await call(
      "task.add",
      {
        tasks: [{ title: "Inside the moving folder", folder: folder("before", "inner") }],
        request_id: rid(),
      },
      USER,
    );
    const ref = (added["tasks"] as Json[])[0]?.["ref"];
    renameSync(old, join(w.root, "work", "answers", "after"));
    const set = {
      action: "set",
      project: owner.id,
      folder: join(w.root, "work", "answers", "after"),
      base: await asOf(),
      request_id: rid(),
    };
    const first = await call("folder.manage", set, USER);
    expect(first).toMatchObject({ result: "set", moved: 1, followed: [{ kind: "task", ref }] });
    const retry = await call("folder.manage", set, USER);
    expect(retry).toEqual({ ...first, replayed: true });
  });

  test("a task's folder change names the project folder that moved along, as data, and so does its retry", async () => {
    const own = folder("task-own");
    const added = await call(
      "task.add",
      { tasks: [{ title: "A task with its own folder", folder: own }], request_id: rid() },
      USER,
    );
    const task = (added["tasks"] as Json[])[0] as { ref: string };
    const inner = await call(
      "folder.manage",
      {
        action: "add_project",
        project: "Nested inside",
        folder: folder("task-own", "nested"),
        request_id: rid(),
      },
      USER,
    );
    const markers = w.service.ops.markers;
    const read = await call("task.get", { task: task.ref }, USER);
    const digest = read["task"] as { id: string; folder: { path: string } };
    while (
      markers !== undefined &&
      !(await markers.mark({ space: w.space, kind: "task", id: digest.id }, digest.folder.path))
    );
    const moved = join(w.root, "work", "answers", "task-moved");
    renameSync(own, moved);
    const update = {
      task: task.ref,
      set: { folder: moved },
      base: await asOf(),
      request_id: rid(),
    };
    const first = await call("task.update", update, USER);
    expect(first).toMatchObject({
      result: "updated",
      moved: 1,
      followed: [{ kind: "project", name: (inner["owner"] as Json)["name"] }],
    });
    const retry = await call("task.update", update, USER);
    expect(retry).toEqual({ ...first, replayed: true });
  });
});

describe("[A3.answers.replay-meanwhile] a retry gets the first answer, whatever was written in between", () => {
  const groupId = (answer: Json) => String((answer["group"] as Json)["id"]);
  const ticket = (key: string) => ({ key, kind: "ticket", title: "Fixture ticket" });

  test("a project's creation, sent again after the project moved, names the area it was made in", async () => {
    const create = { action: "create", path: "Farm/Barn", request_id: rid() };
    const first = await call("group.manage", create, USER);
    expect(first).toMatchObject({ result: "created", group: { area: { name: "Farm" } } });
    await call(
      "group.manage",
      { action: "move", path: groupId(first), to: "Coast", base: await asOf(), request_id: rid() },
      USER,
    );
    expect(await call("group.manage", create, USER)).toEqual({ ...first, replayed: true });
  });

  test("a folder change, sent again after its project was renamed, names the project as it was", async () => {
    const made = await call(
      "folder.manage",
      { action: "add_project", project: "Kiln", folder: folder("kiln"), request_id: rid() },
      USER,
    );
    const project = String((made["owner"] as Json)["id"]);
    const set = {
      action: "set",
      project: "Kiln",
      folder: folder("kiln-next"),
      base: await asOf(),
      request_id: rid(),
    };
    const first = await call("folder.manage", set, USER);
    expect(first).toMatchObject({ result: "set", owner: { name: "Kiln" } });
    await call(
      "group.manage",
      {
        action: "rename",
        path: project,
        to: "Kiln renamed",
        base: await asOf(),
        request_id: rid(),
      },
      USER,
    );
    expect(await call("folder.manage", set, USER)).toEqual({ ...first, replayed: true });
  });

  test("an import that found its task by key, sent again after the task was renamed, gives the title it gave", async () => {
    await call("task.add", {
      tasks: [{ title: "Keyed before", sources: [ticket("fixture:meanwhile-1")] }],
      request_id: rid(),
    });
    const again = {
      tasks: [{ title: "Keyed again", sources: [ticket("fixture:meanwhile-1")] }],
      request_id: rid(),
    };
    const first = await call("task.add", again);
    const found = (first["tasks"] as Json[])[0] as { result: string; ref: string; title: string };
    expect(found).toMatchObject({ result: "exists", title: "Keyed before" });
    await call("task.update", {
      task: found.ref,
      set: { title: "Keyed and renamed" },
      base: await asOf(),
      request_id: rid(),
    });
    expect(await call("task.add", again)).toEqual({ ...first, replayed: true });
  });

  test("a follow-up that found its task by key, sent again after the task was renamed, gives the title it gave", async () => {
    await call("task.add", {
      tasks: [{ title: "Keyed follow-up", sources: [ticket("fixture:meanwhile-2")] }],
      request_id: rid(),
    });
    const added = await call("task.add", {
      tasks: [{ title: "Finished here" }],
      request_id: rid(),
    });
    const done = (added["tasks"] as { ref: string }[])[0]?.ref ?? "";
    const finish = {
      task: done,
      outcome: "Fixture outcome.",
      follow_ups: [{ title: "Follow it up", sources: [ticket("fixture:meanwhile-2")] }],
      base: await asOf(),
      request_id: rid(),
    };
    const first = await call("task.finish", finish);
    const follow = (first["follow_ups"] as { result: string; ref: string }[])[0];
    expect(follow).toMatchObject({ result: "exists", title: "Keyed follow-up" });
    await call("task.update", {
      task: follow?.ref,
      set: { title: "Followed and renamed" },
      base: await asOf(),
      request_id: rid(),
    });
    expect(await call("task.finish", finish)).toEqual({ ...first, replayed: true });
  });

  test("a preference set, sent again after another value was set, says the value it set", async () => {
    const key = "tasks.dedupe_window_days";
    const set = (value: number) => ({
      action: "set",
      set: [{ key, value }],
      request_id: rid(),
    });
    const fourteen = set(14);
    const first = await call("prefs.manage", { ...fourteen, base: await asOf() }, USER);
    expect(first).toMatchObject({ result: "updated", prefs: [{ key, value: 14 }] });
    await call("prefs.manage", { ...set(30), base: await asOf() }, USER);
    const retry = await call("prefs.manage", { ...fourteen, base: await asOf() }, USER);
    await call("prefs.manage", { ...set(21), base: await asOf() }, USER);
    expect(retry).toEqual({ ...first, replayed: true });
  });

  test("an undo, sent again after a script changed its task, says what it said", async () => {
    const added = await call("task.add", { tasks: [{ title: "Undone here" }], request_id: rid() });
    const ref = (added["tasks"] as { ref: string }[])[0]?.ref ?? "";
    await call(
      "task.update",
      { task: ref, set: { summary: "A change to undo" }, base: await asOf(), request_id: rid() },
      USER,
    );
    const undo = { request_id: rid() };
    const first = await call("history.undo", undo, USER);
    expect(first).toMatchObject({ result: "undone", tasks: [ref] });
    expect(first["script_change"]).toBeUndefined();
    await call("task.update", {
      task: ref,
      set: { summary: "A script's change after the undo" },
      base: await asOf(),
      request_id: rid(),
    });
    expect(await call("history.undo", undo, USER)).toEqual({ ...first, replayed: true });
  });
});

describe("[A3.answers.retry-first] a request answered before is answered again before today's rules read it", () => {
  /** The agent's shell as the writer knows it: its actor and its writer scope. */
  async function script() {
    const writer = w.service.ops.spaces().find((s) => s.id === w.space)?.writer;
    if (writer === undefined) throw new Error("the world's space has no writer");
    const principal = principalOf("cli-script", w.service.ops.machine.id);
    const actor = {
      scope_id: principal.scope,
      principal_id: await writer.actor("agent", principal.label),
      actor_kind: "agent" as const,
      machine_id: w.service.ops.machine.id as Id<"m">,
      origin: "cli" as const,
    };
    return { writer, actor };
  }

  /**
   * A one-task import as the build before this one decided it: the request it sent to the writer,
   * its intent the input as that build parsed it, the source's date read by Date.parse.
   */
  async function earlierImport(at: string): Promise<{ input: Json; task: Id<"t"> }> {
    const { writer, actor } = await script();
    const input = {
      tasks: [{ title: `Dated ${at}`, sources: [{ kind: "email", title: "Fixture mail", at }] }],
      request_id: rid(),
    };
    const entry = findEntry("task.add");
    if (entry === undefined) throw new Error("task.add is no entry");
    const parsed = parseInput(entry, "agent", input);
    if (!parsed.success) throw new Error("the earlier input does not parse");
    const task = newId("t");
    const first = await writer.submit({
      space_id: w.space,
      request_id: input.request_id,
      actor,
      intent: { entry: "task.add", input: parsed.data },
      ops: [
        { kind: "task.create", id: task, title: `Dated ${at}`, inbox: true },
        {
          kind: "source.add",
          task,
          source: { kind: "email", title: "Fixture mail", at: Date.parse(at) },
        },
      ],
    });
    expect(first.status).toBe("applied");
    return { input, task };
  }

  test("an import an earlier build accepted with a date this build refuses, sent again, is answered and adds nothing", async () => {
    for (const at of ["Mon, 2 Mar 2026", "2026-02-30"]) {
      const { input, task } = await earlierImport(at);
      const before = await asOf();
      const retry = await call("task.add", input);
      expect(retry).toMatchObject({ replayed: true, tasks: [{ result: "created", id: task }] });
      expect(await call("task.add", input)).toEqual(retry);
      expect(await asOf()).toBe(before);
      // The same date under a new request ID is a new request: this build's rule refuses it.
      expect(await refusal("task.add", { ...input, request_id: rid() })).toMatchObject({
        code: "invalid_input",
        data: { issues: [{ path: "tasks.0.sources.0.at" }] },
      });
    }
  });

  test("a request whose answer was kept is answered from it, also when its input breaks a rule of this build", async () => {
    const { writer, actor } = await script();
    // A title as long as an earlier, wider limit allowed: this build refuses it for an agent.
    const input = { tasks: [{ title: "T".repeat(300) }], request_id: rid() };
    const task = newId("t");
    const first = await writer.submit({
      space_id: w.space,
      request_id: input.request_id,
      actor,
      intent: { entry: "task.add", input },
      ops: [{ kind: "task.create", id: task, title: "T".repeat(300), inbox: true }],
    });
    expect(first.status).toBe("applied");
    const fingerprint = intentFingerprint({
      space_id: w.space,
      entry: "task.add",
      input,
      reason: null,
    });
    const answer = { as_of: first.as_of, tasks: [{ result: "created", id: task }], warnings: [] };
    await writer.keep(
      { scope_id: actor.scope_id, request_id: input.request_id, fingerprint },
      { sent: fingerprint, result: answer },
    );
    expect(await call("task.add", input)).toEqual({ ...answer, replayed: true });
    expect(await refusal("task.add", { ...input, request_id: rid() })).toMatchObject({
      code: "too_large",
    });
  });
});

describe("[A3.answers.groups] an import makes groups only for the drafts it adds", () => {
  const ticket = (key: string) => ({ key, kind: "ticket", title: "Fixture ticket" });

  test("a draft that finds its task by key makes none of the groups it names", async () => {
    await call("task.add", {
      tasks: [{ title: "Keyed work", sources: [ticket("fixture:groups-1")] }],
      request_id: rid(),
    });
    const again = await call("task.add", {
      tasks: [
        {
          title: "Keyed work again",
          area: "Unused area",
          project: "Unused project",
          sources: [ticket("fixture:groups-1")],
        },
      ],
      request_id: rid(),
    });
    expect((again["tasks"] as Json[])[0]).toMatchObject({ result: "exists" });
    expect(again["warnings"]).toEqual([]);
    const names = await groupNames();
    expect(names).not.toContain("Unused area");
    expect(names).not.toContain("Unused project");
  });

  test("a group named by a matched draft and an added one is made once, for the added one", async () => {
    await call("task.add", {
      tasks: [{ title: "Keyed elsewhere", sources: [ticket("fixture:groups-2")] }],
      request_id: rid(),
    });
    const added = await call("task.add", {
      tasks: [
        {
          title: "Keyed elsewhere again",
          area: "Shared area",
          project: "Shared project",
          sources: [ticket("fixture:groups-2")],
        },
        { title: "New in the shared project", area: "Shared area", project: "Shared project" },
      ],
      request_id: rid(),
    });
    expect((added["tasks"] as Json[]).map((t) => t["result"])).toEqual(["exists", "created"]);
    const listed = (await call("group.manage", { action: "list" })) as {
      areas: { name: string; projects: { name: string; active: number }[] }[];
    };
    expect(listed.areas.find((a) => a.name === "Shared area")?.projects).toEqual([
      expect.objectContaining({ name: "Shared project", active: 1 }),
    ]);
  });
});

describe("[A3.answers.history] a task's history is its own changes, every one of them", () => {
  test("a task made in one call with another shows none of the other's entries", async () => {
    const added = await call("task.add", {
      tasks: [{ title: "Made without a log" }, { title: "Made with a log", log: "Fixture entry" }],
      request_id: rid(),
    });
    const [a] = added["tasks"] as { ref: string }[];
    const read = await call("task.get", { task: a?.ref, sections: ["history"] });
    const history = (read["sections"] as { history: { what: string }[] }).history;
    expect(history).toHaveLength(1);
    expect(history[0]?.what).not.toMatch(/log\.add|\bl1\b/u);
  });

  test("paging through a task's history reaches its first change, and a change made meanwhile moves no page", async () => {
    const added = await call("task.add", { tasks: [{ title: "Busy task" }], request_id: rid() });
    const ref = (added["tasks"] as { ref: string }[])[0]?.ref ?? "";
    for (let k = 0; k < 45; k += 1) {
      await call("entry.add", {
        task: ref,
        kind: "progress",
        text: `Step ${String(k)}`,
        request_id: rid(),
      });
    }
    const seen: number[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const read = await call("task.get", {
        task: ref,
        sections: ["history"],
        ...(before === undefined ? {} : { before }),
      });
      seen.push(...(read["sections"] as { history: { seq: number }[] }).history.map((h) => h.seq));
      before = typeof read["before"] === "string" ? read["before"] : undefined;
      pages += 1;
      // A change made between two pages: the next page still starts where this one ended.
      if (pages === 1) {
        await call("entry.add", {
          task: ref,
          kind: "progress",
          text: "Meanwhile",
          request_id: rid(),
        });
      }
    } while (before !== undefined && pages < 10);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(46);
    expect(new Set(seen).size).toBe(46);
    expect([...seen].sort((x, y) => y - x)).toEqual(seen);
  });
});

describe("[A3.answers.source-date] a source's date is a date, and the answer shows the one stored", () => {
  test("February 30 is refused at its field, and nothing is added", async () => {
    const before = await asOf();
    const refused = await refusal("task.add", {
      tasks: [
        {
          title: "Dated wrongly",
          sources: [{ kind: "doc", title: "Fixture document", at: "2026-02-30" }],
        },
      ],
      request_id: rid(),
    });
    expect(refused).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "tasks.0.sources.0.at" }] },
    });
    expect(await asOf()).toBe(before);
  });

  test("an agent reads back the date its source was stored with", async () => {
    const added = await call("task.add", {
      tasks: [
        {
          title: "Dated rightly",
          sources: [{ kind: "doc", title: "Fixture document", at: "2026-02-27T10:00:00+01:00" }],
        },
      ],
      request_id: rid(),
    });
    const ref = (added["tasks"] as { ref: string }[])[0]?.ref ?? "";
    const text = await tool("get_task", { task: ref, sections: ["sources"] });
    expect(text).toContain("2026-02-27T09:00:00.000Z");
  });
});
