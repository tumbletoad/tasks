// Calendar formatting for the row: due dates are local calendar dates ("2026-11-14")
// and instants are milliseconds since 1970 in UTC. The row reads them on the viewer's
// calendar, which the clock names, so every function here is pure: the same clock gives the same
// answer on every machine, and tests pass their own. The calendar arithmetic is day.ts's, shared
// with the service.
import { dayNumber, localDate, type DayClock } from "@ttasks/contracts/day";

/** The viewer's calendar and its locale. */
export interface Clock extends DayClock {
  /** A BCP 47 locale ("en"). */
  readonly locale: string;
}

const DAY_MS = 86_400_000;

const formats = new Map<string, Intl.DateTimeFormat>();

/** One formatter per locale, zone and options: building them is the expensive part. */
export function formatter(
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formats.set(key, format);
  }
  return format;
}

/**
 * Formats a calendar date. A calendar date is a day, not an instant: it is read at noon UTC and
 * formatted in UTC, so no zone moves it to another day.
 */
export function formatDay(
  date: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const day = dayNumber(date);
  if (day === undefined) return date;
  return formatter(locale, "UTC", options).format(day * DAY_MS + DAY_MS / 2);
}

/** Formats an instant in the clock's zone. */
export function formatInstant(
  ms: number,
  clock: Clock,
  options: Intl.DateTimeFormatOptions,
): string {
  return formatter(clock.locale, clock.timeZone, options).format(ms);
}

/** "14:02" today, "23 Nov, 14:02" another day: when something happened. */
export function formatWhen(ms: number, clock: Clock): string {
  const time = formatInstant(ms, clock, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (localDate(ms, clock.timeZone) === clock.today) return time;
  return `${formatInstant(ms, clock, { day: "numeric", month: "short" })}, ${time}`;
}

/**
 * When a task is due, as its card shows it: the day, or for a due time the day and the time in the
 * viewer's zone, as the page's row reads them. Undefined when it has no due date.
 */
export function dueWhen(
  task: { readonly due_date?: string; readonly due_at?: number },
  clock: Clock,
): string | undefined {
  const day = { weekday: "short", day: "numeric", month: "short" } as const;
  if (task.due_at !== undefined) {
    const date = formatDay(localDate(task.due_at, clock.timeZone), clock.locale, day);
    const time = formatInstant(task.due_at, clock, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    return `${date}, ${time}`;
  }
  return task.due_date === undefined ? undefined : formatDay(task.due_date, clock.locale, day);
}
