// The run host: one background run from its `starting` record to its settled end, in a container
// (container/) whose processes it ends together and confirms gone from the operating system's own
// count. What the person can count on, and how this keeps it:
//
// - Stop ends the agent and everything it started, and the run is called ended only once that is
//   confirmed. Stop is committed first (`cancelling`); then the agent gets an interrupt, so it can
//   print its answer, and after the grace time the container is killed and confirmed empty. A
//   container that is not empty in time leaves the run `unknown`, with End by force.
// - The answer is kept whole up to 1 MiB, also after megabytes of other output: every byte of
//   stdout goes through the parser, and each answer-bearing event is saved to the run's folder as
//   it is parsed, before anything else, so a crash of the service keeps the last one.
// - When the service ends, its runs' processes end with it (the container's own guarantee). The
//   next start confirms each open run's container from its name before it settles the run
//   (`service_ended`), with the last saved answer.
// - A late PID, exit or event never revives a stopped run: the record's rules (machine.ts) refuse
//   it, and a container that starts after its run gave up on it is killed.
//
// Every limit runs on the monotonic clock: the start time, the run's wall and idle times, the
// stop's grace, the confirmation and the drain of the output after the container is empty.
import type { RunRecord, RunResult } from "@tasks/contracts/runs";
import { SIGNAL_NAME } from "@tasks/contracts/runs";
import type {
  AgentExit,
  Confirmation,
  Contained,
  ContainerSpec,
  Containers,
} from "./container/index.ts";
import { RunMachine, type RunEnd } from "./machine.ts";
import type { RunFolders, SavedAnswer } from "./run-files.ts";
import { createStreamParser, type RunEvent, type RunOutcome } from "./streams/index.ts";

/** The host's time limits, in milliseconds. A run's wall and idle times come from its record. */
export interface RunTimes {
  /** From the start of the container to the agent's PID. */
  startMs: number;
  /** From the interrupt to the kill. */
  stopGraceMs: number;
  /** From the kill to the confirmation that the container is empty. */
  confirmMs: number;
  /** For the output pipes to end once the container is empty. */
  drainMs: number;
  /** Between attempts to record a run's end that the store did not take. */
  retryMs: number;
  /** How long those attempts go on; the next start settles the run after that. */
  retryForMs: number;
}

export const RUN_TIMES: Readonly<RunTimes> = {
  startMs: 60_000,
  stopGraceMs: 10_000,
  confirmMs: 10_000,
  drainMs: 5_000,
  retryMs: 30_000,
  retryForMs: 10 * 60_000,
};

/** What runs in a run's container: the agent's program, arguments, folder and environment. */
export type AgentCommand = Omit<ContainerSpec, "name">;

/** What the host logs: codes and counts only, never a run's text. */
export type RunHostLog = (
  event: "run.started" | "run.settled" | "run.recovered" | "run.failed",
  fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export interface RunHostOptions {
  readonly machine: RunMachine;
  readonly containers: Containers;
  readonly files: RunFolders;
  /** Wall clock milliseconds, for the PID's start time. Default: Date.now. */
  readonly now?: () => number;
  /** A monotonic clock in milliseconds. Default: performance.now. */
  readonly elapsed?: () => number;
  /** Resolves once `ms` passed on the monotonic clock, or never when `signal` aborts first. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly times?: Partial<RunTimes>;
  readonly log?: RunHostLog;
}

/** A container is named after its run: the record of `starting` is the record of its name. */
export const containerName = (run: string): string => run;

/** One run this host works on, from its start until its record is final. */
interface Flow {
  readonly id: string;
  /** A Stop was accepted for it. */
  stopping: boolean;
  readonly stopped: Promise<"stop">;
  readonly stop: () => void;
  /** The container's start has not answered yet: a container may still appear. */
  startPending: boolean;
  /** The end it settles with once its container is confirmed empty, while it is `unknown`. */
  pending: RunEnd | undefined;
  readonly abort: AbortController;
  done: Promise<RunRecord | undefined>;
}

function timer(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (typeof handle === "object") handle.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(handle);
    });
  });
}

/** Resolves when a stream ended or failed. */
const endOf = (stream: NodeJS.ReadableStream): Promise<void> =>
  new Promise((resolve) => {
    stream.once("end", resolve);
    stream.once("close", resolve);
    stream.once("error", () => {
      resolve();
    });
  });

/** The result a record keeps from the parser's outcome. */
export function resultOf(outcome: RunOutcome, durationMs: number | null): RunResult {
  const signal = outcome.exit.signal;
  return {
    ok: outcome.ok,
    outcome: outcome.reason,
    exitCode: outcome.exit.code,
    signal: signal !== null && SIGNAL_NAME.test(signal) ? signal : null,
    nativeId: outcome.nativeId,
    text: outcome.result,
    ...(outcome.resultCut ? { textCut: true } : {}),
    ...(outcome.resultFinal ? { textFinal: true } : {}),
    error: outcome.error,
    usage: outcome.usage,
    appTools: outcome.session?.appTools ?? null,
    declined: outcome.counts.declined,
    permissionDenials: outcome.counts.permissionDenials,
    durationMs: durationMs === null ? null : Math.max(0, Math.round(durationMs)),
  };
}

/** The result recovery records from a run's saved answer: the run did not end by itself. */
export function savedResult(run: RunRecord, saved: SavedAnswer | undefined): RunResult | null {
  if (saved === undefined) return null;
  return {
    ok: false,
    outcome: "no_result",
    exitCode: null,
    signal: null,
    nativeId: run.evidence.native_id ?? null,
    text: saved.text,
    ...(saved.cut ? { textCut: true } : {}),
    ...(saved.final ? { textFinal: true } : {}),
    error: null,
    usage: null,
    appTools: null,
    declined: 0,
    permissionDenials: 0,
    durationMs: null,
  };
}

export class RunHost {
  readonly #machine: RunMachine;
  readonly #containers: Containers;
  readonly #files: RunFolders;
  readonly #now: () => number;
  readonly #elapsed: () => number;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #times: RunTimes;
  readonly #log: RunHostLog;
  readonly #flows = new Map<string, Flow>();
  readonly #closed = new AbortController();

  constructor(options: RunHostOptions) {
    this.#machine = options.machine;
    this.#containers = options.containers;
    this.#files = options.files;
    this.#now = options.now ?? Date.now;
    this.#elapsed = options.elapsed ?? (() => globalThis.performance.now());
    this.#wait = options.wait ?? timer;
    this.#times = { ...RUN_TIMES, ...options.times };
    this.#log = options.log ?? (() => undefined);
  }

  /** The runs this host works on now, `unknown` ones it can end by force included. */
  hosted(): string[] {
    return [...this.#flows.keys()];
  }

  /**
   * Starts a queued run: commits `starting`, then hosts it until its record is final. Returns the
   * record as `begin` left it: a run that was not queued is returned as it is and nothing starts.
   * `command` names what runs in the container; it is asked once, after the commit.
   */
  async start(
    id: string,
    command: (run: RunRecord) => AgentCommand | Promise<AgentCommand>,
  ): Promise<RunRecord | undefined> {
    if (this.#closed.signal.aborted) throw new Error("The run host is closed");
    if (this.#flows.has(id)) return this.#machine.read(id);
    const flow = this.#flow(id);
    let begun: { run: RunRecord | undefined; began: boolean };
    try {
      begun = await this.#machine.begin(id);
    } catch (error) {
      this.#flows.delete(id);
      throw error;
    }
    const run = begun.run;
    if (!begun.began || run === undefined) {
      this.#flows.delete(id);
      return run;
    }
    flow.done = this.#host(flow, run, command).catch((error: unknown) => {
      this.#failed("host", error);
      return undefined;
    });
    void flow.done.then(() => {
      if (flow.pending === undefined && this.#flows.get(id) === flow) this.#flows.delete(id);
    });
    return run;
  }

  /** Resolves with the run's record once this host's work on it is over. */
  async ended(id: string): Promise<RunRecord | undefined> {
    const flow = this.#flows.get(id);
    if (flow !== undefined) await flow.done;
    return this.#machine.read(id);
  }

  /**
   * The person's Stop: committed first, then the run is stopped. A queued run is cancelled at
   * once. A run no flow of this service holds is settled from its container's name, as at start.
   */
  async stop(id: string): Promise<RunRecord | undefined> {
    const { run, stopping } = await this.#machine.cancel(id);
    if (!stopping || run === undefined) return run;
    const flow = this.#flows.get(id);
    if (flow !== undefined) {
      flow.stop();
      return run;
    }
    return this.#reconcile(run);
  }

  /**
   * End by force, for an `unknown` run: ends whatever is left in its container by its name and
   * settles the run once the container is confirmed empty. A run whose container may still be
   * starting cannot be confirmed yet and stays `unknown`.
   */
  async forceEnd(id: string): Promise<RunRecord | undefined> {
    const run = await this.#machine.read(id);
    if (run?.state !== "unknown") return run;
    const flow = this.#flows.get(id);
    if (flow?.startPending === true) return run;
    const confirmed = await this.#recoverContainer(id);
    if (confirmed.state !== "empty") return run;
    const end = flow?.pending ?? this.#serviceEnded(run);
    const after = await this.#settle(id, end);
    if (flow !== undefined && after?.state !== "unknown") this.#flows.delete(id);
    return after;
  }

  /**
   * At the service's start: every open run of this machine that no flow of this host holds, and
   * every `unknown` one, is settled once its container is confirmed empty by its name: `failed`
   * (`service_ended`) with its last saved answer, or `cancelled` after an accepted Stop. One that
   * cannot be confirmed is `unknown`. Queued runs stay queued. Returns the runs it looked at.
   */
  async recover(): Promise<RunRecord[]> {
    const open = await this.#machine.open();
    const looked = open.filter((run) => run.state !== "queued" && !this.#flows.has(run.id));
    const settled = await Promise.all(looked.map((run) => this.#reconcile(run)));
    this.#log("run.recovered", { runs: looked.length });
    return settled.flatMap((run) => (run === undefined ? [] : [run]));
  }

  /**
   * Stops hosting: every wait ends and every live container is killed, without a record. The
   * service's own end ends them too; the next start's recovery settles the runs.
   */
  async close(): Promise<void> {
    this.#closed.abort();
    const flows = [...this.#flows.values()];
    for (const flow of flows) flow.abort.abort();
    await Promise.all(
      flows.map((flow) => this.#containers.kill(containerName(flow.id)).catch(() => undefined)),
    );
  }

  #flow(id: string): Flow {
    let stop!: () => void;
    const stopped = new Promise<"stop">((resolve) => {
      stop = () => {
        resolve("stop");
      };
    });
    const abort = new AbortController();
    this.#closed.signal.addEventListener("abort", () => {
      abort.abort();
    });
    const flow: Flow = {
      id,
      stopping: false,
      stopped,
      stop: () => {
        flow.stopping = true;
        stop();
      },
      startPending: false,
      pending: undefined,
      abort,
      done: Promise.resolve(undefined),
    };
    this.#flows.set(id, flow);
    return flow;
  }

  /** `promise`'s value, or undefined after `ms` or once the flow is aborted. */
  async #within<T>(flow: Flow, promise: Promise<T>, ms: number): Promise<T | undefined> {
    const stop = new AbortController();
    const abort = () => {
      stop.abort();
    };
    flow.abort.signal.addEventListener("abort", abort);
    try {
      return await Promise.race([
        promise,
        this.#wait(ms, stop.signal).then(() => undefined),
        new Promise<undefined>((resolve) => {
          if (flow.abort.signal.aborted) resolve(undefined);
          stop.signal.addEventListener("abort", () => {
            resolve(undefined);
          });
        }),
      ]);
    } finally {
      flow.abort.signal.removeEventListener("abort", abort);
      stop.abort();
    }
  }

  /** One run's life in its container, from the `starting` this host committed to its end. */
  async #host(
    flow: Flow,
    run: RunRecord,
    command: (run: RunRecord) => AgentCommand | Promise<AgentCommand>,
  ): Promise<RunRecord | undefined> {
    const name = containerName(run.id);
    let spec: ContainerSpec;
    try {
      this.#files.prepare(run.id);
      spec = { ...(await command(run)), name };
    } catch (error) {
      this.#failed("prepare", error);
      return this.#settle(flow.id, { kind: "start_failed", reason: "spawn_failed" });
    }
    // A Stop before anything started: nothing to stop.
    if (flow.stopping) {
      return this.#settle(flow.id, { kind: "start_failed", reason: "spawn_failed" });
    }

    flow.startPending = true;
    const starting = this.#containers.start(spec).then(
      (contained) => ({ ok: true as const, contained }),
      () => ({ ok: false as const }),
    );
    void starting.then(() => {
      flow.startPending = false;
    });
    const started = await this.#within(flow, starting, this.#times.startMs);
    if (started === undefined) return this.#startTimedOut(flow, starting);
    // The container's contract: a refused start leaves nothing running and no container.
    if (!started.ok) return this.#settle(flow.id, { kind: "start_failed", reason: "spawn_failed" });
    return this.#running(flow, run, started.contained);
  }

  /**
   * The container gave no agent within the start time: whatever it holds is ended. Its start may
   * still answer later, so the run is settled only once that answer came and the container is
   * confirmed empty; until then it is `unknown`.
   */
  async #startTimedOut(
    flow: Flow,
    starting: Promise<{ ok: true; contained: Contained } | { ok: false }>,
  ): Promise<RunRecord | undefined> {
    const name = containerName(flow.id);
    const end: RunEnd = { kind: "start_failed", reason: "start_timed_out" };
    await this.#containers.kill(name).catch(() => undefined);
    const late = await this.#within(flow, starting, this.#times.confirmMs);
    if (late === undefined) {
      flow.pending = end;
      const unknown = await this.#settle(flow.id, { kind: "not_confirmed" });
      // When the start answers at last, what it made is ended and the run settled.
      void starting
        .then(async () => {
          const confirmed = await this.#endContainer(name);
          if (confirmed.state === "empty" && flow.pending !== undefined) {
            await this.#settle(flow.id, flow.pending);
            flow.pending = undefined;
            if (this.#flows.get(flow.id) === flow) this.#flows.delete(flow.id);
          }
        })
        .catch((error: unknown) => {
          this.#failed("late_start", error);
        });
      return unknown;
    }
    return this.#confirmed(flow, end, await this.#endContainer(name));
  }

  /** The agent runs: its output is read, and the first of its exit, a Stop and a limit ends it. */
  async #running(flow: Flow, run: RunRecord, contained: Contained): Promise<RunRecord | undefined> {
    const name = contained.name;
    const startedAt = this.#elapsed();
    let exitedAt: number | undefined;
    const exited = contained.exited.then((exit) => {
      exitedAt = this.#elapsed();
      return exit;
    });
    this.#log("run.started", { adapter: run.adapter });
    await this.#machine.started(flow.id, contained.pid, this.#now()).catch((error: unknown) => {
      this.#failed("started", error);
    });

    const parser = createStreamParser(run.adapter);
    const logs = this.#files.logs(flow.id);
    let lastOutput = startedAt;
    const read = (events: readonly RunEvent[]): void => {
      for (const event of events) this.#event(flow, event);
    };
    contained.stdout.on("data", (chunk: Buffer) => {
      lastOutput = this.#elapsed();
      logs.stdout(chunk);
      read(parser.push(chunk));
    });
    contained.stderr.on("data", (chunk: Buffer) => {
      logs.stderr(chunk);
    });
    const drained = Promise.all([endOf(contained.stdout), endOf(contained.stderr)]);

    const limits = new AbortController();
    flow.abort.signal.addEventListener("abort", () => {
      limits.abort();
    });
    const why = await Promise.race([
      exited.then(() => "exited" as const),
      flow.stopped,
      this.#limits(run, startedAt, () => lastOutput, limits.signal),
    ]);
    limits.abort();

    if (why !== "exited") {
      // A Stop or a limit: the agent may still print its answer, then whatever is left is killed.
      await this.#containers.interrupt(name).catch(() => false);
      await this.#within(flow, exited, this.#times.stopGraceMs);
    }
    const confirmed = await this.#endContainer(name);
    // Once the container is empty, nothing holds the pipes: the rest of the output arrives.
    if (confirmed.state === "empty") await this.#within(flow, drained, this.#times.drainMs);
    const exit: AgentExit = (await this.#within(flow, exited, 0)) ?? { code: null, signal: null };
    const parsed = parser.end(exit);
    read(parsed.events);
    logs.close();
    const result = resultOf(parsed.outcome, exitedAt === undefined ? null : exitedAt - startedAt);
    const end: RunEnd =
      why === "wall" || why === "idle"
        ? { kind: "timed_out", limit: why, result }
        : { kind: "exited", result };
    return this.#confirmed(flow, end, confirmed);
  }

  /** Resolves with the run's limit that passed first: its wall time, or its time without output. */
  async #limits(
    run: RunRecord,
    startedAt: number,
    lastOutput: () => number,
    signal: AbortSignal,
  ): Promise<"wall" | "idle"> {
    for (;;) {
      const now = this.#elapsed();
      const wall = startedAt + run.limits.wallMs - now;
      const idle = lastOutput() + run.limits.idleMs - now;
      if (wall <= 0) return "wall";
      if (idle <= 0) return "idle";
      await this.#wait(Math.min(wall, idle), signal);
      if (signal.aborted) return new Promise<never>(() => undefined);
    }
  }

  /** What the parser reports, as it comes: the answer is saved first, at once. */
  #event(flow: Flow, event: RunEvent): void {
    if (event.kind === "answer") {
      try {
        this.#files.saveAnswer(flow.id, { text: event.text, final: event.final, cut: event.cut });
      } catch (error) {
        // The answer stays in memory and goes into the record when the run ends; only a crash
        // before that loses what this write would have kept.
        this.#failed("answer", error);
      }
    } else if (event.kind === "native-id") {
      void this.#machine.evidence(flow.id, { native_id: event.id }).catch((error: unknown) => {
        this.#failed("evidence", error);
      });
    }
  }

  /** Kills the container and waits until it is confirmed empty, or the confirmation time passed. */
  async #endContainer(name: string): Promise<Confirmation> {
    try {
      await this.#containers.kill(name);
    } catch {
      // The confirmation below says whether anything is left.
    }
    try {
      return await this.#containers.confirmEmpty(name, { waitMs: this.#times.confirmMs });
    } catch (error) {
      return { state: "unknown", detail: error instanceof Error ? error.name : "error" };
    }
  }

  /** From the container's name alone: ends what is left and confirms it empty. */
  async #recoverContainer(name: string): Promise<Confirmation> {
    try {
      return await this.#containers.recover(name, { waitMs: this.#times.confirmMs });
    } catch (error) {
      return { state: "unknown", detail: error instanceof Error ? error.name : "error" };
    }
  }

  /** Settles with `end` when the container is empty, else `unknown`, keeping `end` for later. */
  async #confirmed(
    flow: Flow,
    end: RunEnd,
    confirmed: Confirmation,
  ): Promise<RunRecord | undefined> {
    if (confirmed.state === "empty") return this.#settle(flow.id, end);
    flow.pending = end;
    return this.#settle(flow.id, { kind: "not_confirmed" });
  }

  /** The end a run gets once the service that hosted it is gone: its last saved answer. */
  #serviceEnded(run: RunRecord): RunEnd {
    let saved: SavedAnswer | undefined;
    try {
      saved = this.#files.readAnswer(run.id);
    } catch {
      saved = undefined;
    }
    return { kind: "service_ended", result: savedResult(run, saved) };
  }

  /** Recovery's rule for one run no flow holds: confirm its container by name, then settle. */
  async #reconcile(run: RunRecord): Promise<RunRecord | undefined> {
    const end = this.#serviceEnded(run);
    const confirmed = await this.#recoverContainer(containerName(run.id));
    if (confirmed.state === "empty") return this.#settle(run.id, end);
    const flow = this.#flows.get(run.id) ?? this.#flow(run.id);
    flow.pending = end;
    return this.#settle(run.id, { kind: "not_confirmed" });
  }

  /**
   * Records an end. A store that does not take it now is asked again every `retryMs` for
   * `retryForMs`; after that the run is left to the next start's recovery.
   */
  async #settle(id: string, end: RunEnd): Promise<RunRecord | undefined> {
    const until = this.#elapsed() + this.#times.retryForMs;
    for (;;) {
      try {
        const after = await this.#machine.settle(id, end);
        if (after !== undefined) {
          this.#log("run.settled", {
            state: after.state,
            ...(after.reason === null ? {} : { reason: after.reason }),
          });
        }
        return after;
      } catch (error) {
        this.#failed("settle", error);
        if (this.#closed.signal.aborted || this.#elapsed() >= until) return undefined;
        if (!(await this.#pause(this.#times.retryMs))) return undefined;
      }
    }
  }

  /** Waits `ms`: true once they passed, false when the host closed first. */
  #pause(ms: number): Promise<boolean> {
    const closed = this.#closed.signal;
    if (closed.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const stop = new AbortController();
      const onClose = () => {
        stop.abort();
        resolve(false);
      };
      closed.addEventListener("abort", onClose, { once: true });
      void this.#wait(ms, stop.signal).then(() => {
        closed.removeEventListener("abort", onClose);
        resolve(true);
      });
    });
  }

  #failed(stage: string, error: unknown): void {
    this.#log("run.failed", {
      stage,
      type: error instanceof Error ? error.name : typeof error,
    });
  }
}
