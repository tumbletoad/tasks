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
import { checkHistory, expectStatus, writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("undo");
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

/**
 * Codex's wrap-up as M3.04's `task.wrap_up` will write it: a commit that sets the task's wrap field
 * to `wrapped` with an outcome, with its change row, versions, touched mark and outbox row.
 */
async function codexWrapUp(id: Id<"t">): Promise<number> {
  let done = 0;
  await raw((conn) => {
    const seq = Number(conn.prepare("SELECT last_seq FROM space").get()?.["last_seq"]) + 1;
    const at = Number(conn.prepare("SELECT max(at) AS at FROM commits").get()?.["at"]) + 1000;
    const space = conn.prepare("SELECT * FROM space").get();
    const t = conn.prepare("SELECT * FROM tasks WHERE id = $id").get({ id });
    if (space === undefined || t === undefined) throw new Error("no task");
    const fv = JSON.parse(String(t["fv"])) as Record<string, number>;
    const fp = JSON.parse(String(t["fp"])) as Record<string, number>;
    const wrap = (r: Row) =>
      JSON.stringify({
        wrap_state: r["wrap_state"] ?? null,
        outcome: r["outcome"] ?? null,
        wrapped_at: r["wrapped_at"] ?? null,
        wrapped_by: r["wrapped_by"] ?? null,
      });
    const after = {
      wrap_state: "wrapped",
      outcome: "Shipped",
      wrapped_at: at,
      wrapped_by: fx.codex.principal_id,
    };
    conn
      .prepare(
        "INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id, " +
          "author_id, scope_id, machine_id, origin, request_id, kind, ops) VALUES ($seq, $op, " +
          "$epoch, $incarnation, $at, 'agent', $codex, $codex, 'grant:codex', $machine, 'mcp', " +
          "$request, 'ops', $ops)",
      )
      .run({
        seq,
        op: newId("op"),
        epoch: space["authority_epoch"] as number,
        incarnation: space["authority_incarnation"] as string,
        at,
        codex: fx.codex.principal_id,
        machine: TEST_MACHINE,
        request: newId("op").slice(3),
        ops: JSON.stringify([{ v: 1, op: "task.wrap_up", target: id, input: { task: id } }]),
      });
    conn
      .prepare(
        "INSERT INTO changes (seq, n, op, entity, entity_id, task_id, action, field, before, " +
          "after, before_ver, before_prov, after_prov) VALUES ($seq, 1, 0, 'tasks', $id, $id, " +
          "'set', 'wrap', $before, $after, $ver, $prov, $seq)",
      )
      .run({
        seq,
        id,
        before: wrap(t),
        after: JSON.stringify(after),
        ver: fv["wrap"] ?? (t["created_seq"] as number),
        prov: fp["wrap"] ?? (t["created_seq"] as number),
      });
    conn
      .prepare(
        "UPDATE tasks SET wrap_state = $wrap_state, outcome = $outcome, wrapped_at = $wrapped_at, " +
          "wrapped_by = $wrapped_by, version = $seq, touched = $seq, fv = $fv, fp = $fp WHERE id = $id",
      )
      .run({
        ...after,
        seq,
        id,
        fv: JSON.stringify({ ...fv, wrap: seq }),
        fp: JSON.stringify({ ...fp, wrap: seq }),
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
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.inversions).toHaveLength(75);
    // One per child table of a task and one for a source's links, never one per created row: an
    // importer's commit holds thousands, and a source's links have no index by source.
    expect(scans).toBeLessThanOrEqual(8);
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
});
