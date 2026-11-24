// A home's agent-home rows by the app, folder and file a click recorded (home-rows.ts), over a
// grants table in memory.
import { describe, expect, test } from "vitest";
import { MemoryGrants } from "../local/index.ts";
import { standing } from "../binding/decide.ts";
import { homeRows } from "./home-rows.ts";

const SPACE = "sp_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const OTHER = "sp_0000000000000000000000000z";

function table() {
  const grants = new MemoryGrants();
  let at = Date.parse("2026-11-01T10:00:00.000Z");
  const row = (app: string, home: string, instance: string, space = SPACE) =>
    grants.create(
      { kind: "agent_home", principal: "user", spaces: [space], attrs: { app, home, instance } },
      new Date((at += 1_000)),
    ).grant.grant_id;
  return { grants, row };
}

describe("[A3.3.7.binding.home-rows] a home's agent-home rows by its app and folder", () => {
  test("newest first, each with its instance, its spaces and whether it is live", () => {
    const { grants, row } = table();
    const first = row("claude-code", "/home/fixture/.claude", "work-claude");
    const second = row("claude-code", "/home/fixture/.claude", "main-claude", OTHER);
    grants.revoke(first);
    row("codex", "/home/fixture/.claude", "codex-one");
    row("claude-code", "/home/fixture/.claude-other", "other-claude");
    expect(
      homeRows(
        { grants: () => grants, platform: "linux" },
        { app: "claude-code", home: "/home/fixture/.claude" },
      ),
    ).toEqual({
      kind: "rows",
      rows: [
        { grant: second, instance: "main-claude", spaces: [OTHER], live: true },
        { grant: first, instance: "work-claude", spaces: [SPACE], live: false },
      ],
    });
  });

  test("a home that was never registered has no rows", () => {
    const { grants, row } = table();
    row("codex", "/home/fixture/.codex", "codex-one");
    expect(
      homeRows(
        { grants: () => grants, platform: "linux" },
        { app: "claude-code", home: "/home/fixture/.claude" },
      ),
    ).toEqual({ kind: "rows", rows: [] });
  });

  test("the folder is compared as the OS compares paths", () => {
    const { grants, row } = table();
    const win = row("codex", "C:\\Users\\Fixture\\.codex", "codex-one");
    expect(
      homeRows(
        { grants: () => grants, platform: "win32" },
        { app: "codex", home: "c:\\users\\fixture\\.codex\\" },
      ),
    ).toMatchObject({ kind: "rows", rows: [{ grant: win }] });
    const posix = row("codex", "/home/fixture/.codex", "codex-two");
    const on = (platform: NodeJS.Platform, home: string) =>
      homeRows({ grants: () => grants, platform }, { app: "codex", home });
    expect(on("linux", "/home/fixture/./.codex/")).toMatchObject({ rows: [{ grant: posix }] });
    expect(on("linux", "/home/Fixture/.codex")).toEqual({ kind: "rows", rows: [] });
  });

  test("a grants table that cannot be read is a failed lookup", () => {
    const broken = {
      list: () => {
        throw new Error("the service database is gone");
      },
    };
    expect(
      homeRows(
        { grants: () => broken, platform: "linux" },
        { app: "codex", home: "/home/fixture" },
      ),
    ).toEqual({
      kind: "failed",
    });
    expect(
      homeRows(
        {
          grants: () => {
            throw new Error("no grants table yet");
          },
          platform: "linux",
        },
        { app: "codex", home: "/home/fixture" },
      ),
    ).toEqual({ kind: "failed" });
  });
});

describe("[A3.3.7.binding.home-rows] a home's agent-home rows by its app and folder", () => {
  test("two settings files of one folder: a click that recorded its file has that file's rows; an earlier build's row of the folder is the file that build gave it", () => {
    const grants = new MemoryGrants();
    const user = "/home/fixture";
    const folder = `${user}/.claude`;
    const plain = `${user}/.claude.json`;
    const named = `${folder}/.claude.json`;
    const made = (attrs: Record<string, unknown>) =>
      grants.create({ kind: "agent_home", principal: "user", spaces: [SPACE], attrs }).grant
        .grant_id;
    const ofPlain = made({ app: "claude-code", home: folder, file: plain, instance: "claude" });
    const ofNamed = made({ app: "claude-code", home: folder, file: named, instance: "claude-2" });
    const host = { grants: () => grants, platform: "linux" as const, userHome: user };
    const grantsOf = (file?: string) => {
      const rows = homeRows(host, {
        app: "claude-code",
        home: folder,
        ...(file === undefined ? {} : { file }),
      });
      return rows.kind === "rows" ? rows.rows.map((r) => r.grant) : [];
    };
    expect(grantsOf(plain)).toEqual([ofPlain]);
    expect(grantsOf(named)).toEqual([ofNamed]);
    // A launch an earlier build recorded names the folder only.
    expect(grantsOf().sort()).toEqual([ofPlain, ofNamed].sort());
    // That build's row of the folder: plain Claude Code's file, never the named one's.
    grants.revoke(ofPlain);
    grants.revoke(ofNamed);
    const earlier = made({ app: "claude-code", home: folder, instance: "claude" });
    expect(grantsOf(plain)).toContain(earlier);
    expect(grantsOf(named)).not.toContain(earlier);
  });
});

describe("[A3.3.7.binding.home-rows] a home's agent-home rows by its app and folder", () => {
  test("a launched agent's shell may use a space while its own file's row is live: turning that file off stops it, whatever the other file of its folder has", () => {
    const grants = new MemoryGrants();
    const user = "/home/fixture";
    const folder = `${user}/.claude`;
    const made = (file: string, instance: string) =>
      grants.create({
        kind: "agent_home",
        principal: "user",
        spaces: [SPACE],
        attrs: { app: "claude-code", home: folder, file, instance },
      }).grant.grant_id;
    const plain = made(`${user}/.claude.json`, "claude");
    made(`${folder}/.claude.json`, "claude-2");
    const sources = {
      named: () => ({ kind: "none" }) as const,
      rows: (click: Parameters<typeof homeRows>[1]) =>
        homeRows({ grants: () => grants, platform: "linux", userHome: user }, click),
      runAllows: () => false,
      machineDefault: () => undefined,
    };
    const shell = () =>
      standing(sources, {
        of: "launch",
        app: "claude-code",
        home: folder,
        file: `${user}/.claude.json`,
      });
    const read = shell();
    expect(read.kind === "read" && read.may(SPACE)).toBe(true);
    grants.revoke(plain);
    const after = shell();
    expect(after.kind === "read" && after.may(SPACE)).toBe(false);
  });
});
