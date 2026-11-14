// Calendar arithmetic for the row (A5 3.6, 3.23): due dates are local calendar dates ("2026-11-14")
// and instants are milliseconds since 1970 in UTC (A1). The row compares them on the viewer's
// calendar, which the clock names, so every function here is pure: the same clock gives the same
// answer on every machine, and tests pass their own.

/** The viewer's calendar: today's date, the instant, its time zone and its locale. */
export interface Clock {
  /** Today on the viewer's calendar, `YYYY-MM-DD`. */
  readonly today: string;
  /** Now, milliseconds since 1970. */
  readonly now: number;
  /** An IANA time zone ("Europe/Amsterdam"). */
  readonly timeZone: string;
  /** A BCP 47 locale ("en"). */
  readonly locale: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a calendar date, or undefined for a value that is none. */
export function dayNumber(date: string): number | undefined {
  const match = DATE.exec(date);
  if (match === null) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : undefined;
}

/** The calendar date of a day number. */
export function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

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

/** The calendar date of an instant in a time zone. */
export function localDate(ms: number, timeZone: string): string {
  const parts = formatter("en-CA", timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(ms);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
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
