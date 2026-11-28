// Run records in the space database (A4 3.11, 3.16; A1 3.4): the v1 backend of A4's execution
// store writes them only through `run.create` and `run.transition`, two operations of the write
// path, so a run's record, its history and its request's receipt commit together. This module holds
// what the writer needs beyond its generic machinery: the writer's copy of A4's run rules, the
// statements, the record's JSON columns and the reads the execution store makes.
//
// A run is not a child of its task, as a launch is not: its changes carry no task, it moves neither
// the task's `touched` nor its projection, and it is never on an undo stack (A1 3.6). Its exit never
// changes its task (A4 3.11.5). It holds task text (the request, the result), so it keeps its
// task's create from being undone (A1 3.10, history.ts).
import type { Connection, Row } from "../driver.ts";
import { isId, type Id } from "../ids.ts";
import { invalidValue, RowReader } from "../rows.ts";
import { OPEN_SETS } from "../schema.ts";

/**
 * The writer's copy of A4's run rules (packages/contracts: RUN_STATES, RUN_EDGES, RUN_REASONS,
 * RUN_EVIDENCE_FIELDS and the limits). Every execution store checks them before it writes and the
 * writer checks them again, so no caller of the write path can move a run along another edge. A
 * runs test compares the copies (storage never imports contracts).
 */
export const RUN_STATES = OPEN_SETS["runs.state"];
export type RunState = (typeof RUN_STATES)[number];

export const OPEN_RUN_STATES = [
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "cancelling",
  "reconciling",
] as const satisfies readonly RunState[];

export const FINAL_RUN_STATES = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "unknown",
] as const satisfies readonly RunState[];

export const RUN_EDGES: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["starting", "cancelled", "failed"],
  starting: ["starting", "running", "failed", "cancelling", "cancelled", "reconciling", "unknown"],
  running: [
    "running",
    "waiting_for_input",
    "succeeded",
    "failed",
    "timed_out",
    "cancelling",
    "reconciling",
  ],
  waiting_for_input: ["waiting_for_input", "running", "cancelling", "reconciling"],
  cancelling: ["cancelling", "cancelled", "unknown", "reconciling"],
  reconciling: ["succeeded", "failed", "timed_out", "cancelled", "unknown"],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  unknown: ["reconciling", "succeeded", "failed", "timed_out", "cancelled"],
};

export const RUN_REASONS: Readonly<Partial<Record<RunState, readonly string[]>>> = {
  failed: [
    "task_closed",
    "instance_gone",
    "not_for_space",
    "folder_gone",
    "spawn_failed",
    "start_timed_out",
    "service_ended",
    "restored",
    "agent_error",
    "interrupted",
    "max_turns",
    "max_budget",
    "exit_status",
    "no_result",
    "no_output",
    "needs_input",
  ],
  timed_out: ["wall", "idle"],
  unknown: ["stop_timed_out"],
};

export const RUN_EVIDENCE_FIELDS = {
  pid: "count",
  pid_started_at: "instant",
  native_id: "id",
  home: "id",
  process_group: "id",
  folder_id: "id",
} as const satisfies Record<string, "id" | "instant" | "count">;

/** An ID in a run's evidence or result: plain characters only. */
export const RUN_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const RUN_PERMISSIONS = ["full-access", "auto-edit", "read-only"] as const;

/** The outcome reasons of the stream parsers (A4 3.11.4), which a result records. */
export const RUN_OUTCOMES = [
  "success",
  "agent_error",
  "interrupted",
  "max_turns",
  "max_budget",
  "exit_status",
  "no_result",
  "no_output",
  "needs_input",
] as const;

/** How a run's processes ended, which a result records. */
export const RUN_CLEANUPS = ["confirmed", "ended_leftovers", "ended_found"] as const;

export const RUN_APP_TOOLS = ["connected", "not-connected", "absent"] as const;

/** A run's error, at most this many UTF-8 bytes (A4 3.11.5). */
export const RUN_TEXT_MAX_BYTES = 8 * 1024;

/** A run's answer (its result's text), at most this many UTF-8 bytes. */
export const RUN_RESULT_TEXT_MAX_BYTES = 1024 * 1024;

/** The person's instruction for a run, at most this many UTF-8 bytes (a note's size, A1 3.7). */
export const RUN_REQUEST_MAX_BYTES = 64 * 1024;

export const RUN_LIMIT_BOUNDS = {
  maxTurns: { min: 1, max: 10_000 },
  wallMs: { min: 1_000, max: 24 * 60 * 60_000 },
  idleMs: { min: 1_000, max: 24 * 60 * 60_000 },
  budgetUsd: { min: 0, max: 100_000 },
} as const;

/** A run's evidence: one of A4's keys to a value of that key's kind. */
export type RunEvidence = Record<string, string | number | boolean>;

/** A run's limits as the record stores them, in its `spec`. */
export interface RunLimitsRow {
  max_turns: number;
  /** Absent: no wall time. */
  wall_ms?: number;
  /** Absent: no idle time. */
  idle_ms?: number;
  budget_usd?: number;
}

/** What a run fixes when it is queued (its `spec` column), written once. */
export interface RunSpec {
  brief_hash: string;
  permission: string;
  limits: RunLimitsRow;
}

/** A run's final outcome (its `result` column), written once, entering a final state. */
export interface RunResultRow {
  ok: boolean;
  outcome: string;
  exit_code: number | null;
  signal: string | null;
  native_id: string | null;
  text: string | null;
  /** The answer was cut to RUN_RESULT_TEXT_MAX_BYTES. Absent means false. */
  text_cut?: boolean;
  /** The agent finished its turn with this answer. Absent means false. */
  text_final?: boolean;
  error: string | null;
  usage: Record<string, number> | null;
  app_tools: string | null;
  declined: number;
  permission_denials: number;
  duration_ms: number | null;
  /** How the run's processes ended. Absent on a result written before it was kept. */
  cleanup?: string;
}

/** The usage keys a result may hold, each a non-negative number. */
export const RUN_USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "cost_usd",
] as const;

/** A run's `detail`: its evidence and the time it entered each state. */
export interface RunDetail {
  evidence: RunEvidence;
  at: Partial<Record<RunState, number>>;
}

export const RUN_SQL = {
  run: "SELECT * FROM runs WHERE id = $id",
  place: "SELECT machine_id, deleted_at FROM places WHERE id = $id",
  insert:
    "INSERT INTO runs (id, task_id, routine_id, session_id, instance_id, machine_id, adapter, " +
    "place_id, request, spec, state, reason, attempt, detail, result, queued_at, started_at, " +
    "ended_at, created_seq, version, fv, fp) VALUES ($id, $task, $routine, $session, $instance, " +
    "$machine, $adapter, $place, $request, $spec, 'queued', NULL, 1, $detail, '{}', $at, NULL, " +
    "NULL, $seq, $seq, '{}', '{}')",
  update:
    "UPDATE runs SET state = $state, reason = $reason, detail = $detail, result = $result, " +
    "started_at = $started_at, ended_at = $ended_at WHERE id = $id",
  versions: "UPDATE runs SET version = $seq, fv = $fv, fp = $fp WHERE id = $id",
  // The same condition as the `runs_open` index's (0003), so the read uses that index.
  open:
    "SELECT * FROM runs WHERE machine_id = $machine AND (state IN ('queued','starting'," +
    "'running','waiting_for_input','cancelling','reconciling') OR (state = 'unknown' AND " +
    "reason = 'stop_timed_out')) ORDER BY queued_at, id",
} as const;

/** One spelling of a JSON object: keys in order, so the same value is the same text. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );
}

/** The one spelling of a detail: the times in A4's state order, the evidence by key. */
export function runDetailText(detail: RunDetail): string {
  const at: Record<string, number> = {};
  for (const state of RUN_STATES) {
    const value = detail.at[state];
    if (value !== undefined) at[state] = value;
  }
  return sortedJson({ at, evidence: detail.evidence });
}

/** A run row as the execution store reads it, checked against its domain. */
export interface RunRow {
  id: Id<"ru">;
  task_id: Id<"t"> | null;
  routine_id: Id<"ro"> | null;
  session_id: Id<"se"> | null;
  instance_id: string;
  machine_id: Id<"m">;
  adapter: string;
  place_id: Id<"pl"> | null;
  request: string | null;
  spec: RunSpec;
  state: RunState;
  reason: string | null;
  attempt: number;
  evidence: RunEvidence;
  at: Partial<Record<RunState, number>>;
  result: RunResultRow | null;
  queued_at: number;
  started_at: number | null;
  ended_at: number | null;
  version: number;
}

const ADAPTERS: readonly string[] = OPEN_SETS["runs.adapter"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A run's evidence with the key that once named its process group, `container`, read as
 * `process_group`, so the next write of the run keeps only the new key. Kept until step 2's
 * tables, into which the spaces made before it are moved by hand.
 */
function renamed(evidence: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(evidence, "container")) return evidence;
  const { container, ...rest } = evidence;
  return { process_group: container, ...rest };
}

/**
 * Decodes a run row, or SPACE_INVALID naming the column (never the value). The JSON columns are
 * checked for their shape; the execution store checks each key against A4's lists.
 */
export function decodeRun(row: Row): RunRow {
  const r = new RowReader("runs", row);
  const detail = r.json("detail");
  if (!isObject(detail) || !isObject(detail["evidence"]) || !isObject(detail["at"])) {
    throw invalidValue("runs", "detail");
  }
  const at: Partial<Record<RunState, number>> = {};
  for (const [state, value] of Object.entries(detail["at"])) {
    if (!RUN_STATES.includes(state as RunState) || typeof value !== "number") {
      throw invalidValue("runs", "detail");
    }
    at[state as RunState] = value;
  }
  const spec = r.json("spec");
  if (!isObject(spec) || !isObject(spec["limits"])) throw invalidValue("runs", "spec");
  const result = r.json("result");
  if (!isObject(result)) throw invalidValue("runs", "result");
  return {
    id: r.id("id", "ru"),
    task_id: r.optText("task_id", (v) => isId(v, "t")) as Id<"t"> | null,
    routine_id: r.optText("routine_id", (v) => isId(v, "ro")) as Id<"ro"> | null,
    session_id: r.optText("session_id", (v) => isId(v, "se")) as Id<"se"> | null,
    instance_id: r.text("instance_id"),
    machine_id: r.id("machine_id", "m"),
    adapter: r.text("adapter", (v) => ADAPTERS.includes(v)),
    place_id: r.optText("place_id", (v) => isId(v, "pl")) as Id<"pl"> | null,
    request: r.optText("request"),
    spec: spec as unknown as RunSpec,
    state: r.oneOf("state", RUN_STATES),
    reason: r.optText("reason"),
    attempt: r.int("attempt", "count"),
    evidence: renamed(detail["evidence"]) as RunEvidence,
    at,
    result: Object.keys(result).length === 0 ? null : (result as unknown as RunResultRow),
    queued_at: r.int("queued_at", "instant"),
    started_at: r.optInt("started_at", "instant"),
    ended_at: r.optInt("ended_at", "instant"),
    version: r.int("version", "seq"),
  };
}

/** The run with this ID, on `conn`, or undefined. */
export function readRun(conn: Connection, id: string): RunRow | undefined {
  if (!isId(id, "ru")) return undefined;
  const row = conn.prepare(RUN_SQL.run).get({ id });
  return row === undefined ? undefined : decodeRun(row);
}

/**
 * Every run of `machine` that is not final, and every `unknown` one whose stop timed out, which a
 * later exit still settles: oldest first (A4 3.11.9, 3.16.1 `openWork`).
 */
export function readOpenRuns(conn: Connection, machine: string): RunRow[] {
  if (!isId(machine, "m")) return [];
  return conn.prepare(RUN_SQL.open).all({ machine }).map(decodeRun);
}
