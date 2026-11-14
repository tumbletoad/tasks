// SafeText (A3 3.10 item 4). Strings are built from code points, so this file stays ASCII and
// shows every hidden character it tests.
import { Ajv2020 } from "ajv/dist/2020.js";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parseInput } from "./define.ts";
import { toJsonSchema } from "./json-schema.ts";
import { normaliseLine, normaliseText, safeLine, safeText } from "./safe-text.ts";

/** Text from pieces: strings as they are, numbers as code points. */
const t = (...pieces: (string | number)[]) =>
  pieces.map((p) => (typeof p === "number" ? String.fromCodePoint(p) : p)).join("");

const ZWJ = 0x200d;
const ZWNJ = 0x200c;
const WOMAN = 0x1f469;
const LAPTOP = 0x1f4bb;

const cases: [label: string, input: string, output: string][] = [
  ["tag characters", t("Fix", 0xe0049, 0xe0067, 0xe006e, " zones"), "Fix zones"],
  [
    "bidirectional controls",
    t("a", 0x202e, "b", 0x2066, "c", 0x2069, "d", 0x200e, "e", 0x200f, "f", 0x061c, "g"),
    "abcdefg",
  ],
  [
    "C0 controls except tab and newline",
    t("a", 0x00, "b", 0x07, "c\td\ne", 0x1b, "f"),
    "abc\td\nef",
  ],
  ["DEL and C1 controls", t("a", 0x7f, "b", 0x85, "c", 0x9f, "d"), "abcd"],
  ["zero-width space, word joiner and BOM", t(0xfeff, "a", 0x200b, "b", 0x2060, "c"), "abc"],
  [
    "ZWJ and ZWNJ stay",
    t(WOMAN, ZWJ, LAPTOP, " a", ZWNJ, "b"),
    t(WOMAN, ZWJ, LAPTOP, " a", ZWNJ, "b"),
  ],
  ["CRLF and CR become LF", "one\r\ntwo\rthree", "one\ntwo\nthree"],
  ["NFC", t("cafe", 0x0301), t("caf", 0x00e9)],
  // As the writer stores them (A1 3.7): UTF-8 has no lone surrogate.
  ["a lone surrogate becomes U+FFFD", t("a", 0xd800, "b", 0xdc00), t("a", 0xfffd, "b", 0xfffd)],
  ["a surrogate pair stays", t("a", 0xd83d, 0xde00, "b"), t("a", 0x1f600, "b")],
];

describe("[A3.3.10.safe-text] SafeText normalises without rejecting", () => {
  for (const [label, input, output] of cases) {
    test(label, () => {
      expect(normaliseText(input)).toBe(output);
      expect(normaliseText(output)).toBe(output);
    });
  }

  test("one-line fields turn line breaks into one space", () => {
    expect(normaliseLine("Fix appointment\r\n  time zones\n")).toBe("Fix appointment time zones ");
    expect(normaliseLine(normaliseLine("a \n\n b"))).toBe("a b");
    // Every run of spaces, tabs and breaks that holds a break is one space; other runs stay.
    expect(normaliseLine("a \t b\t\n \n\tc  d\n")).toBe("a \t b c  d ");
    // Linear: a long run of spaces without a break once cost quadratic time in a regex.
    const started = performance.now();
    expect(normaliseLine(`a${" ".repeat(200_000)}b`)).toHaveLength(200_002);
    expect(normaliseLine(`a${" ".repeat(200_000)}\nb`)).toBe("a b");
    expect(performance.now() - started).toBeLessThan(5_000);
    // The same result as the regular expression it replaced, on short texts of gaps and words.
    const pieces = fc.constantFrom(" ", "\t", "\n", "\r", "\r\n", "a", "b c", "\u200b");
    fc.assert(
      fc.property(fc.array(pieces, { maxLength: 30 }), (list) => {
        const text = list.join("");
        expect(normaliseLine(text)).toBe(normaliseText(text).replace(/[ \t]*\n[ \t\n]*/g, " "));
      }),
      { numRuns: 2_000 },
    );
  });

  test("schemas normalise on parse and check the limit on the input as sent", () => {
    expect(safeText(10).parse(t("a", 0x200b, "b\r\nc"))).toBe("ab\nc");
    expect(safeLine(20).parse("two\nlines")).toBe("two lines");
    expect(safeText(3).safeParse(t("a", 0x200b, 0x200b, "b")).success).toBe(false);
  });

  test("limits count code points in Zod and in Ajv: 2,000 emoji fit, 2,001 do not", () => {
    const schema = z.strictObject({ text: safeText(2000).describe("Text") });
    const validate = new Ajv2020({ strict: true }).compile(toJsonSchema(schema, "input"));
    const emoji = String.fromCodePoint(0x1f600);
    for (const [n, ok] of [
      [2000, true],
      [2001, false],
    ] as const) {
      const value = { text: emoji.repeat(n) };
      expect(schema.safeParse(value).success, `Zod ${String(n)}`).toBe(ok);
      expect(validate(value), `Ajv ${String(n)}`).toBe(ok);
    }
  });

  test("the boundary parse checks limits on the normalised text, which NFC can lengthen", () => {
    // U+0958 has no NFC form of its own: it becomes U+0915 U+093C, two code points.
    const qa = String.fromCodePoint(0x0958);
    expect(Array.from(normaliseLine(qa.repeat(200)))).toHaveLength(400);
    const entry = {
      input: z.strictObject({ title: safeLine(200).describe("Title") }),
    };
    // The schema alone checks the text as sent, as the JSON Schema does.
    expect(entry.input.safeParse({ title: qa.repeat(200) }).success).toBe(true);
    // The boundary parse refuses what would be stored over the limit, for both audiences.
    for (const audience of ["user", "agent"] as const) {
      const over = parseInput(entry, audience, { title: qa.repeat(200) });
      expect(over.success, audience).toBe(false);
      expect(over.error?.issues[0]?.code).toBe("too_big");
      const fits = parseInput(entry, audience, { title: qa.repeat(100) });
      expect(fits.success, audience).toBe(true);
      expect(Array.from(fits.data?.title ?? "")).toHaveLength(200);
    }
  });
});
