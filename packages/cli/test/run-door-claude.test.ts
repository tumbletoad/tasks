// `ttasks run` with a Claude Code instance, from a person's command line to a settled run, on a
// service in this process with the fake Claude Code (packages/runs/test/claude-fake.ts) as the
// instance's program: the request reaches the agent on its input and no command line, the run's
// tools are a private file in the run's folder whose ticket no command line carries, the agent's
// calls through them are recorded as the run's, list, show and stop work as for a Codex run, and
// a signed-out Claude Code ends the run with the command to sign in. Fixture spaces only.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { instanceReadiness } from "@ttasks/launch";
import { RUNS_FOLDER, TOOLS_FILE } from "@ttasks/runs";
import { startService, type RunningService } from "@ttasks/service/hub";
import {
  instanceToml,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
} from "@ttasks/service/test/harness";
import { classSession } from "@ttasks/service/test/ops-helpers";
import { newId, type Id } from "@ttasks/storage";
import { seedMira } from "@ttasks/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { callTools, type ToolCall } from "../../runs/test/codex-server.ts";
import { BIN, fileTexts, runMain } from "./cli-harness.ts";

const windows = process.platform === "win32";
const FAKE = fileURLToPath(new URL("../../runs/test/claude-fake.ts", import.meta.url));
const REQUEST_MARK = "Look at MARKREQ8C3 first.";
const ANSWER_MARK = "Found MARKANS2C7 in the export.";
const LOG_MARK = "Progress MARKLOG6C2 noted.";

let root = "";
let home = "";
let cleanup = (): void => undefined;
let spaceId = "";
let task = "";
let log = "";
let service: RunningService | undefined;

const RUN_CALLS: readonly ToolCall[] = [
  { name: "add_entry", arguments: { text: LOG_MARK, request_id: "runlogentryclaude000001" } },
  { name: "get_task", arguments: {} },
];

const codeOf = (result: unknown): string | undefined => {
  const answer = result as { isError?: boolean; content?: { text?: string }[] };
  if (answer.isError !== true) return undefined;
  const text = answer.content?.map((c) => c.text ?? "").join("") ?? "";
  return /^error ([a-z_]+):/.exec(text)?.[1] ?? text;
};

/** A Claude Code instance whose program is the fake, replaying `scenario`. */
const claudeInstance = (id: string, scenario: object, env: Record<string, string> = {}): string =>
  instanceToml({
    id,
    target: "claude-cli",
    label: "Claude Code",
    exec: process.execPath,
    args_prefix: [FAKE],
    env: { FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario), ...env },
  });

beforeAll(async () => {
  ({ root, cleanup } = tempRoot("run-door-claude"));
  home = join(root, "h");
  const machine = newId("m");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: machine,
      name: "fixture-machine",
      created_at: "2026-11-17T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  mkdirSync(join(root, "spaces"));
  const os = windows ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const seeded = await seedMira(join(root, "spaces"), { tasks: 1, machineId: machine, os });
  spaceId = (
    JSON.parse(readFileSync(join(seeded.folder, "space.json"), "utf8")) as { space_id: Id<"sp"> }
  ).space_id;
  log = join(root, "fake.jsonl");
  registerSpaces(
    home,
    [seeded.folder],
    claudeInstance("claude", {
      fixture: "windows-tool",
      answer: ANSWER_MARK,
      pace: 0.3,
      log,
      callTool: { calls: RUN_CALLS, home },
    }) +
      claudeInstance("claude-slow", { fixture: "windows-interrupt", pace: 2 }) +
      claudeInstance("claude-out", { fixture: "windows-signed-out" }) +
      claudeInstance(
        "claude-says-out",
        { fixture: "windows-plain" },
        { FAKE_CLAUDE_SIGNED_OUT: "1" },
      ),
  );
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    say: () => undefined,
    launch: { shimCommand: [process.execPath, BIN], baseEnv: () => process.env },
    runs: { times: { stopGraceMs: 2_000, closeMs: 5_000 } },
  });
  await service.spacesSettled;
  const s = await classSession(home, service.endpoint.path, "cli-script");
  try {
    const out = (await s.call(
      "op/call",
      {
        op: "task.add",
        input: {
          tasks: [{ title: "Look into the export" }],
          request_id: "run-door-claude-task-001",
        },
      },
      { timeoutMs: 30_000 },
    )) as { tasks?: { id?: string }[] };
    task = out.tasks?.[0]?.id ?? "";
  } finally {
    s.close();
  }
}, 300_000);

afterAll(async () => {
  if (service !== undefined) {
    await service.stop();
    removeRuntimeDir(service);
  }
  cleanup();
}, 120_000);

const user = (argv: string[], stdin?: string) =>
  runMain(argv, { home, tty: true, ...(stdin === undefined ? {} : { stdin }) });

/** The command lines of every process this account runs now, as the system lists them. */
function commandLines(): string {
  if (windows) {
    const listed = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 60_000 },
    );
    return listed.stdout;
  }
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map((entry) => {
      try {
        return readFileSync(join("/proc", entry, "cmdline"), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

const runsOf = async (): Promise<{ id: string; instance: string; state: string }[]> =>
  (
    JSON.parse((await user(["run", "list", task, "--json"])).stdout) as {
      runs: { id: string; instance: string; state: string }[];
    }
  ).runs;

describe("[A4.3.11.run.door-claude] ttasks run with a Claude Code instance: the same door, the same record", () => {
  test("the request is on the program's input only, the tools file is private with the only TTasks entry and a ticket no command line carries, and the agent's calls are recorded as the run's", async () => {
    const running = user(["run", task, "--instance", "claude", "--wait", "-"], REQUEST_MARK);
    await waitFor(
      () =>
        readFileSync(log, { flag: "a+" }).toString().includes("MARKREQ8C3") ? true : undefined,
      60_000,
      "the request at the agent",
    );
    const live = (await runsOf()).find((r) => r.instance === "claude")?.id ?? "";
    const folder = join(stateOf(home), RUNS_FOLDER, live);
    const toolsPath = join(folder, TOOLS_FILE);
    const tools = JSON.parse(readFileSync(toolsPath, "utf8")) as {
      mcpServers: Record<string, { args: string[]; env: Record<string, string> }>;
    };
    // One server, TTasks's own, for this run's instance, with the run's ticket.
    expect(Object.keys(tools.mcpServers)).toEqual(["ttasks"]);
    const entry = tools.mcpServers["ttasks"];
    expect(entry?.args).toEqual(
      expect.arrayContaining(["mcp", "--space", spaceId, "--instance", "claude", "--app"]),
    );
    const ticket = entry?.env["TTASKS_TICKET"] ?? "";
    expect(ticket.length).toBeGreaterThan(10);
    if (!windows) expect(statSync(toolsPath).mode & 0o777).toBe(0o600);
    // The program was given the file, and neither the request nor the ticket, on its command line.
    const started = JSON.parse(readFileSync(log, "utf8").split("\n")[0] ?? "{}") as {
      argv: string[];
    };
    expect(started.argv).toEqual(expect.arrayContaining(["--mcp-config", toolsPath]));
    const lines = commandLines();
    expect(lines).not.toContain("MARKREQ8C3");
    expect(lines).not.toContain(ticket);
    expect(service?.runs.allows("claude", spaceId, live)).toBe(true);
    expect(service?.ops.homes?.may("claude", spaceId)).toBe(false);
    // While the run runs, its ticket names it, as the session named after it, in the copy of the
    // space it started in.
    expect(service?.runs.liveByTicket(ticket)).toEqual({
      run: live,
      space: spaceId,
      copy: service?.ops.spaces().find((s) => s.id === spaceId && s.reader !== undefined)?.copy,
      task: expect.stringMatching(/^t_/) as unknown,
      instance: "claude",
      session: `se_${live.slice("ru_".length)}`,
    });

    const ran = await running;
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(ANSWER_MARK);
    const shown = JSON.parse((await user(["run", "show", live, "--json"])).stdout) as Record<
      string,
      unknown
    >;
    expect(shown).toMatchObject({
      state: "succeeded",
      outcome: "success",
      instance: "claude",
      answer: ANSWER_MARK,
      answer_final: true,
    });

    // The agent's calls through the file's entry bound to the run's session and wrote as the run.
    const said = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.includes("tool_result"))
      .map((l) => JSON.parse(l) as { tool: string; tool_result: unknown });
    expect(said.map((c) => [c.tool, codeOf(c.tool_result)])).toEqual([
      ["add_entry", undefined],
      ["get_task", undefined],
    ]);
    const served = service?.ops.spaces().find((s) => s.id === spaceId);
    const rows = (await served?.reader?.transaction("deferred", [
      {
        sql: "SELECT run_id FROM log_entries WHERE body = $body",
        mode: "all",
        params: { body: LOG_MARK },
      },
    ])) as unknown[][] | undefined;
    expect(rows?.[0]).toEqual([expect.objectContaining({ run_id: live })]);

    // Once the run ended, its ticket names nothing, and the file's entry no longer opens the space.
    await waitFor(
      () => (service?.runs.liveByTicket(ticket) === undefined ? true : undefined),
      30_000,
      "the run's ticket let go",
    );
    const late = await callTools(entry ?? {}, { calls: [{ name: "status", arguments: {} }], home });
    expect(codeOf(late[0])).toBe("forbidden");

    // The request and the answer are in no file of the state folder but the run's own, and the
    // tools file is in the run's folder, which goes as a whole.
    expect(toolsPath.startsWith(folder)).toBe(true);
    for (const [file, text] of fileTexts(stateOf(home))) {
      if (file.includes(live)) continue;
      expect(text.includes("MARKREQ8C3"), file).toBe(false);
      expect(text.includes("MARKANS2C7"), file).toBe(false);
      expect(text.includes(ticket), file).toBe(false);
    }
  });

  test("with more than one instance that can run, a run names one, as before", async () => {
    const refused = await user(["run", task, "--json", "Again."]);
    expect(refused.code).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      error: { code: "invalid_input", data: { reason: "instance" } },
    });
    expect(refused.stdout).toContain("claude-slow");
  });

  test("Stop of a Claude Code run during its turn: the run is cancelled, as a Codex run is", async () => {
    const started = await user(["run", task, "--instance", "claude-slow", "--json", "Slowly."]);
    const id = (JSON.parse(started.stdout) as { id: string }).id;
    await waitFor(
      async () =>
        (await runsOf()).find((r) => r.id === id)?.state === "running" ? true : undefined,
      60_000,
      "the run running",
    );
    const stopped = await user(["run", "stop", id, "--json"]);
    expect(stopped.code, stopped.stdout).toBe(0);
    await waitFor(
      async () =>
        (await runsOf()).find((r) => r.id === id)?.state === "cancelled" ? true : undefined,
      60_000,
      "the run cancelled",
    );
  });

  test("a signed-out Claude Code ends the run with its own words and the command to sign in", async () => {
    const ran = await user(["run", task, "--instance", "claude-out", "--wait", "--json", "Hi."]);
    const id = (await runsOf()).find((r) => r.instance === "claude-out")?.id ?? "";
    const shown = JSON.parse((await user(["run", "show", id, "--json"])).stdout) as Record<
      string,
      unknown
    >;
    expect(shown, ran.stdout).toMatchObject({ state: "failed", outcome: "agent_error" });
    expect(JSON.stringify(shown)).toContain("Sign in with: claude auth login");
  });

  test("a Claude Code whose own status command found no login runs all the same: the check only informs", async () => {
    const found = await instanceReadiness(
      {
        target: "claude-cli",
        exec: process.execPath,
        argsPrefix: [FAKE],
        env: { FAKE_CLAUDE_SIGNED_OUT: "1" },
        configHome: undefined,
      },
      { platform: process.platform, base: {}, baseKind: "user", home: undefined },
    );
    expect(found?.state).toBe("no_login");
    const ran = await user([
      "run",
      task,
      "--instance",
      "claude-says-out",
      "--wait",
      "--json",
      "Hi.",
    ]);
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    const id = (await runsOf()).find((r) => r.instance === "claude-says-out")?.id ?? "";
    const shown = JSON.parse((await user(["run", "show", id, "--json"])).stdout) as Record<
      string,
      unknown
    >;
    expect(shown).toMatchObject({ state: "succeeded" });
  });
});
