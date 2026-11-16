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

/** The most tasks one search holds, as the service freezes them. */
const SEARCH_IDS = 1_000;

/**
 * A search over finished tasks that reads the source's query shapes and answers in pages of
 * `limit` rows, in due-date order (undated last), as the service orders a query without words. Like
 * the service it holds at most 1,000 tasks a search and then says `1000+`.
 */
function fakeSearch(done: readonly Done[]): { search: Search; queries: string[] } {
  const queries: string[] = [];
  const pending = new Map<string, { list: Done[]; total: number | "1000+" }>();
  let cursors = 0;
  const page = (list: Done[], limit: number, total: number | "1000+") => {
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
      pending.set(cursor, { list: rest, total });
    }
    return {
      as_of: "1:x:1",
      scope: "finished" as const,
      parsed: "",
      total,
      first: list.length === 0 ? 0 : 1,
      rows,
      ...(cursor === undefined ? {} : { cursor }),
    };
  };
  const search: Search = (input) => {
    const limit = input.limit ?? 15;
    if (input.cursor !== undefined) {
      const held = pending.get(input.cursor);
      return Promise.resolve(page(held?.list ?? [], limit, held?.total ?? 0));
    }
    const q = input.q ?? "";
    queries.push(q);
    const checked = q.split(" ").includes(CHECKED_OFF_QUERY);
    const from = /completed>=(\S+)/.exec(q)?.[1];
    const before = /completed<(\S+)/.exec(q)?.[1];
    const found = done
      .filter(
        (d) =>
          (d.unwrapped === true) === checked &&
          (from === undefined || d.completed >= from) &&
          (before === undefined || d.completed < before),
      )
      .sort((a, b) =>
        (a.due ?? "~") < (b.due ?? "~") ? -1 : (a.due ?? "~") > (b.due ?? "~") ? 1 : 0,
      );
    const total = found.length > SEARCH_IDS ? "1000+" : found.length;
    return Promise.resolve(page(found.slice(0, SEARCH_IDS), limit, total));
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
    expect(monthQuery("done", "2026-11", true)).toBe("-is:unwrapped completed>=2026-11-01");
    expect(monthQuery("done", "2026-10", false)).toBe(
      "-is:unwrapped completed>=2026-10-01 completed<2026-11-01",
    );
    expect(monthQuery("checked", "2026-10", false)).toBe(
      "is:unwrapped completed>=2026-10-01 completed<2026-11-01",
    );
    expect(earlierQuery("done", "2026-10")).toBe("-is:unwrapped completed<2026-10-01");
    expect(earlierQuery("checked", "2026-10")).toBe("is:unwrapped completed<2026-10-01");
  });

  test("checked off first, then each month newest first, in completion order whatever the search's", async () => {
    const { search, queries } = fakeSearch([
      { ref: "M-1", completed: "2026-11-10", due: "2026-11-01" },
      { ref: "M-2", completed: "2026-11-11", due: "2026-12-01" },
      { ref: "M-3", completed: "2026-11-12", unwrapped: true },
      { ref: "M-4", completed: "2026-09-03" },
      { ref: "M-5", completed: "2026-11-02", unwrapped: true, due: "2026-01-01" },
      { ref: "M-7", completed: "2026-08-20", unwrapped: true },
      // A month with nothing (October) costs one read; the source steps over it.
      { ref: "M-6", completed: "2025-12-31" },
    ]);
    const page = await sourceOf(search)({ after: undefined, limit: 50 });
    expect(page.rows.map((r) => r.ref)).toEqual(["M-3", "M-5", "M-7", "M-2", "M-1", "M-4", "M-6"]);
    expect(page.next).toBeUndefined();
    // The windows it read: checked off by month, then the rest, each from this month open-ended
    // back to the oldest month that holds one.
    const back = (from: string, to: string) => {
      const out: string[] = [];
      for (let m = from; m >= to; m = monthBefore(m)) out.push(m);
      return out;
    };
    expect(queries.filter((q) => !/^-?is:unwrapped completed</.test(q))).toEqual([
      monthQuery("checked", "2026-11", true),
      ...back("2026-10", "2026-08").map((m) => monthQuery("checked", m, false)),
      monthQuery("done", "2026-11", true),
      ...back("2026-10", "2025-12").map((m) => monthQuery("done", m, false)),
    ]);

    const groups = completedGroups(page.rows, CLOCK);
    expect(
      groups.map((g) => [g.kind, g.label ?? g.title, g.sections[0]?.tasks.map((t) => t.ref)]),
    ).toEqual([
      ["label", "group.checkedOff", ["M-3", "M-5", "M-7"]],
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
    expect(first.next).toBe("d2026-08");
    const second = await source({ after: first.next, limit: 3 });
    // August, July, then June with every one of its 61 rows, whatever the limit.
    expect(second.rows.slice(0, 3).map((r) => r.ref)).toEqual(["M-8", "M-7", "M-6"]);
    expect(second.rows).toHaveLength(63);
    expect(second.rows.filter((r) => r.ref.startsWith("N-"))).toHaveLength(60);
    expect(second.next).toBe("d2026-05");
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

  test("every finished task stays reachable past the 1,000 a search holds: checked off and the rest alike", async () => {
    const done: Done[] = [];
    // 1,200 checked off over three months and 1,100 others over two: more than one search holds.
    for (let i = 0; i < 1_200; i += 1) {
      const month = ["2026-11", "2026-10", "2026-09"][i % 3] ?? "";
      done.push({
        ref: `C-${String(i)}`,
        completed: `${month}-0${String((i % 9) + 1)}`,
        unwrapped: true,
      });
    }
    for (let i = 0; i < 1_100; i += 1) {
      const month = ["2026-08", "2026-07"][i % 2] ?? "";
      done.push({ ref: `D-${String(i)}`, completed: `${month}-1${String(i % 10)}` });
    }
    const source = sourceOf(fakeSearch(done).search);
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = await source({ after, limit: 50 });
      seen.push(...page.rows.map((r) => r.ref));
      after = page.next;
    } while (after !== undefined);
    expect(new Set(seen).size).toBe(2_300);
    expect(seen).toHaveLength(2_300);
    // Checked off comes first, whole, before any other finished task.
    expect(seen.slice(0, 1_200).every((ref) => ref.startsWith("C-"))).toBe(true);
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
