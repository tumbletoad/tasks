import { describe, expect, test } from "vitest";
import { areaSlots, groupTasks } from "@ttasks/client/today";
import type { AreaRow, ProjectRow, TaskRow } from "@ttasks/client/store";
import { itemsOf, moveFrom } from "./items.ts";

const area = (id: string, title: string, position: string): AreaRow => ({ id, title, position });
const project = (id: string, area_id: string, title: string, position: string): ProjectRow => ({
  id,
  area_id,
  title,
  position,
});
const task = (id: string, fields: Partial<TaskRow> = {}): TaskRow => ({
  id,
  ref: `M-${id}`,
  title: id,
  status: "open",
  inbox: false,
  lifecycle: "active",
  position: id,
  created_at: 1,
  version: 1,
  ...fields,
});

const AREAS = new Map([
  ["a1", area("a1", "Lumen", "a")],
  ["a2", area("a2", "Home", "b")],
]);
const PROJECTS = new Map([["p1", project("p1", "a1", "Portal", "a")]]);
const TASKS = [
  task("t1", { area_id: "a1" }),
  task("t2", { area_id: "a1", project_id: "p1" }),
  task("t3", { area_id: "a1", project_id: "p1" }),
  task("t4", { area_id: "a2" }),
  task("t5", { inbox: true }),
];

const build = () =>
  itemsOf(
    groupTasks(TASKS, AREAS.values(), PROJECTS.values()),
    AREAS,
    PROJECTS,
    areaSlots(AREAS.values()),
  );

describe("[A5.3.25.web.items] a grouped list as one sequence of items", () => {
  test("headings and labels are items; each row knows its place, its set and its area", () => {
    const { items, rows, index } = build();
    expect(items.map((i) => i.key)).toEqual([
      "g:inbox",
      "t5",
      "g:a1",
      "t1",
      "s:p1",
      "t2",
      "t3",
      "g:a2",
      "t4",
    ]);
    expect(rows).toBe(5);
    expect(index.get("t3")).toBe(6);
    const t3 = items[6];
    expect(t3?.kind === "row" && [t3.posinset, t3.setsize]).toEqual([2, 2]);
    const t1 = items[3];
    expect(t1?.kind === "row" && [t1.posinset, t1.setsize, t1.slot]).toEqual([1, 1, 1]);
    // Area and project rows by identity: an unchanged row gets the same objects.
    expect(t3?.kind === "row" && t3.area).toBe(AREAS.get("a1"));
    expect(t3?.kind === "row" && t3.project).toBe(PROJECTS.get("p1"));
    const t4 = items[8];
    expect(t4?.kind === "row" && t4.slot).toBe(2);
  });

  test("keyboard moves skip headings and labels", () => {
    const { items, index } = build();
    const at = (key: string) => index.get(key) ?? -1;
    const key = (i: number | undefined) => (i === undefined ? undefined : items[i]?.key);
    expect(key(moveFrom(items, at("t5"), "next"))).toBe("t1");
    expect(key(moveFrom(items, at("t1"), "next"))).toBe("t2");
    expect(key(moveFrom(items, at("t2"), "previous"))).toBe("t1");
    expect(key(moveFrom(items, at("t4"), "next"))).toBeUndefined();
    expect(key(moveFrom(items, at("t5"), "previous"))).toBeUndefined();
    expect(key(moveFrom(items, at("t3"), "first"))).toBe("t5");
    expect(key(moveFrom(items, at("t1"), "last"))).toBe("t4");
    expect(key(moveFrom(items, at("t1"), "next-group"))).toBe("t4");
    expect(key(moveFrom(items, at("t5"), "next-group"))).toBe("t1");
    // `[`: to the first row of this group, then to the previous group's first row.
    expect(key(moveFrom(items, at("t3"), "previous-group"))).toBe("t1");
    expect(key(moveFrom(items, at("t1"), "previous-group"))).toBe("t5");
    expect(key(moveFrom(items, at("t4"), "previous-group"))).toBe("t1");
  });
});
