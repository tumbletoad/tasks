// A schedule's English words: what an agent's `repeat` and the capture line read, and what an agent
// reads back. Fixture dates.
import { describe, expect, test } from "vitest";
import { parseRepeat, repeatWords } from "./repeat.ts";
import { at, formatRule, parseRule, presets, type Rule } from "./schedule.ts";

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
