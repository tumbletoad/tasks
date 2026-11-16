// The page's receipt from a `launches` row: the terminal and its source reach
// the page only as the fixed words a launch records. Fixture rows only.
import { describe, expect, test } from "vitest";
import { receiptOf } from "./launches.ts";

const row = (evidence: Record<string, unknown>) => ({
  id: "la_00r5mfcw5rfzxb9enb2vg50z3g",
  reference: "L7KQ21",
  instance_id: "cx",
  route: "terminal",
  state: "dispatched",
  reason: null,
  detail: JSON.stringify({ at: { prepared: 1, dispatching: 2, dispatched: 3 }, evidence }),
});

describe("[A4.5.terminal.receipt] the receipt names the terminal and its source", () => {
  test("the recorded words pass; anything else is left out, never shown", () => {
    expect(receiptOf(row({ terminal: "ghostty", terminal_source: "desktop" }))).toMatchObject({
      terminal: { app: "ghostty", source: "desktop" },
      at: { prepared: 1, dispatching: 2, dispatched: 3 },
    });
    for (const evidence of [
      {},
      { terminal: "ghostty" },
      { terminal: "auto", terminal_source: "desktop" },
      { terminal: "alacritty", terminal_source: "desktop" },
      { terminal: "ghostty", terminal_source: "/home/someone" },
      { terminal: 3, terminal_source: "desktop" },
    ]) {
      expect(receiptOf(row(evidence))).not.toHaveProperty("terminal");
    }
  });
});
