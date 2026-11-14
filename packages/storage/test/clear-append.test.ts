// place.clear and task.context_append through the write path (A1 3.5, 3.6, 3.15; A7 3.9 M2.03):
// a clear tombstones the owner's place on the request's machine with its change row and needs a
// base like a change of the place; an append needs none, lands twice when two agents append, and
// still moves the context's version, so a stale replace conflicts. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import type { Operation, WriteResult } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("clear-append");
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
const row = (sql: string, params = {}): Row => fx.reader.prepare(sql).get(params) ?? {};
const changesAt = (seq: number): Row[] =>
  fx.reader.prepare("SELECT * FROM changes WHERE seq = $seq ORDER BY n").all({ seq });

function submit(
  ops: Operation[],
  extra: { base?: string | null; actor?: "human" | "codex" | "claude" } = {},
): WriteResult {
  const actor = fx[extra.actor ?? "human"];
  const base = extra.base === undefined ? fx.base() : extra.base;
  return fx.writer.submit(fx.request(actor, ops, base === null ? {} : { base }));
}

function create(title = "Fix the export", context?: string): Id<"t"> {
  const id = newId("t");
  expectStatus(
    submit([{ kind: "task.create", id, title, ...(context === undefined ? {} : { context }) }]),
    "applied",
  );
  return id;
}

describe("[A1.5.write.clear-append] place.clear", () => {
  test("tombstones the owner's place on this machine, with a base; nothing bound is unchanged", () => {
    const task = create();
    const bound = submit([{ kind: "place.set", task, root: "work", path: "lumen/portal" }], {
      base: null,
    });
    expectStatus(bound, "applied");
    const place = bound.results[0]?.id ?? "";
    const stale = fx.base();
    // Clearing an existing place changes it: it needs a base, as binding another folder does.
    expect(submit([{ kind: "place.clear", task }], { base: null }).error).toMatchObject({
      code: "BASE_REQUIRED",
      op: 0,
    });
    // A place bound after the caller's read is a conflict, never cleared unseen.
    const before = fx.base();
    expectStatus(
      submit([{ kind: "place.set", task, root: "work", path: "lumen/api" }], { base: before }),
      "applied",
    );
    const conflict = submit([{ kind: "place.clear", task: "M-1" }], { base: stale });
    expectStatus(conflict, "conflict");
    expect(conflict.conflicts).toMatchObject([
      { entity: "places", id: place, field: "folder", task, ref: "M-1" },
    ]);

    const cleared = submit([{ kind: "place.clear", task: "M-1" }]);
    expectStatus(cleared, "applied");
    expect(cleared.results[0]).toEqual({
      i: 0,
      status: "updated",
      id: place,
      task,
      ref: "M-1",
      version: cleared.seq,
    });
    expect(
      row("SELECT deleted_at, version, rel_path FROM places WHERE id = $place", { place }),
    ).toMatchObject({ version: cleared.seq, rel_path: "lumen/api" });
    expect(one("SELECT deleted_at FROM places WHERE id = $place", { place })).not.toBeNull();
    expect(changesAt(cleared.seq)).toMatchObject([
      {
        entity: "places",
        entity_id: place,
        task_id: task,
        action: "set",
        field: "deleted",
        before: "null",
        op: 0,
      },
    ]);
    // The task is touched by its place's change and keeps its own version (A1 3.5).
    expect(row("SELECT touched FROM tasks WHERE id = $task", { task })).toEqual({
      touched: cleared.seq,
    });

    // Nothing is bound now: a clear changes nothing and needs no base.
    const again = submit([{ kind: "place.clear", task }], { base: null });
    expectStatus(again, "unchanged");
    expect(again.results[0]).toMatchObject({ status: "unchanged", id: task, ref: "M-1" });
    // A new bind afterwards creates a new place: the tombstone keeps the old one's history.
    const rebound = submit([{ kind: "place.set", task, root: "work", path: "lumen" }], {
      base: null,
    });
    expectStatus(rebound, "applied");
    expect(rebound.results[0]?.status).toBe("created");
    expect(rebound.results[0]?.id).not.toBe(place);
  });

  test("a group's place, one owner, this machine's record, and never bound and cleared at once", () => {
    const task = create();
    const area = submit([{ kind: "place.set", area: "home", root: "oss", path: "garden" }], {
      base: null,
    });
    expectStatus(area, "applied");
    const cleared = submit([{ kind: "place.clear", area: "home" }]);
    expectStatus(cleared, "applied");
    expect(cleared.results[0]?.task).toBeUndefined();
    expect(changesAt(cleared.seq)).toMatchObject([{ entity: "places", task_id: null }]);
    // A project without a place: unchanged, with the project's ID.
    const project = submit([{ kind: "place.clear", project: "portal" }], { base: null });
    expectStatus(project, "unchanged");
    expect(project.results[0]).toMatchObject({ id: fx.project, version: 0 });

    const error = (ops: Record<string, unknown>[], actor = fx.human): unknown[] => {
      const result = fx.writer.submit({ ...fx.request(actor, []), ops, base: fx.base() });
      return [result.error?.code, result.error?.field];
    };
    expect(error([{ kind: "place.clear" }])).toEqual(["VALIDATION_FAILED", "ops[0].task"]);
    expect(error([{ kind: "place.clear", task, area: "home" }])).toEqual([
      "VALIDATION_FAILED",
      "ops[0].task",
    ]);
    expect(error([{ kind: "place.clear", task, root: "work" }])).toEqual([
      "VALIDATION_FAILED",
      "ops[0]",
    ]);
    expect(error([{ kind: "place.clear", project: "nowhere" }])).toEqual(["NOT_FOUND", "project"]);
    expect(error([{ kind: "place.clear", task }], { ...fx.human, machine_id: newId("m") })).toEqual(
      ["VALIDATION_FAILED", "actor.machine_id"],
    );
    for (const ops of [
      [
        { kind: "place.set", task, root: "work", path: "a" },
        { kind: "place.clear", task },
      ],
      [
        { kind: "place.clear", task },
        { kind: "place.set", task, root: "work", path: "a" },
      ],
    ]) {
      expect(error(ops)[0]).toBe("VALIDATION_FAILED");
    }
    // Two clears of one place in a request: one change.
    expectStatus(
      submit([{ kind: "place.set", task, root: "work", path: "b" }], { base: null }),
      "applied",
    );
    const twice = submit([
      { kind: "place.clear", task },
      { kind: "place.clear", task },
    ]);
    expectStatus(twice, "applied");
    expect(changesAt(twice.seq)).toHaveLength(1);
    expect(twice.results.map((r) => r.status)).toEqual(["updated", "unchanged"]);

    // A place that exists already: binding it to another folder and clearing it in one request is
    // refused too, in either order, and nothing is written.
    expectStatus(
      submit([{ kind: "place.set", task, root: "work", path: "c" }], { base: null }),
      "applied",
    );
    const seq = Number(one("SELECT max(seq) FROM commits"));
    for (const ops of [
      [
        { kind: "place.set", task, root: "work", path: "d" },
        { kind: "place.clear", task },
      ],
      [
        { kind: "place.clear", task },
        { kind: "place.set", task, root: "work", path: "d" },
      ],
    ]) {
      expect(error(ops)).toEqual(["VALIDATION_FAILED", "task"]);
    }
    expect(one("SELECT max(seq) FROM commits")).toBe(seq);
    expect(
      row("SELECT rel_path, deleted_at FROM places WHERE owner_id = $task AND deleted_at IS NULL", {
        task,
      }),
    ).toEqual({ rel_path: "c", deleted_at: null });
  });
});

describe("[A1.5.write.clear-append] task.context_append", () => {
  test("appends after a blank line without a base; two appends both land; a stale replace conflicts", () => {
    const task = create("Fix the export", "First finding.");
    const empty = create("Empty context");
    const read = fx.base();
    const a = submit([{ kind: "task.context_append", task, text: "Second finding." }], {
      base: null,
      actor: "codex",
    });
    expectStatus(a, "applied");
    const b = submit([{ kind: "task.context_append", task: "M-1", text: "Third finding." }], {
      base: read,
      actor: "claude",
    });
    expectStatus(b, "applied");
    expect(one("SELECT context FROM tasks WHERE id = $task", { task })).toBe(
      "First finding.\n\nSecond finding.\n\nThird finding.",
    );
    expect(changesAt(b.seq)).toMatchObject([
      {
        entity: "tasks",
        field: "context",
        before: JSON.stringify("First finding.\n\nSecond finding."),
        after: JSON.stringify("First finding.\n\nSecond finding.\n\nThird finding."),
        before_ver: a.seq,
      },
    ]);
    expect(b.results[0]).toMatchObject({ status: "updated", id: task, ref: "M-1" });
    // The field's version moved: a replace from the read before the appends conflicts.
    const replace = submit([{ kind: "task.patch", task, set: { context: "Replaced." } }], {
      base: read,
    });
    expectStatus(replace, "conflict");
    expect(replace.conflicts).toMatchObject([{ field: "context", version: b.seq }]);
    // An empty context takes the text alone, normalised as every stored text is.
    expectStatus(
      submit([{ kind: "task.context_append", task: empty, text: "Line one\r\nline two" }], {
        base: null,
      }),
      "applied",
    );
    expect(one("SELECT context FROM tasks WHERE id = $empty", { empty })).toBe(
      "Line one\nline two",
    );
  });

  test("at most 64 KiB in all, decided on the context as it is; a deleted or missing task fails", () => {
    const big = "a".repeat(64 * 1024 - 10);
    const task = create("Long context", big);
    const over = submit([{ kind: "task.context_append", task, text: "0123456789" }], {
      base: null,
    });
    expectStatus(over, "rejected");
    expect(over.error).toMatchObject({ code: "TOO_LARGE", op: 0, field: "text" });
    expect(one("SELECT context FROM tasks WHERE id = $task", { task })).toBe(big);
    // The blank line counts: eight characters fit.
    expectStatus(
      submit([{ kind: "task.context_append", task, text: "01234567" }], { base: null }),
      "applied",
    );
    const error = (op: Record<string, unknown>): unknown => {
      const result = fx.writer.submit({
        ...fx.request(fx.human, []),
        ops: [{ kind: "task.context_append", task, text: "x", ...op }],
      });
      return [result.error?.code, result.error?.field];
    };
    expect(error({ text: "" })).toEqual(["VALIDATION_FAILED", "ops[0].text"]);
    expect(error({ text: "x".repeat(64 * 1024 + 1) })).toEqual(["TOO_LARGE", "ops[0].text"]);
    expect(error({ task: "M-99" })).toEqual(["NOT_FOUND", "task"]);
    expect(error({ extra: 1 })).toEqual(["VALIDATION_FAILED", "ops[0]"]);
  });
});
