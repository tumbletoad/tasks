// What Open and Run record on the tree writer, by today's rules: a launch and a run of a task, in a
// folder of the request's machine; a second click while a launch still opens gets that launch; a
// move by an edge of the state machine, one compare-and-set on what the caller saw, evidence that
// only grows, and a run's result written once, entering a final state. A node's default folder on
// the machine, as that machine spells it. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TreeResult } from "../src/tree/core.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";

const temp = tempFolders("tree-runs");
afterAll(temp.cleanup);

const HASH = "a1b2c3d4".repeat(8);
const LIMITS = { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 };

describe("[S2.tree.runs] what Open and Run record, and a node's folder, on the tree", () => {
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
  const task = (): string =>
    (
      ok(fx.send("tasks.add", { tasks: [{ title: "Fix the export" }] })) as {
        tasks: { id: string }[];
      }
    ).tasks[0]?.id ?? "";
  const launch = (taskId: string, extra: Record<string, unknown> = {}) =>
    fx.send("launch.create", {
      task: taskId,
      instance: "codex-work",
      route: "terminal",
      folder: null,
      task_version: 3,
      brief_hash: HASH,
      ...extra,
    });
  const row = (table: string, id: unknown) =>
    fx.conn.prepare(`SELECT * FROM ${table} WHERE id = $id`).get({ id: String(id) }) ?? {};

  test("a launch opens prepared; a second click gets it; it moves by the machine's edges only", () => {
    const id = task();
    const made = ok(launch(id, { evidence: { folder_id: "2049:131077" } })) as {
      launch: { id: string };
    };
    // The launch in flight is answered as it is: nothing is written.
    expect(launch(id)).toMatchObject({
      status: "unchanged",
      result: { launch: { id: made.launch.id, existing: true } },
    });
    // A click that continues an agent conversation is another launch than one that continues none.
    const resumed = ok(launch(id, { evidence: { resumes: "thread-7" } })) as {
      launch: { id: string; existing?: boolean };
    };
    expect(resumed.launch.existing).toBeUndefined();
    expect(launch(id, { evidence: { resumes: "thread-7" } }).result).toMatchObject({
      launch: { id: resumed.launch.id, existing: true },
    });
    const move = (expect_: string, next: string, more: Record<string, unknown> = {}) =>
      fx.send("launch.transition", { launch: made.launch.id, expect: expect_, next, ...more });
    expect(move("prepared", "confirmed").error).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "next",
    });
    ok(move("prepared", "dispatching", { evidence: { grant: "grant-7" } }));
    expect(move("prepared", "dispatching").error).toMatchObject({
      code: "INVALID_TRANSITION",
      field: "expect",
    });
    expect(move("dispatching", "dispatched", { evidence: { grant: "grant-8" } }).error?.field).toBe(
      "evidence.grant",
    );
    expect(move("dispatching", "failed").error?.field).toBe("reason");
    ok(move("dispatching", "dispatched"));
    expect(row("launches", made.launch.id)).toMatchObject({ state: "dispatched", task_id: id });
  });

  test("a run is queued for a task with the person's instruction, and moves once to its result", () => {
    const id = task();
    const made = ok(
      fx.send("run.create", {
        task: id,
        instance: "codex-work",
        adapter: "codex",
        folder: null,
        request: "Check the export\r\nand fix the time zone.",
        brief_hash: HASH,
        permission: "full-access",
        limits: LIMITS,
      }),
    ) as { run: { id: string } };
    const run = made.run.id;
    expect(row("runs", run)).toMatchObject({
      state: "queued",
      request: "Check the export\nand fix the time zone.",
    });
    const version = () => Number(row("runs", run)["version"]);
    const move = (expect_: string, next: string, more: Record<string, unknown> = {}) =>
      fx.send("run.transition", { run, expect: expect_, expect_version: version(), next, ...more });
    expect(
      fx.send("run.transition", { run, expect: "queued", expect_version: 1, next: "starting" })
        .error?.field,
    ).toBe("expect_version");
    ok(move("queued", "starting", { evidence: { pid: 4242 } }));
    ok(move("starting", "running"));
    expect(move("running", "failed").error?.field).toBe("reason");
    expect(row("runs", run)["started_at"]).not.toBeNull();
    const noTask = fx.send("run.create", {
      instance: "codex-work",
      adapter: "codex",
      folder: null,
      brief_hash: HASH,
      permission: "full-access",
      limits: LIMITS,
    });
    expect(noTask.error?.field).toBe("task");
  });

  test("a node's folder on this machine: set as the machine spells a path, changed, cleared", () => {
    const id = task();
    expect(fx.send("folder.set", { node: id, path: "relative\\path" }).error?.field).toBe("path");
    const set = ok(fx.send("folder.set", { node: id, path: "C:\\Work\\export" })) as {
      folder: { id: string };
    };
    ok(fx.send("folder.set", { node: id, path: "C:\\Work\\export-2" }));
    expect(row("folders", set.folder.id)).toMatchObject({
      path: "C:\\Work\\export-2",
      is_default: 1,
    });
    ok(launch(id, { folder: set.folder.id }));
    ok(fx.send("folder.clear", { node: id }));
    const gone = launch(task(), { folder: set.folder.id });
    expect(gone.error?.code).toBe("DELETED");
  });

  test("a folder's change is held to its path and its removal as the caller saw them", () => {
    const id = task();
    const first = "C:\\Work\\export";
    const other = "C:\\Work\\other";
    ok(fx.send("folder.set", { node: id, path: first }, { base: null }));
    expect(fx.send("folder.set", { node: id, path: first }, { base: null }).error?.code).toBe(
      "BASE_REQUIRED",
    );
    const seen = fx.asOf();
    ok(fx.send("folder.clear", { node: id }));
    // Cleared since the caller's read: setting one again is a change it has not seen.
    const late = fx.send("folder.set", { node: id, path: other }, { base: seen });
    expect(late.status).toBe("conflict");
    ok(fx.send("folder.set", { node: id, path: other }));
  });

  test("a launch of a task in the Trash is refused, and one may name a note of its task as its request", () => {
    const id = task();
    expect(launch(id, { evidence: { request: "n1" } }).error?.field).toBe("evidence.request");
    ok(fx.send("note.add", { on: id, body: "Please fix the export" }));
    ok(launch(id, { evidence: { request: "n1" } }));
    const trashed = task();
    ok(fx.send("nodes.trash", { task: trashed }));
    expect(launch(trashed).error?.code).toBe("DELETED");
  });
});
