// A grouped list as one sequence of items, so group headings are virtual items too: each
// group's heading, each project's label, then its rows, in order. Pure, so the order, the set sizes
// and the positions are unit tests, and the list (List.tsx) only lays out what this gives it.
import { trail, type Nodes, type NodeRow, type TaskRow } from "@ttasks/client/store";
import type { Group as KeyedGroup } from "@ttasks/client/today";
import type { MessageId } from "../i18n/intl.tsx";

/** A list's group, its heading a message of the page's catalogue. */
export type Group = KeyedGroup<MessageId>;

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
  /** Its section's own key (`Section.key`). */
  readonly sectionKey: string;
  /** The row's place in its list (its project's, or its group's), 1-based, and that list's size. */
  readonly posinset: number;
  readonly setsize: number;
  readonly area: NodeRow | undefined;
  readonly slot: number | undefined;
  readonly project: NodeRow | undefined;
  /** Drawn as Completed draws its rows (`Group.finished`). */
  readonly finished: boolean;
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
 * The items of the groups. `nodes` give each row its area and project rows by identity, so an
 * unchanged row gets the same objects every time; `slots` each area's colour slot.
 */
export function itemsOf(
  groups: readonly Group[],
  nodes: Nodes,
  slots: ReadonlyMap<string, number>,
): Items {
  const items: Item[] = [];
  let rows = 0;
  groups.forEach((group, g) => {
    // A flat group has no heading: its rows stand on their own.
    if (group.kind !== "flat") {
      items.push({ kind: "group", key: `g:${group.key}`, group, first: g === 0 });
    }
    for (const section of group.sections) {
      const sectionKey = `s:${section.key}`;
      if (section.title !== undefined) {
        items.push({ kind: "section", key: sectionKey, group: group.key, title: section.title });
      }
      section.tasks.forEach((task, i) => {
        const [area, project] = trail(nodes, task.parent);
        items.push({
          kind: "row",
          key: task.id,
          task,
          group: group.key,
          section: sectionKey,
          sectionKey: section.key,
          posinset: i + 1,
          setsize: section.tasks.length,
          area,
          slot: area === undefined ? undefined : slots.get(area.id),
          project,
          finished: group.finished === true,
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
