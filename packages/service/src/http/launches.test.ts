// The page's receipt from a `launches` row: the terminal and its source reach
// the page only as the fixed words a launch records. Fixture rows only.
import { describe, expect, test } from "vitest";
import { receiptOf } from "./launches.ts";

const ID = "la_00r5mfcw5rfzxb9enb2vg50z3g";

const row = (evidence: Record<string, unknown>, state = "dispatched") => ({
  id: ID,
  reference: "L7KQ21",
  instance_id: "cx",
  route: "terminal",
  state,
  reason: null,
  detail: JSON.stringify({ at: { prepared: 1, dispatching: 2, dispatched: 3 }, evidence }),
});

describe("[A5.3.9.service.session] a Confirmed launch's session: running only while the service follows it, ended once its end was reported", () => {
  const runs = (launch: string) => launch === ID;
  const confirmed = (evidence: Record<string, unknown>) =>
    receiptOf(row({ claim: "c1", folder_checked: true, ...evidence }, "confirmed"), runs);

  test("running while followed; ended with how long it ran, also by an earlier build's exit code", () => {
    expect(confirmed({})).toMatchObject({ session: "running" });
    expect(confirmed({ exit_code: 0, ran_ms: 125_000 })).toMatchObject({
      session: "ended",
      ran_ms: 125_000,
    });
    // An end the record names wins over a shim record not yet released.
    expect(confirmed({ ran_ms: 9_000 })).toMatchObject({ session: "ended" });
    expect(confirmed({ exit_code: 0 })).toMatchObject({ session: "ended" });
    expect(confirmed({ exit_code: 0 })).not.toHaveProperty("ran_ms");
  });

  test("never running where the service cannot follow it: a lost shim, another computer, an earlier build's record", () => {
    expect(confirmed({ lost_at: 5 })).not.toHaveProperty("session");
    const elsewhere = row({ claim: "c1" }, "confirmed");
    expect(receiptOf(elsewhere, () => false)).not.toHaveProperty("session");
    expect(receiptOf(elsewhere)).not.toHaveProperty("session");
    // Only a Confirmed launch has a session to show: a dispatched one is still opening.
    expect(receiptOf(row({ claim: "c1" }), runs)).not.toHaveProperty("session");
  });
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
