// Source keys and dedupe (A1 3.6, R4; A3 3.4.5, 3.11.1; A7 3.10 M3.06): `task.create` upserts by
// the keys of its draft's sources against active tasks and tasks finished within the window, the
// draft's later operations follow a match by the rebinding rules, and the receipt is looked up
// before dedupe, so a retry replays what the request first returned. Fixture text only.
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Connection, SqlValue } from "../src/driver.ts";
import { newId, type Id } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import { openSpace } from "../src/space.ts";
import { StorageWorker } from "../src/worker/client.ts";
import { CHILD_FIELDS, columnsValue, TASK_FIELDS } from "../src/write/fields.ts";
import {
  DEDUPE_WINDOW_DAYS,
  type Credential,
  type Operation,
  type SourceFields,
  type TaskCreate,
  type WriteRequest,
  type WriteResult,
} from "../src/write/request.ts";
import { checkedDriver, createFixtureSpace, TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import {
  checkHistory,
  expectStatus,
  MACHINE,
  writeFixture,
  type Fixture,
} from "./write-helpers.ts";

const temp = tempFolders("dedupe");
afterAll(temp.cleanup);

const DAY = 86_400_000;

type Row = Record<string, unknown>;

/** A clock the tests move: one second per call, and whole days when a test says so. */
const clock = { now: 0 };
const tick = (): number => (clock.now += 1000);

let fx: Fixture;

const ticket = (key: string): SourceFields => ({ kind: "ticket", title: "Export ticket", key });

interface Draft {
  id: Id<"t">;
  ops: Operation[];
}

/**
 * A draft as A3's `add_tasks` sends it (A1 3.6: there is no nested create): its task.create, then
 * its log entry, its sources and its place, each naming the draft's client ID.
 */
function draft(
  keys: readonly string[],
  options: {
    title?: string;
    dedupe?: TaskCreate["dedupe"];
    link?: boolean;
    log?: string;
    place?: boolean;
  } = {},
): Draft {
  const id = newId("t");
  const ops: Operation[] = [
    {
      kind: "task.create",
      id,
      title: options.title ?? "Answer the clinic",
      ...(options.dedupe === undefined ? {} : { dedupe: options.dedupe }),
      ...(options.link === true ? { link_sources: true } : {}),
    },
  ];
  if (options.log !== undefined) ops.push({ kind: "log.add", task: id, body: options.log });
  for (const key of keys) ops.push({ kind: "source.add", task: id, source: ticket(key) });
  if (options.place === true)
    ops.push({ kind: "place.set", task: id, root: "work", path: "clinic" });
  return { id, ops };
}

function submit(
  ops: Operation[],
  extra: { base?: string; actor?: "human" | "codex" | "claude" } = {},
): WriteResult {
  const actor = fx[extra.actor ?? "codex"];
  return fx.writer.submit(
    fx.request(actor, ops, extra.base === undefined ? {} : { base: extra.base }),
  );
}

const complete = (task: Id<"t">): void => {
  expectStatus(
    submit([{ kind: "task.complete", task }], { actor: "human", base: fx.base() }),
    "applied",
  );
};

const one = (sql: string, params = {}): unknown =>
  Object.values(fx.reader.prepare(sql).get(params) ?? {})[0];

/** The tasks a live link joins to the live source with `key`, sorted. */
const holders = (conn: Connection, key: string): string[] =>
  conn
    .prepare(
      "SELECT ts.task_id AS task FROM sources s JOIN task_sources ts ON ts.source_id = s.id " +
        "WHERE s.source_key = $key AND s.deleted_at IS NULL AND ts.removed_at IS NULL " +
        "ORDER BY ts.task_id",
    )
    .all({ key })
    .map((r) => String(r["task"]));

const opsAt = (seq: number): { op: string; target: string; input: Row }[] =>
  JSON.parse(String(one("SELECT ops FROM commits WHERE seq = $seq", { seq }))) as {
    op: string;
    target: string;
    input: Row;
  }[];

/**
 * Sets one logical field of a task or a link as a later step's operation will (`source.unlink`):
 * a commit by Mira with its change row, the row's versions, the touched mark and the outbox row,
 * on a second connection between the writer's requests.
 */
async function rawSet(
  entity: "tasks" | "task_sources",
  id: string,
  task: Id<"t">,
  field: "deleted" | "removed",
  values: Record<string, SqlValue>,
): Promise<number> {
  const conn = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
  let done = 0;
  try {
    conn.transaction("immediate", () => {
      const space = conn.prepare("SELECT * FROM space").get();
      const seq = Number(space?.["last_seq"]) + 1;
      const at = Number(conn.prepare("SELECT max(at) AS at FROM commits").get()?.["at"]) + 1000;
      const [taskId, sourceId] = id.split("|");
      const row =
        entity === "tasks"
          ? conn.prepare("SELECT * FROM tasks WHERE id = $id").get({ id })
          : conn
              .prepare("SELECT * FROM task_sources WHERE task_id = $task AND source_id = $source")
              .get({ task: taskId ?? "", source: sourceId ?? "" });
      if (space === undefined || row === undefined) throw new Error("no row");
      const columns: readonly string[] =
        entity === "tasks" ? TASK_FIELDS.deleted : CHILD_FIELDS.task_sources.removed;
      const resolved = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, v === "$at" ? at : v]),
      );
      const before = JSON.stringify(columnsValue(row, columns));
      const after = JSON.stringify(columnsValue({ ...row, ...resolved }, columns));
      conn
        .prepare(
          "INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id, " +
            "author_id, scope_id, machine_id, origin, request_id, kind, ops) VALUES ($seq, $op, " +
            "$epoch, $incarnation, $at, 'human', $human, $human, 'cli:fixture', $machine, 'cli', " +
            "$request, 'ops', '[]')",
        )
        .run({
          seq,
          op: newId("op"),
          epoch: space["authority_epoch"] as number,
          incarnation: space["authority_incarnation"] as string,
          at,
          human: fx.human.principal_id,
          machine: TEST_MACHINE,
          request: newId("op").slice(3),
        });
      const fv = { ...(JSON.parse(String(row["fv"])) as Record<string, number>), [field]: seq };
      conn
        .prepare(
          "INSERT INTO changes (seq, n, op, entity, entity_id, task_id, action, field, before, " +
            "after, before_ver, before_prov, after_prov) VALUES ($seq, 1, 0, $entity, $id, $task, " +
            "'set', $field, $before, $after, $version, $version, $seq)",
        )
        .run({
          seq,
          entity,
          id,
          task,
          field,
          before,
          after,
          version:
            (JSON.parse(String(row["fv"])) as Record<string, number>)[field] ??
            (row["created_seq"] as number),
        });
      const sets = Object.keys(resolved)
        .map((c) => `${c} = $${c}`)
        .join(", ");
      const maps = { seq, fv: JSON.stringify(fv) };
      if (entity === "tasks") {
        conn
          .prepare(
            `UPDATE tasks SET ${sets}, version = $seq, touched = $seq, fv = $fv, fp = $fv ` +
              "WHERE id = $id",
          )
          .run({ ...resolved, ...maps, id });
      } else {
        conn
          .prepare(
            `UPDATE task_sources SET ${sets}, version = $seq, fv = $fv, fp = $fv ` +
              "WHERE task_id = $task AND source_id = $source",
          )
          .run({ ...resolved, ...maps, task: taskId ?? "", source: sourceId ?? "" });
        conn.prepare("UPDATE tasks SET touched = $seq WHERE id = $task").run({ seq, task });
      }
      conn
        .prepare(
          "INSERT INTO outbox (topic, key, first_seq, seq) VALUES ('projection', $key, $seq, $seq) " +
            "ON CONFLICT (topic, key) DO UPDATE SET seq = excluded.seq",
        )
        .run({ key: task, seq });
      conn.prepare("UPDATE space SET last_seq = $seq").run({ seq });
      done = seq;
    });
  } finally {
    conn.close();
  }
  return done;
}

describe("[A1.5.write.dedupe] task.create upserts by the keys of its draft's sources", () => {
  beforeEach(async () => {
    fx = await writeFixture(temp.make());
    // After the fixture's own commits, so every commit instant comes from this clock.
    clock.now = Date.UTC(2026, 10, 13, 8);
    fx.reopen({ now: tick });
  });
  afterEach(() => {
    checkHistory(fx.reader);
    fx.close();
  });

  test("an active task that holds a key of the draft is returned: its entries follow it, nothing else of the draft is written", () => {
    const first = draft(["jira:FIX-1"]);
    const created = submit(first.ops);
    expectStatus(created, "applied");
    expect(created.results[0]).toMatchObject({ status: "created", id: first.id, ref: "M-1" });

    // The key as an agent may send it: A1 trims it and lower-cases its namespace (A3 3.11.1).
    const again = draft([" JIRA:FIX-1", "jira:FIX-2"], {
      title: "Answer the clinic again",
      log: "Seen again in the export.",
      place: true,
    });
    const result = submit(again.ops);
    expectStatus(result, "applied");
    const existing = { status: "existing", id: first.id, task: first.id, ref: "M-1" };
    expect(result.results).toEqual([
      {
        i: 0,
        ...existing,
        version: created.seq,
        matched_by: "source_key",
        lifecycle: "active",
      },
      {
        i: 1,
        status: "created",
        id: expect.stringMatching(/^l_/u) as string,
        task: first.id,
        ref: "M-1",
        entry: "l1",
        version: result.seq,
      },
      { i: 2, ...existing, version: created.seq },
      { i: 3, ...existing, version: created.seq },
      { i: 4, ...existing, version: created.seq },
    ]);
    // Nothing of the draft but its log entry: no task, no title, no second source, no place.
    expect(one("SELECT count(*) FROM tasks")).toBe(1);
    expect(one("SELECT title FROM tasks")).toBe("Answer the clinic");
    expect(one("SELECT count(*) FROM sources")).toBe(1);
    expect(one("SELECT count(*) FROM places")).toBe(0);
    expect(one("SELECT task_id FROM log_entries")).toBe(first.id);
    // The commit keeps every operation in order, the matched ones with no text of the draft.
    expect(opsAt(result.seq).map((e) => [e.op, e.target, e.input])).toEqual([
      ["task.create", first.id, { existing: true }],
      ["log.add", result.results[1]?.id, { task: first.id, body: "Seen again in the export." }],
      ["source.add", first.id, { existing: true }],
      ["source.add", first.id, { existing: true }],
      ["place.set", first.id, { existing: true }],
    ]);
    // A matched draft with nothing to follow writes nothing: unchanged, with its receipt.
    const seq = Number(one("SELECT last_seq FROM space"));
    const bare = submit(draft(["jira:FIX-1"]).ops);
    expectStatus(bare, "unchanged");
    expect(bare.results.map((r) => r.status)).toEqual(["existing", "existing"]);
    expect(one("SELECT last_seq FROM space")).toBe(seq);
    expect(one("SELECT count(*) FROM receipts WHERE status = 'unchanged'")).toBe(1);
  });

  test("link_sources links the draft's sources to an active match, so its other keys find the task too", () => {
    const first = draft(["jira:FIX-1"]);
    submit(first.ops);
    const linked = submit(draft(["jira:FIX-1", "jira:FIX-2"], { link: true }).ops);
    expectStatus(linked, "applied");
    expect(linked.results.map((r) => [r.status, r.task])).toEqual([
      ["existing", first.id],
      ["unchanged", first.id],
      ["created", first.id],
    ]);
    expect(holders(fx.reader, "jira:FIX-2")).toEqual([first.id]);
    expect(submit(draft(["jira:FIX-2"]).ops).results[0]).toMatchObject({
      status: "existing",
      id: first.id,
    });
  });

  test("several active tasks hold the draft's keys: existing with every one, and nothing follows", () => {
    const first = draft(["jira:FIX-1"]);
    const second = draft(["jira:FIX-2"]);
    submit([...first.ops, ...second.ops]);
    const both = submit(draft(["jira:FIX-1", "jira:FIX-2"], { log: "Which one?" }).ops);
    expectStatus(both, "unchanged");
    expect(both.results[0]).toEqual({
      i: 0,
      status: "existing",
      id: first.id,
      task: first.id,
      ref: "M-1",
      version: expect.any(Number) as number,
      matched_by: "source_key",
      lifecycle: "active",
      ambiguous: ["M-1", "M-2"],
    });
    expect(both.results.slice(1).map((r) => r.status)).toEqual([
      "existing",
      "existing",
      "existing",
    ]);
    expect(one("SELECT count(*) FROM log_entries")).toBe(0);
    // One key that two tasks hold, because someone linked it to both.
    submit([{ kind: "source.add", task: second.id, source: ticket("jira:FIX-1") }]);
    expect(submit(draft(["jira:FIX-1"]).ops).results[0]).toMatchObject({
      ambiguous: ["M-1", "M-2"],
    });
  });

  test("a task finished within the window is returned with its lifecycle, one finished before it is not", () => {
    const first = draft(["jira:FIX-1"]);
    submit(first.ops);
    complete(first.id);
    clock.now += 29 * DAY;
    // A finished match takes nothing of the draft, its entries included: the caller decides first.
    const late = submit(draft(["jira:FIX-1"], { log: "Answered." }).ops);
    expectStatus(late, "unchanged");
    expect(late.results[0]).toMatchObject({
      status: "existing",
      id: first.id,
      matched_by: "source_key",
      lifecycle: "completed",
    });
    expect(late.results[1]).toMatchObject({ status: "existing", id: first.id });
    // Past the window: a new task, linked to the one source row its key has.
    clock.now += 2 * DAY;
    const fresh = draft(["jira:FIX-1"]);
    expect(submit(fresh.ops).results[0]).toMatchObject({
      status: "created",
      id: fresh.id,
      ref: "M-2",
    });
    expect(holders(fx.reader, "jira:FIX-1")).toEqual([first.id, fresh.id].sort());
    expect(one("SELECT count(*) FROM sources")).toBe(1);
    // An active match comes first, however recent the finished one.
    complete(fresh.id);
    const recent = draft(["jira:FIX-1"]);
    submit([{ kind: "task.reopen", task: first.id }], { actor: "human", base: fx.base() });
    expect(submit(recent.ops).results[0]).toMatchObject({ id: first.id, lifecycle: "active" });
    // Of several finished matches the one finished last.
    complete(first.id);
    expect(submit(recent.ops).results[0]).toMatchObject({ id: first.id, lifecycle: "completed" });
  });

  test("the window is the space's tasks.dedupe_window_days", async () => {
    const conn = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
    try {
      conn
        .prepare(
          "INSERT INTO preferences (key, value, schema_ver, policy, created_seq, version) " +
            "VALUES ('tasks.dedupe_window_days', '5', 1, 0, 0, 0)",
        )
        .run();
    } finally {
      conn.close();
    }
    const first = draft(["jira:FIX-1"]);
    submit(first.ops);
    complete(first.id);
    clock.now += 4 * DAY;
    expect(submit(draft(["jira:FIX-1"]).ops).results[0]?.status).toBe("existing");
    clock.now += 2 * DAY;
    expect(submit(draft(["jira:FIX-1"]).ops).results[0]?.status).toBe("created");
  });

  test("dedupe new creates beside finished tasks and is refused against an active one; none never matches", () => {
    const first = draft(["jira:FIX-1"]);
    submit(first.ops);
    // Refused while an active task holds the key, decided and stored (A3 3.4.5: invalid_input).
    const refused = submit(draft(["jira:FIX-1"], { dedupe: "new" }).ops);
    expectStatus(refused, "rejected");
    expect(refused.error).toMatchObject({ code: "VALIDATION_FAILED", op: 0, field: "dedupe" });
    expect(one("SELECT count(*) FROM receipts WHERE status = 'rejected'")).toBe(1);
    // Beside a finished one: a new active task, which later drafts find first.
    complete(first.id);
    const anew = draft(["jira:FIX-1"], { dedupe: "new" });
    expect(submit(anew.ops).results[0]).toMatchObject({ status: "created", id: anew.id });
    expect(submit(draft(["jira:FIX-1"]).ops).results[0]).toMatchObject({
      status: "existing",
      id: anew.id,
      lifecycle: "active",
    });
    // none: a task whatever holds the key (the importer's legacy tasks, A7 3.15.3), and the
    // source the key names is linked, never written twice.
    const legacy = draft(["jira:FIX-1"], { dedupe: "none" });
    expect(submit(legacy.ops).results[0]).toMatchObject({ status: "created", id: legacy.id });
    expect(holders(fx.reader, "jira:FIX-1")).toEqual([first.id, anew.id, legacy.id].sort());
    expect(one("SELECT count(*) FROM sources")).toBe(1);
  });

  test("a removed link and a deleted task never match", async () => {
    const first = draft(["jira:FIX-1"]);
    const created = submit(first.ops);
    const source = created.results[1]?.id ?? "";
    await rawSet("task_sources", `${first.id}|${source}`, first.id, "removed", {
      removed_at: "$at",
    });
    const second = draft(["jira:FIX-1"]);
    expect(submit(second.ops).results[0]).toMatchObject({ status: "created", id: second.id });
    expect(one("SELECT count(*) FROM sources")).toBe(1);
    expectStatus(
      submit([{ kind: "task.delete", task: second.id }], { actor: "human", base: fx.base() }),
      "applied",
    );
    const third = draft(["jira:FIX-1"]);
    expect(submit(third.ops).results[0]).toMatchObject({ status: "created", id: third.id });
  });

  test("the request's own links and lifecycle changes count, whatever the order of its operations", () => {
    // Two drafts of one request with one key: the second finds the first.
    const a = draft(["jira:FIX-1"]);
    const b = draft(["jira:FIX-1"], { log: "Same thread." });
    const pair = submit([...a.ops, ...b.ops]);
    expect(pair.results.map((r) => [r.status, r.task ?? r.id])).toEqual([
      ["created", a.id],
      ["created", a.id],
      ["existing", a.id],
      ["created", a.id],
      ["existing", a.id],
    ]);
    // Its sources after both creates: the draft's keys count from its create on.
    const c = draft(["jira:FIX-2"]);
    const d = draft(["jira:FIX-2"]);
    const [cCreate, ...cRest] = c.ops;
    const [dCreate, ...dRest] = d.ops;
    if (cCreate === undefined || dCreate === undefined) throw new Error("no create");
    const crossed = submit([cCreate, dCreate, ...cRest, ...dRest]);
    expect(crossed.results.map((r) => r.status)).toEqual([
      "created",
      "existing",
      "created",
      "existing",
    ]);
    expect(holders(fx.reader, "jira:FIX-2")).toEqual([c.id]);
    // A task the request completes before the draft finished last of all and is no match: the
    // draft is new work after it, as complete_task's follow-up of the same ticket is (A3 3.4.8),
    // and later drafts find it.
    const after = draft(["jira:FIX-1"]);
    const finished = submit([{ kind: "task.complete", task: a.id }, ...after.ops], {
      actor: "human",
      base: fx.base(),
    });
    expect(finished.results.map((r) => [r.status, r.task ?? r.id])).toEqual([
      ["updated", a.id],
      ["created", after.id],
      ["created", after.id],
    ]);
    expect(holders(fx.reader, "jira:FIX-1")).toEqual([a.id, after.id].sort());
    expect(submit(draft(["jira:FIX-1"]).ops).results[0]).toMatchObject({
      status: "existing",
      id: after.id,
      lifecycle: "active",
    });
    // So is the next one in the chain, though an earlier task with the key finished within the
    // window: the task the request completes is the one finished last.
    const next = draft(["jira:FIX-1"]);
    const chained = submit([{ kind: "task.complete", task: after.id }, ...next.ops], {
      actor: "human",
      base: fx.base(),
    });
    expect(chained.results[1]).toMatchObject({ status: "created", id: next.id });
    complete(next.id);
    // A task the request reopens is an active one, even when it finished before the window.
    clock.now += 40 * DAY;
    const reopened = submit(
      [{ kind: "task.reopen", task: a.id }, ...draft(["jira:FIX-1"], { log: "Back." }).ops],
      { actor: "human", base: fx.base() },
    );
    expect(reopened.results.map((r) => [r.status, r.task])).toEqual([
      ["updated", undefined],
      ["existing", a.id],
      ["created", a.id],
      ["existing", a.id],
    ]);
  });

  test("a draft that may match by source key takes only entries, sources and a place: any other operation or a sibling that names it is refused, whatever the space holds", () => {
    const first = draft(["jira:FIX-1"]);
    submit(first.ops);
    const receipts = one("SELECT count(*) FROM receipts");
    // The same refusal whether the key matches a task (FIX-1) or not (FIX-9): it depends on the
    // input alone, so it is checked before the transaction and stores nothing (A1 3.7).
    for (const key of ["jira:FIX-1", "jira:FIX-9"]) {
      const again = draft([key]);
      const n = again.ops.length;
      const at = (field: string) => ({
        code: "VALIDATION_FAILED",
        op: n,
        field: `ops[${String(n)}].${field}`,
      });
      for (const op of [
        { kind: "task.patch", task: again.id, set: { summary: "Next: call back" } },
        { kind: "task.complete", task: again.id },
        { kind: "task.reopen", task: again.id },
        { kind: "task.move", task: again.id, area: "home" },
        { kind: "place.clear", task: again.id },
      ] satisfies Operation[]) {
        const refused = submit([...again.ops, op]);
        expectStatus(refused, "rejected");
        expect(refused.error, op.kind).toMatchObject(at("task"));
      }
      const created = submit([
        ...again.ops,
        { kind: "task.create", title: "Call the clinic", after: again.id },
      ]);
      expect(created.error).toMatchObject(at("after"));
      const moved = submit([...again.ops, { kind: "task.move", task: first.id, before: again.id }]);
      expect(moved.error).toMatchObject(at("before"));
    }
    expect(one("SELECT count(*) FROM receipts")).toBe(receipts);
    expect(one("SELECT count(*) FROM tasks")).toBe(1);
    // A draft that never matches takes them: dedupe new or none, or no keyed source.
    for (const [keys, dedupe] of [
      [["jira:FIX-7"], "new"],
      [["jira:FIX-1"], "none"],
      [[], undefined],
    ] as const) {
      const fresh = draft(keys, dedupe === undefined ? {} : { dedupe });
      const changed = submit(
        [
          ...fresh.ops,
          { kind: "task.patch", task: fresh.id, set: { summary: "Next: call back" } },
          { kind: "task.complete", task: fresh.id },
        ],
        { actor: "human" },
      );
      expectStatus(changed, "applied");
      expect(changed.results[0]).toMatchObject({ status: "created", id: fresh.id });
      expect(one("SELECT lifecycle FROM tasks WHERE id = $id", { id: fresh.id })).toBe("completed");
    }
  });

  test("a matched draft's place is left out, and checked as a created draft's is", () => {
    const first = draft(["jira:FIX-1"]);
    submit(first.ops);
    // The place binds a folder on the request's machine, which needs its record in the space
    // whether or not the draft matches (A1 3.15).
    for (const key of ["jira:FIX-1", "jira:FIX-9"]) {
      const placed = draft([key], { place: true });
      const result = fx.writer.submit(
        fx.request({ ...fx.codex, machine_id: newId("m") }, placed.ops),
      );
      expectStatus(result, "rejected");
      expect(result.error).toMatchObject({
        code: "VALIDATION_FAILED",
        op: 2,
        field: "actor.machine_id",
      });
    }
    expect(one("SELECT count(*) FROM tasks")).toBe(1);
    expect(one("SELECT count(*) FROM places")).toBe(0);
  });

  test("of finished matches with one instant, the one whose commit came last", () => {
    // Commit instants never go back (A1 3.9): after the clock does, two completions share one.
    const a = draft(["jira:FIX-1"]);
    submit(a.ops);
    const b = draft(["jira:FIX-1"], { dedupe: "none" });
    submit(b.ops);
    complete(b.id);
    clock.now -= 10 * DAY;
    complete(a.id);
    const at = (id: string): unknown =>
      one("SELECT completed_at FROM tasks WHERE id = $id", { id });
    expect(at(a.id)).toBe(at(b.id));
    expect(submit(draft(["jira:FIX-1"]).ops).results[0]).toMatchObject({
      status: "existing",
      id: a.id,
      ref: "M-1",
      lifecycle: "completed",
    });
  });

  test("the input: a dedupe mode, and link_sources only with dedupe by source key", () => {
    const error = (create: Record<string, unknown>): unknown => {
      // Input as a caller may send it: the writer checks it at run time.
      const ops: unknown[] = [{ kind: "task.create", title: "Answer the clinic", ...create }];
      const result = fx.writer.submit({ ...fx.request(fx.codex, []), ops });
      return [result.error?.code, result.error?.field];
    };
    expect(error({ dedupe: "title" })).toEqual(["VALIDATION_FAILED", "ops[0].dedupe"]);
    expect(error({ link_sources: "yes" })).toEqual(["VALIDATION_FAILED", "ops[0].link_sources"]);
    expect(error({ dedupe: "none", link_sources: true })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].link_sources",
    ]);
    expect(error({ dedupe: "new", link_sources: true })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].link_sources",
    ]);
    // Dedupe without a keyed source of the draft creates the task.
    expect(error({ dedupe: "source_key", link_sources: true })).toEqual([undefined, undefined]);
  });

  test("a request that returned existing, retried after the window, replays existing and creates nothing", () => {
    const first = draft(["jira:FIX-1"]);
    submit(first.ops);
    complete(first.id);
    const request = fx.request(fx.codex, draft(["jira:FIX-1"], { log: "Answered." }).ops);
    const found = fx.writer.submit(request);
    expectStatus(found, "unchanged");
    expect(found.results[0]).toMatchObject({ status: "existing", lifecycle: "completed" });
    clock.now += 40 * DAY;
    // The receipt comes before dedupe (A1 3.8): the same intent replays, whatever the state is now.
    expect(fx.writer.submit(request)).toEqual({ ...found, replayed: true });
    expect(one("SELECT count(*) FROM tasks")).toBe(1);
    // A new request ID is a new decision: past the window, a new task.
    const anew = fx.writer.submit({ ...request, request_id: "fixture-request-anew-000001" });
    expectStatus(anew, "applied");
    expect(anew.results[0]?.status).toBe("created");
    expect(one("SELECT count(*) FROM tasks")).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Sessions: overlapping keys from several sessions, against a reference model.

/** Five keys, so drafts of one or two keys overlap often. */
const KEYS = ["jira:FIX-1", "jira:FIX-2", "jira:FIX-3", "github:lumen/portal#4", "email:<5@x>"];

/** A draft's `on_existing` as A3 3.4.5 maps it onto A1 3.6: return, add_sources, create_new. */
type Mode = "return" | "link" | "new";

interface DraftSpec {
  keys: number[];
  log: boolean;
  mode: Mode;
}

type Step =
  | { kind: "add"; session: number; drafts: DraftSpec[] }
  | { kind: "complete"; pick: number }
  | { kind: "reopen"; pick: number }
  | { kind: "retry"; pick: number }
  | { kind: "jump" };

const draftSpec: fc.Arbitrary<DraftSpec> = fc.record({
  keys: fc.uniqueArray(fc.nat({ max: KEYS.length - 1 }), { minLength: 1, maxLength: 2 }),
  log: fc.boolean(),
  // Mostly the default, as a refresh sends.
  mode: fc.constantFrom<Mode>("return", "return", "return", "link", "new"),
});

const sessionStep: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("add" as const),
      session: fc.nat({ max: 2 }),
      drafts: fc.array(draftSpec, { minLength: 1, maxLength: 3 }),
    }),
    weight: 8,
  },
  { arbitrary: fc.record({ kind: fc.constant("complete" as const), pick: fc.nat() }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("reopen" as const), pick: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("retry" as const), pick: fc.nat() }), weight: 2 },
  // The clock moves past the window: every task finished before then no longer matches.
  { arbitrary: fc.record({ kind: fc.constant("jump" as const) }), weight: 1 },
);

interface ModelTask {
  ref: number;
  lifecycle: "active" | "completed";
  /** The order of its last completion: the later, the higher. */
  finished: number;
  /** The window it last finished in: it matches as finished only in the current one. */
  window: number;
  logs: number;
}

/**
 * What a request returns: its status and, when accepted, each operation's `<status> <task>` in
 * order; when refused, the operation of the `new` draft an active task refused.
 */
type Predicted =
  | {
      status: "applied" | "unchanged";
      results: string[];
      /**
       * Sources add_sources linked to a match, `new` drafts created beside finished tasks, and
       * other drafts created because every task with their keys finished before the window.
       */
      linked: number;
      beside: number;
      past: number;
    }
  | { status: "rejected"; op: number };

interface ModelDraft {
  id: Id<"t">;
  keys: string[];
  log: boolean;
  mode: Mode;
}

/**
 * The reference model of A1 3.6's dedupe: the tasks each key is linked to, and each task's
 * lifecycle and log entries. Between jumps the clock moves by seconds, so a task finished since
 * the last jump is within the window and one finished before it is not.
 */
class SessionsModel {
  tasks = new Map<Id<"t">, ModelTask>();
  keys = new Map<string, Set<Id<"t">>>();
  #finished = 0;
  /** The window the clock stands in: each jump starts the next. */
  window = 0;

  /** Predicts a request of `drafts` and changes the model as the writer would. */
  add(drafts: readonly ModelDraft[]): Predicted {
    // On copies: a refused request changes nothing.
    const tasks = new Map([...this.tasks].map(([id, t]) => [id, { ...t }]));
    const keys = new Map([...this.keys].map(([k, held]) => [k, new Set(held)]));
    const task = (t: Id<"t">): ModelTask => {
      const found = tasks.get(t);
      if (found === undefined) throw new Error("the model has no such task");
      return found;
    };
    const hold = (key: string, t: Id<"t">): void => {
      keys.set(key, new Set([...(keys.get(key) ?? []), t]));
    };
    const results: string[] = [];
    let applied = false;
    let index = 0;
    let linked = 0;
    let beside = 0;
    let past = 0;
    for (const d of drafts) {
      const holders = [...new Set(d.keys.flatMap((k) => [...(keys.get(k) ?? [])]))];
      const active = holders
        .filter((t) => task(t).lifecycle === "active")
        .sort((a, b) => task(a).ref - task(b).ref);
      const recent = holders.filter(
        (t) => task(t).lifecycle === "completed" && task(t).window === this.window,
      );
      const size = 1 + (d.log ? 1 : 0) + d.keys.length;
      const [first] = active;
      if (d.mode === "new" && first !== undefined) return { status: "rejected", op: index };
      if (d.mode !== "new" && first !== undefined && active.length === 1) {
        // One active match: the draft's log follows it, and its sources with add_sources.
        results.push(`existing ${first}`);
        if (d.log) {
          results.push(`created ${first}`);
          task(first).logs += 1;
          applied = true;
        }
        for (const key of d.keys) {
          if (d.mode !== "link") {
            results.push(`existing ${first}`);
            continue;
          }
          const held = keys.get(key)?.has(first) === true;
          results.push(`${held ? "unchanged" : "created"} ${first}`);
          if (!held) {
            applied = true;
            linked += 1;
          }
          hold(key, first);
        }
      } else if (d.mode !== "new" && (first !== undefined || recent.length > 0)) {
        // Ambiguous, or finished within the window only (the one finished last): nothing of the
        // draft follows.
        const named =
          first ?? recent.sort((a, b) => task(b).finished - task(a).finished)[0] ?? d.id;
        for (let k = 0; k < size; k += 1) results.push(`existing ${named}`);
      } else {
        if (holders.length > 0 && d.mode === "new") beside += 1;
        // Every holder finished before the window: a new task, as if the key were new.
        if (holders.length > 0 && d.mode !== "new") past += 1;
        tasks.set(d.id, {
          ref: tasks.size + 1,
          lifecycle: "active",
          finished: 0,
          window: this.window,
          logs: d.log ? 1 : 0,
        });
        for (const key of d.keys) hold(key, d.id);
        for (let k = 0; k < size; k += 1) results.push(`created ${d.id}`);
        applied = true;
      }
      index += size;
    }
    this.tasks = tasks;
    this.keys = keys;
    return { status: applied ? "applied" : "unchanged", results, linked, beside, past };
  }

  complete(t: Id<"t">): void {
    const task = this.tasks.get(t);
    if (task === undefined) throw new Error("the model has no such task");
    task.lifecycle = "completed";
    task.finished = this.#finished += 1;
    task.window = this.window;
  }

  reopen(t: Id<"t">): void {
    const task = this.tasks.get(t);
    if (task === undefined) throw new Error("the model has no such task");
    task.lifecycle = "active";
  }

  /** The active tasks a key is linked to. */
  active(key: string): number {
    return [...(this.keys.get(key) ?? [])].filter((t) => this.tasks.get(t)?.lifecycle === "active")
      .length;
  }
}

/** The space against the model: each key's holders, each task's lifecycle and log entries. */
function expectSessionsModel(conn: Connection, model: SessionsModel): void {
  for (const key of KEYS) {
    expect(holders(conn, key), key).toEqual([...(model.keys.get(key) ?? [])].sort());
  }
  const rows = conn
    .prepare(
      "SELECT t.id AS id, t.ref AS ref, t.lifecycle AS lifecycle, " +
        "(SELECT count(*) FROM log_entries l WHERE l.task_id = t.id) AS logs FROM tasks t",
    )
    .all();
  expect(rows.length).toBe(model.tasks.size);
  for (const row of rows) {
    const task = model.tasks.get(row["id"] as Id<"t">);
    expect(row).toEqual({
      id: row["id"],
      ref: task?.ref,
      lifecycle: task?.lifecycle,
      logs: task?.logs,
    });
  }
}

const sessionsProperty = (seen: Record<string, number>) =>
  fc.asyncProperty(fc.array(sessionStep, { minLength: 8, maxLength: 30 }), async (steps) => {
    const space = await writeFixture(temp.make());
    // One second per commit, and past the window at a jump.
    let now = Date.UTC(2026, 10, 13, 8);
    space.reopen({ now: () => (now += 1000) });
    try {
      const sessions: Credential[] = [space.human, space.codex, space.claude];
      const model = new SessionsModel();
      const sent: { request: WriteRequest; result: WriteResult; window: number }[] = [];
      const count = (label: string): void => {
        seen[label] = (seen[label] ?? 0) + 1;
      };
      // A reopen is the user's act and may leave two active tasks with one key; dedupe never does.
      let reopened = false;
      for (const s of steps) {
        if (s.kind === "jump") {
          now += (DEDUPE_WINDOW_DAYS + 1) * DAY;
          model.window += 1;
          count("jump");
        } else if (s.kind === "complete" || s.kind === "reopen") {
          const want = s.kind === "complete" ? "active" : "completed";
          const pool = [...model.tasks].filter(([, t]) => t.lifecycle === want);
          const picked = pool[s.pick % Math.max(pool.length, 1)];
          if (picked === undefined) continue;
          const [id] = picked;
          const op: Operation = {
            kind: s.kind === "complete" ? "task.complete" : "task.reopen",
            task: id,
          };
          const base = space.base();
          expectStatus(space.writer.submit(space.request(space.human, [op], { base })), "applied");
          if (s.kind === "complete") model.complete(id);
          else model.reopen(id);
          reopened ||= s.kind === "reopen";
          count(s.kind);
        } else if (s.kind === "retry") {
          const earlier = sent[s.pick % Math.max(sent.length, 1)];
          if (earlier === undefined) continue;
          // The stored result, whatever happened to the tasks and keys since (A1 3.8), also after
          // the window: an `existing` replays `existing`, and the space still matches the model,
          // so nothing was created.
          expect(space.writer.submit(earlier.request)).toEqual({
            ...earlier.result,
            replayed: true,
          });
          count("replayed");
          if (
            earlier.window < model.window &&
            earlier.result.results.some((r) => r.matched_by !== undefined)
          ) {
            count("existing replayed after the window");
          }
        } else {
          const drafts: ModelDraft[] = s.drafts.map((d) => ({
            id: newId("t"),
            keys: d.keys.map((k) => KEYS[k] ?? ""),
            log: d.log,
            mode: d.mode,
          }));
          const ops: Operation[] = drafts.flatMap((d): Operation[] => [
            {
              kind: "task.create",
              id: d.id,
              title: "Answer the clinic",
              ...(d.mode === "new" ? { dedupe: "new" as const } : {}),
              ...(d.mode === "link" ? { link_sources: true } : {}),
            },
            ...(d.log
              ? [{ kind: "log.add" as const, task: d.id, body: "New in the thread." }]
              : []),
            ...d.keys.map((key): Operation => ({
              kind: "source.add",
              task: d.id,
              source: ticket(key),
            })),
          ]);
          const predicted = model.add(drafts);
          const actor = sessions[s.session];
          if (actor === undefined) throw new Error("no session");
          const request = space.request(actor, ops);
          const result = space.writer.submit(request);
          sent.push({ request, result, window: model.window });
          expect(result.status, JSON.stringify(result.error)).toBe(predicted.status);
          if (predicted.status === "rejected") {
            expect(result.error).toMatchObject({
              code: "VALIDATION_FAILED",
              op: predicted.op,
              field: "dedupe",
            });
            count("refused new");
          } else {
            expect(result.results.map((r) => `${r.status} ${r.task ?? r.id}`)).toEqual(
              predicted.results,
            );
            if (predicted.linked > 0) count("source linked");
            if (predicted.beside > 0) count("created new");
            if (predicted.past > 0) count("created past the window");
          }
          for (const r of result.results) {
            if (r.ambiguous !== undefined) count("ambiguous");
            else if (r.lifecycle === "completed") count("existing completed");
            else if (r.matched_by !== undefined) count("existing active");
          }
          if (s.drafts.length > 1) count("drafts in one request");
        }
        expectSessionsModel(space.reader, model);
        if (!reopened) {
          for (const key of KEYS) expect(model.active(key), key).toBeLessThanOrEqual(1);
        }
      }
      checkHistory(space.reader);
    } finally {
      space.close();
    }
  });

describe("[A1.5.write.dedupe-sessions] overlapping keys from several sessions", () => {
  test("property: interleaved drafts in every on_existing mode, completions, reopens, retries and jumps past the window leave at most one active task per key, as the model predicts", async () => {
    const seen: Record<string, number> = {};
    await fc.assert(sessionsProperty(seen), { numRuns: 100, seed: 20261114 });
    for (const outcome of [
      "existing active",
      "existing completed",
      "ambiguous",
      "refused new",
      "created new",
      "source linked",
      "replayed",
      "complete",
      "reopen",
      "drafts in one request",
      "jump",
      "created past the window",
      "existing replayed after the window",
    ]) {
      expect(seen[outcome] ?? 0, outcome).toBeGreaterThan(3);
    }
    await fc.assert(sessionsProperty({}), { numRuns: 15 });
  }, 180_000);

  test("requests sent at once through the storage worker leave one task per key", async () => {
    const created = await createFixtureSpace(temp.make());
    const worker = await StorageWorker.start({ driver: "node:sqlite" });
    try {
      const writer = await worker.openSpaceWriter(created.folder, {
        machine: MACHINE,
        // Thirty requests wait in one queue: no limit of this test's own on how long that takes.
        timeoutMs: 600_000,
      });
      const session = (n: number): Credential => ({
        scope_id: `cli:session-${String(n)}`,
        principal_id: created.actors.human,
        actor_kind: "human",
        machine_id: TEST_MACHINE,
        origin: "cli",
      });
      const requests: WriteRequest[] = [];
      for (let s = 0; s < 3; s += 1) {
        for (let n = 0; n < 10; n += 1) {
          // Two keys that overlap other sessions' drafts, and now and then one: every key gets
          // a draft of its own, so each ends up held.
          const pair = [KEYS[(s + n) % 4], KEYS[(s * 2 + n + 1) % 4]];
          const keys = (n % 3 === 0 ? pair.slice(0, 1) : pair).filter(
            (k, i, all): k is string => k !== undefined && all.indexOf(k) === i,
          );
          requests.push({
            space_id: created.space.spaceId,
            request_id: `session-${String(s)}-request-${String(n).padStart(6, "0")}`,
            actor: session(s),
            ops: draft(keys, { log: "New in the thread." }).ops,
          });
        }
      }
      const results = await Promise.all(requests.map((r) => writer.submit(r)));
      for (const result of results) expect(["applied", "unchanged"]).toContain(result.status);
      await writer.close();
      const reader = openSpace(await checkedDriver(), created.folder, { role: "reader" }).conn;
      try {
        for (const key of KEYS.slice(0, 4)) expect(holders(reader, key), key).toHaveLength(1);
        const tasks = Number(reader.prepare("SELECT count(*) AS n FROM tasks").get()?.["n"]);
        const createdTasks = results.filter((r) => r.results[0]?.status === "created").length;
        expect(tasks).toBe(createdTasks);
        expect(tasks).toBeLessThanOrEqual(4);
        checkHistory(reader);
      } finally {
        reader.close();
      }
    } finally {
      await worker.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// The lifecycle steps dedupe stages (A7 3.10 M3.04): archive, wrap-up, delete and restore.

describe("[A1.5.write.dedupe-lifecycle] dedupe sees the request's archive, wrap-up, delete and restore", () => {
  beforeEach(async () => {
    fx = await writeFixture(temp.make());
    clock.now = Date.UTC(2026, 10, 13, 8);
    fx.reopen({ now: tick });
  });
  afterEach(() => {
    checkHistory(fx.reader);
    fx.close();
  });

  const human = (ops: Operation[]): WriteResult => {
    const result = submit(ops, { actor: "human", base: fx.base() });
    expectStatus(result, "applied");
    return result;
  };

  test("an archived task within the window matches with lifecycle archived, finished at the commit that archived it", () => {
    const first = draft(["jira:FIX-1"]);
    submit(first.ops);
    // Archived: no completion time, so it finished at the instant of its archive's commit.
    human([{ kind: "task.archive", task: first.id, reason: "Won't do." }]);
    const archivedAt = Number(
      one("SELECT at FROM commits WHERE seq = (SELECT max(seq) FROM commits)"),
    );
    expect(one("SELECT completed_at FROM tasks WHERE id = $id", { id: first.id })).toBeNull();
    // A later change to another field does not move when it finished.
    clock.now += 20 * DAY;
    human([{ kind: "task.patch", task: first.id, set: { summary: "Kept for the record" } }]);
    clock.now = archivedAt + 29 * DAY;
    expect(submit(draft(["jira:FIX-1"]).ops).results[0]).toMatchObject({
      status: "existing",
      id: first.id,
      matched_by: "source_key",
      lifecycle: "archived",
    });
    // Of an archived and a completed task, the one finished last.
    const second = draft(["jira:FIX-1"], { dedupe: "none" });
    submit(second.ops);
    complete(second.id);
    expect(submit(draft(["jira:FIX-1"]).ops).results[0]).toMatchObject({
      id: second.id,
      lifecycle: "completed",
    });
    // Past the window counted from the archive and the completion: a new task.
    clock.now += 31 * DAY;
    const late = draft(["jira:FIX-1"]);
    expect(submit(late.ops).results[0]).toMatchObject({ status: "created", id: late.id });
  });

  test("a task the request archives or wraps up is no match for a later draft: it is new work", () => {
    const a = draft(["jira:FIX-1"]);
    submit(a.ops);
    const after = draft(["jira:FIX-1"]);
    const archived = human([{ kind: "task.archive", task: a.id }, ...after.ops]);
    expect(archived.results.map((r) => [r.status, r.task ?? r.id])).toEqual([
      ["updated", a.id],
      ["created", after.id],
      ["created", after.id],
    ]);
    // A task the user checked off earlier, wrapped up with a follow-up of its own ticket.
    const b = draft(["jira:FIX-2"]);
    submit(b.ops);
    complete(b.id);
    const follow = draft(["jira:FIX-2"]);
    const wrapped = human([
      { kind: "task.wrap_up", task: b.id, outcome: "Answered the clinic." },
      ...follow.ops,
    ]);
    expect(wrapped.results.map((r) => [r.status, r.task ?? r.id])).toEqual([
      ["updated", b.id],
      ["created", follow.id],
      ["created", follow.id],
    ]);
    expect(holders(fx.reader, "jira:FIX-2")).toEqual([b.id, follow.id].sort());
    // A finishing operation that finds the task finished already (if_active) or wrapped already
    // (once) says the same, though it writes nothing: complete_task's follow-up of a task the
    // user finished first is new work after it too (A3 3.4.8).
    for (const [key, finish] of [
      [
        "jira:FIX-3",
        (id: Id<"t">): Operation => ({ kind: "task.archive", task: id, if_active: true }),
      ],
      [
        "jira:FIX-4",
        (id: Id<"t">): Operation => ({
          kind: "task.wrap_up",
          task: id,
          outcome: "Answered the clinic.",
          once: true,
        }),
      ],
    ] as const) {
      const done = draft([key]);
      submit(done.ops);
      complete(done.id);
      human([{ kind: "task.wrap_up", task: done.id, outcome: "Answered the clinic." }]);
      // Alone, a draft with its key matches the task finished within the window.
      expect(submit(draft([key]).ops).results[0]).toMatchObject({
        status: "existing",
        id: done.id,
      });
      const next = draft([key]);
      const kept = human([finish(done.id), ...next.ops]);
      expect(kept.results.map((r) => [r.status, r.task ?? r.id])).toEqual([
        ["unchanged", done.id],
        ["created", next.id],
        ["created", next.id],
      ]);
    }
  });

  test("a task the request deletes holds no key, and one it restores holds its keys again", () => {
    const a = draft(["jira:FIX-1"]);
    submit(a.ops);
    const fresh = draft(["jira:FIX-1"]);
    const deleted = human([{ kind: "task.delete", task: a.id }, ...fresh.ops]);
    expect(deleted.results[1]).toMatchObject({ status: "created", id: fresh.id });
    // Restored in the same request as a draft with its key: an active holder again, so with the
    // other active holder the match is ambiguous.
    const both = human([{ kind: "task.restore", task: a.id }, ...draft(["jira:FIX-1"]).ops]);
    expect(both.results[1]).toMatchObject({ status: "existing", ambiguous: ["M-1", "M-2"] });
    // Deleted in a request of its own, then restored before a draft: the draft's entries follow.
    const b = draft(["jira:FIX-2"]);
    submit(b.ops);
    human([{ kind: "task.delete", task: b.id }]);
    const back = human([
      { kind: "task.restore", task: b.id },
      ...draft(["jira:FIX-2"], { log: "Back in the thread." }).ops,
    ]);
    expect(back.results.map((r) => [r.status, r.task ?? r.id])).toEqual([
      ["updated", b.id],
      ["existing", b.id],
      ["created", b.id],
      ["existing", b.id],
    ]);
  });
});
