// Dates in inputs (A3 3.4.1): an ISO date, or a short phrase in the space's time zone. The phrases
// of this build are the common ones: today, tomorrow, +3d, +2w and a weekday (the next one, today
// included). A phrase this build does not know is `invalid_input`, never a guess. Until a space
// has its own time zone preference, the space's time zone is this machine's.
import { localDate } from "@ttasks/contracts/day";

const ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const OFFSET = /^\+([1-9][0-9]{0,2})([dw])$/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** This machine's IANA time zone. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `date` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const match = ISO.exec(date);
  if (match === null) throw new RangeError("Not an ISO date");
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  return new Date(utc).toISOString().slice(0, 10);
}

function isCalendarDate(text: string): boolean {
  const match = ISO.exec(text);
  if (match === null) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The ISO date a due phrase names, from `today`, or undefined when this build does not know it. */
export function dueDate(phrase: string, today: string): string | undefined {
  const text = phrase.trim().toLowerCase();
  if (isCalendarDate(text)) return text;
  if (text === "today") return today;
  if (text === "tomorrow") return addDays(today, 1);
  const offset = OFFSET.exec(text);
  if (offset !== null) {
    const n = Number(offset[1]);
    return addDays(today, offset[2] === "w" ? n * 7 : n);
  }
  const named = WEEKDAYS.findIndex((name) => text === name || text === FULL[name]);
  if (named >= 0) {
    const now = new Date(`${today}T00:00:00Z`).getUTCDay();
    return addDays(today, (named - now + 7) % 7);
  }
  return undefined;
}

/** An instant with a time and an offset, such as `2026-03-02T14:05:00+01:00`. */
const INSTANT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

/** A clock a few minutes ahead of this machine's still says "now", not the future. */
const AHEAD_MS = 5 * 60_000;

/** The offset of `timeZone` from UTC at `ms`, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wall - Math.floor(ms / 1000) * 1000;
}

/**
 * When something happened before it was added here, as an instant: an instant with its offset as
 * given, or a date at nine in the morning in `timeZone` (no later than `now`), as the planning
 * import dates an added day. Undefined for anything else; `future` for a time after `now`.
 */
export function pastInstant(
  text: string,
  now: number,
  timeZone: string,
): number | "future" | undefined {
  const value = text.trim();
  let at: number;
  if (isCalendarDate(value)) {
    if (value > localDate(now, timeZone)) return "future";
    const nine = Date.parse(`${value}T09:00:00Z`);
    at = Math.min(nine - offsetAt(nine - offsetAt(nine, timeZone), timeZone), now);
  } else if (INSTANT.test(value) && isCalendarDate(value.slice(0, 10))) {
    at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    if (at > now + AHEAD_MS) return "future";
    at = Math.min(at, now);
  } else {
    return undefined;
  }
  return at;
}

const FULL: Readonly<Record<(typeof WEEKDAYS)[number], string>> = {
  sun: "sunday",
  mon: "monday",
  tue: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  fri: "friday",
  sat: "saturday",
};
