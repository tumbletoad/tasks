import { describe, expect, test } from "vitest";
import type { TaskRow } from "../live.ts";
import { landingSpace, notOpen, type SpaceList } from "./spaces.ts";
import {
  areaFilter,
  projectFilter,
  COUNTED,
  countedViewOf,
  groupCounts,
  sidebarEntries,
  viewCounts,
  viewFilter,
  VIEWS,
} from "./views.ts";

let n = 0;
const task = (patch: Partial<TaskRow>): TaskRow => {
  n += 1;
  return {
    id: `ts_${String(n)}`,
    ref: `M-${String(n)}`,
    title: `Task ${String(n)}`,
    status: "open",
    inbox: false,
    lifecycle: "active",
    position: String(n),
    created_at: n,
    version: 1,
    ...patch,
  };
};

const TASKS: TaskRow[] = [
  task({ inbox: true }),
  task({ inbox: true, status: "waiting" }),
  task({ status: "open", area_id: "ar_a" }),
  task({ status: "open", area_id: "ar_a", project_id: "pj_1" }),
  task({ status: "waiting", area_id: "ar_b" }),
  task({ status: "review" }),
  task({ status: "backlog", area_id: "ar_a", project_id: "pj_1" }),
  task({ status: "someday" }),
];

describe("[A5.3.3.web.views] the sidebar's views and counts", () => {
  test("the status views and the Inbox are disjoint, and their counts add up", () => {
    const counts = viewCounts(TASKS);
    // A status of the space's own without a view ("someday") is in Open.
    expect(counts).toEqual({ inbox: 2, open: 3, waiting: 1, review: 1, backlog: 1 });
    // A task in the Inbox appears in no status view until triaged (A5 3.5).
    for (const t of TASKS) {
      const holders = COUNTED.filter((view) => viewFilter(view)?.(t) === true);
      expect(holders.length, t.ref).toBeLessThanOrEqual(1);
      expect(holders[0]).toBe(countedViewOf(t));
    }
    // Every open task is in exactly one view.
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(TASKS.length);
  });

  test("Today has sections, not a filter; Completed, Agents and the Trash read what the live rows do not hold", () => {
    expect(viewFilter("today")).toBeUndefined();
    expect(viewFilter("completed")).toBeUndefined();
    expect(viewFilter("agents")).toBeUndefined();
    expect(viewFilter("trash")).toBeUndefined();
    expect(VIEWS).toEqual([
      "today",
      "inbox",
      "open",
      "waiting",
      "review",
      "backlog",
      "completed",
      "agents",
      "trash",
    ]);
  });

  test("an area view holds every status of its area, a project view its project", () => {
    expect(TASKS.filter(areaFilter("ar_a")).map((t) => t.status)).toEqual([
      "open",
      "open",
      "backlog",
    ]);
    expect(TASKS.filter(projectFilter("pj_1")).map((t) => t.status)).toEqual(["open", "backlog"]);
  });

  test("an area counts what its view lists, its projects' tasks included; a project its own", () => {
    const counts = groupCounts(TASKS);
    expect(counts.get("ar_a")).toBe(TASKS.filter(areaFilter("ar_a")).length);
    expect(counts.get("pj_1")).toBe(TASKS.filter(projectFilter("pj_1")).length);
    expect(counts.get("ar_b")).toBe(1);
    expect(counts.get("ar_none")).toBeUndefined();
  });

  test("every view has its entry in every state; an empty one is quiet, an unknown one claims nothing", () => {
    // Before the first snapshot nothing is known: no count, and no view says it is empty.
    expect(VIEWS.map((view) => sidebarEntries(undefined).get(view))).toEqual(
      VIEWS.map(() => ({ empty: false })),
    );
    const entries = sidebarEntries(viewCounts(TASKS.filter((t) => t.status !== "review")));
    expect([...entries.keys()]).toEqual(VIEWS);
    expect(Object.fromEntries(entries)).toEqual({
      today: { empty: false },
      inbox: { count: 2, empty: false },
      open: { count: 3, empty: false },
      waiting: { count: 1, empty: false },
      review: { count: 0, empty: true },
      backlog: { count: 1, empty: false },
      completed: { empty: false },
      agents: { empty: false },
      trash: { empty: false },
    });
    // A space with nothing in it: still every entry, in the same order.
    expect([...sidebarEntries(viewCounts([])).keys()]).toEqual(VIEWS);
  });
});

const A = "sp_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "sp_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const list = (defaultId: string | null, states: [string, string][]): SpaceList => ({
  default: defaultId,
  spaces: states.map(([id, state]) => ({ id, name: id.slice(3, 4), state })),
  unopened: [],
});

describe("[A5.3.3.web.landing] what a new tab opens", () => {
  test("the default space when it is served, never another in its place", () => {
    expect(
      landingSpace(
        list(B, [
          [A, "open"],
          [B, "open"],
        ]),
      ),
    ).toBe(B);
    expect(
      landingSpace(
        list(B, [
          [A, "open"],
          [B, "read_only"],
        ]),
      ),
    ).toBe(B);
    // A default that is not open leaves the choice to the person.
    expect(
      landingSpace(
        list(B, [
          [A, "open"],
          [B, "unavailable"],
        ]),
      ),
    ).toBeUndefined();
    expect(landingSpace(list(B, [[A, "open"]]))).toBeUndefined();
  });

  test("without a default: the one served space, or the person's choice among several", () => {
    expect(landingSpace(list(null, [[A, "open"]]))).toBe(A);
    expect(
      landingSpace(
        list(null, [
          [A, "open"],
          [B, "opening"],
        ]),
      ),
    ).toBe(A);
    expect(
      landingSpace(
        list(null, [
          [A, "open"],
          [B, "open"],
        ]),
      ),
    ).toBeUndefined();
    expect(landingSpace(list(null, []))).toBeUndefined();
  });

  test("a space that is not open is named with why, also one that never opened", () => {
    const listed: SpaceList = {
      ...list(null, [
        [A, "open"],
        [B, "unavailable"],
      ]),
      unopened: [{ state: "unavailable", reason: "needs_recovery" }, { state: "opening" }],
    };
    expect(notOpen(listed)).toEqual([
      { name: "b", why: "other" },
      { why: "needs_recovery" },
      { why: "opening" },
    ]);
    expect(notOpen(list(null, [[A, "open"]]))).toEqual([]);
  });
});
