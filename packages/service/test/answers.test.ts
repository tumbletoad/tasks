// What an agent is told about its write is what happened: a retry with the same request ID gets
// what the write did, also for a write that changed nothing, with names as they are now; an import makes groups only
// for the drafts it adds; a task's history holds that task's changes, every one of them; a source's
// date is a real date, and the answer shows what was stored. A service in this process, fixture
// text and temporary folders only.
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PRODUCT_NAME } from "@ttasks/brand";
import { AppError, findEntry, parseInput, type ErrorBody } from "@ttasks/contracts";
import { newId, type Id, type Receipt, type WriteRequest, type WriteResult } from "@ttasks/storage";
import { toolCaller } from "../src/mcp/index.ts";
import { renderError } from "../src/mcp/render.ts";
import { appliedEarlier } from "../src/ops/errors.ts";
import { opCall, principalOf, type Binding, type Caller, type OpsHost } from "../src/ops/index.ts";
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
async function tool(name: string, args: Json, ops: OpsHost = w.service.ops): Promise<string> {
  const binding: Binding = { kind: "none", space: w.space, named: false };
  const result = await toolCaller({
    ops,
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

/** The writer, and `caller`'s actor as the writer knows it in its writer scope. */
async function writerAs(caller: Caller) {
  const writer = w.service.ops.spaces().find((s) => s.id === w.space)?.writer;
  if (writer === undefined) throw new Error("the world's space has no writer");
  const principal = principalOf(caller.class, w.service.ops.machine.id);
  const actor: WriteRequest["actor"] = {
    scope_id: principal.scope,
    principal_id: await writer.actor(principal.actorKind, principal.label),
    actor_kind: principal.actorKind,
    machine_id: w.service.ops.machine.id as Id<"m">,
    origin: principal.origin,
  };
  return { writer, actor };
}

/**
 * A request as another build decided it: the intent and the operations it sent the writer, and
 * the record it kept for the answer, if any.
 */
async function decidedBefore(
  caller: Caller,
  request: { entry: string; input: Json; ops: WriteRequest["ops"]; record?: Json },
): Promise<string> {
  const { writer, actor } = await writerAs(caller);
  const id = rid();
  const history = request.ops.some((op) => op.kind === "undo" || op.kind === "redo");
  const result = await writer.submit({
    space_id: w.space,
    request_id: id,
    actor,
    ...(history ? {} : { base: await asOf() }),
    // A person's change joins the undo stack as the service sends it, but a preference set.
    ...(actor.actor_kind === "human" && !history && request.entry !== "prefs.manage"
      ? { undoable: true }
      : {}),
    intent: { entry: request.entry, input: { ...request.input, request_id: id } },
    ...(request.record === undefined ? {} : { answer: request.record }),
    ops: request.ops,
  });
  expect(result.status, request.entry).toBe("applied");
  return id;
}

describe("[A3.answers.replay] a retry gets what the write did", () => {
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
    // The answer was lost on the way, so the agent sends the same request again. The group it
    // named is gone, so the answer names it by its ID alone.
    const retry = await call("group.manage", again);
    const group = first["group"] as Json;
    expect(retry).toMatchObject({
      result: "no_change",
      replayed: true,
      group: { kind: group["kind"], id: group["id"] },
    });
    expect((retry["group"] as Json)["name"]).toBeUndefined();
    expect(await groupNames()).not.toContain("Shed");
  });

  test("a project made for a folder another project has, sent again, makes no second one and names the other as before", async () => {
    const at = folder("held");
    const holder = await call(
      "folder.manage",
      { action: "add_project", project: "Holder", folder: at, request_id: rid() },
      USER,
    );
    const again = { action: "add_project", project: "Second", folder: at, request_id: rid() };
    const first = await call("folder.manage", again, USER);
    expect(first).toMatchObject({
      result: "created",
      owner: { name: "Second" },
      also: [{ id: (holder["owner"] as Json)["id"], name: "Holder" }],
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
      fields: ["folder"],
      moved: 1,
      followed: [{ kind: "project", name: (inner["owner"] as Json)["name"] }],
    });
    const retry = await call("task.update", update, USER);
    expect(retry).toEqual({ ...first, replayed: true });
  });
});

describe("[A3.answers.replay-meanwhile] a retry repeats what the write did, and names as of now", () => {
  const groupId = (answer: Json) => String((answer["group"] as Json)["id"]);
  const ticket = (key: string) => ({ key, kind: "ticket", title: "Fixture ticket" });

  test("a project's creation, sent again after the project moved, says it was created and where it is now", async () => {
    const create = { action: "create", path: "Farm/Barn", request_id: rid() };
    const first = await call("group.manage", create, USER);
    expect(first).toMatchObject({ result: "created", group: { area: { name: "Farm" } } });
    await call(
      "group.manage",
      { action: "move", path: groupId(first), to: "Coast", base: await asOf(), request_id: rid() },
      USER,
    );
    const retry = await call("group.manage", create, USER);
    expect(retry).toMatchObject({
      result: "created",
      replayed: true,
      group: { kind: "project", id: groupId(first), name: "Barn", area: { name: "Coast" } },
    });
    // Dated by the write, which a base taken from it covers, never by the move after it.
    expect(retry["as_of"]).toBe(first["as_of"]);
    expect(retry["as_of"]).not.toBe(await asOf());
  });

  test("a folder change, sent again after its project was renamed, names the project as it is now", async () => {
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
    expect(first).toMatchObject({ result: "set", owner: { id: project, name: "Kiln" } });
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
    expect(await call("folder.manage", set, USER)).toEqual({
      ...first,
      owner: { ...(first["owner"] as Json), name: "Kiln renamed" },
      replayed: true,
    });
  });

  test("an import that found its task by key, sent again after the task was renamed, finds the same task and names it as it is now", async () => {
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
    expect(await call("task.add", again)).toEqual({
      ...first,
      tasks: [{ ...found, title: "Keyed and renamed" }],
      replayed: true,
    });
  });

  test("a follow-up that found its task by key, sent again after the task was renamed, names it as it is now", async () => {
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
    const follow = (first["follow_ups"] as Json[])[0] as { result: string; ref: string };
    expect(follow).toMatchObject({ result: "exists", title: "Keyed follow-up" });
    await call("task.update", {
      task: follow.ref,
      set: { title: "Followed and renamed" },
      base: await asOf(),
      request_id: rid(),
    });
    expect(await call("task.finish", finish)).toEqual({
      ...first,
      follow_ups: [{ ...follow, title: "Followed and renamed" }],
      replayed: true,
    });
  });

  test("a preference set, sent again after another value was set, says the change it made and the value now", async () => {
    const key = "tasks.dedupe_window_days";
    const set = (value: number) => ({
      action: "set",
      set: [{ key, value }],
      request_id: rid(),
    });
    const fourteen = set(14);
    const first = await call("prefs.manage", { ...fourteen, base: await asOf() }, USER);
    expect(first).toMatchObject({
      result: "updated",
      changed: [{ key, to: 14 }],
      prefs: [{ key, value: 14 }],
    });
    await call("prefs.manage", { ...set(30), base: await asOf() }, USER);
    const retry = await call("prefs.manage", { ...fourteen, base: await asOf() }, USER);
    expect(retry).toMatchObject({
      result: "updated",
      changed: first["changed"],
      prefs: [{ key, value: 30 }],
      as_of: first["as_of"],
      replayed: true,
    });
  });

  test("a level change recorded by a build that recorded levels as names, sent again, says that change and the levels now", async () => {
    const key = "tasks.effort_scale";
    const get = async () =>
      ((await call("prefs.manage", { action: "get", keys: [key] }, USER))["prefs"] as Json[])[0];
    const held = (await get())?.["value"] as Json[];
    const turned = [...held].reverse();
    const names = (levels: Json[]) => levels.map((level) => String(level["key"]));
    const entry = findEntry("prefs.manage");
    if (entry === undefined) throw new Error("prefs.manage is no entry");
    const input = { action: "set", set: [{ key, value: names(turned) }], base: await asOf() };
    const parsed = parseInput(entry, "agent", { ...input, request_id: "fixture-answers-parse" });
    if (!parsed.success) throw new Error("the set does not parse");
    // That build kept this build's record version, with a level list as its names.
    const changed = [{ key, from: names(held), to: names(turned) }];
    const id = await decidedBefore(USER, {
      entry: "prefs.manage",
      input: parsed.data,
      ops: [{ kind: "pref.set", key, value: turned as never }],
      record: { version: 1, entry: "prefs.manage", changed },
    });
    expect(await call("prefs.manage", { ...input, request_id: id }, USER)).toMatchObject({
      result: "updated",
      changed,
      prefs: [{ key, value: turned, is_default: false }],
      replayed: true,
    });
    await call(
      "prefs.manage",
      { action: "set", set: [{ key, reset: true }], base: await asOf(), request_id: rid() },
      USER,
    );
    expect(await get()).toMatchObject({ value: held });
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

/**
 * The world's service, whose writer runs `before` once just before it takes the first request of
 * `entry` and `committed` once just after, and whose reader fails while `failing()` says so.
 */
function held(
  options: {
    readonly entry?: string;
    readonly before?: () => Promise<void>;
    readonly committed?: () => Promise<void>;
    readonly failing?: () => boolean;
    readonly after?: (result: WriteResult) => void;
  } = {},
): OpsHost {
  const ops = w.service.ops;
  let ran = false;
  let answered = false;
  const wrap = <T extends object>(target: T, replace: (key: string | symbol) => unknown): T =>
    new Proxy(target, {
      get(object, key) {
        const own = replace(key);
        if (own !== undefined) return own;
        const value: unknown = Reflect.get(object, key, object);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(object)
          : value;
      },
    });
  return {
    ...ops,
    spaces: () =>
      ops.spaces().map((space) => {
        const { writer, reader } = space;
        if (writer === undefined || reader === undefined) return space;
        const submit = async (request: WriteRequest): Promise<WriteResult> => {
          if (!ran && options.before !== undefined && request.intent?.entry === options.entry) {
            ran = true;
            await options.before();
          }
          const result = await writer.submit(request);
          options.after?.(result);
          if (
            !answered &&
            options.committed !== undefined &&
            request.intent?.entry === options.entry
          ) {
            answered = true;
            await options.committed();
          }
          return result;
        };
        const broken = () => Promise.reject(new Error("Fixture: the read failed"));
        return {
          ...space,
          writer: wrap(writer, (key) => (key === "submit" ? submit : undefined)),
          reader: wrap(reader, (key) =>
            options.failing?.() === true && typeof key === "string" ? broken : undefined,
          ),
        };
      }),
  };
}

describe("[A3.answers.what-the-writer-did] an answer says what the writer did, not what the service expected", () => {
  test("a folder move whose child was moved elsewhere just before the write names it nowhere, first and on its retry", async () => {
    const old = folder("parent-before");
    const made = await call(
      "folder.manage",
      { action: "add_project", project: "Parent", folder: old, request_id: rid() },
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
        tasks: [{ title: "The child", folder: folder("parent-before", "child") }],
        request_id: rid(),
      },
      USER,
    );
    const child = (added["tasks"] as Json[])[0]?.["ref"] as string;
    renameSync(old, join(w.root, "work", "answers", "parent-after"));
    const set = {
      action: "set",
      project: owner.id,
      folder: join(w.root, "work", "answers", "parent-after"),
      base: await asOf(),
      request_id: rid(),
    };
    // The service decides to carry the child along; before the writer takes the request, an
    // agent's update_task gives the child a folder of its own elsewhere.
    const elsewhere = folder("child-elsewhere");
    const host = held({
      entry: "folder.manage",
      before: async () => {
        await call("task.update", {
          task: child,
          set: { folder: elsewhere },
          base: await asOf(),
          request_id: rid(),
        });
      },
    });
    const first = (await opCall(host, USER, { op: "folder.manage", input: set })) as Json;
    expect(first).toMatchObject({ result: "set" });
    expect(first["moved"]).toBeUndefined();
    expect(first["followed"]).toBeUndefined();
    const read = await call("task.get", { task: child }, USER);
    expect((read["task"] as { folder: { path: string } }).folder.path).toMatch(/child-elsewhere$/u);
    expect(await call("folder.manage", set, USER)).toEqual({ ...first, replayed: true });
  });

  test("a project renamed between organize's decision and its write is named once, as it is now", async () => {
    const made = await call(
      "group.manage",
      { action: "create", path: "Yard/Shed", request_id: rid() },
      USER,
    );
    const project = String((made["group"] as Json)["id"]);
    const move = {
      action: "move",
      path: project,
      to: "Garden",
      base: await asOf(),
      request_id: rid(),
    };
    const host = held({
      entry: "group.manage",
      before: async () => {
        await call(
          "group.manage",
          { action: "rename", path: project, to: "Tower", base: await asOf(), request_id: rid() },
          USER,
        );
      },
    });
    const moved = (await opCall(host, USER, { op: "group.manage", input: move })) as Json;
    expect(moved).toMatchObject({ result: "moved", group: { id: project, name: "Tower" } });
    const listed = ((moved["areas"] as Json[]).find((a) => a["name"] === "Garden")?.["projects"] ??
      []) as Json[];
    expect(listed.map((p) => p["name"])).toEqual(["Tower"]);
  });
});

describe("[A3.answers.read-fails] a read after the commit that fails leaves out names and lists, never what the write did", () => {
  let failing = false;
  let armed = false;
  /** The world's service, made once the world is. */
  let host: OpsHost | undefined;
  /** One call whose reads fail once its request has committed, then the same call again. */
  async function both(op: string, input: Json, caller: Caller = AGENT): Promise<[Json, Json]> {
    host ??= held({
      failing: () => failing,
      after: (result) => {
        if (armed && (result.status === "applied" || result.status === "unchanged")) failing = true;
      },
    });
    armed = true;
    try {
      const first = (await opCall(host, caller, { op, input })) as Json;
      return [first, await call(op, input, caller)];
    } finally {
      armed = false;
      failing = false;
    }
  }
  const asOfNow = /^[0-9]+\.[0-9]+\.[0-9a-z]+$/u;

  test("every write answers with what it did when the reads after its commit fail", async () => {
    // add_tasks: the tasks it made, without the titles it could not read.
    const [added, addedAgain] = await both("task.add", {
      tasks: [{ title: "Read fails one" }, { title: "Read fails two", log: "Fixture entry" }],
      request_id: rid(),
    });
    const tasks = added["tasks"] as Json[];
    expect(tasks.map((t) => [t["result"], typeof t["id"], typeof t["ref"], t["title"]])).toEqual([
      ["created", "string", "string", undefined],
      ["created", "string", "string", undefined],
    ]);
    expect(tasks[1]).toMatchObject({ log_added: true });
    expect((addedAgain["tasks"] as Json[]).map((t) => [t["id"], t["title"]])).toEqual([
      [tasks[0]?.["id"], "Read fails one"],
      [tasks[1]?.["id"], "Read fails two"],
    ]);
    const ref = String(tasks[0]?.["ref"]);
    const other = String(tasks[1]?.["ref"]);

    // update_task: the fields the writer changed, never the ones the call named.
    const [updated] = await both("task.update", {
      task: ref,
      set: { title: "Read fails one", summary: "Fixture summary" },
      base: await asOf(),
      request_id: rid(),
    });
    expect(updated).toMatchObject({ result: "updated", task: ref, fields: ["summary"] });

    // add_entry and remove_note.
    const [noted] = await both("entry.add", {
      task: ref,
      kind: "note",
      text: "Fixture note",
      request_id: rid(),
    });
    expect(noted).toMatchObject({ result: "logged", task: ref, entry: "n1", kind: "note" });
    const [removed] = await both(
      "note.remove",
      { task: ref, remove: "n1", base: await asOf(), request_id: rid() },
      USER,
    );
    expect(removed).toMatchObject({ result: "removed", task: ref, note: "n1" });

    // complete_task: how it left the task, and its follow-up by reference.
    const [finished, finishedAgain] = await both("task.finish", {
      task: ref,
      outcome: "Fixture outcome.",
      learnings: ["A fixture learning."],
      follow_ups: [{ title: "Read fails follow-up" }],
      base: await asOf(),
      request_id: rid(),
    });
    expect(finished).toMatchObject({
      result: "completed",
      task: ref,
      lifecycle: "completed",
      wrap_state: "wrapped",
      learnings: 1,
    });
    const follow = (finished["follow_ups"] as Json[])[0];
    expect(follow).toMatchObject({ result: "created" });
    expect(typeof follow?.["ref"]).toBe("string");
    expect(follow?.["title"]).toBeUndefined();
    expect((finishedAgain["follow_ups"] as Json[])[0]).toMatchObject({
      ref: follow?.["ref"],
      title: "Read fails follow-up",
    });

    // reopen_task: the status the reopen gave it.
    const [reopened] = await both("task.reopen", {
      task: ref,
      reason: "A fixture reason.",
      base: await asOf(),
      request_id: rid(),
    });
    expect(reopened).toMatchObject({ result: "reopened", task: ref, lifecycle: "active" });
    expect(typeof reopened["status"]).toBe("string");

    // delete_tasks.
    const [trashed] = await both(
      "task.delete",
      { tasks: [other], base: await asOf(), request_id: rid() },
      USER,
    );
    expect(trashed).toMatchObject({ result: "moved", moved: [other] });

    // undo and redo: the tasks the commit changed, from the writer.
    await call(
      "task.update",
      { task: ref, set: { summary: "To be undone" }, base: await asOf(), request_id: rid() },
      USER,
    );
    const [undone] = await both("history.undo", { request_id: rid() }, USER);
    expect(undone).toMatchObject({ result: "undone", tasks: [ref], task_count: 1 });
    const [redone] = await both("history.redo", { request_id: rid() }, USER);
    expect(redone).toMatchObject({ result: "redone", tasks: [ref], task_count: 1 });

    // organize: the group by kind and ID; its name, its area and the list are left out.
    const [created, createdAgain] = await both(
      "group.manage",
      { action: "create", path: "Read fails area/Read fails project", request_id: rid() },
      USER,
    );
    expect(created).toMatchObject({
      action: "create",
      result: "created",
      group: { kind: "project" },
    });
    expect((created["group"] as Json)["name"]).toBeUndefined();
    for (const part of ["areas", "projects", "total_areas", "total_projects"]) {
      expect(created[part], part).toBeUndefined();
    }
    expect(createdAgain).toMatchObject({
      group: { id: (created["group"] as Json)["id"], name: "Read fails project" },
      total_areas: expect.any(Number) as number,
    });

    // folder.manage: the project it made, by ID.
    const [owned] = await both(
      "folder.manage",
      {
        action: "add_project",
        project: "Read fails folder",
        folder: folder("read-fails"),
        request_id: rid(),
      },
      USER,
    );
    expect(owned).toMatchObject({ result: "created", owner: { kind: "project" } });
    expect(typeof (owned["owner"] as Json)["id"]).toBe("string");
    expect((owned["owner"] as Json)["name"]).toBeUndefined();

    // prefs: the change it made; the keys as they are now are left out.
    const key = "tasks.dedupe_window_days";
    const [set] = await both(
      "prefs.manage",
      { action: "set", set: [{ key, value: 9 }], base: await asOf(), request_id: rid() },
      USER,
    );
    expect(set).toMatchObject({ result: "updated", changed: [{ key, to: 9 }] });
    expect(set["prefs"]).toBeUndefined();
    for (const answer of [added, updated, noted, removed, finished, reopened, trashed, set]) {
      expect(answer["as_of"]).toMatch(asOfNow);
    }
  });
});

describe("[A3.answers.as-of] a write's answer is dated by its own commit, first and on every retry", () => {
  test("a retried create is no base for overwriting the summary a person gave the task since", async () => {
    const add = {
      tasks: [{ title: "Dated by its commit", summary: "The agent's summary" }],
      request_id: rid(),
    };
    const first = await call("task.add", add);
    const ref = String((first["tasks"] as Json[])[0]?.["ref"]);
    await call(
      "task.update",
      {
        task: ref,
        set: { summary: "The person's summary" },
        base: await asOf(),
        request_id: rid(),
      },
      USER,
    );
    const retry = await call("task.add", add);
    expect(retry["as_of"]).toBe(first["as_of"]);
    const update = {
      task: ref,
      set: { summary: "The agent's next summary" },
      base: retry["as_of"],
      request_id: rid(),
    };
    expect(await refusal("task.update", update)).toMatchObject({ code: "conflict" });
    const read = await call("task.get", { task: ref });
    expect((read["task"] as Json)["summary"]).toBe("The person's summary");
  });

  test("every write's first answer and its retry carry its commit's position, whatever was written in between", async () => {
    const bystander = String(
      (
        (await call("task.add", { tasks: [{ title: "Bystander" }], request_id: rid() }))[
          "tasks"
        ] as Json[]
      )[0]?.["ref"],
    );
    /** Another writer's change, which moves the space on. */
    const meanwhile = () =>
      call("entry.add", { task: bystander, text: "Fixture meanwhile", request_id: rid() });
    /**
     * A write whose answer waits, just after its commit, for another writer's change; then the same
     * request again after one more. Both answers must carry the position the commit left.
     */
    async function dated(op: string, input: Json, caller: Caller = AGENT): Promise<Json> {
      let commit = "";
      const host = held({
        entry: op,
        committed: async () => {
          commit = await asOf();
          await meanwhile();
        },
      });
      const first = (await opCall(host, caller, { op, input })) as Json;
      await meanwhile();
      const retry = await call(op, input, caller);
      expect(retry["replayed"], op).toBe(true);
      expect(first["as_of"], `${op}: its first answer`).toBe(commit);
      expect(retry["as_of"], `${op}: its retry`).toBe(commit);
      return first;
    }

    const added = await dated("task.add", {
      tasks: [{ title: "Dated one" }, { title: "Dated two" }],
      request_id: rid(),
    });
    const [ref, other] = (added["tasks"] as Json[]).map((t) => String(t["ref"]));
    await dated("task.update", {
      task: ref,
      set: { summary: "Dated summary" },
      base: await asOf(),
      request_id: rid(),
    });
    await dated("entry.add", { task: ref, kind: "note", text: "Dated note", request_id: rid() });
    await dated(
      "note.remove",
      { task: ref, remove: "n1", base: await asOf(), request_id: rid() },
      USER,
    );
    await dated("task.finish", {
      task: ref,
      outcome: "Fixture outcome.",
      follow_ups: [{ title: "Dated follow-up" }],
      base: await asOf(),
      request_id: rid(),
    });
    await dated("task.reopen", {
      task: ref,
      reason: "A fixture reason.",
      base: await asOf(),
      request_id: rid(),
    });
    await call(
      "task.update",
      { task: ref, set: { summary: "To be undone" }, base: await asOf(), request_id: rid() },
      USER,
    );
    await dated("history.undo", { request_id: rid() }, USER);
    await dated("history.redo", { request_id: rid() }, USER);
    await dated("task.delete", { tasks: [other], base: await asOf(), request_id: rid() }, USER);
    await dated(
      "group.manage",
      { action: "create", path: "Dated/Project", request_id: rid() },
      USER,
    );
    await dated(
      "folder.manage",
      {
        action: "add_project",
        project: "Dated folder",
        folder: folder("dated"),
        request_id: rid(),
      },
      USER,
    );
    await dated(
      "prefs.manage",
      {
        action: "set",
        set: [{ key: "tasks.dedupe_window_days", value: 11 }],
        base: await asOf(),
        request_id: rid(),
      },
      USER,
    );
  });
});

describe("[A3.answers.earlier-version] a request another version applied is answered as applied before, and nothing more", () => {
  /**
   * `id` sent again as each of `bodies`, while every read but the receipt's fails: the error each
   * got. Nothing is written: the space's position does not move.
   */
  async function sentAgain(
    caller: Caller,
    id: string,
    bodies: readonly { op: string; input: Json }[],
  ): Promise<ErrorBody[]> {
    const before = await asOf();
    const host = held({ failing: () => true });
    const answers: ErrorBody[] = [];
    for (const { op, input } of bodies) {
      const error = await opCall(host, caller, { op, input: { ...input, request_id: id } }).then(
        () => undefined,
        (e: unknown) => e,
      );
      if (!(error instanceof AppError)) throw new Error(`${op} was not answered as applied before`);
      answers.push(error.toBody());
    }
    expect(await asOf()).toBe(before);
    return answers;
  }

  async function added(title: string): Promise<{ id: Id<"t">; ref: string }> {
    const answer = await call("task.add", { tasks: [{ title }], request_id: rid() });
    const made = (answer["tasks"] as { id: Id<"t">; ref: string }[])[0];
    if (made === undefined) throw new Error("no task was added");
    return made;
  }

  test("every write's request an earlier version applied, sent again to its own tool or another, with a body that parses or not, gets one answer with the receipt's rows", async () => {
    const task = await added("Earlier version's task");
    const finished = await added("Earlier version's finished task");
    await call("task.finish", { task: finished.ref, base: await asOf(), request_id: rid() }, USER);
    const trashed = await added("Earlier version's trashed task");
    await call("entry.add", {
      task: task.ref,
      kind: "note",
      text: "Fixture note",
      request_id: rid(),
    });
    const area = newId("a");
    const project = newId("p");
    const cases: {
      caller: Caller;
      entry: string;
      input: Json;
      ops: WriteRequest["ops"];
      before?: () => Promise<unknown>;
    }[] = [
      {
        caller: AGENT,
        entry: "task.add",
        input: { tasks: [{ title: "Added earlier" }] },
        ops: [{ kind: "task.create", id: newId("t"), title: "Added earlier", inbox: true }],
      },
      {
        caller: AGENT,
        entry: "task.update",
        input: { task: task.ref, set: { summary: "Set earlier" } },
        ops: [{ kind: "task.patch", task: task.id, set: { summary: "Set earlier" } }],
      },
      {
        caller: AGENT,
        entry: "entry.add",
        input: { task: task.ref, text: "Logged earlier" },
        ops: [{ kind: "log.add", task: task.id, body: "Logged earlier" }],
      },
      {
        caller: USER,
        entry: "note.remove",
        input: { task: task.ref, remove: "n1" },
        ops: [{ kind: "note.delete", task: task.id, ordinal: 1 }],
      },
      {
        caller: AGENT,
        entry: "task.reopen",
        input: { task: finished.ref, reason: "Reopened earlier" },
        ops: [{ kind: "task.reopen", task: finished.id, reason: "Reopened earlier" }],
      },
      {
        caller: AGENT,
        entry: "task.finish",
        input: { task: finished.ref, outcome: "Finished earlier." },
        ops: [{ kind: "task.complete", task: finished.id, outcome: "Finished earlier." }],
      },
      {
        caller: USER,
        entry: "task.delete",
        input: { tasks: [trashed.ref] },
        ops: [{ kind: "task.delete", task: trashed.id }],
      },
      {
        caller: USER,
        entry: "history.undo",
        input: {},
        ops: [{ kind: "undo" }],
        before: async () =>
          call(
            "task.update",
            { task: task.ref, set: { summary: "To undo" }, base: await asOf(), request_id: rid() },
            USER,
          ),
      },
      { caller: USER, entry: "history.redo", input: {}, ops: [{ kind: "redo" }] },
      {
        caller: USER,
        entry: "group.manage",
        input: { action: "create", path: "Area made earlier" },
        ops: [{ kind: "area.create", id: area, title: "Area made earlier" }],
      },
      {
        caller: USER,
        entry: "folder.manage",
        input: {
          action: "add_project",
          project: "Project made earlier",
          folder: folder("earlier"),
        },
        ops: [
          { kind: "project.create", id: project, title: "Project made earlier" },
          { kind: "project.folder_set", project, path: folder("earlier") },
        ],
      },
      {
        caller: USER,
        entry: "prefs.manage",
        input: { action: "set", set: [{ key: "tasks.dedupe_window_days", value: 6 }] },
        ops: [{ kind: "pref.set", key: "tasks.dedupe_window_days", value: 6 }],
      },
    ];
    for (const c of cases) {
      await c.before?.();
      const id = await decidedBefore(c.caller, c);
      const other = c.entry === "task.reopen" ? "task.update" : "task.reopen";
      const bodies: { op: string; input: Json; parses: boolean }[] = [
        { op: c.entry, input: { ...c.input, base: await asOf() }, parses: true },
        { op: c.entry, input: { ...c.input, retired: "Fixture" }, parses: false },
        {
          op: other,
          input:
            other === "task.reopen"
              ? { task: task.ref, reason: "Fixture reason", base: await asOf() }
              : { task: task.ref, set: { summary: "Fixture summary" }, base: await asOf() },
          parses: true,
        },
        { op: other, input: { retired: "Fixture" }, parses: false },
      ];
      const audience = principalOf(c.caller.class, w.service.ops.machine.id).audience;
      for (const body of bodies) {
        const entry = findEntry(body.op);
        if (entry === undefined) throw new Error(`${body.op} is no entry`);
        // An undo or a redo takes no base: its body without one is the one that parses.
        const input = Object.hasOwn(entry.input.shape, "base")
          ? body.input
          : Object.fromEntries(Object.entries(body.input).filter(([k]) => k !== "base"));
        body.input = input;
        const parsed = parseInput(entry, audience, { ...input, request_id: id }).success;
        expect(parsed, `${c.entry} as ${body.op}`).toBe(body.parses);
      }
      const answers = await sentAgain(c.caller, id, bodies);
      const receipt = await call("receipt.get", { request: id }, c.caller);
      expect(receipt, c.entry).toMatchObject({ found: true, request: id, status: "applied" });
      for (const answer of answers) {
        expect(answer, c.entry).toEqual({
          code: "applied_earlier",
          message: expect.stringMatching(
            new RegExp(
              `^Another version of ${PRODUCT_NAME} applied this request before \\(.+\\): nothing was written now\\.$`,
              "u",
            ),
          ) as string,
          hint: "Do not send it again under a new request ID. Read the task for how it is now.",
          data: { request: id, receipt },
        });
      }
      const refs = (receipt["results"] as Json[]).flatMap((r) =>
        typeof r["ref"] === "string" ? [r["ref"]] : [],
      );
      for (const ref of refs) expect(answers[0]?.message, c.entry).toContain(ref);
    }
  });

  test("an update an earlier version applied, sent again while every read but its receipt fails, is answered as applied before with its task", async () => {
    const task = await added("Updated earlier, reads failing");
    const id = await decidedBefore(AGENT, {
      entry: "task.update",
      input: { task: task.ref, set: { summary: "Set earlier" }, clear: ["place"] },
      ops: [{ kind: "task.patch", task: task.id, set: { summary: "Set earlier" } }],
    });
    const [answer] = await sentAgain(AGENT, id, [
      {
        op: "task.update",
        input: { task: task.ref, set: { summary: "Set earlier" }, clear: ["place"] },
      },
    ]);
    expect(answer).toMatchObject({
      code: "applied_earlier",
      message: `Another version of ${PRODUCT_NAME} applied this request before (${task.ref}): nothing was written now.`,
      data: { request: id, receipt: { results: [{ status: "updated", ref: task.ref }] } },
    });
  });

  test("an update an earlier version applied that cleared a retired field's value says which task it changed and nothing about fields", async () => {
    const task = await added("Placed earlier");
    await decidedBefore(AGENT, {
      entry: "task.update",
      input: { task: task.ref, place: "Fixture place" },
      ops: [{ kind: "place.set", task: task.id, root: "work", path: "placed" }],
    });
    const input = { task: task.ref, set: { summary: "Set earlier" }, clear: ["place"] };
    const id = await decidedBefore(AGENT, {
      entry: "task.update",
      input,
      ops: [
        { kind: "task.patch", task: task.id, set: { summary: "Set earlier" } },
        { kind: "place.clear", task: task.id },
      ],
    });
    const [answer] = await sentAgain(AGENT, id, [{ op: "task.update", input }]);
    expect(answer?.code).toBe("applied_earlier");
    expect(Object.keys(answer?.data ?? {}).sort()).toEqual(["receipt", "request"]);
    expect(answer?.data?.["receipt"]).toEqual(await call("receipt.get", { request: id }));
    expect(JSON.stringify(answer)).not.toMatch(/"fields"|summary|place/u);
  });

  test("an organize request an earlier version applied that only made an area, sent to folder.manage with a body that cannot be compared, names that area and clears nothing", async () => {
    const area = newId("a");
    const id = await decidedBefore(USER, {
      entry: "group.manage",
      input: { action: "create", path: "Only an area" },
      ops: [{ kind: "area.create", id: area, title: "Only an area" }],
    });
    const [answer] = await sentAgain(USER, id, [
      {
        op: "folder.manage",
        input: { action: "clear", project: "Only an area", retired: "Fixture" },
      },
    ]);
    expect(answer).toMatchObject({
      code: "applied_earlier",
      message: `Another version of ${PRODUCT_NAME} applied this request before (${area}): nothing was written now.`,
      data: { request: id, receipt: { results: [{ status: "created", id: area }] } },
    });
    expect(JSON.stringify(answer)).not.toMatch(/clear/u);
  });

  test("a receipt whose stored result this version cannot read still says the request was applied before, with its request ID", () => {
    const receipt = {
      scope_id: "script:fixture",
      request_id: "fixture-answers-unread",
      fingerprint: "0".repeat(64),
      status: "applied",
      seq: 7,
      epoch: 1,
      incarnation: newId("ai"),
      at: 0,
      result: {
        status: "applied",
        as_of: "1.7.x",
        results: "not a list",
        conflicts: [],
        warnings: [],
      },
    } as unknown as Receipt;
    expect(appliedEarlier(receipt).toBody()).toEqual({
      code: "applied_earlier",
      message: `Another version of ${PRODUCT_NAME} applied this request before: nothing was written now.`,
      hint: "Do not send it again under a new request ID. Read the task for how it is now.",
      data: { request: "fixture-answers-unread" },
    });
  });

  test("a request a later version applied, whose record holds what this version reads and more, is answered as applied before too", async () => {
    const entry = findEntry("task.add");
    if (entry === undefined) throw new Error("task.add is no entry");
    const input = { tasks: [{ title: "Added by a later version" }] };
    const parsed = parseInput(entry, "agent", { ...input, request_id: "fixture-answers-parse" });
    if (!parsed.success) throw new Error("the later input does not parse");
    const task = newId("t");
    // The intent as this version parses it: without the version check, its fingerprint matches.
    const id = await decidedBefore(AGENT, {
      entry: "task.add",
      input: parsed.data,
      ops: [{ kind: "task.create", id: task, title: "Added by a later version", inbox: true }],
      record: { version: 2, entry: "task.add", paths: ["tasks.0"], made: [], later: { kept: 1 } },
    });
    const [answer] = await sentAgain(AGENT, id, [{ op: "task.add", input }]);
    expect(answer).toMatchObject({
      code: "applied_earlier",
      data: { request: id, receipt: { results: [{ status: "created", id: task }] } },
    });
    // The agent's text says it in two sentences, with the task's reference.
    const ref = String(((answer?.data?.["receipt"] as Json)["results"] as Json[])[0]?.["ref"]);
    if (answer === undefined) throw new Error("no answer");
    expect(renderError(answer)).toBe(
      `error applied_earlier: Another version of ${PRODUCT_NAME} applied this request before (${ref}): nothing was written now. Do not send it again under a new request ID. Read the task for how it is now.`,
    );
  });
});

describe("[A3.answers.retry-first] a request ID this version used holds it for that tool and that body", () => {
  test("a request ID used for one tool is another request for any other tool, whatever its body", async () => {
    const input = { tasks: [{ title: "Its tool's own" }], request_id: rid() };
    await call("task.add", input);
    const before = await asOf();
    for (const body of [{ request_id: input.request_id, reason: 7 }, input]) {
      expect(await refusal("task.reopen", body)).toMatchObject({
        code: "request_id_conflict",
        data: { field: "request_id" },
      });
    }
    expect(await asOf()).toBe(before);
  });

  test("a body that differs from the one its request ID was used for is refused as another request", async () => {
    const input = { tasks: [{ title: "First of its ID" }], request_id: rid() };
    await call("task.add", input);
    expect(
      await refusal("task.add", { ...input, tasks: [{ title: "Second under its ID" }] }),
    ).toMatchObject({ code: "request_id_conflict" });
  });
});

describe("[A3.answers.refusal-again] a refused request wrote nothing, and is decided again when sent again", () => {
  test("a refused batch sent again is refused at the same draft, and applies once the space takes it", async () => {
    const input = {
      tasks: [
        { title: "Makes a group", area: "Refused area", project: "Refused project" },
        { title: "Sized wrongly", effort: "Enormous" },
        { title: "Fine as it is" },
        { title: "Fine as well" },
      ],
      request_id: rid(),
    };
    const first = await refusal("task.add", input);
    expect(first).toMatchObject({ data: { issues: [{ path: "tasks.1.effort" }] } });
    const again = await refusal("task.add", input);
    expect(again).toEqual(first);
    expect(await groupNames()).not.toContain("Refused area");
    const scale = (
      await call("prefs.manage", { action: "get", keys: ["tasks.effort_scale"] }, USER)
    )["prefs"] as { value: string[] }[];
    await call(
      "prefs.manage",
      {
        action: "set",
        set: [{ key: "tasks.effort_scale", value: [...(scale[0]?.value ?? []), "Enormous"] }],
        base: await asOf(),
        request_id: rid(),
      },
      USER,
    );
    const applied = await call("task.add", input);
    expect((applied["tasks"] as Json[]).map((t) => t["result"])).toEqual([
      "created",
      "created",
      "created",
      "created",
    ]);
    expect(applied["replayed"]).toBeUndefined();
    expect(await groupNames()).toContain("Refused area");
    expect(await call("task.add", input)).toMatchObject({ replayed: true });
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
