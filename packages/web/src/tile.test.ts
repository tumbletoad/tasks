import { describe, expect, test } from "vitest";
import { Latest } from "./latest.ts";
import type { Instance } from "./api.ts";
import { agentFor, busyByTask, tileClick, tileState } from "./row/launch.ts";
import type { TaskRow } from "./store/rows.ts";

describe("[A5.3.6.web.tile] the launch tile's states and clicks", () => {
  test("the tile shows what busies its agent app with the task here, as the service says, else Ready", () => {
    const busy = busyByTask(
      [
        { task: "t1", instance: "cx", state: "running" },
        { task: "t1", instance: "cc", state: "opening" },
        { task: "t2", instance: "cx", state: "opening" },
      ],
      new Map(),
    );
    expect(tileState(busy.get("t1"), "cx")).toBe("running");
    expect(tileState(busy.get("t1"), "cc")).toBe("opening");
    expect(tileState(busy.get("t2"), "cx")).toBe("opening");
    expect(tileState(busy.get("t2"), "cc")).toBe("ready");
    expect(tileState(busy.get("t3"), "cx")).toBe("ready");
  });

  test("a task whose apps are busy as before keeps its object, so its row does not render again", () => {
    const before = busyByTask(
      [
        { task: "t1", instance: "cx", state: "running" },
        { task: "t2", instance: "cx", state: "opening" },
      ],
      new Map(),
    );
    const after = busyByTask(
      [
        { task: "t1", instance: "cx", state: "running" },
        { task: "t2", instance: "cx", state: "running" },
      ],
      before,
    );
    expect(after.get("t1")).toBe(before.get("t1"));
    expect(after.get("t2")).toEqual({ cx: "running" });
    expect(busyByTask([], after).size).toBe(0);
  });

  test("Ready opens; Running expands to the thread and the strip, where another opens", () => {
    expect(tileClick("ready")).toBe("open");
    expect(tileClick("opening")).toBe("none");
    expect(tileClick("running")).toBe("expand");
    // The states the place and the area decide (A5 3.6's table).
    expect(tileClick("unavailable")).toBe("expand");
    expect(tileClick("copy_only")).toBe("copy");
    expect(tileClick("elsewhere")).toBe("none");
    expect(tileClick("none")).toBe("none");
  });
});

describe("[A5.3.6.web.tile] the agent a task's Open uses by default", () => {
  test("after the upgrade to one T3 Code entry, a task last opened in a T3 profile that is gone opens in T3 Code, not in the first agent", () => {
    // What Open lists for a machine.toml with Codex first and two old T3 profiles: Codex, then the
    // first T3 instance, which is now the one T3 Code entry (`t3-claude` was the second).
    const list: Instance[] = [
      { key: "codex", app: "Codex", label: "Codex", glyph: "Cx", ring: 0, route: "terminal" },
      { key: "t3-codex", app: "T3 Code", label: "T3 Code", glyph: "T3", ring: 1, route: "t3-mcp" },
    ];
    const task = (last?: TaskRow["last"]): TaskRow =>
      ({
        id: "t1",
        ref: "M-1",
        title: "Fixture",
        ...(last === undefined ? {} : { last }),
      }) as TaskRow;
    const gone = { open: "t3-claude", open_route: "t3-mcp" } as const;
    expect(agentFor(list, "open", task(gone), {})?.key).toBe("t3-codex");
    expect(agentFor(list, "open", task(), gone)?.key).toBe("t3-codex");
    // The task's own last choice still comes before the space's.
    expect(agentFor(list, "open", task({ open: "codex", open_route: "terminal" }), gone)?.key).toBe(
      "codex",
    );
    // An instance that is gone and was no T3 Code: the first, as before.
    expect(
      agentFor(list, "open", task({ open: "claude-old", open_route: "terminal" }), {})?.key,
    ).toBe("codex");
  });
});

describe("[A5.3.9.web.refetch] a late answer never replaces a newer one", () => {
  test("only the newest read of a key may apply, whatever order the answers come in", () => {
    const reads = new Latest();
    const first = reads.begin("ts_a");
    const other = reads.begin("ts_b");
    const second = reads.begin("ts_a");
    // The second read answers first and applies; the first answers late and does not.
    expect(second()).toBe(true);
    expect(first()).toBe(false);
    // Each key keeps its own generations.
    expect(other()).toBe(true);
  });
});
