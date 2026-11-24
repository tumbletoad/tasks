// `ttasks run` from a person's command line to a settled run, on a service in this process with
// the fake app server (packages/runs/test/codex-server.ts) as the instance's Codex: the request
// reaches the agent over its protocol and no command line, the answer is in the run's record, the
// agent's own call of TTasks's tools is recorded as the run's, a retry starts nothing twice, a
// queued run starts after a restart, only the person starts one, and a folder that is not here
// refuses it. Fixture spaces only.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { FINAL_RUN_STATES, type RunRecord } from "@ttasks/contracts/runs";
import { RunMachine, type RunEnd } from "@ttasks/runs";
import { newId, type Id } from "@ttasks/storage";
import { seedMira } from "@ttasks/testkit";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { callTools, type ToolCall } from "../../runs/test/codex-server.ts";
import { runLine } from "../src/runs.ts";
import { BIN, fileTexts, runMain } from "./cli-harness.ts";

const windows = process.platform === "win32";
const SERVER = fileURLToPath(new URL("../../runs/test/codex-server.ts", import.meta.url));
const FINAL: ReadonlySet<string> = new Set(FINAL_RUN_STATES);
const REQUEST_MARK = "Look at MARKREQ7Q2 first.";
const ANSWER_MARK = "Found MARKANS9X4 in the export.";
const LOG_MARK = "Progress MARKLOG3K8 noted.";

let root = "";
let home = "";
let cleanup = (): void => undefined;
let spaceId = "";
let task = "";
let log = "";
/** Writes machine.toml with the `codex` instance set up for these spaces (none: every space). */
let setUp: (spaces: readonly string[]) => void = () => undefined;
let service: RunningService | undefined;

/**
 * What the run's agent calls through TTasks's tools, its session by its ticket: a write and a read
 * of its own task without naming it, reads, and another task of the space named.
 */
const RUN_CALLS: readonly ToolCall[] = [
  { name: "add_entry", arguments: { text: LOG_MARK, request_id: "runlogentry000000000001" } },
  { name: "get_task", arguments: {} },
  { name: "status", arguments: {} },
  { name: "search", arguments: { q: "export" } },
  { name: "get_task", arguments: { task: "M-1" } },
];

/** A tool's answer as the agent reads it: its error code, or none. */
const codeOf = (result: unknown): string | undefined => {
  const answer = result as { isError?: boolean; content?: { text?: string }[] };
  if (answer.isError !== true) return undefined;
  const text = answer.content?.map((c) => c.text ?? "").join("") ?? "";
  return /^error ([a-z_]+):/.exec(text)?.[1] ?? text;
};

async function start(): Promise<RunningService> {
  const started = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    say: () => undefined,
    launch: { shimCommand: [process.execPath, BIN], baseEnv: () => process.env },
    // No ttasks-run.exe here: the runs get no process group, which changes only their cleanup.
    runs: { times: { stopGraceMs: 2_000, closeMs: 5_000 } },
  });
  await started.spacesSettled;
  return started;
}

async function stop(): Promise<void> {
  if (service === undefined) return;
  await service.stop();
  removeRuntimeDir(service);
  service = undefined;
}

beforeAll(async () => {
  ({ root, cleanup } = tempRoot("run-door"));
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
  const scenario = {
    fixture: "windows-tool",
    answer: ANSWER_MARK,
    pace: 0.3,
    log,
    callTool: { calls: RUN_CALLS, home },
  };
  // Two instances that can run, one of them set up for another space only: a run in this space
  // with no instance named takes the one for it.
  const codex = (id: string, spaces: readonly string[]) =>
    instanceToml({
      id,
      target: "codex-cli",
      label: id,
      exec: process.execPath,
      args_prefix: [SERVER],
      spaces,
      env: { FAKE_CODEX_SCENARIO: JSON.stringify(scenario) },
    });
  setUp = (spaces) => {
    registerSpaces(
      home,
      [seeded.folder],
      codex("codex", spaces) + codex("codex-research", ["Research"]),
    );
  };
  setUp([]);
  service = await start();
  const s = await classSession(home, service.endpoint.path, "cli-script");
  try {
    const out = (await s.call(
      "op/call",
      {
        op: "task.add",
        input: {
          tasks: [{ title: "Look into the export" }],
          request_id: "run-door-task-000000001",
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
  await stop();
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

describe("[A4.3.11.run.door] ttasks run: a person starts a background run of a task, and reads its answer", () => {
  test("a run's line says how many of its agent's requests were refused, in the list as in show", () => {
    const run = {
      id: "ru_00r5mfcw5rfzxb9enb2vg50z3g",
      task: "M-14",
      instance: "claude-work",
      state: "succeeded",
      reason: null,
    };
    expect(runLine({ ...run, refused: 2 })).toBe(
      "ru_00r5mfcw5rfzxb9enb2vg50z3g  M-14  claude-work  succeeded (2 refused)",
    );
    expect(runLine(run)).not.toContain("refused");
  });

  test("the request reaches the agent over its protocol only, the answer is in the run's record, and the agent's tool call is recorded as the run's", async () => {
    const running = user(["run", task, "--wait", "-"], REQUEST_MARK);
    // While the run runs, no process carries the request on its command line.
    await waitFor(
      () =>
        readFileSync(log, { flag: "a+" }).toString().includes(REQUEST_MARK.slice(0, 12))
          ? true
          : undefined,
      60_000,
      "the request at the agent",
    );
    expect(commandLines()).not.toContain("MARKREQ7Q2");
    // The run's own calls may use its space, though the instance's home was never set up for it;
    // no other connection of that home may.
    const live = (await service?.runs.list(spaceId, task))?.[0]?.run.id ?? "";
    expect(service?.runs.allows("codex", spaceId, live)).toBe(true);
    expect(service?.ops.homes?.may("codex", spaceId)).toBe(false);
    const ran = await running;
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(ANSWER_MARK);

    const listed = await user(["run", "list", task, "--json"]);
    const runs = (JSON.parse(listed.stdout) as { runs: Record<string, unknown>[] }).runs;
    expect(runs).toHaveLength(1);
    const run = runs[0] ?? {};
    expect(run).toMatchObject({ state: "succeeded", outcome: "success", instance: "codex" });
    expect(["confirmed", "ended_found"]).toContain(run["cleanup"]);
    const id = String(run["id"]);

    const shown = await user(["run", "show", id, "--json"]);
    expect(JSON.parse(shown.stdout)).toMatchObject({ answer: ANSWER_MARK, answer_final: true });

    // The agent's calls of TTasks's own tools as the run's session: it wrote as the run, read its
    // own task as its session without naming it, and read another task by naming it.
    const said = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.includes("tool_result"))
      .slice(0, RUN_CALLS.length)
      .map((l) => JSON.parse(l) as { tool: string; tool_result: unknown });
    expect(said.map((c) => [c.tool, codeOf(c.tool_result)])).toEqual([
      ["add_entry", undefined],
      ["get_task", undefined],
      ["status", undefined],
      ["search", undefined],
      ["get_task", undefined],
    ]);
    expect(JSON.stringify(said[1]?.tool_result)).toContain("Session: this task");
    expect(JSON.stringify(said[4]?.tool_result)).toContain(
      "Pass task M-1 on the calls that act on it",
    );
    const served = service?.ops.spaces().find((s) => s.id === spaceId);
    const rows = (await served?.reader?.transaction("deferred", [
      {
        sql: "SELECT run_id, session_id FROM log_entries WHERE body = $body",
        mode: "all",
        params: { body: LOG_MARK },
      },
    ])) as unknown[][] | undefined;
    expect(rows?.[0]).toEqual([
      expect.objectContaining({ run_id: id, session_id: `se_${id.slice("ru_".length)}` }),
    ]);

    // Once the run ended, its tools' entry (its ticket with it) may no longer use the space.
    const thread = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.includes('"thread/start"'))
      .map(
        (l) => JSON.parse(l) as { params: { config: Record<string, Record<string, unknown>> } },
      )[0];
    const entry = thread?.params.config["mcp_servers.ttasks"] ?? {};
    const late = await callTools(entry, { calls: [{ name: "status", arguments: {} }], home });
    expect(codeOf(late[0])).toBe("forbidden");
    expect(JSON.stringify(late[0])).toContain("not registered");

    // The request and the answer are in no file of the state folder but the run's own.
    for (const [file, text] of fileTexts(stateOf(home))) {
      if (file.includes(id)) continue;
      expect(text.includes("MARKREQ7Q2"), file).toBe(false);
      expect(text.includes("MARKANS9X4"), file).toBe(false);
    }
  });

  test("a run's right to use its space ends when the run does, not once its record is read again", async () => {
    // Each time the store says a run is final, its end recorded or read, that run's calls may no
    // longer use the space. The run may end before its ID is back from the command line.
    const looks: { run: string; may: boolean }[] = [];
    const look = (record: RunRecord | undefined): void => {
      if (record !== undefined && FINAL.has(record.state)) {
        looks.push({
          run: record.id,
          may: service?.runs.allows("codex", spaceId, record.id) ?? false,
        });
      }
    };
    const read = Reflect.get<RunMachine, "read">(RunMachine.prototype, "read");
    const settle = Reflect.get<RunMachine, "settle">(RunMachine.prototype, "settle");
    const reads = vi.spyOn(RunMachine.prototype, "read").mockImplementation(async function (
      this: RunMachine,
      run: string,
    ) {
      const record = await read.call(this, run);
      look(record);
      return record;
    });
    const settles = vi.spyOn(RunMachine.prototype, "settle").mockImplementation(async function (
      this: RunMachine,
      run: string,
      end: RunEnd,
    ) {
      const record = await settle.call(this, run, end);
      look(record);
      return record;
    });
    let id = "";
    try {
      const started = await user(["run", task, "--json", "Once."]);
      id = (JSON.parse(started.stdout) as { id: string }).id;
      expect(id).toMatch(/^ru_/);
      // A queued run's record is final only once it started and ended: wait for that, however long.
      const done = await waitFor(
        async () => {
          const run = await service?.runs.read(spaceId, id);
          return run !== undefined && FINAL.has(run.state) ? run : undefined;
        },
        120_000,
        "the run final",
      );
      expect(done.state).toBe("succeeded");
    } finally {
      reads.mockRestore();
      settles.mockRestore();
    }
    const after = looks.filter((l) => l.run === id).map((l) => l.may);
    expect(after).not.toContain(true);
    expect(after.length).toBeGreaterThan(0);
  });

  test("a retry with the same request ID starts nothing twice", async () => {
    const id = "run-door-retry-0000000001";
    const first = await user(["run", task, "--request-id", id, "--json", "Again, please."]);
    const second = await user(["run", task, "--request-id", id, "--json", "Again, please."]);
    expect(first.code, first.stdout).toBe(0);
    const a = JSON.parse(first.stdout) as { id: string };
    const b = JSON.parse(second.stdout) as { id: string };
    expect(b.id).toBe(a.id);
    // A start without an ID of its own hands out the one it made, and a retry with it is the same.
    const own = await user(["run", task, "--json", "Once more."]);
    const made = /^request (\S+)$/m.exec(own.stderr)?.[1] ?? "";
    const again = await user(["run", task, "--request-id", made, "--json", "Once more."]);
    expect((JSON.parse(again.stdout) as { id: string }).id).toBe(
      (JSON.parse(own.stdout) as { id: string }).id,
    );
    const listed = await user(["run", "list", task, "--json"]);
    const ids = (JSON.parse(listed.stdout) as { runs: { id: string }[] }).runs.map((r) => r.id);
    expect(ids.filter((x) => x === a.id)).toHaveLength(1);
    for (const id of [a.id, (JSON.parse(own.stdout) as { id: string }).id]) {
      await waitFor(
        async () => {
          const shown = JSON.parse((await user(["run", "show", id, "--json"])).stdout) as {
            state: string;
          };
          return shown.state === "succeeded" ? true : undefined;
        },
        60_000,
        "the retried run done",
      );
    }
    // The run is done and the task renamed since: the same press again is still that run, built
    // from nothing new. The same ID with other words is no repeat, and is refused.
    const s = await classSession(home, service?.endpoint.path ?? "", "cli-script");
    try {
      const read = (await s.call("op/call", { op: "task.get", input: { task } })) as {
        as_of: string;
      };
      await s.call("op/call", {
        op: "task.update",
        input: {
          task,
          set: { title: "Look into the export, both files" },
          base: read.as_of,
          request_id: "run-door-rename-000000001",
        },
      });
    } finally {
      s.close();
    }
    const renamed = await user(["run", task, "--request-id", id, "--json", "Again, please."]);
    expect(renamed.code, renamed.stderr).toBe(0);
    expect((JSON.parse(renamed.stdout) as { id: string }).id).toBe(a.id);
    const errorOf = (out: { stdout: string }) =>
      (JSON.parse(out.stdout) as { error: { code: string } }).error.code;
    const other = await user(["run", task, "--request-id", id, "--json", "Something else."]);
    expect(other.code).toBe(4);
    expect(errorOf(other)).toBe("request_id_conflict");
    // A task that does not exist under that ID is no repeat of the run on this one.
    const missing = await user(["run", "M-999", "--request-id", id, "--json", "Again, please."]);
    expect(missing.code).not.toBe(0);
    expect(errorOf(missing)).toBe("not_found");
    const after = await user(["run", "list", task, "--json"]);
    const count = (JSON.parse(after.stdout) as { runs: { id: string }[] }).runs.length;
    expect(count).toBe(ids.length);
  });

  test("a queued run is built from its record, so it starts after a restart of the service", async () => {
    const hold = service?.runs.hold();
    const queued = await user(["run", task, "--json", "After the restart."]);
    const id = (JSON.parse(queued.stdout) as { id: string; state: string }).id;
    expect(JSON.parse(queued.stdout)).toMatchObject({ state: "queued" });
    hold?.release();
    await stop();
    service = await start();
    await waitFor(
      async () => {
        const shown = JSON.parse((await user(["run", "show", id, "--json"])).stdout) as {
          state: string;
        };
        return shown.state === "succeeded" ? true : undefined;
      },
      90_000,
      "the queued run done after the restart",
    );
  });

  test("only the person starts a run: a script and an agent's shell are refused, and nothing is queued", async () => {
    const before = (
      JSON.parse((await user(["run", "list", "--json"])).stdout) as { runs: unknown[] }
    ).runs.length;
    const script = await runMain(["run", task, "--json", "From a script."], { home });
    expect(script.code).toBe(5);
    expect(JSON.parse(script.stdout)).toMatchObject({ error: { code: "forbidden" } });
    const agent = await runMain(["run", task, "--json", "From an agent."], {
      home,
      tty: true,
      env: { CODEX_THREAD_ID: "019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b" },
    });
    expect(agent.code).toBe(5);
    const after = (
      JSON.parse((await user(["run", "list", "--json"])).stdout) as { runs: unknown[] }
    ).runs.length;
    expect(after).toBe(before);
  });

  test("Stop on a queued run cancels it, and a task that is not there is refused with the person's words", async () => {
    const hold = service?.runs.hold();
    try {
      const queued = JSON.parse((await user(["run", task, "--json"])).stdout) as { id: string };
      const stopped = await user(["run", "stop", queued.id, "--json"]);
      expect(JSON.parse(stopped.stdout)).toMatchObject({ state: "cancelled" });
    } finally {
      hold?.release();
    }
    const missing = await user(["run", "M-999", "--json"]);
    expect(missing.code).not.toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ error: { code: "not_found" } });
    const help = await user(["help", "run"]);
    expect(help.stdout).toContain("ttasks run <task>");
  });

  test("a task whose folder is not found here is refused with that reason, and nothing is queued", async () => {
    const folder = join(root, "work", "portal");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const added = await user(["add", "Tidy the portal", "--folder", folder, "--json"]);
    expect(added.code, added.stdout + added.stderr).toBe(0);
    const placed = (JSON.parse(added.stdout) as { tasks: { id: string }[] }).tasks[0]?.id ?? "";
    rmSync(folder, { recursive: true });

    const refused = await user(["run", placed, "--json", "Tidy it."]);
    expect(refused.code).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      error: { code: "invalid_input", data: { reason: "folder_missing" } },
    });
    const listed = await user(["run", "list", placed, "--json"]);
    expect((JSON.parse(listed.stdout) as { runs: unknown[] }).runs).toEqual([]);
  });

  test("an instance set up for other spaces runs nothing here: named, it is refused; set so after its run was queued, the run does not start", async () => {
    const before = (
      JSON.parse((await user(["run", "list", task, "--json"])).stdout) as {
        runs: unknown[];
      }
    ).runs.length;
    const refused = await user(["run", task, "--instance", "codex-research", "--json"]);
    expect(refused.code).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      error: {
        code: "invalid_input",
        message: "This instance is set up for other spaces only. Nothing was started.",
        data: { reason: "not_for_space" },
      },
    });
    const listed = await user(["run", "list", task, "--json"]);
    expect((JSON.parse(listed.stdout) as { runs: unknown[] }).runs).toHaveLength(before);

    // Queued with the one instance for this space, which is set up for another before it starts.
    const hold = service?.runs.hold();
    const queued = await user(["run", task, "--json", "Before the change."]);
    expect(JSON.parse(queued.stdout)).toMatchObject({ state: "queued", instance: "codex" });
    const id = (JSON.parse(queued.stdout) as { id: string }).id;
    hold?.release();
    await stop();
    setUp(["Research"]);
    try {
      service = await start();
      await waitFor(
        async () => {
          const shown = JSON.parse((await user(["run", "show", id, "--json"])).stdout) as {
            state: string;
            reason: string | null;
          };
          return FINAL.has(shown.state) ? shown : undefined;
        },
        90_000,
        "the queued run settled",
      ).then((shown) => {
        expect(shown).toMatchObject({ state: "failed", reason: "not_for_space" });
      });
    } finally {
      await stop();
      setUp([]);
      service = await start();
    }
  });
});
