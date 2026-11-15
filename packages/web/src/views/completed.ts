// Completed (A5 3.5): finished tasks, read in pages because the live store never holds them (A5
// 3.25). Pure parts, so the order and the groups are unit tests: the page source over `task.search`
// and the grouping into "Checked off" and one group per completion month.
//
// The source reads whole windows, so a window's order is the completion date's, newest first,
// whatever order the search returns them in (it orders without words by due date, A3 3.9.3):
//
// 1. "Checked off": completed tasks whose outcome is still missing (`is:unwrapped`).
// 2. Then one window per completion month, newest first: this month from its first day on, then
//    each month before it. Before it steps back a month it asks whether anything was completed
//    earlier at all, so it ends after the oldest month, and empty months cost one read each.
//
// A page is one or more whole windows: at least as many rows as the page asked for, unless the
// windows ran out. The cursor names the next month to read. A window holds at most the 1,000 tasks
// a search freezes (A3 3.9.5); more than that in one month is a limit stated in A5 3.5.
import type { Client } from "@tasks/contracts/generated/client.ts";
import type { MessageId } from "../i18n/intl.tsx";
import type { Group } from "../groups.ts";
import { completedDayOf } from "../row/model.ts";
import { formatDay, type Clock } from "../row/dates.ts";
import type { AreaRow, ProjectRow, TaskRow } from "../store/rows.ts";
import type { Page, PageSource } from "../store/queries.ts";

type SearchResult = Awaited<ReturnType<Client["task"]["search"]>>;
type SearchRow = SearchResult["rows"][number];
type SearchInput = Parameters<Client["task"]["search"]>[0];

/** The search entry the source reads through. */
export type Search = (input: SearchInput) => Promise<SearchResult>;

/** The most rows one search call returns (A3 3.4.3). */
const SEARCH_PAGE = 50;
/** How far back the source steps at most: a guard, never reached by a real space. */
const MAX_MONTHS = 1_200;

/** Completed tasks whose outcome is still missing: the checked-off list (A1, A5 3.5). */
export const CHECKED_OFF_QUERY = "is:unwrapped";
/** Every other finished task: the month windows. */
const NOT_CHECKED_OFF = `-${CHECKED_OFF_QUERY}`;

const MONTH = /^(\d{4})-(\d{2})$/;

/** The month before `YYYY-MM`. */
export function monthBefore(month: string): string {
  const match = MONTH.exec(month);
  const year = Number(match?.[1] ?? 1970);
  const m = Number(match?.[2] ?? 1);
  return m === 1
    ? `${String(year - 1).padStart(4, "0")}-12`
    : `${String(year).padStart(4, "0")}-${String(m - 1).padStart(2, "0")}`;
}

/** The month after `YYYY-MM`. */
export function monthAfter(month: string): string {
  const match = MONTH.exec(month);
  const year = Number(match?.[1] ?? 1970);
  const m = Number(match?.[2] ?? 1);
  return m === 12
    ? `${String(year + 1).padStart(4, "0")}-01`
    : `${String(year).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * A month's window. The newest one (`open`) has no end, so a task completed later than the
 * page's today (another clock) still shows.
 */
export function monthQuery(month: string, open: boolean): string {
  const terms = [NOT_CHECKED_OFF, `completed>=${month}-01`];
  if (!open) terms.push(`completed<${monthAfter(month)}-01`);
  return terms.join(" ");
}

/** Whether a finished task was completed before `month` began, outside the checked-off list. */
export const earlierQuery = (month: string): string =>
  [NOT_CHECKED_OFF, `completed<${month}-01`].join(" ");

/** Where the next page starts: a month, and whether it is the newest (open-ended) one. */
interface Cursor {
  readonly month: string;
  readonly open: boolean;
}

const CURSOR = /^(\d{4}-\d{2})(\+?)$/;

const cursorText = (at: Cursor): string => `${at.month}${at.open ? "+" : ""}`;

function cursorOf(text: string): Cursor | undefined {
  const match = CURSOR.exec(text);
  return match === null ? undefined : { month: match[1] ?? "", open: match[2] === "+" };
}

/**
 * A finished task's row from a search row: its area and project found by their names among the
 * live ones, as the task route's read does. Search rows carry no creation time or version: the
 * feed's row replaces this one when the task changes (queries.ts).
 */
export function rowOfSearch(
  row: SearchRow,
  areas: ReadonlyMap<string, AreaRow>,
  projects: ReadonlyMap<string, ProjectRow>,
  checkedOff: boolean,
): TaskRow | undefined {
  if (row.kind !== "task") return undefined;
  const area = [...areas.values()].find((a) => a.title === row.area);
  const project = [...projects.values()].find(
    (p) => p.title === row.project && (area === undefined || p.area_id === area.id),
  );
  const due = row.due;
  // Without words the snippet is the summary (A3 3.9.4).
  const summary = row.snippet_from === undefined ? row.snippet : undefined;
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    ...(summary === undefined || summary === "" ? {} : { summary }),
    status: row.status,
    inbox: row.inbox,
    lifecycle: row.lifecycle,
    priority: row.priority,
    ...(row.effort === undefined ? {} : { effort: row.effort }),
    ...(typeof due === "string" ? { due_date: due } : {}),
    ...(typeof due === "object" ? { due_at: Date.parse(due.at), due_tz: due.tz } : {}),
    ...(area === undefined ? {} : { area_id: area.id }),
    ...(project === undefined ? {} : { project_id: project.id }),
    position: "",
    ...(checkedOff ? { wrap_state: "pending" } : {}),
    ...(row.completed === undefined ? {} : { completed_on: row.completed }),
    created_at: 0,
    version: 0,
  };
}

/** Newest completion first; a stable sort keeps the search's order among equal days. */
const byCompletion =
  (timeZone: string) =>
  (a: TaskRow, b: TaskRow): number => {
    const da = completedDayOf(a, timeZone) ?? "";
    const db = completedDayOf(b, timeZone) ?? "";
    return da < db ? 1 : da > db ? -1 : 0;
  };

export interface CompletedSourceOptions {
  readonly search: Search;
  /** The viewer's today and zone, read when a page is read (the first month is today's). */
  readonly clock: () => Pick<Clock, "today" | "timeZone">;
  /** A search row as a task row: the live areas and projects name its group. */
  readonly rowOf: (row: SearchRow, checkedOff: boolean) => TaskRow | undefined;
}

/** The Completed list's page source over `task.search` (see the head of this file). */
export function completedSource(options: CompletedSourceOptions): PageSource<TaskRow> {
  const { search, rowOf } = options;
  /** Every row of one window, in completion order. */
  const window = async (q: string, checkedOff: boolean, timeZone: string): Promise<TaskRow[]> => {
    const rows: TaskRow[] = [];
    let cursor: string | undefined;
    do {
      const page: SearchResult = await search(
        cursor === undefined
          ? { q, scope: "finished", limit: SEARCH_PAGE }
          : { cursor, limit: SEARCH_PAGE },
      );
      for (const found of page.rows) {
        const row = rowOf(found, checkedOff);
        if (row !== undefined) rows.push(row);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return rows.sort(byCompletion(timeZone));
  };

  return async ({ after, limit }): Promise<Page<TaskRow>> => {
    const { today, timeZone } = options.clock();
    const rows: TaskRow[] = [];
    let at: Cursor | undefined = after === undefined ? undefined : cursorOf(after);
    if (after !== undefined && at === undefined) return { rows };
    if (at === undefined) {
      rows.push(...(await window(CHECKED_OFF_QUERY, true, timeZone)));
      at = { month: today.slice(0, 7), open: true };
    }
    for (let step = 0; step < MAX_MONTHS; step += 1) {
      rows.push(...(await window(monthQuery(at.month, at.open), false, timeZone)));
      const earlier = await search({ q: earlierQuery(at.month), scope: "finished", limit: 1 });
      if (earlier.total === 0) return { rows };
      at = { month: monthBefore(at.month), open: false };
      if (rows.length >= limit) return { rows, next: cursorText(at) };
    }
    return { rows };
  };
}

/** The group a finished row belongs to: the checked-off list, or its completion month. */
export function completedGroupOf(row: TaskRow, timeZone: string): string {
  if (row.lifecycle === "completed" && row.wrap_state === "pending") return "checked";
  return completedDayOf(row, timeZone)?.slice(0, 7) ?? "";
}

const CHECKED_LABEL: MessageId = "group.checkedOff";

/**
 * Completed's groups (A5 3.5): "Checked off" first, then one group per completion month, newest
 * first, each in the order the rows came in. `held` is the expanded task when the rows do not hold
 * it (a link named it, or it left the list while expanded): it sits at the top of its group (A5 3.3).
 */
export function completedGroups(
  rows: readonly TaskRow[],
  clock: Pick<Clock, "today" | "timeZone" | "locale">,
  held?: TaskRow,
): Group[] {
  const buckets = new Map<string, TaskRow[]>();
  const add = (row: TaskRow, first: boolean) => {
    const key = completedGroupOf(row, clock.timeZone);
    const list = buckets.get(key) ?? [];
    if (first) list.unshift(row);
    else list.push(row);
    buckets.set(key, list);
  };
  for (const row of rows) add(row, false);
  if (held !== undefined && !rows.some((row) => row.id === held.id)) add(held, true);
  const year = clock.today.slice(0, 4);
  return [...buckets]
    .sort(([a], [b]) => (a === "checked" ? -1 : b === "checked" ? 1 : a < b ? 1 : a > b ? -1 : 0))
    .map(([key, tasks]): Group => {
      const section = [{ key: `c:${key}`, tasks }];
      if (key === "checked") {
        return { key: "c:checked", kind: "label", label: CHECKED_LABEL, sections: section };
      }
      // A month of this year by its name, another with its year; a row with no date, untitled.
      const title =
        key === ""
          ? ""
          : formatDay(`${key}-01`, clock.locale, {
              month: "long",
              ...(key.startsWith(year) ? {} : { year: "numeric" }),
            });
      return { key: `c:${key}`, kind: key === "" ? "flat" : "label", title, sections: section };
    });
}
