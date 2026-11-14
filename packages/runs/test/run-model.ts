// A model world for the run state machine's property test (A4 3.11.2, 3.11.9, 5.1, 5.2): one
// service's RunMachine over a durable store, fake run shims and agents, and crashes of the service
// at every boundary: a store write before or after it takes effect, and an external step (a spawn,
// a claim's reply, a stop) before or after it runs. A crash kills the machine (every later call of
// it fails) and a new one starts on the same durable state and recovers. The world keeps its own
// record of what the processes did, which the store never wrote, and checks the store against it.
import {
  FINAL_RUN_STATES,
  RUN_EDGES,
  RUN_LIMITS,
  type RunRecord,
  type RunResult,
  type RunState,
} from "@tasks/contracts/runs";
import type { RunStore } from "@tasks/launch/execution-store";
import {
  RunMachine,
  type RunExit,
  type RunObservation,
  type SpawnOutcome,
} from "../src/machine.ts";

/** The service died here. Thrown by every call of a dead machine. */
export class Crash extends Error {
  override readonly name = "Crash";
}

/** One service's life: everything it calls fails once it is dead. */
interface Life {
  dead: boolean;
}

/** A crash armed at the n-th boundary from now, before or after its effect. */
interface Armed {
  left: number;
  after: boolean;
}

/** What one run's processes did, as the world saw it. */
interface Processes {
  /** The spawn step ran: a shim was started. */
  spawned: boolean;
  /** How often the spawn step started a shim: never more than once per run. */
  spawns: number;
  shimAlive: boolean;
  /** The claim ID a reply reached the shim with: only then may it start the agent. */
  replied?: string;
  /** How many claim replies reached the shim: at most one per run (A4 3.11.2). */
  replies: number;
  /** Claims the shim sent, for a repeat with the same ID. */
  claims: string[];
  agents: number;
  agentRunning: boolean;
  /** The stop step reached the shim. */
  stopped: boolean;
  exit?: RunExit;
}

export type Event =
  | { kind: "queue" }
  | { kind: "start"; pick: number; outcome: "spawned" | "refused" | "unknown" }
  | { kind: "claim"; pick: number; same: boolean }
  | { kind: "agent"; pick: number }
  | { kind: "native"; pick: number }
  | { kind: "exit"; pick: number; how: "ok" | "error" | "wall" | "idle" }
  | { kind: "die"; pick: number }
  | { kind: "cancel"; pick: number }
  | { kind: "sweep" }
  | { kind: "recover" }
  | { kind: "tick"; ms: number }
  | { kind: "step"; ms: number }
  | { kind: "arm"; after: number; late: boolean }
  | { kind: "crash" }
  /**
   * The service is down for `ms`: one shim's agent ends meanwhile and its shim writes exit.json and
   * exits without reporting it, or with `ends` an idle shim gives up without one. Then a restart.
   */
  | { kind: "down"; pick: number; ms: number; ends: boolean };

export interface ModelBackend {
  machine: string;
  /** The store on the durable state, as a new service would open it. */
  store(): RunStore;
  tasks: readonly string[];
}

const RESULTS: Record<"ok" | "error" | "wall" | "idle" | "interrupted" | "none", RunResult> = {
  ok: result(true, "success", 0),
  error: result(false, "agent_error", 1),
  wall: result(false, "no_result", null),
  idle: result(false, "no_result", null),
  interrupted: result(false, "interrupted", 0),
  none: result(false, "no_output", 0),
};

function result(ok: boolean, outcome: RunResult["outcome"], exitCode: number | null): RunResult {
  return {
    ok,
    outcome,
    exitCode,
    signal: exitCode === null ? "SIGKILL" : null,
    nativeId: null,
    text: ok ? "Done." : null,
    error: ok ? null : "It failed.",
    usage: null,
    appTools: null,
    declined: 0,
    permissionDenials: 0,
    durationMs: 1_000,
  };
}

let ids = 0;

export class World {
  now = Date.UTC(2026, 10, 13, 9, 0, 0);
  mono = 0;
  readonly #backend: ModelBackend;
  #life: Life = { dead: false };
  #machine: RunMachine;
  #armed: Armed | undefined;
  readonly runs: string[] = [];
  readonly processes = new Map<string, Processes>();
  /** Runs a cancel was asked for, durably or not. */
  readonly cancels = new Set<string>();
  #requests = 0;

  constructor(backend: ModelBackend) {
    this.#backend = backend;
    this.#machine = this.#newMachine();
  }

  #newMachine(): RunMachine {
    const life = this.#life;
    const store = this.#faulty(this.#backend.store(), life);
    return new RunMachine({
      store,
      machine: this.#backend.machine,
      recovery: {
        observe: (run) => this.#boundary(life, () => Promise.resolve(this.#observe(run))),
      },
      now: () => this.now,
      elapsed: () => this.mono,
      // Every call and step answers or crashes: deadlines never pass in this model.
      wait: () => new Promise<void>(() => undefined),
    });
  }

  /** The store a service of `life` uses: writes are boundaries, reads fail once it is dead. */
  #faulty(store: RunStore, life: Life): RunStore {
    const alive = <T>(call: () => Promise<T>): Promise<T> =>
      life.dead ? Promise.reject(new Crash()) : call();
    return {
      createRun: (input, id) => this.#boundary(life, () => store.createRun(input, id)),
      transitionRun: (id, expect, next, patch) =>
        this.#boundary(life, () => store.transitionRun(id, expect, next, patch)),
      readRun: (id) => alive(() => store.readRun(id)),
      openWork: (machine) => alive(() => store.openWork(machine)),
    };
  }

  /** One boundary: a store write or an external step. An armed crash fires before or after it. */
  async #boundary<T>(life: Life, effect: () => Promise<T>): Promise<T> {
    if (life.dead) throw new Crash();
    const armed = this.#armed;
    if (armed !== undefined) {
      armed.left -= 1;
      if (armed.left <= 0) {
        this.#armed = undefined;
        if (!armed.after) {
          life.dead = true;
          throw new Crash();
        }
        await effect().catch(() => undefined);
        life.dead = true;
        throw new Crash();
      }
    }
    return effect();
  }

  /** What recovery sees of a run's shim after a restart (A4 3.11.9). */
  #observe(run: RunRecord): RunObservation {
    const p = this.processes.get(run.id);
    if (p === undefined || !p.spawned) return { kind: "lost" };
    if (p.shimAlive) return { kind: "pending" };
    return p.exit === undefined ? { kind: "lost" } : { kind: "exited", exit: p.exit };
  }

  #pick(pick: number): string | undefined {
    return this.runs.length === 0 ? undefined : this.runs[pick % this.runs.length];
  }

  #processes(id: string): Processes {
    let p = this.processes.get(id);
    if (p === undefined) {
      p = {
        spawned: false,
        spawns: 0,
        shimAlive: false,
        replies: 0,
        claims: [],
        agents: 0,
        agentRunning: false,
        stopped: false,
      };
      this.processes.set(id, p);
    }
    return p;
  }

  /** Runs one call of the service; a crash restarts it, and recovery may crash too. */
  async #service(call: (machine: RunMachine) => Promise<unknown>): Promise<void> {
    try {
      await call(this.#machine);
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      await this.restart();
    }
  }

  /** A new service on the same durable state, and its start-up recovery. */
  async restart(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      this.#life.dead = true;
      this.#life = { dead: false };
      this.#machine = this.#newMachine();
      try {
        await this.#machine.recover();
        return;
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
      }
    }
    throw new Error("The service did not come back");
  }

  /** The shim's end: it writes exit.json, reports it while the service lives, and exits. */
  async #exit(id: string, exit: RunExit): Promise<void> {
    const p = this.#processes(id);
    p.agentRunning = false;
    p.exit = exit;
    await this.#service((m) => m.report(id, { kind: "exited", exit }));
    p.shimAlive = false;
  }

  async run(event: Event): Promise<void> {
    switch (event.kind) {
      case "queue": {
        this.#requests += 1;
        const task = this.#backend.tasks[this.#requests % this.#backend.tasks.length] ?? "";
        const requestId = `model-run-request-${String((ids += 1)).padStart(8, "0")}`;
        await this.#service(async (m) => {
          const run = await m.queue(
            {
              task,
              routine: null,
              instance: "codex-work",
              adapter: "codex-exec",
              place: null,
              request: "Fix the export.",
              briefHash: "0a1b2c3d".repeat(8),
              permission: "full-access",
              limits: RUN_LIMITS.task,
            },
            requestId,
          );
          if (!this.runs.includes(run.id)) this.runs.push(run.id);
        });
        return;
      }
      case "start": {
        const id = this.#pick(event.pick);
        if (id === undefined) return;
        const life = this.#life;
        const spawn = (run: RunRecord): Promise<SpawnOutcome> =>
          this.#boundary(life, () => {
            const p = this.#processes(run.id);
            p.spawns += 1;
            if (event.outcome !== "refused") {
              p.spawned = true;
              p.shimAlive = true;
            }
            return Promise.resolve({ kind: event.outcome });
          });
        await this.#service((m) => m.start(id, spawn));
        return;
      }
      case "claim": {
        const id = this.#pick(event.pick);
        if (id === undefined) return;
        const p = this.#processes(id);
        // A live shim may send its claim again, also after a reply reached it: the machine must
        // refuse every claim but the first, so the invariants count the replies.
        if (!p.shimAlive) return;
        const claim =
          event.same && p.claims.length > 0
            ? (p.claims.at(-1) ?? "")
            : `claim-${String((ids += 1))}`;
        p.claims.push(claim);
        const life = this.#life;
        const reply = (): Promise<void> =>
          this.#boundary(life, () => {
            // The reply is what lets the shim start its agent, whatever the record says.
            p.replies += 1;
            p.replied ??= claim;
            return Promise.resolve();
          });
        await this.#service((m) => m.claim(id, claim, reply));
        return;
      }
      case "agent": {
        const id = this.#pick(event.pick);
        if (id === undefined) return;
        const p = this.#processes(id);
        if (!p.shimAlive || p.replied === undefined || p.agents > 0 || p.exit !== undefined) return;
        if (p.stopped) {
          // A stop before the agent started: the shim ends without one.
          await this.#exit(id, { result: RESULTS.none });
          return;
        }
        p.agents += 1;
        p.agentRunning = true;
        await this.#service((m) =>
          m.report(id, { kind: "started", pid: 4000 + p.agents, pidStartedAt: this.now }),
        );
        return;
      }
      case "native": {
        const id = this.#pick(event.pick);
        if (id === undefined) return;
        const p = this.#processes(id);
        if (!p.agentRunning) return;
        await this.#service((m) =>
          m.report(id, { kind: "evidence", evidence: { native_id: `thread-${id.slice(3, 9)}` } }),
        );
        return;
      }
      case "exit": {
        const id = this.#pick(event.pick);
        if (id === undefined) return;
        const p = this.#processes(id);
        if (!p.agentRunning) return;
        // A stopped agent ends interrupted, whatever it was doing.
        const exit: RunExit = p.stopped
          ? { result: RESULTS.interrupted }
          : event.how === "wall" || event.how === "idle"
            ? { result: RESULTS[event.how], timeout: event.how }
            : { result: RESULTS[event.how] };
        await this.#exit(id, exit);
        return;
      }
      case "die": {
        const id = this.#pick(event.pick);
        if (id === undefined) return;
        const p = this.#processes(id);
        if (!p.shimAlive) return;
        // The shim and its agent are gone, and no exit.json was written.
        p.shimAlive = false;
        p.agentRunning = false;
        return;
      }
      case "cancel": {
        const id = this.#pick(event.pick);
        if (id === undefined) return;
        this.cancels.add(id);
        const life = this.#life;
        const p = this.#processes(id);
        const stop = (): Promise<void> =>
          this.#boundary(life, () => {
            if (p.shimAlive) p.stopped = true;
            return Promise.resolve();
          });
        await this.#service((m) => m.cancel(id, stop));
        return;
      }
      case "sweep":
        await this.#service((m) => m.sweep());
        return;
      case "recover":
        await this.#service((m) => m.recover());
        return;
      case "tick":
        this.now += event.ms;
        this.mono += event.ms;
        return;
      case "step":
        // The wall clock steps; the monotonic one does not.
        this.now += event.ms;
        return;
      case "arm":
        this.#armed = { left: event.after, after: event.late };
        return;
      case "crash":
        await this.restart();
        return;
      case "down": {
        this.#life.dead = true;
        this.now += event.ms;
        this.mono += event.ms;
        const id = this.#pick(event.pick);
        const p = id === undefined ? undefined : this.#processes(id);
        if (p?.agentRunning === true) {
          // The agent ends, and its shim writes exit.json that no service hears of, and exits.
          p.agentRunning = false;
          p.exit = { result: p.stopped ? RESULTS.interrupted : RESULTS.ok };
          p.shimAlive = false;
        } else if (p?.shimAlive === true && event.ends) {
          p.shimAlive = false;
        }
        await this.restart();
        return;
      }
    }
  }

  /**
   * The end of a scenario: no crash is armed, time passes beyond every window, every live shim
   * ends (a running agent exits, a stopped one interrupted, an idle shim gives up), and the service
   * restarts, recovers and sweeps.
   */
  async finish(): Promise<void> {
    this.#armed = undefined;
    for (const id of this.runs) {
      const p = this.#processes(id);
      if (p.agentRunning) {
        await this.#exit(id, { result: p.stopped ? RESULTS.interrupted : RESULTS.ok });
      } else if (p.shimAlive) {
        p.shimAlive = false;
      }
    }
    this.now += 10 * 60_000;
    this.mono += 10 * 60_000;
    await this.restart();
    await this.#service((m) => m.sweep());
  }

  /** Every invariant, against the durable records. */
  async check(store: RunStore, final: boolean): Promise<void> {
    for (const id of this.runs) {
      const run = await store.readRun(id);
      if (run === undefined) throw new Error("A run the service returned is gone");
      const p = this.processes.get(id);
      const where = `${run.state} ${id}`;
      // At most one agent per run, and none without a durable claim that its shim was replied with.
      if (p !== undefined && p.agents > 1) throw new Error(`two agents: ${where}`);
      if (p !== undefined && p.spawns > 1) throw new Error(`two spawns: ${where}`);
      if (p !== undefined && p.replies > 1) throw new Error(`two claim replies: ${where}`);
      if (p !== undefined && p.agents > 0 && run.evidence.claim !== p.replied) {
        throw new Error(`an agent without its durable claim: ${where}`);
      }
      if (p?.replied !== undefined && run.evidence.claim !== p.replied) {
        throw new Error(`a reply without a durable claim: ${where}`);
      }
      const started = (p?.agents ?? 0) > 0;
      switch (run.state) {
        case "succeeded":
          if (p?.exit?.result.ok !== true || p.exit.timeout !== undefined) {
            throw new Error(`succeeded without a successful exit: ${where}`);
          }
          if (run.at.cancelling !== undefined) throw new Error(`succeeded after a stop: ${where}`);
          break;
        case "timed_out":
          if (p?.exit?.timeout === undefined || p.exit.timeout !== run.reason) {
            throw new Error(`timed out without the shim's timeout: ${where}`);
          }
          break;
        case "cancelled":
          if (!this.cancels.has(id)) throw new Error(`cancelled without a cancel: ${where}`);
          // On process exit only: no agent of a cancelled run still runs.
          if (p?.agentRunning === true) throw new Error(`cancelled while the agent runs: ${where}`);
          if (started && p?.exit === undefined) throw new Error(`cancelled with no exit: ${where}`);
          break;
        case "failed":
          if ((run.reason === "not_claimed" || run.reason === "spawn_failed") && started) {
            throw new Error(`failed as never started, with an agent: ${where}`);
          }
          if (run.reason === "not_claimed" && run.evidence.claim !== undefined) {
            throw new Error(`a claimed run failed as unclaimed: ${where}`);
          }
          break;
        case "unknown":
          // Lost only once its shim is gone: a live shim re-attaches.
          if (run.reason === "lost" && p?.shimAlive === true) {
            throw new Error(`lost with a live shim: ${where}`);
          }
          break;
        default:
          break;
      }
      // Final states that come from an exit hold its result.
      if ((run.state === "succeeded" || run.state === "timed_out") && run.result === null) {
        throw new Error(`a final state from an exit without its result: ${where}`);
      }
      if (final) {
        const settled =
          (FINAL_RUN_STATES as readonly RunState[]).includes(run.state) || run.state === "queued";
        if (!settled) throw new Error(`not settled at the end: ${where}`);
        // A definite exit settles a run, however the service heard of it: live or from exit.json.
        if (run.state === "unknown" && p?.exit !== undefined && run.evidence.claim !== undefined) {
          throw new Error(`unknown although its shim left exit.json: ${where}`);
        }
      }
    }
  }

  /** Every committed transition is one of A4's edges (a store's own history, when it keeps one). */
  static checkEdges(history: readonly { id: string; from: RunState | null; to: RunState }[]): void {
    for (const step of history) {
      if (step.from === null) {
        if (step.to !== "queued") throw new Error("A run was created outside queued");
        continue;
      }
      if (!RUN_EDGES[step.from].includes(step.to)) {
        throw new Error(`Not an edge: ${step.from} -> ${step.to}`);
      }
    }
  }
}
