// Search results from the top field: the pure parts, so the paging, the rows and the groups are
// unit tests. Open tasks and finished ones are two searches over `task.search`, each frozen at its
// first page by the service's cursor (queries.ts treats them as frozen), shown as two groups of
// one list: To do, then Completed. Every open match is read at once, because the space's open
// tasks are the live store's anyway; finished ones come a page at a time with "Show more".
//
// A row keeps the group it was found in. A task checked off from the results stays under To do,
// checked, until the person refreshes: results do not move under the pointer. A search that sorts
// by effort (`sort:effort`) splits To do into one group per effort, in the service's order.
import type { Client } from "@tasks/contracts/generated/client.ts";
import { filterOf, QUERY_KEYS } from "@tasks/contracts/query-terms";
import type { Group } from "../groups.ts";
import type { MessageId } from "../i18n/intl.tsx";
import type { Page, PageSource } from "../store/queries.ts";
import type { AreaRow, ProjectRow, TaskRow } from "../store/rows.ts";
import type { HeldRow } from "./TaskList.tsx";

type SearchResult = Awaited<ReturnType<Client["task"]["search"]>>;
export type SearchRow = SearchResult["rows"][number];
type SearchInput = Parameters<Client["task"]["search"]>[0];
export type Search = (input: SearchInput) => Promise<SearchResult>;

/** The most rows one call returns: the service's own limit. */
export const SEARCH_PAGE = 50;

/** Which of the two searches a row was found by. */
export type Found = "open" | "finished";

/**
 * A task row as a search found it. `found` and `foundEffort`, the effort the search sorted it by,
 * survive the feed's updates (`withTaskRow`), so a row keeps its group until the person refreshes.
 */
export type FoundRow = TaskRow & { readonly found: Found; readonly foundEffort?: string };

/**
 * A search row as a task row: its area and project found by name among the live ones, because a
 * search row names them and carries no IDs. It has no creation time or version either, so it is
 * older than any feed row and the feed's row replaces it. A task deleted or redacted since the
 * search ran keeps its place in the service's list, but has nothing to show.
 */
export function rowOfFound(
  row: SearchRow,
  found: Found,
  areas: ReadonlyMap<string, AreaRow>,
  projects: ReadonlyMap<string, ProjectRow>,
): FoundRow | undefined {
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
    // A finished task's row says how it ended in the summary's place, as in Completed. A completed
    // task has an ending only once it is wrapped up: the feed then keeps it while it stays so.
    ...(row.ending === undefined ? {} : { ending: row.ending }),
    ...(row.ending !== undefined && row.lifecycle === "completed" ? { wrap_state: "wrapped" } : {}),
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
    ...(row.completed === undefined ? {} : { completed_on: row.completed }),
    created_at: 0,
    version: 0,
    found,
    ...(row.effort === undefined ? {} : { foundEffort: row.effort }),
  };
}

export interface SourceOptions {
  readonly search: Search;
  readonly q: string;
  readonly found: Found;
  readonly rowOf: (row: SearchRow, found: Found) => FoundRow | undefined;
  /** Read every page at once (the open tasks), else one page per call. */
  readonly all?: boolean;
}

/** A paged source over one search: at least `limit` rows per page while there are more. */
export function searchSource(options: SourceOptions): PageSource<FoundRow> {
  const { search, q, found, rowOf } = options;
  const scope = found === "open" ? "active" : "finished";
  return async ({ after, limit }): Promise<Page<FoundRow>> => {
    const rows: FoundRow[] = [];
    let cursor = after;
    let first = after === undefined;
    // A page of the service holds the first page's limit; a refresh that shows more rows than
    // one page reads on until it has them.
    while (first || cursor !== undefined) {
      const page: SearchResult = first
        ? await search({ q, scope, limit: SEARCH_PAGE })
        : await search({ cursor: cursor });
      first = false;
      cursor = page.cursor;
      for (const row of page.rows) {
        const shown = rowOf(row, found);
        if (shown !== undefined) rows.push(shown);
      }
      if (options.all !== true && rows.length >= limit) break;
    }
    return cursor === undefined ? { rows } : { rows, next: cursor };
  };
}

/** Whether an error is the service saying a search cursor expired: the search starts again. */
export const isExpired = (error: unknown): boolean => codeOf(error) === "cursor_expired";

/** Whether an error is the service saying the space has no word index (an older space). */
export const isUnindexed = (error: unknown): boolean =>
  codeOf(error) === "space_unavailable" && dataOf(error)?.["reason"] === "not_indexed";

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

function dataOf(error: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}

/** The terms of a query as the service splits them: words, "phrases", filters and OR. */
interface Term {
  readonly text: string;
  readonly filter: boolean;
  /** A filter's key in lower case. */
  readonly key?: string;
  /** A filter's value, or a word's text, as written and without a negating `-`. */
  readonly value: string;
  readonly negated: boolean;
}

function termsOf(q: string): Term[] {
  const terms: Term[] = [];
  let i = 0;
  while (i < q.length) {
    if (/\s/u.test(q[i] ?? "")) {
      i += 1;
      continue;
    }
    const start = i;
    // A word runs to the next blank; a quote, at its start or after a filter's operator, runs to
    // the next quote ("" inside is one quote) or to the end.
    while (i < q.length && !/\s/u.test(q[i] ?? "")) {
      if (q[i] === '"') {
        i += 1;
        while (i < q.length) {
          if (q[i] === '"' && q[i + 1] === '"') i += 2;
          else if (q[i] === '"') break;
          else i += 1;
        }
      }
      i += 1;
    }
    const text = q.slice(start, i);
    const negated = text.length > 1 && text.startsWith("-");
    const body = negated ? text.slice(1) : text;
    const filter = filterOf(body);
    terms.push(
      filter === undefined
        ? { text, filter: false, value: body, negated }
        : { text, filter: true, key: filter.key, value: body.slice(filter.length), negated },
    );
  }
  return terms;
}

/** Whether a query has words besides its filters: the part an older space cannot search. */
export function hasWords(q: string): boolean {
  return termsOf(q).some((term) => !term.filter && term.text !== "OR");
}

const KEYS: ReadonlySet<string> = new Set(QUERY_KEYS);

/**
 * The words of a query as a task's title: its filters, `OR` and the words it leaves out (`-word`)
 * dropped, and a phrase without its quotes. A word that only looks like a filter (`https://…`,
 * `bug:123`) is the person's text and stays.
 */
export function wordsOf(q: string): string {
  return termsOf(q)
    .filter((term) => !term.negated && term.text !== "OR" && !KEYS.has(term.key ?? ""))
    .map((term) =>
      term.filter
        ? term.text
        : term.value.startsWith('"')
          ? term.value.replace(/^"|"$/gu, "").replaceAll('""', '"')
          : term.value,
    )
    .filter((word) => word !== "")
    .join(" ");
}

/** The query's filters alone, for a space without the word index. */
export function filtersOnly(q: string): string {
  const terms = termsOf(q);
  const kept: string[] = [];
  terms.forEach((term, i) => {
    if (term.filter) kept.push(term.text);
    else if (term.text === "OR" && terms[i - 1]?.filter === true && terms[i + 1]?.filter === true) {
      kept.push(term.text);
    }
  });
  return kept.join(" ");
}

/** A filter's key, as the service reads it, and the logical task fields it reads (A1's names). */
const FIELDS_OF: Readonly<Record<string, readonly string[]>> = {
  status: ["status"],
  p: ["priority"],
  effort: ["effort"],
  sort: ["effort"],
  due: ["due"],
  area: ["area", "grouping"],
  project: ["project", "grouping"],
  is: ["inbox", "focus", "due", "wrap"],
  on: ["grouping"],
  updated: ["*"],
};

/** Every logical field a task has: what a filter on any change reads. */
const EVERY_FIELD = [
  "title",
  "summary",
  "context",
  "status",
  "inbox",
  "priority",
  "effort",
  "planned_for",
  "focus",
  "owner",
  "waiting_on",
  "due",
  "grouping",
  "lifecycle",
  "wrap",
  "deleted",
];

/**
 * The task fields a search filters or sorts on, besides its text (`QueryDef.fields`): a change to
 * one of them may change what matches or its order, so the results offer a refresh. A query
 * without words is ordered by due date and priority.
 */
export function searchFields(q: string): readonly string[] {
  const fields = new Set<string>();
  const terms = termsOf(q);
  for (const term of terms) {
    if (!term.filter) continue;
    for (const field of FIELDS_OF[term.key ?? ""] ?? []) {
      if (field === "*") for (const each of EVERY_FIELD) fields.add(each);
      else fields.add(field);
    }
  }
  if (!terms.some((term) => !term.filter && term.text !== "OR")) {
    fields.add("due");
    fields.add("priority");
  }
  return [...fields];
}

/**
 * Whether the query sorts by effort, as the service reads it (`sort=` too, the value quoted or
 * not): its open results are then grouped by effort.
 */
export function sortsByEffort(q: string): boolean {
  return termsOf(q).some(
    (term) => term.key === "sort" && !term.negated && /^("?)-?effort\1$/iu.test(term.value),
  );
}

const LABEL: Readonly<Record<Found, MessageId>> = {
  open: "search.tasks",
  finished: "search.completed",
};

interface Shown {
  readonly key: string;
  readonly label: MessageId;
  readonly labelValues?: Readonly<Record<string, string>>;
  readonly tasks: TaskRow[];
}

/**
 * The results as the list's groups: To do, then Completed, each hidden when empty. With
 * `byEffort`, To do is one group per effort, as the search found it, in the search's order. A row
 * the live store holds is shown with the store's row, which carries the person's edits at once;
 * another with the search's row, which the feed keeps current. `held` is the expanded task, kept at
 * its place when a refresh no longer finds it.
 */
export function searchGroups(
  open: readonly FoundRow[],
  finished: readonly FoundRow[],
  live: ReadonlyMap<string, TaskRow>,
  held?: HeldRow,
  byEffort = false,
): Group[] {
  const shown = (row: FoundRow): TaskRow => live.get(row.id) ?? row;
  // One group per effort, in the order the search first met each: an effort the space's scale no
  // longer has sorts with the tasks that have none, so its rows need not be next to each other.
  const byKey = new Map<string, Shown>();
  for (const row of open) {
    const effort = row.foundEffort;
    const key = byEffort ? `s:open:${effort ?? ""}` : "s:open";
    let group = byKey.get(key);
    if (group === undefined) {
      group = !byEffort
        ? { key, label: LABEL.open, tasks: [] }
        : effort === undefined
          ? { key, label: "search.noEffort", tasks: [] }
          : { key, label: "search.effort", labelValues: { effort }, tasks: [] };
      byKey.set(key, group);
    }
    group.tasks.push(shown(row));
  }
  const groups = [...byKey.values()];
  // The two searches are separate snapshots, so one task can be in both (checked off from the
  // results, then Completed read again): it stays where the person saw it first.
  const inOpen = new Set(open.map((row) => row.id));
  const done: Shown = {
    key: "s:finished",
    label: LABEL.finished,
    tasks: finished.filter((row) => !inOpen.has(row.id)).map(shown),
  };
  groups.push(done);
  if (held !== undefined && ![...open, ...finished].some((row) => row.id === held.task.id)) {
    let into = groups.find((group) => group.key === held.group);
    if (into === undefined) {
      into = groups[0] === done ? { key: "s:open", label: LABEL.open, tasks: [] } : groups[0];
      if (into !== undefined && !groups.includes(into)) groups.unshift(into);
    }
    into?.tasks.splice(Math.min(held.index ?? 0, into.tasks.length), 0, held.task);
  }
  return groups
    .filter((group) => group.tasks.length > 0)
    .map((group): Group => ({
      key: group.key,
      kind: "section",
      label: group.label,
      ...(group.labelValues === undefined ? {} : { labelValues: group.labelValues }),
      sections: [{ key: group.key, tasks: group.tasks }],
    }));
}
