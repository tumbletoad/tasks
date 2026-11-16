// Completed: finished tasks, read in pages because the live store never holds them. Pure parts, so
// the order and the groups are unit tests: the page source over the service's read of finished
// tasks (`task.finished`, newest first by the time each was finished), and the groups.
//
// "Checked off" (completed, its wrap-up still waiting) sits on top, so the source reads that part
// whole first, then every other finished task. A page may cross from one part to the other; its
// cursor names the part and the read's own cursor there.
import type { Client } from "@tasks/contracts/generated/client.ts";
import type { MessageId } from "../i18n/intl.tsx";
import type { Group } from "../groups.ts";
import { finishedDayOf } from "../row/model.ts";
import { formatDay, type Clock } from "../row/dates.ts";
import { taskRow, type TaskRow } from "../store/rows.ts";
import type { Page, PageSource } from "../store/queries.ts";
import type { HeldRow } from "./TaskList.tsx";

type Finished = Client["task"]["finished"];

/** The service's read of finished tasks. */
export type FinishedRead = (input: Parameters<Finished>[0]) => ReturnType<Finished>;

/** The most rows one read returns. */
const READ_MAX = 200;

/** `c`: the checked-off part, `d`: the rest; then the read's cursor in that part, if any. */
const CURSOR = /^([cd]):(.*)$/;

/** The Completed list's page source: the checked-off part whole, then the rest. */
export function completedSource(read: FinishedRead): PageSource<TaskRow> {
  return async ({ after, limit }): Promise<Page<TaskRow>> => {
    let part = "c";
    let cursor: string | undefined;
    if (after !== undefined) {
      const match = CURSOR.exec(after);
      if (match === null) return { rows: [] };
      part = match[1] ?? "d";
      cursor = match[2] === "" ? undefined : match[2];
    }
    const rows: TaskRow[] = [];
    while (rows.length < limit) {
      const page = await read({
        checked_off: part === "c",
        limit: Math.min(READ_MAX, limit - rows.length),
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const found of page.rows) {
        const row = taskRow(found);
        if (row !== undefined) rows.push(row);
      }
      cursor = page.cursor;
      if (cursor !== undefined) continue;
      if (part === "d") return { rows };
      part = "d";
    }
    return { rows, next: `${part}:${cursor ?? ""}` };
  };
}

const CHECKED = "checked";

/**
 * The group a finished row belongs to: the checked-off list, or the month it was finished in.
 * Undefined once it is no longer finished (reopened, or deleted): it leaves the list.
 */
export function completedGroupOf(row: TaskRow, timeZone: string): string | undefined {
  if (row.lifecycle === "active" || row.deleted_at !== undefined) return undefined;
  if (row.lifecycle === "completed" && row.wrap_state === "pending") return CHECKED;
  return finishedDayOf(row, timeZone)?.slice(0, 7) ?? "";
}

const CHECKED_LABEL: MessageId = "group.checkedOff";
const PREFIX = "c:";

/**
 * Completed's groups: "Checked off" first, then one group per month, newest first, each in the
 * order the rows came in. A dropped task sits in the month it was dropped in, its row marked so.
 * `held` is the expanded task: it stays in the group and at the place it was shown, also when it
 * was reopened or the rows do not hold it (a link named it); without a place, at the top of its
 * group.
 */
export function completedGroups(
  rows: readonly TaskRow[],
  clock: Pick<Clock, "today" | "timeZone" | "locale">,
  held?: HeldRow,
): Group[] {
  const buckets = new Map<string, TaskRow[]>();
  const add = (key: string, row: TaskRow, at?: number) => {
    const list = buckets.get(key) ?? [];
    list.splice(at === undefined ? list.length : Math.min(at, list.length), 0, row);
    buckets.set(key, list);
  };
  let placed = held === undefined;
  let heldRow = held?.task;
  // The untitled group holds only a row without its finish time: a link's row read before the
  // page. Its place there is no place to keep once the page's row names the month.
  const index = held?.group === PREFIX ? undefined : held?.index;
  for (const row of rows) {
    const key = completedGroupOf(row, clock.timeZone);
    if (row.id === held?.task.id) {
      // Reopened or deleted: the held row, the newest, goes back where it was shown, below.
      if (key === undefined) continue;
      // Still finished: the page's row is whole (a link's row has no finish time).
      heldRow = row;
      if (index !== undefined) continue;
      placed = true;
    }
    if (key !== undefined) add(key, row);
  }
  if (held !== undefined && heldRow !== undefined && !placed) {
    const shown =
      index !== undefined && held.group?.startsWith(PREFIX) === true
        ? held.group.slice(PREFIX.length)
        : undefined;
    add(shown ?? completedGroupOf(heldRow, clock.timeZone) ?? "", heldRow, index ?? 0);
  }
  const year = clock.today.slice(0, 4);
  return [...buckets]
    .sort(([a], [b]) => (a === CHECKED ? -1 : b === CHECKED ? 1 : a < b ? 1 : a > b ? -1 : 0))
    .map(([key, tasks]): Group => {
      const section = [{ key: `${PREFIX}${key}`, tasks }];
      if (key === CHECKED) {
        return {
          key: `${PREFIX}${CHECKED}`,
          kind: "label",
          label: CHECKED_LABEL,
          sections: section,
        };
      }
      // A month of this year by its name, another with its year; a row with no date, untitled.
      const title =
        key === ""
          ? ""
          : formatDay(`${key}-01`, clock.locale, {
              month: "long",
              ...(key.startsWith(year) ? {} : { year: "numeric" }),
            });
      return {
        key: `${PREFIX}${key}`,
        kind: key === "" ? "flat" : "label",
        title,
        sections: section,
      };
    });
}
