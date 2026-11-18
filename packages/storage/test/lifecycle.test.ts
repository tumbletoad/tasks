// The lifecycle (A1 3.11.1 to 3.11.4 without redact; A7 3.10 M3.04): complete, reopen, archive, the
// additive wrap-up with its learnings, and the tombstone delete with restore, through the write
// path. Fixture text only.
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import {
  expectedDocuments,
  storedDocuments,
  type SearchDocument,
} from "../src/search/documents.ts";
import type { Operation, WriteResult } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import {
  checkHistory,
  expectStatus,
  writeFixture,
  type Fixture,
  fixtureCopies,
} from "./write-helpers.ts";

const temp = tempFolders("lifecycle");
/** The fixture space, made once and copied for each test. */
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

let fx: Fixture;
beforeEach(async () => {
  fx = await fixture();
});
afterEach(() => {
  checkHistory(fx.reader);
  fx.close();
});

type Row = Record<string, unknown>;
type Actor = "human" | "codex";

const one = (sql: string, params = {}): unknown =>
  Object.values(fx.reader.prepare(sql).get(params) ?? {})[0];
const task = (id: string): Row =>
  fx.reader.prepare("SELECT * FROM tasks WHERE id = $id").get({ id }) ?? {};
const lastSeq = (): number => Number(one("SELECT last_seq FROM space"));
const changesAt = (seq: number): unknown[][] =>
  fx.reader
    .prepare("SELECT entity, field, action FROM changes WHERE seq = $seq ORDER BY n")
    .all({ seq })
    .map((row) => [row["entity"], row["field"], row["action"]]);
const learnings = (id: string): Row[] =>
  fx.reader.prepare("SELECT * FROM learnings WHERE task_id = $id ORDER BY position").all({ id });
const live = (id: string): unknown[] =>
  learnings(id)
    .filter((row) => row["deleted_at"] === null)
    .map((row) => row["body"]);

/** Submits with a fresh base unless one is given, as Mira unless an agent is named. */
function submit(
  ops: Operation[],
  extra: { base?: string | null; actor?: Actor } = {},
): WriteResult {
  const base = extra.base === undefined ? fx.base() : extra.base;
  return fx.writer.submit(
    fx.request(fx[extra.actor ?? "human"], ops, base === null ? {} : { base }),
  );
}

/** Creates a task with a client ID and returns it. */
function create(extra: Partial<Extract<Operation, { kind: "task.create" }>> = {}): Id<"t"> {
  const id = newId("t");
  expectStatus(submit([{ kind: "task.create", title: "Fix the export", ...extra, id }]), "applied");
  return id;
}

describe("[A1.5.write.lifecycle] complete, reopen, archive, wrap-up, delete and restore", () => {
  test("archive: active to archived with its reason, no completion time and no wrap-up waiting", () => {
    const id = create();
    const result = submit([{ kind: "task.archive", task: id, reason: "Superseded by M-9." }]);
    expectStatus(result, "applied");
    expect(task(id)).toMatchObject({
      lifecycle: "archived",
      archived_reason: "Superseded by M-9.",
      completed_at: null,
      completed_by: null,
      wrap_state: null,
    });
    // One change row: the lifecycle. Archiving counts for the burst brake (A1 3.4).
    expect(changesAt(result.seq)).toEqual([["tasks", "lifecycle", "set"]]);
    expect(one("SELECT affected FROM commits WHERE seq = $seq", { seq: result.seq })).toBe(1);
    // Only an active task is archived, and an archive needs a base.
    expect(submit([{ kind: "task.archive", task: id }]).error).toMatchObject({
      code: "INVALID_TRANSITION",
      op: 0,
    });
    const other = create();
    expect(submit([{ kind: "task.archive", task: other }], { base: null }).error).toMatchObject({
      code: "BASE_REQUIRED",
    });
    // A reopen clears the reason and keeps the task's ID and reference (A1 3.11.3).
    const ref = task(id)["ref"];
    expectStatus(submit([{ kind: "task.reopen", task: id }]), "applied");
    expect(task(id)).toMatchObject({ lifecycle: "active", archived_reason: null, ref });
  });

  test("if_active leaves a finished task as it is: it touches nothing, so even a stale base is no change", () => {
    const id = create();
    const stale = fx.base();
    expectStatus(submit([{ kind: "task.complete", task: id }]), "applied");
    const seq = lastSeq();
    const before = task(id);
    for (const kind of ["task.complete", "task.archive"] as const) {
      const result = submit([{ kind, task: id, if_active: true }], { base: stale });
      expectStatus(result, "unchanged");
      expect(result.results[0]).toMatchObject({ status: "unchanged", id });
    }
    expect(lastSeq()).toBe(seq);
    expect(task(id)).toEqual(before);
    // On an active task it completes or archives as without it.
    const other = create();
    expectStatus(submit([{ kind: "task.archive", task: other, if_active: true }]), "applied");
    expect(task(other)["lifecycle"]).toBe("archived");
    // It judges the task as the request's earlier operations leave it: reopened, the task is
    // finished, and the finish counts for the burst brake (A3 3.8.3).
    for (const kind of ["task.complete", "task.archive"] as const) {
      const done = create();
      expectStatus(submit([{ kind: "task.complete", task: done }]), "applied");
      const result = submit([
        { kind: "task.reopen", task: done },
        { kind, task: done, if_active: true },
      ]);
      expectStatus(result, "applied");
      expect(task(done)["lifecycle"]).toBe(kind === "task.complete" ? "completed" : "archived");
      expect(one("SELECT affected FROM commits WHERE seq = $seq", { seq: result.seq })).toBe(1);
    }
    // Finished by an earlier operation, the task is left as that one leaves it.
    const twice = create();
    const result = submit([
      { kind: "task.complete", task: twice },
      { kind: "task.archive", task: twice, if_active: true },
    ]);
    expectStatus(result, "applied");
    expect(result.results.map((r) => r.status)).toEqual(["updated", "unchanged"]);
    expect(task(twice)["lifecycle"]).toBe("completed");
    expect(one("SELECT affected FROM commits WHERE seq = $seq", { seq: result.seq })).toBe(1);
  });

  test("wrap-up: outcome, learnings and the mark on a completed or archived task, never an active one", () => {
    const id = create({ planned_for: "2026-11-20", focus: "2026-11-12" });
    expect(submit([{ kind: "task.wrap_up", task: id, outcome: "Too early." }]).error).toMatchObject(
      { code: "INVALID_TRANSITION", op: 0 },
    );
    expectStatus(submit([{ kind: "task.complete", task: id }]), "applied");
    const wrapped = submit(
      [
        {
          kind: "task.wrap_up",
          task: id,
          outcome: "Times are stored as UTC plus the zone ID.",
          learnings: { add: ["Store UTC plus the zone ID.", "Convert once, at the edge."] },
        },
      ],
      { actor: "codex" },
    );
    expectStatus(wrapped, "applied");
    expect(wrapped.results).toEqual([
      { i: 0, status: "updated", id, ref: "M-1", version: wrapped.seq },
    ]);
    expect(task(id)).toMatchObject({
      lifecycle: "completed",
      wrap_state: "wrapped",
      outcome: "Times are stored as UTC plus the zone ID.",
      wrapped_by: fx.codex.principal_id,
      // Without clear_planning the planning scalars stay.
      planned_for: "2026-11-20",
      focus_on: "2026-11-12",
    });
    expect(live(id)).toEqual(["Store UTC plus the zone ID.", "Convert once, at the edge."]);
    expect(learnings(id)[0]).toMatchObject({ created_by: fx.codex.principal_id });
    expect(changesAt(wrapped.seq)).toEqual([
      ["tasks", "wrap", "set"],
      ["learnings", null, "create"],
      ["learnings", null, "create"],
    ]);

    // A later wrap-up rewrites the outcome with a base, removes a learning (its row and text stay)
    // and skips one the task holds already; clear_planning clears the planning scalars.
    const [first] = learnings(id);
    const again = submit([
      {
        kind: "task.wrap_up",
        task: id,
        outcome: "Stored as UTC plus the zone ID, converted once.",
        learnings: {
          add: ["Convert once, at the edge.", "Check the mobile app too."],
          remove: [first?.["id"] as Id<"lr">],
        },
        clear_planning: true,
      },
    ]);
    expectStatus(again, "applied");
    expect(live(id)).toEqual(["Convert once, at the edge.", "Check the mobile app too."]);
    expect(learnings(id)).toHaveLength(3);
    expect(learnings(id)[0]).toMatchObject({ body: "Store UTC plus the zone ID." });
    expect(task(id)).toMatchObject({
      planned_for: null,
      focus_on: null,
      wrapped_by: fx.human.principal_id,
    });
    expect(changesAt(again.seq)).toEqual([
      ["tasks", "wrap", "set"],
      ["tasks", "planned_for", "set"],
      ["tasks", "focus", "set"],
      ["learnings", "deleted", "set"],
      ["learnings", null, "create"],
    ]);

    // A stale base conflicts on the wrap-up it would overwrite.
    const stale = fx.base();
    expectStatus(submit([{ kind: "task.wrap_up", task: id, outcome: "First." }]), "applied");
    const conflict = submit([{ kind: "task.wrap_up", task: id, outcome: "Second." }], {
      base: stale,
    });
    expect(conflict).toMatchObject({ status: "conflict", conflicts: [{ field: "wrap" }] });
    expect(task(id)["outcome"]).toBe("First.");

    // An archived task is wrapped up like a completed one (A1 3.11.3).
    const dropped = create();
    expectStatus(
      submit([
        { kind: "task.archive", task: dropped },
        { kind: "task.wrap_up", task: dropped, outcome: "Not needed after the migration." },
      ]),
      "applied",
    );
    expect(task(dropped)).toMatchObject({ lifecycle: "archived", wrap_state: "wrapped" });
  });

  test("wrap-up's learnings: at most 20 live per task, 1 KiB each, IDs of this task's learnings only", () => {
    const id = create();
    expectStatus(submit([{ kind: "task.complete", task: id }]), "applied");
    const texts = Array.from({ length: 20 }, (_, n) => `Learning ${String(n + 1)}`);
    expectStatus(
      submit([{ kind: "task.wrap_up", task: id, learnings: { add: texts } }]),
      "applied",
    );
    expect(live(id)).toEqual(texts);
    const seq = lastSeq();
    expect(
      submit([{ kind: "task.wrap_up", task: id, learnings: { add: ["One more."] } }]).error,
    ).toMatchObject({ code: "TOO_LARGE", op: 0, field: "learnings.add" });
    // Removing one makes room in the same operation.
    const [oldest] = learnings(id);
    expectStatus(
      submit([
        {
          kind: "task.wrap_up",
          task: id,
          learnings: { add: ["One more."], remove: [oldest?.["id"] as Id<"lr">] },
        },
      ]),
      "applied",
    );
    expect(live(id)).toHaveLength(20);
    expect(lastSeq()).toBe(seq + 1);

    const code = (learning: unknown): unknown => {
      const ops: unknown[] = [{ kind: "task.wrap_up", task: id, learnings: learning }];
      const result = fx.writer.submit({ ...fx.request(fx.human, [], { base: fx.base() }), ops });
      return [result.error?.code, result.error?.field];
    };
    expect(code({ add: ["é".repeat(513)] })).toEqual(["TOO_LARGE", "ops[0].learnings.add"]);
    expect(code({ add: ["   "] })).toEqual(["VALIDATION_FAILED", "ops[0].learnings.add"]);
    expect(code({ add: Array<string>(21).fill("x") })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].learnings.add",
    ]);
    expect(code({ remove: ["n_0000000000000000000000000"] })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].learnings.remove",
    ]);
    expect(code({ keep: [] })).toEqual(["VALIDATION_FAILED", "ops[0].learnings"]);
    // A learning of another task is not found under this one.
    const other = create();
    expectStatus(submit([{ kind: "task.complete", task: other }]), "applied");
    const [theirs] = learnings(id);
    expect(
      submit([
        { kind: "task.wrap_up", task: other, learnings: { remove: [theirs?.["id"] as Id<"lr">] } },
      ]).error,
    ).toMatchObject({ code: "NOT_FOUND", op: 0, field: "learnings.remove" });
  });

  test("once: a wrapped task is no change when nothing would change, else a conflict whatever the base", () => {
    const id = create();
    expectStatus(
      submit([
        { kind: "task.complete", task: id, if_active: true },
        {
          kind: "task.wrap_up",
          task: id,
          outcome: "Shipped in 2.3.",
          learnings: { add: ["Pin the runtime."] },
          once: true,
        },
      ]),
      "applied",
    );
    const seq = lastSeq();
    const finish = (outcome: string, add: string[] = []): WriteResult =>
      submit([
        { kind: "task.complete", task: id, if_active: true },
        { kind: "task.wrap_up", task: id, outcome, learnings: { add }, once: true },
      ]);
    // The same outcome, and learnings it holds: unchanged, no commit.
    const same = finish("Shipped in 2.3.", ["Pin the runtime."]);
    expectStatus(same, "unchanged");
    expect(same.results.map((r) => r.status)).toEqual(["unchanged", "unchanged"]);
    expect(lastSeq()).toBe(seq);
    // Another outcome, or a new learning: a conflict on wrap that names the stored outcome.
    for (const changed of [finish("Shipped in 2.4."), finish("Shipped in 2.3.", ["New."])]) {
      expect(changed).toMatchObject({
        status: "conflict",
        error: { code: "VERSION_CONFLICT" },
        conflicts: [
          {
            op: 1,
            entity: "tasks",
            id,
            field: "wrap",
            value: { wrap_state: "wrapped", outcome: "Shipped in 2.3." },
            version: seq,
          },
        ],
      });
    }
    expect(task(id)["outcome"]).toBe("Shipped in 2.3.");
    // It judges removals on the start as well: an earlier operation that removes the same
    // learning makes it no less a change, so the request is a conflict and removes nothing.
    const [held] = learnings(id);
    const remove = { remove: [held?.["id"] as Id<"lr">] };
    expect(
      submit([
        { kind: "task.wrap_up", task: id, learnings: remove },
        { kind: "task.wrap_up", task: id, learnings: remove, once: true },
      ]),
    ).toMatchObject({ status: "conflict", conflicts: [{ op: 1, field: "wrap" }] });
    expect(live(id)).toEqual(["Pin the runtime."]);
    // A task the user checked off waits for its wrap-up: once wraps it.
    const checked = create();
    expectStatus(submit([{ kind: "task.complete", task: checked }]), "applied");
    expectStatus(
      submit([{ kind: "task.wrap_up", task: checked, outcome: "Done.", once: true }]),
      "applied",
    );
    expect(task(checked)).toMatchObject({ wrap_state: "wrapped", outcome: "Done." });
  });

  test("delete sets the tombstone and restore clears it; a deleted task takes no other change", () => {
    const id = create();
    const deleted = submit([{ kind: "task.delete", task: id }]);
    expectStatus(deleted, "applied");
    expect(task(id)).toMatchObject({ deleted_by: fx.human.principal_id });
    expect(task(id)["deleted_at"]).not.toBeNull();
    expect(changesAt(deleted.seq)).toEqual([["tasks", "deleted", "set"]]);
    expect(one("SELECT affected FROM commits WHERE seq = $seq", { seq: deleted.seq })).toBe(1);
    const seq = lastSeq();
    for (const op of [
      { kind: "task.delete", task: id },
      { kind: "task.patch", task: id, set: { summary: "x" } },
      { kind: "note.add", task: id, body: "x" },
      { kind: "task.complete", task: id },
      { kind: "task.wrap_up", task: id },
    ] satisfies Operation[]) {
      expect(submit([op]).error, op.kind).toMatchObject({ code: "DELETED", op: 0, field: "task" });
    }
    // A request sees its own tombstones: restored, the task takes the next operation; deleted,
    // it refuses it, and the request writes nothing.
    expect(
      submit([
        { kind: "task.restore", task: id },
        { kind: "task.delete", task: id },
        { kind: "log.add", task: id, body: "Lost with the request." },
      ]).error,
    ).toMatchObject({ code: "DELETED", op: 2 });
    expect(lastSeq()).toBe(seq);
    const restored = submit([
      { kind: "task.restore", task: id },
      { kind: "log.add", task: id, body: "Back again." },
    ]);
    expectStatus(restored, "applied");
    expect(task(id)).toMatchObject({ deleted_at: null, deleted_by: null });
    expect(one("SELECT count(*) FROM log_entries WHERE task_id = $id", { id })).toBe(1);
    // Only a deleted task is restored, and both need a base.
    expect(submit([{ kind: "task.restore", task: id }]).error).toMatchObject({
      code: "INVALID_TRANSITION",
      op: 0,
    });
    expect(submit([{ kind: "task.delete", task: id }], { base: null }).error).toMatchObject({
      code: "BASE_REQUIRED",
    });
  });

  test("the search index follows archive, wrap-up, delete and restore in the commit: it equals a fresh rebuild", async () => {
    // A space with the search tables, as the schema step that adds them will make it (A1 3.12).
    const f = await writeFixture(temp.make());
    try {
      const send = (ops: Operation[]): WriteResult => {
        const result = f.writer.submit(f.request(f.human, ops, { base: f.base() }));
        expectStatus(result, "applied");
        return result;
      };
      const docs = (): [string, string | null][] =>
        [...storedDocuments(f.reader).docs.values()]
          .map((d): [string, string | null] => [d.kind, d.lifecycle])
          .sort();
      const rebuilt = (): void => {
        const { docs: stored, stray } = storedDocuments(f.reader);
        expect(stray).toBe(0);
        const plain = (all: Iterable<SearchDocument>): unknown[] =>
          [...all]
            .map(({ kind, entityId, taskId, lifecycle, audience, title, body, extra }) => ({
              kind,
              entityId,
              taskId,
              lifecycle,
              audience,
              title,
              body,
              extra,
            }))
            .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
        expect(plain(stored.values())).toEqual(plain(expectedDocuments(f.reader).values()));
      };
      const id = newId("t");
      send([
        { kind: "task.create", id, title: "Fix the export" },
        { kind: "note.add", task: id, body: "Ask the clinic first." },
      ]);
      const base = docs().filter(([kind]) => kind === "area" || kind === "project");
      const without = (): [string, string | null][] =>
        docs().filter(([kind]) => kind !== "area" && kind !== "project");
      send([{ kind: "task.archive", task: id }]);
      rebuilt();
      expect(without()).toEqual([
        ["note", "archived"],
        ["task", "archived"],
      ]);
      send([
        {
          kind: "task.wrap_up",
          task: id,
          outcome: "Not needed after the move.",
          learnings: { add: ["Ask before exporting.", "Check the zone."] },
        },
      ]);
      rebuilt();
      expect(without()).toEqual([
        ["learning", "archived"],
        ["learning", "archived"],
        ["note", "archived"],
        ["task", "archived"],
      ]);
      // A tombstone takes the task's documents and its children's out; a restore brings them back.
      send([{ kind: "task.delete", task: id }]);
      rebuilt();
      expect(without()).toEqual([]);
      send([{ kind: "task.restore", task: id }]);
      rebuilt();
      expect(without()).toHaveLength(4);
      // A removed learning leaves the index; a reopen moves the rest to active.
      const learning = f.reader
        .prepare("SELECT id FROM learnings WHERE task_id = $id ORDER BY position LIMIT 1")
        .get({ id })?.["id"] as Id<"lr">;
      send([{ kind: "task.wrap_up", task: id, learnings: { remove: [learning] } }]);
      send([{ kind: "task.reopen", task: id }]);
      rebuilt();
      expect(without()).toEqual([
        ["learning", "active"],
        ["note", "active"],
        ["task", "active"],
      ]);
      expect(docs().filter(([kind]) => kind === "area" || kind === "project")).toEqual(base);
      checkHistory(f.reader);
    } finally {
      f.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Wrap-up is additive (A1 3.11.2): a property over random lifecycles and wrap-ups.

const OUTCOMES = [
  "Shipped in 2.3.",
  "Dropped: the clinic moved.",
  "Ünïcødé outcome ✓",
  "Two\nlines.",
];
const LEARNINGS = [
  "Store UTC plus the zone ID.",
  "Convert once, at the edge.",
  "Pin the runtime.",
  "Ask the clinic before changing the export.",
  "é".repeat(512),
];

type Step =
  | {
      kind: "wrap";
      actor: Actor;
      outcome: string | undefined;
      add: string[];
      remove: number[];
      clear: boolean;
      once: boolean;
    }
  | { kind: "complete" | "archive" | "reopen" }
  /** complete_task called again on the task as it stands: once, its outcome, a learning it holds. */
  | { kind: "again"; actor: Actor };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("again" as const),
      actor: fc.constantFrom<Actor>("human", "codex"),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("wrap" as const),
      actor: fc.constantFrom<Actor>("human", "codex"),
      outcome: fc.option(fc.constantFrom(...OUTCOMES), { nil: undefined }),
      add: fc.uniqueArray(fc.constantFrom(...LEARNINGS), { maxLength: 4 }),
      remove: fc.uniqueArray(fc.nat({ max: 9 }), { maxLength: 2 }),
      clear: fc.boolean(),
      once: fc.boolean(),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({ kind: fc.constantFrom("complete" as const, "archive" as const) }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("reopen" as const) }), weight: 1 },
);

/** What a wrap-up may change: the wrap field, the row's versions, and with clear_planning those two. */
const WRAP_COLUMNS = [
  "wrap_state",
  "outcome",
  "wrapped_at",
  "wrapped_by",
  "version",
  "touched",
  "fv",
  "fp",
];

/** Everything a wrap-up never changes (A1 3.11.2): the task's other columns and the rows under it. */
function untouched(id: Id<"t">, clear: boolean): unknown {
  const free = new Set([...WRAP_COLUMNS, ...(clear ? ["planned_for", "focus_on"] : [])]);
  const rows = (sql: string): Row[] => fx.reader.prepare(sql).all({ id });
  return {
    task: Object.fromEntries(Object.entries(task(id)).filter(([column]) => !free.has(column))),
    notes: rows("SELECT * FROM notes WHERE task_id = $id ORDER BY id"),
    log: rows("SELECT * FROM log_entries WHERE task_id = $id ORDER BY id"),
    links: rows("SELECT * FROM task_sources WHERE task_id = $id ORDER BY source_id"),
    sources: rows(
      "SELECT s.* FROM sources s JOIN task_sources ts ON ts.source_id = s.id " +
        "WHERE ts.task_id = $id ORDER BY s.id",
    ),
    places: rows("SELECT * FROM places WHERE owner_kind = 'task' AND owner_id = $id"),
    attachments: rows("SELECT * FROM attachments WHERE task_id = $id"),
  };
}

/** A task with every kind of row a wrap-up must leave alone: context, a note, a log entry, a source, a place. */
function fullTask(): Id<"t"> {
  const id = newId("t");
  expectStatus(
    submit([
      {
        kind: "task.create",
        id,
        title: "Fix the export",
        context: "Times drift by one hour.\n\nSee the clinic's export.",
        planned_for: "2026-11-20",
        focus: "2026-11-12",
      },
      { kind: "note.add", task: id, body: "Ask Jonas first." },
      { kind: "log.add", task: id, body: "Reproduced on staging.", log_kind: "evidence" },
      {
        kind: "source.add",
        task: id,
        source: { kind: "ticket", title: "Times off", key: `jira:LUM-${id.slice(-6)}` },
      },
      { kind: "place.set", task: id, root: "work", path: "lumen/portal" },
    ]),
    "applied",
  );
  return id;
}

interface Model {
  lifecycle: "active" | "completed" | "archived";
  wrap: "pending" | "wrapped" | null;
  outcome: string | null;
  learnings: string[];
  planned: boolean;
}

describe("[A1.5.write.wrap-up-additive] wrap-up never changes context, notes, log, sources or places", () => {
  test(
    "property: random wrap-ups across completions, archives and reopens change only the outcome, the learnings, the mark and, when asked, the planning scalars",
    { timeout: 120_000 },
    () => {
      const seen = new Set<string>();
      fc.assert(
        fc.property(fc.array(step, { minLength: 1, maxLength: 8 }), (steps) => {
          const id = fullTask();
          const model: Model = {
            lifecycle: "active",
            wrap: null,
            outcome: null,
            learnings: [],
            planned: true,
          };
          for (const given of steps) {
            const s =
              given.kind === "again"
                ? {
                    kind: "wrap" as const,
                    actor: given.actor,
                    outcome: model.outcome ?? undefined,
                    add: model.learnings.slice(0, 1),
                    remove: [],
                    clear: false,
                    once: true,
                  }
                : given;
            if (s.kind !== "wrap") {
              const active = model.lifecycle === "active";
              if (s.kind === "reopen" && active) continue;
              const op: Operation =
                s.kind === "reopen"
                  ? { kind: "task.reopen", task: id }
                  : {
                      kind: s.kind === "complete" ? "task.complete" : "task.archive",
                      task: id,
                      if_active: true,
                    };
              expectStatus(submit([op]), s.kind === "reopen" || active ? "applied" : "unchanged");
              if (s.kind === "reopen") Object.assign(model, { lifecycle: "active", wrap: null });
              else if (active) {
                model.lifecycle = s.kind === "complete" ? "completed" : "archived";
                model.wrap = s.kind === "complete" ? "pending" : null;
              }
              continue;
            }
            const ids = learnings(id)
              .filter((row) => row["deleted_at"] === null)
              .map((row) => row["id"] as Id<"lr">);
            const remove = [
              ...new Set(s.remove.flatMap((n) => (ids.length === 0 ? [] : [n % ids.length]))),
            ];
            const removed = remove.map((n) => ids[n] as Id<"lr">);
            const before = untouched(id, s.clear);
            const result = submit(
              [
                {
                  kind: "task.wrap_up",
                  task: id,
                  ...(s.outcome === undefined ? {} : { outcome: s.outcome }),
                  learnings: { add: s.add, remove: removed },
                  clear_planning: s.clear,
                  once: s.once,
                },
              ],
              { actor: s.actor },
            );
            // What the model says it does.
            const kept = model.learnings.filter((_, n) => !remove.includes(n));
            const next = [...kept, ...s.add.filter((body) => !kept.includes(body))];
            if (model.lifecycle === "active") {
              expect(result.error?.code).toBe("INVALID_TRANSITION");
              seen.add("active");
            } else if (s.once && model.wrap === "wrapped") {
              const same =
                (s.outcome === undefined || s.outcome === model.outcome) &&
                removed.length === 0 &&
                (!s.clear || !model.planned) &&
                s.add.every((body) => model.learnings.includes(body));
              expectStatus(result, same ? "unchanged" : "conflict");
              seen.add(same ? "once unchanged" : "once conflict");
            } else if (next.length > 20) {
              expect(result.error?.code).toBe("TOO_LARGE");
              seen.add("too many");
            } else {
              expectStatus(result, "applied");
              model.wrap = "wrapped";
              model.outcome = s.outcome ?? model.outcome;
              model.learnings = next;
              if (s.clear) model.planned = false;
              seen.add(s.clear ? "applied, cleared" : "applied");
            }
            // Whatever happened, nothing else of the task or under it changed.
            expect(untouched(id, s.clear)).toEqual(before);
            expect(task(id)).toMatchObject({
              lifecycle: model.lifecycle,
              wrap_state: model.wrap,
              outcome: model.outcome,
              planned_for: model.planned ? "2026-11-20" : null,
            });
            expect(live(id)).toEqual(model.learnings);
          }
        }),
        { numRuns: 60, seed: 20261114 },
      );
      for (const outcome of [
        "active",
        "once unchanged",
        "once conflict",
        "applied",
        "applied, cleared",
      ]) {
        expect(seen, outcome).toContain(outcome);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Restore brings a tombstoned task back with its history (A1 3.11.4).

describe("[A1.5.write.tombstone] a deleted task keeps every row and its history, and restore brings it back", () => {
  /** The task's row without what every commit moves, and every row under it. */
  function state(id: Id<"t">): unknown {
    const rows = (sql: string): Row[] => fx.reader.prepare(sql).all({ id });
    const row = Object.fromEntries(
      Object.entries(task(id)).filter(
        ([column]) =>
          !["version", "touched", "fv", "fp", "deleted_at", "deleted_by"].includes(column),
      ),
    );
    return {
      task: row,
      notes: rows("SELECT * FROM notes WHERE task_id = $id ORDER BY id"),
      log: rows("SELECT * FROM log_entries WHERE task_id = $id ORDER BY id"),
      links: rows("SELECT * FROM task_sources WHERE task_id = $id ORDER BY source_id"),
      learnings: rows("SELECT * FROM learnings WHERE task_id = $id ORDER BY id"),
      places: rows("SELECT * FROM places WHERE owner_kind = 'task' AND owner_id = $id"),
    };
  }
  const history = (id: Id<"t">): Row[] =>
    fx.reader
      .prepare("SELECT * FROM changes WHERE task_id = $id OR entity_id = $id ORDER BY seq, n")
      .all({ id });

  test(
    "property: after any history, delete then restore leaves the task, its rows and its history as they were, plus the two tombstone changes",
    { timeout: 120_000 },
    () => {
      const before = fc.array(
        fc.constantFrom("patch", "note", "log", "finish", "reopen", "unplace"),
        { maxLength: 6 },
      );
      fc.assert(
        fc.property(before, fc.boolean(), (kinds, agent) => {
          const id = fullTask();
          for (const kind of kinds) {
            const finished = task(id)["lifecycle"] !== "active";
            const op: Operation[] =
              kind === "patch"
                ? [
                    {
                      kind: "task.patch",
                      task: id,
                      set: { summary: `Summary at ${String(lastSeq())}` },
                    },
                  ]
                : kind === "note"
                  ? [{ kind: "note.add", task: id, body: "Fixture note." }]
                  : kind === "log"
                    ? [{ kind: "log.add", task: id, body: "Fixture progress." }]
                    : kind === "finish"
                      ? [
                          { kind: "task.complete", task: id, if_active: true },
                          {
                            kind: "task.wrap_up",
                            task: id,
                            outcome: "Fixture outcome.",
                            learnings: { add: [`Learning ${String(lastSeq())}`] },
                          },
                        ]
                      : kind === "reopen"
                        ? finished
                          ? [{ kind: "task.reopen", task: id }]
                          : []
                        : [{ kind: "place.clear", task: id }];
            if (op.length > 0) expect(["applied", "unchanged"]).toContain(submit(op).status);
          }
          const was = state(id);
          const past = history(id);
          const actor: Actor = agent ? "codex" : "human";
          const deleted = submit([{ kind: "task.delete", task: id }], { actor });
          expectStatus(deleted, "applied");
          // Deleted: every row stays, and history only grows.
          expect(state(id)).toEqual(was);
          expect(history(id).slice(0, past.length)).toEqual(past);
          expect(task(id)["deleted_by"]).toBe(fx[actor].principal_id);
          const restored = submit([{ kind: "task.restore", task: id }], { actor });
          expectStatus(restored, "applied");
          expect(state(id)).toEqual(was);
          expect(task(id)).toMatchObject({ deleted_at: null, deleted_by: null });
          const now = history(id);
          expect(now.slice(0, past.length)).toEqual(past);
          const tombstone = (c: Row): unknown =>
            (JSON.parse(String(c["after"])) as Row)["deleted_at"] === null;
          expect(now.slice(past.length).map((c) => [c["seq"], c["field"], tombstone(c)])).toEqual([
            [deleted.seq, "deleted", false],
            [restored.seq, "deleted", true],
          ]);
          // The restored task takes changes again.
          expectStatus(submit([{ kind: "log.add", task: id, body: "Back." }]), "applied");
        }),
        { numRuns: 25, seed: 20261114 },
      );
    },
  );
});
