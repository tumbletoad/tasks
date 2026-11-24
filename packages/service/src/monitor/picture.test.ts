// The Agents page's picture of a snapshot: each conversation once with the agents inside it, each
// account's plan usage, and nothing the page does not show. Fixture data only.
import { readFileSync } from "node:fs";
import { MONITOR_SCHEMA_VERSION } from "@ttasks/contracts/monitor";
import { TTAM_CONVERSATIONS } from "@ttasks/testkit";
import { describe, expect, test } from "vitest";
import { readSnapshot } from "./lines.ts";
import { pictureOf } from "./picture.ts";

type Obj = Record<string, unknown>;

const snapshots = readFileSync(TTAM_CONVERSATIONS.on, "utf8")
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line) as { from: string; line?: string })
  .flatMap((r) => (r.from === "ttam" && r.line !== undefined ? [JSON.parse(r.line) as Obj] : []))
  .filter((line) => line["type"] === "snapshot");
const last = readSnapshot(snapshots.at(-1) ?? {}, MONITOR_SCHEMA_VERSION);

describe("[A5.agents.picture] the Agents page's picture of a snapshot", () => {
  test("each conversation once, with every agent inside it one level under it", () => {
    const picture = pictureOf(last, 1_500);
    expect(picture.ageMs).toBe(1_500);
    expect(picture.settling).toBe(false);
    expect(picture.sessions.map((s) => [s.appName, s.title, s.activity])).toEqual([
      ["antigravity", "Port the parser", "idle"],
      ["claude", "synthetic-project", "working"],
      ["claude", "synthetic-project", "unknown"],
      ["codex", "API documentation", "working"],
      ["codex", "Release checklist", "idle"],
      ["cursor", "Sort the import queue", "unknown"],
      ["example", "synthetic-project", "idle"],
    ]);
    const [, claude, , codex] = picture.sessions;
    expect(claude?.nested.map((n) => [n.kind, n.title, n.activity])).toEqual([
      ["subagent", "Survey the fixtures", "unknown"],
      ["subagent", "scout", "unknown"],
      ["workflow_agent", "Check the build", "working"],
      ["workflow_agent", "Run the tests", "working"],
    ]);
    // A conversation of its own that runs inside another is shown inside it.
    expect(codex?.nested.map((n) => n.title)).toEqual(["Map endpoints"]);
    const agents = picture.sessions.length + picture.sessions.flatMap((s) => s.nested).length;
    expect(agents).toBe(last.agents.length);
  });

  test("an agent app TTasks does not know keeps its name, and its state stays unknown", () => {
    const picture = pictureOf(last, 0);
    expect(picture.sessions.at(-1)).toMatchObject({ app: "unknown", appName: "example" });
    expect(picture.sessions[2]).toMatchObject({ activity: "unknown", quietMs: null });
  });

  test("an agent whose parent is gone or whose chain loops stands on its own", () => {
    const [a, b] = last.agents;
    if (a === undefined || b === undefined) throw new Error("fixture");
    const looped = pictureOf(
      {
        ...last,
        agents: [
          { ...a, rowId: "x", parentRowId: "y", name: "x" },
          { ...b, rowId: "y", parentRowId: "x", name: "y" },
          { ...b, rowId: "w", parentRowId: "x", name: "w" },
          { ...b, rowId: "z", parentRowId: "gone", name: "z" },
        ],
      },
      0,
    );
    expect(looped.sessions.map((s) => [s.title, s.nested.length])).toEqual([
      ["x", 0],
      ["y", 0],
      ["w", 0],
      ["z", 0],
    ]);
  });

  test("a row's key is the same in the next snapshot and differs between rows", () => {
    const keys = pictureOf(last, 0).sessions.map((s) => s.key);
    expect(pictureOf(last, 9).sessions.map((s) => s.key)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("plan usage per account, with each one's own state", () => {
    const picture = pictureOf(last, 0);
    expect(picture.accounts.map((a) => [a.appName, a.account, a.plan])).toEqual([
      ["claude", "claude", "Claude Max"],
      ["codex", "spare", null],
      ["codex", "codex", "plus"],
      ["antigravity", "antigravity-cli", null],
      ["cursor", "cursor", null],
      ["grok", "grok", null],
      ["example", "example", "team"],
    ]);
    const plus = picture.accounts[2];
    expect(plus).toMatchObject({ limited: true, refreshing: false, failed: null, sameAs: null });
    expect(plus?.windows.map((w) => [w.kind, w.usedPercent, w.limited])).toEqual([
      ["weekly", 100, true],
      ["session", 100, true],
    ]);
    expect(picture.accounts[1]).toMatchObject({ windows: [], readingAgeMs: null });
  });

  test("a home signed in to the same account as one listed before it names that one", () => {
    const [, spare, plus] = last.accounts;
    if (spare === undefined || plus === undefined) throw new Error("fixture");
    const shared = pictureOf(
      {
        ...last,
        accounts: [
          { ...spare, sameAccount: spare.homeId },
          { ...plus, sameAccount: spare.homeId },
        ],
      },
      0,
    );
    expect(shared.accounts.map((a) => [a.account, a.sameAs])).toEqual([
      ["spare", null],
      ["codex", "spare"],
    ]);
  });

  test("no session ID, home path or process reaches the page", () => {
    const text = JSON.stringify(pictureOf(last, 0));
    for (const agent of last.agents) expect(text).not.toContain(agent.sessionId);
    for (const home of last.homes) expect(text).not.toContain(home.path);
    expect(text).not.toContain("pid");
  });
});
