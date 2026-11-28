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

function write(actor: Credential, ops: Operation[]): WriteResult {
  return fx.writer.submit(fx.request(actor, ops, { base: fx.base() }));
}

const setLevels = (keys: readonly string[], moves?: EffortMove[]): Operation => ({
  kind: "pref.set",
  key: SCALE,
  value: levels(keys),
  ...(moves === undefined ? {} : { moves }),
});

/** The person's change of levels, a step on their undo stack. */
const change = (keys: readonly string[], moves?: EffortMove[]): WriteResult =>
  write(fx.human, [setLevels(keys, moves)]);

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
  test("every task on M, finished and in the Trash too, moves with its rename", () => {
    const [active, done, archived, trashed, large, none] = tasks("M", "M", "M", "M", "L", null);
    for (const [kind, task] of [
      ["task.complete", done],
      ["task.archive", archived],
      ["task.delete", trashed],
    ] as const) {
      expectStatus(write(fx.codex, [{ kind, task: task ?? "" }]), "applied");
    }
    const before = commits();
    const result = change(["S", "Medium", "L"], [{ from: "M", to: "Medium" }]);
    expectStatus(result, "applied");
    expect(commits()).toBe(Number(before) + 1);
    expect(result.results[0]?.moved).toEqual([
      { from: "M", to: "Medium", active: 1, finished: 2, trash: 1 },
    ]);
    expect(names()).toEqual(["S", "Medium", "L"]);
    for (const id of [active, done, archived, trashed]) expect(effortOf(id ?? "")).toBe("Medium");
    expect([effortOf(large ?? ""), effortOf(none ?? "")]).toEqual(["L", null]);
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

  test("moves on another preference are refused, and the levels go with another preference", () => {
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
    // The levels and another preference go in one request.
    expectStatus(write(fx.human, both), "applied");
  });

  test.each([
    ["a size nobody has", [{ from: "Q", to: "S" }]],
    ["a target outside the new list", [{ from: "M", to: "XL" }]],
    [
      "a size moved twice",
      [
        { from: "M", to: "S" },
        { from: "M", to: "L" },
      ],
    ],
  ])(
    "a base older than the list's last change is a conflict, before a move from or to %s is judged",
    (_, moves) => {
      tasks("M");
      const stale = fx.base();
      expectStatus(change(["S", "M", "L", "XL"]), "applied");
      const result = fx.writer.submit(
        fx.request(fx.human, [setLevels(["S", "L"], moves)], { base: stale }),
      );
      expect([result.status, result.error?.code]).toEqual(["conflict", "VERSION_CONFLICT"]);
    },
  );
});

describe("[A1.3.16.prefs.effort-moves-same] a move to the same name moves nothing", () => {
  test("it is no step on its own, and the answer says no task moved", () => {
    const [task] = tasks("M");
    const before = commits();
    const same = change(["S", "M", "L"], [{ from: "M", to: "M" }]);
    expect(same.status).toBe("unchanged");
    expect(same.results[0]?.moved).toEqual([
      { from: "M", to: "M", active: 0, finished: 0, trash: 0 },
    ]);
    expect([commits(), effortOf(task ?? "")]).toEqual([before, "M"]);
  });
});

describe("[A1.3.16.prefs.effort-dry-run] a dry run of a change of levels is the write, decided and rolled back", () => {
  test("it answers as the write would, a stale base included, and leaves nothing: no commit, no task, no receipt", () => {
    const [task] = tasks("M");
    const stale = fx.base();
    const request = fx.request(
      fx.human,
      [setLevels(["S", "Medium", "L"], [{ from: "M", to: "Medium" }])],
      { base: fx.base(), dry_run: true },
    );
    const before = commits();
    const dry = fx.writer.submit(request);
    expectStatus(dry, "applied");
    expect(dry.results[0]?.moved).toEqual([
      { from: "M", to: "Medium", active: 1, finished: 0, trash: 0 },
    ]);
    expect([commits(), names(), effortOf(task ?? "")]).toEqual([before, ["S", "M", "L"], "M"]);
    expect(
      fx.writer.receipt({ scope_id: fx.human.scope_id, request_id: request.request_id }),
    ).toBeUndefined();
    expectStatus(change(["S", "M", "L", "XL"]), "applied");
    const late = fx.writer.submit(
      fx.request(fx.human, [setLevels(["S", "L"], [{ from: "M", to: "M" }])], {
        base: stale,
        dry_run: true,
      }),
    );
    expect([late.status, late.error?.code]).toEqual(["conflict", "VERSION_CONFLICT"]);
  });

  test("it says the space as it is: a later change makes its position stale, as it does a read's", () => {
    tasks("M");
    const read = fx.base();
    const version = fx.reader
      .prepare("SELECT version FROM preferences WHERE key = $key")
      .get({ key: SCALE })?.["version"];
    const dry = fx.writer.submit(
      fx.request(fx.human, [setLevels(["S", "L"], [{ from: "M", to: "L" }])], {
        base: read,
        dry_run: true,
      }),
    );
    expectStatus(dry, "applied");
    expect([dry.as_of, dry.seq, dry.commit, dry.results[0]?.version]).toEqual([
      read,
      fx.writer.asOf().seq,
      undefined,
      version,
    ]);
    expectStatus(change(["L", "M", "S"]), "applied");
    const after = fx.writer.submit(
      fx.request(fx.human, [setLevels(["S", "M", "L"])], { base: dry.as_of }),
    );
    expect([after.status, after.error?.code]).toEqual(["conflict", "VERSION_CONFLICT"]);
  });

  test("it decides preferences only", () => {
    const dry = fx.writer.submit(
      fx.request(fx.human, [{ kind: "task.create", id: newId("t"), title: "Fixture task" }], {
        dry_run: true,
      }),
    );
    expect([dry.status, dry.error?.field]).toEqual(["rejected", "dry_run"]);
  });
});
