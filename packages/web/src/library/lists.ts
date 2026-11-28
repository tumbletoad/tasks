// What a Library lists, from the live store's pages: the node's own pages, the pages of its tasks,
// and the levels above it with theirs, each by title. Pure, so the lists are unit tests.
import type { AreaRow, PageRow, ProjectRow } from "../store/rows.ts";

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

const ownedBy = (pages: readonly PageRow[], node: LibraryNode): PageRow[] =>
  pages
    .filter((page) =>
      node.kind === "space"
        ? page.owner_kind === "space"
        : page.owner_kind === node.kind && page.owner_id === node.id,
    )
    .sort(byTitle);

export function listsOf(
  node: LibraryNode,
  pages: Iterable<PageRow>,
  space: string,
  areas: ReadonlyMap<string, AreaRow>,
  projects: ReadonlyMap<string, ProjectRow>,
): Lists {
  const all = [...pages];
  const tasks =
    node.kind === "space"
      ? []
      : all
          .filter(
            (page) =>
              page.owner_kind === "task" &&
              (node.kind === "area" ? page.area_id : page.project_id) === node.id,
          )
          .sort(byTitle);
  const above: Level[] = [];
  const area = node.kind === "project" ? projects.get(node.id)?.area_id : undefined;
  if (area !== undefined) {
    const level = { kind: "area", id: area } as const;
    above.push({ node: level, title: areas.get(area)?.title ?? "", pages: ownedBy(all, level) });
  }
  if (node.kind !== "space") {
    above.push({ node: { kind: "space" }, title: space, pages: ownedBy(all, { kind: "space" }) });
  }
  return { own: ownedBy(all, node), tasks, above };
}

/**
 * What a task's card shows of the library: the task's own pages, and the levels above it, nearest
 * first (its project, its area, the space), each with its pages.
 */
export function taskLists(
  task: { readonly id: string; readonly area_id?: string; readonly project_id?: string },
  pages: Iterable<PageRow>,
  space: string,
  areas: ReadonlyMap<string, AreaRow>,
  projects: ReadonlyMap<string, ProjectRow>,
): { readonly own: readonly PageRow[]; readonly above: readonly Level[] } {
  const all = [...pages];
  const own = all
    .filter((page) => page.owner_kind === "task" && page.owner_id === task.id)
    .sort(byTitle);
  const above: Level[] = [];
  if (task.project_id !== undefined) {
    const level = { kind: "project", id: task.project_id } as const;
    const title = projects.get(task.project_id)?.title ?? "";
    above.push({ node: level, title, pages: ownedBy(all, level) });
  }
  if (task.area_id !== undefined) {
    const level = { kind: "area", id: task.area_id } as const;
    above.push({
      node: level,
      title: areas.get(task.area_id)?.title ?? "",
      pages: ownedBy(all, level),
    });
  }
  above.push({ node: { kind: "space" }, title: space, pages: ownedBy(all, { kind: "space" }) });
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
