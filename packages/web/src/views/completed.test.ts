// Completed's page source and groups (A5 3.5) against a fake `task.search` that answers the
// queries the source sends as the service would: the checked-off list, then month windows.
import { describe, expect, test } from "vitest";
import type { TaskRow } from "../store/rows.ts";
import {
  CHECKED_OFF_QUERY,
  completedGroups,
  completedSource,
  earlierQuery,
  monthAfter,
  monthBefore,
  monthQuery,
  rowOfSearch,
  type Search,
} from "./completed.ts";

interface Done {
  readonly ref: string;
  readonly completed: string;
  /** Its outcome is still missing: the checked-off list. */
  readonly unwrapped?: boolean;
  /** Its due date: the order the search answers in without words (A3 3.9.3). */
  readonly due?: string;
}

const CLOCK = { today: "2026-11-12", timeZone: "UTC", locale: "en" } as const;

/**
 * A search over finished tasks that reads the source's three query shapes and answers in pages of
 * `limit` rows, in due-date order (undated last), as the service orders a query without words.
 */
function fakeSearch(done: readonly Done[]): { search: Search; queries: string[] } {
  const queries: string[] = [];
  const pending = new Map<string, Done[]>();
  let cursors = 0;
  const page = (list: Done[], limit: number) => {
    const rows = list.slice(0, limit).map((d) => ({
      kind: "task" as const,
      id: `ts_${d.ref}`,
      ref: d.ref,
      title: `Task ${d.ref}`,
      lifecycle: "completed" as const,
      status: "open",
      inbox: false,
      priority: 4,
      area: "Home",
      completed: d.completed,
      ...(d.due === undefined ? {} : { due: d.due }),
    }));
    const rest = list.slice(limit);
    let cursor: string | undefined;
    if (rest.length > 0) {
      cursors += 1;
      cursor = `c_${String(cursors).padStart(16, "0")}`;
      pending.set(cursor, rest);
    }
    return {
      as_of: "1:x:1",
      scope: "finished" as const,
      parsed: "",
      total: list.length,
      first: list.length === 0 ? 0 : 1,
      rows,
      ...(cursor === undefined ? {} : { cursor }),
    };
  };
  const search: Search = (input) => {
    const limit = input.limit ?? 15;
    if (input.cursor !== undefined) {
      return Promise.resolve(page(pending.get(input.cursor) ?? [], limit));
    }
    const q = input.q ?? "";
    queries.push(q);
    let list: Done[];
    if (q === CHECKED_OFF_QUERY) list = done.filter((d) => d.unwrapped === true);
    else {
      const from = /completed>=(\S+)/.exec(q)?.[1];
      const before = /completed<(\S+)/.exec(q)?.[1];
      list = done.filter(
        (d) =>
          d.unwrapped !== true &&
          (from === undefined || d.completed >= from) &&
          (before === undefined || d.completed < before),
      );
    }
    list = [...list].sort((a, b) =>
      (a.due ?? "~") < (b.due ?? "~") ? -1 : (a.due ?? "~") > (b.due ?? "~") ? 1 : 0,
    );
    return Promise.resolve(page(list, limit));
  };
  return { search, queries };
}

const AREAS = new Map([["ar_home", { id: "ar_home", title: "Home", position: "a" }]]);

const sourceOf = (search: Search) =>
  completedSource({
    search,
    clock: () => CLOCK,
    rowOf: (row, checkedOff) => rowOfSearch(row, AREAS, new Map(), checkedOff),
  });

describe("[A5.3.5.web.completed] Completed: the source's windows and the groups", () => {
  test("months step back and forth across years; each window's query", () => {
    expect([monthBefore("2026-01"), monthBefore("2026-11"), monthAfter("2026-12")]).toEqual([
      "2025-12",
      "2026-10",
      "2027-01",
    ]);
    expect(monthQuery("2026-11", true)).toBe("-is:unwrapped completed>=2026-11-01");
    expect(monthQuery("2026-10", false)).toBe(
      "-is:unwrapped completed>=2026-10-01 completed<2026-11-01",
    );
    expect(earlierQuery("2026-10")).toBe("-is:unwrapped completed<2026-10-01");
  });

  test("checked off first, then each month newest first, in completion order whatever the search's", async () => {
    const { search, queries } = fakeSearch([
      { ref: "M-1", completed: "2026-11-10", due: "2026-11-01" },
      { ref: "M-2", completed: "2026-11-11", due: "2026-12-01" },
      { ref: "M-3", completed: "2026-11-12", unwrapped: true },
      { ref: "M-4", completed: "2026-09-03" },
      { ref: "M-5", completed: "2026-11-02", unwrapped: true, due: "2026-01-01" },
      // A month with nothing (October) costs one read; the source steps over it.
      { ref: "M-6", completed: "2025-12-31" },
    ]);
    const page = await sourceOf(search)({ after: undefined, limit: 50 });
    expect(page.rows.map((r) => r.ref)).toEqual(["M-3", "M-5", "M-2", "M-1", "M-4", "M-6"]);
    expect(page.next).toBeUndefined();
    // The windows it read: checked off, this month open-ended, then each month before it.
    expect(queries.filter((q) => !q.startsWith("-is:unwrapped completed<"))).toEqual([
      CHECKED_OFF_QUERY,
      monthQuery("2026-11", true),
      monthQuery("2026-10", false),
      monthQuery("2026-09", false),
      monthQuery("2026-08", false),
      monthQuery("2026-07", false),
      monthQuery("2026-06", false),
      monthQuery("2026-05", false),
      monthQuery("2026-04", false),
      monthQuery("2026-03", false),
      monthQuery("2026-02", false),
      monthQuery("2026-01", false),
      monthQuery("2025-12", false),
    ]);

    const groups = completedGroups(page.rows, CLOCK);
    expect(
      groups.map((g) => [g.kind, g.label ?? g.title, g.sections[0]?.tasks.map((t) => t.ref)]),
    ).toEqual([
      ["label", "group.checkedOff", ["M-3", "M-5"]],
      ["label", "November", ["M-2", "M-1"]],
      ["label", "September", ["M-4"]],
      ["label", "December 2025", ["M-6"]],
    ]);
  });

  test("a page holds whole windows, at least the rows asked for, and the cursor goes on from there", async () => {
    const done: Done[] = [];
    for (let i = 1; i <= 11; i += 1) {
      done.push({ ref: `M-${String(i)}`, completed: `2026-${String(i).padStart(2, "0")}-15` });
    }
    // Sixty in one month: a window reads every page of its search, never half a month.
    for (let i = 0; i < 60; i += 1) {
      done.push({
        ref: `N-${String(i)}`,
        completed: "2026-06-01",
        due: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      });
    }
    const { search } = fakeSearch(done);
    const source = sourceOf(search);
    const first = await source({ after: undefined, limit: 3 });
    // November (one), October (one), September (one): three rows, and the cursor names August.
    expect(first.rows.map((r) => r.ref)).toEqual(["M-11", "M-10", "M-9"]);
    expect(first.next).toBe("2026-08");
    const second = await source({ after: first.next, limit: 3 });
    // August, July, then June with every one of its 61 rows, whatever the limit.
    expect(second.rows.slice(0, 3).map((r) => r.ref)).toEqual(["M-8", "M-7", "M-6"]);
    expect(second.rows).toHaveLength(63);
    expect(second.rows.filter((r) => r.ref.startsWith("N-"))).toHaveLength(60);
    expect(second.next).toBe("2026-05");
    let after = second.next;
    const rest: string[] = [];
    while (after !== undefined) {
      const page = await source({ after, limit: 3 });
      rest.push(...page.rows.map((r) => r.ref));
      after = page.next;
    }
    expect(rest).toEqual(["M-5", "M-4", "M-3", "M-2", "M-1"]);
    // A cursor the source did not give reads nothing.
    expect((await source({ after: "nonsense", limit: 3 })).rows).toEqual([]);
  });

  test("a search row becomes a finished row: its day, its area by name, no age to show", () => {
    const row = rowOfSearch(
      {
        kind: "task",
        id: "ts_1",
        ref: "M-1",
        title: "Sign the lease",
        lifecycle: "completed",
        status: "open",
        inbox: false,
        priority: 2,
        area: "Home",
        completed: "2026-11-10",
        snippet: "Both copies",
      },
      AREAS,
      new Map(),
      true,
    );
    expect(row).toMatchObject({
      ref: "M-1",
      area_id: "ar_home",
      completed_on: "2026-11-10",
      wrap_state: "pending",
      summary: "Both copies",
      version: 0,
    });
    expect(
      rowOfSearch({ kind: "deleted", id: "ts_2", ref: "M-2" }, AREAS, new Map(), false),
    ).toBeUndefined();
  });

  test("the expanded task the rows do not hold sits at the top of its group", () => {
    const row = (ref: string, completed_on: string, extra: Partial<TaskRow> = {}): TaskRow => ({
      id: `ts_${ref}`,
      ref,
      title: ref,
      status: "open",
      inbox: false,
      lifecycle: "completed",
      position: "",
      created_at: 0,
      version: 0,
      completed_on,
      ...extra,
    });
    const rows = [row("M-1", "2026-11-10"), row("M-2", "2026-10-01")];
    const held = row("M-9", "2026-10-20");
    const groups = completedGroups(rows, CLOCK, held);
    expect(groups.map((g) => g.sections[0]?.tasks.map((t) => t.ref))).toEqual([
      ["M-1"],
      ["M-9", "M-2"],
    ]);
    // The live row's instant wins over the read's day: the feed's row of a reopened, then again
    // completed task moves it to its new month.
    const moved = row("M-2", "2026-10-01", { completed_at: Date.UTC(2026, 10, 12, 9) });
    expect(completedGroups([moved], CLOCK).map((g) => g.title)).toEqual(["November"]);
    // Held and already shown: once.
    expect(
      completedGroups(rows, CLOCK, rows[0]).flatMap((g) => g.sections[0]?.tasks ?? []),
    ).toHaveLength(2);
  });
});
