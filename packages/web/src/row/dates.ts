// Calendar formatting for the row (A5 3.6, 3.23): due dates are local calendar dates ("2026-11-14")
// and instants are milliseconds since 1970 in UTC (A1). The row reads them on the viewer's
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

/** Today's clock for this browser: its zone and the page's locale. */
export function browserClock(locale: string, now: number = Date.now()): Clock {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { today: localDate(now, timeZone), now, timeZone, locale };
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
