// A4's launch state machine (3.9) as code over the execution store, with every external step
// injected. It owns three rules:
//
// 1. Persistence before each external step. Dispatching is committed before the route's call
//    (spawn, URL open, T3 request), a terminal shim's claim before the claim's reply, which is
//    what lets the shim start the agent, and T3's repeat before the repeat. A step whose record did
//    not commit never runs, so a crash between "I decided to start an agent" and "I know it
//    started" leaves a durable record of the decision, and never a second start.
// 2. No automatic retry. Only Prepared moves to Dispatching, by compare-and-set, so a second press,
//    a repeated request, a racing recovery path or a restart never dispatches an intent again. The
//    one repeat is A4 L14's: T3's idle-thread create with the same key under the same grant, which
//    starts no agent turn, recorded before it is sent and so sent once at most. After re-pairing
//    the intent becomes Unknown instead.
// 3. Restart recovery (A4 3.9.3). After a restart the machine reads its own open work and settles
//    each intent by its route's rule and what it can observe. Unknown stays Unknown until a
//    definite observation settles it, and nothing leads from Unknown to a dispatch or a claim.
//
// One call at a time per intent. Every call on an intent (a dispatch, a claim and its reply, a
// report, the sweep's or recovery's work on it) runs in that intent's section: one at a time, in
// the order they arrive. Inside it the call reads the record, decides, commits and runs at most one
// effectful external step (a dispatch, T3's repeat, a claim's reply), and the commit before a step
// is a compare-and-set on the record it read there. A call may also read from outside first (T3's
// grant, recovery's observation of a claimed terminal), which changes nothing.
// Nothing decides on a record read outside the section: the sweep and recovery list their open
// work first, and read each intent again inside its section. So no call acts on a record another
// call of this service is changing.
//
// Every call to the store and every external step has a deadline. A store call still unanswered
// then has an open outcome: the call ends with DeadlinePassed and leaves the record as it is, which
// later calls settle as after a crash. A step still unanswered is a timeout, recorded as A4 says
// for not knowing. So a call that never answers owns its intent only until its deadline. A write
// that lands after its deadline is a compare-and-set on a record that has changed since, when any
// call has committed on that intent meanwhile: it is refused, or the later call's commit is, and
// that call reads again. Since every external step follows a commit of its own call, no late
// write can change the record between that commit and the step. One service per machine owns its
// launches (A2's service lock), so no other service runs a section on them.
import {
  apart,
  CLAIM_WINDOW_MS,
  CLICK_SLACK_MS,
  isOpening,
  isOpenLaunch,
  PREPARED_TTL_MS,
  STEP_DEADLINE_MS,
  STORE_DEADLINE_MS,
  type Evidence,
  type FailReason,
  type IntentState,
  type Reason,
} from "./intents.ts";
import {
  ExecutionRefused,
  seen,
  type LaunchIntent,
  type LaunchStore,
  type NewIntent,
} from "./store.ts";

/** What a route's external call reports (A4 3.9.2's Dispatched, Failed and Unknown columns). */
export type DispatchOutcome =
  /** The OS or API accepted the call. Evidence such as T3's thread ID. */
  | { kind: "accepted"; evidence?: Evidence }
  /** Definite evidence that nothing started: an error before activation. */
  | { kind: "refused"; reason?: FailReason }
  /** No answer, a timeout, or an answer that does not tell whether anything started. */
  | { kind: "unknown" };

/** The route's external call, run at most once per intent, and only after Dispatching is durable. */
export interface LaunchSteps {
  /**
   * Must not wait for another call on the same intent (a claim, a report): those wait for this
   * one, until its deadline.
   */
  dispatch(intent: LaunchIntent): Promise<DispatchOutcome>;
}

/** What is known of a launch now: from a live report, or observed after a restart. */
export type Observation =
  /** Nothing settles it yet: a re-attached shim whose agent still starts, an open claim window. */
  | { kind: "pending" }
  /** Evidence to record, without a change of state: an agent's PID, the bridge's binding. */
  | { kind: "evidence"; evidence: Evidence }
  /** Definite evidence that a session exists in the exact folder (A4 3.9.2's Confirmed). */
  | { kind: "confirmed"; evidence?: Evidence }
  /** Definite evidence that no session started, or that the agent ended within 3 s. */
  | { kind: "failed"; reason: FailReason; evidence?: Evidence }
  /** The service lost track: a claimed shim gone without a report (A4 3.9.3). */
  | { kind: "lost" };

/** What recovery may look at after a restart (A4 3.9.3). Each route's step brings its own. */
export interface RecoverySteps {
  /**
   * Terminal: a claimed launch after a restart. A shim that re-attached is `pending` until it
   * reports, `exit.json` gives `confirmed` or `failed`, and a shim that is gone is `lost`.
   */
  observe(intent: LaunchIntent): Promise<Observation>;
  /** T3: the current grant ID, or undefined when TTasks is not paired. */
  grant(): Promise<string | undefined>;
  /**
   * T3: the repeat of the idle-thread create with the intent's key under its grant (A4 L14). It
   * starts no agent turn. The machine calls it only when the intent's grant is the current one,
   * once per intent, on a record that says so.
   */
  replay(intent: LaunchIntent): Promise<DispatchOutcome>;
}

/** How long the machine waits for one call, in milliseconds on the monotonic clock. */
export interface Deadlines {
  /** A call to the execution store. Default: STORE_DEADLINE_MS. */
  store: number;
  /** An external step: a dispatch, a repeat, a claim's reply, an observation. STEP_DEADLINE_MS. */
  step: number;
}

export interface LaunchMachineOptions {
  /** The launch part of the execution store: the machine reads and writes intents only. */
  store: LaunchStore;
  /** This machine (`m_` ID): it recovers only the intents it dispatched (A4 3.16.1). */
  machine: string;
  steps: LaunchSteps;
  recovery: RecoverySteps;
  /** Milliseconds since 1970: the wall clock. Default: Date.now. */
  now?: () => number;
  /**
   * A monotonic clock in milliseconds, which a step of the wall clock does not move. Default:
   * performance.now. The windows of intents this service opened or dispatched run on it.
   */
  elapsed?: () => number;
  /**
   * Resolves once `ms` have passed on the monotonic clock, or never when `signal` aborts first:
   * the timer of every deadline. Default: a timer that does not keep the process alive.
   */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  deadlines?: Partial<Deadlines>;
}

/**
 * A call to the store gave no answer within its deadline: its outcome is open (A1 3.8), as after
 * a storage failure. The call on the intent ended without it, and the record is as the store
 * holds it, for the next call to read.
 */
export class DeadlinePassed extends Error {
  override readonly name = "DeadlinePassed";
  constructor() {
    super("The execution store did not answer in time: the outcome is open");
  }
}

/**
 * When this service opened an intent and when it committed its Dispatching, on the monotonic
 * clock. A record's times of state are wall clock readings, which a step of the wall clock
 * moves, so they cannot time a window while the service runs; they decide only for a record
 * from before a restart, on the safe side.
 */
interface Marks {
  opened?: number;
  dispatching?: number;
}

const FINAL: ReadonlySet<IntentState> = new Set(["confirmed", "failed", "unknown"]);

/** A transition the machine wants: the next state and what it writes. */
interface Move {
  next: IntentState;
  reason?: Reason;
  evidence?: Evidence;
}

/** What one attempted move did: moved, lost to a write that landed first (`stale`), or refused. */
interface Tried {
  kind: "moved" | "stale" | "refused";
  intent: LaunchIntent | undefined;
  /** The store's refusal, for `refused`. */
  error?: ExecutionRefused;
}

/** What an external step gave: its answer, or nothing by its deadline, or an error. */
type Answer<T> = { kind: "answered"; value: T } | { kind: "silent" };

/**
 * How often a call reads again after losing a compare-and-set inside its section, which only a
 * write that landed after its own call's deadline can make it do. The state graph has no cycle.
 */
const RETRIES = 8;

/** Where a call that settles an intent runs: the live sweep, or recovery after a restart. */
type Settling = "sweep" | "restart";

/** A wait on the process's own timers, which never keeps the process alive. */
function timer(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (typeof handle === "object") handle.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(handle);
    });
  });
}

export class LaunchMachine {
  readonly #store: LaunchStore;
  readonly #machine: string;
  readonly #steps: LaunchSteps;
  readonly #recovery: RecoverySteps;
  readonly #now: () => number;
  readonly #elapsed: () => number;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #deadlines: Deadlines;
  /**
   * Each intent's section: the end of the last call queued on it. A call waits for the one before
   * it, and the entry goes when the last call ends. Every call ends by its deadlines.
   */
  readonly #sections = new Map<string, Promise<void>>();
  readonly #marks = new Map<string, Marks>();

  constructor(options: LaunchMachineOptions) {
    this.#store = options.store;
    this.#machine = options.machine;
    this.#steps = options.steps;
    this.#recovery = options.recovery;
    this.#now = options.now ?? Date.now;
    this.#elapsed = options.elapsed ?? (() => globalThis.performance.now());
    this.#wait = options.wait ?? timer;
    this.#deadlines = {
      store: options.deadlines?.store ?? STORE_DEADLINE_MS,
      step: options.deadlines?.step ?? STEP_DEADLINE_MS,
    };
  }

  /** The intents a call of this service is working on or waiting for, in no order. */
  owned(): string[] {
    return [...this.#sections.keys()];
  }

  /**
   * A click: the Prepared intent, or the one a repeated request or a second click returns. The
   * store decides it in one atomic step, on no record the machine read before, so it needs no
   * section. Its mark reads only the click's wall time, which never changes.
   */
  async open(input: Omit<NewIntent, "machine">, requestId: string): Promise<LaunchIntent> {
    const intent = await this.#call(() =>
      this.#store.createIntent({ ...input, machine: this.#machine }, requestId),
    );
    if (intent.state === "prepared" && this.#marks.get(intent.id)?.opened === undefined) {
      // Its age so far on the wall clock that recorded the click. A click just recorded is a
      // few milliseconds old. One the wall clock cannot place (recorded in its future, after a
      // step back) or older than the limit gets no mark: the wall clock rule then closes it.
      const age = this.#now() - clickedAt(intent);
      if (age > -CLICK_SLACK_MS && age < PREPARED_TTL_MS) {
        this.#mark(intent.id, { opened: this.#elapsed() - Math.max(0, age) });
      }
    }
    return intent;
  }

  /**
   * The person confirmed and every check passed: commit Dispatching, then run the route's
   * external call once, then record what it reported. An intent that is not Prepared is returned
   * as it is, without a call. `evidence` is what Dispatching records, such as T3's grant ID. A
   * T3 call without an answer is reconciled at once by the same-key repeat, in a call of its own.
   */
  async dispatch(id: string, evidence: Evidence = {}): Promise<LaunchIntent | undefined> {
    const done = await this.#section(id, () => this.#dispatch(id, evidence));
    if (!done.reconcile) return done.intent;
    return this.#section(id, () => this.#settle(id, "sweep"));
  }

  async #dispatch(
    id: string,
    evidence: Evidence,
  ): Promise<{ intent: LaunchIntent | undefined; reconcile: boolean }> {
    const prepared = await this.#read(id);
    if (prepared?.state !== "prepared") return { intent: prepared, reconcile: false };
    if (this.#expired(prepared)) {
      const closed = await this.#decide(id, (intent) => this.#timedOut(intent), prepared);
      return { intent: closed, reconcile: false };
    }
    // The crash boundary (A4 3.9.1). Nothing external has happened yet.
    const committed = await this.#try(prepared, { next: "dispatching", evidence });
    // A write that landed after its own call's deadline moved it first: nothing external.
    if (committed.kind !== "moved" || committed.intent?.state !== "dispatching") {
      return { intent: committed.intent, reconcile: false };
    }
    const intent = committed.intent;
    this.#mark(id, { dispatching: this.#elapsed() });
    const answer = await this.#external(() => this.#steps.dispatch(intent));
    // A step that throws or does not answer in time cannot tell whether anything started.
    const outcome: DispatchOutcome =
      answer.kind === "answered" ? answer.value : { kind: "unknown" };
    // A lost T3 reply is reconciled at once, as after a restart (A4 3.9.2, 3.9.3): the record
    // stays Dispatching for the repeat, which is the next call on this intent.
    if (outcome.kind === "unknown" && intent.route === "t3-mcp") {
      return { intent, reconcile: true };
    }
    const after = await this.#try(intent, this.#dispatched(intent, outcome));
    return { intent: after.intent, reconcile: false };
  }

  /**
   * A terminal shim's claim (A4 3.6.3 step 3). The claim is committed first, then `reply` sends
   * the shim the agent's argv, which is what lets it start the agent: so an agent never starts
   * without a durable claim, and a second claim, a late one or one on a closed intent is refused
   * and gets no reply. The claim and its reply are one call on the intent, so no other call acts
   * between them. Returns the claimed intent, whether its reply was answered in time or not.
   */
  claim(
    id: string,
    claim: string,
    reply: (intent: LaunchIntent) => Promise<void>,
  ): Promise<LaunchIntent | undefined> {
    return this.#section(id, async () => {
      for (let attempt = 0; attempt < RETRIES; attempt += 1) {
        const intent = await this.#read(id);
        if (intent?.route !== "terminal" || intent.evidence.claim !== undefined) return undefined;
        if (intent.state !== "dispatching" && intent.state !== "dispatched") return undefined;
        if (this.#windowPassed(intent)) return undefined;
        const tried = await this.#try(intent, {
          next: "dispatched",
          evidence: { claim, claimed_at: this.#now() },
        });
        if (tried.kind === "stale") continue;
        const claimed = tried.intent;
        if (tried.kind !== "moved" || claimed?.evidence.claim !== claim) return undefined;
        // A reply without an answer in time may still reach the shim: the claim stands, and
        // the shim's reports or recovery's observation settle the launch.
        await this.#external(() => reply(claimed));
        return claimed;
      }
      return undefined;
    });
  }

  /**
   * A live report about a launch: the shim's `launch.started`, `launch.settled`, `launch.exited`
   * and `launch.failed`, the bridge's binding, T3's folder check. Applies it, in its turn, to the
   * intent as it is then and returns the result. A store that cannot take the write now
   * (`unavailable`) throws its refusal, so the reporter keeps what it reported and tries again; a
   * definite refusal returns the record as it is. An observation that depends on the record (a
   * best-effort app's folder check, A4 3.4.4) is given as a function of the intent: it is decided
   * in the section, on the record as it is then, so a dispatch still in its external call when the
   * report arrived has recorded its evidence first.
   */
  report(
    id: string,
    observation: Observation | ((intent: LaunchIntent) => Observation),
  ): Promise<LaunchIntent | undefined> {
    const observe = typeof observation === "function" ? observation : () => observation;
    return this.#section(id, () =>
      this.#decide(id, (intent) => this.#observed(intent, observe(intent)), undefined, true),
    );
  }

  /**
   * The live service's periodic check: a Prepared intent older than 10 minutes is closed as
   * `expired`, an unclaimed terminal launch whose claim window has passed is Failed with
   * `not_claimed`, and a launch left in Dispatching by a call that ended without its step's
   * outcome is settled as recovery would (a T3 launch by its one repeat). Returns the intents it
   * moved.
   */
  async sweep(): Promise<LaunchIntent[]> {
    const settled = await this.#settleAll("sweep");
    return settled.filter((s) => s.moved).map((s) => s.intent);
  }

  /**
   * Restart recovery (A4 3.9.3): every open intent of this machine, settled by its route's rule.
   * It never dispatches. Returns the intents as recovery left them.
   */
  async recover(): Promise<LaunchIntent[]> {
    return (await this.#settleAll("restart")).map((s) => s.intent);
  }

  /**
   * Ends a launch a claim or a restore in place brought back from a backup while it was open
   * (isOpenLaunch), whichever machine made it: one still opening fails `restored`, a terminal
   * session records `restored_at`. No process is asked about: a session writes only into the copy
   * it was made in. Any other launch is returned as it is.
   */
  endRestored(id: string): Promise<LaunchIntent | undefined> {
    return this.#section(id, () => this.#decide(id, (intent) => this.#restored(intent)));
  }

  /** How a launch a backup brought back while it was open ends: as restored. */
  #restored(intent: LaunchIntent): Move | undefined {
    if (isOpening(intent)) return { next: "failed", reason: "restored" };
    if (isOpenLaunch(intent)) return { next: "confirmed", evidence: { restored_at: this.#now() } };
    return undefined;
  }

  /**
   * Lists the open work, then settles each intent in its own section, on the record read there:
   * the list only names the candidates. An intent whose call passes a deadline is left out.
   */
  async #settleAll(when: Settling): Promise<{ intent: LaunchIntent; moved: boolean }[]> {
    const { intents } = await this.#call(() => this.#store.openWork(this.#machine));
    const results = await Promise.allSettled(
      intents.map(async (candidate) => {
        let read: LaunchIntent | undefined;
        const after = await this.#section(candidate.id, async () => {
          read = await this.#read(candidate.id);
          return read === undefined ? undefined : this.#settle(candidate.id, when, read);
        });
        return { intent: after, moved: after !== undefined && after.version !== read?.version };
      }),
    );
    const out: { intent: LaunchIntent; moved: boolean }[] = [];
    let failure: Error | undefined;
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.intent !== undefined) {
          out.push({ intent: result.value.intent, moved: result.value.moved });
        }
      } else if (!(result.reason instanceof DeadlinePassed)) {
        // A storage failure on one intent: the others are settled first, then it is reported.
        failure ??=
          result.reason instanceof Error ? result.reason : new Error("A launch call failed");
      }
    }
    if (failure !== undefined) throw failure;
    return out;
  }

  /**
   * Settles one intent by recovery's rule (A4 3.9.3), in its section, on the record read there.
   * After a restart nothing of the previous service's calls is left; in the live service a record
   * still in Dispatching when this call has the section belongs to a call that ended without its
   * step's outcome, which is the same.
   */
  async #settle(
    id: string,
    when: Settling,
    first?: LaunchIntent,
  ): Promise<LaunchIntent | undefined> {
    let intent = first ?? (await this.#read(id));
    for (let attempt = 0; attempt < RETRIES && intent !== undefined; attempt += 1) {
      if (FINAL.has(intent.state)) return intent;
      if (this.#timedOut(intent) !== undefined) {
        return this.#decide(id, (current) => this.#timedOut(current), intent);
      }
      if (intent.state === "prepared") return intent;
      switch (intent.route) {
        case "terminal": {
          // Unclaimed: wait out the claim window (#timedOut above ends it). No agent can start
          // without a claim, so a shim that claims now continues normally. Claimed: the live
          // shim reports itself; after a restart, recovery looks.
          if (intent.evidence.claim === undefined || when === "sweep") return intent;
          const claimed = intent;
          const looked = await this.#external(() => this.#recovery.observe(claimed));
          const observation: Observation =
            looked.kind === "answered" ? looked.value : { kind: "pending" };
          const move = this.#observed(intent, observation);
          if (move === undefined) return intent;
          const tried = await this.#try(intent, move);
          if (tried.kind !== "stale") return tried.intent;
          intent = tried.intent;
          continue;
        }
        case "link":
        case "t3-cli": {
          // A link that was accepted stays Dispatched: the session may well exist (A4 3.9.2).
          // `t3-cli` is a route no longer made, kept so its launches recorded earlier settle: its
          // message cannot be repeated and nothing checks its folder now, so it is Unknown. A
          // call that ended in Dispatching cannot be told apart from one that opened.
          const keep =
            intent.state === "dispatched" && (intent.route === "link" || when === "sweep");
          if (keep) return intent;
          const tried = await this.#try(intent, { next: "unknown", reason: "lost" });
          if (tried.kind !== "stale") return tried.intent;
          intent = tried.intent;
          continue;
        }
        case "clipboard": {
          // A4 3.9.2: a clipboard launch is never Unknown. A copy not reported was not made.
          if (intent.state === "dispatched") return intent;
          const tried = await this.#try(intent, { next: "failed", reason: "interrupted" });
          if (tried.kind !== "stale") return tried.intent;
          intent = tried.intent;
          continue;
        }
        case "t3-mcp": {
          if (intent.state === "dispatched") return intent;
          const repeated = await this.#repeat(intent);
          if (repeated.kind !== "stale") return repeated.intent;
          intent = repeated.intent;
          continue;
        }
      }
    }
    return intent;
  }

  /**
   * T3's lost reply (A4 3.9.2 "Lost reply, then reconciled", 3.9.3): repeat the idle-thread create
   * once, only under the grant it was dispatched with, recorded on the record before it is sent.
   * After re-pairing the same key would make a second thread, so the intent becomes Unknown. A
   * repeat without an answer, or a refused one, makes it Unknown too: it says nothing about the
   * first call, which may have made the thread.
   */
  async #repeat(intent: LaunchIntent): Promise<Tried> {
    // A repeat already sent whose answer was never recorded: the launch may well have its thread.
    if (intent.evidence.replayed_at !== undefined) {
      return this.#try(intent, { next: "unknown", reason: "no_answer" });
    }
    const grant = await this.#external(() => this.#recovery.grant());
    if (grant.kind !== "answered") {
      return this.#try(intent, { next: "unknown", reason: "no_answer" });
    }
    if (intent.evidence.grant === undefined || grant.value !== intent.evidence.grant) {
      return this.#try(intent, { next: "unknown", reason: "regranted" });
    }
    const announced = await this.#try(intent, {
      next: "dispatching",
      evidence: { replayed_at: this.#now() },
    });
    if (announced.kind !== "moved" || announced.intent?.state !== "dispatching") return announced;
    const repeated = announced.intent;
    const answer = await this.#external(() => this.#recovery.replay(repeated));
    if (answer.kind !== "answered" || answer.value.kind !== "accepted") {
      return this.#try(repeated, { next: "unknown", reason: "no_answer" });
    }
    return this.#try(repeated, this.#dispatched(repeated, answer.value));
  }

  /** The move a dispatch outcome makes from Dispatching. */
  #dispatched(intent: LaunchIntent, outcome: DispatchOutcome): Move {
    switch (outcome.kind) {
      case "accepted":
        return {
          next: "dispatched",
          ...(outcome.evidence === undefined ? {} : { evidence: outcome.evidence }),
        };
      case "refused":
        return { next: "failed", reason: outcome.reason ?? "refused" };
      case "unknown":
        switch (intent.route) {
          case "terminal":
            // The claim window decides (A4 3.6.2: an ambiguous handoff counts as Dispatched),
            // which is safe because no agent starts without a claim.
            return { next: "dispatched" };
          case "clipboard":
            // A4 3.9.2: a clipboard launch is never Unknown. A copy that cannot be confirmed
            // was not made, as far as TTasks can tell, and nothing starts from a clipboard alone.
            return { next: "failed", reason: "refused" };
          default:
            // The launch may have opened, and TTasks cannot tell.
            return { next: "unknown", reason: "no_answer" };
        }
    }
  }

  /** The move an observation makes from the intent's state, or undefined for none. */
  #observed(intent: LaunchIntent, observation: Observation): Move | undefined {
    const { state } = intent;
    switch (observation.kind) {
      case "pending":
        return undefined;
      case "evidence":
        return state === "dispatched" || state === "confirmed"
          ? { next: state, evidence: observation.evidence }
          : undefined;
      case "confirmed":
        if (intent.route === "terminal" && intent.evidence.claim === undefined) return undefined;
        // In one step from every state that may move there, Dispatching included: evidence that
        // a session exists can arrive before the call's own answer is recorded, and a
        // confirmation in two commits could be cut off between them.
        if (state === "dispatching" || state === "dispatched" || state === "unknown") {
          return {
            next: "confirmed",
            ...(observation.evidence === undefined ? {} : { evidence: observation.evidence }),
          };
        }
        if (state === "confirmed" && observation.evidence !== undefined) {
          return { next: "confirmed", evidence: observation.evidence };
        }
        return undefined;
      case "failed":
        // A session the bridge confirmed before its agent's early end did run: it stays
        // Confirmed, and the end's evidence is what tells every tab that it ended.
        if (state === "confirmed") {
          return observation.evidence === undefined
            ? undefined
            : { next: "confirmed", evidence: observation.evidence };
        }
        return state === "dispatching" || state === "dispatched" || state === "unknown"
          ? {
              next: "failed",
              reason: observation.reason,
              ...(observation.evidence === undefined ? {} : { evidence: observation.evidence }),
            }
          : undefined;
      case "lost":
        // An unclaimed terminal launch is not lost: its claim window decides, and no agent
        // starts without a claim (A4 3.9.2). So no terminal launch is Unknown without a claim.
        // Nor is a clipboard launch, which A4 3.9.2 never makes Unknown: nothing runs there.
        if (intent.route === "terminal" && intent.evidence.claim === undefined) return undefined;
        if (intent.route === "clipboard") return undefined;
        // A session that did run stays Confirmed; the record says it is no longer followed, so
        // nothing shows it as running.
        if (state === "confirmed") {
          return intent.route === "terminal"
            ? { next: "confirmed", evidence: { lost_at: this.#now() } }
            : undefined;
        }
        return state === "dispatching" || state === "dispatched"
          ? { next: "unknown", reason: "lost" }
          : undefined;
    }
  }

  /**
   * Decides on the record as it is, in the caller's section, and commits: after a compare-and-set
   * lost to a write that landed late it reads again and decides again. No external step.
   */
  async #decide(
    id: string,
    rule: (intent: LaunchIntent) => Move | undefined,
    first?: LaunchIntent,
    notYetThrows = false,
  ): Promise<LaunchIntent | undefined> {
    let intent = first ?? (await this.#read(id));
    for (let attempt = 0; attempt < RETRIES && intent !== undefined; attempt += 1) {
      const move = rule(intent);
      if (move === undefined) return intent;
      const tried = await this.#try(intent, move);
      if (notYetThrows && tried.error?.code === "unavailable") throw tried.error;
      if (tried.kind !== "stale") return tried.intent;
      intent = tried.intent;
    }
    return intent;
  }

  /** One compare-and-set on the record the move was decided on: its state and its version. */
  async #try(intent: LaunchIntent, move: Move): Promise<Tried> {
    const evidence = fresh(intent.evidence, move.evidence);
    if (move.next === intent.state && Object.keys(evidence).length === 0) {
      return { kind: "moved", intent };
    }
    try {
      const after = await this.#call(() =>
        this.#store.transitionIntent(intent.id, seen(intent), move.next, {
          ...(move.reason === undefined ? {} : { reason: move.reason }),
          evidence,
        }),
      );
      if (FINAL.has(after.state)) this.#marks.delete(after.id);
      return { kind: "moved", intent: after };
    } catch (error) {
      if (!(error instanceof ExecutionRefused)) throw error;
      // A write that landed after its own call's deadline changed it: act on the record as it is
      // now. Any other refusal ends here.
      if (error.code === "stale") return { kind: "stale", intent: error.current };
      return { kind: "refused", intent: error.current ?? intent, error };
    }
  }

  /**
   * Runs `work` in the intent's section: after every call queued on it before, and before every
   * call queued after. `work` ends by its deadlines, so the section always moves on.
   */
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

  /** The intent as the store holds it now. */
  #read(id: string): Promise<LaunchIntent | undefined> {
    return this.#call(() => this.#store.readIntent(id));
  }

  /** A call to the store, with its deadline: DeadlinePassed once it has passed. */
  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#within(this.#deadlines.store, call).then((answer) => {
      if (answer.kind === "silent") throw new DeadlinePassed();
      return answer.value;
    });
  }

  /** An external step, with its deadline. A step that throws gives no answer either. */
  async #external<T>(step: () => Promise<T>): Promise<Answer<T>> {
    try {
      return await this.#within(this.#deadlines.step, step);
    } catch {
      return { kind: "silent" };
    }
  }

  /** `call`'s answer, or `silent` once `ms` have passed. A later answer is dropped. */
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

  #mark(id: string, marks: Marks): void {
    this.#marks.set(id, { ...this.#marks.get(id), ...marks });
  }

  /**
   * Prepared for 10 minutes: on the monotonic clock for an intent this service opened, else on
   * the wall clock, where an instant 10 minutes away on either side has passed (the safe side:
   * closing a Prepared intent starts nothing).
   */
  #expired(intent: LaunchIntent): boolean {
    const opened = this.#marks.get(intent.id)?.opened;
    return opened === undefined
      ? apart(this.#now(), clickedAt(intent), PREPARED_TTL_MS)
      : this.#elapsed() - opened >= PREPARED_TTL_MS;
  }

  /**
   * The claim window is over: 120 s from Dispatching, on the monotonic clock for an intent this
   * service dispatched, else on the wall clock on either side (the safe side: a claim refused
   * starts no agent).
   */
  #windowPassed(intent: LaunchIntent): boolean {
    const dispatching = this.#marks.get(intent.id)?.dispatching;
    if (dispatching !== undefined) return this.#elapsed() - dispatching >= CLAIM_WINDOW_MS;
    const since = intent.at.dispatching;
    return since !== undefined && apart(this.#now(), since, CLAIM_WINDOW_MS);
  }

  /** Closing an intent whose time ran out: no external step is involved. */
  #timedOut(intent: LaunchIntent): Move | undefined {
    if (intent.state === "prepared") {
      return this.#expired(intent) ? { next: "failed", reason: "expired" } : undefined;
    }
    const unclaimed = intent.route === "terminal" && intent.evidence.claim === undefined;
    if (
      unclaimed &&
      (intent.state === "dispatching" || intent.state === "dispatched") &&
      this.#windowPassed(intent)
    ) {
      return { next: "failed", reason: "not_claimed" };
    }
    return undefined;
  }
}

/** When the click was recorded, on the wall clock (A4 3.16's time of Prepared). */
const clickedAt = (intent: LaunchIntent): number => intent.at.prepared ?? intent.createdAt;

/** The evidence of `incoming` that `held` does not have yet. Held keys keep their values. */
function fresh(held: Evidence, incoming: Evidence | undefined): Evidence {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (!(key in held)) out[key] = value;
  }
  return out;
}
