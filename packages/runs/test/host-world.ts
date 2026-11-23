// A model world for the run host: one service at a time (its RunMachine and RunHost over a durable
// store), fake containers on a fake operating system that outlives the service, fake agents that
// talk Claude's stream, a fake monotonic clock, and crashes of the service at any boundary (a store
// write, a container call or an answer's save, before or after it takes effect). A crash kills the
// service: everything it calls fails or never answers, its containers' processes die with it unless
// one refuses to end, and a new service starts on the same durable state and recovers.
//
// The world keeps its own truth of what the processes did, which the host never sees, and checks
// the store against it.
import { PassThrough } from "node:stream";
import type { RunLimits, RunRecord, RunState } from "@ttasks/contracts/runs";
import { FINAL_RUN_STATES } from "@ttasks/contracts/runs";
import type { RunStore } from "@ttasks/launch/execution-store";
import {
  ContainerError,
  RunHost,
  RunMachine,
  type AgentExit,
  type Confirmation,
  type Contained,
  type Containers,
  type ContainerSpec,
  type OpenDriver,
  type RunFolders,
  type SavedAnswer,
} from "../src/index.ts";

/** The service died here. Thrown by every call of a dead service. */
export class Crash extends Error {
  override readonly name = "Crash";
}

/** One service's life: everything it calls fails once it is dead. */
interface Life {
  dead: boolean;
}

const isDead = (life: Life): boolean => life.dead;

/** One run's container on the fake operating system. */
interface Box {
  /** Processes alive in it: the agent and what it started. */
  procs: number;
  agentAlive: boolean;
  /** One process of it survives every kill until it is released. */
  stuck: boolean;
  /** The agent prints its answer and exits on an interrupt; otherwise it ignores it. */
  obeys: boolean;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly exit: (exit: AgentExit) => void;
  ended: boolean;
}

/** What one run's agent wrote, as the world saw it. */
interface Spoken {
  answers: string[];
  finals: Set<string>;
}

export type StartMode = "ok" | "refuse" | "hang";

export type Event =
  | { kind: "queue" }
  | { kind: "start"; pick: number; mode: StartMode; obeys: boolean }
  | { kind: "answerStart"; pick: number; ok: boolean }
  | { kind: "say"; pick: number; final: boolean }
  | { kind: "fork"; pick: number }
  | { kind: "exit"; pick: number; code: number }
  | { kind: "stop"; pick: number }
  | { kind: "stick"; pick: number }
  | { kind: "release"; pick: number }
  | { kind: "forceEnd"; pick: number }
  | { kind: "tick"; ms: number }
  | { kind: "arm"; after: number; late: boolean }
  | { kind: "crash" };

const FINAL: ReadonlySet<RunState> = new Set(FINAL_RUN_STATES);

/** A run's limits in the model: short, so the world reaches them. */
export const MODEL_LIMITS = { maxTurns: 50, wallMs: 120_000, idleMs: 60_000 };

interface Timer {
  at: number;
  life: Life;
  resolve: () => void;
}

export interface WorldBackend {
  machine: string;
  /** The store on the durable state, as a new service would open it. */
  store(): RunStore;
  tasks: readonly string[];
}

export class World {
  mono = 0;
  now = Date.UTC(2026, 10, 16, 9, 0, 0);
  readonly #backend: WorldBackend;
  #life: Life = { dead: false };
  #armed: { left: number; after: boolean } | undefined;
  #timers: Timer[] = [];
  #host: RunHost;
  #requests = 0;
  #pids = 1_000;
  #said = 0;
  readonly runs: string[] = [];
  /** The operating system's truth: each run's container, and the starts not answered yet. */
  readonly boxes = new Map<string, Box>();
  readonly hung = new Map<string, { answer: (ok: boolean) => void; life: Life }>();
  /** How each run's next start goes, set before the host starts it. */
  readonly modes = new Map<string, { mode: StartMode; obeys: boolean }>();
  /** The run folders' files: they outlive the service, as files do. */
  readonly saved = new Map<string, SavedAnswer>();
  readonly spoken = new Map<string, Spoken>();
  /** Runs whose record once entered `cancelling`. */
  readonly stopped = new Set<string>();
  /** Every state a check found a run in. */
  readonly seen = new Set<string>();
  /** What reached each run's agent on its input. */
  readonly input = new Map<string, string>();
  /** The driver every run gets; without one, the print-mode parser's. */
  open: OpenDriver | undefined;
  /** The limits every run is queued with. */
  limits: RunLimits = MODEL_LIMITS;

  constructor(backend: WorldBackend) {
    this.#backend = backend;
    this.#host = this.#newHost();
  }

  #newHost(): RunHost {
    const life = this.#life;
    const store = this.#faultyStore(this.#backend.store(), life);
    const machine = new RunMachine({
      store,
      machine: this.#backend.machine,
      // Every store call answers or crashes: its deadline never passes here.
      wait: () => new Promise<void>(() => undefined),
    });
    return new RunHost({
      machine,
      containers: this.#containers(life),
      files: this.#files(life),
      now: () => this.now,
      elapsed: () => this.mono,
      wait: this.#wait(life),
    });
  }

  // -------------------------------------------------------------------------------------------
  // The service's view: a store, containers, files and a clock, each bound to one life.

  /** Waits on the fake clock; a dead service's waits never end. */
  #wait(life: Life): (ms: number, signal: AbortSignal) => Promise<void> {
    return (ms, signal) =>
      new Promise<void>((resolve) => {
        if (life.dead || signal.aborted) return;
        if (ms <= 0) {
          queueMicrotask(resolve);
          return;
        }
        const timer: Timer = { at: this.mono + ms, life, resolve };
        this.#timers.push(timer);
        signal.addEventListener("abort", () => {
          this.#timers = this.#timers.filter((t) => t !== timer);
        });
      });
  }

  /** One boundary: an armed crash fires before or after its effect. */
  async #boundary<T>(life: Life, effect: () => Promise<T>): Promise<T> {
    if (life.dead) throw new Crash();
    const armed = this.#armed;
    if (armed !== undefined) {
      armed.left -= 1;
      if (armed.left <= 0) {
        this.#armed = undefined;
        if (armed.after) await effect().catch(() => undefined);
        this.#die();
        throw new Crash();
      }
    }
    return effect();
  }

  #faultyStore(store: RunStore, life: Life): RunStore {
    const alive = <T>(call: () => Promise<T>): Promise<T> =>
      life.dead ? Promise.reject(new Crash()) : call();
    return {
      createRun: (input, id) => this.#boundary(life, () => store.createRun(input, id)),
      replayedRun: (id) => alive(() => store.replayedRun(id)),
      transitionRun: (id, expect, next, patch) =>
        this.#boundary(life, () => store.transitionRun(id, expect, next, patch)),
      readRun: (id) => alive(() => store.readRun(id)),
      openWork: (machine) => alive(() => store.openWork(machine)),
    };
  }

  #files(life: Life): RunFolders {
    return {
      prepare: () => {
        if (life.dead) throw new Crash();
      },
      saveAnswer: (id, answer) => {
        if (life.dead) throw new Crash();
        // A write is a boundary too, but a synchronous one: an armed crash before it loses it.
        const armed = this.#armed;
        if (armed !== undefined && armed.left <= 1) {
          this.#armed = undefined;
          if (armed.after) this.saved.set(id, answer);
          this.#die();
          throw new Crash();
        }
        if (armed !== undefined) armed.left -= 1;
        this.saved.set(id, answer);
      },
      readAnswer: (id) => this.saved.get(id),
      logs: () => ({ stdout: () => undefined, stderr: () => undefined, close: () => undefined }),
      removeTemps: () => undefined,
    };
  }

  #containers(life: Life): Containers {
    const alive = <T>(call: () => T): Promise<T> =>
      life.dead ? Promise.reject(new Crash()) : Promise.resolve(call());
    const confirm = async (name: string, waitMs = 0): Promise<Confirmation> => {
      if (life.dead) throw new Crash();
      const box = this.boxes.get(name);
      if (box === undefined || box.procs === 0) return { state: "empty" };
      await this.#wait(life)(waitMs, new AbortController().signal);
      // The service may have died while it waited.
      if (isDead(life)) throw new Crash();
      return this.boxes.get(name)?.procs === 0
        ? { state: "empty" }
        : { state: "occupied", detail: "procs" };
    };
    return {
      probe: () => alive(() => ({ available: true as const, kind: "job" as const })),
      kind: () => alive(() => "job" as const),
      start: (spec) => this.#boundary(life, () => this.#start(spec, life)),
      interrupt: (name) =>
        alive(() => {
          const box = this.boxes.get(name);
          if (box === undefined || !box.agentAlive) return false;
          if (box.obeys) {
            this.#say(name, box, true);
            this.#agentExit(box, { code: 0, signal: null });
          }
          return true;
        }),
      kill: (name) =>
        this.#boundary(life, () => {
          this.#kill(name);
          return Promise.resolve();
        }),
      confirmEmpty: (name, options) => confirm(name, options?.waitMs ?? 0),
      recover: async (name, options) => {
        if (life.dead) throw new Crash();
        this.#kill(name);
        return confirm(name, options?.waitMs ?? 10_000);
      },
    };
  }

  #start(spec: ContainerSpec, life: Life): Promise<Contained> {
    const how = this.modes.get(spec.name) ?? { mode: "ok", obeys: true };
    if (how.mode === "refuse") {
      return Promise.reject(new ContainerError("start_failed", "the agent did not start"));
    }
    if (how.mode === "ok") return Promise.resolve(this.#create(spec.name, how.obeys));
    return new Promise<Contained>((resolve, reject) => {
      this.hung.set(spec.name, {
        life,
        answer: (ok) => {
          this.hung.delete(spec.name);
          if (life.dead) return;
          if (ok) resolve(this.#create(spec.name, how.obeys));
          else reject(new ContainerError("start_failed", "the agent did not start"));
        },
      });
    });
  }

  #create(name: string, obeys: boolean): Contained {
    let exit!: (exit: AgentExit) => void;
    const exited = new Promise<AgentExit>((resolve) => {
      exit = resolve;
    });
    const box: Box = {
      procs: 1,
      agentAlive: true,
      stuck: false,
      obeys,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exit,
      ended: false,
    };
    this.boxes.set(name, box);
    this.#pids += 1;
    return {
      name,
      pid: this.#pids,
      stdin: this.#stdin(name),
      stdout: box.stdout,
      stderr: box.stderr,
      exited,
    };
  }

  /** An agent's input, kept for the test as it arrives. */
  #stdin(name: string): PassThrough {
    const stdin = new PassThrough();
    this.input.set(name, "");
    stdin.on("data", (chunk: Buffer) => {
      this.input.set(name, (this.input.get(name) ?? "") + chunk.toString("utf8"));
    });
    return stdin;
  }

  #agentExit(box: Box, exit: AgentExit): void {
    if (!box.agentAlive) return;
    box.agentAlive = false;
    box.procs = Math.max(0, box.procs - 1);
    box.exit(exit);
    this.#maybeEnd(box);
  }

  /** The output pipes end once no process of the container holds them. */
  #maybeEnd(box: Box): void {
    if (box.procs === 0 && !box.ended) {
      box.ended = true;
      box.stdout.end();
      box.stderr.end();
    }
  }

  #kill(name: string): void {
    const box = this.boxes.get(name);
    if (box === undefined) return;
    const survivor = box.stuck && box.procs > 0;
    this.#agentExit(box, { code: null, signal: "SIGKILL" });
    box.procs = survivor ? 1 : 0;
    this.#maybeEnd(box);
  }

  #say(name: string, box: Box, final: boolean): void {
    if (!box.agentAlive) return;
    this.#said += 1;
    const text = `answer ${String(this.#said)}`;
    const spoken = this.spoken.get(name) ?? { answers: [], finals: new Set<string>() };
    spoken.answers.push(text);
    if (final) spoken.finals.add(text);
    this.spoken.set(name, spoken);
    const line = final
      ? { type: "result", subtype: "success", is_error: false, result: text }
      : { type: "assistant", message: { content: [{ type: "text", text }] } };
    box.stdout.write(`${JSON.stringify(line)}\n`);
  }

  /** The service dies: its timers and calls end, and its containers' processes with it. */
  #die(): void {
    if (this.#life.dead) return;
    this.#life.dead = true;
    this.#timers = this.#timers.filter((t) => !t.life.dead);
    for (const [name, hung] of this.hung) if (hung.life.dead) this.hung.delete(name);
    for (const box of this.boxes.values()) {
      box.agentAlive = false;
      box.procs = box.stuck && box.procs > 0 ? 1 : 0;
      this.#maybeEnd(box);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Events

  #pick(pick: number): string | undefined {
    return this.runs.length === 0 ? undefined : this.runs[pick % this.runs.length];
  }

  async run(event: Event): Promise<void> {
    if (this.#life.dead) await this.#restart();
    const host = this.#host;
    const id = "pick" in event ? this.#pick(event.pick) : undefined;
    const box = id === undefined ? undefined : this.boxes.get(id);
    const quiet = (promise: Promise<unknown>): void => {
      void promise.catch((error: unknown) => {
        if (!(error instanceof Crash)) throw error;
      });
    };
    switch (event.kind) {
      case "queue": {
        const task = this.#backend.tasks[this.runs.length % this.#backend.tasks.length] ?? "";
        const machine = new RunMachine({
          store: this.#faultyStore(this.#backend.store(), this.#life),
          machine: this.#backend.machine,
        });
        this.#requests += 1;
        try {
          const run = await machine.queue(
            {
              task,
              routine: null,
              instance: "claude-work",
              adapter: "claude-print",
              place: null,
              request: "Fix the export.",
              briefHash: "0a1b2c3d".repeat(8),
              permission: "auto-edit",
              limits: this.limits,
            },
            `host-model-${String(this.#requests).padStart(8, "0")}`,
          );
          this.runs.push(run.id);
        } catch (error) {
          if (!(error instanceof Crash)) throw error;
        }
        break;
      }
      case "start":
        if (id === undefined) break;
        this.modes.set(id, { mode: event.mode, obeys: event.obeys });
        quiet(
          host.start(id, () => ({
            command: "agent",
            args: [],
            cwd: "/w",
            env: {},
            ...(this.open === undefined ? {} : { open: this.open }),
          })),
        );
        break;
      case "answerStart":
        if (id !== undefined) this.hung.get(id)?.answer(event.ok);
        break;
      case "say":
        if (id !== undefined && box !== undefined) this.#say(id, box, event.final);
        break;
      case "fork":
        if (box?.agentAlive === true) box.procs += 1;
        break;
      case "exit":
        if (box !== undefined) this.#agentExit(box, { code: event.code, signal: null });
        break;
      case "stop":
        if (id !== undefined) quiet(host.stop(id));
        break;
      case "stick":
        if (box !== undefined && box.procs > 0) box.stuck = true;
        break;
      case "release":
        if (box !== undefined) box.stuck = false;
        break;
      case "forceEnd":
        if (id !== undefined) quiet(host.forceEnd(id));
        break;
      case "tick":
        await this.#advance(event.ms);
        break;
      case "arm":
        this.#armed = { left: event.after, after: event.late };
        break;
      case "crash":
        this.#die();
        break;
    }
    await flush();
  }

  /** Moves the fake clock, firing each timer in order and letting its work run. */
  async #advance(ms: number): Promise<void> {
    const target = this.mono + ms;
    for (;;) {
      await flush();
      const due = this.#timers
        .filter((t) => t.at <= target && !t.life.dead)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.now += due.at - this.mono;
      this.mono = due.at;
      due.resolve();
    }
    this.now += target - this.mono;
    this.mono = target;
    await flush();
  }

  /** A new service on the same durable state: it recovers at once. */
  async #restart(): Promise<void> {
    this.#life = { dead: false };
    this.#armed = undefined;
    this.#host = this.#newHost();
    const recovering = this.#host.recover().catch((error: unknown) => {
      if (!(error instanceof Crash)) throw error;
      return [];
    });
    // Recovery waits for confirmations on the clock; time goes on while it does.
    await flush();
    await this.#advance(20_000);
    await recovering;
  }

  /**
   * The end of a scenario: the agents and starts are left as they are, and time goes on until every
   * limit passed. Every run must then be final or `unknown`. Then every stuck process is released,
   * and the next start must settle every run that is not queued.
   */
  async finish(store: () => RunStore): Promise<void> {
    if (this.#life.dead) await this.#restart();
    this.#armed = undefined;
    for (let i = 0; i < 6; i += 1) await this.#advance(70_000);
    for (const id of this.runs) {
      const run = await store().readRun(id);
      if (run === undefined || run.state === "queued") continue;
      if (!FINAL.has(run.state))
        throw new Error(`a run stays ${run.state} after every limit passed`);
    }
    for (const box of this.boxes.values()) box.stuck = false;
    this.#die();
    await this.#restart();
    for (const id of this.runs) {
      const run = await store().readRun(id);
      if (run === undefined || run.state === "queued") continue;
      if (!FINAL.has(run.state) || run.state === "unknown") {
        throw new Error(`the next start left a run ${run.state}`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Invariants

  /** The store against the world's truth, after every event. */
  async check(store: RunStore): Promise<void> {
    for (const id of this.runs) {
      const run = await store.readRun(id);
      if (run === undefined) continue;
      if (run.at.cancelling !== undefined) this.stopped.add(id);
      this.seen.add(run.state);
      this.#checkRun(run);
    }
  }

  #checkRun(run: RunRecord): void {
    const box = this.boxes.get(run.id);
    const occupied = (box?.procs ?? 0) > 0 || this.hung.has(run.id);
    if (FINAL.has(run.state) && run.state !== "unknown" && occupied) {
      throw new Error(`a ${run.state} run's container is not empty`);
    }
    if (
      this.stopped.has(run.id) &&
      !["cancelling", "reconciling", "unknown", "cancelled"].includes(run.state)
    ) {
      throw new Error(`a stopped run is ${run.state}`);
    }
    const text = run.result?.text ?? null;
    const spoken = this.spoken.get(run.id) ?? { answers: [], finals: new Set<string>() };
    if (text !== null && !spoken.answers.includes(text)) {
      throw new Error("a run's answer is not one its agent gave whole");
    }
    if (run.result?.textFinal === true && text !== null && !spoken.finals.has(text)) {
      throw new Error("an answer is marked final that the agent never finished with");
    }
    if (run.reason === "service_ended" && text !== (this.saved.get(run.id)?.text ?? null)) {
      throw new Error("recovery did not copy the saved answer");
    }
    // A run that ended in its service has the answer the parser chose from all its agent wrote:
    // the last one it finished its turn with, else its last message. One settled after a restart
    // has the one saved last.
    if (run.result !== null && FINAL.has(run.state) && run.state !== "unknown") {
      const last =
        [...spoken.answers].reverse().find((a) => spoken.finals.has(a)) ?? spoken.answers.at(-1);
      if (text !== (last ?? null) && text !== (this.saved.get(run.id)?.text ?? null)) {
        throw new Error("a run's answer is neither its agent's last nor the one saved");
      }
    }
  }
}

/** Lets every promise, stream and immediate the last step started run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
