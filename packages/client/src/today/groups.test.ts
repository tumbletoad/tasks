import { describe, expect, test } from "vitest";
import {
  archivedGroup,
  groupTasks,
  liveGroups,
  projectGroups,
  sidebarAreas,
  slotOf,
} from "./groups.ts";
import type { NodeRow, TaskRow } from "../store/rows.ts";
import { areaNode, projectNode, TEST_SPACE, treeOf } from "../../test/nodes.ts";

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
    parent: TEST_SPACE,
    ...fields,
  };
}

const lumen = areaNode({ id: "a_lumen", title: "Lumen", position: "a1" });
const home = areaNode({ id: "a_home", title: "Home", position: "a0" });
const empty = areaNode({ id: "a_empty", title: "Empty", position: "a2" });
const portal = projectNode("a_lumen", { id: "p_portal", title: "Lumen portal", position: "b1" });
const sync = projectNode("a_lumen", { id: "p_sync", title: "Clinic sync", position: "b0" });

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
      task({ title: "Fix time zones", parent: "p_portal" }),
      task({ title: "Sync delays", parent: "p_sync" }),
      task({ title: "Lumen admin", parent: "a_lumen" }),
      task({ title: "Mow", parent: "a_home" }),
    ];
    expect(titles(groupTasks(tasks, treeOf(lumen, home, empty, portal, sync)))).toEqual([
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
      task({ title: "Later", parent: "a_home", status: "backlog" }),
      task({ title: "Waits", parent: "a_home", status: "waiting" }),
      task({ title: "Now", parent: "a_home", status: "open" }),
      task({ title: "Unknown project", parent: "p_gone" }),
      task({ title: "Unknown area", parent: "a_gone", inbox: true }),
    ];
    const groups = groupTasks(tasks, treeOf(home, lumen, portal));
    const shown = groups.flatMap((g) => g.sections.flatMap((s) => s.tasks.map((t) => t.title)));
    expect(shown.sort()).toEqual(tasks.map((t) => t.title).sort());
    const homeGroup = groups.find((g) => g.title === "Home");
    expect(homeGroup?.sections[0]?.tasks.map((t) => t.title)).toEqual(["Now", "Waits", "Later"]);
    expect(groups[0]?.kind).toBe("inbox");
    expect(groups.at(-1)?.sections[0]?.tasks.map((t) => t.title)).toEqual(["Unknown project"]);
  });

  test("an area's colour slot: the stored one, else its place in the order", () => {
    expect(slotOf({ ...lumen, color: "7" }, 0)).toBe(7);
    expect(slotOf({ ...lumen, color: "9" }, 2)).toBe(3);
    expect(slotOf(lumen, 8)).toBe(1);
    const groups = groupTasks([task({ title: "x", parent: "a_lumen" })], treeOf(home, lumen));
    expect(groups[0]?.slot).toBe(2);
  });
});

describe("[A5.archived.web.groups] an archived area or project leaves the areas for Archived and takes no new work", () => {
  const attic = areaNode({ id: "a_attic", title: "Attic", position: "a05", state: "archived" });
  const boxes = projectNode("a_attic", { id: "p_boxes", title: "Boxes", position: "c0" });
  const shelvedSync: NodeRow = { ...sync, state: "archived" };
  const areas = [lumen, attic, home, empty];
  const projects = [portal, shelvedSync, boxes];
  const nodes = treeOf(...areas, ...projects);

  test("the sidebar: live areas with their live projects; Archived in the same order, an archived area with all its projects and an archived project of a live area on its own", () => {
    const { live, archived } = sidebarAreas(nodes);
    expect(live.map((a) => [a.area.title, a.projects.map((p) => p.title)])).toEqual([
      ["Home", []],
      ["Lumen", ["Lumen portal"]],
      ["Empty", []],
    ]);
    expect(
      archived.map((g) =>
        g.kind === "area"
          ? [g.area.title, g.projects.map((p) => p.title)]
          : [g.area.title, g.project.title],
      ),
    ).toEqual([
      ["Attic", ["Boxes"]],
      ["Lumen", "Clinic sync"],
    ]);
  });

  test("a project without an area is a project at the top, listed as an area after the areas, an archived one under Archived after the areas' groups", () => {
    const shed = areaNode({ id: "p_shed", title: "Shed", position: "~d0" });
    const kiln = areaNode({ id: "p_kiln", title: "Kiln", position: "~d1", state: "archived" });
    const { live, archived } = sidebarAreas(treeOf(...areas, ...projects, kiln, shed));
    expect(live.map((a) => a.area.title)).toEqual(["Home", "Lumen", "Empty", "Shed"]);
    expect(archived.map((g) => (g.kind === "area" ? g.area.title : g.project.title))).toEqual([
      "Attic",
      "Clinic sync",
      "Kiln",
    ]);
  });

  test("a project's view: its tasks in one list, open first, with or without an area", () => {
    const kiln = areaNode({ id: "p_kiln", title: "Kiln", position: "~d1" });
    const rows = [
      task({ title: "Later", parent: "p_kiln", status: "backlog" }),
      task({ title: "Fire it", parent: "p_kiln" }),
    ];
    expect(titles(projectGroups(rows, treeOf(...areas, kiln)))).toEqual([
      ["flat", undefined, [[undefined, ["Fire it", "Later"]]]],
    ]);
  });

  test("archiving an area recolours no other: each keeps its place among all areas", () => {
    const before = sidebarAreas(
      treeOf(...areas.map((a) => ({ ...a, state: "active" })), ...projects),
    );
    const after = sidebarAreas(nodes);
    const slots = (listed: ReturnType<typeof sidebarAreas>) =>
      Object.fromEntries([...listed.live, ...listed.archived].map((g) => [g.area.title, g.slot]));
    expect(slots(after)).toEqual(slots(before));
  });

  test("new work goes to live groups: no archived area, no archived project, no project of an archived area", () => {
    const { areas: open, projects: openProjects } = liveGroups(nodes);
    expect(open.map((a) => a.title)).toEqual(["Home", "Lumen", "Empty"]);
    expect(openProjects.map((p) => p.title)).toEqual(["Lumen portal"]);
  });

  test("a page is archived by its project, else by its area; a live one is not", () => {
    expect(archivedGroup(lumen, portal)).toBeUndefined();
    expect(archivedGroup(lumen)).toBeUndefined();
    expect(archivedGroup(lumen, shelvedSync)).toEqual({ kind: "project", row: shelvedSync });
    expect(archivedGroup(attic, boxes)).toEqual({ kind: "area", row: attic });
    expect(archivedGroup(attic)).toEqual({ kind: "area", row: attic });
    expect(archivedGroup(undefined)).toBeUndefined();
  });
});
