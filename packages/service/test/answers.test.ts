// What an agent is told about its write is what happened: a retry with the same request ID gets
// the answer the first call got, also for a write that changed nothing. A service in this process,
// fixture text and temporary folders only.
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { opCall, type Caller } from "../src/ops/index.ts";
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
