// The tree writer's one working path, in a disposable tree space: a task added under a project is
// read with its trail and finished, with its follow-ups in the same commit. Also the request's
// boundary (one transaction, one receipt, a base checked against the versions before it), the
// finishing question for open subtasks, and the Trash of a subtree. Fixture text
// only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { readTreeTask } from "../src/tree/read.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";

const temp = tempFolders("tree-core");
afterAll(temp.cleanup);

describe("[S2.tree.core] the tree writer's commands in a disposable tree space", () => {
  let fx: TreeFixture;
  beforeEach(async () => {
    fx = openTree(await checkedDriver(), temp.make(), true);
  });
  afterEach(() => {
    const problems = treeHistoryProblems(fx.conn);
    fx.close();
    expect(problems).toEqual([]);
  });

  const count = (sql: string): number => Number(fx.conn.prepare(sql).get()?.["n"]);
  const commits = () => count("SELECT count(*) AS n FROM commits");
  const project = (title: string, under?: string): string => {
    const made = fx.send("project.create", { title, ...(under === undefined ? {} : { under }) });
    expect(made.status).toBe("applied");
    return (made.result as { project: { id: string } }).project.id;
  };
  const add = (draft: Record<string, unknown>) => {
    const made = fx.send("tasks.add", { tasks: [draft] });
    return (made.result as { tasks: { status: string; id: string; ref: string }[] }).tasks[0];
  };

  test("a task under a project is read with its trail and finished with a follow-up, in one commit", () => {
    const client = project("Client work");
    project("Lumen Health", client);
    const task = add({
      under: "client-work/Lumen Health",
      title: "Fix appointment time zones",
      brief: "Store the zone",
    });
    expect(task).toMatchObject({ status: "created", ref: "M-1" });
    const read = readTreeTask(fx.conn, "M-1");
    expect(read?.trail.map((l) => [l.kind, l.title])).toEqual([
      ["project", "Lumen Health"],
      ["project", "Client work"],
      ["space", "Mira"],
    ]);
    const before = commits();
    const done = fx.send("task.finish", {
      task: "M-1",
      outcome: "Times are stored with the clinic's zone",
      follow_ups: [{ under: "M-1", title: "Tell the clinic" }],
    });
    expect(done.status).toBe("applied");
    expect(commits()).toBe(before + 1);
    expect(count("SELECT count(*) AS n FROM receipts WHERE status = 'applied'")).toBe(commits());
    const after = readTreeTask(fx.conn, "M-1");
    expect(after).toMatchObject({
      lifecycle: "completed",
      outcome: "Times are stored with the clinic's zone",
    });
    expect(after?.subtasks).toEqual([
      expect.objectContaining({ title: "Tell the clinic", lifecycle: "active" }),
    ]);
  });

  test("a follow-up that cannot be made leaves nothing of the finish", () => {
    add({ title: "Renew the passport" });
    const before = commits();
    const refused = fx.send("task.finish", {
      task: "M-1",
      outcome: "Sent",
      follow_ups: [{ under: "Nowhere", title: "Pay" }],
    });
    expect(refused).toMatchObject({
      status: "rejected",
      error: { code: "NOT_FOUND", field: "tasks.0.under" },
    });
    expect(commits()).toBe(before);
    expect(readTreeTask(fx.conn, "M-1")?.lifecycle).toBe("active");
  });

  test("a resend replays the stored answer; the same ID with another intent is refused", () => {
    add({ title: "Renew the passport" });
    const first = fx.send("task.finish", { task: "M-1" }, { request_id: "finish-1" });
    const again = fx.send("task.finish", { task: "M-1" }, { request_id: "finish-1" });
    expect(again).toEqual({ ...first, replayed: true });
    const other = fx.send("task.reopen", { task: "M-1" }, { request_id: "finish-1" });
    expect(other.error?.code).toBe("REQUEST_ID_REUSED");
    expect(readTreeTask(fx.conn, "M-1")?.lifecycle).toBe("completed");
  });

  test("a base is checked against each field's version before the request", () => {
    add({ title: "Renew the passport" });
    const base = fx.send("task.update", { task: "M-1", set: { status: "open" } }).as_of;
    fx.send(
      "task.update",
      { task: "M-1", set: { title: "Renew both passports" } },
      { who: fx.agent },
    );
    const stale = fx.send("task.update", { task: "M-1", set: { title: "Renew mine" } }, { base });
    expect(stale.status).toBe("conflict");
    expect(stale.conflicts).toEqual([expect.objectContaining({ entity: "nodes", field: "title" })]);
    // Another field, and a request that writes one field twice, do not conflict with that base.
    expect(fx.send("task.update", { task: "M-1", set: { priority: 2 } }, { base }).status).toBe(
      "applied",
    );
    const finish = fx.send("task.finish", { task: "M-1", outcome: "Sent the form" }, { base });
    expect(finish.status).toBe("applied");
    expect(readTreeTask(fx.conn, "M-1")?.title).toBe("Renew both passports");
  });

  test("finishing a task with open subtasks asks which is meant; only, and all", () => {
    add({ title: "Move house" });
    add({ under: "M-1", title: "Book the van" });
    add({ under: "M-2", title: "Compare prices" });
    const asked = fx.send("task.finish", { task: "M-1" }, { entry: "task.finish" });
    expect(asked).toMatchObject({
      status: "rejected",
      error: { code: "OPEN_SUBTASKS", field: "subtasks" },
    });
    expect(
      (asked.error?.data as { subtasks: { ref: string }[] }).subtasks.map((s) => s.ref),
    ).toEqual(["M-2", "M-3"]);
    expect(count("SELECT count(*) AS n FROM receipts")).toBe(commits());
    expect(fx.send("task.finish", { task: "M-2", subtasks: "only" }).status).toBe("applied");
    // An open task under a finished one keeps its trail.
    expect(readTreeTask(fx.conn, "M-3")?.trail.map((l) => l.ref ?? l.kind)).toEqual([
      "M-2",
      "M-1",
      "space",
    ]);
    expect(fx.send("task.finish", { task: "M-1", subtasks: "all" }).status).toBe("applied");
    expect(readTreeTask(fx.conn, "M-3")?.lifecycle).toBe("completed");
  });

  test("the Trash takes a subtree and Restore brings back what it took, not what went before", () => {
    add({ title: "Move house" });
    add({ under: "M-1", title: "Book the van" });
    add({ under: "M-1", title: "Old plan" });
    fx.send("nodes.trash", { task: "M-3" });
    expect(fx.send("nodes.trash", { task: "M-1" }).result).toMatchObject({ tasks: 2 });
    expect(fx.send("nodes.restore", { task: "M-2" }).error?.code).toBe("INVALID_TRANSITION");
    expect(fx.send("nodes.restore", { task: "M-1" }).result).toMatchObject({ tasks: 2 });
    expect(readTreeTask(fx.conn, "M-2")?.in_trash).toBe(false);
    expect(readTreeTask(fx.conn, "M-3")?.in_trash).toBe(true);
  });

  test("a task never goes under itself or below itself", () => {
    add({ title: "Move house" });
    add({ under: "M-1", title: "Book the van" });
    expect(fx.send("task.move", { task: "M-1", under: "M-2" }).error?.code).toBe(
      "INVALID_TRANSITION",
    );
    expect(fx.send("task.move", { task: "M-2", under: "space" }).status).toBe("applied");
  });

  test("the history check sees a row written outside the commands", () => {
    add({ title: "Renew the passport" });
    fx.conn.prepare("UPDATE nodes SET title = 'Changed by hand' WHERE kind = 'task'").run();
    expect(treeHistoryProblems(fx.conn)).toEqual(["history: nodes.title is not its history"]);
    fx.conn.prepare("UPDATE nodes SET title = 'Renew the passport' WHERE kind = 'task'").run();
  });
});
