// The run host's rules one by one, on the model world's fake containers and clock (host-world.ts):
// Stop before the agent's PID, while it runs and after it exited, the start time, the run's limits,
// a container that refuses to empty and End by force, and the next start after a crash.
import type { RunRecord } from "@tasks/contracts/runs";
import { MemoryDurable, MemoryExecutionStore } from "@tasks/launch/memory-store";
import { describe, expect, test } from "vitest";
import { endMove } from "../src/machine.ts";
import { World, type Event } from "./host-world.ts";

const MACHINE = "m_3q7k9d2xw8f4r6t1c5v0b2n8a7";

/** A world with one queued run, and a way to read it. */
async function oneRun(): Promise<{
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

  test("Stop after the agent exited, while what it left is ended: the run is cancelled", async () => {
    const { run, read } = await oneRun();
    await run(start(), say(true), { kind: "fork", pick: 0 }, { kind: "stick", pick: 0 });
    await run({ kind: "exit", pick: 0, code: 0 }, STOP);
    expect((await read()).state).toBe("cancelling");
    // The leftover survives the kill: the run is unknown, and keeps the Stop.
    await run(tick(11_000));
    expect(await read()).toMatchObject({ state: "unknown", reason: "stop_timed_out" });
    await run({ kind: "release", pick: 0 }, { kind: "forceEnd", pick: 0 }, tick(1_000));
    const after = await read();
    expect(after.state).toBe("cancelled");
    expect(after.result?.text).toBe("answer 1");
  });

  test("a container that refuses to empty leaves the run unknown; End by force settles it once it is empty", async () => {
    const { run, read } = await oneRun();
    await run(start(), say(true), { kind: "fork", pick: 0 }, { kind: "stick", pick: 0 });
    await run({ kind: "exit", pick: 0, code: 0 }, tick(11_000));
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

  test("a crash mid run: the next start ends it as interrupted with the last saved answer", async () => {
    const { run, read, world } = await oneRun();
    await run(start(), say(), say(), { kind: "crash" }, tick(1_000));
    const after = await read();
    expect(after).toMatchObject({ state: "failed", reason: "service_ended" });
    expect(after.result?.text).toBe("answer 2");
    expect(after.result?.textFinal).toBeUndefined();
    expect(world.boxes.get(after.id)?.procs).toBe(0);
  });

  test("a crash after a Stop: the next start ends the run cancelled", async () => {
    const { run, read } = await oneRun();
    await run(start("ok", false), say(true), STOP, { kind: "crash" }, tick(1_000));
    const after = await read();
    expect(after.state).toBe("cancelled");
    expect(after.result?.text).toBe("answer 1");
  });

  test("a crash while a process refuses to end: unknown at the next start, settled once it ends", async () => {
    const { run, read } = await oneRun();
    await run(start(), say(), { kind: "fork", pick: 0 }, { kind: "stick", pick: 0 });
    await run({ kind: "crash" }, tick(1_000));
    expect(await read()).toMatchObject({ state: "unknown", reason: "stop_timed_out" });
    await run({ kind: "release", pick: 0 }, { kind: "forceEnd", pick: 0 }, tick(1_000));
    expect(await read()).toMatchObject({ state: "failed", reason: "service_ended" });
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
