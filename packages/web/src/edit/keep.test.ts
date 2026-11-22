// @vitest-environment happy-dom
//
// The field edits that wait, kept in the browser across a reload (keep.ts): each control's edit
// comes back as the control made it, a value no control could make never comes back, and a tab
// removes only what it kept or read.
import { PRODUCT_ID } from "@ttasks/brand";
import { beforeEach, describe, expect, test } from "vitest";
import {
  changeOf,
  dueChange,
  effortChange,
  groupingChange,
  priorityChange,
  restoreChange,
  starChange,
  statusChange,
  titleChange,
  triageChange,
  waitingChange,
  type Change,
} from "./change.ts";
import type { Unsaved } from "./edits.ts";
import { forgetUnsaved, unsavedKeeper, unsavedOf, unsavedTasks } from "./keep.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const OTHER = "sp_abcdefghjkmnpqrs0123456789";
const AREA = { id: "ar_0123456789abcdefghjkmnpqrs", title: "Home" };
const PROJECT = { id: "pj_0123456789abcdefghjkmnpqrs", title: "Move" };

function unsaved(change: Change, n = 1, extra: Partial<Unsaved> = {}): Unsaved {
  return {
    task: `tk_${String(n).padStart(5, "0")}`,
    ref: `M-${String(n)}`,
    field: change.fields[0] ?? "title",
    change,
    reason: "failed",
    ...extra,
  };
}

const asMap = (list: readonly Unsaved[]) =>
  new Map(list.flatMap((u) => u.change.fields.map((f) => [`${u.task}\u0000${f}`, u] as const)));

/** What a change does and says, without how it was made. */
const effect = (change: Change | undefined) =>
  change === undefined
    ? undefined
    : {
        fields: change.fields,
        set: change.set,
        clear: change.clear,
        overlay: change.overlay,
        said: change.said,
        shown: change.shown,
      };

const stored = () =>
  Object.keys(localStorage)
    .filter((key) => key.startsWith(`${PRODUCT_ID}.unsaved.`))
    .sort();

beforeEach(() => {
  localStorage.clear();
});

describe("[A5.3.11.web.kept-edits] an edit the service did not take survives a reload, and only as a control made it", () => {
  test("every control's edit comes back from the browser's storage as it was made", () => {
    const triage = triageChange().parts ?? [];
    const changes: Change[] = [
      titleChange("Book the van"),
      starChange(true, "2026-11-17"),
      starChange(false, ""),
      priorityChange(1),
      priorityChange(4),
      effortChange("L"),
      effortChange(undefined),
      dueChange("2026-11-20", "Fri 20 Nov"),
      dueChange(undefined, undefined),
      statusChange("waiting"),
      ...triage,
      waitingChange("Ana"),
      waitingChange(undefined),
      groupingChange(AREA, PROJECT),
      groupingChange(AREA, undefined),
      restoreChange("grouping", { area_id: AREA.id, project_id: null }) as Change,
    ];
    const list = changes.map((change, i) =>
      unsaved(change, i + 1, i % 2 === 0 ? {} : { reason: "conflict", by: "Codex", at: 1_000 }),
    );
    unsavedKeeper(SPACE).save(asMap(list));
    const back = unsavedKeeper(SPACE).load();
    expect(back).toHaveLength(list.length);
    for (const original of list) {
      const found = back.find((u) => u.task === original.task);
      expect(found, original.task).toMatchObject({
        ref: original.ref,
        field: original.field,
        reason: original.reason,
        ...(original.by === undefined ? {} : { by: original.by, at: original.at }),
      });
      expect(effect(found?.change), original.task).toEqual(effect(original.change));
    }
    // Kept per space: another space's page reads none of them.
    expect(unsavedKeeper(OTHER).load()).toEqual([]);
    expect(unsavedTasks(SPACE)).toHaveLength(list.length);
  });

  test("a value no control could make, or not of the edit's shape, never comes back and is removed", () => {
    const good = unsaved(priorityChange(2));
    unsavedKeeper(SPACE).save(asMap([good]));
    const name = (task: string, field: string) => `${PRODUCT_ID}.unsaved.${SPACE}.${task}.${field}`;
    const hostile: Record<string, unknown>[] = [
      // A request of its own rather than a control's source.
      { task: "tk_2", ref: "M-2", field: "title", reason: "failed", set: { title: "x" } },
      {
        task: "tk_3",
        ref: "M-3",
        field: "priority",
        reason: "failed",
        source: { kind: "priority", level: 9 },
      },
      {
        task: "tk_4",
        ref: "M-4",
        field: "due",
        reason: "failed",
        source: { kind: "due", date: "soon" },
      },
      {
        task: "tk_5",
        ref: "M-5",
        field: "title",
        reason: "maybe",
        source: { kind: "title", title: "x" },
      },
      {
        task: "tk_6",
        ref: "<b>",
        field: "title",
        reason: "failed",
        source: { kind: "title", title: "x" },
      },
      // A source for another field than the one it is kept under.
      {
        task: "tk_7",
        ref: "M-7",
        field: "due",
        reason: "failed",
        source: { kind: "title", title: "x" },
      },
      {
        task: "tk_8",
        ref: "M-8",
        field: "grouping",
        reason: "failed",
        source: { kind: "restore", field: "grouping", value: { area_id: "../x" } },
      },
      {
        task: "tk_9",
        ref: "M-9",
        field: "status",
        reason: "failed",
        source: { kind: "status", status: "Open!" },
      },
    ];
    for (const value of hostile) {
      localStorage.setItem(
        name(String(value["task"]), String(value["field"])),
        JSON.stringify(value),
      );
    }
    localStorage.setItem(name("tk_10", "title"), "not json");
    // Kept under another task's name than its own.
    localStorage.setItem(
      name("tk_11", "title"),
      JSON.stringify({
        task: "tk_12",
        ref: "M-12",
        field: "title",
        reason: "failed",
        source: { kind: "title", title: "x" },
      }),
    );
    const back = unsavedKeeper(SPACE).load();
    expect(back.map((u) => u.task)).toEqual([good.task]);
    expect(stored()).toEqual([name(good.task, "priority")]);
    expect(changeOf({ kind: "title", title: "" })).toBeUndefined();
    expect(changeOf(null)).toBeUndefined();
  });

  test("saved or discarded, it goes; a second tab never takes away what it did not keep or read", () => {
    const first = unsaved(titleChange("Mine"), 1);
    const tab = unsavedKeeper(SPACE);
    tab.save(asMap([first]));
    // Another tab opened before: it never read the first tab's edit, and keeps its own beside it.
    const other = unsavedKeeper(SPACE);
    const second = unsaved(effortChange("S"), 2);
    other.save(asMap([second]));
    other.save(new Map());
    expect(stored()).toEqual([`${PRODUCT_ID}.unsaved.${SPACE}.tk_00001.title`]);
    // A reload reads it; the person discards it there, and it is gone for every tab.
    const reloaded = unsavedKeeper(SPACE);
    expect(reloaded.load().map((u) => u.task)).toEqual(["tk_00001"]);
    reloaded.save(new Map());
    expect(stored()).toEqual([]);
    // Two tabs read one edit; the second keeps a newer one in its place. The first discards the
    // edit it read, and the newer one stays.
    const kept = unsaved(titleChange("Old"), 4);
    unsavedKeeper(SPACE).save(asMap([kept]));
    const tabA = unsavedKeeper(SPACE);
    const tabB = unsavedKeeper(SPACE);
    expect(tabA.load()).toHaveLength(1);
    expect(tabB.load()).toHaveLength(1);
    tabB.save(asMap([unsaved(titleChange("Newer"), 4)]));
    tabA.save(new Map());
    expect(
      unsavedKeeper(SPACE)
        .load()
        .map((u) => u.change.source),
    ).toEqual([titleChange("Newer").source]);
    tabB.save(new Map());
    expect(stored()).toEqual([]);
    // A task gone for good takes its edits with it.
    tab.save(asMap([unsaved(titleChange("Again"), 3), unsaved(priorityChange(1), 3)]));
    forgetUnsaved(SPACE, "tk_00003");
    expect(stored()).toEqual([]);
  });

  test("a kept edit is read by its shape alone", () => {
    expect(
      unsavedOf({
        task: "tk_1",
        ref: "M-1",
        field: "title",
        reason: "failed",
        source: { kind: "title", title: "A" },
      }),
    ).toMatchObject({ task: "tk_1", field: "title" });
    expect(unsavedOf("tk_1")).toBeUndefined();
    expect(
      unsavedOf({
        task: "tk_1",
        ref: "M-1",
        field: "title",
        reason: "failed",
        by: 3,
        source: { kind: "title", title: "A" },
      }),
    ).toBeUndefined();
  });
});
