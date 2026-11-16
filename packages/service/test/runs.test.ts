// Background runs in the service: the probe at start, each open space's recovery, and a run
// started through the internal call. Services run in this process on temporary homes; fixture
// spaces and generated agents only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunHelper } from "@tasks/launcher-win/build";
import type { NewRun, RunRecord } from "@tasks/contracts/runs";
import { newId, type Id } from "@tasks/storage";
import { RunFiles, RUNS_FOLDER, type Containers, type ProbeResult } from "@tasks/runs";
import { seedMira } from "@tasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import type { Logger } from "../src/hub/log.ts";
import { startService, type RunningService, type StartOptions } from "../src/hub/service.ts";
import type { ServedSpace } from "../src/ops/index.ts";
import { RunService, RunsUnavailable } from "../src/runs/service.ts";
import {
  readLog,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
} from "./harness.ts";
import { classSession } from "./ops-helpers.ts";

const windows = process.platform === "win32";
const running: RunningService[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A home whose machine.json names `machine`, and the Mira sample in `<root>/spaces/mira`. */
async function setUp(label: string) {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  const machine = newId("m");
  const home = join(root, "h");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: machine,
      name: "fixture-machine",
      created_at: "2026-11-16T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  mkdirSync(join(root, "spaces"));
  const seeded = await seedMira(join(root, "spaces"), { tasks: 1, machineId: machine });
  const manifest = JSON.parse(readFileSync(join(seeded.folder, "space.json"), "utf8")) as {
    space_id: Id<"sp">;
  };
  registerSpaces(home, [seeded.folder]);
  return { root, home, spaceId: manifest.space_id };
}

async function start(home: string, runs: StartOptions["runs"]): Promise<RunningService> {
  const service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    say: () => undefined,
    ...(runs === undefined ? {} : { runs }),
  });
  running.push(service);
  await service.spacesSettled;
  return service;
}

/** A new task of the space, through the request path. */
async function addTask(home: string, service: RunningService, n: number): Promise<string> {
  const s = await classSession(home, service.endpoint.path, "cli-script");
  try {
    const out = (await s.call(
      "op/call",
      {
        op: "task.add",
        input: {
          tasks: [{ title: `Look into the export ${String(n)}` }],
          request_id: `runs-service-task-${String(n).padStart(6, "0")}`,
        },
      },
      { timeoutMs: 30_000 },
    )) as { tasks?: { id?: string }[] };
    const id = out.tasks?.[0]?.id;
    if (id === undefined) throw new Error("no task made");
    return id;
  } finally {
    s.close();
  }
}

const input = (task: string): Omit<NewRun, "machine"> => ({
  task,
  routine: null,
  instance: "claude-work",
  adapter: "claude-print",
  place: null,
  request: "Look into the export.",
  briefHash: "0a1b2c3d".repeat(8),
  permission: "auto-edit",
  limits: { maxTurns: 50, wallMs: 10 * 60_000, idleMs: 10 * 60_000 },
});

/** A generated agent: Node with a script that prints Claude's stream. */
const agent = (script: string, cwd: string) => () => ({
  command: process.execPath,
  args: ["-e", script],
  cwd,
  env: Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  ),
});

const ANSWERS = `process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Found it in the export."})+"\\n")`;
const WAITS = `process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Still looking."}]}})+"\\n");setInterval(()=>{},1e6)`;

/** Reads a run until `ok` holds; throws after `ms`. */
async function runUntil(
  service: RunningService,
  space: string,
  id: string,
  ok: (run: RunRecord) => boolean,
  what: string,
  ms = 30_000,
): Promise<RunRecord> {
  const deadline = Date.now() + ms;
  for (;;) {
    const run = await service.runs.read(space, id).catch(() => undefined);
    if (run !== undefined && ok(run)) return run;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("[A4.3.11.9.run.service] the service probes its containers at start, recovers each open space's runs, and hosts a run started through its internal call", () => {
  test("Windows: a run ends with its answer, and one left by a stopped service is interrupted at the next start", async (ctx) => {
    if (!windows)
      ctx.skip(
        "in this process a run is contained on Windows only: Linux needs the service's own user unit",
      );
    const { root, home, spaceId } = await setUp("runs-host");
    const helper = buildRunHelper(join(root, "bin"));
    const runs = { runHelper: helper, times: { stopGraceMs: 1_000 } };
    const service = await start(home, runs);
    expect(await service.runs.probe()).toEqual({ available: true, kind: "job" });

    const task = await addTask(home, service, 1);
    const first = await service.runs.start(
      spaceId,
      input(task),
      "runs-service-run-000001",
      agent(ANSWERS, home),
    );
    expect(first?.state).toBe("starting");
    const done = await service.runs.ended(spaceId, first?.id ?? "");
    expect(done).toMatchObject({ state: "succeeded", result: { text: "Found it in the export." } });

    const second = await service.runs.start(
      spaceId,
      input(task),
      "runs-service-run-000002",
      agent(WAITS, home),
    );
    const id = second?.id ?? "";
    const live = await runUntil(service, spaceId, id, (r) => r.state === "running", "the run runs");
    // Its message is saved before the service stops: what a restart keeps is what was saved.
    const files = new RunFiles(join(stateOf(home), RUNS_FOLDER));
    await waitFor(() => files.readAnswer(id), 15_000, "the message saved");
    // The service stops: the run's processes end with it, and its record is still open.
    await service.stop();
    removeRuntimeDir(service);
    running.splice(running.indexOf(service), 1);
    await waitFor(() => (alive(live.evidence.pid) ? undefined : true), 15_000, "the agent ended");

    const next = await start(home, runs);
    const after = await runUntil(next, spaceId, id, (r) => r.state === "failed", "the recovery");
    expect(after).toMatchObject({ reason: "service_ended", result: { text: "Still looking." } });
    const events = readLog(home).map((line) => line["ev"]);
    expect(events).toContain("runs.probe");
    expect(events).toContain("run.recovered");
  }, 180_000);

  test("a probe that failed is asked again, and a space that opens after an empty round is recovered", async () => {
    const answers: ProbeResult[] = [
      { available: false, reason: "check_failed", message: "The user manager did not answer." },
      { available: true, kind: "job" },
    ];
    let probes = 0;
    const containers: Containers = {
      probe: () =>
        Promise.resolve(answers[Math.min(probes++, 1)] ?? { available: true, kind: "job" }),
      start: () => Promise.reject(new Error("no runs here")),
      interrupt: () => Promise.resolve(false),
      kill: () => Promise.resolve(),
      confirmEmpty: () => Promise.resolve({ state: "empty" }),
      recover: () => Promise.resolve({ state: "empty" }),
    };
    let spaces: ServedSpace[] = [];
    let recovered = 0;
    // The host's making starts with the writer: that it is asked shows the space is looked at.
    const writer = {
      actor: () => {
        recovered += 1;
        return Promise.reject(new Error("closed"));
      },
    };
    const service = new RunService({
      containers,
      machine: newId("m"),
      stateDir: join(tmpdir(), "tasks-runs-unused"),
      platform: process.platform,
      spaces: () => spaces,
      log: { log: () => undefined } as unknown as Logger,
    });
    try {
      expect((await service.probe()).available).toBe(false);
      expect((await service.probe()).available).toBe(true);
      expect(probes).toBe(2);
      await service.tick();
      spaces = [{ id: newId("sp"), state: "open", writer } as unknown as ServedSpace];
      await service.tick();
      expect(recovered).toBe(1);
    } finally {
      await service.close();
    }
  });

  test("where runs cannot be contained, the probe says why and the internal call refuses", async () => {
    const { home, spaceId } = await setUp("runs-none");
    // On Windows without tasks-run.exe; elsewhere a service outside a delegated systemd unit.
    const runs = windows ? { runHelper: join(home, "missing", "tasks-run.exe") } : undefined;
    const service = await start(home, runs);
    const probe = await service.runs.probe();
    expect(probe.available).toBe(false);
    if (probe.available) return;
    expect(probe.message.length).toBeGreaterThan(20);
    const task = await addTask(home, service, 1);
    await expect(
      service.runs.start(spaceId, input(task), "runs-service-run-000003", agent(ANSWERS, home)),
    ).rejects.toBeInstanceOf(RunsUnavailable);
  }, 120_000);
});
