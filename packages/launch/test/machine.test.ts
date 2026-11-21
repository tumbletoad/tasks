// The launch state machine's rules one by one (A4 3.6.3, 3.9.1–3.9.3), on the in-memory store
// with stub external steps. The property test covers their combinations under crashes.
import { beforeEach, describe, expect, test } from "vitest";
import { CLAIM_WINDOW_MS, PREPARED_TTL_MS, type Route } from "../src/intents.ts";
import {
  LaunchMachine,
  type DispatchOutcome,
  type Observation,
  type RecoverySteps,
} from "../src/machine.ts";
import type { LaunchStore, LaunchIntent } from "../src/store.ts";
import { MemoryDurable, MemoryExecutionStore, randomId } from "./memory-store.ts";
import { MACHINE } from "./stores.ts";

/** The wall clock, and a monotonic clock that only time passing moves. */
let now: number;
let mono: number;
let durable: MemoryDurable;
let calls: {
  dispatch: LaunchIntent[];
  replay: LaunchIntent[];
  states: string[];
  /** Claims replied to, with the state the record had when the reply left. */
  replies: string[];
};
let outcome: DispatchOutcome;
/** What T3 answers to the repeat of an idle-thread create. */
let repeat: DispatchOutcome;
let observation: Observation;
let grant: string | undefined;
/** When set, the next read of the grant waits for it. */
let grantGate: Promise<void> | undefined;

/** The machine's timers, on the monotonic clock: a deadline fires only when time passes. */
let timers: { at: number; fire: () => void }[];

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = { at: mono + ms, fire: resolve };
    timers.push(timer);
    signal.addEventListener("abort", () => {
      timers = timers.filter((t) => t !== timer);
    });
  });
}

/** Time passes: both clocks move, and the timers due fire. */
function pass(ms: number): void {
  now += ms;
  mono += ms;
  const due = timers.filter((t) => t.at <= mono);
  timers = timers.filter((t) => t.at > mono);
  for (const timer of due) timer.fire();
}

/** The wall clock steps, and no time passes. */
function step(ms: number): void {
  now += ms;
}

beforeEach(() => {
  now = Date.UTC(2026, 10, 13, 9, 0, 0);
  mono = 1_000;
  timers = [];
  durable = new MemoryDurable(() => now);
  calls = { dispatch: [], replay: [], states: [], replies: [] };
  outcome = { kind: "accepted" };
  repeat = { kind: "accepted", evidence: { thread: "thr-1" } };
  observation = { kind: "pending" };
  grant = "grant-1";
  grantGate = undefined;
});

const store = (): MemoryExecutionStore => new MemoryExecutionStore(durable);

/** A claim's reply to its shim: it records the state the record has as the reply leaves. */
async function send(intent: LaunchIntent): Promise<void> {
  const state = (await store().readIntent(intent.id))?.state ?? "missing";
  calls.replies.push(`${intent.id}:${state}`);
}

function machine(): LaunchMachine {
  const recovery: RecoverySteps = {
    observe: () => Promise.resolve(observation),
    grant: async () => {
      const held = grantGate;
      grantGate = undefined;
      // The grant as it was when asked, answered once the gate opens.
      const answer = grant;
      if (held !== undefined) await held;
      return answer;
    },
    replay: (intent) => {
      calls.replay.push(intent);
      return Promise.resolve(repeat);
    },
  };
  return new LaunchMachine({
    store: store(),
    machine: MACHINE,
    now: () => now,
    elapsed: () => mono,
    wait,
    steps: {
      dispatch: async (intent) => {
        // The step sees the durable record: Dispatching is committed before it runs.
        calls.states.push((await store().readIntent(intent.id))?.state ?? "missing");
        calls.dispatch.push(intent);
        if (outcome.kind === "unknown" && intent.instance === "throws") throw new Error("opener");
        return outcome;
      },
    },
    recovery,
  });
}

let clicks = 0;
async function open(
  m: LaunchMachine,
  route: Route,
  instance = "codex-work",
): Promise<LaunchIntent> {
  clicks += 1;
  return m.open(
    {
      task: randomId("t"),
      instance,
      route,
      place: null,
      taskVersion: 1,
      briefHash: "c".repeat(64),
    },
    `machine-click-${String(clicks).padStart(8, "0")}`,
  );
}

describe("[A4.5.launch.machine] the launch state machine's rules", () => {
  test("Dispatching is durable before the step, which runs once; outcomes map per route", async () => {
    const m = machine();
    const cases: [Route, DispatchOutcome, string, string | null][] = [
      ["terminal", { kind: "accepted" }, "dispatched", null],
      ["terminal", { kind: "refused" }, "failed", "refused"],
      // A terminal's claim window decides an ambiguous answer (A4 3.6.2).
      ["terminal", { kind: "unknown" }, "dispatched", null],
      ["link", { kind: "unknown" }, "unknown", "no_answer"],
      ["link", { kind: "refused", reason: "refused" }, "failed", "refused"],
      ["t3-mcp", { kind: "accepted", evidence: { thread: "thr-9" } }, "dispatched", null],
      ["clipboard", { kind: "accepted" }, "dispatched", null],
    ];
    for (const [route, result, state, reason] of cases) {
      outcome = result;
      const intent = await open(m, route);
      const after = await m.dispatch(intent.id);
      expect(after, `${route} ${result.kind}`).toMatchObject({ state, reason });
      expect(await m.dispatch(intent.id)).toEqual(after);
    }
    expect(calls.dispatch).toHaveLength(cases.length);
    expect(calls.states.every((s) => s === "dispatching")).toBe(true);
    expect((await store().readIntent(calls.dispatch[5]?.id ?? ""))?.evidence.thread).toBe("thr-9");
    outcome = { kind: "unknown" };
    const throwing = await open(m, "link", "throws");
    expect(await m.dispatch(throwing.id)).toMatchObject({ state: "unknown", reason: "no_answer" });
  });

  test("a Prepared intent older than 10 minutes is closed as expired, never dispatched", async () => {
    const m = machine();
    const intent = await open(m, "terminal");
    pass(PREPARED_TTL_MS);
    expect(await m.dispatch(intent.id)).toMatchObject({ state: "failed", reason: "expired" });
    expect(calls.dispatch).toEqual([]);
    const other = await open(m, "link", "claude-work");
    pass(PREPARED_TTL_MS);
    expect((await m.sweep()).map((i) => i.id)).toEqual([other.id]);
  });

  test("a claim is durable before its reply, once, within its window, on a terminal only", async () => {
    const m = machine();
    const intent = await open(m, "terminal");
    await m.dispatch(intent.id);
    const claimed = await m.claim(intent.id, "claim-a", send);
    expect(claimed?.evidence).toMatchObject({ claim: "claim-a", claimed_at: now });
    expect((await store().readIntent(intent.id))?.evidence.claim).toBe("claim-a");
    expect(await m.claim(intent.id, "claim-b", send)).toBeUndefined();
    const late = await open(m, "terminal", "late");
    await m.dispatch(late.id);
    pass(CLAIM_WINDOW_MS + 1);
    expect(await m.claim(late.id, "claim-c", send)).toBeUndefined();
    expect((await m.sweep()).map((i) => [i.id, i.state, i.reason])).toEqual([
      [late.id, "failed", "not_claimed"],
    ]);
    const link = await open(m, "link", "link");
    await m.dispatch(link.id);
    expect(await m.claim(link.id, "claim-d", send)).toBeUndefined();
  });

  test("no Confirmed without a claim on a terminal; Unknown settles only on definite evidence", async () => {
    const m = machine();
    const intent = await open(m, "terminal");
    await m.dispatch(intent.id);
    expect(await m.report(intent.id, { kind: "confirmed" })).toMatchObject({ state: "dispatched" });
    // Unclaimed, it is not lost: its claim window decides.
    expect(await m.report(intent.id, { kind: "lost" })).toMatchObject({ state: "dispatched" });
    await m.claim(intent.id, "claim-a", send);
    await m.report(intent.id, { kind: "evidence", evidence: { pid: 77, pid_started_at: now } });
    expect(await m.report(intent.id, { kind: "lost" })).toMatchObject({ state: "unknown" });
    expect(await m.claim(intent.id, "claim-b", send)).toBeUndefined();
    expect(await m.dispatch(intent.id)).toMatchObject({ state: "unknown" });
    expect(
      await m.report(intent.id, { kind: "confirmed", evidence: { bound_at: now } }),
    ).toMatchObject({
      state: "confirmed",
      reason: null,
      evidence: { claim: "claim-a", pid: 77, bound_at: now },
    });
    expect(calls.dispatch).toHaveLength(1);
  });

  test("restart recovery follows each route's rule and never dispatches", async () => {
    const m = machine();
    // Intents a crashed service left in Dispatching.
    const make = async (route: Route, instance: string, evidence = {}) => {
      const intent = await open(m, route, instance);
      return store().transitionIntent(intent.id, "prepared", "dispatching", { evidence });
    };
    const terminal = await make("terminal", "t-open");
    const claimed = await make("terminal", "t-claimed");
    await store().transitionIntent(claimed.id, "dispatching", "dispatched", {
      evidence: { claim: "claim-x", claimed_at: now },
    });
    const link = await make("link", "link");
    const cli = await make("t3-cli", "t3-cli");
    const clip = await make("clipboard", "clip");
    const same = await make("t3-mcp", "t3-same", { grant: "grant-1" });
    const regranted = await make("t3-mcp", "t3-old", { grant: "grant-0" });
    observation = { kind: "lost" };
    const recovered = new Map((await machine().recover()).map((i) => [i.id, i]));
    expect(recovered.get(terminal.id)?.state).toBe("dispatching");
    expect(recovered.get(claimed.id)).toMatchObject({ state: "unknown", reason: "lost" });
    expect(recovered.get(link.id)).toMatchObject({ state: "unknown", reason: "lost" });
    expect(recovered.get(cli.id)).toMatchObject({ state: "unknown", reason: "lost" });
    expect(recovered.get(clip.id)).toMatchObject({ state: "failed", reason: "interrupted" });
    expect(recovered.get(same.id)).toMatchObject({
      state: "dispatched",
      evidence: { thread: "thr-1" },
    });
    expect(recovered.get(regranted.id)).toMatchObject({ state: "unknown", reason: "regranted" });
    expect(calls.replay.map((i) => i.id)).toEqual([same.id]);
    expect(calls.dispatch).toEqual([]);
    // The unclaimed terminal launch ends only when its claim window has passed.
    pass(CLAIM_WINDOW_MS + 1);
    await machine().recover();
    expect(await store().readIntent(terminal.id)).toMatchObject({
      state: "failed",
      reason: "not_claimed",
    });
    expect(calls.dispatch).toEqual([]);
  });

  test("restart recovery makes an accepted T3 CLI launch Unknown, as A4 3.9.3's table says", async () => {
    const m = machine();
    const cli = await open(m, "t3-cli", "t3-cli-accepted");
    await m.dispatch(cli.id);
    expect((await store().readIntent(cli.id))?.state).toBe("dispatched");
    await machine().recover();
    expect(await store().readIntent(cli.id)).toMatchObject({ state: "unknown", reason: "lost" });
  });

  test("a clipboard launch is never Unknown: an unclear copy is Failed", async () => {
    const m = machine();
    outcome = { kind: "unknown" };
    const clip = await open(m, "clipboard", "clip-unclear");
    expect(await m.dispatch(clip.id)).toMatchObject({ state: "failed", reason: "refused" });
  });

  test("two claims at once, even with one claim ID, get one reply", async () => {
    const m = machine();
    const intent = await open(m, "terminal");
    await m.dispatch(intent.id);
    const replies = await Promise.all([
      m.claim(intent.id, "claim-same", send),
      m.claim(intent.id, "claim-same", send),
      machine().claim(intent.id, "claim-same", send),
    ]);
    expect(replies.filter((r) => r !== undefined)).toHaveLength(1);
    expect(calls.replies).toEqual([`${intent.id}:dispatched`]);
    expect((await store().readIntent(intent.id))?.evidence.claim).toBe("claim-same");
  });

  test("a sweep that read an intent before its claim never fails the claimed launch", async () => {
    const intent = await open(machine(), "terminal");
    await machine().dispatch(intent.id);
    pass(CLAIM_WINDOW_MS - 1);
    // The sweep reads its open work, then waits while the shim claims and the clock moves on.
    const held = gate();
    const sweeper = machineOn({
      transitionIntent: (...args) => store().transitionIntent(...args),
      readIntent: (id) => store().readIntent(id),
      createIntent: (input, id) => store().createIntent(input, id),
      openWork: async (m) => {
        const work = await store().openWork(m);
        await held.wait;
        return work;
      },
    });
    const sweeping = sweeper.sweep();
    expect(await machine().claim(intent.id, "claim-a", send)).toBeDefined();
    pass(2);
    held.open();
    expect(await sweeping).toEqual([]);
    expect(await store().readIntent(intent.id)).toMatchObject({
      state: "dispatched",
      reason: null,
      evidence: { claim: "claim-a" },
    });
  });

  test("recovery and a lost report wait for the dispatch in progress, then apply to what it recorded", async () => {
    const m = machine();
    const intent = await open(m, "link");
    // Dispatching commits, and its answer is held: the step has not run yet.
    const held = gate();
    let committed!: () => void;
    const dispatchingCommitted = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const live = machineOn({
      createIntent: (input, id) => store().createIntent(input, id),
      readIntent: (id) => store().readIntent(id),
      openWork: (machineId) => store().openWork(machineId),
      transitionIntent: async (...args) => {
        const after = await store().transitionIntent(...args);
        if (after.state === "dispatching") {
          committed();
          await held.wait;
        }
        return after;
      },
    });
    const dispatching = live.dispatch(intent.id);
    await dispatchingCommitted;
    const recovering = live.recover();
    const reporting = live.report(intent.id, { kind: "lost" });
    for (let n = 0; n < 20; n += 1) await Promise.resolve();
    // Neither has acted while the dispatch owns the intent.
    expect(await store().readIntent(intent.id)).toMatchObject({ state: "dispatching" });
    held.open();
    expect(await dispatching).toMatchObject({ state: "dispatched" });
    expect(calls.states).toEqual(["dispatching"]);
    // In the order they reached the intent: the report first (recovery listed its work before).
    expect(await reporting).toMatchObject({ state: "unknown", reason: "lost" });
    expect((await recovering).map((i) => [i.id, i.state])).toEqual([[intent.id, "unknown"]]);
  });

  test("a confirmation that arrives while the call is still open waits for it and is kept", async () => {
    const intent = await open(machine(), "link");
    const held = gate();
    const m = new LaunchMachine({
      store: store(),
      machine: MACHINE,
      now: () => now,
      elapsed: () => mono,
      wait,
      steps: {
        dispatch: async () => {
          await held.wait;
          return { kind: "accepted" };
        },
      },
      recovery: {
        observe: () => Promise.resolve(observation),
        grant: () => Promise.resolve(grant),
        replay: () => Promise.resolve<DispatchOutcome>({ kind: "unknown" }),
      },
    });
    const dispatching = m.dispatch(intent.id);
    // The opener has not returned, and the agent's bridge already redeemed the reference.
    await until(async () => (await store().readIntent(intent.id))?.state === "dispatching");
    const confirming = m.report(intent.id, { kind: "confirmed", evidence: { bound_at: now } });
    for (let n = 0; n < 20; n += 1) await Promise.resolve();
    expect(await store().readIntent(intent.id)).toMatchObject({ state: "dispatching" });
    held.open();
    expect(await dispatching).toMatchObject({ state: "dispatched" });
    expect(await confirming).toMatchObject({ state: "confirmed", evidence: { bound_at: now } });
  });

  test("a lost T3 reply is repeated at once with the same key, under the same grant only", async () => {
    const m = machine();
    outcome = { kind: "unknown" };
    const same = await open(m, "t3-mcp", "t3-lost");
    expect(await m.dispatch(same.id, { grant: "grant-1" })).toMatchObject({
      state: "dispatched",
      evidence: { grant: "grant-1", thread: "thr-1" },
    });
    expect(calls.replay.map((i) => i.id)).toEqual([same.id]);
    const regranted = await open(m, "t3-mcp", "t3-regranted");
    grant = "grant-2";
    expect(await m.dispatch(regranted.id, { grant: "grant-1" })).toMatchObject({
      state: "unknown",
      reason: "regranted",
    });
    expect(calls.replay).toHaveLength(1);
    expect(calls.dispatch).toHaveLength(2);
  });

  test("a wall clock step neither stretches nor ends this service's windows", async () => {
    const m = machine();
    const late = await open(m, "terminal", "late");
    await m.dispatch(late.id);
    const prepared = await open(m, "link", "prepared-link");
    // The wall clock steps back an hour, then two minutes pass: the claim window is over.
    step(-3_600_000);
    pass(CLAIM_WINDOW_MS + 1_000);
    expect(await m.claim(late.id, "claim-late", send)).toBeUndefined();
    expect((await m.sweep()).map((i) => [i.id, i.reason])).toEqual([[late.id, "not_claimed"]]);
    // Two minutes is not ten: the Prepared intent is still young.
    expect(await m.dispatch(prepared.id)).toMatchObject({ state: "dispatched" });
    // The wall clock jumps two hours ahead, and no time passes: nothing is over.
    const fresh = await open(m, "terminal", "fresh");
    await m.dispatch(fresh.id);
    const ready = await open(m, "link", "ready");
    step(7_200_000);
    expect(await m.claim(fresh.id, "claim-fresh", send)).toBeDefined();
    expect(await m.dispatch(ready.id)).toMatchObject({ state: "dispatched" });
    expect(await m.sweep()).toEqual([]);
    // Ten minutes pass: a Prepared intent expires, whatever the wall clock did.
    const slow = await open(m, "link", "slow");
    step(-7_200_000);
    pass(PREPARED_TTL_MS);
    expect(await m.dispatch(slow.id)).toMatchObject({ state: "failed", reason: "expired" });
  });

  test("after a restart the wall clock decides, and an instant far from it has passed", async () => {
    const m = machine();
    const unclaimed = await open(m, "terminal", "unclaimed");
    await m.dispatch(unclaimed.id);
    const prepared = await open(m, "link", "prepared");
    step(-3_600_000);
    // A new service knows only the records' instants: an hour away is past every window.
    const restarted = machine();
    expect(await restarted.claim(unclaimed.id, "claim-x", send)).toBeUndefined();
    expect(await restarted.dispatch(prepared.id)).toMatchObject({
      state: "failed",
      reason: "expired",
    });
    expect(calls.dispatch.map((i) => i.id)).toEqual([unclaimed.id]);
  });

  test("a click repeated after the clock stepped back keeps its age", async () => {
    const input = {
      task: randomId("t"),
      instance: "codex-work",
      route: "link" as const,
      place: null,
      taskVersion: 1,
      briefHash: "c".repeat(64),
    };
    const first = await machine().open(input, "machine-click-replayed-01");
    pass(20 * 60_000);
    step(-3_600_000);
    // A new service, and the same request again: the click is 20 minutes old, not new.
    const restarted = machine();
    const again = await restarted.open(input, "machine-click-replayed-01");
    expect(again.id).toBe(first.id);
    expect(await restarted.dispatch(again.id)).toMatchObject({
      state: "failed",
      reason: "expired",
    });
    expect(calls.dispatch).toEqual([]);
  });

  test("recovery and a lost report wait for a claim's reply, which leaves before Unknown", async () => {
    const m = machine();
    const intent = await open(m, "terminal");
    await m.dispatch(intent.id);
    observation = { kind: "lost" };
    let later: Promise<unknown>[] = [];
    const claimed = await m.claim(intent.id, "claim-a", async (held) => {
      // While the reply is under way, this service's recovery and reports wait for it.
      later = [m.recover(), m.report(held.id, { kind: "lost" })];
      for (let n = 0; n < 20; n += 1) await Promise.resolve();
      await send(held);
    });
    expect(claimed?.evidence.claim).toBe("claim-a");
    expect(calls.replies).toEqual([`${intent.id}:dispatched`]);
    // Once the reply has left, a shim that is gone is lost.
    const [recovered, reported] = await Promise.all(later);
    expect(reported).toMatchObject({ state: "unknown", reason: "lost" });
    expect(recovered).toMatchObject([{ state: "unknown", reason: "lost" }]);
  });

  test("two recoveries at once repeat a T3 launch once, never after the other made it Unknown", async () => {
    // A crash left a T3 launch in Dispatching.
    const intent = await open(machine(), "t3-mcp", "t3-twice");
    await store().transitionIntent(intent.id, "prepared", "dispatching", {
      evidence: { grant: "grant-1" },
    });
    const restarted = machine();
    // The first recovery asks for the grant and waits for the answer; TTasks then re-pairs.
    const held = gate();
    grantGate = held.wait;
    const first = restarted.recover();
    // Until the recovery has asked: the grant step takes the gate when it is called.
    const asked = (): boolean => grantGate === undefined;
    await until(() => Promise.resolve(asked()));
    grant = "grant-2";
    const second = restarted.recover();
    const reporting = restarted.report(intent.id, { kind: "lost" });
    for (let n = 0; n < 20; n += 1) await Promise.resolve();
    expect(await store().readIntent(intent.id)).toMatchObject({ state: "dispatching" });
    held.open();
    // The repeat was recorded before it was sent, under the grant the recovery read.
    expect(await first).toMatchObject([
      { state: "dispatched", evidence: { thread: "thr-1", replayed_at: now } },
    ]);
    expect(await reporting).toMatchObject({ state: "unknown", reason: "lost" });
    expect(await second).toMatchObject([{ state: "unknown", reason: "lost" }]);
    expect(calls.replay).toHaveLength(1);
  });

  test("a refused T3 repeat makes the launch Unknown: the first call may have made the thread", async () => {
    const m = machine();
    outcome = { kind: "unknown" };
    repeat = { kind: "refused" };
    const live = await open(m, "t3-mcp", "t3-refused-live");
    expect(await m.dispatch(live.id, { grant: "grant-1" })).toMatchObject({
      state: "unknown",
      reason: "no_answer",
    });
    const crashed = await open(m, "t3-mcp", "t3-refused-crash");
    await store().transitionIntent(crashed.id, "prepared", "dispatching", {
      evidence: { grant: "grant-1" },
    });
    expect(await machine().recover()).toMatchObject([{ state: "unknown", reason: "no_answer" }]);
  });

  test("a confirmation in Dispatching is one commit, so none is left half-applied to finish", async () => {
    for (const evidence of [
      undefined,
      { bound_at: now },
      { folder_checked: true, thread: "t-1" },
    ]) {
      const intent = await open(machine(), "link", `whole-${String(durable.history.length)}`);
      await store().transitionIntent(intent.id, "prepared", "dispatching");
      const before = durable.history.length;
      expect(
        await machine().report(intent.id, { kind: "confirmed", ...(evidence ? { evidence } : {}) }),
      ).toMatchObject({ state: "confirmed", evidence: evidence ?? {} });
      expect(durable.history.slice(before)).toEqual([
        { id: intent.id, from: "dispatching", to: "confirmed" },
      ]);
    }
  });

  test("with the default timer, a step that never answers ends at its deadline", async () => {
    const m = new LaunchMachine({
      store: store(),
      machine: MACHINE,
      now: () => now,
      elapsed: () => mono,
      deadlines: { step: 20 },
      steps: { dispatch: () => new Promise<DispatchOutcome>(() => undefined) },
      recovery: {
        observe: () => Promise.resolve(observation),
        grant: () => Promise.resolve(grant),
        replay: () => Promise.resolve<DispatchOutcome>({ kind: "unknown" }),
      },
    });
    const intent = await open(m, "link", "default-timer");
    expect(await m.dispatch(intent.id)).toMatchObject({ state: "unknown", reason: "no_answer" });
    expect(m.owned()).toEqual([]);
  });

  test("a clipboard launch is never lost", async () => {
    const m = machine();
    const clip = await open(m, "clipboard", "clip-lost");
    await m.dispatch(clip.id);
    expect(await m.report(clip.id, { kind: "lost" })).toMatchObject({ state: "dispatched" });
  });
});

/**
 * Waits, a bounded number of turns, until `holds` is true. A bare loop on microtasks would starve
 * the timers, so a call that never gets there would hang the run instead of failing the test.
 */
async function until(holds: () => Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (await holds()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("The condition never held");
}

/** A promise a test opens when it wants a held call to go on. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** A machine with the stub steps over another store. */
function machineOn(over: LaunchStore): LaunchMachine {
  return new LaunchMachine({
    store: over,
    machine: MACHINE,
    now: () => now,
    elapsed: () => mono,
    wait,
    steps: {
      dispatch: async (intent) => {
        calls.states.push((await store().readIntent(intent.id))?.state ?? "missing");
        calls.dispatch.push(intent);
        return outcome;
      },
    },
    recovery: {
      observe: () => Promise.resolve(observation),
      grant: () => Promise.resolve(grant),
      replay: () => Promise.resolve<DispatchOutcome>({ kind: "unknown" }),
    },
  });
}
