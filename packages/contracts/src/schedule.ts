// When a repeating task or a routine comes back: the schedule a person sets, in the form a space
// stores it, and the times it gives. Pure and without dependencies, so the page, the service and
// later the phone read a schedule the same way (`@ttasks/contracts/schedule`).
//
// The stored form is a small subset of RFC 5545's RRULE, with a start date and an IANA time zone.
// One departure from the standard: a day of the month past the month's end falls on its last day,
// so "every month on the 31st" never skips a month. A working day is Monday to Friday. Weeks start
// on Monday. A time of day keeps its wall-clock hour through daylight saving: a time in the spring
// gap falls on the first valid minute after it, and a time the autumn repeats on its first one.
import { dateOf, dayNumber, isTimeZone, localDate } from "./day.ts";

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The first to fourth of a month, or its last (-1). */
export type Ordinal = 1 | 2 | 3 | 4 | -1;

/** Which day of a month: a date (-1 the last), a weekday's turn, or the first or last working day. */
export type MonthDay =
  | { readonly kind: "date"; readonly day: number }
  | { readonly kind: "weekday"; readonly ordinal: Ordinal; readonly weekday: Weekday }
  | { readonly kind: "working"; readonly position: 1 | -1 };

export type Pattern =
  | { readonly freq: "DAILY" }
  | { readonly freq: "WEEKLY"; readonly days: readonly Weekday[] }
  | { readonly freq: "MONTHLY"; readonly on: MonthDay }
  | { readonly freq: "YEARLY"; readonly month: number; readonly on: MonthDay };

/** A local time of day, 00:00 to 23:59. */
export interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
}

/** A rule: what repeats, every how many periods, and at what time of day, if any. */
export interface Rule {
  readonly pattern: Pattern;
  /** 1 to MAX_INTERVAL: every period, every second one, … */
  readonly interval: number;
  /** Null: a date only. */
  readonly time: TimeOfDay | null;
}

/** A schedule as a space stores it: the rule's text, its first possible date, and its zone. */
export interface Schedule {
  /** RRULE text in this module's subset, as `formatRule` writes it. */
  readonly rule: string;
  /** The first date it may fall on, `YYYY-MM-DD` on its zone's calendar. */
  readonly start: string;
  /** An IANA time zone. */
  readonly zone: string;
}

export const MAX_INTERVAL = 99;

/** When an agent's routine runs on a schedule that names no time. */
export const DEFAULT_RUN_TIME: TimeOfDay = { hour: 7, minute: 0 };

// ---------------------------------------------------------------------------------------------
// The presets the page offers. Each returns a rule without a time; `at` adds one.

const WORKING: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR"];

export const presets = {
  daily: (interval = 1): Rule => rule({ freq: "DAILY" }, interval),
  weekdays: (): Rule => rule({ freq: "WEEKLY", days: WORKING }, 1),
  weekly: (days: readonly Weekday[], interval = 1): Rule =>
    rule({ freq: "WEEKLY", days: WEEKDAYS.filter((d) => days.includes(d)) }, interval),
  /** On a date of the month, -1 for its last day. */
  monthly: (day: number, interval = 1): Rule =>
    rule({ freq: "MONTHLY", on: { kind: "date", day } }, interval),
  monthlyOn: (ordinal: Ordinal, weekday: Weekday, interval = 1): Rule =>
    rule({ freq: "MONTHLY", on: { kind: "weekday", ordinal, weekday } }, interval),
  workingDay: (position: 1 | -1, interval = 1): Rule =>
    rule({ freq: "MONTHLY", on: { kind: "working", position } }, interval),
  yearly: (month: number, day: number): Rule =>
    rule({ freq: "YEARLY", month, on: { kind: "date", day } }, 1),
};

/** The rule at a time of day, or without one. */
export const at = (base: Rule, time: TimeOfDay | null): Rule => ({ ...base, time });

const rule = (pattern: Pattern, interval: number): Rule => ({ pattern, interval, time: null });

// ---------------------------------------------------------------------------------------------
// The stored text

const ORDINAL = /^(-1|[1-4])?(MO|TU|WE|TH|FR|SA|SU)$/u;
const NUMBER = /^-?\d{1,2}$/u;

const isWeekday = (value: string): value is Weekday =>
  (WEEKDAYS as readonly string[]).includes(value);

function int(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !NUMBER.test(value)) return undefined;
  const n = Number(value);
  return n >= min && n <= max ? n : undefined;
}

/**
 * A rule from its text, or undefined for any text outside the subset: an unknown or repeated part,
 * a value out of bounds, or a combination the subset does not have.
 */
export function parseRule(text: string): Rule | undefined {
  const parts = new Map<string, string>();
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return undefined;
    const key = part.slice(0, eq);
    if (parts.has(key)) return undefined;
    parts.set(key, part.slice(eq + 1));
  }
  const take = (key: string): string | undefined => {
    const value = parts.get(key);
    parts.delete(key);
    return value;
  };
  const freq = take("FREQ");
  const intervalText = take("INTERVAL");
  const interval = intervalText === undefined ? 1 : int(intervalText, 1, MAX_INTERVAL);
  const hourText = take("BYHOUR");
  const minuteText = take("BYMINUTE");
  if (interval === undefined || (hourText === undefined) !== (minuteText === undefined)) {
    return undefined;
  }
  let time: TimeOfDay | null = null;
  if (hourText !== undefined) {
    const hour = int(hourText, 0, 23);
    const minute = int(minuteText, 0, 59);
    if (hour === undefined || minute === undefined) return undefined;
    time = { hour, minute };
  }
  const pattern = parsePattern(freq, take);
  if (pattern === undefined || parts.size > 0) return undefined;
  return { pattern, interval, time };
}

function parsePattern(
  freq: string | undefined,
  take: (key: string) => string | undefined,
): Pattern | undefined {
  switch (freq) {
    case "DAILY":
      return { freq };
    case "WEEKLY": {
      const days = take("BYDAY")?.split(",");
      if (days === undefined || !days.every(isWeekday)) return undefined;
      const ordered = WEEKDAYS.filter((d) => days.includes(d));
      return ordered.length === days.length ? { freq, days: ordered } : undefined;
    }
    case "MONTHLY": {
      const on = parseMonthDay(take);
      return on === undefined ? undefined : { freq, on };
    }
    case "YEARLY": {
      const month = int(take("BYMONTH"), 1, 12);
      const on = parseMonthDay(take);
      return month === undefined || on === undefined ? undefined : { freq, month, on };
    }
    default:
      return undefined;
  }
}

function parseMonthDay(take: (key: string) => string | undefined): MonthDay | undefined {
  const date = take("BYMONTHDAY");
  const byDay = take("BYDAY");
  const setPos = take("BYSETPOS");
  if (date !== undefined) {
    if (byDay !== undefined || setPos !== undefined) return undefined;
    const day = int(date, -1, 31);
    return day === undefined || day === 0 ? undefined : { kind: "date", day };
  }
  if (byDay === undefined) return undefined;
  if (setPos !== undefined) {
    if (byDay !== WORKING.join(",") || (setPos !== "1" && setPos !== "-1")) return undefined;
    return { kind: "working", position: setPos === "1" ? 1 : -1 };
  }
  const match = ORDINAL.exec(byDay);
  if (match?.[1] === undefined || match[2] === undefined || !isWeekday(match[2])) return undefined;
  return { kind: "weekday", ordinal: Number(match[1]) as Ordinal, weekday: match[2] };
}

/** A rule's text in one canonical order, which `parseRule` reads back to the same rule. */
export function formatRule(value: Rule): string {
  const { pattern } = value;
  const parts = [`FREQ=${pattern.freq}`];
  if (value.interval !== 1) parts.push(`INTERVAL=${String(value.interval)}`);
  if (pattern.freq === "YEARLY") parts.push(`BYMONTH=${String(pattern.month)}`);
  if (pattern.freq === "WEEKLY") parts.push(`BYDAY=${pattern.days.join(",")}`);
  if (pattern.freq === "MONTHLY" || pattern.freq === "YEARLY") {
    const on = pattern.on;
    if (on.kind === "date") parts.push(`BYMONTHDAY=${String(on.day)}`);
    else if (on.kind === "weekday") parts.push(`BYDAY=${String(on.ordinal)}${on.weekday}`);
    else parts.push(`BYDAY=${WORKING.join(",")}`, `BYSETPOS=${String(on.position)}`);
  }
  if (value.time !== null) {
    parts.push(`BYHOUR=${String(value.time.hour)}`, `BYMINUTE=${String(value.time.minute)}`);
  }
  return parts.join(";");
}

/** A stored schedule's rule, or undefined when the schedule cannot be used. */
export function readSchedule(schedule: Schedule): Rule | undefined {
  // A start that is no date of the calendar (30 February) would otherwise roll into the next month.
  const start = dayNumber(schedule.start);
  if (start === undefined || dateOf(start) !== schedule.start) return undefined;
  if (!isTimeZone(schedule.zone)) return undefined;
  return parseRule(schedule.rule);
}

// ---------------------------------------------------------------------------------------------
// Dates: day numbers since 1970-01-01, which was a Thursday.

/** Monday 0 to Sunday 6. */
const weekdayOf = (day: number): number => (((day + 3) % 7) + 7) % 7;

const monthOf = (day: number): number => {
  const [y, m] = dateOf(day).split("-").map(Number);
  return (y ?? 0) * 12 + (m ?? 1) - 1;
};
const firstOfMonth = (month: number): number =>
  Math.floor(Date.UTC(Math.floor(month / 12), month % 12, 1) / 86_400_000);
const lengthOf = (month: number): number => firstOfMonth(month + 1) - firstOfMonth(month);

/** The day a month's MonthDay falls on in month index `month` (year × 12 + month − 1). */
function dayInMonth(month: number, on: MonthDay): number {
  const first = firstOfMonth(month);
  const last = first + lengthOf(month) - 1;
  switch (on.kind) {
    case "date":
      return on.day === -1 ? last : Math.min(first + on.day - 1, last);
    case "weekday": {
      const wd = WEEKDAYS.indexOf(on.weekday);
      if (on.ordinal === -1) return last - ((weekdayOf(last) - wd + 7) % 7);
      return first + ((wd - weekdayOf(first) + 7) % 7) + 7 * (on.ordinal - 1);
    }
    case "working": {
      // Saturday is 5 and Sunday 6: the first moves on to Monday, the last back to Friday.
      if (on.position === 1) return first + (weekdayOf(first) > 4 ? 7 - weekdayOf(first) : 0);
      return last - Math.max(0, weekdayOf(last) - 4);
    }
  }
}

/** The period a day lies in, as the pattern counts periods: a day, a week, a month or a year. */
function periodOf(pattern: Pattern, day: number): number {
  switch (pattern.freq) {
    case "DAILY":
      return day;
    case "WEEKLY":
      return Math.floor((day + 3) / 7);
    case "MONTHLY":
      return monthOf(day);
    case "YEARLY":
      return Math.floor(monthOf(day) / 12);
  }
}

/** The days of one period that the pattern falls on, in order. */
function daysIn(pattern: Pattern, period: number): number[] {
  switch (pattern.freq) {
    case "DAILY":
      return [period];
    case "WEEKLY": {
      const monday = period * 7 - 3;
      return pattern.days.map((d) => monday + WEEKDAYS.indexOf(d));
    }
    case "MONTHLY":
      return [dayInMonth(period, pattern.on)];
    case "YEARLY":
      return [dayInMonth(period * 12 + pattern.month - 1, pattern.on)];
  }
}

/** No rule of the subset needs more periods than this to find its next date. */
const PERIOD_CAP = 4 * MAX_INTERVAL + 8;

/** The first date after `after` that the schedule falls on (never before its start). */
export function nextDate(schedule: Schedule, after: string): string | undefined {
  const value = readSchedule(schedule);
  const start = dayNumber(schedule.start);
  const from = dayNumber(after);
  if (value === undefined || start === undefined || from === undefined) return undefined;
  const { pattern, interval } = value;
  const first = periodOf(pattern, start);
  let period = Math.max(periodOf(pattern, from), first);
  period += (interval - ((period - first) % interval)) % interval;
  for (let i = 0; i < PERIOD_CAP; i += 1, period += interval) {
    const found = daysIn(pattern, period).find((d) => d > from && d >= start);
    if (found !== undefined) return dateOf(found);
  }
  return undefined;
}

/** The last date on or before `onOrBefore` that the schedule falls on, if one comes after its start. */
export function previousDate(schedule: Schedule, onOrBefore: string): string | undefined {
  const value = readSchedule(schedule);
  const start = dayNumber(schedule.start);
  const to = dayNumber(onOrBefore);
  if (value === undefined || start === undefined || to === undefined) return undefined;
  const { pattern, interval } = value;
  const first = periodOf(pattern, start);
  let period = periodOf(pattern, to);
  if (period < first) return undefined;
  period -= (period - first) % interval;
  for (; period >= first; period -= interval) {
    const found = daysIn(pattern, period)
      .filter((d) => d <= to && d >= start)
      .at(-1);
    if (found !== undefined) return dateOf(found);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Instants

const MINUTE = 60_000;
const DAY = 86_400_000;

const parts = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at an instant, in ms: local wall time minus UTC. */
function offsetAt(ms: number, zone: string): number {
  let format = parts.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    parts.set(zone, format);
  }
  const get = (type: string) =>
    Number(format.formatToParts(ms).find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return local - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a local date and time stands for in a zone. A time the spring change skips falls on
 * the first valid minute after the gap; a time the autumn change repeats falls on its first.
 */
export function instantOf(date: string, time: TimeOfDay, zone: string): number {
  const day = dayNumber(date) ?? 0;
  const local = day * DAY + time.hour * 3_600_000 + time.minute * MINUTE;
  const before = offsetAt(local - DAY, zone);
  const after = offsetAt(local + DAY, zone);
  const reads = (u: number) => u + offsetAt(u, zone) === local;
  const found = [local - before, local - after].filter(reads);
  if (found.length > 0) return Math.min(...found);
  // In a gap: the change itself, the first instant on the later offset, lies between the two.
  let lo = Math.min(local - before, local - after);
  let hi = Math.max(local - before, local - after);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offsetAt(mid, zone) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

const timeOf = (value: Rule): TimeOfDay => value.time ?? DEFAULT_RUN_TIME;

/**
 * The first instant after `after` the schedule falls on, at its time of day, else at
 * DEFAULT_RUN_TIME: when an agent's routine is next due.
 */
export function nextInstant(schedule: Schedule, after: number): number | undefined {
  const value = readSchedule(schedule);
  if (value === undefined) return undefined;
  let date = dateOf((dayNumber(localDate(after, schedule.zone)) ?? 0) - 2);
  for (let i = 0; i < 8; i += 1) {
    const next = nextDate(schedule, date);
    if (next === undefined) return undefined;
    date = next;
    const instant = instantOf(date, timeOf(value), schedule.zone);
    if (instant > after) return instant;
  }
  return undefined;
}

/** The last instant on or before `now` the schedule fell on, at its time of day as nextInstant. */
export function latestInstant(schedule: Schedule, now: number): number | undefined {
  const value = readSchedule(schedule);
  if (value === undefined) return undefined;
  let date: string | undefined = dateOf((dayNumber(localDate(now, schedule.zone)) ?? 0) + 2);
  for (let i = 0; i < 8; i += 1) {
    date = previousDate(schedule, date);
    if (date === undefined) return undefined;
    const instant = instantOf(date, timeOf(value), schedule.zone);
    if (instant <= now) return instant;
    date = dateOf((dayNumber(date) ?? 0) - 1);
  }
  return undefined;
}

/** What the clock does with an agent's routine now: the slot it claims, and the next due time. */
export interface Claim {
  /** The latest due time that has passed: the one run after any absence, however long. */
  readonly due: number;
  /** The first due time after now, which the routine moves on to. */
  readonly next: number;
}

/**
 * The claim on a routine due at `dueAt`, or undefined while that is still to come. However many
 * due times passed since, it claims the latest of them, once.
 */
export function claim(schedule: Schedule, dueAt: number, now: number): Claim | undefined {
  if (dueAt > now) return undefined;
  const latest = latestInstant(schedule, now);
  const next = nextInstant(schedule, now);
  if (next === undefined) return undefined;
  return { due: Math.max(latest ?? dueAt, dueAt), next };
}

/** When the next occurrence of a task a person does falls: a date, and a due time when it has one. */
export interface Following {
  readonly date: string;
  /** The due time, for a rule with a time of day. */
  readonly at?: number;
}

/**
 * The next occurrence of a task a person finished or dropped at `now` whose own date was `own`:
 * the schedule's first time after both now and that date, so finishing early or late never makes
 * two for one period and never piles up the ones that were missed.
 */
export function following(schedule: Schedule, now: number, own: string): Following | undefined {
  const value = readSchedule(schedule);
  if (value === undefined) return undefined;
  if (value.time === null) {
    const today = localDate(now, schedule.zone);
    const date = nextDate(schedule, today > own ? today : own);
    return date === undefined ? undefined : { date };
  }
  const ownAt = instantOf(own, value.time, schedule.zone);
  const next = nextInstant(schedule, Math.max(now, ownAt));
  return next === undefined ? undefined : { date: localDate(next, schedule.zone), at: next };
}
