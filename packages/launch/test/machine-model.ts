// A model of the world around the launch state machine, for the property test (A4 5.1, 5.2): fake
// terminals with their shims, a fake URL opener, a fake T3 that keys idle threads by grant and
// launch, a wall clock that can step either way, a monotonic clock that only time moves and the
// timers that run on it, and a fault injector. The injector kills the service at any call to the
// store or to an external step, before or after the call takes effect, recovery included, and makes
// any such call slow: it takes effect late, answers late, or never answers at all. The calls of the
// service do not wait for each other: each event starts its call, and a call that waits on time
// stays under way while later events start theirs, so slow calls, reports, sweeps, recoveries and
// claims interleave in any order. Every call also waits a seeded number of microtask turns first.
// The machine is the real one, over a real store; the world counts what it started, so the
// invariants can be checked after every event. The model's rules are its own: it imports no table
// of the implementation's.
import { expect } from "vitest";
import { CLAIM_WINDOW_MS, PREPARED_TTL_MS, ROUTES, type Route } from "../src/intents.ts";
import {
  LaunchMachine,
  type DispatchOutcome,
  type LaunchSteps,
  type Observation,
  type RecoverySteps,
} from "../src/machine.ts";
import type { ExecutionStore, LaunchIntent, NewIntent } from "../src/store.ts";

/** The service died. Nothing it does after this reaches the world or the store. */
export class Crash extends Error {
  override readonly name = "Crash";
}

/** The deadlines the model gives the machine: a call to the store, and an external step. */
export const DEADLINES = { store: 15_000, step: 30_000 } as const;

/** A4 3.9.1's edges, written out here so a wrong table in the implementation cannot pass. */
const MODEL_EDGES: Readonly<Record<string, readonly string[]>> = {
  prepared: ["dispatching", "failed"],
  // A self edge records the T3 repeat before it is sent; a confirmation is one step.
  dispatching: ["dispatching", "dispatched", "confirmed", "failed", "unknown"],
  dispatched: ["dispatched", "confirmed", "failed", "unknown"],
  confirmed: ["confirmed"],
  failed: [],
  unknown: ["confirmed", "failed"],
};

/** The reasons of Failed that say no session started. The others are an agent's own report. */
const NOTHING_STARTED = ["expired", "cancelled", "refused", "not_claimed", "interrupted"];

/** A backend for the model: a durable store the service reaches, and a restart. */
export interface ModelBackend {
  machine: string;
  /** The store on the durable state as it is now, unwrapped: the checker reads through it. */
  durable(): ExecutionStore;
  /** Drops the service's store and returns a new one on the same durable state. */
  restart(): Promise<ExecutionStore>;
  /** Two tasks of the space. */
  tasks: readonly string[];
  /** Every committed transition so far, when the backend can list them. */
  history?: () => readonly { from: string | null; to: string }[];
}

/**
 * How one call is slow: it takes effect late and answers then (`effect`), takes effect at once and
 * answers late (`reply`), never answers, having taken effect or not (`hang`), or never answers and
 * takes effect right after the `calls`-th next store call of the service has taken effect (`late`):
 * a write whose caller gave up, landing inside a later call.
 */
export type Slow =
  | { mode: "effect" | "reply"; ms: number }
  | { mode: "hang"; effect: boolean }
  | { mode: "late"; calls: number };

/** What the live service does: each starts a call, which may still be under way at the next. */
export type LiveEvent =
  | { kind: "click"; task: number; instance: number; route: Route; repeat: boolean }
  /** `crash`: the service dies right after the external step took effect (A4 5.2). */
  | { kind: "confirm"; pick: number; crash: boolean }
  /** `same`: the shim sends the claim ID it sent before (a retry, or a duplicate request). */
  | { kind: "claim"; pick: number; same: boolean }
  | {
      kind: "report";
      pick: number;
      what: "started" | "settled" | "exited" | "bound" | "checked" | "lost";
    }
  | { kind: "sweep" }
  /** Start-up recovery while live calls already run (A4 3.9.3). */
  | { kind: "recover" }
  /** Time passes: both clocks move, and the timers due on the way fire. */
  | { kind: "tick"; ms: number };

export type Event =
  | LiveEvent
  | { kind: "outcome"; value: "accepted" | "refused" | "unknown" | "throws" }
  /** The wall clock steps, and no time passes. */
  | { kind: "step"; ms: number }
  | { kind: "arm"; after: number; late: boolean }
  /** The `after`-th next call of the service to the store or to the world is slow. */
  | { kind: "slow"; after: number; slow: Slow }
  | { kind: "crash" }
  /** A restart. With `fault`, the new service may die again during its recovery. */
  | { kind: "restart"; fault?: { after: number; late: boolean } }
  | { kind: "regrant" }
  /**
   * Two calls at once; the second starts right after the first's `delay`-th call returns. A
   * `twin` second is the first again: the same click, confirmation, report or sweep, or the same
   * claim with the same claim ID.
   */
  | { kind: "together"; first: LiveEvent; second: LiveEvent; twin: boolean; delay: number };

export { ROUTES };

/** A small seeded generator (mulberry32), so a failing scenario replays the same interleaving. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Lets every reaction of the service run: microtasks drain before a macrotask turn. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Timer {
  at: number;
  seq: number;
  fire: () => void;
  live: boolean;
}

/** Model time: the wall clock, the monotonic clock and the timers that run on the latter. */
export class Time {
  /** The wall clock, which can step either way. */
  now = Date.UTC(2026, 10, 13, 9, 0, 0);
  /** A monotonic clock: only time passing moves it. */
  mono = 1_000;
  #timers: Timer[] = [];
  #seq = 0;

  /** Runs `fire` once `ms` have passed. Returns its cancellation. */
  schedule(ms: number, fire: () => void): () => void {
    const timer: Timer = { at: this.mono + ms, seq: (this.#seq += 1), fire, live: true };
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  /** Resolves once `ms` have passed, or never when `signal` aborts first. The machine's timer. */
  readonly wait = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      const cancel = this.schedule(ms, resolve);
      signal?.addEventListener("abort", cancel, { once: true });
    });

  /** The timers still to fire. */
  get pending(): number {
    return this.#timers.filter((t) => t.live).length;
  }

  /**
   * Time passes: both clocks move by `ms`, and each timer due on the way fires at its moment, with
   * every reaction of the service run before the next.
   */
  async pass(ms: number): Promise<void> {
    const end = this.mono + ms;
    for (;;) {
      this.#timers = this.#timers.filter((t) => t.live);
      let next: Timer | undefined;
      for (const timer of this.#timers) {
        if (timer.at > end) continue;
        if (
          next === undefined ||
          timer.at < next.at ||
          (timer.at === next.at && timer.seq < next.seq)
        )
          next = timer;
      }
      if (next === undefined) break;
      this.now += next.at - this.mono;
      this.mono = next.at;
      next.live = false;
      next.fire();
      await settle();
    }
    this.now += end - this.mono;
    this.mono = end;
    await settle();
  }
}

/** One life of the service, from a start to its death. */
class Life {
  #over = false;

  end(): void {
    this.#over = true;
  }

  /** Whether the service of this life has died. A method: it changes across awaits. */
  over(): boolean {
    return this.#over;
  }
}

/**
 * Kills the service at its n-th next call to the store or to a step, makes a chosen call slow, and
 * spaces the calls.
 */
class Faults {
  life = new Life();
  #countdown: number | undefined;
  #late = false;
  #slow: { calls: number; slow: Slow } | undefined;
  readonly #random: () => number;
  readonly #time: Time;
  /** Runs once, right after the n-th next call returns: the start of a second call. */
  #after: { calls: number; then: () => void } | undefined;
  /**
   * Calls held until the `calls`-th next store call has taken effect (`late`): for a held write
   * on an intent, the `calls`-th next write on that intent, so it lands inside a later call's
   * commit and its answer.
   */
  #held: { calls: number; key: string | undefined; land: () => void }[] = [];

  constructor(random: () => number, time: Time) {
    this.#random = random;
    this.#time = time;
  }

  /** Runs `then` right after the `calls`-th next call has returned (at once for 0). */
  after(calls: number, then: () => void): void {
    if (calls <= 0) then();
    else this.#after = { calls, then };
  }

  /** Forgets a pending `after` and returns it, when it was still waiting. */
  cancelAfter(): (() => void) | undefined {
    const then = this.#after?.then;
    this.#after = undefined;
    return then;
  }

  /** A store call has taken effect: the held calls due land now, before its caller hears back. */
  #stored(key: string | undefined): void {
    const due: (() => void)[] = [];
    for (const held of this.#held) {
      if (held.key !== undefined && held.key !== key) continue;
      held.calls -= 1;
      if (held.calls <= 0) due.push(held.land);
    }
    this.#held = this.#held.filter((held) => held.calls > 0);
    for (const land of due) land();
  }

  #returned(): void {
    if (this.#after === undefined) return;
    this.#after.calls -= 1;
    if (this.#after.calls > 0) return;
    const { then } = this.#after;
    this.#after = undefined;
    then();
  }

  arm(after: number, late: boolean): void {
    this.#countdown = after;
    this.#late = late;
  }

  slowNext(after: number, slow: Slow): void {
    this.#slow = { calls: after, slow };
  }

  /** Lands every held call now: what is still in flight reaches the store or the world. */
  landHeld(): void {
    const held = this.#held;
    this.#held = [];
    for (const { land } of held) land();
  }

  /** No more deaths or slow calls from now on; the calls already slow stay so. */
  calm(): void {
    this.#countdown = undefined;
    this.#slow = undefined;
  }

  /** The service dies: nothing it still does reaches the store. */
  kill(): void {
    this.life.end();
    this.calm();
  }

  /** A new life after a restart. */
  revive(): Life {
    this.life = new Life();
    this.calm();
    return this.life;
  }

  /** A call of the service in `life`, to its store or to the world. */
  async around<T>(
    where: "store" | "world",
    life: Life,
    call: () => Promise<T>,
    key?: string,
  ): Promise<T> {
    // A few microtask turns first, so calls that run at once interleave in many orders.
    for (let n = Math.floor(this.#random() * 4); n > 0; n -= 1) await Promise.resolve();
    if (life.over()) throw new Crash();
    // A store call that has taken effect lets the held calls due land, before its caller hears.
    const run =
      where === "store"
        ? () =>
            call().finally(() => {
              this.#stored(key);
            })
        : call;
    if (life === this.life && this.#countdown !== undefined) {
      this.#countdown -= 1;
      if (this.#countdown <= 0) {
        this.kill();
        // Late: the call takes effect, and the service dies before it hears the answer.
        if (this.#late) await run().catch(() => undefined);
        throw new Crash();
      }
    }
    let slow: Slow | undefined;
    if (life === this.life && this.#slow !== undefined) {
      this.#slow.calls -= 1;
      if (this.#slow.calls <= 0) {
        slow = this.#slow.slow;
        this.#slow = undefined;
      }
    }
    if (slow?.mode === "hang") {
      // It never answers: the caller's deadline is all that ends its wait.
      if (slow.effect) run().catch(() => undefined);
      return new Promise<T>(() => undefined);
    }
    if (slow?.mode === "late") {
      // It never answers, and lands inside a later call, once its caller has likely given up.
      this.#held.push({
        calls: slow.calls,
        key,
        land: () => {
          // A store write still queued when the service died died with it. The world goes on.
          if (where === "store" && life.over()) return;
          run().catch(() => undefined);
        },
      });
      return new Promise<T>(() => undefined);
    }
    try {
      if (slow?.mode === "effect") {
        await this.#time.wait(slow.ms);
        // A store write still queued when the service died died with it. The world goes on.
        if (life.over() && where === "store") throw new Crash();
        return await run();
      }
      if (slow?.mode === "reply") {
        const answer = run();
        answer.catch(() => undefined);
        await this.#time.wait(slow.ms);
        if (life.over()) throw new Crash();
        return await answer;
      }
      return await run();
    } finally {
      this.#returned();
    }
  }
}

/** The store as the service sees it in one life: every call can be the one it dies at, or slow. */
function faulty(store: ExecutionStore, faults: Faults, life: Life): ExecutionStore {
  return {
    createIntent: (input, requestId) =>
      faults.around("store", life, () => store.createIntent(input, requestId)),
    transitionIntent: (id, expect, next, outcome) =>
      faults.around("store", life, () => store.transitionIntent(id, expect, next, outcome), id),
    readIntent: (id) => faults.around("store", life, () => store.readIntent(id)),
    openWork: (machine) => faults.around("store", life, () => store.openWork(machine)),
  };
}

interface Window {
  intent: string;
  /** waiting: not claimed yet; noreply: claimed, the service died before the reply. */
  shim: "waiting" | "noreply" | "replied" | "refused";
  agent: "none" | "running" | "settled" | "exited";
  /** The claim ID the shim sent last. */
  claim?: string;
}

/** An error a call of the service may end with without breaking a rule. */
const expected = (error: unknown): boolean =>
  error instanceof Crash || (error instanceof Error && error.name === "DeadlinePassed");

export class World {
  readonly time = new Time();
  readonly backend: ModelBackend;
  readonly faults: Faults;
  #grant = 1;
  #store: ExecutionStore;
  #life: Life;
  machine: LaunchMachine;
  /** Intents the service created, in order. */
  readonly intents: string[] = [];
  readonly windows: Window[] = [];
  readonly dispatches = new Map<string, number>();
  readonly agents = new Map<string, number>();
  readonly threads = new Map<string, Set<string>>();
  readonly #t3 = new Map<string, string>();
  /** Intents the durable state has shown in Unknown. */
  readonly unknownSeen = new Set<string>();
  #outcome: "accepted" | "refused" | "unknown" | "throws" = "accepted";
  #last: { input: Omit<NewIntent, "machine">; requestId: string } | undefined;
  #counter = 0;
  /** Intents whose next dispatch takes effect, and the service dies before it hears the answer. */
  readonly #dieAfter = new Set<string>();
  /** Every call the world made to the machine, until it ends. */
  readonly #calls = new Set<Promise<void>>();
  /** What a call ended with other than a crash or a passed deadline: a broken expectation. */
  readonly #errors: unknown[] = [];
  /**
   * Rules broken inside an external step. They are recorded, not thrown: the machine catches
   * what a step throws (a step that fails cannot tell what happened), so a thrown assertion
   * would be lost. `check` fails on any.
   */
  readonly violations: string[] = [];

  #require(holds: boolean, rule: string): void {
    if (!holds) this.violations.push(rule);
  }

  readonly #random: () => number;

  constructor(backend: ModelBackend, seed = 1) {
    this.backend = backend;
    this.#random = seeded(seed);
    this.faults = new Faults(this.#random, this.time);
    this.#life = this.faults.life;
    this.#store = backend.durable();
    this.machine = this.#machine();
  }

  /** The wall clock: the stores of the tests read it. */
  get now(): number {
    return this.time.now;
  }

  get grant(): string {
    return `grant-${String(this.#grant)}`;
  }

  /**
   * An external step of the service: the machine calls it on a record it has just committed, and
   * it takes effect a while later. Until its deadline its call owns the intent, so nothing changes
   * the record in between; after it, the machine has given up on the step, and a late effect
   * happens on a record the machine has moved on from as A4 says for not knowing.
   */
  async #step<T>(
    life: Life,
    what: string,
    intent: LaunchIntent,
    holds: (now: LaunchIntent | undefined) => boolean,
    effect: () => T | Promise<T>,
  ): Promise<T> {
    const called = this.time.mono;
    const now = await this.backend.durable().readIntent(intent.id);
    this.#require(holds(now), `${what} starts only from its durable state`);
    this.#require(
      now?.version === intent.version,
      `${what} starts on the record the machine committed, as it committed it`,
    );
    this.#require(
      now?.state !== "unknown" && !this.unknownSeen.has(intent.id),
      `Unknown never leads to ${what}`,
    );
    return this.faults.around("world", life, async () => {
      // It takes a while: other calls of the service run meanwhile.
      for (let n = Math.floor(this.#random() * 9); n > 0; n -= 1) await Promise.resolve();
      const then = await this.backend.durable().readIntent(intent.id);
      const givenUp = life.over() || this.time.mono - called >= DEADLINES.step;
      this.#require(
        givenUp || then?.version === intent.version,
        `${what} takes effect while its call still owns the intent`,
      );
      return effect();
    });
  }

  #machine(): LaunchMachine {
    const life = this.#life;
    const steps: LaunchSteps = {
      dispatch: async (intent) => {
        const outcome = await this.#step(
          life,
          "a dispatch",
          intent,
          (now) => now?.state === "dispatching",
          () => this.#dispatch(intent),
        );
        if (this.#dieAfter.delete(intent.id)) {
          this.faults.kill();
          throw new Crash();
        }
        return outcome;
      },
    };
    const recovery: RecoverySteps = {
      observe: (intent) =>
        this.faults.around("world", life, () => Promise.resolve(this.#observe(intent))),
      grant: () => this.faults.around("world", life, () => Promise.resolve(this.grant)),
      replay: (intent) =>
        this.#step(
          life,
          "a T3 repeat",
          intent,
          (now) => now?.state === "dispatching",
          () => this.#replay(intent),
        ),
    };
    return new LaunchMachine({
      store: faulty(this.#store, this.faults, life),
      machine: this.backend.machine,
      steps,
      recovery,
      now: () => this.time.now,
      elapsed: () => this.time.mono,
      wait: this.time.wait,
      deadlines: DEADLINES,
    });
  }

  #bump(map: Map<string, number>, id: string): void {
    map.set(id, (map.get(id) ?? 0) + 1);
  }

  /** T3's idle-thread create: idempotent per grant and key, so a repeat returns the same thread. */
  #t3Create(grant: string, intent: string): string {
    const key = `${grant}|${intent}`;
    let thread = this.#t3.get(key);
    if (thread === undefined) {
      thread = `thread-${String((this.#counter += 1))}`;
      this.#t3.set(key, thread);
      const set = this.threads.get(intent) ?? new Set<string>();
      set.add(thread);
      this.threads.set(intent, set);
    }
    return thread;
  }

  /** The route's external call, as it takes effect. */
  #dispatch(intent: LaunchIntent): DispatchOutcome {
    this.#bump(this.dispatches, intent.id);
    const outcome = this.#outcome;
    if (outcome === "refused") return { kind: "refused" };
    let accepted: DispatchOutcome = { kind: "accepted" };
    switch (intent.route) {
      case "terminal":
        this.windows.push({ intent: intent.id, shim: "waiting", agent: "none" });
        break;
      case "link":
        // The app opens with the brief and starts its session.
        this.#bump(this.agents, intent.id);
        break;
      case "t3-mcp": {
        // T3 refuses a token of an earlier grant (401) before it creates anything.
        if (intent.evidence.grant !== this.grant) return { kind: "refused" };
        accepted = {
          kind: "accepted",
          evidence: { thread: this.#t3Create(this.grant, intent.id) },
        };
        break;
      }
      case "t3-cli":
        // `t3 thread start` creates a thread and sends the brief: an agent turn.
        this.#t3Create(this.grant, intent.id);
        this.#bump(this.agents, intent.id);
        break;
      case "clipboard":
        break;
    }
    if (outcome === "unknown") return { kind: "unknown" };
    if (outcome === "throws") throw new Error("The opener failed after it ran");
    return accepted;
  }

  /** What recovery observes of a claimed terminal launch: the shim, if it re-attached. */
  #observe(intent: LaunchIntent): Observation {
    const window = this.windows.find((w) => w.intent === intent.id && w.shim === "replied");
    if (window === undefined) return { kind: "lost" };
    if (window.agent === "settled") return { kind: "confirmed" };
    if (window.agent === "exited") return { kind: "failed", reason: "agent_exited" };
    return { kind: "pending" };
  }

  /** T3's repeat of the idle-thread create, as it takes effect. Its answer can be lost too. */
  #replay(intent: LaunchIntent): DispatchOutcome {
    // The adapter sends only while its pairing is still the intent's grant, checked at the send
    // (A4 3.9.2, M2.11): a re-pairing after the machine read the grant creates nothing.
    if (intent.evidence.grant !== this.grant) return { kind: "refused" };
    // T3 refuses the repeat (an error before it creates anything): the first call's thread, if
    // it made one, is still there.
    if (this.#outcome === "refused") return { kind: "refused" };
    // T3 keys the thread by the current grant: under a new one, the same key makes a second.
    const thread = this.#t3Create(this.grant, intent.id);
    if (this.#outcome === "unknown") return { kind: "unknown" };
    if (this.#outcome === "throws") throw new Error("T3 did not answer");
    return { kind: "accepted", evidence: { thread } };
  }

  /** Starts a call of the service; the world does not wait for it to end. */
  #start(call: () => Promise<unknown>): void {
    const task = (async () => {
      await call();
    })().catch((error: unknown) => {
      if (!expected(error)) this.#errors.push(error);
    });
    this.#calls.add(task);
    void task.finally(() => this.#calls.delete(task));
  }

  /** Runs one event, and lets the service react. A Crash ends the service until the next restart. */
  async run(event: Event): Promise<void> {
    try {
      await this.#run(event);
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
    }
    await settle();
    await this.check();
  }

  async #run(event: Event): Promise<void> {
    switch (event.kind) {
      case "click":
      case "confirm":
      case "claim":
      case "report":
      case "sweep":
      case "recover":
        this.#start(() => this.#live(event));
        return;
      case "tick":
        await this.time.pass(event.ms);
        return;
      case "outcome":
        this.#outcome = event.value;
        return;
      case "step":
        this.time.now += event.ms;
        return;
      case "arm":
        if (!this.#life.over()) this.faults.arm(event.after, event.late);
        return;
      case "slow":
        if (!this.#life.over()) this.faults.slowNext(event.after, event.slow);
        return;
      case "crash":
        this.faults.kill();
        return;
      case "restart":
        await this.restart(event.fault);
        return;
      case "regrant":
        this.#grant += 1;
        return;
      case "together": {
        // The second call starts right after the first's `delay`-th call to the store or a step
        // returns, or once the first and every reaction to it have run, whichever comes first.
        let start!: () => void;
        const started = new Promise<void>((resolve) => {
          start = resolve;
        });
        this.faults.after(event.delay, start);
        const second: LiveEvent = !event.twin
          ? event.second
          : event.first.kind === "claim"
            ? { ...event.first, same: true }
            : event.first;
        if (event.first.kind === "tick") await this.time.pass(event.first.ms);
        else this.#start(() => this.#live(event.first));
        this.#start(async () => {
          await started;
          if (second.kind === "tick") await this.time.pass(second.ms);
          else await this.#live(second);
        });
        await settle();
        this.faults.cancelAfter()?.();
        return;
      }
    }
  }

  /** One call of the live service, with what the world does around it. */
  async #live(event: LiveEvent): Promise<void> {
    const alive = !this.#life.over();
    const pick = <T>(list: readonly T[], n: number): T | undefined =>
      list.length === 0 ? undefined : list[n % list.length];
    const machine = this.machine;
    switch (event.kind) {
      case "click": {
        if (!alive) return;
        let input: Omit<NewIntent, "machine">;
        let requestId: string;
        if (event.repeat && this.#last !== undefined) {
          ({ input, requestId } = this.#last);
        } else {
          input = {
            task: this.backend.tasks[event.task % this.backend.tasks.length] ?? "",
            instance: `instance-${String(event.instance)}`,
            route: event.route,
            place: null,
            taskVersion: 1,
            briefHash: "b".repeat(64),
          };
          requestId = `model-click-${String((this.#counter += 1)).padStart(8, "0")}`;
          this.#last = { input, requestId };
        }
        const intent = await machine.open(input, requestId);
        if (!this.intents.includes(intent.id)) this.intents.push(intent.id);
        return;
      }
      case "confirm": {
        const id = pick(this.intents, event.pick);
        if (!alive || id === undefined) return;
        const route = (await this.backend.durable().readIntent(id))?.route;
        if (event.crash) this.#dieAfter.add(id);
        try {
          await machine.dispatch(id, route === "t3-mcp" ? { grant: this.grant } : {});
        } finally {
          this.#dieAfter.delete(id);
        }
        return;
      }
      case "claim": {
        const window = pick(
          this.windows.filter((w) => w.shim === "waiting" || w.shim === "noreply"),
          event.pick,
        );
        if (!alive || window === undefined) return;
        const claim =
          event.same && window.claim !== undefined
            ? window.claim
            : `claim-${String((this.#counter += 1))}`;
        window.claim = claim;
        const life = this.#life;
        // The reply to the shim, an external step like a dispatch: it lets the shim start the
        // agent. The claim must be durable when it leaves and when it arrives.
        const reply = (intent: LaunchIntent): Promise<void> =>
          this.#step(
            life,
            "a claim's reply",
            intent,
            (now) => now?.evidence.claim === claim && now.state === "dispatched",
            () => {
              window.shim = "replied";
              window.agent = "running";
              this.#bump(this.agents, window.intent);
            },
          );
        let claimed: LaunchIntent | undefined;
        try {
          claimed = await machine.claim(window.intent, claim, reply);
        } catch (error) {
          if (error instanceof Crash && window.shim === "waiting") window.shim = "noreply";
          throw error;
        }
        if (claimed === undefined && window.shim === "waiting") window.shim = "refused";
        return;
      }
      case "report": {
        const id = pick(this.intents, event.pick);
        if (!alive || id === undefined) return;
        if (event.what === "lost") {
          // The service loses track of a launch, whatever it is: the machine decides.
          await machine.report(id, { kind: "lost" });
          return;
        }
        const window = this.windows.find((w) => w.intent === id && w.shim === "replied");
        const thread = [...(this.threads.get(id) ?? [])][0];
        switch (event.what) {
          case "started":
            if (window === undefined && (this.agents.get(id) ?? 0) === 0) return;
            await machine.report(id, {
              kind: "evidence",
              evidence: { pid: 4000 + this.intents.indexOf(id), pid_started_at: this.time.now },
            });
            return;
          case "settled":
            if (window?.agent !== "running") return;
            window.agent = "settled";
            await machine.report(id, { kind: "confirmed" });
            return;
          case "exited":
            if (window?.agent !== "running") return;
            window.agent = "exited";
            await machine.report(id, {
              kind: "failed",
              reason: "agent_exited",
              evidence: { exit_code: 1 },
            });
            return;
          case "bound":
            if (window === undefined && (this.agents.get(id) ?? 0) === 0) return;
            await machine.report(id, {
              kind: "confirmed",
              evidence: { bound_at: this.time.now },
            });
            return;
          case "checked":
            // T3's folder check of the thread it made (A4 3.4.1 step 3).
            if (thread === undefined) return;
            await machine.report(id, {
              kind: "confirmed",
              evidence: { folder_checked: true, thread },
            });
            return;
        }
        return;
      }
      case "sweep":
        if (alive) await machine.sweep();
        return;
      case "recover":
        if (alive) await machine.recover();
        return;
      case "tick":
        await this.time.pass(event.ms);
        return;
    }
  }

  /**
   * A new service on the same durable state, which starts its recovery. With `fault` armed, it
   * may die during that recovery, and stays dead until the next restart.
   */
  async restart(fault?: { after: number; late: boolean }): Promise<void> {
    this.faults.kill();
    this.#store = await this.backend.restart();
    this.#life = this.faults.revive();
    this.#dieAfter.clear();
    this.machine = this.#machine();
    if (fault !== undefined) this.faults.arm(fault.after, fault.late);
    const machine = this.machine;
    this.#start(() => machine.recover());
  }

  /** The invariants, after every event. */
  async check(): Promise<void> {
    if (this.#errors.length > 0) throw this.#errors[0];
    expect(this.violations, "rules inside the external steps").toEqual([]);
    const durable = this.backend.durable();
    for (const id of this.intents) {
      expect(this.dispatches.get(id) ?? 0, "one dispatch per intent at most").toBeLessThanOrEqual(
        1,
      );
      expect(this.agents.get(id) ?? 0, "one agent process per intent at most").toBeLessThanOrEqual(
        1,
      );
      expect(
        this.threads.get(id)?.size ?? 0,
        "one T3 thread per intent at most",
      ).toBeLessThanOrEqual(1);
      const intent = await durable.readIntent(id);
      if (intent?.state === "unknown") this.unknownSeen.add(id);
      if (intent?.route === "clipboard") {
        expect(intent.state, "a clipboard launch is never Unknown (A4 3.9.2)").not.toBe("unknown");
      }
      if (this.unknownSeen.has(id)) {
        expect(["unknown", "confirmed", "failed"], "Unknown never goes back").toContain(
          intent?.state,
        );
      }
      // Failed is definite evidence that nothing started (A4 3.9.1): never so while an agent or a
      // T3 thread exists, except for what an agent or a thread reported about itself.
      const started = (this.agents.get(id) ?? 0) > 0 || (this.threads.get(id)?.size ?? 0) > 0;
      if (started && intent?.state === "failed") {
        expect(NOTHING_STARTED, "Failed as if nothing started, while something did").not.toContain(
          intent.reason,
        );
      }
      const replied = this.windows.filter((w) => w.intent === id && w.shim === "replied");
      if (replied.length > 0) {
        expect(intent?.evidence.claim, "no agent without a durable claim").toBeDefined();
        // A launch whose shim was given its reply is never Failed for want of a claim.
        expect(intent?.reason, "a claimed launch is never not_claimed").not.toBe("not_claimed");
      }
    }
    for (const step of this.backend.history?.() ?? []) {
      if (step.from !== null) {
        expect(MODEL_EDGES[step.from], `${step.from} -> ${step.to}`).toContain(step.to);
      }
    }
  }

  /** Time passes until every call the world made has ended, or a bound is reached. */
  async #drain(rule: string): Promise<void> {
    for (let round = 0; round < 64 && this.#calls.size > 0; round += 1) {
      await this.time.pass(DEADLINES.step + DEADLINES.store);
    }
    expect(this.#calls.size, rule).toBe(0);
    expect(this.machine.owned(), "no intent stays owned once its calls have ended").toEqual([]);
  }

  /** Nothing is due on any open intent: each is final, or waits for evidence only. */
  async #resting(when: string): Promise<void> {
    const { intents } = await this.backend.durable().openWork(this.backend.machine);
    for (const intent of intents) {
      expect(intent.state, `${when}: no Prepared intent outlives its 10 minutes`).not.toBe(
        "prepared",
      );
      expect(intent.state, `${when}: no step's outcome is left open in Dispatching`).not.toBe(
        "dispatching",
      );
      if (intent.route === "terminal") {
        expect(intent.evidence.claim, `${when}: an unclaimed terminal launch ends`).toBeDefined();
      }
      // Only a confirmation writes these: a launch holding one is Confirmed.
      expect(intent.evidence.bound_at, `${when}: no confirmation half-applied`).toBeUndefined();
      expect(intent.evidence.folder_checked, `${when}: no confirmation half-applied`).toBe(
        undefined,
      );
    }
  }

  /**
   * The end of a run, and the liveness property: every deadline passes, and every call of the
   * service ends with no intent left owned. What is still in flight lands, and the calls it
   * unblocks end too. Then the wall clock is right again, past every
   * instant the records hold, time passes beyond every window and the Prepared limit, and one more
   * sweep and recovery run on the service as it is: nothing is owned, and every intent is final
   * or waits for evidence only. A clean restart then finds the same.
   */
  async finish(): Promise<void> {
    this.faults.calm();
    await this.#drain("every call of the service ends once its deadlines have passed");
    // What is still in flight lands, then the calls it unblocks end too.
    this.faults.landHeld();
    await settle();
    await this.#drain("every call ends once what was in flight has landed");
    await this.check();
    let latest = this.time.now;
    const open = await this.backend.durable().openWork(this.backend.machine);
    for (const intent of open.intents) {
      latest = Math.max(latest, intent.updatedAt, intent.createdAt, ...Object.values(intent.at));
    }
    this.time.now = latest;
    await this.time.pass(PREPARED_TTL_MS + CLAIM_WINDOW_MS + 1);
    if (this.#life.over()) {
      await this.restart();
    } else {
      const machine = this.machine;
      this.#start(() => machine.recover());
    }
    const machine = this.machine;
    this.#start(() => machine.sweep());
    await settle();
    await this.#drain("one more sweep and recovery end");
    await this.check();
    await this.#resting("after a sweep and a recovery");
    await this.restart();
    const restarted = this.machine;
    this.#start(() => restarted.sweep());
    await settle();
    await this.#drain("a clean restart's recovery and sweep end");
    await this.check();
    await this.#resting("after a clean restart");
  }
}
