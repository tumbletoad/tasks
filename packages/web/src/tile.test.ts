import { describe, expect, test } from "vitest";
import type { Receipt, ReceiptState } from "./api.ts";
import { Latest } from "./latest.ts";
import { tileClick, tileState } from "./row/launch.ts";

const receipt = (
  state: ReceiptState,
  route = "terminal",
  instance = "cx",
  session?: Receipt["session"],
): Receipt => ({
  id: `ln_${state}_${session ?? ""}`,
  reference: "M-1",
  instance,
  route,
  state,
  reason: null,
  at: { prepared: 1 },
  ...(session === undefined ? {} : { session }),
});

describe("[A5.3.6.web.tile] the launch tile's states and clicks", () => {
  test("Opening while the latest launch is on its way, Running while a session runs, else Ready", () => {
    expect(tileState([], "cx")).toBe("ready");
    expect(tileState([receipt("prepared")], "cx")).toBe("opening");
    expect(tileState([receipt("dispatching")], "cx")).toBe("opening");
    expect(tileState([receipt("dispatched")], "cx")).toBe("opening");
    // A link has gone once the app was asked: nothing follows it, so nothing waits for it.
    expect(tileState([receipt("dispatched", "link")], "cx")).toBe("ready");
    expect(tileState([receipt("confirmed", "terminal", "cx", "running")], "cx")).toBe("running");
    expect(tileState([receipt("failed")], "cx")).toBe("ready");
    expect(tileState([receipt("unknown")], "cx")).toBe("ready");
    // Another instance's receipt says nothing about this tile.
    expect(tileState([receipt("confirmed", "terminal", "cc", "running")], "cx")).toBe("ready");
    // An older session that still runs keeps the tile Running after a newer one failed.
    expect(
      tileState([receipt("confirmed", "terminal", "cx", "running"), receipt("failed")], "cx"),
    ).toBe("running");
  });

  test("a session that ended, or one the service cannot follow, blocks nothing", () => {
    // Confirmed launches whose agents are gone, recorded with an end or, by an earlier build,
    // without one.
    expect(tileState([receipt("confirmed", "terminal", "cx", "ended")], "cx")).toBe("ready");
    expect(tileState([receipt("confirmed")], "cx")).toBe("ready");
    expect(tileState([receipt("confirmed", "t3-mcp")], "cx")).toBe("ready");
    expect(
      tileState([receipt("confirmed"), receipt("confirmed"), receipt("confirmed")], "cx"),
    ).toBe("ready");
    expect(tileClick(tileState([receipt("confirmed")], "cx"))).toBe("open");
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
