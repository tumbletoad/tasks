// The space's tree as the store holds it: a node's place above its tasks, the order of siblings,
// where work is filed on today's operations, and a node found by the names a read gives.
import { describe, expect, test } from "vitest";
import { areaNode, projectNode, TEST_SPACE, treeOf } from "../../test/nodes.ts";
import { childrenOf, filedAs, isUnder, nodeNamed, placeOf, topLevel, trail } from "./tree.ts";

const lumen = areaNode({ id: "a_lumen", title: "Lumen", position: "a1" });
const home = areaNode({ id: "a_home", title: "Home", position: "a0" });
const shed = areaNode({ id: "p_shed", title: "Shed", position: "~a0" });
const portal = projectNode("a_lumen", { id: "p_portal", title: "Portal", position: "b1" });
const sync = projectNode("a_lumen", { id: "p_sync", title: "Sync", position: "b0" });
const nodes = treeOf(lumen, home, shed, portal, sync);

describe("[A5.tree.client.tree] the space's tree in the store", () => {
  test("a node's trail runs from the top down to it; the space and an unknown node have none", () => {
    expect(trail(nodes, "p_portal").map((n) => n.id)).toEqual(["a_lumen", "p_portal"]);
    expect(trail(nodes, "a_home").map((n) => n.id)).toEqual(["a_home"]);
    expect(trail(nodes, TEST_SPACE)).toEqual([]);
    expect(trail(nodes, "p_gone")).toEqual([]);
    expect(isUnder(nodes, "p_portal", "a_lumen")).toBe(true);
    expect(isUnder(nodes, "a_lumen", "a_lumen")).toBe(true);
    expect(isUnder(nodes, "a_home", "a_lumen")).toBe(false);
  });

  test("siblings in their order; a project made without an area after every area", () => {
    expect(topLevel(nodes).map((n) => n.title)).toEqual(["Home", "Lumen", "Shed"]);
    expect(childrenOf(nodes, "a_lumen").map((n) => n.title)).toEqual(["Sync", "Portal"]);
  });

  test("today's operations take an area and its project, and a project made without an area as a project", () => {
    expect(filedAs(lumen, portal)).toEqual({ area: lumen, project: portal });
    expect(filedAs(lumen)).toEqual({ area: lumen });
    expect(filedAs(shed)).toEqual({ project: shed });
  });

  test("a tree space takes its top project as the area and a project at any depth by itself", () => {
    const home = areaNode({ id: "p_home", title: "Home", position: "a0" });
    const kitchen = projectNode("p_home", { id: "p_kitchen", title: "Kitchen", position: "b0" });
    expect(filedAs(home, undefined, true)).toEqual({ area: home });
    expect(filedAs(home, kitchen, true)).toEqual({ project: kitchen });
  });

  test("a task's place is its top project and its own project at any depth", () => {
    const home = areaNode({ id: "p_home", title: "Home", position: "a0" });
    const reno = projectNode("p_home", { id: "p_reno", title: "Renovation", position: "b0" });
    const kitchen = projectNode("p_reno", { id: "p_kitchen", title: "Kitchen", position: "c0" });
    const deep = treeOf(home, reno, kitchen);
    expect(placeOf(deep, "p_kitchen").map((n) => n?.id)).toEqual(["p_home", "p_kitchen"]);
    expect(placeOf(deep, "p_home").map((n) => n?.id)).toEqual(["p_home", undefined]);
    expect(placeOf(deep, TEST_SPACE)).toEqual([undefined, undefined]);
    // A read names a task deeper down by its two nearest levels.
    expect(nodeNamed(deep, "Renovation", "Kitchen")).toBe("p_kitchen");
    expect(nodeNamed(deep, "Home", "Renovation")).toBe("p_reno");
    expect(nodeNamed(deep, "Home")).toBe("p_home");
  });

  test("an area and a project of one name, and an area named as the space: the read's project is the one under its area", () => {
    // Areas Work and Design, and a project Design under Work.
    const design = areaNode({ id: "a_design", title: "Design", position: "a0" });
    const work = areaNode({ id: "a_work", title: "Work", position: "a1" });
    const inWork = projectNode("a_work", { id: "p_design", title: "Design", position: "b0" });
    const twins = treeOf(design, work, inWork);
    expect(nodeNamed(twins, "Work", "Design")).toBe("p_design");
    expect(nodeNamed(twins, "Design")).toBe("a_design");
    // A project at the top named as a project of an area named as the space ("Mira").
    const top = areaNode({ id: "p_top", title: "Design", position: "a0" });
    const mira = areaNode({ id: "a_mira", title: "Mira", position: "a1" });
    const inMira = projectNode("a_mira", { id: "p_inmira", title: "Design", position: "b0" });
    expect(nodeNamed(treeOf(top, mira, inMira), "Mira", "Design")).toBe("p_inmira");
  });

  test("a read's names find the project under its area, else the area, else a project at the top, else the space", () => {
    expect(nodeNamed(nodes, "Lumen", "Portal")).toBe("p_portal");
    expect(nodeNamed(nodes, "Lumen")).toBe("a_lumen");
    expect(nodeNamed(nodes, "Lumen", "Gone")).toBe("a_lumen");
    expect(nodeNamed(nodes, undefined, "Shed")).toBe("p_shed");
    expect(nodeNamed(nodes, "Gone")).toBe(TEST_SPACE);
    // An area and a project made without an area of one name: the read says which.
    const twins = treeOf(lumen, areaNode({ id: "p_lumen", title: "Lumen", position: "~a0" }));
    expect(nodeNamed(twins, undefined, "Lumen")).toBe("p_lumen");
    expect(nodeNamed(twins, "Lumen")).toBe("a_lumen");
    expect(nodeNamed(nodes)).toBe(TEST_SPACE);
  });
});
