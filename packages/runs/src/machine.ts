// A4's run state machine (3.11.2) as code over the execution store's run part, with every external
// step injected. It follows the launch machine's rules (A4 3.9.1, packages/launch: machine.ts):
//
// 1. Persistence before each external step. `starting` is committed before the spawn, the run
//    shim's claim before the claim's reply, which is what lets the shim start the agent, and
//    `cancelling` before the stop. A step whose record did not commit never runs, so a crash between
//    "I decided" and "I know it happened" leaves a durable record of the decision, never a second
//    agent.
// 2. No automatic rerun (A4 3.11.2). Only `queued` moves to `starting`, by compare-and-set, so a
//    repeated start, a racing recovery or a restart never spawns a run again, and nothing leads from
//    `unknown` back to a state a process may hold.
// 3. Restart recovery (A4 3.11.9). After a restart the machine reads its own open runs and settles
//    each one by what it can observe: a live shim re-attaches (M6.03), a shim gone with `exit.json`
//    finalizes from it, a shim gone without one is `unknown`, never respawned. A lost shim is
//    recorded as `reconciling` first, so a crash while its files are read leaves a record that says
//    so. What the shim left comes before any time limit, and an `unknown` run whose stop timed out
//    stays on the list until its exit settles it or its shim is found gone, because an exit the
//    service did not hear while it was down is still a definite exit. The sweep applies the same
//    rule while the service runs, so what did not finish at start is tried again.
// 4. What a shim reports never keeps a run open. A result the store refuses is left out and the
//    transition commits without it; an outcome that names no reason of A4's is `no_result`.
//
// One call at a time per run: every call on a run (a start, a claim and its reply, a report, a
// cancel, the sweep's or recovery's work on it) runs in that run's section, reads the record there,
// decides, commits by compare-and-set on what it read, and runs at most one external step after its
// commit. Every store call and external step has a deadline; a store call still unanswered has an
// open outcome, which the next call settles as after a crash. One service per machine owns its runs
// (A2's service lock), so no other service runs a section on them.
//
// What later steps call: the supervisor (M6.02) `queue`s a run and `start`s it when its caps allow,
// with a spawn step that starts the run shim; the run shim's host (M6.03) passes the shim's first
// `run.attach` to `claim` and its reports and journal events to `report`; cancellation (M6.04)
// passes the person's Stop to `cancel` with its stop step. The service runs `sweep` periodically
// and `recover` once at start, with the observation of M6.03's records.
import {
  awaitsExit,
  FINAL_RUN_STATES,
  isRunReason,
  type NewRun,
  type RunEvidence,
  type RunPatch,
  type RunReason,
  type RunRecord,
  type RunResult,
  type RunState,
} from "@tasks/contracts/runs";
import { RunRefused, seenRun, type RunStore } from "@tasks/launch/execution-store";

/**
 * A run in `starting` whose shim has not claimed it within this window is `failed` (`not_claimed`):
 * no agent starts without a claim (A4 3.11.2, as a terminal launch's claim window, A4 3.9.2).
 */
export const RUN_CLAIM_WINDOW_MS = 120_000;

/**
 * A run in `cancelling` whose process has not ended within this time is `unknown`
 * (`stop_timed_out`, A4 3.11.2). It covers A4 3.11.8's sequence: the interrupt, the kill after 10 s,
 * the descendants' 2 s and the shim's `exit.json`, with room for a loaded machine.
 */
export const RUN_STOP_TIMEOUT_MS = 60_000;

/** How long the machine waits for one call to the store, as the launch machine does. */
export const RUN_STORE_DEADLINE_MS = 15_000;

/** How long the machine waits for one external step: a spawn, a claim's reply, a stop, a look. */
export const RUN_STEP_DEADLINE_MS = 30_000;

/** How the agent ended, from the shim's `exit.json` or its `run.exited` (A4 3.11.5). */
export interface RunExit {
  /** The final outcome as the record keeps it. */
  result: RunResult;
  /** The shim ended the run at its wall or idle limit (A4 3.11.7). */
  timeout?: "wall" | "idle";
}

/** What the spawn step reports: the run shim started, could not start, or the call cannot tell. */
export type SpawnOutcome =
  | { kind: "spawned" }
  | { kind: "refused" }
  /** No answer, a timeout, or an error that does not tell: the claim window decides. */
  | { kind: "unknown" };

/** A live report about a run, from its shim (M6.03) or the supervisor. */
export type RunReport =
  /** The shim started the agent: its PID and start time, and whether the folder check passed. */
  | { kind: "started"; pid: number; pidStartedAt: number; folderChecked?: boolean }
  /** Evidence to record without a change of state: the native ID, from the journal. */
  | { kind: "evidence"; evidence: RunEvidence }
  /** The shim's check of the folder or the executable failed: no agent started. */
  | { kind: "verify_failed" }
  /** The shim could not start the agent. */
  | { kind: "spawn_failed" }
  /** The agent ended, and the shim drained its output. */
  | { kind: "exited"; exit: RunExit };

/** What recovery can see of a run after a restart (A4 3.11.9 steps 2, 4 and 5). */
export type RunObservation =
  /** The shim is alive and re-attaches, or the OS could not tell: wait. */
  | { kind: "pending" }
  /** The shim is gone and left `exit.json`. */
  | { kind: "exited"; exit: RunExit }
  /** The shim is gone without `exit.json`. */
  | { kind: "lost" };

export interface RunRecovery {
  /** Looks at a run's shim and files, at start and at every sweep, also of a live run. Read-only. */
  observe(run: RunRecord): Promise<RunObservation>;
}

export interface RunDeadlines {
  store: number;
  step: number;
}

export interface RunMachineOptions {
  store: RunStore;
  /** This machine (`m_` ID): it recovers only its own runs (A4 3.16.1). */
  machine: string;
  recovery: RunRecovery;
  /** Milliseconds since 1970: the wall clock. Default: Date.now. */
  now?: () => number;
  /** A monotonic clock in milliseconds. Default: performance.now. */
  elapsed?: () => number;
  /** Resolves once `ms` passed on the monotonic clock, or never when `signal` aborts first. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  deadlines?: Partial<RunDeadlines>;
}

/** A call to the store gave no answer within its deadline: its outcome is open (A1 3.8). */
export class RunDeadlinePassed extends Error {
  override readonly name = "RunDeadlinePassed";
  constructor() {
    super("The execution store did not answer in time: the outcome is open");
  }
}

const FINAL: ReadonlySet<RunState> = new Set(FINAL_RUN_STATES);

/** The states a shim may hold a process in. */
const HELD: ReadonlySet<RunState> = new Set([
  "starting",
  "running",
  "waiting_for_input",
  "cancelling",
]);

/** A transition the machine wants. */
interface Move {
  next: RunState;
  patch?: RunPatch;
}

interface Tried {
  kind: "moved" | "stale" | "refused";
  run: RunRecord | undefined;
  error?: RunRefused;
}

type Answer<T> = { kind: "answered"; value: T } | { kind: "silent" };

/** Reads again after losing a compare-and-set to a write that landed late. The graph is finite. */
const RETRIES = 8;

function timer(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (typeof handle === "object") handle.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(handle);
    });
  });
}

/** Whether two instants lie at least `limit` apart, either way: the safe side for a window. */
const apart = (now: number, since: number, limit: number): boolean =>
  Math.abs(now - since) >= limit;

/**
 * The final state an exit gives (A4 3.11.2): `cancelled` once a stop was asked for, on process exit
 * only; `timed_out` at the shim's limit; `succeeded` when the outcome says success; else `failed`
 * with the outcome's reason, or `no_result` for an outcome that names none of A4's reasons, so a
 * damaged report still settles the run.
 */
export function finalFor(run: RunRecord, exit: RunExit): Move {
  const result = exit.result;
  if (run.at.cancelling !== undefined) return { next: "cancelled", patch: { result } };
  if (exit.timeout !== undefined && isRunReason("timed_out", exit.timeout)) {
    return { next: "timed_out", patch: { reason: exit.timeout, result } };
  }
  if (result.ok) return { next: "succeeded", patch: { result } };
  const outcome = result.outcome === "success" ? "exit_status" : result.outcome;
  const reason: RunReason = isRunReason("failed", outcome) ? outcome : "no_result";
  return { next: "failed", patch: { reason, result } };
}

export class RunMachine {
  readonly #store: RunStore;
  readonly #machine: string;
  readonly #recovery: RunRecovery;
  readonly #now: () => number;
  readonly #elapsed: () => number;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #deadlines: RunDeadlines;
  readonly #sections = new Map<string, Promise<void>>();
  /** When this service committed a run's `starting` and its `cancelling`, on the monotonic clock. */
  readonly #marks = new Map<string, { starting?: number; cancelling?: number }>();

  constructor(options: RunMachineOptions) {
    this.#store = options.store;
    this.#machine = options.machine;
    this.#recovery = options.recovery;
    this.#now = options.now ?? Date.now;
    this.#elapsed = options.elapsed ?? (() => globalThis.performance.now());
    this.#wait = options.wait ?? timer;
    this.#deadlines = {
      store: options.deadlines?.store ?? RUN_STORE_DEADLINE_MS,
      step: options.deadlines?.step ?? RUN_STEP_DEADLINE_MS,
    };
  }

  /** The runs a call of this service is working on or waiting for, in no order. */
  owned(): string[] {
    return [...this.#sections.keys()];
  }

  /** Records a run in `queued` before anything spawns (A4 3.11.2). A request ID replays it. */
  queue(input: Omit<NewRun, "machine">, requestId: string): Promise<RunRecord> {
    return this.#call(() => this.#store.createRun({ ...input, machine: this.#machine }, requestId));
  }

  /**
   * Starts a queued run: commits `starting`, then runs the spawn step once. A run that is not
   * queued is returned as it is, without a spawn. A refused spawn is `failed` (`spawn_failed`); a
   * spawn without an answer stays `starting`, and the claim window decides, because no agent
   * starts without a claim.
   */
  start(
    id: string,
    spawn: (run: RunRecord) => Promise<SpawnOutcome>,
  ): Promise<RunRecord | undefined> {
    return this.#section(id, async () => {
      const queued = await this.#read(id);
      if (queued?.state !== "queued") return queued;
      // The crash boundary (A4 3.11.2): nothing has spawned yet.
      const committed = await this.#try(queued, { next: "starting" });
      if (committed.kind !== "moved" || committed.run?.state !== "starting") return committed.run;
      const starting = committed.run;
      this.#mark(id, { starting: this.#elapsed() });
      const answer = await this.#external(() => spawn(starting));
      if (answer.kind !== "answered" || answer.value.kind !== "refused") return starting;
      return this.#decide(id, (run) =>
        run.state === "starting" && run.evidence.claim === undefined
          ? { next: "failed", patch: { reason: "spawn_failed" } }
          : undefined,
      );
    });
  }

  /**
   * The run shim's claim (its first `run.attach`). The claim is committed first, then `reply` lets
   * the shim start the agent: an agent never starts without a durable claim, and a second claim, a
   * late one, or one on a run that is not `starting` is refused and gets no reply.
   */
  claim(
    id: string,
    claim: string,
    reply: (run: RunRecord) => Promise<void>,
  ): Promise<RunRecord | undefined> {
    return this.#section(id, async () => {
      for (let attempt = 0; attempt < RETRIES; attempt += 1) {
        const run = await this.#read(id);
        if (run?.state !== "starting" || run.evidence.claim !== undefined) return undefined;
        if (this.#windowPassed(run)) return undefined;
        const tried = await this.#try(run, {
          next: "starting",
          patch: { evidence: { claim, claimed_at: this.#now() } },
        });
        if (tried.kind === "stale") continue;
        const claimed = tried.run;
        if (tried.kind !== "moved" || claimed?.evidence.claim !== claim) return undefined;
        await this.#external(() => reply(claimed));
        return claimed;
      }
      return undefined;
    });
  }

  /**
   * A live report about a run: applies it in its turn to the run as it is then. A store that
   * cannot take the write now (`unavailable`) throws, so the reporter keeps its report and sends
   * it again; a definite refusal returns the record as it is.
   */
  report(id: string, report: RunReport): Promise<RunRecord | undefined> {
    return this.#section(id, () => this.#decide(id, (run) => this.#reported(run, report), true));
  }

  /**
   * The person's Stop (A4 3.11.8). A queued run, or a starting one whose shim has not claimed it,
   * is `cancelled` at once: a claim after that is refused, so no agent starts. A run a process may
   * hold is `cancelling`, committed before the stop step runs once; it is `cancelled` when the
   * process exits. Any other run is returned as it is.
   */
  cancel(id: string, stop: (run: RunRecord) => Promise<void>): Promise<RunRecord | undefined> {
    return this.#section(id, async () => {
      // Whether this call's commit entered `cancelling`: only then does the stop's time start on
      // this service's monotonic clock. Another Stop keeps the first one's time.
      const decision = { entered: false };
      const after = await this.#decide(id, (run) => {
        decision.entered = false;
        if (run.state === "queued") return { next: "cancelled" };
        if (run.state === "starting" && run.evidence.claim === undefined) {
          return { next: "cancelled" };
        }
        if (
          run.state === "starting" ||
          run.state === "running" ||
          run.state === "waiting_for_input"
        ) {
          decision.entered = true;
          return { next: "cancelling" };
        }
        return undefined;
      });
      if (after?.state !== "cancelling") return after;
      if (decision.entered && this.#marks.get(id)?.cancelling === undefined) {
        this.#mark(id, { cancelling: this.#elapsed() });
      }
      await this.#external(() => stop(after));
      return after;
    });
  }

  /**
   * The live service's periodic check, recovery's rule again (#recoverOne): every open run is
   * settled by what its shim left, then by its time limits (a starting run unclaimed past its
   * window is `failed`, `not_claimed`; a cancelling run whose process has not ended in time is
   * `unknown`, `stop_timed_out`). So an observation or a write that did not finish at start is
   * tried again, and a shim lost while the service runs is settled without a restart. Returns the
   * runs it moved.
   */
  async sweep(): Promise<RunRecord[]> {
    const settled = await this.#settleAll();
    return settled.filter((s) => s.moved).map((s) => s.run);
  }

  /**
   * Restart recovery (A4 3.11.9): every open run of this machine, settled by what can be observed.
   * It never spawns and never sends a stop. Returns the runs as recovery left them.
   */
  async recover(): Promise<RunRecord[]> {
    const settled = await this.#settleAll();
    return settled.map((s) => s.run);
  }

  async #settleAll(): Promise<{ run: RunRecord; moved: boolean }[]> {
    const { runs } = await this.#call(() => this.#store.openWork(this.#machine));
    const results = await Promise.allSettled(
      runs.map(async (candidate) => {
        let read: RunRecord | undefined;
        const after = await this.#section(candidate.id, async () => {
          read = await this.#read(candidate.id);
          return read === undefined ? undefined : this.#recoverOne(read);
        });
        return { run: after, moved: after !== undefined && after.version !== read?.version };
      }),
    );
    const out: { run: RunRecord; moved: boolean }[] = [];
    let failure: Error | undefined;
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.run !== undefined)
          out.push({ run: result.value.run, moved: result.value.moved });
      } else if (!(result.reason instanceof RunDeadlinePassed)) {
        failure ??= result.reason instanceof Error ? result.reason : new Error("A run call failed");
      }
    }
    if (failure !== undefined) throw failure;
    return out;
  }

  /**
   * Recovery's rule for one run, in its section, on the record read there: at start and at every
   * sweep. What the shim left comes first; a time limit applies only while the shim is pending.
   */
  async #recoverOne(first: RunRecord): Promise<RunRecord | undefined> {
    let run: RunRecord | undefined = first;
    for (let attempt = 0; attempt < RETRIES && run !== undefined; attempt += 1) {
      // An `unknown` run whose stop timed out still settles on its exit, or is lost with its shim.
      if ((FINAL.has(run.state) && !awaitsExit(run)) || run.state === "queued") return run;
      // An unclaimed starting run waits out its claim window: no agent starts without a claim.
      if (run.state === "starting" && run.evidence.claim === undefined) {
        return this.#decide(run.id, (r) => this.#timedOut(r), false, run);
      }
      // What the shim left comes first: a definite exit settles a run whose stop's time passed
      // while the service was down, which a stop timeout would leave unknown.
      const held = run;
      const looked = await this.#external(() => this.#recovery.observe(held));
      const seen: RunObservation = looked.kind === "answered" ? looked.value : { kind: "pending" };
      // A live shim, or one the OS could not tell: only a stop whose time has passed moves it.
      if (seen.kind === "pending") {
        return this.#decide(run.id, (r) => this.#timedOut(r), false, run);
      }
      // A lost shim is recorded first, then its files settle the run.
      if (run.state !== "reconciling") {
        const marked = await this.#try(run, { next: "reconciling" });
        if (marked.kind === "stale") {
          run = marked.run;
          continue;
        }
        if (marked.kind !== "moved" || marked.run?.state !== "reconciling") return marked.run;
        run = marked.run;
      }
      const reconciling = run;
      const move: Move =
        seen.kind === "exited"
          ? finalFor(reconciling, seen.exit)
          : { next: "unknown", patch: { reason: "lost" } };
      const settled = await this.#try(reconciling, move);
      if (settled.kind !== "stale") return settled.run;
      run = settled.run;
    }
    return run;
  }

  /** The move a live report makes from the run's state, or undefined for none. */
  #reported(run: RunRecord, report: RunReport): Move | undefined {
    const { state } = run;
    switch (report.kind) {
      case "started":
        if (run.evidence.claim === undefined) return undefined;
        // A stop that came between the claim and the start keeps the run cancelling, with the
        // agent's PID for the stop (A4 3.11.8).
        if (state === "cancelling") {
          return {
            next: "cancelling",
            patch: { evidence: { pid: report.pid, pid_started_at: report.pidStartedAt } },
          };
        }
        if (state !== "starting") return undefined;
        return {
          next: "running",
          patch: {
            evidence: {
              pid: report.pid,
              pid_started_at: report.pidStartedAt,
              ...(report.folderChecked === true ? { folder_checked: true } : {}),
            },
          },
        };
      case "evidence":
        return HELD.has(state) ? { next: state, patch: { evidence: report.evidence } } : undefined;
      case "verify_failed":
      case "spawn_failed":
        // A definite end before any agent: no process will exit to settle the run. After a Stop
        // it is cancelled, as every stopped run that ends, also once the stop timed out; once an
        // agent's PID is recorded, a start failure is not this run's and its exit decides.
        if (run.evidence.claim === undefined || run.evidence.pid !== undefined) return undefined;
        if (state === "cancelling" || awaitsExit(run)) return { next: "cancelled" };
        if (state === "starting" || state === "reconciling") {
          return run.at.cancelling === undefined
            ? { next: "failed", patch: { reason: report.kind } }
            : { next: "cancelled" };
        }
        return undefined;
      case "exited":
        // The process ended: from every state a process may have been in, or that lost track of
        // it. A run never claimed had no process, so an exit report for it is not its own.
        if (run.evidence.claim === undefined) return undefined;
        if (HELD.has(state) || state === "reconciling" || state === "unknown") {
          if (run.result !== null) return undefined;
          return this.#viaReconciling(run, finalFor(run, report.exit));
        }
        return undefined;
    }
  }

  /**
   * A final move from a state with a direct edge to it, as A4 3.11.2 draws them. A live exit from
   * `starting` or `waiting_for_input`, which have no direct edge to a final state, goes through
   * `reconciling` in two commits (see #decide).
   */
  #viaReconciling(run: RunRecord, move: Move): Move {
    const direct: Record<string, readonly RunState[]> = {
      running: ["succeeded", "failed", "timed_out"],
      cancelling: ["cancelled", "unknown"],
      reconciling: ["succeeded", "failed", "timed_out", "cancelled", "unknown"],
      unknown: ["succeeded", "failed", "timed_out", "cancelled"],
    };
    if (direct[run.state]?.includes(move.next) === true) return move;
    return { next: "reconciling" };
  }

  /** Closing a run whose time ran out: no external step is involved. */
  #timedOut(run: RunRecord): Move | undefined {
    if (run.state === "starting" && run.evidence.claim === undefined && this.#windowPassed(run)) {
      return { next: "failed", patch: { reason: "not_claimed" } };
    }
    if (run.state === "cancelling" && this.#stopPassed(run)) {
      return { next: "unknown", patch: { reason: "stop_timed_out" } };
    }
    return undefined;
  }

  /**
   * Decides on the record as it is, in the caller's section, and commits: after a compare-and-set
   * lost to a write that landed late it reads again and decides again. A move through
   * `reconciling` (#viaReconciling) decides again on the reconciling record. No external step.
   */
  async #decide(
    id: string,
    rule: (run: RunRecord) => Move | undefined,
    notYetThrows = false,
    first?: RunRecord,
  ): Promise<RunRecord | undefined> {
    let run = first ?? (await this.#read(id));
    for (let attempt = 0; attempt < RETRIES && run !== undefined; attempt += 1) {
      const move = rule(run);
      if (move === undefined) return run;
      const tried = await this.#try(run, move);
      if (notYetThrows && tried.error?.code === "unavailable") throw tried.error;
      if (tried.kind === "moved" && move.next === "reconciling" && run.state !== "reconciling") {
        run = tried.run;
        continue;
      }
      if (tried.kind !== "stale") return tried.run;
      run = tried.run;
    }
    return run;
  }

  /** One compare-and-set on the record the move was decided on: its state and its version. */
  async #try(run: RunRecord, move: Move): Promise<Tried> {
    const patch = fresh(run, move.patch);
    if (move.next === run.state && Object.keys(patch.evidence ?? {}).length === 0) {
      return { kind: "moved", run };
    }
    try {
      const after = await this.#call(() =>
        this.#store.transitionRun(run.id, seenRun(run), move.next, patch),
      );
      if (FINAL.has(after.state)) this.#marks.delete(after.id);
      return { kind: "moved", run: after };
    } catch (error) {
      if (!(error instanceof RunRefused)) throw error;
      if (error.code === "stale") return { kind: "stale", run: error.current };
      // A result the store refuses is left out, never the transition: what an agent or its shim
      // reported must not keep the run from settling (A4 3.11.2). The state and reason still say
      // how it ended; the record then holds no result.
      if (
        error.code === "invalid" &&
        patch.result !== undefined &&
        error.field?.startsWith("patch.result") === true
      ) {
        return this.#try(run, {
          next: move.next,
          patch: {
            ...(move.patch?.reason === undefined ? {} : { reason: move.patch.reason }),
            ...(move.patch?.evidence === undefined ? {} : { evidence: move.patch.evidence }),
          },
        });
      }
      return { kind: "refused", run: error.current ?? run, error };
    }
  }

  async #section<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.#sections.get(id);
    let end!: () => void;
    const mine = new Promise<void>((resolve) => {
      end = resolve;
    });
    const last = before === undefined ? mine : before.then(() => mine);
    this.#sections.set(id, last);
    try {
      if (before !== undefined) await before;
      return await work();
    } finally {
      end();
      if (this.#sections.get(id) === last) this.#sections.delete(id);
    }
  }

  #read(id: string): Promise<RunRecord | undefined> {
    return this.#call(() => this.#store.readRun(id));
  }

  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#within(this.#deadlines.store, call).then((answer) => {
      if (answer.kind === "silent") throw new RunDeadlinePassed();
      return answer.value;
    });
  }

  async #external<T>(step: () => Promise<T>): Promise<Answer<T>> {
    try {
      return await this.#within(this.#deadlines.step, step);
    } catch {
      return { kind: "silent" };
    }
  }

  async #within<T>(ms: number, call: () => Promise<T>): Promise<Answer<T>> {
    const stop = new AbortController();
    try {
      return await Promise.race([
        new Promise<Answer<T>>((resolve, reject) => {
          call().then((value) => {
            resolve({ kind: "answered", value });
          }, reject);
        }),
        this.#wait(ms, stop.signal).then((): Answer<T> => ({ kind: "silent" })),
      ]);
    } finally {
      stop.abort();
    }
  }

  #mark(id: string, marks: { starting?: number; cancelling?: number }): void {
    this.#marks.set(id, { ...this.#marks.get(id), ...marks });
  }

  /**
   * The claim window has passed: on the monotonic clock for a run this service started, else on
   * the wall clock on either side (the safe side: a refused claim starts no agent).
   */
  #windowPassed(run: RunRecord): boolean {
    const starting = this.#marks.get(run.id)?.starting;
    if (starting !== undefined) return this.#elapsed() - starting >= RUN_CLAIM_WINDOW_MS;
    const since = run.at.starting;
    return since !== undefined && apart(this.#now(), since, RUN_CLAIM_WINDOW_MS);
  }

  /** The stop's time has passed, judged as the claim window is. */
  #stopPassed(run: RunRecord): boolean {
    const cancelling = this.#marks.get(run.id)?.cancelling;
    if (cancelling !== undefined) return this.#elapsed() - cancelling >= RUN_STOP_TIMEOUT_MS;
    const since = run.at.cancelling;
    return since !== undefined && apart(this.#now(), since, RUN_STOP_TIMEOUT_MS);
  }
}

/** The patch without evidence the record holds already: held keys keep their values. */
function fresh(run: RunRecord, patch: RunPatch | undefined): RunPatch {
  if (patch === undefined) return {};
  const evidence: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch.evidence ?? {})) {
    if (!(key in run.evidence)) evidence[key] = value;
  }
  return {
    ...(patch.reason === undefined ? {} : { reason: patch.reason }),
    ...(Object.keys(evidence).length === 0 ? {} : { evidence: evidence }),
    ...(patch.result === undefined ? {} : { result: patch.result }),
  };
}
