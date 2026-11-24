// The name a person reads for an instance, built one way for every place that shows it.
import { describe, expect, test } from "vitest";
import { instanceNames } from "../src/sections.ts";

describe("[A4.3.2.instance.names] an instance is named by its app, and by its own name beside a sibling", () => {
  test("the only instance of its app is the app's name, whatever its label says", () => {
    expect(
      instanceNames([
        { app: "Claude Code", label: "Claude Code · work", account: "work" },
        { app: "Codex", label: "Codex · codex", account: "codex" },
        { app: "T3 Code", label: "Codex · T3 Code", account: "default" },
      ]),
    ).toEqual(["Claude Code", "Codex", "T3 Code"]);
  });

  test("two of an app each add their own name: the label without the app, else the account", () => {
    expect(
      instanceNames([
        { app: "Claude Code", label: "Claude Code", account: "default" },
        { app: "Claude Code", label: "Claude Code · work", account: "work" },
        { app: "Codex", label: "personal", account: "personal" },
        { app: "Codex", label: "Codex · .codex", account: "default" },
        { app: "T3 Code", label: "Codex · T3 Code", account: "default" },
        { app: "T3 Code", label: "Claude · T3 Code", account: "default" },
      ]),
    ).toEqual([
      "Claude Code · default",
      "Claude Code · work",
      "Codex · personal",
      "Codex · default",
      "T3 Code · Codex",
      "T3 Code · Claude",
    ]);
  });
});
