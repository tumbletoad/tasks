// What a Library lists, from the live store's pages: the node's own pages, the pages of its tasks,
// and the levels above it with theirs, each by title. Pure, so the lists are unit tests.
import { isUnder, trail, type Nodes, type PageRow } from "@ttasks/client/store";

/** The space or a project: what holds a Library. */
export type LibraryNode =
  { readonly kind: "space" } | { readonly kind: "project"; readonly id: string };

/** A level above a node: its name, where its Library is, and its pages. */
export interface Level {
  readonly node: LibraryNode;
  readonly title: string;
  readonly pages: readonly PageRow[];
}

export interface Lists {
  readonly own: readonly PageRow[];
  readonly tasks: readonly PageRow[];
  readonly above: readonly Level[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byTitle = (a: PageRow, b: PageRow): number =>
  collator.compare(a.title, b.title) || collator.compare(a.ref, b.ref);

/** The pages held by `node` itself, not by a task. */
function ownedBy(pages: readonly PageRow[], node: LibraryNode, nodes: Nodes): PageRow[] {
  const owner =
    node.kind === "space" ? [...nodes.values()].find((n) => n.kind === "space")?.id : node.id;
  return pages.filter((page) => page.task === undefined && page.owner_id === owner).sort(byTitle);
}

export function listsOf(
  node: LibraryNode,
  pages: Iterable<PageRow>,
  space: string,
  nodes: Nodes,
): Lists {
  const all = [...pages];
  const tasks =
    node.kind === "space"
      ? []
      : all
          .filter((page) => page.task !== undefined && isUnder(nodes, page.under, node.id))
          .sort(byTitle);
  const above: Level[] = [];
  if (node.kind !== "space") {
    const path = trail(nodes, node.id);
    path.slice(0, -1).forEach((n) => {
      const level: LibraryNode = { kind: "project", id: n.id };
      above.unshift({ node: level, title: n.title, pages: ownedBy(all, level, nodes) });
    });
    above.push({
      node: { kind: "space" },
      title: space,
      pages: ownedBy(all, { kind: "space" }, nodes),
    });
  }
  return { own: ownedBy(all, node, nodes), tasks, above };
}

/**
 * What a task's card shows of the library: the task's own pages, and the levels above it, nearest
 * first (its project, its area, the space), each with its pages.
 */
export function taskLists(
  task: { readonly id: string; readonly parent: string },
  pages: Iterable<PageRow>,
  space: string,
  nodes: Nodes,
): { readonly own: readonly PageRow[]; readonly above: readonly Level[] } {
  const all = [...pages];
  const own = all
    .filter((page) => page.task !== undefined && page.owner_id === task.id)
    .sort(byTitle);
  const above: Level[] = trail(nodes, task.parent)
    .map((n) => {
      const level: LibraryNode = { kind: "project", id: n.id };
      return { node: level, title: n.title, pages: ownedBy(all, level, nodes) };
    })
    .reverse();
  above.push({
    node: { kind: "space" },
    title: space,
    pages: ownedBy(all, { kind: "space" }, nodes),
  });
  return { own, above };
}
