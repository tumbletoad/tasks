// Folders through the write path (schema 0.5): a project's and a task's folder on the request's
// machine, the same-folder rule for live projects, the move of a project's task folders with its
// own, a project's delete and restore with its folders, undo and redo of each, the form a path
// must have on its machine, and the folder a launch would use. Fixture text and fixture paths
// only, in a temporary space: no folder named here is looked at.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import {
  folderKey,
  folderProblem,
  isFolderForm,
  launchFolder,
  rebased,
} from "../src/write/folders.ts";
import type { Credential, Operation, WriteRequest, WriteResult } from "../src/write/request.ts";
import { openSpace } from "../src/space.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, type Fixture, fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("folders");
/** The fixture space, made once and copied for each test. */
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

let fx: Fixture;
beforeEach(async () => {
  fx = await fixture();
});
afterEach(() => {
  checkHistory(fx.reader);
  fx.close();
});

function submit(
  ops: Operation[],
  actor: Credential = fx.human,
  extra: Partial<WriteRequest> = {},
): WriteResult {
  return fx.writer.submit(
    fx.request(actor, ops, {
      base: fx.base(),
      ...(actor.actor_kind === "human" ? { undoable: true } : {}),
      ...extra,
    }),
  );
}

const undo = (partial = false): WriteResult =>
  fx.writer.submit(fx.request(fx.human, [{ kind: "undo", ...(partial ? { partial } : {}) }]));
const redo = (): WriteResult => fx.writer.submit(fx.request(fx.human, [{ kind: "redo" }]));

/** The live folders of every owner, as `kind:owner -> path`. */
function live(): Record<string, string> {
  return Object.fromEntries(
    fx.reader
      .prepare(
        "SELECT owner_kind, owner_id, path FROM folders WHERE deleted_at IS NULL ORDER BY owner_id",
      )
      .all<{ owner_kind: string; owner_id: string; path: string }>()
      .map((r) => [`${r.owner_kind}:${r.owner_id}`, r.path]),
  );
}

function newProject(title: string, path?: string): Id<"p"> {
  const id = newId("p");
  const result = submit([
    { kind: "project.create", id, title, area: "lumen" },
    ...(path === undefined ? [] : [{ kind: "project.folder_set" as const, project: id, path }]),
  ]);
  expectStatus(result, "applied");
  return id;
}

function newTask(title: string, project?: string, path?: string): Id<"t"> {
  const id = newId("t");
  const result = submit([
    { kind: "task.create", id, title, ...(project === undefined ? {} : { project }) },
    ...(path === undefined ? [] : [{ kind: "task.folder_set" as const, task: id, path }]),
  ]);
  expectStatus(result, "applied");
  return id;
}

describe("[A1.5.write.folders] a project's and a task's folder through the write path", () => {
  test("a project created with its folder is one commit and one undo step; the path is stored exactly as sent", () => {
    // A decomposed é (e and U+0301): the writer's text normalisation would make it another folder.
    const decomposed = "~/work/cafe\u0301";
    const id = newProject("Café", decomposed);
    expect(live()).toEqual({ [`project:${id}`]: decomposed });
    const commit = fx.reader
      .prepare("SELECT ops FROM commits ORDER BY seq DESC LIMIT 1")
      .get<{ ops: string }>();
    const ops = JSON.parse(commit?.ops ?? "[]") as { input: { path?: string } }[];
    expect(ops[1]?.input.path).toBe(decomposed);
    expectStatus(undo(), "applied");
    expect(live()).toEqual({});
    expect(
      fx.reader.prepare("SELECT deleted_at FROM projects WHERE id = $id").get({ id }),
    ).not.toEqual({ deleted_at: null });
    expectStatus(redo(), "applied");
    expect(live()).toEqual({ [`project:${id}`]: decomposed });
  });

  test("a moved folder needs a base and carries every folder inside it, other projects' and their tasks' too, as one undo step", () => {
    const project = newProject("Portal two", "~/work/portal");
    const inside = newTask("Header", project, "~/work/portal/web/header");
    const same = newTask("Root", project, "~/work/portal");
    const outside = newTask("Docs", project, "~/work/portal-docs");
    const loose = newTask("Not in the project", undefined, "~/work/portal/other");
    const nested = newProject("Portal api", "~/work/portal/api");
    const nestedTask = newTask("Api task", nested, "~/work/portal/api/v2");
    const before = live();
    const unbased = fx.writer.submit(
      fx.request(fx.human, [
        { kind: "project.folder_set", project, path: "~/Code/portal", carry: true },
      ]),
    );
    expect(unbased.error?.code).toBe("BASE_REQUIRED");
    const moved = submit([
      { kind: "project.folder_set", project, path: "~/Code/portal", carry: true },
    ]);
    expectStatus(moved, "applied");
    expect(live()).toEqual({
      [`project:${project}`]: "~/Code/portal",
      [`task:${inside}`]: "~/Code/portal/web/header",
      [`task:${same}`]: "~/Code/portal",
      [`task:${outside}`]: "~/work/portal-docs",
      [`task:${loose}`]: "~/Code/portal/other",
      [`project:${nested}`]: "~/Code/portal/api",
      [`task:${nestedTask}`]: "~/Code/portal/api/v2",
    });
    expectStatus(undo(), "applied");
    expect(live()).toEqual(before);
    expectStatus(redo(), "applied");
    expect(live()[`task:${inside}`]).toBe("~/Code/portal/web/header");
    // A task's folder moved on disk carries what is inside it as well, a project's included.
    expectStatus(
      submit([{ kind: "task.folder_set", task: same, path: "~/code/portal-moved", carry: true }]),
      "applied",
    );
    expect(live()).toMatchObject({
      [`project:${project}`]: "~/code/portal-moved",
      [`project:${nested}`]: "~/code/portal-moved/api",
      [`task:${loose}`]: "~/code/portal-moved/other",
    });
    // Clearing the project's folder leaves the folders inside it as they are.
    expectStatus(submit([{ kind: "project.folder_clear", project }]), "applied");
    expect(live()[`project:${project}`]).toBeUndefined();
    expect(live()[`task:${inside}`]).toBe("~/code/portal-moved/web/header");
    // A clear of nothing is no change.
    expectStatus(submit([{ kind: "project.folder_clear", project }]), "unchanged");
  });

  test("a folder changed without carry changes the owner's folder alone", () => {
    const project = newProject("Repointed", "~/work/wrong");
    const task = newTask("Inner", project, "~/work/wrong/inner");
    const other = newProject("Inside", "~/work/wrong/inside");
    expectStatus(
      submit([{ kind: "project.folder_set", project, path: "~/work/right" }]),
      "applied",
    );
    expect(live()).toMatchObject({
      [`project:${project}`]: "~/work/right",
      [`task:${task}`]: "~/work/wrong/inner",
      [`project:${other}`]: "~/work/wrong/inside",
    });
  });

  test("a stale base is a conflict on a folder the move would carry", () => {
    const project = newProject("Moves", "~/work/moves");
    const task = newTask("Inner", project, "~/work/moves/inner");
    const stale = fx.base();
    expectStatus(
      submit([{ kind: "task.folder_set", task, path: "~/work/moves/inner2" }]),
      "applied",
    );
    const conflict = submit(
      [{ kind: "project.folder_set", project, path: "~/work/moved", carry: true }],
      fx.human,
      {
        base: stale,
      },
    );
    expectStatus(conflict, "conflict");
    expect(conflict.conflicts).toEqual([
      expect.objectContaining({ entity: "folders", field: "path", task }),
    ]);
  });

  test("two live projects never share one folder on one machine; an archived one keeps its folder, a deleted one frees it", () => {
    const first = newProject("First", "~/work/shared");
    const second = newProject("Second");
    const taken = submit([{ kind: "project.folder_set", project: second, path: "~/work/shared" }]);
    expectStatus(taken, "rejected");
    expect(taken.error).toMatchObject({ code: "FOLDER_TAKEN", field: "path" });
    // Nested folders are fine, and so is a task's folder in a project's.
    expectStatus(
      submit([{ kind: "project.folder_set", project: second, path: "~/work/shared/inner" }]),
      "applied",
    );
    newTask("Same folder", undefined, "~/work/shared");
    expectStatus(submit([{ kind: "project.archive", project: first }]), "applied");
    const third = newProject("Third");
    expectStatus(
      submit([{ kind: "project.folder_set", project: third, path: "~/work/shared" }]),
      "rejected",
    );
    // Linux compares with case: another spelling is another folder there.
    expectStatus(
      submit([{ kind: "project.folder_set", project: third, path: "~/work/Shared" }]),
      "applied",
    );
  });

  test("delete removes a project's folders on every machine; restore brings them back unless another live project took one meanwhile", async () => {
    const other = { ...fx.human, machine_id: newId("m") };
    await addMachine(other.machine_id, "linux");
    const project = newProject("Gone", "~/work/gone");
    expectStatus(
      submit([{ kind: "project.folder_set", project, path: "/srv/gone" }], other),
      "applied",
    );
    expectStatus(submit([{ kind: "project.delete", project }]), "applied");
    expect(live()).toEqual({});
    // Meanwhile a new project takes the folder on the first machine.
    const taker = newProject("Taker", "~/work/gone");
    const restored = submit([{ kind: "project.restore", project }]);
    expectStatus(restored, "applied");
    expect(live()).toEqual({
      [`project:${taker}`]: "~/work/gone",
      [`project:${project}`]: "/srv/gone",
    });
    // The result names the folder that stays removed, by the project that holds it now.
    expect(restored.conflicts).toEqual([
      expect.objectContaining({ entity: "folders", field: "path" }),
    ]);
    expectStatus(undo(), "applied");
    expect(live()).toEqual({ [`project:${taker}`]: "~/work/gone" });
  });

  test("undo of a delete is a conflict on a folder another project took; the partial undo brings the project back without it", () => {
    const project = newProject("Undone", "~/work/undone");
    expectStatus(submit([{ kind: "project.delete", project }]), "applied");
    // An agent's project takes the folder: agents' commits are on no undo stack.
    const taker = newId("p");
    expectStatus(
      submit(
        [
          { kind: "project.create", id: taker, title: "Taker" },
          { kind: "project.folder_set", project: taker, path: "~/work/undone" },
        ],
        fx.codex,
      ),
      "applied",
    );
    const blocked = undo();
    expectStatus(blocked, "conflict");
    expect(blocked.conflicts).toEqual([
      expect.objectContaining({ entity: "folders", field: "path", value: "~/work/undone" }),
    ]);
    expectStatus(undo(true), "applied");
    expect(live()).toEqual({ [`project:${taker}`]: "~/work/undone" });
    expect(
      fx.reader.prepare("SELECT deleted_at FROM projects WHERE id = $id").get({ id: project }),
    ).toEqual({ deleted_at: null });
  });

  test("undo of a folder change that another project's folder took back is a conflict", () => {
    const project = newProject("Mover", "~/work/a");
    expectStatus(submit([{ kind: "project.folder_set", project, path: "~/work/b" }]), "applied");
    const taker = newId("p");
    expectStatus(
      submit(
        [
          { kind: "project.create", id: taker, title: "Taker" },
          { kind: "project.folder_set", project: taker, path: "~/work/a" },
        ],
        fx.codex,
      ),
      "applied",
    );
    expectStatus(undo(), "conflict");
    expect(live()[`project:${project}`]).toBe("~/work/b");
  });

  test("a task's folder: set, changed and cleared on this machine, with a draft in one request and one undo", () => {
    const task = newTask("Own folder", fx.project, "~/work/own");
    expectStatus(submit([{ kind: "task.folder_set", task, path: "~/work/own2" }]), "applied");
    expectStatus(submit([{ kind: "task.folder_clear", task }]), "applied");
    expect(live()).toEqual({});
    expectStatus(undo(), "applied");
    expect(live()).toEqual({ [`task:${task}`]: "~/work/own2" });
    // One request changes an owner's folder once: set and cleared, or set twice, is refused.
    for (const second of [
      { kind: "task.folder_clear" as const, task },
      { kind: "task.folder_set" as const, task, path: "~/work/z" },
    ]) {
      expectStatus(
        submit([{ kind: "task.folder_set", task, path: "~/work/x" }, second]),
        "rejected",
      );
    }
    // An agent sets a folder too; a deleted task takes none.
    expectStatus(
      submit([{ kind: "task.folder_set", task, path: "~/work/agent" }], fx.codex),
      "applied",
    );
    expectStatus(submit([{ kind: "task.delete", task }]), "applied");
    expectStatus(submit([{ kind: "task.folder_set", task, path: "~/work/y" }]), "rejected");
  });

  test("a project's folder changed to one inside or around the old one moves no task folder; a deleted task's folder moves with a real move", () => {
    const project = newProject("Portal three", "~/work/portal");
    const web = newTask("Web", project, "~/work/portal/web");
    const api = newTask("Api", project, "~/work/portal/api");
    const trashed = newTask("Trashed", project, "~/work/portal/old");
    expectStatus(submit([{ kind: "task.delete", task: trashed }]), "applied");
    // The project is really the web folder: the folders below stay where they are.
    expectStatus(
      submit([{ kind: "project.folder_set", project, path: "~/work/portal/web", carry: true }]),
      "applied",
    );
    expect(live()[`task:${web}`]).toBe("~/work/portal/web");
    expect(live()[`task:${api}`]).toBe("~/work/portal/api");
    // And back out to the folder around it.
    expectStatus(
      submit([{ kind: "project.folder_set", project, path: "~/work/portal", carry: true }]),
      "applied",
    );
    expect(live()[`task:${web}`]).toBe("~/work/portal/web");
    // A real move carries every task's folder inside, a deleted task's too.
    expectStatus(
      submit([{ kind: "project.folder_set", project, path: "~/Code/portal", carry: true }]),
      "applied",
    );
    expect(live()).toMatchObject({
      [`task:${web}`]: "~/Code/portal/web",
      [`task:${api}`]: "~/Code/portal/api",
      [`task:${trashed}`]: "~/Code/portal/old",
    });
  });

  test("a move that would land a project inside it on another live project's folder is refused whole", () => {
    const project = newProject("Outer", "~/work/outer");
    const inner = newProject("Inner", "~/work/outer/app");
    const holder = newProject("Holder", "~/Code/app");
    const before = live();
    const refused = submit([{ kind: "project.folder_set", project, path: "~/Code", carry: true }]);
    expectStatus(refused, "rejected");
    expect(refused.error).toMatchObject({ code: "FOLDER_TAKEN" });
    expect(live()).toEqual(before);
    expect(live()[`project:${holder}`]).toBe("~/Code/app");
    expect(live()[`project:${inner}`]).toBe("~/work/outer/app");
  });

  test("setting a folder from a base before another's clear is a conflict; without a base it sets", () => {
    const project = newProject("Cleared", "~/work/cleared");
    const stale = fx.base();
    expectStatus(submit([{ kind: "project.folder_clear", project }], fx.codex), "applied");
    const conflict = submit(
      [{ kind: "project.folder_set", project, path: "~/work/other" }],
      fx.human,
      { base: stale },
    );
    expectStatus(conflict, "conflict");
    expect(conflict.conflicts).toEqual([
      expect.objectContaining({ entity: "folders", field: "deleted" }),
    ]);
    expectStatus(
      submit([{ kind: "project.folder_set", project, path: "~/work/other" }]),
      "applied",
    );
    // With an older removed folder beside it, the newest clear still counts.
    const before = fx.base();
    expectStatus(submit([{ kind: "project.folder_clear", project }], fx.codex), "applied");
    expectStatus(
      submit([{ kind: "project.folder_set", project, path: "~/work/third" }], fx.human, {
        base: before,
      }),
      "conflict",
    );
    const unbased = fx.writer.submit(
      fx.request(fx.human, [{ kind: "task.folder_set", task: newTask("T"), path: "~/work/t" }]),
    );
    expectStatus(unbased, "applied");
  });

  test("setting a folder from a base before Undo brought the cleared one back is a conflict, and the restored folder stays", () => {
    const task = newTask("Restored", undefined, "~/work/a");
    expectStatus(submit([{ kind: "task.folder_clear", task }]), "applied");
    const empty = fx.base();
    expectStatus(undo(), "applied");
    expect(live()).toEqual({ [`task:${task}`]: "~/work/a" });
    const stale = submit([{ kind: "task.folder_set", task, path: "~/work/b" }], fx.codex, {
      base: empty,
    });
    expectStatus(stale, "conflict");
    expect(stale.conflicts).toEqual([
      expect.objectContaining({ entity: "folders", field: "deleted", task }),
    ]);
    expect(live()).toEqual({ [`task:${task}`]: "~/work/a" });
  });

  test("Redo of a clear after someone changed the folder is a conflict, and their folder stays", () => {
    const task = newTask("Moved since", undefined, "~/work/a");
    expectStatus(submit([{ kind: "task.folder_clear", task }]), "applied");
    expectStatus(undo(), "applied");
    expectStatus(
      submit([{ kind: "task.folder_set", task, path: "~/work/b" }], fx.codex),
      "applied",
    );
    const late = redo();
    expectStatus(late, "conflict");
    expect(late.conflicts).toEqual([
      expect.objectContaining({ entity: "folders", field: "path", task }),
    ]);
    expect(live()).toEqual({ [`task:${task}`]: "~/work/b" });
  });

  test("a deleted project never holds a live folder: undo of a clear while it is deleted is a conflict, so its restore cannot share a folder", () => {
    const project = newProject("Away", "~/work/away");
    expectStatus(submit([{ kind: "project.folder_clear", project }]), "applied");
    expectStatus(submit([{ kind: "project.delete", project }], fx.codex), "applied");
    const blocked = undo();
    expectStatus(blocked, "conflict");
    expect(blocked.conflicts).toEqual([
      expect.objectContaining({ entity: "projects", id: project, field: "deleted" }),
    ]);
    const taker = newId("p");
    expectStatus(
      submit(
        [
          { kind: "project.create", id: taker, title: "Taker" },
          { kind: "project.folder_set", project: taker, path: "~/work/away" },
        ],
        fx.codex,
      ),
      "applied",
    );
    expectStatus(submit([{ kind: "project.restore", project }], fx.codex), "applied");
    expect(live()).toEqual({ [`project:${taker}`]: "~/work/away" });
  });

  test("undo of a restore is a conflict when a folder was set on the project since, and redo of a delete when a task was filed into it", () => {
    const project = newProject("Twice");
    expectStatus(submit([{ kind: "project.delete", project }]), "applied");
    expectStatus(submit([{ kind: "project.restore", project }]), "applied");
    expectStatus(
      submit([{ kind: "project.folder_set", project, path: "~/work/twice" }], fx.codex),
      "applied",
    );
    const restoreUndo = undo();
    expectStatus(restoreUndo, "conflict");
    expect(restoreUndo.conflicts).toEqual([
      expect.objectContaining({ entity: "folders", field: "deleted" }),
    ]);
    expectStatus(undo(true), "applied");
    expect(live()[`project:${project}`]).toBe("~/work/twice");

    // A delete undone, then a task an agent files into the project: the redo would hide it.
    const other = newProject("Once");
    expectStatus(submit([{ kind: "project.delete", project: other }]), "applied");
    expectStatus(undo(), "applied");
    const filed = newId("t");
    expectStatus(
      submit([{ kind: "task.create", id: filed, title: "Filed since", project: other }], fx.codex),
      "applied",
    );
    const deleteRedo = redo();
    expectStatus(deleteRedo, "conflict");
    // Named by who put it into the project.
    expect(deleteRedo.conflicts).toEqual([
      expect.objectContaining({ entity: "tasks", id: filed, field: "grouping" }),
    ]);
    expect(
      fx.reader.prepare("SELECT deleted_at FROM projects WHERE id = $id").get({ id: other }),
    ).toEqual({ deleted_at: null });
  });

  test("a request whose operations together would leave a live folder or task in a deleted project is refused", () => {
    for (const after of [
      (project: string): Operation => ({
        kind: "project.folder_set",
        project,
        path: "~/work/late",
      }),
      (project: string): Operation => ({ kind: "task.create", title: "Late", project }),
      (project: string): Operation => ({ kind: "task.move", task: newTask("Moved"), project }),
    ]) {
      const project = newProject("Gone with it");
      const refused = submit([{ kind: "project.delete", project }, after(project)]);
      expectStatus(refused, "rejected");
      expect(refused.error).toMatchObject({ code: "DELETED", op: 1 });
    }
    expect(live()).toEqual({});
  });

  test("a task restored after its project was deleted lands in the project's area; with the project restored first it stays in it", () => {
    const where = (task: string) =>
      fx.reader
        .prepare("SELECT area_id, project_id FROM tasks WHERE id = $task")
        .get<{ area_id: string | null; project_id: string | null }>({ task });
    const area = fx.reader
      .prepare("SELECT id FROM areas WHERE slug = 'lumen'")
      .get<{ id: string }>()?.id;
    const project = newProject("Holder");
    const [moved, kept] = [newTask("Inside", project), newTask("Kept", project)];
    expectStatus(submit([{ kind: "task.delete", task: moved }]), "applied");
    expectStatus(submit([{ kind: "task.delete", task: kept }]), "applied");
    expectStatus(submit([{ kind: "project.delete", project }]), "applied");
    const restored = submit([{ kind: "task.restore", task: moved }]);
    expectStatus(restored, "applied");
    expect(restored.results[0]).toMatchObject({ regrouped: "area" });
    expect(where(moved)).toEqual({ area_id: area, project_id: null });
    const both = submit([
      { kind: "project.restore", project },
      { kind: "task.restore", task: kept },
    ]);
    expectStatus(both, "applied");
    expect(both.results[1]?.regrouped).toBeUndefined();
    expect(where(kept)).toEqual({ area_id: area, project_id: project });
  });

  test("a task left in a deleted project before these rules can still be changed", async () => {
    const project = newProject("Left behind");
    const task = newTask("Still here", project);
    // Outside the write path, as a space from before the rules may hold it.
    const deletedAt = async (at: number | null) => {
      fx.writer.close();
      const conn = openSpace(await checkedDriver(), fx.folder, { role: "writer" }).conn;
      try {
        conn
          .prepare("UPDATE projects SET deleted_at = $at WHERE id = $id")
          .run({ at, id: project });
      } finally {
        conn.close();
      }
      fx.reopen();
    };
    await deletedAt(1);
    expectStatus(submit([{ kind: "task.patch", task, set: { title: "Renamed" } }]), "applied");
    expectStatus(submit([{ kind: "task.move", task, project: null }]), "applied");
    await deletedAt(null);
  });

  test("a path the request's machine cannot name is refused before anything is written", () => {
    const task = newTask("Paths");
    for (const path of [
      "relative/folder",
      "C:\\work",
      "~/work/../etc",
      "~/work//x",
      "~/work/x/",
      "~/a\u0007b",
      "",
    ]) {
      expectStatus(submit([{ kind: "task.folder_set", task, path }]), "rejected");
    }
    expect(live()).toEqual({});
  });
});

/**
 * Adds another machine's record beside the writer, as that machine's first open as the authority
 * would, so a request can come from it. The fixture's checks read no machine's history.
 */
async function addMachine(id: Id<"m">, os: "linux" | "windows"): Promise<void> {
  fx.writer.close();
  const conn = openSpace(await checkedDriver(), fx.folder, { role: "writer" }).conn;
  try {
    conn.transaction("immediate", () => {
      const seq = Number(conn.prepare("SELECT last_seq AS seq FROM space").get()?.["seq"]);
      conn
        .prepare(
          "INSERT INTO machines (id, name, os, first_seen, retired_at, created_seq, version, " +
            "fv, fp) VALUES ($id, 'mira-laptop', $os, 0, NULL, $seq, $seq, '{}', '{}')",
        )
        .run({ id, os, seq });
    });
  } finally {
    conn.close();
  }
  fx.reopen();
}

describe("[A1.3.15.folders.form] a folder's form, its case rule and where a folder lands when its parent moves", () => {
  test("the forms of each OS", () => {
    for (const path of ["~", "~/work/tasks", "/srv/build", "/"]) {
      expect(folderProblem(path, "linux"), path).toBeUndefined();
      expect(folderProblem(path, "macos"), path).toBeUndefined();
    }
    for (const path of ["~", "~\\Projects\\tasks", "D:\\work\\x", "C:\\", "\\\\server\\share\\x"]) {
      expect(folderProblem(path, "windows"), path).toBeUndefined();
    }
    for (const path of ["C:\\work", "\\\\server\\share", "~\\Projects"]) {
      expect(folderProblem(path, "linux"), path).toBeDefined();
    }
    for (const path of ["/srv", "~/work", "d:\\work", "C:\\work\\", "C:\\a:b", "\\\\server"]) {
      expect(folderProblem(path, "windows"), path).toBeDefined();
    }
    expect(isFolderForm("x".repeat(4097))).toBe(false);
    expect(isFolderForm(`/${"x".repeat(4095)}`)).toBe(true);
    expect(isFolderForm("/a\ud800b")).toBe(false);
  });

  test("the case rule and the whole-segment rule", () => {
    expect(folderKey("~\\Projects\\Tasks", "windows")).toBe(
      folderKey("~\\projects\\tasks", "windows"),
    );
    expect(folderKey("~/work/Tasks", "linux")).not.toBe(folderKey("~/dev/tasks", "linux"));
    expect(rebased("~/work/a/b", "~/work/a", "~/Code/a", "linux")).toBe("~/Code/a/b");
    expect(rebased("~/work/ab", "~/work/a", "~/Code/a", "linux")).toBeUndefined();
    expect(rebased("~/dev/a/b", "~/work/a", "~/Code/a", "linux")).toBeUndefined();
    expect(rebased("~\\dev\\A\\b", "~\\Dev\\a", "D:\\", "windows")).toBe("D:\\b");
    expect(rebased("/x/y", "/", "/srv", "linux")).toBe("/srv/x/y");
  });
});

describe("[A1.3.15.folders.launch] the folder a launch uses on a machine", () => {
  test("the task's own folder there, else its project's there, else the machine that has one, else none", () => {
    const here = fx.human.machine_id;
    const project = newProject("Launch", "~/work/launch");
    const own = newTask("Own", project, "~/work/launch/own");
    const inherits = newTask("Inherits", project);
    const loose = newTask("Loose");
    expect(launchFolder(fx.reader, own, here)).toMatchObject({
      kind: "task",
      folder: { path: "~/work/launch/own", machine: here },
    });
    expect(launchFolder(fx.reader, inherits, here)).toMatchObject({
      kind: "project",
      folder: { path: "~/work/launch" },
    });
    expect(launchFolder(fx.reader, loose, here)).toEqual({ kind: "none" });
    // On a machine with no folder of its own: it opens where the folder is.
    const other = newId("m");
    expect(launchFolder(fx.reader, inherits, other)).toEqual({
      kind: "other_machine",
      machine: { id: here, name: "mira-desktop" },
    });
    expect(launchFolder(fx.reader, own, other)).toMatchObject({ kind: "other_machine" });
  });
});
