// Undo and Redo of a change of the effort levels (A1 3.10.1, 3.16): plain inversions of the rows
// its commit recorded, under each field's own guard. Its tasks go back only with its list, and a
// task left on a size the levels lack is said, never a reason to refuse. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import { readSpacePreference } from "../src/preferences.ts";
import type { Credential, EffortMove, Operation, WriteResult } from "../src/write/request.ts";
import { join } from "node:path";
import { openSpaceConnection } from "../src/open.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("effort-undo");
const fixture = fixtureCopies(temp.make, { flush: false });
afterAll(temp.cleanup);

let fx: Fixture;
beforeEach(async () => {
  fx = await fixture();
});
afterEach(() => {
  checkHistory(fx.reader);
  fx.close();
});

const SCALE = "tasks.effort_scale";

const write = (actor: Credential, ops: Operation[], extra = {}): WriteResult =>
  fx.writer.submit(fx.request(actor, ops, { base: fx.base(), ...extra }));

const setLevels = (keys: readonly string[], moves?: EffortMove[]): Operation => ({
  kind: "pref.set",
  key: SCALE,
  value: keys.map((key) => ({ key })),
  ...(moves === undefined ? {} : { moves }),
});

/** A change of levels by `actor`: the person's is a step on their undo stack. */
const change = (keys: readonly string[], moves?: EffortMove[], actor = fx.human) =>
  write(actor, [setLevels(keys, moves)], actor === fx.human ? { undoable: true } : {});

const history = (kind: "undo" | "redo", partial = false): WriteResult =>
  fx.writer.submit(fx.request(fx.human, [{ kind, ...(partial ? { partial: true } : {}) }]));

function tasks(...efforts: string[]): Id<"t">[] {
  const ids = efforts.map(() => newId("t"));
  const ops = efforts.map((effort, k): Operation => ({
    kind: "task.create",
    id: ids[k] ?? newId("t"),
    title: `Fixture task ${String(k + 1)}`,
    effort,
  }));
  expectStatus(write(fx.codex, ops), "applied");
  return ids;
}

const efforts = (ids: readonly string[]): unknown[] =>
  ids.map(
    (id) => fx.reader.prepare("SELECT effort FROM tasks WHERE id = $id").get({ id })?.["effort"],
  );
const names = (): string[] =>
  (readSpacePreference(fx.reader, SCALE).value as { key: string }[]).map((l) => l.key);
const refOf = (id: string): string =>
  String(
    fx.reader
      .prepare("SELECT s.ref_prefix || '-' || t.ref AS ref FROM tasks t, space s WHERE t.id = $id")
      .get({ id })?.["ref"],
  );

/** The levels S, M and L, set by the person off the undo stack. */
const start = () => {
  expectStatus(write(fx.human, [setLevels(["S", "M", "L"])]), "applied");
};

/** A second person of the space, who may change the levels too. */
async function partner(): Promise<Credential> {
  const id = newId("ac");
  const conn = openSpaceConnection(await checkedDriver(), join(fx.folder, "space.db"), "writer");
  try {
    conn
      .prepare(
        "INSERT INTO actors (id, kind, label, instance_id, routine_id, created_at) " +
          "VALUES ($id, 'human', 'Fixture partner', NULL, NULL, 0)",
      )
      .run({ id });
  } finally {
    conn.close();
  }
  return { ...fx.human, principal_id: id, scope_id: "ui:partner" };
}

describe("[A1.3.10.history.effort-levels] Undo and Redo take a change of levels back whole, and say what is off the levels", () => {
  test("working alone, Undo puts the list and every moved task back, and Redo the change again", () => {
    start();
    const ids = tasks("M", "M", "L");
    expectStatus(change(["S", "Medium", "L"], [{ from: "M", to: "Medium" }]), "applied");
    const undone = history("undo");
    expectStatus(undone, "applied");
    expect(undone.results[0]).toMatchObject({ levels: true });
    expect(undone.results[0]?.off_list).toBeUndefined();
    expect([names(), efforts(ids)]).toEqual([
      ["S", "M", "L"],
      ["M", "M", "L"],
    ]);
    expectStatus(history("redo"), "applied");
    expect([names(), efforts(ids)]).toEqual([
      ["S", "Medium", "L"],
      ["Medium", "Medium", "L"],
    ]);
  });

  test("a task that reached a size the old levels lack keeps it, is named, and a move from that size takes it along", () => {
    start();
    const [moved] = tasks("M");
    expectStatus(change(["S", "Medium", "L"], [{ from: "M", to: "Medium" }]), "applied");
    const [late] = tasks("Medium");
    const undone = history("undo");
    expectStatus(undone, "applied");
    expect(undone.conflicts).toEqual([]);
    expect(undone.results[0]?.off_list).toEqual([
      { effort: "Medium", tasks: [refOf(late ?? "")], count: 1 },
    ]);
    expect([names(), efforts([moved ?? "", late ?? ""])]).toEqual([
      ["S", "M", "L"],
      ["M", "Medium"],
    ]);
    expectStatus(change(["S", "M", "L"], [{ from: "Medium", to: "M" }]), "applied");
    expect(efforts([late ?? ""])).toEqual(["M"]);
  });

  test("a moved task whose size changed since is named; Undo the rest puts back the list and the others, and it keeps its size", () => {
    start();
    const ids = tasks("M", "M");
    expectStatus(change(["S", "Medium", "L"], [{ from: "M", to: "Medium" }]), "applied");
    expectStatus(
      write(fx.codex, [{ kind: "task.patch", task: ids[1] ?? "", set: { effort: "L" } }]),
      "applied",
    );
    const full = history("undo");
    expect([full.status, full.conflicts.map((c) => [c.entity, c.field])]).toEqual([
      "conflict",
      [["tasks", "effort"]],
    ]);
    expectStatus(history("undo", true), "applied");
    expect([names(), efforts(ids)]).toEqual([
      ["S", "M", "L"],
      ["M", "L"],
    ]);
  });

  test("when someone else changed the levels since, none of the step comes back; Undo the rest consumes it", async () => {
    start();
    const ids = tasks("M");
    expectStatus(change(["S", "Medium", "L"], [{ from: "M", to: "Medium" }]), "applied");
    // Another person's change of the levels, off this person's stack.
    expectStatus(write(await partner(), [setLevels(["S", "Medium", "L", "XL"])]), "applied");
    const full = history("undo");
    expect([full.status, full.conflicts.map((c) => [c.entity, c.id, c.field])]).toEqual([
      "conflict",
      [["preferences", SCALE, "value"]],
    ]);
    const rest = history("undo", true);
    expectStatus(rest, "applied");
    expect(rest.results[0]).toMatchObject({ levels: true });
    expect([names(), efforts(ids)]).toEqual([["S", "Medium", "L", "XL"], ["Medium"]]);
    expect(history("undo").error?.code).toBe("NOTHING_TO_UNDO");
  });
});

describe("[A1.3.10.history.effort-first] the first change of levels a space stores comes back as the levels it read", () => {
  test("Undo stores the levels the space read, which its opening keeps, and Redo after a reopen applies", () => {
    const read = names();
    const without = fx.writer.submit(
      fx.request(fx.human, [setLevels(["S", "M"])], { undoable: true }),
    );
    expect(without.error?.code).toBe("BASE_REQUIRED");
    expectStatus(change(["S", "M"]), "applied");
    expectStatus(history("undo"), "applied");
    expect(readSpacePreference(fx.reader, SCALE)).toMatchObject({ state: "set" });
    expect(names()).toEqual(read);
    fx.reopen();
    expect(fx.writer.storeDefaults()).toBe(false);
    expectStatus(history("redo"), "applied");
    expect(names()).toEqual(["S", "M"]);
  });

  test("of two people who read a space without stored levels, the second's change is a conflict", async () => {
    const base = fx.base();
    const first = fx.writer.submit(
      fx.request(fx.human, [setLevels(["S", "M"])], { base, undoable: true }),
    );
    expectStatus(first, "applied");
    const second = fx.writer.submit(fx.request(await partner(), [setLevels(["M", "L"])], { base }));
    expect([second.status, second.error?.code]).toEqual(["conflict", "VERSION_CONFLICT"]);
    expect(names()).toEqual(["S", "M"]);
  });
});

describe("[A1.3.16.prefs.undo-other] only the effort levels join the undo stack", () => {
  test("a change of another preference is no step: Undo after it takes back the step before it", () => {
    start();
    const [task] = tasks("M");
    expectStatus(
      write(fx.human, [{ kind: "task.patch", task: task ?? "", set: { effort: "L" } }], {
        undoable: true,
      }),
      "applied",
    );
    expectStatus(
      write(fx.human, [{ kind: "pref.set", key: "tasks.dedupe_window_days", value: 14 }]),
      "applied",
    );
    expectStatus(history("undo"), "applied");
    expect(efforts([task ?? ""])).toEqual(["M"]);
    expect(readSpacePreference(fx.reader, "tasks.dedupe_window_days").value).toBe(14);
  });
});
