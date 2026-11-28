// Sources and links on the tree writer, in a disposable tree space: a source sits on one node and
// takes the space's next reference; one live source holds a key, so the same key added elsewhere is
// linked there; a capture finds its task again through the source the task was made from, wherever
// that source has moved and also after the window for finished tasks; links come and go; a source's
// fields and key are read as today's writer reads them. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TreeResult } from "../src/tree/core.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";

const temp = tempFolders("tree-sources");
afterAll(temp.cleanup);

describe("[S2.tree.sources] sources, links and the capture by source on the tree", () => {
  let fx: TreeFixture;
  beforeEach(async () => {
    fx = openTree(await checkedDriver(), temp.make(), true);
  });
  afterEach(() => {
    const problems = treeHistoryProblems(fx.conn);
    fx.close();
    expect(problems).toEqual([]);
  });

  const ok = (result: TreeResult): Record<string, unknown> => {
    expect(result.status).toBe("applied");
    return result.result as Record<string, unknown>;
  };
  const row = (table: string, id: unknown): Record<string, unknown> =>
    fx.conn.prepare(`SELECT * FROM ${table} WHERE id = $id`).get({ id: String(id) }) ?? {};
  const task = (): string =>
    (
      ok(fx.send("tasks.add", { tasks: [{ title: "Renew the passport" }] })) as {
        tasks: { ref: string }[];
      }
    ).tasks[0]?.ref ?? "";
  const project = (title: string): string =>
    (ok(fx.send("project.create", { title })) as { project: { id: string } }).project.id;
  const count = (sql: string) => Number(fx.conn.prepare(sql).get()?.["n"]);

  test("a repeat capture finds its task through the source it came from, wherever the source moved", () => {
    const source = { kind: "ticket", title: "LUM-212", key: "jira:LUM-212" };
    const capture = (title: string, log?: string) =>
      // A capture that finds its task and adds nothing writes nothing: it is unchanged.
      (
        fx.send("tasks.add", { tasks: [{ title, source, ...(log === undefined ? {} : { log }) }] })
          .result as { tasks: { status: string; ref: string }[] }
      ).tasks[0];
    expect(capture("Fix the export")).toMatchObject({ status: "created", ref: "M-1" });
    const made = fx.conn.prepare("SELECT id, ref, owner_id FROM sources").get() ?? {};
    expect(row("tasks", made["owner_id"])["origin_source_id"]).toBe(made["id"]);
    // The source moves to a project: the next capture still finds the task.
    ok(fx.send("source.move", { source: "M-2", on: project("Lumen") }));
    expect(capture("Fix the export again", "Asked again")).toMatchObject({
      status: "exists",
      ref: "M-1",
    });
    // Finished long ago: a new task from the same source, and the next capture finds that one.
    ok(fx.send("task.finish", { task: "M-1", at: 1 }));
    const second = capture("Fix the export, part two");
    expect(second).toMatchObject({ status: "created" });
    expect(capture("Once more")).toMatchObject({ status: "exists", ref: second?.ref });
    expect(count("SELECT count(*) AS n FROM sources")).toBe(1);
  });

  test("a source key is read as today's writer reads it: trimmed, its namespace lower-cased", () => {
    const source = { kind: "ticket", title: "LUM-212", key: "  JIRA:LUM-212 " };
    ok(fx.send("tasks.add", { tasks: [{ title: "Fix the export", source }] }));
    expect(fx.conn.prepare("SELECT source_key FROM sources").get()?.["source_key"]).toBe(
      "jira:LUM-212",
    );
    const bad = fx.send("tasks.add", {
      tasks: [{ title: "A", source: { ...source, key: "no namespace" } }],
    });
    expect(bad.error).toMatchObject({ code: "VALIDATION_FAILED", field: "tasks.0.source.key" });
    const kind = fx.send("tasks.add", {
      tasks: [{ title: "A", source: { ...source, kind: "rumour" } }],
    });
    expect(kind.error?.field).toBe("tasks.0.source.kind");
  });

  test("a source on a node; the same key elsewhere links it; links come and go; a held key stays put", () => {
    const home = project("Home");
    const ref = task();
    const reply = { kind: "email", title: "Council reply", key: "mail:1" };
    const added = ok(fx.send("source.add", { on: home, source: reply }));
    expect(added).toMatchObject({ status: "created" });
    expect(ok(fx.send("source.add", { on: ref, source: reply }))).toMatchObject({
      status: "exists",
    });
    const links = () => fx.conn.prepare("SELECT removed_at FROM links").all();
    expect(links()).toEqual([{ removed_at: null }]);
    const sourceRef = (added["source"] as { ref: string }).ref;
    ok(fx.send("link.remove", { on: ref, target: sourceRef }));
    ok(fx.send("link.add", { on: ref, target: sourceRef }));
    expect(links()).toEqual([{ removed_at: null }]);
    ok(fx.send("source.remove", { source: sourceRef }));
    ok(fx.send("source.add", { on: ref, source: { ...reply, title: "Council reply, again" } }));
    expect(fx.send("source.put_back", { source: sourceRef }).error?.code).toBe("KEY_HELD");
    const page = (
      ok(fx.send("page.create", { on: home, title: "Council" })) as { page: { ref: string } }
    ).page;
    ok(fx.send("link.add", { on: ref, target: page.ref }));
    expect(fx.send("link.add", { on: ref, target: "M-99" }).error?.code).toBe("NOT_FOUND");
  });

  test("a source under a task in the Trash is not found, and comes back with it", () => {
    const ref = task();
    const added = ok(fx.send("source.add", { on: ref, source: { kind: "email", title: "Form" } }));
    const sourceRef = (added["source"] as { ref: string }).ref;
    ok(fx.send("nodes.trash", { task: ref }));
    expect(fx.send("source.move", { source: sourceRef, on: "space" }).error?.code).toBe(
      "NOT_FOUND",
    );
    ok(fx.send("nodes.restore", { task: ref }));
    ok(fx.send("source.move", { source: sourceRef, on: "space" }));
  });
});
