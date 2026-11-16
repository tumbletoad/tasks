// Folders through the request path of a running service, over real tasks-local/1 sessions: a
// project made for a folder in one change, its folder changed with its task's folder moving
// along, the undo and redo of that change, an agent's project created by name, and the checks at
// bind: a folder inside Tasks' own data, a folder that is not there, and a folder another project
// has; and a retry that replays after a rename. The folders are temporary ones of this test.
// Fixture text only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FolderManageResult, HistoryUndoResult, TaskAddResult } from "@tasks/contracts";
import type { RpcSession } from "@tasks/bridge/protocol";
import { startService, type RunningService } from "../src/hub/service.ts";
import { readFolders, readLaunchFolder } from "../src/ops/read.ts";
import { classSession, errorOf, type CliClass } from "./ops-helpers.ts";
import { removeRuntimeDir, serviceEnv, tempRoot } from "./harness.ts";

let service: RunningService;
let home: string;
let root: string;
let cleanup: () => void;
let space: string;
const sessions: RpcSession[] = [];

const session = async (cls: CliClass, env: Record<string, string> = {}): Promise<RpcSession> => {
  const opened = await classSession(home, service.endpoint.path, cls, env);
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
const rid = () => `fixture-folders-${String((n += 1)).padStart(6, "0")}`;

const asOf = async (s: RpcSession): Promise<string> =>
  ((await call(s, "space.status", {})) as { as_of: string }).as_of;

/** A folder of this test, made with its parents. */
function folder(...parts: string[]): string {
  const path = join(root, "work", ...parts);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

const reader = () => {
  const served = service.ops.spaces().find((s) => s.id === space);
  if (served?.reader === undefined) throw new Error("the space is not served");
  return served.reader;
};

beforeAll(async () => {
  const temp = tempRoot("folders");
  cleanup = temp.cleanup;
  root = temp.root;
  home = join(temp.root, "h");
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  const user = await session("cli-interactive");
  const created = (await user.call(
    "space/create",
    { name: "Mira", path: join(temp.root, "spaces", "mira"), ref_prefix: "M" },
    { timeoutMs: 60_000 },
  )) as { space: { state: string; id: string } };
  expect(created.space.state).toBe("open");
  space = created.space.id;
}, 120_000);

afterAll(async () => {
  for (const s of sessions) s.close();
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
}, 60_000);

describe("[A1.3.15.folders.request-path] folders through the request path of a running service", () => {
  test("a project made for a folder, its folder changed with its task's inside it, then undone and redone", async () => {
    const user = await session("cli-interactive");
    const portal = folder("portal");
    const web = folder("portal", "web");
    const moved = folder("portal2");
    const added = FolderManageResult.parse(
      await call(user, "folder.manage", {
        action: "add_project",
        project: "Portal",
        area: "Client work",
        folder: portal,
        request_id: rid(),
      }),
    );
    expect(added).toMatchObject({ result: "created", owner: { kind: "project", name: "Portal" } });
    expect(added.folder?.endsWith(`${sep}portal`)).toBe(true);
    const project = added.owner.id;
    // The project and its folder are one change: one undo would take both.
    const [task] = TaskAddResult.parse(
      await call(user, "task.add", {
        tasks: [{ title: "Fix the header", area: "Client work", project: "Portal" }],
        request_id: rid(),
      }),
    ).tasks;
    const ref = task?.ref ?? "";
    const own = FolderManageResult.parse(
      await call(user, "folder.manage", {
        action: "set",
        task: ref,
        folder: web,
        request_id: rid(),
      }),
    );
    expect(own).toMatchObject({ result: "set", owner: { kind: "task", ref } });
    const taskId = own.owner.id;
    const machine = service.ops.machine.id;
    expect(await readLaunchFolder(reader(), taskId, machine)).toMatchObject({
      kind: "task",
      folder: { path: own.folder },
    });

    // The project's folder moves, and the task's folder inside the old one moves with it.
    const changed = FolderManageResult.parse(
      await call(user, "folder.manage", {
        action: "set",
        project: "Client work/Portal",
        folder: moved,
        base: await asOf(user),
        request_id: rid(),
      }),
    );
    expect(changed).toMatchObject({ result: "set", moved: 1 });
    const after = await readLaunchFolder(reader(), taskId, machine);
    expect(after.kind === "task" && after.folder.path).toBe(
      `${changed.folder ?? ""}${changed.folder?.includes("\\") === true ? "\\" : "/"}web`,
    );
    expect((await readFolders(reader(), "project", project)).map((f) => f.path)).toEqual([
      changed.folder,
    ]);

    // One undo puts both back; the redo moves both again.
    HistoryUndoResult.parse(await call(user, "history.undo", { request_id: rid() }));
    expect((await readFolders(reader(), "project", project)).map((f) => f.path)).toEqual([
      added.folder,
    ]);
    expect(await readLaunchFolder(reader(), taskId, machine)).toMatchObject({
      folder: { path: own.folder },
    });
    await call(user, "history.redo", { request_id: rid() });
    expect((await readFolders(reader(), "project", project)).map((f) => f.path)).toEqual([
      changed.folder,
    ]);

    // Adding a folder that a project has already answers that project, and makes none.
    const again = FolderManageResult.parse(
      await call(user, "folder.manage", {
        action: "add_project",
        project: "Portal again",
        folder: moved,
        request_id: rid(),
      }),
    );
    expect(again).toMatchObject({ result: "exists", owner: { id: project, name: "Portal" } });
    // Setting it on another project is refused, naming the project that has it.
    const other = FolderManageResult.parse(
      await call(user, "folder.manage", {
        action: "add_project",
        project: "Docs",
        folder: folder("docs"),
        request_id: rid(),
      }),
    );
    const taken = await refused(
      call(user, "folder.manage", {
        action: "set",
        project: other.owner.id,
        folder: moved,
        base: await asOf(user),
        request_id: rid(),
      }),
    );
    expect(taken).toMatchObject({
      code: "conflict",
      data: { reason: "folder_taken", project: { id: project, name: "Portal" } },
    });
    // A project's folder is cleared on this machine; the task keeps its own.
    expect(
      FolderManageResult.parse(
        await call(user, "folder.manage", {
          action: "clear",
          project: project,
          base: await asOf(user),
          request_id: rid(),
        }),
      ),
    ).toMatchObject({ result: "cleared" });
    expect(await readLaunchFolder(reader(), taskId, machine)).toMatchObject({ kind: "task" });
  });

  test("a folder inside Tasks' own data, one that is not there, and a file are refused, and nothing is written", async () => {
    const user = await session("cli-interactive");
    const before = await asOf(user);
    const at = (path: string) =>
      refused(
        call(user, "folder.manage", {
          action: "add_project",
          project: "Not here",
          folder: path,
          request_id: rid(),
        }),
      );
    // The Tasks home of this service, a folder inside it, and the space's own folder.
    expect(await at(home)).toMatchObject({
      code: "invalid_input",
      data: { reason: "folder_reserved" },
    });
    expect(await at(join(home, "state"))).toMatchObject({ data: { reason: "folder_reserved" } });
    expect(await at(join(root, "spaces", "mira"))).toMatchObject({
      data: { reason: "folder_reserved" },
    });
    expect(await at(join(root, "work", "nowhere"))).toMatchObject({
      data: { reason: "folder_missing" },
    });
    const file = join(folder("files"), "notes.txt");
    writeFileSync(file, "fixture", { mode: 0o600 });
    expect(await at(file)).toMatchObject({ data: { reason: "not_a_directory" } });
    expect(await at("relative/folder")).toMatchObject({ data: { reason: "not_absolute" } });
    expect(await asOf(user)).toBe(before);
  });

  test("a retry of a folder set replays after the project was renamed in between", async () => {
    const user = await session("cli-interactive");
    const made = FolderManageResult.parse(
      await call(user, "folder.manage", {
        action: "add_project",
        project: "Old name",
        area: "Client work",
        folder: folder("replayed"),
        request_id: rid(),
      }),
    );
    const input = {
      action: "set",
      project: "Client work/Old name",
      folder: folder("replayed2"),
      base: await asOf(user),
      request_id: rid(),
    };
    const first = FolderManageResult.parse(await call(user, "folder.manage", input));
    expect(first).toMatchObject({ result: "set", owner: { id: made.owner.id } });
    await call(user, "group.manage", {
      action: "rename",
      path: "Client work/Old name",
      to: "Renamed",
      base: await asOf(user),
      request_id: rid(),
    });
    const retry = FolderManageResult.parse(await call(user, "folder.manage", input));
    expect(retry).toMatchObject({
      result: "set",
      replayed: true,
      owner: { kind: "project", id: made.owner.id, name: "Renamed" },
      folder: first.folder,
    });
  });

  test("an agent files a task into a project it names first, which is created with it", async () => {
    const agent = await session("cli-agent", { TASKS_SPACE: space });
    const added = TaskAddResult.parse(
      await call(agent, "task.add", {
        tasks: [{ title: "Draft the release notes", area: "Releases", project: "Spring release" }],
        request_id: rid(),
      }),
    );
    expect(added.tasks[0]?.result).toBe("created");
    const user = await session("cli-interactive");
    const listed = (await call(user, "group.manage", { action: "list" })) as {
      areas: { name: string; projects: { name: string; active: number }[] }[];
    };
    expect(listed.areas.find((a) => a.name === "Releases")?.projects).toEqual([
      expect.objectContaining({ name: "Spring release", active: 1 }),
    ]);
  });
});
