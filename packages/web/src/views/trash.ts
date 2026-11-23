// The Trash: the tasks moved there on purpose, read in pages because the live store never holds
// them (`task.trash`, newest change first, then by reference). Pure parts, so the order and the
// groups are unit tests: the page source, and one group per change that moved tasks there.
import type { Client } from "@ttasks/contracts/generated/client.ts";
import type { Group } from "../groups.ts";
import { taskRow, type TaskRow } from "../store/rows.ts";
import type { Page, PageSource } from "../store/queries.ts";
import type { HeldRow } from "./TaskList.tsx";

type Trash = Client["task"]["trash"];

/** The service's read of the Trash. */
export type TrashRead = (input: Parameters<Trash>[0]) => ReturnType<Trash>;

/** The change that moved a task to the Trash. */
export type Removal = Awaited<ReturnType<Trash>>["rows"][number]["removed"];

/** A task in the Trash as the list draws it: its row, where it was, and the change. */
export interface TrashedRow extends TaskRow {
  /** Its area's and project's names, a deleted one's too. */
  readonly area?: string;
  readonly project?: string;
  readonly removed?: Removal;
}

/** The most rows one read returns. */
const READ_MAX = 200;

/**
 * The Trash's page source: rows newest change first, those whose title holds every word of `q`
 * or whose reference it names. A restart reads the rows shown again, at least a page.
 */
export function trashSource(read: TrashRead, q: string): PageSource<TrashedRow> {
  return async ({ after, limit }): Promise<Page<TrashedRow>> => {
    const rows: TrashedRow[] = [];
    let cursor = after;
    while (rows.length < limit) {
      const page = await read({
        limit: Math.min(READ_MAX, limit - rows.length),
        ...(cursor === undefined ? {} : { cursor }),
        ...(q === "" ? {} : { q }),
      });
      for (const found of page.rows) {
        const row = taskRow(found);
        // The row keeps the read's own fields: where it was, and the change that moved it.
        if (row !== undefined) rows.push(row);
      }
      cursor = page.cursor;
      if (cursor === undefined) return { rows };
    }
    return cursor === undefined ? { rows } : { rows, next: cursor };
  };
}

const PREFIX = "x:";

/** How the page heads a change's group and takes it back whole. */
export interface ChangeFace {
  readonly title: (removal: Removal) => string;
  /** "Restore these": the change's tasks still in the Trash. */
  readonly restore: (removal: Removal) => { readonly label: string; readonly run: () => void };
}

/**
 * The Trash's groups: one per change, newest first, headed by who moved how many tasks there and
 * when, with "Restore these" when it moved more than one. A task restored since leaves its group.
 * `held` is the expanded task: it stays where it was shown until it is collapsed, also restored;
 * one the rows do not hold (a link named it) heads the list.
 */
export function trashGroups(
  rows: readonly TrashedRow[],
  face: ChangeFace,
  held?: HeldRow,
): Group[] {
  const groups = new Map<string, { removal?: Removal; tasks: TaskRow[] }>();
  const add = (key: string, removal: Removal | undefined, row: TaskRow, at?: number) => {
    const group = groups.get(key) ?? { ...(removal === undefined ? {} : { removal }), tasks: [] };
    group.tasks.splice(at === undefined ? group.tasks.length : at, 0, row);
    groups.set(key, group);
  };
  for (const row of rows) {
    if (row.removed === undefined) continue;
    // The expanded task's group keeps its place in the order; the task joins it below.
    if (row.id === held?.task.id) {
      if (!groups.has(row.removed.id))
        groups.set(row.removed.id, { removal: row.removed, tasks: [] });
      continue;
    }
    if (row.deleted_at === undefined) continue;
    add(row.removed.id, row.removed, row);
  }
  const out: Group[] = [];
  if (held !== undefined) {
    // Still in the Trash, its newest row is the page's; restored while expanded, the live one.
    const page = rows.find((row) => row.id === held.task.id);
    const row = held.task.deleted_at === undefined ? held.task : (page ?? held.task);
    const removal = page?.removed ?? (held.task as TrashedRow).removed;
    const shown =
      held.group?.startsWith(PREFIX) === true && held.group.length > PREFIX.length
        ? held.group.slice(PREFIX.length)
        : undefined;
    const key = shown ?? removal?.id;
    if (key === undefined) {
      out.push({ key: PREFIX, kind: "flat", sections: [{ key: PREFIX, tasks: [row] }] });
    } else {
      add(
        key,
        removal,
        row,
        shown === undefined
          ? undefined
          : Math.min(held.index ?? 0, groups.get(key)?.tasks.length ?? 0),
      );
    }
  }
  for (const [key, { removal, tasks }] of groups) {
    if (tasks.length === 0) continue;
    const many = removal !== undefined && removal.count > 1;
    out.push({
      key: `${PREFIX}${key}`,
      kind: "label",
      title: removal === undefined ? "" : face.title(removal),
      ...(many ? { action: face.restore(removal) } : {}),
      sections: [{ key: `${PREFIX}${key}`, tasks }],
    });
  }
  return out;
}
