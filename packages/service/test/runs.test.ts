// Background runs in the service: the probe at start, each open space's recovery, and a run
// started through the internal call. Services run in this process on temporary homes; fixture
// spaces and generated agents only.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { buildRunHelper } from "@ttasks/launcher-win/build";
import type { NewRun, RunRecord } from "@ttasks/contracts/runs";
import { newId, type Id } from "@ttasks/storage";
import {
  RunFiles,
  RUNS_FOLDER,
  type AgentExit,
  type Contained,
  type Containers,
  type ProbeResult,
} from "@ttasks/runs";
import { seedMira } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import type { Logger } from "../src/hub/log.ts";
import { startService, type RunningService, type StartOptions } from "../src/hub/service.ts";
import { opCall, type ServedSpace } from "../src/ops/index.ts";
import { RunService } from "../src/runs/service.ts";
import { holdRuns } from "../src/install/context.ts";
import {
  instanceToml,
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
async function setUp(label: string, machineToml = "") {
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
  // The space's machine is this one, with this OS: its folders take this OS's form.
  const os = windows ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const seeded = await seedMira(join(root, "spaces"), { tasks: 1, machineId: machine, os });
  const manifest = JSON.parse(readFileSync(join(seeded.folder, "space.json"), "utf8")) as {
    space_id: Id<"sp">;
  };
  registerSpaces(
    home,
    [seeded.folder],
    instanceToml({
      id: "claude-work",
      target: "claude-cli",
      label: "Claude · work",
      exec: process.execPath,
    }) + machineToml,
  );
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
    expect(first.state).toBe("queued");
    const done = await service.runs.ended(spaceId, first.id);
    expect(done).toMatchObject({ state: "succeeded", result: { text: "Found it in the export." } });

    const second = await service.runs.start(
      spaceId,
      input(task),
      "runs-service-run-000002",
      agent(WAITS, home),
    );
    const id = second.id;
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

  test("a probe that failed is asked again, a space that opens after an empty round is recovered, and a space whose store does not answer holds up no other", async () => {
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
      stateDir: join(tmpdir(), "ttasks-runs-unused"),
      platform: process.platform,
      spaces: () => spaces,
      log: { log: () => undefined } as unknown as Logger,
    });
    try {
      expect((await service.probe()).available).toBe(false);
      expect((await service.probe()).available).toBe(true);
      expect(probes).toBe(2);
      await service.tick();
      const open = (w: unknown) =>
        ({ id: newId("sp"), state: "open", writer: w }) as unknown as ServedSpace;
      spaces = [open(writer)];
      await service.tick();
      expect(recovered).toBe(1);
      // A space whose store never answers holds up neither another space nor a later round.
      const silent = { actor: () => new Promise<never>(() => undefined) };
      spaces = [open(silent), open(writer)];
      void service.tick();
      expect(recovered).toBe(2);
      let later = 0;
      const opened = {
        actor: () => {
          later += 1;
          return Promise.reject(new Error("closed"));
        },
      };
      spaces = [open(silent), open(opened)];
      void service.tick();
      expect(later).toBe(1);
    } finally {
      await service.close();
    }
  });

  test("where no process group can hold runs, the probe says why and a run starts anyway: its work is done, and its cleanup says TTasks ended what it could find", async () => {
    const { home, spaceId } = await setUp("runs-none");
    // On Windows without ttasks-run.exe; elsewhere a service outside a delegated systemd unit.
    const runs = windows ? { runHelper: join(home, "missing", "ttasks-run.exe") } : undefined;
    const service = await start(home, runs);
    const probe = await service.runs.probe();
    expect(probe.available).toBe(false);
    if (probe.available) return;
    expect(probe.message.length).toBeGreaterThan(20);
    const task = await addTask(home, service, 1);
    const queued = await service.runs.start(
      spaceId,
      input(task),
      "runs-service-run-000003",
      agent(ANSWERS, home),
    );
    const done = await service.runs.ended(spaceId, queued.id);
    expect(done).toMatchObject({
      state: "succeeded",
      result: { text: "Found it in the export.", cleanup: "ended_found" },
    });
  });
});

/**
 * Containers on no operating system: each agent says it is working, and answers and exits on the
 * interrupt or when `finish` is called. Every OS runs the tests that use them.
 */
function fakeBoxes() {
  const live = new Map<
    string,
    { stdout: PassThrough; stderr: PassThrough; exit: (e: AgentExit) => void }
  >();
  const say = (out: PassThrough, text: string, final: boolean) => {
    const event = final
      ? { type: "result", subtype: "success", is_error: false, result: text }
      : { type: "assistant", message: { content: [{ type: "text", text }] } };
    out.write(`${JSON.stringify(event)}\n`);
  };
  const end = (name: string, text: string | undefined): boolean => {
    const box = live.get(name);
    if (box === undefined) return false;
    live.delete(name);
    if (text !== undefined) say(box.stdout, text, true);
    box.exit({ code: 0, signal: null });
    box.stdout.end();
    box.stderr.end();
    return true;
  };
  let pid = 4_000;
  const containers: Containers = {
    probe: () => Promise.resolve({ available: true, kind: "job" }),
    start: (spec) => {
      let exit!: (e: AgentExit) => void;
      const exited = new Promise<AgentExit>((resolve) => {
        exit = resolve;
      });
      const box = { stdout: new PassThrough(), stderr: new PassThrough(), exit };
      live.set(spec.name, box);
      say(box.stdout, "Still looking.", false);
      pid += 1;
      const contained: Contained = {
        name: spec.name,
        pid,
        stdin: new PassThrough(),
        stdout: box.stdout,
        stderr: box.stderr,
        exited,
      };
      return Promise.resolve(contained);
    },
    interrupt: (name) => Promise.resolve(end(name, "Stopped with what was found.")),
    kill: (name) => {
      end(name, undefined);
      return Promise.resolve();
    },
    confirmEmpty: (name) =>
      Promise.resolve(live.has(name) ? { state: "occupied", detail: "alive" } : { state: "empty" }),
    recover: (name) => {
      end(name, undefined);
      return Promise.resolve({ state: "empty" });
    },
  };
  return { containers, live, finish: (name: string) => end(name, "Found it in the export.") };
}

describe("[A4.3.11.9.run.folder] a queued run checks the folder a launch of its task would use, right before it starts", () => {
  test("a task whose folder went is refused as folder_gone and nothing starts; a task without a folder runs", async () => {
    const { root, home, spaceId } = await setUp("runs-folder");
    const boxes = fakeBoxes();
    const service = await start(home, { containers: boxes.containers });
    const placed = await addTask(home, service, 1);
    const plain = await addTask(home, service, 2);
    const folder = join(root, "work", "portal");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    await opCall(
      service.ops,
      { class: "cli-interactive", env: {} },
      {
        op: "folder.manage",
        input: { action: "set", task: placed, folder, request_id: "runs-folder-set-000001" },
        space: spaceId,
      },
    );
    rmSync(folder, { recursive: true });

    const command = agent(ANSWERS, home);
    const gone = await service.runs.start(
      spaceId,
      input(placed),
      "runs-folder-run-000001",
      command,
    );
    expect(
      await runUntil(service, spaceId, gone.id, (r) => r.state !== "queued", "the check"),
    ).toMatchObject({ state: "failed", reason: "folder_gone" });
    expect(boxes.live.size).toBe(0);

    const runs = await service.runs.start(spaceId, input(plain), "runs-folder-run-000002", command);
    await runUntil(
      service,
      spaceId,
      runs.id,
      (r) => r.state === "running",
      "the run in the work folder",
    );
    boxes.finish(runs.id);
    expect(await service.runs.ended(spaceId, runs.id)).toMatchObject({ state: "succeeded" });
  }, 120_000);
});

describe("[A4.3.11.9.run.stop-unknown] Stop of a run whose processes were not confirmed ended ends them by force", () => {
  test("a process that outlived the kill leaves the run unknown; once it can be ended, Stop settles the run as it ended", async () => {
    const { home, spaceId } = await setUp("runs-unknown");
    const boxes = fakeBoxes();
    // What the agent left survives the run's own kill, until it is ended by its name.
    const left = new Set<string>();
    const containers: Containers = {
      ...boxes.containers,
      start: async (spec) => {
        left.add(spec.name);
        return boxes.containers.start(spec);
      },
      confirmEmpty: (name, options) =>
        left.has(name)
          ? Promise.resolve({ state: "occupied", detail: "left" })
          : boxes.containers.confirmEmpty(name, options),
      recover: (name, options) => {
        left.delete(name);
        return boxes.containers.recover(name, options);
      },
    };
    const service = await start(home, {
      containers,
      times: { stopGraceMs: 500, confirmMs: 200, closeMs: 200 },
    });
    const task = await addTask(home, service, 1);
    const run = await service.runs.start(
      spaceId,
      input(task),
      "runs-unknown-run-000001",
      agent(ANSWERS, home),
    );
    await runUntil(service, spaceId, run.id, (r) => r.state === "running", "the run");
    await service.runs.stop(spaceId, run.id);
    await runUntil(service, spaceId, run.id, (r) => r.state === "unknown", "the run unknown");
    expect(await service.runs.stop(spaceId, run.id)).toMatchObject({
      state: "cancelled",
      result: { text: "Stopped with what was found." },
    });
  }, 120_000);
});

describe("[A4.3.11.9.run.update-hold] an update's hold over the local endpoint: what blocks it, nothing new starts, Stop on request, and the hold goes with its connection", () => {
  test("a working run comes with what it said so far and since when it is quiet; a run being stopped is not quiet, and one that waits said nothing", async () => {
    const { home, spaceId } = await setUp("runs-live");
    const boxes = fakeBoxes();
    const service = await start(home, { containers: boxes.containers });
    const task = await addTask(home, service, 1);
    const command = agent(ANSWERS, home);
    const first = await service.runs.start(spaceId, input(task), "runs-live-run-000001", command);
    const running = await runUntil(service, spaceId, first.id, (r) => r.state === "running", "it");
    const live = await waitFor(
      () => {
        const now = service.runs.live(running);
        return now.said === undefined ? undefined : now;
      },
      15_000,
      "what it said",
    );
    expect(live.said).toEqual({ text: "Still looking.", final: false, cut: false });
    expect(typeof live.quietSince).toBe("number");
    // The host still holds the run while its Stop is on its way: it is stopping, not quiet.
    const stopping = service.runs.live({ ...running, state: "cancelling" });
    expect(stopping).not.toHaveProperty("quietSince");
    expect(stopping.said?.text).toBe("Still looking.");
    expect(service.runs.live({ ...running, state: "queued" })).not.toHaveProperty("said");
    boxes.finish(first.id);
    const ended = await service.runs.ended(spaceId, first.id);
    expect(ended).toMatchObject({ state: "succeeded" });
    // An ended run's record says it all.
    expect(ended === undefined ? undefined : service.runs.live(ended)).toEqual({});
  }, 60_000);

  test("the hold names the running run with its task, a new run waits with the reason update, stop_held stops the run with its answer, and closing the hold's connection lets the queue move", async () => {
    const { home, spaceId } = await setUp(
      "runs-hold",
      "\n[runs]\nmax_minutes = 7\nmax_quiet_minutes = 3\n",
    );
    const boxes = fakeBoxes();
    const service = await start(home, { containers: boxes.containers });
    const task = await addTask(home, service, 1);
    const other = await addTask(home, service, 2);
    const command = agent(ANSWERS, home);
    const first = await service.runs.start(spaceId, input(task), "runs-hold-run-000001", command);
    await runUntil(service, spaceId, first.id, (r) => r.state === "running", "the first run");

    // An agent's shell may not hold runs back: the update restarts the service.
    const agentSession = await classSession(home, service.endpoint.path, "cli-agent", {
      CLAUDECODE: "1",
    });
    await expect(agentSession.call("runs/hold", {}, { timeoutMs: 10_000 })).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    agentSession.close();

    const updater = await classSession(home, service.endpoint.path, "cli-script");
    const told: unknown[][] = [];
    updater.onNotification = (method, params) => {
      if (method === "runs/blocking") told.push((params as { runs: unknown[] }).runs);
    };
    const holding = updater.call("runs/hold", {}).then(
      () => "answered",
      () => "ended",
    );
    await waitFor(() => (told.length > 0 ? true : undefined), 15_000, "what blocks the update");
    expect(told[0]).toEqual([
      expect.objectContaining({ space: spaceId, run: first.id, state: "running" }),
    ]);
    const blocker = (told[0] as { task: unknown; space_name: unknown }[])[0];
    expect(blocker?.task).toMatch(/^[A-Z]+-\d+$/);
    expect(typeof blocker?.space_name).toBe("string");

    // A run queued meanwhile waits, and says why. Without limits of its own it takes [runs]'s.
    const unlimited: Partial<Omit<NewRun, "machine">> & Omit<NewRun, "machine" | "limits"> =
      input(other);
    delete unlimited.limits;
    const second = await service.runs.start(spaceId, unlimited, "runs-hold-run-000002", command);
    expect(second.limits).toMatchObject({ wallMs: 7 * 60_000, idleMs: 3 * 60_000 });
    await waitFor(
      () => (service.runs.live(second).waiting === "update" ? true : undefined),
      15_000,
      "the reason it waits",
    );
    expect((await service.runs.read(spaceId, second.id))?.state).toBe("queued");

    // The person said: stop the runs.
    const asker = await classSession(home, service.endpoint.path, "cli-script");
    const left = (await asker.call("runs/stop_held", {}, { timeoutMs: 60_000 })) as {
      runs: unknown[];
    };
    asker.close();
    expect(left.runs).toEqual([]);
    expect(await service.runs.read(spaceId, first.id)).toMatchObject({
      state: "cancelled",
      result: { text: "Stopped with what was found." },
    });
    await waitFor(
      () => (told.at(-1)?.length === 0 ? true : undefined),
      15_000,
      "nothing blocks any more",
    );
    expect((await service.runs.read(spaceId, second.id))?.state).toBe("queued");

    // The updater goes, and its hold with its connection: the queue moves.
    updater.close();
    expect(await holding).toBe("ended");
    await runUntil(service, spaceId, second.id, (r) => r.state === "running", "the second run");

    // The updater's own client: the running run, by its task; nothing once the service stopped.
    // Its environment carries no agent's marker: the update is the person's.
    const env = {};
    const hold = await holdRuns(service.layout.state, service.installId, env, 15_000);
    if (hold === undefined || hold === "silent") throw new Error(`no hold: ${String(hold)}`);
    expect(hold.blocking()).toEqual([expect.objectContaining({ state: "running" })]);
    expect(hold.blocking()[0]?.task).toMatch(/^[A-Z]+-\d+$/);
    hold.release();
    boxes.finish(second.id);
    expect(await service.runs.ended(spaceId, second.id)).toMatchObject({ state: "succeeded" });
    await service.stop();
    expect(await holdRuns(service.layout.state, service.installId, env, 15_000)).toBeUndefined();
  }, 120_000);
});
