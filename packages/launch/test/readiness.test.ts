// What an instance's app reports about itself, with the testkit's stand-in `claude` and `codex` on a
// scratch PATH and in a scratch home: their status commands find a login while a marker file is in
// the app's home. The lines to paste are read by the shell of each OS in shell-line's own test.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FAKE_SIGNED_IN, installFakeAgents, type FakeAgents } from "@ttasks/testkit/fake-agents";
import { instanceReadiness, oneCall } from "../src/readiness.ts";
import type { Instance } from "../src/sections.ts";

let root: string;
let home: string;
let fakes: FakeAgents;
const platform = process.platform;
const windows = platform === "win32";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ttasks-ready-"));
  home = join(root, "u");
  mkdirSync(home);
  fakes = installFakeAgents(join(root, "t"), home);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

type Checked = Pick<Instance, "target" | "exec" | "argsPrefix" | "env" | "configHome">;
const claude = (env: Record<string, string> = {}): Checked => ({
  target: "claude-cli",
  exec: "claude",
  argsPrefix: [],
  env,
  configHome: undefined,
});
const ready = (instance: Checked, more: Record<string, string> = {}) =>
  instanceReadiness(instance, {
    platform,
    base: { ...fakes.env, ...more },
    baseKind: "user",
    home,
  });
const logIn = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FAKE_SIGNED_IN), "");
};
const statusRuns = () =>
  fakes.calls().filter((c) => c.args[0] === "auth" && c.args[1] === "status").length;

describe("[A4.3.2.readiness] what an instance's app reports: its program, its version, and whether its own status command found a login", () => {
  test("no confirmed login, then a login found, in the instance's own home; the login line changes that home for its one command", async () => {
    const work = join(home, ".claude-work");
    const before = await ready(claude({ CLAUDE_CONFIG_DIR: work }));
    expect(before?.state).toBe("no_login");
    expect(before).toMatchObject({ version: "2.1.332" });
    expect(before?.state === "no_login" ? before.login : "").toBe(
      oneCall(platform, ["claude", "auth", "login"], "CLAUDE_CONFIG_DIR", work),
    );
    logIn(join(home, ".claude"));
    expect((await ready(claude({ CLAUDE_CONFIG_DIR: work })))?.state).toBe("no_login");
    expect(await ready(claude())).toEqual({ state: "login_found", version: "2.1.332" });
    logIn(work);
    expect((await ready(claude({ CLAUDE_CONFIG_DIR: work })))?.state).toBe("login_found");
  });

  test("the default home's login line unsets an override the terminal has, for its one command", async () => {
    const codex: Checked = { ...claude(), target: "codex-cli", exec: "codex" };
    const found = await ready(codex);
    expect(found).toEqual({
      state: "no_login",
      version: "0.167.2",
      login: oneCall(platform, ["codex", "login"], "CODEX_HOME", null),
    });
    expect(found?.state === "no_login" ? found.login : "").toBe(
      windows
        ? "& { $was = $env:CODEX_HOME; $env:CODEX_HOME = $null; try { codex login } finally { $env:CODEX_HOME = $was } }"
        : "env -u CODEX_HOME codex login",
    );
  });

  test("a line sets or unsets the home for one command only, quotes a path with spaces, and is none when a path cannot be quoted", () => {
    const spaced = windows ? "C:\\Users\\a b\\.claude-work" : "/home/a b/.claude-work";
    expect(oneCall(platform, ["claude", "auth", "login"], "CLAUDE_CONFIG_DIR", spaced)).toBe(
      windows
        ? `& { $was = $env:CLAUDE_CONFIG_DIR; $env:CLAUDE_CONFIG_DIR = '${spaced}'; try { claude auth login } finally { $env:CLAUDE_CONFIG_DIR = $was } }`
        : `CLAUDE_CONFIG_DIR='${spaced}' claude auth login`,
    );
    expect(oneCall(platform, ["claude", "auth", "login"], "CLAUDE_CONFIG_DIR", "a\u0007b")).toBe(
      undefined,
    );
  });

  test("a Claude Code older than its status command is not asked, and reads unknown with nothing to run", async () => {
    const before = statusRuns();
    expect(await ready(claude(), { FAKE_AGENT_CLAUDE_VERSION: "2.1.40" })).toEqual({
      state: "unknown",
      version: "2.1.40",
      status: undefined,
    });
    expect(statusRuns()).toBe(before);
  });

  test("a status command that answers neither way, or never ends, is unknown with the command to find out", async () => {
    const odd = await ready(claude(), { FAKE_AGENT_FAIL: "claude:status" });
    expect(odd).toEqual({
      state: "unknown",
      version: "2.1.332",
      status: oneCall(platform, ["claude", "auth", "status"], "CLAUDE_CONFIG_DIR", null),
    });
    const hung = await instanceReadiness(claude(), {
      platform,
      base: { ...fakes.env, FAKE_AGENT_FAIL: "claude:hang" },
      baseKind: "user",
      home,
      timeoutMs: 1_000,
    });
    expect(hung?.state).toBe("unknown");
  });

  test("the check runs in the environment a launch builds: a home of its own gets no account variable of the person's", async () => {
    const last = () =>
      fakes
        .calls()
        .filter((c) => c.args[0] === "auth")
        .at(-1)?.env;
    const work = join(home, ".claude-gate");
    await ready(claude({ CLAUDE_CONFIG_DIR: work }), { ANTHROPIC_API_KEY: "placeholder" });
    expect(last()).toMatchObject({ CLAUDE_CONFIG_DIR: work, ANTHROPIC_API_KEY: null });
    await ready(claude(), { ANTHROPIC_API_KEY: "placeholder" });
    expect(last()).toMatchObject({ ANTHROPIC_API_KEY: "placeholder" });
  });

  test("a program that is not there is not installed, with the vendor's install page", async () => {
    const gone = await ready({ ...claude(), exec: join(root, "nowhere", "claude") });
    expect(gone).toEqual({
      state: "not_installed",
      install: "https://code.claude.com/docs/en/setup",
    });
  });

  test("an app without a login to ask about has no readiness", async () => {
    expect(await ready({ ...claude(), target: "t3" })).toBeUndefined();
  });
});
