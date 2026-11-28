import { describe, expect, test } from "vitest";
import {
  archivedGroup,
  groupTasks,
  liveGroups,
  projectGroups,
  sidebarAreas,
  sidebarTree,
  slotOf,
  subtreeGroups,
  type TreeEntry,
} from "./groups.ts";
import { groupCounts } from "./views.ts";
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

describe("[S2.nav.tree] the side menu's tree and a project's groups, at any depth", () => {
  // Four levels: Client work › Lumen › Portal › Login, with an archived Reports under Lumen.
  const work = areaNode({ id: "a_work", title: "Client work", position: "a0" });
  const internal = areaNode({ id: "a_internal", title: "Internal", position: "a1" });
  const lumenHealth = projectNode("a_work", { id: "n_lumen", title: "Lumen", position: "b0" });
  const portalApp = projectNode("n_lumen", { id: "n_portal", title: "Portal", position: "c0" });
  const login = projectNode("n_portal", { id: "n_login", title: "Login", position: "d0" });
  const reports = projectNode("n_lumen", {
    id: "n_reports",
    title: "Reports",
    position: "c1",
    state: "archived",
  });
  const monthly = projectNode("n_reports", { id: "n_monthly", title: "Monthly", position: "d0" });
  const nodes = treeOf(work, internal, lumenHealth, portalApp, login, reports, monthly);

  const shape = (entries: readonly TreeEntry[]): unknown[] =>
    entries.map((e) => [e.node.title, e.depth, e.slot, ...shape(e.children)]);

  test("every live level nests in its order with its top's colour; an archived one leaves for Archived with its trail and all it holds", () => {
    const { live, archived } = sidebarTree(nodes);
    expect(shape(live)).toEqual([
      ["Client work", 1, 1, ["Lumen", 2, 1, ["Portal", 3, 1, ["Login", 4, 1]]]],
      ["Internal", 1, 2],
    ]);
    expect(archived.map((e) => [e.above.map((n) => n.title), ...shape([e])])).toEqual([
      [
        ["Client work", "Lumen"],
        ["Reports", 3, 1, ["Monthly", 4, 1]],
      ],
    ]);
  });

  test("a level counts the open tasks of everything under it", () => {
    const tasks = [
      task({ title: "Deep", parent: "n_login" }),
      task({ title: "Portal's", parent: "n_portal" }),
      task({ title: "Lumen's", parent: "n_lumen" }),
      task({ title: "In the archive", parent: "n_monthly" }),
    ];
    const counts = groupCounts(tasks, nodes);
    expect(
      ["a_work", "n_lumen", "n_portal", "n_login", "n_reports", "a_internal"].map((id) =>
        counts.get(id),
      ),
    ).toEqual([4, 4, 2, 1, 1, undefined]);
  });

  test("a project's own tasks first under no heading, then each project below it as a group of all it holds", () => {
    const tasks = [
      task({ title: "Store the zone", parent: "n_lumen", status: "waiting" }),
      task({ title: "Fix time zones", parent: "n_lumen" }),
      task({ title: "Login copy", parent: "n_login" }),
      task({ title: "Portal plan", parent: "n_portal" }),
      task({ title: "Monthly report", parent: "n_monthly" }),
    ];
    expect(titles(subtreeGroups("n_lumen")(tasks, nodes))).toEqual([
      ["flat", undefined, [[undefined, ["Fix time zones", "Store the zone"]]]],
      [
        "project",
        "Portal",
        [
          [undefined, ["Portal plan"]],
          ["Login", ["Login copy"]],
        ],
      ],
      ["project", "Reports", [["Monthly", ["Monthly report"]]]],
    ]);
    expect(subtreeGroups("n_lumen")(tasks, nodes).map((g) => g.node)).toEqual([
      undefined,
      "n_portal",
      "n_reports",
    ]);
    // A task the list keeps though it sits elsewhere now stays with the project's own tasks.
    const moved = task({ title: "Moved away", parent: "a_internal" });
    expect(titles(subtreeGroups("n_portal")([moved, ...tasks.slice(3, 4)], nodes))).toEqual([
      ["flat", undefined, [[undefined, ["Portal plan", "Moved away"]]]],
    ]);
    // A project below with nothing open has no group.
    expect(titles(subtreeGroups("a_work")(tasks.slice(0, 2), nodes))).toEqual([
      ["project", "Lumen", [[undefined, ["Fix time zones", "Store the zone"]]]],
    ]);
  });
});
