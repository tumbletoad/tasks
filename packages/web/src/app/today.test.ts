// Today's selection (A5 3.4) as plain data: the fixture example of A5 3.4, the orders, the day
// filter, the Next limit, Changes, and a property over generated tasks that no task is in two
// sections and every selected task meets its section's rule. Fixture data only.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { TaskRow } from "../live.ts";
import { dateOf, dayNumber, type Clock } from "../row/dates.ts";
import {
  CHANGES_LIMIT,
  dueDayOf,
  holdExpanded,
  inFocus,
  inNext,
  inWeek,
  isStarred,
  onDay,
  todayOf,
  type TaskChange,
  type TodaySection,
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
    ...patch,
  };
};

const titles = (today: ReturnType<typeof todayOf>) =>
  Object.fromEntries(today.sections.map((s) => [s.key, s.tasks.map((t) => t.title)]));

describe("[A5.3.4.web.today] Today's sections and week strip", () => {
  test("the fixture example of A5 3.4", () => {
    const lumen = "ar_lumen";
    const home = "ar_home";
    const tasks = [
      task({
        title: "Fix appointment time zones",
        focus_on: "2026-11-11",
        due_date: "2026-11-13",
        area_id: lumen,
        priority: 1,
      }),
      task({
        title: "Investigate checkout crash on Android 15",
        focus_on: "2026-11-12",
        area_id: lumen,
        priority: 2,
      }),
      task({
        title: "Review Jonas's pull request",
        due_date: "2026-11-14",
        area_id: lumen,
        priority: 2,
      }),
      task({ title: "Sign the lease", due_date: "2026-11-14", area_id: home, priority: 3 }),
      task({
        title: "New product photos",
        status: "waiting",
        waiting_on: "Tom Haas",
        planned_for: "2026-11-16",
        area_id: lumen,
      }),
      task({
        title: "Release 2.4 to the app stores",
        due_date: "2026-11-17",
        area_id: lumen,
        priority: 1,
      }),
      task({ title: "Dentist check-up", due_date: "2026-11-17", area_id: home, priority: 2 }),
      task({ title: "Book the moving van", due_date: "2026-11-21", area_id: home, priority: 2 }),
      task({ title: "File the Q4 VAT return", due_date: "2026-11-30", area_id: home, priority: 2 }),
      task({ title: "Release 1.9 with structured fields", area_id: lumen, priority: 2 }),
      // Left out: a fourth open task (the Next limit), backlog and review without a date, Inbox.
      task({ title: "Tidy the garden shed", area_id: home, priority: 3 }),
      task({ title: "Someday: a sauna", status: "backlog", area_id: home }),
      task({
        title: "Agent finished the docs migration, check it",
        status: "review",
        area_id: lumen,
      }),
      task({ title: "Call the plumber", inbox: true }),
    ];
    const slots = new Map([
      [lumen, 1],
      [home, 4],
    ]);
    const review = tasks.find((t) => t.status === "review");
    const changes: TaskChange[] = [{ task: review?.id ?? "", actor: "Claude Code", at: CLOCK.now }];
    const today = todayOf(tasks, CLOCK, { slots, changes });
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
    // The strip: seven days, today first; area-coloured marks, a ring for a follow-up day.
    expect(today.strip.map((d) => d.date)).toEqual([
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
    ]);
    expect(today.strip.map((d) => d.today)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    const marks = today.strip.map((d) =>
      d.marks.map((m) => (m.ring ? "ring" : `a${String(m.slot)}`)),
    );
    expect(marks).toEqual([[], ["a1"], ["a1", "a4"], [], ["ring"], ["a1", "a4"], []]);
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

  test("the strip's day narrows Focus and This week to that day, and Next stays", () => {
    const tasks = [
      task({ title: "starred undated", focus_on: "2026-11-12" }),
      task({ title: "due today", due_date: "2026-11-12" }),
      task({ title: "due Sat", due_date: "2026-11-14" }),
      task({ title: "planned Sat", planned_for: "2026-11-14", due_date: "2026-11-17" }),
      task({ title: "starred due Sat", focus_on: "2026-11-12", due_date: "2026-11-14" }),
      task({ title: "open undated", priority: 2 }),
    ];
    expect(titles(todayOf(tasks, CLOCK, { day: "2026-11-14" }))).toEqual({
      focus: ["starred due Sat"],
      week: ["due Sat", "planned Sat"],
      next: ["open undated"],
    });
    expect(titles(todayOf(tasks, CLOCK, { day: "2026-11-12" }))).toEqual({
      focus: ["due today"],
      next: ["open undated"],
    });
    // A task the filter hides keeps its section: it never drops into Next.
    expect(titles(todayOf(tasks, CLOCK, { day: "2026-11-18" }))).toEqual({
      next: ["open undated"],
    });
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
  });
});

// --- The property --------------------------------------------------------------------------------

const DAYS = Array.from({ length: 21 }, (_, i) => dateOf((dayNumber(CLOCK.today) ?? 0) - 10 + i));
const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });
const arbTask = fc.record({
  status: fc.constantFrom("open", "waiting", "review", "backlog", "someday"),
  inbox: fc.boolean(),
  priority: maybe(fc.integer({ min: 1, max: 4 })),
  due_date: maybe(fc.constantFrom(...DAYS)),
  due_at: maybe(fc.integer({ min: CLOCK.now - 5 * 86_400_000, max: CLOCK.now + 9 * 86_400_000 })),
  planned_for: maybe(fc.constantFrom(...DAYS)),
  focus_on: maybe(fc.constantFrom(...DAYS)),
  area_id: maybe(fc.constantFrom("ar_a", "ar_b")),
  lifecycle: fc.constantFrom("active", "active", "active", "completed"),
  created_at: fc.integer({ min: 0, max: 1_000 }),
  position: fc.constantFrom("a", "b", "c"),
});

describe("[A5.3.4.web.today-disjoint] property: no task in two sections", () => {
  test("every task is in at most one section, and each selected task meets its section's rule", () => {
    fc.assert(
      fc.property(
        fc.array(arbTask, { maxLength: 40 }),
        fc.array(fc.record({ i: fc.nat(60), ago: fc.integer({ min: 0, max: 9 * 86_400_000 }) }), {
          maxLength: 20,
        }),
        maybe(fc.constantFrom(...DAYS.slice(10, 17))),
        fc.integer({ min: 0, max: 6 }),
        maybe(
          fc.record({
            i: fc.nat(60),
            section: maybe(fc.constantFrom<TodaySection>("focus", "week", "next", "changes")),
            index: fc.nat(10),
          }),
        ),
        (drafts, changeDrafts, day, nextLimit, holdDraft) => {
          const tasks = drafts.map((d, i) => {
            const row = {
              id: `ts_${String(i).padStart(3, "0")}`,
              ref: `M-${String(i)}`,
              title: `Task ${String(i)}`,
              version: 1,
              ...d,
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
          const today = todayOf(tasks, CLOCK, { day, nextLimit, changes });

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
          for (const t of sectionOf("focus")) {
            expect(inFocus(t, CLOCK)).toBe(true);
            if (day !== undefined) expect(onDay(t, day, CLOCK)).toBe(true);
          }
          for (const t of sectionOf("week")) {
            expect(inFocus(t, CLOCK)).toBe(false);
            expect(inWeek(t, CLOCK)).toBe(true);
            if (day !== undefined) expect(onDay(t, day, CLOCK)).toBe(true);
          }
          expect(sectionOf("next").length).toBeLessThanOrEqual(nextLimit);
          for (const t of sectionOf("next")) {
            expect(inFocus(t, CLOCK) || inWeek(t, CLOCK)).toBe(false);
            expect(inNext(t)).toBe(true);
          }
          expect(sectionOf("changes").length).toBeLessThanOrEqual(CHANGES_LIMIT);
          for (const t of sectionOf("changes")) {
            expect(inFocus(t, CLOCK) || inWeek(t, CLOCK)).toBe(false);
            const change = changes.find((c) => c.task === t.id);
            expect(change?.at ?? 0).toBeGreaterThanOrEqual(CLOCK.now - 7 * 86_400_000);
          }
          // Without a filter, every task Focus or This week selects is shown; a starred one in Focus.
          if (day === undefined) {
            for (const t of tasks) {
              if (inFocus(t, CLOCK)) expect(seen.get(t.id)).toBe("focus");
              else if (inWeek(t, CLOCK)) expect(seen.get(t.id)).toBe("week");
              if (t.lifecycle === "active" && isStarred(t, CLOCK.today))
                expect(seen.get(t.id)).toBe("focus");
            }
          }
          // The strip: seven days from today; each mark is a Focus or This week task's due or plan.
          expect(today.strip.map((d) => d.date)).toEqual(DAYS.slice(10, 17));
          for (const cell of today.strip) {
            for (const mark of cell.marks) {
              const t = tasks.find((x) => x.id === mark.task);
              expect(t !== undefined && (inFocus(t, CLOCK) || inWeek(t, CLOCK))).toBe(true);
              if (t !== undefined) {
                expect(dueDayOf(t, CLOCK) === cell.date || t.planned_for === cell.date).toBe(true);
              }
            }
          }
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
              const at = held.find((s) => s.tasks.some((t) => t.id === heldTask.id))?.key;
              expect(at).toBe(holdDraft.section ?? seen.get(heldTask.id) ?? "focus");
              for (const s of held) expect(s.tasks.length).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
