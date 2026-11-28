// How a project stands, derived from its open tasks: the one rule for the page's status line and,
// later, for what the service tells an agent. No dependencies beyond the day's rules, so the page
// can import it.
import { dueDayOf, isLate, type DayClock, type DueTask } from "./day.ts";
import type { EffortLevel, EffortUnit } from "./preferences.ts";

/** What the status reads of an open task. */
export type StatusTask = DueTask & {
  readonly status: string;
  readonly effort?: string | null | undefined;
};

/** One part of the status line, in the line's order. A part that would be zero is left out. */
export type StatusPart =
  | { readonly kind: "open"; readonly count: number }
  | { readonly kind: "waiting"; readonly count: number }
  /** The sized tasks' typical time together, from the space's effort levels. */
  | { readonly kind: "effort"; readonly minutes: number }
  | { readonly kind: "unsized"; readonly count: number }
  /** The earliest due day; `late` when a task is late, by the rule its row follows. */
  | { readonly kind: "due"; readonly date: string; readonly late: boolean };

/** A level's time in minutes of work: a day is a working day of 8 hours, a week 5 of them. */
const UNIT_MINUTES: Readonly<Record<EffortUnit, number>> = {
  minutes: 1,
  hours: 60,
  days: 8 * 60,
  weeks: 5 * 8 * 60,
};

/**
 * The status of the open tasks of a project and everything below it. A task sized with a level
 * that has no time adds no time and is still sized.
 */
export function projectStatus(
  tasks: Iterable<StatusTask>,
  levels: readonly EffortLevel[],
  today: DayClock,
): StatusPart[] {
  const minutesOf = new Map(
    levels.flatMap((level) =>
      level.time === undefined
        ? []
        : [[level.key, level.time.amount * UNIT_MINUTES[level.time.unit]] as const],
    ),
  );
  let open = 0;
  let waiting = 0;
  let minutes = 0;
  let unsized = 0;
  let due: string | undefined;
  let late = false;
  for (const task of tasks) {
    open += 1;
    if (task.status === "waiting") waiting += 1;
    if (task.effort === undefined || task.effort === null || task.effort === "") unsized += 1;
    else minutes += minutesOf.get(task.effort) ?? 0;
    const day = dueDayOf(task, today);
    if (day !== undefined && (due === undefined || day < due)) due = day;
    late ||= isLate(task, today);
  }
  const parts: StatusPart[] = [];
  if (open > 0) parts.push({ kind: "open", count: open });
  if (waiting > 0) parts.push({ kind: "waiting", count: waiting });
  if (minutes > 0) parts.push({ kind: "effort", minutes });
  if (unsized > 0) parts.push({ kind: "unsized", count: unsized });
  if (due !== undefined) parts.push({ kind: "due", date: due, late });
  return parts;
}
