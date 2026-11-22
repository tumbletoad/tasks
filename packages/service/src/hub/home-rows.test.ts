// A home's agent-home rows by app and folder (home-rows.ts), over a grants table in memory.
import { describe, expect, test } from "vitest";
import { MemoryGrants } from "../local/index.ts";
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
      homeRows({ grants: () => grants, platform: "linux" }, "claude-code", "/home/fixture/.claude"),
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
      homeRows({ grants: () => grants, platform: "linux" }, "claude-code", "/home/fixture/.claude"),
    ).toEqual({ kind: "rows", rows: [] });
  });

  test("the folder is compared as the OS compares paths", () => {
    const { grants, row } = table();
    const win = row("codex", "C:\\Users\\Fixture\\.codex", "codex-one");
    expect(
      homeRows(
        { grants: () => grants, platform: "win32" },
        "codex",
        "c:\\users\\fixture\\.codex\\",
      ),
    ).toMatchObject({ kind: "rows", rows: [{ grant: win }] });
    const posix = row("codex", "/home/fixture/.codex", "codex-two");
    const on = (platform: NodeJS.Platform, home: string) =>
      homeRows({ grants: () => grants, platform }, "codex", home);
    expect(on("linux", "/home/fixture/./.codex/")).toMatchObject({ rows: [{ grant: posix }] });
    expect(on("linux", "/home/Fixture/.codex")).toEqual({ kind: "rows", rows: [] });
  });

  test("a grants table that cannot be read is a failed lookup", () => {
    const broken = {
      list: () => {
        throw new Error("the service database is gone");
      },
    };
    expect(homeRows({ grants: () => broken, platform: "linux" }, "codex", "/home/fixture")).toEqual(
      {
        kind: "failed",
      },
    );
    expect(
      homeRows(
        {
          grants: () => {
            throw new Error("no grants table yet");
          },
          platform: "linux",
        },
        "codex",
        "/home/fixture",
      ),
    ).toEqual({ kind: "failed" });
  });
});
