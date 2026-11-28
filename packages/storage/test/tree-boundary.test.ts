// What today's writer guarantees at the request boundary, held for the tree writer: a write to
// what exists needs a base from this copy of the space and no later than it; the fields one write
// changes together stay together when one of them conflicts; a removal is based on the task as
// the person saw it, the tasks below it included; Undo never hides work someone else did since;
// the principal is an actor of the kind it claims, and only a person corrects a note; "all"
// finishes every open task below; and the history check sees a row that went missing. Fixture text
// only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { TreeWriter, type TreeResult } from "../src/tree/core.ts";
import { checkedDriver, tempFolders, TEST_MACHINE } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";

const temp = tempFolders("tree-boundary");
afterAll(temp.cleanup);

describe("[S2.tree.boundary] the tree writer keeps today's guarantees at the request boundary", () => {
  let fx: TreeFixture;
  beforeEach(async () => {
    fx = openTree(await checkedDriver(), temp.make(), true);
  });
  afterEach(() => {
    const problems = treeHistoryProblems(fx.conn);
    fx.close();
    expect(problems).toEqual([]);
  });

  const ok = (result: TreeResult): TreeResult => {
    expect(result.status).toBe("applied");
    return result;
  };
  const add = (title: string, under?: string) =>
    ok(fx.send("tasks.add", { tasks: [{ title, ...(under === undefined ? {} : { under }) }] }));
  const count = (sql: string): number => Number(fx.conn.prepare(sql).get()?.["n"]);
  const commits = () => count("SELECT count(*) AS n FROM commits");
  const lifecycle = (ref: number) =>
    fx.conn.prepare("SELECT lifecycle FROM tasks WHERE ref = $ref").get({ ref })?.["lifecycle"];

  test("a write to what exists needs a base, from no later than the space", () => {
    add("Renew the passport");
    const none = fx.send(
      "task.update",
      { task: "M-1", set: { title: "Renew mine" } },
      { base: null },
    );
    expect(none).toMatchObject({
      status: "rejected",
      error: { code: "BASE_REQUIRED", field: "base" },
    });
    const now = fx.send("note.add", { on: "M-1", body: "Booked" }).as_of;
    const future = now.replace(
      /^(\d+)\.(\d+)\./u,
      (_, e: string, s: string) => `${e}.${String(Number(s) + 5)}.`,
    );
    const ahead = fx.send(
      "task.update",
      { task: "M-1", set: { title: "Renew mine" } },
      { base: future },
    );
    expect(ahead.error?.code).toBe("BASE_FROM_FUTURE");
    // A new row needs none.
    expect(fx.send("note.add", { on: "M-1", body: "Paid" }, { base: null }).status).toBe("applied");
  });

  test("fields written together stay together: a stale reopen after an agent's outcome changes nothing", () => {
    add("Renew the passport");
    ok(fx.send("task.finish", { task: "M-1" }));
    const read = fx.send("note.add", { on: "M-1", body: "Done" }).as_of;
    ok(fx.send("task.finish", { task: "M-1", outcome: "Sent the form" }, { who: fx.agent }));
    const before = commits();
    const stale = fx.send("task.reopen", { task: "M-1" }, { base: read });
    expect(stale.status).toBe("conflict");
    expect(stale.conflicts).toEqual([expect.objectContaining({ entity: "tasks", field: "wrap" })]);
    expect(commits()).toBe(before);
    expect(lifecycle(1)).toBe("completed");
  });

  test("a task goes to the Trash only as the person saw it, the tasks below it included, and is counted", () => {
    add("Move house");
    add("Book the van", "M-1");
    const read = fx.send("note.add", { on: "M-1", body: "Start Monday" }).as_of;
    ok(
      fx.send(
        "task.update",
        { task: "M-2", set: { title: "Book the big van" } },
        { who: fx.agent },
      ),
    );
    const stale = fx.send("nodes.trash", { task: "M-1" }, { base: read });
    expect(stale.status).toBe("conflict");
    expect(stale.conflicts).toEqual([expect.objectContaining({ entity: "nodes", field: "title" })]);
    expect(count("SELECT count(*) AS n FROM nodes WHERE deleted_at IS NOT NULL")).toBe(0);
    const trashed = ok(fx.send("nodes.trash", { task: "M-1" }));
    expect(count(`SELECT affected AS n FROM commits WHERE seq = ${String(trashed.seq)}`)).toBe(2);
  });

  test("Undo never takes out of sight a task someone else added since below what it hides", () => {
    add("Move house");
    ok(fx.send("nodes.trash", { task: "M-1" }));
    ok(fx.send("nodes.restore", { task: "M-1" }));
    ok(
      fx.send(
        "tasks.add",
        { tasks: [{ title: "Pack the books", under: "M-1" }] },
        { who: fx.agent },
      ),
    );
    const kept = fx.send("undo", {}, { base: null });
    expect(kept.status).toBe("unchanged");
    const work = (kept.result as { kept: { work: { by: { label: string } }[] } }).kept.work;
    expect(work.map((w) => w.by.label)).toEqual(["agent:codex"]);
    expect(count("SELECT count(*) AS n FROM nodes WHERE deleted_at IS NOT NULL")).toBe(0);
  });

  test("the principal is an actor of the kind it claims, and only a person corrects or removes a note", () => {
    add("Renew the passport");
    const posing = { ...fx.agent, actor_kind: "human" as const };
    const refused = fx.send(
      "note.add",
      { on: "M-1", body: "From me" },
      { who: posing, request_id: "posing-request-0001" },
    );
    expect(refused.error).toMatchObject({ code: "VALIDATION_FAILED", field: "actor.principal_id" });
    expect(
      count("SELECT count(*) AS n FROM receipts WHERE request_id = 'posing-request-0001'"),
    ).toBe(0);
    const ghost = { ...fx.agent, author_id: "ac_00000000000000000000000000" as const };
    expect(fx.send("note.add", { on: "M-1", body: "Hi" }, { who: ghost }).error?.field).toBe(
      "actor.author_id",
    );
    ok(fx.send("note.add", { on: "M-1", body: "Never mail the council", for_agents: true }));
    const edit = fx.send(
      "note.edit",
      { on: "M-1", ordinal: 1, body: "Mail the council" },
      { who: fx.agent },
    );
    expect(edit.error?.code).toBe("USER_ONLY");
    expect(fx.send("note.remove", { on: "M-1", ordinal: 1 }, { who: fx.agent }).error?.code).toBe(
      "USER_ONLY",
    );
  });

  test("all finishes every open task below, also after the task itself was finished alone", () => {
    add("Move house");
    add("Book the van", "M-1");
    ok(fx.send("task.finish", { task: "M-1", subtasks: "only" }));
    expect(lifecycle(2)).toBe("active");
    const all = ok(fx.send("task.finish", { task: "M-1", subtasks: "all" }));
    expect(all.result).toMatchObject({ subtasks: 1 });
    expect(lifecycle(2)).toBe("completed");
  });

  test("a second Trash, a restore of a live task, and any change of a task in the Trash", () => {
    add("Move house");
    ok(fx.send("nodes.trash", { task: "M-1" }));
    expect(fx.send("nodes.trash", { task: "M-1" })).toMatchObject({
      status: "unchanged",
      result: { tasks: 0 },
    });
    expect(fx.send("task.update", { task: "M-1", set: { title: "Stay" } }).error?.code).toBe(
      "DELETED",
    );
    ok(fx.send("nodes.restore", { task: "M-1" }));
    expect(fx.send("nodes.restore", { task: "M-1" })).toMatchObject({
      status: "unchanged",
      result: { tasks: 0 },
    });
  });

  test("a writer that is not the authority, and a request for another space, decide nothing", () => {
    const other = new TreeWriter(fx.conn, { machineId: "m_00000000000000000000000000" });
    const request = {
      space_id: fx.spaceId,
      request_id: "elsewhere-request-01",
      actor: fx.human,
      command: "tasks.add",
      input: { tasks: [{ title: "Hi" }] },
    };
    expect(other.submit(request).error?.code).toBe("SPACE_READ_ONLY");
    expect(
      fx.writer.submit({ ...request, space_id: "sp_00000000000000000000000000" }).error?.code,
    ).toBe("SPACE_MISMATCH");
    expect(count("SELECT count(*) AS n FROM receipts")).toBe(0);
  });

  test("a person's new step ends what could be redone; a named Undo of another step leaves the stack", () => {
    add("Renew the passport");
    const done = ok(fx.send("task.finish", { task: "M-1" }));
    ok(fx.send("task.update", { task: "M-1", set: { title: "Renew it" } }));
    expect(fx.send("undo", { commit: done.commit }, { base: null }).error?.code).toBe(
      "INVALID_TRANSITION",
    );
    expect(
      fx.send("undo", { commit: "op_00000000000000000000000000" }, { base: null }).error?.code,
    ).toBe("NOT_FOUND");
    ok(fx.send("undo", {}, { base: null }));
    ok(fx.send("task.update", { task: "M-1", set: { title: "Renew both" } }));
    expect(fx.send("redo", {}, { base: null }).error?.code).toBe("NOTHING_TO_REDO");
  });

  test("a commit's time never goes back when the clock does", () => {
    let now = 2_000_000_000_000;
    const late = new TreeWriter(fx.conn, { machineId: TEST_MACHINE, clock: () => (now -= 60_000) });
    for (const title of ["One", "Two", "Three"]) {
      late.submit({
        space_id: fx.spaceId,
        request_id: `late-commit-request-${title}`,
        actor: fx.human,
        command: "tasks.add",
        input: { tasks: [{ title }] },
      });
    }
    const times = fx.conn
      .prepare("SELECT at FROM commits ORDER BY seq")
      .all()
      .map((r) => Number(r["at"]));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("a request that fails its checks stores nothing: the corrected request goes through under the same ID", () => {
    const blank = fx.send(
      "tasks.add",
      { tasks: [{ title: " " }] },
      { request_id: "corrected-request-01" },
    );
    expect(blank).toMatchObject({
      status: "rejected",
      error: { code: "VALIDATION_FAILED", field: "tasks.0.title" },
    });
    expect(count("SELECT count(*) AS n FROM receipts")).toBe(0);
    const fixed = fx.send(
      "tasks.add",
      { tasks: [{ title: "Renew the passport" }] },
      { request_id: "corrected-request-01" },
    );
    expect(fixed.status).toBe("applied");
  });

  test("text is normalised before the fingerprint and the write: the same words sent decomposed are the same request", () => {
    const decomposed = fx.send(
      "tasks.add",
      { tasks: [{ title: "Cafe\u0301 visit\u0007" }] },
      { request_id: "normalised-request-1" },
    );
    expect(decomposed.status).toBe("applied");
    expect(fx.conn.prepare("SELECT title FROM nodes WHERE kind = 'task'").get()?.["title"]).toBe(
      "Café visit",
    );
    const composed = fx.send(
      "tasks.add",
      { tasks: [{ title: "Café visit" }] },
      { request_id: "normalised-request-1" },
    );
    expect(composed).toMatchObject({ status: "applied", replayed: true });
  });

  test("the envelope today's writer checks: the request ID, the writer's own scope, the size, a key no command knows", () => {
    expect(
      fx.send("tasks.add", { tasks: [{ title: "A" }] }, { request_id: "short" }).error?.code,
    ).toBe("REQUEST_ID_INVALID");
    const system = { ...fx.human, scope_id: "system" };
    expect(fx.send("tasks.add", { tasks: [{ title: "A" }] }, { who: system }).error?.field).toBe(
      "actor.scope_id",
    );
    const huge = fx.send("tasks.add", {
      tasks: [{ title: "A", description: "x".repeat(17 * 1024 * 1024) }],
    });
    expect(huge.error?.code).toBe("TOO_LARGE");
    const unknown = fx.send("tasks.add", { tasks: [{ title: "A", "Never mail the council": 1 }] });
    expect(unknown.error?.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(unknown)).not.toContain("council");
    expect(
      fx.send("tasks.add", { tasks: [{ title: "A" }] }, { extra: { dry_run: true } }).error?.field,
    ).toBe("dry_run");
    expect(count("SELECT count(*) AS n FROM receipts")).toBe(0);
  });

  test("a conflict names the task, the value now, and who changed it when; its receipt keeps all but the value", () => {
    add("Move house");
    const read = fx.send("note.add", { on: "M-1", body: "Start Monday" }).as_of;
    ok(
      fx.send("task.update", { task: "M-1", set: { title: "Move house soon" } }, { who: fx.agent }),
    );
    const stale = fx.send(
      "nodes.trash",
      { task: "M-1" },
      { base: read, request_id: "stale-trash-request" },
    );
    const title = stale.conflicts?.find((c) => c.field === "title");
    expect(title).toMatchObject({
      ref: "M-1",
      value: "Move house soon",
      by: { label: "agent:codex", kind: "agent" },
    });
    expect(typeof title?.at).toBe("number");
    const kept = fx.conn
      .prepare("SELECT result FROM receipts WHERE request_id = 'stale-trash-request'")
      .get()?.["result"];
    expect(String(kept)).not.toContain("Move house soon");
    expect(String(kept)).toContain("agent:codex");
  });

  test("a move under a task made just before is no step; only a filing into a project made just before is", () => {
    ok(fx.send("project.create", { title: "Papers" }, { who: fx.agent }));
    add("Renew the passport", "papers");
    add("Book an appointment");
    ok(fx.send("task.move", { task: "M-1", under: "M-2" }));
    expect(fx.send("undo", {}).error?.code).toBe("NOTHING_TO_UNDO");
  });

  test("retries are kept apart by scope; a reused ID says when; warnings and the caller's answer replay", () => {
    const other = { ...fx.human, scope_id: "cli:test" };
    ok(fx.send("tasks.add", { tasks: [{ title: "One" }] }, { request_id: "shared-request-id-01" }));
    ok(
      fx.send(
        "tasks.add",
        { tasks: [{ title: "One" }] },
        { request_id: "shared-request-id-01", who: other },
      ),
    );
    expect(count("SELECT count(*) AS n FROM tasks")).toBe(2);
    const reused = fx.send(
      "tasks.add",
      { tasks: [{ title: "Two" }] },
      { request_id: "shared-request-id-01" },
    );
    expect(reused.error?.code).toBe("REQUEST_ID_REUSED");
    expect(typeof (reused.error?.data as { at?: unknown }).at).toBe("number");
    const extra = {
      warnings: ["folder not checked on this machine"],
      answer: { made: ["Garden"] },
    };
    const first = ok(
      fx.send(
        "tasks.add",
        { tasks: [{ title: "Three" }] },
        { request_id: "warned-request-0001", extra },
      ),
    );
    expect(first).toMatchObject(extra);
    const again = fx.send(
      "tasks.add",
      { tasks: [{ title: "Three" }] },
      { request_id: "warned-request-0001" },
    );
    expect(again).toMatchObject({ ...extra, replayed: true });
  });

  test("only a person undoes, and never on a base; a request marked active changes active tasks only", () => {
    add("Renew the passport");
    ok(fx.send("task.finish", { task: "M-1" }));
    expect(fx.send("undo", {}, { who: fx.agent }).error?.field).toBe("actor.actor_kind");
    const now = fx.send("note.add", { on: "M-1", body: "Done" }).as_of;
    expect(fx.send("undo", {}, { extra: { base: now } }).error?.field).toBe("base");
    const active = fx.send(
      "task.update",
      { task: "M-1", set: { priority: 1 } },
      { extra: { active: true } },
    );
    expect(active.error?.code).toBe("TASK_NOT_ACTIVE");
  });

  test("a task is found by its legacy alias from the prototype import", () => {
    add("Renew the passport");
    const id = fx.conn.prepare("SELECT id FROM tasks").get()?.["id"];
    fx.conn
      .prepare(
        "INSERT INTO aliases (namespace, alias, entity_id, created_at) VALUES ('planning', 't-c71c0065', $id, 0)",
      )
      .run({ id: String(id) });
    ok(fx.send("note.add", { on: "t-c71c0065", body: "Found by its old name" }));
    expect(count("SELECT count(*) AS n FROM notes")).toBe(1);
  });

  test("a base from another copy of the space is refused; a kept Undo's answer replays on a resend", () => {
    add("Renew the passport");
    const now = fx.send("note.add", { on: "M-1", body: "Booked" }).as_of;
    const elsewhere = now.replace(/^\d+\./u, "9.");
    const copy = fx.send(
      "task.update",
      { task: "M-1", set: { title: "Mine" } },
      { base: elsewhere },
    );
    expect(copy.error?.code).toBe("EPOCH_CHANGED");
    ok(fx.send("task.update", { task: "M-1", set: { title: "Renew it" } }));
    ok(fx.send("task.update", { task: "M-1", set: { title: "Renew it soon" } }, { who: fx.agent }));
    const kept = fx.send("undo", {}, { request_id: "kept-undo-request-01" });
    expect(kept.result).toMatchObject({ kept: { work: [{ by: { label: "agent:codex" } }] } });
    expect(fx.send("undo", {}, { request_id: "kept-undo-request-01" })).toEqual({
      ...kept,
      replayed: true,
    });
  });
  test("the history check sees a row the history made that went missing", () => {
    add("Renew the passport");
    ok(fx.send("note.add", { on: "M-1", body: "Booked" }));
    const note = fx.conn.prepare("SELECT * FROM notes").get() ?? {};
    fx.conn.prepare("DELETE FROM notes").run();
    expect(treeHistoryProblems(fx.conn)).toContain("history: a notes row the history made is gone");
    // Put back as it was, for the check after the test.
    const columns = Object.keys(note);
    fx.conn
      .prepare(
        `INSERT INTO notes (${columns.join(", ")}) VALUES (${columns.map((c) => `$${c}`).join(", ")})`,
      )
      .run(note as Record<string, string | number | null>);
  });
});
