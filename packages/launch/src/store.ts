// The execution store (A4 3.16.1, X7): the one interface through which launch intents and runs are
// written. Launch and run code never write a record any other way. v1's backend is the space
// database, where each call is one A1 operation in one transaction (space-store.ts). From L1 a
// machine without authority writes the same interface to a machine-local journal (A6). One contract
// suite per part runs against every backend (test/execution-store-contract.ts,
// test/run-store-contract.ts).
//
// The interface has a launch part (M2.05) and a run part (M6.01), and `openWork` returns runs beside
// intents. Each state machine takes only its part: LaunchMachine a LaunchStore, the run machine
// (@tasks/runs) a RunStore. Sessions (`upsertSession`, with the session move of A4 3.10) and
// occurrences (`decideOccurrence`, M9) join it with the steps that write those records.
import {
  ANSWER_CAP_BYTES,
  cutRunAnswer,
  cutRunText,
  FINAL_RUN_STATES,
  isRunEdge,
  normaliseRunText,
  isRunReason,
  OUTCOME_REASONS,
  APP_TOOLS_STATES,
  RUN_CLEANUPS,
  RUN_ADAPTERS,
  RUN_EVIDENCE_FIELDS,
  RUN_EVIDENCE_ID,
  RUN_LIMIT_BOUNDS,
  RUN_PERMISSIONS,
  RUN_REQUEST_MAX_BYTES,
  RUN_STATES,
  SIGNAL_NAME,
  takesReason,
  TEXT_CAP_BYTES,
  type NewRun,
  type RunEvidence,
  type RunEvidenceKey,
  type RunLimits,
  type RunPatch,
  type RunReason,
  type RunRecord,
  type RunResult,
  type RunState,
  type Usage,
} from "@tasks/contracts/runs";
import {
  cleanEvidence,
  evidenceProblem,
  isEdge,
  isEvidenceValue,
  MAX_COUNT,
  isFailReason,
  isIntentState,
  isRoute,
  isUnknownReason,
  type Evidence,
  type IntentState,
  type Reason,
  type Route,
} from "./intents.ts";

/** What a click records (A4 3.9.1 Prepared). IDs and codes only. */
export interface NewIntent {
  /** The task (`t_` ID). */
  task: string;
  /** The machine that dispatches it (`m_` ID): the one whose `openWork` recovers it. */
  machine: string;
  /** The instance's key in this machine's `machine.toml`. */
  instance: string;
  route: Route;
  /** The place the folder resolved from (`pl_` ID), or null for the Tasks work folder (A4 3.3). */
  place: string | null;
  /** The task's version when the person clicked. */
  taskVersion: number;
  /** SHA-256 of the brief, lower-case hex. The brief itself is never stored. */
  briefHash: string;
  /** The session a Resume continues (`se_` ID). */
  session?: string;
  /** The folder's identity and a preset native session ID, known at Prepared. */
  evidence?: Evidence;
}

/** A launch intent and its receipt, as every backend returns it. */
export interface LaunchIntent {
  /** `la_` ID. */
  id: string;
  /** The launch reference in the brief, such as `L7KQ2M`. */
  reference: string;
  task: string | null;
  session: string | null;
  machine: string;
  instance: string;
  route: Route;
  place: string | null;
  /** `place` when the folder came from a place, else the space's Tasks work folder. */
  folderKind: "place" | "work_folder";
  taskVersion: number | null;
  briefHash: string | null;
  state: IntentState;
  /** Why it is Failed or Unknown. Null in every other state. */
  reason: Reason | null;
  evidence: Evidence;
  /** When it entered each state it has been in (A4 3.16: "a timestamp per state"). */
  at: Partial<Record<IntentState, number>>;
  createdAt: number;
  updatedAt: number;
  /** Grows with every change, so two reads can be told apart. */
  version: number;
}

/** What a transition writes beside the state: the reason of Failed and Unknown, and evidence. */
export interface Outcome {
  reason?: Reason;
  evidence?: Evidence;
}

/**
 * What a transition expects of the record: its state (A4 3.16.1's compare-and-set), or its state
 * at one version, the record the caller read and decided on. With a version, any change since,
 * evidence on a self edge included, makes the call `stale`. The state machine always gives one.
 */
export type Expected = IntentState | { state: IntentState; version: number };

/** The record a decision was made on, as a transition's expectation. */
export const seen = (intent: LaunchIntent): Expected => ({
  state: intent.state,
  version: intent.version,
});

/** The launch part of the execution store: what LaunchMachine needs. */
export interface LaunchStore {
  /**
   * Records a click as a Prepared intent: the record, its history and the request's receipt in one
   * atomic step. The same request ID with the same input returns the same intent; with another
   * input it is refused (`request_id_reused`). A distinct click on the same task and instance while
   * an intent is in Dispatching or younger than 5 s returns that intent (A4 3.9.1).
   */
  createIntent(input: NewIntent, requestId: string): Promise<LaunchIntent>;
  /**
   * One atomic compare-and-set transition: the state must be `expect` (and the version, when
   * `expect` names one), or the call is refused with `stale` and the current record, and moves
   * nothing. `expect → next` must be an edge of A4's machine. Evidence only grows: a key with
   * another value than the record holds is refused. Returns the record as it is after the call:
   * the one it wrote, or a later one when another path moved it at once.
   */
  transitionIntent(
    id: string,
    expect: Expected,
    next: IntentState,
    outcome?: Outcome,
  ): Promise<LaunchIntent>;
  /** The intent as it is now, or undefined. */
  readIntent(id: string): Promise<LaunchIntent | undefined>;
  /** Every intent of that machine that is not final: Prepared, Dispatching and Dispatched. */
  openWork(machine: string): Promise<{ intents: LaunchIntent[] }>;
}

/**
 * What a run transition expects of the record: its state at one version, the record the caller
 * read and decided on (A4 3.16.1). Any change since makes the call `stale`.
 */
export interface RunExpected {
  state: RunState;
  version: number;
}

/** The run a decision was made on, as a transition's expectation. */
export const seenRun = (run: RunRecord): RunExpected => ({
  state: run.state,
  version: run.version,
});

/** The run part of the execution store (A4 3.16.1): what the run machine needs. */
export interface RunStore {
  /**
   * Records a run in `queued` before anything spawns (A4 3.11.2): the record, its history and the
   * request's receipt in one atomic step. The same request ID with the same input returns the same
   * run; with another input it is refused (`request_id_reused`).
   */
  createRun(input: NewRun, requestId: string): Promise<RunRecord>;
  /**
   * One atomic compare-and-set transition: the record must be at `expect`, or the call is refused
   * with `stale` and the current record, and moves nothing. `expect.state → next` must be an edge
   * of A4's machine. Evidence only grows, and a result goes in once, entering a final state.
   * Returns the record as it is after the call.
   */
  transitionRun(
    id: string,
    expect: RunExpected,
    next: RunState,
    patch?: RunPatch,
  ): Promise<RunRecord>;
  /** The run as it is now, or undefined. */
  readRun(id: string): Promise<RunRecord | undefined>;
  /**
   * Every run of that machine that is not final (OPEN_RUN_STATES), and every `unknown` one not yet
   * confirmed ended (`awaitsConfirmation`), oldest first.
   */
  openWork(machine: string): Promise<{ runs: RunRecord[] }>;
}

/** A4 3.16.1's execution store: both parts, and `openWork` with intents and runs. */
export interface ExecutionStore extends LaunchStore, RunStore {
  openWork(machine: string): Promise<{ intents: LaunchIntent[]; runs: RunRecord[] }>;
}

export type RefusalCode =
  /** The input or the change breaks a rule: a malformed ID, a missing reason, an illegal edge. */
  | "invalid"
  /** No intent has this ID, or the task or place it names is gone. */
  | "not_found"
  /** The intent is not in the expected state any more: another path moved it. Read `current`. */
  | "stale"
  /** The change would rewrite evidence the record holds. */
  | "evidence"
  /** The request ID was used for another click (A1 3.8). */
  | "request_id_reused"
  /** The store takes no write here: a read-only space, another space, an unknown actor. */
  | "unavailable";

/**
 * A call the store refused: nothing changed. A refusal is a decision, unlike a storage failure,
 * which leaves the outcome open (A1 3.8) and reaches the caller as the backend's own error.
 */
export class ExecutionRefused extends Error {
  override readonly name = "ExecutionRefused";
  readonly code: RefusalCode;
  /** The input path that broke a rule, such as `next` or `evidence.claim`. Never a value. */
  readonly field: string | undefined;
  /** The record as it is now, for `stale` and `evidence`. */
  readonly current: LaunchIntent | undefined;
  constructor(code: RefusalCode, message: string, field?: string, current?: LaunchIntent) {
    super(message);
    this.code = code;
    this.field = field;
    this.current = current;
  }
}

/** A call on a run the store refused: nothing changed. As ExecutionRefused, for a run record. */
export class RunRefused extends Error {
  override readonly name = "RunRefused";
  readonly code: RefusalCode;
  /** The input path that broke a rule, such as `next` or `patch.evidence.pid`. Never a value. */
  readonly field: string | undefined;
  /** The record as it is now, for `stale` and `evidence`. */
  readonly current: RunRecord | undefined;
  constructor(code: RefusalCode, message: string, field?: string, current?: RunRecord) {
    super(message);
    this.code = code;
    this.field = field;
    this.current = current;
  }
}

const ID = (prefix: string): RegExp => new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`);
export const TASK_ID = ID("t");
export const RUN_ID = ID("ru");
export const ROUTINE_ID = ID("ro");
export const MACHINE_ID = ID("m");
export const PLACE_ID = ID("pl");
export const SESSION_ID = ID("se");
export const LAUNCH_ID = ID("la");
/** An instance's key in machine.toml (A4 3.2): a short key of plain characters. */
export const INSTANCE_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEQ_MAX = 999_999_999_999_999;

function refuse(field: string, message: string): never {
  throw new ExecutionRefused("invalid", message, field === "" ? undefined : field);
}

const matches = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.test(value);

/**
 * Checks a click's input, as every backend does before it writes: IDs by their pattern, the route,
 * the brief's hash and the evidence's keys and kinds. The input may come from another thread, so
 * every field is checked at run time. Returns it without undefined values or unknown keys.
 */
export function checkNewIntent(value: unknown): NewIntent {
  if (typeof value !== "object" || value === null) return refuse("", "Expected an intent");
  const input = value as Record<string, unknown>;
  const { task, machine, instance, route, place, taskVersion, briefHash, session, evidence } =
    input;
  if (!matches(TASK_ID, task)) return refuse("task", "Expected a task ID");
  if (!matches(MACHINE_ID, machine)) return refuse("machine", "Expected a machine ID");
  if (!matches(INSTANCE_KEY, instance)) return refuse("instance", "Expected an instance key");
  if (!isRoute(route)) return refuse("route", "Expected a route");
  if (place !== null && !matches(PLACE_ID, place)) {
    return refuse("place", "Expected a place ID or null");
  }
  if (
    typeof taskVersion !== "number" ||
    !Number.isSafeInteger(taskVersion) ||
    taskVersion < 0 ||
    taskVersion > SEQ_MAX
  ) {
    return refuse("taskVersion", "Expected a task version");
  }
  if (!matches(SHA256, briefHash)) {
    return refuse("briefHash", "Expected a SHA-256 in lower-case hex");
  }
  if (session !== undefined && !matches(SESSION_ID, session)) {
    return refuse("session", "Expected a session ID");
  }
  const problem = evidence === undefined ? undefined : evidenceProblem(evidence);
  if (problem !== undefined) {
    return refuse(problem, "Evidence holds IDs, instants, counts and flags only");
  }
  const known = new Set(Object.keys(EMPTY_INTENT));
  if (Object.keys(input).some((key) => !known.has(key) && input[key] !== undefined)) {
    return refuse("", "The intent has a field it does not take");
  }
  return {
    task,
    machine,
    instance,
    route,
    place,
    taskVersion,
    briefHash,
    ...(session === undefined ? {} : { session }),
    ...(evidence === undefined ? {} : { evidence: cleanEvidence(evidence as Evidence) }),
  };
}

/** Every field a NewIntent may have, for the unknown-key check. */
const EMPTY_INTENT: Record<keyof NewIntent, null> = {
  task: null,
  machine: null,
  instance: null,
  route: null,
  place: null,
  taskVersion: null,
  briefHash: null,
  session: null,
  evidence: null,
};

/**
 * Checks a transition before any backend reads the record: a launch ID, an edge of A4's machine,
 * a reason exactly when it enters Failed or Unknown, and valid evidence. The compare-and-set on
 * `expect` and the evidence's growth are the backend's, inside its atomic step: a pure check of
 * `expect → next` here is equivalent to one there, because the step moves nothing unless the
 * state is `expect`.
 */
export function checkTransition(
  id: unknown,
  expected: unknown,
  next: unknown,
  outcome: unknown = {},
): CheckedTransition {
  if (!matches(LAUNCH_ID, id)) return refuse("id", "Expected a launch ID");
  let expect: unknown = expected;
  let version: number | undefined;
  if (typeof expected === "object" && expected !== null) {
    const { state, version: v, ...more } = expected as Record<string, unknown>;
    if (Object.values(more).some((x) => x !== undefined)) {
      return refuse("expect", "Expected a state and a version");
    }
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > SEQ_MAX) {
      return refuse("expect.version", "Expected a record version");
    }
    expect = state;
    version = v;
  }
  if (!isIntentState(expect)) return refuse("expect", "Expected a state");
  if (!isIntentState(next)) return refuse("next", "Expected a state");
  if (!isEdge(expect, next)) return refuse("next", "Not a transition of the launch state machine");
  if (typeof outcome !== "object" || outcome === null) return refuse("", "Expected an outcome");
  const { reason, evidence = {}, ...rest } = outcome as Record<string, unknown>;
  if (Object.values(rest).some((v) => v !== undefined)) {
    return refuse("", "The outcome has a field it does not take");
  }
  const entering = next !== expect;
  if (entering && (next === "failed" || next === "unknown")) {
    const fits = next === "failed" ? isFailReason(reason) : isUnknownReason(reason);
    if (!fits) return refuse("reason", "Failed and Unknown take a reason code of their own");
  } else if (reason !== undefined) {
    return refuse("reason", "Only entering Failed or Unknown takes a reason");
  }
  const problem = evidenceProblem(evidence);
  if (problem !== undefined) {
    return refuse(problem, "Evidence holds IDs, instants, counts and flags only");
  }
  const clean = cleanEvidence(evidence as Evidence);
  if (!entering && Object.keys(clean).length === 0) {
    return refuse("evidence", "A transition that keeps its state records evidence");
  }
  return {
    id,
    expect,
    ...(version === undefined ? {} : { version }),
    next,
    evidence: clean,
    ...(reason === undefined ? {} : { reason: reason as Reason }),
  };
}

/** A transition that passed `checkTransition`. */
export interface CheckedTransition {
  id: string;
  expect: IntentState;
  /** The version the record must still have, when the caller named one. */
  version?: number;
  next: IntentState;
  reason?: Reason;
  evidence: Evidence;
}

// ---------------------------------------------------------------------------------------------
// Runs (A4 3.11.2, 3.16.1)

function refuseRun(field: string, message: string): never {
  throw new RunRefused("invalid", message, field === "" ? undefined : field);
}

const utf8 = (text: string): number => new TextEncoder().encode(text).length;

/** A whole number within `bounds`. */
const within = (value: unknown, bounds: { min: number; max: number }): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= bounds.min &&
  value <= bounds.max;

/** The limits, checked against their bounds, without unknown keys. */
function checkLimits(value: unknown): RunLimits {
  if (typeof value !== "object" || value === null) return refuseRun("limits", "Expected limits");
  const { maxTurns, wallMs, idleMs, budgetUsd, ...more } = value as Record<string, unknown>;
  if (Object.values(more).some((v) => v !== undefined)) {
    return refuseRun("limits", "The limits have a field they do not take");
  }
  const b = RUN_LIMIT_BOUNDS;
  if (!within(maxTurns, b.maxTurns)) return refuseRun("limits.maxTurns", "Expected a turn limit");
  if (!within(wallMs, b.wallMs)) return refuseRun("limits.wallMs", "Expected a wall time");
  if (!within(idleMs, b.idleMs)) return refuseRun("limits.idleMs", "Expected an idle time");
  if (
    budgetUsd !== undefined &&
    (typeof budgetUsd !== "number" ||
      !Number.isFinite(budgetUsd) ||
      budgetUsd < b.budgetUsd.min ||
      budgetUsd > b.budgetUsd.max)
  ) {
    return refuseRun("limits.budgetUsd", "Expected a budget in dollars");
  }
  return { maxTurns, wallMs, idleMs, ...(budgetUsd === undefined ? {} : { budgetUsd }) };
}

/**
 * Checks a run's input, as every backend does before it writes: IDs by their pattern, exactly one
 * of task and routine, the adapter, the permission (never `inherit`, A4 3.11.6), the limits and the
 * request text's size. Returns it without undefined values or unknown keys.
 */
export function checkNewRun(value: unknown): NewRun {
  if (typeof value !== "object" || value === null) return refuseRun("", "Expected a run");
  const input = value as Record<string, unknown>;
  const { task, routine, machine, instance, adapter, place, session, request, briefHash } = input;
  const { permission, limits, ...more } = input;
  const known = new Set([
    "task",
    "routine",
    "machine",
    "instance",
    "adapter",
    "place",
    "session",
    "request",
    "briefHash",
  ]);
  if (Object.entries(more).some(([key, v]) => !known.has(key) && v !== undefined)) {
    return refuseRun("", "The run has a field it does not take");
  }
  if (task !== null && !matches(TASK_ID, task)) return refuseRun("task", "Expected a task ID");
  if (routine !== null && !matches(ROUTINE_ID, routine)) {
    return refuseRun("routine", "Expected a routine ID");
  }
  if ((task === null) === (routine === null)) {
    return refuseRun("task", "A run belongs to a task or a routine, exactly one");
  }
  if (!matches(MACHINE_ID, machine)) return refuseRun("machine", "Expected a machine ID");
  if (!matches(INSTANCE_KEY, instance)) return refuseRun("instance", "Expected an instance key");
  if (!(RUN_ADAPTERS as readonly unknown[]).includes(adapter)) {
    return refuseRun("adapter", "Expected a run adapter");
  }
  if (place !== null && !matches(PLACE_ID, place)) {
    return refuseRun("place", "Expected a place ID or null");
  }
  if (session !== undefined && !matches(SESSION_ID, session)) {
    return refuseRun("session", "Expected a session ID");
  }
  // A task's run needs the person's instruction (A4 3.11.7); a routine's takes its template. The
  // instruction is judged as the space stores it, so every backend keeps and refuses the same text.
  const stored = typeof request === "string" ? normaliseRunText(request) : request;
  if (routine !== null ? stored !== null : typeof stored !== "string" || stored.trim() === "") {
    return refuseRun("request", "A task's run takes an instruction, a routine's none");
  }
  if (typeof stored === "string" && utf8(stored) > RUN_REQUEST_MAX_BYTES) {
    return refuseRun("request", "The instruction is larger than its limit");
  }
  if (!matches(SHA256, briefHash)) {
    return refuseRun("briefHash", "Expected a SHA-256 in lower-case hex");
  }
  if (!(RUN_PERMISSIONS as readonly unknown[]).includes(permission)) {
    return refuseRun("permission", "A run takes a permission mode of its own, never inherit");
  }
  return {
    task,
    routine,
    machine,
    instance,
    adapter: adapter as NewRun["adapter"],
    place,
    ...(session === undefined ? {} : { session }),
    request: stored as string | null,
    briefHash,
    permission: permission as NewRun["permission"],
    limits: checkLimits(limits),
  };
}

/** The problem with run evidence as a path such as `patch.evidence.pid`, or undefined. */
export function runEvidenceProblem(evidence: unknown): string | undefined {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    return "patch.evidence";
  }
  for (const [key, value] of Object.entries(evidence)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(RUN_EVIDENCE_FIELDS, key)) return "patch.evidence";
    const kind = RUN_EVIDENCE_FIELDS[key as RunEvidenceKey];
    const fits =
      kind === "id"
        ? typeof value === "string" && RUN_EVIDENCE_ID.test(value)
        : isEvidenceValue(kind, value);
    if (!fits) return `patch.evidence.${key}`;
  }
  return undefined;
}

const isText = (value: unknown, cap: number): value is string | null =>
  value === null || (typeof value === "string" && utf8(value) <= cap);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;

/**
 * The problem with a run result as a path, or undefined. The answer within ANSWER_CAP_BYTES, the
 * error within TEXT_CAP_BYTES. Every object it reads is a plain object, never a list, as the writer
 * reads it: a list is an object with no keys to refuse, which one store would keep as a list and
 * another as an empty object.
 */
export function runResultProblem(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return "patch.result";
  }
  const r = result as Record<string, unknown>;
  const keys = [
    "ok",
    "outcome",
    "exitCode",
    "signal",
    "nativeId",
    "text",
    "textCut",
    "textFinal",
    "error",
    "usage",
    "appTools",
    "declined",
    "permissionDenials",
    "durationMs",
    "cleanup",
  ];
  if (Object.keys(r).some((key) => !keys.includes(key) && r[key] !== undefined)) {
    return "patch.result";
  }
  if (typeof r["ok"] !== "boolean") return "patch.result.ok";
  if (!(OUTCOME_REASONS as readonly unknown[]).includes(r["outcome"]))
    return "patch.result.outcome";
  // A signed or an unsigned 32-bit status (Windows reports NTSTATUS codes unsigned), as the writer.
  const code = r["exitCode"];
  if (
    code !== null &&
    (typeof code !== "number" ||
      !Number.isSafeInteger(code) ||
      code < -2_147_483_648 ||
      code > 4_294_967_295)
  ) {
    return "patch.result.exitCode";
  }
  const signal = r["signal"];
  if (signal !== null && (typeof signal !== "string" || !SIGNAL_NAME.test(signal))) {
    return "patch.result.signal";
  }
  const nativeId = r["nativeId"];
  if (nativeId !== null && (typeof nativeId !== "string" || !RUN_EVIDENCE_ID.test(nativeId))) {
    return "patch.result.nativeId";
  }
  if (!isText(r["text"], ANSWER_CAP_BYTES)) return "patch.result.text";
  for (const flag of ["textCut", "textFinal"]) {
    if (r[flag] !== undefined && typeof r[flag] !== "boolean") return `patch.result.${flag}`;
  }
  if (!isText(r["error"], TEXT_CAP_BYTES)) return "patch.result.error";
  const usage = r["usage"];
  if (usage !== null) {
    if (typeof usage !== "object" || Array.isArray(usage)) return "patch.result.usage";
    const fields = [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "costUsd",
    ];
    // Each a count or a cost the writer stores: finite, from 0 to the largest safe integer.
    for (const [key, n] of Object.entries(usage as Usage)) {
      if (n === undefined) continue;
      if (
        !fields.includes(key) ||
        typeof n !== "number" ||
        !Number.isFinite(n) ||
        n < 0 ||
        n > Number.MAX_SAFE_INTEGER
      ) {
        return "patch.result.usage";
      }
    }
  }
  const appTools = r["appTools"];
  if (appTools !== null && !(APP_TOOLS_STATES as readonly unknown[]).includes(appTools)) {
    return "patch.result.appTools";
  }
  const cleanup = r["cleanup"];
  if (cleanup !== undefined && !(RUN_CLEANUPS as readonly unknown[]).includes(cleanup)) {
    return "patch.result.cleanup";
  }
  if (!isCount(r["declined"])) return "patch.result.declined";
  if (!isCount(r["permissionDenials"])) return "patch.result.permissionDenials";
  const duration = r["durationMs"];
  if (duration !== null && !isEvidenceValue("instant", duration)) return "patch.result.durationMs";
  return undefined;
}

/** A run transition that passed `checkRunTransition`. */
export interface CheckedRunTransition {
  id: string;
  expect: RunExpected;
  next: RunState;
  reason?: RunReason;
  evidence: RunEvidence;
  result?: RunResult;
}

const isRunState = (value: unknown): value is RunState =>
  (RUN_STATES as readonly unknown[]).includes(value);

/**
 * Checks a run transition before any backend reads the record: a run ID, an expectation with a
 * version, an edge of A4's machine, a reason exactly when entering a state that takes one, valid
 * evidence, and a result only entering a final state. The compare-and-set, the evidence's growth
 * and the result's once-only rule are the backend's, inside its atomic step.
 */
export function checkRunTransition(
  id: unknown,
  expected: unknown,
  next: unknown,
  patch: unknown = {},
): CheckedRunTransition {
  if (!matches(RUN_ID, id)) return refuseRun("id", "Expected a run ID");
  if (typeof expected !== "object" || expected === null) {
    return refuseRun("expect", "Expected a state and a version");
  }
  const { state, version, ...more } = expected as Record<string, unknown>;
  if (Object.values(more).some((x) => x !== undefined)) {
    return refuseRun("expect", "Expected a state and a version");
  }
  if (!isRunState(state)) return refuseRun("expect.state", "Expected a state");
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    return refuseRun("expect.version", "Expected a record version");
  }
  if (!isRunState(next)) return refuseRun("next", "Expected a state");
  if (!isRunEdge(state, next))
    return refuseRun("next", "Not a transition of the run state machine");
  if (typeof patch !== "object" || patch === null) return refuseRun("patch", "Expected a patch");
  const { reason, evidence = {}, result, ...rest } = patch as Record<string, unknown>;
  if (Object.values(rest).some((v) => v !== undefined)) {
    return refuseRun("patch", "The patch has a field it does not take");
  }
  const entering = next !== state;
  if (entering && takesReason(next)) {
    if (!isRunReason(next, reason)) {
      return refuseRun("patch.reason", "This state takes a reason code of its own");
    }
  } else if (reason !== undefined) {
    return refuseRun("patch.reason", "Only entering failed, timed_out or unknown takes a reason");
  }
  const problem = runEvidenceProblem(evidence);
  if (problem !== undefined)
    return refuseRun(problem, "Evidence holds IDs, instants, counts and flags only");
  const final = (FINAL_RUN_STATES as readonly RunState[]).includes(next);
  let kept: RunResult | undefined;
  if (result !== undefined) {
    if (!entering || !final)
      return refuseRun("patch.result", "A result goes in entering a final state");
    // The agent's texts are cut, never refused, in the form the space stores them: what an agent
    // wrote must not keep its run from settling, and normalising can lengthen a text (A4 3.11.5).
    kept = cutResultTexts(result);
    const resultProblem = runResultProblem(kept);
    if (resultProblem !== undefined) return refuseRun(resultProblem, "Not a run result");
  }
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(evidence as object).sort()) {
    const v = (evidence as Record<string, unknown>)[key];
    if (v !== undefined) clean[key] = v;
  }
  if (!entering && Object.keys(clean).length === 0) {
    return refuseRun("patch.evidence", "A transition that keeps its state records evidence");
  }
  return {
    id,
    expect: { state, version },
    next,
    evidence: clean,
    ...(reason === undefined ? {} : { reason: reason }),
    ...(kept === undefined ? {} : { result: kept }),
  };
}

/**
 * A result with its answer and error normalised and cut (`cutRunText`): the answer to
 * ANSWER_CAP_BYTES, flagged `textCut` when that cut it, the error to TEXT_CAP_BYTES.
 */
export function cutResultTexts(result: unknown): RunResult {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return result as RunResult;
  }
  const r = result as Record<string, unknown>;
  const text = r["text"];
  const error = r["error"];
  if (typeof text !== "string") {
    return { ...r, error: typeof error === "string" ? cutRunText(error) : error } as RunResult;
  }
  const answer = cutRunAnswer(text);
  return {
    ...r,
    text: answer.text,
    ...(answer.cut ? { textCut: true } : {}),
    error: typeof error === "string" ? cutRunText(error) : error,
  } as unknown as RunResult;
}
