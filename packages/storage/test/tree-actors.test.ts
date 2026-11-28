// What joins a tree space by the space's own system commits: its machine, registered once with its
// create row; an agent, by its label, once, with no change row; and the preferences a space always
// holds, stored where it holds none. Only the space's authority writes them. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { TreeWriter } from "../src/tree/core.ts";
import { checkedDriver, tempFolders, TEST_MACHINE } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";

const temp = tempFolders("tree-actors");
afterAll(temp.cleanup);

const OTHER = "m_00000000000000000000000000";

describe("[S2.tree.actors] a tree space's machine, agents and default preferences", () => {
  let fx: TreeFixture;
  beforeEach(async () => {
    fx = openTree(await checkedDriver(), temp.make(), true);
  });
  afterEach(() => {
    const problems = treeHistoryProblems(fx.conn);
    fx.close();
    expect(problems).toEqual([]);
  });

  const count = (sql: string) => Number(fx.conn.prepare(sql).get()?.["n"]);
  const system = (kind: string) =>
    count(`SELECT count(*) AS n FROM commits WHERE scope_id = 'system' AND kind = '${kind}'`);

  test("the machine registers once, by a system commit with its create row; another machine registers nothing", () => {
    expect(system("machine.register")).toBe(1);
    expect(fx.writer.registerMachine({ name: "test", os: "windows" })).toBe(false);
    const other = new TreeWriter(fx.conn, { machineId: OTHER });
    expect(other.registerMachine({ name: "laptop", os: "linux" })).toBe(false);
    expect(count("SELECT count(*) AS n FROM machines")).toBe(1);
    expect(count(`SELECT count(*) AS n FROM machines WHERE id = '${TEST_MACHINE}'`)).toBe(1);
  });

  test("an agent joins by its label once, with no change row; the person is the space's own", () => {
    const before = system("actor.register");
    const id = fx.writer.actor("agent", "agent:claude");
    expect(fx.writer.actor("agent", "agent:claude")).toBe(id);
    expect(system("actor.register")).toBe(before + 1);
    expect(fx.writer.actor("human", "anything")).toBe(fx.human.principal_id);
    expect(() => fx.writer.actor("agent", "two\nlines")).toThrow();
    const other = new TreeWriter(fx.conn, { machineId: OTHER });
    expect(() => other.actor("agent", "agent:gemini")).toThrow();
  });

  test("the preferences a space always holds are stored where it holds none, once, as the space's own act", () => {
    expect(count("SELECT count(*) AS n FROM preferences")).toBe(0);
    expect(fx.writer.storeDefaults()).toBe(true);
    expect(count("SELECT count(*) AS n FROM preferences WHERE key = 'tasks.effort_scale'")).toBe(1);
    expect(fx.writer.storeDefaults()).toBe(false);
    expect(
      count(
        "SELECT count(*) AS n FROM commits WHERE actor_kind = 'system' AND scope_id = 'defaults'",
      ),
    ).toBe(1);
    // A reset by the person stores the default itself, as today's writer does: none is left to fill.
    const levels = { key: "tasks.effort_scale" };
    expect(fx.send("pref.set", { ...levels, value: [{ key: "Quick" }] }).status).toBe("applied");
    expect(fx.send("pref.set", { ...levels, value: null }).status).toBe("applied");
    expect(fx.send("pref.set", { ...levels, value: null }).status).toBe("unchanged");
    expect(fx.writer.storeDefaults()).toBe(false);
    // The agent's own requests name it as their author.
    const made = fx.send("tasks.add", { tasks: [{ title: "Hi" }] }, { who: fx.agent });
    expect(made.status).toBe("applied");
  });
});
