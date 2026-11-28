// Today's selection (A5 3.4) as plain data: the fixture example of A5 3.4, the orders, the Next
// limit, Changes, the day's numbers, and a property over generated tasks that no task is in two
// sections, every selected task meets its section's rule and the numbers count what they say.
// Fixture data only.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { TaskRow } from "../store/rows.ts";
import {
  dateOf,
  dayNumber,
  dueDayOf,
  inToday,
  inWeek,
  isStarred,
  localDate,
} from "@ttasks/contracts/day";
import {
  DAY_CASES,
  DAY_CLOCK,
  DAY_COUNTS,
  DAY_STARRED,
  DAY_TODAY,
  DAY_WEEK,
} from "@ttasks/contracts/day-cases";
import type { Clock } from "./dates.ts";
import {
  CHANGES_LIMIT,
  dayNumbersOf,
  holdExpanded,
  inNext,
  todayOf,
  viewCounts,
  type TaskChange,
  type TodaySection,
  weekStartOf,
} from "./views.ts";

/** Thursday 12 November 2026, 10:00 in Amsterdam (A5's fixture day). */
const CLOCK: Clock = {
  today: "2026-11-12",
  now: Date.UTC(2026, 10, 12, 9, 0),
  timeZone: "Europe/Amsterdam",
  locale: "en-GB",
};

let n = 0;
const task = (patch: Partial<TaskRow>): TaskRow => {
  n += 1;
  return {
    id: `ts_${String(n).padStart(4, "0")}`,
    ref: `M-${String(n)}`,
    title: `Task ${String(n)}`,
    status: "open",
    inbox: false,
    lifecycle: "active",
    position: String(n).padStart(4, "0"),
    created_at: Date.UTC(2026, 10, 1) + n,
    version: 1,
    parent: "sp_a",
    ...patch,
  };
};

const titles = (today: ReturnType<typeof todayOf>) =>
  Object.fromEntries(today.sections.map((s) => [s.key, s.tasks.map((t) => t.title)]));

describe("[A5.3.4.day.one-rule] the page's day follows the rule an agent's status does", () => {
  // The table an agent's status is tested with (service test/day.test.ts).
  const clock: Clock = { ...DAY_CLOCK, locale: "en-GB" };
  const rows = DAY_CASES.map(({ name, ...fields }, i) =>
    task({ ...fields, title: name, created_at: Date.UTC(2026, 10, 1) + i }),
  );

  test("Focus and This week hold the table's Today and week, in their order", () => {
    const today = titles(todayOf(rows, clock));
    expect(today["focus"]).toEqual(DAY_TODAY);
    expect(today["week"]).toEqual(DAY_WEEK);
  });

  test("the sidebar counts each task once: the Inbox by its flag, else its status", () => {
    const { inbox, statuses } = DAY_COUNTS;
    // A status of the space's own has no view: the sidebar lists and counts it in Open.
    expect(viewCounts(rows)).toEqual({ ...statuses, inbox, open: statuses.open + statuses.inbox });
  });

  test("the row is starred where the digest says focus", () => {
    expect(rows.filter((t) => isStarred(t, clock.today)).map((t) => t.title)).toEqual(DAY_STARRED);
  });
});

describe("[A5.3.4.web.today] Today's sections and numbers", () => {
  test("the fixture example of A5 3.4", () => {
    const lumen = "ar_lumen";
    const home = "ar_home";
    const tasks = [
      task({
        title: "Fix appointment time zones",
        focus_on: "2026-11-11",
        due_date: "2026-11-13",
        parent: lumen,
        priority: 1,
      }),
      task({
        title: "Investigate checkout crash on Android 15",
        focus_on: "2026-11-12",
        parent: lumen,
        priority: 2,
      }),
      task({
        title: "Review Jonas's pull request",
        due_date: "2026-11-14",
        parent: lumen,
        priority: 2,
      }),
      task({ title: "Sign the lease", due_date: "2026-11-14", parent: home, priority: 3 }),
      task({
        title: "New product photos",
        status: "waiting",
        waiting_on: "Tom Haas",
        planned_for: "2026-11-16",
        parent: lumen,
      }),
      task({
        title: "Release 2.4 to the app stores",
        due_date: "2026-11-17",
        parent: lumen,
        priority: 1,
      }),
      task({ title: "Dentist check-up", due_date: "2026-11-17", parent: home, priority: 2 }),
      task({ title: "Book the moving van", due_date: "2026-11-21", parent: home, priority: 2 }),
      task({ title: "File the Q4 VAT return", due_date: "2026-11-30", parent: home, priority: 2 }),
      task({ title: "Release 1.9 with structured fields", parent: lumen, priority: 2 }),
      // Left out: a fourth open task (the Next limit), backlog and review without a date, Inbox.
      task({ title: "Tidy the garden shed", parent: home, priority: 3 }),
      task({ title: "Someday: a sauna", status: "backlog", parent: home }),
      task({
        title: "Agent finished the docs migration, check it",
        status: "review",
        parent: lumen,
      }),
      task({ title: "Call the plumber", inbox: true }),
    ];
    const review = tasks.find((t) => t.status === "review");
    const changes: TaskChange[] = [{ task: review?.id ?? "", actor: "Claude Code", at: CLOCK.now }];
    const today = todayOf(tasks, CLOCK, { changes });
    expect(titles(today)).toEqual({
      focus: ["Fix appointment time zones", "Investigate checkout crash on Android 15"],
      week: [
        "Review Jonas's pull request",
        "Sign the lease",
        "New product photos",
        "Release 2.4 to the app stores",
        "Dentist check-up",
      ],
      next: ["Book the moving van", "File the Q4 VAT return", "Release 1.9 with structured fields"],
      changes: ["Agent finished the docs migration, check it"],
    });
    // Nothing is late or due today in the fixture; one task waits on someone.
    expect(dayNumbersOf(tasks, CLOCK)).toEqual({ late: 0, dueToday: 0, waiting: 1 });
  });

  test("Focus: late first by oldest due, then due today, then priority, due date and age", () => {
    const tasks = [
      task({ title: "starred P3", focus_on: "2026-11-10", priority: 3 }),
      task({ title: "late 2d", due_date: "2026-11-10", priority: 3 }),
      task({ title: "late 5d", due_date: "2026-11-07", priority: 4 }),
      task({ title: "today P2", due_date: "2026-11-12", priority: 2 }),
      task({ title: "today P1", due_date: "2026-11-12", priority: 1 }),
      // 10:00 has passed at the clock's 10:00 + 0: due at 09:30 local is late.
      task({ title: "late at 09:30", due_at: Date.UTC(2026, 10, 12, 8, 30) }),
      task({ title: "today at 16:00", due_at: Date.UTC(2026, 10, 12, 15, 0), priority: 1 }),
      task({ title: "planned today P1", planned_for: "2026-11-12", priority: 1 }),
      task({
        title: "starred P1 due Sat",
        focus_on: "2026-11-12",
        priority: 1,
        due_date: "2026-11-14",
      }),
      task({ title: "starred P1 undated", focus_on: "2026-11-12", priority: 1 }),
      task({ title: "starred backlog", focus_on: "2026-11-12", status: "backlog" }),
      task({ title: "late backlog", due_date: "2026-11-01", status: "backlog" }),
      task({ title: "starred tomorrow", focus_on: "2026-11-13" }),
    ];
    expect(titles(todayOf(tasks, CLOCK)).focus).toEqual([
      "late 5d",
      "late 2d",
      "late at 09:30",
      "today P1",
      "today at 16:00",
      "today P2",
      "starred P1 due Sat",
      "planned today P1",
      "starred P1 undated",
      "starred P3",
      "starred backlog",
    ]);
  });

  test("This week: by the day that selects it, then priority; a waiting task by its follow-up day", () => {
    const tasks = [
      task({ title: "Tue P2", due_date: "2026-11-17", priority: 2 }),
      task({ title: "Tue P1", due_date: "2026-11-17", priority: 1 }),
      task({ title: "planned Fri, due later", planned_for: "2026-11-13", due_date: "2026-12-01" }),
      task({ title: "waiting, follow up Mon", status: "waiting", planned_for: "2026-11-16" }),
      task({ title: "Wed, the last day", due_date: "2026-11-18" }),
      task({ title: "Thu next week: not this week", due_date: "2026-11-19" }),
      task({ title: "backlog Sat: not on Today", due_date: "2026-11-14", status: "backlog" }),
      task({ title: "review Sat", due_date: "2026-11-14", status: "review", priority: 3 }),
    ];
    const today = todayOf(tasks, CLOCK);
    expect(titles(today).week).toEqual([
      "planned Fri, due later",
      "review Sat",
      "waiting, follow up Mon",
      "Tue P1",
      "Tue P2",
      "Wed, the last day",
    ]);
    // The undated open task goes to Next; the review and backlog tasks without a date nowhere.
    expect(titles(today).next).toEqual(["Thu next week: not this week"]);
  });

  test("Next: open and not in the Inbox, by priority, due date, position and age, three by default", () => {
    const tasks = [
      task({ title: "P4 undated", position: "0001" }),
      task({ title: "P2 undated", priority: 2 }),
      task({ title: "P2 due Dec", priority: 2, due_date: "2026-12-10" }),
      task({ title: "P2 due Nov", priority: 2, due_date: "2026-11-25" }),
      task({ title: "P1 undated, waiting", priority: 1, status: "waiting" }),
      task({ title: "P1 undated, Inbox", priority: 1, inbox: true }),
      task({ title: "P3 position a", priority: 3, position: "a" }),
      task({ title: "P3 position b", priority: 3, position: "b" }),
    ];
    expect(titles(todayOf(tasks, CLOCK)).next).toEqual(["P2 due Nov", "P2 due Dec", "P2 undated"]);
    expect(titles(todayOf(tasks, CLOCK, { nextLimit: 6 })).next).toEqual([
      "P2 due Nov",
      "P2 due Dec",
      "P2 undated",
      "P3 position a",
      "P3 position b",
      "P4 undated",
    ]);
    expect(titles(todayOf(tasks, CLOCK, { nextLimit: 0 })).next).toBeUndefined();
  });

  test("the day's numbers: late by its due day, due today at any time of it, and what Waiting lists", () => {
    const tasks = [
      task({ title: "late", due_date: "2026-11-10" }),
      task({ title: "late backlog", due_date: "2026-11-01", status: "backlog" }),
      // Its time has passed, but it is today's: Search's due:today finds it, not is:overdue.
      task({ title: "today at 09:30", due_at: Date.UTC(2026, 10, 12, 8, 30) }),
      task({ title: "today", due_date: "2026-11-12", inbox: true }),
      task({ title: "tomorrow", due_date: "2026-11-13" }),
      task({ title: "waiting", status: "waiting" }),
      task({ title: "waiting in the Inbox", status: "waiting", inbox: true }),
      task({ title: "done late", due_date: "2026-11-01", lifecycle: "completed" }),
    ];
    expect(dayNumbersOf(tasks, CLOCK)).toEqual({ late: 2, dueToday: 2, waiting: 1 });
    // The week starts on Monday: Thursday 12 November's is the 9th, a Monday's is itself.
    expect(weekStartOf("2026-11-12")).toBe("2026-11-09");
    expect(weekStartOf("2026-11-09")).toBe("2026-11-09");
    expect(weekStartOf("2026-11-15")).toBe("2026-11-09");
    expect(weekStartOf("2026-01-01")).toBe("2025-12-29");
  });

  test("Changes: agents' changes to tasks no section above holds, newest first, five at most", () => {
    const shown = task({ title: "starred", focus_on: "2026-11-12" });
    const quiet = Array.from({ length: 8 }, (_, i) =>
      task({ title: `review ${String(i)}`, status: "review" }),
    );
    const changes: TaskChange[] = [
      { task: shown.id, actor: "Codex", at: CLOCK.now },
      ...quiet.map((t, i) => ({ task: t.id, actor: "Codex", at: CLOCK.now - i * 60_000 })),
      // A second change to a task already listed, a task not in the working set, and an old one.
      { task: quiet[0]?.id ?? "", actor: "Claude Code", at: CLOCK.now - 3_600_000 },
      { task: "ts_gone", actor: "Codex", at: CLOCK.now },
    ];
    const today = todayOf([shown, ...quiet], CLOCK, { changes });
    expect(titles(today).changes).toEqual([
      "review 0",
      "review 1",
      "review 2",
      "review 3",
      "review 4",
    ]);
    const old = [{ task: quiet[0]?.id ?? "", actor: "Codex", at: CLOCK.now - 8 * 86_400_000 }];
    expect(titles(todayOf(quiet, CLOCK, { changes: old })).changes).toBeUndefined();
  });

  test("an expanded task stays at its place in its section until it is collapsed", () => {
    const a = task({ title: "a", focus_on: "2026-11-12", priority: 1 });
    const b = task({ title: "b", focus_on: "2026-11-12", priority: 2 });
    const c = task({ title: "c", focus_on: "2026-11-12", priority: 3 });
    const before = todayOf([a, b, c], CLOCK).sections;
    expect(before.map((s) => s.key)).toEqual(["focus"]);
    // An agent unstars b and gives it a date on Saturday: it would move to This week.
    const moved: TaskRow = {
      ...Object.fromEntries(Object.entries(b).filter(([key]) => key !== "focus_on")),
      due_date: "2026-11-14",
    } as TaskRow;
    const after = todayOf([a, moved, c], CLOCK).sections;
    expect(after.map((s) => [s.key, s.tasks.map((t) => t.title)])).toEqual([
      ["focus", ["a", "c"]],
      ["week", ["b"]],
    ]);
    const held = holdExpanded(after, { task: moved, section: "focus", index: 1 });
    expect(held.map((s) => [s.key, s.tasks.map((t) => t.title)])).toEqual([
      ["focus", ["a", "b", "c"]],
    ]);
    expect(held[0]?.tasks[1]).toBe(moved);
    // Completed by an agent: off Today, still where it was.
    const done = { ...b, lifecycle: "completed" };
    const gone = holdExpanded(todayOf([a, done, c], CLOCK).sections, {
      task: done,
      section: "focus",
      index: 1,
    });
    expect(gone.map((s) => s.tasks.map((t) => t.title))).toEqual([["a", "b", "c"]]);
    // A task Today never showed (named by the URL) sits at the top of Focus; one it shows stays.
    const other = task({ title: "backlog", status: "backlog" });
    const linked = holdExpanded(todayOf([a, other], CLOCK).sections, { task: other });
    expect(linked.map((s) => s.tasks.map((t) => t.title))).toEqual([["backlog", "a"]]);
    const there = todayOf([a, b], CLOCK).sections;
    expect(holdExpanded(there, { task: b })).toBe(there);
    expect(holdExpanded(there, { task: b, section: "focus", index: 1 })).toBe(there);
  });

  test("an expanded task an update re-sorts inside its section stays at its place", () => {
    const a = task({ title: "a", focus_on: "2026-11-12", priority: 1 });
    const b = task({ title: "b", focus_on: "2026-11-12", priority: 2 });
    const c = task({ title: "c", focus_on: "2026-11-12", priority: 3 });
    // An agent lowers a's priority: Focus would put it last.
    const lowered = { ...a, priority: 4 };
    const after = todayOf([lowered, b, c], CLOCK).sections;
    expect(after.map((s) => s.tasks.map((t) => t.title))).toEqual([["b", "c", "a"]]);
    const held = holdExpanded(after, { task: lowered, section: "focus", index: 0 });
    expect(held.map((s) => s.tasks.map((t) => t.title))).toEqual([["a", "b", "c"]]);
    expect(held[0]?.tasks[0]).toBe(lowered);
  });
});

// --- The property --------------------------------------------------------------------------------

/**
 * The viewer's clock: a time zone (whole, half-hour and quarter-hour offsets, both hemispheres'
 * daylight saving, the date line) and an instant near a midnight or a daylight-saving change there.
 */
const ZONES = [
  "Europe/Amsterdam",
  "America/New_York",
  "America/St_Johns",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Australia/Lord_Howe",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
  "UTC",
];
const MOMENTS = [
  CLOCK.now,
  Date.UTC(2026, 2, 29, 1, 0), // Europe springs forward
  Date.UTC(2026, 9, 25, 1, 0), // Europe falls back
  Date.UTC(2026, 2, 8, 7, 0), // New York springs forward
  Date.UTC(2026, 10, 1, 6, 0), // New York falls back
  Date.UTC(2026, 3, 4, 15, 0), // Lord Howe's half hour back
  Date.UTC(2026, 11, 31, 23, 59), // a year's end
];
const arbClock = fc
  .record({
    timeZone: fc.constantFrom(...ZONES),
    moment: fc.constantFrom(...MOMENTS),
    // Up to a day and a half either side, by the minute: every zone's midnight falls in it.
    shift: fc.integer({ min: -36 * 60, max: 36 * 60 }),
  })
  .map(({ timeZone, moment, shift }): Clock => {
    const now = moment + shift * 60_000;
    return { today: localDate(now, timeZone), now, timeZone, locale: "en-GB" };
  });
const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });
/** A day as an offset from the clock's today, so every draft lands around whatever today is. */
const arbDay = maybe(fc.integer({ min: -10, max: 10 }));
const arbTask = fc.record({
  status: fc.constantFrom("open", "waiting", "review", "backlog", "someday"),
  inbox: fc.boolean(),
  priority: maybe(fc.integer({ min: 1, max: 4 })),
  due_date: arbDay,
  // Minutes from now: within a day of a midnight, and across the whole window.
  due_at: maybe(fc.integer({ min: -5 * 24 * 60, max: 9 * 24 * 60 })),
  planned_for: arbDay,
  focus_on: arbDay,
  parent: fc.constantFrom("sp_a", "ar_a", "ar_b"),
  lifecycle: fc.constantFrom("active", "active", "active", "completed", "archived"),
  created_at: fc.integer({ min: 0, max: 1_000 }),
  position: fc.constantFrom("a", "b", "c"),
});

/** A task's due day and planned day, read plainly: the due time's day on the viewer's calendar. */
function daysOf(t: TaskRow, clock: Clock): string[] {
  const due = t.due_at !== undefined ? localDate(t.due_at, clock.timeZone) : t.due_date;
  return [due, t.planned_for].filter((d): d is string => d !== undefined);
}

/**
 * The oracle: A5 3.4's table written again from the specification, not from views.ts. The section
 * whose rule selects a task before Next's limit and Changes, or none.
 */
function ruleOf(t: TaskRow, clock: Clock): "focus" | "week" | "next" | undefined {
  if (t.lifecycle !== "active") return undefined;
  if (t.focus_on !== undefined && t.focus_on <= clock.today) return "focus";
  if (t.status === "backlog") return undefined;
  const days = daysOf(t, clock);
  if (days.some((d) => d <= clock.today)) return "focus";
  const last = dateOf((dayNumber(clock.today) ?? 0) + 6);
  if (days.some((d) => d > clock.today && d <= last)) return "week";
  if (t.status === "open" && !t.inbox) return "next";
  return undefined;
}

describe("[A5.3.4.web.today-disjoint] property: no task in two sections", () => {
  test("every task is in at most one section, and each selected task meets its section's rule", () => {
    fc.assert(
      fc.property(
        arbClock,
        fc.array(arbTask, { maxLength: 40 }),
        fc.array(fc.record({ i: fc.nat(60), ago: fc.integer({ min: 0, max: 9 * 86_400_000 }) }), {
          maxLength: 20,
        }),
        fc.integer({ min: 0, max: 6 }),
        maybe(
          fc.record({
            i: fc.nat(60),
            section: maybe(fc.constantFrom<TodaySection>("focus", "week", "next", "changes")),
            index: fc.nat(10),
          }),
        ),
        (CLOCK, drafts, changeDrafts, nextLimit, holdDraft) => {
          const base = dayNumber(CLOCK.today) ?? 0;
          const dayAt = (offset: number | undefined) =>
            offset === undefined ? undefined : dateOf(base + offset);
          const tasks = drafts.map((d, i) => {
            const row = {
              id: `ts_${String(i).padStart(3, "0")}`,
              ref: `M-${String(i)}`,
              title: `Task ${String(i)}`,
              version: 1,
              ...d,
              due_date: dayAt(d.due_date),
              due_at: d.due_at === undefined ? undefined : CLOCK.now + d.due_at * 60_000,
              planned_for: dayAt(d.planned_for),
              focus_on: dayAt(d.focus_on),
            };
            // A compact row leaves out what is null.
            return Object.fromEntries(
              Object.entries(row).filter(([, value]) => value !== undefined),
            ) as unknown as TaskRow;
          });
          const changes = changeDrafts
            .map((c) => ({
              task: `ts_${String(c.i).padStart(3, "0")}`,
              actor: "Codex",
              at: CLOCK.now - c.ago,
            }))
            .sort((a, b) => b.at - a.at);
          const today = todayOf(tasks, CLOCK, { nextLimit, changes });

          const seen = new Map<string, TodaySection>();
          for (const section of today.sections) {
            expect(section.tasks.length).toBeGreaterThan(0);
            for (const t of section.tasks) {
              expect(
                seen.has(t.id),
                `${t.id} in ${String(seen.get(t.id))} and ${section.key}`,
              ).toBe(false);
              seen.set(t.id, section.key);
              expect(t.lifecycle).toBe("active");
            }
          }
          const sectionOf = (key: TodaySection) =>
            today.sections.find((s) => s.key === key)?.tasks ?? [];
          // Every task against the oracle: Focus and This week hold exactly what their rule
          // selects, Next only its candidates, Changes nothing above.
          const candidates = tasks.filter((t) => ruleOf(t, CLOCK) === "next");
          for (const t of tasks) {
            const rule = ruleOf(t, CLOCK);
            const shown = seen.get(t.id);
            if (rule === "focus" || rule === "week") {
              expect(shown, `${t.id} by rule ${rule}`).toBe(rule);
            } else if (rule === "next") {
              expect([undefined, "next", "changes"]).toContain(shown);
            } else if (t.lifecycle === "active") {
              expect([undefined, "changes"]).toContain(shown);
            } else {
              expect(shown).toBeUndefined();
            }
          }
          // Next is full whenever it has candidates: none of them is lost to a section above.
          expect(sectionOf("next").length).toBe(Math.min(nextLimit, candidates.length));
          expect(sectionOf("changes").length).toBeLessThanOrEqual(CHANGES_LIMIT);
          for (const t of sectionOf("changes")) {
            const change = changes.find((c) => c.task === t.id);
            expect(change?.at ?? 0).toBeGreaterThanOrEqual(CLOCK.now - 7 * 86_400_000);
          }
          // The production predicates agree with the oracle.
          for (const t of tasks) {
            if (t.lifecycle !== "active") continue;
            const rule = ruleOf(t, CLOCK);
            expect(inToday(t, CLOCK)).toBe(rule === "focus");
            expect(!inToday(t, CLOCK) && inWeek(t, CLOCK)).toBe(rule === "week");
            expect(!inToday(t, CLOCK) && !inWeek(t, CLOCK) && inNext(t)).toBe(rule === "next");
            if (isStarred(t, CLOCK.today)) expect(rule).toBe("focus");
            const due = dueDayOf(t, CLOCK);
            if (due !== undefined) expect(daysOf(t, CLOCK)[0]).toBe(due);
          }
          // The numbers count the open tasks by their due day, as Search reads it.
          const active = tasks.filter((t) => t.lifecycle === "active");
          const dueOf = (t: TaskRow) =>
            t.due_at !== undefined ? localDate(t.due_at, CLOCK.timeZone) : t.due_date;
          expect(dayNumbersOf(tasks, CLOCK)).toEqual({
            late: active.filter((t) => (dueOf(t) ?? CLOCK.today) < CLOCK.today).length,
            dueToday: active.filter((t) => dueOf(t) === CLOCK.today).length,
            waiting: active.filter((t) => t.status === "waiting" && !t.inbox).length,
          });
          // Holding the expanded task keeps every section disjoint and puts it where it was.
          if (holdDraft !== undefined) {
            const heldTask = tasks[holdDraft.i];
            if (heldTask !== undefined) {
              const held = holdExpanded(today.sections, {
                task: heldTask,
                ...(holdDraft.section === undefined ? {} : { section: holdDraft.section }),
                index: holdDraft.index,
              });
              const ids = held.flatMap((s) => s.tasks.map((t) => t.id));
              expect(new Set(ids).size).toBe(ids.length);
              const home = held.find((s) => s.tasks.some((t) => t.id === heldTask.id));
              expect(home?.key).toBe(holdDraft.section ?? seen.get(heldTask.id) ?? "focus");
              // At its place there, as near as the section's length allows.
              if (holdDraft.section !== undefined && home !== undefined) {
                expect(home.tasks.findIndex((t) => t.id === heldTask.id)).toBe(
                  Math.min(holdDraft.index, home.tasks.length - 1),
                );
              }
              for (const s of held) expect(s.tasks.length).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
