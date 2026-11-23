// A model world for the supervisor: a service with a run machine and a run host per space over
// in-memory stores, the supervisor over them, fake containers on a fake operating system that
// outlives the service, and run folders that outlive it too. The world checks the supervisor's
// promises where they are kept or broken: at each container start (the limits, a Stop, the update
// hold) and at each folder's removal (retention), and once everything settled (no run waits while
// there is room for it).
import { PassThrough } from "node:stream";
import {
  awaitsConfirmation,
  FINAL_RUN_STATES,
  type RunRecord,
  type RunState,
} from "@ttasks/contracts/runs";
import { MemoryDurable, MemoryExecutionStore } from "@ttasks/launch/memory-store";
import type { RunStore } from "@ttasks/launch/execution-store";
import {
  ContainerError,
  planStarts,
  RunHost,
  RunMachine,
  Supervisor,
  type AgentExit,
  type Contained,
  type Containers,
  type ContainerSpec,
  type HeldAnswer,
  type Hold,
  type Lane,
  type QueueLimits,
  type RunFolderList,
  type RunFolders,
  type SavedAnswer,
  type Slot,
} from "../src/index.ts";

/** What a folder holds of a run's answer, as RunFiles would read it. */
export const held = (answer: SavedAnswer | undefined): HeldAnswer =>
  answer === undefined ? { kind: "none" } : { kind: "saved", answer };

/** Whether removing a folder that holds `answer` loses what its run's record does not keep. */
const lostWith = (answer: SavedAnswer | undefined, run: RunRecord): boolean =>
  answer !== undefined &&
  typeof run.result?.text !== "string" &&
  (answer.text !== null || run.result === null);

export const MACHINE = "m_3q7k9d2xw8f4r6t1c5v0b2n8a7";
export const SPACES = ["sp_0000000000000000000000000a", "sp_0000000000000000000000000b"];
export const TASKS = [
  "t_0000000000000000000000000a",
  "t_0000000000000000000000000b",
  "t_0000000000000000000000000c",
];
export const INSTANCES = ["claude-work", "claude-home", "codex-work"];
const DAY = 24 * 60 * 60_000;

export type Event =
  | { kind: "queue"; space: number; task: number; instance: number }
  | { kind: "stop"; pick: number }
  | { kind: "end"; pick: number }
  | { kind: "limits"; runs: number; perInstance: number; perTask: number }
  | { kind: "restart" }
  | { kind: "hold" }
  | { kind: "release"; dies: boolean }
  | { kind: "close-task"; task: number }
  | { kind: "refuse-start"; on: boolean }
  | { kind: "age"; days: number }
  | { kind: "retain" };

/** One run's container on the fake operating system. */
interface Box {
  alive: boolean;
  readonly space: string;
  readonly task: string | null;
  readonly instance: string;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly exit: (exit: AgentExit) => void;
}

/** One service's life: its store calls fail once it is gone. */
interface Life {
  dead: boolean;
}

class Gone extends Error {
  override readonly name = "Gone";
}

const FINAL: ReadonlySet<RunState> = new Set(FINAL_RUN_STATES);
const ACTIVE: ReadonlySet<RunState> = new Set([
  "starting",
  "running",
  "waiting_for_input",
  "cancelling",
  "reconciling",
]);

/** A store whose calls fail once its service is gone, as a dead process makes none. */
function lifeStore(store: RunStore, life: Life): RunStore {
  return new Proxy(store, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (life.dead) return Promise.reject(new Gone());
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Lets every promise, stream and immediate the last step started run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const never = (): Promise<void> => new Promise<void>(() => undefined);

export class SupervisorWorld {
  now = Date.UTC(2026, 10, 16, 9, 0, 0);
  limits: QueueLimits = { runs: 3, perInstance: 2, perTask: 1 };
  readonly durables = SPACES.map(() => new MemoryDurable(() => this.now));
  readonly boxes = new Map<string, Box>();
  readonly folders = new Map<string, { changedAt: number; answer?: SavedAnswer }>();
  /** Every run queued, in order. */
  readonly runs: string[] = [];
  /** Runs a Stop cancelled while they were queued: none of them may ever start. */
  readonly stoppedQueued = new Set<string>();
  readonly closedTasks = new Set<string>();
  /** Every container start, in order. */
  readonly started: string[] = [];
  /** Folders retention removed. */
  readonly removed: string[] = [];
  /** Promises broken where the supervisor cannot see them: at a start or at a removal. */
  readonly broken: string[] = [];
  refuseStarts = false;
  #life: Life = { dead: false };
  #lanes: Lane[] = [];
  #supervisor: Supervisor;
  #holds: Hold[] = [];
  /** A hold whose first round ended: from then on nothing may start. */
  #holdInForce = false;
  #requests = 0;
  #pids = 1_000;

  constructor() {
    this.#supervisor = this.#start();
  }

  get supervisor(): Supervisor {
    return this.#supervisor;
  }

  store(space: number): MemoryExecutionStore {
    return new MemoryExecutionStore(this.durables[space]);
  }

  record(id: string): RunRecord | undefined {
    for (const durable of this.durables) {
      const run = durable.runs.get(id);
      if (run !== undefined) return run;
    }
    return undefined;
  }

  #start(): Supervisor {
    const life = this.#life;
    const containers = this.#containers();
    const files = this.#files();
    this.#lanes = SPACES.map((space, i) => {
      const machine = new RunMachine({
        store: lifeStore(this.store(i), life),
        machine: MACHINE,
        wait: never,
      });
      const host = new RunHost({
        machine,
        containers,
        files,
        now: () => this.now,
        wait: never,
      });
      return { space, machine, host };
    });
    return new Supervisor({
      lanes: () => this.#lanes,
      limits: () => this.limits,
      prepare: (_lane, run) =>
        Promise.resolve(
          run.task !== null && this.closedTasks.has(run.task)
            ? { refused: "task_closed" as const }
            : { command: () => ({ command: "agent", args: [], cwd: "/", env: {} }) },
        ),
      folders: files,
      retention: { days: 1, count: 3 },
      now: () => this.now,
    });
  }

  /** The fake operating system's containers, which check the supervisor's promises at a start. */
  #containers(): Containers {
    const end = (box: Box, exit: AgentExit) => {
      if (!box.alive) return;
      box.alive = false;
      box.exit(exit);
      box.stdout.end();
      box.stderr.end();
    };
    return {
      probe: () => Promise.resolve({ available: true, kind: "job" }),
      start: (spec: ContainerSpec): Promise<Contained> => {
        const name = spec.name;
        const run = this.record(name);
        if (run === undefined) {
          this.broken.push("a container started for a run no store has");
          return Promise.reject(new ContainerError("start_failed", "no run"));
        }
        this.#checkStart(run);
        if (this.refuseStarts) {
          return Promise.reject(new ContainerError("start_failed", "refused"));
        }
        let exit!: (exit: AgentExit) => void;
        const exited = new Promise<AgentExit>((resolve) => {
          exit = resolve;
        });
        const box: Box = {
          alive: true,
          space: SPACES[this.durables.findIndex((d) => d.runs.has(name))] ?? "",
          task: run.task,
          instance: run.instance,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exit,
        };
        this.boxes.set(name, box);
        this.started.push(name);
        this.#pids += 1;
        return Promise.resolve({
          name,
          pid: this.#pids,
          stdin: new PassThrough(),
          stdout: box.stdout,
          stderr: box.stderr,
          exited,
        });
      },
      interrupt: (name) => {
        const box = this.boxes.get(name);
        if (box?.alive !== true) return Promise.resolve(false);
        this.#answer(box, "Stopped here.");
        end(box, { code: 0, signal: null });
        return Promise.resolve(true);
      },
      kill: (name) => {
        const box = this.boxes.get(name);
        if (box !== undefined) end(box, { code: null, signal: "SIGKILL" });
        return Promise.resolve();
      },
      confirmEmpty: (name) =>
        Promise.resolve(
          this.boxes.get(name)?.alive === true
            ? { state: "occupied", detail: "alive" }
            : { state: "empty" },
        ),
      recover: (name) => {
        const box = this.boxes.get(name);
        if (box !== undefined) end(box, { code: null, signal: "SIGKILL" });
        return Promise.resolve({ state: "empty" });
      },
    };
  }

  #answer(box: Box, text: string): void {
    box.stdout.write(
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text })}\n`,
    );
  }

  /** The supervisor's promises at the moment a container starts. */
  #checkStart(run: RunRecord): void {
    if (this.stoppedQueued.has(run.id)) this.broken.push("a run stopped while queued started");
    if (this.#holdInForce) this.broken.push("a run started while an update held the queue");
    const alive = [...this.boxes.values()].filter((b) => b.alive);
    const space = SPACES[this.durables.findIndex((d) => d.runs.has(run.id))];
    if (alive.length >= this.limits.runs) this.broken.push("a start went past the machine's limit");
    if (alive.filter((b) => b.instance === run.instance).length >= this.limits.perInstance) {
      this.broken.push("a start went past its instance's limit");
    }
    if (
      run.task !== null &&
      alive.filter((b) => b.task === run.task && b.space === space).length >= this.limits.perTask
    ) {
      this.broken.push("a start went past its task's limit");
    }
  }

  /** Run folders that outlive the service; a removal checks retention's promise. */
  #files(): RunFolders & RunFolderList {
    return {
      prepare: (id) => {
        this.folders.set(id, { changedAt: this.now });
      },
      saveAnswer: (id, answer) => {
        this.folders.set(id, { changedAt: this.now, answer });
      },
      readAnswer: (id) => this.folders.get(id)?.answer,
      heldAnswer: (id) => held(this.folders.get(id)?.answer),
      logs: () => ({
        stdout: () => undefined,
        stderr: () => undefined,
        close: () => undefined,
      }),
      removeTemps: () => undefined,
      list: () => [...this.folders].map(([id, f]) => ({ id, changedAt: f.changedAt })),
      remove: (id) => {
        const run = this.record(id);
        if (run === undefined) this.broken.push("a folder went whose run no open space knows");
        else if (!FINAL.has(run.state) || awaitsConfirmation(run)) {
          this.broken.push(`the folder of a ${run.state} run went`);
        } else if (this.#lanes.some((lane) => lane.host.hosted().includes(id))) {
          this.broken.push("the folder of a run its host still works on went");
        } else if (lostWith(this.folders.get(id)?.answer, run)) {
          this.broken.push("the folder of a run whose answer is not saved went");
        }
        this.folders.delete(id);
        this.removed.push(id);
      },
    };
  }

  #pick(pick: number, ok: (run: RunRecord) => boolean): string | undefined {
    const candidates = this.runs.filter((id) => {
      const run = this.record(id);
      return run !== undefined && ok(run);
    });
    return candidates.length === 0 ? undefined : candidates[pick % candidates.length];
  }

  #laneOf(id: string): Lane | undefined {
    const space = this.durables.findIndex((d) => d.runs.has(id));
    return this.#lanes[space];
  }

  async run(event: Event): Promise<void> {
    switch (event.kind) {
      case "queue": {
        this.now += 1;
        this.#requests += 1;
        const lane = this.#lanes[event.space % SPACES.length];
        if (lane === undefined) return;
        const run = await lane.machine.queue(
          {
            task: TASKS[event.task % TASKS.length] ?? null,
            routine: null,
            instance: INSTANCES[event.instance % INSTANCES.length] ?? "claude-work",
            adapter: "claude-print",
            place: null,
            request: "Look into the export.",
            briefHash: "0a1b2c3d".repeat(8),
            permission: "auto-edit",
            limits: { maxTurns: 50, wallMs: 60 * 60_000, idleMs: 20 * 60_000 },
          },
          `supervisor-model-${String(this.#requests).padStart(8, "0")}`,
        );
        this.runs.push(run.id);
        void this.#supervisor.round();
        return;
      }
      case "stop": {
        const id = this.#pick(event.pick, (r) => !FINAL.has(r.state));
        const lane = id === undefined ? undefined : this.#laneOf(id);
        if (id === undefined || lane === undefined) return;
        const before = this.record(id)?.state;
        const after = await lane.host.stop(id).catch(() => undefined);
        if (before === "queued" && after?.state === "cancelled") this.stoppedQueued.add(id);
        void this.#supervisor.round();
        return;
      }
      case "end": {
        const alive = [...this.boxes].filter(([, b]) => b.alive);
        const found = alive[event.pick % Math.max(1, alive.length)];
        if (found === undefined) return;
        const [, box] = found;
        this.#answer(box, "Found it.");
        box.alive = false;
        box.exit({ code: 0, signal: null });
        box.stdout.end();
        box.stderr.end();
        return;
      }
      case "limits":
        this.limits = {
          runs: event.runs,
          perInstance: event.perInstance,
          perTask: event.perTask,
        };
        void this.#supervisor.round();
        return;
      case "restart": {
        // The service ends: its runs' processes with it, its holds with their connections.
        this.#supervisor.close();
        this.#life.dead = true;
        await Promise.all(this.#lanes.map((lane) => lane.host.close()));
        for (const box of this.boxes.values()) {
          if (box.alive) {
            box.alive = false;
            box.exit({ code: null, signal: "SIGKILL" });
            box.stdout.end();
            box.stderr.end();
          }
        }
        this.#holds = [];
        this.#holdInForce = false;
        this.#life = { dead: false };
        this.#supervisor = this.#start();
        await Promise.all(this.#lanes.map((lane) => lane.host.recover()));
        void this.#supervisor.round();
        return;
      }
      case "hold": {
        this.#holds.push(this.#supervisor.hold());
        // The updater learns what blocks from a round that began after its hold.
        await this.#supervisor.blocking();
        this.#holdInForce = true;
        return;
      }
      case "release": {
        // A holder that dies lets go of its hold the same way: its connection closes.
        this.#holds.shift()?.release();
        this.#holdInForce = this.#holds.length > 0;
        return;
      }
      case "close-task":
        this.closedTasks.add(TASKS[event.task % TASKS.length] ?? "");
        return;
      case "refuse-start":
        this.refuseStarts = event.on;
        return;
      case "age":
        this.now += event.days * DAY;
        void this.#supervisor.round();
        return;
      case "retain":
        await this.#supervisor.retain();
        return;
    }
  }

  /** Once everything settled: no queued run waits while there is room for it. */
  check(): void {
    if (this.broken.length > 0) throw new Error(this.broken.join("; "));
    const queued: Slot[] = [];
    const active: Slot[] = [];
    for (const [i, durable] of this.durables.entries()) {
      for (const run of durable.runs.values()) {
        const slot = {
          space: SPACES[i] ?? "",
          id: run.id,
          task: run.task,
          instance: run.instance,
          queuedAt: run.queuedAt,
        };
        if (run.state === "queued") queued.push(slot);
        else if (ACTIVE.has(run.state)) active.push(slot);
      }
    }

    const waiting = new Set(queued.map((s) => s.id));
    if (this.#holds.length > 0) {
      for (const id of waiting) {
        if (this.#supervisor.waiting(id) !== "update") {
          throw new Error("a run waits during an update without saying so");
        }
      }
      return;
    }
    const { start } = planStarts(queued, active, this.limits);
    if (start.length > 0) throw new Error("a queued run waits while there is room for it");
    for (const id of waiting) {
      if (this.#supervisor.waiting(id) === undefined) {
        throw new Error("a queued run waits without saying why");
      }
    }
  }

  /** The end of a scenario: holds go, every agent finishes, and every run settles. */
  async finish(): Promise<void> {
    for (const hold of this.#holds.splice(0)) hold.release();
    this.#holdInForce = false;
    this.closedTasks.clear();
    this.refuseStarts = false;
    for (let i = 0; i < this.runs.length + 2; i += 1) {
      for (const box of this.boxes.values()) {
        if (box.alive) {
          this.#answer(box, "Done.");
          box.alive = false;
          box.exit({ code: 0, signal: null });
          box.stdout.end();
          box.stderr.end();
        }
      }
      await this.#supervisor.round();
      await settle();
    }
    for (const id of this.runs) {
      const run = this.record(id);
      if (run === undefined || !FINAL.has(run.state)) {
        throw new Error(`a run did not settle: ${run?.state ?? "missing"}`);
      }
    }
    if ([...this.boxes.values()].some((b) => b.alive)) throw new Error("a container lives on");
  }

  async close(): Promise<void> {
    this.#supervisor.close();
    this.#life.dead = true;
    await Promise.all(this.#lanes.map((lane) => lane.host.close()));
  }
}
