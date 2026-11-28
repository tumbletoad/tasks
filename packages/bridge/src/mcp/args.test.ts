// `ttasks mcp`'s arguments and the bind context built from an allow-list.
import { describe, expect, test } from "vitest";
import { MCP_CONTEXT_ENV } from "../protocol/index.ts";
import { parseArgs } from "./args.ts";
import { MAX_CWD, MAX_ENV_VALUE, baseContext, bindContext, contextEnv } from "./context.ts";

describe("[A2.3.7.bridge.hygiene] arguments and the bind context", () => {
  test("the three flags, in either spelling, each optional", () => {
    expect(parseArgs([])).toEqual({ space: null, instance: null, app: null });
    expect(
      parseArgs([
        "--space",
        "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf",
        "--instance=codex-work",
        "--app",
        "codex",
      ]),
    ).toEqual({ space: "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf", instance: "codex-work", app: "codex" });
  });

  test("anything else is a usage problem", () => {
    for (const argv of [
      ["--bogus"],
      ["positional"],
      ["--space"],
      ["--space="],
      ["--space", "--app"],
      ["--space", "a", "--space", "b"],
      ["--app", "../escape"],
      ["--instance", "has space"],
      ["--app", "x".repeat(129)],
    ]) {
      expect(parseArgs(argv), argv.join(" ")).toHaveProperty("problem");
    }
  });

  test("only the allow-listed environment values are copied, each short and well-formed", () => {
    const env: Record<string, string | undefined> = {
      TTASKS_TICKET: "Q4M8",
      CLAUDE_CODE_SESSION_ID: "6f1c",
      CODEX_THREAD_ID: "019a",
      T3CODE_THREAD_ID: "t3",
      TTASKS_TASK: "M-14",
      TTASKS_SPACE: "sp_x",
      CLAUDECODE: "1",
      CODEX_SANDBOX: "seatbelt",
      PATH: "/usr/bin",
      HOME: "/home/mira",
      TTASKS_HOME: "/x",
    };
    expect(contextEnv(env)).toEqual({
      TTASKS_TICKET: "Q4M8",
      CLAUDE_CODE_SESSION_ID: "6f1c",
      CODEX_THREAD_ID: "019a",
      T3CODE_THREAD_ID: "t3",
      TTASKS_TASK: "M-14",
      TTASKS_SPACE: "sp_x",
    });
    expect(MCP_CONTEXT_ENV).toHaveLength(6);
    expect(
      contextEnv({
        TTASKS_TICKET: "",
        TTASKS_TASK: "x".repeat(MAX_ENV_VALUE + 1),
        TTASKS_SPACE: "lone \ud800 surrogate",
        CODEX_THREAD_ID: undefined,
      }),
    ).toEqual({});
  });

  test("the context holds the arguments, cwd, env and parent; mcp_init and the held space only when known", () => {
    const base = baseContext(
      { space: "sp_a", instance: null, app: "codex" },
      { env: { TTASKS_TICKET: "T", SECRET: "S" }, cwd: "/work/repo", ppid: 4802 },
    );
    expect(bindContext(base, undefined)).toEqual({
      space: "sp_a",
      instance: null,
      app: "codex",
      cwd: "/work/repo",
      env: { TTASKS_TICKET: "T" },
      parent: { pid: 4802 },
    });
    const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: {} };
    expect(bindContext(base, init)).toMatchObject({ mcp_init: init });
    expect(bindContext(base, init, "sp_b")).toMatchObject({ held_space: "sp_b" });
    expect(bindContext(base, init)).not.toHaveProperty("held_space");
    // A working folder the bind frame cannot carry is sent as null.
    for (const cwd of [undefined, "", "x".repeat(MAX_CWD + 1), "C:\\a\udc00b"]) {
      expect(
        baseContext({ space: null, instance: null, app: null }, { env: {}, cwd, ppid: 1 }).cwd,
      ).toBeNull();
    }
  });
});
