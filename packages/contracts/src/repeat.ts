// A schedule in plain English words, as an agent writes `repeat` and a person types it in the
// capture line ("every saturday", "weekdays at 7", "the first monday of every month"), and the words
// an agent reads back. A small grammar, not a language: what it does not read is no schedule, and
// the caller says so. The page says a schedule in its own catalogue's words (web/row/schedule.ts).
import { dayNumber } from "./day.ts";
import {
  MAX_INTERVAL,
  WEEKDAYS,
  presets,
  type MonthDay,
  type Ordinal,
  type Rule,
  type TimeOfDay,
  type Weekday,
} from "./schedule.ts";

const DAY_NAMES: readonly (readonly [Weekday, string])[] = [
  ["MO", "monday"],
  ["TU", "tuesday"],
  ["WE", "wednesday"],
  ["TH", "thursday"],
  ["FR", "friday"],
  ["SA", "saturday"],
  ["SU", "sunday"],
];

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const ORDINAL_WORDS: Readonly<Record<string, Ordinal>> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  last: -1,
};

/** A weekday by its name, its first three letters or a plural ("saturdays"). */
function weekday(word: string): Weekday | undefined {
  const w = word.replace(/s$/u, "");
  for (const [day, name] of DAY_NAMES) {
    if (w === name || (w.length >= 3 && name.startsWith(w))) return day;
  }
  return undefined;
}

/** A month by its name or its first three letters, 1 to 12. */
function month(word: string): number | undefined {
  const i = MONTHS.findIndex(
    (name) => word === name || (word.length >= 3 && name.startsWith(word)),
  );
  return i < 0 ? undefined : i + 1;
}

/** "monday", "mon, wed and fri", "monday & thursday": the days in the week's order. */
function days(text: string): Weekday[] | undefined {
  const words = text.split(/\s*(?:,|\band\b|&|\+)\s*|\s+/u).filter((w) => w !== "");
  if (words.length === 0) return undefined;
  const found = words.map(weekday);
  if (found.some((d) => d === undefined)) return undefined;
  return WEEKDAYS.filter((d) => found.includes(d));
}

/** "15th", "the 15th", "15", "the last day": a day of the month, -1 its last. */
function dayOfMonth(text: string): number | undefined {
  const t = text.replace(/^the\s+/u, "");
  if (t === "last day" || t === "last") return -1;
  const m = /^(\d{1,2})(?:st|nd|rd|th)?$/u.exec(t);
  const day = m?.[1] === undefined ? undefined : Number(m[1]);
  return day !== undefined && day >= 1 && day <= 31 ? day : undefined;
}

/** "the first monday", "last friday", "first working day": a day of the month by its turn. */
function turn(text: string): MonthDay | undefined {
  const m = /^(?:the\s+)?(\S+)\s+(.+)$/u.exec(text);
  const ordinal = m?.[1] === undefined ? undefined : ORDINAL_WORDS[m[1]];
  const rest = m?.[2];
  if (ordinal === undefined || rest === undefined) return undefined;
  if (rest === "working day" || rest === "weekday" || rest === "business day") {
    return ordinal === 1 || ordinal === -1 ? { kind: "working", position: ordinal } : undefined;
  }
  if (rest === "day") return ordinal === -1 ? { kind: "date", day: -1 } : undefined;
  const day = weekday(rest);
  return day === undefined ? undefined : { kind: "weekday", ordinal, weekday: day };
}

/** "every", "every 2", "every other": how many periods apart, or undefined for none of them. */
function every(word: string | undefined): number | undefined {
  if (word === undefined || word === "") return 1;
  if (word === "other") return 2;
  const n = Number(word);
  return Number.isInteger(n) && n >= 1 && n <= MAX_INTERVAL ? n : undefined;
}

/** "at 7", "at 07:30", "at 7pm", "at 7.30 am": a time of day. */
function timeOf(text: string): TimeOfDay | undefined {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/u.exec(text);
  if (m?.[1] === undefined) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (m[3] !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (m[3] === "pm" ? 12 : 0);
  }
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
}

const with_ = (rule: Rule, interval: number): Rule => ({ ...rule, interval });

/** The words of a pattern without its time; `today` fills in "every week", "every month". */
function pattern(text: string, today: string): Rule | undefined {
  const date = dayNumber(today);
  if (date === undefined) return undefined;
  // 1970-01-01 was a Thursday: WEEKDAYS counts from Monday.
  const todays = WEEKDAYS[(date + 3) % 7] as Weekday;
  const [, monthNow, dayNow] = today.split("-").map(Number) as [number, number, number];
  let m: RegExpExecArray | null;
  if (text === "daily" || text === "every day" || text === "each day") return presets.daily();
  if (/^(?:every|each) (?:weekday|working day|business day)s?$|^weekdays$/u.test(text)) {
    return presets.weekdays();
  }
  if ((m = /^every (\d+|other) days?$/u.exec(text)) !== null) {
    const n = every(m[1]);
    return n === undefined ? undefined : presets.daily(n);
  }
  if (text === "weekly" || text === "every week" || text === "each week") {
    return presets.weekly([todays]);
  }
  if ((m = /^(?:weekly on|on) (.+)$/u.exec(text)) !== null) {
    const found = days(m[1] ?? "");
    return found === undefined ? undefined : presets.weekly(found);
  }
  if ((m = /^every (\d+|other) weeks?(?: on (.+))?$/u.exec(text)) !== null) {
    const n = every(m[1]);
    const found = m[2] === undefined ? [todays] : days(m[2]);
    return n === undefined || found === undefined ? undefined : presets.weekly(found, n);
  }
  if (text === "monthly" || text === "every month" || text === "each month") {
    return presets.monthly(dayNow);
  }
  if ((m = /^(?:every|each) (?:(\d+|other) )?months?(?: on (.+))?$/u.exec(text)) !== null) {
    const n = every(m[1]);
    if (n === undefined) return undefined;
    if (m[2] === undefined) return with_(presets.monthly(dayNow), n);
    const day = dayOfMonth(m[2]);
    if (day !== undefined) return presets.monthly(day, n);
    const on = turn(m[2]);
    return on === undefined ? undefined : monthly(on, n);
  }
  const yearTurn = /^(?:the )?(.+?) of ([a-z]+),? (?:every|each) (?:(\d+|other) )?years?$/u;
  if ((m = yearTurn.exec(text)) !== null) {
    const n = every(m[3]);
    const on = turn(m[1] ?? "");
    const named = month(m[2] ?? "");
    return n === undefined || on === undefined || named === undefined
      ? undefined
      : { pattern: { freq: "YEARLY", month: named, on }, interval: n, time: null };
  }
  const monthOf = /^(?:on )?(.+?) of (?:the month|(?:every|each) (?:(\d+|other) )?months?)$/u;
  if ((m = monthOf.exec(text)) !== null) {
    const n = every(m[2]);
    const on = turn(m[1] ?? "") ?? dateOn(m[1] ?? "");
    return n === undefined || on === undefined ? undefined : monthly(on, n);
  }
  if ((m = /^monthly on (.+)$/u.exec(text)) !== null) {
    const on = turn(m[1] ?? "") ?? dateOn(m[1] ?? "");
    return on === undefined ? undefined : monthly(on, 1);
  }
  if (text === "yearly" || text === "every year" || text === "each year" || text === "annually") {
    return presets.yearly(monthNow, dayNow);
  }
  if ((m = /^(?:every|each) (?:(\d+|other) )?years? on (.+)$/u.exec(text)) !== null) {
    const n = every(m[1]);
    const on = yearDate(m[2] ?? "");
    return n === undefined || on === undefined ? undefined : with_(on, n);
  }
  if ((m = /^(?:every|each) (\d+|other) years?$/u.exec(text)) !== null) {
    const n = every(m[1]);
    return n === undefined ? undefined : with_(presets.yearly(monthNow, dayNow), n);
  }
  if ((m = /^(?:every|each) (.+)$/u.exec(text)) !== null) {
    const rest = m[1] ?? "";
    const found = days(rest);
    if (found !== undefined) return presets.weekly(found);
    const on = turn(rest);
    if (on !== undefined) return monthly(on, 1);
    return yearDate(rest);
  }
  // "saturdays", "mondays and thursdays"; a day named once is a date, not a schedule.
  if (/^[a-z]+days?(?:\s*(?:,|and|&)\s*[a-z]+days)*$/u.test(text) && /s$/u.test(text)) {
    const found = days(text);
    return found === undefined ? undefined : presets.weekly(found);
  }
  return undefined;
}

const dateOn = (text: string): MonthDay | undefined => {
  const day = dayOfMonth(text);
  return day === undefined ? undefined : { kind: "date", day };
};

const monthly = (on: MonthDay, interval: number): Rule => ({
  pattern: { freq: "MONTHLY", on },
  interval,
  time: null,
});

/** "14 december", "december 14", "dec 14th": a date of every year. */
function yearDate(text: string): Rule | undefined {
  const last = /^(?:the )?last day of ([a-z]+)$/u.exec(text);
  if (last !== null) {
    const n = month(last[1] ?? "");
    return n === undefined ? undefined : presets.yearly(n, -1);
  }
  const m =
    /^(?:the )?(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)$|^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?$/u.exec(
      text,
    );
  if (m === null) return undefined;
  const dayText = m[1] ?? m[4];
  const monthText = m[2] ?? m[3];
  const n = monthText === undefined ? undefined : month(monthText);
  const day = Number(dayText);
  if (n === undefined || !(day >= 1 && day <= 31)) return undefined;
  return presets.yearly(n, day);
}

/**
 * The rule a schedule's words say, or undefined when they say none this grammar reads. `today`
 * (YYYY-MM-DD) is the day "every week" and "every month" count from.
 */
export function parseRepeat(words: string, today: string): Rule | undefined {
  let text = words
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, "")
    .replace(/\s+/gu, " ");
  let time: TimeOfDay | null = null;
  const at = /^(.*?)\s+at\s+(.+)$/u.exec(text);
  if (at !== null) {
    const found = timeOf(at[2] ?? "");
    if (found === undefined) return undefined;
    time = found;
    text = at[1] ?? "";
  }
  const rule = pattern(text, today);
  return rule === undefined ? undefined : { ...rule, time };
}

// ---------------------------------------------------------------------------------------------
// The words an agent reads

const NAME: Readonly<Record<Weekday, string>> = Object.fromEntries(
  DAY_NAMES.map(([d, name]) => [d, name.charAt(0).toUpperCase() + name.slice(1)]),
) as Record<Weekday, string>;

const MONTH_NAME = (n: number): string => {
  const name = MONTHS[n - 1] ?? "";
  return name.charAt(0).toUpperCase() + name.slice(1);
};

const ORDINAL_NAME: Readonly<Record<Ordinal, string>> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  [-1]: "last",
};

const nth = (n: number): string => {
  const ten = n % 100;
  const suffix = ten >= 11 && ten <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${String(n)}${suffix}`;
};

const list = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;

const periods = (interval: number, one: string, many: string): string =>
  interval === 1 ? one : many.replace("#", String(interval));

function onMonth(on: MonthDay): string {
  switch (on.kind) {
    case "date":
      return on.day === -1 ? "the last day" : `the ${nth(on.day)}`;
    case "weekday":
      return `the ${ORDINAL_NAME[on.ordinal]} ${NAME[on.weekday]}`;
    case "working":
      return `the ${on.position === 1 ? "first" : "last"} working day`;
  }
}

/**
 * The date from which a yearly date falls on its month's last day every year: the 29th of February,
 * which an ordinary year moves to the 28th, else the month's own length (as the page says it).
 */
const lastDayFrom = (n: number): number =>
  n === 2 ? 29 : new Date(Date.UTC(2024, n, 0)).getUTCDate();

/** A rule in English, as `repeat` reads it back: "Every Saturday", "Every weekday at 07:00". */
export function repeatWords(rule: Rule): string {
  const { pattern: p, interval } = rule;
  let words: string;
  switch (p.freq) {
    case "DAILY":
      words = periods(interval, "Every day", "Every # days");
      break;
    case "WEEKLY":
      words =
        interval === 1 && p.days.join() === "MO,TU,WE,TH,FR"
          ? "Every weekday"
          : interval === 1
            ? `Every ${list(p.days.map((d) => NAME[d]))}`
            : `Every ${String(interval)} weeks on ${list(p.days.map((d) => NAME[d]))}`;
      break;
    case "MONTHLY":
      words =
        p.on.kind === "date"
          ? `${periods(interval, "Every month", "Every # months")} on ${onMonth(p.on)}`
          : `${onMonth(p.on).replace(/^the/u, "The")} of ${periods(interval, "every month", "every # months")}`;
      break;
    case "YEARLY":
      words =
        p.on.kind === "date"
          ? `${periods(interval, "Every year", "Every # years")} on ${
              p.on.day === -1 || p.on.day >= lastDayFrom(p.month)
                ? `the last day of ${MONTH_NAME(p.month)}`
                : `${String(p.on.day)} ${MONTH_NAME(p.month)}`
            }`
          : `${onMonth(p.on).replace(/^the/u, "The")} of ${MONTH_NAME(p.month)}, ${periods(interval, "every year", "every # years")}`;
      break;
  }
  if (rule.time === null) return words;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${words} at ${pad(rule.time.hour)}:${pad(rule.time.minute)}`;
}
