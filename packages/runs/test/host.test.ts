// The run host's rules one by one, on the model world's fake containers and clock (host-world.ts):
// Stop before the agent's PID, while it runs and after it exited, the start time, the run's limits,
// a container that refuses to empty and End by force, and the next start after a crash.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunLimits, RunRecord } from "@ttasks/contracts/runs";
import type { RunStore } from "@ttasks/launch/execution-store";
import { MemoryDurable, MemoryExecutionStore } from "@ttasks/launch/memory-store";
import { describe, expect, test } from "vitest";
import {
  ANSWER_FILE,
  FallbackContainers,
  claudeDriver,
  RunFiles,
  RunHost,
  RunMachine,
  UngroupedContainers,
  type AgentCommand,
  type AgentExit,
  type Confirmation,
  type Containers,
  type OpenDriver,
  type RunFolders,
  type RunTimes,
  type SavedAnswer,
  type Work,
} from "../src/index.ts";
import { endMove } from "../src/machine.ts";
import { MODEL_LIMITS, World, type Event } from "./host-world.ts";
import { census, newToken, standInSpec, waitForCensus } from "./stand-ins/stand-ins.ts";

const MACHINE = "m_3q7k9d2xw8f4r6t1c5v0b2n8a7";

/**
 * A host over a memory store with no model world: for what the world does not model, real child
 * processes and preparation that never ends. `wrap` changes what the store does.
 */
async function bareHost(options: {
  containers: Containers;
  wrap?: (store: RunStore) => RunStore;
  times?: Partial<RunTimes>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  elapsed?: () => number;
}) {
  const store = new MemoryExecutionStore(new MemoryDurable(() => Date.UTC(2026, 10, 16)));
  const machine = new RunMachine({ store: options.wrap?.(store) ?? store, machine: MACHINE });
  const saved = new Map<string, SavedAnswer>();
  const files: RunFolders = {
    prepare: () => undefined,
    saveAnswer: (id, answer) => saved.set(id, answer),
    readAnswer: (id) => saved.get(id),
    logs: () => ({ stdout: () => undefined, stderr: () => undefined, close: () => undefined }),
    removeTemps: () => undefined,
  };
  const host = new RunHost({
    machine,
    containers: options.containers,
    files,
    ...(options.times === undefined ? {} : { times: options.times }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.elapsed === undefined ? {} : { elapsed: options.elapsed }),
  });
  const queued = await machine.queue(
    {
      task: "t_0000000000000000000000000a",
      routine: null,
      instance: "claude-work",
      adapter: "claude-print",
      place: null,
      request: "Fix the export.",
      briefHash: "0a1b2c3d".repeat(8),
      permission: "auto-edit",
      limits: MODEL_LIMITS,
    },
    "host-bare-00000001",
  );
  return { host, id: queued.id, saved, machine, files };
}

/** Containers that run each agent as a plain child process, and one that refuses every start. */
function childContainers(): Containers & { exited: Promise<void> } {
  const children = new Map<string, ChildProcess>();
  let ended!: () => void;
  const exited = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const gone = (child: ChildProcess | undefined) =>
    child === undefined || child.exitCode !== null || child.signalCode !== null;
  const confirm = async (name: string, waitMs = 0) => {
    const child = children.get(name);
    if (!gone(child)) {
      await Promise.race([new Promise((resolve) => child?.once("exit", resolve)), sleep(waitMs)]);
    }
    return gone(child)
      ? { state: "empty" as const }
      : { state: "occupied" as const, detail: "alive" };
  };
  return {
    exited,
    probe: () => Promise.resolve({ available: true, kind: "job" }),
    kind: () => Promise.resolve("job" as const),
    start: (spec) => {
      const child = spawn(spec.command, [...spec.args], { stdio: ["pipe", "pipe", "pipe"] });
      children.set(spec.name, child);
      const exit = new Promise<AgentExit>((resolve) => {
        child.once("exit", (code, signal) => {
          resolve({ code, signal });
          ended();
        });
      });
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", () => {
          if (child.pid === undefined) {
            reject(new Error("no PID"));
            return;
          }
          resolve({
            name: spec.name,
            pid: child.pid,
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
            exited: exit,
          });
        });
      });
    },
    interrupt: () => Promise.resolve(false),
    kill: (name) => {
      children.get(name)?.kill();
      return Promise.resolve();
    },
    confirmEmpty: (name, o) => confirm(name, o?.waitMs),
    recover: (name, o) => {
      children.get(name)?.kill();
      return confirm(name, o?.waitMs);
    },
  };
}

const refusing: Containers = {
  probe: () => Promise.resolve({ available: true, kind: "job" }),
  kind: () => Promise.resolve("job" as const),
  start: () => Promise.reject(new Error("the agent did not start")),
  interrupt: () => Promise.resolve(false),
  kill: () => Promise.resolve(),
  confirmEmpty: () => Promise.resolve({ state: "empty" }),
  recover: () => Promise.resolve({ state: "empty" }),
};

/** Resolves once `ok` holds, asked again after each turn of the event loop. */
async function waitUntil(ok: () => Promise<boolean>): Promise<void> {
  while (!(await ok())) await new Promise((resolve) => setImmediate(resolve));
}

/** A command that is never ready, as an adapter's preparation that hangs. */
const never = (): Promise<AgentCommand> => new Promise<AgentCommand>(() => undefined);

/** A world with one queued run, and a way to read it. */
async function oneRun(limits: RunLimits = MODEL_LIMITS): Promise<{
  world: World;
  run: (...events: Event[]) => Promise<void>;
  read: () => Promise<RunRecord>;
  history: () => string[];
}> {
  const clock: { world?: World } = {};
  const durable = new MemoryDurable(() => clock.world?.now ?? 0);
  const world = new World({
    machine: MACHINE,
    store: () => new MemoryExecutionStore(durable),
    tasks: ["t_0000000000000000000000000a"],
  });
  clock.world = world;
  world.limits = limits;
  const run = async (...events: Event[]) => {
    for (const e of events) {
      await world.run(e);
      await world.check(new MemoryExecutionStore(durable));
    }
  };
  await run({ kind: "queue" });
  const id = world.runs[0] ?? "";
  return {
    world,
    run,
    read: async () => {
      const record = await new MemoryExecutionStore(durable).readRun(id);
      if (record === undefined) throw new Error("no run");
      return record;
    },
    history: () => durable.runHistory.filter((h) => h.id === id).map((h) => h.to),
  };
}

const start = (mode: "ok" | "hang" | "refuse" = "ok", obeys = true): Event => ({
  kind: "start",
  pick: 0,
  mode,
  obeys,
});
const say = (final = false): Event => ({ kind: "say", pick: 0, final });
const tick = (ms: number): Event => ({ kind: "tick", ms });
const STOP: Event = { kind: "stop", pick: 0 };

describe("[A4.5.run.host] the run host's rules", () => {
  test("Stop on a queued run cancels it at once, and nothing starts", async () => {
    const { run, read, world } = await oneRun();
    await run(STOP, start());
    expect((await read()).state).toBe("cancelled");
    expect(world.boxes.size).toBe(0);
  });

  test("Stop while the agent runs: an agent that obeys gives its answer, and the run is cancelled with it", async () => {
    const { run, read, world } = await oneRun();
    await run(start("ok", true), say());
    expect((await read()).state).toBe("running");
    await run(STOP);
    const after = await read();
    expect(after.state).toBe("cancelled");
    expect(after.result?.text).toBe("answer 2");
    expect(after.result?.textFinal).toBe(true);
    expect(world.boxes.get(after.id)?.procs).toBe(0);
  });

  test("Stop for an agent that ignores it: the container is killed after the grace time", async () => {
    const { run, read, world } = await oneRun();
    await run(start("ok", false), say(), { kind: "fork", pick: 0 }, STOP);
    expect((await read()).state).toBe("cancelling");
    await run(tick(9_000));
    expect((await read()).state).toBe("cancelling");
    await run(tick(2_000));
    const after = await read();
    expect(after.state).toBe("cancelled");
    expect(after.result?.text).toBe("answer 1");
    expect(world.boxes.get(after.id)?.procs).toBe(0);
  });

  test("Stop before the agent's PID: the run stays cancelling until its container is started, stopped and confirmed empty", async () => {
    const { run, read, history } = await oneRun();
    await run(start("hang"), STOP);
    expect((await read()).state).toBe("cancelling");
    await run({ kind: "answerStart", pick: 0, ok: true }, tick(11_000));
    const after = await read();
    expect(after.state).toBe("cancelled");
    // The PID came after the Stop: it is recorded, and the run never ran.
    expect(after.evidence.pid).toBeGreaterThan(0);
    expect(history()).not.toContain("running");
  });

  test("Stop while the agent's process starts: once it is there, nothing reaches its input, and the run is cancelled", async () => {
    for (const open of [claudeDriver({ request: "Delete the old exports." }), undefined]) {
      const { run, read, world } = await oneRun();
      world.open = open;
      await run(start("hang"), STOP);
      expect((await read()).state).toBe("cancelling");
      await run({ kind: "answerStart", pick: 0, ok: true }, tick(11_000));
      const after = await read();
      expect(after.state).toBe("cancelled");
      expect(world.input.get(after.id)).toBe("");
      expect(world.boxes.get(after.id)?.procs).toBe(0);
    }
  });

  test("Stop after the agent exited, while what it left is ended: the run is cancelled", async () => {
    const { run, read } = await oneRun();
    await run(start(), say(true), { kind: "fork", pick: 0 }, { kind: "stick", pick: 0 });
    await run({ kind: "exit", pick: 0, code: 0 }, STOP);
    expect((await read()).state).toBe("cancelling");
    // The leftover holds the output and survives the kill: after the drain and the confirmation
    // time the run is unknown, and keeps the Stop.
    await run(tick(16_000));
    expect(await read()).toMatchObject({ state: "unknown", reason: "stop_timed_out" });
    await run({ kind: "release", pick: 0 }, { kind: "forceEnd", pick: 0 }, tick(1_000));
    const after = await read();
    expect(after.state).toBe("cancelled");
    expect(after.result?.text).toBe("answer 1");
  });

  test("a container that refuses to empty leaves the run unknown; End by force settles it once it is empty", async () => {
    const { run, read } = await oneRun();
    await run(start(), say(true), { kind: "fork", pick: 0 }, { kind: "stick", pick: 0 });
    // After the drain, the time to end by itself and the confirmation time.
    await run({ kind: "exit", pick: 0, code: 0 }, tick(18_000));
    expect(await read()).toMatchObject({ state: "unknown", reason: "stop_timed_out" });
    // Still held: End by force cannot confirm it.
    await run({ kind: "forceEnd", pick: 0 }, tick(11_000));
    expect((await read()).state).toBe("unknown");
    await run({ kind: "release", pick: 0 }, { kind: "forceEnd", pick: 0 }, tick(1_000));
    const after = await read();
    expect(after.state).toBe("succeeded");
    expect(after.result?.text).toBe("answer 1");
  });

  test("a start that gives no PID within 60 s: what it makes later is ended, and the run fails", async () => {
    const { run, read, world, history } = await oneRun();
    await run(start("hang"), tick(59_000));
    expect((await read()).state).toBe("starting");
    await run(tick(2_000), tick(11_000));
    // The start may still make a container: the run is not final yet.
    expect((await read()).state).toBe("unknown");
    await run({ kind: "answerStart", pick: 0, ok: true }, tick(1_000));
    const after = await read();
    expect(after).toMatchObject({ state: "failed", reason: "start_timed_out" });
    expect(world.boxes.get(after.id)?.procs).toBe(0);
    expect(history()).not.toContain("running");
  });

  test("a refused start fails the run with nothing left", async () => {
    const { run, read } = await oneRun();
    await run(start("refuse"));
    expect(await read()).toMatchObject({ state: "failed", reason: "spawn_failed" });
  });

  test("the idle and wall limits interrupt the agent, which may still give its answer", async () => {
    const idle = await oneRun();
    await idle.run(start("ok", true), say(), tick(59_000));
    expect((await idle.read()).state).toBe("running");
    await idle.run(tick(2_000));
    expect(await idle.read()).toMatchObject({ state: "timed_out", reason: "idle" });
    expect((await idle.read()).result?.textFinal).toBe(true);

    const wall = await oneRun();
    await wall.run(start("ok", false));
    for (let i = 0; i < 4; i += 1) await wall.run(tick(40_000), say());
    await wall.run(tick(11_000));
    expect(await wall.read()).toMatchObject({ state: "timed_out", reason: "wall" });
  });

  test("an agent that exits having said nothing but on stderr: its words there are the run's error", async () => {
    const { run, read, world } = await oneRun();
    await run(start());
    const id = world.runs[0] ?? "";
    world.boxes.get(id)?.stderr.write("error: unknown option '--instance'\n");
    await run({ kind: "exit", pick: 0, code: 1 }, tick(10_000));
    expect(await read()).toMatchObject({
      state: "failed",
      result: { outcome: "no_output", error: "error: unknown option '--instance'" },
    });
  });

  test("a run without time limits is never ended for its time, however long or quiet it is", async () => {
    const { run, read } = await oneRun({ maxTurns: 50 });
    await run(start("ok", true), say());
    for (let i = 0; i < 30; i += 1) await run(tick(60 * 60_000));
    expect((await read()).state).toBe("running");
    await run(say(true), { kind: "exit", pick: 0, code: 0 }, tick(10_000));
    expect((await read()).state).toBe("succeeded");
  });

  test("a clean run keeps both results: the work's answer, and nothing left behind", async () => {
    const { run, read } = await oneRun();
    await run(start(), say(true), { kind: "exit", pick: 0, code: 0 }, tick(1_000));
    const after = await read();
    expect(after.state).toBe("succeeded");
    expect(after.result).toMatchObject({ text: "answer 1", textFinal: true, cleanup: "confirmed" });
  });

  test("a run whose agent left a process behind: the work stays done, the cleanup says it was ended", async () => {
    const { run, read, world } = await oneRun();
    await run(start(), say(true), { kind: "fork", pick: 0 }, { kind: "exit", pick: 0, code: 0 });
    await run(tick(10_000));
    const after = await read();
    expect(after.state).toBe("succeeded");
    expect(after.result).toMatchObject({ text: "answer 1", cleanup: "ended_leftovers" });
    expect(world.boxes.get(after.id)?.procs).toBe(0);
  });

  test("a crash after the work settled and was saved: the next start records the work's own result", async () => {
    const { run, read } = await oneRun();
    // The leftover holds the output, so the host is still cleaning up when the service dies.
    await run(start(), say(true), { kind: "fork", pick: 0 }, { kind: "exit", pick: 0, code: 0 });
    await run(tick(5_500), { kind: "crash" }, tick(1_000));
    const after = await read();
    expect(after.state).toBe("succeeded");
    expect(after.result).toMatchObject({ ok: true, outcome: "success", text: "answer 1" });
  });

  test("a crash after a time limit ended the work and its result was saved: the next start records the time limit, with the answer", async () => {
    const { run, read } = await oneRun();
    // A process that refuses to end holds the cleanup, so the service dies after the save.
    await run(start("ok", true), say(), { kind: "fork", pick: 0 }, { kind: "stick", pick: 0 });
    await run(tick(59_000), tick(2_000), tick(5_500), { kind: "crash" }, tick(1_000));
    expect(await read()).toMatchObject({ state: "unknown", reason: "stop_timed_out" });
    await run({ kind: "release", pick: 0 }, { kind: "forceEnd", pick: 0 }, tick(1_000));
    const after = await read();
    expect(after).toMatchObject({ state: "timed_out", reason: "idle" });
    expect(after.result).toMatchObject({ outcome: "success", text: "answer 2", textFinal: true });
  });

  test("a crash while a time limit's interrupt and grace go on: the next start records the time limit, with the answer so far", async () => {
    for (const [limits, reason] of [
      [{ maxTurns: 50, idleMs: 60_000 }, "idle"],
      [{ maxTurns: 50, wallMs: 60_000 }, "wall"],
    ] as const) {
      const { run, read } = await oneRun(limits);
      // An agent that ignores the interrupt: the work has not settled when the service dies.
      await run(start("ok", false), say(), tick(59_000), tick(2_000), { kind: "crash" });
      await run(tick(1_000));
      const after = await read();
      expect(after).toMatchObject({ state: "timed_out", reason });
      expect(after.result).toMatchObject({ outcome: "no_result", text: "answer 1" });
      expect(after.result?.textFinal).toBeUndefined();
    }
  });

  test("a run's folder keeps the time limit that ended its work for the next start, from the moment it fired, and a saved work that names no limit is no saved work", () => {
    const root = mkdtempSync(join(tmpdir(), "ttasks-answer-"));
    try {
      const id = "ru_0000000000000000000000000a";
      const files = new RunFiles(root);
      files.prepare(id);
      const plain: SavedAnswer = {
        text: "Found it.",
        final: true,
        cut: false,
        outcome: "success",
        error: null,
      };
      const firing: SavedAnswer = { text: "Half done.", final: false, cut: false, limit: "idle" };
      files.saveAnswer(id, firing);
      expect(new RunFiles(root).readAnswer(id)).toEqual(firing);
      const saved: SavedAnswer = { ...plain, limit: "wall" };
      files.saveAnswer(id, saved);
      expect(new RunFiles(root).readAnswer(id)).toEqual(saved);
      files.saveAnswer(id, plain);
      expect(new RunFiles(root).readAnswer(id)).toEqual(plain);
      writeFileSync(
        join(files.folder(id), ANSWER_FILE),
        JSON.stringify({ ...saved, limit: "lunch" }),
      );
      expect(new RunFiles(root).readAnswer(id)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a crash mid run: the next start ends it as interrupted with the last saved answer", async () => {
    const { run, read, world } = await oneRun();
    await run(start(), say(), say(), { kind: "crash" }, tick(1_000));
    const after = await read();
    expect(after).toMatchObject({ state: "failed", reason: "service_ended" });
    expect(after.result?.text).toBe("answer 2");
    expect(after.result?.textFinal).toBeUndefined();
    expect(world.boxes.get(after.id)?.procs).toBe(0);
  });

  /** Containers whose one agent runs until it is killed, and a driver's work. */
  const boxed = (): Containers => {
    let killed: () => void = () => undefined;
    const exited = new Promise<AgentExit>((resolve) => {
      killed = () => {
        resolve({ code: null, signal: "SIGTERM" });
      };
    });
    return {
      ...refusing,
      start: (spec) =>
        Promise.resolve({
          name: spec.name,
          pid: 4242,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exited,
        }),
      kill: () => {
        killed();
        return Promise.resolve();
      },
    };
  };
  const workOf = (more: Partial<Work>): Work => ({
    ok: false,
    outcome: "no_result",
    nativeId: null,
    text: null,
    textCut: false,
    textFinal: false,
    error: null,
    usage: null,
    appTools: null,
    declined: 0,
    permissionDenials: 0,
    ...more,
  });

  test("a service that closes while the agent writes its answer saves the words so far for the next start", async () => {
    const { host, id, saved, machine, files } = await bareHost({ containers: boxed() });
    let opened: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      opened = resolve;
    });
    // An agent that said one whole message and is writing the next: its driver has the words.
    const writing: OpenDriver = (_pipes, report) => {
      opened();
      report({ kind: "answer", text: "Looking.", final: false, cut: false });
      let settle: (work: Work) => void = () => undefined;
      const settled = new Promise<Work>((resolve) => {
        settle = resolve;
      });
      return {
        settled,
        interrupt: () => false,
        close: () => undefined,
        ended: () => {
          settle(workOf({ text: "The export drops" }));
        },
      };
    };
    void host.start(id, () =>
      Promise.resolve({ command: "codex", args: [], cwd: ".", env: {}, open: writing }),
    );
    await open;
    expect(saved.get(id)).toMatchObject({ text: "Looking." });
    await host.close();
    expect(saved.get(id)).toEqual({ text: "The export drops", final: false, cut: false });
    await new RunHost({ machine, containers: refusing, files }).recover();
    expect(await machine.read(id)).toMatchObject({
      state: "failed",
      reason: "service_ended",
      result: { text: "The export drops" },
    });
  });

  test("a service that closes after the agent's work settled, before its end was recorded: the next start records the work's own end", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host, id, machine, files } = await bareHost({
      containers: boxed(),
      // The `running` commit is slow: the run's end waits behind it when the service closes.
      wrap: (store) => ({
        createRun: (input, request) => store.createRun(input, request),
        replayedRun: (request) => store.replayedRun(request),
        readRun: (run) => store.readRun(run),
        openWork: (machine) => store.openWork(machine),
        transitionRun: async (run, seen, next, patch) => {
          if (next === "running") await held;
          return store.transitionRun(run, seen, next, patch);
        },
      }),
    });
    let opened: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const answer = "The export drops the last row.";
    const answered: OpenDriver = () => {
      opened();
      return {
        settled: Promise.resolve(
          workOf({ ok: true, outcome: "success", text: answer, textFinal: true }),
        ),
        interrupt: () => false,
        close: () => undefined,
        ended: () => undefined,
      };
    };
    void host.start(id, () =>
      Promise.resolve({ command: "codex", args: [], cwd: ".", env: {}, open: answered }),
    );
    await open;
    await host.close();
    release();
    await new RunHost({ machine, containers: refusing, files }).recover();
    expect(await machine.read(id)).toMatchObject({
      state: "succeeded",
      result: { outcome: "success", text: answer, textFinal: true },
    });
  });

  test("after a restart, a run is asked about as its record says it started: a group is counted, a run without one is never confirmed ended, and neither is one whose record does not say", async () => {
    // A group that holds nothing by any name: what a job helper says of a run it never held.
    const group: Containers = { ...refusing, kind: () => Promise.resolve("job" as const) };
    const cases = [
      { held: "job", cleanup: "confirmed" },
      { held: "tree", cleanup: "ended_found" },
      { held: undefined, cleanup: "ended_found" },
    ] as const;
    for (const { held, cleanup } of cases) {
      const { id, machine, files } = await bareHost({ containers: refusing });
      await machine.begin(id, held === undefined ? {} : { container: held });
      await machine.started(id, 4242, Date.UTC(2026, 10, 16));
      await machine.cancel(id);
      files.saveAnswer(id, { text: "Half done.", final: false, cut: false });
      const containers = new FallbackContainers(group, new UngroupedContainers(), () =>
        Promise.resolve(true),
      );
      await new RunHost({ machine, containers, files }).recover();
      expect(await machine.read(id), String(held)).toMatchObject({
        state: "cancelled",
        result: { text: "Half done.", cleanup },
      });
    }
  });

  test("a run records how its processes start before its agent starts, and starts so", async () => {
    const starts: string[] = [];
    const box = (name: "group" | "tree"): Containers => ({
      ...refusing,
      kind: () => Promise.resolve(name === "tree" ? "tree" : "job"),
      start: (spec) => {
        starts.push(`${name}: ${String(spec.kind)}`);
        return Promise.reject(new Error("not here"));
      },
    });
    const containers = new FallbackContainers(box("group"), box("tree"), () =>
      Promise.resolve(false),
    );
    const { host, id, machine } = await bareHost({ containers });
    let recorded: unknown;
    await host.start(id, async () => {
      recorded = (await machine.read(id))?.evidence.container;
      return { command: "agent", args: [], cwd: ".", env: {} };
    });
    await host.ended(id);
    expect([recorded, starts]).toEqual(["tree", ["tree: tree"]]);
  });

  test("a crash after a Stop: the next start ends the run cancelled", async () => {
    const { run, read } = await oneRun();
    await run(start("ok", false), say(true), STOP, { kind: "crash" }, tick(1_000));
    const after = await read();
    expect(after.state).toBe("cancelled");
    expect(after.result?.text).toBe("answer 1");
  });

  test("without a process group, Stop ends the agent even when its tree cannot be walked, and the run is called ended only once the agent is gone", async () => {
    const containers = new UngroupedContainers({ taskkill: join(tmpdir(), "no-taskkill.exe") });
    const { host, id, machine } = await bareHost({
      containers,
      times: { stopGraceMs: 200, closeMs: 200, settleMs: 0, drainMs: 200 },
    });
    const token = newToken();
    try {
      void host.start(id, () => standInSpec(id, "ignore-stop", token));
      await waitForCensus(token, (pids) => pids.length === 2);
      const agent = (await machine.read(id))?.evidence.pid;
      await host.stop(id);
      const after = await host.ended(id);
      expect(after).toMatchObject({ state: "cancelled", result: { cleanup: "ended_found" } });
      expect(census(token)).not.toContain(agent);
    } finally {
      // What nothing could find of its tree: this test's own stand-in.
      for (const left of census(token)) {
        try {
          process.kill(left);
        } catch {
          // Gone meanwhile.
        }
      }
    }
  });

  test("without a process group, an agent that outlives its Stop leaves the run unknown, never ended; once it is gone, End by force settles it and says so", async () => {
    let alive = true;
    let ends = false;
    let exit: (exit: AgentExit) => void = () => undefined;
    const exited = new Promise<AgentExit>((resolve) => {
      exit = resolve;
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const end = (): void => {
      if (!alive || !ends) return;
      alive = false;
      stdout.end();
      stderr.end();
      exit({ code: null, signal: "SIGKILL" });
    };
    const confirm = (): Promise<Confirmation> =>
      Promise.resolve(
        alive ? { state: "occupied", detail: "the agent still runs" } : { state: "unconfirmable" },
      );
    const tree: Containers = {
      probe: () => Promise.resolve({ available: true, kind: "tree" }),
      kind: () => Promise.resolve("tree" as const),
      start: (spec) =>
        Promise.resolve({
          name: spec.name,
          pid: 4242,
          stdin: new PassThrough(),
          stdout,
          stderr,
          exited,
        }),
      interrupt: () => Promise.resolve(false),
      kill: () => {
        end();
        return Promise.resolve();
      },
      confirmEmpty: confirm,
      recover: () => {
        end();
        return confirm();
      },
    };
    const { host, id, machine } = await bareHost({
      containers: tree,
      times: { stopGraceMs: 10, closeMs: 10, settleMs: 0, confirmMs: 10, drainMs: 10 },
    });
    void host.start(id, () => ({ command: "agent", args: [], cwd: ".", env: {} }));
    await waitUntil(async () => (await machine.read(id))?.state === "running");
    await host.stop(id);
    expect(await host.ended(id)).toMatchObject({ state: "unknown", reason: "stop_timed_out" });
    expect(host.hosted()).toEqual([id]);
    expect(await host.forceEnd(id)).toMatchObject({ state: "unknown" });
    ends = true;
    expect(await host.forceEnd(id)).toMatchObject({
      state: "cancelled",
      result: { cleanup: "ended_found" },
    });
    expect(host.hosted()).toEqual([]);
  });

  test("a crash while a process refuses to end: unknown at the next start, settled once it ends", async () => {
    const { run, read } = await oneRun();
    await run(start(), say(), { kind: "fork", pick: 0 }, { kind: "stick", pick: 0 });
    await run({ kind: "crash" }, tick(1_000));
    expect(await read()).toMatchObject({ state: "unknown", reason: "stop_timed_out" });
    await run({ kind: "release", pick: 0 }, { kind: "forceEnd", pick: 0 }, tick(1_000));
    expect(await read()).toMatchObject({ state: "failed", reason: "service_ended" });
  });

  test("an agent that answers and exits while its start is being recorded keeps its answer", async () => {
    const containers = childContainers();
    const { host, id, saved } = await bareHost({
      containers,
      // The `running` commit lands only after the agent exited and its pipes were left alone.
      wrap: (store) => ({
        createRun: (input, request) => store.createRun(input, request),
        replayedRun: (request) => store.replayedRun(request),
        readRun: (run) => store.readRun(run),
        openWork: (machine) => store.openWork(machine),
        transitionRun: async (run, seen, next, patch) => {
          if (next === "running") {
            await containers.exited;
            await sleep(300);
          }
          return store.transitionRun(run, seen, next, patch);
        },
      }),
    });
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done at once.",
    });
    await host.start(id, () => ({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(`${line}\n`)})`],
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
    }));
    const after = await host.ended(id);
    expect(after).toMatchObject({ state: "succeeded", result: { text: "Done at once." } });
    expect(saved.get(id)?.text).toBe("Done at once.");
  });

  test("what the command says the run started with is recorded with its PID", async () => {
    const { host, id } = await bareHost({ containers: childContainers() });
    const home = "a".repeat(64);
    await host.start(id, () => ({
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      evidence: { home },
    }));
    const after = await host.ended(id);
    expect(after?.evidence.home).toBe(home);
    expect(after?.evidence.pid).toBeGreaterThan(0);
  });

  test("Stop while the agent's command is still being prepared: cancelled at once, and nothing starts", async () => {
    let starts = 0;
    const { host, id } = await bareHost({
      containers: {
        ...refusing,
        start: () => {
          starts += 1;
          return Promise.reject(new Error("unexpected"));
        },
      },
    });
    await host.start(id, never);
    expect((await host.stop(id))?.state).toBe("cancelling");
    expect((await host.ended(id))?.state).toBe("cancelled");
    expect(starts).toBe(0);
  });

  test("Stop at each stage of a start, however late the store answers: nothing reaches the agent, and a Stop the store takes cancels the run", async () => {
    // Where the start is when Stop comes, how far it got when the store answered, and whether
    // the store took the Stop.
    const cases = [
      { at: "queued", taken: "after the start was asked", fails: false },
      { at: "queued", taken: "after the start was asked", fails: true },
      { at: "preparing", taken: "at once", fails: false },
      { at: "preparing", taken: "after the command", fails: false },
      { at: "preparing", taken: "after the container", fails: false },
      { at: "spawning", taken: "at once", fails: false },
      { at: "spawning", taken: "after the container", fails: false },
    ] as const;
    const turns = async () => {
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    for (const { at, taken, fails } of cases) {
      const label = `${at}, ${taken}${fails ? ", refused" : ""}`;
      let take: () => void = () => undefined;
      const held = new Promise<void>((resolve, reject) => {
        take = fails
          ? () => {
              reject(new Error("The disk is full"));
            }
          : resolve;
      });
      let ready: ((command: AgentCommand) => void) | undefined;
      let spawn: (() => void) | undefined;
      let starts = 0;
      let input = "";
      let asked = false;
      const { host, id } = await bareHost({
        containers: {
          ...refusing,
          start: (spec) => {
            starts += 1;
            const stdin = new PassThrough();
            stdin.on("data", (chunk: Buffer) => {
              input += chunk.toString("utf8");
            });
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const exited = new Promise<AgentExit>((resolve) => {
              stdin.once("finish", () => {
                stdout.end();
                stderr.end();
                resolve({ code: 0, signal: null });
              });
            });
            return new Promise((resolve) => {
              spawn = () => {
                resolve({ name: spec.name, pid: 4242, stdin, stdout, stderr, exited });
              };
            });
          },
        },
        wrap: (store) => ({
          createRun: (input, request) => store.createRun(input, request),
          replayedRun: (request) => store.replayedRun(request),
          readRun: (run) => store.readRun(run),
          openWork: (machine) => store.openWork(machine),
          transitionRun: async (run, seen, next, patch) => {
            // The Stop's own write: `cancelling`, or `cancelled` for a run still queued.
            if (!asked && (next === "cancelling" || next === "cancelled") && taken !== "at once") {
              asked = true;
              await held;
            }
            return store.transitionRun(run, seen, next, patch);
          },
        }),
      });
      const begin = () =>
        host.start(
          id,
          () =>
            new Promise<AgentCommand>((resolve) => {
              ready = resolve;
            }),
        );
      if (at !== "queued") await begin();
      await turns();
      const command: AgentCommand = {
        command: "claude",
        args: [],
        cwd: ".",
        env: {},
        open: claudeDriver({ request: "Delete the old exports." }),
      };
      if (at === "spawning") {
        ready?.(command);
        await turns();
        expect(starts, at).toBe(1);
      }
      const stopped = host.stop(id);
      stopped.catch(() => undefined);
      // A queued run's start is asked while the store holds the Stop.
      const late = at === "queued" ? begin() : undefined;
      if (taken !== "at once") {
        // The start goes as far as it goes before the store answers.
        ready?.(command);
        await turns();
        if (taken === "after the container") {
          spawn?.();
          await turns();
        }
        take();
      }
      if (fails) await expect(stopped, label).rejects.toThrow("The disk is full");
      else await stopped;
      await late;
      ready?.(command);
      await turns();
      spawn?.();
      const after = await host.ended(id);
      expect(after?.state, label).toBe(fails ? "failed" : "cancelled");
      expect(input, label).toBe("");
      if (at !== "spawning") expect(starts, label).toBe(0);
    }
  });

  test("a Stop the store does not take still stops the run", async () => {
    let starts = 0;
    const { host, id } = await bareHost({
      containers: {
        ...refusing,
        start: () => {
          starts += 1;
          return Promise.reject(new Error("unexpected"));
        },
      },
      wrap: (store) => ({
        createRun: (input, request) => store.createRun(input, request),
        replayedRun: (request) => store.replayedRun(request),
        readRun: (run) => store.readRun(run),
        openWork: (machine) => store.openWork(machine),
        transitionRun: (run, seen, next, patch) =>
          next === "cancelling"
            ? Promise.reject(new Error("The disk is full"))
            : store.transitionRun(run, seen, next, patch),
      }),
    });
    await host.start(id, never);
    await expect(host.stop(id)).rejects.toThrow("The disk is full");
    expect(await host.ended(id)).toMatchObject({ state: "failed", reason: "spawn_failed" });
    expect(starts).toBe(0);
  });

  test("a command that is never ready fails the run after the start time", async () => {
    const { host, id } = await bareHost({ containers: refusing, times: { startMs: 50 } });
    await host.start(id, never);
    expect(await host.ended(id)).toMatchObject({ state: "failed", reason: "start_timed_out" });
  });

  test("a store that refuses the end for a long time records it once it takes it again", async () => {
    let mono = 0;
    const { host, id } = await bareHost({
      containers: refusing,
      elapsed: () => mono,
      // Each wait passes at once on this clock.
      wait: (ms, signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) return;
          mono += ms;
          setImmediate(resolve);
        }),
      wrap: (store) => ({
        createRun: (input, request) => store.createRun(input, request),
        replayedRun: (request) => store.replayedRun(request),
        readRun: (run) => store.readRun(run),
        openWork: (machine) => store.openWork(machine),
        transitionRun: (run, seen, next, patch) =>
          next === "failed" && mono < 60 * 60_000
            ? Promise.reject(new Error("The disk is full"))
            : store.transitionRun(run, seen, next, patch),
      }),
    });
    await host.start(id, () => ({ command: "agent", args: [], cwd: "/", env: {} }));
    expect(await host.ended(id)).toMatchObject({ state: "failed", reason: "spawn_failed" });
    expect(mono).toBeGreaterThanOrEqual(60 * 60_000);
  });

  test("endMove: a final run stays; an accepted Stop makes every confirmed end cancelled", async () => {
    const { run, read } = await oneRun();
    await run(start("ok", false), STOP);
    const stopping = await read();
    const result = {
      ok: true,
      outcome: "success" as const,
      exitCode: 0,
      signal: null,
      nativeId: null,
      text: "Done.",
      error: null,
      usage: null,
      appTools: null,
      declined: 0,
      permissionDenials: 0,
      durationMs: 1,
    };
    expect(endMove(stopping, { kind: "exited", result })).toEqual({
      next: "cancelled",
      patch: { result },
    });
    expect(endMove(stopping, { kind: "not_confirmed" })).toEqual({
      next: "unknown",
      patch: { reason: "stop_timed_out" },
    });
    await run(tick(11_000));
    const cancelled = await read();
    expect(cancelled.state).toBe("cancelled");
    expect(endMove(cancelled, { kind: "exited", result })).toBeUndefined();
    expect(endMove(cancelled, { kind: "not_confirmed" })).toBeUndefined();
  });
});
