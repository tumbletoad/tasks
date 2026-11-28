// What a Library lists, from the live store's pages: the node's own pages, the pages of its tasks,
// and the levels above it with theirs, each by title. Pure, so the lists are unit tests.
import { isUnder, trail, type Nodes, type PageRow } from "@ttasks/client/store";

/** The space, an area or a project: what holds a Library. */
export type LibraryNode =
  | { readonly kind: "space" }
  | { readonly kind: "area"; readonly id: string }
  | { readonly kind: "project"; readonly id: string };

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

/** A level of the tree as a Library names it: the project at the top is an area. */
const levelOf = (id: string, depth: number): LibraryNode =>
  depth === 0 ? { kind: "area", id } : { kind: "project", id };

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
    path.slice(0, -1).forEach((n, depth) => {
      const level = levelOf(n.id, depth);
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
    .map((n, depth) => {
      const level = levelOf(n.id, depth);
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

/**
 * The pages an agent or a routine changed last in the past `days`, newest first, at most `limit`:
 * Today's Changes beside the tasks. A page the person changed after it is the person's again.
 */
export function agentPages(
  pages: Iterable<PageRow>,
  now: number,
  days: number,
  limit: number,
): PageRow[] {
  const since = now - days * 86_400_000;
  return [...pages]
    .filter((page) => page.by !== "user" && page.by !== "import" && page.at >= since)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}
