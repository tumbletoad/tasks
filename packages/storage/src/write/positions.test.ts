// The fractional index of `position` (A1 3.4).
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { StorageError } from "../errors.ts";
import { FIRST_POSITION, isPosition, positionBetween } from "./positions.ts";

/** Builds a list by inserting at random places, as moves and creates do. */
const inserts = fc.array(fc.tuple(fc.nat(), fc.boolean()), { minLength: 1, maxLength: 300 });

function build(steps: readonly (readonly [number, boolean])[]): string[] {
  const list: string[] = [];
  for (const [at, after] of steps) {
    if (list.length === 0) {
      list.push(positionBetween(undefined, undefined));
      continue;
    }
    const i = at % list.length;
    // Right after list[i], or right before it.
    const [low, high, index] = after ? [list[i], list[i + 1], i + 1] : [list[i - 1], list[i], i];
    list.splice(index, 0, positionBetween(low, high));
  }
  return list;
}

const misuse = (fn: () => unknown): void => {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(StorageError);
  expect((error as StorageError).code).toBe("STORAGE_MISUSE");
};

describe("[A1.5.write.positions] positions are a fractional index", () => {
  test("an empty group starts at a0, and appending only increments the integer part", () => {
    expect(positionBetween(undefined, undefined)).toBe(FIRST_POSITION);
    const list = [FIRST_POSITION];
    for (let i = 0; i < 5_000; i += 1) list.push(positionBetween(list.at(-1), undefined));
    expect([...list].sort()).toEqual(list);
    expect(list.slice(0, 4)).toEqual(["a0", "a1", "a2", "a3"]);
    expect(list[62]).toBe("b00");
    // 5,000 appends stay short.
    expect(Math.max(...list.map((p) => p.length))).toBeLessThanOrEqual(4);
  });

  test("prepending decrements the integer part across the a/Z boundary", () => {
    const list = [FIRST_POSITION];
    for (let i = 0; i < 5_000; i += 1) list.unshift(positionBetween(undefined, list[0]));
    expect([...list].sort()).toEqual(list);
    expect(list.at(-2)).toBe("Zz");
    expect(list.every(isPosition)).toBe(true);
  });

  test("a position between two others sorts strictly between them, as SQLite compares text", () => {
    fc.assert(
      fc.property(inserts, (steps) => {
        const list = build(steps);
        expect(list.every(isPosition)).toBe(true);
        expect(new Set(list).size).toBe(list.length);
        // JavaScript's < is SQLite's BINARY collation on ASCII.
        for (let i = 1; i < list.length; i += 1) {
          expect((list[i - 1] ?? "") < (list[i] ?? "")).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("repeated inserts between the same two neighbours grow slowly", () => {
    let low = "a0";
    const high = "a1";
    for (let i = 0; i < 1_000; i += 1) low = positionBetween(low, high);
    expect(low < high).toBe(true);
    // About one character per five inserts: each insert halves the room that is left.
    expect(low.length).toBeLessThan(250);
  });

  test("prepending reaches past the smallest integer part with a fraction", () => {
    const smallest = `A${"0".repeat(26)}`;
    let first = `A${"0".repeat(25)}2`;
    for (let i = 0; i < 20; i += 1) {
      const before = positionBetween(undefined, first);
      expect(isPosition(before), before).toBe(true);
      expect(before < first).toBe(true);
      first = before;
    }
    expect(first.startsWith(smallest)).toBe(true);
    expect(positionBetween(undefined, `A${"0".repeat(25)}1`)).toBe(`${smallest}V`);
  });

  test("long positions are handled without recursion", () => {
    // Inserting again and again right before the same neighbour grows a run of z digits.
    const nines = `a0${"z".repeat(50_000)}`;
    const between = positionBetween(nines, "a1");
    expect(isPosition(between)).toBe(true);
    expect(nines < between && between < "a1").toBe(true);
    const low = `a0${"0".repeat(50_000)}1`;
    const high = `a0${"0".repeat(50_000)}2`;
    const middle = positionBetween(low, high);
    expect(isPosition(middle)).toBe(true);
    expect(low < middle && middle < high).toBe(true);
    let upper = "a1";
    let lower = "a0";
    for (let i = 0; i < 2_000; i += 1) lower = positionBetween(lower, upper);
    upper = lower;
    lower = "a0";
    for (let i = 0; i < 2_000; i += 1) upper = positionBetween(lower, upper);
    expect(lower < upper).toBe(true);
  });

  test("isPosition accepts only the format", () => {
    const smallest = `A${"0".repeat(26)}`;
    for (const good of ["a0", "a1V", "Zz", "b00", `A${"0".repeat(25)}1`, `${"z".repeat(27)}V`]) {
      expect(isPosition(good), good).toBe(true);
    }
    for (const bad of ["", "a", "a10", "b0", "0a", "a-", "a0 ", smallest, "a00000", 3, null]) {
      expect(isPosition(bad), String(bad)).toBe(false);
    }
  });

  test("invalid or unordered neighbours are refused", () => {
    misuse(() => positionBetween("a1", "a0"));
    misuse(() => positionBetween("a1", "a1"));
    misuse(() => positionBetween("a-", undefined));
    misuse(() => positionBetween(undefined, "a10"));
  });
});
