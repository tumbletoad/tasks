// `tasks doctor`'s agent checks and `tasks setup agents` for the remaining apps, through the CLI
// and a real service (A3 3.13, 3.14; A7 3.11 M4.05): doctor checks pass against fakes, each fault
// gives a row with the command that fixes it, `--live` asks fake apps for a headless call and the
// service must see it, and apply then remove leaves every file as it was.
//
// A real service in this process, the CLI in this process, fake `claude` and `codex` commands
// (testkit) on a scratch PATH, scratch homes and app folders in a temporary folder, named to setup
// through the environment it reads. The entries run a scratch install's command, which stands for
// the CLI from source (the bridge) wherever doctor or a fake app runs it. No real agent home, app
// folder or agent command is read or run.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MCP_SERVER_KEY } from "@tasks/brand";
import { startService, type RunningService } from "@tasks/service/hub";
import { removeRuntimeDir, serviceEnv, stateOf, tempRoot } from "@tasks/service/test/harness";
import { classSession } from "@tasks/service/test/ops-helpers";
import { installFakeAgents, type FakeAgents } from "@tasks/testkit/fake-agents";
import type { AgentsSetupOptions } from "../src/setup-agents.ts";
import { BIN, runMain } from "./cli-harness.ts";

const SLOW = 300_000;
const windows = process.platform === "win32";

let service: RunningService;
let home: string;
let user: string;
let root: string;
let fakes: FakeAgents;
let space: string;
let tasks: string;
let desktopFolder: string;
let desktopEnv: Record<string, string>;
let engine: string | undefined;
let cleanup: () => void;
let started: number | "not_running" | undefined;

interface Report {
  ok: boolean;
  checks: { id: string; status: string; detail: string }[];
}

beforeAll(async () => {
  const temp = tempRoot("da");
  cleanup = temp.cleanup;
  root = temp.root;
  home = join(root, "h");
  user = join(root, "u");
  mkdirSync(user);
  fakes = installFakeAgents(join(root, "t"), user);
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
    // `doctor --live` would take the person's login-shell snapshot: a fixed environment instead.
    launch: { baseEnv: () => ({}) },
  });
  const session = await classSession(home, service.endpoint.path, "cli-interactive");
  try {
    await session.call(
      "space/create",
      { name: "Mira", path: join(root, "s", "mira"), ref_prefix: "M" },
      { timeoutMs: 120_000 },
    );
    const listed = (await session.call("space/list", {}, { timeoutMs: 30_000 })) as {
      spaces: { id: string }[];
    };
    space = listed.spaces[0]?.id ?? "";
  } finally {
    session.close();
  }
  // The install's stable command, which every entry runs: here it stands for the CLI from source.
  tasks = join(home, "bin", windows ? "tasks.exe" : "tasks");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(tasks, "");
  // Claude Code's default home with another server, a Codex home, Claude Desktop's file.
  mkdirSync(join(user, ".claude"));
  writeFileSync(
    join(user, ".claude.json"),
    JSON.stringify({ mcpServers: { other: { command: "/opt/other", args: [] } } }, null, 2),
  );
  mkdirSync(join(user, ".codex"));
  writeFileSync(join(user, ".codex", "config.toml"), 'model = "m"\n');
  if (windows) {
    const local = join(root, "local");
    desktopEnv = { LOCALAPPDATA: local, APPDATA: join(root, "roaming") };
    desktopFolder = join(local, "Claude-Data", "claude_pkg7");
    // The Codex app's bundled engine: it reads the default Codex home too.
    engine = join(local, "OpenAI", "Codex", "bin", "4f2a9c", "codex.exe");
    mkdirSync(join(engine, ".."), { recursive: true });
    writeFileSync(engine, "");
  } else if (process.platform === "darwin") {
    desktopEnv = {};
    desktopFolder = join(user, "Library", "Application Support", "Claude");
  } else {
    desktopEnv = { XDG_CONFIG_HOME: join(root, "xdg") };
    desktopFolder = join(root, "xdg", "Claude");
  }
  mkdirSync(desktopFolder, { recursive: true });
  writeFileSync(
    join(desktopFolder, "claude_desktop_config.json"),
    '{\n  "mcpServers": {},\n  "preferences": {}\n}\n',
  );
  // T3 Code with one provider instance on the default Codex home.
  mkdirSync(join(user, ".t3", "userdata"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(user, ".t3", "userdata", "settings.json"),
    JSON.stringify({ providerInstances: { codex: { provider: "codex" } } }),
    { mode: 0o600 },
  );
}, SLOW);

afterAll(async () => {
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
}, SLOW);

const fakeCodex = () =>
  join(root, "t", "bin", "node_modules", "@openai", "codex", "bin", "codex.js");

/**
 * Every program a test lets setup or doctor run: Node (the fakes run with it) or a file in the
 * scratch folder. Anything else would be a real program of this machine: the test fails instead.
 */
function scratchOnly(argv: readonly string[]): readonly string[] {
  const file = argv[0] ?? "";
  const ok =
    file === process.execPath ||
    dirname(file) === dirname(process.execPath) ||
    file.startsWith(`${root}${sep}`);
  if (!ok) throw new Error(`a test would run a program outside its scratch folder: ${file}`);
  return argv;
}

/** What setup and doctor take: the scratch home, the fakes, the stand-ins for real programs. */
function agents(env: Record<string, string> = {}, engineArgv?: string[]): AgentsSetupOptions {
  return {
    env: {
      ...fakes.env,
      ...desktopEnv,
      TASKS_HOME: home,
      FAKE_AGENT_TASKS: JSON.stringify({ path: tasks, argv: [process.execPath, BIN] }),
      ...env,
    },
    home: user,
    // macOS: never the machine's own Applications folder.
    systemApplications: join(root, "Applications"),
    resolve: (argv) =>
      scratchOnly(
        argv[0] === tasks
          ? [process.execPath, BIN, ...argv.slice(1)]
          : engine !== undefined && argv[0] === engine
            ? [...(engineArgv ?? [process.execPath, fakeCodex()]), ...argv.slice(1)]
            : argv,
      ),
    desktopStarted: () => Promise.resolve(started),
  };
}

const run = (argv: string[], options: AgentsSetupOptions = agents(), tty = true) =>
  runMain(argv, { home, tty, main: { agents: options } });

async function doctor(
  options: AgentsSetupOptions = agents(),
  extra: string[] = [],
): Promise<Report> {
  const ran = await run(["doctor", "--json", ...extra], options, false);
  return JSON.parse(ran.stdout) as Report;
}

const row = (report: Report, id: string) => report.checks.find((c) => c.id === id);
const agentRows = (report: Report) =>
  report.checks
    .filter((c) =>
      /^(claude\.env|agents|mcp\.|codex\.engines\.|bridge\.|desktop\.|grants|t3\.|live)/u.test(
        c.id,
      ),
    )
    .map((c) => [c.id, c.status]);

const files = () => [
  join(user, ".claude.json"),
  join(user, ".codex", "config.toml"),
  join(desktopFolder, "claude_desktop_config.json"),
  join(user, ".t3", "userdata", "settings.json"),
];
const read = () => files().map((f) => readFileSync(f, "utf8"));

/** The preview's apply, run as the person at a terminal. */
async function applyAll(argv: string[] = [], options = agents()): Promise<string> {
  const preview = await run(["setup", "agents", "--json", ...argv], options, false);
  expect(preview.code, preview.stderr).toBe(0);
  const planned = JSON.parse(preview.stdout) as { apply: string[] };
  const applied = await run([...planned.apply.slice(1), "--json"], options);
  expect(applied.code, applied.stdout + applied.stderr).toBe(0);
  return applied.stdout;
}

describe("[A3.3.14.doctor.agents] tasks doctor's agent checks against fakes", () => {
  test(
    "before setup: one row says to run setup, and no agent home is read",
    async () => {
      const report = await doctor();
      expect(agentRows(report)).toEqual([
        ["claude.env", "ok"],
        ["agents", "warn"],
        ["live", "skip"],
      ]);
      expect(row(report, "agents")?.detail).toContain("setup agents");
      // Not even detection ran: no fake was asked for its version.
      expect(fakes.calls()).toEqual([]);
    },
    SLOW,
  );

  test(
    "after setup every agent row passes, and each fault fails or warns with its fix",
    async () => {
      const before = read();
      const text = await run(["setup", "agents"], agents(), false);
      expect(text.stdout).toContain("writes one entry into this file");
      expect(text.stdout).toMatch(/\(instance codex; also read by (the Codex app and )?T3 Code\)/u);
      await applyAll();
      started = Date.now() + 60_000;

      const report = await doctor();
      const expected = [
        ["claude.env", "ok"],
        ["mcp.claude", "ok"],
        ["bridge.claude", "ok"],
        ["mcp.codex", "ok"],
        ["codex.engines.codex", "ok"],
        ["bridge.codex", "ok"],
        ["mcp.claude-desktop", "ok"],
        ["bridge.claude-desktop", "ok"],
        ["desktop.restart", "ok"],
        ["grants", "ok"],
        ["t3.homes", "ok"],
        ["live", "skip"],
      ];
      expect(agentRows(report).sort()).toEqual(expected.sort());
      expect(row(report, "bridge.codex")?.detail).toMatch(/status round trip took \d+ ms/u);
      if (engine !== undefined) {
        expect(row(report, "codex.engines.codex")?.detail).toContain("all 2 Codex engines");
      }
      // No home's path and no entry's content in a row.
      expect(JSON.stringify(agentRows(report))).not.toContain(user);

      // An engine that rejects the file: the app's own get and the engines row fail.
      const rejecting = await doctor(agents({ FAKE_AGENT_FAIL: "codex:get" }));
      expect(row(rejecting, "mcp.codex")?.status).toBe("fail");
      expect(row(rejecting, "codex.engines.codex")).toMatchObject({ status: "fail" });
      expect(row(rejecting, "codex.engines.codex")?.detail).toContain("setup agents --remove");
      if (engine !== undefined) {
        // Only the Codex app's engine rejects it.
        const app = await doctor(agents({}, [process.execPath, "-e", "process.exit(1)"]));
        expect(row(app, "mcp.codex")?.status).toBe("ok");
        expect(row(app, "codex.engines.codex")?.detail).toContain("the Codex app's engine");
      }

      // Claude Desktop started before the change, or doctor cannot tell.
      started = Date.now() - 3_600_000;
      expect(row(await doctor(), "desktop.restart")).toMatchObject({ status: "warn" });
      started = undefined;
      expect(row(await doctor(), "desktop.restart")?.detail).toContain("quit and reopen it");
      started = "not_running";
      expect(row(await doctor(), "desktop.restart")?.status).toBe("ok");

      // The allow-list variable where Claude Code starts.
      expect(
        row(await doctor(agents({ CLAUDE_CODE_MCP_ALLOWLIST_ENV: "1" })), "claude.env")?.status,
      ).toBe("warn");

      // An entry changed by hand: a warning, and setup leaves it.
      const desktopFile = join(desktopFolder, "claude_desktop_config.json");
      const applied = readFileSync(desktopFile, "utf8");
      writeFileSync(desktopFile, applied.replace('"--app"', '"--app-x"'));
      expect(row(await doctor(), "mcp.claude-desktop")?.status).toBe("warn");
      writeFileSync(desktopFile, applied);

      // The install's command gone: the entries run nothing.
      renameSync(tasks, `${tasks}.moved`);
      const missing = await doctor();
      expect(row(missing, "mcp.claude")).toMatchObject({ status: "fail" });
      expect(row(missing, "mcp.claude")?.detail).toContain("not there any more");
      renameSync(`${tasks}.moved`, tasks);

      // A row revoked behind setup's back: grants and the home's row fail; apply renews it.
      const person = await classSession(home, service.endpoint.path, "cli-interactive");
      try {
        const rows = (await person.call("setup/homes", {}, { timeoutMs: 30_000 })) as {
          homes: { grant: string; instance: string }[];
        };
        const codexRow = rows.homes.find((r) => r.instance === "codex");
        await person.call(
          "setup/home_revoke",
          { grants: [codexRow?.grant ?? ""] },
          { timeoutMs: 30_000 },
        );
      } finally {
        person.close();
      }
      const revoked = await doctor();
      expect(row(revoked, "grants")?.status).toBe("fail");
      expect(row(revoked, "mcp.codex")?.detail).toContain("no grant row");
      await applyAll();
      expect(row(await doctor(), "grants")?.status).toBe("ok");

      // T3 starts using another Codex home: it lacks the entry until setup adds it there.
      mkdirSync(join(user, ".codex-t3x"));
      const settings = join(user, ".t3", "userdata", "settings.json");
      const t3Before = readFileSync(settings, "utf8");
      writeFileSync(
        settings,
        JSON.stringify({
          providerInstances: {
            codex: { provider: "codex" },
            "codex-t3x": { provider: "codex", homePath: join(user, ".codex-t3x") },
          },
        }),
      );
      const gap = await doctor();
      expect(row(gap, "t3.homes")).toMatchObject({ status: "warn" });
      expect(row(gap, "t3.homes")?.detail).toContain("setup agents --app t3");
      await applyAll(["--app", "t3"]);
      expect(row(await doctor(), "t3.homes")?.status).toBe("ok");
      const t3Rows = await run(["setup", "agents", "--status", "--json"], agents(), false);
      expect(
        (JSON.parse(t3Rows.stdout) as { homes: { instance: string; hosts: string[] }[] }).homes
          .filter((h) => h.hosts.includes("t3"))
          .map((h) => h.instance)
          .sort(),
      ).toEqual(["codex", "codex-t3x"]);

      // T3 names Claude Code's default folder by its path: its Claude reads `.claude.json` inside
      // that folder, not the user's file where the default home's entry is. Doctor says so.
      writeFileSync(
        settings,
        JSON.stringify({
          providerInstances: {
            codex: { provider: "codex" },
            "codex-t3x": { provider: "codex", homePath: join(user, ".codex-t3x") },
            claude: { provider: "claudeAgent", homePath: join(user, ".claude") },
            // A key that is not a plain name (a path, a control character) never reaches a row.
            [`${join(user, "odd")}\u001b[31m`]: { provider: "codex", homePath: join(user, "x") },
          },
        }),
      );
      const explicit = row(await doctor(), "t3.homes");
      expect(explicit).toMatchObject({ status: "warn" });
      expect(explicit?.detail).toContain("clear the instance's home path");
      expect(explicit?.detail).toContain("(a key that is not a plain name) (Codex)");
      expect(explicit?.detail).not.toContain(user);
      expect(explicit?.detail).not.toContain("\u001b");

      // Remove: every entry and row back, every file as it was (T3's file only by this test).
      const removed = await run(["setup", "agents", "--remove", "--json"]);
      expect(removed.code, removed.stdout).toBe(0);
      writeFileSync(settings, t3Before);
      expect(read()).toEqual(before);
      // The file the command made there, emptied by its remove, is gone again.
      expect(existsSync(join(user, ".codex-t3x", "config.toml"))).toBe(false);
    },
    SLOW,
  );

  test(
    "print and approve-tools write nothing; block is not in this build",
    async () => {
      const before = read();
      const printed = await run(
        ["setup", "agents", "print", "--app", "cursor", "--json"],
        agents(),
        false,
      );
      expect(printed.code, printed.stderr).toBe(0);
      const snippet = JSON.parse(printed.stdout) as { files: string[]; text: string };
      expect(snippet.files).toEqual([join(user, ".cursor", "mcp.json")]);
      // A hand-made entry (A3 3.7.4): no row is kept for it, so it names no instance, and it uses
      // the machine's default space, the one the grant gate lets such an entry use (A3 3.7.8).
      expect(JSON.parse(snippet.text)).toEqual({
        mcpServers: { [MCP_SERVER_KEY]: { command: tasks, args: ["mcp", "--app", "cursor"] } },
      });
      expect(existsSync(join(user, ".cursor"))).toBe(false);
      const named = await run(
        ["setup", "agents", "print", "--app", "cursor", "--space", space],
        agents(),
        false,
      );
      expect(named.code).toBe(2);
      const desktop = await run(
        ["setup", "agents", "print", "--app", "claude-desktop"],
        agents(),
        false,
      );
      expect(desktop.stdout).toContain(join(desktopFolder, "claude_desktop_config.json"));

      const approve = await run(["setup", "agents", "--parts", "approve-tools"], agents(), false);
      expect(approve.code).toBe(0);
      expect(approve.stdout).toContain("never changes another app's approval settings");
      expect(approve.stdout).toContain(`mcp__${MCP_SERVER_KEY}__*`);
      expect(approve.stdout).toContain('default_tools_approval_mode = "approve"');
      expect(read()).toEqual(before);
      expect(existsSync(join(user, ".claude", "settings.json"))).toBe(false);

      expect((await run(["setup", "agents", "--parts", "block"])).code).toBe(2);
      expect((await run(["setup", "agents", "print-block", "--for", "claude"])).code).toBe(2);
      expect((await run(["setup", "agents", "print", "--app", "notepad"])).code).toBe(2);
      expect((await run(["doctor", "--bogus"])).code).toBe(2);

      // A remove of only approve-tools (which setup never writes) takes no MCP entry out.
      await applyAll(["--app", "claude-desktop"]);
      const registered = read();
      const approvalsOnly = await run([
        "setup",
        "agents",
        "--remove",
        "--parts",
        "approve-tools",
        "--app",
        "claude-desktop",
      ]);
      expect(approvalsOnly.code).toBe(2);
      expect(approvalsOnly.stdout + approvalsOnly.stderr).toContain("nothing of it to remove");
      expect(read()).toEqual(registered);
      expect((await run(["setup", "agents", "--status", "--parts", "mcp"])).code).toBe(2);
      const removed = await run(["setup", "agents", "--remove", "--parts", "mcp", "--json"]);
      expect(removed.code, removed.stdout).toBe(0);
      expect(read()).toEqual(before);
    },
    SLOW,
  );

  test(
    "an entry's command that starts and never answers: its row fails by the deadline and no process is left",
    async () => {
      await applyAll(["--app", "claude-desktop"]);
      // The entry's command stands for a bridge that reads nothing and never ends by itself.
      const pidFile = join(root, "hung.pid");
      const hung = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const options = agents();
      const report = await doctor({
        ...options,
        resolve: (argv) =>
          argv[0] === tasks
            ? [process.execPath, "-e", hung, ...argv.slice(1)]
            : (options.resolve?.(argv) ?? argv),
      });
      const pid = Number(readFileSync(pidFile, "utf8"));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        expect(row(report, "bridge.claude-desktop")).toMatchObject({ status: "fail" });
        expect(row(report, "bridge.claude-desktop")?.detail).toContain("did not answer in time");
        // The probe's process ends with its deadline: doctor leaves nothing running.
        const until = Date.now() + 10_000;
        while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
        expect(alive()).toBe(false);
      } finally {
        if (alive()) process.kill(pid, "SIGKILL");
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
      }
    },
    SLOW,
  );

  test(
    "an entry's command that prints what is not a JSON object, or a line without end: the row fails and doctor goes on",
    async () => {
      await applyAll(["--app", "claude-desktop"]);
      const options = agents();
      const standIn = (script: string) => ({
        ...options,
        resolve: (argv: readonly string[]) =>
          argv[0] === tasks
            ? [process.execPath, "-e", script, ...argv.slice(1)]
            : (options.resolve?.(argv) ?? argv),
      });
      try {
        // Lines that parse but are no message: null, an array, a number, a string.
        const odd = await doctor(
          standIn(
            `process.stdout.write('null\\n[]\\n5\\n"x"\\n'); setTimeout(() => process.exit(0), 300);`,
          ),
        );
        expect(row(odd, "bridge.claude-desktop")).toMatchObject({ status: "fail" });
        expect(row(odd, "bridge.claude-desktop")?.detail).toContain("did not answer initialize");

        // Output without a line end, past the bound: the probe ends long before its deadline.
        const t0 = Date.now();
        const flood = await doctor(
          standIn(
            `process.stdout.write("x".repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000);`,
          ),
        );
        expect(row(flood, "bridge.claude-desktop")).toMatchObject({ status: "fail" });
        expect(Date.now() - t0).toBeLessThan(15_000);
      } finally {
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
      }
    },
    SLOW,
  );
});

describe("[A3.3.14.doctor.manual] tasks doctor on an entry setup did not write", () => {
  test(
    "an entry without --instance is named for what it reaches, one with an instance for its refusal, each with how to take it out",
    async () => {
      await applyAll(["--app", "claude-desktop"]);
      const claudeFile = join(user, ".claude.json");
      const before = readFileSync(claudeFile, "utf8");
      const withEntry = (args: string[]) => {
        const doc = JSON.parse(before) as { mcpServers: Record<string, unknown> };
        doc.mcpServers[MCP_SERVER_KEY] = { command: tasks, args };
        writeFileSync(claudeFile, JSON.stringify(doc, null, 2));
      };
      try {
        expect(row(await doctor(), "manual")?.status).toBe("ok");

        // As `print` gives one: a hand-made entry, not a mistake.
        withEntry(["mcp", "--app", "claude-code"]);
        const handMade = row(await doctor(), "manual");
        expect(handMade?.status).toBe("warn");
        expect(handMade?.detail).toContain("without --instance");
        expect(handMade?.detail).toContain("reach only the machine's default space");
        expect(handMade?.detail).toContain(`claude mcp remove ${MCP_SERVER_KEY} --scope user`);
        expect(handMade?.detail).not.toContain(user);

        // One with an instance setup did not register: the grant gate refuses it.
        withEntry(["mcp", "--instance", "claude-x", "--app", "claude-code"]);
        const named = row(await doctor(), "manual");
        expect(named?.status).toBe("warn");
        expect(named?.detail).toContain("as instance claude-x");
        expect(named?.detail).toContain("refuses its calls");
        expect(named?.detail).not.toContain(user);
      } finally {
        writeFileSync(claudeFile, before);
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
      }
    },
    SLOW,
  );
});

describe("[A3.3.14.doctor.live] tasks doctor --live against fake apps", () => {
  test(
    "a headless call through each app reaches the service from that home; without --live nothing runs",
    async () => {
      await applyAll(["--app", "claude-code,codex"]);
      const headless = () =>
        fakes.calls().filter((c) => c.args[0] === "-p" || c.args[0] === "exec").length;
      const quiet = await doctor();
      expect(row(quiet, "live")?.status).toBe("skip");
      expect(headless()).toBe(0);

      const live = await doctor(agents(), ["--live"]);
      expect(row(live, "live.claude"), JSON.stringify(live.checks)).toMatchObject({ status: "ok" });
      expect(row(live, "live.codex")).toMatchObject({ status: "ok" });
      // One headless run per registered Claude Code and Codex home, each seen by the service.
      const liveRows = live.checks.filter((c) => c.id.startsWith("live."));
      expect(liveRows.map((c) => c.status)).toEqual(liveRows.map(() => "ok"));
      expect(headless()).toBe(liveRows.length);
      // The prompt went on stdin: no argument of a headless run holds it.
      for (const call of fakes.calls().filter((c) => c.args[0] === "-p" || c.args[0] === "exec")) {
        expect(call.args.join(" ")).not.toContain('status" once');
      }

      // An app that cannot start the entry makes no call: the row fails.
      const broken = await doctor(
        agents({ FAKE_AGENT_TASKS: JSON.stringify({ path: "", argv: [] }) }),
        ["--live"],
      );
      expect(row(broken, "live.claude")?.status).toBe("fail");
      expect(row(broken, "live.claude")?.detail).toContain("setup agents --status");

      const removed = await run(["setup", "agents", "--remove", "--json"]);
      expect(removed.code, removed.stdout).toBe(0);
    },
    SLOW,
  );

  test(
    "a headless run that hangs with a process it started: both end at the deadline and the row fails",
    async () => {
      await applyAll(["--app", "claude-code"]);
      const pidFile = join(root, "live-descendant.pid");
      // Starts a descendant and hangs with it. On Windows the descendant leaves Node's kill-on-close
      // job (`detached`), as one an app's native launcher starts would never be in it.
      const hang = [
        "const { spawn } = require('node:child_process');",
        "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
        "setTimeout(() => {}, 60000);",
      ].join("\n");
      const options = agents();
      const report = await doctor(
        {
          ...options,
          liveMs: 4_000,
          resolve: (argv) =>
            argv.includes("-p")
              ? [process.execPath, "-e", hang]
              : (options.resolve?.(argv) ?? argv),
        },
        ["--live"],
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        expect(row(report, "live.claude")).toMatchObject({ status: "fail" });
        expect(row(report, "live.claude")?.detail).toContain("did not finish its headless run");
        const until = Date.now() + 10_000;
        while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
        expect(alive()).toBe(false);
      } finally {
        if (alive()) process.kill(pid, "SIGKILL");
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
      }
    },
    SLOW,
  );

  test(
    "an app that ends and leaves a process in the run's folder: the report still comes, and a later run sweeps old folders",
    async () => {
      await applyAll(["--app", "claude-code"]);
      const tmp = join(stateOf(home), "tmp");
      // A folder an earlier run could not remove, from long ago.
      const old = join(tmp, "doctor-live-0123456789ab");
      mkdirSync(old, { recursive: true });
      const long = new Date(Date.now() - 3_600_000);
      utimesSync(old, long, long);
      const pidFile = join(root, "left-behind.pid");
      // Ends at once and leaves a process working in the run's folder (on Windows it holds it, so
      // the folder cannot be removed); `detached` takes it out of Node's kill-on-close job.
      const leave = [
        "const { spawn } = require('node:child_process');",
        "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: process.cwd(), stdio: 'ignore', windowsHide: true, detached: true });",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
        "c.unref();",
      ].join("\n");
      const options = agents();
      const report = await doctor(
        {
          ...options,
          liveMs: 20_000,
          resolve: (argv) =>
            argv.includes("-p")
              ? [process.execPath, "-e", leave]
              : (options.resolve?.(argv) ?? argv),
        },
        ["--live"],
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      try {
        expect(row(report, "live.claude")).toMatchObject({ status: "fail" });
        expect(row(report, "live.claude")?.detail).toContain("saw no call from this home");
        expect(existsSync(old)).toBe(false);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone already.
        }
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
      }
    },
    SLOW,
  );
});
