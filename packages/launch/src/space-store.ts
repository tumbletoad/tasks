// The v1 execution store: the space database (A4 3.16.1, X7). Each call is one A1 operation,
// `launch.create`, `launch.transition`, `run.create` or `run.transition`, sent to the space's writer, which commits the record, its
// history and the request's receipt in one transaction (A1 3.7). Reads go to the
// same writer, behind the requests sent before them. Launch code never imports storage (A7 3.2):
// the writer reaches this store as a port, the in-thread SpaceWriter in tests and the worker's
// SpaceWriterHandle in the service, which both fit it.
import {
  EVIDENCE_FIELDS,
  INTENT_STATES,
  isEvidenceValue,
  isFailReason,
  isIntentState,
  isLaunchRef,
  isRoute,
  isUnknownReason,
  type EvidenceKey,
  type IntentState,
} from "./intents.ts";
import {
  APP_TOOLS_STATES,
  OUTCOME_REASONS,
  RUN_ADAPTERS,
  RUN_CLEANUPS,
  RUN_EVIDENCE_FIELDS,
  RUN_PERMISSIONS,
  RUN_STATES,
  isRunReason,
  type AppToolsState,
  type NewRun,
  type OutcomeReason,
  type RunCleanup,
  type RunPatch,
  type RunRecord,
  type RunResult,
  type RunState,
  type Usage,
} from "@ttasks/contracts/runs";
import {
  checkNewIntent,
  checkNewRun,
  checkRunTransition,
  checkTransition,
  ExecutionRefused,
  LAUNCH_ID,
  RUN_ID,
  RunRefused,
  runEvidenceProblem,
  runResultProblem,
  type ExecutionStore,
  type Expected,
  type LaunchIntent,
  type NewIntent,
  type Outcome,
  type RefusalCode,
  type RunExpected,
} from "./store.ts";

type MaybePromise<T> = T | Promise<T>;

/** A launch row as the space's writer reads it back (storage: `LaunchRecord`). */
export interface SpaceLaunchRow {
  id: string;
  reference: string;
  task_id: string | null;
  session_id: string | null;
  instance_id: string;
  machine_id: string;
  route: string;
  place_id: string | null;
  task_version: number | null;
  brief_hash: string | null;
  state: string;
  reason: string | null;
  evidence: Readonly<Record<string, unknown>>;
  at: Readonly<Record<string, unknown>>;
  created_at: number;
  updated_at: number;
  version: number;
}

/**
 * A run row as the space's writer reads it back (storage: `RunRow`): its JSON columns decoded, each
 * key checked here against A4's lists.
 */
export interface SpaceRunRow {
  id: string;
  task_id: string | null;
  routine_id: string | null;
  session_id: string | null;
  instance_id: string;
  machine_id: string;
  adapter: string;
  place_id: string | null;
  request: string | null;
  spec: object;
  state: string;
  reason: string | null;
  attempt: number;
  evidence: Readonly<Record<string, unknown>>;
  at: Readonly<Record<string, unknown>>;
  result: object | null;
  queued_at: number;
  started_at: number | null;
  ended_at: number | null;
  version: number;
}

/** The part of a write result this store reads (storage: `WriteResult`). */
export interface SpaceWriteResult {
  status: string;
  results: readonly { id: string }[];
  error?: { code: string; message: string; field?: string };
}

/**
 * The credential the store's requests carry (A1 3.21; storage: `Credential`). The writer refuses
 * launch operations from any actor but a human or the space's system (R7).
 */
export interface SpaceCredential {
  scope_id: string;
  principal_id: string;
  actor_kind: string;
  machine_id: string;
  origin: string;
}

/** The space's writer, as this store needs it. */
export interface SpaceWriterPort {
  submit(request: SpaceWriteRequest): MaybePromise<SpaceWriteResult>;
  launch(id: string): MaybePromise<SpaceLaunchRow | null | undefined>;
  openLaunches(machine: string): MaybePromise<readonly SpaceLaunchRow[]>;
  run(id: string): MaybePromise<SpaceRunRow | null | undefined>;
  openRuns(machine: string): MaybePromise<readonly SpaceRunRow[]>;
  /**
   * A request's receipt in a writer scope (storage: `receipt`, A1 3.8), read only: whether the
   * scope already decided a request with this ID. Behind the requests sent before it.
   */
  receipt(lookup: {
    scope_id: string;
    request_id: string;
  }): MaybePromise<SpaceReceipt | null | undefined>;
}

/** The part of a request's receipt this store reads (storage: `Receipt`). */
export interface SpaceReceipt {
  readonly request_id: string;
  readonly status?: string;
  /** The stored result, as a replay returns it. */
  readonly result?: { readonly results: readonly { readonly id: string }[] };
}

/** A write request with launch operations (storage: `WriteRequest`). */
export interface SpaceWriteRequest {
  space_id: string;
  request_id: string;
  actor: SpaceCredential;
  ops: Record<string, unknown>[];
}

export interface SpaceExecutionStoreOptions {
  writer: SpaceWriterPort;
  spaceId: string;
  /**
   * Who writes the records: the person who clicked (A4 3.16: `created_by = user`), in the writer
   * scope of the service's launch path. Its machine is the one the records belong to.
   */
  credential: SpaceCredential;
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A fresh request ID for each transition call: 130 random bits. A call is never repeated under the
 * same ID: a transition whose answer was lost leaves its outcome open (A1 3.8), and the caller
 * reads the record again instead. The compare-and-set then refuses the repeat of a transition that
 * did commit, so no caller can take a lost answer as permission to act twice.
 */
function transitionRequestId(): string {
  const bytes = new Uint8Array(26);
  globalThis.crypto.getRandomValues(bytes);
  return `launch-${Array.from(bytes, (b) => ALPHABET.charAt(b % 32)).join("")}`;
}

export class SpaceExecutionStore implements ExecutionStore {
  readonly #writer: SpaceWriterPort;
  readonly #spaceId: string;
  readonly #credential: SpaceCredential;

  constructor(options: SpaceExecutionStoreOptions) {
    this.#writer = options.writer;
    this.#spaceId = options.spaceId;
    this.#credential = options.credential;
  }

  async createIntent(value: NewIntent, requestId: string): Promise<LaunchIntent> {
    const input = checkNewIntent(value);
    if (input.machine !== this.#credential.machine_id) {
      throw new ExecutionRefused("invalid", "This store writes for its own machine", "machine");
    }
    const result = await this.#submit(requestId, {
      kind: "launch.create",
      task: input.task,
      instance: input.instance,
      route: input.route,
      place: input.place,
      task_version: input.taskVersion,
      brief_hash: input.briefHash,
      ...(input.session === undefined ? {} : { session: input.session }),
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
    const id = result.results[0]?.id;
    if (result.error !== undefined || id === undefined) throw refusal(result);
    return this.#read(id);
  }

  async transitionIntent(
    id: string,
    expect: Expected,
    next: IntentState,
    outcome?: Outcome,
  ): Promise<LaunchIntent> {
    const change = checkTransition(id, expect, next, outcome);
    const result = await this.#submit(transitionRequestId(), {
      kind: "launch.transition",
      launch: change.id,
      expect: change.expect,
      ...(change.version === undefined ? {} : { expect_version: change.version }),
      next: change.next,
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(Object.keys(change.evidence).length === 0 ? {} : { evidence: change.evidence }),
    });
    if (result.error === undefined) return this.#read(change.id);
    const refused = refusal(result);
    if (refused.code === "stale" || refused.code === "evidence") {
      const current = await this.readIntent(change.id);
      throw new ExecutionRefused(refused.code, refused.message, refused.field, current);
    }
    throw refused;
  }

  /**
   * Whether this store's writer scope already decided a request with this ID (A1 3.8), read only.
   * Then `createIntent` with it replays that decision (the same intent, as it is now) or refuses it
   * as `request_id_reused`, and never makes a new intent: a check that guards only a new intent
   * must not stand in front of its replay.
   */
  async decided(requestId: string): Promise<boolean> {
    const found = await this.#writer.receipt({
      scope_id: this.#credential.scope_id,
      request_id: requestId,
    });
    return found !== null && found !== undefined;
  }

  /**
   * The intent a request this scope already decided made (or was given by A4's 5 s rule), as it
   * is now: a replay read from the receipt alone, before anything the click would be built from is
   * read again (A1 3.8). Undefined when the scope has not decided the request or it made no
   * intent; `createIntent` then decides it, a refusal included. Read only.
   */
  async replayed(requestId: string): Promise<LaunchIntent | undefined> {
    const found = await this.#writer.receipt({
      scope_id: this.#credential.scope_id,
      request_id: requestId,
    });
    if (found === null || found === undefined) return undefined;
    if (found.status !== "applied" && found.status !== "unchanged") return undefined;
    const id = found.result?.results[0]?.id;
    return id === undefined ? undefined : this.readIntent(id);
  }

  async readIntent(id: string): Promise<LaunchIntent | undefined> {
    if (!LAUNCH_ID.test(id)) return undefined;
    const row = await this.#writer.launch(id);
    return row === null || row === undefined ? undefined : decodeLaunch(row);
  }

  async openWork(machine: string): Promise<{ intents: LaunchIntent[]; runs: RunRecord[] }> {
    const rows = await this.#writer.openLaunches(machine);
    const runs = await this.#writer.openRuns(machine);
    return { intents: rows.map(decodeLaunch), runs: runs.map(decodeRun) };
  }

  async createRun(value: NewRun, requestId: string): Promise<RunRecord> {
    const input = checkNewRun(value);
    if (input.machine !== this.#credential.machine_id) {
      throw new RunRefused("invalid", "This store writes for its own machine", "machine");
    }
    const { limits } = input;
    const result = await this.#submit(requestId, {
      kind: "run.create",
      ...(input.task === null ? {} : { task: input.task }),
      ...(input.routine === null ? {} : { routine: input.routine }),
      instance: input.instance,
      adapter: input.adapter,
      place: input.place,
      ...(input.session === undefined ? {} : { session: input.session }),
      ...(input.request === null ? {} : { request: input.request }),
      brief_hash: input.briefHash,
      permission: input.permission,
      limits: {
        max_turns: limits.maxTurns,
        wall_ms: limits.wallMs,
        idle_ms: limits.idleMs,
        ...(limits.budgetUsd === undefined ? {} : { budget_usd: limits.budgetUsd }),
      },
    });
    const id = result.results[0]?.id;
    if (result.error !== undefined || id === undefined) throw runRefusal(result);
    return this.#readRunOrThrow(id);
  }

  async transitionRun(
    id: string,
    expect: RunExpected,
    next: RunState,
    patch?: RunPatch,
  ): Promise<RunRecord> {
    const change = checkRunTransition(id, expect, next, patch);
    const result = await this.#submit(transitionRequestId(), {
      kind: "run.transition",
      run: change.id,
      expect: change.expect.state,
      expect_version: change.expect.version,
      next: change.next,
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(Object.keys(change.evidence).length === 0 ? {} : { evidence: change.evidence }),
      ...(change.result === undefined ? {} : { result: resultRow(change.result) }),
    });
    if (result.error === undefined) return this.#readRunOrThrow(change.id);
    const refused = runRefusal(result);
    if (refused.code === "stale" || refused.code === "evidence") {
      const current = await this.readRun(change.id);
      throw new RunRefused(refused.code, refused.message, refused.field, current);
    }
    throw refused;
  }

  async readRun(id: string): Promise<RunRecord | undefined> {
    if (!RUN_ID.test(id)) return undefined;
    const row = await this.#writer.run(id);
    return row === null || row === undefined ? undefined : decodeRun(row);
  }

  async #readRunOrThrow(id: string): Promise<RunRecord> {
    const run = await this.readRun(id);
    if (run === undefined) throw new Error("A run the writer returned is not there");
    return run;
  }

  async #read(id: string): Promise<LaunchIntent> {
    const intent = await this.readIntent(id);
    if (intent === undefined) throw new Error("A launch the writer returned is not there");
    return intent;
  }

  async #submit(requestId: string, op: Record<string, unknown>): Promise<SpaceWriteResult> {
    return this.#writer.submit({
      space_id: this.#spaceId,
      request_id: requestId,
      actor: this.#credential,
      ops: [op],
    });
  }
}

/** The refusal a rejected request means. The writer's message is a fixed sentence. */
function refusal(result: SpaceWriteResult): ExecutionRefused {
  const error = result.error ?? { code: "INTERNAL", message: "The writer returned no result" };
  // The writer names a field of the one operation, with or without its `ops[0].` prefix.
  const field = error.field?.replace(/^ops\[0\]\./, "");
  let code: RefusalCode;
  switch (error.code) {
    case "INVALID_TRANSITION":
      code = field?.startsWith("evidence") === true ? "evidence" : "stale";
      break;
    case "NOT_FOUND":
    case "DELETED":
      code = "not_found";
      break;
    case "REQUEST_ID_REUSED":
      code = "request_id_reused";
      break;
    case "VALIDATION_FAILED":
    case "REQUEST_ID_INVALID":
    case "TOO_LARGE":
      code = "invalid";
      break;
    default:
      code = "unavailable";
  }
  return new ExecutionRefused(code, error.message, field);
}

/** A launch row as a LaunchIntent, checked: a row that is not one is a damaged space. */
export function decodeLaunch(row: SpaceLaunchRow): LaunchIntent {
  const bad = (column: string): never => {
    throw new Error(`A launch row holds an invalid ${column}`);
  };
  const { state, route, reason } = row;
  if (!LAUNCH_ID.test(row.id)) bad("id");
  if (!isLaunchRef(row.reference)) bad("reference");
  if (!isIntentState(state)) return bad("state");
  if (!isRoute(route)) return bad("route");
  if (reason !== null && !isFailReason(reason) && !isUnknownReason(reason)) return bad("reason");
  const at: Partial<Record<IntentState, number>> = {};
  for (const [key, value] of Object.entries(row.at)) {
    if (!isIntentState(key) || typeof value !== "number") return bad("at");
    at[key] = value;
  }
  // A4's keys, checked by their kind. A key a newer build added is left out, not refused: the
  // writer has checked its shape, and evidence only grows.
  const evidence: Record<string, unknown> = {};
  for (const key of Object.keys(row.evidence).sort()) {
    if (!Object.hasOwn(EVIDENCE_FIELDS, key)) continue;
    const value = row.evidence[key];
    if (!isEvidenceValue(EVIDENCE_FIELDS[key as EvidenceKey], value)) return bad("evidence");
    evidence[key] = value;
  }
  return {
    id: row.id,
    reference: row.reference,
    task: row.task_id,
    session: row.session_id,
    machine: row.machine_id,
    instance: row.instance_id,
    route,
    place: row.place_id,
    folderKind: row.place_id === null ? "work_folder" : "place",
    taskVersion: row.task_version,
    briefHash: row.brief_hash,
    state,
    reason,
    evidence,
    at: Object.fromEntries(INTENT_STATES.flatMap((s) => (s in at ? [[s, at[s]]] : []))),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/** The refusal a rejected run request means: as a launch's, for a run record. */
function runRefusal(result: SpaceWriteResult): RunRefused {
  const launch = refusal(result);
  // The writer names a run's patch fields bare (`result.usage`, `evidence.claim`, `reason`): they
  // are named as every store names them, under `patch.`. A result the record holds is held data,
  // as evidence is, not a record that moved on.
  const held = launch.code === "stale" && launch.field === "result";
  const patchField = /^(?:result|evidence|reason)(?:\.|$)/u.test(launch.field ?? "");
  const field = patchField ? `patch.${launch.field ?? ""}` : launch.field;
  return new RunRefused(held ? "evidence" : launch.code, launch.message, field);
}

/** A run result as the writer stores it, in its column's snake case. */
function resultRow(result: RunResult): Record<string, unknown> {
  const usage =
    result.usage === null
      ? null
      : Object.fromEntries(
          Object.entries(USAGE_KEYS).flatMap(([camel, snake]) => {
            const value = result.usage?.[camel as keyof Usage];
            return value === undefined ? [] : [[snake, value]];
          }),
        );
  return {
    ok: result.ok,
    outcome: result.outcome,
    exit_code: result.exitCode,
    signal: result.signal,
    native_id: result.nativeId,
    text: result.text,
    ...(result.textCut === undefined ? {} : { text_cut: result.textCut }),
    ...(result.textFinal === undefined ? {} : { text_final: result.textFinal }),
    error: result.error,
    usage,
    app_tools: result.appTools,
    declined: result.declined,
    permission_denials: result.permissionDenials,
    duration_ms: result.durationMs,
    ...(result.cleanup === undefined ? {} : { cleanup: result.cleanup }),
  };
}

const USAGE_KEYS = {
  inputTokens: "input_tokens",
  cachedInputTokens: "cached_input_tokens",
  outputTokens: "output_tokens",
  reasoningOutputTokens: "reasoning_output_tokens",
  costUsd: "cost_usd",
} as const satisfies Record<keyof Usage, string>;

const isOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  values.includes(value as T);

/** A run row as a RunRecord, checked: a row that is not one is a damaged space. */
export function decodeRun(row: SpaceRunRow): RunRecord {
  const bad = (column: string): never => {
    throw new Error(`A run row holds an invalid ${column}`);
  };
  const { state, adapter, reason } = row;
  const spec = row.spec as Readonly<Record<string, unknown>>;
  if (!RUN_ID.test(row.id)) bad("id");
  if (!isOf(RUN_STATES, state)) return bad("state");
  if (!isOf(RUN_ADAPTERS, adapter)) return bad("adapter");
  if (reason !== null && !isRunReason(state, reason) && !isFinalReason(reason))
    return bad("reason");
  const limits = spec["limits"] as Record<string, unknown> | undefined;
  const permission = spec["permission"];
  const briefHash = spec["brief_hash"];
  if (!isOf(RUN_PERMISSIONS, permission) || typeof briefHash !== "string") return bad("spec");
  if (
    limits === undefined ||
    typeof limits["max_turns"] !== "number" ||
    typeof limits["wall_ms"] !== "number" ||
    typeof limits["idle_ms"] !== "number"
  ) {
    return bad("spec");
  }
  const at: Partial<Record<RunState, number>> = {};
  for (const [key, value] of Object.entries(row.at)) {
    if (!isOf(RUN_STATES, key) || typeof value !== "number") return bad("at");
    at[key] = value;
  }
  // A4's keys, checked by their kind. A key a newer build added is left out, not refused: the
  // writer has checked its shape, and evidence only grows.
  const evidence: Record<string, unknown> = {};
  for (const key of Object.keys(row.evidence).sort()) {
    if (!Object.hasOwn(RUN_EVIDENCE_FIELDS, key)) continue;
    const value = row.evidence[key];
    if (runEvidenceProblem({ [key]: value }) !== undefined) return bad("evidence");
    evidence[key] = value;
  }
  const result =
    row.result === null ? null : decodeResult(row.result as Readonly<Record<string, unknown>>);
  if (result === undefined) return bad("result");
  const budget = limits["budget_usd"];
  return {
    id: row.id,
    task: row.task_id,
    routine: row.routine_id,
    session: row.session_id,
    machine: row.machine_id,
    instance: row.instance_id,
    adapter,
    place: row.place_id,
    folderKind: row.place_id === null ? "work_folder" : "place",
    request: row.request,
    briefHash,
    permission,
    limits: {
      maxTurns: limits["max_turns"],
      wallMs: limits["wall_ms"],
      idleMs: limits["idle_ms"],
      ...(typeof budget === "number" ? { budgetUsd: budget } : {}),
    },
    state,
    reason: reason as RunRecord["reason"],
    attempt: row.attempt,
    evidence: evidence,
    at: Object.fromEntries(RUN_STATES.flatMap((s) => (s in at ? [[s, at[s]]] : []))),
    result,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    version: row.version,
  };
}

/** A reason a record may keep from a final state it entered before (unknown, then settled). */
function isFinalReason(reason: string): boolean {
  return (["failed", "timed_out", "unknown"] as const).some((s) => isRunReason(s, reason));
}

/** A stored result as a RunResult, or undefined when it is not one. */
function decodeResult(row: Readonly<Record<string, unknown>>): RunResult | undefined {
  const usageRow = row["usage"] as Record<string, unknown> | null | undefined;
  let usage: Usage | null = null;
  if (usageRow !== null && usageRow !== undefined) {
    const out: Record<string, number> = {};
    for (const [camel, snake] of Object.entries(USAGE_KEYS)) {
      const value = usageRow[snake];
      if (typeof value === "number") out[camel] = value;
    }
    usage = out;
  }
  const result: RunResult = {
    ok: row["ok"] as boolean,
    outcome: row["outcome"] as OutcomeReason,
    exitCode: (row["exit_code"] ?? null) as number | null,
    signal: (row["signal"] ?? null) as string | null,
    nativeId: (row["native_id"] ?? null) as string | null,
    text: (row["text"] ?? null) as string | null,
    ...(row["text_cut"] === undefined ? {} : { textCut: row["text_cut"] as boolean }),
    ...(row["text_final"] === undefined ? {} : { textFinal: row["text_final"] as boolean }),
    error: (row["error"] ?? null) as string | null,
    usage,
    appTools: (row["app_tools"] ?? null) as AppToolsState | null,
    declined: row["declined"] as number,
    permissionDenials: row["permission_denials"] as number,
    durationMs: (row["duration_ms"] ?? null) as number | null,
    ...(row["cleanup"] === undefined ? {} : { cleanup: row["cleanup"] as RunCleanup }),
  };
  if (!isOf(OUTCOME_REASONS, result.outcome)) return undefined;
  if (result.cleanup !== undefined && !isOf(RUN_CLEANUPS, result.cleanup)) return undefined;
  if (result.appTools !== null && !isOf(APP_TOOLS_STATES, result.appTools)) return undefined;
  return runResultProblem(result) === undefined ? result : undefined;
}
