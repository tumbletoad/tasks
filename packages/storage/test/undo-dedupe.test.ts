// Undo and redo meet dedupe by source key (A1 3.6, 3.10, 3.10.1; A7 3.10 M3.02, M3.06): two steps
// built side by side, checked together. Fixed scenarios first: an undo of a request whose draft
// matched a task takes back only what the request wrote on the match; an undone create holds no
// key; a redo never brings back a second active holder of a key, whether the key's source row is
// taken (the unique key) or shared (the holder rule), in either order of two humans' redos; an
// undo or redo never shares a request with a create, and dedupe's start state sees what they
// left; a check-off undone is no finish, and a finish set back keeps its own instant; a receipt
// replays after an undo; a link an undo removed comes back only with its link version. Then a
// property test: overlapping keys, completions, reopens, undo and redo of two humans together.
// Fixture text only.
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Connection } from "../src/driver.ts";
import { newId, type Id } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import {
  expectedDocuments,
  storedDocuments,
  type SearchDocument,
} from "../src/search/documents.ts";
import { CHILD_FIELDS, columnsValue, TASK_FIELDS } from "../src/write/fields.ts";
import { redoTarget, undoTarget } from "../src/write/history.ts";
import type {
  Credential,
  Operation,
  SourceFields,
  TaskCreate,
  WriteRequest,
  WriteResult,
} from "../src/write/request.ts";
import { checkedDriver, TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("undo-dedupe");
afterAll(temp.cleanup);

const DAY = 86_400_000;

type Row = Record<string, unknown>;

const ticket = (key: string): SourceFields => ({ kind: "ticket", title: "Export ticket", key });

interface Draft {
  id: Id<"t">;
  ops: Operation[];
}

/** A draft as A3's `add_tasks` sends it: its task.create, then its log entry and its sources. */
function draft(
  keys: readonly string[],
  options: { dedupe?: TaskCreate["dedupe"]; link?: boolean; log?: string } = {},
): Draft {
  const id = newId("t");
  const ops: Operation[] = [
    {
      kind: "task.create",
      id,
      title: "Answer the clinic",
      ...(options.dedupe === undefined ? {} : { dedupe: options.dedupe }),
      ...(options.link === true ? { link_sources: true } : {}),
    },
  ];
  if (options.log !== undefined) ops.push({ kind: "log.add", task: id, body: options.log });
  for (const key of keys) ops.push({ kind: "source.add", task: id, source: ticket(key) });
  return { id, ops };
}

/** A second human of a space, with an undo stack of its own. */
async function secondHuman(space: Fixture): Promise<Credential> {
  const id = newId("ac");
  const conn = openWriter(await checkedDriver(), join(space.folder, "space.db"));
  try {
    conn.transaction("immediate", () => {
      conn
        .prepare(
          "INSERT INTO actors (id, kind, label, instance_id, routine_id, created_at) " +
            "VALUES ($id, 'human', 'Fixture partner', NULL, NULL, 0)",
        )
        .run({ id });
    });
  } finally {
    conn.close();
  }
  return { ...space.human, principal_id: id, scope_id: "cli:partner" };
}

/**
 * Each key's holders as A1 3.6 defines them, with their lifecycles: the tasks that are not deleted
 * and that a live link joins to the live source with the key.
 */
function keyHolders(conn: Connection): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const rows = conn
    .prepare(
      "SELECT s.source_key AS key, t.id AS task, t.lifecycle AS lifecycle FROM sources s " +
        "JOIN task_sources ts ON ts.source_id = s.id JOIN tasks t ON t.id = ts.task_id " +
        "WHERE s.source_key IS NOT NULL AND s.deleted_at IS NULL AND ts.removed_at IS NULL " +
        "AND t.deleted_at IS NULL",
    )
    .all();
  for (const r of rows) {
    const key = String(r["key"]);
    const held = out.get(key) ?? new Map<string, string>();
    held.set(String(r["task"]), String(r["lifecycle"]));
    out.set(key, held);
  }
  return out;
}

const holdersOf = (conn: Connection, key: string): string[] =>
  [...(keyHolders(conn).get(key)?.keys() ?? [])].sort();

const activeOf = (conn: Connection, key: string): string[] =>
  [...(keyHolders(conn).get(key) ?? [])]
    .filter(([, lifecycle]) => lifecycle === "active")
    .map(([task]) => task)
    .sort();

const changesAt = (conn: Connection, seq: number): Row[] =>
  conn.prepare("SELECT * FROM changes WHERE seq = $seq ORDER BY n").all({ seq });

describe("[A1.5.history.dedupe] undo and redo meet dedupe by source key", () => {
  let fx: Fixture;
  let partner: Credential;
  /** The writer's clock: one second per request, and whole days when a test says so. */
  const clock = { now: 0 };

  beforeEach(async () => {
    fx = await writeFixture(temp.make());
    partner = await secondHuman(fx);
    // After the fixture's own commits, so every commit instant comes from this clock.
    clock.now = Date.UTC(2026, 10, 13, 8);
    fx.reopen({ now: () => (clock.now += 1000) });
  });
  afterEach(() => {
    checkHistory(fx.reader);
    fx.close();
  });

  type Who = "human" | "partner" | "codex";
  const as = (who: Who): Credential => (who === "partner" ? partner : fx[who]);
  /** A request as `who`. A human's joins its undo stack, as the service sends every human write. */
  const send = (who: Who, ops: Operation[], extra: Partial<WriteRequest> = {}): WriteResult =>
    fx.writer.submit(
      fx.request(as(who), ops, { ...(who === "codex" ? {} : { undoable: true }), ...extra }),
    );
  const applied = (result: WriteResult): WriteResult => {
    expectStatus(result, "applied");
    return result;
  };
  const undo = (who: "human" | "partner" = "human"): WriteResult =>
    fx.writer.submit(fx.request(as(who), [{ kind: "undo" }]));
  const redo = (who: "human" | "partner" = "human"): WriteResult =>
    fx.writer.submit(fx.request(as(who), [{ kind: "redo" }]));
  const lifecycle = (kind: "task.complete" | "task.reopen", task: Id<"t">, who: Who = "codex") =>
    applied(send(who, [{ kind, task }], { base: fx.base() }));
  const one = (sql: string, params = {}): unknown =>
    Object.values(fx.reader.prepare(sql).get(params) ?? {})[0];
  const lastSeq = (): number => Number(one("SELECT last_seq FROM space"));
  const task = (id: string): Row =>
    fx.reader.prepare("SELECT * FROM tasks WHERE id = $id").get({ id }) ?? {};
  const deleted = (id: string): boolean => task(id)["deleted_at"] !== null;
  const ref = (id: string): string => `M-${String(task(id)["ref"])}`;
  const liveLogs = (id: string): unknown =>
    one("SELECT count(*) FROM log_entries WHERE task_id = $id AND deleted_at IS NULL", { id });
  const sourceOf = (key: string): string =>
    String(one("SELECT id FROM sources WHERE source_key = $key AND deleted_at IS NULL", { key }));
  /** What a fresh draft with `keys` finds now: Codex's, which no undo can reach. */
  const probe = (keys: string[], options: Parameters<typeof draft>[1] = {}): WriteResult =>
    send("codex", draft(keys, options).ops);

  test("an undo of a request whose draft matched takes back what it wrote on the match, never the match", () => {
    const x = draft(["jira:FIX-1"]);
    applied(send("codex", x.ops));
    const matchBefore = task(x.id);
    // One request: a created task and a draft that matches X, whose log, and with link_sources
    // whose sources, go on with X.
    const a = draft(["jira:FIX-2"]);
    const b = draft(["jira:FIX-1", "jira:FIX-3"], { link: true, log: "Asked again." });
    const r = applied(send("human", [...a.ops, ...b.ops]));
    expect(r.results.map((o) => [o.status, o.task ?? o.id])).toEqual([
      ["created", a.id],
      ["created", a.id],
      ["existing", x.id],
      ["created", x.id],
      ["unchanged", x.id],
      ["created", x.id],
    ]);
    const ops = JSON.parse(
      String(one("SELECT ops FROM commits WHERE seq = $seq", { seq: r.seq })),
    ) as Row[];
    // The matched create holds no text of the draft: only that it matched, and the task.
    expect(ops[2]).toEqual({ v: 1, op: "task.create", target: x.id, input: { existing: true } });
    const fix3 = sourceOf("jira:FIX-3");

    const u = applied(undo());
    // The request created A, its source and link, X's log entry, FIX-3's source and X's link to
    // it: exactly those are tombstoned. X itself was never the request's to take back.
    expect(
      changesAt(fx.reader, u.seq).map((c) => [c["entity"], c["entity_id"], c["field"]]),
    ).toEqual([
      ["tasks", a.id, "deleted"],
      ["sources", r.results[1]?.id, "deleted"],
      ["task_sources", `${a.id}|${String(r.results[1]?.id)}`, "removed"],
      ["log_entries", r.results[3]?.id, "deleted"],
      ["sources", fix3, "deleted"],
      ["task_sources", `${x.id}|${fix3}`, "removed"],
    ]);
    const matchAfter = task(x.id);
    for (const column of ["deleted_at", "lifecycle", "title", "version", "fv", "fp"]) {
      expect(matchAfter[column], column).toEqual(matchBefore[column]);
    }
    expect(liveLogs(x.id)).toBe(0);
    expect(holdersOf(fx.reader, "jira:FIX-1")).toEqual([x.id]);
    expect(holdersOf(fx.reader, "jira:FIX-2")).toEqual([]);
    expect(holdersOf(fx.reader, "jira:FIX-3")).toEqual([]);
    // Dedupe sees the space the undo left: X still holds its key.
    expect(probe(["jira:FIX-1"]).results[0]).toMatchObject({ status: "existing", id: x.id });

    // The redo brings back what the undo took, X's log and link included.
    applied(redo());
    expect(deleted(a.id)).toBe(false);
    expect(liveLogs(x.id)).toBe(1);
    expect(holdersOf(fx.reader, "jira:FIX-2")).toEqual([a.id]);
    expect(holdersOf(fx.reader, "jira:FIX-3")).toEqual([x.id]);

    // Undone again, its keys are free, and new tasks take them: the next redo would make a
    // second active holder of each, so it is a conflict naming them, and writes nothing.
    applied(undo());
    const c2 = draft(["jira:FIX-2"]);
    const c3 = draft(["jira:FIX-3"]);
    applied(send("codex", [...c2.ops, ...c3.ops]));
    const seq = lastSeq();
    const refused = redo();
    expectStatus(refused, "conflict");
    expect(refused.error?.code).toBe("UNDO_CONFLICT");
    const s2 = sourceOf("jira:FIX-2");
    const s3 = sourceOf("jira:FIX-3");
    expect(refused.conflicts.map((c) => [c.entity, c.id, c.field, c.ref]).sort()).toEqual(
      [
        ["sources", s2, "deleted", undefined],
        ["sources", s3, "deleted", undefined],
        ["task_sources", `${c2.id}|${s2}`, "removed", ref(c2.id)],
        ["task_sources", `${c3.id}|${s3}`, "removed", ref(c3.id)],
      ].sort(),
    );
    expect(lastSeq()).toBe(seq);
    expect(deleted(a.id)).toBe(true);
    expect(liveLogs(x.id)).toBe(0);
    expect(activeOf(fx.reader, "jira:FIX-3")).toEqual([c3.id]);
  });

  test("an undone create holds no key, and its redo never takes a key whose source row another task now holds", () => {
    const a = draft(["jira:FIX-1"]);
    applied(send("human", a.ops));
    applied(undo());
    expect(holdersOf(fx.reader, "jira:FIX-1")).toEqual([]);
    const b = draft(["jira:FIX-1"]);
    const made = applied(send("codex", b.ops));
    expect(made.results[0]).toMatchObject({ status: "created", id: b.id });
    const source = String(made.results[1]?.id);

    const seq = lastSeq();
    const refused = redo();
    expectStatus(refused, "conflict");
    // The source row with the key (the unique index), and B, the active task that holds it:
    // never two live tasks with one key, never a constraint error.
    expect(refused.conflicts).toMatchObject([
      { entity: "sources", id: source, field: "deleted" },
      {
        entity: "task_sources",
        id: `${b.id}|${source}`,
        task: b.id,
        ref: ref(b.id),
        field: "removed",
        value: null,
        version: made.seq,
        by: { label: "Codex · work" },
      },
    ]);
    expect(refused.conflicts).toHaveLength(2);
    expect(lastSeq()).toBe(seq);
    expect(deleted(a.id)).toBe(true);
    // Finished, B still holds the source row: the unique key alone keeps A's redo off.
    lifecycle("task.complete", b.id);
    const again = redo();
    expectStatus(again, "conflict");
    expect(again.conflicts.map((c) => [c.entity, c.id])).toEqual([["sources", source]]);
    expect(holdersOf(fx.reader, "jira:FIX-1")).toEqual([b.id]);
  });

  test("a redo never brings back a second active holder of a shared source; a finished holder never blocks", () => {
    // Y finished with the key; A is created beside it with dedupe new, linking Y's source.
    const y = draft(["jira:FIX-1"]);
    applied(send("codex", y.ops));
    lifecycle("task.complete", y.id);
    const shared = sourceOf("jira:FIX-1");
    const a = draft(["jira:FIX-1"], { dedupe: "new" });
    applied(send("human", a.ops));
    applied(undo());
    // The undo removes A's link, never the source it did not create.
    expect(sourceOf("jira:FIX-1")).toBe(shared);
    expect(holdersOf(fx.reader, "jira:FIX-1")).toEqual([y.id]);
    const b = draft(["jira:FIX-1"], { dedupe: "new" });
    const made = applied(send("codex", b.ops));

    const seq = lastSeq();
    const refused = redo();
    expectStatus(refused, "conflict");
    expect(refused.conflicts).toMatchObject([
      {
        entity: "task_sources",
        id: `${b.id}|${shared}`,
        task: b.id,
        ref: ref(b.id),
        field: "removed",
        value: null,
        version: made.seq,
        by: { label: "Codex · work" },
      },
    ]);
    expect(refused.conflicts).toHaveLength(1);
    expect(lastSeq()).toBe(seq);
    expect(deleted(a.id)).toBe(true);

    // Once B is finished too, A comes back beside the finished tasks, as dedupe new makes it.
    lifecycle("task.complete", b.id);
    applied(redo());
    expect(holdersOf(fx.reader, "jira:FIX-1")).toEqual([a.id, b.id, y.id].sort());
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([a.id]);
    expect(probe(["jira:FIX-1"]).results[0]).toMatchObject({ status: "existing", id: a.id });
  });

  test("two humans' creates of one key, undone, then redone in either order: the first back holds the key, the other's redo names it", () => {
    for (const path of ["own source", "shared source"] as const) {
      for (const first of ["human", "partner"] as const) {
        const key = `jira:${path === "own source" ? "OWN" : "SHARED"}-${first}`;
        if (path === "shared source") {
          // A finished task holds the key first, so both creates link its source.
          const y = draft([key]);
          applied(send("codex", y.ops));
          lifecycle("task.complete", y.id);
        }
        const dedupe = path === "own source" ? "source_key" : "new";
        const a = draft([key], { dedupe });
        applied(send("human", a.ops));
        applied(undo("human"));
        const b = draft([key], { dedupe });
        expect(applied(send("partner", b.ops)).results[0]).toMatchObject({ status: "created" });
        applied(undo("partner"));
        const second = first === "human" ? "partner" : "human";
        const [back, held] = first === "human" ? [a.id, b.id] : [b.id, a.id];
        applied(redo(first));
        const linked = String(
          one(
            "SELECT ts.source_id FROM task_sources ts JOIN sources s ON s.id = ts.source_id " +
              "WHERE ts.task_id = $task AND s.source_key = $key",
            { task: back, key },
          ),
        );
        const seq = lastSeq();
        const refused = redo(second);
        expectStatus(refused, "conflict");
        const holder = {
          entity: "task_sources",
          id: `${back}|${linked}`,
          task: back,
          ref: ref(back),
          field: "removed",
          by: { actor: as(first).principal_id },
        };
        // With its own source the key's row is taken as well; a shared source is one row.
        expect(refused.conflicts).toMatchObject(
          path === "own source"
            ? [{ entity: "sources", id: linked, field: "deleted" }, holder]
            : [holder],
        );
        expect(lastSeq()).toBe(seq);
        expect(deleted(held)).toBe(true);
        expect(activeOf(fx.reader, key)).toEqual([back]);
      }
    }
  });

  test("an undo or redo never shares a request with a create; dedupe's start state sees what an undo tombstoned and a redo restored", () => {
    const receipts = one("SELECT count(*) FROM receipts");
    const keyed = draft(["jira:FIX-1"]);
    for (const ops of [
      [{ kind: "undo" }, ...keyed.ops],
      [...keyed.ops, { kind: "redo" }],
    ] as Operation[][]) {
      const result = fx.writer.submit(fx.request(fx.human, ops));
      expect(result.status).toBe("rejected");
      expect(result.error).toMatchObject({ code: "VALIDATION_FAILED", field: "ops" });
    }
    // Refused from the input alone: no receipt, no commit, no task.
    expect(one("SELECT count(*) FROM receipts")).toBe(receipts);
    expect(one("SELECT count(*) FROM tasks")).toBe(0);

    // A task an undo tombstoned holds nothing: a draft with its key, even with dedupe new, is new.
    const a = draft(["jira:FIX-1"]);
    applied(send("human", a.ops));
    applied(undo());
    const fresh = probe(["jira:FIX-1"], { dedupe: "new" });
    expect(fresh.results[0]).toMatchObject({ status: "created" });
    // A task a redo restored holds its key again: a draft finds it, dedupe new is refused.
    const c = draft(["jira:FIX-2"]);
    applied(send("human", c.ops));
    applied(undo());
    applied(redo());
    expect(probe(["jira:FIX-2"]).results[0]).toMatchObject({
      status: "existing",
      id: c.id,
      lifecycle: "active",
    });
    expect(probe(["jira:FIX-2"], { dedupe: "new" }).error).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "dedupe",
    });
  });

  test("a check-off undone is no finish, and a finish an undo or redo sets back keeps its own instant", async () => {
    // Completed: the redo brings back the first completed_at with the lifecycle.
    const a = draft(["jira:FIX-1"]);
    applied(send("codex", a.ops));
    lifecycle("task.complete", a.id, "human");
    const finished = task(a.id)["completed_at"];
    expect(probe(["jira:FIX-1"]).results[0]).toMatchObject({ lifecycle: "completed" });
    clock.now += 31 * DAY;
    // Undone, the check-off is no finish: the task is active, and a draft follows it.
    applied(undo());
    expect(probe(["jira:FIX-1"]).results[0]).toMatchObject({
      status: "existing",
      id: a.id,
      lifecycle: "active",
    });
    const r = applied(redo());
    expect(task(a.id)["completed_at"]).toBe(finished);
    expect(JSON.parse(String(task(a.id)["fv"]))).toMatchObject({ lifecycle: r.seq });
    // It finished at its first completion, before the window, never at the redo: new work.
    expect(probe(["jira:FIX-1"]).results[0]).toMatchObject({ status: "created" });

    // A reopen undone: the task finished when it first did.
    const c = draft(["jira:FIX-2"]);
    applied(send("codex", c.ops));
    lifecycle("task.complete", c.id);
    clock.now += 31 * DAY;
    lifecycle("task.reopen", c.id, "human");
    expect(probe(["jira:FIX-2"]).results[0]).toMatchObject({ status: "existing", id: c.id });
    applied(undo());
    expect(probe(["jira:FIX-2"]).results[0]).toMatchObject({ status: "created" });

    // An archived task has no completed_at: it finished at the commit whose write its lifecycle
    // holds, which an undo of its reopen sets back to the archive, though the undo wrote it last.
    const d = draft(["jira:FIX-3"]);
    applied(send("codex", d.ops));
    const archived = await archive(d.id);
    clock.now += 31 * DAY;
    lifecycle("task.reopen", d.id, "human");
    const u = applied(undo());
    expect(task(d.id)["lifecycle"]).toBe("archived");
    expect(JSON.parse(String(task(d.id)["fv"]))).toMatchObject({ lifecycle: u.seq });
    expect(JSON.parse(String(task(d.id)["fp"]))).toMatchObject({ lifecycle: archived });
    expect(probe(["jira:FIX-3"]).results[0]).toMatchObject({ status: "created" });
  });

  /**
   * Codex's archive as M3.04's `task.archive` will write it: the lifecycle alone, with no
   * completion time, its change row, versions, touched mark and outbox row, between requests.
   */
  async function archive(id: Id<"t">): Promise<number> {
    const conn = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
    let done = 0;
    try {
      conn.transaction("immediate", () => {
        const space = conn.prepare("SELECT * FROM space").get();
        const t = conn.prepare("SELECT * FROM tasks WHERE id = $id").get({ id });
        if (space === undefined || t === undefined) throw new Error("no task");
        const seq = Number(space["last_seq"]) + 1;
        const at = Number(conn.prepare("SELECT max(at) AS at FROM commits").get()?.["at"]) + 1000;
        const fv = JSON.parse(String(t["fv"])) as Record<string, number>;
        const fp = JSON.parse(String(t["fp"])) as Record<string, number>;
        const columns = TASK_FIELDS.lifecycle;
        const after = {
          lifecycle: "archived",
          completed_at: null,
          completed_by: null,
          archived_reason: "Not needed now",
        };
        conn
          .prepare(
            "INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id, " +
              "author_id, scope_id, machine_id, origin, request_id, kind, ops) VALUES ($seq, $op, " +
              "$epoch, $incarnation, $at, 'agent', $actor, $actor, $scope, $machine, 'mcp', " +
              "$request, 'ops', $ops)",
          )
          .run({
            seq,
            op: newId("op"),
            epoch: space["authority_epoch"] as number,
            incarnation: space["authority_incarnation"] as string,
            at,
            actor: fx.codex.principal_id,
            scope: fx.codex.scope_id,
            machine: TEST_MACHINE,
            request: newId("op").slice(3),
            ops: JSON.stringify([{ v: 1, op: "task.archive", target: id, input: { task: id } }]),
          });
        conn
          .prepare(
            "INSERT INTO changes (seq, n, op, entity, entity_id, task_id, action, field, before, " +
              "after, before_ver, before_prov, after_prov) VALUES ($seq, 1, 0, 'tasks', $id, $id, " +
              "'set', 'lifecycle', $before, $after, $ver, $prov, $seq)",
          )
          .run({
            seq,
            id,
            before: JSON.stringify(columnsValue(t, columns)),
            after: JSON.stringify(after),
            ver: fv["lifecycle"] ?? (t["created_seq"] as number),
            prov: fp["lifecycle"] ?? (t["created_seq"] as number),
          });
        conn
          .prepare(
            "UPDATE tasks SET lifecycle = $lifecycle, completed_at = $completed_at, " +
              "completed_by = $completed_by, archived_reason = $archived_reason, version = $seq, " +
              "touched = $seq, fv = $fv, fp = $fp WHERE id = $id",
          )
          .run({
            ...after,
            seq,
            id,
            fv: JSON.stringify({ ...fv, lifecycle: seq }),
            fp: JSON.stringify({ ...fp, lifecycle: seq }),
          });
        conn
          .prepare(
            "INSERT INTO outbox (topic, key, first_seq, seq) VALUES ('projection', $key, $seq, " +
              "$seq) ON CONFLICT (topic, key) DO UPDATE SET seq = excluded.seq",
          )
          .run({ key: id, seq });
        conn.prepare("UPDATE space SET last_seq = $seq").run({ seq });
        done = seq;
      });
    } finally {
      conn.close();
    }
    return done;
  }

  test("a retry after an undo replays its first answer: an existing stays existing, a create stays undone", () => {
    const x = draft(["jira:FIX-1"]);
    applied(send("codex", x.ops));
    const found = fx.request(fx.human, draft(["jira:FIX-1"], { log: "Asked again." }).ops, {
      undoable: true,
    });
    const first = applied(fx.writer.submit(found));
    expect(first.results[0]).toMatchObject({ status: "existing", id: x.id });
    applied(undo());
    const seq = lastSeq();
    // The receipt is looked up first (A1 3.8): the same answer, and nothing written again.
    expect(fx.writer.submit(found)).toEqual({ ...first, replayed: true });
    expect(lastSeq()).toBe(seq);
    expect(liveLogs(x.id)).toBe(0);

    const a = draft(["jira:FIX-2"]);
    const created = fx.request(fx.human, a.ops, { undoable: true });
    const made = applied(fx.writer.submit(created));
    applied(undo());
    const tasks = one("SELECT count(*) FROM tasks");
    expect(fx.writer.submit(created)).toEqual({ ...made, replayed: true });
    expect(one("SELECT count(*) FROM tasks")).toBe(tasks);
    expect(deleted(a.id)).toBe(true);
    expect(holdersOf(fx.reader, "jira:FIX-2")).toEqual([]);
  });

  test("a link an undo removed comes back only with its link version: a later draft's add_sources never revives it unseen", () => {
    // Y finished with FIX-2; X is the active task with FIX-1.
    const y = draft(["jira:FIX-2"]);
    applied(send("codex", y.ops));
    lifecycle("task.complete", y.id);
    const x = draft(["jira:FIX-1"]);
    applied(send("codex", x.ops));
    const shared = sourceOf("jira:FIX-2");
    // The human's draft matches X and links FIX-2's source to it; the undo removes that link.
    applied(send("human", draft(["jira:FIX-1", "jira:FIX-2"], { link: true }).ops));
    const u = applied(undo());
    expect(holdersOf(fx.reader, "jira:FIX-2")).toEqual([y.id]);
    // Codex's draft matches X again and would revive the link the undo removed: it needs the
    // link's version, and the refusal names who removed it (A1 3.5).
    const again = probe(["jira:FIX-1", "jira:FIX-2"], { link: true });
    expect(again.status).toBe("rejected");
    expect(again.error).toMatchObject({ code: "BASE_REQUIRED", field: "link_version" });
    expect(again.conflicts).toMatchObject([
      { entity: "task_sources", id: `${x.id}|${shared}`, field: "removed", version: u.seq },
    ]);
    expect(holdersOf(fx.reader, "jira:FIX-2")).toEqual([y.id]);
    // The human's redo revives it: Y is finished, so X is the one active holder.
    applied(redo());
    expect(activeOf(fx.reader, "jira:FIX-2")).toEqual([x.id]);
  });
});

// ---------------------------------------------------------------------------------------------
// Property: overlapping keys, completions, reopens, undo and redo of two humans together.

const KEYS = ["jira:FIX-1", "jira:FIX-2", "email:<3@x>"];

/** A draft's `on_existing` as A3 3.4.5 maps it onto A1 3.6: return, add_sources, create_new. */
type Mode = "return" | "link" | "new";

interface DraftSpec {
  keys: number[];
  mode: Mode;
  log: boolean;
}

/** Actors by index: the human (0) and a partner (1), each with an undo stack, and Codex (2). */
type Step =
  | { kind: "add"; actor: number; drafts: DraftSpec[] }
  | { kind: "complete" | "reopen"; actor: number; pick: number }
  | { kind: "undo"; who: number; partial: boolean }
  | { kind: "redo"; who: number }
  | { kind: "cycle"; who: number }
  /** Codex completes every active task that holds the key. */
  | { kind: "finish"; key: number }
  /**
   * Two creates of one key around an undo, then the redo: `who` creates a task with the key
   * beside its finished holders (sharing their source row), undoes it, `other` creates one too,
   * and `who` redoes.
   */
  | { kind: "rival"; who: number; other: number; key: number }
  | { kind: "retry"; pick: number }
  /** The clock moves past the window: a task finished before then no longer matches. */
  | { kind: "jump" };

const actor = fc.constantFrom(0, 0, 1, 1, 2);
const who = fc.constantFrom(0, 1);
const draftSpec: fc.Arbitrary<DraftSpec> = fc.record({
  keys: fc.uniqueArray(fc.nat({ max: KEYS.length - 1 }), { minLength: 1, maxLength: 2 }),
  // `new` often: a task beside finished ones shares their source row, which only the holder
  // rule guards against a redo.
  mode: fc.constantFrom<Mode>("return", "link", "new", "new"),
  log: fc.boolean(),
});
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("add" as const),
      actor,
      drafts: fc.array(draftSpec, { minLength: 1, maxLength: 2 }),
    }),
    weight: 7,
  },
  {
    arbitrary: fc.record({
      kind: fc.constantFrom("complete" as const, "complete" as const, "reopen" as const),
      actor,
      pick: fc.nat(),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("undo" as const), who, partial: fc.boolean() }),
    weight: 5,
  },
  { arbitrary: fc.record({ kind: fc.constant("redo" as const), who }), weight: 4 },
  // An undo and a redo of one human at once, as a quick Ctrl+Z, Ctrl+Shift+Z makes them.
  { arbitrary: fc.record({ kind: fc.constant("cycle" as const), who }), weight: 3 },
  {
    arbitrary: fc.record({
      kind: fc.constant("rival" as const),
      who,
      other: fc.constantFrom(0, 1, 2),
      key: fc.nat({ max: KEYS.length - 1 }),
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ kind: fc.constant("retry" as const), pick: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("jump" as const) }), weight: 2 },
);

type Cell = { value: string; fv: number; fp: number };

/**
 * Every logical field of the rows this test's operations write, by `entity|id|field`: its value,
 * fv and fp (a missing key means created_seq). Read on the test's own connection.
 */
function fieldsOf(conn: Connection): Map<string, Cell> {
  const out = new Map<string, Cell>();
  const tables = [
    { table: "tasks", key: "id", fields: TASK_FIELDS },
    {
      table: "task_sources",
      key: "task_id || '|' || source_id",
      fields: CHILD_FIELDS.task_sources,
    },
    { table: "sources", key: "id", fields: CHILD_FIELDS.sources },
    { table: "log_entries", key: "id", fields: CHILD_FIELDS.log_entries },
  ] as const;
  for (const { table, key, fields } of tables) {
    for (const row of conn.prepare(`SELECT ${key} AS entity_id, * FROM ${table}`).all()) {
      const fv = JSON.parse(String(row["fv"])) as Record<string, number>;
      const fp = JSON.parse(String(row["fp"])) as Record<string, number>;
      const created = Number(row["created_seq"]);
      for (const [field, columns] of Object.entries(fields) as [string, readonly string[]][]) {
        out.set(`${table}|${String(row["entity_id"])}|${field}`, {
          value: JSON.stringify(columnsValue(row, columns)),
          fv: fv[field] ?? created,
          fp: fp[field] ?? created,
        });
      }
    }
  }
  return out;
}

/**
 * An applied undo or redo against the space before it (A1 3.10): the only fields that moved are
 * those its change rows name; each is a row of the commit it inverts (`inverted`) and held exactly
 * the write that row made, never a write whose provenance moved since; it gets that row's
 * before-value and before-provenance back, or for a create a tombstone of its own.
 */
function expectInversion(
  conn: Connection,
  before: ReadonlyMap<string, Cell>,
  inverted: readonly Row[],
  seq: number,
): Row[] {
  const rows = changesAt(conn, seq);
  const written = new Set(
    rows.map((n) => `${String(n["entity"])}|${String(n["entity_id"])}|${String(n["field"])}`),
  );
  // Collected, then asserted once: a few hundred fields per step.
  const wrong: string[] = [];
  for (const [k, cell] of fieldsOf(conn)) {
    const was = before.get(k);
    if (was === undefined) wrong.push(`${k}: an inversion creates no row`);
    const moved = was?.value !== cell.value || was.fv !== cell.fv || was.fp !== cell.fp;
    if (moved !== written.has(k)) {
      wrong.push(`${k} moved ${moved ? "outside" : "without"} the inversion's rows`);
    }
  }
  for (const n of rows) {
    const k = `${String(n["entity"])}|${String(n["entity_id"])}|${String(n["field"])}`;
    const ch = inverted.find(
      (c) =>
        c["entity"] === n["entity"] &&
        c["entity_id"] === n["entity_id"] &&
        (c["field"] === n["field"] || c["action"] === "create"),
    );
    if (ch === undefined) {
      wrong.push(`${k} is no row of the commit it inverts`);
      continue;
    }
    // The guard (A1 3.10): the field held exactly the write the inverted row made.
    if (before.get(k)?.fp !== ch["after_prov"]) wrong.push(`${k} held another write`);
    if (ch["action"] === "set") {
      if (n["after"] !== ch["before"]) wrong.push(`${k} did not get its before-value back`);
      if (n["after_prov"] !== ch["before_prov"]) wrong.push(`${k}: not its before-provenance`);
    } else if (n["after_prov"] !== seq) {
      wrong.push(`${k} is not tombstoned by the inversion's own write`);
    }
  }
  expect(wrong).toEqual([]);
  return rows;
}

/** A result as its receipt replays it: a conflict without the values that were current (A1 3.8). */
function replayOf(result: WriteResult): WriteResult {
  return {
    ...result,
    conflicts: result.conflicts.map((c) => {
      const kept = { ...c };
      delete kept.value;
      delete kept.wrote;
      delete kept.restore;
      return kept;
    }),
    replayed: true,
  };
}

/** Search documents without their numbers and seqs, as a rebuild compares them. */
const plainDocs = (docs: Iterable<SearchDocument>): SearchDocument[] =>
  [...docs]
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

const property = (seen: Record<string, number>) =>
  fc.asyncProperty(fc.array(step, { minLength: 10, maxLength: 40 }), async (generated) => {
    const steps = generated.flatMap((s): Step[] => {
      if (s.kind === "cycle") {
        return [
          { kind: "undo", who: s.who, partial: false },
          { kind: "redo", who: s.who },
        ];
      }
      if (s.kind !== "rival") return [s];
      const create = (actor: number): Step => ({
        kind: "add",
        actor,
        drafts: [{ keys: [s.key], mode: "new", log: false }],
      });
      // Codex makes sure the key has a source row and a finished holder first.
      const held: Step = {
        kind: "add",
        actor: 2,
        drafts: [{ keys: [s.key], mode: "return", log: false }],
      };
      const other = s.other === s.who ? 2 : s.other;
      return [
        held,
        { kind: "finish", key: s.key },
        create(s.who),
        { kind: "undo", who: s.who, partial: false },
        create(other),
        { kind: "redo", who: s.who },
      ];
    });
    // With the search tables, so every undo and redo keeps the index too (A1 3.12).
    const space = await writeFixture(temp.make(), { search: true });
    let now = Date.UTC(2026, 10, 13, 8);
    space.reopen({ now: () => (now += 1000) });
    const count = (label: string): void => {
      seen[label] = (seen[label] ?? 0) + 1;
    };
    try {
      const actors: Credential[] = [space.human, await secondHuman(space), space.codex];
      const as = (n: number): Credential => actors[n] ?? space.codex;
      const conn = space.reader;
      const lastSeq = (): number =>
        Number(conn.prepare("SELECT last_seq FROM space").get()?.["last_seq"]);
      const sent: { request: WriteRequest; result: WriteResult }[] = [];
      const submit = (request: WriteRequest): WriteResult => {
        // A constraint error or any other storage failure throws here and fails the run.
        const result = space.writer.submit(request);
        sent.push({ request, result });
        return result;
      };
      const tasksIn = (lifecycle: string): Id<"t">[] =>
        conn
          .prepare(
            "SELECT id FROM tasks WHERE lifecycle = $lifecycle AND deleted_at IS NULL ORDER BY ref",
          )
          .all({ lifecycle })
          .map((r) => r["id"] as Id<"t">);

      for (const s of steps) {
        const before = fieldsOf(conn);
        const keysBefore = keyHolders(conn);
        const seqBefore = lastSeq();
        let result: WriteResult | undefined;
        if (s.kind === "jump") {
          now += 31 * DAY;
          continue;
        } else if (s.kind === "finish") {
          const key = KEYS[s.key] ?? "";
          for (const [task, lifecycle] of keysBefore.get(key) ?? []) {
            if (lifecycle !== "active") continue;
            const done = submit(
              space.request(space.codex, [{ kind: "task.complete", task }], {
                base: space.base(),
              }),
            );
            expectStatus(done, "applied");
          }
        } else if (s.kind === "retry") {
          const earlier = sent[s.pick % Math.max(sent.length, 1)];
          if (earlier === undefined) continue;
          // The stored answer, whatever undo, redo and dedupe did since (A1 3.8).
          expect(space.writer.submit(earlier.request)).toEqual(replayOf(earlier.result));
          expect(lastSeq()).toBe(seqBefore);
          count("replayed");
          continue;
        } else if (s.kind === "add") {
          const ops = s.drafts.flatMap(
            (d) =>
              draft(
                d.keys.map((k) => KEYS[k] ?? ""),
                {
                  ...(d.mode === "new" ? { dedupe: "new" as const } : {}),
                  ...(d.mode === "link" ? { link: true } : {}),
                  ...(d.log ? { log: "New in the thread." } : {}),
                },
              ).ops,
          );
          result = submit(space.request(as(s.actor), ops, s.actor < 2 ? { undoable: true } : {}));
          if (result.status === "rejected") {
            // A dedupe new against an active task, or a link an undo removed that only its
            // link version revives (A1 3.5).
            expect(["VALIDATION_FAILED dedupe", "BASE_REQUIRED link_version"]).toContain(
              `${String(result.error?.code)} ${String(result.error?.field)}`,
            );
            count(
              result.error?.code === "BASE_REQUIRED"
                ? "revival needs its link version"
                : "refused new",
            );
          } else {
            expect(["applied", "unchanged"]).toContain(result.status);
            if (result.results.some((r) => r.matched_by !== undefined)) count("matched");
          }
        } else if (s.kind === "complete" || s.kind === "reopen") {
          const pool = tasksIn(s.kind === "complete" ? "active" : "completed");
          const picked = pool[s.pick % Math.max(pool.length, 1)];
          if (picked === undefined) continue;
          result = submit(
            space.request(as(s.actor), [{ kind: `task.${s.kind}`, task: picked }], {
              base: space.base(),
              ...(s.actor < 2 ? { undoable: true } : {}),
            }),
          );
          expectStatus(result, "applied");
        } else if (s.kind === "undo" || s.kind === "redo") {
          const principal = as(s.who).principal_id;
          const undo = s.kind === "undo";
          const target = undo ? undoTarget(conn, principal) : redoTarget(conn, principal);
          const op: Operation =
            s.kind === "undo"
              ? { kind: "undo", ...(s.partial ? { partial: true } : {}) }
              : { kind: "redo" };
          result = submit(space.request(as(s.who), [op]));
          if (target === undefined) {
            expect(result.error?.code).toBe(undo ? "NOTHING_TO_UNDO" : "NOTHING_TO_REDO");
          } else if (result.status === "conflict") {
            expect(result.error?.code).toBe("UNDO_CONFLICT");
            count(`${s.kind} conflict`);
            const inverted = changesAt(conn, undo ? target.seq : (target.undoneBy ?? 0));
            const own = new Set(inverted.map((c) => c["task_id"]));
            for (const c of result.conflicts) {
              if (undo) {
                // An undo's create guard names another's live child row: a link to a source the
                // undone commit created, which keeps that source and its task.
                if (c.entity === "task_sources" && !own.has(c.task)) count("undo kept by a link");
                continue;
              }
              if (c.entity === "sources") count("redo held off by a taken source key");
              if (c.entity !== "task_sources" || own.has(c.task)) continue;
              // Another task's link in a redo, which inverts set rows only: it is a live, active
              // holder of a key the redo would make a restored task hold (history.ts).
              count("redo held off by an active holder");
              const [holder = "", source = ""] = c.id.split("|");
              const key = String(
                conn.prepare("SELECT source_key FROM sources WHERE id = $source").get({ source })?.[
                  "source_key"
                ],
              );
              expect(keyHolders(conn).get(key)?.get(holder), c.id).toBe("active");
            }
            // A shared source: no source row is taken, so only the holder rule refuses it.
            if (
              !undo &&
              result.conflicts.some((c) => c.entity === "task_sources" && !own.has(c.task)) &&
              !result.conflicts.some((c) => c.entity === "sources")
            ) {
              count("redo held off by an active holder of a shared source");
            }
          } else {
            expectStatus(result, "applied");
            const inverted = changesAt(conn, undo ? target.seq : (target.undoneBy ?? 0));
            const rows = expectInversion(conn, before, inverted, result.seq);
            if (s.kind === "undo" && result.conflicts.length > 0) count("partial undo");
            const restored = rows.some((n) => n["entity"] === "tasks" && n["field"] === "deleted");
            if (restored) count(undo ? "create undone" : "create redone");
            if (undo) {
              const ops = String(
                conn.prepare("SELECT ops FROM commits WHERE seq = $seq").get({ seq: target.seq })?.[
                  "ops"
                ],
              );
              if (ops.includes('"existing":true')) count("matched draft undone");
            }
            if (!undo && restored) {
              const back = new Set(
                rows.filter((n) => n["entity"] === "tasks").map((n) => String(n["entity_id"])),
              );
              for (const held of keyHolders(conn).values()) {
                if (
                  [...held.keys()].some((t) => back.has(t)) &&
                  [...held.values()].includes("completed")
                ) {
                  count("restored beside a finished holder");
                }
              }
            }
          }
        }
        if (result !== undefined && result.status !== "applied") {
          // A refusal or a no-op writes nothing (a receipt aside).
          expect(lastSeq()).toBe(seqBefore);
          const after = fieldsOf(conn);
          const moved = [...after].filter(([k, c]) => {
            const was = before.get(k);
            return was?.value !== c.value || was.fv !== c.fv || was.fp !== c.fp;
          });
          expect(moved.map(([k]) => k)).toEqual([]);
          expect(after.size).toBe(before.size);
        }
        // At most one active holder per key, unless a lifecycle put another there: a reopen, an
        // undo of a check-off or a redo of a reopen, which dedupe does not guard (A1 3.6). A
        // create, a link and a restore never make a second one.
        for (const [key, held] of keyHolders(conn)) {
          const active = [...held].filter(([, l]) => l === "active").map(([t]) => t);
          if (active.length <= 1) continue;
          for (const t of active) {
            const was = keysBefore.get(key)?.get(t);
            if (was === "active") continue;
            expect(
              was,
              `${key}: ${t} became a second active holder by a create, link or restore`,
            ).toBe("completed");
            count("second active holder by a lifecycle");
          }
        }
      }
      checkHistory(conn);
      // The index equals a fresh rebuild, undone and redone tasks and entries included.
      const { docs, stray } = storedDocuments(conn);
      expect(stray).toBe(0);
      expect(plainDocs(docs.values())).toEqual(plainDocs(expectedDocuments(conn).values()));
    } finally {
      space.close();
    }
  });

describe("[A1.5.history.property] undo and redo with dedupe by source key", () => {
  test("property: overlapping keys, completions, reopens, undo and redo of two humans: no inversion moves a field whose provenance moved, no constraint error, and a key gains a second active holder only by a lifecycle", async () => {
    // A fixed seed, whose runs must reach every outcome, then fresh random runs.
    const seen: Record<string, number> = {};
    await fc.assert(property(seen), { numRuns: 100, seed: 20261114 });
    for (const outcome of [
      "matched",
      "matched draft undone",
      "create undone",
      "create redone",
      "partial undo",
      "undo conflict",
      "undo kept by a link",
      "redo conflict",
      "redo held off by an active holder",
      "redo held off by an active holder of a shared source",
      "redo held off by a taken source key",
      "restored beside a finished holder",
      "second active holder by a lifecycle",
      "refused new",
      "replayed",
    ]) {
      expect(seen[outcome] ?? 0, outcome).toBeGreaterThan(2);
    }
    await fc.assert(property({}), { numRuns: 20 });
  }, 180_000);
});
