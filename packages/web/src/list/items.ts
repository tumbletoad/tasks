// A grouped list as one sequence of items (A5 3.25: "Group headings are virtual items too"): each
// group's heading, each project's label, then its rows, in order. Pure, so the order, the set sizes
// and the positions are unit tests, and the list (List.tsx) only lays out what this gives it.
import type { Group } from "../groups.ts";
import type { AreaRow, ProjectRow, TaskRow } from "../store/rows.ts";

export interface GroupItem {
  readonly kind: "group";
  readonly key: string;
  readonly group: Group;
  readonly first: boolean;
}

export interface SectionItem {
  readonly kind: "section";
  readonly key: string;
  readonly group: string;
  readonly title: string;
}

export interface RowItem {
  readonly kind: "row";
  /** The task's ID: rows keep their identity whatever their place. */
  readonly key: string;
  readonly task: TaskRow;
  readonly group: string;
  readonly section: string;
  /** The row's place in its list (its project's, or its group's), 1-based, and that list's size. */
  readonly posinset: number;
  readonly setsize: number;
  readonly area: AreaRow | undefined;
  readonly slot: number | undefined;
  readonly project: ProjectRow | undefined;
}

export type Item = GroupItem | SectionItem | RowItem;

/** The sequence of a grouped list, and the index of each item by its key. */
export interface Items {
  readonly items: readonly Item[];
  readonly index: ReadonlyMap<string, number>;
  /** How many rows (tasks) the list holds. */
  readonly rows: number;
}

/**
 * The items of the groups. `areas` and `projects` give each row its area and project rows by
 * identity, so an unchanged row gets the same objects every time; `slots` each area's colour slot.
 */
export function itemsOf(
  groups: readonly Group[],
  areas: ReadonlyMap<string, AreaRow>,
  projects: ReadonlyMap<string, ProjectRow>,
  slots: ReadonlyMap<string, number>,
): Items {
  const items: Item[] = [];
  let rows = 0;
  groups.forEach((group, g) => {
    items.push({ kind: "group", key: `g:${group.key}`, group, first: g === 0 });
    for (const section of group.sections) {
      const sectionKey = `s:${section.key}`;
      if (section.title !== undefined) {
        items.push({ kind: "section", key: sectionKey, group: group.key, title: section.title });
      }
      section.tasks.forEach((task, i) => {
        items.push({
          kind: "row",
          key: task.id,
          task,
          group: group.key,
          section: sectionKey,
          posinset: i + 1,
          setsize: section.tasks.length,
          area: task.area_id === undefined ? undefined : areas.get(task.area_id),
          slot: task.area_id === undefined ? undefined : slots.get(task.area_id),
          project: task.project_id === undefined ? undefined : projects.get(task.project_id),
        });
        rows += 1;
      });
    }
  });
  const index = new Map<string, number>();
  items.forEach((item, i) => index.set(item.key, i));
  return { items, index, rows };
}

/** A row's neighbour for keyboard movement: the next or previous row, the first or the last. */
export function moveFrom(
  items: readonly Item[],
  from: number,
  move: "next" | "previous" | "first" | "last" | "next-group" | "previous-group",
): number | undefined {
  const isRow = (i: number) => items[i]?.kind === "row";
  switch (move) {
    case "first":
      for (let i = 0; i < items.length; i += 1) if (isRow(i)) return i;
      return undefined;
    case "last":
      for (let i = items.length - 1; i >= 0; i -= 1) if (isRow(i)) return i;
      return undefined;
    case "next":
      for (let i = from + 1; i < items.length; i += 1) if (isRow(i)) return i;
      return undefined;
    case "previous":
      for (let i = from - 1; i >= 0; i -= 1) if (isRow(i)) return i;
      return undefined;
    case "next-group": {
      const here = items[from];
      const group = here?.kind === "row" ? here.group : undefined;
      for (let i = from + 1; i < items.length; i += 1) {
        const item = items[i];
        if (item?.kind === "row" && item.group !== group) return i;
      }
      return undefined;
    }
    case "previous-group": {
      // The first row of this group, or of the previous group when already on it.
      const here = items[from];
      if (here?.kind !== "row") return undefined;
      let start = from;
      while (start > 0) {
        const before = items[start - 1];
        if (before?.kind === "row" && before.group === here.group) start -= 1;
        else if (before?.kind === "section" && before.group === here.group) start -= 1;
        else break;
      }
      while (items[start]?.kind !== "row" && start < from) start += 1;
      if (start < from) return start;
      for (let i = from - 1; i >= 0; i -= 1) {
        const item = items[i];
        if (item?.kind === "row" && item.group !== here.group) {
          // The first row of that group.
          let first = i;
          for (let j = i - 1; j >= 0; j -= 1) {
            const other = items[j];
            if (other?.kind === "group") break;
            if (other?.kind === "row" && other.group === item.group) first = j;
          }
          return first;
        }
      }
      return undefined;
    }
  }
}
