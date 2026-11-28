// A schedule's English words: what an agent's `repeat` and the capture line read, and what an agent
// reads back. Fixture dates.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { parseRepeat, repeatWords } from "./repeat.ts";
import { WEEKDAYS, at, formatRule, nextDate, parseRule, presets, type Rule } from "./schedule.ts";

/** Wednesday 2 December 2026. */
const TODAY = "2026-12-02";
const rule = (words: string) => {
  const found = parseRepeat(words, TODAY);
  return found === undefined ? undefined : formatRule(found);
};

describe("[A4.routines.repeat.words] a schedule in English words, read and said", () => {
  test("the words a person and an agent write read as the rule they mean", () => {
    const cases: Readonly<Record<string, Rule>> = {
      "every saturday": presets.weekly(["SA"]),
      "Every Saturday.": presets.weekly(["SA"]),
      saturdays: presets.weekly(["SA"]),
      "every mon, wed and fri": presets.weekly(["MO", "WE", "FR"]),
      "every thursday & monday": presets.weekly(["MO", "TH"]),
      "weekly on sunday": presets.weekly(["SU"]),
      "every week": presets.weekly(["WE"]),
      "every other week on friday": presets.weekly(["FR"], 2),
      "every 3 weeks": presets.weekly(["WE"], 3),
      daily: presets.daily(),
      "every day at 7": at(presets.daily(), { hour: 7, minute: 0 }),
      "every 2 days": presets.daily(2),
      weekdays: presets.weekdays(),
      "every weekday at 07:30": at(presets.weekdays(), { hour: 7, minute: 30 }),
      "every working day at 6pm": at(presets.weekdays(), { hour: 18, minute: 0 }),
      monthly: presets.monthly(2),
      "every month on the 15th": presets.monthly(15),
      "every 3 months on the 1st": presets.monthly(1, 3),
      "every month on the last day": presets.monthly(-1),
      "the last day of every month": presets.monthly(-1),
      "the first monday of every month": presets.monthlyOn(1, "MO"),
      "first monday of the month": presets.monthlyOn(1, "MO"),
      "the last friday of the month": presets.monthlyOn(-1, "FR"),
      "every year on the last day of february": presets.yearly(2, -1),
      "the fourth thursday of november, every year": {
        pattern: { freq: "YEARLY", month: 11, on: { kind: "weekday", ordinal: 4, weekday: "TH" } },
        interval: 1,
        time: null,
      },
      "every last friday": presets.monthlyOn(-1, "FR"),
      "the first working day of every month": presets.workingDay(1),
      "the last working day of every other month": presets.workingDay(-1, 2),
      yearly: presets.yearly(12, 2),
      "every year on 14 december": presets.yearly(12, 14),
      "every march 1st": presets.yearly(3, 1),
    };
    for (const [words, expected] of Object.entries(cases)) {
      expect([words, rule(words)]).toEqual([words, formatRule(expected)]);
    }
  });

  test("words it does not read are no schedule", () => {
    for (const words of [
      "",
      "sometimes",
      "every blursday",
      "every 0 days",
      "every 100 weeks",
      "every month on the 32nd",
      "every saturday at 25",
      "every saturday at 13pm",
      "the second day of every month",
      "every year on 14 smarch",
    ]) {
      expect([words, parseRepeat(words, TODAY)]).toEqual([words, undefined]);
    }
  });

  test("an agent reads a rule back in words that read as the same rule", () => {
    const said: Readonly<Record<string, string>> = {
      "FREQ=WEEKLY;BYDAY=SA": "Every Saturday",
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0": "Every weekday at 07:00",
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH": "Every 2 weeks on Monday and Thursday",
      "FREQ=DAILY;INTERVAL=3": "Every 3 days",
      "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15": "Every 3 months on the 15th",
      "FREQ=MONTHLY;BYMONTHDAY=22": "Every month on the 22nd",
      "FREQ=MONTHLY;BYMONTHDAY=-1": "Every month on the last day",
      "FREQ=MONTHLY;BYDAY=-1FR": "The last Friday of every month",
      "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1": "The first working day of every month",
      "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=14": "Every year on 14 December",
    };
    for (const [text, words] of Object.entries(said)) {
      const parsed = parseRule(text);
      if (parsed === undefined) throw new Error(`${text} is a rule`);
      expect(repeatWords(parsed)).toBe(words);
      expect(rule(words)).toBe(text);
    }
  });
});

/** Every rule the stored form holds, at any interval, with or without a time of day. */
const anyRule: fc.Arbitrary<Rule> = fc
  .tuple(
    fc.oneof(
      fc.constant("FREQ=DAILY"),
      fc.subarray([...WEEKDAYS], { minLength: 1 }).map((d) => `FREQ=WEEKLY;BYDAY=${d.join(",")}`),
      fc
        .integer({ min: -1, max: 31 })
        .filter((d) => d !== 0)
        .map((d) => `FREQ=MONTHLY;BYMONTHDAY=${String(d)}`),
      fc
        .tuple(fc.constantFrom("1", "2", "3", "4", "-1"), fc.constantFrom(...WEEKDAYS))
        .map(([n, d]) => `FREQ=MONTHLY;BYDAY=${n}${d}`),
      fc.constantFrom("1", "-1").map((p) => `FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=${p}`),
      fc
        .tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: -1, max: 31 }))
        .filter(([, d]) => d !== 0)
        .map(([m, d]) => `FREQ=YEARLY;BYMONTH=${String(m)};BYMONTHDAY=${String(d)}`),
      fc
        .tuple(
          fc.integer({ min: 1, max: 12 }),
          fc.constantFrom("1", "2", "3", "4", "-1"),
          fc.constantFrom(...WEEKDAYS),
        )
        .map(([m, n, d]) => `FREQ=YEARLY;BYMONTH=${String(m)};BYDAY=${n}${d}`),
      fc
        .tuple(fc.integer({ min: 1, max: 12 }), fc.constantFrom("1", "-1"))
        .map(([m, p]) => `FREQ=YEARLY;BYMONTH=${String(m)};BYDAY=MO,TU,WE,TH,FR;BYSETPOS=${p}`),
    ),
    fc.integer({ min: 1, max: 99 }),
    fc.option(
      fc.record({ hour: fc.integer({ min: 0, max: 23 }), minute: fc.integer({ min: 0, max: 59 }) }),
      { nil: null },
    ),
  )
  .map(([base, interval, time]) => {
    const rule = parseRule(`${base};INTERVAL=${String(interval)}`);
    if (rule === undefined) throw new Error(`${base} is a rule`);
    return { ...rule, time };
  });

/** The dates a rule falls on in the four years from 2026, as a schedule from then. */
const dates = (rule: Rule): string[] => {
  const schedule = { rule: formatRule(rule), start: "2026-01-01", zone: "UTC" };
  const out: string[] = [];
  for (let d = nextDate(schedule, "2025-12-31"); d !== undefined && d < "2030";) {
    out.push(d);
    d = nextDate(schedule, d);
  }
  return out;
};

describe("[A4.routines.repeat.round-trip] every rule's words read back as the same schedule", () => {
  test("the words said for any rule parse to a rule with the same words, dates and time", () => {
    fc.assert(
      fc.property(anyRule, (rule) => {
        const said = repeatWords(rule);
        const back = parseRepeat(said, TODAY);
        expect([said, back === undefined]).toEqual([said, false]);
        if (back === undefined) return;
        expect(repeatWords(back)).toBe(said);
        expect(back.time).toEqual(rule.time);
        expect(dates(back)).toEqual(dates(rule));
      }),
    );
  });
});
