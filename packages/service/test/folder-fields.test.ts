// The folder fields of the agent's tools through the request path of a running service, over real
// ttasks-local/1 sessions: an agent's connection that names its working folder adds tasks with
// folder "cwd" and they land in the project whose folder holds it; organize makes a project with
// its folder, sets and clears one, and answers with the project that has a folder already; the
// digest names a task's folder; search finds tasks by folder; and the refusals of a folder the
// service cannot take name their reason and a way on. Temporary folders and fixture text only.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  GroupListResult,
  HistoryUndoResult,
  TaskAddResult,
  TaskFinishResult,
  TaskGetResult,
  TaskSearchResult,
  TaskUpdateResult,
} from "@ttasks/contracts";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { startService, type RunningService } from "../src/hub/service.ts";
import { classSession, errorOf, type CliClass } from "./ops-helpers.ts";
import { removeRuntimeDir, serviceEnv, tempRoot } from "./harness.ts";

let service: RunningService;
let home: string;
let root: string;
let cleanup: () => void;
let user: RpcSession;
let agent: RpcSession;
const sessions: RpcSession[] = [];

const session = async (cls: CliClass): Promise<RpcSession> => {
  const opened = await classSession(home, service.endpoint.path, cls);
  sessions.push(opened);
  return opened;
};

const call = (s: RpcSession, op: string, input: Record<string, unknown>) =>
  s.call("op/call", { op, input }, { timeoutMs: 30_000 });

async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return errorOf(error);
  }
  throw new Error("expected a refusal");
}

let n = 0;
const rid = () => `fixture-fields-${String((n += 1)).padStart(6, "0")}`;

const asOf = async (): Promise<string> =>
  ((await call(user, "space.status", {})) as { as_of: string }).as_of;

/** A folder of this test, made with its parents. */
function folder(...parts: string[]): string {
  const path = join(root, "work", ...parts);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** The project and the folder the digest of `ref` names. */
async function filed(ref: string): Promise<{ project?: string; folder?: unknown }> {
  const read = TaskGetResult.parse(await call(user, "task.get", { task: ref }));
  if (read.view !== "digest") throw new Error("expected a digest");
  return {
    ...(read.task.project === undefined ? {} : { project: read.task.project }),
    ...(read.task.folder === undefined ? {} : { folder: read.task.folder }),
  };
}

/** One task an agent adds from `cwd` with folder "cwd". */
async function addHere(title: string, cwd: string) {
  return TaskAddResult.parse(
    await call(agent, "task.add", {
      tasks: [{ title, folder: "cwd" }],
      cwd,
      request_id: rid(),
    }),
  );
}

const ends = (tail: string): unknown => expect.stringMatching(new RegExp(`${tail}$`, "u"));

beforeAll(async () => {
  const temp = tempRoot("fields");
  cleanup = temp.cleanup;
  root = temp.root;
  home = join(temp.root, "h");
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  user = await session("cli-interactive");
  agent = await session("cli-script");
  await user.call(
    "space/create",
    { name: "Mira", path: join(temp.root, "spaces", "mira"), ref_prefix: "M" },
    { timeoutMs: 60_000 },
  );
  // Two projects, one nested in the other's folder, made by the agent with their folders.
  for (const [path, at] of [
    ["Client work/Portal", folder("portal")],
    ["Client work/Portal web", folder("portal", "web")],
  ] as const) {
    const made = GroupListResult.parse(
      await call(agent, "group.manage", { action: "create", path, folder: at, request_id: rid() }),
    );
    expect(made).toMatchObject({ result: "created", group: { kind: "project", folder: ends("") } });
  }
}, 120_000);

afterAll(async () => {
  for (const s of sessions) s.close();
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
}, 60_000);

describe("[A3.3.4.folders.agent] an agent's task in the folder it works in", () => {
  test("a task from a project's subfolder lands in the deepest project whose folder holds it, with its own folder", async () => {
    const added = await addHere("Fixture api task", folder("portal", "api", "src"));
    expect(added.tasks[0]).toMatchObject({ result: "created" });
    expect(await filed(added.tasks[0]?.ref ?? "")).toEqual({
      project: "Portal",
      folder: { path: ends(["portal", "api", "src"].join("[\\\\/]")), of: "task" },
    });
    const nested = await addHere("Fixture web task", folder("portal", "web", "app"));
    expect((await filed(nested.tasks[0]?.ref ?? "")).project).toBe("Portal web");
  });

  test("a task from the project's folder itself takes the project's folder, none of its own", async () => {
    const added = await addHere("Fixture portal task", folder("portal"));
    expect(await filed(added.tasks[0]?.ref ?? "")).toEqual({
      project: "Portal",
      folder: { path: ends("portal"), of: "project" },
    });
  });

  test("a task from outside every project's folder has no project and its own folder", async () => {
    const added = await addHere("Fixture loose task", folder("elsewhere"));
    expect(added.warnings).toEqual([]);
    expect(await filed(added.tasks[0]?.ref ?? "")).toEqual({
      folder: { path: ends("elsewhere"), of: "task" },
    });
  });

  test("a task from an archived project's folder has no project, its own folder and a warning", async () => {
    await call(agent, "group.manage", {
      action: "create",
      path: "Client work/Old site",
      folder: folder("old-site"),
      request_id: rid(),
    });
    await call(agent, "group.manage", {
      action: "archive",
      path: "Client work/Old site",
      base: await asOf(),
      request_id: rid(),
    });
    const added = await addHere("Fixture old task", folder("old-site", "pages"));
    expect(added.warnings).toEqual([expect.stringContaining("archived project")]);
    expect(added.warnings[0]?.startsWith("tasks.0.folder:")).toBe(true);
    expect(await filed(added.tasks[0]?.ref ?? "")).toEqual({
      folder: { path: ends("pages"), of: "task" },
    });

    // A follow-up from the same folder says so too.
    const read = TaskGetResult.parse(
      await call(user, "task.get", { task: added.tasks[0]?.ref ?? "" }),
    );
    const done = TaskFinishResult.parse(
      await call(agent, "task.finish", {
        task: added.tasks[0]?.ref ?? "",
        outcome: "Fixture outcome.",
        library: "nothing reusable",
        follow_ups: [{ title: "Fixture old follow-up", folder: "cwd" }],
        cwd: folder("old-site", "pages"),
        base: read.as_of,
        request_id: rid(),
      }),
    );
    expect(done.warnings).toEqual([expect.stringMatching(/^follow_ups\.0\.folder:.*archived/u)]);
    expect((await filed(done.follow_ups[0]?.ref ?? "")).project).toBeUndefined();
  });

  test("a draft that names its group keeps it, and its folder", async () => {
    const added = TaskAddResult.parse(
      await call(agent, "task.add", {
        tasks: [{ title: "Fixture named task", area: "Errands", folder: "cwd" }],
        cwd: folder("portal", "docs"),
        request_id: rid(),
      }),
    );
    expect(await filed(added.tasks[0]?.ref ?? "")).toEqual({
      folder: { path: ends("docs"), of: "task" },
    });
  });

  test("a follow-up with folder cwd lands in the project of the folder too", async () => {
    const [first] = (await addHere("Fixture finished task", folder("portal"))).tasks;
    const read = TaskGetResult.parse(await call(user, "task.get", { task: first?.ref ?? "" }));
    const done = (await call(agent, "task.finish", {
      task: first?.ref ?? "",
      outcome: "Fixture outcome.",
      follow_ups: [{ title: "Fixture follow-up", folder: "cwd" }],
      cwd: folder("portal", "web"),
      base: read.as_of,
      request_id: rid(),
    })) as { follow_ups: { ref: string }[] };
    expect(await filed(done.follow_ups[0]?.ref ?? "")).toEqual({
      project: "Portal web",
      folder: { path: ends("web"), of: "project" },
    });
  });

  test("a retry replays after its folder has gone, and a new request is refused", async () => {
    const gone = folder("going");
    const request = { tasks: [{ title: "Fixture going task", folder: gone }], request_id: rid() };
    const first = TaskAddResult.parse(await call(agent, "task.add", request));
    rmSync(gone, { recursive: true });
    expect(TaskAddResult.parse(await call(agent, "task.add", request))).toEqual({
      ...first,
      replayed: true,
    });
    expect(await refused(call(agent, "task.add", { ...request, request_id: rid() }))).toMatchObject(
      { code: "invalid_input", data: { reason: "folder_missing" } },
    );
  });
});

describe("[A3.3.4.folders.agent] organize's folders and the refusals", () => {
  test("an agent sets a project's folder to cwd, it is listed, and the agent clears it", async () => {
    const at = folder("billing");
    await call(agent, "group.manage", {
      action: "create",
      path: "Client work/Billing",
      request_id: rid(),
    });
    const set = GroupListResult.parse(
      await call(agent, "group.manage", {
        action: "set_folder",
        path: "Client work/Billing",
        folder: "cwd",
        cwd: at,
        base: await asOf(),
        request_id: rid(),
      }),
    );
    expect(set).toMatchObject({
      result: "folder_set",
      group: { kind: "project", name: "Billing", folder: ends("billing") },
    });
    const listed = GroupListResult.parse(await call(agent, "group.manage", { action: "list" }));
    const billing = listed.areas.flatMap((a) => a.projects).find((p) => p.name === "Billing");
    expect(billing?.folder).toEqual(ends("billing"));
    const cleared = GroupListResult.parse(
      await call(agent, "group.manage", {
        action: "clear_folder",
        path: "Client work/Billing",
        base: await asOf(),
        request_id: rid(),
      }),
    );
    expect(cleared).toMatchObject({ result: "folder_cleared" });
    const after = GroupListResult.parse(await call(agent, "group.manage", { action: "list" }));
    expect(
      after.areas.flatMap((a) => a.projects).find((p) => p.name === "Billing")?.folder,
    ).toBeUndefined();
  });

  test("the person's set_folder is one undo step", async () => {
    const at = folder("ledger");
    await call(user, "group.manage", {
      action: "create",
      path: "Client work/Ledger",
      request_id: rid(),
    });
    const projectFolder = async () =>
      GroupListResult.parse(await call(user, "group.manage", { action: "list" }))
        .areas.flatMap((a) => a.projects)
        .find((p) => p.name === "Ledger")?.folder;
    await call(user, "group.manage", {
      action: "set_folder",
      path: "Client work/Ledger",
      folder: at,
      base: await asOf(),
      request_id: rid(),
    });
    expect(await projectFolder()).toEqual(ends("ledger"));
    HistoryUndoResult.parse(await call(user, "history.undo", { request_id: rid() }));
    expect(await projectFolder()).toBeUndefined();
  });

  test("creating a project with a folder another project has makes it on that folder and names the other", async () => {
    const answer = GroupListResult.parse(
      await call(agent, "group.manage", {
        action: "create",
        path: "Client work/Portal again",
        folder: folder("portal"),
        request_id: rid(),
      }),
    );
    expect(answer).toMatchObject({
      result: "created",
      group: { kind: "project", name: "Portal again", folder: ends("portal") },
      also: [{ name: "Portal" }],
    });
  });

  test("creating with an area and a folder makes a project in the area named after the folder", async () => {
    const made = GroupListResult.parse(
      await call(agent, "group.manage", {
        action: "create",
        path: "Errands",
        folder: folder("garden-planner"),
        request_id: rid(),
      }),
    );
    expect(made).toMatchObject({
      result: "created",
      group: { kind: "project", name: "garden-planner", folder: ends("garden-planner") },
    });
    const errands = made.areas.find((a) => a.name === "Errands");
    expect(errands?.projects.map((p) => p.name)).toContain("garden-planner");
  });

  test("cwd without a working folder, a folder that is not there and a file are refused with their reason", async () => {
    const noCwd = await refused(
      call(agent, "group.manage", {
        action: "set_folder",
        path: "Client work/Portal",
        folder: "cwd",
        base: await asOf(),
        request_id: rid(),
      }),
    );
    expect(noCwd).toMatchObject({
      code: "invalid_input",
      data: { reason: "no_cwd", issues: [{ path: "cwd" }] },
    });
    expect(noCwd.hint).toContain("cwd");
    const missing = await refused(
      call(agent, "group.manage", {
        action: "create",
        path: "Client work/Nowhere",
        folder: join(root, "work", "not-there"),
        request_id: rid(),
      }),
    );
    expect(missing).toMatchObject({
      code: "invalid_input",
      data: { reason: "folder_missing", issues: [{ path: "folder" }] },
    });
    expect(missing.hint).toBe("Make the folder first, then name it.");
    const noTaskCwd = await refused(
      call(agent, "task.update", {
        task: "M-1",
        set: { folder: "cwd" },
        base: await asOf(),
        request_id: rid(),
      }),
    );
    expect(noTaskCwd).toMatchObject({ code: "invalid_input", data: { reason: "no_cwd" } });
    const file = join(folder("files"), "notes.txt");
    writeFileSync(file, "fixture");
    expect(
      await refused(
        call(agent, "task.add", {
          tasks: [{ title: "Fixture in a file", folder: file }],
          request_id: rid(),
        }),
      ),
    ).toMatchObject({
      code: "invalid_input",
      data: { reason: "not_a_directory", issues: [{ path: "tasks.0.folder" }] },
    });
    expect(
      await refused(
        call(agent, "task.add", {
          tasks: [{ title: "Fixture in the home", folder: home }],
          request_id: rid(),
        }),
      ),
    ).toMatchObject({ code: "invalid_input", data: { reason: "folder_reserved" } });
    // Nothing was made for the refused project.
    const listed = GroupListResult.parse(await call(agent, "group.manage", { action: "list" }));
    expect(JSON.stringify(listed)).not.toContain("Nowhere");
  });
});

describe("[A3.3.4.folders.agent] search by folder", () => {
  test("has:folder finds tasks with a folder of their own or their project's; folder: those in one", async () => {
    const search = async (q: string, cwd?: string) =>
      TaskSearchResult.parse(
        await call(agent, "task.search", { q, ...(cwd === undefined ? {} : { cwd }) }),
      ).rows.map((row) => ("title" in row ? row.title : ""));
    const plain = TaskAddResult.parse(
      await call(agent, "task.add", {
        tasks: [{ title: "Fixture task without folder" }],
        request_id: rid(),
      }),
    );
    expect(plain.tasks[0]?.result).toBe("created");
    const withFolder = await search("has:folder");
    expect(withFolder).toContain("Fixture api task");
    expect(withFolder).toContain("Fixture portal task");
    expect(withFolder).not.toContain("Fixture task without folder");
    expect(await search("-has:folder")).toContain("Fixture task without folder");
    // Inside the portal's folder: its project's tasks and those with a folder inside it.
    const inPortal = await search(`folder:"${folder("portal")}"`);
    expect(inPortal).toEqual(expect.arrayContaining(["Fixture api task", "Fixture portal task"]));
    expect(inPortal).not.toContain("Fixture loose task");
    expect(await search("folder:cwd", folder("elsewhere"))).toEqual(["Fixture loose task"]);
    expect(await refused(call(agent, "task.search", { q: "folder:cwd" }))).toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("[A3.3.4.folders.agent] names an earlier draft makes, and where a refusal points", () => {
  test("a group an earlier draft makes is known by its slug too", async () => {
    const added = TaskAddResult.parse(
      await call(agent, "task.add", {
        tasks: [
          { title: "Fixture garden task", area: "Garden work" },
          { title: "Fixture garden task two", area: "garden-work" },
        ],
        request_id: rid(),
      }),
    );
    expect(added.tasks.map((t) => t.result)).toEqual(["created", "created"]);
    const listed = GroupListResult.parse(await call(agent, "group.manage", { action: "list" }));
    const garden = listed.areas.filter((a) => a.name === "Garden work");
    expect(garden).toHaveLength(1);
    expect(garden[0]?.active).toBe(2);
  });

  test("a refusal's op counts the call's own operations, not the groups it creates", async () => {
    const error = await refused(
      call(agent, "task.add", {
        tasks: [
          { title: "Fixture first", area: "Fresh area for the index" },
          { title: "Fixture second", status: "no-such-status" },
        ],
        request_id: rid(),
      }),
    );
    // The second draft's task.create is the call's operation 1, whatever the area's create adds.
    expect(error.data?.["op"]).toBe(1);
  });
});

describe("[A3.3.4.folders.agent] update_task's folder", () => {
  test("a task's folder is set from cwd and the result names the field", async () => {
    const [task] = (await addHere("Fixture moving task", folder("elsewhere"))).tasks;
    const updated = TaskUpdateResult.parse(
      await call(agent, "task.update", {
        task: task?.ref ?? "",
        set: { folder: "cwd" },
        cwd: folder("elsewhere", "deeper"),
        base: await asOf(),
        request_id: rid(),
      }),
    );
    expect(updated).toMatchObject({ result: "updated", fields: ["folder"] });
    expect((await filed(task?.ref ?? "")).folder).toEqual({ path: ends("deeper"), of: "task" });
  });

  test("a task's folder moved on disk takes another task's folder inside it along, and says so", async () => {
    const [outer] = (await addHere("Fixture outer task", folder("moving"))).tasks;
    const [inner] = (await addHere("Fixture inner task", folder("moving", "inner"))).tasks;
    renameSync(join(root, "work", "moving"), join(root, "work", "moved"));
    const updated = TaskUpdateResult.parse(
      await call(agent, "task.update", {
        task: outer?.ref ?? "",
        set: { folder: join(root, "work", "moved") },
        base: await asOf(),
        request_id: rid(),
      }),
    );
    // The answer names the task whose folder followed, and where it is now.
    expect(updated).toMatchObject({ moved: 1, followed: [{ kind: "task", ref: inner?.ref }] });
    expect((await filed(inner?.ref ?? "")).folder).toEqual({
      path: ends(`moved\\${sep}inner`),
      of: "task",
    });
  });
});
