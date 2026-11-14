// M7.02's Verify line (A7 3.14): the fallback ID matches the prototype's FNV-1a output for the
// synthetic titles. The expected IDs come from the fixture's index, where an independent Python
// implementation confirmed every one of them, including the two titles that tell code points from
// UTF-8 bytes and UTF-16 units.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { fallbackId, fnv1aCodePoints } from "./index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
interface Where {
  task?: string;
  expect?: Record<string, unknown>;
}
const index = JSON.parse(
  readFileSync(join(ROOT, "fixtures", "planning-prototype.index.json"), "utf8"),
) as {
  tasks: { id: string; group: string; title: string; marked: boolean }[];
  cases: Record<string, { where: Where[] }>;
};
const where = (name: string) => index.cases[name]?.where ?? [];

describe("[A7.3.15.importer.fallback-id] the fallback ID is the prototype's FNV-1a", () => {
  test("published FNV-1a 32-bit test vectors", () => {
    for (const [input, hash] of [
      ["", 0x811c9dc5],
      ["a", 0xe40c292c],
      ["foobar", 0xbf9cf968],
    ] as const) {
      expect(fnv1aCodePoints(input)).toBe(hash);
    }
  });

  test("every unmarked title of the index gives the ID the index states", () => {
    const unmarked = index.tasks.filter((t) => !t.marked);
    expect(unmarked.length).toBeGreaterThanOrEqual(5);
    for (const t of unmarked) expect(fallbackId(t.group, t.title), t.id).toBe(t.id);
  });

  test("code points, not UTF-8 bytes or UTF-16 units", () => {
    const narrow = where("non-ascii-fallback");
    const astral = where("astral-fallback");
    expect(narrow).toHaveLength(1);
    expect(astral).toHaveLength(1);
    for (const w of [...narrow, ...astral]) {
      const t = index.tasks.find((x) => x.id === w.task);
      if (t === undefined) throw new Error(`no task ${String(w.task)}`);
      const id = fallbackId(t.group, t.title);
      expect(id).toBe(w.expect?.["id"]);
      expect(id).not.toBe(w.expect?.["utf8BytesWouldGive"]);
      if (w.expect !== undefined && "utf16UnitsWouldGive" in w.expect) {
        expect(id).not.toBe(w.expect["utf16UnitsWouldGive"]);
      }
    }
    // The astral title holds a character above U+FFFF, the narrow one only characters below U+0800.
    const title = (w: Where | undefined) => index.tasks.find((x) => x.id === w?.task)?.title ?? "";
    expect(Array.from(title(astral[0])).some((c) => (c.codePointAt(0) ?? 0) > 0xffff)).toBe(true);
    expect(Array.from(title(narrow[0])).some((c) => (c.codePointAt(0) ?? 0) > 0x7f)).toBe(true);
  });

  test("a reconciled line keeps the ID of its group in TODO.md, not of group Other", () => {
    for (const w of where("done-reconciled-fallback")) {
      const t = index.tasks.find((x) => x.id === w.task);
      if (t === undefined) throw new Error(`no task ${String(w.task)}`);
      expect(fallbackId(String(w.expect?.["todoGroup"]), t.title)).toBe(w.expect?.["id"]);
      expect(fallbackId("Other", t.title)).toBe(w.expect?.["fallbackHere"]);
    }
  });

  test("eight lower-case hex digits, zero-padded", () => {
    for (const title of ["", "x", "Buy tea", "\u{1F382}", "a".repeat(10_000)]) {
      expect(fallbackId("Other", title)).toMatch(/^t-[0-9a-f]{8}$/);
    }
  });
});
