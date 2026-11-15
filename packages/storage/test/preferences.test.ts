// pref.set through the write path, and the writer's own reads of preferences (A1 3.16, 3.5, 3.7;
// A3 3.8.3; A7 3.10 M3.11). The registry itself is tested in packages/contracts. Fixture text only.
import { join } from "node:path";
import { ReceiptGetResult, receiptResult } from "@tasks/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import { newId } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import { readSpacePreference, readSpacePreferences } from "../src/preferences.ts";
import type { ConflictEntity, Operation, WriteResult } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("preferences");
afterAll(temp.cleanup);

let fx: Fixture;
beforeEach(async () => {
  fx = await writeFixture(temp.make());
});
afterEach(() => {
  checkHistory(fx.reader);
  fx.close();
});

type Row = Record<string, unknown>;
const one = (sql: string, params = {}): unknown =>
  Object.values(fx.reader.prepare(sql).get(params) ?? {})[0];
const row = (sql: string, params = {}): Row | undefined => fx.reader.prepare(sql).get(params);
const changesAt = (seq: number): Row[] =>
  fx.reader.prepare("SELECT * FROM changes WHERE seq = $seq ORDER BY n").all({ seq });

function submit(
  ops: Operation[],
  extra: { base?: string | null; actor?: "human" | "codex" } = {},
): WriteResult {
  const base = extra.base === undefined ? fx.base() : extra.base;
  return fx.writer.submit(
    fx.request(fx[extra.actor ?? "human"], ops, base === null ? {} : { base }),
  );
}

const set = (key: string, value: unknown): Operation =>
  ({ kind: "pref.set", key, value }) as Operation;

const read = (key: string) => readSpacePreference(fx.reader, key);
const receipts = (status: string): unknown =>
  one("SELECT count(*) FROM receipts WHERE status = $status", { status });

describe("[A1.3.16.prefs.set] pref.set is an ordinary operation through the one write path", () => {
  test("a first set needs no base and writes the row, its create change, its commit and the projection's outbox", () => {
    const result = submit([set("ui.theme", "washi")], { base: null });
    expectStatus(result, "applied");
    expect(result.results[0]).toMatchObject({
      status: "created",
      id: "ui.theme",
      version: result.seq,
    });
    expect(row("SELECT key, value, schema_ver, policy FROM preferences")).toEqual({
      key: "ui.theme",
      value: '"washi"',
      schema_ver: 1,
      policy: 0,
    });
    const [change] = changesAt(result.seq);
    expect(change).toMatchObject({
      entity: "preferences",
      entity_id: "ui.theme",
      task_id: null,
      action: "create",
    });
    expect(
      JSON.parse(one("SELECT ops FROM commits WHERE seq = $seq", { seq: result.seq }) as string),
    ).toEqual([
      { v: 1, op: "pref.set", target: "ui.theme", input: { key: "ui.theme", value: "washi" } },
    ]);
    expect(one("SELECT seq FROM outbox WHERE key = '*'")).toBe(result.seq);
    expect(read("ui.theme")).toEqual({ key: "ui.theme", value: "washi", state: "set" });
  });

  test("changing a stored value needs a base, conflicts on a stale one, and records before and after", () => {
    const first = submit([set("ui.theme", "washi")]);
    const stale = first.as_of;
    const missing = submit([set("ui.theme", "system")], { base: null });
    expectStatus(missing, "rejected");
    expect(missing.error).toMatchObject({ code: "BASE_REQUIRED", op: 0, field: "base" });
    expectStatus(submit([set("ui.theme", "sumi")], { base: stale }), "applied");
    const conflict = submit([set("ui.theme", "system")], { base: stale });
    expectStatus(conflict, "conflict");
    expect(conflict.conflicts).toEqual([
      expect.objectContaining({ op: 0, entity: "preferences", id: "ui.theme", field: "value" }),
    ]);
    const changed = submit([set("ui.theme", "system")]);
    expectStatus(changed, "applied");
    expect(changed.results[0]).toMatchObject({ status: "updated", id: "ui.theme" });
    expect(changesAt(changed.seq)).toEqual([
      expect.objectContaining({
        entity: "preferences",
        action: "set",
        field: "value",
        before: JSON.stringify({ value: '"sumi"', schema_ver: 1 }),
        after: JSON.stringify({ value: '"system"', schema_ver: 1 }),
      }),
    ]);
    // The same value again changes nothing: no commit.
    const again = submit([set("ui.theme", "system")]);
    expectStatus(again, "unchanged");
    expect(again.seq).toBe(changed.seq);
  });

  test("null resets a key to its default and keeps the row; a key never set resets to nothing", () => {
    submit([set("grouping.names", { area: "Client", project: "Engagement" })]);
    expect(read("grouping.names").value).toEqual({ area: "Client", project: "Engagement" });
    const reset = submit([set("grouping.names", null)]);
    expectStatus(reset, "applied");
    expect(one("SELECT value FROM preferences WHERE key = 'grouping.names'")).toBe("null");
    expect(read("grouping.names")).toEqual({
      key: "grouping.names",
      value: { area: "Area", project: "Project" },
      state: "default",
    });
    expectStatus(submit([set("grouping.names", null)]), "unchanged");
    const never = submit([set("projection.enabled", null)], { base: null });
    expectStatus(never, "unchanged");
    expect(never.results[0]).toMatchObject({
      status: "unchanged",
      id: "projection.enabled",
      version: 0,
    });
    expect(one("SELECT count(*) FROM preferences WHERE key = 'projection.enabled'")).toBe(0);
    // Set again after a reset: the row's value comes back, with a base.
    expectStatus(submit([set("grouping.names", { area: "A", project: "P" })]), "applied");
  });

  test("two sets of one key in a request fold into one create with the last value", () => {
    const result = submit([set("ui.theme", "washi"), set("ui.theme", "system")]);
    expectStatus(result, "applied");
    expect(result.results.map((r) => r.status)).toEqual(["created", "updated"]);
    expect(changesAt(result.seq)).toHaveLength(1);
    expect(read("ui.theme").value).toBe("system");
  });

  test("a preference request holds pref.set operations only, so no operation reads a preference the request changes", () => {
    const create = (status?: string): Operation => ({
      kind: "task.create",
      title: "Ask",
      ...(status === undefined ? {} : { status }),
    });
    for (const ops of [
      // A status the request adds, or the default status of a list without `open`.
      [set("tasks.statuses", ["doing"]), create("doing")],
      [set("tasks.statuses", ["doing"]), create()],
      [create(), set("tasks.statuses", ["doing"])],
      // Dedupe's window, which a draft of the same request would read.
      [set("tasks.dedupe_window_days", 0), create()],
    ]) {
      const result = submit(ops);
      expectStatus(result, "rejected");
      expect(result.error).toMatchObject({ code: "VALIDATION_FAILED", field: "ops" });
    }
    // Refused before the transaction: no receipt, no row, no task.
    expect(receipts("rejected")).toBe(0);
    expect(one("SELECT count(*) FROM preferences")).toBe(0);
    expect(one("SELECT count(*) FROM tasks WHERE title = 'Ask'")).toBe(0);
    // In two requests, the second reads what the first set.
    expectStatus(submit([set("tasks.statuses", ["doing"])]), "applied");
    expectStatus(submit([create()]), "applied");
    expect(one("SELECT status FROM tasks WHERE title = 'Ask'")).toBe("doing");
  });

  test("a preference change never joins the undo stack, so it never blocks the person's undo", () => {
    const refused = fx.writer.submit(
      fx.request(fx.human, [set("autonomy.level", "full")], { base: fx.base(), undoable: true }),
    );
    expectStatus(refused, "rejected");
    expect(refused.error).toMatchObject({ code: "VALIDATION_FAILED", field: "undoable" });
    expect(receipts("rejected")).toBe(0);
    // The person's own task change stays the newest on the stack, behind a preference change.
    const created = fx.writer.submit(
      fx.request(fx.human, [{ kind: "task.create", title: "Plan the week" }], {
        base: fx.base(),
        undoable: true,
      }),
    );
    expectStatus(created, "applied");
    expectStatus(submit([set("autonomy.level", "full")]), "applied");
    const undone = fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }]));
    expectStatus(undone, "applied");
    expect(one("SELECT count(*) FROM tasks WHERE deleted_at IS NULL")).toBe(0);
    expect(read("autonomy.level").value).toBe("full");
  });

  test("every receipt of pref.set is receipt.get's result: applied, conflict and refused", () => {
    const first = submit([set("ui.theme", "washi")], { base: null });
    const stale = first.as_of;
    expectStatus(submit([set("ui.theme", "sumi")]), "applied");
    const outcomes = [
      fx.request(fx.human, [set("ui.theme", "system")], { base: stale }),
      fx.request(fx.codex, [set("autonomy.level", "full")]),
      fx.request(fx.human, [set("grouping.names", { area: "A", project: "P" })]),
    ].map((request) => {
      fx.writer.submit(request);
      const output = receiptResult(
        fx.writer.receipt({ scope_id: request.actor.scope_id, request_id: request.request_id }),
      );
      expect(ReceiptGetResult.safeParse(output).error).toBeUndefined();
      return output.found ? output.status : "none";
    });
    expect(outcomes).toEqual(["conflict", "rejected", "applied"]);
    // receipt.get names every table a request can conflict on.
    type Found = Extract<ReturnType<typeof ReceiptGetResult.parse>, { found: true }>;
    type Entity = NonNullable<Found["conflicts"]>[number]["entity"];
    expectTypeOf<Entity>().toEqualTypeOf<ConflictEntity>();
  });

  test("an agent writes only keys that list it; a policy key refuses it, decided with a receipt", () => {
    expectStatus(submit([set("ui.theme", "washi")], { actor: "codex", base: null }), "applied");
    for (const [key, value] of [
      ["autonomy.level", "full"],
      ["autonomy.overrides", { "task.patch.due": "apply" }],
      ["targets.default", "codex-work"],
      ["tasks.effort_scale", [{ key: "XS" }]],
    ] as const) {
      const refused = submit([set(key, value)], { actor: "codex" });
      expectStatus(refused, "rejected");
      expect(refused.error, key).toMatchObject({
        code: "PREFERENCE_FORBIDDEN",
        op: 0,
        field: "key",
      });
    }
    expect(receipts("rejected")).toBe(4);
    expect(one("SELECT count(*) FROM preferences WHERE policy = 1")).toBe(0);
    // The user may: the row records that it is a policy key.
    expectStatus(submit([set("autonomy.level", "full")]), "applied");
    expect(one("SELECT policy FROM preferences WHERE key = 'autonomy.level'")).toBe(1);
    expect(read("autonomy.level").value).toBe("full");
  });

  test("a value outside its shape, an unknown key, a machine key and a missing value are refused before the transaction", () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ kind: "pref.set", key: "ui.theme", value: "purple" }, "VALIDATION_FAILED", "ops[0].value"],
      [
        { kind: "pref.set", key: "tasks.dedupe_window_days", value: 3_651 },
        "VALIDATION_FAILED",
        "ops[0].value",
      ],
      [
        { kind: "pref.set", key: "tasks.statuses", value: ["open", "open"] },
        "VALIDATION_FAILED",
        "ops[0].value",
      ],
      [
        { kind: "pref.set", key: "grouping.names", value: { area: "A" } },
        "VALIDATION_FAILED",
        "ops[0].value",
      ],
      [{ kind: "pref.set", key: "ui.nothing", value: true }, "VALIDATION_FAILED", "ops[0].key"],
      [{ kind: "pref.set", key: "UI Theme", value: "sumi" }, "VALIDATION_FAILED", "ops[0].key"],
      [
        { kind: "pref.set", key: "projection.dir", value: "/srv/view" },
        "VALIDATION_FAILED",
        "ops[0].key",
      ],
      [{ kind: "pref.set", key: "ui.theme" }, "VALIDATION_FAILED", "ops[0].value"],
      [
        { kind: "pref.set", key: "ui.theme", value: "sumi", extra: 1 },
        "VALIDATION_FAILED",
        "ops[0]",
      ],
      [
        {
          kind: "pref.set",
          key: "tasks.statuses",
          value: Array.from({ length: 20_000 }, () => "x"),
        },
        "TOO_LARGE",
        "ops[0].value",
      ],
    ];
    for (const [op, code, field] of cases) {
      const result = submit([op as unknown as Operation]);
      expectStatus(result, "rejected");
      expect(result.error, JSON.stringify(op).slice(0, 80)).toMatchObject({ code, field });
      // The problem never quotes the key or the value.
      expect(result.error?.message).not.toMatch(/purple|nothing|UI Theme|srv/);
    }
    expect(receipts("rejected")).toBe(0);
    expect(one("SELECT count(*) FROM preferences")).toBe(0);
  });

  test("text in a value is stored as the writer stores all text", () => {
    expectStatus(
      submit([set("grouping.names", { area: "Café", project: "Proje\u0000ct" })]),
      "applied",
    );
    expect(read("grouping.names").value).toEqual({ area: "Café", project: "Project" });
  });

  test("a value a newer build wrote stays unchanged and read-only; the default applies", async () => {
    expectStatus(submit([set("ui.theme", "washi")]), "applied");
    const raw = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
    const version = (v: number) =>
      raw.prepare("UPDATE preferences SET schema_ver = $v WHERE key = 'ui.theme'").run({ v });
    try {
      version(2);
      expect(read("ui.theme")).toEqual({ key: "ui.theme", value: "sumi", state: "newer" });
      const refused = submit([set("ui.theme", "system")]);
      expectStatus(refused, "rejected");
      expect(refused.error).toMatchObject({ code: "VALIDATION_FAILED", op: 0, field: "key" });
      expect(one("SELECT value FROM preferences WHERE key = 'ui.theme'")).toBe('"washi"');
    } finally {
      // Back as the history holds it, for the history check after the test.
      version(1);
      raw.close();
    }
  });
});

describe("[A1.3.16.prefs.read] the writer reads preferences through the registry", () => {
  test("a task takes the space's own statuses and effort keys once they are set", () => {
    expectStatus(
      submit([
        set("tasks.statuses", ["open", "doing", "done-ish"]),
        set("tasks.effort_scale", [{ key: "XS" }, { key: "XL" }]),
      ]),
      "applied",
    );
    const id = newId("t");
    expectStatus(
      submit([{ kind: "task.create", id, title: "Plan the week", status: "doing", effort: "XS" }]),
      "applied",
    );
    const waiting = submit([{ kind: "task.create", title: "Ask", status: "waiting" }]);
    expect(waiting.error).toMatchObject({ code: "VALIDATION_FAILED", field: "status" });
    const effort = submit([{ kind: "task.create", title: "Ask", effort: "M" }]);
    expect(effort.error).toMatchObject({ code: "VALIDATION_FAILED", field: "effort" });
    // Reset: the defaults apply again.
    expectStatus(submit([set("tasks.statuses", null), set("tasks.effort_scale", null)]), "applied");
    expectStatus(
      submit([{ kind: "task.create", title: "Ask", status: "waiting", effort: "M" }]),
      "applied",
    );
  });

  test("every declared space key reads its default in a new space, and a set one its value", () => {
    const before = readSpacePreferences(fx.reader);
    expect(before.every((p) => p.state === "default")).toBe(true);
    expect(before.map((p) => p.key)).not.toContain("projection.dir");
    submit([set("features.search_trigram", true)]);
    expect(
      readSpacePreferences(fx.reader).find((p) => p.key === "features.search_trigram"),
    ).toEqual({
      key: "features.search_trigram",
      value: true,
      state: "set",
    });
    expect(() => readSpacePreference(fx.reader, "projection.dir")).toThrow();
  });
});
