// A task's due date or due time as its card shows it.
import { describe, expect, test } from "vitest";
import { dueWhen } from "./dates.ts";

const clock = {
  now: Date.UTC(2026, 10, 28, 9),
  today: "2026-11-28",
  timeZone: "UTC",
  locale: "en",
};

describe("[S5.phone.due-when] a card shows a due date, or a due time with its day", () => {
  test("a due date, a due time in the viewer's zone, and none", () => {
    expect(dueWhen({ due_date: "2026-11-30" }, clock)).toBe("Mon, Nov 30");
    expect(dueWhen({ due_at: Date.UTC(2026, 10, 30, 14, 5) }, clock)).toBe("Mon, Nov 30, 14:05");
    expect(
      dueWhen({ due_at: Date.UTC(2026, 10, 30, 14, 5) }, { ...clock, timeZone: "Asia/Tokyo" }),
    ).toBe("Mon, Nov 30, 23:05");
    expect(dueWhen({}, clock)).toBeUndefined();
  });
});
