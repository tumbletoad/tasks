// How long a toast stays: long enough to read what it says.
import { describe, expect, test } from "vitest";
import { lastsFor } from "./Toast.tsx";

describe("[A5.3.12.toast.reading-time] a toast stays as long as its sentence takes to read", () => {
  test("a short sentence stays as before, a long one longer, none for ever, an error until dismissed", () => {
    expect(lastsFor("info", "Task added.")).toBe(2_500);
    expect(lastsFor("undo", "Moved to the Trash.")).toBe(6_000);
    const long =
      "Opened in the app without your read-only setting, which this way of opening cannot carry. A terminal can, where one is set up: see the doctor.";
    // About 24 words: at four words a second a person needs six seconds for it.
    expect(lastsFor("info", long)).toBeGreaterThanOrEqual(6_000);
    expect(lastsFor("undo", long)).toBeGreaterThanOrEqual(6_000);
    expect(lastsFor("info", long.repeat(10))).toBe(lastsFor("undo", long.repeat(10)));
    expect(lastsFor("info", long.repeat(10))).toBeLessThanOrEqual(15_000);
    expect(lastsFor("error", long)).toBeUndefined();
  });
});
