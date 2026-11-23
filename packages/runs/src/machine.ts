// What a run record may say about a run's processes, and when. The run host (host.ts) owns the
// processes and their container; this module decides each move of the record on the record as it
// is, and commits it by compare-and-set:
//
// 1. Only `queued` moves to `starting`, and it is committed before any container exists. A run's
//    container is named after the run, so that commit is also the record of the container's name:
//    a crash right after it leaves a record that the next start's recovery settles, and nothing
//    ever starts twice.
// 2. A final state is entered only once the run's container was confirmed empty. A container that
//    could not be confirmed makes the run `unknown` (reason `stop_timed_out`), which keeps the
//    cancel intent and moves on once End by force or the next start confirms the container.
// 3. An accepted Stop (`cancelling`, committed before anything is stopped) ends `cancelled` or
//    `unknown`. A late agent PID is recorded as evidence and never moves a run out of it.
// 4. What an agent wrote never keeps its run from settling: a result the store refuses is left out.
//
// One call at a time per run: each call reads the record in that run's section, decides, and
// commits on what it read. Every store call has a deadline; one still unanswered has an open
// outcome, which the caller treats as after a crash. One service per machine owns its runs.
import {
  FINAL_RUN_STATES,
  isRunEdge,
  isRunReason,
  type NewRun,
  type RunEvidence,
  type RunPatch,
  type RunReason,
  type RunRecord,
  type RunResult,
  type RunState,
} from "@ttasks/contracts/runs";
import { RunRefused, seenRun, type RunStore } from "@ttasks/launch/execution-store";

/** How long the machine waits for one call to the store, as the launch machine does. */
export const RUN_STORE_DEADLINE_MS = 15_000;

/**
 * How a run ended, once its container was confirmed empty, or that it could not be confirmed.
 * With a Stop accepted before, every confirmed end is `cancelled`.
 */
export type RunEnd =
  /** The agent exited, or was stopped, and the parser judged its output. */
  | { readonly kind: "exited"; readonly result: RunResult }
  /** A limit of the run ended it. */
  | { readonly kind: "timed_out"; readonly limit: "wall" | "idle"; readonly result: RunResult }
  /** No agent ran: it could not start, or gave no PID within the start time. */
  | { readonly kind: "start_failed"; readonly reason: "spawn_failed" | "start_timed_out" }
  /** The service ended while the run was open; the result holds the last saved answer. */
  | { readonly kind: "service_ended"; readonly result: RunResult | null }
  /** A claim or a restore in place brought the run back open from a backup: it never goes on. */
  | { readonly kind: "restored" }
  /** The container could not be confirmed empty. */
  | { readonly kind: "not_confirmed" };

/**
 * Why a queued run can no longer start: its task was finished or deleted, its instance is gone or
 * no longer for its space, its folder is gone, or no agent could be made for it.
 */
export type StartRefusal =
  "task_closed" | "instance_gone" | "not_for_space" | "folder_gone" | "spawn_failed";

export interface RunMachineOptions {
  store: RunStore;
  /** This machine (`m_` ID): it works on its own runs only. */
  machine: string;
  /** Resolves once `ms` passed, or never when `signal` aborts first. Default: a timer. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Default: RUN_STORE_DEADLINE_MS. */
  deadline?: number;
}

/** A call to the store gave no answer within its deadline: its outcome is open (A1 3.8). */
export class RunDeadlinePassed extends Error {
  override readonly name = "RunDeadlinePassed";
  constructor() {
    super("The execution store did not answer in time: the outcome is open");
  }
}

const FINAL: ReadonlySet<RunState> = new Set(FINAL_RUN_STATES);

/** The states whose container may hold processes, where evidence about them is recorded. */
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

/** The final move an agent's result gives: succeeded on success, else failed with its reason. */
function outcomeMove(result: RunResult): Move {
  if (result.ok) return { next: "succeeded", patch: { result } };
  const outcome = result.outcome === "success" ? "exit_status" : result.outcome;
  const reason: RunReason = isRunReason("failed", outcome) ? outcome : "no_result";
  return { next: "failed", patch: { reason, result } };
}

/**
 * The move an end makes from the run's record, or undefined for none: a final run stays as it is
 * (an `unknown` one moves on a confirmed end only), a queued run has no container, and an accepted
 * Stop makes every confirmed end `cancelled`.
 */
export function endMove(run: RunRecord, end: RunEnd): Move | undefined {
  // A queued run a restore brought back has no container: it ends at once, never to start.
  if (end.kind === "restored" && run.state === "queued") {
    return { next: "failed", patch: { reason: "restored" } };
  }
  if (run.state === "queued") return undefined;
  if (FINAL.has(run.state) && run.state !== "unknown") return undefined;
  if (end.kind === "not_confirmed") {
    return run.state === "unknown"
      ? undefined
      : { next: "unknown", patch: { reason: "stop_timed_out" } };
  }
  const result = end.kind === "start_failed" || end.kind === "restored" ? null : end.result;
  if (run.at.cancelling !== undefined) {
    return { next: "cancelled", ...(result === null ? {} : { patch: { result } }) };
  }
  switch (end.kind) {
    case "exited":
      return outcomeMove(end.result);
    case "timed_out":
      return { next: "timed_out", patch: { reason: end.limit, result: end.result } };
    case "start_failed":
      return { next: "failed", patch: { reason: end.reason } };
    case "service_ended":
      return {
        next: "failed",
        patch: { reason: "service_ended", ...(result === null ? {} : { result }) },
      };
    case "restored":
      return { next: "failed", patch: { reason: "restored" } };
  }
}

export class RunMachine {
  readonly #store: RunStore;
  readonly #machine: string;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #deadline: number;
  readonly #sections = new Map<string, Promise<void>>();

  constructor(options: RunMachineOptions) {
    this.#store = options.store;
    this.#machine = options.machine;
    this.#wait = options.wait ?? timer;
    this.#deadline = options.deadline ?? RUN_STORE_DEADLINE_MS;
  }

  /** Records a run in `queued` before anything starts. A request ID replays it. */
  queue(input: Omit<NewRun, "machine">, requestId: string): Promise<RunRecord> {
    return this.#call(() => this.#store.createRun({ ...input, machine: this.#machine }, requestId));
  }

  /** The run a request already queued, as it is now; undefined when it queued none. */
  replayed(requestId: string): Promise<RunRecord | undefined> {
    return this.#call(() => this.#store.replayedRun(requestId));
  }

  /** The run as the store holds it now. */
  read(id: string): Promise<RunRecord | undefined> {
    return this.#call(() => this.#store.readRun(id));
  }

  /** This machine's open runs and its `unknown` runs not yet confirmed ended, oldest first. */
  async open(): Promise<RunRecord[]> {
    return (await this.#call(() => this.#store.openWork(this.#machine))).runs;
  }

  /**
   * Commits `queued → starting`, the one move that lets a container start. `began` is true only
   * for the call that made it; any other gets the record as it is.
   */
  begin(id: string): Promise<{ run: RunRecord | undefined; began: boolean }> {
    return this.#section(id, async () => {
      const run = await this.#read(id);
      if (run?.state !== "queued") return { run, began: false };
      const tried = await this.#try(run, { next: "starting" });
      return {
        run: tried.run,
        began: tried.kind === "moved" && tried.run?.state === "starting",
      };
    });
  }

  /**
   * The agent's PID and start time: `starting → running`. On a run whose Stop was accepted they
   * are recorded and it stays `cancelling`; any other run is returned as it is.
   */
  started(
    id: string,
    pid: number,
    at: number,
    more: RunEvidence = {},
  ): Promise<RunRecord | undefined> {
    const evidence: RunEvidence = { ...more, pid, pid_started_at: at };
    return this.#section(id, () =>
      this.#decide(id, (run) => {
        if (run.state === "starting") return { next: "running", patch: { evidence } };
        if (run.state === "cancelling") return { next: "cancelling", patch: { evidence } };
        return undefined;
      }),
    );
  }

  /** Evidence about a run whose container may hold processes, such as the agent's native ID. */
  evidence(id: string, evidence: RunEvidence): Promise<RunRecord | undefined> {
    return this.#section(id, () =>
      this.#decide(id, (run) =>
        HELD.has(run.state) ? { next: run.state, patch: { evidence } } : undefined,
      ),
    );
  }

  /**
   * The person's Stop. A queued run is `cancelled` at once: it has no container. A run whose
   * container may hold processes is `cancelling`, committed before anything is stopped, and
   * `stopping` says the caller must stop it. Any other run is returned as it is.
   */
  cancel(id: string): Promise<{ run: RunRecord | undefined; stopping: boolean }> {
    return this.#section(id, async () => {
      const run = await this.#decide(id, (r) => {
        if (r.state === "queued") return { next: "cancelled" };
        if (r.state === "starting" || r.state === "running" || r.state === "waiting_for_input") {
          return { next: "cancelling" };
        }
        return undefined;
      });
      return { run, stopping: run?.state === "cancelling" };
    });
  }

  /**
   * A queued run that can no longer start fails with why, before any container exists. Any other
   * run is returned as it is: one a Stop cancelled meanwhile, or one that started.
   */
  refuse(id: string, reason: StartRefusal): Promise<RunRecord | undefined> {
    return this.#section(id, () =>
      this.#decide(id, (run) =>
        run.state === "queued" ? { next: "failed", patch: { reason } } : undefined,
      ),
    );
  }

  /** Settles a run by how it ended (endMove). A final run, and a queued one, stay as they are. */
  settle(id: string, end: RunEnd): Promise<RunRecord | undefined> {
    return this.#section(id, () => this.#decide(id, (run) => endMove(run, end)));
  }

  /**
   * Decides on the record as it is and commits. A move along no edge of the run's state goes
   * through `reconciling` first, in two commits, and is decided again there. After a
   * compare-and-set lost to a write that landed late, it reads again and decides again.
   */
  async #decide(
    id: string,
    rule: (run: RunRecord) => Move | undefined,
  ): Promise<RunRecord | undefined> {
    let run = await this.#read(id);
    for (let attempt = 0; attempt < RETRIES && run !== undefined; attempt += 1) {
      const wanted = rule(run);
      if (wanted === undefined) return run;
      const move =
        isRunEdge(run.state, wanted.next) || !isRunEdge(run.state, "reconciling")
          ? wanted
          : { next: "reconciling" as const };
      const tried = await this.#try(run, move);
      if (tried.error?.code === "unavailable") throw tried.error;
      if (tried.kind === "moved" && move !== wanted) {
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
      return { kind: "moved", run: after };
    } catch (error) {
      if (!(error instanceof RunRefused)) throw error;
      if (error.code === "stale") return { kind: "stale", run: error.current };
      // A result the store refuses is left out, never the transition: what an agent reported must
      // not keep its run from settling. The state and reason still say how it ended.
      if (
        error.code === "invalid" &&
        patch.result !== undefined &&
        error.field?.startsWith("patch.result") === true
      ) {
        const rest: RunPatch = { ...patch };
        delete rest.result;
        return this.#try(run, { next: move.next, patch: rest });
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

  async #call<T>(call: () => Promise<T>): Promise<T> {
    const stop = new AbortController();
    try {
      const answer = await Promise.race([
        call().then((value) => ({ value })),
        this.#wait(this.#deadline, stop.signal).then(() => undefined),
      ]);
      if (answer === undefined) throw new RunDeadlinePassed();
      return answer.value;
    } finally {
      stop.abort();
    }
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
