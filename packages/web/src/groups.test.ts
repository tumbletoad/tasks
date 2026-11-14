import { describe, expect, test } from "vitest";
import { groupTasks, slotOf } from "./groups.ts";
import type { AreaRow, ProjectRow, TaskRow } from "./live.ts";

let n = 0;
function task(fields: Partial<TaskRow> & { title: string }): TaskRow {
  n += 1;
  return {
    id: `t_${String(n).padStart(26, "0")}`,
    ref: `M-${String(n)}`,
    status: "open",
    inbox: false,
    lifecycle: "active",
    position: `a${String(n)}`,
    created_at: n,
    version: 1,
    ...fields,
  };
}

const lumen: AreaRow = { id: "a_lumen", title: "Lumen", position: "a1" };
const home: AreaRow = { id: "a_home", title: "Home", position: "a0" };
const empty: AreaRow = { id: "a_empty", title: "Empty", position: "a2" };
const portal: ProjectRow = {
  id: "p_portal",
  area_id: "a_lumen",
  title: "Lumen portal",
  position: "b1",
};
const sync: ProjectRow = { id: "p_sync", area_id: "a_lumen", title: "Clinic sync", position: "b0" };

const titles = (groups: ReturnType<typeof groupTasks>) =>
  groups.map((g) => [
    g.kind,
    g.title,
    g.sections.map((s) => [s.title, s.tasks.map((t) => t.title)]),
  ]);

describe("[A5.3.5.web.groups] open tasks by area and project", () => {
  test("Inbox first, areas in order with their projects, tasks without an area last", () => {
    const tasks = [
      task({ title: "Captured first", inbox: true }),
      task({ title: "Captured second", inbox: true }),
      task({ title: "Loose", inbox: false }),
      task({ title: "Fix time zones", area_id: "a_lumen", project_id: "p_portal" }),
      task({ title: "Sync delays", area_id: "a_lumen", project_id: "p_sync" }),
      task({ title: "Lumen admin", area_id: "a_lumen" }),
      task({ title: "Mow", area_id: "a_home" }),
    ];
    expect(titles(groupTasks(tasks, [lumen, home, empty], [portal, sync]))).toEqual([
      ["inbox", undefined, [[undefined, ["Captured second", "Captured first"]]]],
      ["area", "Home", [[undefined, ["Mow"]]]],
      [
        "area",
        "Lumen",
        [
          [undefined, ["Lumen admin"]],
          ["Clinic sync", ["Sync delays"]],
          ["Lumen portal", ["Fix time zones"]],
        ],
      ],
      ["loose", undefined, [[undefined, ["Loose"]]]],
    ]);
  });

  test("inside a group, open first and backlog last; every task appears exactly once", () => {
    const tasks = [
      task({ title: "Later", area_id: "a_home", status: "backlog" }),
      task({ title: "Waits", area_id: "a_home", status: "waiting" }),
      task({ title: "Now", area_id: "a_home", status: "open" }),
      task({ title: "Orphan project", area_id: "a_home", project_id: "p_gone" }),
      task({ title: "Other area's project", area_id: "a_home", project_id: "p_portal" }),
      task({ title: "Unknown area", area_id: "a_gone", inbox: true }),
    ];
    const groups = groupTasks(tasks, [home, lumen], [portal]);
    const shown = groups.flatMap((g) => g.sections.flatMap((s) => s.tasks.map((t) => t.title)));
    expect(shown.sort()).toEqual(tasks.map((t) => t.title).sort());
    const homeGroup = groups.find((g) => g.title === "Home");
    expect(homeGroup?.sections[0]?.tasks.map((t) => t.title)).toEqual([
      "Now",
      "Orphan project",
      "Waits",
      "Later",
    ]);
    expect(groups[0]?.kind).toBe("inbox");
  });

  test("an area's colour slot: the stored one, else its place in the order", () => {
    expect(slotOf({ ...lumen, color: 5 }, 0)).toBe(5);
    expect(slotOf({ ...lumen, color: "7" }, 0)).toBe(7);
    expect(slotOf({ ...lumen, color: 9 }, 2)).toBe(3);
    expect(slotOf(lumen, 8)).toBe(1);
    const groups = groupTasks([task({ title: "x", area_id: "a_lumen" })], [home, lumen], []);
    expect(groups[0]?.slot).toBe(2);
  });
});
