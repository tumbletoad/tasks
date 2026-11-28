// The space's tree as the store holds it: a node's place above its tasks, the order of siblings,
// where work is filed on today's operations, and a node found by the names a read gives.
import { describe, expect, test } from "vitest";
import { areaNode, projectNode, TEST_SPACE, treeOf } from "../../test/nodes.ts";
import { childrenOf, filedAs, isUnder, nodeNamed, topLevel, trail } from "./tree.ts";

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

  test("a read's names find the project under its area, else the area, else a project at the top, else the space", () => {
    expect(nodeNamed(nodes, "Lumen", "Portal")).toBe("p_portal");
    expect(nodeNamed(nodes, "Lumen")).toBe("a_lumen");
    expect(nodeNamed(nodes, "Lumen", "Gone")).toBe("a_lumen");
    expect(nodeNamed(nodes, undefined, "Shed")).toBe("p_shed");
    expect(nodeNamed(nodes, "Gone")).toBe(TEST_SPACE);
    expect(nodeNamed(nodes)).toBe(TEST_SPACE);
  });
});
