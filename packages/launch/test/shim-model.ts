// A model of terminal launches with real shims for the property test (A4 3.6.3, 3.9.3, A4 5.1):
// the real LaunchMachine and the real ShimHost over the in-memory execution store and machine
// state, a model process table (PIDs, start times, PID reuse), model shims that hold their ticket
// and, once replied to, their credential and their agent, and service lives that die and restart.
// Each event starts its call without waiting for it, so claims, attaches, reports, sweeps, checks
// and recoveries interleave, and a service may die in the middle of any of them: every store call
// and machine state write of a dead service fails before it takes effect, and its replies never
// reach a shim. The model's rules are its own; it counts what started and checks after each event.
import { expect } from "vitest";
import { CLAIM_WINDOW_MS, PREPARED_TTL_MS } from "../src/intents.ts";
import { LaunchMachine, type DispatchOutcome } from "../src/machine.ts";
import type { ProcessProbe } from "../src/process.ts";
import { ShimHost, type Attachment } from "../src/shim/host.ts";
import {
  MemoryRecords,
  type LaunchFile,
  type RecordStore,
  type SpawnPlan,
} from "../src/shim/records.ts";
import { SHIM_METHODS, type ClaimReply, type ExitFile } from "../src/shim/wire.ts";
import type { LaunchStore, LaunchIntent } from "../src/store.ts";
import { settle, Time } from "./machine-model.ts";
import { MemoryDurable, MemoryExecutionStore, randomId } from "./memory-store.ts";
import { MACHINE } from "./stores.ts";

const SPACE = "sp_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const BOOT = "0f0e0d0c-0b0a-4908-8706-050403020100";
const PLAN: SpawnPlan = {
  argv: ["/opt/agent/bin/agent", "--brief", "Read the task"],
  folder: { stored: "~/work/lumen/portal", path: "/home/mira/work/lumen/portal" },
  env: { FIXTURE_INSTANCE: "1" },
  title: "Fixture launch",
  afterExit: "close",
};
/** The folder each dispatch resolved, and the check the claim's reply hands its shim. */
const FOLDER = {
  path: "/home/mira/work/lumen/portal",
  check: { dev: "2049", ino: "1311007", rootDev: "2049", rootIno: "1310977", depth: 2 },
};
const DEADLINES = { store: 15_000, step: 30_000 } as const;

/** The service died: nothing it does after this reaches the store, the machine state or a shim. */
export class Dead extends Error {
  override readonly name = "Dead";
}

class Life {
  over = false;
}

/** How a claim's reply travels: delivered, lost on the way, or never answered (the step's deadline). */
export type Delivery = "deliver" | "lose" | "hang";

export type ShimEvent =
  /**
   * A click, then its dispatch: the dispatch step issues the ticket and starts a shim, which may
   * get the PID of a shim that ended (`reuse`).
   */
  | { kind: "launch"; reuse?: boolean }
  /** A shim claims with its ticket (`twice`: the same shim, a second time). */
  | { kind: "claim"; pick: number; delivery: Delivery }
  /** Two claims with one ticket at once: the shim's and a thief's that read the ticket. */
  | { kind: "race"; pick: number }
  /** A shim presents another launch's ticket, or its own credential, as its ticket. */
  | { kind: "misuse"; pick: number; with: "other-ticket" | "credential" | "identity" }
  /** A shim with a credential attaches (after a restart, or a dropped connection). */
  | { kind: "attach"; pick: number }
  | { kind: "report"; pick: number; what: "started" | "settled" }
  /** The agent ends: reported on the attachment, or written to exit.json with the service gone. */
  | { kind: "exit"; pick: number }
  /** A shim process ends without a word; its PID may later name another process. */
  | { kind: "die"; pick: number; reuse: boolean }
  | { kind: "tick"; ms: number }
  /** The wall clock steps, either way; the monotonic clock does not move. */
  | { kind: "step"; ms: number }
  | { kind: "sweep" }
  | { kind: "check" }
  /** The service dies at once, with calls under way, and starts again with its recovery. */
  | { kind: "restart" }
  /** The process table answers late for a while (a slow PowerShell). */
  | { kind: "slow"; ms: number }
  /** The store's commits take this long for a while, past their deadline too (a busy writer). */
  | { kind: "slow-store"; ms: number };

interface ModelShim {
  readonly launch: string;
  readonly ticket: string;
  pid: number;
  startTime: string;
  alive: boolean;
  /** The reply it got: what lets it start the agent. */
  reply?: ClaimReply;
  agent: "none" | "running" | "exited";
  settled: boolean;
  /** The service life it is attached in, if any. */
  attached?: { life: Life; attachment: Attachment };
  /** When its launch was dispatched, on the monotonic clock of the life that dispatched it. */
  readonly dispatchedAt: number;
  /** And on the wall clock, and in which service life. */
  readonly dispatchedWall: number;
  readonly dispatchLife: Life;
}

/** An error a call may end with without breaking a rule. */
const expected = (error: unknown): boolean =>
  error instanceof Dead || (error instanceof Error && error.name === "DeadlinePassed");

export class ShimWorld {
  readonly time = new Time();
  readonly durable = new MemoryDurable(() => this.time.now);
  readonly records = new MemoryRecords();
  readonly shims: ModelShim[] = [];
  /** Agents started per launch. */
  readonly agents = new Map<string, number>();
  /** Replies that carried argv per launch. */
  readonly replies = new Map<string, number>();
  readonly violations: string[] = [];
  readonly #processes = new Map<number, string>();
  #nextPid = 1000;
  #nextStart = 1;
  #probeDelay = 0;
  #storeDelay = 0;
  #reuseNext = false;
  #life = new Life();
  #machine!: LaunchMachine;
  #host!: ShimHost;
  readonly #calls = new Set<Promise<void>>();
  readonly #errors: unknown[] = [];
  #requests = 0;

  constructor() {
    this.#boot();
  }

  #require(holds: boolean, rule: string): void {
    if (!holds) this.violations.push(rule);
  }

  #spawnProcess(reuse = false): { pid: number; startTime: string } {
    // A new process may get the PID of a shim that ended: another process, by its start time.
    const freed = reuse
      ? this.shims.find((s) => !s.alive && !this.#processes.has(s.pid))?.pid
      : undefined;
    const pid = freed ?? (this.#nextPid += 1);
    const startTime = `linux:${BOOT}:${String((this.#nextStart += 1))}`;
    this.#processes.set(pid, startTime);
    return { pid, startTime };
  }

  #boot(): void {
    const life = new Life();
    this.#life = life;
    const guard = <T>(call: () => Promise<T>): Promise<T> =>
      life.over
        ? Promise.reject(new Dead())
        : call().then((v) => (life.over ? Promise.reject(new Dead()) : v));
    const inner = new MemoryExecutionStore(this.durable);
    // A slow commit takes effect once its time has passed, its call's deadline or not.
    const slow = <T>(call: () => Promise<T>): Promise<T> =>
      this.#storeDelay > 0 ? this.time.wait(this.#storeDelay).then(() => guard(call)) : guard(call);
    const store: LaunchStore = {
      createIntent: (input, id) => guard(() => inner.createIntent(input, id)),
      transitionIntent: (id, expect, next, outcome) =>
        slow(() => inner.transitionIntent(id, expect, next, outcome)),
      readIntent: (id) => guard(() => inner.readIntent(id)),
      openWork: (machine) => guard(() => inner.openWork(machine)),
    };
    const records = this.records;
    const lifeRecords: RecordStore = {
      list: () => records.list(),
      get: (launch) => records.get(launch),
      put: (file: LaunchFile) => {
        if (life.over) throw new Dead();
        this.#require(
          !JSON.stringify(file).includes(
            this.shims.find((s) => s.launch === file.launch)?.ticket ?? "\u0000",
          ),
          "machine state never holds a ticket",
        );
        records.put(file);
      },
      remove: (launch) => {
        if (life.over) throw new Dead();
        records.remove(launch);
      },
      readExit: (launch) => records.readExit(launch),
      exitPath: (launch) => records.exitPath(launch),
    };
    const probe: ProcessProbe = {
      // The OS is read at once and answers late, as a slow PowerShell does: the answer may be
      // out of date by the time it arrives.
      startTimes: async (pids) => {
        const read = new Map(
          pids.flatMap((pid): [number, string][] => {
            const time = this.#processes.get(pid);
            return time === undefined ? [] : [[pid, time]];
          }),
        );
        if (this.#probeDelay > 0) await this.time.wait(this.#probeDelay);
        return read;
      },
    };
    this.#machine = new LaunchMachine({
      store,
      machine: MACHINE,
      steps: {
        dispatch: (intent): Promise<DispatchOutcome> => {
          if (life.over) return Promise.reject(new Dead());
          const ticket = this.#host.issueTicket(intent.id, FOLDER);
          const { pid, startTime } = this.#spawnProcess(this.#reuseNext);
          this.#reuseNext = false;
          this.shims.push({
            launch: intent.id,
            ticket,
            pid,
            startTime,
            alive: true,
            agent: "none",
            settled: false,
            dispatchedAt: this.time.mono,
            dispatchedWall: this.time.now,
            dispatchLife: life,
          });
          return Promise.resolve({ kind: "accepted" });
        },
      },
      recovery: {
        observe: (intent) => this.#host.observe(intent),
        grant: () => Promise.resolve(undefined),
        replay: () => Promise.resolve({ kind: "refused" }),
      },
      now: () => this.time.now,
      elapsed: () => this.time.mono,
      wait: this.time.wait,
      deadlines: DEADLINES,
    });
    this.#host = new ShimHost({
      records: lifeRecords,
      probe,
      platform: "linux",
      machine: () => (life.over ? undefined : this.#machine),
      environment: () => ({ kind: "service", env: { PATH: "/usr/bin" } }),
      now: () => this.time.now,
    });
  }

  #start(call: () => Promise<unknown>): void {
    const task = (async () => {
      await call();
    })().catch((error: unknown) => {
      if (!expected(error)) this.#errors.push(error);
    });
    this.#calls.add(task);
    void task.finally(() => this.#calls.delete(task));
  }

  #pick(n: number, test: (s: ModelShim) => boolean = () => true): ModelShim | undefined {
    const list = this.shims.filter(test);
    return list.length === 0 ? undefined : list[n % list.length];
  }

  async #durable(id: string): Promise<LaunchIntent | undefined> {
    return new MemoryExecutionStore(this.durable).readIntent(id);
  }

  /**
   * The claim's reply as the claiming process gets it: it starts the agent of the launch the reply
   * names. `shim` is the process that claimed (a thief's copy in a race).
   */
  #send(shim: ModelShim, life: Life, delivery: Delivery) {
    // The claim is presented now. Its decision comes later, and its reply after a commit that
    // may be slow, so the window is judged at the presentation: one presented after it never
    // succeeds.
    const presented = { mono: this.time.mono, now: this.time.now };
    return async (reply: ClaimReply): Promise<void> => {
      const launch = reply.launch.id;
      const owner = this.shims.find((s) => s.launch === launch);
      const now = await this.#durable(launch);
      this.#require(now?.evidence.claim !== undefined, "a reply leaves only on a durable claim");
      // The window as the service can know it: on the monotonic clock in the life that
      // dispatched, and only on the wall clock after a restart (A4 3.9.1), where a step of
      // the wall clock cannot be told from time passing.
      this.#require(
        owner !== undefined &&
          (owner.dispatchLife === life
            ? presented.mono - owner.dispatchedAt < CLAIM_WINDOW_MS
            : Math.abs(presented.now - owner.dispatchedWall) < CLAIM_WINDOW_MS),
        "a claim succeeds only within its window",
      );
      this.#require(
        reply.argv.join(" ") === PLAN.argv.join(" ") &&
          JSON.stringify(reply.check) === JSON.stringify(FOLDER.check),
        "the reply carries the launch's own plan",
      );
      if (delivery === "lose") throw new Error("the connection closed on the way");
      if (delivery === "hang") {
        await new Promise<void>(() => undefined);
      }
      if (life.over) throw new Dead();
      this.replies.set(launch, (this.replies.get(launch) ?? 0) + 1);
      this.agents.set(launch, (this.agents.get(launch) ?? 0) + 1);
      if (shim.launch === launch && this.shims.includes(shim)) {
        shim.reply = reply;
        shim.agent = shim.alive ? "running" : "exited";
      }
    };
  }

  async run(event: ShimEvent): Promise<void> {
    const life = this.#life;
    const host = this.#host;
    switch (event.kind) {
      case "launch": {
        this.#reuseNext = event.reuse === true;
        this.#requests += 1;
        const requestId = `shim-model-${String(this.#requests).padStart(6, "0")}`;
        const machine = this.#machine;
        this.#start(async () => {
          const intent = await machine.open(
            {
              task: randomId("t"),
              instance: "codex-work",
              route: "terminal",
              place: null,
              taskVersion: 1,
              briefHash: "b".repeat(64),
            },
            requestId,
          );
          if (life.over) throw new Dead();
          host.prepare(SPACE, intent, PLAN);
          await machine.dispatch(intent.id);
        });
        break;
      }
      case "claim": {
        const shim = this.#pick(event.pick, (s) => s.alive && s.reply === undefined);
        if (shim === undefined) break;
        this.#start(async () => {
          const outcome = await host.claim(
            { ticket: shim.ticket, role: "shim", pid: shim.pid, start_time: shim.startTime },
            this.#send(shim, life, event.delivery),
          );
          if (outcome.kind === "claimed" && !life.over) {
            shim.attached = { life, attachment: outcome.attachment };
          }
        });
        break;
      }
      case "race": {
        const shim = this.#pick(event.pick, (s) => s.alive && s.reply === undefined);
        if (shim === undefined) break;
        const thief = this.#spawnProcess();
        const claims = [
          { pid: shim.pid, startTime: shim.startTime, model: shim },
          {
            pid: thief.pid,
            startTime: thief.startTime,
            model: { ...shim, pid: thief.pid, startTime: thief.startTime },
          },
        ];
        for (const c of claims) {
          this.#start(async () => {
            await host.claim(
              { ticket: shim.ticket, role: "shim", pid: c.pid, start_time: c.startTime },
              this.#send(c.model, life, "deliver"),
            );
          });
        }
        break;
      }
      case "misuse": {
        const shim = this.#pick(event.pick);
        if (shim === undefined) break;
        const other = this.shims.find((s) => s.launch !== shim.launch);
        let ticket = shim.ticket;
        let startTime = shim.startTime;
        if (event.with === "other-ticket") {
          if (other === undefined) break;
          ticket = other.ticket;
        } else if (event.with === "credential") {
          if (shim.reply === undefined) break;
          ticket = shim.reply.credential;
        } else {
          startTime = `linux:${BOOT}:1`;
        }
        const before = await this.#durable(other?.launch ?? shim.launch);
        this.#start(async () => {
          const outcome = await host.claim(
            { ticket, role: "shim", pid: shim.pid, start_time: startTime },
            this.#send(shim, life, "deliver"),
          );
          if (event.with === "credential" || event.with === "identity") {
            this.#require(outcome.kind === "refused", `a claim with ${event.with} is refused`);
          } else if (outcome.kind === "claimed") {
            // Another launch's ticket claims that launch at most, never this shim's.
            this.#require(outcome.intent.id === other?.launch, "a ticket claims only its launch");
            this.#require(before?.evidence.claim === undefined, "a used ticket never claims");
          }
        });
        break;
      }
      case "attach": {
        const shim = this.#pick(event.pick, (s) => s.alive && s.reply !== undefined);
        const reply = shim?.reply;
        if (shim === undefined || reply === undefined) break;
        this.#start(async () => {
          const outcome = await host.attach({
            credential: reply.credential,
            pid: shim.pid,
            start_time: shim.startTime,
          });
          if (outcome.kind === "attached") {
            this.#require(
              Object.keys(outcome.reply).sort().join(",") === "launch,protocol",
              "an attach reply starts nothing",
            );
            if (!life.over) shim.attached = { life, attachment: outcome.attachment };
          }
        });
        break;
      }
      case "report": {
        const shim = this.#pick(
          event.pick,
          (s) => s.agent === "running" && s.attached?.life === life,
        );
        const attached = shim?.attached;
        if (shim === undefined || attached === undefined) break;
        if (event.what === "settled") shim.settled = true;
        const method = event.what === "started" ? SHIM_METHODS.started : SHIM_METHODS.settled;
        const params =
          event.what === "started" ? { pid: shim.pid + 1, started_at: this.time.now } : {};
        this.#start(() => host.report(attached.attachment, method, params));
        break;
      }
      case "exit": {
        const shim = this.#pick(event.pick, (s) => s.agent === "running" && s.alive);
        if (shim === undefined) break;
        shim.agent = "exited";
        const exit = {
          code: 0,
          signal: null,
          ran_ms: shim.settled ? 60_000 : 500,
          settled: shim.settled,
        };
        const attached = shim.attached;
        if (attached !== undefined && attached.life === life && !life.over) {
          this.#start(() => host.report(attached.attachment, SHIM_METHODS.exited, exit));
        } else {
          const file: ExitFile = { format: 1, launch: shim.launch, spawned: true, ...exit };
          this.records.exits.set(shim.launch, file);
        }
        break;
      }
      case "die": {
        const shim = this.#pick(event.pick, (s) => s.alive);
        if (shim === undefined) break;
        shim.alive = false;
        this.#processes.delete(shim.pid);
        if (event.reuse)
          this.#processes.set(shim.pid, `linux:${BOOT}:${String((this.#nextStart += 1))}`);
        break;
      }
      case "tick":
        await this.time.pass(event.ms);
        break;
      case "step":
        this.time.now += event.ms;
        break;
      case "sweep": {
        const machine = this.#machine;
        this.#start(() => machine.sweep());
        break;
      }
      case "check":
        this.#start(() => host.check());
        break;
      case "restart":
        await this.restart();
        break;
      case "slow":
        this.#probeDelay = event.ms;
        break;
      case "slow-store":
        this.#storeDelay = event.ms;
        break;
    }
    await settle();
    await this.check();
  }

  /** The service dies with its calls under way, and a new one starts with its recovery. */
  async restart(): Promise<void> {
    this.#life.over = true;
    for (const shim of this.shims) delete shim.attached;
    this.#boot();
    const machine = this.#machine;
    const host = this.#host;
    this.#start(async () => {
      await machine.recover();
      await host.check();
    });
    await settle();
  }

  /** The rules, after every event. */
  async check(): Promise<void> {
    if (this.#errors.length > 0) throw this.#errors[0];
    expect(this.violations, "rules inside the calls").toEqual([]);
    for (const shim of this.shims) {
      expect(this.agents.get(shim.launch) ?? 0, "one agent per intent at most").toBeLessThanOrEqual(
        1,
      );
      expect(
        this.replies.get(shim.launch) ?? 0,
        "one reply with argv per intent",
      ).toBeLessThanOrEqual(1);
      const intent = await this.#durable(shim.launch);
      if ((this.agents.get(shim.launch) ?? 0) > 0) {
        expect(intent?.evidence.claim, "no agent without a durable claim").toBeDefined();
        expect(intent?.reason, "a claimed launch is never not_claimed").not.toBe("not_claimed");
      }
      // A shim whose agent runs is never given up: its attachment stays, and its launch is
      // never lost while its process lives.
      if (shim.alive && shim.reply !== undefined && shim.agent === "running") {
        expect(
          this.records.get(shim.launch)?.attachment?.pid,
          "a live shim keeps its attachment",
        ).toBe(shim.pid);
        expect(intent?.state, "a live shim's launch is never Unknown").not.toBe("unknown");
      }
    }
    for (const record of this.records.list()) {
      const text = JSON.stringify(record);
      for (const shim of this.shims) {
        expect(text.includes(shim.ticket), "machine state holds no ticket").toBe(false);
        if (shim.reply !== undefined) {
          expect(text.includes(shim.reply.credential), "machine state holds no credential").toBe(
            false,
          );
        }
      }
    }
  }

  /** Time passes until every call ended. */
  async #drain(): Promise<void> {
    for (let round = 0; round < 64 && this.#calls.size > 0; round += 1) {
      await this.time.pass(DEADLINES.step + DEADLINES.store);
    }
    expect(this.#calls.size, "every call ends once its deadlines have passed").toBe(0);
  }

  /**
   * Liveness: every agent ends and every shim with it, every window and the Prepared limit pass,
   * and a clean service recovers, sweeps and checks: no launch is left open, and no machine state.
   */
  async finish(): Promise<void> {
    this.#probeDelay = 0;
    this.#storeDelay = 0;
    await this.#drain();
    for (const shim of this.shims) {
      if (shim.agent === "running") {
        shim.agent = "exited";
        this.records.exits.set(shim.launch, {
          format: 1,
          launch: shim.launch,
          spawned: true,
          settled: shim.settled,
          code: 0,
          signal: null,
          ran_ms: shim.settled ? 60_000 : 500,
        });
      }
      shim.alive = false;
      this.#processes.delete(shim.pid);
    }
    // Longer than every window a launch waits in.
    await this.time.pass(PREPARED_TTL_MS + 15 * 60_000 + CLAIM_WINDOW_MS);
    await this.restart();
    await this.#drain();
    const machine = this.#machine;
    const host = this.#host;
    this.#start(async () => {
      await machine.sweep();
      await host.check();
    });
    await settle();
    await this.#drain();
    await this.check();
    const { intents } = await new MemoryExecutionStore(this.durable).openWork(MACHINE);
    expect(
      intents.map((i) => `${i.state}:${i.evidence.claim === undefined ? "unclaimed" : "claimed"}`),
      "every launch ends once its shim is gone",
    ).toEqual([]);
    expect(this.records.list(), "no machine state outlives its shim").toEqual([]);
  }
}
