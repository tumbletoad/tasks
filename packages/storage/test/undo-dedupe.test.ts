// Undo and redo meet dedupe by source key (A1 3.6, 3.10, 3.10.1; A7 3.10 M3.02, M3.06): two steps
// built side by side, checked together. Fixed scenarios first: an undo of a request whose draft
// matched a task takes back only what the request wrote on the match; an undone create holds no
// key; a redo never brings back a second active holder of a key, whether the key's source row is
// taken (the unique key) or shared (the holder rule), in either order of two humans' redos, when
// the redo brings the key's source back too, and when it brings back several holders itself; a
// key that was double before a restore is not the restore's doing; an undo or redo never shares
// a request with a create, and dedupe's start state sees what they left; a check-off undone is no
// finish, and a finish set back keeps its own instant; a receipt replays after an undo; a link an
// undo removed comes back only with its link version. Then a property test: overlapping keys,
// completions, reopens, explicit links, archives, wrap-ups, deletes and restores, undo and redo of
// two humans together.
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
import { inTrashSql } from "../src/write/trash.ts";
import {
  applyInversions,
  planInversions,
  readChanges,
  redoSteps,
  undoTarget,
} from "../src/write/history.ts";
import type {
  Credential,
  Operation,
  SourceFields,
  TaskCreate,
  WriteRequest,
  WriteResult,
} from "../src/write/request.ts";
import { checkedDriver, TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import { checkSpace } from "./space-rules.ts";
import { checkHistory, expectStatus, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("undo-dedupe");
/** The fixture space, made once and copied for each test. */
const fixture = fixtureCopies(temp.make);
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
    fx = await fixture();
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

    // Undone again, its keys are free, and new tasks take them with source rows of their own:
    // the next redo would take each key's unique row, so it is a conflict naming those rows, and
    // writes nothing.
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
    expect(refused.conflicts.map((c) => [c.entity, c.id, c.field]).sort()).toEqual(
      [
        ["sources", s2, "deleted"],
        ["sources", s3, "deleted"],
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
    // The source row with the key (the unique index), created with B: never two live rows with
    // one key, never a constraint error. A's link would come back to its own source, which stays
    // tombstoned, so A would hold no key and no holder is named.
    expect(refused.conflicts).toMatchObject([
      {
        entity: "sources",
        id: source,
        field: "deleted",
        value: null,
        version: made.seq,
        by: { label: "Codex · work" },
      },
    ]);
    expect(refused.conflicts).toHaveLength(1);
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

  test("a creation an active holder keeps from Redo is passed over, the next step is redone, and Redo brings the task back with its notes once the holder is finished", () => {
    const y = draft(["jira:FIX-1"]);
    applied(send("codex", y.ops));
    lifecycle("task.complete", y.id);
    const other = draft([]);
    applied(send("human", other.ops));
    const a = draft(["jira:FIX-1"], { dedupe: "new" });
    const made = applied(
      send("human", [...a.ops, { kind: "note.add", task: a.id, body: "Asked twice." }]),
    );
    const noted = applied(send("human", [{ kind: "note.add", task: a.id, body: "Called back." }]));
    applied(
      send("human", [{ kind: "task.patch", task: other.id, set: { priority: 1 } }], {
        base: fx.base(),
      }),
    );
    for (let i = 0; i < 3; i += 1) applied(undo());
    const b = draft(["jira:FIX-1"], { dedupe: "new" });
    applied(send("codex", b.ops));
    const liveNotes = (): unknown =>
      one("SELECT count(*) FROM notes WHERE task_id = $id AND deleted_at IS NULL", { id: a.id });

    // A would be a second active holder, and its later note has no task to go on: both are passed
    // over, and the edit behind them is redone.
    const first = applied(redo());
    expect(first.passed).toEqual([made.commit, noted.commit]);
    expect(task(other.id)["priority"]).toBe(1);
    expect(deleted(a.id)).toBe(true);
    // Not in the Trash: a restore says Redo brings it back, and Redo does once B is finished.
    const restore = send("human", [{ kind: "task.restore", task: a.id }], { base: fx.base() });
    expect(restore.error).toMatchObject({ code: "NOT_FOUND", reason: "creation_undone" });
    lifecycle("task.complete", b.id);
    applied(redo());
    expect(deleted(a.id)).toBe(false);
    expect(liveNotes()).toBe(1);
    applied(redo());
    expect(liveNotes()).toBe(2);
    expect(redo().error?.code).toBe("NOTHING_TO_REDO");
    // Undo goes back in the order they were redone: the note, A, then the edit.
    applied(undo());
    expect(liveNotes()).toBe(1);
    applied(undo());
    expect(deleted(a.id)).toBe(true);
    applied(undo());
    expect(task(other.id)["priority"]).not.toBe(1);
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
        // With its own source the key's row is taken, and the unique key names it; a shared
        // source is one row, which the holder rule guards.
        expect(refused.conflicts).toMatchObject(
          path === "own source"
            ? [{ entity: "sources", id: linked, field: "deleted", by: holder.by }]
            : [holder],
        );
        expect(refused.conflicts).toHaveLength(1);
        expect(lastSeq()).toBe(seq);
        expect(deleted(held)).toBe(true);
        expect(activeOf(fx.reader, key)).toEqual([back]);
      }
    }
  });

  /** A task without sources, made by `who`. */
  const plainTask = (who: Who = "codex"): Id<"t"> => {
    const id = newId("t");
    applied(send(who, [{ kind: "task.create", id, title: "Call the clinic back" }]));
    return id;
  };
  /** One request of `who` that links each task to the keyed source `key`. */
  const link = (who: Who, key: string, tasks: Id<"t">[]): WriteResult =>
    applied(
      send(
        who,
        tasks.map((task) => ({ kind: "source.add", task, source: ticket(key) })),
      ),
    );

  test("a link to a source that is not there is not redone; once the source is back, its redo meets the holder rule", () => {
    // A is finished and B active. The human adds a new keyed source to A; the partner links B to
    // it. The partner undoes, the human undoes (the source is tombstoned), Codex reopens A.
    const a = plainTask();
    lifecycle("task.complete", a);
    const b = plainTask();
    link("human", "jira:FIX-1", [a]);
    const source = sourceOf("jira:FIX-1");
    link("partner", "jira:FIX-1", [b]);
    applied(undo("partner"));
    applied(undo("human"));
    expect(deleted(a)).toBe(false);
    lifecycle("task.reopen", a);
    // The partner's redo would revive B's link to a source that is not there: refused, naming it.
    const seq = lastSeq();
    const away = redo("partner");
    expectStatus(away, "conflict");
    expect(away.conflicts).toMatchObject([{ entity: "sources", id: source, field: "deleted" }]);
    expect(lastSeq()).toBe(seq);
    // The human's redo brings back the source and A's link: A is its one active holder.
    applied(redo("human"));
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([a]);
    // B's link would now make a second active holder: A's link is the conflict.
    const held = redo("partner");
    expectStatus(held, "conflict");
    expect(held.conflicts).toMatchObject([
      { entity: "task_sources", id: `${a}|${source}`, task: a, ref: ref(a), field: "removed" },
    ]);
    // Once A is finished again, B's link comes back, B the one active holder.
    lifecycle("task.complete", a);
    applied(redo("partner"));
    expect(holdersOf(fx.reader, "jira:FIX-1")).toEqual([a, b].sort());
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([b]);
  });

  test("restores of one plan never make two active holders together: none of them comes back, and each one's lifecycle is named", () => {
    // Y finished with the key, so its source row is shared. One request of the human links A,
    // finished, and B, active, to it; the undo removes both links; Codex reopens A.
    const y = draft(["jira:FIX-1"]);
    applied(send("codex", y.ops));
    lifecycle("task.complete", y.id);
    const a = plainTask();
    lifecycle("task.complete", a);
    const b = plainTask();
    const bMade = Number(task(b)["created_seq"]);
    link("human", "jira:FIX-1", [a, b]);
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([b]);
    applied(undo());
    const reopened = lifecycle("task.reopen", a);
    const seq = lastSeq();
    const refused = redo();
    expectStatus(refused, "conflict");
    // Both links would come back: A and B active together. Neither does, and the conflict names
    // what makes each active: Codex's reopen of A, B's create.
    expect(refused.conflicts).toMatchObject([
      {
        entity: "tasks",
        id: a,
        task: a,
        ref: ref(a),
        field: "lifecycle",
        value: { lifecycle: "active" },
        version: reopened.seq,
        by: { label: "Codex · work" },
      },
      { entity: "tasks", id: b, task: b, field: "lifecycle", version: bMade },
    ]);
    expect(refused.conflicts).toHaveLength(2);
    expect(lastSeq()).toBe(seq);
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([]);
    // Finished again, A comes back with B, the one active holder.
    lifecycle("task.complete", a);
    applied(redo());
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([b]);
    expect(holdersOf(fx.reader, "jira:FIX-1")).toEqual([a, b, y.id].sort());
  });

  test("a create of several tasks with one key comes back with one active holder; another human's reopen of one of them waits until then", () => {
    // One request creates T1, finishes it, and creates T2 with the same key: new work after it.
    const t1 = draft(["jira:FIX-1"], { dedupe: "new" });
    const t2 = draft(["jira:FIX-1"]);
    const made = applied(
      send("human", [...t1.ops, { kind: "task.complete", task: t1.id }, ...t2.ops], {
        base: fx.base(),
      }),
    );
    expect(made.results.map((r) => r.status)).toContain("created");
    expect(holdersOf(fx.reader, "jira:FIX-1")).toEqual([t1.id, t2.id].sort());
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([t2.id]);
    // The partner reopens T1 and undoes it; the human undoes the create. The partner's redo
    // would reopen T1 while it is not there: refused, naming T1's tombstone.
    lifecycle("task.reopen", t1.id, "partner");
    applied(undo("partner"));
    const gone = applied(undo("human"));
    expect(deleted(t1.id) && deleted(t2.id)).toBe(true);
    const seq = lastSeq();
    const away = redo("partner");
    expectStatus(away, "conflict");
    expect(away.conflicts).toMatchObject([
      { entity: "tasks", id: t1.id, field: "deleted", version: gone.seq },
    ]);
    expect(lastSeq()).toBe(seq);
    // The human's redo brings both back, T2 the one active holder; the partner's redo then
    // reopens T1 beside it, a lifecycle the holder rule does not guard.
    applied(redo("human"));
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([t2.id]);
    applied(redo("partner"));
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([t1.id, t2.id].sort());
  });

  test("Undo of a check-off beside new work that took the ticket meanwhile does what a reopen does: both hold it open, and the next capture names both", () => {
    const a = draft(["jira:FIX-1"]);
    applied(send("human", a.ops));
    lifecycle("task.complete", a.id, "human");
    // New work asked for as new while A is finished: B holds the ticket.
    const b = draft(["jira:FIX-1"], { dedupe: "new" });
    applied(send("codex", b.ops));
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([b.id]);
    applied(undo());
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([a.id, b.id].sort());
    const undone = probe(["jira:FIX-1"]);
    // A reopen of A from the same state leaves the same two.
    lifecycle("task.complete", a.id, "human");
    lifecycle("task.reopen", a.id, "human");
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([a.id, b.id].sort());
    const reopened = probe(["jira:FIX-1"]);
    const both = [ref(a.id), ref(b.id)].sort();
    for (const found of [undone, reopened]) {
      expect(found.results[0]).toMatchObject({ status: "existing", ambiguous: both });
    }
  });

  test("a partial inversion leaves out the restores of a broken key and applies the rest", async () => {
    // A redo is all or nothing, so this build reaches a partial inversion that restores only
    // through the engine itself, as M3.03's revert with allow_partial will.
    const y = draft(["jira:FIX-1"]);
    applied(send("codex", y.ops));
    lifecycle("task.complete", y.id);
    const a = plainTask();
    lifecycle("task.complete", a);
    const b = plainTask();
    const z = plainTask();
    const s = sourceOf("jira:FIX-1");
    const made = applied(
      send("human", [
        { kind: "source.add", task: a, source: ticket("jira:FIX-1") },
        { kind: "source.add", task: b, source: ticket("jira:FIX-1") },
        { kind: "log.add", task: z, body: "Called back." },
      ]),
    );
    const entry = String(made.results[2]?.id);
    const u = applied(undo());
    const reopened = lifecycle("task.reopen", a);
    const seq = lastSeq();
    const conn = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
    const rolledBack = new Error("rolled back");
    try {
      conn.transaction("immediate", () => {
        const plan = planInversions(conn, readChanges(conn, u.seq), {
          creating: new Set([made.seq]),
          refPrefix: "M",
          partial: true,
          op: 0,
          principal: fx.human.principal_id,
          applied: () => u.seq,
        });
        expect(plan.conflicts).toEqual([]);
        const done = applyInversions(conn, plan, {
          seq: seq + 1,
          at: clock.now + 1000,
          principal: fx.human.principal_id,
          op: 0,
          refPrefix: "M",
          partial: true,
          owners: false,
        });
        // The two links would make A and B active holders together: both stay removed, each
        // named by its lifecycle. The log entry is no holder: it comes back.
        expect(done?.changes.map((c) => [c.entity, c.entityId, c.field])).toEqual([
          ["log_entries", entry, "deleted"],
        ]);
        expect(plan.conflicts).toMatchObject([
          { entity: "tasks", id: a, field: "lifecycle", version: reopened.seq },
          { entity: "tasks", id: b, field: "lifecycle" },
        ]);
        const live = (sql: string, params: Record<string, string>): unknown =>
          Object.values(conn.prepare(sql).get(params) ?? {})[0];
        const removed =
          "SELECT removed_at FROM task_sources WHERE task_id = $task AND source_id = $s";
        expect(live(removed, { task: a, s })).not.toBeNull();
        expect(live(removed, { task: b, s })).not.toBeNull();
        expect(live("SELECT deleted_at FROM log_entries WHERE id = $entry", { entry })).toBeNull();
        throw rolledBack;
      });
    } catch (error) {
      if (error !== rolledBack) throw error;
    } finally {
      conn.close();
    }
    expect(lastSeq()).toBe(seq);
  });

  test("a key that had two active holders before a restore is not the restore's doing", () => {
    // X and Y hold the key, both active: Codex reopened Y, which dedupe does not guard.
    const x = draft(["jira:FIX-1"]);
    applied(send("codex", x.ops));
    lifecycle("task.complete", x.id);
    const y = draft(["jira:FIX-1"], { dedupe: "new" });
    applied(send("codex", y.ops));
    lifecycle("task.reopen", x.id);
    expect(activeOf(fx.reader, "jira:FIX-1")).toEqual([x.id, y.id].sort());
    // The human links a finished task to the key and undoes it; the redo brings back a finished
    // holder only, so the double that stood before is no reason to refuse it.
    const z = plainTask();
    lifecycle("task.complete", z);
    link("human", "jira:FIX-1", [z]);
    applied(undo());
    applied(redo());
    expect(holdersOf(fx.reader, "jira:FIX-1")).toEqual([x.id, y.id, z].sort());
    // A restore that would add a third active holder is refused: it names both.
    const w = plainTask();
    link("human", "jira:FIX-1", [w]);
    applied(undo());
    const refused = redo();
    expectStatus(refused, "conflict");
    const s = sourceOf("jira:FIX-1");
    expect(refused.conflicts.map((c) => [c.entity, c.id]).sort()).toEqual(
      [
        ["task_sources", `${x.id}|${s}`],
        ["task_sources", `${y.id}|${s}`],
      ].sort(),
    );
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
    // A task a redo restored holds its key again: a draft finds it, and one with dedupe new is
    // created beside it with the key's source linked without the key.
    const c = draft(["jira:FIX-2"]);
    applied(send("human", c.ops));
    applied(undo());
    applied(redo());
    expect(probe(["jira:FIX-2"]).results[0]).toMatchObject({
      status: "existing",
      id: c.id,
      lifecycle: "active",
    });
    const beside = probe(["jira:FIX-2"], { dedupe: "new" });
    const still = probe(["jira:FIX-2"]).results[0];
    expect(still).toMatchObject({ status: "existing", id: c.id });
    expect(beside.results.map((r) => [r.status, r.held_by])).toEqual([
      ["created", undefined],
      ["created", still?.ref],
    ]);
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
// Property: overlapping keys, completions, reopens, explicit links, archives, wrap-ups with
// learnings, deletes and restores, undo and redo of two humans together.

/** The keys drafts name. */
const KEYS = ["jira:FIX-1", "jira:FIX-2", "email:<3@x>"];
/** The keys explicit links name: the drafts' keys, and one that only links and creates make. */
const LINK_KEYS = [...KEYS, "jira:FIX-9"];

/** A draft's `on_existing` as A3 3.4.5 maps it onto A1 3.6: return, add_sources, create_new. */
type Mode = "return" | "link" | "new";

interface DraftSpec {
  keys: string[];
  mode: Mode;
  log: boolean;
}

type Lifecycle = "active" | "completed" | "archived" | "finished" | "any";

/**
 * A live task: one a composite step saved under a name, or one of those in a lifecycle (holding
 * `key` when given) in reference order, `at` counted from the first, or from the last when
 * negative. A task that is gone, or none in the pool, skips the step.
 */
type Pick = { slot: string } | { lifecycle: Lifecycle; key?: string; at: number };

/** Actors by index: the human (0) and a partner (1), each with an undo stack, and Codex (2). */
type Step =
  /** Drafts; the first one's ID is saved under `save` when it is created. */
  | { kind: "add"; actor: number; drafts: DraftSpec[]; save?: string }
  /** A task without sources. */
  | { kind: "plain"; actor: number; save: string }
  | { kind: "complete" | "reopen"; actor: number; pick: Pick }
  /** One request of explicit links (`source.add` on existing tasks): the key to each task. */
  | { kind: "link"; actor: number; key: string; tasks: Pick[] }
  /** One create commit of two tasks with one key: the first created and finished, then new work. */
  | { kind: "several"; actor: number; key: string; save?: string }
  /** `task.archive` of an active task. */
  | { kind: "archive"; actor: number; pick: Pick; save?: string }
  /** `task.wrap_up` of a finished task, adding learnings and removing its first live one. */
  | { kind: "wrap"; actor: number; pick: Pick; add: string[]; remove: boolean }
  /** `task.delete` of a live task. */
  | { kind: "delete"; actor: number; pick: Pick }
  /** `task.restore` of a deleted task, picked by `at` as a pick is. */
  | { kind: "restore"; actor: number; at: number }
  /**
   * An undo of a delete beside a newer active holder: Codex creates R with the key, `who`
   * deletes R, Codex creates another task with the key, and `who` undoes the delete.
   */
  | { kind: "revive"; who: number; key: number; partial: boolean }
  | { kind: "undo"; who: number; partial: boolean }
  | { kind: "redo"; who: number }
  | { kind: "cycle"; who: number }
  /** Codex completes every active task that holds the key. */
  | { kind: "finish"; key: string }
  /**
   * Two creates of one key around an undo, then the redo: `who` creates a task with the key
   * beside its finished holders (sharing their source row), undoes it, `other` creates one too,
   * and `who` redoes. With `fresh`, on a key no row holds yet: each create makes a source row of
   * its own, and the redo meets the unique key.
   */
  | { kind: "rival"; who: number; other: number; key: number; fresh: boolean }
  /**
   * A redo that brings back a source beside another's link: `who` adds a new keyed source to a
   * finished task A, the other human links an active B to it, both undo, Codex reopens A, and
   * both redo in turn.
   */
  | { kind: "race"; who: number; n: number }
  /** One request of `who` links a finished A and an active B to a key; undone; A reopened; redo. */
  | { kind: "pair"; who: number; key: number }
  /**
   * A create commit of two tasks with one key; the other human reopens the first and undoes it;
   * `who` undoes the create; the other's redo reopens the tombstoned task; `who` redoes.
   */
  | { kind: "twins"; who: number; key: number }
  /** `who` archives an active task, Codex wraps it up, `who` undoes the archive. */
  | { kind: "wrapped"; who: number; partial: boolean }
  /**
   * An archived holder whose reopen is undone after the window: it finished at its archive, so a
   * later draft with the key is new work (A1 3.6 rule 3).
   */
  | { kind: "stale"; who: number; key: number }
  | { kind: "retry"; pick: number }
  /** The clock moves past the window: a task finished before then no longer matches. */
  | { kind: "jump" };

const actor = fc.constantFrom(0, 0, 1, 1, 2);
const who = fc.constantFrom(0, 1);
const at = fc.integer({ min: -3, max: 12 });
const lifecycles = fc.constantFrom<Lifecycle>("active", "completed", "archived", "finished", "any");
const draftSpec: fc.Arbitrary<DraftSpec> = fc.record({
  keys: fc.uniqueArray(fc.constantFrom(...KEYS), { minLength: 1, maxLength: 2 }),
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
      kind: fc.constant("complete" as const),
      actor,
      pick: fc.record({ lifecycle: fc.constant<Lifecycle>("active"), at }),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("reopen" as const),
      actor,
      pick: fc.record({ lifecycle: fc.constant<Lifecycle>("finished"), at }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("link" as const),
      actor,
      key: fc.constantFrom(...LINK_KEYS),
      tasks: fc.array(fc.record({ lifecycle: lifecycles, at }), { minLength: 1, maxLength: 2 }),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("several" as const),
      actor,
      key: fc.constantFrom(...LINK_KEYS),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("archive" as const),
      actor,
      pick: fc.record({ lifecycle: fc.constant<Lifecycle>("active"), at }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("wrap" as const),
      actor,
      pick: fc.record({ lifecycle: fc.constant<Lifecycle>("finished"), at }),
      add: fc.uniqueArray(fc.constantFrom("Ask early.", "Keep notes.", "Check the logs."), {
        maxLength: 2,
      }),
      remove: fc.boolean(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      actor,
      pick: fc.record({ lifecycle: lifecycles, at }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("restore" as const), actor, at }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("revive" as const),
      who,
      key: fc.nat({ max: KEYS.length - 1 }),
      partial: fc.boolean(),
    }),
    weight: 1,
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
      fresh: fc.boolean(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("race" as const), who, n: fc.nat({ max: 3 }) }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("pair" as const),
      who,
      key: fc.nat({ max: LINK_KEYS.length - 1 }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("twins" as const),
      who,
      key: fc.nat({ max: LINK_KEYS.length - 1 }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("wrapped" as const), who, partial: fc.boolean() }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("stale" as const),
      who,
      key: fc.nat({ max: KEYS.length - 1 }),
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ kind: fc.constant("retry" as const), pick: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("jump" as const) }), weight: 2 },
);

/** A composite step as the primitive steps it stands for, in order. */
function expand(s: Step): Step[] {
  const other = (n: number): number => (n === 0 ? 1 : 0);
  const slot = (name: string): Pick => ({ slot: name });
  const plain = (save: string): Step => ({ kind: "plain", actor: 2, save });
  switch (s.kind) {
    case "cycle":
      return [
        { kind: "undo", who: s.who, partial: false },
        { kind: "redo", who: s.who },
      ];
    case "rival": {
      const key = s.fresh ? `jira:RIVAL-${String(s.key)}` : (KEYS[s.key] ?? "");
      const create = (actor: number): Step => ({
        kind: "add",
        actor,
        drafts: [{ keys: [key], mode: s.fresh ? "return" : "new", log: false }],
      });
      const race = [
        create(s.who),
        { kind: "undo", who: s.who, partial: false },
        create(s.other === s.who ? 2 : s.other),
        { kind: "redo", who: s.who },
      ] satisfies Step[];
      // Codex makes sure a shared key has a source row and a finished holder first.
      return s.fresh
        ? race
        : [
            { kind: "add", actor: 2, drafts: [{ keys: [key], mode: "return", log: false }] },
            { kind: "finish", key },
            ...race,
          ];
    }
    case "race": {
      const key = `jira:RACE-${String(s.n)}`;
      return [
        plain("a"),
        { kind: "complete", actor: 2, pick: slot("a") },
        plain("b"),
        { kind: "link", actor: s.who, key, tasks: [slot("a")] },
        { kind: "link", actor: other(s.who), key, tasks: [slot("b")] },
        { kind: "undo", who: other(s.who), partial: false },
        { kind: "undo", who: s.who, partial: false },
        { kind: "reopen", actor: 2, pick: slot("a") },
        { kind: "redo", who: other(s.who) },
        { kind: "redo", who: s.who },
      ];
    }
    case "pair":
      return [
        plain("a"),
        { kind: "complete", actor: 2, pick: slot("a") },
        plain("b"),
        { kind: "link", actor: s.who, key: LINK_KEYS[s.key] ?? "", tasks: [slot("a"), slot("b")] },
        { kind: "undo", who: s.who, partial: false },
        { kind: "reopen", actor: 2, pick: slot("a") },
        { kind: "redo", who: s.who },
      ];
    case "twins": {
      const key = LINK_KEYS[s.key] ?? "";
      return [
        { kind: "finish", key },
        { kind: "several", actor: s.who, key, save: "t" },
        { kind: "reopen", actor: other(s.who), pick: slot("t") },
        { kind: "undo", who: other(s.who), partial: false },
        { kind: "undo", who: s.who, partial: false },
        { kind: "redo", who: other(s.who) },
        { kind: "redo", who: s.who },
      ];
    }
    case "wrapped":
      return [
        { kind: "archive", actor: s.who, pick: { lifecycle: "active", at: -1 }, save: "w" },
        { kind: "wrap", actor: 2, pick: slot("w"), add: ["Ask early."], remove: false },
        { kind: "undo", who: s.who, partial: s.partial },
      ];
    case "revive": {
      const key = KEYS[s.key] ?? "";
      const create = (save?: string): Step => ({
        kind: "add",
        actor: 2,
        drafts: [{ keys: [key], mode: "new", log: false }],
        ...(save === undefined ? {} : { save }),
      });
      return [
        { kind: "finish", key },
        create("r"),
        { kind: "delete", actor: s.who, pick: slot("r") },
        create(),
        { kind: "undo", who: s.who, partial: s.partial },
      ];
    }
    case "stale": {
      const key = KEYS[s.key] ?? "";
      const probe = (mode: Mode, save?: string): Step => ({
        kind: "add",
        actor: 2,
        drafts: [{ keys: [key], mode, log: false }],
        ...(save === undefined ? {} : { save }),
      });
      return [
        { kind: "finish", key },
        probe("new", "x"),
        { kind: "archive", actor: 2, pick: slot("x") },
        { kind: "jump" },
        { kind: "reopen", actor: s.who, pick: slot("x") },
        { kind: "undo", who: s.who, partial: false },
        probe("return"),
      ];
    }
    default:
      return [s];
  }
}

/**
 * The oracle for a draft's match (A1 3.6 rules 1 to 3), on the state before its request at
 * instant `at`: its keys' holders, the first active one by reference, else the one finished last
 * within the window. A task finished at the commit whose write its lifecycle holds (its
 * provenance), never at an undo that set that write back.
 */
function expectedMatch(
  conn: Connection,
  keys: readonly string[],
  at: number,
): { active: string[]; match: string | undefined; setBack: boolean } {
  const held = keyHolders(conn);
  const ids = new Set(keys.flatMap((k) => [...(held.get(k)?.keys() ?? [])]));
  const rows = [...ids].map((id) => {
    const r = conn
      .prepare(
        "SELECT id, ref, lifecycle, completed_at, created_seq, fv, fp FROM tasks WHERE id = $id",
      )
      .get({ id });
    if (r === undefined) throw new Error("no holder");
    const fv = JSON.parse(String(r["fv"])) as Record<string, number>;
    const fp = JSON.parse(String(r["fp"])) as Record<string, number>;
    const seq = fp["lifecycle"] ?? Number(r["created_seq"]);
    const finished = Number(
      conn.prepare("SELECT at FROM commits WHERE seq = $seq").get({ seq })?.["at"],
    );
    return {
      id: String(r["id"]),
      ref: Number(r["ref"]),
      lifecycle: String(r["lifecycle"]),
      seq,
      finished,
      setBack: r["lifecycle"] === "archived" && (fv["lifecycle"] ?? seq) !== seq,
    };
  });
  const active = rows
    .filter((r) => r.lifecycle === "active")
    .sort((a, b) => a.ref - b.ref)
    .map((r) => r.id);
  const [last] = rows
    .filter((r) => r.lifecycle !== "active" && r.finished >= at - 30 * DAY)
    .sort((a, b) => b.finished - a.finished || b.seq - a.seq || b.ref - a.ref);
  return {
    active,
    match: active[0] ?? last?.id,
    setBack: rows.some((r) => r.setBack),
  };
}

/**
 * The oracle for a draft that returns a match: of the tasks its keys match, the one that has every
 * key of the draft, held or as a source linked without its key; else none when a key of it matches
 * nothing (the draft is new); else A1 3.6's match on all its keys.
 */
function expectedReturn(
  conn: Connection,
  keys: readonly string[],
  at: number,
): ReturnType<typeof expectedMatch> {
  const all = expectedMatch(conn, keys, at);
  const distinct = [...new Set(keys)];
  if (all.match === undefined || distinct.length < 2) return all;
  const each = distinct.map((k) => expectedMatch(conn, [k], at).match);
  const candidates = new Set([...each.filter((t) => t !== undefined), ...all.active]);
  const had = (task: string | undefined): Set<string> =>
    new Set(
      conn
        .prepare(
          "SELECT coalesce(s.source_key, s.ref) AS k FROM task_sources l JOIN sources s " +
            "ON s.id = l.source_id WHERE l.task_id = $task AND l.removed_at IS NULL " +
            "AND s.deleted_at IS NULL",
        )
        .all({ task: task ?? "" })
        .map((r) => String(r["k"])),
    );
  const covered = [...candidates].filter((t) => {
    const has = had(t);
    return distinct.every((k) => has.has(k));
  });
  if (covered.length === 1) return { ...all, match: covered[0] };
  return each.includes(undefined) ? { ...all, match: undefined } : all;
}

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
    { table: "learnings", key: "id", fields: CHILD_FIELDS.learnings },
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

/** A fresh copy of one fixture space per run: which writes apply does not depend on a flush. */
const freshSpace = fixtureCopies(temp.make, { flush: false });

const property = (seen: Record<string, number>) =>
  fc.asyncProperty(fc.array(step, { minLength: 10, maxLength: 40 }), async (generated) => {
    const steps = generated.flatMap(expand);
    // With the search tables, so every undo and redo keeps the index too (A1 3.12).
    const space = await freshSpace();
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
      const undoable = (n: number): Partial<WriteRequest> => (n < 2 ? { undoable: true } : {});
      const taskRow = (id: string): Row =>
        conn.prepare("SELECT * FROM tasks WHERE id = $id").get({ id }) ?? {};
      /** A task's live learnings, in their order. */
      const learningsOf = (id: string): Id<"lr">[] =>
        conn
          .prepare(
            "SELECT id FROM learnings WHERE task_id = $id AND deleted_at IS NULL ORDER BY position",
          )
          .all({ id })
          .map((r) => r["id"] as Id<"lr">);
      /** The tasks composite steps saved, by name. */
      const slots = new Map<string, Id<"t">>();
      const resolve = (p: Pick): Id<"t"> | undefined => {
        if ("slot" in p) {
          const id = slots.get(p.slot);
          return id !== undefined && taskRow(id)["deleted_at"] === null ? id : undefined;
        }
        const held = p.key === undefined ? undefined : keyHolders(conn).get(p.key);
        const pool = conn
          .prepare("SELECT id, lifecycle FROM tasks WHERE deleted_at IS NULL ORDER BY ref")
          .all()
          .filter((r) => {
            const lifecycle = String(r["lifecycle"]);
            if (p.lifecycle === "finished" ? lifecycle === "active" : p.lifecycle !== lifecycle) {
              if (p.lifecycle !== "any") return false;
            }
            return held === undefined ? p.key === undefined : held.has(String(r["id"]));
          })
          .map((r) => r["id"] as Id<"t">);
        return pool[((p.at % Math.max(pool.length, 1)) + pool.length) % Math.max(pool.length, 1)];
      };

      let rules = checkSpace(conn);
      for (const s of steps) {
        rules = checkSpace(conn, rules);
        const before = fieldsOf(conn);
        const keysBefore = keyHolders(conn);
        const seqBefore = lastSeq();
        let result: WriteResult | undefined;
        if (s.kind === "jump") {
          now += 31 * DAY;
          continue;
        } else if (s.kind === "finish") {
          for (const [task, lifecycle] of keysBefore.get(s.key) ?? []) {
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
          const drafts = s.drafts.map((d) => ({
            spec: d,
            keys: d.keys,
            draft: draft(d.keys, {
              ...(d.mode === "new" ? { dedupe: "new" as const } : {}),
              ...(d.mode === "link" ? { link: true } : {}),
              ...(d.log ? { log: "New in the thread." } : {}),
            }),
          }));
          // The first draft sees the state before its request only (A1 3.6): the oracle's input.
          const [first] = drafts;
          const oracle =
            first === undefined
              ? undefined
              : first.spec.mode === "return"
                ? expectedReturn(conn, first.keys, now + 1000)
                : expectedMatch(conn, first.keys, now + 1000);
          const heldBefore = new Map(
            (first?.keys ?? []).map((key) => [
              key,
              expectedMatch(conn, [key], now + 1000).active[0],
            ]),
          );
          result = submit(
            space.request(
              as(s.actor),
              drafts.flatMap((d) => d.draft.ops),
              undoable(s.actor),
            ),
          );
          if (result.status === "rejected") {
            // A link an undo removed, which only its link version revives (A1 3.5).
            expect(`${String(result.error?.code)} ${String(result.error?.field)}`).toBe(
              "BASE_REQUIRED link_version",
            );
            count("revival needs its link version");
          } else {
            expect(["applied", "unchanged"]).toContain(result.status);
            if (result.results.some((r) => r.matched_by !== undefined)) count("matched");
            const r0 = result.results[0];
            if (first !== undefined && oracle !== undefined) {
              if (first.spec.mode === "new") {
                // A new task whatever its keys match: a key an active task holds stays that
                // task's, and the new one has its source without the key.
                expect(r0?.status).toBe("created");
                first.keys.forEach((key, k) => {
                  const holder = heldBefore.get(key);
                  const added = result?.results[1 + (first.spec.log ? 1 : 0) + k];
                  expect([key, added?.held_by !== undefined]).toEqual([key, holder !== undefined]);
                });
                if (oracle.active.length > 0) count("new beside an active holder");
              } else if (oracle.match === undefined) {
                expect(r0?.status, JSON.stringify(r0)).toBe("created");
              } else {
                expect(r0).toMatchObject({ status: "existing", id: oracle.match });
              }
              if (oracle.setBack) count("archived finish set back");
              if (r0?.status === "created" && s.save !== undefined) {
                slots.set(s.save, first.draft.id);
              }
            }
          }
        } else if (s.kind === "plain") {
          const id = newId("t");
          result = submit(
            space.request(
              as(s.actor),
              [{ kind: "task.create", id, title: "Call the clinic back" }],
              undoable(s.actor),
            ),
          );
          expectStatus(result, "applied");
          slots.set(s.save, id);
        } else if (s.kind === "complete" || s.kind === "reopen") {
          const picked = resolve(s.pick);
          if (picked === undefined) continue;
          if ((taskRow(picked)["lifecycle"] === "active") !== (s.kind === "complete")) continue;
          result = submit(
            space.request(as(s.actor), [{ kind: `task.${s.kind}`, task: picked }], {
              base: space.base(),
              ...undoable(s.actor),
            }),
          );
          expectStatus(result, "applied");
        } else if (s.kind === "link") {
          const tasks = [
            ...new Set(s.tasks.map(resolve).filter((t): t is Id<"t"> => t !== undefined)),
          ];
          if (tasks.length === 0) continue;
          // Explicit links with a fresh base, so a link an undo removed is revived too (A1 3.5).
          result = submit(
            space.request(
              as(s.actor),
              tasks.map((task): Operation => ({ kind: "source.add", task, source: ticket(s.key) })),
              { base: space.base(), ...undoable(s.actor) },
            ),
          );
          expect(["applied", "unchanged"], JSON.stringify(result.error)).toContain(result.status);
        } else if (s.kind === "several") {
          const finished = draft([s.key], { dedupe: "new" });
          const then = draft([s.key]);
          result = submit(
            space.request(
              as(s.actor),
              [...finished.ops, { kind: "task.complete", task: finished.id }, ...then.ops],
              { base: space.base(), ...undoable(s.actor) },
            ),
          );
          expectStatus(result, "applied");
          if (s.save !== undefined) slots.set(s.save, finished.id);
          // Where an active task holds the key, the second draft finds it instead.
          if (result.results.at(-2)?.status === "created") count("several tasks with one key");
        } else if (s.kind === "delete" || s.kind === "restore") {
          const deleted = conn
            .prepare("SELECT id FROM tasks WHERE deleted_at IS NOT NULL ORDER BY ref")
            .all()
            .map((r) => r["id"] as Id<"t">);
          const picked =
            s.kind === "delete"
              ? resolve(s.pick)
              : deleted[
                  ((s.at % Math.max(deleted.length, 1)) + deleted.length) %
                    Math.max(deleted.length, 1)
                ];
          if (picked === undefined) continue;
          result = submit(
            space.request(as(s.actor), [{ kind: `task.${s.kind}`, task: picked }], {
              base: space.base(),
              ...undoable(s.actor),
            }),
          );
          // A task whose creation was undone is not in the Trash: Redo brings it back, not this.
          const trashed = conn
            .prepare(`SELECT ${inTrashSql("t")} AS yes FROM tasks t WHERE t.id = $id`)
            .get({ id: picked })?.["yes"];
          if (s.kind === "restore" && result.status === "rejected" && trashed !== 1) {
            expect(result.error).toMatchObject({ code: "NOT_FOUND", reason: "creation_undone" });
            count("an undone creation not restored");
            continue;
          }
          expectStatus(result, "applied");
          count(s.kind === "delete" ? "deleted" : "restored");
        } else if (s.kind === "archive" || s.kind === "wrap") {
          const picked = resolve(s.pick);
          if (picked === undefined) continue;
          // An archive takes an active task, a wrap-up a finished one.
          if ((taskRow(picked)["lifecycle"] !== "active") !== (s.kind === "wrap")) continue;
          const [first] = s.kind === "wrap" && s.remove ? learningsOf(picked) : [];
          const op: Operation =
            s.kind === "archive"
              ? { kind: "task.archive", task: picked, reason: "Not needed now" }
              : {
                  kind: "task.wrap_up",
                  task: picked,
                  outcome: "Shipped",
                  learnings: { add: s.add, ...(first === undefined ? {} : { remove: [first] }) },
                };
          result = submit(
            space.request(as(s.actor), [op], { base: space.base(), ...undoable(s.actor) }),
          );
          if (result.status === "rejected") {
            // A wrap-up that would take the task past 20 learnings (A1 3.11.2).
            expect(`${String(result.error?.code)} ${String(result.error?.field)}`).toBe(
              "TOO_LARGE learnings.add",
            );
          } else {
            expect(["applied", "unchanged"]).toContain(result.status);
            if (s.kind === "archive" && s.save !== undefined) slots.set(s.save, picked);
            count(s.kind === "archive" ? "archived" : "wrapped up");
            if (s.kind === "wrap" && (s.add.length > 0 || first !== undefined)) {
              count("learnings written");
            }
          }
        } else if (s.kind === "undo" || s.kind === "redo") {
          const principal = as(s.who).principal_id;
          const undo = s.kind === "undo";
          // What an undo takes, or what a redo tries in turn (it redoes the first it can).
          const newest = undo ? undoTarget(conn, principal) : undefined;
          const targets = undo
            ? newest === undefined
              ? []
              : [newest]
            : redoSteps(conn, principal);
          const target = targets[0];
          const op: Operation =
            s.kind === "undo"
              ? { kind: "undo", ...(s.partial ? { partial: true } : {}) }
              : { kind: "redo" };
          result = submit(space.request(as(s.who), [op]));
          /** An undo of an archive another has wrapped up since keeps both (A1 3.10). */
          const archiveKept = (): void => {
            const ops = String(
              conn.prepare("SELECT ops FROM commits WHERE seq = $seq").get({
                seq: target?.seq ?? 0,
              })?.["ops"],
            );
            if (
              ops.includes('"task.archive"') &&
              result?.conflicts.some((c) => c.field === "wrap" || c.field === "lifecycle")
            ) {
              count("archive undo kept from an active wrap-up");
            }
          };
          if (target === undefined) {
            expect(result.error?.code).toBe(undo ? "NOTHING_TO_UNDO" : "NOTHING_TO_REDO");
          } else if (result.status === "conflict") {
            expect(result.error?.code).toBe("UNDO_CONFLICT");
            count(`${s.kind} conflict`);
            const inverted = undo
              ? changesAt(conn, target.seq)
              : targets.flatMap((t) => changesAt(conn, t.undoneBy ?? 0));
            const own = new Set(inverted.map((c) => c["task_id"]));
            if (undo) archiveKept();
            for (const c of result.conflicts) {
              if (undo) {
                // An undo's create guard names another's live child row: a link to a source the
                // undone commit created, which keeps that source and its task. An undo of a
                // delete brings its task back, so the holder rule names an active holder's link.
                const deletion = inverted.some(
                  (n) => n["entity"] === "tasks" && n["field"] === "deleted",
                );
                if (c.entity === "task_sources" && !own.has(c.task)) {
                  count(
                    deletion
                      ? "undo of a delete held off by an active holder"
                      : "undo kept by a link",
                  );
                }
                continue;
              }
              if (c.entity === "sources") count("redo held off by a taken source key");
              // The holder rule's own holders: each one's lifecycle, with no value to restore.
              if (c.entity === "tasks" && c.field === "lifecycle" && c.wrote === undefined) {
                count("redo held off by its own holders");
              }
              if (c.entity !== "task_sources" || own.has(c.task)) continue;
              // Another task's link in a redo, which inverts set rows only: a standing holder,
              // an active task with a live link, of a key the redo would give a second one.
              count("redo held off by an active holder");
              const [holder = "", source = ""] = c.id.split("|");
              expect(
                conn
                  .prepare(
                    "SELECT ts.removed_at AS removed_at, t.lifecycle AS lifecycle, " +
                      "t.deleted_at AS deleted_at FROM task_sources ts JOIN tasks t " +
                      "ON t.id = ts.task_id WHERE ts.task_id = $holder AND ts.source_id = $source",
                  )
                  .get({ holder, source }),
                c.id,
              ).toEqual({ removed_at: null, lifecycle: "active", deleted_at: null });
              // The source of that key is one the redo itself would bring back.
              if (
                inverted.some(
                  (n) =>
                    n["entity"] === "sources" &&
                    n["entity_id"] === source &&
                    n["field"] === "deleted",
                )
              ) {
                count("redo held off beside the source it brings back");
              }
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
            const redone = targets.find((t) => t.id === result?.results[0]?.id);
            const inverted = changesAt(conn, undo ? target.seq : (redone?.undoneBy ?? 0));
            const rows = expectInversion(conn, before, inverted, result.seq);
            if (s.kind === "undo" && result.conflicts.length > 0) {
              count("partial undo");
              archiveKept();
            }
            const restored = rows.some((n) => n["entity"] === "tasks" && n["field"] === "deleted");
            if (restored) count(undo ? "create undone" : "create redone");
            if (rows.some((n) => n["entity"] === "learnings")) count("learnings inverted");
            if (undo) {
              const ops = String(
                conn.prepare("SELECT ops FROM commits WHERE seq = $seq").get({ seq: target.seq })?.[
                  "ops"
                ],
              );
              if (ops.includes('"existing":true')) count("matched draft undone");
            }
            // Tasks whose tombstone the inversion cleared: a redo of a create, an undo of a delete.
            const back = new Set(
              rows
                .filter(
                  (n) =>
                    n["entity"] === "tasks" &&
                    n["field"] === "deleted" &&
                    (JSON.parse(String(n["after"])) as { deleted_at: unknown }).deleted_at === null,
                )
                .map((n) => String(n["entity_id"])),
            );
            for (const held of keyHolders(conn).values()) {
              if (
                [...held.keys()].some((t) => back.has(t)) &&
                [...held.values()].some((l) => l !== "active")
              ) {
                count("restored beside a finished holder");
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
        // At most one active holder per key, unless a lifecycle put another there (a reopen, an
        // undo of a check-off or archive, or a redo of a reopen, which dedupe does not guard) or
        // an explicit link did (the caller's own act, A1 3.6). A create and a restore never make
        // a second one.
        for (const [key, held] of keyHolders(conn)) {
          const active = [...held].filter(([, l]) => l === "active").map(([t]) => t);
          if (active.length <= 1) continue;
          for (const t of active) {
            const was = keysBefore.get(key)?.get(t);
            if (was === "active") continue;
            if ((s.kind === "link" || s.kind === "restore") && was === undefined) {
              count(`explicit ${s.kind} beside an active holder`);
              continue;
            }
            expect(
              was === "completed" || was === "archived",
              `${key}: ${t} became a second active holder by a create or restore`,
            ).toBe(true);
            count("second active holder by a lifecycle");
          }
        }
      }
      checkSpace(conn, rules);
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
  test("property: overlapping keys, completions, reopens, explicit links, archives, wrap-ups, deletes and restores, undo and redo of two humans: no inversion moves a field whose provenance moved, no constraint error, a key gains a second active holder only by a lifecycle or an explicit link or restore, and a draft matches as A1 3.6 says", async () => {
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
      "redo held off by its own holders",
      "restored beside a finished holder",
      "second active holder by a lifecycle",
      "explicit link beside an active holder",
      "several tasks with one key",
      "archived",
      "wrapped up",
      "learnings written",
      "learnings inverted",
      "deleted",
      "restored",
      "undo of a delete held off by an active holder",
      "archive undo kept from an active wrap-up",
      "archived finish set back",
      "new beside an active holder",
      "replayed",
    ]) {
      expect(seen[outcome] ?? 0, outcome).toBeGreaterThan(2);
    }
    await fc.assert(property({}), { numRuns: 20 });
  }, 600_000);
});
