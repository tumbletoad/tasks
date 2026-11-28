// The space's tree as the store holds it: nodes by ID, the space at the root and each project under
// its parent. A task's `parent` names a node. The page calls a project at the top an area.
import type { NodeRow } from "./rows.ts";

export type Nodes = ReadonlyMap<string, NodeRow>;

/** Siblings in their order: by position, then by ID. */
export const byNodeOrder = (a: NodeRow, b: NodeRow): number => {
  const x = a.position ?? "";
  const y = b.position ?? "";
  if (x !== y) return x < y ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** The projects directly under `id`, archived ones too, in their order. */
export function childrenOf(nodes: Nodes, id: string): NodeRow[] {
  return [...nodes.values()]
    .filter((node) => node.kind === "project" && node.parent === id)
    .sort(byNodeOrder);
}

/**
 * The projects from the top down to `id`, `id` last: none for the space, or for a node the store
 * does not hold.
 */
export function trail(nodes: Nodes, id: string | undefined): NodeRow[] {
  const out: NodeRow[] = [];
  let node = id === undefined ? undefined : nodes.get(id);
  while (node?.kind === "project") {
    out.unshift(node);
    node = node.parent === undefined ? undefined : nodes.get(node.parent);
  }
  return out;
}

/** Whether `id` is `node` or lies below it. */
export const isUnder = (nodes: Nodes, id: string | undefined, node: string): boolean =>
  trail(nodes, id).some((n) => n.id === node);

/**
 * Whether today's operations take this project at the top as a project, not as an area: it was
 * made as a project without an area, and its ID says so. Such a project holds no project, and work
 * filed into it names it as the project. Goes when the operations take a node.
 */
export const projectWithoutArea = (id: string): boolean => id.startsWith("p_");

/** What today's operations take as the area and as the project, to file work into `area`'s `project`. */
export function filedAs<T extends { readonly id: string }>(
  area: T,
  project?: T,
): { readonly area?: T; readonly project?: T } {
  if (project !== undefined) return { area, project };
  return projectWithoutArea(area.id) ? { project: area } : { area };
}

/** The projects at the top, under the space, archived ones too, in their order. */
export function topLevel(nodes: Nodes): NodeRow[] {
  const space = [...nodes.values()].find((node) => node.kind === "space");
  return space === undefined ? [] : childrenOf(nodes, space.id);
}

/**
 * The node a read names by its area's and its project's names (`task.get`, a search): the project
 * of that name under the area, else the area, else a project made without an area of the
 * project's name; else the space. An area and such a project may share a name: the read says
 * which it is.
 */
export function nodeNamed(nodes: Nodes, area?: string, project?: string): string {
  const tops = topLevel(nodes);
  const top = tops.find((a) => a.title === area && !projectWithoutArea(a.id));
  const named =
    top === undefined
      ? area === undefined
        ? tops.find((p) => p.title === project && projectWithoutArea(p.id))
        : undefined
      : (childrenOf(nodes, top.id).find((p) => p.title === project) ?? top);
  return named?.id ?? [...nodes.values()].find((n) => n.kind === "space")?.id ?? "";
}
