// The tree's search index: a document for every live task, project, note, page and page comment,
// changed in the commit that changes what it shows, and a search that keeps to what lies under one
// node. After every test the history check also compares the index with a fresh rebuild. Fixture
// text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TreeResult } from "../src/tree/core.ts";
import { rebuildTreeIndex, searchTree, storedTreeDocuments } from "../src/tree/search.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";

const temp = tempFolders("tree-search");
afterAll(temp.cleanup);

describe("[S2.tree.search] the tree's search index, kept in each commit, and a search under a node", () => {
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
    return (result.result ?? {}) as Record<string, unknown>;
  };
  const project = (title: string): string =>
    (ok(fx.send("project.create", { title })) as { project: { id: string } }).project.id;
  const add = (draft: Record<string, unknown>): string =>
    (ok(fx.send("tasks.add", { tasks: [draft] })) as { tasks: { id: string }[] }).tasks[0]?.id ??
    "";
  const found = (match: string, under?: string) =>
    searchTree(fx.conn, match, under === undefined ? {} : { under }).map((h) => h.entityId);

  test("a task's words, its notes, its pages and their comments are found, under the node that holds them", () => {
    const lumen = project("Lumen");
    const other = project("Household");
    const task = add({ title: "Fix the export", under: lumen, brief: "Time zones shift" });
    const licence = add({ title: "Renew the export licence", under: other });
    ok(fx.send("note.add", { on: task, body: "The report runs at midnight" }));
    const page = (
      ok(fx.send("page.create", { on: task, title: "Runbook", body: "Restart the scheduler" })) as {
        page: { id: string; ref: string };
      }
    ).page;
    ok(fx.send("note.add", { on: page.ref, body: "Ask about the scheduler's queue" }));
    // A note and a page show the title of what they are on, as today's documents do.
    expect(found("export", other)).toEqual([licence]);
    expect(found("export", lumen)).toHaveLength(3);
    expect(found("midnight", lumen)).toHaveLength(1);
    expect(found("scheduler", lumen)).toHaveLength(2);
    expect(found("scheduler", other)).toEqual([]);
    expect(found("zones")).toEqual([task]);
  });

  test("what a document shows of another row follows that row: a parent's title, a page or a source that moves", () => {
    const parent = add({ title: "Move house" });
    const child = add({ title: "Book the van", under: parent });
    expect(found("house")).toEqual(expect.arrayContaining([parent, child]));
    ok(fx.send("task.update", { task: parent, set: { title: "Move flat" } }));
    expect(found("house")).toEqual([]);
    expect(found("flat")).toEqual(expect.arrayContaining([parent, child]));
    const away = add({ title: "Unrelated" });
    const page = (
      ok(fx.send("page.create", { on: parent, title: "Checklist", body: "Boxes and tape" })) as {
        page: { ref: string; id: string };
      }
    ).page;
    ok(fx.send("page.move", { page: page.ref, on: away }));
    expect(found("tape", parent)).toEqual([]);
    expect(found("tape", away)).toEqual([page.id]);
    ok(fx.send("source.add", { on: parent, source: { kind: "email", title: "Removal quote" } }));
    expect(found("quote", parent)).toEqual([parent]);
  });

  test("the Trash takes a task's documents and its subtasks' out of search, and a restore brings them back", () => {
    const parent = add({ title: "Plan the garden" });
    const child = add({ title: "Order the seeds", under: parent });
    ok(fx.send("note.add", { on: child, body: "Tomatoes first" }));
    ok(fx.send("nodes.trash", { task: parent }));
    expect(found("garden OR seeds OR tomatoes")).toEqual([]);
    ok(fx.send("nodes.restore", { task: parent }));
    expect(found("garden OR seeds OR tomatoes")).toHaveLength(3);
    ok(fx.send("task.update", { task: child, set: { title: "Order the bulbs" } }));
    ok(fx.send("undo", {}));
    expect(found("seeds")).toHaveLength(2);
  });

  test("a request refused after its writes leaves the index as it was; a rebuild makes the same documents", () => {
    const made = fx.send("tasks.add", { tasks: [{ title: "Fix the export" }] });
    const task = (ok(made) as { tasks: { id: string }[] }).tasks[0]?.id ?? "";
    const seen = made.as_of;
    ok(fx.send("task.update", { task, set: { title: "Fix the export job" } }));
    const before = storedTreeDocuments(fx.conn).docs;
    // Refused after its write: the title changed after what the caller saw.
    const late = fx.send("task.update", { task, set: { title: "Fix the import" } }, { base: seen });
    expect(late.status).toBe("conflict");
    expect(storedTreeDocuments(fx.conn).docs).toEqual(before);
    fx.conn.transaction("immediate", () => rebuildTreeIndex(fx.conn));
    expect(storedTreeDocuments(fx.conn).docs).toEqual(before);
  });
});
