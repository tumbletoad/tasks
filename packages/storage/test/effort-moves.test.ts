// A change of the effort levels that moves the tasks on a size (A1 3.16): the list and every task
// that holds a moved size change in one commit, through the field path, and its refusals. Each
// test's space holds the levels S, M and L, set by the person off the undo stack. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import { readSpacePreference } from "../src/preferences.ts";
import type { Credential, EffortMove, Operation, WriteResult } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("effort-moves");
const fixture = fixtureCopies(temp.make, { flush: false });
afterAll(temp.cleanup);

let fx: Fixture;
beforeEach(async () => {
  fx = await fixture();
  expectStatus(write(fx.human, [setLevels(["S", "M", "L"])]), "applied");
});
afterEach(() => {
  checkHistory(fx.reader);
  fx.close();
});

const SCALE = "tasks.effort_scale";
const levels = (keys: readonly string[]) => keys.map((key) => ({ key }));

function write(actor: Credential, ops: Operation[], extra: { undoable?: true } = {}): WriteResult {
  return fx.writer.submit(fx.request(actor, ops, { base: fx.base(), ...extra }));
}

const setLevels = (keys: readonly string[], moves?: EffortMove[]): Operation => ({
  kind: "pref.set",
  key: SCALE,
  value: levels(keys),
  ...(moves === undefined ? {} : { moves }),
});

/** The person's change of levels, a step on their undo stack. */
const change = (keys: readonly string[], moves?: EffortMove[]): WriteResult =>
  write(fx.human, [setLevels(keys, moves)], { undoable: true });

/** New tasks of an agent's, one per size (null: none). */
function tasks(...efforts: (string | null)[]): Id<"t">[] {
  const ids = efforts.map(() => newId("t"));
  const ops = efforts.map((effort, k): Operation => ({
    kind: "task.create",
    id: ids[k] ?? newId("t"),
    title: `Fixture task ${String(k + 1)}`,
    ...(effort === null ? {} : { effort }),
  }));
  expectStatus(write(fx.codex, ops), "applied");
  return ids;
}

const effortOf = (id: string): unknown =>
  fx.reader.prepare("SELECT effort FROM tasks WHERE id = $id").get({ id })?.["effort"];
const names = (): string[] =>
  (readSpacePreference(fx.reader, SCALE).value as { key: string }[]).map((l) => l.key);
const commits = (): unknown => fx.reader.prepare("SELECT count(*) AS n FROM commits").get()?.["n"];

describe("[A1.3.16.prefs.effort-moves] a change of levels moves the tasks on a size in the same commit", () => {
  test("every task on M, finished and in the Trash too, moves with its rename; an undone creation holds nothing", () => {
    const [active, done, archived, trashed, large, none] = tasks("M", "M", "M", "M", "L", null);
    for (const [kind, task] of [
      ["task.complete", done],
      ["task.archive", archived],
      ["task.delete", trashed],
    ] as const) {
      expectStatus(write(fx.codex, [{ kind, task: task ?? "" }]), "applied");
    }
    // The person's own task on M, whose creation they undid.
    const undone = newId("t");
    const made = { kind: "task.create", id: undone, title: "Fixture undone", effort: "M" } as const;
    expectStatus(write(fx.human, [made], { undoable: true }), "applied");
    expectStatus(fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }])), "applied");

    const before = commits();
    const result = change(["S", "Medium", "L"], [{ from: "M", to: "Medium" }]);
    expectStatus(result, "applied");
    expect(commits()).toBe(Number(before) + 1);
    expect(result.results[0]?.moved).toEqual([
      { from: "M", to: "Medium", active: 1, finished: 2, trash: 1 },
    ]);
    expect(names()).toEqual(["S", "Medium", "L"]);
    for (const id of [active, done, archived, trashed]) expect(effortOf(id ?? "")).toBe("Medium");
    expect([effortOf(large ?? ""), effortOf(none ?? ""), effortOf(undone)]).toEqual([
      "L",
      null,
      "M",
    ]);
    // One change row for the list, and one for each moved task's effort, each a new version.
    const rows = fx.reader
      .prepare("SELECT entity, field FROM changes WHERE seq = $seq ORDER BY n")
      .all({ seq: result.seq });
    expect(rows).toEqual([
      { entity: "preferences", field: "value" },
      ...Array.from({ length: 4 }, () => ({ entity: "tasks", field: "effort" })),
    ]);
  });

  test("a chain and a swap move each task by the size it held before the change, once", () => {
    const [small, medium, large] = tasks("S", "M", "L");
    const rotate = [
      { from: "S", to: "M" },
      { from: "M", to: "L" },
      { from: "L", to: "S" },
    ];
    expectStatus(change(["S", "M", "L"], rotate), "applied");
    expect([small, medium, large].map((id) => effortOf(id ?? ""))).toEqual(["M", "L", "S"]);
    expectStatus(change(["S", "L"], [{ from: "M", to: null }]), "applied");
    expect(effortOf(small ?? "")).toBeNull();
  });

  test("the same list without a move is no change and no step; a reorder is one", () => {
    tasks("M");
    const before = commits();
    expect(change(["S", "M", "L"]).status).toBe("unchanged");
    expect(commits()).toBe(before);
    expectStatus(change(["L", "M", "S"]), "applied");
    expect(names()).toEqual(["L", "M", "S"]);
  });

  test("an agent's write from a read before the change conflicts, whatever size it sends", () => {
    const [task] = tasks("M");
    const stale = fx.base();
    expectStatus(change(["S", "Medium", "L"], [{ from: "M", to: "Medium" }]), "applied");
    for (const effort of ["M", "L"]) {
      const result = fx.writer.submit(
        fx.request(fx.codex, [{ kind: "task.patch", task: task ?? "", set: { effort } }], {
          base: stale,
        }),
      );
      expect([result.status, result.error?.code], effort).toEqual(["conflict", "VERSION_CONFLICT"]);
    }
  });
});

describe("[A1.3.16.prefs.effort-moves-refused] a change of levels that would strand a size is refused, and nothing changes", () => {
  test("a list that drops a size tasks hold, without a move, is refused with how many hold it", () => {
    const [, done, trashed] = tasks("M", "M", "M", "L");
    expectStatus(write(fx.codex, [{ kind: "task.complete", task: done ?? "" }]), "applied");
    expectStatus(write(fx.codex, [{ kind: "task.delete", task: trashed ?? "" }]), "applied");
    const before = commits();
    const result = change(["S", "L"]);
    expect([result.status, result.error?.code]).toEqual(["rejected", "VALIDATION_FAILED"]);
    expect(result.error?.holders).toEqual([{ effort: "M", active: 1, finished: 1, trash: 1 }]);
    expect([commits(), names()]).toEqual([before, ["S", "M", "L"]]);
  });

  test.each([
    ["a size neither the list nor a task has", ["S", "M", "L"], [{ from: "Q", to: "S" }]],
    ["a target outside the new list", ["S", "L"], [{ from: "M", to: "M" }]],
    [
      "a size moved twice",
      ["S", "L"],
      [
        { from: "M", to: "S" },
        { from: "M", to: "L" },
      ],
    ],
  ])("a move from or to %s is refused", (_, keys, moves) => {
    tasks("M");
    const result = change(keys, moves);
    expect([result.status, result.error?.code]).toEqual(["rejected", "VALIDATION_FAILED"]);
    expect(names()).toEqual(["S", "M", "L"]);
  });

  test("moves on another preference, or the levels with another preference on the stack, are refused", () => {
    const statuses: Operation = {
      kind: "pref.set",
      key: "tasks.statuses",
      value: ["open", "waiting"],
      moves: [{ from: "M", to: "L" }],
    };
    expect(write(fx.human, [statuses]).error?.code).toBe("VALIDATION_FAILED");
    const both: Operation[] = [
      setLevels(["S", "M", "L", "XL"]),
      { kind: "pref.set", key: "tasks.statuses", value: ["open", "waiting"] },
    ];
    expect(write(fx.human, both, { undoable: true }).error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Set the effort levels in a request of their own: only they join the undo stack",
    });
    // Off the stack, as a script or a test helper sends it, the two go in one request.
    expectStatus(write(fx.human, both), "applied");
    const alone: Operation = { kind: "pref.set", key: "tasks.statuses", value: ["open"] };
    expect(write(fx.human, [alone], { undoable: true }).error?.code).toBe("VALIDATION_FAILED");
  });

  test("a base older than the list's last change is a conflict, before its moves are checked", () => {
    tasks("M");
    const stale = fx.base();
    expectStatus(change(["S", "M", "L", "XL"]), "applied");
    const result = fx.writer.submit(
      fx.request(fx.human, [setLevels(["S", "L"], [{ from: "Q", to: "S" }])], {
        base: stale,
        undoable: true,
      }),
    );
    expect([result.status, result.error?.code]).toEqual(["conflict", "VERSION_CONFLICT"]);
  });
});
