// The agent apps' switches as the page holds them: the first start proposes the usual choice,
// Settings shows them as they stand, Apply sends only what can be turned over, and a view that came
// back newer keeps the person's choices that can still be made.
import { describe, expect, test } from "vitest";
import {
  appliedOf,
  carryChoices,
  choose,
  initialChoices,
  pendingOf,
  shownOn,
  switchKey,
  viewOf,
  type AppsView,
} from "./apps.ts";

const part = (on: boolean, change: "add" | "remove" | null, plan = "0123456789abcdef") => ({
  on,
  change,
  file: "~/.claude.json",
  detail: ['+ mcpServers.ttasks.command = "ttasks"'],
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
    expect(shownOn(first, VIEW.rows[0], "open")).toBe(true);
    expect(shownOn(first, VIEW.rows[0], "tools")).toBe(true);
    // One that cannot be turned on here stays as it is.
    expect(shownOn(first, VIEW.rows[2], "tools")).toBe(false);
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

  test("a newer view takes every switch the person did not touch as it stands now", () => {
    const [claude] = VIEW.rows;
    if (claude === undefined) throw new Error("no rows");
    const offCodex = { ...VIEW.rows[1], open: part(false, "add"), tools: part(false, "add") };
    const view = viewOf({ ...VIEW, rows: [VIEW.rows[0], offCodex] });
    const touched = choose(view, initialChoices(view, false), claude, "tools", true);
    // Another window turned Codex's tools on meanwhile.
    const newer = viewOf({
      ...VIEW,
      rows: [VIEW.rows[0], { ...offCodex, tools: part(true, "remove", "fedcba9876543210") }],
    });
    const carried = carryChoices(newer, touched);
    expect(pendingOf(newer, carried).map((p) => [p.row.key, p.part, p.on])).toEqual([
      ["claude", "tools", true],
    ]);
    expect(shownOn(carried, newer.rows[1], "tools")).toBe(true);
  });

  test("several Claude Desktop files: none is proposed, and turning one on turns off the others that are off", () => {
    const desktop = (key: string, tools: ReturnType<typeof part> & { why?: string }) => ({
      key,
      app: "claude-desktop",
      label: "Claude Desktop",
      home: `~/${key}`,
      also: [],
      tools,
    });
    const view = viewOf({
      space: "sp_one",
      rows: [
        desktop("a", { ...part(false, "add"), why: "several" }),
        desktop("b", { ...part(false, "add"), why: "several" }),
        desktop("c", part(true, "remove")),
      ],
    });
    expect(pendingOf(view, initialChoices(view, true))).toEqual([]);
    const [a, b] = view.rows;
    if (a === undefined || b === undefined) throw new Error("no rows");
    const one = choose(view, initialChoices(view, false), a, "tools", true);
    const other = choose(view, one, b, "tools", true);
    // The last one turned on is the one applied; one that has the tools keeps them.
    expect(pendingOf(view, other).map((p) => [p.row.key, p.on])).toEqual([["b", true]]);
    expect(shownOn(other, view.rows[2], "tools")).toBe(true);
  });

  test("an answer of another shape is refused, and an applied one is read with its outcomes", () => {
    expect(() => viewOf({ rows: "no" })).toThrow();
    // Setup's own record that cannot be read is named once, for the whole page.
    expect(viewOf({ space: "sp_one", rows: [], record: "~/state/setup/agents.json" }).record).toBe(
      "~/state/setup/agents.json",
    );
    expect(viewOf({ space: "sp_one", rows: [] }).record).toBeUndefined();
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
