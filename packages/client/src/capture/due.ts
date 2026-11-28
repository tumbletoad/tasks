// What the due date's text field reads: an ISO date, `tod` and
// `today`, `tom` and `tomorrow`, a weekday (today when it is that day, as the service reads it),
// `+3d` and `+2w`, and `-` to clear. The page turns every one into a calendar date before it
// sends, so what the preview shows is exactly what is saved. Pure: the day it counts from is given.
//
// chrono-node's natural phrases in the space's language are not read yet: they would add a
// dependency for phrasings the quick picks and the month grid already cover.

export type DueReading =
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "clear" }
  | { readonly kind: "empty" }
  | { readonly kind: "invalid" };

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const FULL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/u;
const OFFSET = /^\+(\d{1,3})\s*([dw])$/u;

/** Whether `text` is a real calendar date, YYYY-MM-DD. */
export function isDate(text: string): boolean {
  const match = ISO.exec(text);
  if (match === null) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** A calendar date `n` days after `date` (before, for a negative `n`). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n)).toISOString().slice(0, 10);
}

/** The weekday of a calendar date, 0 for Sunday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

/** The same day `n` months on, kept inside the month (31 Jan + 1 month is 28 or 29 Feb). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d ?? 1, last));
  return first.toISOString().slice(0, 10);
}

export function readDue(text: string, today: string): DueReading {
  const word = text.trim().toLowerCase();
  if (word === "") return { kind: "empty" };
  if (word === "-") return { kind: "clear" };
  if (isDate(word)) return { kind: "date", date: word };
  if (word === "tod" || word === "today") return { kind: "date", date: today };
  if (word === "tom" || word === "tomorrow") return { kind: "date", date: addDays(today, 1) };
  const offset = OFFSET.exec(word);
  if (offset !== null) {
    const n = Number(offset[1]);
    return { kind: "date", date: addDays(today, offset[2] === "w" ? n * 7 : n) };
  }
  let day = WEEKDAYS.findIndex((name) => name === word);
  if (day < 0) day = FULL.indexOf(word);
  if (day >= 0) return { kind: "date", date: addDays(today, (day - weekdayOf(today) + 7) % 7) };
  return { kind: "invalid" };
}

/** The quick picks: Today, Tomorrow, Next Monday, In a week. None clears. */
export function quickPicks(today: string): {
  readonly today: string;
  readonly tomorrow: string;
  readonly nextMonday: string;
  readonly inAWeek: string;
} {
  const toMonday = (1 - weekdayOf(today) + 7) % 7;
  return {
    today,
    tomorrow: addDays(today, 1),
    // "Next Monday" is never today: on a Monday it is the one a week on.
    nextMonday: addDays(today, toMonday === 0 ? 7 : toMonday),
    inAWeek: addDays(today, 7),
  };
}
