import { describe, expect, test } from "vitest";
import type { DayClock } from "./day.ts";
import { EFFORT_LEVELS, type EffortLevel } from "./preferences.ts";
import { projectStatus, type StatusTask } from "./project-status.ts";

const clock = (today: string, timeZone = "UTC"): DayClock => ({
  today,
  now: Date.parse(`${today}T12:00:00Z`),
  timeZone,
});

const task = (fields: Partial<StatusTask> = {}): StatusTask => ({ status: "open", ...fields });

describe("[S2.status.line] a project's status line from its open tasks", () => {
  test("counts the open, the waiting, the time of the sized ones, the unsized ones and the next due day", () => {
    const tasks = [
      task({ effort: "M", due_date: "2026-12-09" }),
      task({ effort: "S", status: "waiting", due_date: "2026-12-03" }),
      task({ effort: "XS", status: "waiting" }),
      task(),
      task({ effort: "", status: "backlog" }),
    ];
    expect(projectStatus(tasks, EFFORT_LEVELS, clock("2026-11-28"))).toEqual([
      { kind: "open", count: 5 },
      { kind: "waiting", count: 2 },
      { kind: "effort", minutes: 4 * 60 + 60 + 10 },
      { kind: "unsized", count: 2 },
      { kind: "due", date: "2026-12-03", late: false },
    ]);
  });

  test("a part that is zero is left out, and nothing open says nothing", () => {
    expect(projectStatus([], EFFORT_LEVELS, clock("2026-11-28"))).toEqual([]);
    expect(projectStatus([task({ effort: "S" })], EFFORT_LEVELS, clock("2026-11-28"))).toEqual([
      { kind: "open", count: 1 },
      { kind: "effort", minutes: 60 },
    ]);
  });

  test("days and weeks are working days and weeks; a level without a time is sized and adds none", () => {
    const levels: EffortLevel[] = [
      { key: "Day", time: { amount: 2, unit: "days" } },
      { key: "Week", time: { amount: 1, unit: "weeks" } },
      { key: "Vague" },
    ];
    const tasks = [task({ effort: "Day" }), task({ effort: "Week" }), task({ effort: "Vague" })];
    expect(projectStatus(tasks, levels, clock("2026-11-28"))).toEqual([
      { kind: "open", count: 3 },
      { kind: "effort", minutes: 2 * 8 * 60 + 40 * 60 },
    ]);
  });

  test("the next due day across a year's end, and a day already past is late", () => {
    const year = [task({ due_date: "2027-01-02" }), task({ due_date: "2026-12-30" })];
    expect(projectStatus(year, EFFORT_LEVELS, clock("2026-12-28")).at(-1)).toEqual({
      kind: "due",
      date: "2026-12-30",
      late: false,
    });
    const late = [task({ due_date: "2027-01-02" }), task({ due_date: "2026-12-30" })];
    expect(projectStatus(late, EFFORT_LEVELS, clock("2027-01-01")).at(-1)).toEqual({
      kind: "due",
      date: "2026-12-30",
      late: true,
    });
  });

  test("a due time counts on the viewer's calendar", () => {
    // 23:30 on 31 December in UTC is already 1 January in Amsterdam.
    const timed = [task({ due_at: Date.parse("2026-12-31T23:30:00Z") })];
    expect(
      projectStatus(timed, EFFORT_LEVELS, clock("2026-12-20", "Europe/Amsterdam")).at(-1),
    ).toEqual({ kind: "due", date: "2027-01-01", late: false });
  });
});
