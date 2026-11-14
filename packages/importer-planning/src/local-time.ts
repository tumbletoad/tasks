// Days and instants in the import machine's time zone (A7 3.15.3). The prototype writes days
// (`YYYY-MM-DD`) and event times; the space stores millisecond instants and days. A day becomes
// 09:00 on that day in the import's time zone, and a star's day is the day of its event's instant
// in that zone. The zone is an input, so the mapping reads no clock and no environment.

import { eventInstant } from "./events.ts";

/** The writer's instant range (A1 3.4: 1970 to 9999-12-31T23:59:59.999Z). */
export const INSTANT_MAX = 253_402_300_799_999;

/** An IANA zone name, as the writer takes one (A1 3.4); a bare offset is not a zone. */
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether `name` is an IANA time zone this runtime knows. */
export function isTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || name.length > 64 || !ZONE.test(name)) return false;
  try {
    formatter(name);
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock time in `timeZone` at `ms`, to the second. */
function wallAt(ms: number, timeZone: string): Wall {
  const parts = formatter(timeZone).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The instant whose UTC wall clock reads `w`. `Date.UTC` would read years 0 to 99 as 19xx. */
function utcOf(w: Wall): number {
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  d.setUTCHours(w.hour, w.minute, w.second, 0);
  return d.getTime();
}

/** The zone's offset from UTC at `ms`, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const whole = ms - (((ms % 1000) + 1000) % 1000);
  return utcOf(wallAt(whole, timeZone)) - whole;
}

/**
 * The instant of 09:00 on `date` (`YYYY-MM-DD`) in `timeZone`, or undefined when it is outside
 * the writer's range. In a gap of a clock change the later reading is taken.
 */
export function nineOClock(date: string, timeZone: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return undefined;
  const wall = utcOf({
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: 9,
    minute: 0,
    second: 0,
  });
  const first = wall - offsetAt(wall, timeZone);
  const at = wall - offsetAt(first, timeZone);
  return inRange(at) ? at : undefined;
}

/** The calendar day in `timeZone` at the instant `ms`, as `YYYY-MM-DD`. */
export function localDay(ms: number, timeZone: string): string {
  const w = wallAt(ms, timeZone);
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}`;
}

/** Microseconds from 0001-01-01 to 1970-01-01: 719,162 days. */
const UNIX_EPOCH_MICROS = 719_162n * 86_400_000_000n;

/**
 * The millisecond instant of an event's `at` (A7 3.15.2), its microseconds cut, or undefined when
 * the text is no event time or the instant is outside the writer's range.
 */
export function eventMillis(at: string): number | undefined {
  const micros = eventInstant(at);
  if (micros === undefined) return undefined;
  const since = micros - UNIX_EPOCH_MICROS;
  // BigInt division truncates towards zero; an instant before 1970 is out of range anyway.
  if (since < 0n) return undefined;
  const ms = Number(since / 1000n);
  return inRange(ms) ? ms : undefined;
}

function inRange(ms: number): boolean {
  return Number.isSafeInteger(ms) && ms >= 0 && ms <= INSTANT_MAX;
}
