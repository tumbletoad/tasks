// The schedule calculator against a plain day-by-day walk written apart from it, in zones with and
// without daylight saving, on fixed clocks only. Fixture dates and times.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { dateOf, dayNumber, localDate } from "./day.ts";
import {
  WEEKDAYS,
  at,
  claim,
  following,
  formatRule,
  instantOf,
  latestInstant,
  nextDate,
  nextInstant,
  parseRule,
  presets,
  previousDate,
  type MonthDay,
  type Pattern,
  type Rule,
  type Schedule,
  type TimeOfDay,
} from "./schedule.ts";

const ZONES = [
  "UTC",
  "Europe/Amsterdam",
  "America/New_York",
  "America/St_Johns",
  "America/Santiago",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "Asia/Kolkata",
] as const;

const day = (date: string): number => dayNumber(date) ?? Number.NaN;
const schedule = (value: Rule, start: string, zone = "Europe/Amsterdam"): Schedule => ({
  rule: formatRule(value),
  start,
  zone,
});

// ---------------------------------------------------------------------------------------------
// The reference: whether a date is one the rule falls on, from the calendar of `Date` alone.

const utc = (d: number) => new Date(d * 86_400_000);
const isoWeekday = (d: number) => (utc(d).getUTCDay() + 6) % 7;
const monthIndex = (d: number) => utc(d).getUTCFullYear() * 12 + utc(d).getUTCMonth();

function daysOfMonth(month: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= 31; d += 1) {
    const date = new Date(Date.UTC(Math.floor(month / 12), month % 12, d));
    if (date.getUTCMonth() === month % 12) out.push(Math.round(date.getTime() / 86_400_000));
  }
  return out;
}

function expectedIn(month: number, on: MonthDay): number {
  const days = daysOfMonth(month);
  const last = (list: number[]) => list[list.length - 1] ?? Number.NaN;
  if (on.kind === "date") return on.day === -1 ? last(days) : (days[on.day - 1] ?? last(days));
  if (on.kind === "working") {
    const working = days.filter((d) => isoWeekday(d) < 5);
    return on.position === 1 ? (working[0] ?? Number.NaN) : last(working);
  }
  const same = days.filter((d) => isoWeekday(d) === WEEKDAYS.indexOf(on.weekday));
  return on.ordinal === -1 ? last(same) : (same[on.ordinal - 1] ?? Number.NaN);
}

function falls(value: Rule, start: number, d: number): boolean {
  if (d < start) return false;
  const p = value.pattern;
  const every = (n: number) => n % value.interval === 0;
  switch (p.freq) {
    case "DAILY":
      return every(d - start);
    case "WEEKLY": {
      const weeks = (d - isoWeekday(d) - (start - isoWeekday(start))) / 7;
      return p.days.includes(WEEKDAYS[isoWeekday(d)] ?? "MO") && every(weeks);
    }
    case "MONTHLY":
      return every(monthIndex(d) - monthIndex(start)) && expectedIn(monthIndex(d), p.on) === d;
    case "YEARLY": {
      const years = utc(d).getUTCFullYear() - utc(start).getUTCFullYear();
      return (
        every(years) &&
        utc(d).getUTCMonth() === p.month - 1 &&
        expectedIn(monthIndex(d), p.on) === d
      );
    }
  }
}

function walkNext(value: Rule, start: number, after: number): number | undefined {
  for (let d = after + 1; d <= after + 366 * 5; d += 1) if (falls(value, start, d)) return d;
  return undefined;
}

function walkPrevious(value: Rule, start: number, to: number): number | undefined {
  for (let d = to; d >= start; d -= 1) if (falls(value, start, d)) return d;
  return undefined;
}

/** A local reading of an instant, from Intl alone: `YYYY-MM-DD HH:MM`. */
function reading(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const wall = (date: string, time: TimeOfDay) => `${date} ${pad(time.hour)}:${pad(time.minute)}`;

// ---------------------------------------------------------------------------------------------
// Arbitraries

const weekday = fc.constantFrom(...WEEKDAYS);
const monthDay: fc.Arbitrary<MonthDay> = fc.oneof(
  fc
    .integer({ min: -1, max: 31 })
    .filter((d) => d !== 0)
    .map((d) => ({ kind: "date", day: d }) as const),
  fc
    .record({ ordinal: fc.constantFrom(1, 2, 3, 4, -1 as const), weekday })
    .map((o) => ({ kind: "weekday", ...o }) as const),
  fc.constantFrom(1, -1 as const).map((position) => ({ kind: "working", position }) as const),
);
const pattern: fc.Arbitrary<Pattern> = fc.oneof(
  fc.constant({ freq: "DAILY" } as const),
  fc.subarray([...WEEKDAYS], { minLength: 1 }).map((days) => ({ freq: "WEEKLY", days }) as const),
  monthDay.map((on) => ({ freq: "MONTHLY", on }) as const),
  fc
    .record({ month: fc.integer({ min: 1, max: 12 }), on: monthDay })
    .map((y) => ({ freq: "YEARLY", ...y }) as const),
);
const time = fc.record({
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.integer({ min: 0, max: 59 }),
});
const rule = (maxInterval: number): fc.Arbitrary<Rule> =>
  fc.record({
    pattern,
    interval: fc.integer({ min: 1, max: maxInterval }),
    time: fc.option(time, { nil: null }),
  });
/** Days from 2020 to 2031, around the daylight-saving changes of every zone above. */
const aDay = fc.integer({ min: day("2020-01-01"), max: day("2031-12-31") });
const zone = fc.constantFrom(...ZONES);

describe("[A4.routines.schedule.rule] the stored form of a schedule", () => {
  test("every rule of the subset reads back as itself", () => {
    fc.assert(
      fc.property(rule(99), (value) => {
        const text = formatRule(value);
        expect(parseRule(text)).toEqual(value);
        expect(formatRule(parseRule(text) ?? value)).toBe(text);
      }),
    );
  });

  test("the presets write the rules the design names", () => {
    expect(formatRule(presets.weekly(["SA"]))).toBe("FREQ=WEEKLY;BYDAY=SA");
    expect(formatRule(at(presets.weekdays(), { hour: 7, minute: 0 }))).toBe(
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0",
    );
    expect(formatRule(presets.workingDay(1))).toBe("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1");
    expect(formatRule(presets.monthly(15, 3))).toBe("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15");
    expect(formatRule(presets.monthlyOn(-1, "FR"))).toBe("FREQ=MONTHLY;BYDAY=-1FR");
    expect(formatRule(presets.yearly(12, 14))).toBe("FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=14");
    expect(formatRule(presets.weekly(["TH", "MO"], 2))).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH");
  });

  test("a text outside the subset is no rule", () => {
    for (const text of [
      "",
      "FREQ=HOURLY",
      "FREQ=WEEKLY",
      "FREQ=DAILY;BYDAY=MO",
      "FREQ=DAILY;COUNT=3",
      "FREQ=DAILY;INTERVAL=0",
      "FREQ=DAILY;INTERVAL=100",
      "FREQ=DAILY;FREQ=DAILY",
      "FREQ=DAILY;BYHOUR=7",
      "FREQ=DAILY;BYHOUR=24;BYMINUTE=0",
      "FREQ=WEEKLY;BYDAY=MO,MO",
      "FREQ=WEEKLY;BYDAY=1MO",
      "FREQ=MONTHLY;BYMONTHDAY=0",
      "FREQ=MONTHLY;BYMONTHDAY=32",
      "FREQ=MONTHLY;BYDAY=5MO",
      "FREQ=MONTHLY;BYDAY=MO",
      "FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1",
      "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=2",
      "FREQ=MONTHLY;BYMONTHDAY=1;BYDAY=1MO",
      "FREQ=YEARLY;BYMONTHDAY=1",
      "FREQ=YEARLY;BYMONTH=13;BYMONTHDAY=1",
    ]) {
      expect(parseRule(text), text).toBeUndefined();
    }
  });
});

describe("[A4.routines.schedule.dates] the dates a schedule falls on", () => {
  test("every Saturday, the first working day, the 31st and the last Friday", () => {
    const saturday = schedule(presets.weekly(["SA"]), "2026-11-28");
    expect(nextDate(saturday, "2026-11-28")).toBe("2026-12-05");
    expect(nextDate(saturday, "2026-11-27")).toBe("2026-11-28");
    expect(nextDate(saturday, "2026-01-01")).toBe("2026-11-28");
    const working = schedule(presets.workingDay(1), "2026-01-01");
    expect(nextDate(working, "2026-01-31")).toBe("2026-02-02");
    const lastWorking = schedule(presets.workingDay(-1), "2026-01-01");
    expect(nextDate(lastWorking, "2026-02-01")).toBe("2026-02-27");
    const end = schedule(presets.monthly(31), "2026-01-31");
    expect(nextDate(end, "2026-01-31")).toBe("2026-02-28");
    expect(nextDate(end, "2028-02-01")).toBe("2028-02-29");
    expect(nextDate(end, "2026-04-01")).toBe("2026-04-30");
    const friday = schedule(presets.monthlyOn(-1, "FR"), "2026-11-01");
    expect(nextDate(friday, "2026-11-01")).toBe("2026-11-27");
    const quarter = schedule(presets.monthly(15, 3), "2026-01-15");
    expect(nextDate(quarter, "2026-01-15")).toBe("2026-04-15");
    expect(previousDate(quarter, "2026-07-14")).toBe("2026-04-15");
    expect(previousDate(quarter, "2026-01-14")).toBeUndefined();
  });

  test("the next and the previous date are the walk's, in any period and interval", () => {
    fc.assert(
      fc.property(rule(4), aDay, fc.integer({ min: -400, max: 1500 }), (value, start, offset) => {
        const s = schedule(value, dateOf(start));
        const after = start + offset;
        const next = walkNext(value, start, after);
        expect(nextDate(s, dateOf(after))).toBe(next === undefined ? undefined : dateOf(next));
        const previous = walkPrevious(value, start, after);
        expect(previousDate(s, dateOf(after))).toBe(
          previous === undefined ? undefined : dateOf(previous),
        );
      }),
    );
  });

  test("a long interval still finds its next date", () => {
    fc.assert(
      fc.property(rule(99), aDay, (value, start) => {
        const s = schedule(value, dateOf(start));
        const next = nextDate(s, dateOf(start + 4000));
        expect(next).toBeDefined();
        expect(falls(value, start, day(next ?? ""))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe("[A4.routines.schedule.daylight-saving] a time keeps its wall-clock hour", () => {
  test("the spring gap moves to the first valid minute, the autumn fold takes the first", () => {
    const half = { hour: 2, minute: 30 };
    // Amsterdam: 02:00 becomes 03:00 on 29 March 2026, 03:00 becomes 02:00 on 25 October.
    expect(new Date(instantOf("2026-03-29", half, "Europe/Amsterdam")).toISOString()).toBe(
      "2026-03-29T01:00:00.000Z",
    );
    expect(new Date(instantOf("2026-10-25", half, "Europe/Amsterdam")).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    // New York: 8 March and 1 November 2026.
    expect(new Date(instantOf("2026-03-08", half, "America/New_York")).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(
      new Date(instantOf("2026-11-01", { hour: 1, minute: 30 }, "America/New_York")).toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
    // Lord Howe moves by half an hour.
    expect(
      reading(
        instantOf("2026-10-04", { hour: 2, minute: 10 }, "Australia/Lord_Howe"),
        "Australia/Lord_Howe",
      ),
    ).toBe("2026-10-04 02:30");
  });

  test("in every zone, a time that exists is its first instant, and one in a gap the end of it", () => {
    fc.assert(
      fc.property(zone, aDay, time, (z, d, t) => {
        const date = dateOf(d);
        const u = instantOf(date, t, z);
        const wanted = wall(date, t);
        if (reading(u, z) === wanted) {
          for (let k = 1; k <= 12; k += 1) {
            expect(reading(u - k * 15 * 60_000, z)).not.toBe(wanted);
          }
        } else {
          // A gap: the wall clock jumped over the time. Just before, it read earlier; at u, later.
          expect(reading(u, z) > wanted).toBe(true);
          expect(reading(u - 60_000, z) < wanted).toBe(true);
          expect(u - instantOf(date, { hour: 0, minute: 0 }, z)).toBeLessThan(86_400_000);
        }
      }),
      { numRuns: 2000 },
    );
  });

  test("every weekday at 07:00 stays at 07:00 through both changes of a year", () => {
    for (const z of ["Europe/Amsterdam", "America/New_York", "Australia/Sydney"]) {
      const s = schedule(at(presets.weekdays(), { hour: 7, minute: 0 }), "2026-01-01", z);
      let after = instantOf("2026-01-01", { hour: 0, minute: 0 }, z);
      for (let i = 0; i < 261; i += 1) {
        const next = nextInstant(s, after);
        expect(next).toBeDefined();
        after = next ?? after;
        expect(reading(after, z).slice(11)).toBe("07:00");
      }
      expect(reading(after, z)).toBe("2026-12-31 07:00"); // 2026 has 261 weekdays
    }
  });
});

describe("[A4.routines.schedule.due] when an agent's routine is due, and after an absence", () => {
  test("no time given means 07:00", () => {
    const s = schedule(presets.daily(), "2026-11-01");
    expect(reading(nextInstant(s, Date.UTC(2026, 10, 28, 12)) ?? 0, "Europe/Amsterdam")).toBe(
      "2026-11-29 07:00",
    );
  });

  test("two weeks away gives one claim, of the latest due time, and moves past now", () => {
    const s = schedule(at(presets.weekdays(), { hour: 7, minute: 0 }), "2026-11-01");
    const due = nextInstant(s, Date.UTC(2026, 10, 27, 12)) ?? 0; // Monday 30 November, 07:00
    expect(reading(due, "Europe/Amsterdam")).toBe("2026-11-30 07:00");
    expect(claim(s, due, due - 1)).toBeUndefined();
    const now = Date.UTC(2026, 11, 14, 8, 12); // Monday 14 December, 09:12 in Amsterdam
    const taken = claim(s, due, now);
    expect(reading(taken?.due ?? 0, "Europe/Amsterdam")).toBe("2026-12-14 07:00");
    expect(reading(taken?.next ?? 0, "Europe/Amsterdam")).toBe("2026-12-15 07:00");
  });

  test("a claim is the latest due time that passed, and the next is the first after now", () => {
    fc.assert(
      fc.property(
        rule(3),
        zone,
        aDay,
        fc.integer({ min: 0, max: 40 * 86_400_000 }),
        (value, z, start, gap) => {
          const s = schedule(value, dateOf(start), z);
          const due = nextInstant(s, start * 86_400_000) ?? 0;
          const now = due + gap;
          const taken = claim(s, due, now);
          expect(taken).toBeDefined();
          if (taken === undefined) return;
          expect(taken.due).toBeGreaterThanOrEqual(due);
          expect(taken.due).toBeLessThanOrEqual(now);
          expect(taken.next).toBeGreaterThan(now);
          expect(nextInstant(s, taken.due)).toBe(taken.next);
          expect(latestInstant(s, now)).toBe(taken.due);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("[A4.routines.schedule.following] the next one of a task a person does", () => {
  const saturday = schedule(presets.weekly(["SA"]), "2026-11-07");
  const at12 = (date: string) => Date.parse(`${date}T11:00:00Z`);

  test("early, on time or late, one period gets one task", () => {
    // Saturday 5 December's, finished on Friday the 4th: the next is the 12th.
    expect(following(saturday, at12("2026-12-04"), "2026-12-05")).toEqual({ date: "2026-12-12" });
    // Finished on the day.
    expect(following(saturday, at12("2026-12-05"), "2026-12-05")).toEqual({ date: "2026-12-12" });
    // Saturday 28 November's, missed and finished on Tuesday 1 December: this Saturday.
    expect(following(saturday, at12("2026-12-01"), "2026-11-28")).toEqual({ date: "2026-12-05" });
  });

  test("with a time, the next is a due time after both now and its own", () => {
    const nine = schedule(at(presets.weekdays(), { hour: 9, minute: 0 }), "2026-11-02");
    const next = following(nine, Date.parse("2026-11-30T07:30:00Z"), "2026-11-30");
    expect(next?.date).toBe("2026-12-01");
    expect(reading(next?.at ?? 0, "Europe/Amsterdam")).toBe("2026-12-01 09:00");
  });

  test("the next date is after both today and its own, and the first such", () => {
    fc.assert(
      fc.property(rule(4), zone, aDay, aDay, (value, z, start, ownDay) => {
        const s = schedule({ ...value, time: null }, dateOf(start), z);
        const own = dateOf(ownDay);
        const now = (start + 30) * 86_400_000;
        const today = localDate(now, z);
        const result = following(s, now, own);
        const floor = today > own ? today : own;
        expect(result?.date).toBe(nextDate(s, floor));
        expect((result?.date ?? "") > floor).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
