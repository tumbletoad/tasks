// The write path (A1 3.5 to 3.7, X11; A7 3.8 M1.04): coalescing, read-your-writes and each
// operation with its errors. Fixture text only.
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Connection } from "../src/driver.ts";
import { newId, type Id } from "../src/ids.ts";
import { opSpec } from "@tasks/contracts";
import { openWriter } from "../src/open.ts";
import { openSpace } from "../src/space.ts";
import {
  normaliseStored,
  OPERATION_KINDS,
  type Operation,
  type WriteResult,
} from "../src/write/request.ts";
import { SpaceWriter } from "../src/write/writer.ts";
import { checkedDriver, createFixtureSpace, TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import {
  checkHistory,
  expectStatus,
  MACHINE,
  writeFixture,
  type Fixture,
} from "./write-helpers.ts";

const temp = tempFolders("write-path");
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
const task = (id: string): Row =>
  fx.reader.prepare("SELECT * FROM tasks WHERE id = $id").get({ id }) ?? {};
const lastSeq = (): unknown => one("SELECT last_seq FROM space");
const changesAt = (seq: number): Row[] =>
  fx.reader.prepare("SELECT * FROM changes WHERE seq = $seq ORDER BY n").all({ seq });

/** Submits as Mira with a fresh base unless one is given. */
function submit(
  ops: Operation[],
  extra: { base?: string | null; actor?: "human" | "codex" | "claude" } = {},
): WriteResult {
  const actor = fx[extra.actor ?? "human"];
  const base = extra.base === undefined ? fx.base() : extra.base;
  return fx.writer.submit(fx.request(actor, ops, base === null ? {} : { base }));
}

const mapValues = (
  record: Record<string, string>,
  fn: (value: string) => string,
): Record<string, string> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));

/** Every text inside a JSON value, keys included. */
function texts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [key, ...texts(item)]);
  }
  return [];
}

/**
 * Every text the space holds is its own normalisation (A1 3.7): every TEXT value of every row of
 * every table, and every text inside the JSON of commits.ops and of the change rows.
 */
function expectAllNormal(conn: Connection): void {
  const tables = conn
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  for (const { name } of tables) {
    // The names come from sqlite_schema, not from input.
    for (const row of conn.prepare(`SELECT * FROM "${name}"`).all()) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== "string") continue;
        const json =
          (name === "commits" && column === "ops") ||
          (name === "changes" && (column === "before" || column === "after"));
        // JSON writes a lone surrogate as an escape, so its text shows only once parsed.
        const found = json ? [value, ...texts(JSON.parse(value))] : [value];
        for (const text of found) {
          expect(normaliseStored(text), `${name}.${column}`).toBe(text);
        }
      }
    }
  }
}

/** Creates a task and returns its ID. */
function create(fields: Partial<Extract<Operation, { kind: "task.create" }>> = {}): Id<"t"> {
  const id = fields.id ?? newId("t");
  expectStatus(
    submit([{ kind: "task.create", title: "Fix the export", ...fields, id }]),
    "applied",
  );
  return id;
}

describe("[A1.5.write.coalesce] one before-value and one after-value per field per commit", () => {
  test("a request that patches one field twice records one before and one after", () => {
    const id = create({ summary: "First" });
    const createdSeq = task(id)["created_seq"];
    const result = submit([
      { kind: "task.patch", task: id, set: { summary: "Second" } },
      { kind: "task.patch", task: id, set: { summary: "Third" } },
    ]);
    expectStatus(result, "applied");
    const rows = changesAt(result.seq);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: "tasks",
      entity_id: id,
      task_id: id,
      action: "set",
      field: "summary",
      before: '"First"',
      after: '"Third"',
      before_ver: createdSeq,
      before_prov: createdSeq,
      after_prov: result.seq,
      op: 0,
    });
    expect(JSON.parse(String(task(id)["fv"]))).toEqual({ summary: result.seq });
    expect(result.results.map((r) => r.status)).toEqual(["updated", "updated"]);
  });

  test("a multi-column field written twice is one change of the whole field", () => {
    const id = create();
    const result = submit([
      { kind: "task.patch", task: id, set: { due: { date: "2026-11-20" } } },
      {
        kind: "task.patch",
        task: id,
        set: { due: { at: Date.UTC(2026, 10, 21, 9), tz: "Europe/Amsterdam" } },
      },
    ]);
    expectStatus(result, "applied");
    const rows = changesAt(result.seq);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.["before"]))).toEqual({
      due_date: null,
      due_at: null,
      due_tz: null,
    });
    expect(JSON.parse(String(rows[0]?.["after"]))).toEqual({
      due_date: null,
      due_at: Date.UTC(2026, 10, 21, 9),
      due_tz: "Europe/Amsterdam",
    });
  });

  test("a field that ends where it started gets no row and keeps its versions", () => {
    const id = create({ summary: "Stay" });
    const before = task(id);
    const seq = lastSeq();
    const back = submit([
      { kind: "task.patch", task: id, set: { summary: "Away" } },
      { kind: "task.patch", task: id, set: { summary: "Stay" } },
    ]);
    expectStatus(back, "unchanged");
    expect(back.seq).toBe(seq);
    expect(back.commit).toBeUndefined();
    expect(back.results.map((r) => r.status)).toEqual(["unchanged", "unchanged"]);
    expect(lastSeq()).toBe(seq);
    expect(task(id)).toEqual(before);
    // With another field that does change, only that field gets a row.
    const mixed = submit([
      { kind: "task.patch", task: id, set: { summary: "Away" } },
      { kind: "task.patch", task: id, set: { priority: 2 } },
      { kind: "task.patch", task: id, set: { summary: "Stay" } },
    ]);
    expectStatus(mixed, "applied");
    expect(changesAt(mixed.seq).map((c) => c["field"])).toEqual(["priority"]);
    expect(JSON.parse(String(task(id)["fv"]))).toEqual({ priority: mixed.seq });
    expect(mixed.results.map((r) => r.status)).toEqual(["unchanged", "updated", "unchanged"]);
  });

  test("complete then reopen without an outcome leaves the task as it was", () => {
    const id = create();
    const result = submit([
      { kind: "task.complete", task: id },
      { kind: "task.reopen", task: id },
    ]);
    expectStatus(result, "unchanged");
    expect(task(id)["lifecycle"]).toBe("active");
  });

  test("sets on a row the request created fold into its create row", () => {
    const id = newId("t");
    const result = submit(
      [
        { kind: "task.create", id, title: "Plant bulbs" },
        { kind: "task.patch", task: id, set: { summary: "Before the frost", priority: 1 } },
        { kind: "task.move", task: id, project: "portal" },
        { kind: "task.complete", task: id, outcome: "Planted" },
      ],
      { base: null },
    );
    expectStatus(result, "applied");
    const rows = changesAt(result.seq);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "create", field: null, before: null, op: 0 });
    const after = JSON.parse(String(rows[0]?.["after"])) as Row;
    expect(after).toMatchObject({
      id,
      summary: "Before the frost",
      priority: 1,
      project_id: fx.project,
      area_id: fx.areas.lumen,
      lifecycle: "completed",
      wrap_state: "wrapped",
      outcome: "Planted",
    });
    // The derived columns follow from the change's seq and are not in the row.
    for (const derived of ["created_seq", "version", "touched", "fv", "fp"]) {
      expect(after).not.toHaveProperty(derived);
    }
    expect(task(id)).toMatchObject({ created_seq: result.seq, version: result.seq, fv: "{}" });
    expect(result.results.map((r) => r.status)).toEqual([
      "created",
      "updated",
      "updated",
      "updated",
    ]);
  });
});

describe("[A1.5.write.read-your-writes] an operation never fails against an earlier write of its own request", () => {
  test("a field an earlier operation wrote is no conflict for a later one with the same base", () => {
    const id = create();
    const base = fx.base();
    const result = submit(
      [
        { kind: "task.patch", task: id, set: { summary: "One" } },
        { kind: "task.patch", task: id, set: { summary: "Two", priority: 1 } },
        { kind: "task.patch", task: id, set: { summary: "Three" } },
      ],
      { base, actor: "codex" },
    );
    expectStatus(result, "applied");
  });

  test("complete, reopen and complete again: each sees the one before", () => {
    const id = create();
    const result = submit([
      { kind: "task.complete", task: id },
      { kind: "task.reopen", task: id, reason: "Not done yet" },
      { kind: "task.complete", task: id, outcome: "Done after all" },
    ]);
    expectStatus(result, "applied");
    expect(task(id)).toMatchObject({
      lifecycle: "completed",
      wrap_state: "wrapped",
      outcome: "Done after all",
    });
  });

  test("a move into a group, then a move next to a sibling that the request put there", () => {
    const id = create();
    const sibling = newId("t");
    const result = submit([
      { kind: "task.move", task: id, area: "home" },
      { kind: "task.create", id: sibling, title: "Plant bulbs", area: "home" },
      { kind: "task.move", task: id, after: sibling },
    ]);
    expectStatus(result, "applied");
    expect(task(id)["area_id"]).toBe(fx.areas.home);
    expect(String(task(sibling)["position"]) < String(task(id)["position"])).toBe(true);
  });

  test("operations on a task the request creates need no base", () => {
    const id = newId("t");
    const result = submit(
      [
        { kind: "task.create", id, title: "Book the dentist" },
        { kind: "task.patch", task: id, set: { summary: "Call before noon" } },
        { kind: "task.complete", task: id },
        { kind: "task.reopen", task: id },
        { kind: "task.move", task: id, area: "lumen" },
      ],
      { base: null },
    );
    expectStatus(result, "applied");
  });

  test("any sequence of valid operations on one task, with one base, applies or changes nothing", () => {
    const id = create();
    type Step = "summary" | "priority" | "status" | "move" | "flip" | "same";
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Step>("summary", "priority", "status", "move", "flip", "same"), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.nat(),
        (steps, n) => {
          let active = task(id)["lifecycle"] === "active";
          const ops: Operation[] = steps.map((s, i): Operation => {
            switch (s) {
              case "summary":
                return {
                  kind: "task.patch",
                  task: id,
                  set: { summary: `Step ${String((n + i) % 3)}` },
                };
              case "priority":
                return { kind: "task.patch", task: id, set: { priority: ((n + i) % 4) + 1 } };
              case "status":
                return {
                  kind: "task.patch",
                  task: id,
                  set: { status: i % 2 === 0 ? "open" : "waiting" },
                };
              case "move":
                return {
                  kind: "task.move",
                  task: id,
                  area: [null, "lumen", "home"][(n + i) % 3] ?? null,
                };
              case "same":
                return { kind: "task.patch", task: id, unset: ["effort"] };
              case "flip":
                active = !active;
                return active
                  ? { kind: "task.reopen", task: id }
                  : {
                      kind: "task.complete",
                      task: id,
                      ...(i % 2 === 0 ? { outcome: "Done" } : {}),
                    };
            }
          });
          const result = submit(ops, { actor: "claude" });
          expect(["applied", "unchanged"], JSON.stringify(result.error)).toContain(result.status);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("[A1.5.write.operations] the five task operations, their checks and their history", () => {
  test("the writer's operations are the registry's, with the same base rule", () => {
    // packages/contracts holds the operation registry (A3 3.2).
    // The inserts need no base; a revival's link version and an existing place's base are
    // conditional, which the registry leaves to the handler (A1 3.6).
    const baseFree = new Set([
      "task.create",
      "task.context_append",
      "note.add",
      "log.add",
      "source.add",
      "place.set",
      "place.clear",
    ]);
    for (const kind of OPERATION_KINDS) {
      if (kind.startsWith("launch.")) {
        // A4's family: the user's alone (R7), and a compare-and-set on the state, not a base.
        expect(opSpec(kind), kind).toMatchObject({ class: "user", base: false, r7: true });
        continue;
      }
      if (kind === "undo" || kind === "redo") {
        // The user's alone (A3 3.2.3), and guarded by provenance, not a base (A1 3.10.1).
        expect(opSpec(kind), kind).toMatchObject({ class: "user", base: false });
        expect(opSpec(kind)).not.toHaveProperty("r7");
        continue;
      }
      expect(opSpec(kind), kind).toMatchObject({ class: "agent", base: !baseFree.has(kind) });
    }
    expect(opSpec("machine.register")).toMatchObject({ class: "system" });
  });

  test("the machine registers once, on the space's first open, as a system commit", () => {
    const commit = fx.reader.prepare("SELECT * FROM commits WHERE seq = 1").get() ?? {};
    expect(commit).toMatchObject({
      actor_kind: "system",
      origin: "system",
      scope_id: "system",
      kind: "ops",
      machine_id: MACHINE.id,
      undo_status: null,
    });
    expect(JSON.parse(String(commit["ops"]))).toEqual([
      {
        v: 1,
        op: "machine.register",
        target: MACHINE.id,
        input: { name: MACHINE.name, os: MACHINE.os },
      },
    ]);
    expect(
      fx.reader.prepare("SELECT id, name, os, created_seq, version FROM machines").all(),
    ).toEqual([{ id: MACHINE.id, name: MACHINE.name, os: MACHINE.os, created_seq: 1, version: 1 }]);
    expect(changesAt(1)).toMatchObject([
      { entity: "machines", entity_id: MACHINE.id, action: "create" },
    ]);
    fx.reopen();
    expect(lastSeq()).toBe(1);
  });

  test("a new task: the next reference, the end of its group, a create row, the commit and the outbox", () => {
    const a = newId("t");
    const b = newId("t");
    const result = submit(
      [
        { kind: "task.create", id: a, title: "Fix the export", inbox: true, priority: 2 },
        {
          kind: "task.create",
          id: b,
          title: "Review the export",
          effort: "S",
          waiting_on: "Tomas",
        },
      ],
      { base: null, actor: "codex" },
    );
    expectStatus(result, "applied");
    expect(result.results).toEqual([
      { i: 0, status: "created", id: a, ref: "M-1", version: result.seq },
      { i: 1, status: "created", id: b, ref: "M-2", version: result.seq },
    ]);
    expect(result.as_of).toMatch(/^1\.2\.[0-9a-hjkmnp-tv-z]{8}$/);
    expect(task(a)).toMatchObject({
      ref: 1,
      position: "a0",
      inbox: 1,
      priority: 2,
      status: "open",
      lifecycle: "active",
    });
    expect(task(b)).toMatchObject({ ref: 2, position: "a1", effort: "S", waiting_on: "Tomas" });
    const commit =
      fx.reader.prepare("SELECT * FROM commits WHERE seq = $seq").get({ seq: result.seq }) ?? {};
    expect(commit).toMatchObject({
      id: result.commit,
      epoch: 1,
      actor_kind: "agent",
      principal_id: fx.codex.principal_id,
      author_id: fx.codex.principal_id,
      scope_id: "grant:codex",
      origin: "mcp",
      kind: "ops",
      affected: 0,
      undo_status: null,
    });
    expect(JSON.parse(String(commit["ops"]))).toEqual([
      {
        v: 1,
        op: "task.create",
        target: a,
        input: { title: "Fix the export", inbox: true, priority: 2 },
      },
      {
        v: 1,
        op: "task.create",
        target: b,
        input: { title: "Review the export", effort: "S", waiting_on: "Tomas" },
      },
    ]);
    expect(changesAt(result.seq).map((c) => [c["action"], c["entity_id"]])).toEqual([
      ["create", a],
      ["create", b],
    ]);
    expect(fx.reader.prepare("SELECT key, first_seq, seq FROM outbox ORDER BY key").all()).toEqual(
      [
        { key: "*", first_seq: result.seq, seq: result.seq },
        { key: a, first_seq: result.seq, seq: result.seq },
        { key: b, first_seq: result.seq, seq: result.seq },
      ].sort((x, y) => (x.key < y.key ? -1 : 1)),
    );
    // A later commit moves the outbox row on and keeps where its backlog starts (A1 3.7).
    const patch = submit([{ kind: "task.patch", task: a, set: { summary: "Next" } }]);
    expect(one("SELECT first_seq FROM outbox WHERE key = $k", { k: a })).toBe(result.seq);
    expect(one("SELECT seq FROM outbox WHERE key = $k", { k: a })).toBe(patch.seq);
  });

  test("a task is named by ID, by reference, by an old prefix or by a legacy alias", () => {
    create({ id: fx.legacy.task });
    for (const name of [fx.legacy.task, "M-1", `${fx.legacy.prefix}-1`, fx.legacy.alias]) {
      expectStatus(submit([{ kind: "task.patch", task: name, set: { summary: name } }]), "applied");
      expect(task(fx.legacy.task)["summary"]).toBe(name);
    }
    const refused = (name: string): string | undefined =>
      submit([{ kind: "task.patch", task: name, set: { summary: "x" } }]).error?.code;
    expect(refused("Q-1")).toBe("SPACE_MISMATCH");
    expect(refused("M-99")).toBe("NOT_FOUND");
    expect(refused(newId("t"))).toBe("NOT_FOUND");
    expect(refused("t-00000000")).toBe("NOT_FOUND");
  });

  test("groups by ID, slug or old slug; the area follows the project; a move keeps or leaves the area", () => {
    const id = create({ project: "portal" });
    expect(task(id)).toMatchObject({ project_id: fx.project, area_id: fx.areas.lumen });
    expectStatus(submit([{ kind: "task.move", task: id, area: "home" }]), "applied");
    expect(task(id)).toMatchObject({ project_id: null, area_id: fx.areas.home });
    expectStatus(
      submit([{ kind: "task.move", task: id, project: fx.legacy.slug, area: "home" }]),
      "applied",
    );
    expect(task(id)).toMatchObject({ project_id: fx.project, area_id: fx.areas.lumen });
    expectStatus(submit([{ kind: "task.move", task: id, project: null }]), "applied");
    expect(task(id)).toMatchObject({ project_id: null, area_id: fx.areas.lumen });
    expectStatus(submit([{ kind: "task.move", task: id, area: fx.areas.lumen }]), "unchanged");
    expectStatus(submit([{ kind: "task.move", task: id, area: null }]), "applied");
    expect(task(id)).toMatchObject({ project_id: null, area_id: null });
    const moved = submit([{ kind: "task.move", task: id, area: "nowhere" }]);
    expect(moved.error).toMatchObject({ code: "NOT_FOUND", op: 0, field: "area" });
    const commit = fx.reader
      .prepare("SELECT affected FROM commits ORDER BY seq DESC LIMIT 1")
      .get();
    expect(commit).toEqual({ affected: 1 });
  });

  test("after and before a sibling, in the sibling's group", () => {
    const [a, b, c] = [create(), create(), create()];
    const order = (): string[] =>
      fx.reader
        .prepare(
          "SELECT id FROM tasks WHERE area_id IS NULL AND project_id IS NULL ORDER BY position",
        )
        .all<{ id: string }>()
        .map((r) => r.id);
    expect(order()).toEqual([a, b, c]);
    expectStatus(submit([{ kind: "task.move", task: c, before: a }]), "applied");
    expect(order()).toEqual([c, a, b]);
    expectStatus(submit([{ kind: "task.move", task: a, after: b }]), "applied");
    expect(order()).toEqual([c, b, a]);
    // Already there: nothing changes.
    expectStatus(submit([{ kind: "task.move", task: a, after: b }]), "unchanged");
    expectStatus(submit([{ kind: "task.move", task: c, before: b }]), "unchanged");
    // Only a sibling: the task joins the sibling's group.
    const d = create({ area: "home" });
    expectStatus(submit([{ kind: "task.move", task: a, before: d }]), "applied");
    expect(task(a)["area_id"]).toBe(fx.areas.home);
    expect(submit([{ kind: "task.move", task: b, area: "lumen", after: d }]).error).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "after",
    });
    expect(submit([{ kind: "task.move", task: b, after: b }]).error).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "after",
    });
    // A new task next to a sibling.
    const e = create({ before: c });
    expect(order()).toEqual([e, c, b]);
  });

  test("the base: required, per field, and only from this epoch and incarnation", () => {
    const id = create({ summary: "Start" });
    const stale = fx.base();
    expectStatus(submit([{ kind: "task.patch", task: id, set: { summary: "Mira's" } }]), "applied");
    // A field nobody changed after the base still applies.
    expectStatus(
      submit([{ kind: "task.patch", task: id, set: { priority: 1 } }], {
        base: stale,
        actor: "codex",
      }),
      "applied",
    );
    // A field changed after the base conflicts, and every conflict of the request comes back.
    const conflict = submit(
      [
        { kind: "task.patch", task: id, set: { summary: "Codex's" } },
        { kind: "task.patch", task: id, set: { priority: 2, status: "waiting" } },
      ],
      { base: stale, actor: "claude" },
    );
    expectStatus(conflict, "conflict");
    expect(conflict.error?.code).toBe("VERSION_CONFLICT");
    expect(conflict.seq).toBe(lastSeq());
    expect(conflict.conflicts).toEqual([
      {
        op: 0,
        entity: "tasks",
        id,
        task: id,
        ref: "M-1",
        field: "summary",
        value: "Mira's",
        version: Number(lastSeq()) - 1,
        by: { actor: fx.human.principal_id, kind: "human", label: "Mira Okafor", origin: "cli" },
        at: expect.any(Number) as number,
      },
      expect.objectContaining({
        op: 1,
        field: "priority",
        by: { actor: fx.codex.principal_id, kind: "agent", label: "Codex · work", origin: "mcp" },
      }),
    ]);
    expect(task(id)["summary"]).toBe("Mira's");
    // No base for a change to an existing task.
    expect(submit([{ kind: "task.complete", task: id }], { base: null }).error).toMatchObject({
      code: "BASE_REQUIRED",
      op: 0,
    });
    // Another epoch or incarnation, a future seq, or text that is no as_of.
    const [epoch, seq, tag] = fx.base().split(".") as [string, string, string];
    const refuse = (base: string | object): string | undefined =>
      fx.writer.submit(
        fx.request(fx.human, [{ kind: "task.patch", task: id, set: { summary: "x" } }], {
          base: base as string,
        }),
      ).error?.code;
    expect(refuse(`2.${seq}.${tag}`)).toBe("EPOCH_CHANGED");
    expect(refuse(`${epoch}.${seq}.00000000`)).toBe("EPOCH_CHANGED");
    expect(refuse({ epoch: 1, seq: Number(seq), incarnation: newId("ai") })).toBe("EPOCH_CHANGED");
    expect(refuse(`${epoch}.${String(Number(seq) + 1)}.${tag}`)).toBe("BASE_FROM_FUTURE");
    expect(refuse("yesterday")).toBe("VALIDATION_FAILED");
    const { incarnation } = fx.writer.asOf();
    expectStatus(
      fx.writer.submit(
        fx.request(fx.human, [{ kind: "task.patch", task: id, set: { summary: "Full" } }], {
          base: { epoch: 1, seq: Number(seq), incarnation },
        }),
      ),
      "applied",
    );
  });

  test("complete and reopen follow the lifecycle", () => {
    const id = create();
    expectStatus(submit([{ kind: "task.complete", task: id }]), "applied");
    expect(task(id)).toMatchObject({
      lifecycle: "completed",
      wrap_state: "pending",
      completed_by: fx.human.principal_id,
      outcome: null,
    });
    expect(submit([{ kind: "task.complete", task: id }]).error).toMatchObject({
      code: "INVALID_TRANSITION",
      op: 0,
    });
    expectStatus(submit([{ kind: "task.reopen", task: id }]), "applied");
    expect(task(id)).toMatchObject({
      lifecycle: "active",
      wrap_state: null,
      completed_at: null,
      completed_by: null,
    });
    expect(submit([{ kind: "task.reopen", task: id }]).error?.code).toBe("INVALID_TRANSITION");
    expectStatus(
      submit([{ kind: "task.complete", task: id, outcome: "Shipped in 2.3." }], { actor: "codex" }),
      "applied",
    );
    expect(task(id)).toMatchObject({
      wrap_state: "wrapped",
      outcome: "Shipped in 2.3.",
      wrapped_by: fx.codex.principal_id,
    });
    // Reopening keeps the outcome as the previous result (A1 3.11.3).
    expectStatus(submit([{ kind: "task.reopen", task: id }]), "applied");
    expect(task(id)).toMatchObject({
      lifecycle: "active",
      wrap_state: null,
      outcome: "Shipped in 2.3.",
    });
    // An invalid transition undoes the request's earlier writes.
    const before = task(id);
    const failed = submit([
      { kind: "task.patch", task: id, set: { summary: "Lost with the request" } },
      { kind: "task.reopen", task: id },
    ]);
    expect(failed.error).toMatchObject({ code: "INVALID_TRANSITION", op: 1 });
    expect(task(id)).toEqual(before);
  });

  test("a request marked active changes active tasks only, and its refusal is decided", () => {
    const id = create();
    const patch = (extra: { active?: boolean } = {}) =>
      fx.writer.submit(
        fx.request(fx.human, [{ kind: "task.patch", task: id, set: { summary: "Next" } }], {
          base: fx.base(),
          ...extra,
        }),
      );
    expectStatus(submit([{ kind: "task.complete", task: id }]), "applied");
    // Without the mark, A1 lets a completed task's fields change; with it, the writer refuses.
    const before = task(id);
    const refused = patch({ active: true });
    expect(refused).toMatchObject({
      status: "rejected",
      error: { code: "TASK_NOT_ACTIVE", op: 0, field: "task" },
    });
    expect(task(id)).toEqual(before);
    // Decided in the request's transaction: the refusal has a receipt.
    const receipts = one("SELECT count(*) FROM receipts WHERE status = 'rejected'");
    expect(receipts).toBeGreaterThan(0);
    expectStatus(patch(), "applied");
    // A task the request creates is active.
    expectStatus(
      fx.writer.submit(
        fx.request(fx.human, [{ kind: "task.create", id: newId("t"), title: "Fixture" }], {
          active: true,
        }),
      ),
      "applied",
    );
    // A launch changes no task, so a launch request takes no mark: refused before the
    // transaction, nothing stored (A1 3.6's launch request rule).
    const receiptsBefore = one("SELECT count(*) FROM receipts");
    const launch = fx.writer.submit(
      fx.request(
        fx.human,
        [
          {
            kind: "launch.create",
            task: id,
            instance: "codex-work",
            route: "terminal",
            place: null,
            task_version: 1,
            brief_hash: "a1b2c3d4".repeat(8),
          },
        ],
        { active: true },
      ),
    );
    expect(launch).toMatchObject({
      status: "rejected",
      error: { code: "VALIDATION_FAILED", field: "active" },
    });
    expect(one("SELECT count(*) FROM receipts")).toBe(receiptsBefore);
    expect(one("SELECT count(*) FROM launches")).toBe(0);
  });

  test("patch sets and clears every patchable field, with A1's defaults and checks", () => {
    const id = create();
    const set = {
      title: "Review the invoice export",
      summary: "Compare totals",
      context: "## Context\n\nTwo exports.",
      status: "review",
      inbox: true,
      priority: 1,
      effort: "L",
      planned_for: "2026-11-13",
      focus: "2026-11-13",
      owner: "Mira",
      waiting_on: "Aiko",
      source_at: Date.UTC(2026, 10, 10),
      reviewed_at: Date.UTC(2026, 10, 12),
      due: { date: "2026-11-20" },
    };
    expectStatus(submit([{ kind: "task.patch", task: id, set }]), "applied");
    expect(task(id)).toMatchObject({
      title: set.title,
      focus_on: "2026-11-13",
      inbox: 1,
      due_date: "2026-11-20",
    });
    const unset = [
      "summary",
      "context",
      "status",
      "inbox",
      "priority",
      "effort",
      "planned_for",
      "focus",
      "owner",
      "waiting_on",
      "source_at",
      "reviewed_at",
      "due",
    ] as const;
    expectStatus(submit([{ kind: "task.patch", task: id, unset: [...unset] }]), "applied");
    expect(task(id)).toMatchObject({
      summary: "",
      context: "",
      status: "open",
      inbox: 0,
      priority: 4,
      effort: null,
      planned_for: null,
      focus_on: null,
      owner: null,
      waiting_on: null,
      source_at: null,
      reviewed_at: null,
      due_date: null,
    });
    // A1 3.7's normalisation: LF line endings, no NUL or other C0 controls, NFC.
    expectStatus(
      submit([{ kind: "task.patch", task: id, set: { context: "a\r\nb\u0000c\u0007é" } }]),
      "applied",
    );
    expect(task(id)["context"]).toBe("a\nbcé");
    // A lone surrogate cannot be stored as UTF-8: it becomes U+FFFD before the limits, in the row
    // and in the history alike.
    const result = submit([
      { kind: "task.patch", task: id, set: { title: "Fixture\ud800", summary: "\udc00x" } },
    ]);
    expectStatus(result, "applied");
    expect(task(id)).toMatchObject({ title: "Fixture�", summary: "�x" });
    const ops = one("SELECT ops FROM commits WHERE seq = $s", { s: result.seq });
    expect(JSON.parse(String(ops))).toMatchObject([
      { input: { set: { title: "Fixture�", summary: "�x" } } },
    ]);
    const after = fx.reader
      .prepare("SELECT field, after FROM changes WHERE seq = $s ORDER BY n")
      .all<{ field: string; after: string }>({ s: result.seq });
    expect(after.map((c) => [c.field, JSON.parse(c.after) as unknown])).toEqual([
      ["title", "Fixture�"],
      ["summary", "�x"],
    ]);
  });

  test("invalid input is refused before the transaction, naming the field and never the value", () => {
    const id = create();
    const SECRET = "SYNTHETIC_SECRET_TITLE";
    const seq = lastSeq();
    const code = (op: Record<string, unknown>): unknown => {
      const result = submit([op as unknown as Operation]);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      return [result.error?.code, result.error?.field];
    };
    expect(
      code({ kind: "task.patch", task: id, set: { title: `${SECRET}\nsecond line` } }),
    ).toEqual(["VALIDATION_FAILED", "ops[0].set.title"]);
    expect(
      code({ kind: "task.patch", task: id, set: { title: `${SECRET}${"x".repeat(300)}` } }),
    ).toEqual(["TOO_LARGE", "ops[0].set.title"]);
    expect(code({ kind: "task.patch", task: id, set: { context: "x".repeat(65_537) } })).toEqual([
      "TOO_LARGE",
      "ops[0].set.context",
    ]);
    expect(code({ kind: "task.patch", task: id, set: { title: "   " } })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].set.title",
    ]);
    expect(code({ kind: "task.patch", task: id, unset: ["title"] })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].unset",
    ]);
    expect(code({ kind: "task.patch", task: id, set: {} })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].set",
    ]);
    // An unknown key is input too: the problem names the object that holds it, never the key.
    expect(code({ kind: "task.patch", task: id, set: { colour: SECRET } })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].set",
    ]);
    expect(code({ kind: "task.patch", task: id, set: { [SECRET]: "x" } })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].set",
    ]);
    expect(code({ kind: "task.complete", task: id, [`${SECRET}\nline`]: 1 })).toEqual([
      "VALIDATION_FAILED",
      "ops[0]",
    ]);
    expect(
      code({ kind: "task.patch", task: id, set: { due: { date: "2026-12-01", [SECRET]: 1 } } }),
    ).toEqual(["VALIDATION_FAILED", "ops[0].set.due"]);
    expect(code({ kind: "task.patch", task: id, set: { priority: 5 } })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].set.priority",
    ]);
    expect(code({ kind: "task.patch", task: id, set: { status: "doing" } })).toEqual([
      "VALIDATION_FAILED",
      "status",
    ]);
    expect(code({ kind: "task.patch", task: id, set: { effort: "XL" } })).toEqual([
      "VALIDATION_FAILED",
      "effort",
    ]);
    expect(code({ kind: "task.patch", task: id, set: { planned_for: "2026-02-30" } })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].set.planned_for",
    ]);
    expect(code({ kind: "task.patch", task: id, set: { due: { at: 0, tz: "+01:00" } } })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].set.due.tz",
    ]);
    expect(
      code({ kind: "task.patch", task: id, set: { due: { at: 0, tz: "Mars/Olympus" } } }),
    ).toEqual(["VALIDATION_FAILED", "ops[0].set.due.tz"]);
    expect(code({ kind: "task.move", task: id })).toEqual(["VALIDATION_FAILED", "ops[0].project"]);
    expect(code({ kind: "task.move", task: id, after: id, before: id })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].before",
    ]);
    expect(code({ kind: "task.create", title: SECRET, id })).toEqual(["VALIDATION_FAILED", "id"]);
    expect(code({ kind: "task.delete", task: id })).toEqual(["VALIDATION_FAILED", "ops[0].kind"]);
    expect(lastSeq()).toBe(seq);
  });

  test("the request: its ID, size, space, actor and undo flag", () => {
    const id = create();
    const patch: Operation = { kind: "task.patch", task: id, set: { summary: "x" } };
    const base = fx.base();
    const seq = lastSeq();
    const error = (extra: Record<string, unknown>, actor = fx.human): unknown => {
      const result = fx.writer.submit({ ...fx.request(actor, [patch], { base }), ...extra });
      return [result.status, result.error?.code, result.error?.field];
    };
    expect(error({ request_id: "short" })).toEqual([
      "rejected",
      "REQUEST_ID_INVALID",
      "request_id",
    ]);
    expect(error({ ops: [] })).toEqual(["rejected", "VALIDATION_FAILED", "ops"]);
    expect(error({ ops: Array.from({ length: 51 }, () => patch) })).toEqual([
      "rejected",
      "TOO_LARGE",
      "ops",
    ]);
    expect(error({ space_id: newId("sp") })).toEqual(["rejected", "SPACE_MISMATCH", "space_id"]);
    expect(error({ colour: "red" })).toEqual(["rejected", "VALIDATION_FAILED", undefined]);
    expect(error({ actor: { ...fx.human, colour: "red" } })).toEqual([
      "rejected",
      "VALIDATION_FAILED",
      "actor",
    ]);
    expect(error({ actor: { ...fx.codex, actor_kind: "human" } })).toEqual([
      "rejected",
      "VALIDATION_FAILED",
      "actor.principal_id",
    ]);
    expect(error({ actor: { ...fx.codex, author_id: newId("ac") } })).toEqual([
      "rejected",
      "VALIDATION_FAILED",
      "actor.author_id",
    ]);
    expect(error({ undoable: true }, fx.codex)).toEqual([
      "rejected",
      "VALIDATION_FAILED",
      "undoable",
    ]);
    expect(
      error({
        ops: [
          { kind: "task.patch", task: id, set: { context: "x".repeat(60_000) } },
          ...Array.from({ length: 9 }, () => ({
            kind: "task.patch",
            task: id,
            set: { context: "y".repeat(60_000) },
          })),
        ],
      }),
    ).toEqual(["rejected", "TOO_LARGE", undefined]);
    expect(lastSeq()).toBe(seq);
    // A human's undoable action joins the undo stack; the same request ID cannot apply twice: the
    // same intent replays (receipts.test.ts), another one is refused.
    const request = fx.request(fx.human, [patch], { base, undoable: true });
    const applied = fx.writer.submit(request);
    expectStatus(applied, "applied");
    expect(one("SELECT undo_status FROM commits WHERE seq = $s", { s: applied.seq })).toBe("done");
    expect(fx.writer.submit({ ...request, base: fx.base() })).toEqual({
      ...applied,
      replayed: true,
    });
    expect(
      fx.writer.submit({ ...request, base: fx.base(), ops: [{ ...patch, set: { summary: "z" } }] })
        .error?.code,
    ).toBe("REQUEST_ID_REUSED");
    // The same ID in another writer scope is another request.
    expectStatus(
      fx.writer.submit({
        ...request,
        actor: fx.codex,
        undoable: false,
        base: fx.base(),
        ops: [{ ...patch, set: { summary: "y" } }],
      }),
      "applied",
    );
  });

  test("a human's new undoable action ends the redo of what that human undid", async () => {
    const id = create();
    const undoable = (summary: string): WriteResult =>
      fx.writer.submit(
        fx.request(fx.human, [{ kind: "task.patch", task: id, set: { summary } }], {
          base: fx.base(),
          undoable: true,
        }),
      );
    const first = undoable("First");
    expectStatus(first, "applied");
    // Undo arrives with M3, so the test marks the commit undone as it will.
    const raw = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
    raw.prepare("UPDATE commits SET undo_status = 'undone' WHERE seq = $s").run({ s: first.seq });
    raw.close();
    // An agent's write leaves the human's undo stack alone.
    expectStatus(
      submit([{ kind: "task.patch", task: id, set: { owner: "Aiko" } }], { actor: "codex" }),
      "applied",
    );
    expect(one("SELECT undo_status FROM commits WHERE seq = $s", { s: first.seq })).toBe("undone");
    expectStatus(undoable("Second"), "applied");
    expect(one("SELECT undo_status FROM commits WHERE seq = $s", { s: first.seq })).toBe("dead");
  });

  test("a writer on a machine that is not the authority registers nothing and writes nothing", () => {
    create();
    const seq = lastSeq();
    const other = fx.reopen({ machine: { id: newId("m"), name: "mira-laptop", os: "linux" } });
    expect(lastSeq()).toBe(seq);
    const result = other.submit(
      fx.request(fx.human, [{ kind: "task.create", title: "Elsewhere" }]),
    );
    expect(result.error).toMatchObject({ code: "SPACE_READ_ONLY" });
    expect(lastSeq()).toBe(seq);
    expect(one("SELECT count(*) FROM machines")).toBe(1);
  });

  test("every text the writer stores goes through one normalisation: rows, change rows and commits.ops agree", async () => {
    // Each text input of each operation, and of machine.register, gets text that A1 3.7's
    // normalisation changes: a lone surrogate, a NUL or BEL, a decomposed é, and CR LF where the
    // field takes more than one line.
    const line = (label: string): string => `${label} é\u0000\ud800`;
    const lines = (label: string): string => `${label}\r\né\u0007\udc00`;
    const normal = (text: string): string => normaliseStored(text);
    for (const text of [line("x"), lines("x")]) expect(normal(text)).not.toBe(text);
    const id = newId("t");
    const send = (ops: Operation[], reason: string): WriteResult =>
      fx.writer.submit(fx.request(fx.human, ops, { base: fx.base(), reason }));
    const inputs = {
      create: {
        title: line("title"),
        summary: line("summary"),
        context: lines("context"),
        owner: line("owner"),
        waiting_on: line("waiting"),
      },
      patch: {
        title: line("title 2"),
        summary: line("summary 2"),
        context: lines("context 2"),
        owner: line("owner 2"),
        waiting_on: line("waiting 2"),
      },
      outcome: lines("outcome"),
      reopen: lines("reopen"),
    };
    const seqs = [
      send([{ kind: "task.create", id, ...inputs.create }], line("reason 1")),
      send([{ kind: "task.patch", task: id, set: inputs.patch }], lines("reason 2")),
      send([{ kind: "task.complete", task: id, outcome: inputs.outcome }], line("reason 3")),
      send([{ kind: "task.reopen", task: id, reason: inputs.reopen }], line("reason 4")),
    ].map((result) => {
      expectStatus(result, "applied");
      return result.seq;
    });
    const commit = (seq: number | undefined): Row =>
      fx.reader
        .prepare("SELECT ops, reason FROM commits WHERE seq = $seq")
        .get({ seq: seq ?? 0 }) ?? {};
    const input = (seq: number | undefined): Record<string, unknown> =>
      (JSON.parse(String(commit(seq)["ops"])) as { input: Record<string, unknown> }[])[0]?.input ??
      {};
    // The values: the same normalised text in the row, the change row and commits.ops.
    expect(input(seqs[0])).toMatchObject(mapValues(inputs.create, normal));
    expect(input(seqs[1])).toMatchObject({ set: mapValues(inputs.patch, normal) });
    // A reopen keeps the outcome as the previous result (A1 3.11.3).
    expect(task(id)).toMatchObject({
      ...mapValues(inputs.patch, normal),
      outcome: normal(inputs.outcome),
    });
    const created = changesAt(seqs[0] ?? 0)[0];
    expect(JSON.parse(String(created?.["after"]))).toMatchObject(mapValues(inputs.create, normal));
    expect(input(seqs[2])).toMatchObject({ outcome: normal(inputs.outcome) });
    expect(input(seqs[3])).toMatchObject({ reason: normal(inputs.reopen) });
    expect(commit(seqs[1])["reason"]).toBe(normal(lines("reason 2")));
    // The text inputs of note.add, log.add, source.add and place.set (M1.05). A place's path takes
    // the decomposed é and the lone surrogate, but no NUL: a path with a control is refused, not
    // changed (A1 3.15; children.test.ts).
    const dir = "dir é\ud800";
    expect(normal(dir)).not.toBe(dir);
    const source = {
      kind: "email" as const,
      title: line("source title"),
      key: `mail:${line("key")}`,
      who: line("who"),
      ref: line("ref"),
      url: line("url"),
    };
    const children = send(
      [
        { kind: "note.add", task: id, body: lines("note") },
        { kind: "log.add", task: id, body: lines("log") },
        { kind: "source.add", task: id, source },
        {
          kind: "place.set",
          task: id,
          root: "work",
          path: dir,
          git_remote: line("remote"),
        },
      ],
      line("reason 5"),
    );
    expectStatus(children, "applied");
    const ops = JSON.parse(String(commit(children.seq)["ops"])) as { input: Row }[];
    expect(ops.map((op) => op.input)).toMatchObject([
      { body: normal(lines("note")) },
      { body: normal(lines("log")) },
      { source: { ...mapValues(source, normal), key: `mail:${normal(line("key"))}` } },
      { path: normal(dir), git_remote: normal(line("remote")) },
    ]);
    expect(one("SELECT body FROM notes")).toBe(normal(lines("note")));
    expect(one("SELECT body FROM log_entries")).toBe(normal(lines("log")));
    expect(fx.reader.prepare("SELECT title, source_key, who, ref, url FROM sources").get()).toEqual(
      {
        title: normal(source.title),
        source_key: `mail:${normal(line("key"))}`,
        who: normal(source.who),
        ref: normal(source.ref),
        url: normal(source.url),
      },
    );
    expect(one("SELECT rel_path FROM places")).toBe(normal(dir));
    // machine.register, on another space's first open. The reviewer's case first: a lone
    // surrogate alone, which the machine check used to let through unchanged.
    const checked = await checkedDriver();
    for (const name of ["Host\ud800", line("Mira's desk")]) {
      const other = await createFixtureSpace(temp.make());
      const machine = { id: TEST_MACHINE, name, os: "linux" as const };
      SpaceWriter.open(openSpace(checked, other.folder, { role: "writer" }), { machine }).close();
      const reader = openSpace(checked, other.folder, { role: "reader" }).conn;
      try {
        const stored = reader.prepare("SELECT name FROM machines").get()?.["name"];
        expect(stored).toBe(normal(name));
        const ops = String(reader.prepare("SELECT ops FROM commits").get()?.["ops"]);
        expect(JSON.parse(ops)).toMatchObject([
          { op: "machine.register", input: { name: normal(name) } },
        ]);
        const after = String(reader.prepare("SELECT after FROM changes").get()?.["after"]);
        expect(JSON.parse(after)).toMatchObject({ name: normal(name) });
        expectAllNormal(reader);
      } finally {
        reader.close();
      }
    }
    // And whatever else either space holds: every text, in every row and in the JSON of
    // commits.ops and the change rows, is its own normalisation.
    expectAllNormal(fx.reader);
  });

  test("a commit's time never goes back when the clock does", () => {
    let now = Date.UTC(2026, 10, 12, 9);
    fx.reopen({ now: () => (now -= 60_000) });
    create();
    create();
    const times = fx.reader
      .prepare("SELECT at FROM commits ORDER BY seq")
      .all<{ at: number }>()
      .map((r) => r.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
