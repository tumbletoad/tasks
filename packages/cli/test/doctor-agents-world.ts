// The shared part of `ttasks doctor`'s agent tests (doctor-agents*.test.ts): each file's own real
// service in this process, fake `claude` and `codex` commands (testkit) on a scratch PATH, scratch
// homes and app folders in a temporary folder, and the helpers that run setup and doctor there.
// No real agent home, app folder or agent command is read or run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import { startService, type RunningService } from "@ttasks/service/hub";
import { removeRuntimeDir, serviceEnv, tempRoot } from "@ttasks/service/test/harness";
import { classSession } from "@ttasks/service/test/ops-helpers";
import { installFakeAgents, type FakeAgents } from "@ttasks/testkit/fake-agents";
import type { AgentsSetupOptions } from "../src/setup-agents.ts";
import { BIN, runMain } from "./cli-harness.ts";

export const SLOW = 300_000;
export const windows = process.platform === "win32";

export let service: RunningService;
export let home: string;
export let user: string;
export let root: string;
export let fakes: FakeAgents;
export let space: string;
export let tasks: string;
export let desktopFolder: string;
export let desktopEnv: Record<string, string>;
export let engine: string | undefined;
export let cleanup: () => void;
export let started: number | "not_running" | undefined;
/** When Claude Desktop started, as doctor reads it from here on. */
export const setStarted = (at: typeof started): void => {
  started = at;
};

export interface Report {
  ok: boolean;
  checks: { id: string; status: string; detail: string }[];
}

/** Starts this file's service and scratch homes, and removes them at the end. */
export function useDoctorWorld(): void {
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
    tasks = join(home, "bin", windows ? "ttasks.exe" : "ttasks");
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
    // T3 Code with its default Codex instance renamed, in T3's own shape (A3 3.13.6), and its default
    // Claude instance, which the file does not list: both on the default homes.
    mkdirSync(join(user, ".t3", "userdata"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(user, ".t3", "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: { codex: { driver: "codex", displayName: "Codex", enabled: true } },
      }),
      { mode: 0o600 },
    );
  }, SLOW);

  afterAll(async () => {
    await service.stop();
    removeRuntimeDir(service);
    cleanup();
  }, SLOW);
}

export const fakeCodex = () =>
  join(root, "t", "bin", "node_modules", "@openai", "codex", "bin", "codex.js");

/**
 * Every program a test lets setup or doctor run: Node (the fakes run with it) or a file in the
 * scratch folder. Anything else would be a real program of this machine: the test fails instead.
 */
export function scratchOnly(argv: readonly string[]): readonly string[] {
  const file = argv[0] ?? "";
  const ok =
    file === process.execPath ||
    dirname(file) === dirname(process.execPath) ||
    file.startsWith(`${root}${sep}`);
  if (!ok) throw new Error(`a test would run a program outside its scratch folder: ${file}`);
  return argv;
}

/** What setup and doctor take: the scratch home, the fakes, the stand-ins for real programs. */
export function agents(
  env: Record<string, string> = {},
  engineArgv?: string[],
): AgentsSetupOptions {
  return {
    env: {
      ...fakes.env,
      ...desktopEnv,
      TTASKS_HOME: home,
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

export const run = (argv: string[], options: AgentsSetupOptions = agents(), tty = true) =>
  runMain(argv, { home, tty, main: { agents: options } });

export async function doctor(
  options: AgentsSetupOptions = agents(),
  extra: string[] = [],
): Promise<Report> {
  const ran = await run(["doctor", "--json", ...extra], options, false);
  return JSON.parse(ran.stdout) as Report;
}

export const row = (report: Report, id: string) => report.checks.find((c) => c.id === id);
export const agentRows = (report: Report) =>
  report.checks
    .filter((c) =>
      /^(claude\.env|agents|mcp\.|codex\.engines\.|bridge\.|desktop\.|grants|t3\.|live)/u.test(
        c.id,
      ),
    )
    .map((c) => [c.id, c.status]);

export const files = () => [
  join(user, ".claude.json"),
  join(user, ".codex", "config.toml"),
  join(desktopFolder, "claude_desktop_config.json"),
  join(user, ".t3", "userdata", "settings.json"),
];
export const read = () => files().map((f) => readFileSync(f, "utf8"));

/** The preview's apply, run as the person at a terminal. */
export async function applyAll(argv: string[] = [], options = agents()): Promise<string> {
  const preview = await run(["setup", "agents", "--json", ...argv], options, false);
  expect(preview.code, preview.stderr).toBe(0);
  const planned = JSON.parse(preview.stdout) as { apply: string[] };
  const applied = await run([...planned.apply.slice(1), "--json"], options);
  expect(applied.code, applied.stdout + applied.stderr).toBe(0);
  return applied.stdout;
}
