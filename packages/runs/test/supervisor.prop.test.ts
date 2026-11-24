// The supervisor's model test: random sequences of runs queued in two spaces, Stops, agents that
// finish, limits changed, a service restart, an update's hold taken and released (or its holder
// gone), tasks closed, starts refused, time passing and retention, over in-memory stores and fake
// process groups (supervisor-world.ts). And the start order itself, as a property of planStarts.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { planStarts, type QueueLimits, type Slot } from "../src/index.ts";
import { settle, SupervisorWorld, type Event } from "./supervisor-world.ts";

const pick = fc.nat(5);

const event: fc.Arbitrary<Event> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("queue" as const),
      space: fc.nat(1),
      task: fc.nat(2),
      instance: fc.nat(2),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("stop" as const), pick }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("end" as const), pick }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("limits" as const),
      runs: fc.integer({ min: 1, max: 4 }),
      perInstance: fc.integer({ min: 1, max: 3 }),
      perTask: fc.integer({ min: 1, max: 2 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("restart" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("hold" as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("release" as const), dies: fc.boolean() }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("close-task" as const), task: fc.nat(2) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("refuse-start" as const), on: fc.boolean() }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("age" as const), days: fc.constantFrom(1, 2, 15) }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("retain" as const) }) },
);

describe("[A4.5.run.supervisor-model] the supervisor under random queues, Stops, ends, limit changes, restarts and update holds", () => {
  test("the limits hold at every start, nothing starts under a hold or after a Stop of its queued run, no run waits while there is room, retention keeps every folder still needed, and every run settles", async () => {
    const reached = new Map<string, number>();
    let removed = 0;
    let held = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(event, { minLength: 6, maxLength: 40 }), async (events) => {
        const world = new SupervisorWorld();
        try {
          for (const e of events) {
            await world.run(e);
            await settle();
            world.check();
            if (e.kind === "hold") held += 1;
          }
          await world.finish();
          await world.run({ kind: "age", days: 15 });
          await world.run({ kind: "retain" });
          await settle();
          world.check();
          removed += world.removed.length;
          for (const id of world.runs) {
            const run = world.record(id);
            const key = `${run?.state ?? "none"}:${run?.reason ?? ""}`;
            reached.set(key, (reached.get(key) ?? 0) + 1);
          }
        } finally {
          await world.close();
        }
      }),
      { numRuns: 1_000 },
    );
    // The scenarios reach every way a queued run ends, so the property says something about each.
    for (const key of [
      "succeeded:",
      "cancelled:",
      "failed:task_closed",
      "failed:spawn_failed",
      "failed:service_ended",
    ]) {
      expect(reached.get(key) ?? 0, key).toBeGreaterThan(0);
    }
    expect(removed).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(0);
  }, 300_000);
});

const slot = fc.record({
  space: fc.constantFrom("sp_a", "sp_b"),
  id: fc.uuid(),
  task: fc.option(fc.constantFrom("t_1", "t_2", "t_3"), { nil: null }),
  instance: fc.constantFrom("claude-work", "claude-home", "codex-work"),
  queuedAt: fc.integer({ min: 0, max: 20 }),
});
const limits: fc.Arbitrary<QueueLimits> = fc.record({
  runs: fc.integer({ min: 1, max: 5 }),
  perInstance: fc.integer({ min: 1, max: 3 }),
  perTask: fc.integer({ min: 1, max: 2 }),
});

const taskOf = (s: Slot) => (s.task === null ? undefined : `${s.space}\n${s.task}`);

describe("[A4.5.run.queue-order] the oldest queued run its limits allow starts first", () => {
  test("starts stay within every limit, none is passed over by a younger one that its own limits did not hold back, and none waits while there is room", () => {
    fc.assert(
      fc.property(
        fc.array(slot, { maxLength: 12 }),
        fc.array(slot, { maxLength: 5 }),
        limits,
        (queued, active, l) => {
          const { start, waiting } = planStarts(queued, active, l);
          const all = [...active, ...start];
          const count = (key: (s: Slot) => string | undefined, value: string | undefined) =>
            all.filter((s) => key(s) === value).length;
          // A start never takes the machine, its instance or its task past a limit.
          if (start.length > 0) expect(all.length).toBeLessThanOrEqual(l.runs);
          for (const s of start) {
            expect(count((o) => o.instance, s.instance)).toBeLessThanOrEqual(l.perInstance);
            if (s.task !== null) expect(count(taskOf, taskOf(s))).toBeLessThanOrEqual(l.perTask);
          }
          // Every queued run starts or says why it waits, and the reason is true.
          for (const s of queued) {
            const why = waiting.get(s.id);
            expect(start.includes(s) !== (why !== undefined)).toBe(true);
            if (why === "machine_limit") expect(all.length).toBeGreaterThanOrEqual(l.runs);
            if (why === "instance_limit") {
              expect(count((o) => o.instance, s.instance)).toBeGreaterThanOrEqual(l.perInstance);
            }
            if (why === "task_limit") {
              expect(count(taskOf, taskOf(s))).toBeGreaterThanOrEqual(l.perTask);
            }
          }
          // Oldest first: a younger run starts only past older ones their own instance or task held.
          for (const s of start) {
            for (const q of queued) {
              if (q.queuedAt < s.queuedAt) expect(waiting.get(q.id)).not.toBe("machine_limit");
            }
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });

  test("a run held back by its own task holds back no younger run of another task", () => {
    const queued: Slot[] = [
      { space: "sp_a", id: "ru_1", task: "t_1", instance: "claude-work", queuedAt: 1 },
      { space: "sp_a", id: "ru_2", task: "t_2", instance: "claude-work", queuedAt: 2 },
      { space: "sp_a", id: "ru_3", task: "t_3", instance: "claude-work", queuedAt: 3 },
      { space: "sp_b", id: "ru_4", task: "t_1", instance: "codex-work", queuedAt: 4 },
    ];
    const active: Slot[] = [
      { space: "sp_a", id: "ru_0", task: "t_1", instance: "codex-work", queuedAt: 0 },
    ];
    const { start, waiting } = planStarts(queued, active, { runs: 3, perInstance: 2, perTask: 1 });
    // ru_1's task runs already; ru_2 and ru_3 fill the machine's three, so ru_4 (another space's t_1)
    // waits for the machine.
    expect(start.map((s) => s.id)).toEqual(["ru_2", "ru_3"]);
    expect(waiting).toEqual(
      new Map([
        ["ru_1", "task_limit"],
        ["ru_4", "machine_limit"],
      ]),
    );
  });
});
