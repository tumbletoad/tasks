// The run host under random lives (host-world.ts): runs queued and started, starts that fail or
// hang, agents that talk, fork, exit, obey or ignore an interrupt, Stop at every moment, the clock
// passing every limit, containers that refuse to empty, End by force, and crashes of the service at
// any boundary with the next start. After every event: a final run's container is empty, a stopped
// run ends `cancelled` or `unknown` and never runs again, and an answer in a record is one its agent
// gave whole. At the end every run is final or `unknown` once every limit passed, and the next
// start settles every run that is not queued.
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpaceExecutionStore } from "@ttasks/launch";
import { MemoryDurable, MemoryExecutionStore } from "@ttasks/launch/memory-store";
import { openLaunchSpace } from "@ttasks/testkit";
import { describe, expect, test } from "vitest";
import { World, type Event } from "./host-world.ts";

const MACHINE = "m_3q7k9d2xw8f4r6t1c5v0b2n8a7";

const pick = fc.nat(3);

const event: fc.Arbitrary<Event> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("queue" as const) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("start" as const),
      pick,
      mode: fc.constantFrom(
        "ok" as const,
        "ok" as const,
        "ok" as const,
        "refuse" as const,
        "hang" as const,
      ),
      obeys: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("answerStart" as const), pick, ok: fc.boolean() }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("say" as const), pick, final: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("fork" as const), pick }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("exit" as const), pick, code: fc.constantFrom(0, 1) }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("stop" as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("stick" as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("release" as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("forceEnd" as const), pick }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("tick" as const),
      ms: fc.constantFrom(1_000, 5_000, 10_000, 30_000, 61_000, 130_000),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("arm" as const),
      after: fc.integer({ min: 1, max: 6 }),
      late: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("crash" as const) }) },
);

/** Starting points deep in a run's life, which random events reach only rarely. */
const started: Event[] = [
  { kind: "queue" },
  { kind: "start", pick: 0, mode: "ok", obeys: false },
  { kind: "say", pick: 0, final: false },
];
const PREFIXES: Event[][] = [
  started,
  [...started, { kind: "stop", pick: 0 }],
  [...started, { kind: "stick", pick: 0 }, { kind: "stop", pick: 0 }, { kind: "tick", ms: 30_000 }],
  [
    { kind: "queue" },
    { kind: "start", pick: 0, mode: "hang", obeys: true },
    { kind: "tick", ms: 61_000 },
  ],
  [...started, { kind: "fork", pick: 0 }, { kind: "exit", pick: 0, code: 0 }],
  [...started, { kind: "say", pick: 0, final: true }, { kind: "exit", pick: 0, code: 0 }],
];

const scenario = fc.oneof(
  { weight: 3, arbitrary: fc.array(event, { minLength: 4, maxLength: 30, size: "max" }) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.constantFrom(...PREFIXES), fc.array(event, { maxLength: 20 }))
      .map(([prefix, rest]) => [...prefix, ...rest]),
  },
);

describe("[A4.5.run.lifecycle-model] the run host under Stop at every moment, limits, containers that refuse to empty and crashes at any boundary", () => {
  test("in memory: final runs have empty containers, stopped runs end cancelled or unknown, answers are whole, and every run settles", async () => {
    const reached = new Map<string, number>();
    const seen = new Set<string>();
    await fc.assert(
      fc.asyncProperty(scenario, async (events) => {
        const clock: { world?: World } = {};
        const durable = new MemoryDurable(() => clock.world?.now ?? 0);
        const world = new World({
          machine: MACHINE,
          store: () => new MemoryExecutionStore(durable),
          tasks: ["t_0000000000000000000000000a", "t_0000000000000000000000000b"],
        });
        clock.world = world;
        for (const e of events) {
          await world.run(e);
          await world.check(new MemoryExecutionStore(durable));
        }
        await world.finish(() => new MemoryExecutionStore(durable));
        await world.check(new MemoryExecutionStore(durable));
        for (const state of world.seen) seen.add(state);
        for (const id of world.runs) {
          const run = await new MemoryExecutionStore(durable).readRun(id);
          const key = `${run?.state ?? "none"}:${run?.reason ?? ""}`;
          reached.set(key, (reached.get(key) ?? 0) + 1);
        }
      }),
      { numRuns: 1_500 },
    );
    // The scenarios reach every way a run ends, so the property says something about each.
    for (const key of [
      "succeeded:",
      "failed:no_result",
      "failed:spawn_failed",
      "failed:start_timed_out",
      "failed:service_ended",
      "timed_out:idle",
      "cancelled:",
    ]) {
      expect(reached.get(key) ?? 0, key).toBeGreaterThan(0);
    }
    // And the states between: a Stop in flight, and a container not confirmed empty.
    for (const state of ["starting", "running", "cancelling", "unknown"]) {
      expect(seen.has(state), state).toBe(true);
    }
  }, 600_000);

  test("on the space database: the same property", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (events) => {
        const parent = mkdtempSync(join(tmpdir(), "ttasks-host-model-"));
        const clock: { world?: World } = {};
        try {
          const space = await openLaunchSpace(parent, {
            now: () => clock.world?.now ?? Date.UTC(2026, 10, 16),
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
              await world.check(store());
            }
            await world.finish(store);
            await world.check(store());
          } finally {
            space.close();
          }
        } finally {
          rmSync(parent, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  }, 600_000);
});
