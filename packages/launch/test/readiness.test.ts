// An instance's readiness with the testkit's stand-in `claude` and `codex` on a scratch PATH and in
// a scratch home: their status commands say signed in while a marker file is in the app's home.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FAKE_SIGNED_IN, installFakeAgents, type FakeAgents } from "@ttasks/testkit/fake-agents";
import { instanceReadiness } from "../src/readiness.ts";
import type { Instance } from "../src/sections.ts";

let root: string;
let home: string;
let fakes: FakeAgents;
const platform = process.platform;

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
const ready = (instance: Checked, fail = "") =>
  instanceReadiness(instance, {
    platform,
    base: { ...fakes.env, FAKE_AGENT_FAIL: fail },
    home,
  });
const signIn = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FAKE_SIGNED_IN), "");
};

describe("[A4.3.2.readiness] an instance's program, version and sign-in, from the app's own status command", () => {
  test("not signed in, then signed in, in the instance's own home; the login line names that home", async () => {
    const work = join(home, ".claude-work");
    const before = await ready(claude({ CLAUDE_CONFIG_DIR: work }));
    expect(before?.state).toBe("signed_out");
    expect(before).toMatchObject({ version: "2.1.9" });
    const login = before?.state === "signed_out" ? before.login : "";
    expect(login).toContain("CLAUDE_CONFIG_DIR");
    expect(login).toContain(work);
    expect(login).toMatch(/claude auth login$/u);
    // Signed in to the default home only: the work home is still not.
    signIn(join(home, ".claude"));
    expect((await ready(claude({ CLAUDE_CONFIG_DIR: work })))?.state).toBe("signed_out");
    expect(await ready(claude())).toEqual({ state: "signed_in", version: "2.1.9" });
    signIn(work);
    expect((await ready(claude({ CLAUDE_CONFIG_DIR: work })))?.state).toBe("signed_in");
  });

  test("Codex in its default home: the vendor's own login line", async () => {
    const codex: Checked = { ...claude(), target: "codex-cli", exec: "codex" };
    expect(await ready(codex)).toEqual({
      state: "signed_out",
      version: "0.167.2",
      login: "codex login",
    });
  });

  test("a status command that answers neither way, or never ends, is unknown with the command to find out", async () => {
    const odd = await ready(claude(), "claude:status");
    expect(odd).toEqual({ state: "unknown", version: "2.1.9", status: "claude auth status" });
    const started = Date.now();
    const hung = await instanceReadiness(claude(), {
      platform,
      base: { ...fakes.env, FAKE_AGENT_FAIL: "claude:hang" },
      home,
      timeoutMs: 1_000,
    });
    expect(hung?.state).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  test("a program that is not there is not installed, with the vendor's install page", async () => {
    const gone = await ready({ ...claude(), exec: join(root, "nowhere", "claude") });
    expect(gone).toEqual({ state: "not_installed", install: "https://code.claude.com/docs/en/setup" });
  });

  test("an app without a sign-in to ask about has no readiness", async () => {
    expect(await ready({ ...claude(), target: "t3" })).toBeUndefined();
  });
});
