// The execution store (A4 3.16.1, X7): the one interface through which launch intents are written.
// Launch code never writes a record any other way. v1's backend is the space database, where each
// call is one A1 operation in one transaction (space-store.ts). From L1 a machine without authority
// writes the same interface to a machine-local journal (A6). One contract suite runs against every
// backend (test/execution-store-contract.ts).
//
// This step brings the launch part of A4's interface. Sessions (`upsertSession`), runs
// (`createRun`, `transitionRun`, M6.01) and occurrences (`decideOccurrence`, M9) join it with the
// steps that write those records, and `openWork` then returns runs beside intents.
import {
  cleanEvidence,
  evidenceProblem,
  isEdge,
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

export interface ExecutionStore {
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

const ID = (prefix: string): RegExp => new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`);
export const TASK_ID = ID("t");
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
