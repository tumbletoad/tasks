// The agent apps' switches as the page holds them: the first start proposes the usual choice,
// Settings shows them as they stand, Apply sends only what can be turned over, and a view that came
// back newer keeps the person's choices that can still be made.
import { describe, expect, test } from "vitest";
import {
  appliedOf,
  carryChoices,
  initialChoices,
  pendingOf,
  switchKey,
  viewOf,
  type AppsView,
} from "./apps.ts";

const part = (on: boolean, change: "add" | "remove" | null, plan = "0123456789abcdef") => ({
  on,
  change,
  file: "~/.claude.json",
  detail: ['+ mcpServers.tasks.command = "tasks"'],
  plan,
});

const VIEW: AppsView = viewOf({
  space: "sp_one",
  rows: [
    {
      key: "claude",
      app: "claude-code",
      label: "Claude Code",
      home: "~/.claude",
      also: ["t3", "elsewhere"],
      open: part(false, "add"),
      tools: part(false, "add"),
    },
    {
      key: "codex",
      app: "codex",
      label: "Codex",
      home: "~/.codex",
      also: [],
      open: part(true, null),
      tools: part(true, "remove"),
    },
    {
      key: "desktop",
      app: "claude-desktop",
      label: "Claude Desktop",
      home: "~/.config/Claude",
      also: [],
      tools: { ...part(false, null), why: "not_set_up" },
    },
  ],
});

describe("[A7.3.12.m5-12.web-apps] The agent apps' switches in the page", () => {
  test("the first start turns on every switch that can be turned on, and Settings shows them as they stand", () => {
    const first = initialChoices(VIEW, true);
    expect(first.get(switchKey("claude", "open"))).toBe(true);
    expect(first.get(switchKey("claude", "tools"))).toBe(true);
    // One that cannot be turned on here stays as it is.
    expect(first.get(switchKey("desktop", "tools"))).toBe(false);
    expect(pendingOf(VIEW, first).map((p) => [p.row.key, p.part, p.on])).toEqual([
      ["claude", "open", true],
      ["claude", "tools", true],
    ]);
    const later = initialChoices(VIEW, false);
    expect(pendingOf(VIEW, later)).toEqual([]);
    expect(VIEW.rows[0]?.also).toEqual(["t3"]);
    expect(VIEW.rows[2]?.tools?.why).toBe("not_set_up");
  });

  test("Apply sends only switches turned over that can be: off where it can be taken out", () => {
    const choices = new Map(initialChoices(VIEW, false))
      .set(switchKey("codex", "tools"), false)
      .set(switchKey("codex", "open"), false)
      .set(switchKey("desktop", "tools"), true);
    expect(pendingOf(VIEW, choices).map((p) => [p.row.key, p.part, p.on])).toEqual([
      ["codex", "tools", false],
    ]);
  });

  test("a newer view keeps the person's choices that can still be made", () => {
    const choices = new Map(initialChoices(VIEW, true)).set(switchKey("codex", "tools"), false);
    const newer = viewOf({
      ...VIEW,
      rows: [
        { ...VIEW.rows[0], tools: part(false, null) },
        { ...VIEW.rows[1], tools: part(true, "remove", "fedcba9876543210") },
      ],
    });
    const carried = carryChoices(newer, choices);
    expect(pendingOf(newer, carried).map((p) => [p.row.key, p.part, p.on, p.found.plan])).toEqual([
      ["claude", "open", true, "0123456789abcdef"],
      ["codex", "tools", false, "fedcba9876543210"],
    ]);
  });

  test("an answer of another shape is refused, and an applied one is read with its outcomes", () => {
    expect(() => viewOf({ rows: "no" })).toThrow();
    const applied = appliedOf({
      applied: true,
      view: VIEW,
      outcomes: [
        { key: "claude", part: "tools", result: "failed", reason: "command_failed" },
        { key: "claude", part: "open", result: "done" },
      ],
    });
    expect(applied.applied && applied.outcomes.map((o) => o.result)).toEqual(["failed", "done"]);
    expect(appliedOf({ applied: false, view: VIEW }).applied).toBe(false);
  });
});
