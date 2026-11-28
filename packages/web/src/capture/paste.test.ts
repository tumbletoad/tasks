// A paste into the top field that is more than a title keeps every word: its first line in the
// field, cut at a word when it does not fit, and the rest for the new task's context.
import { describe, expect, test } from "vitest";
import { joinRest, splitPaste } from "./paste.ts";

describe("[A5.top.web.paste] a paste that is more than a title loses no word", () => {
  test("one line that fits is the field's as it is", () => {
    expect(splitPaste("Call ", 5, 5, "the plumber", 500)).toBeUndefined();
  });

  test("lines: the first is the title, the others the context", () => {
    expect(
      splitPaste("", 0, 0, "Fix the export\r\nThe clinic says\nthe times shift.\n", 500),
    ).toEqual({
      text: "Fix the export",
      caret: 14,
      rest: "The clinic says\nthe times shift.",
    });
  });

  test("a line too long for the field is cut at a word; what follows goes first in the context", () => {
    const line = `${"word ".repeat(30)}end`;
    const split = splitPaste("Re: ", 4, 4, line, 60);
    expect(split?.text).toBe(`Re: ${"word ".repeat(11).trimEnd()}`);
    expect(split?.text.length).toBeLessThanOrEqual(60);
    expect(`${split?.text.slice(4) ?? ""} ${split?.rest ?? ""}`).toBe(line);
  });

  test("a paste over a selection keeps the text around it", () => {
    expect(splitPaste("Call X today", 5, 6, "Ana\nabout the leak", 500)).toEqual({
      text: "Call Ana today",
      caret: 8,
      rest: "about the leak",
    });
  });

  test("a second paste adds to what the first kept", () => {
    expect(joinRest("", "first")).toBe("first");
    expect(joinRest("first", "second")).toBe("first\n\nsecond");
  });
});
