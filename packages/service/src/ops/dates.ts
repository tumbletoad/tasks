// Dates in inputs (A3 3.4.1): an ISO date, or a short phrase in the space's time zone. The phrases
// of this build are the common ones: today, tomorrow, +3d, +2w and a weekday (the next one, today
// included). A phrase this build does not know is `invalid_input`, never a guess. Until a space
// has its own time zone preference, the space's time zone is this machine's.

const ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const OFFSET = /^\+([1-9][0-9]{0,2})([dw])$/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** This machine's IANA time zone. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The calendar date of `ms` in `timeZone`, as `YYYY-MM-DD`. */
export function dateIn(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
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

const FULL: Readonly<Record<(typeof WEEKDAYS)[number], string>> = {
  sun: "sunday",
  mon: "monday",
  tue: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  fri: "friday",
  sat: "saturday",
};
