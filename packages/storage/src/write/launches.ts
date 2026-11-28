// Launch records in the space database (A4 3.9, 3.16; A1 3.4): the v1 backend of A4's execution
// store writes them only through `launch.create` and `launch.transition`, two operations of the
// write path, so a launch's record, its history and its request's receipt commit together. This
// module holds what the writer needs beyond its generic machinery: the statements, the launch
// reference, the compare-and-set and evidence rules, and the reads the execution store makes.
//
// A launch is not a child of its task: its changes carry no task, it moves neither the task's
// `touched` nor its projection, and it is never on an undo stack (A1 3.6).
import type { Connection, Row } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { isId, type Id, type RandomSource } from "../ids.ts";
import { invalidValue, RowReader } from "../rows.ts";
import { OPEN_SETS } from "../schema.ts";
import { LAUNCH_STATES, type LaunchEvidence, type LaunchState } from "./request.ts";

/**
 * A4 3.9.1's edges. A self edge records evidence only. A4 owns this table (packages/launch:
 * EDGES), and every execution store checks it before it writes; the writer checks it again, so
 * no caller of the write path can move a launch along another edge. A test compares the two.
 */
export const LAUNCH_EDGES: Readonly<Record<LaunchState, readonly LaunchState[]>> = {
  prepared: ["dispatching", "failed"],
  dispatching: ["dispatching", "dispatched", "confirmed", "failed", "unknown"],
  dispatched: ["dispatched", "confirmed", "failed", "unknown"],
  confirmed: ["confirmed"],
  failed: [],
  unknown: ["confirmed", "failed"],
};

/** The states recovery reads (A4 3.16.1 `openWork`): not final. */
export const OPEN_LAUNCH_STATES = ["prepared", "dispatching", "dispatched"] as const;

/** A1's ID alphabet in upper case. */
const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Tries for a reference no launch of the space ever held: 2^20 exist and launches are never
 * deleted, so 32 tries fail only once a space has held most of a million launches.
 */
const REFERENCE_TRIES = 32;

export const LAUNCH_SQL = {
  launch: "SELECT * FROM launches WHERE id = $id",
  /**
   * The intent still opening for a task and instance on a machine, newest first: Prepared,
   * Dispatching, or a terminal launch its shim has not settled yet. A link or T3 launch that
   * was Dispatched only asked its app, and nothing settles it, so it holds no click. It continues
   * the same agent conversation as the click (`resumes`), or neither continues one.
   */
  focus:
    "SELECT id FROM launches WHERE task_id = $task AND instance_id = $instance " +
    "AND machine_id = $machine AND json_extract(detail, '$.evidence.resumes') IS $resumes " +
    "AND (state IN ('prepared','dispatching') OR (state = 'dispatched' AND route = 'terminal')) " +
    "ORDER BY created_at DESC, id DESC LIMIT 1",
  referenceTaken: "SELECT 1 AS taken FROM launches WHERE reference = $reference LIMIT 1",
  place: "SELECT machine_id, deleted_at FROM places WHERE id = $id",
  /** The note a launch names as its request: one of its task's, not deleted. */
  request:
    "SELECT 1 AS found FROM notes WHERE task_id = $task AND ordinal = $ordinal " +
    "AND deleted_at IS NULL",
  insert:
    "INSERT INTO launches (id, reference, task_id, session_id, instance_id, machine_id, route, " +
    "place_id, task_version, brief_hash, state, reason, detail, created_at, updated_at, " +
    "created_seq, version, fv, fp) VALUES ($id, $reference, $task, $session, $instance, " +
    "$machine, $route, $place, $task_version, $brief_hash, 'prepared', NULL, $detail, $at, $at, " +
    "$seq, $seq, '{}', '{}')",
  update:
    "UPDATE launches SET state = $state, reason = $reason, detail = $detail, updated_at = $at " +
    "WHERE id = $id",
  versions: "UPDATE launches SET version = $seq, fv = $fv, fp = $fp WHERE id = $id",
  open:
    "SELECT * FROM launches WHERE machine_id = $machine " +
    "AND state IN ('prepared','dispatching','dispatched') ORDER BY created_at, id",
} as const;

/**
 * The check character of four reference symbols: their values weighted 1, 3, 5 and 7, mod 32. Odd
 * weights are invertible mod 32, so a single changed symbol always changes the check (A4 3.1).
 */
export function launchRefCheck(symbols: string): string | undefined {
  if (symbols.length !== 4) return undefined;
  let sum = 0;
  for (let i = 0; i < 4; i += 1) {
    const value = REF_ALPHABET.indexOf(symbols.charAt(i));
    if (value < 0) return undefined;
    sum += value * (2 * i + 1);
  }
  return REF_ALPHABET.charAt(sum % 32);
}

/** Whether `text` is a launch reference, `L` and four symbols and their check, such as `L7KQ2M`. */
export function isLaunchRef(text: unknown): text is string {
  if (typeof text !== "string" || text.length !== 6 || !text.startsWith("L")) return false;
  return launchRefCheck(text.slice(1, 5)) === text.charAt(5);
}

/**
 * A new launch reference that no launch of the space ever held, nor one this request made, so an
 * old brief never names a newer launch. Each symbol takes 5 bits of one random byte: 256 is a
 * multiple of 32, so none is favoured.
 */
export function newLaunchRef(
  conn: Connection,
  taken: ReadonlySet<string>,
  random: RandomSource,
): string {
  for (let attempt = 0; attempt < REFERENCE_TRIES; attempt += 1) {
    const bytes = new Uint8Array(4);
    random(bytes);
    const symbols = Array.from(bytes, (b) => REF_ALPHABET.charAt(b % 32)).join("");
    const reference = `L${symbols}${launchRefCheck(symbols) ?? ""}`;
    if (taken.has(reference)) continue;
    if (conn.prepare(LAUNCH_SQL.referenceTaken).get({ reference }) === undefined) {
      return reference;
    }
  }
  throw new StorageError("STORAGE_CONSTRAINT", "No free launch reference was found");
}

/** A launch's `detail`: its evidence and the time it entered each state. */
export interface LaunchDetail {
  evidence: LaunchEvidence;
  at: Partial<Record<LaunchState, number>>;
}

/** The one spelling of a detail: keys in order, so the same detail is the same text. */
export function detailText(detail: LaunchDetail): string {
  const sorted = <T>(map: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)));
  const at: Record<string, number> = {};
  for (const state of LAUNCH_STATES) {
    const value = detail.at[state];
    if (value !== undefined) at[state] = value;
  }
  return JSON.stringify({ at, evidence: sorted(detail.evidence) });
}

/** A launch row as the execution store reads it, checked against its domain. */
export interface LaunchRecord {
  id: Id<"la">;
  reference: string;
  task_id: Id<"t"> | null;
  session_id: Id<"se"> | null;
  instance_id: string;
  machine_id: Id<"m">;
  route: string;
  place_id: Id<"pl"> | null;
  task_version: number | null;
  brief_hash: string | null;
  state: LaunchState;
  reason: string | null;
  evidence: LaunchEvidence;
  at: Partial<Record<LaunchState, number>>;
  created_at: number;
  updated_at: number;
  version: number;
}

const ROUTES: readonly string[] = OPEN_SETS["launches.route"];

/** Decodes a launch row, or SPACE_INVALID naming the column (never the value). */
export function decodeLaunch(row: Row): LaunchRecord {
  const r = new RowReader("launches", row);
  const detail = r.json("detail");
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    throw invalidValue("launches", "detail");
  }
  const { evidence, at } = detail as Record<string, unknown>;
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    throw invalidValue("launches", "detail");
  }
  if (typeof at !== "object" || at === null || Array.isArray(at)) {
    throw invalidValue("launches", "detail");
  }
  const times: Partial<Record<LaunchState, number>> = {};
  for (const [state, value] of Object.entries(at)) {
    if (!LAUNCH_STATES.includes(state as LaunchState) || typeof value !== "number") {
      throw invalidValue("launches", "detail");
    }
    times[state as LaunchState] = value;
  }
  return {
    id: r.id("id", "la"),
    reference: r.text("reference", isLaunchRef),
    task_id: r.optText("task_id", (v) => isId(v, "t")) as Id<"t"> | null,
    session_id: r.optText("session_id", (v) => isId(v, "se")) as Id<"se"> | null,
    instance_id: r.text("instance_id"),
    machine_id: r.id("machine_id", "m"),
    route: r.text("route", (v) => ROUTES.includes(v)),
    place_id: r.optText("place_id", (v) => isId(v, "pl")) as Id<"pl"> | null,
    task_version: r.optInt("task_version", "seq"),
    brief_hash: r.optText("brief_hash"),
    state: r.oneOf("state", LAUNCH_STATES),
    reason: r.optText("reason"),
    evidence: evidence as LaunchEvidence,
    at: times,
    created_at: r.int("created_at", "instant"),
    updated_at: r.int("updated_at", "instant"),
    version: r.int("version", "seq"),
  };
}

/** The launch with this ID, on `conn`, or undefined. */
export function readLaunch(conn: Connection, id: string): LaunchRecord | undefined {
  if (!isId(id, "la")) return undefined;
  const row = conn.prepare(LAUNCH_SQL.launch).get({ id });
  return row === undefined ? undefined : decodeLaunch(row);
}

/** Every launch of `machine` that is not final, oldest first (A4 3.9.3, 3.16.1 `openWork`). */
export function readOpenLaunches(conn: Connection, machine: string): LaunchRecord[] {
  if (!isId(machine, "m")) return [];
  return conn.prepare(LAUNCH_SQL.open).all({ machine }).map(decodeLaunch);
}
