// One call at a time per intent, each with deadlines (A4 3.9, 3.16.1): the races
// and stalls three review rounds found, replayed step by step on both backends. Each test holds a
// call of the store or of an external step at a chosen point, lets other calls run, and checks
// that every decision rests on the record its call read inside the intent's section, that no
// external step runs while its record changes under it, and that a call that never answers owns
// its intent only until its deadline. Model time: the machine's timers and clocks are the test's.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Evidence, type Route } from "../src/intents.ts";
import {
  LaunchMachine,
  type DispatchOutcome,
  type LaunchSteps,
  type Observation,
  type RecoverySteps,
} from "../src/machine.ts";
import type { LaunchStore, LaunchIntent } from "../src/store.ts";
import { DEADLINES, settle, Time } from "./machine-model.ts";
import { MemoryDurable, MemoryExecutionStore, randomId } from "./memory-store.ts";
import { MACHINE, spaceBackend, spaceStore } from "./stores.ts";

/** A backend on a fresh durable state whose clock is the test's wall clock. */
interface Bench {
  machine: string;
  /** The store on the durable state as it is now. */
  durable(): LaunchStore;
  /** Drops the store, as a crash would, and returns a new one on the same state. */
  restart(): Promise<LaunchStore>;
  task(): Promise<string>;
  close(): Promise<void>;
}

const BENCHES: [string, (time: Time) => Promise<Bench>][] = [
  [
    "in memory",
    (time) => {
      const durable = new MemoryDurable(() => time.now);
      return Promise.resolve({
        machine: MACHINE,
        durable: () => new MemoryExecutionStore(durable),
        restart: () => Promise.resolve(new MemoryExecutionStore(durable)),
        task: () => Promise.resolve(randomId("t")),
        close: () => Promise.resolve(),
      });
    },
  ],
  [
    "on the space database",
    async (time) => {
      const fixture = await spaceBackend({ now: () => time.now });
      return {
        machine: fixture.machine,
        durable: () => spaceStore(fixture.space),
        restart: () => fixture.restart(),
        task: () => fixture.task(),
        close: () => fixture.close(),
      };
    },
  ],
];

type Method = "createIntent" | "transitionIntent" | "readIntent" | "openWork";

/** One call to the store, as a hook sees it. */
interface Call {
  method: Method;
  args: unknown[];
}

/**
 * Hooks around the store's calls: `before` runs before the call is made (a write held there takes
 * effect late), `after` once it has taken effect and before its answer is given (an answer held
 * there comes late).
 */
interface Hooks {
  before?: (call: Call) => Promise<void> | void;
  after?: (call: Call) => Promise<void> | void;
}

function hooked(store: () => LaunchStore, hooks: Hooks): LaunchStore {
  const around = async <T>(call: Call, run: () => Promise<T>): Promise<T> => {
    await hooks.before?.(call);
    const answer = await run();
    await hooks.after?.(call);
    return answer;
  };
  return {
    createIntent: (...args) =>
      around({ method: "createIntent", args }, () => store().createIntent(...args)),
    transitionIntent: (...args) =>
      around({ method: "transitionIntent", args }, () => store().transitionIntent(...args)),
    readIntent: (...args) =>
      around({ method: "readIntent", args }, () => store().readIntent(...args)),
    openWork: (...args) => around({ method: "openWork", args }, () => store().openWork(...args)),
  };
}

/** A promise a test opens when it wants a held call to go on. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Whether a call has ended, and how. */
function track<T>(promise: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error: unknown) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const THREAD: DispatchOutcome = { kind: "accepted", evidence: { thread: "thr-1" } };

describe.each(BENCHES)(
  "[A4.5.launch.sections] one call at a time per intent, each with deadlines: %s",
  (_name, open) => {
    let time: Time;
    let bench: Bench;
    let clicks = 0;
    let tasks: string[];

    beforeEach(async () => {
      time = new Time();
      bench = await open(time);
      tasks = [];
    }, 60_000);

    afterEach(async () => {
      await bench.close();
    }, 60_000);

    const read = (id: string): Promise<LaunchIntent | undefined> => bench.durable().readIntent(id);

    /** A machine over `store` with the test's clocks, timers and deadlines. */
    function machine(
      store: LaunchStore,
      steps: Partial<LaunchSteps & RecoverySteps> = {},
    ): LaunchMachine {
      return new LaunchMachine({
        store,
        machine: bench.machine,
        now: () => time.now,
        elapsed: () => time.mono,
        wait: time.wait,
        deadlines: DEADLINES,
        steps: { dispatch: steps.dispatch ?? (() => Promise.resolve({ kind: "accepted" })) },
        recovery: {
          observe: steps.observe ?? (() => Promise.resolve<Observation>({ kind: "pending" })),
          grant: steps.grant ?? (() => Promise.resolve("grant-1")),
          replay: steps.replay ?? (() => Promise.resolve(THREAD)),
        },
      });
    }

    /** A click on task `n` (a new task each time when omitted). */
    async function click(m: LaunchMachine, route: Route, n?: number): Promise<LaunchIntent> {
      const index = n ?? tasks.length;
      while (tasks.length <= index) tasks.push(await bench.task());
      clicks += 1;
      return m.open(
        {
          task: tasks[index] ?? "",
          instance: "codex-work",
          route,
          place: null,
          taskVersion: 1,
          briefHash: "d".repeat(64),
        },
        `sections-click-${String(clicks).padStart(8, "0")}`,
      );
    }

    /** A T3 launch a crashed service left in Dispatching under grant-1. */
    async function crashedT3(): Promise<LaunchIntent> {
      const intent = await click(machine(bench.durable()), "t3-mcp");
      return bench
        .durable()
        .transitionIntent(intent.id, "prepared", "dispatching", { evidence: { grant: "grant-1" } });
    }

    test("recovery decides on the record it reads in the intent's section, not on its list of open work", async () => {
      // Round 3, finding 1: recovery's list comes late, and a lost report makes it Unknown meanwhile.
      const intent = await crashedT3();
      const list = gate();
      const replays: string[] = [];
      const m = machine(
        hooked(() => bench.durable(), {
          after: async ({ method }) => {
            if (method === "openWork") await list.wait;
          },
        }),
        {
          replay: async (fenced) => {
            replays.push((await read(fenced.id))?.state ?? "missing");
            return THREAD;
          },
        },
      );
      const recovering = track(m.recover());
      await settle();
      expect(await m.report(intent.id, { kind: "lost" })).toMatchObject({
        state: "unknown",
        reason: "lost",
      });
      list.open();
      await settle();
      expect(recovering.done).toBe(true);
      expect(replays).toEqual([]);
      expect(await read(intent.id)).toMatchObject({ state: "unknown", reason: "lost" });
    });

    test("a recovery whose list comes late repeats nothing once another recovery made the launch Unknown", async () => {
      // Round 3, finding 1: the other recovery repeats, T3 refuses, and the launch is Unknown.
      const intent = await crashedT3();
      const list = gate();
      let held = false;
      const replays: string[] = [];
      const m = machine(
        hooked(() => bench.durable(), {
          after: async ({ method }) => {
            if (method !== "openWork" || held) return;
            held = true;
            await list.wait;
          },
        }),
        {
          replay: async (fenced) => {
            replays.push((await read(fenced.id))?.state ?? "missing");
            return { kind: "refused" };
          },
        },
      );
      const first = track(m.recover());
      await settle();
      expect(await m.recover()).toMatchObject([
        { id: intent.id, state: "unknown", reason: "no_answer" },
      ]);
      list.open();
      await settle();
      expect(first.done).toBe(true);
      expect(replays).toEqual(["dispatching"]);
      expect(await read(intent.id)).toMatchObject({ state: "unknown", reason: "no_answer" });
    });

    test("a lost report's write that lands after its deadline cannot change the record under a T3 repeat", async () => {
      // Round 3, finding 1, second probe: a lost report decided Unknown, and its write is late.
      const intent = await crashedT3();
      const lost = gate();
      const during: (LaunchIntent | undefined)[] = [];
      const m = machine(
        hooked(() => bench.durable(), {
          before: async ({ method, args }) => {
            if (method === "transitionIntent" && args[2] === "unknown") await lost.wait;
          },
        }),
        {
          replay: async (fenced) => {
            // The late write arrives while the repeat is under way.
            lost.open();
            await settle();
            during.push(await read(fenced.id));
            return THREAD;
          },
        },
      );
      const reporting = track(m.report(intent.id, { kind: "lost" }));
      await settle();
      // The report's write is still queued: its deadline passes, and its call ends.
      await time.pass(DEADLINES.store + 1);
      const recovered = await m.recover();
      expect(during).toHaveLength(1);
      // The repeat ran on Dispatching, as the record that announced it, and stayed so.
      expect(during[0]).toMatchObject({ state: "dispatching" });
      expect(during[0]?.evidence.replayed_at).toBeDefined();
      expect(recovered).toMatchObject([{ state: "dispatched", evidence: { thread: "thr-1" } }]);
      expect(await read(intent.id)).toMatchObject({ state: "dispatched", reason: null });
      expect(reporting.done).toBe(true);
      expect((reporting.error as Error | undefined)?.name).toBe("DeadlinePassed");
      expect(m.owned()).toEqual([]);
    });

    for (const at of ["its list of open work", "its read of the intent"] as const) {
      test(`a late lost write that lands before recovery decides, at ${at}, stops the T3 repeat`, async () => {
        const intent = await crashedT3();
        const lost = gate();
        let recovering = false;
        const replays: string[] = [];
        const m = machine(
          hooked(() => bench.durable(), {
            before: async ({ method, args }) => {
              if (method === "transitionIntent" && args[2] === "unknown") await lost.wait;
            },
            after: async ({ method }) => {
              const point = at === "its list of open work" ? "openWork" : "readIntent";
              if (!recovering || method !== point) return;
              recovering = false;
              lost.open();
              await settle();
            },
          }),
          {
            replay: async (fenced) => {
              replays.push((await read(fenced.id))?.state ?? "missing");
              return THREAD;
            },
          },
        );
        const reporting = track(m.report(intent.id, { kind: "lost" }));
        await settle();
        await time.pass(DEADLINES.store + 1);
        recovering = true;
        await m.recover();
        expect(replays).toEqual([]);
        expect(await read(intent.id)).toMatchObject({ state: "unknown", reason: "lost" });
        expect(reporting.done).toBe(true);
      });
    }

    test("a dispatch whose step never answers ends at its deadline as Unknown and owns nothing after", async () => {
      // Round 3, finding 2: an abandoned link dispatch stayed Dispatching and kept the focus.
      const m = machine(bench.durable(), { dispatch: () => never() });
      const intent = await click(m, "link", 0);
      const dispatching = track(m.dispatch(intent.id));
      await settle();
      expect(m.owned()).toEqual([intent.id]);
      await time.pass(DEADLINES.step + 1);
      expect(dispatching.done).toBe(true);
      expect(dispatching.value).toMatchObject({ state: "unknown", reason: "no_answer" });
      expect(m.owned()).toEqual([]);
      await time.pass(3_600_000);
      await m.recover();
      await m.sweep();
      await m.report(intent.id, { kind: "lost" });
      expect(await read(intent.id)).toMatchObject({ state: "unknown", reason: "no_answer" });
      // A new click on the same task and instance is a new intent: nothing holds the focus.
      const again = await click(m, "link", 0);
      expect(again.id).not.toBe(intent.id);
      expect(again.state).toBe("prepared");
      expect(m.owned()).toEqual([]);
    });

    test("a store call that never answers ends its call at the store's deadline; the sweep settles what it left", async () => {
      // The dispatch's record of its outcome never answers.
      let stuck = true;
      const m = machine(
        hooked(() => bench.durable(), {
          before: async ({ method, args }) => {
            if (stuck && method === "transitionIntent" && args[2] === "dispatched") await never();
          },
        }),
      );
      const intent = await click(m, "link", 0);
      const dispatching = track(m.dispatch(intent.id));
      await settle();
      await time.pass(DEADLINES.step + DEADLINES.store);
      expect(dispatching.done).toBe(true);
      expect((dispatching.error as Error | undefined)?.name).toBe("DeadlinePassed");
      expect(m.owned()).toEqual([]);
      expect(await read(intent.id)).toMatchObject({ state: "dispatching" });
      // No call owns it now: its step's outcome is lost, and the sweep says so (A4 3.9.3).
      stuck = false;
      expect(await m.sweep()).toMatchObject([{ id: intent.id, state: "unknown", reason: "lost" }]);
      const again = await click(m, "link", 0);
      expect(again.id).not.toBe(intent.id);
    });

    test("a claim's reply that never returns: the claim stands, the call ends, and nothing is owned", async () => {
      const m = machine(bench.durable());
      const intent = await click(m, "terminal", 0);
      await m.dispatch(intent.id);
      const claiming = track(m.claim(intent.id, "claim-a", () => never()));
      await settle();
      expect(m.owned()).toEqual([intent.id]);
      // A lost report waits for the claim's call: it never lands between the claim and its reply.
      const reporting = track(m.report(intent.id, { kind: "lost" }));
      await settle();
      expect(reporting.done).toBe(false);
      expect(await read(intent.id)).toMatchObject({ state: "dispatched", reason: null });
      await time.pass(DEADLINES.step + 1);
      expect(claiming.done).toBe(true);
      expect(claiming.value?.evidence.claim).toBe("claim-a");
      expect(reporting.done).toBe(true);
      expect(reporting.value).toMatchObject({ state: "unknown", reason: "lost" });
      expect(m.owned()).toEqual([]);
    });

    test("calls on one intent run one at a time, in the order they arrive", async () => {
      const held = gate();
      const order: string[] = [];
      const m = machine(bench.durable(), {
        dispatch: async () => {
          order.push("step");
          await held.wait;
          order.push("step done");
          return { kind: "accepted" };
        },
      });
      const intent = await click(m, "link", 0);
      const dispatching = m.dispatch(intent.id);
      await settle();
      const reported = m
        .report(intent.id, { kind: "confirmed", evidence: { bound_at: time.now } })
        .then((after) => {
          order.push(`report ${after?.state ?? ""}`);
        });
      const swept = m.sweep().then(() => {
        order.push("sweep");
      });
      await settle();
      expect(order).toEqual(["step"]);
      expect(await read(intent.id)).toMatchObject({ state: "dispatching" });
      held.open();
      await Promise.all([dispatching, reported, swept]);
      expect(order).toEqual(["step", "step done", "report confirmed", "sweep"]);
      expect(await read(intent.id)).toMatchObject({ state: "confirmed" });
    });

    /** The confirmations A4 3.9.2 names, as the evidence they carry. */
    const SHAPES: [string, Evidence | undefined][] = [
      ["the shim's settle", undefined],
      ["the bridge's binding", { bound_at: 1_800_000_000_000 }],
      ["a binding with the observed folder", { bound_at: 1_800_000_000_000, folder_checked: true }],
      ["T3's folder check", { folder_checked: true, thread: "thr-9" }],
      ["a settle with the agent's PID", { pid: 4242, pid_started_at: 1_800_000_000_000 }],
    ];

    test("every confirmation is applied whole or not at all, whatever it carries, cut off anywhere", async () => {
      // Round 3, finding 3: a confirmation in Dispatching took two commits, and only one carrying
      // a binding was finished after a cut between them.
      for (const [shape, evidence] of SHAPES) {
        for (const from of ["dispatching", "dispatched", "unknown"] as const) {
          for (let cut = 1; cut <= 3; cut += 1) {
            for (const late of [false, true]) {
              const label = `${shape} from ${from}, cut at call ${String(cut)}${late ? " after it" : ""}`;
              const intent = await click(machine(bench.durable()), "link");
              const store = bench.durable();
              let before = await store.transitionIntent(intent.id, "prepared", "dispatching");
              if (from === "dispatched") {
                before = await store.transitionIntent(intent.id, "dispatching", "dispatched");
              } else if (from === "unknown") {
                before = await store.transitionIntent(intent.id, "dispatching", "unknown", {
                  reason: "no_answer",
                });
              }
              // The service dies at its `cut`-th call to the store, before or after it takes effect.
              let calls = 0;
              const dying = hooked(() => bench.durable(), {
                before: () => {
                  calls += 1;
                  if (calls === cut && !late) throw new Error("crash");
                },
                after: () => {
                  if (calls === cut && late) throw new Error("crash");
                },
              });
              await machine(dying)
                .report(intent.id, { kind: "confirmed", ...(evidence ? { evidence } : {}) })
                .catch(() => undefined);
              const cutOff = await read(intent.id);
              await bench.restart();
              const restarted = machine(bench.durable());
              await restarted.recover();
              await restarted.sweep();
              // Once any of it is durable, recovery and the sweep leave it Confirmed.
              if (cutOff?.version !== before.version) {
                const after = await read(intent.id);
                expect(after?.state, label).toBe("confirmed");
                expect(after?.evidence, label).toMatchObject(evidence ?? {});
              }
            }
          }
        }
      }
    }, 120_000);
  },
);
