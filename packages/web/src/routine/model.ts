// What the page shows of a routine, as plain data: the Routines page's groups (Due, Coming, Paused)
// and the words of its line, its schedule and who does it, when its open time is, and its newest
// entry. A routine's schedule words come from the calculator's (row/schedule.ts).
import { parseRule } from "@ttasks/contracts/schedule";
import type { RoutineRow } from "@ttasks/client/store";
import { formatDay, type Clock } from "@ttasks/client/today";
import type { MessageId, Translate } from "../i18n/intl.tsx";
import { scheduleWords, type ScheduleWording } from "../row/schedule.ts";

export interface RoutineGroups {
  /** Its open time has come: today, or late. Oldest first. */
  readonly due: readonly RoutineRow[];
  /** Its open time is still to come. Soonest first. */
  readonly coming: readonly RoutineRow[];
  readonly paused: readonly RoutineRow[];
}

const byTime = (a: RoutineRow, b: RoutineRow): number =>
  a.due_date.localeCompare(b.due_date) ||
  (a.due_at ?? 0) - (b.due_at ?? 0) ||
  a.title.localeCompare(b.title);

/** The active routines by where the Routines page lists them; a finished one is in none. */
export function routineGroups(routines: Iterable<RoutineRow>, clock: Clock): RoutineGroups {
  const due: RoutineRow[] = [];
  const coming: RoutineRow[] = [];
  const paused: RoutineRow[] = [];
  for (const r of routines) {
    if (r.lifecycle !== "active" || r.deleted_at !== undefined) continue;
    if (r.paused) paused.push(r);
    else if (r.due_date <= clock.today) due.push(r);
    else coming.push(r);
  }
  return {
    due: due.sort(byTime),
    coming: coming.sort(byTime),
    paused: paused.sort((a, b) => a.title.localeCompare(b.title)),
  };
}

/** A message and its values: what a line of the page says. */
export interface Said {
  readonly id: MessageId;
  readonly values?: Readonly<Record<string, string | number>>;
}

const day = (date: string, clock: Clock): string =>
  formatDay(date, clock.locale, { weekday: "short", day: "numeric", month: "short" });

/** When its open time is: late since a day, today, or next on a day. */
export function whenOf(row: RoutineRow, clock: Clock): Said {
  if (row.due_date < clock.today) {
    return { id: "routine.late", values: { date: day(row.due_date, clock) } };
  }
  if (row.due_date === clock.today) return { id: "routine.today" };
  return { id: "routine.next", values: { date: day(row.due_date, clock) } };
}

/** Its newest entry, when it has one: last done or skipped on a day. */
export function lastOf(row: RoutineRow, clock: Clock): Said | undefined {
  if (row.last_state === undefined || row.last_at === undefined) return undefined;
  const date = row.last_due ?? new Date(row.last_at).toISOString().slice(0, 10);
  return {
    id: row.last_state === "done" ? "routine.lastDone" : "routine.lastSkipped",
    values: { date: day(date, clock) },
  };
}

/** Its schedule in words, and who does it: "Every Saturday · you". */
export function lineOf(row: RoutineRow, t: Translate, wording: ScheduleWording): string {
  const rule = parseRule(row.rule);
  const schedule = rule === undefined ? row.rule : scheduleWords(rule, wording);
  const by = row.by === "you" ? t("routine.byYou") : row.by;
  return t("routine.line", { schedule, by });
}
