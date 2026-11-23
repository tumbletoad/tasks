// The status views and the area view as data (A5 3.5): each view's grouping, and the property that
// the counted views are disjoint, so their counts add up and each view lists exactly its count.
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vitest";
import { areaGroups, flatGroups, personGroups, projectGroups, type Group } from "../groups.ts";
import { itemsOf } from "../list/items.ts";
import type { Change } from "../store/core.ts";
import type { AreaRow, ProjectRow, TaskRow } from "../store/rows.ts";
import type { Changes } from "../store/store.ts";
import { ChangeLog } from "./changes.ts";
import {
  projectFilter,
  COUNTED,
  countedViewOf,
  recentOf,
  VIEW_LABEL,
  VIEW_LIST,
  viewCounts,
  viewFilter,
} from "./views.ts";

let n = 0;
const task = (patch: Partial<TaskRow> & { title: string }): TaskRow => {
  n += 1;
  return {
    id: `ts_${String(n).padStart(4, "0")}`,
    ref: `M-${String(n)}`,
    status: "open",
    inbox: false,
    lifecycle: "active",
    position: `a${String(n).padStart(4, "0")}`,
    created_at: n,
    version: 1,
    ...patch,
  };
};

const lumen: AreaRow = { id: "ar_lumen", title: "Lumen Health", position: "a1" };
const home: AreaRow = { id: "ar_home", title: "Home", position: "a0" };
const portal: ProjectRow = {
  id: "pj_portal",
  area_id: "ar_lumen",
  title: "Portal",
  position: "b1",
};
const sync: ProjectRow = {
  id: "pj_sync",
  area_id: "ar_lumen",
  title: "Clinic sync",
  position: "b0",
};

/** Each group as [kind, title or label, [[section title, row titles]]]. */
const shape = (groups: readonly Group[]) =>
  groups.map((g) => [
    g.kind,
    g.title ?? g.label,
    g.sections.map((s) => [s.title, s.tasks.map((t) => t.title)]),
  ]);

describe("[A5.3.5.web.view-groups] each view's grouping", () => {
  test("Inbox and Review: one flat list, newest first, with no heading item", () => {
    const tasks = [
      task({ title: "Captured first", inbox: true }),
      task({ title: "Captured second", inbox: true }),
      task({ title: "Captured third", inbox: true, area_id: "ar_home" }),
    ];
    const groups = flatGroups(tasks, [home], []);
    expect(shape(groups)).toEqual([
      ["flat", undefined, [[undefined, ["Captured third", "Captured second", "Captured first"]]]],
    ]);
    // A flat list has rows only: no heading names the view (U3).
    const items = itemsOf(groups, new Map(), new Map(), new Map());
    expect(items.items.map((i) => i.kind)).toEqual(["row", "row", "row"]);
    expect(VIEW_LIST.inbox.group).toBe(flatGroups);
    expect(VIEW_LIST.review.group).toBe(flatGroups);
    expect(flatGroups([], [], [])).toEqual([]);
  });

  test("Waiting: one group per person, by name, the follow-up day first; then no one named", () => {
    const tasks = [
      task({
        title: "Photos",
        status: "waiting",
        waiting_on: "Tom Haas",
        planned_for: "2026-11-16",
      }),
      task({ title: "Contract", status: "waiting", waiting_on: "Ana Reyes" }),
      task({
        title: "Invoice",
        status: "waiting",
        waiting_on: "tom haas ",
        planned_for: "2026-11-14",
      }),
      task({ title: "Keys", status: "waiting", waiting_on: "Tom Haas" }),
      task({ title: "Somebody", status: "waiting" }),
      task({ title: "Blank", status: "waiting", waiting_on: "  " }),
    ];
    expect(shape(personGroups(tasks, [], []))).toEqual([
      ["label", "Ana Reyes", [[undefined, ["Contract"]]]],
      // One person whatever the case and spaces; their first spelling names the group.
      ["label", "Tom Haas", [[undefined, ["Invoice", "Photos", "Keys"]]]],
      ["label", "group.nobody", [[undefined, ["Somebody", "Blank"]]]],
    ]);
    expect(VIEW_LIST.waiting.grouping).toBe("person");
  });

  test("Open and Backlog: area headings, then project labels", () => {
    expect(VIEW_LIST.open.grouping).toBe("area");
    expect(VIEW_LIST.backlog.grouping).toBe("area");
  });

  test("the area view: by project, no area heading, backlog last; a project's view: no label", () => {
    const tasks = [
      task({ title: "Later", area_id: "ar_lumen", status: "backlog" }),
      task({ title: "Admin", area_id: "ar_lumen", status: "waiting", waiting_on: "Ana" }),
      task({ title: "Fix zones", area_id: "ar_lumen", project_id: "pj_portal" }),
      task({ title: "Someday", area_id: "ar_lumen", project_id: "pj_portal", status: "backlog" }),
      task({ title: "Delays", area_id: "ar_lumen", project_id: "pj_sync", status: "review" }),
    ];
    const groups = areaGroups(tasks, [lumen], [portal, sync]);
    expect(shape(groups)).toEqual([
      [
        "flat",
        "Lumen Health",
        [
          [undefined, ["Admin", "Later"]],
          ["Clinic sync", ["Delays"]],
          ["Portal", ["Fix zones", "Someday"]],
        ],
      ],
    ]);
    // No area heading item; the project labels stay.
    const items = itemsOf(groups, new Map(), new Map(), new Map());
    expect(items.items.filter((i) => i.kind === "group")).toEqual([]);
    expect(items.items.filter((i) => i.kind === "section").map((i) => i.key)).toEqual([
      "s:pj_sync",
      "s:pj_portal",
    ]);
    const project = projectGroups(
      tasks.filter(projectFilter("pj_portal")),
      [lumen],
      [portal, sync],
    );
    expect(shape(project)).toEqual([["flat", undefined, [[undefined, ["Fix zones", "Someday"]]]]]);
  });

  test("Agents: a task an agent finished stays in Recent with its finished row, until it is deleted", () => {
    let emit: (changes: Changes) => void = () => undefined;
    const log = new ChangeLog(
      {
        onChanges: (listener) => {
          emit = listener;
          return () => undefined;
        },
      },
      () => Date.UTC(2026, 10, 12, 9),
    );
    const change = (before: TaskRow, after: TaskRow, actor: string): Change => ({
      type: "task",
      id: after.id,
      task: after.id,
      before,
      after,
      changed: ["lifecycle", "wrap"],
      created: false,
      kind: "ops",
      actor: { kind: actor, label: actor === "agent" ? "Codex" : "You" },
      request_id: `fixture-${String(after.version)}`,
    });
    const open = task({ title: "Draft the export" });
    const done: TaskRow = {
      ...open,
      lifecycle: "completed",
      wrap_state: "wrapped",
      completed_at: Date.UTC(2026, 10, 12, 8),
      version: 2,
    };
    const other = task({ title: "Still open" });
    emit({ changes: [change(open, done, "agent"), change(other, other, "agent")], reset: false });
    // The live rows no longer hold the finished task: the log's row shows it.
    const live = new Map([[other.id, other]]);
    expect(recentOf(log.getEntries(), live, "UTC")).toEqual([
      { date: "2026-11-12", tasks: [other, done] },
    ]);
    // The person's later change keeps the task where it is, with its newest row.
    const deleted: TaskRow = { ...done, deleted_at: Date.UTC(2026, 10, 12, 10), version: 3 };
    emit({ changes: [change(done, deleted, "human")], reset: false });
    expect(recentOf(log.getEntries(), live, "UTC")).toEqual([
      { date: "2026-11-12", tasks: [other] },
    ]);
  });
});

const arbTask = fc.record({
  inbox: fc.boolean(),
  status: fc.constantFrom("open", "waiting", "review", "backlog", "someday"),
  waiting_on: fc.option(fc.constantFrom("Tom", "tom", "Ana", " "), { nil: undefined }),
  area_id: fc.option(fc.constantFrom("ar_lumen", "ar_home", "ar_gone"), { nil: undefined }),
  project_id: fc.option(fc.constantFrom("pj_portal", "pj_sync", "pj_gone"), { nil: undefined }),
  created_at: fc.nat(1000),
});

describe("[A5.while-away.web.recent] the agents' changes a snapshot brings", () => {
  test("a snapshot's list is the log, the feed's later changes go on top, and the next snapshot replaces it", () => {
    let emit: (changes: Changes) => void = () => undefined;
    const NOW = Date.UTC(2026, 10, 12, 9);
    const log = new ChangeLog(
      {
        onChanges: (listener) => {
          emit = listener;
          return () => undefined;
        },
      },
      () => NOW,
    );
    const [one, two, three] = [
      task({ title: "One" }),
      task({ title: "Two" }),
      task({ title: "Three" }),
    ];
    const done: TaskRow = { ...task({ title: "Done" }), lifecycle: "completed" };
    const live = new Map([one, two, three].map((t) => [t.id, t]));
    emit({
      changes: [],
      reset: true,
      agentChanges: [
        { task: done.id, actor: "Codex", at: NOW - 3_600_000, row: done },
        { task: one.id, actor: "Codex", at: NOW - 86_400_000 },
      ],
    });
    expect(recentOf(log.getEntries(), live, "UTC")).toEqual([
      { date: "2026-11-12", tasks: [done] },
      { date: "2026-11-11", tasks: [one] },
    ]);
    // An agent changes the oldest task again: it comes first, once.
    emit({
      changes: [
        {
          type: "log",
          id: "lg_0001",
          task: one.id,
          changed: [],
          created: true,
          kind: "ops",
          actor: { kind: "agent", label: "Claude Code" },
          request_id: "fixture-1",
        },
      ],
      reset: false,
    });
    expect(log.getEntries().map((e) => [e.task, e.actor])).toEqual([
      [one.id, "Claude Code"],
      [done.id, "Codex"],
    ]);
    // A fresh snapshot is the service's word on it.
    emit({ changes: [], reset: true, agentChanges: [{ task: two.id, actor: "Codex", at: NOW }] });
    expect(log.getEntries().map((e) => e.task)).toEqual([two.id]);
  });
});

describe("[A5.while-away.web.recent-dates] the recent list is what happened", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a change is dated by its commit, also one the feed replays later; a deleted task takes no place; each leaves when seven days old while the page stays open", () => {
    const DAY = 86_400_000;
    const NOW = Date.UTC(2026, 10, 12, 9);
    vi.useFakeTimers({ now: NOW });
    let emit: (changes: Changes) => void = () => undefined;
    const log = new ChangeLog({
      onChanges: (listener) => {
        emit = listener;
        return () => undefined;
      },
    });
    const [one, two, gone] = [
      task({ title: "One" }),
      task({ title: "Two" }),
      task({ title: "Gone" }),
    ];
    const change = (row: TaskRow, at: number, by = "agent"): Change => ({
      type: "task",
      id: row.id,
      task: row.id,
      after: row,
      changed: ["title"],
      created: false,
      kind: "ops",
      actor: { kind: by, label: by === "agent" ? "Codex" : "You" },
      at,
      request_id: `fixture-${row.id}`,
    });
    emit({
      changes: [],
      reset: true,
      agentChanges: [{ task: one.id, actor: "Codex", at: NOW - 6 * DAY }],
    });
    // Replayed after a reconnect an hour on, the change keeps its own time.
    vi.setSystemTime(NOW + 3_600_000);
    emit({ changes: [change(two, NOW - 2 * DAY), change(gone, NOW - DAY)], reset: false });
    expect(log.getEntries().map((e) => [e.task, e.at])).toEqual([
      [gone.id, NOW - DAY],
      [two.id, NOW - 2 * DAY],
      [one.id, NOW - 6 * DAY],
    ]);
    emit({ changes: [change({ ...gone, deleted_at: NOW }, NOW, "human")], reset: false });
    expect(log.getEntries().map((e) => e.task)).toEqual([two.id, one.id]);
    // A day later the oldest is seven days old, and leaves without another change.
    vi.advanceTimersByTime(DAY);
    expect(log.getEntries().map((e) => e.task)).toEqual([two.id]);
    vi.advanceTimersByTime(5 * DAY);
    expect(log.getEntries()).toEqual([]);
  });
});

describe("[A5.3.5.web.counts-add-up] property: the counts add up across disjoint views", () => {
  test("each task is in at most one counted view, and each view lists exactly its count", () => {
    fc.assert(
      fc.property(fc.array(arbTask, { maxLength: 40 }), (drafts) => {
        const tasks = drafts.map((d, i) =>
          task({
            title: `Task ${String(i)}`,
            ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)),
          }),
        );
        const counts = viewCounts(tasks);
        const listed = new Map<string, string>();
        let total = 0;
        for (const view of COUNTED) {
          const filter = viewFilter(view);
          if (filter === undefined) throw new Error(`${view} has no filter`);
          const groups = VIEW_LIST[view].group(tasks.filter(filter), [lumen, home], [portal, sync]);
          const rows = groups.flatMap((g) => g.sections.flatMap((s) => s.tasks));
          // A view lists its count, each task once.
          expect(rows.length, view).toBe(counts[view]);
          expect(new Set(rows.map((r) => r.id)).size, view).toBe(rows.length);
          for (const row of rows) {
            // In no other view.
            expect(listed.get(row.id), row.ref).toBeUndefined();
            listed.set(row.id, view);
            expect(countedViewOf(row)).toBe(view);
          }
          // No group heading names the view (U3).
          expect(groups.map((g) => g.title)).not.toContain(VIEW_LABEL[view]);
          total += counts[view];
        }
        // The counts add up: every task some view holds, and none twice.
        expect(total).toBe(listed.size);
        expect(total).toBe(tasks.length);
      }),
    );
  });
});
