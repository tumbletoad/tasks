// A schedule in the words a person reads: "Every Saturday", "The first working day of every
// month", "Every weekday at 07:00". The sentence is the catalogue's; weekday and month names and
// the time come from Intl in the page's locale, and a list of days is joined as the locale joins.
import type { MonthDay, Ordinal, Rule, Weekday } from "@ttasks/contracts/schedule";
import { WEEKDAYS } from "@ttasks/contracts/schedule";
import type { Translate } from "../i18n/intl.tsx";
import { formatDay, formatter } from "./dates.ts";

/** What the words need of the page: its messages, how it joins a list, and its locale. */
export interface ScheduleWording {
  readonly t: Translate;
  readonly list: (items: readonly string[]) => string;
  readonly locale: string;
}

const LEAP_YEAR = 2024;

const ORDINALS: Readonly<Record<Ordinal, string>> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  [-1]: "last",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** 1 January 2024 was a Monday: WEEKDAYS' index counts on from it. */
const weekdayName = (day: Weekday, locale: string): string =>
  formatDay(`2024-01-${pad(1 + WEEKDAYS.indexOf(day))}`, locale, { weekday: "long" });

const monthName = (month: number, locale: string): string =>
  formatDay(`${String(LEAP_YEAR)}-${pad(month)}-01`, locale, { month: "long" });

/** A date of a month in a leap year, so every day of every month has a name. */
function dateName(month: number, day: number, locale: string): string {
  const length = new Date(Date.UTC(LEAP_YEAR, month, 0)).getUTCDate();
  return formatDay(`${String(LEAP_YEAR)}-${pad(month)}-${pad(Math.min(day, length))}`, locale, {
    day: "numeric",
    month: "long",
  });
}

function monthWords(on: MonthDay, interval: number, w: ScheduleWording): string {
  switch (on.kind) {
    case "date":
      return on.day === -1
        ? w.t("schedule.monthLast", { interval })
        : w.t("schedule.monthDate", { interval, day: on.day });
    case "weekday":
      return w.t("schedule.monthWeekday", {
        interval,
        ordinal: ORDINALS[on.ordinal],
        weekday: weekdayName(on.weekday, w.locale),
      });
    case "working":
      return w.t("schedule.monthWorking", {
        interval,
        position: on.position === 1 ? "first" : "last",
      });
  }
}

function yearWords(month: number, on: MonthDay, interval: number, w: ScheduleWording): string {
  const name = monthName(month, w.locale);
  switch (on.kind) {
    case "date":
      return on.day === -1
        ? w.t("schedule.yearLast", { interval, month: name })
        : w.t("schedule.yearDate", { interval, date: dateName(month, on.day, w.locale) });
    case "weekday":
      return w.t("schedule.yearWeekday", {
        interval,
        month: name,
        ordinal: ORDINALS[on.ordinal],
        weekday: weekdayName(on.weekday, w.locale),
      });
    case "working":
      return w.t("schedule.yearWorking", {
        interval,
        month: name,
        position: on.position === 1 ? "first" : "last",
      });
  }
}

function patternWords(rule: Rule, w: ScheduleWording): string {
  const { pattern, interval } = rule;
  switch (pattern.freq) {
    case "DAILY":
      return w.t("schedule.daily", { interval });
    case "WEEKLY":
      if (interval === 1 && pattern.days.join() === "MO,TU,WE,TH,FR") {
        return w.t("schedule.weekdays");
      }
      return w.t("schedule.weekly", {
        interval,
        days: w.list(pattern.days.map((d) => weekdayName(d, w.locale))),
      });
    case "MONTHLY":
      return monthWords(pattern.on, interval, w);
    case "YEARLY":
      return yearWords(pattern.month, pattern.on, interval, w);
  }
}

/** The schedule as a person reads it, with its time of day when it has one. */
export function scheduleWords(rule: Rule, w: ScheduleWording): string {
  const words = patternWords(rule, w);
  if (rule.time === null) return words;
  const time = formatter(w.locale, "UTC", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(Date.UTC(2000, 0, 1, rule.time.hour, rule.time.minute));
  return w.t("schedule.at", { schedule: words, time });
}
