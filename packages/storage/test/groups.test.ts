// Areas and projects through the write path: create, change, move a project, archive and
// unarchive, delete and restore, each with its history and one undo step per request. Fixture
// text only, in a temporary space.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SqlValue } from "../src/driver.ts";
import { newId } from "../src/ids.ts";
import { openSpace } from "../src/space.ts";
import type { Operation, WriteRequest, WriteResult } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, type Fixture, fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("groups");
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

type Who = "human" | "codex";

function submit(ops: Operation[], who: Who = "human", extra: Partial<WriteRequest> = {}) {
  const actor = who === "human" ? fx.human : fx.codex;
  return fx.writer.submit(
    fx.request(actor, ops, {
      base: fx.base(),
      ...(who === "human" ? { undoable: true } : {}),
      ...extra,
    }),
  );
}

const undo = (): WriteResult => fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }]));
const redo = (): WriteResult => fx.writer.submit(fx.request(fx.human, [{ kind: "redo" }]));

const row = (table: "areas" | "projects", id: string) =>
  fx.reader.prepare(`SELECT * FROM ${table} WHERE id = $id`).get({ id }) ?? {};

const created = (result: WriteResult, i = 0): string => {
  expectStatus(result, "applied");
  return result.results[i]?.id ?? "";
};

describe("[A1.5.write.groups] areas and projects are created, changed, moved, archived, deleted and restored through the write path", () => {
  test("create: a slug from the title, numbered when it is taken; a project in a new area of the same request", () => {
    const area = created(submit([{ kind: "area.create", title: "Client work" }]));
    expect(row("areas", area)).toMatchObject({ slug: "client-work", title: "Client work" });
    const again = created(submit([{ kind: "area.create", title: "Client  Work!" }]));
    expect(row("areas", again)).toMatchObject({ slug: "client-work-2" });
    // Accents are dropped from a slug, and a title with no letter of a-z gives the kind.
    const accented = created(submit([{ kind: "area.create", title: "Café Öl" }]));
    expect(row("areas", accented)["slug"]).toBe("cafe-ol");
    const symbols = created(submit([{ kind: "area.create", title: "★★★" }]));
    expect(row("areas", symbols)["slug"]).toBe("area");

    const result = submit([
      { kind: "area.create", id: "a_0garden0000000000000000000", title: "Garden" },
      { kind: "project.create", title: "Beds", area: "garden" },
      { kind: "project.create", title: "Beds", area: "a_0garden0000000000000000000" },
    ]);
    expectStatus(result, "applied");
    const [, beds, beds2] = result.results;
    expect(row("projects", beds?.id ?? "")).toMatchObject({
      slug: "beds",
      area_id: "a_0garden0000000000000000000",
    });
    expect(row("projects", beds2?.id ?? "")["slug"]).toBe("beds-2");
    // A given slug that a live group holds is refused, and an ID that exists too.
    expectStatus(submit([{ kind: "project.create", title: "Other", slug: "beds" }]), "rejected");
    expectStatus(
      submit([{ kind: "area.create", id: "a_0garden0000000000000000000", title: "X" }]),
      "rejected",
    );
    // A project needs no area.
    const loose = created(submit([{ kind: "project.create", title: "Loose ends" }]));
    expect(row("projects", loose)["area_id"]).toBeNull();
  });

  test("an agent creates a group; a task is filed into a project the same request creates", () => {
    const result = submit(
      [
        { kind: "project.create", id: "p_0n0rth00000000000000000000", title: "North" },
        { kind: "task.create", title: "Plan the north beds", project: "north" },
      ],
      "codex",
    );
    expectStatus(result, "applied");
    const task = result.results[1]?.id ?? "";
    expect(
      fx.reader.prepare("SELECT project_id FROM tasks WHERE id = $id").get({ id: task }),
    ).toEqual({ project_id: "p_0n0rth00000000000000000000" });
  });

  test("rename and other fields need a base, keep the ID, the slug and the tasks, and undo puts them back", () => {
    const task = created(
      submit([{ kind: "task.create", title: "Fix the header", project: fx.project }]),
    );
    const before = row("projects", fx.project);
    const unbased = fx.writer.submit(
      fx.request(fx.human, [{ kind: "project.patch", project: fx.project, set: { title: "Web" } }]),
    );
    expectStatus(unbased, "rejected");
    expect(unbased.error?.code).toBe("BASE_REQUIRED");
    const renamed = submit([
      {
        kind: "project.patch",
        project: "portal",
        set: { title: "Web portal", brief: "The patient portal.", color: "#3366aa" },
      },
    ]);
    expectStatus(renamed, "applied");
    expect(row("projects", fx.project)).toMatchObject({
      slug: "portal",
      title: "Web portal",
      brief: "The patient portal.",
      color: "#3366aa",
    });
    expect(
      fx.reader.prepare("SELECT project_id FROM tasks WHERE id = $id").get({ id: task }),
    ).toEqual({ project_id: fx.project });
    expectStatus(undo(), "applied");
    expect(row("projects", fx.project)).toMatchObject({
      title: before["title"],
      brief: before["brief"],
      color: before["color"],
    });
    expectStatus(redo(), "applied");
    expect(row("projects", fx.project)["title"]).toBe("Web portal");
    // A stale base is a conflict on the field another changed since.
    const stale = fx.base();
    expectStatus(
      submit([{ kind: "area.patch", area: "lumen", set: { title: "Lumen Health" } }]),
      "applied",
    );
    const conflict = submit(
      [{ kind: "area.patch", area: "lumen", set: { title: "Lumen" } }],
      "human",
      {
        base: stale,
      },
    );
    expectStatus(conflict, "conflict");
    expect(conflict.conflicts[0]).toMatchObject({ entity: "areas", field: "title" });
    // A colour is #rrggbb or null.
    expectStatus(
      submit([{ kind: "area.patch", area: "lumen", set: { color: "red" } }]),
      "rejected",
    );
  });

  test("a project moves to another area with all its tasks, at the end of that area; undo moves them back", () => {
    const done = created(submit([{ kind: "task.create", title: "Ship v1", project: fx.project }]));
    expectStatus(submit([{ kind: "task.complete", task: done }]), "applied");
    const open = created(submit([{ kind: "task.create", title: "Ship v2", project: fx.project }]));
    const moved = submit([{ kind: "project.move", project: fx.project, area: "home" }]);
    expectStatus(moved, "applied");
    expect(row("projects", fx.project)["area_id"]).toBe(fx.areas.home);
    const areas = fx.reader
      .prepare("SELECT area_id FROM tasks WHERE project_id = $p ORDER BY ref")
      .all({ p: fx.project });
    expect(areas).toEqual([{ area_id: fx.areas.home }, { area_id: fx.areas.home }]);
    // The brake counts the tasks it moves.
    const commit = fx.reader.prepare("SELECT affected FROM commits WHERE id = $id").get({
      id: moved.commit ?? "",
    });
    expect(commit?.["affected"]).toBe(2);
    expectStatus(undo(), "applied");
    expect(row("projects", fx.project)["area_id"]).toBe(fx.areas.lumen);
    for (const task of [done, open]) {
      expect(
        fx.reader.prepare("SELECT area_id FROM tasks WHERE id = $id").get({ id: task }),
      ).toEqual({
        area_id: fx.areas.lumen,
      });
    }
    // Out of every area, then a task filed into it later in the same request takes no area.
    const result = submit([
      { kind: "project.move", project: fx.project, area: null },
      { kind: "task.create", title: "Later", project: fx.project },
    ]);
    expectStatus(result, "applied");
    const later = result.results[1]?.id ?? "";
    expect(
      fx.reader.prepare("SELECT area_id FROM tasks WHERE id = $id").get({ id: later }),
    ).toEqual({
      area_id: null,
    });
  });

  test("undo of a project's move is a conflict when a task was filed into it since; its partial form leaves the project and its tasks together", () => {
    const first = created(submit([{ kind: "task.create", title: "Before", project: fx.project }]));
    expectStatus(submit([{ kind: "project.move", project: fx.project, area: "home" }]), "applied");
    const filed = created(
      submit([{ kind: "task.create", title: "Filed since", project: fx.project }], "codex"),
    );
    const blocked = undo();
    expectStatus(blocked, "conflict");
    expect(blocked.conflicts).toEqual([
      expect.objectContaining({ entity: "tasks", id: filed, field: "grouping" }),
    ]);
    const partial = fx.writer.submit(fx.request(fx.human, [{ kind: "undo", partial: true }]));
    expectStatus(partial, "applied");
    const areaOf = (id: string) =>
      fx.reader.prepare("SELECT area_id FROM tasks WHERE id = $id").get({ id })?.["area_id"];
    expect(row("projects", fx.project)["area_id"]).toBe(fx.areas.home);
    expect([areaOf(first), areaOf(filed)]).toEqual([fx.areas.home, fx.areas.home]);
  });

  test("archive keeps the group's tasks as they are; archive twice and unarchive an active one change nothing", () => {
    const task = created(
      submit([{ kind: "task.create", title: "Still open", project: fx.project }]),
    );
    expectStatus(submit([{ kind: "project.archive", project: fx.project }]), "applied");
    expect(row("projects", fx.project)["lifecycle"]).toBe("archived");
    expect(
      fx.reader.prepare("SELECT lifecycle FROM tasks WHERE id = $id").get({ id: task }),
    ).toEqual({
      lifecycle: "active",
    });
    expectStatus(submit([{ kind: "project.archive", project: fx.project }]), "unchanged");
    // A task can still be filed into an archived project: nothing of the person's is refused.
    expectStatus(submit([{ kind: "task.create", title: "Late", project: fx.project }]), "applied");
    expectStatus(submit([{ kind: "project.unarchive", project: fx.project }]), "applied");
    expect(row("projects", fx.project)["lifecycle"]).toBe("active");
    expectStatus(submit([{ kind: "area.unarchive", area: "home" }]), "unchanged");
    expectStatus(submit([{ kind: "area.archive", area: "home" }]), "applied");
    expect(row("areas", fx.areas.home)["lifecycle"]).toBe("archived");
    expectStatus(undo(), "applied");
    expect(row("areas", fx.areas.home)["lifecycle"]).toBe("active");
  });

  test("delete refuses a project that holds tasks; delete and restore, and undo of each, of an empty one", () => {
    created(submit([{ kind: "task.create", title: "Keep me", project: fx.project }]));
    const refused = submit([{ kind: "project.delete", project: fx.project }]);
    expectStatus(refused, "rejected");
    expect(refused.error).toMatchObject({ code: "VALIDATION_FAILED", field: "project" });

    const empty = created(submit([{ kind: "project.create", title: "Spare" }]));
    expectStatus(submit([{ kind: "project.delete", project: empty }]), "applied");
    expect(row("projects", empty)["deleted_at"]).not.toBeNull();
    // A deleted project takes no task, and its slug is free for a new project.
    expectStatus(submit([{ kind: "task.create", title: "No", project: empty }]), "rejected");
    expectStatus(undo(), "applied");
    expect(row("projects", empty)["deleted_at"]).toBeNull();
    expectStatus(redo(), "applied");
    expectStatus(submit([{ kind: "project.restore", project: empty }]), "applied");
    expect(row("projects", empty)["deleted_at"]).toBeNull();
    expect(submit([{ kind: "project.restore", project: empty }]).error?.code).toBe(
      "INVALID_TRANSITION",
    );
    expectStatus(undo(), "applied");
    expect(row("projects", empty)["deleted_at"]).not.toBeNull();
    // A restore whose slug a new project took meanwhile is refused, and changes nothing.
    created(submit([{ kind: "project.create", title: "Spare" }]));
    expectStatus(submit([{ kind: "project.restore", project: empty }]), "rejected");
  });

  test("a step that makes a group and files what was there into it is undone whole: the undo moves it out", () => {
    const task = created(submit([{ kind: "task.create", title: "Dig" }], "codex"));
    const area = newId("a");
    const project = newId("p");
    expectStatus(
      submit([
        { kind: "area.create", id: area, title: "Garden" },
        { kind: "project.move", project: fx.project, area },
        { kind: "project.create", id: project, title: "Beds", area },
        { kind: "task.move", task, project },
      ]),
      "applied",
    );
    expectStatus(undo(), "applied");
    expect([
      row("areas", area)["deleted_at"],
      row("projects", project)["deleted_at"],
    ]).not.toContain(null);
    expect(row("projects", fx.project)["area_id"]).toBe(fx.areas.lumen);
    expect(
      fx.reader.prepare("SELECT project_id FROM tasks WHERE id = $id").get({ id: task }),
    ).toEqual({ project_id: null });
  });

  test("a project restored after its area is gone comes back without an area, with its tasks", () => {
    const area = created(submit([{ kind: "area.create", title: "Garden" }]));
    const project = created(submit([{ kind: "project.create", title: "Beds", area }], "codex"));
    const task = created(submit([{ kind: "task.create", title: "Dig", project }], "codex"));
    expectStatus(submit([{ kind: "task.delete", task }], "codex"), "applied");
    expectStatus(submit([{ kind: "project.delete", project }], "codex"), "applied");
    // Nothing live is in the area: its creation is undone.
    expectStatus(undo(), "applied");
    expect(row("areas", area)["deleted_at"]).not.toBeNull();
    expectStatus(submit([{ kind: "project.restore", project }]), "applied");
    expect(row("projects", project)).toMatchObject({ deleted_at: null, area_id: null });
    expect(
      fx.reader.prepare("SELECT area_id, project_id FROM tasks WHERE id = $id").get({ id: task }),
    ).toEqual({ area_id: null, project_id: project });
  });

  test("Undo and Redo of a project's move take along its tasks out of sight, as the move does", () => {
    const areaOf = (id: string): unknown =>
      fx.reader.prepare("SELECT area_id FROM tasks WHERE id = $id").get({ id })?.["area_id"];
    // A task made in the project after the move, whose creation is undone first.
    expectStatus(
      submit([{ kind: "project.move", project: fx.project, area: fx.areas.home }]),
      "applied",
    );
    const later = created(submit([{ kind: "task.create", title: "Dig", project: fx.project }]));
    expectStatus(undo(), "applied");
    expectStatus(undo(), "applied");
    expect(areaOf(later)).toBe(fx.areas.lumen);
    expectStatus(redo(), "applied");
    expectStatus(redo(), "applied");
    expect(areaOf(later)).toBe(fx.areas.home);
    // A task made in the project by the request that moves it.
    const id = newId("t");
    expectStatus(
      submit([
        { kind: "task.create", id, title: "Rake", project: fx.project },
        { kind: "project.move", project: fx.project, area: fx.areas.lumen },
      ]),
      "applied",
    );
    expectStatus(undo(), "applied");
    expect(areaOf(id)).toBe(fx.areas.home);
  });

  test("one request that restores a project and makes another of the same name gives the new one a slug of its own", () => {
    const beds = created(submit([{ kind: "project.create", title: "Beds" }]));
    expectStatus(submit([{ kind: "project.delete", project: beds }]), "applied");
    const both = submit([
      { kind: "project.restore", project: beds },
      { kind: "project.create", title: "Beds" },
    ]);
    const made = created(both, 1);
    expect(row("projects", beds)).toMatchObject({ slug: "beds", deleted_at: null });
    expect(row("projects", made)).toMatchObject({ slug: "beds-2", deleted_at: null });
    // A slug the request asks for is refused while the restored project holds it.
    expectStatus(submit([{ kind: "project.delete", project: made }]), "applied");
    expectStatus(submit([{ kind: "project.delete", project: beds }]), "applied");
    const asked = submit([
      { kind: "project.restore", project: beds },
      { kind: "project.create", title: "Beds", slug: "beds" },
    ]);
    expectStatus(asked, "rejected");
    expect(asked.error).toMatchObject({ code: "VALIDATION_FAILED", field: "slug" });
  });

  test("Redo of a project's delete after someone renamed it is a conflict naming the rename, and the project stays", () => {
    const spare = created(submit([{ kind: "project.create", title: "Spare" }]));
    expectStatus(submit([{ kind: "project.delete", project: spare }]), "applied");
    expectStatus(undo(), "applied");
    expectStatus(
      submit(
        [{ kind: "project.patch", project: spare, set: { title: "Spare, renamed" } }],
        "codex",
      ),
      "applied",
    );
    const late = redo();
    expectStatus(late, "conflict");
    expect(late.conflicts).toEqual([
      expect.objectContaining({ entity: "projects", id: spare, field: "title" }),
    ]);
    expect(row("projects", spare)["deleted_at"]).toBeNull();
  });

  test("undo of a create tombstones the group; a task another commit filed into it keeps it", () => {
    const area = created(submit([{ kind: "area.create", title: "Errands" }]));
    expectStatus(undo(), "applied");
    expect(row("areas", area)["deleted_at"]).not.toBeNull();
    expectStatus(redo(), "applied");
    expect(row("areas", area)["deleted_at"]).toBeNull();
    const project = created(submit([{ kind: "project.create", title: "Shopping", area }]));
    expectStatus(submit([{ kind: "task.create", title: "Milk", project }], "codex"), "applied");
    const blocked = undo();
    expectStatus(blocked, "conflict");
    expect(blocked.conflicts.map((c) => c.entity)).toContain("tasks");
  });

  test("in a space whose project left its tasks in another area, ordinary moves, a new task beside them and undo of each work, and a move of the project brings them along", async () => {
    const [first, second] = [newTask("First"), newTask("Second")];
    const loose = created(submit([{ kind: "task.create", title: "Loose", area: "lumen" }]));
    // The project moved without its tasks, as an earlier version let it.
    await olderSpace("UPDATE projects SET area_id = $area WHERE id = $id", {
      area: fx.areas.home,
      id: fx.project,
    });
    expect([taskRow(first)["area_id"], taskRow(second)["area_id"]]).toEqual([
      fx.areas.lumen,
      fx.areas.lumen,
    ]);
    expectStatus(
      submit([{ kind: "task.patch", task: first, set: { title: "Renamed" } }]),
      "applied",
    );

    // A reorder takes the project's area with it, and its undo puts the task back as it was.
    expectStatus(submit([{ kind: "task.move", task: second, before: first }]), "applied");
    expect(order()).toEqual([second, first]);
    expect(taskRow(second)["area_id"]).toBe(fx.areas.home);
    expectStatus(undo(), "applied");
    expect(order()).toEqual([first, second]);
    expect(taskRow(second)["area_id"]).toBe(fx.areas.lumen);
    expectStatus(redo(), "applied");

    // A task put beside one of them, or created there, joins the project in its area.
    expectStatus(submit([{ kind: "task.move", task: loose, after: first }]), "applied");
    expect(taskRow(loose)).toMatchObject({ project_id: fx.project, area_id: fx.areas.home });
    const beside = created(submit([{ kind: "task.create", title: "Beside", before: first }]));
    expect(taskRow(beside)).toMatchObject({ project_id: fx.project, area_id: fx.areas.home });
    const named = created(submit([{ kind: "task.create", title: "Named", project: fx.project }]));
    expect(taskRow(named)["area_id"]).toBe(fx.areas.home);
    for (let n = 0; n < 3; n += 1) expectStatus(undo(), "applied");

    // The project's move brings every task into its new area; its undo puts each back.
    const third = created(submit([{ kind: "area.create", title: "Third" }]));
    expectStatus(submit([{ kind: "project.move", project: fx.project, area: third }]), "applied");
    expect([taskRow(first)["area_id"], taskRow(second)["area_id"]]).toEqual([third, third]);
    expectStatus(undo(), "applied");
    expect(row("projects", fx.project)["area_id"]).toBe(fx.areas.home);
    expect(taskRow(first)["area_id"]).toBe(fx.areas.lumen);
    expectStatus(redo(), "applied");
    expect(taskRow(first)["area_id"]).toBe(third);
  });

  test("in a space whose deleted project still holds live tasks, a reorder and its undo work, a move out and its undo too, and no task joins the project", async () => {
    const [first, second] = [newTask("First"), newTask("Second")];
    // The project was deleted with its tasks still in it, as an earlier build's undo of an import
    // could leave it.
    await olderSpace("UPDATE projects SET deleted_at = 1 WHERE id = $id", { id: fx.project });
    expectStatus(submit([{ kind: "task.move", task: second, before: first }]), "applied");
    expect(order()).toEqual([second, first]);
    expectStatus(undo(), "applied");
    expect(order()).toEqual([first, second]);

    const joining = submit([{ kind: "task.create", title: "Joining", after: first }]);
    expectStatus(joining, "rejected");
    expect(joining.error).toMatchObject({ code: "DELETED", op: 0 });

    expectStatus(submit([{ kind: "task.move", task: first, project: null }]), "applied");
    expect(taskRow(first)["project_id"]).toBeNull();
    expectStatus(undo(), "applied");
    expect(taskRow(first)["project_id"]).toBe(fx.project);
    expectStatus(submit([{ kind: "task.complete", task: second }]), "applied");
    expectStatus(submit([{ kind: "task.delete", task: second }]), "applied");
    expectStatus(undo(), "applied");
    expect(taskRow(second)["deleted_at"]).toBeNull();
    expectStatus(submit([{ kind: "project.restore", project: fx.project }]), "applied");
  });
});

/** A task created in the fixture's project. */
function newTask(title: string): string {
  return created(submit([{ kind: "task.create", title, project: fx.project }]));
}

const taskRow = (id: string) =>
  fx.reader.prepare("SELECT * FROM tasks WHERE id = $id").get({ id }) ?? {};

/** The fixture project's tasks, in their order. */
const order = (): string[] =>
  fx.reader
    .prepare("SELECT id FROM tasks WHERE project_id = $p AND deleted_at IS NULL ORDER BY position")
    .all({ p: fx.project })
    .map((r) => String(r["id"]));

/**
 * Changes the space outside the write path, as a space from before the group rules may hold it.
 * Only the fixture's project, which has no create row, keeps its history whole that way.
 */
async function olderSpace(sql: string, params: Record<string, SqlValue>): Promise<void> {
  fx.writer.close();
  const conn = openSpace(await checkedDriver(), fx.folder, { role: "writer" }).conn;
  try {
    conn.prepare(sql).run(params);
  } finally {
    conn.close();
  }
  fx.reopen();
}
