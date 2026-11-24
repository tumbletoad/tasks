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
    expect(levelsWrite(L, { kind: "rename", key: "M", name: "Medium" })).toEqual({
      value: [L[0], { key: "Medium", time: { amount: 4, unit: "hours" } }, L[2]],
      moves: [{ from: "M", to: "Medium" }],
    });
    expect(
      levelsWrite(L, { kind: "time", key: "L", time: { amount: 2, unit: "days" } })?.value[2],
    ).toEqual({ key: "L", time: { amount: 2, unit: "days" } });
    expect(levelsWrite(L, { kind: "time", key: "S", time: undefined })?.value[0]).toEqual({
      key: "S",
      about: "Small",
    });
    expect(levelsWrite(L, { kind: "about", key: "S", about: undefined })?.value[0]).toEqual({
      key: "S",
      time: { amount: 1, unit: "hours" },
    });
    expect(keys(levelsWrite(L, { kind: "up", key: "M" })?.value)).toEqual(["M", "S", "L"]);
    expect(keys(levelsWrite(L, { kind: "down", key: "M" })?.value)).toEqual(["S", "L", "M"]);
    expect(levelsWrite(L, { kind: "up", key: "M" })?.moves).toEqual([]);
    expect(levelsWrite(L, { kind: "remove", key: "M" })).toEqual({
      value: [L[0], L[2]],
      moves: [],
    });
    expect(levelsWrite(L, { kind: "remove", key: "M", to: "L" })?.moves).toEqual([
      { from: "M", to: "L" },
    ]);
    expect(levelsWrite(L, { kind: "remove", key: "M", to: null })?.moves).toEqual([
      { from: "M", to: null },
    ]);
  });

  test("a change to nothing writes nothing, and the bounds hold", () => {
    expect(levelsWrite(L, { kind: "rename", key: "M", name: "M" })).toBeUndefined();
    expect(
      levelsWrite(L, { kind: "time", key: "M", time: { amount: 4, unit: "hours" } }),
    ).toBeUndefined();
    expect(levelsWrite(L, { kind: "about", key: "L", about: undefined })).toBeUndefined();
    expect(levelsWrite(L, { kind: "up", key: "S" })).toBeUndefined();
    expect(levelsWrite(L, { kind: "down", key: "L" })).toBeUndefined();
    expect(levelsWrite([{ key: "M" }], { kind: "remove", key: "M" })).toBeUndefined();
  });

  test("a name used twice, ignoring case, a character a name cannot have, or too long is a problem", () => {
    expect(nameProblem(L, "M", "Medium")).toBeUndefined();
    expect(nameProblem(L, "M", "m")).toBeUndefined();
    expect(nameProblem(L, "M", "s")).toBe("taken");
    expect(nameProblem(L, undefined, "l")).toBe("taken");
    expect(nameProblem(L, "M", "")).toBe("empty");
    expect(nameProblem(L, "M", "M/L")).toBe("characters");
    expect(nameProblem(L, "M", "Half  day")).toBe("characters");
    expect(nameProblem(L, "M", "Half a day")).toBeUndefined();
    expect(nameProblem(L, "M", "Half a day!")).toBe("characters");
    expect(nameProblem(L, "M", "Half a days")).toBe("long");
    // A longer name the space holds already stays.
    const held = [{ key: "Deep-work-sessions" }, { key: "M" }];
    expect(nameProblem(held, "Deep-work-sessions", "Deep-work-sessions")).toBeUndefined();
    expect(oneLine("  a\tquick\nreply ")).toBe("a quick reply");
  });

  test("a removed level's tasks go to the next bigger level, or the next smaller when the largest goes", () => {
    expect(moveTarget(EFFORT_LEVELS, "M")).toBe("L");
    expect(moveTarget(EFFORT_LEVELS, "XS")).toBe("S");
    expect(moveTarget(EFFORT_LEVELS, "XL")).toBe("L");
  });
});
