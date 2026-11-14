// The run state machine's rules, one by one (A4 3.11.2, 3.11.8, 3.11.9): a cancel in every state,
// the spawn and the claim, live reports, the sweep's windows, and restart recovery from what the
// shim left. In memory, with the execution store's reference backend. Fixture data only.
import {
  RUN_LIMITS,
  RUN_STATES,
  type RunRecord,
  type RunResult,
  type RunState,
} from "@tasks/contracts/runs";
import type { RunStore } from "@tasks/launch/execution-store";
import { MemoryDurable, MemoryExecutionStore } from "@tasks/launch/memory-store";
import { describe, expect, test } from "vitest";
import {
  finalFor,
  RUN_CLAIM_WINDOW_MS,
  RUN_STOP_TIMEOUT_MS,
  RunMachine,
  type RunObservation,
} from "../src/machine.ts";

const MACHINE = "m_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const TASK = "t_0000000000000000000000000a";

const OK: RunResult = {
  ok: true,
  outcome: "success",
  exitCode: 0,
  signal: null,
  nativeId: "thread-1",
  text: "Done.",
  error: null,
  usage: null,
  appTools: null,
  declined: 0,
  permissionDenials: 0,
  durationMs: 1_000,
};

let requests = 0;

/** A machine on fresh memory, its clocks, and what recovery sees. */
function bench(observe: (run: RunRecord) => RunObservation = () => ({ kind: "pending" })) {
  const clock = { now: Date.UTC(2026, 10, 13, 9, 0, 0), mono: 0 };
  const durable = new MemoryDurable(() => clock.now);
  const make = () =>
    new RunMachine({
      store: new MemoryExecutionStore(durable),
      machine: MACHINE,
      recovery: { observe: (run) => Promise.resolve(observe(run)) },
      now: () => clock.now,
      elapsed: () => clock.mono,
    });
  const machine = make();
  const store = new MemoryExecutionStore(durable);
  const queue = () =>
    machine.queue(
      {
        task: TASK,
        routine: null,
        instance: "codex-work",
        adapter: "claude-print",
        place: null,
        request: "Fix the export.",
        briefHash: "0a1b2c3d".repeat(8),
        permission: "auto-edit",
        limits: RUN_LIMITS.task,
      },
      `machine-test-${String((requests += 1)).padStart(8, "0")}`,
    );
  const spawned = () => Promise.resolve({ kind: "spawned" as const });
  /** A run moved to `state` through the machine, as the service and a shim would. */
  const runIn = async (state: RunState): Promise<RunRecord> => {
    const queued = await queue();
    const id = queued.id;
    const get = async () => (await store.readRun(id)) ?? queued;
    if (state === "queued") return queued;
    await machine.start(id, spawned);
    if (state === "starting") return get();
    await machine.claim(id, "claim-1", () => Promise.resolve());
    if (state === "cancelled") {
      await machine.cancel(id, () => Promise.resolve());
      await machine.report(id, { kind: "exited", exit: { result: OK } });
      return get();
    }
    await machine.report(id, { kind: "started", pid: 4242, pidStartedAt: clock.now });
    if (state === "running") return get();
    const run = await get();
    const to = async (next: RunState, patch = {}) =>
      store.transitionRun(id, { state: run.state, version: run.version }, next, patch);
    switch (state) {
      case "waiting_for_input":
        return to("waiting_for_input");
      case "cancelling":
        await machine.cancel(id, () => Promise.resolve());
        return get();
      case "reconciling":
        return to("reconciling");
      case "succeeded":
        await machine.report(id, { kind: "exited", exit: { result: OK } });
        return get();
      case "failed":
        return to("failed", { reason: "agent_error" });
      case "timed_out":
        return to("timed_out", { reason: "wall" });
      case "unknown":
        await to("reconciling");
        return store.transitionRun(
          id,
          { state: "reconciling", version: (await get()).version },
          "unknown",
          { reason: "lost" },
        );
      default:
        throw new Error(`no path to ${String(state)}`);
    }
  };
  return { clock, durable, machine, make, queue, runIn, spawned, store };
}

describe("[A4.5.run.machine] the run machine's rules", () => {
  test("a cancel in every state: queued and unclaimed runs end at once, a process's run stops through cancelling, the rest stay", async () => {
    const expected: Record<RunState, { state: RunState; stops: number }> = {
      queued: { state: "cancelled", stops: 0 },
      starting: { state: "cancelled", stops: 0 },
      running: { state: "cancelling", stops: 1 },
      waiting_for_input: { state: "cancelling", stops: 1 },
      // A second Stop sends the stop again: the record already says cancelling.
      cancelling: { state: "cancelling", stops: 1 },
      reconciling: { state: "reconciling", stops: 0 },
      succeeded: { state: "succeeded", stops: 0 },
      failed: { state: "failed", stops: 0 },
      timed_out: { state: "timed_out", stops: 0 },
      cancelled: { state: "cancelled", stops: 0 },
      unknown: { state: "unknown", stops: 0 },
    };
    for (const state of RUN_STATES) {
      const b = bench();
      const run = await b.runIn(state);
      expect(run.state, state).toBe(state);
      let stops = 0;
      const after = await b.machine.cancel(run.id, () => {
        stops += 1;
        return Promise.resolve();
      });
      expect(after?.state, state).toBe(expected[state].state);
      expect(stops, state).toBe(expected[state].stops);
      if (after?.state === "cancelling") {
        // The process ends: cancelled, whatever its outcome.
        const ended = await b.machine.report(run.id, { kind: "exited", exit: { result: OK } });
        expect(ended).toMatchObject({ state: "cancelled", result: OK });
      }
    }
    // A claimed starting run stops through cancelling too, and keeps the agent's PID for the stop.
    const b = bench();
    const run = await b.queue();
    await b.machine.start(run.id, b.spawned);
    await b.machine.claim(run.id, "claim-1", () => Promise.resolve());
    expect((await b.machine.cancel(run.id, () => Promise.resolve()))?.state).toBe("cancelling");
    const started = await b.machine.report(run.id, {
      kind: "started",
      pid: 77,
      pidStartedAt: b.clock.now,
    });
    expect(started).toMatchObject({ state: "cancelling", evidence: { pid: 77 } });
  });

  test("a claim is committed before its reply, once, and never on a run that is not starting", async () => {
    const b = bench();
    const run = await b.queue();
    expect(await b.machine.claim(run.id, "claim-0", () => Promise.resolve())).toBeUndefined();
    await b.machine.start(run.id, b.spawned);
    const seen: (string | undefined)[] = [];
    const reply = async (r: RunRecord) => {
      seen.push((await b.store.readRun(r.id))?.evidence.claim);
    };
    expect((await b.machine.claim(run.id, "claim-1", reply))?.evidence.claim).toBe("claim-1");
    expect(seen).toEqual(["claim-1"]);
    expect(await b.machine.claim(run.id, "claim-1", reply)).toBeUndefined();
    expect(await b.machine.claim(run.id, "claim-2", reply)).toBeUndefined();
    expect(seen).toEqual(["claim-1"]);
    // A cancelled run takes no claim.
    const other = await b.queue();
    await b.machine.start(other.id, b.spawned);
    await b.machine.cancel(other.id, () => Promise.resolve());
    expect(await b.machine.claim(other.id, "claim-3", reply)).toBeUndefined();
  });

  test("a spawn the OS refused fails the run, a spawn without an answer waits for the claim window", async () => {
    const b = bench();
    const refused = await b.queue();
    const after = await b.machine.start(refused.id, () => Promise.resolve({ kind: "refused" }));
    expect(after).toMatchObject({ state: "failed", reason: "spawn_failed" });
    const silent = await b.queue();
    expect((await b.machine.start(silent.id, () => Promise.reject(new Error("lost"))))?.state).toBe(
      "starting",
    );
    // A second start spawns nothing.
    let spawns = 0;
    await b.machine.start(silent.id, () => {
      spawns += 1;
      return Promise.resolve({ kind: "spawned" });
    });
    expect(spawns).toBe(0);
    b.clock.mono += RUN_CLAIM_WINDOW_MS - 1;
    expect(await b.machine.sweep()).toEqual([]);
    b.clock.mono += 1;
    expect(await b.machine.sweep()).toMatchObject([{ state: "failed", reason: "not_claimed" }]);
  });

  test("reports: started, evidence, a failed check, and exits that end in each final state", async () => {
    const b = bench();
    const running = await b.runIn("running");
    expect(running).toMatchObject({ evidence: { claim: "claim-1", pid: 4242 } });
    const native = await b.machine.report(running.id, {
      kind: "evidence",
      evidence: { native_id: "thread-9" },
    });
    expect(native?.evidence.native_id).toBe("thread-9");
    const timed = await b.machine.report(running.id, {
      kind: "exited",
      exit: { result: { ...OK, ok: false, outcome: "no_result" }, timeout: "idle" },
    });
    expect(timed).toMatchObject({ state: "timed_out", reason: "idle" });
    // An exit report from starting goes through reconciling to its final state.
    const starting = await b.queue();
    await b.machine.start(starting.id, b.spawned);
    await b.machine.claim(starting.id, "claim-1", () => Promise.resolve());
    const quick = await b.machine.report(starting.id, {
      kind: "exited",
      exit: { result: { ...OK, ok: false, outcome: "no_output" } },
    });
    expect(quick).toMatchObject({ state: "failed", reason: "no_output" });
    expect(Object.keys(quick?.at ?? {})).toContain("reconciling");
    const check = await b.queue();
    await b.machine.start(check.id, b.spawned);
    await b.machine.claim(check.id, "claim-1", () => Promise.resolve());
    expect(await b.machine.report(check.id, { kind: "verify_failed" })).toMatchObject({
      state: "failed",
      reason: "verify_failed",
    });
    // An exit report for a run no shim claimed is not its own.
    const unclaimed = await b.queue();
    await b.machine.start(unclaimed.id, b.spawned);
    expect(
      (await b.machine.report(unclaimed.id, { kind: "exited", exit: { result: OK } }))?.state,
    ).toBe("starting");
  });

  test("a stop that does not end the process in time is unknown, and its exit later settles it cancelled", async () => {
    const b = bench();
    const run = await b.runIn("cancelling");
    b.clock.mono += RUN_STOP_TIMEOUT_MS;
    expect(await b.machine.sweep()).toMatchObject([{ state: "unknown", reason: "stop_timed_out" }]);
    const settled = await b.machine.report(run.id, {
      kind: "exited",
      exit: { result: { ...OK, ok: false, outcome: "interrupted" } },
    });
    expect(settled).toMatchObject({ state: "cancelled" });
  });

  test("restart recovery: a live shim waits, a shim gone with exit.json finalizes, one gone without is unknown; an unclaimed start waits out its window on the wall clock", async () => {
    const seen = new Map<string, RunObservation>();
    const b = bench((run) => seen.get(run.id) ?? { kind: "pending" });
    const live = await b.runIn("running");
    const done = await b.runIn("running");
    const gone = await b.runIn("running");
    const stopping = await b.runIn("cancelling");
    const unclaimed = await b.runIn("starting");
    const queued = await b.runIn("queued");
    seen.set(done.id, { kind: "exited", exit: { result: OK } });
    seen.set(gone.id, { kind: "lost" });
    seen.set(stopping.id, {
      kind: "exited",
      exit: { result: { ...OK, ok: false, outcome: "interrupted" } },
    });
    // A new service: no marks of the old one.
    const restarted = b.make();
    const after = new Map((await restarted.recover()).map((r) => [r.id, r]));
    expect(after.get(live.id)?.state).toBe("running");
    expect(after.get(done.id)).toMatchObject({ state: "succeeded", result: OK });
    expect(after.get(done.id)?.at.reconciling).toBeDefined();
    expect(after.get(gone.id)).toMatchObject({ state: "unknown", reason: "lost" });
    expect(after.get(stopping.id)?.state).toBe("cancelled");
    expect(after.get(unclaimed.id)?.state).toBe("starting");
    expect(after.get(queued.id)?.state).toBe("queued");
    // The wall clock decides for a run another service started: either way of the window.
    b.clock.now -= RUN_CLAIM_WINDOW_MS;
    expect((await restarted.recover()).find((r) => r.id === unclaimed.id)).toMatchObject({
      state: "failed",
      reason: "not_claimed",
    });
  });

  test("restart recovery after the stop's time passed: exit.json settles a cancelling run cancelled, a gone shim is lost, a live one times out", async () => {
    const seen = new Map<string, RunObservation>();
    const b = bench((run) => seen.get(run.id) ?? { kind: "pending" });
    const exited = await b.runIn("cancelling");
    const gone = await b.runIn("cancelling");
    const live = await b.runIn("cancelling");
    seen.set(exited.id, {
      kind: "exited",
      exit: { result: { ...OK, ok: false, outcome: "interrupted" } },
    });
    seen.set(gone.id, { kind: "lost" });
    // The service was down past the stop's time; the shim ended meanwhile and wrote exit.json.
    b.clock.now += RUN_STOP_TIMEOUT_MS + 1_000;
    const after = new Map((await b.make().recover()).map((r) => [r.id, r]));
    expect(after.get(exited.id)).toMatchObject({ state: "cancelled", reason: null });
    expect(after.get(exited.id)?.result?.outcome).toBe("interrupted");
    expect(after.get(gone.id)).toMatchObject({ state: "unknown", reason: "lost" });
    expect(after.get(live.id)).toMatchObject({ state: "unknown", reason: "stop_timed_out" });
  });

  test("the stop's time counts from the first Stop: another Stop after a restart does not start it again", async () => {
    const b = bench();
    const run = await b.runIn("cancelling");
    const restarted = b.make();
    b.clock.now += RUN_STOP_TIMEOUT_MS - 1_000;
    b.clock.mono += RUN_STOP_TIMEOUT_MS - 1_000;
    let stops = 0;
    const again = await restarted.cancel(run.id, () => {
      stops += 1;
      return Promise.resolve();
    });
    expect(again?.state).toBe("cancelling");
    expect(stops).toBe(1);
    b.clock.now += 2_000;
    b.clock.mono += 2_000;
    expect((await restarted.sweep()).map((r) => [r.id, r.state, r.reason])).toEqual([
      [run.id, "unknown", "stop_timed_out"],
    ]);
  });

  test("a run whose stop timed out stays on recovery's list until its exit.json settles it or its shim is found gone", async () => {
    const seen = new Map<string, RunObservation>();
    const b = bench((run) => seen.get(run.id) ?? { kind: "pending" });
    const timedOut = async (): Promise<RunRecord> => {
      const run = await b.runIn("cancelling");
      b.clock.mono += RUN_STOP_TIMEOUT_MS;
      await b.machine.sweep();
      const after = await b.store.readRun(run.id);
      expect(after).toMatchObject({ state: "unknown", reason: "stop_timed_out" });
      return after ?? run;
    };
    const exited = await timedOut();
    const gone = await timedOut();
    const live = await timedOut();
    // The service stops; one shim then writes exit.json and ends, another ends without one.
    seen.set(exited.id, {
      kind: "exited",
      exit: { result: { ...OK, ok: false, outcome: "interrupted" } },
    });
    seen.set(gone.id, { kind: "lost" });
    const restarted = b.make();
    const after = new Map((await restarted.recover()).map((r) => [r.id, r]));
    expect(after.get(exited.id)).toMatchObject({ state: "cancelled", reason: null });
    expect(after.get(exited.id)?.result?.outcome).toBe("interrupted");
    expect(after.get(exited.id)?.at.reconciling).toBeDefined();
    expect(after.get(gone.id)).toMatchObject({ state: "unknown", reason: "lost" });
    expect(after.get(live.id)).toMatchObject({ state: "unknown", reason: "stop_timed_out" });
    // Only the live one is still listed: a lost run and a settled one have nothing more to wait for.
    const open = (await b.store.openWork(MACHINE)).runs.map((r) => r.id);
    expect(open).toContain(live.id);
    expect(open).not.toContain(gone.id);
    expect(open).not.toContain(exited.id);
  });

  test("a result the store refuses is left out, never the transition: a damaged report still settles its run", async () => {
    const b = bench();
    // A cost no store keeps, an outcome that names none of A4's reasons, a timeout of no kind.
    const costly = await b.runIn("running");
    const settled = await b.machine.report(costly.id, {
      kind: "exited",
      exit: { result: { ...OK, usage: { costUsd: 1e300 } } },
    });
    expect(settled).toMatchObject({ state: "succeeded", result: null });
    const strange = await b.runIn("running");
    const failed = await b.machine.report(strange.id, {
      kind: "exited",
      exit: {
        result: { ...OK, ok: false, outcome: "lost_track" as RunResult["outcome"] },
        timeout: "forever" as "wall",
      },
    });
    expect(failed).toMatchObject({ state: "failed", reason: "no_result", result: null });
    // The same from exit.json after a restart.
    const seen = new Map<string, RunObservation>();
    const c = bench((run) => seen.get(run.id) ?? { kind: "pending" });
    const gone = await c.runIn("running");
    seen.set(gone.id, { kind: "exited", exit: { result: { ...OK, durationMs: 1.5 } } });
    const after = (await c.make().recover()).find((r) => r.id === gone.id);
    expect(after).toMatchObject({ state: "succeeded", result: null });
  });

  test("a run left reconciling by a write that failed late is settled by the next sweep, not the next restart", async () => {
    const durable = new MemoryDurable(() => Date.UTC(2026, 10, 13, 9, 0, 0));
    const memory = new MemoryExecutionStore(durable);
    // The final write hangs past its deadline, then fails: recovery's call ends without it.
    let fail: ((error: Error) => void) | undefined;
    let hang = true;
    const store: RunStore = {
      createRun: (input, id) => memory.createRun(input, id),
      readRun: (id) => memory.readRun(id),
      openWork: (machine) => memory.openWork(machine),
      transitionRun: (id, expect, next, patch) =>
        hang && next === "succeeded"
          ? new Promise((_resolve, reject) => {
              fail = reject;
            })
          : memory.transitionRun(id, expect, next, patch),
    };
    let release: (() => void) | undefined;
    const machine = new RunMachine({
      store,
      machine: MACHINE,
      recovery: { observe: () => Promise.resolve({ kind: "exited", exit: { result: OK } }) },
      deadlines: { store: 1, step: 1 },
      // The store's deadline passes when the test says so.
      wait: (_ms, signal) =>
        new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener("abort", () => undefined);
        }),
    });
    const live = new RunMachine({
      store: memory,
      machine: MACHINE,
      recovery: { observe: () => Promise.resolve({ kind: "pending" }) },
    });
    const run = await live.queue(
      {
        task: TASK,
        routine: null,
        instance: "codex-work",
        adapter: "codex-exec",
        place: null,
        request: "Fix the export.",
        briefHash: "0a1b2c3d".repeat(8),
        permission: "auto-edit",
        limits: RUN_LIMITS.task,
      },
      "machine-test-late-write-01",
    );
    await live.start(run.id, () => Promise.resolve({ kind: "spawned" }));
    await live.claim(run.id, "claim-1", () => Promise.resolve());
    await live.report(run.id, { kind: "started", pid: 4242, pidStartedAt: 1 });
    const recovering = machine.recover();
    // Let every store call but the hanging one answer before its deadline.
    for (let i = 0; i < 50 && fail === undefined; i += 1) await Promise.resolve();
    release?.();
    expect(await recovering).toEqual([]);
    fail?.(new Error("The storage worker restarted"));
    expect((await memory.readRun(run.id))?.state).toBe("reconciling");
    hang = false;
    const swept = await machine.sweep();
    expect(swept.map((r) => [r.id, r.state])).toEqual([[run.id, "succeeded"]]);
    expect(durable.runs.get(run.id)?.result).toEqual(OK);
  });

  test("finalFor: cancelled after a stop, timed out at a limit, succeeded on success, failed with the outcome", () => {
    const run = { at: {} } as RunRecord;
    expect(finalFor(run, { result: OK })).toEqual({ next: "succeeded", patch: { result: OK } });
    expect(finalFor({ at: { cancelling: 1 } } as RunRecord, { result: OK }).next).toBe("cancelled");
    expect(finalFor(run, { result: OK, timeout: "wall" }).patch?.reason).toBe("wall");
    expect(finalFor(run, { result: { ...OK, ok: false } }).patch?.reason).toBe("exit_status");
    expect(
      finalFor(run, { result: { ...OK, ok: false, outcome: "max_turns" } }).patch?.reason,
    ).toBe("max_turns");
  });
});
