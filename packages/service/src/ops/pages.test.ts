// The pages of a sections read (pages.ts): the token's grammar, a whole item that a fresh page
// holds starting the next page, a longer text split by code point with ranges that meet, the
// log's limit per page, and a page that always shows something, so the pages end.
import { describe, expect, test } from "vitest";
import {
  buildPage,
  formatToken,
  ITEM_BYTES,
  PAGE_BYTES,
  parseToken,
  SECTION_BYTES,
  textCost,
  type PageItem,
  type SectionInput,
} from "./pages.ts";

const item = (key: number, text: string): PageItem<{ key: number }> => ({
  value: { key },
  key,
  text,
  extra: 0,
});

describe("[A3.3.4.tools.five] pages of a sections read", () => {
  test("tokens: every form reads back as written, and others are refused", () => {
    for (const token of [
      "i",
      "i7",
      "i7.120",
      "c",
      "c.4001",
      "n12",
      "n12.9",
      "l1",
      "s3",
      "o",
      "o.17",
      "o0",
      "o2",
      "h20",
    ]) {
      expect(formatToken(parseToken(token))).toBe(token);
    }
    // The outcome's learnings are whole on a page, and only its text and the context are item 0.
    for (const bad of [
      "",
      "x",
      "l0",
      "l-1",
      "c0",
      "c3",
      "c3.1",
      "o2.5",
      "o0.3",
      "o.0",
      "n0",
      "l.5",
      "n1.0",
      "l1.2.3",
      "L1",
    ]) {
      expect(() => parseToken(bad), bad).toThrow();
    }
  });

  test("a whole item that a fresh page holds starts the next page; a longer one is split", () => {
    const room = PAGE_BYTES - SECTION_BYTES - ITEM_BYTES;
    const half = "a".repeat(Math.floor(room / 2));
    const inputs: SectionInput<unknown>[] = [
      { section: "notes", items: [item(3, half), item(2, half), item(1, "b".repeat(room * 3))] },
    ];
    const first = buildPage(inputs);
    expect(first.sections.get("notes")?.map((p) => p.text?.length)).toEqual([half.length]);
    expect(first.before).toBe("n3");
    // From n2 on: n2 fits whole, then n1 starts on the rest of the page and goes on.
    const second = buildPage([{ section: "notes", items: inputs[0]?.items.slice(1) ?? [] }]);
    const placed = second.sections.get("notes") ?? [];
    expect(placed[0]?.slice).toBeUndefined();
    expect(placed[1]?.slice).toMatchObject({ from: 0, of: room * 3 });
    const to = placed[1]?.slice?.to ?? 0;
    expect(second.before).toBe(`n1.${String(to)}`);
    // Each part's cost stays within the page.
    for (const page of [first, second]) {
      let used = 0;
      for (const parts of page.sections.values()) {
        used += SECTION_BYTES;
        for (const part of parts) used += ITEM_BYTES + textCost(part.text ?? "");
      }
      expect(used).toBeLessThanOrEqual(PAGE_BYTES);
    }
    // The rest goes on from where it ended, and the parts meet end to start.
    let offset = to;
    let rest = "";
    for (let pages = 0; pages < 10; pages += 1) {
      const page = buildPage([
        { section: "notes", items: [item(1, "b".repeat(room * 3))], offset },
      ]);
      const part = page.sections.get("notes")?.[0];
      expect(part?.slice?.from).toBe(offset);
      rest += part?.text ?? "";
      if (page.before === undefined) break;
      offset = part?.slice?.to ?? 0;
    }
    expect(to + rest.length).toBe(room * 3);
  });

  test("a section whose first item waits for the next page is not on this one", () => {
    const room = PAGE_BYTES - 2 * SECTION_BYTES - 2 * ITEM_BYTES;
    const page = buildPage([
      { section: "context", items: [item(0, "c".repeat(Math.floor(room / 2)))] },
      { section: "notes", items: [item(4, "n".repeat(Math.floor(room / 2) + 100))] },
    ]);
    expect([...page.sections.keys()]).toEqual(["context"]);
    expect(page.before).toBe("n");
    // The next page starts there and holds it.
    const next = buildPage([
      {
        section: "notes",
        items: [item(4, "n".repeat(Math.floor(room / 2) + 100))],
        resume: parseToken("n"),
      },
    ]);
    expect(next.sections.get("notes")).toHaveLength(1);
    expect(next.before).toBeUndefined();
  });

  test("the log's limit ends a page; a page always shows something", () => {
    const log = buildPage([
      { section: "log", items: [item(5, "x"), item(4, "y"), item(3, "z")], limit: 2 },
      { section: "history", items: [{ value: {}, key: 1, extra: 10 }] },
    ]);
    expect(log.sections.get("log")).toHaveLength(2);
    expect(log.before).toBe("l4");
    expect(log.sections.has("history")).toBe(false);
    // An item with no text to split and larger than a page goes alone onto one.
    const big = buildPage([
      {
        section: "sources",
        items: [
          { value: {}, key: 1, extra: PAGE_BYTES * 2 },
          { value: {}, key: 2, extra: 1 },
        ],
      },
    ]);
    expect(big.sections.get("sources")).toHaveLength(1);
    expect(big.before).toBe("s1");
  });
});
