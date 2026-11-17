// The search results' pure parts (search.ts): the source over `task.search` and its cursors, an
// expired cursor that starts the search again, the two groups and how they keep their rows, and
// what an older space without the word index can still search.
import { describe, expect, test } from "vitest";
import { PagedQuery } from "../store/queries.ts";
import { withTaskRow, type TaskRow } from "../store/rows.ts";
import {
  filtersOnly,
  hasWords,
  isExpired,
  isUnindexed,
  rowOfFound,
  searchFields,
  searchGroups,
  searchSource,
  sortsByEffort,
  wordsOf,
  type FoundRow,
  type Search,
  type SearchRow,
} from "./search.ts";

const AREAS = new Map([["a_home", { id: "a_home", title: "Home", position: "a" }]]);
const PROJECTS = new Map([
  ["p_garden", { id: "p_garden", area_id: "a_home", title: "Garden", position: "a" }],
]);

const taskRow = (n: number, more: Partial<SearchRow> = {}): SearchRow =>
  ({
    kind: "task",
    id: `t_${String(n).padStart(26, "0")}`,
    ref: `M-${String(n)}`,
    title: `Fixture result ${String(n)}`,
    lifecycle: "active",
    status: "open",
    inbox: false,
    priority: 4,
    ...more,
  }) as SearchRow;

/** A fake `task.search` over `total` rows, pages of the first call's limit, cursors `c_<n>`. */
function fakeSearch(total: number, options: { expireOnce?: boolean } = {}) {
  const calls: Parameters<Search>[0][] = [];
  let limit = 0;
  let expire = options.expireOnce === true;
  const search: Search = (input) => {
    calls.push(input);
    if (input.cursor !== undefined && expire) {
      expire = false;
      return Promise.reject(Object.assign(new Error("expired"), { code: "cursor_expired" }));
    }
    if (input.cursor === undefined) limit = input.limit ?? 15;
    const offset = input.cursor === undefined ? 0 : Number(input.cursor.slice(2));
    const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) =>
      taskRow(offset + i + 1),
    );
    const next = offset + limit;
    return Promise.resolve({
      as_of: "1:x:1",
      scope: "active",
      parsed: input.q ?? "",
      total,
      first: offset + 1,
      rows,
      ...(next < total ? { cursor: `c_${String(next)}` } : {}),
    });
  };
  return { search, calls };
}

const rowOf = (row: SearchRow, found: "open" | "finished") =>
  rowOfFound(row, found, AREAS, PROJECTS);

describe("[A5.3.13.web.search] search results read in pages, frozen, in two groups", () => {
  test("the open tasks are read at once; finished ones a page at a time with their cursor", async () => {
    const open = fakeSearch(120);
    const all = await searchSource({
      search: open.search,
      q: "fence",
      found: "open",
      rowOf,
      all: true,
    })({
      after: undefined,
      limit: 50,
    });
    expect(all.rows).toHaveLength(120);
    expect(all.next).toBeUndefined();
    expect(open.calls[0]).toEqual({ q: "fence", scope: "active", limit: 50 });
    expect(open.calls.slice(1)).toEqual([{ cursor: "c_50" }, { cursor: "c_100" }]);

    const done = fakeSearch(120);
    const source = searchSource({ search: done.search, q: "fence", found: "finished", rowOf });
    const first = await source({ after: undefined, limit: 50 });
    expect(first.rows).toHaveLength(50);
    expect(first.next).toBe("c_50");
    expect(done.calls[0]).toMatchObject({ scope: "finished" });
    // A refresh that shows more than one page reads on until it has them.
    const again = await source({ after: undefined, limit: 80 });
    expect(again.rows).toHaveLength(100);
    expect(again.next).toBe("c_100");
  });

  test("an expired cursor starts the search again, with the rows shown and one page more", async () => {
    const fake = fakeSearch(200, { expireOnce: true });
    const source = searchSource({ search: fake.search, q: "fence", found: "finished", rowOf });
    const query = new PagedQuery({ kind: "search" }, source, { expired: isExpired });
    await query.refresh();
    expect(query.getState().rows).toHaveLength(50);
    await query.more();
    expect(query.getState()).toMatchObject({ phase: "ready", more: true });
    expect(query.getState().rows).toHaveLength(100);
    // The restart was a first page: a query, not a cursor.
    expect(fake.calls.filter((call) => call.cursor === undefined)).toHaveLength(2);
    // Any other failure is shown as one.
    const broken = new PagedQuery(
      { kind: "search" },
      () => Promise.reject(Object.assign(new Error("down"), { code: "service_unavailable" })),
      { expired: isExpired },
    );
    await broken.refresh();
    expect(broken.getState()).toMatchObject({ phase: "failed" });
    expect(isExpired(broken.getState().error)).toBe(false);
  });

  test("a row keeps its group, shows the live row when the store holds it, and a gone one is left out", () => {
    const open = [rowOf(taskRow(1), "open"), rowOf(taskRow(2), "open")] as FoundRow[];
    const done = [
      rowOf(taskRow(3, { lifecycle: "completed", area: "Home", project: "Garden" }), "finished"),
    ] as FoundRow[];
    expect(done[0]).toMatchObject({ area_id: "a_home", project_id: "p_garden", version: 0 });
    expect(rowOf({ kind: "deleted", id: "t_x", ref: "M-9" }, "open")).toBeUndefined();
    const live = new Map<string, TaskRow>([
      [open[0]?.id ?? "", { ...(open[0] as TaskRow), title: "Edited at once", version: 3 }],
    ]);
    const groups = searchGroups(open, done, live);
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ["s:open", "search.tasks"],
      ["s:finished", "search.completed"],
    ]);
    expect(groups[0]?.sections[0]?.tasks.map((t) => t.title)).toEqual([
      "Edited at once",
      "Fixture result 2",
    ]);
    // A task checked off from the results is no longer live; it stays under To do.
    const checked = { ...(open[1] as FoundRow), lifecycle: "completed" };
    expect(
      searchGroups([open[0] as FoundRow, checked], [], new Map())[0]?.sections[0]?.tasks,
    ).toHaveLength(2);
    // An empty group is hidden.
    expect(searchGroups([], done, new Map()).map((g) => g.key)).toEqual(["s:finished"]);
  });

  test("a finished row carries how it ended, for the summary's place; a summary without a match stays", () => {
    const dropped = rowOf(
      taskRow(4, { lifecycle: "archived", ending: "Not needed after all." }),
      "finished",
    );
    expect(dropped).toMatchObject({ ending: "Not needed after all." });
    expect(dropped).not.toHaveProperty("summary");
    const noted = rowOf(
      taskRow(5, {
        lifecycle: "completed",
        snippet: "A word in a note",
        snippet_from: "note",
        ending: "Shipped.",
      }),
      "finished",
    );
    expect(noted).toMatchObject({ ending: "Shipped." });
    expect(noted).not.toHaveProperty("summary");
    expect(rowOf(taskRow(6, { snippet: "Its summary." }), "open")).toMatchObject({
      summary: "Its summary.",
    });
  });

  test("a found task's ending stays while it stays finished, and goes when it is reopened", async () => {
    const found = rowOf(
      taskRow(7, { lifecycle: "completed", ending: "Shipped." }),
      "finished",
    ) as FoundRow;
    const query = new PagedQuery<FoundRow>({ kind: "search" }, () =>
      Promise.resolve({ rows: [found] }),
    );
    await query.refresh();
    // The feed's compact row: a task's columns, no ending and no group.
    const columns = Object.fromEntries(
      Object.entries(found).filter(([key]) => !["ending", "found", "wrap_state"].includes(key)),
    );
    const feed = (version: number, more: Record<string, unknown>) => ({
      changes: [
        {
          type: "task",
          id: found.id,
          changed: ["priority"],
          after: { ...columns, version, ...more },
        },
      ],
      reset: false,
    });
    // An edit that keeps it wrapped up keeps how it ended.
    query.apply(feed(2, { lifecycle: "completed", wrap_state: "wrapped" }) as never);
    expect(query.getState().rows[0]?.ending).toBe("Shipped.");
    // Reopened, then checked off again without an outcome: that ending was an earlier finish's.
    query.apply(feed(3, { lifecycle: "active" }) as never);
    query.apply(feed(4, { lifecycle: "completed", wrap_state: "pending" }) as never);
    expect(query.getState().rows[0]?.ending).toBeUndefined();
    expect(query.getState().rows[0]?.found).toBe("finished");
  });

  test("a task both searches found shows once, where it was first: under To do", () => {
    // Checked off from the results, then Completed read again after its cursor expired.
    const open = [1, 2].map((n) => rowOf(taskRow(n), "open") as FoundRow);
    const done = [2, 3].map(
      (n) => rowOf(taskRow(n, { lifecycle: "completed" }), "finished") as FoundRow,
    );
    const groups = searchGroups(open, done, new Map());
    const refs = groups.map((g) => g.sections[0]?.tasks.map((t) => t.ref));
    expect(refs).toEqual([["M-1", "M-2"], ["M-3"]]);
  });

  test("the expanded task stays at its place when a refresh no longer finds it", () => {
    const open = [1, 2, 3].map((n) => rowOf(taskRow(n), "open") as FoundRow);
    const gone = open[1] as FoundRow;
    const groups = searchGroups([open[0] as FoundRow, open[2] as FoundRow], [], new Map(), {
      task: gone,
      group: "s:open",
      index: 1,
    });
    expect(groups[0]?.sections[0]?.tasks.map((t) => t.ref)).toEqual(["M-1", "M-2", "M-3"]);
  });

  test("an older space without the word index still filters: the words come out, the filters stay", () => {
    expect(hasWords("fence status:open")).toBe(true);
    expect(hasWords('"time zone"')).toBe(true);
    expect(hasWords("status:open OR status:waiting p<=2")).toBe(false);
    expect(filtersOnly('fence "time zone" status:open p<=2 -is:inbox area:"Client work"')).toBe(
      'status:open p<=2 -is:inbox area:"Client work"',
    );
    expect(filtersOnly("status:open OR status:waiting")).toBe("status:open OR status:waiting");
    expect(filtersOnly("fence OR gate")).toBe("");
    expect(filtersOnly("10:30 standup")).toBe("");
    const unindexed = Object.assign(new Error("no index"), {
      code: "space_unavailable",
      data: { reason: "not_indexed", retryable: false },
    });
    expect(isUnindexed(unindexed)).toBe(true);
    expect(isUnindexed(Object.assign(new Error("busy"), { code: "space_unavailable" }))).toBe(
      false,
    );
  });

  test("a search sorted by effort shows To do as one group per effort, in the search's order", () => {
    expect(sortsByEffort("fence sort:effort")).toBe(true);
    expect(sortsByEffort("sort:-Effort")).toBe(true);
    expect(sortsByEffort("fence effort:S")).toBe(false);
    expect(sortsByEffort('"sort:effort"')).toBe(false);
    for (const q of ["sort=effort", 'sort:"-effort"']) {
      expect(sortsByEffort(q)).toBe(true);
    }
    // No key of the query language: the service refuses it, and nothing is sorted.
    expect(sortsByEffort("order:effort")).toBe(false);
    // The search's order: S, S, L, then XL (no longer in the scale) among the tasks without one.
    const found = (
      [
        [1, "S"],
        [2, "S"],
        [3, "L"],
        [6, "XL"],
        [4, undefined],
        [7, "XL"],
      ] as const
    ).map(
      ([n, effort]) =>
        rowOf(taskRow(n, effort === undefined ? {} : { effort }), "open") as FoundRow,
    );
    // The feed brings an edit of the second task's effort; the store has the first one's edit.
    const open = found.map((row, i) =>
      i === 1 ? withTaskRow(row, { ...taskRow(2, { effort: "L" }), version: 2 }) : row,
    );
    const done = [rowOf(taskRow(5, { lifecycle: "completed", effort: "M" }), "finished")];
    const live = new Map<string, TaskRow>([
      [open[0]?.id ?? "", { ...(open[0] as TaskRow), effort: "L", version: 2 }],
    ]);
    const groups = searchGroups(open, done as FoundRow[], live, undefined, true);
    // Each row stays in the group it was found in, and each effort is one group.
    expect(groups.map((g) => [g.label, g.labelValues])).toEqual([
      ["search.effort", { effort: "S" }],
      ["search.effort", { effort: "L" }],
      ["search.effort", { effort: "XL" }],
      ["search.noEffort", undefined],
      ["search.completed", undefined],
    ]);
    expect(groups.map((g) => g.sections[0]?.tasks.map((t) => t.ref))).toEqual([
      ["M-1", "M-2"],
      ["M-3"],
      ["M-6", "M-7"],
      ["M-4"],
      ["M-5"],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
    // The edits show on the rows.
    expect(groups[0]?.sections[0]?.tasks.map((t) => t.effort)).toEqual(["L", "L"]);
    // The expanded task a refresh no longer finds stays in its effort's group.
    const kept = searchGroups(
      [open[0], open[2], open[3]] as FoundRow[],
      [],
      new Map(),
      { task: open[1] as TaskRow, group: groups[0]?.key ?? "", index: 1 },
      true,
    );
    expect(kept[0]?.sections[0]?.tasks.map((t) => t.ref)).toEqual(["M-1", "M-2"]);
    expect(searchFields("fence sort:effort")).toEqual(["effort"]);
  });

  test("a filter written with = is a filter where the service reads one, and a word elsewhere", () => {
    expect(hasWords("p=3")).toBe(false);
    expect(hasWords("sort=effort fence")).toBe(true);
    expect(filtersOnly("fence p=3 sort=effort")).toBe("p=3 sort=effort");
    expect(searchFields("fence p=3")).toEqual(["priority"]);
    // Behind a word that is no key, = is text, as the service reads it.
    expect(hasWords("x=1")).toBe(true);
    expect(filtersOnly("x=1 p:2")).toBe("p:2");
  });

  test("Add as a task takes the query's words only", () => {
    expect(wordsOf("fence gate")).toBe("fence gate");
    expect(wordsOf("fence p:1 sort:effort status:open")).toBe("fence");
    expect(wordsOf('call "Ana ""the vet"" Reyes" p=2')).toBe('call Ana "the vet" Reyes');
    expect(wordsOf("fence OR gate -dst")).toBe("fence gate");
    expect(wordsOf("10:30 standup x=1")).toBe("10:30 standup x=1");
    expect(wordsOf("p<=2 -is:inbox")).toBe("");
  });

  test("the fields a search reads decide which changes offer a refresh", () => {
    expect(searchFields("fence")).toEqual([]);
    expect(searchFields("fence p<=2")).toEqual(["priority"]);
    expect([...searchFields("status:open")].sort()).toEqual(["due", "priority", "status"]);
    expect(searchFields("fence area:home")).toEqual(["area", "grouping"]);
    expect(searchFields("fence updated>1d")).toContain("title");
  });
});
