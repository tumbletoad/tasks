import { describe, expect, test } from "vitest";
import type { Receipt, ReceiptState } from "./api.ts";
import { Latest } from "./latest.ts";
import { tileClick, tileState } from "./row/launch.ts";

const receipt = (state: ReceiptState, route = "terminal", instance = "cx"): Receipt => ({
  id: `ln_${state}`,
  reference: "M-1",
  instance,
  route,
  state,
  reason: null,
  at: { prepared: 1 },
});

describe("[A5.3.6.web.tile] the launch tile's states and clicks", () => {
  test("each receipt state gives A5's tile state, from the instance's latest receipt", () => {
    expect(tileState([], "cx")).toBe("ready");
    expect(tileState([receipt("prepared")], "cx")).toBe("opening");
    expect(tileState([receipt("dispatching")], "cx")).toBe("opening");
    expect(tileState([receipt("dispatched")], "cx")).toBe("opening");
    expect(tileState([receipt("dispatched", "link")], "cx")).toBe("not_confirmed");
    expect(tileState([receipt("confirmed")], "cx")).toBe("connected");
    expect(tileState([receipt("failed")], "cx")).toBe("ready");
    expect(tileState([receipt("unknown")], "cx")).toBe("ready");
    // Another instance's receipt says nothing about this tile.
    expect(tileState([receipt("confirmed", "terminal", "cc")], "cx")).toBe("ready");
    expect(tileState([receipt("confirmed"), receipt("failed")], "cx")).toBe("ready");
  });

  test("only a Ready tile opens; a launch on its way or done expands the task, never a second launch", () => {
    expect(tileClick("ready")).toBe("open");
    expect(tileClick("opening")).toBe("none");
    expect(tileClick("not_confirmed")).toBe("expand");
    expect(tileClick("connected")).toBe("expand");
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
