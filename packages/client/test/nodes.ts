// Nodes of a test space's tree: an area is a project under the space, its projects under it.
import type { NodeRow } from "../src/store/rows.ts";
import type { Nodes } from "../src/store/tree.ts";

export const TEST_SPACE = "sp_0000000000000000000000000a";

type Fields = Partial<NodeRow> & Pick<NodeRow, "id" | "title" | "position">;

/** A project at the top of the tree of `space`, which the page calls an area. */
export const areaNode = (fields: Fields, space = TEST_SPACE): NodeRow => ({
  kind: "project",
  parent: space,
  state: "active",
  ...fields,
});

/** A project under `area`. */
export const projectNode = (area: string, fields: Fields): NodeRow => ({
  kind: "project",
  parent: area,
  state: "active",
  ...fields,
});

/** The rows of a snapshot's `nodes`: the space, then these. */
export const nodesOf = (space: string, ...nodes: readonly NodeRow[]): NodeRow[] => [
  { id: space, kind: "space", title: "Mira", state: "active" },
  ...nodes,
];

/** The tree of these nodes under the test space, by ID. */
export const treeOf = (...nodes: readonly NodeRow[]): Nodes =>
  new Map(nodesOf(TEST_SPACE, ...nodes).map((node) => [node.id, node]));
