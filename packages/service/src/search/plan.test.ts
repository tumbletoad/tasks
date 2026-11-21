import { describe, expect, test } from "vitest";
import { startOfDay } from "./plan.ts";

describe("[A3.5.search.day-start] a local date's first instant", () => {
  test("an ordinary day starts at its midnight", () => {
    expect(startOfDay("2026-11-12", "Europe/Amsterdam")).toBe(Date.UTC(2026, 10, 11, 23));
    expect(startOfDay("2026-11-12", "America/New_York")).toBe(Date.UTC(2026, 10, 12, 5));
    expect(startOfDay("2026-11-12", "UTC")).toBe(Date.UTC(2026, 10, 12));
  });

  test("a clock change in the night leaves midnight where it was", () => {
    // The clocks go forward at 02:00 on 29 March and back at 03:00 on 25 October.
    for (const date of ["2026-03-29", "2026-03-30", "2026-10-25", "2026-10-26"]) {
      const start = startOfDay(date, "Europe/Amsterdam");
      expect(new Date(start).toLocaleString("sv", { timeZone: "Europe/Amsterdam" })).toBe(
        `${date} 00:00:00`,
      );
    }
  });

  test("a day whose midnight the clocks skip starts when they resume, at 01:00", () => {
    // Santiago moves from UTC-4 to UTC-3 at midnight on 6 September: 00:00 never happens.
    expect(startOfDay("2026-09-06", "America/Santiago")).toBe(Date.UTC(2026, 8, 6, 4));
    // The day before ends there too, so a task due at 23:30 on the 5th is on the 5th.
    expect(startOfDay("2026-09-05", "America/Santiago")).toBe(Date.UTC(2026, 8, 5, 4));
  });

  test("a day whose midnight the clocks repeat starts at the second midnight", () => {
    // Santiago moves back from UTC-3 to UTC-4 at midnight on 5 April: 23:00 on the 4th comes twice.
    expect(startOfDay("2026-04-05", "America/Santiago")).toBe(Date.UTC(2026, 3, 5, 4));
    expect(startOfDay("2026-04-04", "America/Santiago")).toBe(Date.UTC(2026, 3, 4, 3));
  });
});
