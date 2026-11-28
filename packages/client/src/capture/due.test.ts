// What the due date's field reads (due.ts): every form A5 3.11 names, as the service reads it.
import { describe, expect, test } from "vitest";
import { addMonths, quickPicks, readDue } from "./due.ts";

/** Thursday 12 November 2026, the fixture's day. */
const TODAY = "2026-11-12";

describe("[A5.3.11.web.due] the date field reads ISO dates, tod, tom, weekdays, +3d, +2w and -", () => {
  test("each form gives a calendar date, - clears, anything else is not a date", () => {
    const date = (text: string) => {
      const reading = readDue(text, TODAY);
      return reading.kind === "date" ? reading.date : reading.kind;
    };
    expect(date("2026-11-20")).toBe("2026-11-20");
    expect(date("2026-02-30")).toBe("invalid");
    expect(date("tod")).toBe(TODAY);
    expect(date(" Today ")).toBe(TODAY);
    expect(date("tom")).toBe("2026-11-13");
    expect(date("tomorrow")).toBe("2026-11-13");
    // A weekday is the next one, today when it is that day (the service's rule).
    expect(date("thu")).toBe(TODAY);
    expect(date("fri")).toBe("2026-11-13");
    expect(date("Monday")).toBe("2026-11-16");
    expect(date("+3d")).toBe("2026-11-15");
    expect(date("+2w")).toBe("2026-11-26");
    expect(date("+30d")).toBe("2026-12-12");
    expect(date("-")).toBe("clear");
    expect(date("")).toBe("empty");
    expect(date("next week")).toBe("invalid");
    expect(date("2026-11-20T10:00")).toBe("invalid");
  });

  test("the quick picks: Next Monday is never today, and a month on stays inside the month", () => {
    expect(quickPicks(TODAY)).toEqual({
      today: TODAY,
      tomorrow: "2026-11-13",
      nextMonday: "2026-11-16",
      inAWeek: "2026-11-19",
    });
    expect(quickPicks("2026-11-16").nextMonday).toBe("2026-11-23");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });
});
