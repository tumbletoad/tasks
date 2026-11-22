// A terminal launch's receipt names the terminal and why it was chosen, in the page's
// own words from its catalogue. Fixture receipts only.
import { createIntl } from "react-intl";
import { describe, expect, test } from "vitest";
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import type { Receipt } from "../api.ts";
import en from "../i18n/en.json" with { type: "json" };
import type { MessageId, Values } from "../i18n/intl.tsx";
import { entryState, ranFor, receiptText } from "./Thread.tsx";

const intl = createIntl({
  locale: "en",
  messages: en,
  onError: (e) => {
    throw e;
  },
});
const t = (id: MessageId, values?: Values) =>
  intl.formatMessage({ id }, { product: PRODUCT_NAME, cli: CLI_NAME, ...values });

const receipt = (over: Partial<Receipt>): Receipt => ({
  id: "la_00r5mfcw5rfzxb9enb2vg50z3g",
  reference: "L7KQ21",
  instance: "cx",
  route: "terminal",
  state: "dispatched",
  reason: null,
  at: {},
  ...over,
});

describe("[A4.5.terminal.receipt] the receipt names the terminal and its source", () => {
  test("dispatched and confirmed name both; without them the words stay as before", () => {
    const ghostty = { app: "ghostty", source: "desktop" };
    expect(receiptText(receipt({ terminal: ghostty }), "Codex · work", t)).toBe(
      "Opening in Ghostty, the desktop's default…",
    );
    expect(receiptText(receipt({ state: "confirmed", terminal: ghostty }), "Codex · work", t)).toBe(
      "Opened in Ghostty, the desktop's default",
    );
    const cases: [string, string, string][] = [
      ["wt", "windows", "Windows Terminal, Windows' default"],
      ["console", "windows", "a console window, Windows' default"],
      ["gnome-terminal", "installed", "GNOME Terminal, the first installed"],
      ["x-terminal-emulator", "distribution", "x-terminal-emulator, the distribution's default"],
      ["kitty", "terminal_var", "kitty, from $TERMINAL"],
      ["custom", "configured", "your custom terminal, chosen in Settings"],
      ["konsole", "fallback", "Konsole, a fallback"],
    ];
    for (const [app, source, words] of cases) {
      expect(receiptText(receipt({ terminal: { app, source } }), "Cx", t)).toBe(
        `Opening in ${words}…`,
      );
    }
    expect(receiptText(receipt({}), "Cx", t)).toBe("Opening…");
    expect(receiptText(receipt({ state: "confirmed" }), "Cx", t)).toBe("Opened in Cx");
  });
});

describe("[A4.5.receipt.folder-reason] a launch its folder stopped says why in the toast's words", () => {
  test("the folder's reason in words, any other reason as its code reads", () => {
    const failed = (reason: string) => receiptText(receipt({ state: "failed", reason }), "Cx", t);
    expect(failed("path_missing")).toBe("Did not open: the folder was not found on this machine");
    expect(failed("not_a_directory")).toBe(
      "Did not open: the task's folder is a file on this machine",
    );
    expect(failed("not_answering")).toBe("Did not open: the task's folder did not answer in time");
    expect(failed("unsafe_folder")).toBe(
      "Did not open: the task's folder cannot be used on this machine",
    );
    expect(failed("agent_exited")).toBe("Did not open: the agent ended right after it started");
    expect(failed("expired")).toBe("Did not open: expired");
  });
});

describe("[A5.3.9.web.session-entry] a launch's entry is a record: opened, then running or ended as far as the service knows", () => {
  const ghostty = { app: "ghostty", source: "configured" };
  const confirmed = (over: Partial<Receipt>) =>
    receipt({ state: "confirmed", terminal: ghostty, ...over });
  const where = "Opened in Ghostty, chosen in Settings";

  test("running, ended with and without its length, and opened where the service cannot follow it", () => {
    expect(receiptText(confirmed({ session: "running" }), "Cx", t)).toBe(`${where} · running`);
    expect(receiptText(confirmed({ session: "ended", ran_ms: 125_000 }), "Cx", t)).toBe(
      `${where} · ended after 2 min`,
    );
    // An earlier build recorded the end by its exit code alone.
    expect(receiptText(confirmed({ session: "ended" }), "Cx", t)).toBe(`${where} · ended`);
    // A launch recorded before the service followed sessions, or a shim gone without a word.
    expect(receiptText(confirmed({}), "Cx", t)).toBe(where);
    expect(receiptText(receipt({ state: "confirmed", route: "t3-mcp" }), "T3 Code", t)).toBe(
      "Opened in T3 Code",
    );
    // A link or T3 only asked the app: it says so until the agent connects.
    expect(receiptText(receipt({ state: "dispatched", route: "link" }), "Claude", t)).toBe(
      "Asked Claude to open",
    );
    expect(receiptText(receipt({ state: "dispatched", route: "t3-mcp" }), "T3 Code", t)).toBe(
      "Asked T3 Code to open",
    );
    expect(receiptText(receipt({ state: "confirmed", route: "link" }), "Claude", t)).toBe(
      "Opened in Claude",
    );
  });

  test("only a running session carries the live mark", () => {
    expect(entryState(confirmed({ session: "running" }))).toBe("running");
    expect(entryState(confirmed({ session: "ended" }))).toBe("ended");
    expect(entryState(confirmed({}))).toBe("opened");
    expect(entryState(receipt({ state: "dispatched", route: "link" }))).toBe("dispatched");
    expect(entryState(receipt({ state: "dispatched" }))).toBe("dispatched");
    expect(entryState(receipt({ state: "failed", reason: "agent_exited" }))).toBe("failed");
  });

  test("how long it ran, in short words", () => {
    expect(ranFor(400, t)).toBe("1 s");
    expect(ranFor(42_000, t)).toBe("42 s");
    expect(ranFor(60_000, t)).toBe("1 min");
    expect(ranFor(59 * 60_000 + 59_000, t)).toBe("59 min");
    expect(ranFor(60 * 60_000, t)).toBe("1 h");
    expect(ranFor(65 * 60_000, t)).toBe("1 h 5 min");
  });
});
