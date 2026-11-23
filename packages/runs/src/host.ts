// The run host: one background run from its `starting` record to its settled end. It starts the
// agent's program in a container (container/) and owns its pipes; a driver (drivers/) speaks the
// agent's protocol over them. A run has two results, and the record keeps both:
//
// - The work's, from the driver: done with its answer, needs the person, failed, stopped. It is
//   saved to the run's folder first, before anything of the run is closed or ended.
// - The cleanup's, from the container: nothing was left, what was left had to be ended, or (with
//   no process group) TTasks ended what it could find. It never changes the work's.
//
// What the person can count on, and how this keeps it:
// - The run is settled when its work is, not when its first turn ends or its process exits: the
//   driver says when. Then the protocol is closed, the agent gets time to end by itself, and only
//   what is still there is ended.
// - Stop works at every moment, start-up and a close included, and waits for nothing: it is
//   committed first (`cancelling`), the agent is asked to stop over its protocol (or interrupted
//   when it has none), and after the grace time the container is killed. A Stop before the
//   agent's process was there means its driver never opens: nothing of the work reaches it. A
//   container that is not confirmed empty in time, or without a process group an agent still
//   alive, leaves the run `unknown`, with End by force.
// - The answer is kept whole up to 1 MiB, also after megabytes of other output, and each answer
//   is saved to the run's folder as it comes, so a crash of the service keeps the last one.
// - When the service ends, its runs' processes end with it (the container's own guarantee). A
//   service that closes saves each agent's work first: its own end when it had settled, else what
//   it said so far, the words of an answer still being written included. The next start settles
//   each open run from its saved work: its own result, and the time limit that ended it, when the
//   work had settled, else `service_ended` with the last saved answer.
// - A late PID, exit or event never revives a stopped run: the record's rules (machine.ts) refuse
//   it, and a container that starts after its run gave up on it is killed.
//
// Every limit runs on the monotonic clock: the start time, the run's wall and idle times, the
// stop's grace, the close, the confirmation and the drain of the output.
import type {
  RunCleanup,
  RunEvent,
  RunEvidence,
  RunRecord,
  RunResult,
} from "@ttasks/contracts/runs";
import { SIGNAL_NAME, TEXT_CAP_BYTES } from "@ttasks/contracts/runs";
import type {
  AgentExit,
  Confirmation,
  Contained,
  ContainerSpec,
  Containers,
} from "./container/index.ts";
import { printDriver } from "./drivers/print.ts";
import type { DriverSession, OpenDriver, Work } from "./drivers/types.ts";
import { RunMachine, type RunEnd } from "./machine.ts";
import type { RunFolders, SavedAnswer, TimeLimit } from "./run-files.ts";
import { STREAM_KINDS, type StreamKind } from "./streams/index.ts";
import { capText } from "./streams/values.ts";

/** The host's time limits, in milliseconds. A run's wall and idle times come from its record. */
export interface RunTimes {
  /** From the start of the container to the agent's PID. */
  startMs: number;
  /** From the interrupt to the kill. */
  stopGraceMs: number;
  /** From the end of the protocol to the agent's own exit, before it is ended. */
  closeMs: number;
  /** After the agent's exit, for what it started to end by itself before it counts as left. */
  settleMs: number;
  /** From the kill to the confirmation that the container is empty. */
  confirmMs: number;
  /** For the output pipes to end once the agent or its container ended. */
  drainMs: number;
  /** Between attempts to record a run's end that the store did not take. */
  retryMs: number;
}

export const RUN_TIMES: Readonly<RunTimes> = {
  startMs: 60_000,
  stopGraceMs: 10_000,
  closeMs: 10_000,
  settleMs: 2_000,
  confirmMs: 10_000,
  drainMs: 5_000,
  retryMs: 30_000,
};

/**
 * What runs in a run's container: the agent's program, arguments, folder and environment, and
 * its driver. Without one, a print-mode agent's stream parser is the driver.
 */
export interface AgentCommand extends Omit<ContainerSpec, "name"> {
  readonly open?: OpenDriver;
  /** What the run records once its agent started, besides its PID. */
  readonly evidence?: RunEvidence;
}

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
  /** Whether a Stop was accepted for it by now: one can come during any wait of its flow. */
  readonly stopping: () => boolean;
  readonly stopped: Promise<"stop">;
  readonly stop: () => void;
  /** The container's start has not answered yet: a container may still appear. */
  startPending: boolean;
  /** The end it settles with once its container is confirmed empty, while it is `unknown`. */
  pending: RunEnd | undefined;
  /** Its end is being recorded: from here on the run no longer runs. */
  settling: boolean;
  /** While its agent runs: when it last wrote output, or started, in wall clock milliseconds. */
  quietSince: number | undefined;
  /** While its agent runs: the driver of its protocol. */
  session: DriverSession | undefined;
  /** The time limit that ended its work, once one did: saved with the work's result. */
  limit: TimeLimit | undefined;
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

/**
 * Whether a run may settle on this confirmation: empty, or no process group holds it and its agent
 * is gone, so nothing can count what is left.
 */
const settles = (confirmed: Confirmation): boolean =>
  confirmed.state === "empty" || confirmed.state === "unconfirmable";

/** How the run's processes ended, once they had to be ended: undefined while that is not known. */
const endedBy = (confirmed: Confirmation): RunCleanup | undefined =>
  confirmed.state === "empty"
    ? "ended_leftovers"
    : confirmed.state === "unconfirmable"
      ? "ended_found"
      : undefined;

/** `end` with how the run's processes ended, when it keeps a result. */
function withCleanup(end: RunEnd, cleanup: RunCleanup): RunEnd {
  switch (end.kind) {
    case "exited":
    case "timed_out":
      return { ...end, result: { ...end.result, cleanup } };
    case "service_ended":
      return end.result === null ? end : { ...end, result: { ...end.result, cleanup } };
    default:
      return end;
  }
}

/** What the run's folder keeps of settled work: its answer, its result, the limit that ended it. */
const settledAnswer = (work: Work, limit: TimeLimit | undefined): SavedAnswer => ({
  text: work.text,
  final: work.textFinal,
  cut: work.textCut,
  outcome: work.outcome,
  error: work.error,
  ...(limit === undefined ? {} : { limit }),
});

/** The work, when the session settled already. */
async function settledNow(session: DriverSession): Promise<Work | undefined> {
  const pending = Symbol("pending");
  const first = await Promise.race([session.settled, Promise.resolve(pending)]);
  return first === pending ? undefined : first;
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

/** The result a record keeps: the work's, how the agent's process ended, and the cleanup's. */
export function resultOf(
  work: Work,
  exit: AgentExit | undefined,
  durationMs: number | null,
  cleanup: RunCleanup | undefined,
): RunResult {
  const signal = exit?.signal ?? null;
  return {
    ok: work.ok,
    outcome: work.outcome,
    exitCode: exit?.code ?? null,
    signal: signal !== null && SIGNAL_NAME.test(signal) ? signal : null,
    nativeId: work.nativeId,
    text: work.text,
    ...(work.textCut ? { textCut: true } : {}),
    ...(work.textFinal ? { textFinal: true } : {}),
    error: work.error,
    usage: work.usage,
    appTools: work.appTools,
    declined: work.declined,
    permissionDenials: work.permissionDenials,
    durationMs: durationMs === null ? null : Math.max(0, Math.round(durationMs)),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
}

/**
 * The result recovery records from a run's saved work: its own verdict when the work had settled,
 * else `no_result` with the last answer, since the run did not end by itself.
 */
export function savedResult(
  run: RunRecord,
  saved: SavedAnswer | undefined,
  cleanup?: RunCleanup,
): RunResult | null {
  if (saved === undefined) return null;
  const outcome = saved.outcome ?? "no_result";
  return {
    ok: outcome === "success",
    outcome,
    exitCode: null,
    signal: null,
    nativeId: run.evidence.native_id ?? null,
    text: saved.text,
    ...(saved.cut ? { textCut: true } : {}),
    ...(saved.final ? { textFinal: true } : {}),
    error: saved.error ?? null,
    usage: null,
    appTools: null,
    declined: 0,
    permissionDenials: 0,
    durationMs: null,
    ...(cleanup === undefined ? {} : { cleanup }),
  };
}

/** A driver that could not start its protocol: the work fails with no output. */
const unopened: DriverSession = {
  settled: Promise.resolve({
    ok: false,
    outcome: "no_output",
    nativeId: null,
    text: null,
    textCut: false,
    textFinal: false,
    error: null,
    usage: null,
    appTools: null,
    declined: 0,
    permissionDenials: 0,
  }),
  interrupt: () => false,
  close: () => undefined,
  ended: () => undefined,
};

/** The driver of a run whose command names none: its adapter's print-mode stream parser. */
function defaultDriver(run: RunRecord): OpenDriver | undefined {
  const kind = run.adapter as string;
  return (STREAM_KINDS as readonly string[]).includes(kind)
    ? printDriver(kind as StreamKind)
    : undefined;
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
    await this.hosting(id);
    return this.#machine.read(id);
  }

  /** Resolves as soon as this host's work on the run is over: its end recorded, or the host closed. */
  async hosting(id: string): Promise<void> {
    await this.#flows.get(id)?.done;
  }

  /**
   * Whether the run runs here now: started by this host, and its end not yet being recorded. It
   * is false before anyone can read the run's end from the store.
   */
  running(id: string): boolean {
    const flow = this.#flows.get(id);
    return flow !== undefined && !flow.settling && !this.#isClosed();
  }

  /**
   * Since when the run's agent has written nothing, in wall clock milliseconds, while it runs here:
   * a quiet run is shown as one, so the person can judge whether to stop it.
   */
  quietSince(id: string): number | undefined {
    return this.running(id) ? this.#flows.get(id)?.quietSince : undefined;
  }

  /**
   * The person's Stop: committed first, then the run is stopped. A queued run is cancelled at
   * once. A run no flow of this service holds is settled from its container's name, as at start.
   */
  async stop(id: string): Promise<RunRecord | undefined> {
    // The flow hears the Stop before the store is asked: a start that goes on while the store
    // answers must not open the agent's input. When the store does not take it, the agent is
    // stopped all the same, and the record then says how it ended rather than cancelled. A start
    // asked while the store answered goes on once the store refuses: it is stopped as well.
    const flow = this.#flows.get(id);
    if (flow !== undefined && !flow.settling) flow.stop();
    let cancelled: { run: RunRecord | undefined; stopping: boolean };
    try {
      cancelled = await this.#machine.cancel(id);
    } catch (error) {
      const late = this.#flows.get(id);
      if (late !== undefined && !late.settling) late.stop();
      throw error;
    }
    const { run, stopping } = cancelled;
    if (!stopping || run === undefined || flow !== undefined) return run;
    return this.#reconcile(run);
  }

  /**
   * End by force, for an `unknown` run: ends whatever is left in its container by its name and
   * settles the run once the container is confirmed empty, or with no process group once its agent
   * is gone, and records how its processes ended. A run whose container may still be starting
   * cannot be confirmed yet and stays `unknown`.
   */
  async forceEnd(id: string): Promise<RunRecord | undefined> {
    const run = await this.#machine.read(id);
    if (run?.state !== "unknown") return run;
    const flow = this.#flows.get(id);
    if (flow?.startPending === true) return run;
    const cleanup = endedBy(await this.#recoverContainer(id));
    if (cleanup === undefined) return run;
    const end =
      flow?.pending === undefined
        ? this.#serviceEnded(run, cleanup)
        : withCleanup(flow.pending, cleanup);
    const after = await this.#settle(id, end);
    if (flow !== undefined && after?.state !== "unknown") this.#flows.delete(id);
    return after;
  }

  /**
   * A `starting` run no flow of this host holds while the service runs: its `starting` commit
   * reached the store after the host had given up waiting for it, so nothing started it. Once its
   * container is confirmed empty by its name it fails `start_timed_out`; any other run is returned
   * as it is.
   */
  async settleUnstarted(id: string): Promise<RunRecord | undefined> {
    if (this.#isClosed() || this.#flows.has(id)) return this.#machine.read(id);
    const run = await this.#machine.read(id);
    if (run?.state !== "starting" || this.#flows.has(id)) return run;
    const end: RunEnd = { kind: "start_failed", reason: "start_timed_out" };
    const confirmed = await this.#recoverContainer(containerName(id));
    if (settles(confirmed)) return this.#settle(id, end);
    const flow = this.#flows.get(id) ?? this.#flow(id);
    flow.pending = end;
    return this.#settle(id, { kind: "not_confirmed" });
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
   * service's own end ends them too; the next start's recovery settles the runs, with what each
   * agent had said: the part of an answer it was still writing is saved first.
   */
  async close(): Promise<void> {
    this.#closed.abort();
    const flows = [...this.#flows.values()];
    await Promise.all(flows.map((flow) => this.#keepSaid(flow)));
    for (const flow of flows) flow.abort.abort();
    await Promise.all(
      flows.map((flow) => this.#containers.kill(containerName(flow.id)).catch(() => undefined)),
    );
  }

  /**
   * Saves what a working agent said: the work's own end when it settled, else what it said so far,
   * since its output ends here and its driver settles with that. A run whose end is being recorded
   * saved it already.
   */
  async #keepSaid(flow: Flow): Promise<void> {
    const session = flow.session;
    if (session === undefined || flow.settling) return;
    const own = await settledNow(session);
    if (own === undefined) session.ended({ code: null, signal: null });
    const work = own ?? (await settledNow(session));
    if (work === undefined || (own === undefined && work.text === null)) return;
    try {
      this.#files.saveAnswer(
        flow.id,
        own === undefined
          ? { text: work.text, final: work.textFinal, cut: work.textCut }
          : settledAnswer(own, flow.limit),
      );
    } catch (error) {
      this.#failed("answer", error);
    }
  }

  #flow(id: string): Flow {
    let stop!: () => void;
    const stopped = new Promise<"stop">((resolve) => {
      stop = () => {
        resolve("stop");
      };
    });
    const abort = new AbortController();
    let stopping = false;
    const flow: Flow = {
      id,
      stopping: () => stopping,
      stopped,
      stop: () => {
        stopping = true;
        stop();
      },
      startPending: false,
      pending: undefined,
      settling: false,
      quietSince: undefined,
      session: undefined,
      limit: undefined,
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
    // The command is asked within the start time, and a Stop ends the wait: no container exists
    // yet, so nothing is left to stop.
    let prepared: AgentCommand | "stop" | undefined;
    try {
      this.#files.prepare(run.id);
      const asked = Promise.resolve().then(() => command(run));
      prepared = await this.#within(flow, Promise.race([asked, flow.stopped]), this.#times.startMs);
    } catch (error) {
      this.#failed("prepare", error);
      return this.#settle(flow.id, { kind: "start_failed", reason: "spawn_failed" });
    }
    if (prepared === undefined) {
      return this.#settle(flow.id, { kind: "start_failed", reason: "start_timed_out" });
    }
    if (prepared === "stop" || flow.stopping()) {
      return this.#settle(flow.id, { kind: "start_failed", reason: "spawn_failed" });
    }
    const open = prepared.open ?? defaultDriver(run);
    if (open === undefined) {
      return this.#settle(flow.id, { kind: "start_failed", reason: "spawn_failed" });
    }
    const spec: ContainerSpec = {
      name,
      command: prepared.command,
      args: prepared.args,
      cwd: prepared.cwd,
      env: prepared.env,
    };

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
    return this.#running(flow, run, started.contained, open, prepared.evidence);
  }

  /**
   * A Stop came while the agent's process started: its driver is never opened, so nothing of the
   * work reaches its input. Its PID is recorded, and what it is is ended.
   */
  async #stoppedAtStart(flow: Flow, contained: Contained): Promise<RunRecord | undefined> {
    contained.stdin.on("error", () => undefined);
    contained.stdin.end();
    contained.stdout.resume();
    contained.stderr.resume();
    await this.#machine.started(flow.id, contained.pid, this.#now()).catch((error: unknown) => {
      this.#failed("started", error);
    });
    const end: RunEnd = { kind: "start_failed", reason: "spawn_failed" };
    return this.#confirmed(flow, end, await this.#endContainer(contained.name));
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
          if (settles(confirmed) && flow.pending !== undefined) {
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

  /**
   * The agent runs: its driver speaks its protocol, and the first of its settled work, its own
   * end, a Stop and a limit ends it. The work's result is saved, then the protocol is closed and
   * the container cleaned up: the cleanup's result is added, and never changes the work's.
   */
  async #running(
    flow: Flow,
    run: RunRecord,
    contained: Contained,
    open: OpenDriver,
    evidence: RunEvidence = {},
  ): Promise<RunRecord | undefined> {
    if (flow.stopping()) return this.#stoppedAtStart(flow, contained);
    const name = contained.name;
    const startedAt = this.#elapsed();
    const agent: { exit: AgentExit | undefined; at: number | undefined } = {
      exit: undefined,
      at: undefined,
    };
    const exited = contained.exited.then((exit) => {
      agent.exit = exit;
      agent.at = this.#elapsed();
      return exit;
    });
    this.#log("run.started", { adapter: run.adapter });

    // Read before anything is awaited: a pipe nobody reads when the agent exits is emptied and its
    // output thrown away, so an agent that answers and exits quickly would lose its answer.
    const logs = this.#files.logs(flow.id);
    let lastOutput = startedAt;
    flow.quietSince = this.#now();
    contained.stdout.on("data", (chunk: Buffer) => {
      lastOutput = this.#elapsed();
      flow.quietSince = this.#now();
      logs.stdout(chunk);
    });
    // The end of what it wrote on stderr: the only explanation of a start that said nothing else.
    let stderrTail = Buffer.alloc(0);
    contained.stderr.on("data", (chunk: Buffer) => {
      logs.stderr(chunk);
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-TEXT_CAP_BYTES);
    });
    const drained = Promise.all([endOf(contained.stdout), endOf(contained.stderr)]);
    let session: DriverSession;
    try {
      session = open({ stdin: contained.stdin, stdout: contained.stdout }, (event) => {
        this.#event(flow, event);
      });
    } catch (error) {
      this.#failed("open", error);
      contained.stdin.end();
      session = unopened;
    }
    flow.session = session;
    // The agent's own end: its exit, then the rest of its output for as long as the drain allows,
    // since a process it left behind may hold the pipe.
    const agentEnded = exited.then(async (exit) => {
      await this.#within(flow, drained, this.#times.drainMs);
      return exit;
    });

    await this.#machine
      .started(flow.id, contained.pid, this.#now(), evidence)
      .catch((error: unknown) => {
        this.#failed("started", error);
      });

    const limits = new AbortController();
    flow.abort.signal.addEventListener("abort", () => {
      limits.abort();
    });
    const why = await Promise.race([
      session.settled.then(() => "settled" as const),
      agentEnded.then(() => "exited" as const),
      flow.stopped,
      this.#limits(run, startedAt, () => lastOutput, limits.signal),
    ]);
    limits.abort();
    if (why === "wall" || why === "idle") flow.limit = why;

    if (why === "stop" || flow.limit !== undefined) {
      // The agent is asked to stop, and may still say how its work ended.
      if (!session.interrupt()) await this.#containers.interrupt(name).catch(() => false);
      await this.#within(
        flow,
        Promise.race([session.settled, agentEnded]),
        this.#times.stopGraceMs,
      );
    }
    let work = await settledNow(session);
    if (work === undefined && agent.exit !== undefined) {
      session.ended(agent.exit);
      work = await settledNow(session);
    }
    if (work === undefined) {
      // The agent did not end its work in time: it is ended, and what it said is its work.
      await this.#containers.kill(name).catch(() => undefined);
      await this.#within(flow, agentEnded, this.#times.confirmMs);
      session.ended(agent.exit ?? { code: null, signal: null });
      work = (await settledNow(session)) ?? (await unopened.settled);
    }
    if (work.outcome === "no_output" && work.error === null) {
      const said = stderrTail.toString("utf8").replace(/^�+/u, "").trim();
      if (said !== "") work = { ...work, error: capText(said).text };
    }
    if (this.#isClosed()) {
      // The service ends, and the run with it: its work did not settle by itself, and the next
      // start records why from what was saved.
      logs.close();
      return undefined;
    }
    // The work's result first: a crash of the service from here on still records it.
    try {
      this.#files.saveAnswer(flow.id, settledAnswer(work, flow.limit));
    } catch (error) {
      this.#failed("answer", error);
    }

    // The protocol ends, and the agent gets time to end by itself; a Stop waits for nothing.
    session.close();
    if (agent.exit === undefined) {
      await this.#within(flow, Promise.race([agentEnded, flow.stopped]), this.#times.closeMs);
    }
    const ended = why === "settled" || why === "exited";
    const { confirmed, cleanup } = await this.#cleanUp(
      name,
      ended && agent.exit !== undefined && !flow.stopping() ? this.#times.settleMs : 0,
    );
    if (settles(confirmed)) {
      // Nothing holds the pipes any more: the rest of the output arrives.
      await this.#within(flow, drained, this.#times.drainMs);
    }
    logs.close();
    const result = resultOf(
      work,
      agent.exit,
      agent.at === undefined ? null : agent.at - startedAt,
      cleanup,
    );
    const end: RunEnd =
      flow.limit === undefined
        ? { kind: "exited", result }
        : { kind: "timed_out", limit: flow.limit, result };
    return this.#confirmed(flow, end, confirmed);
  }

  /**
   * The cleanup's result: whether anything was left after `waitMs` for it to end by itself, and
   * once what was left was ended, whether the container is confirmed empty, or, with no process
   * group, whether the agent is gone.
   */
  async #cleanUp(
    name: string,
    waitMs: number,
  ): Promise<{ confirmed: Confirmation; cleanup: RunCleanup | undefined }> {
    let first: Confirmation;
    try {
      first = await this.#containers.confirmEmpty(name, { waitMs });
    } catch (error) {
      first = { state: "unknown", detail: error instanceof Error ? error.name : "error" };
    }
    if (first.state === "empty") return { confirmed: first, cleanup: "confirmed" };
    const confirmed = await this.#endContainer(name);
    return { confirmed, cleanup: endedBy(confirmed) };
  }

  /**
   * Resolves with the run's limit that passed first: its wall time, or its time without output.
   * A run without either never resolves here.
   */
  async #limits(
    run: RunRecord,
    startedAt: number,
    lastOutput: () => number,
    signal: AbortSignal,
  ): Promise<"wall" | "idle"> {
    const { wallMs, idleMs } = run.limits;
    if (wallMs === undefined && idleMs === undefined) return new Promise<never>(() => undefined);
    for (;;) {
      const now = this.#elapsed();
      const wall = wallMs === undefined ? Infinity : startedAt + wallMs - now;
      const idle = idleMs === undefined ? Infinity : lastOutput() + idleMs - now;
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

  /**
   * Settles with `end` when the container is empty, or when no process group holds the run and
   * nothing can be confirmed; else `unknown`, keeping `end` for later.
   */
  async #confirmed(
    flow: Flow,
    end: RunEnd,
    confirmed: Confirmation,
  ): Promise<RunRecord | undefined> {
    if (settles(confirmed)) return this.#settle(flow.id, end);
    flow.pending = end;
    return this.#settle(flow.id, { kind: "not_confirmed" });
  }

  /**
   * The end a run gets once the service that hosted it is gone: its saved work, and the time limit
   * that ended it, when the work had settled, else `service_ended` with its last saved answer.
   */
  #serviceEnded(run: RunRecord, cleanup?: RunCleanup): RunEnd {
    let saved: SavedAnswer | undefined;
    try {
      this.#files.removeTemps(run.id);
      saved = this.#files.readAnswer(run.id);
    } catch {
      saved = undefined;
    }
    const result = savedResult(run, saved, cleanup);
    if (saved?.outcome === undefined || result === null) return { kind: "service_ended", result };
    return saved.limit === undefined
      ? { kind: "exited", result }
      : { kind: "timed_out", limit: saved.limit, result };
  }

  /**
   * Recovery's rule for one run no flow holds: confirm its container by name, ending what is
   * left, then settle.
   */
  async #reconcile(run: RunRecord): Promise<RunRecord | undefined> {
    const name = containerName(run.id);
    let left: Confirmation;
    try {
      left = await this.#containers.confirmEmpty(name);
    } catch (error) {
      left = { state: "unknown", detail: error instanceof Error ? error.name : "error" };
    }
    const confirmed = left.state === "empty" ? left : await this.#recoverContainer(name);
    const end = this.#serviceEnded(run, left.state === "empty" ? "confirmed" : endedBy(confirmed));
    if (settles(confirmed)) return this.#settle(run.id, end);
    const flow = this.#flows.get(run.id) ?? this.#flow(run.id);
    flow.pending = end;
    return this.#settle(run.id, { kind: "not_confirmed" });
  }

  /**
   * Records an end. A store that does not take it now, a full disk for one, is asked again every
   * `retryMs` for as long as the host is open: the run's end is known, and only this flow holds it.
   */
  async #settle(id: string, end: RunEnd): Promise<RunRecord | undefined> {
    // Before the end can be read from the store, the run no longer runs here.
    const flow = this.#flows.get(id);
    if (flow !== undefined) flow.settling = true;
    // A closed host's runs end with its service: the next start records why.
    if (this.#isClosed()) return undefined;
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
        if (!(await this.#pause(this.#times.retryMs))) return undefined;
      }
    }
  }

  #isClosed(): boolean {
    return this.#closed.signal.aborted;
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
