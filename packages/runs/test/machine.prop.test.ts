// The Verify line of A7 3.13 M6.01 (A4 5.1 "Run state machine", 5.2): random runs queued,
// started, claimed (the same claim again included), started agents, native IDs, exits with every
// outcome and the shim's timeouts, shims that die without exit.json, cancels in every state, time
// passing, wall clock steps, sweeps, start-up recoveries, and crashes of the service at every
// boundary (a store write or an external step, before or after it takes effect, recovery included)
// with a restart. After every event: no run spawned twice, no agent without a durable claim its
// shim was replied with, every final state matches what the processes did (succeeded only after a
// successful exit and no stop, cancelled only after a stop and on process exit, timed out only at
// the shim's limit, never started only without an agent, lost only once the shim is gone). At the
// end, liveness: once every window has passed and every shim has ended, every run is final or
// still queued. The same model runs on the in-memory store and on the space database.
import fc from "fast-check";
import { MemoryDurable, MemoryExecutionStore } from "@tasks/launch/memory-store";
import { SpaceExecutionStore } from "@tasks/launch";
import { openLaunchSpace } from "@tasks/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { World, type Event } from "./run-model.ts";

const MACHINE = "m_3q7k9d2xw8f4r6t1c5v0b2n8a7";

const pick = fc.nat(3);

const event: fc.Arbitrary<Event> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("queue" as const) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("start" as const),
      pick,
      outcome: fc.constantFrom(
        "spawned" as const,
        "spawned" as const,
        "refused" as const,
        "unknown" as const,
      ),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("claim" as const), pick, same: fc.boolean() }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("agent" as const), pick }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("startFails" as const),
      pick,
      how: fc.constantFrom("verify_failed" as const, "spawn_failed" as const),
      late: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("native" as const), pick }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("exit" as const),
      pick,
      how: fc.constantFrom("ok" as const, "error" as const, "wall" as const, "idle" as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("die" as const), pick }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("cancel" as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("sweep" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("recover" as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("tick" as const),
      ms: fc.constantFrom(1_000, 30_000, 61_000, 121_000),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("step" as const),
      ms: fc.constantFrom(-3_600_000, 3_600_000),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("arm" as const),
      after: fc.integer({ min: 1, max: 6 }),
      late: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("crash" as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("down" as const),
      pick,
      ms: fc.constantFrom(1_000, 61_000, 121_000),
      ends: fc.boolean(),
    }),
  },
);

const events = fc.array(event, { minLength: 4, maxLength: 40, size: "max" });

/**
 * Starting points deep in a run's life, which random events reach only rarely: a run claimed by
 * its shim, then stopped, its stop timed out, its agent started, or its agent ended.
 */
const claimed: Event[] = [
  { kind: "queue" },
  { kind: "start", pick: 0, outcome: "spawned" },
  { kind: "claim", pick: 0, same: false },
];
const stopped: Event[] = [...claimed, { kind: "cancel", pick: 0 }];
const started: Event[] = [...claimed, { kind: "agent", pick: 0 }];
const PREFIXES: Event[][] = [
  claimed,
  stopped,
  [...stopped, { kind: "tick", ms: 61_000 }, { kind: "sweep" }],
  started,
  [...started, { kind: "exit", pick: 0, how: "ok" }],
  [...started, { kind: "exit", pick: 0, how: "wall" }],
];

/** Random events, a fifth of them after one of the starting points. */
const scenario = fc.oneof(
  { weight: 4, arbitrary: events },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.constantFrom(...PREFIXES), events)
      .map(([prefix, rest]) => [...prefix, ...rest]),
  },
);

describe("[A4.5.run.state-machine] the run state machine under cancels in every state and crashes at every boundary", () => {
  test("in memory: one spawn and one claimed agent per run, final states that match the processes, and every run settles", async () => {
    // The states the scenarios cancel in, so the test shows a cancel reaches each, not only that
    // the property held. The same for the states a late start failure arrives in.
    const cancelledIn = new Map<string, number>();
    const lateIn = new Map<string, number>();
    await fc.assert(
      fc.asyncProperty(scenario, async (events) => {
        const clock: { world?: World } = {};
        const durable = new MemoryDurable(() => clock.world?.now ?? 0);
        const world = new World({
          machine: MACHINE,
          store: () => new MemoryExecutionStore(durable),
          tasks: ["t_0000000000000000000000000a", "t_0000000000000000000000000b"],
          cancelledIn: (state) => cancelledIn.set(state, (cancelledIn.get(state) ?? 0) + 1),
          lateIn: (state) => lateIn.set(state, (lateIn.get(state) ?? 0) + 1),
        });
        clock.world = world;
        for (const e of events) {
          await world.run(e);
          await world.check(new MemoryExecutionStore(durable), false);
        }
        await world.finish();
        await world.check(new MemoryExecutionStore(durable), true);
        World.checkEdges(durable.runHistory);
      }),
      { numRuns: 5_000 },
    );
    // Every state a v1 run can be cancelled in. `waiting_for_input` is never entered in v1, and
    // `reconciling` lasts only between recovery's two commits; [A4.5.run.machine] cancels in both.
    const states = [
      "queued",
      "starting:unclaimed",
      "starting:claimed",
      "running",
      "cancelling",
      "unknown:lost",
      "unknown:stop_timed_out",
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
    ];
    for (const state of states) expect(cancelledIn.get(state) ?? 0, state).toBeGreaterThan(0);
    // A shim's start failure that arrives after a sweep found the shim gone and settled the run
    // lost, without and with a Stop (A4 3.11.2).
    for (const state of ["unknown:lost", "unknown:lost:stopped"]) {
      expect(lateIn.get(state) ?? 0, state).toBeGreaterThan(0);
    }
  }, 600_000);

  test("on the space database: the same property", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (events) => {
        const clock: { world?: World } = {};
        const parent = mkdtempSync(join(tmpdir(), "tasks-run-model-"));
        try {
          const space = await openLaunchSpace(parent, {
            now: () => clock.world?.now ?? Date.UTC(2026, 10, 13),
          });
          try {
            const store = (): SpaceExecutionStore =>
              new SpaceExecutionStore({
                writer: space.writer,
                spaceId: space.spaceId,
                credential: space.credential,
              });
            const world = new World({
              machine: space.machine,
              store,
              tasks: [await space.task(), await space.task()],
            });
            clock.world = world;
            for (const e of events) {
              await world.run(e);
              await world.check(store(), false);
            }
            await world.finish();
            await world.check(store(), true);
          } finally {
            space.close();
          }
        } finally {
          rmSync(parent, { recursive: true, force: true });
        }
      }),
      { numRuns: 150 },
    );
  }, 600_000);
});
