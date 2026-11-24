// A change of the effort levels as the Settings grid makes it: each kind of change gives the list
// and the moves a person expects, a change to nothing writes nothing, and a name the writer would
// refuse is caught before it is sent.
import { describe, expect, test } from "vitest";
import { EFFORT_LEVELS, type EffortLevel } from "@ttasks/contracts/preferences";
import { levelsWrite, moveTarget, nameProblem, oneLine } from "./levels.ts";

const L: readonly EffortLevel[] = [
  { key: "S", time: { amount: 1, unit: "hours" }, about: "Small" },
  { key: "M", time: { amount: 4, unit: "hours" } },
  { key: "L" },
];
const keys = (levels: readonly EffortLevel[] | undefined) => levels?.map((level) => level.key);

describe("[A5.3.7.web.levels-write] the write each change of the grid makes", () => {
  test("add, rename, time, line, reorder and remove give the list and moves a person expects", () => {
    expect(levelsWrite(L, { kind: "add", name: "XL" })).toEqual({
      value: [...L, { key: "XL" }],
      moves: [],
    });
    // A rename keeps the level's time and line and carries its tasks along.
    expect(levelsWrite(L, { kind: "rename", at: 1, name: "Medium" })).toEqual({
      value: [L[0], { key: "Medium", time: { amount: 4, unit: "hours" } }, L[2]],
      moves: [{ from: "M", to: "Medium" }],
    });
    expect(
      levelsWrite(L, { kind: "time", at: 2, time: { amount: 2, unit: "days" } })?.value[2],
    ).toEqual({ key: "L", time: { amount: 2, unit: "days" } });
    expect(levelsWrite(L, { kind: "time", at: 0, time: undefined })?.value[0]).toEqual({
      key: "S",
      about: "Small",
    });
    expect(levelsWrite(L, { kind: "about", at: 0, about: undefined })?.value[0]).toEqual({
      key: "S",
      time: { amount: 1, unit: "hours" },
    });
    expect(keys(levelsWrite(L, { kind: "up", at: 1 })?.value)).toEqual(["M", "S", "L"]);
    expect(keys(levelsWrite(L, { kind: "down", at: 1 })?.value)).toEqual(["S", "L", "M"]);
    expect(levelsWrite(L, { kind: "up", at: 1 })?.moves).toEqual([]);
    expect(levelsWrite(L, { kind: "remove", at: 1 })).toEqual({ value: [L[0], L[2]], moves: [] });
    expect(levelsWrite(L, { kind: "remove", at: 1, to: "L" })?.moves).toEqual([
      { from: "M", to: "L" },
    ]);
    expect(levelsWrite(L, { kind: "remove", at: 1, to: null })?.moves).toEqual([
      { from: "M", to: null },
    ]);
  });

  test("a change to nothing writes nothing, and the bounds hold", () => {
    expect(levelsWrite(L, { kind: "rename", at: 1, name: "M" })).toBeUndefined();
    expect(
      levelsWrite(L, { kind: "time", at: 1, time: { amount: 4, unit: "hours" } }),
    ).toBeUndefined();
    expect(levelsWrite(L, { kind: "about", at: 2, about: undefined })).toBeUndefined();
    expect(levelsWrite(L, { kind: "up", at: 0 })).toBeUndefined();
    expect(levelsWrite(L, { kind: "down", at: 2 })).toBeUndefined();
    expect(levelsWrite([{ key: "M" }], { kind: "remove", at: 0 })).toBeUndefined();
  });

  test("a name used twice, ignoring case, a character a name cannot have, or too long is a problem", () => {
    expect(nameProblem(L, 1, "Medium")).toBeUndefined();
    expect(nameProblem(L, 1, "m")).toBeUndefined();
    expect(nameProblem(L, 1, "s")).toBe("taken");
    expect(nameProblem(L, L.length, "l")).toBe("taken");
    expect(nameProblem(L, 1, "")).toBe("empty");
    expect(nameProblem(L, 1, "M/L")).toBe("characters");
    expect(nameProblem(L, 1, "Half  day")).toBe("characters");
    expect(nameProblem(L, 1, "Half a day")).toBeUndefined();
    expect(nameProblem(L, 1, "Half a day!")).toBe("characters");
    expect(nameProblem(L, 1, "Half a days")).toBe("long");
    // A longer name the space holds already stays.
    const held = [{ key: "Deep-work-sessions" }, { key: "M" }];
    expect(nameProblem(held, 0, "Deep-work-sessions")).toBeUndefined();
    expect(oneLine("  a\tquick\nreply ")).toBe("a quick reply");
  });

  test("a removed level's tasks go to the next bigger level, or the next smaller when the largest goes", () => {
    expect(moveTarget(EFFORT_LEVELS, 2)).toBe("L");
    expect(moveTarget(EFFORT_LEVELS, 0)).toBe("S");
    expect(moveTarget(EFFORT_LEVELS, 4)).toBe("L");
  });
});
