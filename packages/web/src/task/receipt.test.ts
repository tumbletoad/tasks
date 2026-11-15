// A terminal launch's receipt names the terminal and why it was chosen (A4 3.6.1), in the page's
// own words from its catalogue. Fixture receipts only.
import { createIntl } from "react-intl";
import { describe, expect, test } from "vitest";
import { APP_NAME, CLI_NAME } from "@tasks/brand";
import type { Receipt } from "../api.ts";
import en from "../i18n/en.json" with { type: "json" };
import type { MessageId, Values } from "../i18n/intl.tsx";
import { receiptText } from "./Thread.tsx";

const intl = createIntl({
  locale: "en",
  messages: en,
  onError: (e) => {
    throw e;
  },
});
const t = (id: MessageId, values?: Values) =>
  intl.formatMessage({ id }, { product: APP_NAME, cli: CLI_NAME, ...values });

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
      "Open in Codex · work · Ghostty, the desktop's default",
    );
    const cases: [string, string, string][] = [
      ["wt", "windows", "Windows Terminal, Windows' default"],
      ["console", "windows", "a console window, Windows' default"],
      ["gnome-terminal", "installed", "GNOME Terminal, the first installed"],
      ["x-terminal-emulator", "distribution", "x-terminal-emulator, the distribution's default"],
      ["kitty", "terminal_var", "kitty, from $TERMINAL"],
      ["custom", "configured", "your custom terminal, set in machine.toml"],
      ["konsole", "fallback", "Konsole, a fallback"],
    ];
    for (const [app, source, words] of cases) {
      expect(receiptText(receipt({ terminal: { app, source } }), "Cx", t)).toBe(
        `Opening in ${words}…`,
      );
    }
    expect(receiptText(receipt({}), "Cx", t)).toBe("Opening…");
    expect(receiptText(receipt({ state: "confirmed" }), "Cx", t)).toBe("Open in Cx");
  });
});
