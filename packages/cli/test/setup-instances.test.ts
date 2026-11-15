// `tasks setup instances` through the CLI and a real service (A4 3.2 "Detection proposes, the
// user confirms"; A2 3.2.4): the preview shows what detection found and the exact entries and
// writes nothing, only the person applies, the service writes machine.toml through its editor and
// Open offers the instances at once, doctor says what is still missing, and remove takes back only
// an entry that is still exactly as written.
//
// A real service in this process with a test's terminal (it records each start and starts
// nothing), the CLI in this process, fake `claude` and `codex` commands (testkit) on a scratch
// PATH, and scratch agent homes in the test's temporary folder. No real agent home is read.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { configOf, stateOf } from "@tasks/service/test/harness";
import { httpWorld, openFeed, signIn, type HttpWorld } from "@tasks/service/test/http-world";
import { installFakeAgents, type FakeAgents } from "@tasks/testkit/fake-agents";
import type { AgentsSetupOptions } from "../src/setup-agents.ts";
import { runMain } from "./cli-harness.ts";

const SLOW = 300_000;
const windows = process.platform === "win32";

let w: HttpWorld;
let user: string;
let fakes: FakeAgents;
let options: AgentsSetupOptions;

beforeAll(async () => {
  w = await httpWorld(
    "si",
    {},
    { launch: { terminal: () => Promise.resolve({ kind: "accepted" as const }) } },
  );
  user = join(w.root, "u");
  mkdirSync(user);
  fakes = installFakeAgents(join(w.root, "t"), user);
  // Claude Code's default home and a Codex home, as the apps leave them.
  mkdirSync(join(user, ".claude"));
  writeFileSync(join(user, ".claude.json"), "{}\n");
  mkdirSync(join(user, ".codex"));
  writeFileSync(join(user, ".codex", "config.toml"), 'model = "m"\n');
  // The install's stable command, which setup agents' entries run.
  mkdirSync(join(w.home, "bin"), { recursive: true });
  writeFileSync(join(w.home, "bin", windows ? "tasks.exe" : "tasks"), "");
  // Every folder an app's configuration may be looked for in is the test's own.
  const scratch = windows
    ? { LOCALAPPDATA: join(w.root, "local"), APPDATA: join(w.root, "roaming") }
    : { XDG_CONFIG_HOME: join(w.root, "xdg") };
  options = {
    env: { ...fakes.env, ...scratch },
    home: user,
    systemApplications: join(w.root, "Applications"),
  };
}, SLOW);

afterAll(async () => {
  await w.close();
}, SLOW);

const machineToml = () => join(configOf(w.home), "machine.toml");

/** `tasks <argv>` as a person at a terminal (tty), a script, or an agent's shell. */
const run = (argv: string[], tty = true, env: Record<string, string> = {}) =>
  runMain(argv, { home: w.home, tty, env, main: { agents: options } });

interface Preview {
  commands: { target: string; version?: string; usable: boolean }[];
  homes: { target: string; home: string }[];
  configured: { id: string }[];
  add: { id: string; entry: Record<string, unknown>; model_from?: string }[];
  plan?: string;
  apply?: string[];
}

const preview = async (): Promise<Preview> => {
  const ran = await run(["setup", "instances", "--json"], false);
  expect(ran.code, ran.stderr).toBe(0);
  return JSON.parse(ran.stdout) as Preview;
};

/** The instances Open draws a tile for, as a page's snapshot names them. */
async function tiles(): Promise<string[]> {
  const { token } = await signIn(w);
  const feed = await openFeed(w.port(), token);
  try {
    await feed.next((m) => m["type"] === "hello");
    feed.send({ type: "subscribe", space: "Mira" });
    const snapshot = await feed.next((m) => m["type"] === "snapshot");
    return (snapshot["instances"] as { key: string }[]).map((i) => i.key);
  } finally {
    feed.ws.close();
  }
}

const doctorRow = async (id: string) => {
  const ran = await run(["doctor", "--json"], false);
  const report = JSON.parse(ran.stdout) as {
    checks: { id: string; status: string; detail: string }[];
  };
  return report.checks.find((c) => c.id === id);
};

describe("[A4.3.2.setup.instances] tasks setup instances through the CLI and the service", () => {
  test(
    "preview shows what was found and writes nothing; only the user applies; Open offers the instances at once",
    async () => {
      expect(await doctorRow("instances")).toMatchObject({
        status: "warn",
        detail: expect.stringContaining("Run: tasks setup instances") as unknown,
      });
      const shown = await preview();
      // Detection ran only each command's --version, and read no agent home.
      expect(fakes.calls().every((c) => c.args.join(" ") === "--version")).toBe(true);
      expect(shown.commands.map((c) => [c.target, c.usable])).toEqual([
        ["claude-cli", true],
        ["codex-cli", true],
      ]);
      expect(shown.commands.every((c) => typeof c.version === "string")).toBe(true);
      expect(shown.homes.map((h) => h.home).sort()).toEqual(
        [join(user, ".claude"), join(user, ".codex")].sort(),
      );
      expect(shown.add.map((a) => a.id)).toEqual(["claude", "codex"]);
      expect(shown.add[1]?.entry).toMatchObject({
        id: "codex",
        target: "codex-cli",
        label: "Codex",
        account: "default",
        config_home: join(user, ".codex"),
        remote_allowed: false,
      });
      expect(shown.apply?.slice(0, 5)).toEqual([
        "tasks",
        "setup",
        "instances",
        "--apply",
        "--plan",
      ]);
      expect(existsSync(machineToml())).toBe(false);
      const text = await run(["setup", "instances"], false);
      expect(text.stdout).toContain("[[instance]]");
      expect(text.stdout).toContain("Nothing was changed.");

      // A script or an agent's shell may not apply; a plan that is not the preview's changes nothing.
      const apply = shown.apply ?? [];
      expect((await run(apply.slice(1), false)).code).toBe(5);
      expect((await run(apply.slice(1), true, { CLAUDECODE: "1" })).code).toBe(5);
      const stale = await run(["setup", "instances", "--apply", "--plan", "0".repeat(16)]);
      expect(stale.code).toBe(4);
      expect(existsSync(machineToml())).toBe(false);

      const applied = await run(apply.slice(1));
      expect(applied.code, applied.stderr).toBe(0);
      expect(applied.stdout).toContain("tasks setup agents");
      const written = readFileSync(machineToml(), "utf8");
      expect(written.match(/^\[\[instance\]\]$/gmu)).toHaveLength(2);
      expect(existsSync(join(stateOf(w.home), "instances.json"))).toBe(true);
      // The same apply again: the entries are there as it wrote them, so it says so and exits 0.
      const twice = await run(apply.slice(1));
      expect(twice.code, twice.stderr).toBe(0);
      expect(twice.stdout).toContain("already");
      expect(twice.stdout).toContain("Nothing was changed.");
      const twiceJson = await run([...apply.slice(1), "--json"]);
      expect(twiceJson.code, twiceJson.stderr).toBe(0);
      expect(JSON.parse(twiceJson.stdout)).toEqual({ added: [], already: ["claude", "codex"] });
      expect(readFileSync(machineToml(), "utf8")).toBe(written);
      // Open offers them now, without a restart.
      expect(await tiles()).toEqual(["claude", "codex"]);
      // A second preview has nothing to add: machine.toml names both.
      const again = await preview();
      expect(again.add).toEqual([]);
      expect(again.configured.map((c) => c.id)).toEqual(["claude", "codex"]);
    },
    SLOW,
  );

  test(
    "doctor names what is still missing until setup agents registers the homes",
    async () => {
      expect(await doctorRow("instances")).toMatchObject({
        status: "warn",
        detail: expect.stringContaining("Run: tasks setup agents") as unknown,
      });
      const planned = JSON.parse((await run(["setup", "agents", "--json"], false)).stdout) as {
        apply: string[];
        homes: { instance: string }[];
      };
      // The homes' entries name the instances setup instances wrote.
      expect(planned.homes.map((h) => h.instance).sort()).toEqual(["claude", "codex"]);
      const registered = await run(planned.apply.slice(1));
      expect(registered.code, registered.stdout + registered.stderr).toBe(0);
      expect(await doctorRow("instances")).toEqual({
        id: "instances",
        status: "ok",
        detail: "Open can start a task in claude, codex.",
      });
    },
    SLOW,
  );

  test(
    "remove takes back only what is still exactly as written, and the file comes back",
    async () => {
      expect((await run(["setup", "instances", "--remove"], false)).code).toBe(5);
      // The person changes the Codex entry: it is theirs now.
      const written = readFileSync(machineToml(), "utf8");
      writeFileSync(machineToml(), written.replace('label = "Codex"', 'label = "Codex · work"'));
      const removed = await run(["setup", "instances", "--remove", "--json"]);
      expect(removed.code).toBe(10);
      expect(JSON.parse(removed.stdout)).toEqual({
        outcomes: [
          { id: "claude", result: "removed" },
          { id: "codex", result: "edited" },
        ],
      });
      expect(await tiles()).toEqual(["codex"]);
      // Put back as written, it is setup's again.
      const left = readFileSync(machineToml(), "utf8");
      writeFileSync(machineToml(), left.replace('label = "Codex · work"', 'label = "Codex"'));
      const rest = await run(["setup", "instances", "--remove", "--instance", "codex"]);
      expect(rest.code, rest.stdout).toBe(0);
      expect(rest.stdout).toContain("codex: removed from machine.toml");
      expect(readFileSync(machineToml(), "utf8")).toBe("");
      expect(await tiles()).toEqual([]);
      expect((await run(["setup", "instances", "--remove"])).stdout).toContain("Nothing to remove");
    },
    SLOW,
  );

  test(
    "T3 Code: one complete instance per enabled provider instance in T3's settings, applied and removed like the others",
    async () => {
      // T3's folder and its settings in T3's own shape (A3 3.13.6), in the test's scratch home.
      const t3 = join(user, ".t3", "userdata");
      mkdirSync(t3, { recursive: true, mode: 0o700 });
      const settings = join(t3, "settings.json");
      writeFileSync(
        settings,
        JSON.stringify({
          providerInstances: {
            codex: { driver: "codex", displayName: "Codex Work", enabled: true },
            claude_personal: {
              driver: "claudeAgent",
              displayName: "Claude Personal",
              enabled: true,
              config: { homePath: "~/.claude_personal" },
            },
            claude_off: { driver: "claudeAgent", enabled: false },
            cursor: { driver: "cursor", enabled: true },
          },
          defaultModelSelection: { instanceId: "claude_personal", model: "claude-sonnet-5" },
        }),
        { mode: 0o600 },
      );
      const before = readFileSync(settings, "utf8");
      const shown = await preview();
      // The CLIs' homes again, then T3's enabled Codex and Claude provider instances: its default
      // Claude instance too, which the file does not list.
      expect(shown.add.map((a) => [a.id, a.model_from])).toEqual([
        ["claude", undefined],
        ["codex", undefined],
        ["t3-codex", "catalogue"],
        ["t3-claude-personal", "t3"],
        ["t3-claude", "catalogue"],
      ]);
      expect(shown.add.find((a) => a.id === "t3-claude-personal")?.entry).toEqual({
        id: "t3-claude-personal",
        target: "t3",
        label: "Claude Personal",
        account: "personal",
        t3_environment: "local",
        t3_provider_instance: "claude_personal",
        t3_model: "claude-sonnet-5",
        remote_allowed: false,
      });
      expect(shown.add.find((a) => a.id === "t3-codex")?.entry).toMatchObject({
        label: "Codex Work",
        account: "default",
        t3_provider_instance: "codex",
        t3_model: "gpt-6-astra",
      });
      const text = await run(["setup", "instances"], false);
      expect(text.stdout).toContain("change t3_model in machine.toml");

      // One of them, applied as the preview showed it.
      const one = await run(["setup", "instances", "--instance", "t3-claude-personal", "--json"], false);
      const planned = JSON.parse(one.stdout) as Preview;
      expect(planned.add.map((a) => a.id)).toEqual(["t3-claude-personal"]);
      const applied = await run((planned.apply ?? []).slice(1));
      expect(applied.code, applied.stdout + applied.stderr).toBe(0);
      const written = readFileSync(machineToml(), "utf8");
      expect(written).toContain('t3_provider_instance = "claude_personal"');
      expect(written).toContain('t3_model = "claude-sonnet-5"');
      // Its provider instance is configured now, so it is not proposed again.
      expect((await preview()).add.map((a) => a.id)).not.toContain("t3-claude-personal");

      const removed = await run(["setup", "instances", "--remove", "--instance", "t3-claude-personal"]);
      expect(removed.code, removed.stdout).toBe(0);
      expect(readFileSync(machineToml(), "utf8")).toBe("");
      // T3's settings were only read.
      expect(readFileSync(settings, "utf8")).toBe(before);

      // Every instance turned off in T3: nothing to propose for it, and the preview says why.
      writeFileSync(
        settings,
        JSON.stringify({
          providerInstances: {
            codex: { driver: "codex", enabled: false },
            claudeAgent: { driver: "claudeAgent", config: { enabled: false } },
          },
        }),
      );
      const off = await run(["setup", "instances", "--instance", "t3", "--json"], false);
      expect(JSON.parse(off.stdout)).toMatchObject({
        add: [],
        left: [{ id: "t3", reason: "needs_t3_provider" }],
      });
    },
    SLOW,
  );
});
