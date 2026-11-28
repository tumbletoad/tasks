// A space's preferences on the tree writer, by today's writer's rules: who may change a key; a
// value a newer build wrote kept as it is; a status active tasks hold never dropped; a change of
// the effort levels that moves the tasks on a dropped level; a preview decided whole and rolled
// back, with no receipt; and the tasks' statuses, sizes and the capture window read from the space's
// own preferences. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TreeResult } from "../src/tree/core.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";

const temp = tempFolders("tree-prefs");
afterAll(temp.cleanup);

const LEVELS = [{ key: "S" }, { key: "M" }, { key: "L" }];

describe("[S2.tree.prefs] a space's preferences on the tree", () => {
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
  const count = (sql: string) => Number(fx.conn.prepare(sql).get()?.["n"]);
  const value = (key: string) =>
    fx.conn.prepare("SELECT value FROM preferences WHERE key = $key").get({ key })?.["value"];

  test("a person sets a preference and resets it; an agent may not set one that is a person's", () => {
    ok(fx.send("pref.set", { key: "tasks.dedupe_window_days", value: 7 }));
    expect(value("tasks.dedupe_window_days")).toBe("7");
    const agent = fx.send(
      "pref.set",
      { key: "tasks.dedupe_window_days", value: 3 },
      { who: fx.agent },
    );
    expect(agent.error?.code).toBe("PREFERENCE_FORBIDDEN");
    ok(fx.send("pref.set", { key: "tasks.dedupe_window_days", value: null }));
    expect(value("tasks.dedupe_window_days")).toBe("null");
    expect(fx.send("pref.set", { key: "no.such.key", value: 1 }).error?.field).toBe("key");
  });

  test("a stored value is held to its base, the same value included; a first setting of the levels needs one", () => {
    expect(
      fx.send("pref.set", { key: "tasks.effort_scale", value: LEVELS }, { base: null }).error?.code,
    ).toBe("BASE_REQUIRED");
    const seen = fx.asOf();
    ok(fx.send("pref.set", { key: "tasks.dedupe_window_days", value: 7 }));
    const stale = fx.send(
      "pref.set",
      { key: "tasks.dedupe_window_days", value: 7 },
      { base: seen },
    );
    expect(stale.status).toBe("conflict");
    expect(
      fx.send("pref.set", { key: "tasks.dedupe_window_days", value: 7 }, { base: null }).error
        ?.code,
    ).toBe("BASE_REQUIRED");
  });

  test("a change of the levels moves the tasks on a dropped one, also one changed since the read", () => {
    ok(fx.send("pref.set", { key: "tasks.effort_scale", value: LEVELS }));
    ok(fx.send("tasks.add", { tasks: [{ title: "A", effort: "S" }] }));
    const seen = fx.asOf();
    ok(fx.send("task.update", { task: "M-1", set: { effort: "L" } }, { who: fx.agent }));
    const moved = fx.send(
      "pref.set",
      {
        key: "tasks.effort_scale",
        value: [{ key: "S" }, { key: "M" }],
        moves: [{ from: "L", to: "M" }],
      },
      { base: seen },
    );
    // The levels changed nothing since the read: the move goes ahead.
    expect(moved.status).toBe("applied");
    expect(fx.conn.prepare("SELECT effort FROM tasks").get()?.["effort"]).toBe("M");
  });

  test("a value a newer build wrote stays as it is here", () => {
    fx.conn
      .prepare(
        "INSERT INTO preferences (key, value, schema_ver, created_seq, version) " +
          "VALUES ('tasks.dedupe_window_days', '9', 999, 1, 1)",
      )
      .run();
    const refused = fx.send("pref.set", { key: "tasks.dedupe_window_days", value: 7 });
    expect(refused.error?.code).toBe("VALIDATION_FAILED");
    // Made by hand for the test: it has no history of its own.
    fx.conn.prepare("DELETE FROM preferences").run();
  });

  test("a preview is decided whole and rolled back: no commit, no receipt, the version it would change", () => {
    ok(fx.send("pref.set", { key: "tasks.dedupe_window_days", value: 7 }));
    const before = count("SELECT count(*) AS n FROM receipts");
    const preview = fx.send(
      "pref.set",
      { key: "tasks.dedupe_window_days", value: 9 },
      { extra: { dry_run: true } },
    );
    expect(preview).toMatchObject({ status: "applied", version: expect.any(Number) as number });
    expect(preview.commit).toBeUndefined();
    expect(value("tasks.dedupe_window_days")).toBe("7");
    expect(count("SELECT count(*) AS n FROM receipts")).toBe(before);
  });

  test("a task takes a status and a size of the space's lists only; a status active tasks hold stays", () => {
    const refused = fx.send("tasks.add", { tasks: [{ title: "A", status: "someday" }] });
    expect(refused.error).toMatchObject({ code: "VALIDATION_FAILED", field: "tasks.0.status" });
    ok(fx.send("pref.set", { key: "tasks.statuses", value: ["open", "waiting", "someday"] }));
    ok(fx.send("tasks.add", { tasks: [{ title: "A", status: "someday", effort: "M" }] }));
    const drop = fx.send("pref.set", { key: "tasks.statuses", value: ["open", "waiting"] });
    expect(drop.error?.code).toBe("VALIDATION_FAILED");
    const size = fx.send("task.update", { task: "M-1", set: { effort: "XXL" } });
    expect(size.error?.field).toBe("set.effort");
  });

  test("a change of the effort levels moves the tasks on a level it drops, as the person says", () => {
    ok(fx.send("pref.set", { key: "tasks.effort_scale", value: LEVELS }));
    ok(
      fx.send("tasks.add", {
        tasks: [
          { title: "A", effort: "L" },
          { title: "B", effort: "S" },
        ],
      }),
    );
    const next = [{ key: "S" }, { key: "M" }];
    const stranded = fx.send("pref.set", { key: "tasks.effort_scale", value: next });
    expect(stranded.error).toMatchObject({ code: "VALIDATION_FAILED", field: "value" });
    const moved = ok(
      fx.send("pref.set", {
        key: "tasks.effort_scale",
        value: next,
        moves: [{ from: "L", to: "M" }],
      }),
    );
    expect(moved.result).toMatchObject({ moved: [{ from: "L", to: "M", tasks: 1 }] });
    expect(fx.conn.prepare("SELECT effort FROM tasks ORDER BY ref").all()).toEqual([
      { effort: "M" },
      { effort: "S" },
    ]);
  });

  test("a capture counts a finished task as its own within the space's window only", () => {
    const source = { kind: "ticket", title: "LUM-212", key: "jira:LUM-212" };
    ok(fx.send("tasks.add", { tasks: [{ title: "Fix the export", source }] }));
    ok(fx.send("task.finish", { task: "M-1" }));
    const within = fx.send("tasks.add", { tasks: [{ title: "Again", source }] });
    expect(within.result).toMatchObject({ tasks: [{ status: "exists", ref: "M-1" }] });
    ok(fx.send("pref.set", { key: "tasks.dedupe_window_days", value: 0 }));
    const after = ok(fx.send("tasks.add", { tasks: [{ title: "Again", source }] }));
    expect(after.result).toMatchObject({ tasks: [{ status: "created" }] });
  });
});
