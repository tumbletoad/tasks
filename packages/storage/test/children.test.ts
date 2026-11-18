// The remaining skeleton operations (A1 3.6, 3.15; A7 3.8 M1.05): note.add, log.add, source.add
// and place.set, with their checks, history and results. Fixture text only.
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Connection } from "../src/driver.ts";
import { newId, type Id } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import { normaliseSourceKey, type Operation, type WriteResult } from "../src/write/request.ts";
import { checkedDriver, TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, type Fixture, fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("children");
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
const changesAt = (seq: number): Row[] =>
  fx.reader.prepare("SELECT * FROM changes WHERE seq = $seq ORDER BY n").all({ seq });
const opsAt = (seq: number): { op: string; target: string; input: Row }[] =>
  JSON.parse(String(one("SELECT ops FROM commits WHERE seq = $seq", { seq }))) as {
    op: string;
    target: string;
    input: Row;
  }[];

/** Submits as `actor` (Mira by default), with a fresh base unless one is given. */
function submit(
  ops: Operation[],
  extra: { base?: string | null; actor?: "human" | "codex" | "claude" } = {},
): WriteResult {
  const actor = fx[extra.actor ?? "human"];
  const base = extra.base === undefined ? fx.base() : extra.base;
  return fx.writer.submit(fx.request(actor, ops, base === null ? {} : { base }));
}

function create(title = "Fix the export"): Id<"t"> {
  const id = newId("t");
  expectStatus(submit([{ kind: "task.create", id, title }]), "applied");
  return id;
}

/** A second connection between the writer's requests, for states no operation makes yet. */
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
 * Removes a link as M3's `source.unlink` will: a commit by Mira that sets the link's `removed`
 * field, with its change row, versions, touched mark and outbox row. Returns the commit's seq.
 */
async function unlink(task: Id<"t">, source: string): Promise<number> {
  let done = 0;
  await raw((conn) => {
    const seq = Number(conn.prepare("SELECT last_seq FROM space").get()?.["last_seq"]) + 1;
    const at = Number(conn.prepare("SELECT max(at) AS at FROM commits").get()?.["at"]) + 1000;
    const space = conn.prepare("SELECT * FROM space").get();
    const link = conn
      .prepare("SELECT * FROM task_sources WHERE task_id = $task AND source_id = $source")
      .get({ task, source });
    if (space === undefined || link === undefined) throw new Error("no link");
    const id = `${task}|${source}`;
    conn
      .prepare(
        "INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id, " +
          "author_id, scope_id, machine_id, origin, request_id, kind, ops) VALUES ($seq, $op, " +
          "$epoch, $incarnation, $at, 'human', $human, $human, 'cli:fixture', $machine, 'cli', " +
          "$request, 'ops', $ops)",
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
        ops: JSON.stringify([{ v: 1, op: "source.unlink", target: source, input: { task } }]),
      });
    conn
      .prepare(
        "INSERT INTO changes (seq, n, op, entity, entity_id, task_id, action, field, before, " +
          "after, before_ver, before_prov, after_prov) VALUES ($seq, 1, 0, 'task_sources', $id, " +
          "$task, 'set', 'removed', 'null', $at, $version, $version, $seq)",
      )
      .run({ seq, id, task, at: String(at), version: link["version"] as number });
    const versions = JSON.stringify({ removed: seq });
    conn
      .prepare(
        "UPDATE task_sources SET removed_at = $at, version = $seq, fv = $v, fp = $v " +
          "WHERE task_id = $task AND source_id = $source",
      )
      .run({ at, seq, v: versions, task, source });
    conn.prepare("UPDATE tasks SET touched = $seq WHERE id = $task").run({ seq, task });
    conn
      .prepare(
        "INSERT INTO outbox (topic, key, first_seq, seq) VALUES ('projection', $key, $seq, $seq) " +
          "ON CONFLICT (topic, key) DO UPDATE SET seq = excluded.seq",
      )
      .run({ key: task, seq });
    conn.prepare("UPDATE space SET last_seq = $seq").run({ seq });
    done = seq;
  });
  return done;
}

const EMAIL = {
  kind: "email",
  title: "Re: the export totals",
  key: "email:<41.fixture@mail.lumen.example>",
  who: "Tomas",
  url: "https://lumen.example/mail/41",
  at: Date.UTC(2026, 10, 11, 9),
} as const;

describe("[A1.5.write.children] note.add and log.add", () => {
  test("a note and a log entry: the task's next ordinal, a create row, the task touched", () => {
    const task = create();
    const version = Number(one("SELECT version FROM tasks WHERE id = $task", { task }));
    // Base-free appends (A1 3.5): no base, from an agent.
    const result = submit(
      [
        {
          kind: "note.add",
          task: "M-1",
          body: "Ask Tomas about the old export.",
          addressee: "agents",
        },
        { kind: "log.add", task, body: "Compared both exports.", log_kind: "evidence" },
        { kind: "note.add", task, body: "Second note." },
      ],
      { base: null, actor: "codex" },
    );
    expectStatus(result, "applied");
    const [note, log, second] = result.results;
    expect(note).toMatchObject({ i: 0, status: "created", task, ref: "M-1", entry: "n1" });
    expect(log).toMatchObject({ i: 1, status: "created", task, ref: "M-1", entry: "l1" });
    expect(second).toMatchObject({ i: 2, status: "created", entry: "n2", version: result.seq });
    expect(note?.id).toMatch(/^n_/);
    expect(log?.id).toMatch(/^l_/);
    const at = one("SELECT at FROM commits WHERE seq = $seq", { seq: result.seq });
    expect(row("SELECT * FROM notes WHERE id = $id", { id: note?.id })).toMatchObject({
      task_id: task,
      ordinal: 1,
      author_id: fx.codex.principal_id,
      addressee: "agents",
      audience: "all",
      body: "Ask Tomas about the old export.",
      created_at: at,
      created_seq: result.seq,
      version: result.seq,
    });
    expect(row("SELECT * FROM log_entries WHERE id = $id", { id: log?.id })).toMatchObject({
      ordinal: 1,
      kind: "evidence",
      session_id: null,
      author_id: fx.codex.principal_id,
    });
    expect(one("SELECT addressee FROM notes WHERE ordinal = 2")).toBe("self");
    // One create row each, under the task, naming the operation that created it.
    expect(changesAt(result.seq).map((c) => [c.entity, c.op, c.task_id, c.action])).toEqual([
      ["notes", 0, task, "create"],
      ["log_entries", 1, task, "create"],
      ["notes", 2, task, "create"],
    ]);
    expect(opsAt(result.seq)).toEqual([
      {
        v: 1,
        op: "note.add",
        target: note?.id,
        input: { task, body: "Ask Tomas about the old export.", addressee: "agents" },
      },
      {
        v: 1,
        op: "log.add",
        target: log?.id,
        input: { task, body: "Compared both exports.", log_kind: "evidence" },
      },
      { v: 1, op: "note.add", target: second?.id, input: { task, body: "Second note." } },
    ]);
    // The task keeps its own version and is touched (A1 3.5).
    expect(row("SELECT version, touched FROM tasks WHERE id = $task", { task })).toEqual({
      version,
      touched: result.seq,
    });
  });

  test("a log entry carries the session and run of its credential", () => {
    const task = create();
    const session = newId("se");
    const run = newId("ru");
    const result = fx.writer.submit(
      fx.request({ ...fx.claude, session_id: session, run_id: run }, [
        { kind: "log.add", task, body: "Started the run.", log_kind: "progress" },
      ]),
    );
    expectStatus(result, "applied");
    expect(row("SELECT session_id, run_id FROM log_entries")).toEqual({
      session_id: session,
      run_id: run,
    });
  });

  test("on a task the same request creates, on a missing or deleted task, and the limits", async () => {
    const id = newId("t");
    const both = submit(
      [
        { kind: "task.create", id, title: "Plan the offsite" },
        { kind: "note.add", task: id, body: "Book the room first." },
      ],
      { base: null },
    );
    expectStatus(both, "applied");
    expect(both.results.map((r) => r.status)).toEqual(["created", "created"]);
    expect(changesAt(both.seq).map((c) => [c.entity, c.op])).toEqual([
      ["tasks", 0],
      ["notes", 1],
    ]);
    const error = (op: Operation): [string, string | undefined, string | undefined] => {
      const result = submit([op], { base: null });
      return [result.status, result.error?.code, result.error?.field];
    };
    expect(error({ kind: "note.add", task: "M-99", body: "x" })).toEqual([
      "rejected",
      "NOT_FOUND",
      "task",
    ]);
    expect(error({ kind: "note.add", task: id, body: " \n " })).toEqual([
      "rejected",
      "VALIDATION_FAILED",
      "ops[0].body",
    ]);
    expect(error({ kind: "note.add", task: id, body: "é".repeat(32_769) })).toEqual([
      "rejected",
      "TOO_LARGE",
      "ops[0].body",
    ]);
    expect(error({ kind: "note.add", task: id, body: "x".repeat(65_536) })[0]).toBe("applied");
    expect(error({ kind: "log.add", task: id, body: "x".repeat(16_385) })).toEqual([
      "rejected",
      "TOO_LARGE",
      "ops[0].body",
    ]);
    expect(error({ kind: "log.add", task: id, body: "x", log_kind: "rumour" } as never)).toEqual([
      "rejected",
      "VALIDATION_FAILED",
      "ops[0].log_kind",
    ]);
    // A deleted task takes no new child row (A1 3.5: appends fail only on a deleted parent).
    await raw((conn) => conn.prepare("UPDATE tasks SET deleted_at = 1 WHERE id = $id").run({ id }));
    expect(error({ kind: "log.add", task: id, body: "x" })).toEqual([
      "rejected",
      "DELETED",
      "task",
    ]);
    await raw((conn) =>
      conn.prepare("UPDATE tasks SET deleted_at = NULL WHERE id = $id").run({ id }),
    );
  });
});

describe("[A1.5.write.children] source.add", () => {
  test("a source key is trimmed, its namespace lower-cased and its ID kept as given", () => {
    expect(normaliseSourceKey("  JIRA:LUM-212 ")).toBe("jira:LUM-212");
    expect(normaliseSourceKey("Email:<9f2c41d7@Mail.Lumen.Example>")).toBe(
      "email:<9f2c41d7@Mail.Lumen.Example>",
    );
    expect(normaliseSourceKey("github.com:lumen/portal#388")).toBe("github.com:lumen/portal#388");
    for (const bad of ["nocolon", ":id", "jira:", "ji_ra:1", "jíra:1", `ns:${"x".repeat(510)}`]) {
      expect(normaliseSourceKey(bad), bad).toBeUndefined();
    }
    expect(normaliseSourceKey(`ns:${"x".repeat(509)}`)).toHaveLength(512);
  });

  test("a new source is created and linked; the same key finds it; a live link is unchanged", () => {
    const first = create();
    const second = create("Review the export");
    const added = submit([
      {
        kind: "source.add",
        task: first,
        source: { ...EMAIL, key: "  EMAIL:<41.fixture@mail.lumen.example> " },
      },
    ]);
    expectStatus(added, "applied");
    const source = added.results[0]?.id ?? "";
    expect(added.results[0]).toMatchObject({ status: "created", task: first, ref: "M-1" });
    expect(row("SELECT * FROM sources WHERE id = $source", { source })).toMatchObject({
      source_key: EMAIL.key,
      kind: "email",
      title: EMAIL.title,
      who: "Tomas",
      ref: null,
      url: EMAIL.url,
      at: EMAIL.at,
      created_by: fx.human.principal_id,
      created_seq: added.seq,
    });
    expect(row("SELECT * FROM task_sources WHERE source_id = $source", { source })).toMatchObject({
      task_id: first,
      role: "origin",
      position: "a0",
      added_by: fx.human.principal_id,
      removed_at: null,
      version: added.seq,
    });
    expect(changesAt(added.seq).map((c) => [c.entity, c.entity_id, c.task_id, c.op])).toEqual([
      ["sources", source, first, 0],
      ["task_sources", `${first}|${source}`, first, 0],
    ]);
    expect(opsAt(added.seq)[0]).toMatchObject({
      op: "source.add",
      target: source,
      input: { task: first, source: { key: EMAIL.key } },
    });
    // The same key on the same task: the link is live, so nothing changes.
    const seq = lastSeq();
    const again = submit([{ kind: "source.add", task: first, source: EMAIL }]);
    expectStatus(again, "unchanged");
    expect(again.results[0]).toMatchObject({ status: "unchanged", id: source, version: added.seq });
    expect(lastSeq()).toBe(seq);
    // The same key on another task links the one source, and reports what the input gives
    // otherwise. The source keeps its metadata (A1 3.6).
    const linked = submit([
      {
        kind: "source.add",
        task: second,
        source: { ...EMAIL, title: "Fwd: the export totals", who: "Tomas" },
        role: "related",
      },
    ]);
    expectStatus(linked, "applied");
    expect(linked.results[0]).toMatchObject({ status: "created", id: source, differs: ["title"] });
    expect(one("SELECT count(*) FROM sources")).toBe(1);
    expect(one("SELECT title FROM sources")).toBe(EMAIL.title);
    expect(one("SELECT role FROM task_sources WHERE task_id = $second", { second })).toBe(
      "related",
    );
    // A source without a key is always a new one, and a new link goes after the others.
    const plain = { kind: "web", title: "Export format notes" } as const;
    const twice = submit([
      { kind: "source.add", task: first, source: plain },
      { kind: "source.add", task: first, source: plain },
    ]);
    expectStatus(twice, "applied");
    expect(one("SELECT count(*) FROM sources")).toBe(3);
    expect(
      fx.reader
        .prepare("SELECT position FROM task_sources WHERE task_id = $first ORDER BY position")
        .all({ first })
        .map((r) => r["position"]),
    ).toEqual(["a0", "a1", "a2"]);
  });

  test("one request: a new key twice is one source with two links, on a task it creates", () => {
    const id = newId("t");
    const other = create();
    const result = submit(
      [
        { kind: "task.create", id, title: "Answer the clinic" },
        { kind: "source.add", task: id, source: EMAIL },
        { kind: "source.add", task: other, source: EMAIL },
        { kind: "source.add", task: id, source: EMAIL },
      ],
      { base: null },
    );
    expectStatus(result, "applied");
    expect(result.results.map((r) => r.status)).toEqual([
      "created",
      "created",
      "created",
      "unchanged",
    ]);
    expect(new Set(result.results.slice(1).map((r) => r.id)).size).toBe(1);
    expect(one("SELECT count(*) FROM sources")).toBe(1);
    expect(one("SELECT count(*) FROM task_sources")).toBe(2);
  });

  test("a removed link is revived only with its link version or a base", async () => {
    const task = create();
    const added = submit([{ kind: "source.add", task, source: EMAIL }]);
    const source = added.results[0]?.id ?? "";
    const before = fx.base();
    const removed = await unlink(task, source);
    const at = one("SELECT removed_at FROM task_sources");
    const revive = (extra: { link_version?: number; base?: string | null }): WriteResult =>
      submit(
        [
          {
            kind: "source.add",
            task,
            source: EMAIL,
            ...(extra.link_version === undefined ? {} : { link_version: extra.link_version }),
          },
        ],
        { base: extra.base === undefined ? null : extra.base },
      );
    // Neither: BASE_REQUIRED with who removed the link and when (A1 3.5).
    const bare = revive({});
    expectStatus(bare, "rejected");
    expect(bare.error).toMatchObject({ code: "BASE_REQUIRED", op: 0, field: "link_version" });
    expect(bare.conflicts).toEqual([
      {
        op: 0,
        entity: "task_sources",
        id: `${task}|${source}`,
        task,
        ref: "M-1",
        field: "removed",
        value: at,
        version: removed,
        by: { actor: fx.human.principal_id, kind: "human", label: "Mira Okafor", origin: "cli" },
        at: expect.any(Number) as number,
      },
    ]);
    // An older link version, or a base from before the removal: a conflict.
    expectStatus(revive({ link_version: added.seq }), "conflict");
    expectStatus(revive({ base: before }), "conflict");
    // The current link version revives it, with one change of its one field.
    const revived = revive({ link_version: removed });
    expectStatus(revived, "applied");
    expect(revived.results[0]).toMatchObject({ status: "updated", version: revived.seq });
    expect(changesAt(revived.seq)).toMatchObject([
      {
        entity: "task_sources",
        entity_id: `${task}|${source}`,
        action: "set",
        field: "removed",
        before: String(at),
        after: "null",
        before_ver: removed,
      },
    ]);
    // A base from after the removal revives it too.
    const again = await unlink(task, source);
    expect(again).toBeGreaterThan(revived.seq);
    expectStatus(revive({ base: fx.base() }), "applied");
    expect(one("SELECT removed_at FROM task_sources")).toBe(null);
  });

  test("a source's input is checked: kind, title, key, URL and instant", () => {
    const task = create();
    const error = (source: unknown): unknown => {
      const result = submit([{ kind: "source.add", task, source } as Operation], { base: null });
      return [result.error?.code, result.error?.field];
    };
    expect(error({ ...EMAIL, kind: "fax" })).toEqual(["VALIDATION_FAILED", "ops[0].source.kind"]);
    expect(error({ ...EMAIL, title: "" })).toEqual(["VALIDATION_FAILED", "ops[0].source.title"]);
    expect(error({ ...EMAIL, title: "x".repeat(301) })).toEqual([
      "TOO_LARGE",
      "ops[0].source.title",
    ]);
    expect(error({ ...EMAIL, key: "no-colon" })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].source.key",
    ]);
    expect(error({ ...EMAIL, url: "x".repeat(2049) })).toEqual(["TOO_LARGE", "ops[0].source.url"]);
    expect(error({ ...EMAIL, at: -1 })).toEqual(["VALIDATION_FAILED", "ops[0].source.at"]);
    expect(error({ ...EMAIL, body: "the whole message" })).toEqual([
      "VALIDATION_FAILED",
      "ops[0].source",
    ]);
    expect(error({ ...EMAIL })).toEqual([undefined, undefined]);
  });
});

describe("[A1.5.write.children] place.set", () => {
  const remote = "https://git.lumen.example/lumen/portal.git";

  test("binds a folder for an owner on the request's machine; another folder needs a base", () => {
    const bound = submit(
      [
        {
          kind: "place.set",
          project: fx.project,
          root: "work",
          path: "lumen/portal",
          git_remote: remote,
        },
      ],
      { base: null },
    );
    expectStatus(bound, "applied");
    const place = bound.results[0]?.id ?? "";
    expect(bound.results[0]).toEqual({ i: 0, status: "created", id: place, version: bound.seq });
    expect(row("SELECT * FROM places WHERE id = $place", { place })).toMatchObject({
      owner_kind: "project",
      owner_id: fx.project,
      machine_id: TEST_MACHINE,
      root_id: "work",
      rel_path: "lumen/portal",
      kind: "folder",
      identity: JSON.stringify({ git_remote: remote }),
      created_seq: bound.seq,
    });
    // A group's place belongs to no task: its change carries none, and only `*` waits.
    expect(changesAt(bound.seq)).toMatchObject([
      { entity: "places", entity_id: place, task_id: null },
    ]);
    expect(one("SELECT count(*) FROM outbox WHERE seq = $seq", { seq: bound.seq })).toBe(1);
    // The owner has a place on this machine now: binding again needs a base.
    const portal = {
      kind: "place.set",
      project: "portal",
      root: "work",
      path: "lumen/portal-2",
    } as const;
    expect(submit([portal], { base: null }).error).toMatchObject({ code: "BASE_REQUIRED", op: 0 });
    const stale = fx.base();
    const same = submit([{ ...portal, path: "lumen/portal", git_remote: remote }]);
    expectStatus(same, "unchanged");
    const moved = submit([portal]);
    expectStatus(moved, "applied");
    expect(moved.results[0]).toMatchObject({ status: "updated", id: place, version: moved.seq });
    expect(changesAt(moved.seq)).toMatchObject([
      {
        entity: "places",
        action: "set",
        field: "folder",
        before: JSON.stringify({
          root_id: "work",
          rel_path: "lumen/portal",
          kind: "folder",
          identity: JSON.stringify({ git_remote: remote }),
        }),
        after: JSON.stringify({
          root_id: "work",
          rel_path: "lumen/portal-2",
          kind: "folder",
          identity: null,
        }),
        before_ver: bound.seq,
      },
    ]);
    const conflict = submit([{ ...portal, path: "lumen" }], { base: stale });
    expectStatus(conflict, "conflict");
    expect(conflict.conflicts).toMatchObject([
      { entity: "places", id: place, field: "folder", version: moved.seq },
    ]);
    expect(conflict.conflicts[0]?.task).toBeUndefined();
  });

  test("a task's and an area's place; two binds of a new owner fold into one create", () => {
    const task = create();
    const forTask = submit([{ kind: "place.set", task: "M-1", root: "work", path: "" }], {
      base: null,
    });
    expectStatus(forTask, "applied");
    expect(forTask.results[0]).toMatchObject({ status: "created", task, ref: "M-1" });
    expect(one("SELECT touched FROM tasks WHERE id = $task", { task })).toBe(forTask.seq);
    const area = submit(
      [{ kind: "place.set", area: "home", root: "oss", path: "garden", place_kind: "file" }],
      { base: null },
    );
    expectStatus(area, "applied");
    expect(one("SELECT owner_id FROM places WHERE kind = 'file'")).toBe(fx.areas.home);
    const id = newId("t");
    const folded = submit(
      [
        { kind: "task.create", id, title: "Plant bulbs" },
        { kind: "place.set", task: id, root: "work", path: "garden/a" },
        { kind: "place.set", task: id, root: "work", path: "garden/b" },
      ],
      { base: null },
    );
    expectStatus(folded, "applied");
    expect(folded.results.map((r) => r.status)).toEqual(["created", "created", "updated"]);
    expect(changesAt(folded.seq).map((c) => [c.entity, c.action, c.op])).toEqual([
      ["tasks", "create", 0],
      ["places", "create", 1],
    ]);
    const created = JSON.parse(String(changesAt(folded.seq)[1]?.["after"])) as Row;
    expect(created["rel_path"]).toBe("garden/b");
  });

  test("a root ID and a relative path, one owner, and a machine the space knows", () => {
    const task = create();
    const error = (op: Record<string, unknown>, actor = fx.human): unknown => {
      const ops = [{ kind: "place.set", task, root: "work", path: "a", ...op }];
      const result = fx.writer.submit({ ...fx.request(actor, []), ops });
      return [result.error?.code, result.error?.field];
    };
    for (const root of ["Work", "", "-work", "w".repeat(33), "work/a"]) {
      expect(error({ root }), root).toEqual(["VALIDATION_FAILED", "ops[0].root"]);
    }
    for (const path of [
      "/abs",
      "a/",
      "a//b",
      "./a",
      "a/../b",
      "..",
      "a\\..\\b",
      `a${String.fromCodePoint(0x202e)}b`,
      `a${String.fromCodePoint(0x200b)}b`,
      "a\tb",
      "a\nb",
      "a\r\nb",
      "a\u0085b",
      // Controls the text normalisation would drop: the path is refused, never changed.
      "a\u0000b",
      "a\u0007b",
      "a\u001fb",
      // A drive-qualified path is absolute or drive-relative on Windows (A1 3.15, A6 3.3).
      "C:/outside",
      "c:",
      "C:outside/a",
      "x".repeat(1025),
    ]) {
      expect(error({ path }), JSON.stringify(path)).toEqual(["VALIDATION_FAILED", "ops[0].path"]);
    }
    expect(error({ project: fx.project })).toEqual(["VALIDATION_FAILED", "ops[0].task"]);
    expect(error({ task: undefined })).toEqual(["VALIDATION_FAILED", "ops[0].task"]);
    expect(error({ project: "nowhere", task: undefined })).toEqual(["NOT_FOUND", "project"]);
    // The place binds a folder on the request's machine, which needs its record in the space.
    expect(error({}, { ...fx.human, machine_id: newId("m") })).toEqual([
      "VALIDATION_FAILED",
      "actor.machine_id",
    ]);
    expect(error({ path: "x".repeat(1024) })).toEqual([undefined, undefined]);
  });
});
