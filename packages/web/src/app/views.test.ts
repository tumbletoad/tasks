import { describe, expect, test } from "vitest";
import type { TaskRow } from "../live.ts";
import { landingSpace, type SpaceList } from "./spaces.ts";
import { areaFilter, COUNTED, countedViewOf, viewCounts, viewFilter, VIEWS } from "./views.ts";

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
    expect(counts).toEqual({ inbox: 2, open: 2, waiting: 1, review: 1, backlog: 1 });
    // A task in the Inbox appears in no status view until triaged (A5 3.5).
    for (const t of TASKS) {
      const holders = COUNTED.filter((view) => viewFilter(view)?.(t) === true);
      expect(holders.length, t.ref).toBeLessThanOrEqual(1);
      expect(holders[0]).toBe(countedViewOf(t));
    }
    // A status no view shows is in no count.
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(TASKS.length - 1);
  });

  test("Today lists every open task for now; Completed and Agents have no list yet", () => {
    expect(TASKS.filter((t) => viewFilter("today")?.(t) === true)).toHaveLength(TASKS.length);
    expect(viewFilter("completed")).toBeUndefined();
    expect(viewFilter("agents")).toBeUndefined();
    expect(VIEWS).toEqual([
      "today",
      "inbox",
      "open",
      "waiting",
      "review",
      "backlog",
      "completed",
      "agents",
    ]);
  });

  test("an area view holds every status of its area, a project view its project", () => {
    expect(TASKS.filter(areaFilter("ar_a")).map((t) => t.status)).toEqual([
      "open",
      "open",
      "backlog",
    ]);
    expect(TASKS.filter(areaFilter("ar_a", "pj_1")).map((t) => t.status)).toEqual([
      "open",
      "backlog",
    ]);
  });
});

const A = "sp_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "sp_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const list = (defaultId: string | null, states: [string, string][]): SpaceList => ({
  default: defaultId,
  spaces: states.map(([id, state]) => ({ id, name: id.slice(3, 4), state })),
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
});
