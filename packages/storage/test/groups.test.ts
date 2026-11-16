// Areas and projects through the write path: create, change, move a project, archive and
// unarchive, delete and restore, each with its history and one undo step per request. Fixture
// text only, in a temporary space.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Operation, WriteRequest, WriteResult } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("groups");
afterAll(temp.cleanup);

let fx: Fixture;
beforeEach(async () => {
  fx = await writeFixture(temp.make());
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
});
