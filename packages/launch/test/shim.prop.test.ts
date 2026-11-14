// The launch state machine with real shim behaviour (A4 3.6.3, 3.9; A4 5.1): the
// real ShimHost in front of the real LaunchMachine, and shims that claim late, twice, at once with
// a thief, after a restart, after their window, with another launch's ticket, their credential or
// a wrong start time, whose reply is lost or never answered, that reattach and report, or die and
// leave their PID to another process. After every event: at most one agent and one reply with
// argv per intent, no agent without a durable claim, a reply only within the claim window, no
// claimed launch failed as unclaimed, an attach never starts anything, no secret in machine state.
// At the end, once every shim is gone and every window has passed, a clean restart leaves no
// launch open and no machine state behind.
import fc from "fast-check";
import { describe, test } from "vitest";
import { ShimWorld, type ShimEvent } from "./shim-model.ts";

const event: fc.Arbitrary<ShimEvent> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("launch" as const), reuse: fc.boolean() }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("claim" as const),
      pick: fc.nat(3),
      delivery: fc.constantFrom(
        "deliver" as const,
        "deliver" as const,
        "lose" as const,
        "hang" as const,
      ),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("race" as const), pick: fc.nat(3) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("misuse" as const),
      pick: fc.nat(3),
      with: fc.constantFrom("other-ticket" as const, "credential" as const, "identity" as const),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("attach" as const), pick: fc.nat(3) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("report" as const),
      pick: fc.nat(3),
      what: fc.constantFrom("started" as const, "settled" as const),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("exit" as const), pick: fc.nat(3) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("die" as const),
      pick: fc.nat(3),
      reuse: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("tick" as const),
      ms: fc.constantFrom(500, 3_000, 31_000, 60_000, 119_000, 121_000, 16 * 60_000),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("step" as const),
      ms: fc.constantFrom(121_000, -121_000, 25 * 60 * 60_000),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("sweep" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("check" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("restart" as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("slow" as const),
      ms: fc.constantFrom(0, 0, 2_000, 40_000),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("slow-store" as const),
      ms: fc.constantFrom(0, 0, 2_000, 20_000),
    }),
  },
);

const scenario = fc.array(event, { minLength: 4, maxLength: 40, size: "max" });

describe("[A4.5.launch.shim-property] the state machine with real shims", () => {
  test("one agent per intent, none without a durable claim, an attachment never a claim, and nothing left behind", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (events) => {
        const world = new ShimWorld();
        for (const e of events) await world.run(e);
        await world.finish();
      }),
      { numRuns: 4_000 },
    );
  }, 600_000);
});
