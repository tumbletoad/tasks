// Completed: finished tasks, read in pages because the live store never holds them. Pure parts, so
// the order and the groups are unit tests: the page source over `task.search` and the grouping
// into "Checked off" and one group per completion month.
//
// The search orders a query without words by due date, and one search holds at most 1,000 tasks.
// So the source reads month windows and orders each by completion day, newest first, keeping the
// search's order among equal days. First the checked-off tasks (completed, wrap-up still pending:
// `is:unwrapped`), month by month, then every other finished task, month by month. Each run of
// months starts at this month, open-ended so a task completed by another clock's tomorrow still
// shows, and steps back only while something of its kind was completed earlier, so it ends after
// its oldest month and an empty month costs one read.
//
// A page is one or more whole windows: at least as many rows as the page asked for, unless the
// windows ran out. The cursor names the next window. A window shows at most the 1,000 tasks one
// search holds: more of one kind completed in one month is the limit.
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

/** The most rows one search call returns. */
const SEARCH_PAGE = 50;
/** How many windows one page reads at most: a guard, never reached by a real space. */
const MAX_WINDOWS = 2_400;

/** Completed tasks whose wrap-up is still pending: the checked-off list. */
export const CHECKED_OFF_QUERY = "is:unwrapped";

/** The two runs of windows, in the order the list shows them. */
export type WindowKind = "checked" | "done";

const KIND_TERM: Readonly<Record<WindowKind, string>> = {
  checked: CHECKED_OFF_QUERY,
  done: `-${CHECKED_OFF_QUERY}`,
};

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
 * A month's window of one kind. The newest one (`open`) has no end, so a task completed later than
 * the page's today (another clock) still shows.
 */
export function monthQuery(kind: WindowKind, month: string, open: boolean): string {
  const terms = [KIND_TERM[kind], `completed>=${month}-01`];
  if (!open) terms.push(`completed<${monthAfter(month)}-01`);
  return terms.join(" ");
}

/** Whether a finished task of this kind was completed before `month` began. */
export const earlierQuery = (kind: WindowKind, month: string): string =>
  [KIND_TERM[kind], `completed<${month}-01`].join(" ");

/** Where the next page starts: a kind, a month, and whether it is the newest (open-ended) one. */
interface Cursor {
  readonly kind: WindowKind;
  readonly month: string;
  readonly open: boolean;
}

const CURSOR = /^([cd])(\d{4}-\d{2})(\+?)$/;

const cursorText = (at: Cursor): string =>
  `${at.kind === "checked" ? "c" : "d"}${at.month}${at.open ? "+" : ""}`;

function cursorOf(text: string): Cursor | undefined {
  const match = CURSOR.exec(text);
  if (match === null) return undefined;
  return {
    kind: match[1] === "c" ? "checked" : "done",
    month: match[2] ?? "",
    open: match[3] === "+",
  };
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
  // Without words the snippet is the summary.
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
    const thisMonth = today.slice(0, 7);
    const rows: TaskRow[] = [];
    let at: Cursor | undefined =
      after === undefined ? { kind: "checked", month: thisMonth, open: true } : cursorOf(after);
    if (at === undefined) return { rows };
    for (let step = 0; step < MAX_WINDOWS; step += 1) {
      const checked = at.kind === "checked";
      rows.push(...(await window(monthQuery(at.kind, at.month, at.open), checked, timeZone)));
      const earlier = await search({
        q: earlierQuery(at.kind, at.month),
        scope: "finished",
        limit: 1,
      });
      if (earlier.total !== 0) at = { kind: at.kind, month: monthBefore(at.month), open: false };
      else if (checked) at = { kind: "done", month: thisMonth, open: true };
      else return { rows };
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
 * Completed's groups: "Checked off" first, then one group per completion month, newest
 * first, each in the order the rows came in. `held` is the expanded task when the rows do not hold
 * it (a link named it, or it left the list while expanded): it sits at the top of its group.
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
