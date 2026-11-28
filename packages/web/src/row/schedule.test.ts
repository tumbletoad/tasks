// A schedule's words, from the catalogue, for the presets a person picks and for every rule the
// stored form can hold.
import fc from "fast-check";
import { createIntl } from "react-intl";
import { describe, expect, test } from "vitest";
import { WEEKDAYS, at, parseRule, presets, type Rule } from "@ttasks/contracts/schedule";
import en from "../i18n/en.json" with { type: "json" };
import type { MessageId, Values } from "../i18n/intl.tsx";
import { scheduleWords, type ScheduleWording } from "./schedule.ts";

const intl = createIntl({
  locale: "en",
  messages: en,
  onError: (e) => {
    throw e;
  },
});
const wording: ScheduleWording = {
  t: (id: MessageId, values?: Values) => intl.formatMessage({ id }, values),
  list: (items) => intl.formatList(items, { type: "conjunction" }),
  locale: "en-GB",
};
const words = (rule: Rule) => scheduleWords(rule, wording);

describe("[A5.routines.web.schedule-words] a schedule in the words a person reads", () => {
  test("the presets read as the design names them", () => {
    expect(words(presets.weekly(["SA"]))).toBe("Every Saturday");
    expect(words(presets.weekly(["MO", "TH"]))).toBe("Every Monday and Thursday");
    expect(words(presets.weekly(["MO"], 2))).toBe("Every 2 weeks on Monday");
    expect(words(presets.weekdays())).toBe("Every weekday");
    expect(words(at(presets.weekdays(), { hour: 7, minute: 0 }))).toBe("Every weekday at 07:00");
    expect(words(presets.daily())).toBe("Every day");
    expect(words(presets.daily(3))).toBe("Every 3 days");
    expect(words(presets.workingDay(1))).toBe("The first working day of every month");
    expect(words(presets.workingDay(-1, 3))).toBe("The last working day of every 3 months");
    expect(words(presets.monthly(15, 3))).toBe("Every 3 months on the 15th");
    expect(words(presets.monthly(1))).toBe("Every month on the 1st");
    expect(words(presets.monthly(22))).toBe("Every month on the 22nd");
    expect(words(presets.monthly(-1))).toBe("Every month on the last day");
    expect(words(presets.monthlyOn(-1, "FR"))).toBe("The last Friday of every month");
    expect(words(presets.monthlyOn(1, "MO"))).toBe("The first Monday of every month");
    expect(words(presets.yearly(12, 14))).toBe("Every year on 14 December");
    expect(words(parseRule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH") ?? presets.daily())).toBe(
      "The fourth Thursday of November, every year",
    );
  });

  test("every rule of the stored form has words, with nothing of the message left in them", () => {
    const weekday = fc.constantFrom(...WEEKDAYS);
    const text = fc.oneof(
      fc.constant("FREQ=DAILY"),
      fc.subarray([...WEEKDAYS], { minLength: 1 }).map((d) => `FREQ=WEEKLY;BYDAY=${d.join(",")}`),
      fc
        .integer({ min: -1, max: 31 })
        .filter((d) => d !== 0)
        .map((d) => `FREQ=MONTHLY;BYMONTHDAY=${String(d)}`),
      fc
        .tuple(fc.constantFrom("1", "2", "3", "4", "-1"), weekday)
        .map(([n, d]) => `FREQ=YEARLY;BYMONTH=2;BYDAY=${n}${d}`),
      fc
        .constantFrom("1", "-1")
        .map((p) => `FREQ=YEARLY;BYMONTH=5;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=${p}`),
      fc
        .integer({ min: -1, max: 31 })
        .filter((d) => d !== 0)
        .map((d) => `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=${String(d)}`),
    );
    fc.assert(
      fc.property(text, fc.integer({ min: 1, max: 99 }), fc.boolean(), (base, interval, timed) => {
        const rule = parseRule(
          `${base};INTERVAL=${String(interval)}${timed ? ";BYHOUR=9;BYMINUTE=5" : ""}`,
        );
        expect(rule).toBeDefined();
        if (rule === undefined) return;
        const said = words(rule);
        expect(said).not.toMatch(/[{}#]/);
        expect(said.length).toBeGreaterThan(5);
        if (timed) expect(said.endsWith(" at 09:05")).toBe(true);
      }),
    );
  });
});
