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
import { checkHistory, expectStatus, writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("folders");
afterAll(temp.cleanup);

let fx: Fixture;
beforeEach(async () => {
  fx = await writeFixture(temp.make());
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
    const decomposed = "~/Dev/cafe\u0301";
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

  test("changing a project's folder needs a base and moves its tasks' folders inside the old one, as one undo step", () => {
    const project = newProject("Portal two", "~/Dev/portal");
    const inside = newTask("Header", project, "~/Dev/portal/web/header");
    const same = newTask("Root", project, "~/Dev/portal");
    const outside = newTask("Docs", project, "~/Dev/portal-docs");
    const elsewhere = newTask("Not in the project", undefined, "~/Dev/portal/other");
    const before = live();
    const unbased = fx.writer.submit(
      fx.request(fx.human, [{ kind: "project.folder_set", project, path: "~/Code/portal" }]),
    );
    expect(unbased.error?.code).toBe("BASE_REQUIRED");
    const moved = submit([{ kind: "project.folder_set", project, path: "~/Code/portal" }]);
    expectStatus(moved, "applied");
    expect(live()).toEqual({
      ...before,
      [`project:${project}`]: "~/Code/portal",
      [`task:${inside}`]: "~/Code/portal/web/header",
      [`task:${same}`]: "~/Code/portal",
      [`task:${outside}`]: "~/Dev/portal-docs",
      [`task:${elsewhere}`]: "~/Dev/portal/other",
    });
    expectStatus(undo(), "applied");
    expect(live()).toEqual(before);
    expectStatus(redo(), "applied");
    expect(live()[`task:${inside}`]).toBe("~/Code/portal/web/header");
    // Clearing the project's folder leaves its tasks' folders as they are.
    expectStatus(submit([{ kind: "project.folder_clear", project }]), "applied");
    expect(live()[`project:${project}`]).toBeUndefined();
    expect(live()[`task:${inside}`]).toBe("~/Code/portal/web/header");
    // A clear of nothing is no change.
    expectStatus(submit([{ kind: "project.folder_clear", project }]), "unchanged");
  });

  test("a stale base is a conflict on a task folder the move would carry", () => {
    const project = newProject("Moves", "~/Dev/moves");
    const task = newTask("Inner", project, "~/Dev/moves/inner");
    const stale = fx.base();
    expectStatus(
      submit([{ kind: "task.folder_set", task, path: "~/Dev/moves/inner2" }]),
      "applied",
    );
    const conflict = submit(
      [{ kind: "project.folder_set", project, path: "~/Dev/moved" }],
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
    const first = newProject("First", "~/Dev/shared");
    const second = newProject("Second");
    const taken = submit([{ kind: "project.folder_set", project: second, path: "~/Dev/shared" }]);
    expectStatus(taken, "rejected");
    expect(taken.error).toMatchObject({ code: "FOLDER_TAKEN", field: "path" });
    // Nested folders are fine, and so is a task's folder in a project's.
    expectStatus(
      submit([{ kind: "project.folder_set", project: second, path: "~/Dev/shared/inner" }]),
      "applied",
    );
    newTask("Same folder", undefined, "~/Dev/shared");
    expectStatus(submit([{ kind: "project.archive", project: first }]), "applied");
    const third = newProject("Third");
    expectStatus(
      submit([{ kind: "project.folder_set", project: third, path: "~/Dev/shared" }]),
      "rejected",
    );
    // Linux compares with case: another spelling is another folder there.
    expectStatus(
      submit([{ kind: "project.folder_set", project: third, path: "~/Dev/Shared" }]),
      "applied",
    );
  });

  test("delete removes a project's folders on every machine; restore brings them back unless another live project took one meanwhile", async () => {
    const other = { ...fx.human, machine_id: newId("m") };
    await addMachine(other.machine_id, "linux");
    const project = newProject("Gone", "~/Dev/gone");
    expectStatus(
      submit([{ kind: "project.folder_set", project, path: "/srv/gone" }], other),
      "applied",
    );
    expectStatus(submit([{ kind: "project.delete", project }]), "applied");
    expect(live()).toEqual({});
    // Meanwhile a new project takes the folder on the first machine.
    const taker = newProject("Taker", "~/Dev/gone");
    const restored = submit([{ kind: "project.restore", project }]);
    expectStatus(restored, "applied");
    expect(live()).toEqual({
      [`project:${taker}`]: "~/Dev/gone",
      [`project:${project}`]: "/srv/gone",
    });
    // The result names the folder that stays removed, by the project that holds it now.
    expect(restored.conflicts).toEqual([
      expect.objectContaining({ entity: "folders", field: "path" }),
    ]);
    expectStatus(undo(), "applied");
    expect(live()).toEqual({ [`project:${taker}`]: "~/Dev/gone" });
  });

  test("undo of a delete is a conflict on a folder another project took; the partial undo brings the project back without it", () => {
    const project = newProject("Undone", "~/Dev/undone");
    expectStatus(submit([{ kind: "project.delete", project }]), "applied");
    // An agent's project takes the folder: agents' commits are on no undo stack.
    const taker = newId("p");
    expectStatus(
      submit(
        [
          { kind: "project.create", id: taker, title: "Taker" },
          { kind: "project.folder_set", project: taker, path: "~/Dev/undone" },
        ],
        fx.codex,
      ),
      "applied",
    );
    const blocked = undo();
    expectStatus(blocked, "conflict");
    expect(blocked.conflicts).toEqual([
      expect.objectContaining({ entity: "folders", field: "path", value: "~/Dev/undone" }),
    ]);
    expectStatus(undo(true), "applied");
    expect(live()).toEqual({ [`project:${taker}`]: "~/Dev/undone" });
    expect(
      fx.reader.prepare("SELECT deleted_at FROM projects WHERE id = $id").get({ id: project }),
    ).toEqual({ deleted_at: null });
  });

  test("undo of a folder change that another project's folder took back is a conflict", () => {
    const project = newProject("Mover", "~/Dev/a");
    expectStatus(submit([{ kind: "project.folder_set", project, path: "~/Dev/b" }]), "applied");
    const taker = newId("p");
    expectStatus(
      submit(
        [
          { kind: "project.create", id: taker, title: "Taker" },
          { kind: "project.folder_set", project: taker, path: "~/Dev/a" },
        ],
        fx.codex,
      ),
      "applied",
    );
    expectStatus(undo(), "conflict");
    expect(live()[`project:${project}`]).toBe("~/Dev/b");
  });

  test("a task's folder: set, changed and cleared on this machine, with a draft in one request and one undo", () => {
    const task = newTask("Own folder", fx.project, "~/Dev/own");
    expectStatus(submit([{ kind: "task.folder_set", task, path: "~/Dev/own2" }]), "applied");
    expectStatus(submit([{ kind: "task.folder_clear", task }]), "applied");
    expect(live()).toEqual({});
    expectStatus(undo(), "applied");
    expect(live()).toEqual({ [`task:${task}`]: "~/Dev/own2" });
    // Set and cleared in one request is two intents in one.
    expectStatus(
      submit([
        { kind: "task.folder_set", task, path: "~/Dev/x" },
        { kind: "task.folder_clear", task },
      ]),
      "rejected",
    );
    // An agent sets a folder too; a deleted task takes none.
    expectStatus(
      submit([{ kind: "task.folder_set", task, path: "~/Dev/agent" }], fx.codex),
      "applied",
    );
    expectStatus(submit([{ kind: "task.delete", task }]), "applied");
    expectStatus(submit([{ kind: "task.folder_set", task, path: "~/Dev/y" }]), "rejected");
  });

  test("a path the request's machine cannot name is refused before anything is written", () => {
    const task = newTask("Paths");
    for (const path of [
      "relative/folder",
      "C:\\work",
      "~/Dev/../etc",
      "~/Dev//x",
      "~/Dev/x/",
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
    for (const path of ["~", "~/Dev/tasks", "/srv/build", "/"]) {
      expect(folderProblem(path, "linux"), path).toBeUndefined();
      expect(folderProblem(path, "macos"), path).toBeUndefined();
    }
    for (const path of ["~", "~\\Projects\\tasks", "D:\\work\\x", "C:\\", "\\\\server\\share\\x"]) {
      expect(folderProblem(path, "windows"), path).toBeUndefined();
    }
    for (const path of ["C:\\work", "\\\\server\\share", "~\\Projects"]) {
      expect(folderProblem(path, "linux"), path).toBeDefined();
    }
    for (const path of ["/srv", "~/Dev", "d:\\work", "C:\\work\\", "C:\\a:b", "\\\\server"]) {
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
    expect(folderKey("~/Dev/Tasks", "linux")).not.toBe(folderKey("~/dev/tasks", "linux"));
    expect(rebased("~/Dev/a/b", "~/Dev/a", "~/Code/a", "linux")).toBe("~/Code/a/b");
    expect(rebased("~/Dev/ab", "~/Dev/a", "~/Code/a", "linux")).toBeUndefined();
    expect(rebased("~/dev/a/b", "~/Dev/a", "~/Code/a", "linux")).toBeUndefined();
    expect(rebased("~\\dev\\A\\b", "~\\Dev\\a", "D:\\", "windows")).toBe("D:\\b");
    expect(rebased("/x/y", "/", "/srv", "linux")).toBe("/srv/x/y");
  });
});

describe("[A1.3.15.folders.launch] the folder a launch uses on a machine", () => {
  test("the task's own folder there, else its project's there, else the machine that has one, else none", () => {
    const here = fx.human.machine_id;
    const project = newProject("Launch", "~/Dev/launch");
    const own = newTask("Own", project, "~/Dev/launch/own");
    const inherits = newTask("Inherits", project);
    const loose = newTask("Loose");
    expect(launchFolder(fx.reader, own, here)).toMatchObject({
      kind: "task",
      folder: { path: "~/Dev/launch/own", machine: here },
    });
    expect(launchFolder(fx.reader, inherits, here)).toMatchObject({
      kind: "project",
      folder: { path: "~/Dev/launch" },
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
