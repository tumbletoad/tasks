// @vitest-environment happy-dom
//
// The field edits that wait, kept in the browser across a reload (unsent.ts): each control's edit
// comes back as the control made it, a value no control could make never comes back, and a tab
// removes only what it kept or read.
import { PRODUCT_ID } from "@ttasks/brand";
import { beforeEach, describe, expect, test } from "vitest";
import {
  changeOf,
  dueChange,
  effortChange,
  levelsKey,
  groupingChange,
  priorityChange,
  starChange,
  statusChange,
  titleChange,
  triageChange,
  waitingChange,
  type Change,
} from "./change.ts";
import type { Unsaved } from "./edits.ts";
import {
  actionKeeper,
  forgetTask,
  keptActions,
  unsavedKeeper,
  unsavedOf,
  unsentOf,
  unsentTasks,
} from "../unsent.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const OTHER = "sp_abcdefghjkmnpqrs0123456789";
const AREA = { id: "ar_0123456789abcdefghjkmnpqrs", title: "Home" };
const PROJECT = { id: "pj_0123456789abcdefghjkmnpqrs", title: "Move" };

function unsaved(change: Change, n = 1, extra: Partial<Unsaved> = {}): Unsaved {
  return {
    id: crypto.randomUUID(),
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
    .filter((key) => /^[^.]+.edit./u.test(key))
    .sort();
/** The name an edit with an ID is kept under. */
const keptName = (task: string, field: string, id: string) =>
  `${PRODUCT_ID}.edit.${SPACE}.${task}.${field}.${id}`;

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
      effortChange("M", levelsKey([{ key: "S" }, { key: "M" }])),
      effortChange(undefined),
      dueChange("2026-11-20", "Fri 20 Nov"),
      dueChange(undefined, undefined),
      statusChange("waiting"),
      ...triage,
      waitingChange("Ana"),
      waitingChange(undefined),
      groupingChange(AREA, PROJECT),
      groupingChange(AREA, undefined),
    ];
    const list = changes.map((change, i) =>
      unsaved(
        change,
        i + 1,
        i % 2 === 0 ? { base: "1.12.0a1b2c3d" } : { reason: "conflict", by: "Codex", at: 1_000 },
      ),
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
        ...(original.base === undefined ? {} : { base: original.base }),
        ...(original.by === undefined ? {} : { by: original.by, at: original.at }),
      });
      expect(effect(found?.change), original.task).toEqual(effect(original.change));
      // A size keeps the levels it was chosen from, so a change of them since is seen.
      expect(found?.change.source, original.task).toEqual(original.change.source);
    }
    // Kept per space: another space's page reads none of them.
    expect(unsavedKeeper(OTHER).load()).toEqual([]);
    expect(unsentTasks(SPACE)).toHaveLength(list.length);
  });

  test("a value no control could make, or not of the edit's shape, never comes back and is removed", () => {
    const good = unsaved(priorityChange(2));
    unsavedKeeper(SPACE).save(asMap([good]));
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
      {
        task: "tk_13",
        ref: "M-13",
        field: "title",
        reason: "failed",
        base: "../1.2",
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
      const id = crypto.randomUUID();
      localStorage.setItem(
        keptName(String(value["task"]), String(value["field"]), id),
        JSON.stringify({ id, ...value }),
      );
    }
    localStorage.setItem(keptName("tk_10", "title", crypto.randomUUID()), "not json");
    // An ID that is no ID, under the name it would have.
    localStorage.setItem(
      keptName("tk_14", "title", "x"),
      JSON.stringify({
        id: "x",
        task: "tk_14",
        ref: "M-14",
        field: "title",
        reason: "failed",
        source: { kind: "title", title: "x" },
      }),
    );
    // Kept under another task's name than its own.
    const elsewhere = crypto.randomUUID();
    localStorage.setItem(
      keptName("tk_11", "title", elsewhere),
      JSON.stringify({
        id: elsewhere,
        task: "tk_12",
        ref: "M-12",
        field: "title",
        reason: "failed",
        source: { kind: "title", title: "x" },
      }),
    );
    const back = unsavedKeeper(SPACE).load();
    expect(back.map((u) => u.task)).toEqual([good.task]);
    expect(stored()).toEqual([keptName(good.task, "priority", good.id)]);
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
    expect(stored()).toEqual([keptName("tk_00001", "title", first.id)]);
    // A reload reads it; the person discards it there, and it is gone for every tab.
    const reloaded = unsavedKeeper(SPACE);
    expect(reloaded.load().map((u) => u.task)).toEqual(["tk_00001"]);
    reloaded.save(new Map());
    expect(stored()).toEqual([]);
    // A task gone for good takes its edits with it.
    tab.save(asMap([unsaved(titleChange("Again"), 3), unsaved(priorityChange(1), 3)]));
    forgetTask(SPACE, "tk_00003");
    expect(stored()).toEqual([]);
  });

  test("two tabs whose edits of one field are both refused keep both: a reload finds each tab's words", () => {
    const tabA = unsavedKeeper(SPACE);
    const tabB = unsavedKeeper(SPACE);
    tabA.save(asMap([unsaved(titleChange("Book the hall"), 1)]));
    tabB.save(asMap([unsaved(titleChange("Book the big hall"), 1)]));
    const words = unsentOf(SPACE).flatMap((word) =>
      word.kind === "edit" && word.field === "title" ? [word.shown] : [],
    );
    expect(words.sort()).toEqual(["Book the big hall", "Book the hall"]);
    // Tab A saves its own words; tab B's stay.
    tabA.save(new Map());
    expect(unsentOf(SPACE).flatMap((word) => (word.kind === "edit" ? [word.shown] : []))).toEqual([
      "Book the big hall",
    ]);
  });

  test("a kept edit is read by its shape alone", () => {
    const id = crypto.randomUUID();
    expect(
      unsavedOf({
        id,
        task: "tk_1",
        ref: "M-1",
        field: "title",
        reason: "failed",
        source: { kind: "title", title: "A" },
      }),
    ).toMatchObject({ id, task: "tk_1", field: "title" });
    // An edit without its own ID is not one this page keeps.
    expect(
      unsavedOf({
        task: "tk_1",
        ref: "M-1",
        field: "title",
        reason: "failed",
        source: { kind: "title", title: "A" },
      }),
    ).toBeUndefined();
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

describe("[A5.3.11.web.kept-actions] an action that waited when the page went is kept for the browser on its task until it is decided or discarded", () => {
  test("each kept action is listed on its task in its space; one of another shape never is; it goes once done, and with a task gone for good", () => {
    const request = () => crypto.randomUUID();
    const on = (n: number) => ({ task: `tk_0000${String(n)}`, ref: `M-${String(n)}` });
    const finish = { kind: "finish", request: request(), ...on(1), base: "1.12.0a1b2c3d" } as const;
    const undo = { kind: "undo", request: request(), ...on(1), of: request() } as const;
    const redo = {
      kind: "redo",
      request: request(),
      ...on(2),
      commit: `op_${"7".padStart(26, "0")}`,
    } as const;
    const keeper = actionKeeper(SPACE);
    keeper.keep(finish);
    keeper.keep(undo);
    keeper.keep(redo);
    expect(keptActions(SPACE, "tk_00001")).toHaveLength(2);
    expect(keptActions(SPACE, "tk_00001")).toEqual(expect.arrayContaining([finish, undo]));
    expect(keptActions(SPACE, "tk_00002")).toEqual([redo]);
    expect(keptActions(OTHER, "tk_00001")).toEqual([]);
    expect(unsentTasks(SPACE).sort()).toEqual(["tk_00001", "tk_00002"]);
    // Not of a kept action's shape: never listed.
    const id = request();
    localStorage.setItem(
      `${PRODUCT_ID}.action.${SPACE}.tk_00002.${id}`,
      JSON.stringify({ kind: "finish", request: id, task: "tk_00002" }),
    );
    expect(keptActions(SPACE, "tk_00002")).toEqual([redo]);
    keeper.done(undo.request);
    expect(keptActions(SPACE, "tk_00001")).toEqual([finish]);
    forgetTask(SPACE, "tk_00002");
    expect(keptActions(SPACE, "tk_00002")).toEqual([]);
    expect(keptActions(SPACE, "tk_00001")).toEqual([finish]);
  });
});
