import { afterEach, describe, expect, test, vi } from "vitest";
import { pageKept } from "../kept.ts";
import { Unanswered } from "./unanswered.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("[A5.3.8.web.open-once] an Open that got no answer is the same Open when pressed again", () => {
  test("a request unanswered for more than a day is removed with its words, at the next load or press", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 22, 8) });
    const kept = pageKept();
    const first = new Unanswered(kept);
    first.idFor("open.a", "The words of a");
    vi.setSystemTime(Date.UTC(2026, 10, 22, 10));
    first.idFor("open.b", "The words of b");
    // Pressed again: the request is as old as its first press.
    vi.setSystemTime(Date.UTC(2026, 10, 23, 7));
    first.idFor("open.a", "The words of a");
    vi.setSystemTime(Date.UTC(2026, 10, 23, 9));
    expect(kept.names("unanswered.").sort()).toEqual(["unanswered.open.a", "unanswered.open.b"]);
    // The page loads again: what is past its day is gone, not only ignored.
    const loaded = new Unanswered(kept);
    expect(kept.names("unanswered.")).toEqual(["unanswered.open.b"]);
    vi.setSystemTime(Date.UTC(2026, 10, 23, 11));
    loaded.idFor("open.c", "The words of c");
    expect(kept.names("unanswered.")).toEqual(["unanswered.open.c"]);
    expect(loaded.raw("open.")).not.toContain("The words of b");
  });
});
