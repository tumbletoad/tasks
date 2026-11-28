// The launch state machine's property test: random
// clicks, confirmations, claims (the same claim ID again included), reports, time passing, wall
// clock steps either way, sweeps, start-up recoveries, T3 re-pairings, calls that overlap (each
// call stays under way while it waits on time, and two can start at once), calls to the store or
// to an external step that take effect late, answer late or never answer (some landing inside a
// later call, after their own call gave up), crashes of the service
// at any such call (before or after it takes effect, recovery included) and restarts. After every
// event: at most one dispatch, one agent process and one T3 thread per intent; no agent without a
// durable claim, and no claimed launch failed as unclaimed; every external step starts on the
// durable record its call committed, and nothing changes that record until the step is done or
// its deadline has passed; Unknown never leads to a dispatch, a T3 repeat or a claim and never
// goes back. At the end, liveness: once every deadline has passed, every call has ended, no intent
// is owned, and after one more sweep and recovery every intent is final or waits for evidence
// only. The same machine runs on the in-memory store and on the space database, which pass the
// same contract suite.
import fc from "fast-check";
import { describe, test } from "vitest";
import { ROUTES } from "../src/intents.ts";
import {
  World,
  type Event,
  type LiveEvent,
  type ModelBackend,
  type Slow,
} from "./machine-model.ts";
import { MemoryDurable, MemoryExecutionStore, randomId } from "./memory-store.ts";
import { MACHINE, spaceBackend, spaceStore } from "./stores.ts";

const fault = fc.record({ after: fc.integer({ min: 1, max: 5 }), late: fc.boolean() });

/** Shorter than every deadline, past the store's only, and past both. */
const DELAYS = [2_000, 20_000, 45_000] as const;

const slow: fc.Arbitrary<Slow> = fc.oneof(
  fc.record({
    mode: fc.constantFrom("effect" as const, "reply" as const),
    ms: fc.constantFrom(...DELAYS),
  }),
  fc.record({ mode: fc.constant("hang" as const), effect: fc.boolean() }),
  fc.record({ mode: fc.constant("late" as const), calls: fc.integer({ min: 1, max: 8 }) }),
);

const tick = fc.record({
  kind: fc.constant("tick" as const),
  ms: fc.constantFrom(500, 3_000, 6_000, 16_000, 31_000, 60_000, 119_000, 121_000, 610_000),
});

/** What the live service does, alone or beside another call. */
const live: fc.Arbitrary<LiveEvent> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("click" as const),
      task: fc.nat(1),
      instance: fc.nat(2),
      route: fc.constantFrom(...ROUTES),
      repeat: fc.boolean(),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("confirm" as const),
      pick: fc.nat(2),
      crash: fc.boolean(),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("claim" as const),
      pick: fc.nat(2),
      same: fc.boolean(),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("report" as const),
      pick: fc.nat(2),
      what: fc.constantFrom(
        "started" as const,
        "settled" as const,
        "exited" as const,
        "bound" as const,
        "checked" as const,
        "lost" as const,
      ),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("sweep" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("recover" as const) }) },
  { weight: 3, arbitrary: tick },
);

/** The calls that race another one most: recovery, a lost report, a sweep, a claim. */
const racer: fc.Arbitrary<LiveEvent> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("recover" as const) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("report" as const),
      pick: fc.nat(2),
      what: fc.constantFrom("lost" as const, "bound" as const, "checked" as const),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("sweep" as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("claim" as const),
      pick: fc.nat(2),
      same: fc.boolean(),
    }),
  },
  { weight: 3, arbitrary: live },
);

const event: fc.Arbitrary<Event> = fc.oneof(
  { weight: 18, arbitrary: live },
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant("together" as const),
      first: fc.oneof(live, racer),
      second: racer,
      twin: fc.boolean(),
      delay: fc.nat(4),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("slow" as const),
      after: fc.integer({ min: 1, max: 6 }),
      slow,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("outcome" as const),
      value: fc.constantFrom(
        "accepted" as const,
        "refused" as const,
        "unknown" as const,
        "throws" as const,
      ),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("step" as const),
      ms: fc.constantFrom(-3_600_000, -2_000, 2_000, 3_600_000),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("arm" as const),
      after: fc.integer({ min: 1, max: 5 }),
      late: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("crash" as const) }) },
  {
    weight: 2,
    arbitrary: fc.record(
      { kind: fc.constant("restart" as const), fault },
      { requiredKeys: ["kind"] },
    ),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("regrant" as const) }) },
);

// Long scenarios: fast-check's default size keeps arrays short, and a crash only matters with
// enough events around it. The seed spaces the calls, so overlapping calls interleave differently.
const scenario = fc.record({
  seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
  events: fc.array(event, { minLength: 4, maxLength: 40, size: "max" }),
});

async function play(world: World, events: readonly Event[]): Promise<void> {
  for (const e of events) await world.run(e);
  await world.finish();
}

/**
 * The nightly deep job (.github/workflows/nightly.yml) sets TTASKS_DEEP=1 and runs the property
 * at its full counts; every check runs it at a fifth (in memory) and a third (on the database),
 * with a new seed each time. fast-check prints the seed and path of a failure.
 */
const DEEP = process.env["TTASKS_DEEP"] === "1";

describe("[A4.5.launch.state-machine] the launch state machine under crashes, slow calls and restarts", () => {
  test("in memory: one agent per intent, Unknown never leads to a dispatch, and every call ends", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ seed, events }) => {
        // The store's clock is the world's, which exists only once the backend does.
        const clock: { world?: World } = {};
        const durable = new MemoryDurable(() => clock.world?.now ?? 0);
        const backend: ModelBackend = {
          machine: MACHINE,
          durable: () => new MemoryExecutionStore(durable),
          restart: () => Promise.resolve(new MemoryExecutionStore(durable)),
          tasks: [randomId("t"), randomId("t")],
          history: () => durable.history,
        };
        clock.world = new World(backend, seed);
        await play(clock.world, events);
      }),
      { numRuns: DEEP ? 50_000 : 10_000 },
    );
  }, 600_000);

  test("on the space database: the same property", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ seed, events }) => {
        const clock: { world?: World } = {};
        const fixture = await spaceBackend({
          now: () => clock.world?.now ?? Date.UTC(2026, 10, 13),
        });
        try {
          const backend: ModelBackend = {
            machine: fixture.machine,
            // The writer now open, so a restart's new writer is what the checks read.
            durable: () => spaceStore(fixture.space),
            restart: () => fixture.restart(),
            tasks: [await fixture.task(), await fixture.task()],
          };
          clock.world = new World(backend, seed);
          await play(clock.world, events);
        } finally {
          await fixture.close();
        }
      }),
      { numRuns: DEEP ? 300 : 100 },
    );
  }, 600_000);
});
