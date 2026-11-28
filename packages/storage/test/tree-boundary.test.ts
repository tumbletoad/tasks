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
    expect(kept.status).toBe("applied");
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
      { who: posing, request_id: "pose" },
    );
    expect(refused.error).toMatchObject({ code: "VALIDATION_FAILED", field: "actor.principal_id" });
    expect(count("SELECT count(*) AS n FROM receipts WHERE request_id = 'pose'")).toBe(0);
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
      request_id: "elsewhere",
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
        request_id: title,
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

  test("the history check sees a row the history made that went missing", () => {
    add("Renew the passport");
    ok(fx.send("note.add", { on: "M-1", body: "Booked" }));
    const note = fx.conn.prepare("SELECT * FROM notes").get() ?? {};
    fx.conn.prepare("DELETE FROM notes").run();
    expect(treeHistoryProblems(fx.conn)).toEqual(["history: a notes row the history made is gone"]);
    // Put back as it was, for the check after the test.
    const columns = Object.keys(note);
    fx.conn
      .prepare(
        `INSERT INTO notes (${columns.join(", ")}) VALUES (${columns.map((c) => `$${c}`).join(", ")})`,
      )
      .run(note as Record<string, string | number | null>);
  });
});
