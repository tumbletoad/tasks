// Undo and redo through the write path (A1 3.10, 3.10.1, 3.10.4; A7 3.10 M3.02), the fixed
// scenarios A1 5 lists before the property test (undo-model.test.ts): consecutive edits of one
// field, overlapping field sets, undo and redo cycles, foreign edits, creates, the stack and the
// floor. Every test ends with A1's history invariants, provenance included (checkHistory).
// Fixture text only.
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Connection } from "../src/driver.ts";
import { newId, type Id } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import { planInversions, readChanges } from "../src/write/history.ts";
import type { Credential, Operation, WriteRequest, WriteResult } from "../src/write/request.ts";
import { checkedDriver, TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, type Fixture, fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("undo");
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
const one = (sql: string, params = {}): unknown =>
  Object.values(fx.reader.prepare(sql).get(params) ?? {})[0];
const row = (sql: string, params = {}): Row => fx.reader.prepare(sql).get(params) ?? {};
const lastSeq = (): number => Number(one("SELECT last_seq FROM space"));
const commitAt = (seq: number): Row => row("SELECT * FROM commits WHERE seq = $seq", { seq });
const changesAt = (seq: number): Row[] =>
  fx.reader.prepare("SELECT * FROM changes WHERE seq = $seq ORDER BY n").all({ seq });
const task = (id: Id<"t">): Row => row("SELECT * FROM tasks WHERE id = $id", { id });
const maps = (id: Id<"t">): { fv: Record<string, number>; fp: Record<string, number> } => {
  const t = task(id);
  return {
    fv: JSON.parse(String(t["fv"])) as Record<string, number>,
    fp: JSON.parse(String(t["fp"])) as Record<string, number>,
  };
};

type Who = "human" | "codex" | "claude";

/** A write as `who`, with a fresh base. The human's writes are undoable, as the service sends them. */
function write(ops: Operation[], who: Who = "human", extra: Partial<WriteRequest> = {}) {
  return fx.writer.submit(
    fx.request(fx[who], ops, {
      base: fx.base(),
      ...(who === "human" ? { undoable: true } : {}),
      ...extra,
    }),
  );
}

function applied(result: WriteResult): WriteResult {
  expectStatus(result, "applied");
  return result;
}

function create(title = "Fix the export", who: Who = "human"): Id<"t"> {
  const id = newId("t");
  applied(write([{ kind: "task.create", id, title }], who));
  return id;
}

const patch = (id: Id<"t">, set: Record<string, unknown>, who: Who = "human"): WriteResult =>
  applied(write([{ kind: "task.patch", task: id, set }], who));

/** An undo or a redo as `actor` (the human by default). */
function history(
  op: { kind: "undo"; commit?: string; partial?: boolean } | { kind: "redo"; commit?: string },
  actor: Credential = fx.human,
  extra: Partial<WriteRequest> = {},
): WriteResult {
  return fx.writer.submit(fx.request(actor, [op as Operation], extra));
}
const undo = (extra: { commit?: string; partial?: boolean } = {}): WriteResult =>
  history({ kind: "undo", ...extra });
const redo = (extra: { commit?: string } = {}): WriteResult => history({ kind: "redo", ...extra });

const DUE = (date: string) => ({ due_date: date, due_at: null, due_tz: null });

/** A second connection between the writer's requests, for a state no operation of this build makes. */
async function raw(fn: (conn: Connection) => void): Promise<void> {
  const conn = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
  try {
    conn.transaction("immediate", () => {
      fn(conn);
    });
  } finally {
    conn.close();
  }
}

/** The columns of a task's lifecycle and wrap fields (fields.ts: TASK_FIELDS). */
const LONE_COLUMNS = {
  lifecycle: ["lifecycle", "completed_at", "completed_by", "archived_reason"],
  wrap: ["wrap_state", "outcome", "wrapped_at", "wrapped_by"],
} as const;

/**
 * A commit that writes a task's lifecycle or its wrap field alone, as M3.04's `task.archive` and
 * `task.wrap_up` will: its change row, versions, touched mark and outbox row, on `who`'s undo
 * stack when `undoable`. `values` gets the commit's instant.
 */
async function loneWrite(
  id: Id<"t">,
  field: "lifecycle" | "wrap",
  values: (at: number) => Record<string, unknown>,
  who: Credential,
  op: string,
  undoable = false,
): Promise<number> {
  let done = 0;
  await raw((conn) => {
    const seq = Number(conn.prepare("SELECT last_seq FROM space").get()?.["last_seq"]) + 1;
    const at = Number(conn.prepare("SELECT max(at) AS at FROM commits").get()?.["at"]) + 1000;
    const space = conn.prepare("SELECT * FROM space").get();
    const t = conn.prepare("SELECT * FROM tasks WHERE id = $id").get({ id });
    if (space === undefined || t === undefined) throw new Error("no task");
    const fv = JSON.parse(String(t["fv"])) as Record<string, number>;
    const fp = JSON.parse(String(t["fp"])) as Record<string, number>;
    const columns = LONE_COLUMNS[field];
    const given = values(at);
    const after = Object.fromEntries(columns.map((c) => [c, given[c] ?? null]));
    conn
      .prepare(
        "INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id, " +
          "author_id, scope_id, machine_id, origin, request_id, kind, ops, undo_status) VALUES " +
          "($seq, $op, $epoch, $incarnation, $at, $kind, $actor, $actor, $scope, $machine, " +
          "$origin, $request, 'ops', $ops, $status)",
      )
      .run({
        seq,
        op: newId("op"),
        epoch: space["authority_epoch"] as number,
        incarnation: space["authority_incarnation"] as string,
        at,
        kind: who.actor_kind,
        actor: who.principal_id,
        scope: who.scope_id,
        machine: TEST_MACHINE,
        origin: who.origin,
        request: newId("op").slice(3),
        ops: JSON.stringify([{ v: 1, op, target: id, input: { task: id } }]),
        status: undoable ? "done" : null,
      });
    conn
      .prepare(
        "INSERT INTO changes (seq, n, op, entity, entity_id, task_id, action, field, before, " +
          "after, before_ver, before_prov, after_prov) VALUES ($seq, 1, 0, 'tasks', $id, $id, " +
          "'set', $field, $before, $after, $ver, $prov, $seq)",
      )
      .run({
        seq,
        id,
        field,
        before: JSON.stringify(Object.fromEntries(columns.map((c) => [c, t[c] ?? null]))),
        after: JSON.stringify(after),
        ver: fv[field] ?? (t["created_seq"] as number),
        prov: fp[field] ?? (t["created_seq"] as number),
      });
    conn
      .prepare(
        `UPDATE tasks SET ${columns.map((c) => `${c} = $${c}`).join(", ")}, version = $seq, ` +
          "touched = $seq, fv = $fv, fp = $fp WHERE id = $id",
      )
      .run({
        ...after,
        seq,
        id,
        fv: JSON.stringify({ ...fv, [field]: seq }),
        fp: JSON.stringify({ ...fp, [field]: seq }),
      });
    conn
      .prepare(
        "INSERT INTO outbox (topic, key, first_seq, seq) VALUES ('projection', $key, $seq, $seq) " +
          "ON CONFLICT (topic, key) DO UPDATE SET seq = excluded.seq",
      )
      .run({ key: id, seq });
    conn.prepare("UPDATE space SET last_seq = $seq").run({ seq });
    done = seq;
  });
  return done;
}

/** Codex's wrap-up as M3.04's `task.wrap_up` will write it: `wrapped`, with an outcome. */
const codexWrapUp = (id: Id<"t">): Promise<number> =>
  loneWrite(
    id,
    "wrap",
    (at) => ({
      wrap_state: "wrapped",
      outcome: "Shipped",
      wrapped_at: at,
      wrapped_by: fx.codex.principal_id,
    }),
    fx.codex,
    "task.wrap_up",
  );

/** Mira's archive as M3.04's `task.archive` will write it: the lifecycle alone, on her stack. */
const archive = (id: Id<"t">): Promise<number> =>
  loneWrite(
    id,
    "lifecycle",
    () => ({ lifecycle: "archived", archived_reason: "Not needed now" }),
    fx.human,
    "task.archive",
    true,
  );

/** A second human of the space, with a stack of its own. */
async function partner(): Promise<Credential> {
  const id = newId("ac");
  await raw((conn) => {
    conn
      .prepare(
        "INSERT INTO actors (id, kind, label, instance_id, routine_id, created_at) " +
          "VALUES ($id, 'human', 'Fixture partner', NULL, NULL, 0)",
      )
      .run({ id });
  });
  return { ...fx.human, principal_id: id, scope_id: "cli:partner" };
}

describe("[A1.5.history.undo-redo] undo and redo through the write path", () => {
  test("two edits of one field, then two undos and two redos, match each step", () => {
    const id = create();
    const c1 = patch(id, { summary: "First pass" });
    const c2 = patch(id, { summary: "Second pass" });
    const stale = fx.base();

    const u2 = applied(undo());
    expect(task(id)["summary"]).toBe("First pass");
    // fv only grows; fp names the write the field holds again (A1 3.10).
    expect(maps(id)).toMatchObject({ fv: { summary: u2.seq }, fp: { summary: c1.seq } });
    expect(u2.results).toEqual([
      { i: 0, status: "updated", id: commitAt(c2.seq)["id"], version: u2.seq },
    ]);
    expect(commitAt(u2.seq)).toMatchObject({
      kind: "undo",
      undo_of: c2.seq,
      redo_of: null,
      undo_status: null,
      principal_id: fx.human.principal_id,
    });
    expect(commitAt(c2.seq)).toMatchObject({ undo_status: "undone", undone_by: u2.seq });
    expect(changesAt(u2.seq)).toMatchObject([
      {
        entity: "tasks",
        entity_id: id,
        task_id: id,
        action: "set",
        field: "summary",
        before: JSON.stringify("Second pass"),
        after: JSON.stringify("First pass"),
        before_ver: c2.seq,
        before_prov: c2.seq,
        after_prov: c1.seq,
      },
    ]);
    // A stale base still conflicts after an undo: the physical version moved forward.
    expectStatus(
      fx.writer.submit(
        fx.request(fx.codex, [{ kind: "task.patch", task: id, set: { summary: "Late" } }], {
          base: stale,
        }),
      ),
      "conflict",
    );
    // The task waits for the projection at the undo's seq.
    expect(task(id)["touched"]).toBe(u2.seq);
    expect(one("SELECT seq FROM outbox WHERE key = $id", { id })).toBe(u2.seq);

    const u1 = applied(undo());
    expect(task(id)["summary"]).toBe("");
    expect(maps(id).fv["summary"]).toBe(u1.seq);
    expect(maps(id).fp["summary"] ?? task(id)["created_seq"]).toBe(task(id)["created_seq"]);
    expect(commitAt(c1.seq)).toMatchObject({ undo_status: "undone", undone_by: u1.seq });

    // Redo takes the oldest undone commit: c1, then c2, each with its own provenance back.
    const r1 = applied(redo());
    expect(task(id)["summary"]).toBe("First pass");
    expect(maps(id)).toMatchObject({ fv: { summary: r1.seq }, fp: { summary: c1.seq } });
    expect(commitAt(r1.seq)).toMatchObject({ kind: "redo", redo_of: c1.seq, undo_of: null });
    expect(commitAt(c1.seq)).toMatchObject({ undo_status: "done", undone_by: null });
    const r2 = applied(redo());
    expect(task(id)["summary"]).toBe("Second pass");
    expect(maps(id)).toMatchObject({ fv: { summary: r2.seq }, fp: { summary: c2.seq } });
    expect(commitAt(c2.seq)).toMatchObject({ undo_status: "done", undone_by: null });
    expectStatus(redo(), "rejected");
  });

  test("overlapping field sets: undo C2, then C1, then redo both", () => {
    const id = create();
    const c1 = patch(id, { summary: "Compare totals", due: { date: "2026-11-20" } });
    const c2 = patch(id, { due: { date: "2026-11-27" }, status: "waiting" });

    applied(undo());
    expect(task(id)).toMatchObject({
      summary: "Compare totals",
      ...DUE("2026-11-20"),
      status: "open",
    });
    expect(maps(id).fp).toMatchObject({ summary: c1.seq, due: c1.seq });
    applied(undo());
    expect(task(id)).toMatchObject({ summary: "", ...DUE(null as never), status: "open" });
    applied(redo());
    expect(task(id)).toMatchObject({ summary: "Compare totals", ...DUE("2026-11-20") });
    expect(maps(id).fp).toMatchObject({ summary: c1.seq, due: c1.seq });
    applied(redo());
    expect(task(id)).toMatchObject({
      summary: "Compare totals",
      ...DUE("2026-11-27"),
      status: "waiting",
    });
    expect(maps(id).fp).toMatchObject({ summary: c1.seq, due: c2.seq, status: c2.seq });
  });

  test("undo and redo cycles keep passing while fv only grows", () => {
    const id = create();
    const c = patch(id, { priority: 1, title: "Fix the export now" });
    let previous = maps(id).fv["priority"] ?? 0;
    for (let round = 0; round < 5; round += 1) {
      const u = applied(undo());
      expect(task(id)).toMatchObject({ priority: 4, title: "Fix the export" });
      const r = applied(redo());
      expect(task(id)).toMatchObject({ priority: 1, title: "Fix the export now" });
      expect(maps(id).fp).toMatchObject({ priority: c.seq, title: c.seq });
      expect(u.seq).toBeGreaterThan(previous);
      expect(maps(id).fv["priority"]).toBe(r.seq);
      previous = r.seq;
    }
  });

  test("a foreign edit is UNDO_CONFLICT with what each side wrote, and writes nothing", () => {
    const id = create();
    const mine = patch(id, { due: { date: "2026-11-20" }, summary: "Mine" });
    const theirs = patch(id, { due: { date: "2026-11-21" } }, "codex");
    const before = lastSeq();
    const refused = undo();
    expectStatus(refused, "conflict");
    expect(refused.error).toMatchObject({ code: "UNDO_CONFLICT" });
    expect(refused.conflicts).toEqual([
      {
        op: 0,
        entity: "tasks",
        id,
        task: id,
        ref: "M-1",
        field: "due",
        value: DUE("2026-11-21"),
        wrote: DUE("2026-11-20"),
        restore: DUE(null as never),
        version: theirs.seq,
        by: {
          actor: fx.codex.principal_id,
          kind: "agent",
          label: "Codex · work",
          origin: "mcp",
        },
        at: commitAt(theirs.seq)["at"],
      },
    ]);
    expect(lastSeq()).toBe(before);
    // It names the commit it met, for a caller that named none.
    expect(refused.target).toBe(mine.commit);
    expect(commitAt(mine.seq)["undo_status"]).toBe("done");
    // Its receipt holds no task text: the values stay in the reply.
    const stored = JSON.parse(
      String(one("SELECT result FROM receipts WHERE status = 'conflict' ORDER BY at DESC LIMIT 1")),
    ) as WriteResult;
    expect(stored.conflicts[0]).not.toHaveProperty("value");
    expect(stored.conflicts[0]).not.toHaveProperty("wrote");
    expect(stored.conflicts[0]).not.toHaveProperty("restore");
  });

  test("a value set away and back by another actor is theirs: provenance, never equality (R2)", () => {
    const id = create();
    patch(id, { due: { date: "2026-11-20" } });
    patch(id, { due: { date: "2026-11-21" } }, "codex");
    const back = patch(id, { due: { date: "2026-11-20" } }, "codex");
    expect(task(id)).toMatchObject(DUE("2026-11-20"));
    const refused = undo();
    expectStatus(refused, "conflict");
    expect(refused.conflicts).toMatchObject([{ field: "due", version: back.seq }]);
  });

  test("a partial undo inverts what passes, lists the rest, and its redo brings back only that", () => {
    const id = create();
    const mine = patch(id, { due: { date: "2026-11-20" }, summary: "Mine" });
    patch(id, { due: { date: "2026-11-21" } }, "codex");
    const u = applied(undo({ partial: true }));
    expect(task(id)).toMatchObject({ summary: "", ...DUE("2026-11-21") });
    expect(u.conflicts).toMatchObject([{ field: "due", value: DUE("2026-11-21") }]);
    expect(changesAt(u.seq).map((c) => c["field"])).toEqual(["summary"]);
    expect(commitAt(mine.seq)).toMatchObject({ undo_status: "undone", undone_by: u.seq });
    expect(JSON.parse(String(commitAt(u.seq)["ops"]))).toEqual([
      {
        v: 1,
        op: "undo",
        target: commitAt(mine.seq)["id"],
        input: { commit: commitAt(mine.seq)["id"], partial: true },
      },
    ]);
    const r = applied(redo());
    expect(changesAt(r.seq).map((c) => c["field"])).toEqual(["summary"]);
    expect(task(id)).toMatchObject({ summary: "Mine", ...DUE("2026-11-21") });
  });

  test("a partial undo that can invert nothing still takes the change off the stack", () => {
    const id = create();
    const below = patch(id, { summary: "Below" });
    const mine = patch(id, { due: { date: "2026-11-20" } });
    patch(id, { due: { date: "2026-11-21" } }, "codex");
    const u = applied(undo({ partial: true }));
    expect(changesAt(u.seq)).toEqual([]);
    expect(u.conflicts).toMatchObject([{ field: "due" }]);
    expect(commitAt(mine.seq)).toMatchObject({ undo_status: "undone", undone_by: u.seq });
    // The next undo reaches the change below it.
    const next = applied(undo());
    expect(commitAt(next.seq)["undo_of"]).toBe(below.seq);
    expect(task(id)["summary"]).toBe("");
  });

  test("a partial undo keeps a task's lifecycle and wrap-up together", async () => {
    const id = create();
    const done = applied(write([{ kind: "task.complete", task: id }]));
    expect(task(id)).toMatchObject({ lifecycle: "completed", wrap_state: "pending" });
    const wrapped = await codexWrapUp(id);
    // The lifecycle still holds Mira's write and would pass alone, but an active task with a
    // wrap state breaks the row's CHECK: both stay, named with Codex's wrap-up.
    const refused = undo();
    expectStatus(refused, "conflict");
    expect(refused.conflicts.map((c) => c.field)).toEqual(["wrap"]);
    const u = applied(undo({ partial: true }));
    expect(changesAt(u.seq)).toEqual([]);
    expect(task(id)).toMatchObject({ lifecycle: "completed", wrap_state: "wrapped" });
    expect(u.conflicts.map((c) => [c.field, c.version])).toEqual([
      ["wrap", wrapped],
      ["lifecycle", wrapped],
    ]);
    expect(commitAt(done.seq)["undo_status"]).toBe("undone");
  });

  test("an undo never leaves a task active with a wrap-up its commit did not write", async () => {
    const id = create();
    const archived = await archive(id);
    // Codex wraps the archived task up: the archive's lifecycle still holds Mira's write and
    // passes its own guard, but an active task with a wrap state breaks the row's CHECK.
    const wrapped = await codexWrapUp(id);
    const before = lastSeq();
    const refused = undo();
    expectStatus(refused, "conflict");
    expect(refused.error).toMatchObject({ code: "UNDO_CONFLICT" });
    expect(refused.conflicts).toMatchObject([
      {
        entity: "tasks",
        id,
        field: "lifecycle",
        value: { lifecycle: "archived" },
        wrote: { lifecycle: "archived" },
        restore: { lifecycle: "active" },
        version: wrapped,
        by: { label: "Codex · work" },
      },
    ]);
    expect(refused.conflicts).toHaveLength(1);
    expect(lastSeq()).toBe(before);
    const u = applied(undo({ partial: true }));
    expect(changesAt(u.seq)).toEqual([]);
    expect(u.conflicts).toMatchObject([{ field: "lifecycle", version: wrapped }]);
    expect(task(id)).toMatchObject({ lifecycle: "archived", wrap_state: "wrapped" });
    expect(commitAt(archived)["undo_status"]).toBe("undone");
  });

  test("a redo never leaves a task active with a wrap-up: another's undo is the conflict", async () => {
    const id = create();
    await archive(id);
    const other = await partner();
    await loneWrite(
      id,
      "wrap",
      (at) => ({
        wrap_state: "wrapped",
        outcome: "Shipped",
        wrapped_at: at,
        wrapped_by: other.principal_id,
      }),
      other,
      "task.wrap_up",
      true,
    );
    applied(history({ kind: "undo" }, other));
    const u = applied(undo());
    expect(task(id)).toMatchObject({ lifecycle: "active", wrap_state: null });
    const refused = history({ kind: "redo" }, other);
    expectStatus(refused, "conflict");
    expect(refused.conflicts).toMatchObject([
      { field: "wrap", restore: { wrap_state: "wrapped" }, version: u.seq, by: { kind: "human" } },
    ]);
    expect(task(id)).toMatchObject({ lifecycle: "active", wrap_state: null });
  });

  test("a check-off is undone and redone as one", () => {
    const id = create();
    applied(write([{ kind: "task.complete", task: id, outcome: "Shipped" }]));
    applied(undo());
    expect(task(id)).toMatchObject({
      lifecycle: "active",
      completed_at: null,
      wrap_state: null,
      outcome: null,
    });
    applied(redo());
    expect(task(id)).toMatchObject({
      lifecycle: "completed",
      wrap_state: "wrapped",
      outcome: "Shipped",
    });
  });

  test("a create is undone by tombstones and redone by restoring them", () => {
    const id = newId("t");
    const c = applied(
      write([
        { kind: "task.create", id, title: "Plant bulbs" },
        { kind: "note.add", task: id, body: "Tulips by the fence." },
        { kind: "log.add", task: id, body: "Bought the bulbs." },
        { kind: "place.set", task: id, root: "home", path: "garden" },
        {
          kind: "source.add",
          task: id,
          source: { kind: "web", title: "Planting guide", key: "web:bulbs-guide" },
        },
      ]),
    );
    const u = applied(undo());
    expect(task(id)).toMatchObject({
      deleted_at: commitAt(u.seq)["at"],
      deleted_by: fx.human.principal_id,
    });
    for (const table of ["notes", "log_entries", "places", "sources"]) {
      expect(one(`SELECT count(*) FROM ${table} WHERE deleted_at IS NULL`), table).toBe(0);
    }
    expect(one("SELECT count(*) FROM task_sources WHERE removed_at IS NULL")).toBe(0);
    // Each tombstone is a write of the undo's own: fp names it.
    expect(maps(id)).toMatchObject({ fv: { deleted: u.seq }, fp: { deleted: u.seq } });
    expect(changesAt(u.seq).map((ch) => [ch["entity"], ch["field"], ch["after_prov"]])).toEqual([
      ["tasks", "deleted", u.seq],
      ["notes", "deleted", u.seq],
      ["log_entries", "deleted", u.seq],
      ["places", "deleted", u.seq],
      ["sources", "deleted", u.seq],
      ["task_sources", "removed", u.seq],
    ]);
    expect(commitAt(u.seq)["affected"]).toBe(1);

    const r = applied(redo());
    expect(task(id)).toMatchObject({ deleted_at: null, deleted_by: null });
    for (const table of ["notes", "log_entries", "places", "sources"]) {
      expect(one(`SELECT count(*) FROM ${table} WHERE deleted_at IS NULL`), table).toBe(1);
    }
    expect(maps(id)).toMatchObject({ fv: { deleted: r.seq }, fp: { deleted: c.seq } });
    // Undone again under the first undo's guards.
    applied(undo());
    expect(task(id)["deleted_at"]).not.toBeNull();
  });

  test("another actor's child row keeps a create from being undone; the creator's own pass", () => {
    const id = create("Plant bulbs");
    const mine = patch(id, { summary: "Tulips" });
    const log = applied(write([{ kind: "log.add", task: id, body: "Checked the soil." }], "codex"));
    // Mira's own later change goes first, and her create waits for it.
    applied(undo());
    const refused = undo();
    expectStatus(refused, "conflict");
    expect(refused.conflicts).toMatchObject([
      {
        entity: "log_entries",
        id: log.results[0]?.id,
        task: id,
        ref: "M-1",
        field: "deleted",
        value: null,
        version: log.seq,
        by: { label: "Codex · work" },
      },
    ]);
    expect(task(id)["deleted_at"]).toBeNull();
    expect(commitAt(mine.seq)["undo_status"]).toBe("undone");
  });

  test("a child row that holds another's write keeps its task, in a partial undo too", () => {
    const id = newId("t");
    const c = applied(
      write([
        { kind: "task.create", id, title: "Plant bulbs" },
        { kind: "place.set", task: id, root: "home", path: "garden" },
      ]),
    );
    // Codex binds the place Mira created to another folder: its row is hers, its folder is not.
    const theirs = applied(
      write([{ kind: "place.set", task: id, root: "home", path: "garden/beds" }], "codex"),
    );
    const place = String(one("SELECT id FROM places WHERE owner_id = $id", { id }));
    const refused = undo();
    expectStatus(refused, "conflict");
    // Named once, though it blocks both the place's own create and its task's.
    expect(refused.conflicts).toMatchObject([
      { entity: "places", id: place, task: id, field: "folder", version: theirs.seq },
    ]);
    expect(refused.conflicts).toHaveLength(1);
    // A partial undo leaves the task too: a tombstone would hide Codex's folder with it.
    const u = applied(undo({ partial: true }));
    expect(changesAt(u.seq)).toEqual([]);
    expect(u.conflicts).toMatchObject([{ entity: "places", id: place, field: "folder" }]);
    expect(task(id)["deleted_at"]).toBeNull();
    expect(row("SELECT rel_path, deleted_at FROM places WHERE id = $place", { place })).toEqual({
      rel_path: "garden/beds",
      deleted_at: null,
    });
    expect(commitAt(c.seq)["undo_status"]).toBe("undone");
  });

  test("a create's child rows are read once per table, however many rows it created", () => {
    const ops: Operation[] = [];
    for (let k = 0; k < 25; k += 1) {
      const id = newId("t");
      ops.push(
        { kind: "task.create", id, title: `Fixture task ${String(k + 1)}` },
        {
          kind: "source.add",
          task: id,
          source: { kind: "web", title: "Fixture guide", key: `web:fixture-guide-${String(k)}` },
        },
      );
    }
    const c = applied(write(ops));
    // Statements that look for live child rows, counted on a connection that only reads.
    let scans = 0;
    const counting = new Proxy(fx.reader, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            if (/(deleted_at|removed_at) IS NULL/u.test(sql)) scans += 1;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const plan = planInversions(counting, readChanges(fx.reader, c.seq), {
      creating: new Set([c.seq]),
      refPrefix: "MI",
      partial: false,
      op: 0,
      principal: fx.human.principal_id,
      applied: () => c.seq,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.inversions).toHaveLength(75);
    // One per child table of a task and one for a source's links, never one per created row: a
    // commit can hold many, and a source's links have no index by source.
    expect(scans).toBeLessThanOrEqual(9);
  });

  /** A task's live learnings, in their order. */
  const learnings = (id: Id<"t">): string[] =>
    fx.reader
      .prepare(
        "SELECT id FROM learnings WHERE task_id = $id AND deleted_at IS NULL ORDER BY position",
      )
      .all({ id })
      .map((r) => String(r["id"]));

  test("an undo and a redo of a wrap-up take back and bring back its learnings", () => {
    const id = create();
    applied(write([{ kind: "task.complete", task: id }]));
    applied(
      write([
        {
          kind: "task.wrap_up",
          task: id,
          outcome: "Shipped",
          learnings: { add: ["Ask early.", "Keep notes."] },
        },
      ]),
    );
    const made = learnings(id);
    expect(made).toHaveLength(2);
    // The undo tombstones the learnings the wrap-up added and sets the wrap back.
    const u = applied(undo());
    expect(learnings(id)).toEqual([]);
    expect(task(id)).toMatchObject({ wrap_state: "pending", outcome: null });
    expect(changesAt(u.seq).map((c) => [c["entity"], c["field"]])).toEqual([
      ["tasks", "wrap"],
      ["learnings", "deleted"],
      ["learnings", "deleted"],
    ]);
    applied(redo());
    expect(learnings(id)).toEqual(made);
    expect(task(id)).toMatchObject({ wrap_state: "wrapped", outcome: "Shipped" });
    // A removal comes back with its undo.
    applied(
      write([{ kind: "task.wrap_up", task: id, learnings: { remove: [made[0] as Id<"lr">] } }]),
    );
    expect(learnings(id)).toEqual(made.slice(1));
    applied(undo());
    expect(learnings(id)).toEqual(made);
  });

  test("an undo never leaves a task with more than 20 live learnings", () => {
    const id = create();
    applied(write([{ kind: "task.complete", task: id }]));
    const texts = Array.from({ length: 20 }, (_, k) => `Fixture learning ${String(k + 1)}.`);
    applied(
      write([{ kind: "task.wrap_up", task: id, outcome: "Shipped", learnings: { add: texts } }]),
    );
    const [removed = ""] = learnings(id);
    // Mira removes one; Codex adds another, so the task holds 20 again.
    const mine = applied(
      write([{ kind: "task.wrap_up", task: id, learnings: { remove: [removed as Id<"lr">] } }]),
    );
    const theirs = applied(
      write([{ kind: "task.wrap_up", task: id, learnings: { add: ["From Codex."] } }], "codex"),
    );
    const held = learnings(id);
    expect(held).toHaveLength(20);
    // Codex's wrap-up rewrote the wrap, so the full undo conflicts there first.
    const seq = lastSeq();
    expect(undo().conflicts.map((c) => c.field)).toEqual(["wrap"]);
    expect(lastSeq()).toBe(seq);
    // A partial undo would bring the removed learning back as a 21st: it stays removed, named
    // with the 20 that hold the place, and the change leaves the stack.
    const u = applied(undo({ partial: true }));
    expect(changesAt(u.seq)).toEqual([]);
    expect(u.conflicts[0]).toMatchObject({ entity: "tasks", field: "wrap", version: theirs.seq });
    const named = u.conflicts.slice(1);
    expect(named.map((c) => [c.entity, c.id, c.field, c.task]).sort()).toEqual(
      held.map((l) => ["learnings", l, "deleted", id]).sort(),
    );
    expect(named.find((c) => c.version === theirs.seq)).toMatchObject({ by: { kind: "agent" } });
    expect(learnings(id)).toEqual(held);
    expect(commitAt(mine.seq)["undo_status"]).toBe("undone");
  });

  test("a restore never takes a place or a source key another row holds now", () => {
    const id = create();
    applied(
      write([{ kind: "place.set", task: id, root: "work", path: "lumen/portal" }], "human", {}),
    );
    applied(undo());
    // Codex binds the task's folder meanwhile: an agent's write leaves Mira's redo alive.
    const other = applied(
      write([{ kind: "place.set", task: id, root: "work", path: "lumen/api" }], "codex"),
    );
    const refused = redo();
    expectStatus(refused, "conflict");
    expect(refused.conflicts).toMatchObject([
      { entity: "places", id: other.results[0]?.id, task: id, field: "deleted", value: null },
    ]);

    const second = create("Read the guide");
    const key = "web:bulbs-guide";
    applied(
      write([{ kind: "source.add", task: second, source: { kind: "web", title: "Guide", key } }]),
    );
    applied(undo());
    const theirs = applied(
      write(
        [{ kind: "source.add", task: second, source: { kind: "web", title: "Guide", key } }],
        "codex",
      ),
    );
    const blocked = redo();
    expectStatus(blocked, "conflict");
    expect(blocked.conflicts).toMatchObject([
      { entity: "sources", id: theirs.results[0]?.id, field: "deleted" },
    ]);
  });

  test("one stack per human: every scope shares it, agents are never on it", () => {
    const id = create();
    patch(id, { summary: "From the CLI" });
    // The human's UI session is another writer scope of the same principal.
    const ui: Credential = { ...fx.human, scope_id: "ui:fixture", origin: "ui" };
    const fromUi = applied(
      fx.writer.submit(
        fx.request(ui, [{ kind: "task.patch", task: id, set: { status: "waiting" } }], {
          base: fx.base(),
          undoable: true,
        }),
      ),
    );
    const viaCli = applied(undo());
    expect(commitAt(viaCli.seq)["undo_of"]).toBe(fromUi.seq);
    const viaUi = applied(history({ kind: "undo" }, ui));
    expect(task(id)["summary"]).toBe("");
    expect(commitAt(viaUi.seq)["scope_id"]).toBe("ui:fixture");
    // An agent's commit is not undoable, and an agent cannot undo.
    patch(id, { title: "Agent title" }, "codex");
    expect(commitAt(lastSeq())["undo_status"]).toBeNull();
    expect(history({ kind: "undo" }, fx.codex).error).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "actor.actor_kind",
    });
    // An agent's write does not end the redo; the human's next undoable action does.
    applied(redo());
    patch(id, { priority: 2 });
    expect(redo().error).toMatchObject({ code: "NOTHING_TO_REDO" });
    // The undo commits themselves were never on the stack.
    expect(commitAt(viaUi.seq)["undo_status"]).toBeNull();
    expect(one("SELECT count(*) FROM commits WHERE undo_status = 'dead'")).toBe(1);
  });

  test("the named commit, nothing to undo or redo, and retries", () => {
    expect(undo().error).toMatchObject({ code: "NOTHING_TO_UNDO", op: 0 });
    expect(redo().error).toMatchObject({ code: "NOTHING_TO_REDO", op: 0 });
    const id = create();
    const older = patch(id, { summary: "Older" });
    const newer = patch(id, { summary: "Newer" });
    const olderId = older.commit ?? "op_missing";
    const newerId = newer.commit ?? "op_missing";
    expect(commitAt(newer.seq)["id"]).toBe(newerId);
    // A toast's own undo names its commit: another one on top refuses it.
    expect(undo({ commit: olderId }).error).toMatchObject({
      code: "INVALID_TRANSITION",
      field: "commit",
    });
    const request = fx.request(fx.human, [{ kind: "undo", commit: newerId }]);
    const first = applied(fx.writer.submit(request));
    // The same request again replays: it never undoes a second change.
    const again = fx.writer.submit(request);
    expect(again).toEqual({ ...first, replayed: true });
    expect(task(id)["summary"]).toBe("Older");
    expect(redo({ commit: olderId }).error).toMatchObject({ code: "INVALID_TRANSITION" });
    applied(redo({ commit: newerId }));
    expect(task(id)["summary"]).toBe("Newer");
  });

  test("the request: one operation, a human, no base, never undoable, a commit's ID", () => {
    const id = create();
    patch(id, { summary: "Mine" });
    const field = (ops: unknown[], extra: Record<string, unknown> = {}): unknown =>
      fx.writer.submit({ ...fx.request(fx.human, []), ops, ...extra }).error?.field;
    expect(field([{ kind: "undo" }, { kind: "undo" }])).toBe("ops");
    expect(field([{ kind: "undo" }, { kind: "task.patch", task: id, set: { summary: "x" } }])).toBe(
      "ops",
    );
    expect(field([{ kind: "undo" }], { base: fx.base() })).toBe("base");
    expect(field([{ kind: "undo" }], { undoable: true })).toBe("undoable");
    expect(field([{ kind: "undo" }], { active: true })).toBe("active");
    expect(field([{ kind: "undo", commit: "M-1" }])).toBe("ops[0].commit");
    expect(field([{ kind: "redo", partial: true }])).toBe("ops[0]");
    expect(task(id)["summary"]).toBe("Mine");
  });

  test("the undo floor: nothing older than the last format change is undone or redone", async () => {
    const id = create();
    const c1 = patch(id, { summary: "Before" });
    const c2 = patch(id, { summary: "After" });
    applied(undo());
    // A migration that changes a field's shape sets the floor to its commit (A1 3.10.4).
    await raw((conn) => {
      conn.prepare("UPDATE space SET undo_floor_seq = $seq").run({ seq: lastSeq() + 1 });
    });
    expect(redo().error).toMatchObject({ code: "UNDO_BEFORE_FLOOR" });
    expect(undo().error).toMatchObject({ code: "UNDO_BEFORE_FLOOR" });
    expect(commitAt(c1.seq)["undo_status"]).toBe("done");
    expect(commitAt(c2.seq)["undo_status"]).toBe("undone");
    expect(task(id)["summary"]).toBe("Before");
  });

  test("Redo passes over what it cannot apply and redoes the next step; what it passed over stays, and Undo goes back in the order applied", () => {
    const a = create("Renew the passport");
    const b = create("Book the dentist");
    const removal = applied(write([{ kind: "task.delete", task: a }]));
    const restore = applied(write([{ kind: "task.restore", task: a }]));
    patch(a, { title: "Renew both passports" });
    patch(b, { priority: 1 });
    for (let i = 0; i < 4; i += 1) applied(undo());
    applied(write([{ kind: "note.add", task: a, body: "Booked for Tuesday" }], "codex"));
    // The removal would hide Codex's note, and the restore holds what the removal wrote: both are
    // passed over. The rename is judged on A as it is, live, and redone.
    const first = applied(redo());
    expect(first.passed).toEqual([removal.commit, restore.commit]);
    // Who changed what since: Codex on A. The restore waits on the person's own removal, which is
    // no one's newer work.
    expect(first.newer).toEqual({
      work: [
        expect.objectContaining({
          task: a,
          by: expect.objectContaining({ kind: "agent" }) as unknown,
          run: false,
        }),
      ],
    });
    expect(task(a)["title"]).toBe("Renew both passports");
    expect(task(a)["deleted_at"]).toBeNull();
    // The next Redo tries both from the start again, then reaches B's edit.
    const second = applied(redo());
    expect(second.passed).toEqual([removal.commit, restore.commit]);
    expect(task(b)["priority"]).toBe(1);
    // Nothing more can be redone: refused, with the note named, and nothing is discarded.
    const third = redo();
    expectStatus(third, "conflict");
    expect(third.passed).toEqual([removal.commit, restore.commit]);
    expect(third.conflicts).toContainEqual(
      expect.objectContaining({
        entity: "notes",
        task: a,
        by: expect.objectContaining({ kind: "agent" }) as unknown,
      }),
    );
    expect(commitAt(removal.seq)["undo_status"]).toBe("undone");
    expect(commitAt(restore.seq)["undo_status"]).toBe("undone");
    expect(task(a)["deleted_at"]).toBeNull();
    // Undo takes back the step redone last first: B's edit, then the rename.
    applied(undo());
    expect(task(b)["priority"]).not.toBe(1);
    expect(task(a)["title"]).toBe("Renew both passports");
    applied(undo());
    expect(task(a)["title"]).toBe("Renew the passport");
  });

  test("a refused Redo names every author who changed the task since, each with their newest change, and no count", () => {
    const a = create("Renew the passport");
    applied(write([{ kind: "task.delete", task: a }]));
    applied(undo());
    patch(a, { title: "Renew both passports" }, "codex");
    const claude = patch(a, { title: "Renew the passports" }, "claude");
    const last = patch(a, { title: "Renew all passports" }, "codex");
    const refused = redo();
    expectStatus(refused, "conflict");
    const at = (seq: number): number => Number(commitAt(seq)["at"]);
    expect(refused.newer?.work).toEqual(
      expect.arrayContaining([
        {
          task: a,
          ref: expect.any(String) as unknown,
          by: expect.objectContaining({ actor: fx.codex.principal_id }) as unknown,
          run: false,
          at: at(last.seq),
        },
        {
          task: a,
          ref: expect.any(String) as unknown,
          by: expect.objectContaining({ actor: fx.claude.principal_id }) as unknown,
          run: false,
          at: at(claude.seq),
        },
      ]),
    );
    expect(refused.newer?.work).toHaveLength(2);
    expect(refused.newer).not.toHaveProperty("changes");
  });

  test("Undo, Redo, another's write, Redo, Undo, Redo: Redo passes over the step they changed, and Undo always takes the step applied last", async () => {
    const other = await partner();
    const a = create("Renew the passport");
    const b = create("Book the dentist");
    const c = create("Water the plants");
    const priorities = () => [a, b, c].map((id) => task(id)["priority"]);
    const before = priorities();
    patch(a, { priority: 1 });
    patch(b, { priority: 1 });
    patch(c, { priority: 1 });
    for (let i = 0; i < 3; i += 1) applied(undo());
    expect(priorities()).toEqual(before);
    // Redo: the oldest, A.
    applied(redo());
    expect(priorities()).toEqual([1, before[1], before[2]]);
    // The partner changes B's priority: B cannot be redone.
    const set = { kind: "task.patch", task: b, set: { priority: 3 } } as Operation;
    applied(fx.writer.submit(fx.request(other, [set], { base: fx.base(), undoable: true })));
    // Redo passes over B and redoes C.
    const second = applied(redo());
    expect(second.passed).toHaveLength(1);
    expect(priorities()).toEqual([1, 3, 1]);
    // Undo takes C, the step applied last, never A.
    applied(undo());
    expect(priorities()).toEqual([1, 3, before[2]]);
    // Redo passes over B again and brings C back.
    applied(redo());
    expect(priorities()).toEqual([1, 3, 1]);
    // The partner takes theirs back: B can be redone now, after C.
    applied(history({ kind: "undo" }, other));
    applied(redo());
    expect(priorities()).toEqual([1, 1, 1]);
    // Undo goes back in the order applied: B, then C, then A.
    applied(undo());
    expect(priorities()).toEqual([1, before[1], 1]);
    applied(undo());
    expect(priorities()).toEqual([1, before[1], before[2]]);
    applied(undo());
    expect(priorities()).toEqual(before);
  });

  test("Redo never brings back a project whose area is not there: passed over, it comes back after the area", async () => {
    const other = await partner();
    const area = applied(write([{ kind: "area.create", title: "Garden" }]));
    const areaId = String(area.results[0]?.id);
    const project = applied(write([{ kind: "project.create", title: "Beds", area: areaId }]));
    const projectId = String(project.results[0]?.id);
    applied(undo());
    applied(undo());
    // The partner's area takes the slug: the area cannot come back, and its project would be
    // live in an area that is not there.
    const theirs = { kind: "area.create", title: "Garden" } as Operation;
    applied(fx.writer.submit(fx.request(other, [theirs], { undoable: true })));
    const refused = redo();
    expectStatus(refused, "conflict");
    expect(refused.passed).toEqual([area.commit, project.commit]);
    // The partner took the slug: a change of no task. The project waits on the area.
    expect(refused.newer).toEqual({
      work: [
        expect.objectContaining({
          by: expect.objectContaining({ actor: other.principal_id }) as unknown,
        }),
      ],
    });
    expect(refused.newer?.work[0]?.task).toBeUndefined();
    const live = (table: "areas" | "projects", id: string) =>
      row(`SELECT deleted_at FROM ${table} WHERE id = $id`, { id })["deleted_at"] === null;
    expect([live("areas", areaId), live("projects", projectId)]).toEqual([false, false]);
    // The slug free again, Redo brings back the area, then the project in it.
    applied(history({ kind: "undo" }, other));
    applied(redo());
    expect([live("areas", areaId), live("projects", projectId)]).toEqual([true, false]);
    applied(redo());
    expect(live("projects", projectId)).toBe(true);
    expect(row("SELECT area_id FROM projects WHERE id = $id", { id: projectId })["area_id"]).toBe(
      areaId,
    );
  });

  test("Redo never brings back a link to a source that is not there, or a change to a task that is not there", async () => {
    const other = await partner();
    const ticket = { kind: "ticket", title: "Export ticket", key: "jira:FIX-7" } as const;
    const b = create("Call the clinic");
    const a = newId("t");
    const made = applied(
      write([
        { kind: "task.create", id: a, title: "Answer the clinic" },
        { kind: "source.add", task: a, source: ticket },
      ]),
    );
    const done = applied(write([{ kind: "task.complete", task: a }]));
    // A is finished: B links the same source row.
    const linked = applied(write([{ kind: "source.add", task: b, source: ticket }]));
    const source = String(linked.results[0]?.id);
    for (let i = 0; i < 3; i += 1) applied(undo());
    const liveLinks = (): number =>
      Number(
        one(
          "SELECT count(*) FROM task_sources ts JOIN sources s ON s.id = ts.source_id " +
            "WHERE ts.task_id = $b AND ts.removed_at IS NULL AND s.deleted_at IS NULL",
          { b },
        ),
      );
    // The partner's task takes the key: A cannot come back, so neither can its completion, nor
    // B's link to A's source.
    const theirs = newId("t");
    applied(
      fx.writer.submit(
        fx.request(
          other,
          [
            { kind: "task.create", id: theirs, title: "Answer the clinic" },
            { kind: "source.add", task: theirs, source: ticket },
          ],
          { undoable: true },
        ),
      ),
    );
    const refused = redo();
    expectStatus(refused, "conflict");
    expect(refused.passed).toEqual([made.commit, done.commit, linked.commit]);
    expect(
      row("SELECT removed_at FROM task_sources WHERE task_id = $b", { b })["removed_at"],
    ).not.toBeNull();
    // The key free again, each comes back in turn, and B's link is to a live source.
    applied(history({ kind: "undo" }, other));
    applied(redo());
    expect(task(a)["deleted_at"]).toBeNull();
    applied(redo());
    expect(task(a)["lifecycle"]).toBe("completed");
    applied(redo());
    expect(liveLinks()).toBe(1);
    expect(one("SELECT source_id FROM task_sources WHERE task_id = $b", { b })).toBe(source);
  });

  test("Redo of an archive or a check-off after someone added to the task is refused, naming that work, and the task stays open", () => {
    for (const kind of ["task.archive", "task.complete"] as const) {
      const a = create("Renew the passport");
      applied(write([{ kind, task: a }]));
      applied(undo());
      applied(write([{ kind: "note.add", task: a, body: "Booked for Tuesday" }], "codex"));
      const late = redo();
      expectStatus(late, "conflict");
      expect(late.conflicts, kind).toEqual([expect.objectContaining({ entity: "notes", task: a })]);
      expect(late.newer?.work, kind).toEqual([
        expect.objectContaining({
          task: a,
          by: expect.objectContaining({ actor: fx.codex.principal_id }) as unknown,
        }),
      ]);
      expect(task(a)["lifecycle"], kind).toBe("active");
    }
  });

  test("Undo of a reopen after someone added to the task is refused the same way; its partial form leaves the task open", () => {
    const a = create("Renew the passport");
    applied(write([{ kind: "task.complete", task: a }], "codex"));
    applied(write([{ kind: "task.reopen", task: a }]));
    applied(write([{ kind: "note.add", task: a, body: "Booked for Tuesday" }], "codex"));
    const late = undo();
    expectStatus(late, "conflict");
    expect(late.conflicts).toEqual([expect.objectContaining({ entity: "notes", task: a })]);
    expect(task(a)["lifecycle"]).toBe("active");
    const partial = applied(undo({ partial: true }));
    expect(partial.conflicts).toEqual([expect.objectContaining({ entity: "notes", task: a })]);
    expect([task(a)["lifecycle"], task(a)["wrap_state"]]).toEqual(["active", null]);
  });

  test("a refused Undo names, for each task, who changed it after the step last wrote it, not before a redo wrote it again", () => {
    const a = create("Renew the passport");
    const b = create("Book the dentist");
    applied(
      write([
        { kind: "task.patch", task: a, set: { summary: "Mine" } },
        { kind: "task.patch", task: b, set: { summary: "Mine too" } },
      ]),
    );
    patch(b, { summary: "Codex's" }, "codex");
    // Claude's note on A comes before the redo that writes A again.
    applied(write([{ kind: "note.add", task: a, body: "Booked for Tuesday" }], "claude"));
    applied(undo({ partial: true }));
    expect([task(a)["summary"], task(b)["summary"]]).toEqual(["", "Codex's"]);
    applied(redo());
    expect(task(a)["summary"]).toBe("Mine");
    patch(a, { summary: "Codex's too" }, "codex");
    const refused = undo();
    expectStatus(refused, "conflict");
    const named = (refused.newer?.work ?? []).map((w) => `${String(w.task)} ${w.by.actor}`);
    expect(named.sort()).toEqual(
      [`${a} ${fx.codex.principal_id}`, `${b} ${fx.codex.principal_id}`].sort(),
    );
  });

  test("an Undo that a restored task keeps from deleting its project names the restore", async () => {
    const other = await partner();
    const t = newId("t");
    applied(
      write(
        [{ kind: "task.create", id: t, title: "Renew the passport", project: fx.project }],
        "codex",
      ),
    );
    applied(write([{ kind: "task.delete", task: t }]));
    applied(write([{ kind: "project.delete", project: fx.project }]));
    applied(write([{ kind: "project.restore", project: fx.project }]));
    const restore = { kind: "task.restore", task: t } as Operation;
    applied(fx.writer.submit(fx.request(other, [restore], { base: fx.base(), undoable: true })));
    const refused = undo();
    expectStatus(refused, "conflict");
    expect(refused.conflicts).toEqual([
      expect.objectContaining({
        entity: "tasks",
        id: t,
        by: expect.objectContaining({ actor: other.principal_id }) as unknown,
      }),
    ]);
    expect(row("SELECT deleted_at FROM projects WHERE id = $id", { id: fx.project })).toEqual({
      deleted_at: null,
    });
  });

  test("Redo writes what its step wrote under a task the step moved to the Trash, and moves a task a Redo before it put back there", () => {
    // A note and the move to the Trash in one request.
    const a = create("Renew the passport");
    applied(
      write([
        { kind: "note.add", task: a, body: "Booked for Tuesday" },
        { kind: "task.delete", task: a },
      ]),
    );
    applied(undo());
    applied(redo());
    expect(task(a)["deleted_at"]).not.toBeNull();
    expect(one("SELECT count(*) FROM notes WHERE task_id = $a AND deleted_at IS NULL", { a })).toBe(
      1,
    );

    // A task in the Trash that its project's move took along.
    const b = newId("t");
    applied(write([{ kind: "task.create", id: b, title: "Dig", project: fx.project }]));
    applied(write([{ kind: "task.delete", task: b }]));
    applied(write([{ kind: "project.move", project: fx.project, area: fx.areas.home }]));
    applied(undo());
    applied(undo());
    applied(redo());
    applied(redo());
    expect([task(b)["area_id"], task(b)["deleted_at"] === null]).toEqual([fx.areas.home, false]);
  });
});
