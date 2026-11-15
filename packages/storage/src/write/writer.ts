// The write path (A1 3.7, 3.8, X11, X12): the one way a space changes. A request of 1 to 50
// operations is checked, then decided in one BEGIN IMMEDIATE transaction on the space's writer
// connection:
//
//   space checks → receipt lookup → base (epoch, incarnation, seq) → stage → preconditions
//   → SAVEPOINT → commit row → execute in order, with read-your-writes → coalesce into change rows,
//   field versions and outbox rows → receipt → COMMIT
//
// The receipt lookup (receipts.ts) comes before staging: a request whose ID its writer scope holds
// replays the stored result, or is REQUEST_ID_REUSED for another intent, and nothing runs. Every
// outcome decided after it (applied, unchanged, conflict, rejected) writes its receipt in the same
// transaction as its commit. The checks before the lookup (the space, its authority, the
// credential) decide nothing about the intent, so they store nothing (A1 3.8).
//
// Staging reads only the state at the start of the request: it resolves references and groups,
// finds sources by key and places by owner, gives each new row its ID and lists, per operation,
// the logical fields of existing rows it writes. The base covers exactly those fields and is
// checked once against that start state (a revived link may name its version instead), so an
// operation never conflicts with an earlier write of its own request. Execution then runs the
// operations in order on the live rows, each seeing the writes before it. Coalescing compares each
// written field with its start value: a commit holds one change row per (row, field) with the
// first before-value and the final after-value, a field that ends where it started gets no row and
// keeps its versions, and the writes to a row the request created fold into its create row.
//
// Every statement is a constant of this module. Values are bound as parameters, and the only names
// that reach SQL text are the column names of fields.ts, so no request can run SQL of its own
// (A1 3.7). The writer runs where its connection lives: in a storage worker in
// the service, or in-thread in tests and the sample generator. It is synchronous.
import { mayWrite, preferenceSpec } from "@tasks/contracts/preferences";
import type { Connection, Row, SqlValue } from "../driver.ts";
import { misuse, StorageError } from "../errors.ts";
import { isId, newId, osRandom, type Id, type RandomSource } from "../ids.ts";
import {
  formatEntryRef,
  formatTaskRef,
  nextEntryOrdinal,
  parseTaskRef,
  takeTaskRef,
} from "../refs.ts";
import {
  decodeSpaceRow,
  inRange,
  invalidValue,
  isSpaceName,
  RowReader,
  type SpaceRow,
} from "../rows.ts";
import { readSpacePreference } from "../preferences.ts";
import { indexChanges } from "../search/documents.ts";
import { hasSearchTables } from "../search/tables.ts";
import type { OpenedSpace } from "../space.ts";
import { Dedupe, type Match } from "./dedupe.ts";
import {
  CHILD_FIELDS,
  columnsValue,
  DERIVED_COLUMNS,
  fieldJson,
  TASK_FIELDS,
  type PatchableField,
  type TaskField,
} from "./fields.ts";
import {
  applyInversions,
  planInversions,
  readChanges,
  redoTarget,
  undoTarget,
  type Inversion,
} from "./history.ts";
import {
  decodeLaunch,
  detailText,
  FOCUS_MS,
  LAUNCH_EDGES,
  LAUNCH_SQL,
  newLaunchRef,
  readLaunch,
  readOpenLaunches,
  type LaunchRecord,
} from "./launches.ts";
import { canonicalJson } from "./canonical.ts";
import { isPosition, positionBetween } from "./positions.ts";
import {
  decodeRun,
  FINAL_RUN_STATES,
  readOpenRuns,
  readRun,
  RUN_EDGES,
  RUN_REASONS,
  RUN_SQL,
  runDetailText,
  sortedJson,
  type RunRow,
  type RunState,
} from "./runs.ts";
import {
  readReceipt,
  readReceipts,
  requestFingerprint,
  writeReceipt,
  type Receipt,
  type ReceiptLookup,
} from "./receipts.ts";
import { provenanceOf, rowState, versionOf, type RowState } from "./row-state.ts";
import {
  checkRequest,
  formatAsOf,
  incarnationTag,
  isHistoryOperation,
  LAUNCH_FAIL_REASONS,
  LAUNCH_UNKNOWN_REASONS,
  normaliseStored,
  REQUEST_ID,
  RequestProblem,
  SYSTEM_SCOPE,
  WRITE_LIMITS,
  type AsOf,
  type Base,
  type CheckedRequest,
  type ConflictEntity,
  type Due,
  type FieldConflict,
  type HistoryOperation,
  type OpResult,
  type Operation,
  type Placement,
  type SourceFields,
  type TaskLifecycle,
  type TaskValues,
  type TaskWrapUp,
  type WriteErrorCode,
  type WriteProblem,
  type WriteResult,
} from "./request.ts";

export { SYSTEM_SCOPE };

export const MACHINE_OS = ["linux", "windows", "macos"] as const;
export type MachineOs = (typeof MACHINE_OS)[number];

/** This machine, from machine.json (A6 3.4). Its record is written on the space's first open. */
export interface MachineInfo {
  id: Id<"m">;
  name: string;
  os: MachineOs;
}

export interface WriterOptions {
  machine: MachineInfo;
  /** Milliseconds since 1970. Default: Date.now. */
  now?: () => number;
  /** The source of every new ID. Default: the OS. */
  random?: RandomSource;
}

/**
 * The points M1.07's crash harness kills at, for every request `submit` decides in a transaction:
 * `before-commit` when the request's rows and receipt are written and COMMIT has not run, and
 * `after-commit` when COMMIT returned and the result has not gone back to the caller.
 */
export type WritePoint = "before-commit" | "after-commit";

/**
 * The request a write point is reached for, and its decision: at `before-commit` it is decided and
 * not committed, at `after-commit` it is durable. The harness reports it, so a decision whose reply
 * a kill cut off is still held to the receipt guarantees (A1 3.8).
 */
export interface WriteDecision {
  request: CheckedRequest;
  result: WriteResult;
}

/** What tests inject. Not part of the package's interface, and off unless a caller passes it. */
export interface WriteSeams {
  at?: (point: WritePoint, decision: WriteDecision) => void;
}

/**
 * This machine's record as the writer stores it, or STORAGE_MISUSE: an m_ ID, a one-line name of
 * 1 to 100 characters and its OS. The name is text the writer stores, so it gets the same
 * normalisation as a request's text (request.ts: normaliseStored) before it is checked. The record
 * can come from another thread, so every field is checked at run time.
 */
export function checkMachine(machine: unknown): MachineInfo {
  if (typeof machine !== "object" || machine === null) {
    throw misuse("A space's writer needs this machine's record");
  }
  const { id, name: given, os } = machine as Record<string, unknown>;
  const name = typeof given === "string" ? normaliseStored(given) : given;
  if (!isId(id, "m") || !isSpaceName(name) || !MACHINE_OS.includes(os as MachineOs)) {
    throw misuse("A machine has an m_ ID, a one-line name and linux, windows or macos");
  }
  return { id, name, os: os as MachineOs };
}

/** One entry of `commits.ops`. */
export interface OpsEntry {
  v: 1;
  op: string;
  target: string;
  input: Record<string, unknown>;
}

/**
 * The text of `commits.ops`, the one place the writer serialises it. Every text in it comes from
 * a checked request or machine record, which normaliseStored normalised as the rows hold it. Text
 * that did not would make the history differ from the rows, so it is refused as a bug.
 */
function opsText(entries: readonly OpsEntry[]): string {
  return JSON.stringify(entries, (_key, value: unknown) => {
    if (typeof value === "string" && normaliseStored(value) !== value) {
      throw misuse("Text reached commits.ops without its normalisation");
    }
    return value;
  });
}

/** The value, or STORAGE_MISUSE: a staged operation always has what its kind needs. */
function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw misuse(message);
  return value;
}

function problem(code: WriteErrorCode, message: string, op?: number, field?: string): never {
  throw new RequestProblem({
    code,
    message,
    ...(op === undefined ? {} : { op }),
    ...(field === undefined ? {} : { field }),
  });
}

// ---------------------------------------------------------------------------------------------
// Rows

/** The tables the write path writes rows of. */
type Entity =
  | "tasks"
  | "notes"
  | "log_entries"
  | "sources"
  | "task_sources"
  | "places"
  | "launches"
  | "runs"
  | "learnings"
  | "preferences";

/** A task row as the write path needs it, checked against its domain. */
interface TaskRow extends RowState {
  id: Id<"t">;
  ref: number;
  lifecycle: "active" | "completed" | "archived";
  areaId: Id<"a"> | null;
  projectId: Id<"p"> | null;
  position: string;
  deleted: boolean;
}

function decodeTask(row: Row): TaskRow {
  const r = new RowReader("tasks", row);
  return {
    ...rowState("tasks", row, TASK_FIELDS),
    id: r.id("id", "t"),
    ref: r.int("ref", "taskRef"),
    lifecycle: r.oneOf("lifecycle", ["active", "completed", "archived"]),
    areaId: r.optText("area_id", (v) => isId(v, "a")) as Id<"a"> | null,
    projectId: r.optText("project_id", (v) => isId(v, "p")) as Id<"p"> | null,
    position: r.text("position", isPosition),
    deleted: r.optInt("deleted_at", "instant") !== null,
  };
}

/** The columns of a logical field of `entity`. */
function columnsOf(entity: Entity, field: string): readonly string[] {
  const fields: Readonly<Record<string, readonly string[]>> | undefined =
    entity === "tasks"
      ? TASK_FIELDS
      : entity === "task_sources" ||
          entity === "places" ||
          entity === "launches" ||
          entity === "runs" ||
          entity === "learnings" ||
          entity === "preferences"
        ? CHILD_FIELDS[entity]
        : undefined;
  const columns = fields?.[field];
  if (columns === undefined) throw misuse("A write names a field its row does not have");
  return columns;
}

interface Group {
  areaId: Id<"a"> | null;
  projectId: Id<"p"> | null;
}

const sameGroup = (a: Group, b: Group): boolean =>
  a.areaId === b.areaId && a.projectId === b.projectId;

// ---------------------------------------------------------------------------------------------
// The staged plan

/** A destination group as staged. `keep` keeps the task's current area (`project: null`). */
interface GroupIntent {
  area: Id<"a"> | null | "keep";
  project: Id<"p"> | null;
}

/** One logical field of a row that existed before the request, which an operation writes. */
interface Touch {
  entity: Extract<ConflictEntity, Entity>;
  /** The row's `changes.entity_id`. */
  id: string;
  field: string;
  /** The task the row is or belongs to. */
  task: Id<"t"> | null;
  /** The link version the operation names instead of a base (A1 3.5). */
  linkVersion?: number;
  /**
   * The operation's own rule refuses the row as it stands, whatever the base: a conflict on this
   * field (`task.wrap_up`'s `once` on a task wrapped already, A3 3.4.8).
   */
  held?: true;
}

interface StagedOp {
  i: number;
  op: Operation;
  /** The row the operation acts on. A new row's ID is given here. */
  target: string;
  /** The task the operation acts on or under, if any. */
  task: Id<"t"> | null;
  /** The fields of rows that existed before the request that this operation writes. */
  touches: Touch[];
  /** The resolved input, for `commits.ops`. */
  record: Record<string, unknown>;
  /** An explicit destination group. Undefined: keep the group, or take the sibling's. */
  group?: GroupIntent;
  sibling?: { id: Id<"t">; side: "after" | "before" };
  /**
   * `place.set` and `place.clear`: the owner the place is found by, on the request's machine. A
   * clear whose owner has no place there has the owner itself as its target, and changes nothing.
   */
  owner?: { kind: "task" | "project" | "area"; id: string; bound?: boolean };
  /**
   * `launch.create`: the resolved task and the new launch's reference, or `existing` when a click
   * on the same task and instance is in flight, which the operation returns instead (A4 3.9.1).
   */
  launch?: { task: Id<"t">; reference: string; existing: boolean };
  /** `run.create`: the resolved task, or null for a routine's run. */
  runTask?: Id<"t"> | null;
  /**
   * A draft that matched a task by source key (with its match), or a later operation of such a
   * draft that the rebinding rules leave out (A1 3.6): it writes nothing, its target is the
   * matched task, and its result is `existing`.
   */
  existing?: { match?: Match };
  /** `task.wrap_up`: the IDs of the learnings it adds, one per text of `learnings.add`. */
  learnings?: Id<"lr">[];
  /** `task.wrap_up` with `once` on a task wrapped already that it would not change: no write. */
  skip?: true;
}

interface Plan {
  ops: StagedOp[];
  /** Start-of-request snapshots of every existing task the request names. */
  tasks: Map<Id<"t">, TaskRow>;
  /** Start-of-request states of the existing rows the request writes, by row key. */
  starts: Map<string, RowState>;
  /** Records the request would complete or move, for A6's burst brake (`commits.affected`). */
  affected: number;
  statuses: readonly string[];
  refPrefix: string;
  /**
   * The wall clock when the request was decided. A launch records it as the time of each state
   * it enters (A4 3.16), and its 5 s focus reads it: commit instants stand still while the clock
   * is behind the newest commit (A1 3.9), so they cannot tell how long ago a click was.
   */
  wall: number;
}

const rowKey = (entity: Entity, id: string): string => `${entity}|${id}`;

/** A row the request writes. */
interface RowWrite {
  entity: Entity;
  /** Its `changes.entity_id`. */
  id: string;
  /** The task it is or belongs to: its changes carry it, and the task is marked touched. */
  task: Id<"t"> | null;
  /** The order of its first write: change rows follow it. */
  order: number;
  /** The operation that created it, when the request created it. */
  created?: number;
  /** An existing row: its start state, and each field written with the first operation to. */
  start?: RowState;
  fields: Map<string, number>;
}

/** Per-request state while it executes. */
interface Execution {
  seq: number;
  at: number;
  request: CheckedRequest;
  plan: Plan;
  /** Every row the request writes, by row key, in the order of their first write. */
  rows: Map<string, RowWrite>;
  /** Per operation: the rows it created (field null) and the fields it wrote. */
  opWrites: Map<number, { key: string; field: string | null }[]>;
  /** `source.add` on an existing source: the fields the input gives otherwise. */
  differs: Map<number, string[]>;
}

interface ChangeRow {
  op: number;
  entity: Entity | "machines";
  entityId: string;
  taskId: string | null;
  action: "create" | "set";
  field: string | null;
  before: string | null;
  after: string;
  beforeVer: number | null;
  beforeProv: number | null;
  /**
   * The provenance the field gets: the commit's own seq, unless the row inverts an earlier one
   * (A1 3.10), whose provenance it sets back.
   */
  afterProv?: number;
}

// ---------------------------------------------------------------------------------------------
// Statements. Every one is a constant.

const COMMIT_COLUMNS =
  "seq, id, epoch, incarnation, at, actor_kind, principal_id, author_id, scope_id, machine_id, " +
  "session_id, run_id, origin, request_id, kind, ops, affected, reason, proposal_id, undo_status, " +
  "undone_by, undo_of, redo_of, revert_of, reverted_by, compacted";

/** Positions in a group: every task of the group counts, whatever its lifecycle. */
const inGroup = (projection: string, condition: string): { project: string; area: string } => ({
  project: `SELECT ${projection} AS p FROM tasks WHERE project_id = $project AND id <> $self${condition}`,
  area:
    `SELECT ${projection} AS p FROM tasks WHERE project_id IS NULL AND area_id IS $area ` +
    `AND id <> $self${condition}`,
});

const SQL = {
  space: "SELECT * FROM space WHERE one = 1",
  task: "SELECT * FROM tasks WHERE id = $id",
  taskByRef: "SELECT * FROM tasks WHERE ref = $ref",
  alias:
    "SELECT entity_kind, entity_id FROM aliases WHERE namespace = $namespace AND alias = $alias",
  areaById: "SELECT id, deleted_at FROM areas WHERE id = $id",
  areaBySlug: "SELECT id, deleted_at FROM areas WHERE slug = $slug AND deleted_at IS NULL",
  projectById: "SELECT id, area_id, deleted_at FROM projects WHERE id = $id",
  projectBySlug:
    "SELECT id, area_id, deleted_at FROM projects WHERE slug = $slug AND deleted_at IS NULL",
  actor: "SELECT kind FROM actors WHERE id = $id",
  systemActor: "SELECT id FROM actors WHERE kind = 'system' ORDER BY created_at, id LIMIT 1",
  lastAt: "SELECT at FROM commits ORDER BY seq DESC LIMIT 1",
  commitAuthor:
    "SELECT k.at AS at, k.author_id AS actor, a.kind AS kind, a.label AS label, " +
    "k.origin AS origin FROM commits k JOIN actors a ON a.id = k.author_id WHERE k.seq = $seq",
  insertCommit:
    `INSERT INTO commits (${COMMIT_COLUMNS}) VALUES ($seq, $id, $epoch, $incarnation, $at, ` +
    "$actor_kind, $principal, $author, $scope, $machine, $session, $run, $origin, $request, " +
    "'ops', $ops, $affected, $reason, NULL, $undo_status, NULL, NULL, NULL, NULL, NULL, 0)",
  deadUndone:
    "UPDATE commits SET undo_status = 'dead' " +
    "WHERE principal_id = $principal AND undo_status = 'undone'",
  // An undo or redo (A1 3.10.1): never on the stack itself, it names the commit it moves.
  insertHistoryCommit:
    `INSERT INTO commits (${COMMIT_COLUMNS}) VALUES ($seq, $id, $epoch, $incarnation, $at, ` +
    "$actor_kind, $principal, $author, $scope, $machine, $session, $run, $origin, $request, " +
    "$kind, $ops, $affected, $reason, NULL, NULL, NULL, $undo_of, $redo_of, NULL, NULL, 0)",
  markUndone: "UPDATE commits SET undo_status = 'undone', undone_by = $seq WHERE seq = $target",
  markRedone: "UPDATE commits SET undo_status = 'done', undone_by = NULL WHERE seq = $target",
  insertChange:
    "INSERT INTO changes (seq, n, op, entity, entity_id, task_id, action, field, before, after, " +
    "before_ver, before_prov, after_prov) VALUES ($seq, $n, $op, $entity, $entity_id, $task_id, " +
    "$action, $field, $before, $after, $before_ver, $before_prov, $after_prov)",
  insertTask:
    "INSERT INTO tasks (id, ref, title, summary, context, lifecycle, status, inbox, priority, " +
    "effort, due_date, due_at, due_tz, planned_for, focus_on, owner, waiting_on, area_id, " +
    "project_id, position, parent_id, source_at, reviewed_at, completed_at, completed_by, " +
    "archived_reason, wrap_state, outcome, wrapped_at, wrapped_by, created_at, created_by, " +
    "created_session, deleted_at, deleted_by, created_seq, version, touched, fv, fp, ext) VALUES (" +
    "$id, $ref, $title, $summary, $context, 'active', $status, $inbox, $priority, $effort, " +
    "$due_date, $due_at, $due_tz, $planned_for, $focus_on, $owner, $waiting_on, $area_id, " +
    "$project_id, $position, NULL, $source_at, $reviewed_at, NULL, NULL, NULL, NULL, NULL, NULL, " +
    "NULL, $at, $author, $session, NULL, NULL, $seq, $seq, $seq, '{}', '{}', '{}')",
  taskVersions:
    "UPDATE tasks SET version = $seq, touched = $seq, fv = $fv, fp = $fp WHERE id = $id",
  touched: "UPDATE tasks SET touched = $seq WHERE id = $id",
  outbox:
    "INSERT INTO outbox (topic, key, first_seq, seq) VALUES ('projection', $key, $seq, $seq) " +
    "ON CONFLICT (topic, key) DO UPDATE SET seq = excluded.seq",
  lastSeq: "UPDATE space SET last_seq = $seq WHERE one = 1",
  last: inGroup("max(position)", ""),
  next: inGroup("min(position)", " AND position > $at"),
  previous: inGroup("max(position)", " AND position < $at"),
  machine: "SELECT id FROM machines WHERE id = $id",
  insertMachine:
    "INSERT INTO machines (id, name, os, first_seen, retired_at, created_seq, version, fv, fp) " +
    "VALUES ($id, $name, $os, $at, NULL, $seq, $seq, '{}', '{}')",
  machineRow: "SELECT * FROM machines WHERE id = $id",
  actorByLabel:
    "SELECT id FROM actors WHERE kind = $kind AND label = $label ORDER BY created_at, id LIMIT 1",
  firstHuman: "SELECT id FROM actors WHERE kind = 'human' ORDER BY created_at, id LIMIT 1",
  insertActor:
    "INSERT INTO actors (id, kind, label, instance_id, routine_id, created_at) " +
    "VALUES ($id, $kind, $label, NULL, NULL, $at)",
  insertSystemCommit:
    `INSERT INTO commits (${COMMIT_COLUMNS}) VALUES ($seq, $id, $epoch, $incarnation, $at, ` +
    "'system', $actor, $actor, $scope, $machine, NULL, NULL, $origin, $request, $kind, $ops, 0, " +
    "NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0)",
  // Notes and log entries (A1 3.6): append-only rows with the task's next ordinal.
  note: "SELECT * FROM notes WHERE id = $id",
  insertNote:
    "INSERT INTO notes (id, task_id, ordinal, author_id, addressee, audience, body, created_at, " +
    "edited_at, deleted_at, created_seq, version, fv, fp) VALUES ($id, $task, $ordinal, $author, " +
    "$addressee, 'all', $body, $at, NULL, NULL, $seq, $seq, '{}', '{}')",
  log: "SELECT * FROM log_entries WHERE id = $id",
  insertLog:
    "INSERT INTO log_entries (id, task_id, ordinal, author_id, session_id, run_id, kind, body, " +
    "created_at, deleted_at, created_seq, version, fv, fp) VALUES ($id, $task, $ordinal, " +
    "$author, $session, $run, $kind, $body, $at, NULL, $seq, $seq, '{}', '{}')",
  // Sources and their links (A1 3.6): a source is found by its key among live sources.
  source: "SELECT * FROM sources WHERE id = $id",
  sourceByKey: "SELECT * FROM sources WHERE source_key = $key AND deleted_at IS NULL",
  insertSource:
    "INSERT INTO sources (id, source_key, kind, title, who, ref, url, at, created_at, created_by, " +
    "deleted_at, created_seq, version, fv, fp, ext) VALUES ($id, $key, $kind, $title, $who, " +
    "$ref, $url, $sent, $at, $author, NULL, $seq, $seq, '{}', '{}', '{}')",
  link: "SELECT * FROM task_sources WHERE task_id = $task AND source_id = $source",
  lastLink: "SELECT max(position) AS p FROM task_sources WHERE task_id = $task",
  insertLink:
    "INSERT INTO task_sources (task_id, source_id, role, position, added_by, removed_at, " +
    "created_seq, version, fv, fp) VALUES ($task, $source, $role, $position, $author, NULL, " +
    "$seq, $seq, '{}', '{}')",
  reviveLink:
    "UPDATE task_sources SET removed_at = NULL WHERE task_id = $task AND source_id = $source",
  linkVersions:
    "UPDATE task_sources SET version = $seq, fv = $fv, fp = $fp " +
    "WHERE task_id = $task AND source_id = $source",
  // Places (A1 3.15): one live place per owner and machine.
  place: "SELECT * FROM places WHERE id = $id",
  placeOf:
    "SELECT * FROM places WHERE owner_kind = $kind AND owner_id = $owner " +
    "AND machine_id = $machine AND deleted_at IS NULL",
  insertPlace:
    "INSERT INTO places (id, owner_kind, owner_id, machine_id, root_id, rel_path, kind, " +
    "identity, created_at, deleted_at, created_seq, version, fv, fp) VALUES ($id, $owner_kind, " +
    "$owner, $machine, $root, $path, $kind, $identity, $at, NULL, $seq, $seq, '{}', '{}')",
  updatePlace:
    "UPDATE places SET root_id = $root, rel_path = $path, kind = $kind, identity = $identity " +
    "WHERE id = $id",
  clearPlace: "UPDATE places SET deleted_at = $at WHERE id = $id",
  placeVersions: "UPDATE places SET version = $seq, fv = $fv, fp = $fp WHERE id = $id",
  // Learnings (A1 3.11.2): rows a wrap-up adds after the task's others, and tombstones to remove.
  learning: "SELECT * FROM learnings WHERE id = $id",
  liveLearnings: "SELECT body FROM learnings WHERE task_id = $task AND deleted_at IS NULL",
  lastLearning: "SELECT max(position) AS p FROM learnings WHERE task_id = $task",
  insertLearning:
    "INSERT INTO learnings (id, task_id, position, body, created_by, created_at, deleted_at, " +
    "created_seq, version, fv, fp) VALUES ($id, $task, $position, $body, $author, $at, NULL, " +
    "$seq, $seq, '{}', '{}')",
  removeLearning: "UPDATE learnings SET deleted_at = $at WHERE id = $id",
  learningVersions: "UPDATE learnings SET version = $seq, fv = $fv, fp = $fp WHERE id = $id",
  areaVersion: "SELECT version FROM areas WHERE id = $id",
  projectVersion: "SELECT version FROM projects WHERE id = $id",
  // Preferences (A1 3.16): one row per key, which a reset keeps with the value null.
  preferenceRow: "SELECT * FROM preferences WHERE key = $id",
  insertPreference:
    "INSERT INTO preferences (key, value, schema_ver, policy, created_seq, version, fv, fp) " +
    "VALUES ($id, $value, $schema_ver, $policy, $seq, $seq, '{}', '{}')",
  updatePreference:
    "UPDATE preferences SET value = $value, schema_ver = $schema_ver WHERE key = $id",
  preferenceVersions: "UPDATE preferences SET version = $seq, fv = $fv, fp = $fp WHERE key = $id",
} as const;

/** A new commit's instant: `now`, or the newest commit's when the clock stepped back (A1 3.9). */
function commitInstant(conn: Connection, now: number): number {
  if (!inRange(now, "instant")) throw misuse("The clock gave an instant outside its range");
  const row = conn.prepare(SQL.lastAt).get();
  const previous = row === undefined ? 0 : row["at"];
  if (!inRange(previous, "instant")) throw invalidValue("commits", "at");
  return Math.max(now, previous);
}

/**
 * A commit Tasks makes on its own, as the space's system actor in the system scope: an operation
 * such as `machine.register` (A1 3.6) or `space.claim` (A1 3.18), of kind `ops` and origin
 * `system`, or a schema step (A1 3.17), of kind `migration` and origin `migration`.
 */
export interface SystemCommit {
  kind: "ops" | "migration";
  origin: "system" | "migration";
  /** Unique in the system scope (A1 3.8: 16 to 64 characters from [A-Za-z0-9_-]). */
  request: string;
  ops: readonly OpsEntry[];
  /** The authority it is written under. A claim's commit carries the new one. */
  epoch: number;
  incarnation: Id<"ai">;
  /** The machine it was made on. */
  machine: Id<"m">;
  /** Milliseconds since 1970. The commit's `at` never goes below the previous commit's. */
  now: number;
  random: RandomSource;
}

/**
 * Writes one system commit inside the caller's IMMEDIATE transaction: the commit row, in the one
 * `commits.ops` format (opsText), and `space.last_seq`. The caller writes the rows the commit
 * changes, their change rows and outbox rows with the returned seq, in the same transaction. Every
 * commit row the package writes comes from this function or from `SpaceWriter.submit`.
 */
export function writeSystemCommit(
  conn: Connection,
  commit: SystemCommit,
): { seq: number; id: Id<"op">; at: number } {
  if (!conn.inTransaction) throw misuse("A system commit is written inside a write transaction");
  if (!REQUEST_ID.test(commit.request)) {
    throw misuse("A system commit's request ID breaks A1 3.8's pattern");
  }
  const space = decodeSpaceRow(conn.prepare(SQL.space).get());
  const system = conn.prepare(SQL.systemActor).get()?.["id"];
  if (!isId(system, "ac")) {
    throw new StorageError("SPACE_INVALID", "The space has no system actor");
  }
  const seq = nextSeq(space);
  const at = commitInstant(conn, commit.now);
  const id = newId("op", commit.random);
  conn.prepare(SQL.insertSystemCommit).run({
    seq,
    id,
    epoch: commit.epoch,
    incarnation: commit.incarnation,
    at,
    actor: system,
    scope: SYSTEM_SCOPE,
    machine: commit.machine,
    origin: commit.origin,
    request: commit.request,
    kind: commit.kind,
    ops: opsText(commit.ops),
  });
  conn.prepare(SQL.lastSeq).run({ seq });
  return { seq, id, at };
}

const TASK_COLUMNS = new Set<string>(Object.values(TASK_FIELDS).flat());

/** `UPDATE tasks SET <columns> WHERE id = $id`, for columns of fields.ts only. */
function updateTaskSql(columns: readonly string[]): string {
  if (columns.length === 0 || columns.some((c) => !TASK_COLUMNS.has(c))) {
    throw misuse("A task update names only the columns of its fields");
  }
  return `UPDATE tasks SET ${columns.map((c) => `${c} = $${c}`).join(", ")} WHERE id = $id`;
}

/** The row of `entity` with the given `changes.entity_id`, as it stands now. */
function readRow(conn: Connection, entity: Entity, id: string): Row {
  let row: Row | undefined;
  if (entity === "task_sources") {
    const [task, source] = id.split("|");
    row = conn.prepare(SQL.link).get({ task: task ?? "", source: source ?? "" });
  } else {
    const sql = {
      tasks: SQL.task,
      notes: SQL.note,
      log_entries: SQL.log,
      sources: SQL.source,
      places: SQL.place,
      launches: LAUNCH_SQL.launch,
      runs: RUN_SQL.run,
      learnings: SQL.learning,
      preferences: SQL.preferenceRow,
    }[entity];
    row = conn.prepare(sql).get({ id });
  }
  if (row === undefined) throw misuse("A row the request wrote has gone");
  return row;
}

/** Sets a changed row's version and field maps to this commit (A1 3.4, 3.5). */
function setVersions(
  conn: Connection,
  row: RowWrite,
  seq: number,
  fv: Record<string, number>,
  fp: Record<string, number>,
): void {
  const maps = { seq, fv: JSON.stringify(fv), fp: JSON.stringify(fp) };
  if (row.entity === "tasks") conn.prepare(SQL.taskVersions).run({ ...maps, id: row.id });
  else if (row.entity === "places") conn.prepare(SQL.placeVersions).run({ ...maps, id: row.id });
  else if (row.entity === "launches") {
    conn.prepare(LAUNCH_SQL.versions).run({ ...maps, id: row.id });
  } else if (row.entity === "runs") {
    conn.prepare(RUN_SQL.versions).run({ ...maps, id: row.id });
  } else if (row.entity === "learnings") {
    conn.prepare(SQL.learningVersions).run({ ...maps, id: row.id });
  } else if (row.entity === "preferences") {
    conn.prepare(SQL.preferenceVersions).run({ ...maps, id: row.id });
  } else if (row.entity === "task_sources") {
    const [task, source] = row.id.split("|");
    conn.prepare(SQL.linkVersions).run({ ...maps, task: task ?? "", source: source ?? "" });
  } else throw misuse("No operation of this build changes that row after its create");
}

// ---------------------------------------------------------------------------------------------

/** Reads the space's `as_of` (A1 3.5) on `conn`. Call it inside a read transaction. */
export function readAsOf(conn: Connection): AsOf {
  const space = decodeSpaceRow(conn.prepare(SQL.space).get());
  return {
    epoch: space.authority.epoch,
    incarnation: space.authority.incarnation,
    seq: space.lastSeq,
  };
}

/**
 * The keys of `tasks.statuses` or `tasks.effort_scale` as the registry reads them: the stored list
 * when it fits its shape, else the default (A1 3.16).
 */
function listPreference(conn: Connection, key: "tasks.statuses" | "tasks.effort_scale"): string[] {
  const value = readSpacePreference(conn, key).value;
  if (!Array.isArray(value)) throw misuse("A list preference reads as a list");
  return value.map((item: unknown) =>
    typeof item === "string" ? item : String((item as { key?: unknown }).key),
  );
}

/**
 * A space's writer: the only write connection of an open space (A1 3.9). It owns the connection
 * of a writer `openSpace` returned, and closes it.
 */
export class SpaceWriter {
  readonly #conn: Connection;
  readonly #machine: MachineInfo;
  readonly #now: () => number;
  readonly #random: RandomSource;
  readonly #seams: WriteSeams;
  /**
   * Whether the space holds the search tables (A1 3.12), which a schema step after 0.2 adds: each
   * commit then writes the documents it changed. A space without them keeps no index.
   */
  readonly #search: boolean;
  readonly spaceId: Id<"sp">;
  #registered = false;
  #closed = false;

  private constructor(opened: OpenedSpace, options: WriterOptions, seams: WriteSeams) {
    this.#conn = opened.conn;
    this.#machine = options.machine;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? osRandom;
    this.#seams = seams;
    this.spaceId = opened.space.spaceId;
    this.#search = hasSearchTables(opened.conn);
  }

  /**
   * Takes over a space opened as the writer, without writing anything yet. `registerMachine()`
   * must run before the first request. The storage worker attaches first, so the process can
   * claim the space before the writer writes to it. `seams` is for tests only (WriteSeams).
   */
  static attach(opened: OpenedSpace, options: WriterOptions, seams: WriteSeams = {}): SpaceWriter {
    if (opened.role !== "writer" || opened.readOnlyReasons.length > 0) {
      throw misuse("A space writer needs a space opened as the writer");
    }
    return new SpaceWriter(opened, { ...options, machine: checkMachine(options.machine) }, seams);
  }

  /** Takes over a space opened as the writer and registers this machine (A1 3.6). */
  static open(opened: OpenedSpace, options: WriterOptions, seams: WriteSeams = {}): SpaceWriter {
    const writer = SpaceWriter.attach(opened, options, seams);
    try {
      writer.registerMachine();
    } catch (error) {
      writer.close();
      throw error;
    }
    return writer;
  }

  #usable(): Connection {
    if (this.#closed) throw misuse("This space writer is closed");
    return this.#conn;
  }

  /**
   * The commit's instant, and the wall clock it came from. A1 3.9 keeps history ordered if the
   * clock steps back, so the instant may be the newest commit's; an age measured against the
   * present (A4's 5 s focus) uses the wall clock instead.
   */
  #clock(): { at: number; wall: number } {
    const wall = this.#now();
    return { at: commitInstant(this.#conn, wall), wall };
  }

  /**
   * Adds this machine's record on the space's first open on it: `machine.register`, a system
   * commit (A1 3.6). Returns whether it wrote one. Safe to call again. A system commit is the
   * writer's own, not a caller's request, so it has no receipt: no request may use its scope.
   */
  registerMachine(): boolean {
    const conn = this.#usable();
    const machine = this.#machine;
    const wrote = conn.transaction("immediate", () => {
      if (conn.prepare(SQL.machine).get({ id: machine.id }) !== undefined) return false;
      const space = decodeSpaceRow(conn.prepare(SQL.space).get());
      // Only the authority writes (A1 3.7). Another machine's writer refuses every request with
      // SPACE_READ_ONLY, and registers nothing.
      if (space.authority.machineId !== machine.id) return false;
      const { seq, at } = writeSystemCommit(conn, {
        kind: "ops",
        origin: "system",
        request: `register-machine-${machine.id.slice(2)}`,
        ops: [
          {
            v: 1,
            op: "machine.register",
            target: machine.id,
            input: { name: machine.name, os: machine.os },
          },
        ],
        epoch: space.authority.epoch,
        incarnation: space.authority.incarnation,
        machine: machine.id,
        now: this.#now(),
        random: this.#random,
      });
      conn.prepare(SQL.insertMachine).run({ ...machine, at, seq });
      const row = conn.prepare(SQL.machineRow).get({ id: machine.id });
      if (row === undefined) throw misuse("The machine row was not written");
      insertChanges(conn, seq, [
        {
          op: 0,
          entity: "machines",
          entityId: machine.id,
          taskId: null,
          action: "create",
          field: null,
          before: null,
          after: JSON.stringify(withoutDerived(row)),
          beforeVer: null,
          beforeProv: null,
        },
      ]);
      conn.prepare(SQL.lastSeq).run({ seq });
      return true;
    });
    this.#registered = true;
    return wrote;
  }

  /**
   * The actor a connection writes as (A3 3.7.4), by kind and label: the space's human for `human`
   * (its first, the `user` of A3), or the agent actor with that label, such as `script` or
   * `agent:unknown`, which joins the space on its first act: `actor.register`, a system commit
   * like `machine.register`, with no change rows (actors carry no versions). Only this machine,
   * as the space's authority, adds one; elsewhere an unknown agent actor is refused with
   * STORAGE_READ_ONLY. Returns the actor's ID.
   */
  actor(kind: "human" | "agent", label: string): Id<"ac"> {
    const conn = this.#usable();
    if (kind === "human") {
      const found = conn.transaction("deferred", () => conn.prepare(SQL.firstHuman).get());
      const id = found?.["id"];
      if (!isId(id, "ac")) throw new StorageError("SPACE_INVALID", "The space has no human actor");
      return id;
    }
    const name = normaliseStored(label);
    if (!isSpaceName(name) || name !== label) {
      throw misuse("An actor label is one line of 1 to 100 characters");
    }
    return conn.transaction("immediate", () => {
      const found = conn.prepare(SQL.actorByLabel).get({ kind, label: name })?.["id"];
      if (isId(found, "ac")) return found;
      const space = decodeSpaceRow(conn.prepare(SQL.space).get());
      if (space.authority.machineId !== this.#machine.id) {
        throw new StorageError("STORAGE_READ_ONLY", "Another machine is this space's authority");
      }
      const id = newId("ac", this.#random);
      const { at } = writeSystemCommit(conn, {
        kind: "ops",
        origin: "system",
        request: `register-actor-${id.slice(3)}`,
        ops: [{ v: 1, op: "actor.register", target: id, input: { kind, label: name } }],
        epoch: space.authority.epoch,
        incarnation: space.authority.incarnation,
        machine: this.#machine.id,
        now: this.#now(),
        random: this.#random,
      });
      conn.prepare(SQL.insertActor).run({ id, kind, label: name, at });
      return id;
    });
  }

  /** The space's current `as_of`. */
  asOf(): AsOf {
    const conn = this.#usable();
    return conn.transaction("deferred", () => readAsOf(conn));
  }

  /**
   * A request's receipt in a writer scope, then in the connection's earlier scope: what
   * `receipt.get` returns (A3 3.2.3). Undefined when the scope holds none: another scope's
   * receipts are never found.
   */
  receipt(lookup: ReceiptLookup): Receipt | undefined {
    const conn = this.#usable();
    return conn.transaction("deferred", () => readReceipt(conn, lookup));
  }

  /** A launch record as it is now (A4 3.16.1), or undefined: the execution store's read. */
  launch(id: string): LaunchRecord | undefined {
    const conn = this.#usable();
    return conn.transaction("deferred", () => readLaunch(conn, id));
  }

  /** Every launch of `machine` that is not final, oldest first: `openWork` (A4 3.16.1). */
  openLaunches(machine: string): LaunchRecord[] {
    const conn = this.#usable();
    return conn.transaction("deferred", () => readOpenLaunches(conn, machine));
  }

  /** A run record as it is now (A4 3.16.1), or undefined: the execution store's read. */
  run(id: string): RunRow | undefined {
    const conn = this.#usable();
    return conn.transaction("deferred", () => readRun(conn, id));
  }

  /** Every run of `machine` that is not final, oldest first: `openWork` (A4 3.11.9, 3.16.1). */
  openRuns(machine: string): RunRow[] {
    const conn = this.#usable();
    return conn.transaction("deferred", () => readOpenRuns(conn, machine));
  }

  /**
   * Decides one request. Every outcome the write path decides comes back as a result: applied,
   * unchanged, conflict or rejected, or the stored result of an earlier decision, marked
   * `replayed`. Storage failures throw StorageError: STORAGE_BUSY and DURABILITY_FAILED leave the
   * request undecided, and a retry with the same ID runs it (A1 3.8).
   */
  submit(input: unknown): WriteResult {
    const conn = this.#usable();
    if (!this.#registered) {
      throw misuse("The writer registers its machine before its first request");
    }
    let request: CheckedRequest;
    try {
      request = checkRequest(input);
    } catch (error) {
      if (!(error instanceof RequestProblem)) throw error;
      // A shape or limit error is not decided: the same input always fails the same way, so it
      // stores nothing (A1 3.8).
      return refused("rejected", this.asOf(), error.problem);
    }
    const fingerprint = requestFingerprint(request);
    const at = this.#seams.at;
    const result = conn.transaction("immediate", () => {
      const decided = this.#decide(conn, request, fingerprint);
      at?.("before-commit", { request, result: decided });
      return decided;
    });
    at?.("after-commit", { request, result });
    return result;
  }

  #decide(conn: Connection, request: CheckedRequest, fingerprint: string): WriteResult {
    const space = decodeSpaceRow(conn.prepare(SQL.space).get());
    const asOf: AsOf = {
      epoch: space.authority.epoch,
      incarnation: space.authority.incarnation,
      seq: space.lastSeq,
    };
    // Whether this space decides the request at all, and who asks. None of these decides the
    // intent, so none stores a receipt (A1 3.7, 3.8): a request meant for another space, a space
    // this machine only reads, and a credential the space does not know.
    try {
      if (request.space_id !== space.spaceId) {
        problem("SPACE_MISMATCH", "The request names another space", undefined, "space_id");
      }
      if (space.authority.machineId !== this.#machine.id) {
        throw new RequestProblem({
          code: "SPACE_READ_ONLY",
          message: "This machine is not the space's authority",
          reason: "not_authority",
        });
      }
      checkActor(conn, request);
    } catch (error) {
      if (!(error instanceof RequestProblem)) throw error;
      return refused("rejected", asOf, error.problem);
    }
    // The receipt, before staging and expansion (A1 3.7, 3.8). When the scope and the earlier
    // scope both hold the ID, the one with this intent replays (receipts.ts: readReceipts).
    const found = readReceipts(conn, {
      scope_id: request.actor.scope_id,
      ...(request.actor.earlier_scope_id === undefined
        ? {}
        : { earlier_scope_id: request.actor.earlier_scope_id }),
      request_id: request.request_id,
    });
    const same = found.find((receipt) => receipt.fingerprint === fingerprint);
    if (same !== undefined) return same.result;
    const prior = found[0];
    if (prior !== undefined) {
      return refused("rejected", asOf, {
        code: "REQUEST_ID_REUSED",
        message: "This request ID was used for another change: review it, then use a new ID",
        field: "request_id",
        at: prior.at,
      });
    }
    const { at, wall } = this.#clock();
    const judged = this.#judge(conn, request, space, asOf, at, wall);
    // What the caller found before the writer goes with an accepted result and into its receipt,
    // so a replay says what this answer says (WriteRequest.warnings).
    const result =
      request.warnings === undefined ||
      request.warnings.length === 0 ||
      (judged.status !== "applied" && judged.status !== "unchanged")
        ? judged
        : { ...judged, warnings: [...judged.warnings, ...request.warnings] };
    // In the request's own transaction: the receipt exists exactly when its commit does.
    writeReceipt(conn, { request, fingerprint, result, at });
    return result;
  }

  /** Every decided outcome of a request with no receipt yet. */
  #judge(
    conn: Connection,
    request: CheckedRequest,
    space: SpaceRow,
    asOf: AsOf,
    at: number,
    wall: number,
  ): WriteResult {
    try {
      if (request.base !== undefined) checkBase(request.base, asOf);
      // An undo or redo is a request of its own (request.ts), guarded by provenance.
      const [first] = request.ops;
      if (first !== undefined && isHistoryOperation(first)) {
        return this.#history(conn, request, first, space, asOf, at);
      }
      const plan = this.#stage(conn, request, space, at, wall);
      const conflicts = preconditions(conn, request, plan, space);
      if (conflicts.length > 0) {
        return refused(
          "conflict",
          asOf,
          { code: "VERSION_CONFLICT", message: "A field changed after the base: read again" },
          conflicts,
        );
      }
      return this.#execute(conn, request, space, plan, asOf, at);
    } catch (error) {
      if (!(error instanceof RequestProblem)) throw error;
      return refused("rejected", asOf, error.problem, error.conflicts);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Stage: read only, against the state at the start of the request.

  #stage(
    conn: Connection,
    request: CheckedRequest,
    space: SpaceRow,
    at: number,
    wall: number,
  ): Plan {
    const tasks = new Map<Id<"t">, TaskRow>();
    const starts = new Map<string, RowState>();
    const drafts = new Set<Id<"t">>();
    /** Sources and places that earlier operations of the request create. */
    const draftSources = new Map<string, Id<"s">>();
    const draftPlaces = new Map<string, Id<"pl">>();
    /**
     * The owners whose place earlier operations bind (a new place or another folder for an
     * existing one) and those whose place they clear, by `kind|id`: one request does not do both.
     */
    const boundOwners = new Set<string>();
    const clearedPlaces = new Set<string>();
    /** Launches that earlier operations create, by task and instance, and their references. */
    const draftLaunches = new Map<string, Id<"la">>();
    /** Runs that earlier operations create. */
    const draftRuns = new Set<Id<"ru">>();
    const draftRefs = new Set<string>();
    const statuses = listPreference(conn, "tasks.statuses");
    const efforts = listPreference(conn, "tasks.effort_scale");
    const affected = new Set<Id<"t">>();
    const random = this.#random;
    /** Dedupe by source key (A1 3.6), and the drafts that matched a task, by the draft's ID. */
    const dedupe = new Dedupe(conn, request.ops, at);
    const matched = new Map<string, Match>();
    /**
     * The tombstones earlier operations set (`true`) or clear (`false`): a later operation sees
     * the task as they leave it, so a restored task takes changes and a deleted one refuses them.
     */
    const tombstones = new Map<Id<"t">, boolean>();
    /** The lifecycle earlier operations leave each task in, as execution will find it. */
    const lifecycles = new Map<Id<"t">, TaskLifecycle>();

    const ops = request.ops.map((op, i): StagedOp => {
      const values: TaskValues =
        op.kind === "task.create" ? op : op.kind === "task.patch" ? (op.set ?? {}) : {};
      if (values.status !== undefined && !statuses.includes(values.status)) {
        problem("VALIDATION_FAILED", "Not a status of this space", i, "status");
      }
      if (typeof values.effort === "string" && !efforts.includes(values.effort)) {
        problem("VALIDATION_FAILED", "Not an effort of this space", i, "effort");
      }
      /** The task `given` names. Only `task.restore` (`restoring`) may name a deleted one. */
      const task = (given: string, field: string, restoring = false): Id<"t"> => {
        // A matched draft's ID names the matched task, for an operation that follows it. Only its
        // entries and sources name it (checkRequest), and they follow one active match only.
        const rebound = matched.get(given);
        if (rebound !== undefined && !rebound.follows) {
          throw misuse("Only an operation that follows a match names a matched draft");
        }
        const found = resolveTask(conn, space, rebound?.task ?? given, drafts, i, field);
        const deleted = tombstones.get(found.id) ?? found.row?.deleted ?? false;
        if (deleted && !restoring) problem("DELETED", "The task is deleted", i, field);
        if (found.row !== undefined && !tasks.has(found.id)) {
          tasks.set(found.id, found.row);
          starts.set(rowKey("tasks", found.id), found.row);
        }
        return found.id;
      };
      const where = (
        placement: Placement,
      ): Pick<StagedOp, "group" | "sibling"> & {
        record: Record<string, unknown>;
      } => {
        const staged: Pick<StagedOp, "group" | "sibling"> = {};
        const record: Record<string, unknown> = {};
        let area: Id<"a"> | null | undefined;
        if (placement.area !== undefined) {
          area = placement.area === null ? null : resolveArea(conn, placement.area, i);
          record["area"] = area;
        }
        if (placement.project !== undefined && placement.project !== null) {
          // The task's area follows its project's (A1 3.6), whatever area the input named.
          const project = resolveProject(conn, placement.project, i);
          record["project"] = project.id;
          staged.group = { area: project.areaId, project: project.id };
        } else if (placement.project === null || area !== undefined) {
          if (placement.project === null) record["project"] = null;
          staged.group = { area: area === undefined ? "keep" : area, project: null };
        }
        const side = placement.after !== undefined ? "after" : "before";
        const sibling = placement.after ?? placement.before;
        if (sibling !== undefined) {
          staged.sibling = { id: task(sibling, side), side };
          record[side] = staged.sibling.id;
        }
        return { ...staged, record };
      };
      const taskTouches = (target: Id<"t">, fields: TaskField[]): Touch[] =>
        drafts.has(target)
          ? []
          : fields.map((field) => ({ entity: "tasks", id: target, field, task: target }));
      /** The request's machine, which a place binds a folder on: it must have its record. */
      const placeMachine = (): string => {
        const machine = request.actor.machine_id;
        if (conn.prepare(SQL.machine).get({ id: machine }) === undefined) {
          problem(
            "VALIDATION_FAILED",
            "The request's machine has no record in this space",
            i,
            "actor.machine_id",
          );
        }
        return machine;
      };
      /** A place's owner, and the request's machine, which must have its record (A1 3.15). */
      const ownerOf = (op: { task?: string; project?: string; area?: string }) => {
        const owner =
          op.task !== undefined
            ? { kind: "task" as const, id: task(op.task, "task") as string }
            : op.project !== undefined
              ? { kind: "project" as const, id: resolveProject(conn, op.project, i).id as string }
              : { kind: "area" as const, id: resolveArea(conn, op.area ?? "", i) as string };
        const machine = placeMachine();
        return { owner, machine, key: `${owner.kind}|${owner.id}` };
      };

      // A later operation of a matched draft: the rebinding rules (A1 3.6) either leave it out,
      // or let it go on with the matched task, which `task` resolves the draft's ID to. Only the
      // draft's entries, sources and place name it (checkRequest refuses the rest from the input
      // alone). A place left out is still checked as a created draft's is, so whether a request
      // is valid never depends on what dedupe finds.
      const named = "task" in op ? op.task : undefined;
      const match = named === undefined ? undefined : matched.get(named);
      if (match !== undefined && !follows(op, match)) {
        if (op.kind === "place.set") placeMachine();
        return {
          i,
          op,
          target: match.task,
          task: match.task,
          touches: [],
          record: { existing: true },
          existing: {},
        };
      }

      switch (op.kind) {
        case "task.create": {
          const id = op.id ?? newId("t", random);
          if (
            drafts.has(id) ||
            matched.has(id) ||
            conn.prepare(SQL.task).get({ id }) !== undefined
          ) {
            problem("VALIDATION_FAILED", "A task with this ID exists", i, "id");
          }
          // The draft's references are checked whatever dedupe finds, so whether a request is
          // valid never depends on what the space holds under its keys.
          const { record, ...placed } = where(op);
          // Dedupe by the keys of the draft's sources (A1 3.6). A draft without a client ID has
          // no source operation that can name it, so it has no keys.
          const keys = op.id === undefined ? [] : dedupe.keysOf(op.id);
          const mode = op.dedupe ?? "source_key";
          if (mode !== "none" && keys.length > 0) {
            const found = dedupe.match(keys, op.link_sources === true);
            if (mode === "new" && found.active.length > 0) {
              problem(
                "VALIDATION_FAILED",
                "An active task holds a source key of this draft: return it or link to it",
                i,
                "dedupe",
              );
            }
            const hit = mode === "source_key" ? found.match : undefined;
            if (hit !== undefined) {
              matched.set(id, hit);
              // The draft's sources will link to the match: later drafts find it by them too.
              if (hit.follows && hit.linkSources) {
                for (const key of keys) dedupe.link(key, hit.task);
              }
              return {
                i,
                op,
                target: hit.task,
                task: hit.task,
                touches: [],
                record: { existing: true },
                existing: { match: hit },
              };
            }
          }
          drafts.add(id);
          dedupe.created(id, keys);
          if (placed.sibling?.id === id) {
            problem(
              "VALIDATION_FAILED",
              "A task cannot stand next to itself",
              i,
              placed.sibling.side,
            );
          }
          return {
            i,
            op,
            target: id,
            task: id,
            touches: [],
            record: { ...valuesRecord(op), ...record },
            ...placed,
          };
        }
        case "task.patch": {
          const target = task(op.task, "task");
          const fields = [...Object.keys(op.set ?? {}), ...(op.unset ?? [])] as PatchableField[];
          return {
            i,
            op,
            target,
            task: target,
            touches: taskTouches(target, fields),
            record: {
              task: target,
              ...(op.set === undefined ? {} : { set: op.set }),
              ...(op.unset === undefined ? {} : { unset: op.unset }),
            },
          };
        }
        case "task.move": {
          const target = task(op.task, "task");
          const { record, ...placed } = where(op);
          if (placed.sibling?.id === target) {
            problem(
              "VALIDATION_FAILED",
              "A task cannot stand next to itself",
              i,
              placed.sibling.side,
            );
          }
          affected.add(target);
          return {
            i,
            op,
            target,
            task: target,
            touches: taskTouches(target, ["grouping"]),
            record: { task: target, ...record },
            ...placed,
          };
        }
        case "task.complete":
        case "task.reopen":
        case "task.archive": {
          const target = task(op.task, "task");
          const next =
            op.kind === "task.complete"
              ? "completed"
              : op.kind === "task.archive"
                ? "archived"
                : "active";
          // `if_active` on a task the request finds finished, as its earlier operations leave it,
          // writes nothing, so it touches nothing: an earlier finish touched the same fields, and
          // the base is checked once against the start (A1 3.7). Execution sees the same state, so
          // what the brake counts is what the commit finishes (A3 3.8.3).
          const kept =
            op.kind !== "task.reopen" &&
            op.if_active === true &&
            (lifecycles.get(target) ?? tasks.get(target)?.lifecycle ?? "active") !== "active";
          if (!kept) lifecycles.set(target, next);
          if (next !== "active" && !kept) affected.add(target);
          // A later draft of the request sees the lifecycle this leaves (A1 3.6).
          dedupe.lifecycle(target, next);
          return {
            i,
            op,
            target,
            task: target,
            // Archiving leaves the wrap-up alone: an active task has none waiting (A1 3.11.3).
            touches: kept
              ? []
              : taskTouches(
                  target,
                  op.kind === "task.archive" ? ["lifecycle"] : ["lifecycle", "wrap"],
                ),
            record: { task: target, ...inputOf(op, "task") },
          };
        }
        case "task.wrap_up": {
          const target = task(op.task, "task");
          // Like a finish: a later draft of the request is new work after it (A3 3.4.8).
          dedupe.wrapped(target);
          const record = { task: target, ...inputOf(op, "task") };
          const learnings = (op.learnings?.add ?? []).map(() => newId("lr", random));
          const touches: Touch[] = [];
          for (const id of op.learnings?.remove ?? []) {
            const row = conn.prepare(SQL.learning).get({ id });
            if (row === undefined || row["task_id"] !== target) {
              problem("NOT_FOUND", "No learning of this task has this ID", i, "learnings.remove");
            }
            // Removing it tombstones it: a base covers that it is still there. One removed at the
            // start is left as it is. Each operation that removes a live one touches it, also
            // after an earlier one of the request did, so `once` sees the change (A1 3.7).
            if (row["deleted_at"] === null) {
              const key = rowKey("learnings", id);
              if (!starts.has(key)) {
                starts.set(key, rowState("learnings", row, CHILD_FIELDS.learnings));
              }
              touches.push({ entity: "learnings", id, field: "deleted", task: target });
            }
          }
          const start = tasks.get(target);
          if (op.once === true && start?.raw["wrap_state"] === "wrapped") {
            // complete_task's rule (A3 3.4.8), judged on the task as the request found it: a
            // wrap-up that would change nothing is no change, any other is a conflict on `wrap`.
            const live = new Set(
              conn
                .prepare(SQL.liveLearnings)
                .all({ task: target })
                .map((row) => row["body"]),
            );
            const same =
              (op.outcome === undefined || op.outcome === start.raw["outcome"]) &&
              touches.length === 0 &&
              (op.clear_planning !== true ||
                (start.raw["planned_for"] === null && start.raw["focus_on"] === null)) &&
              (op.learnings?.add ?? []).every((body) => live.has(body));
            return same
              ? { i, op, target, task: target, touches: [], record, learnings, skip: true }
              : {
                  i,
                  op,
                  target,
                  task: target,
                  touches: [
                    { entity: "tasks", id: target, field: "wrap", task: target, held: true },
                  ],
                  record,
                  learnings,
                };
          }
          const planning: TaskField[] = op.clear_planning === true ? ["planned_for", "focus"] : [];
          return {
            i,
            op,
            target,
            task: target,
            touches: [...taskTouches(target, ["wrap", ...planning]), ...touches],
            record,
            learnings,
          };
        }
        case "task.delete":
        case "task.restore": {
          const deleting = op.kind === "task.delete";
          const target = task(op.task, "task", !deleting);
          if (deleting) affected.add(target);
          tombstones.set(target, deleting);
          // A deleted task holds no key, and a restored one holds its keys again (A1 3.6).
          dedupe.deleted(target, deleting);
          return {
            i,
            op,
            target,
            task: target,
            touches: taskTouches(target, ["deleted"]),
            record: { task: target },
          };
        }
        case "note.add":
        case "log.add": {
          // Base-free inserts: they fail only when the task is deleted (A1 3.5).
          const parent = task(op.task, "task");
          const id = op.kind === "note.add" ? newId("n", random) : newId("l", random);
          return {
            i,
            op,
            target: id,
            task: parent,
            touches: [],
            record: { task: parent, ...inputOf(op, "task") },
          };
        }
        case "source.add": {
          const parent = task(op.task, "task");
          const { key } = op.source;
          if (key !== undefined) dedupe.link(key, parent);
          let source: Id<"s"> | undefined = key === undefined ? undefined : draftSources.get(key);
          const touches: Touch[] = [];
          if (source === undefined) {
            const row = key === undefined ? undefined : conn.prepare(SQL.sourceByKey).get({ key });
            if (row === undefined) {
              source = newId("s", random);
              if (key !== undefined) draftSources.set(key, source);
            } else {
              source = new RowReader("sources", row).id("id", "s");
              // A link that exists at the start and was removed: reviving it changes its one
              // field, which needs its link version or a base (A1 3.5).
              const link = drafts.has(parent)
                ? undefined
                : conn.prepare(SQL.link).get({ task: parent, source });
              if (link !== undefined && link["removed_at"] !== null) {
                const id = `${parent}|${source}`;
                starts.set(rowKey("task_sources", id), linkState(link));
                touches.push({
                  entity: "task_sources",
                  id,
                  field: "removed",
                  task: parent,
                  ...(op.link_version === undefined ? {} : { linkVersion: op.link_version }),
                });
              }
            }
          }
          return {
            i,
            op,
            target: source,
            task: parent,
            touches,
            record: { task: parent, ...inputOf(op, "task") },
          };
        }
        case "task.context_append": {
          // Base-free (A1 3.5): no touch, so no base is needed and two appends commute. The field
          // still changes, so its version moves and a stale replace conflicts with it.
          const target = task(op.task, "task");
          return {
            i,
            op,
            target,
            task: target,
            touches: [],
            record: { task: target, text: op.text },
          };
        }
        case "place.clear": {
          const { owner, machine, key } = ownerOf(op);
          // One request either binds an owner's place or clears it: a place it binds (a new one,
          // or another folder for the one there) and clears again, or clears and binds anew, is
          // two intents in one.
          if (boundOwners.has(key)) {
            problem("VALIDATION_FAILED", "A place is bound and cleared in one request", i, "task");
          }
          clearedPlaces.add(key);
          const parent = owner.kind === "task" ? (owner.id as Id<"t">) : null;
          const row = drafts.has(owner.id as Id<"t">)
            ? undefined
            : conn.prepare(SQL.placeOf).get({ kind: owner.kind, owner: owner.id, machine });
          const record = { [owner.kind]: owner.id };
          if (row === undefined) {
            // Nothing is bound here: the clear changes nothing (A1 3.6, "if any").
            return { i, op, target: owner.id, task: parent, touches: [], record, owner };
          }
          const place = new RowReader("places", row).id("id", "pl");
          const touches: Touch[] = [];
          if (!starts.has(rowKey("places", place))) {
            // The base covers the place the caller saw: its folder and that it is bound (A1 3.6).
            starts.set(rowKey("places", place), rowState("places", row, CHILD_FIELDS.places));
            touches.push(
              { entity: "places", id: place, field: "folder", task: parent },
              { entity: "places", id: place, field: "deleted", task: parent },
            );
          }
          return {
            i,
            op,
            target: place,
            task: parent,
            touches,
            record,
            owner: { ...owner, bound: true },
          };
        }
        case "place.set": {
          const { owner, machine, key: ownerKey } = ownerOf(op);
          if (clearedPlaces.has(ownerKey)) {
            problem("VALIDATION_FAILED", "A place is bound and cleared in one request", i, "task");
          }
          boundOwners.add(ownerKey);
          const parent = owner.kind === "task" ? (owner.id as Id<"t">) : null;
          let place = draftPlaces.get(ownerKey);
          const touches: Touch[] = [];
          if (place === undefined) {
            const row = drafts.has(owner.id as Id<"t">)
              ? undefined
              : conn.prepare(SQL.placeOf).get({ kind: owner.kind, owner: owner.id, machine });
            if (row === undefined) {
              place = newId("pl", random);
              draftPlaces.set(ownerKey, place);
            } else {
              // Binding another folder changes the existing place: it needs a base (A1 3.6).
              place = new RowReader("places", row).id("id", "pl");
              starts.set(rowKey("places", place), rowState("places", row, CHILD_FIELDS.places));
              touches.push({ entity: "places", id: place, field: "folder", task: parent });
            }
          }
          return {
            i,
            op,
            target: place,
            task: parent,
            touches,
            record: { [owner.kind]: owner.id, ...inputOf(op, "task", "project", "area") },
            owner,
          };
        }
        case "launch.create": {
          // A launch is not a child of its task (launches.ts): its rows carry no task.
          const parent = task(op.task, "task");
          const machine = request.actor.machine_id;
          if (conn.prepare(SQL.machine).get({ id: machine }) === undefined) {
            problem(
              "VALIDATION_FAILED",
              "The request's machine has no record in this space",
              i,
              "actor.machine_id",
            );
          }
          if (op.place !== null) {
            const place = conn.prepare(LAUNCH_SQL.place).get({ id: op.place });
            if (place === undefined) problem("NOT_FOUND", "No place has this ID", i, "place");
            if (place["deleted_at"] !== null)
              problem("DELETED", "The place is removed", i, "place");
            if (place["machine_id"] !== machine) {
              problem("VALIDATION_FAILED", "The place is on another machine", i, "place");
            }
          }
          const record = { task: parent, ...inputOf(op, "task") };
          // A second click on the same task and instance while an intent is in Dispatching or
          // younger than 5 s gets that intent (A4 3.9.1), in this request or before it. Its age
          // is measured on the wall clock: commit instants stand still while the clock is behind
          // the newest commit (A1 3.9), which would keep an old click young.
          const key = `${parent}|${op.instance}`;
          const found = drafts.has(parent)
            ? undefined
            : conn.prepare(LAUNCH_SQL.focus).get({
                task: parent,
                instance: op.instance,
                machine,
                since: wall - FOCUS_MS,
                until: wall + FOCUS_MS,
              });
          const focus =
            draftLaunches.get(key) ??
            (found === undefined ? undefined : new RowReader("launches", found).id("id", "la"));
          if (focus !== undefined) {
            return {
              i,
              op,
              target: focus,
              task: null,
              touches: [],
              record,
              launch: { task: parent, reference: "", existing: true },
            };
          }
          const id = newId("la", random);
          const reference = newLaunchRef(conn, at, draftRefs, random);
          draftLaunches.set(key, id);
          draftRefs.add(reference);
          return {
            i,
            op,
            target: id,
            task: null,
            touches: [],
            record,
            launch: { task: parent, reference, existing: false },
          };
        }
        case "launch.transition": {
          // The compare-and-set on `expect` and the evidence rule run on the live row, so a
          // request sees its own earlier transitions (A1 3.7). The edge and the reason are known
          // here.
          if (![...draftLaunches.values()].includes(op.launch)) {
            const row = conn.prepare(LAUNCH_SQL.launch).get({ id: op.launch });
            if (row === undefined)
              return problem("NOT_FOUND", "No launch has this ID", i, "launch");
            if (row["machine_id"] !== request.actor.machine_id) {
              problem(
                "VALIDATION_FAILED",
                "A launch moves only on the machine that dispatched it",
                i,
                "launch",
              );
            }
            starts.set(
              rowKey("launches", op.launch),
              rowState("launches", row, CHILD_FIELDS.launches),
            );
          }
          if (!LAUNCH_EDGES[op.expect].includes(op.next)) {
            problem("VALIDATION_FAILED", "Not a transition of the launch state machine", i, "next");
          }
          const entering = op.next !== op.expect;
          const needsReason = entering && (op.next === "failed" || op.next === "unknown");
          if (needsReason !== (op.reason !== undefined)) {
            problem(
              "VALIDATION_FAILED",
              needsReason
                ? "Entering Failed or Unknown takes a reason code"
                : "Only entering Failed or Unknown takes a reason code",
              i,
              "reason",
            );
          }
          const reasons: readonly string[] =
            op.next === "failed" ? LAUNCH_FAIL_REASONS : LAUNCH_UNKNOWN_REASONS;
          if (needsReason && !reasons.includes(op.reason ?? "")) {
            problem("VALIDATION_FAILED", "Not a reason code of that state", i, "reason");
          }
          return { i, op, target: op.launch, task: null, touches: [], record: inputOf(op) };
        }
        case "run.create": {
          // A run is not a child of its task, as a launch is not (runs.ts): its rows carry no task.
          const parent = op.task === undefined ? null : task(op.task, "task");
          const machine = request.actor.machine_id;
          if (conn.prepare(SQL.machine).get({ id: machine }) === undefined) {
            problem(
              "VALIDATION_FAILED",
              "The request's machine has no record in this space",
              i,
              "actor.machine_id",
            );
          }
          if (op.place !== null) {
            const place = conn.prepare(RUN_SQL.place).get({ id: op.place });
            if (place === undefined) problem("NOT_FOUND", "No place has this ID", i, "place");
            if (place["deleted_at"] !== null) {
              problem("DELETED", "The place is removed", i, "place");
            }
            if (place["machine_id"] !== machine) {
              problem("VALIDATION_FAILED", "The place is on another machine", i, "place");
            }
          }
          const id = newId("ru", random);
          draftRuns.add(id);
          const record = { ...(parent === null ? {} : { task: parent }), ...inputOf(op, "task") };
          return { i, op, target: id, task: null, touches: [], record, runTask: parent };
        }
        case "run.transition": {
          // As a launch's: the compare-and-set and the evidence rule run on the live row.
          if (!draftRuns.has(op.run)) {
            const row = conn.prepare(RUN_SQL.run).get({ id: op.run });
            if (row === undefined) return problem("NOT_FOUND", "No run has this ID", i, "run");
            if (row["machine_id"] !== request.actor.machine_id) {
              problem(
                "VALIDATION_FAILED",
                "A run moves only on the machine that runs it",
                i,
                "run",
              );
            }
            starts.set(rowKey("runs", op.run), rowState("runs", row, CHILD_FIELDS.runs));
          }
          if (!RUN_EDGES[op.expect].includes(op.next)) {
            problem("VALIDATION_FAILED", "Not a transition of the run state machine", i, "next");
          }
          const entering = op.next !== op.expect;
          const reasons = RUN_REASONS[op.next];
          const needsReason = entering && reasons !== undefined;
          if (needsReason !== (op.reason !== undefined)) {
            problem(
              "VALIDATION_FAILED",
              needsReason
                ? "Entering this state takes a reason code"
                : "Only entering failed, timed_out or unknown takes a reason code",
              i,
              "reason",
            );
          }
          if (needsReason && !reasons.includes(op.reason ?? "")) {
            problem("VALIDATION_FAILED", "Not a reason code of that state", i, "reason");
          }
          const final = (FINAL_RUN_STATES as readonly RunState[]).includes(op.next);
          if (op.result !== undefined && !(entering && final)) {
            problem("VALIDATION_FAILED", "A result goes in entering a final state", i, "result");
          }
          return { i, op, target: op.run, task: null, touches: [], record: inputOf(op) };
        }
        case "pref.set": {
          // Who may write the key is decided here, so the refusal has its receipt (A3 3.8.3
          // step 4). The admin scope a policy key also needs is the caller's check (A6 3.6.3).
          const spec = must(preferenceSpec(op.key), "A checked pref.set names a declared key");
          if (!mayWrite(spec, request.actor.actor_kind)) {
            problem("PREFERENCE_FORBIDDEN", "Only the user changes this preference", i, "key");
          }
          const touches: Touch[] = [];
          const row = conn.prepare(SQL.preferenceRow).get({ id: op.key });
          if (row !== undefined) {
            // A newer build's value is kept unchanged: read-only here (A1 3.16).
            if (new RowReader("preferences", row).int("schema_ver", "count") > spec.schemaVer) {
              problem(
                "VALIDATION_FAILED",
                "A newer build wrote this preference: it is read-only here",
                i,
                "key",
              );
            }
            // Changing a stored value, or resetting it, needs a base (A1 3.5).
            const key = rowKey("preferences", op.key);
            if (!starts.has(key)) {
              starts.set(key, rowState("preferences", row, CHILD_FIELDS.preferences));
              touches.push({ entity: "preferences", id: op.key, field: "value", task: null });
            }
          }
          return { i, op, target: op.key, task: null, touches, record: inputOf(op) };
        }
        case "undo":
        case "redo":
          // A request of its own (request.ts), which #history decides.
          throw misuse("An undo or redo is never staged");
      }
    });
    return {
      ops,
      tasks,
      starts,
      affected: affected.size,
      statuses,
      refPrefix: space.refPrefix,
      wall,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Execute, in order, with read-your-writes, then coalesce.

  #execute(
    conn: Connection,
    request: CheckedRequest,
    space: SpaceRow,
    plan: Plan,
    asOf: AsOf,
    at: number,
  ): WriteResult {
    const seq = nextSeq(space);
    const run: Execution = {
      seq,
      at,
      request,
      plan,
      rows: new Map(),
      opWrites: new Map(),
      differs: new Map(),
    };
    const commitId = newId("op", this.#random);
    const { actor } = request;
    let changes: ChangeRow[];
    conn.exec("SAVEPOINT exec");
    try {
      conn.prepare(SQL.insertCommit).run({
        seq,
        id: commitId,
        epoch: space.authority.epoch,
        incarnation: space.authority.incarnation,
        at: run.at,
        actor_kind: actor.actor_kind,
        principal: actor.principal_id,
        author: actor.author_id ?? actor.principal_id,
        scope: actor.scope_id,
        machine: actor.machine_id,
        session: actor.session_id ?? null,
        run: actor.run_id ?? null,
        origin: actor.origin,
        request: request.request_id,
        ops: opsText(
          plan.ops.map((s) => ({ v: 1, op: s.op.kind, target: s.target, input: s.record })),
        ),
        affected: plan.affected,
        reason: request.reason ?? null,
        undo_status: request.undoable === true ? "done" : null,
      });
      for (const staged of plan.ops) apply(conn, run, staged);
      changes = coalesce(conn, run);
      if (changes.length > 0) {
        insertChanges(conn, seq, changes);
        // The search rows, in the same transaction as the state they index (A1 3.7, 3.12).
        if (this.#search) indexChanges(conn, seq, changes);
        const tasks = new Set(changes.flatMap((c) => (c.taskId === null ? [] : [c.taskId])));
        for (const id of tasks) conn.prepare(SQL.outbox).run({ key: id, seq });
        // The projection renders tasks and their children. Launch and run records are not.
        if (changes.some((c) => c.entity !== "launches" && c.entity !== "runs")) {
          conn.prepare(SQL.outbox).run({ key: "*", seq });
        }
        if (request.undoable === true) {
          conn.prepare(SQL.deadUndone).run({ principal: actor.principal_id });
        }
        conn.prepare(SQL.lastSeq).run({ seq });
        conn.exec("RELEASE exec");
      } else {
        // Nothing changed: no commit and no new seq (A1 3.7).
        rollBack(conn);
      }
    } catch (error) {
      // A validation error found only now, such as INVALID_TRANSITION, undoes the request's
      // writes and is decided as rejected. Any other error rolls back the whole transaction.
      if (error instanceof RequestProblem) rollBack(conn);
      throw error;
    }
    if (changes.length === 0) {
      return { ...accepted("unchanged", asOf), results: opResults(conn, run, []) };
    }
    return {
      ...accepted("applied", { ...asOf, seq }),
      commit: commitId,
      results: opResults(conn, run, changes),
    };
  }

  // ------------------------------------------------------------------------------------------
  // Undo and redo (A1 3.10.1, 3.10.4)

  /**
   * An undo or a redo. The principal's stack decides what it inverts: an undo the newest `done`
   * commit's change rows, a redo the rows of the oldest `undone` commit's undo. History (history.ts)
   * plans the inversion under each field's provenance, applies it and checks the holder rule on
   * what it made, and one commit of kind `undo` or `redo` records it and moves the stack: the
   * undone commit becomes `undone` with `undone_by`, a redone
   * one `done` again. An undo is all or nothing unless it is partial, and a partial undo leaves the
   * stack even when it inverts nothing, so the next undo reaches the commit below; a redo is all or
   * nothing. The commit itself never joins the stack.
   */
  #history(
    conn: Connection,
    request: CheckedRequest,
    op: HistoryOperation,
    space: SpaceRow,
    asOf: AsOf,
    at: number,
  ): WriteResult {
    const { actor } = request;
    const principal = actor.principal_id;
    const undo = op.kind === "undo";
    const target = undo ? undoTarget(conn, principal) : redoTarget(conn, principal);
    if (target === undefined) {
      return undo
        ? problem("NOTHING_TO_UNDO", "Nothing of yours is left to undo here", 0)
        : problem("NOTHING_TO_REDO", "Nothing of yours is left to redo here", 0);
    }
    // A caller that names the commit it means (a toast's own undo) never moves another.
    if (op.commit !== undefined && op.commit !== target.id) {
      problem(
        "INVALID_TRANSITION",
        undo
          ? "That change is not your newest one: read again"
          : "That change is not the next one to redo: read again",
        0,
        "commit",
      );
    }
    // The rows an undo inverts are the commit's own; a redo inverts its undo's.
    const inverted = undo ? target.seq : must(target.undoneBy, "An undone commit names its undo");
    if (inverted < space.undoFloorSeq) {
      problem("UNDO_BEFORE_FLOOR", "The change is older than the space's last format change", 0);
    }
    const partial = op.kind === "undo" && op.partial === true;
    const plan = planInversions(conn, readChanges(conn, inverted), {
      creating: new Set([target.seq]),
      refPrefix: space.refPrefix,
      partial,
      op: 0,
    });
    const conflict = (): WriteResult => ({
      ...refused(
        "conflict",
        asOf,
        {
          code: "UNDO_CONFLICT",
          // A redo is all or nothing (A1 3.10.1): it offers no partial form.
          message: undo
            ? "Someone changed a field of it since: undo the rest, or keep theirs"
            : "Someone changed one of its fields since: a redo is all or nothing",
        },
        plan.conflicts,
      ),
      target: target.id,
    });
    if (plan.conflicts.length > 0 && !partial) return conflict();
    const seq = nextSeq(space);
    const commitId = newId("op", this.#random);
    conn.exec("SAVEPOINT exec");
    try {
      // The inversions first: the holder rule is decided on the state they make (A1 3.10).
      const applied = applyInversions(conn, plan, {
        seq,
        at,
        principal,
        op: 0,
        refPrefix: space.refPrefix,
        partial,
      });
      if (applied === undefined) {
        rollBack(conn);
        return conflict();
      }
      conn.prepare(SQL.insertHistoryCommit).run({
        seq,
        id: commitId,
        epoch: space.authority.epoch,
        incarnation: space.authority.incarnation,
        at,
        actor_kind: actor.actor_kind,
        principal,
        author: actor.author_id ?? principal,
        scope: actor.scope_id,
        machine: actor.machine_id,
        session: actor.session_id ?? null,
        run: actor.run_id ?? null,
        origin: actor.origin,
        request: request.request_id,
        kind: op.kind,
        ops: opsText([
          {
            v: 1,
            op: op.kind,
            target: target.id,
            input: { commit: target.id, ...(partial ? { partial: true } : {}) },
          },
        ]),
        affected: affectedBy(plan.inversions),
        reason: request.reason ?? null,
        undo_of: undo ? target.seq : null,
        redo_of: undo ? null : target.seq,
      });
      const inverted = applied.changes.map((c) => ({ ...c, action: "set" as const }));
      insertChanges(conn, seq, inverted);
      // The search rows, as for any commit (A1 3.12): a tombstone drops a task's documents and
      // its children's, a restore brings them back, a field set back rewrites its document.
      if (this.#search) indexChanges(conn, seq, inverted);
      for (const task of applied.tasks) conn.prepare(SQL.outbox).run({ key: task, seq });
      if (applied.changes.length > 0) conn.prepare(SQL.outbox).run({ key: "*", seq });
      if (undo) conn.prepare(SQL.markUndone).run({ target: target.seq, seq });
      else conn.prepare(SQL.markRedone).run({ target: target.seq });
      conn.prepare(SQL.lastSeq).run({ seq });
      conn.exec("RELEASE exec");
    } catch (error) {
      if (error instanceof RequestProblem) rollBack(conn);
      throw error;
    }
    return {
      ...accepted("applied", { ...asOf, seq }),
      commit: commitId,
      results: [{ i: 0, status: "updated", id: target.id, version: seq }],
      // What a partial undo left as others set it (WriteResult.conflicts).
      conflicts: plan.conflicts,
    };
  }

  /** Closes the connection. Safe to call twice. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#conn.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Results

function refused(
  status: "rejected" | "conflict",
  asOf: AsOf,
  error: WriteProblem,
  conflicts: FieldConflict[] = [],
): WriteResult {
  return { status, as_of: formatAsOf(asOf), ...asOf, results: [], conflicts, error, warnings: [] };
}

function accepted(status: "applied" | "unchanged", asOf: AsOf): WriteResult {
  return { status, as_of: formatAsOf(asOf), ...asOf, results: [], conflicts: [], warnings: [] };
}

/**
 * One result per operation: created (it created its row), updated (it wrote a row the request
 * created, or a field of an existing row that changed) or unchanged.
 */
function opResults(conn: Connection, run: Execution, changes: readonly ChangeRow[]): OpResult[] {
  const changed = new Set(
    changes.map((c) => `${rowKey(c.entity as Entity, c.entityId)}|${c.field ?? ""}`),
  );
  const refOf = (task: Id<"t">): string =>
    formatTaskRef(run.plan.refPrefix, readTask(conn, task).ref);
  return run.plan.ops.map((staged): OpResult => {
    if (staged.existing !== undefined) {
      // The matched task, as it stands after the request (A1 3.6). A matched draft's result
      // says how it matched and the lifecycle it matched in.
      const task = readTask(conn, staged.target as Id<"t">);
      const { match } = staged.existing;
      return {
        i: staged.i,
        status: "existing",
        id: task.id,
        task: task.id,
        ref: formatTaskRef(run.plan.refPrefix, task.ref),
        version: task.version,
        ...(match === undefined
          ? {}
          : {
              matched_by: "source_key",
              lifecycle: match.lifecycle,
              ...(match.ambiguous === undefined
                ? {}
                : { ambiguous: match.ambiguous.map((t) => refOf(t)) }),
            }),
      };
    }
    const writes = run.opWrites.get(staged.i) ?? [];
    let status: OpResult["status"] = "unchanged";
    if (writes.some((w) => w.field === null)) status = "created";
    else if (
      writes.some(
        (w) =>
          run.rows.get(w.key)?.created !== undefined || changed.has(`${w.key}|${w.field ?? ""}`),
      )
    ) {
      status = "updated";
    }
    const { op, i } = staged;
    switch (op.kind) {
      case "note.add":
      case "log.add": {
        const entity = op.kind === "note.add" ? "notes" : "log_entries";
        const r = new RowReader(entity, readRow(conn, entity, staged.target));
        const task = r.id("task_id", "t");
        return {
          i,
          status,
          id: staged.target,
          task,
          ref: refOf(task),
          entry: formatEntryRef(
            op.kind === "note.add" ? "note" : "log",
            r.int("ordinal", "ordinal"),
          ),
          version: r.int("version", "seq"),
        };
      }
      case "source.add": {
        const task = must(staged.task, "A source link has a task");
        const link = readRow(conn, "task_sources", `${task}|${staged.target}`);
        const differs = run.differs.get(i);
        return {
          i,
          status,
          id: staged.target,
          task,
          ref: refOf(task),
          version: new RowReader("task_sources", link).int("version", "seq"),
          ...(differs === undefined || differs.length === 0 ? {} : { differs }),
        };
      }
      case "place.set": {
        const place = readRow(conn, "places", staged.target);
        const task = staged.task;
        return {
          i,
          status,
          id: staged.target,
          ...(task === null ? {} : { task, ref: refOf(task) }),
          version: new RowReader("places", place).int("version", "seq"),
        };
      }
      case "place.clear": {
        const task = staged.task;
        const owner = must(staged.owner, "A place has an owner");
        // The cleared place, or the owner when nothing was bound on this machine.
        const version =
          owner.bound === true
            ? new RowReader("places", readRow(conn, "places", staged.target)).int("version", "seq")
            : owner.kind === "task"
              ? readTask(conn, staged.target as Id<"t">).version
              : new RowReader(
                  owner.kind === "area" ? "areas" : "projects",
                  must(
                    conn
                      .prepare(owner.kind === "area" ? SQL.areaVersion : SQL.projectVersion)
                      .get({ id: owner.id }),
                    "A group the request names has gone",
                  ),
                ).int("version", "seq");
        return {
          i,
          status,
          id: staged.target,
          ...(task === null ? {} : { task, ref: refOf(task) }),
          version,
        };
      }
      case "launch.create":
      case "launch.transition": {
        const launch = readRow(conn, "launches", staged.target);
        return {
          i,
          status,
          id: staged.target,
          version: new RowReader("launches", launch).int("version", "seq"),
        };
      }
      case "run.create":
      case "run.transition": {
        const row = readRow(conn, "runs", staged.target);
        return {
          i,
          status,
          id: staged.target,
          version: new RowReader("runs", row).int("version", "seq"),
        };
      }
      case "pref.set": {
        // A key that was never set has no row, so a reset of it has version 0.
        const row = conn.prepare(SQL.preferenceRow).get({ id: staged.target });
        return {
          i,
          status,
          id: staged.target,
          version: row === undefined ? 0 : new RowReader("preferences", row).int("version", "seq"),
        };
      }
      case "task.wrap_up": {
        // Its target is the task: the learnings it adds change the task, they are not the result.
        const task = readTask(conn, staged.target as Id<"t">);
        return {
          i,
          status: status === "created" ? "updated" : status,
          id: task.id,
          ref: formatTaskRef(run.plan.refPrefix, task.ref),
          version: task.version,
        };
      }
      default: {
        const task = readTask(conn, staged.target as Id<"t">);
        return {
          i,
          status,
          id: task.id,
          ref: formatTaskRef(run.plan.refPrefix, task.ref),
          version: task.version,
        };
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Checks and staging helpers

/**
 * The tasks an inversion moves, completes, reopens, archives or tombstones: `commits.affected`
 * for A6's burst brake, which counts tasks rather than fields.
 */
function affectedBy(inversions: readonly Inversion[]): number {
  const counted = new Set(["grouping", "lifecycle", "deleted"]);
  return new Set(
    inversions.filter((i) => i.entity === "tasks" && counted.has(i.field)).map((i) => i.id),
  ).size;
}

function nextSeq(space: SpaceRow): number {
  const seq = space.lastSeq + 1;
  if (!inRange(seq, "seq")) {
    throw new StorageError("STORAGE_CONSTRAINT", "The space has used every commit number");
  }
  return seq;
}

function rollBack(conn: Connection): void {
  conn.exec("ROLLBACK TO exec");
  conn.exec("RELEASE exec");
}

function checkActor(conn: Connection, request: CheckedRequest): void {
  const { principal_id, actor_kind, author_id } = request.actor;
  if (conn.prepare(SQL.actor).get({ id: principal_id })?.["kind"] !== actor_kind) {
    problem(
      "VALIDATION_FAILED",
      "The principal is not an actor of that kind",
      undefined,
      "actor.principal_id",
    );
  }
  if (author_id !== undefined && conn.prepare(SQL.actor).get({ id: author_id }) === undefined) {
    problem(
      "VALIDATION_FAILED",
      "The author is not an actor of this space",
      undefined,
      "actor.author_id",
    );
  }
}

/** A1 3.5: a base from another epoch or incarnation, or from the future, is refused. */
function checkBase(base: Base, asOf: AsOf): void {
  const incarnation = isId(base.incarnation, "ai")
    ? base.incarnation === asOf.incarnation
    : base.incarnation === incarnationTag(asOf.incarnation);
  if (base.epoch !== asOf.epoch || !incarnation) {
    problem(
      "EPOCH_CHANGED",
      "The base comes from another epoch or incarnation: read again",
      undefined,
      "base",
    );
  }
  if (base.seq > asOf.seq) {
    problem("BASE_FROM_FUTURE", "The base is newer than the space", undefined, "base");
  }
}

function linkState(row: Row): RowState {
  return rowState("task_sources", row, CHILD_FIELDS.task_sources);
}

/**
 * The base covers every field of an existing row the request writes, checked once against the
 * state at the start of the request (A1 3.5, 3.7). A revived link may name its version instead.
 * Returns every conflict of the request.
 */
function preconditions(
  conn: Connection,
  request: CheckedRequest,
  plan: Plan,
  space: SpaceRow,
): FieldConflict[] {
  const checked = new Set<string>();
  const conflicts: FieldConflict[] = [];
  const conflictOf = (staged: StagedOp, touch: Touch, start: RowState): FieldConflict => {
    const version = versionOf(start, touch.field);
    const by = conn.prepare(SQL.commitAuthor).get({ seq: version });
    if (by === undefined) throw invalidValue(touch.entity, "fv");
    const r = new RowReader("commits", by);
    const task = touch.task === null ? undefined : plan.tasks.get(touch.task);
    return {
      op: staged.i,
      entity: touch.entity,
      id: touch.id,
      ...(touch.task === null
        ? {}
        : {
            task: touch.task,
            ...(task === undefined ? {} : { ref: formatTaskRef(space.refPrefix, task.ref) }),
          }),
      field: touch.field,
      value: columnsValue(start.raw, columnsOf(touch.entity, touch.field)),
      version,
      by: {
        actor: r.id("actor", "ac"),
        kind: r.text("kind"),
        label: r.text("label"),
        origin: r.text("origin"),
      },
      at: r.int("at", "instant"),
    };
  };
  for (const staged of plan.ops) {
    for (const touch of staged.touches) {
      const key = `${rowKey(touch.entity, touch.id)}|${touch.field}`;
      const start = plan.starts.get(rowKey(touch.entity, touch.id));
      if (start === undefined) throw misuse("A staged row has no start state");
      if (touch.held === true) {
        // The operation refuses the field as it stands, whatever the base: one conflict per field.
        const reported = conflicts.some(
          (c) => c.entity === touch.entity && c.id === touch.id && c.field === touch.field,
        );
        if (!reported) conflicts.push(conflictOf(staged, touch, start));
        checked.add(key);
        continue;
      }
      if (checked.has(key)) continue;
      checked.add(key);
      if (touch.linkVersion !== undefined) {
        // The link version is the link row's version (A1 3.4, 3.5).
        if (touch.linkVersion !== start.version) conflicts.push(conflictOf(staged, touch, start));
        continue;
      }
      const { base } = request;
      if (base === undefined) {
        throw new RequestProblem(
          {
            code: "BASE_REQUIRED",
            message:
              touch.entity === "task_sources"
                ? "Reviving a removed link needs its link version or a base"
                : "This change needs the as_of of a read as its base",
            op: staged.i,
            field: touch.entity === "task_sources" ? "link_version" : "base",
          },
          // A revival names who removed the link and when (A1 3.5).
          touch.entity === "task_sources" ? [conflictOf(staged, touch, start)] : [],
        );
      }
      if (versionOf(start, touch.field) <= base.seq) continue;
      conflicts.push(conflictOf(staged, touch, start));
    }
  }
  return conflicts;
}

/**
 * Resolves a task reference (A1 3.3): an ID, first among the tasks this request creates, then a
 * reference such as `M-14` with the space's prefix or an old one, then a legacy alias. A task this
 * request creates has no row yet.
 */
function resolveTask(
  conn: Connection,
  space: SpaceRow,
  ref: string,
  drafts: ReadonlySet<Id<"t">>,
  op: number,
  field: string,
): { id: Id<"t">; row?: TaskRow } {
  const found = (row: Row | undefined): { id: Id<"t">; row: TaskRow } => {
    if (row === undefined) return problem("NOT_FOUND", "No task has this reference", op, field);
    const task = decodeTask(row);
    return { id: task.id, row: task };
  };
  if (isId(ref, "t")) {
    if (drafts.has(ref)) return { id: ref };
    return found(conn.prepare(SQL.task).get({ id: ref }));
  }
  const parsed = parseTaskRef(ref);
  if (parsed !== undefined) {
    if (parsed.prefix !== space.refPrefix) {
      const alias = conn.prepare(SQL.alias).get({ namespace: "ref_prefix", alias: parsed.prefix });
      if (alias?.["entity_kind"] !== "space") {
        problem("SPACE_MISMATCH", "The reference has another space's prefix", op, field);
      }
    }
    return found(conn.prepare(SQL.taskByRef).get({ ref: parsed.ref }));
  }
  const alias = conn.prepare(SQL.alias).get({ namespace: "planning", alias: ref });
  const id = alias?.["entity_id"];
  if (alias?.["entity_kind"] !== "task" || !isId(id, "t")) {
    return problem("NOT_FOUND", "No task has this reference", op, field);
  }
  return found(conn.prepare(SQL.task).get({ id }));
}

/** An area or project by ID, else by live slug, else by an old slug (A1 3.3). */
function resolveGroupRow(conn: Connection, kind: "area" | "project", ref: string, op: number): Row {
  const byId = kind === "area" ? SQL.areaById : SQL.projectById;
  const bySlug = kind === "area" ? SQL.areaBySlug : SQL.projectBySlug;
  let row: Row | undefined;
  if (isId(ref, kind === "area" ? "a" : "p")) row = conn.prepare(byId).get({ id: ref });
  else {
    row = conn.prepare(bySlug).get({ slug: ref });
    if (row === undefined) {
      const alias = conn.prepare(SQL.alias).get({ namespace: "slug", alias: ref });
      const id = alias?.["entity_id"];
      if (alias?.["entity_kind"] === kind && typeof id === "string") {
        row = conn.prepare(byId).get({ id });
      }
    }
  }
  if (row === undefined) return problem("NOT_FOUND", `No ${kind} has this ID or slug`, op, kind);
  if (row["deleted_at"] !== null) return problem("DELETED", `The ${kind} is deleted`, op, kind);
  return row;
}

function resolveArea(conn: Connection, ref: string, op: number): Id<"a"> {
  return new RowReader("areas", resolveGroupRow(conn, "area", ref, op)).id("id", "a");
}

function resolveProject(
  conn: Connection,
  ref: string,
  op: number,
): { id: Id<"p">; areaId: Id<"a"> | null } {
  const r = new RowReader("projects", resolveGroupRow(conn, "project", ref, op));
  return {
    id: r.id("id", "p"),
    areaId: r.optText("area_id", (v) => isId(v, "a")) as Id<"a"> | null,
  };
}

/**
 * Whether a later operation of a matched draft goes on with the matched task (A1 3.6): only to one
 * active match, and only the draft's entries (`log.add`, `note.add`, `task.context_append`), with
 * its sources too when the draft asked to link them. Its place is what it would have created, so
 * it is left out. No other operation names a draft that may match (checkRequest).
 */
function follows(op: Operation, match: Match): boolean {
  if (!match.follows) return false;
  switch (op.kind) {
    case "log.add":
    case "note.add":
    case "task.context_append":
      return true;
    case "source.add":
      return match.linkSources;
    default:
      return false;
  }
}

/**
 * An operation's input for `commits.ops`: its fields but `kind` and the references named, which
 * staging resolved and the record holds as IDs.
 */
function inputOf(op: Operation, ...resolved: string[]): Record<string, unknown> {
  const drop = new Set(["kind", ...resolved]);
  return Object.fromEntries(Object.entries(op).filter(([key]) => !drop.has(key)));
}

/** The task values of a create, for `commits.ops`. */
function valuesRecord(op: TaskValues): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(op).filter(
      ([key, value]) => Object.hasOwn(TASK_FIELDS, key) && value !== undefined,
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Execution

function readTask(conn: Connection, id: Id<"t">): TaskRow {
  const row = conn.prepare(SQL.task).get({ id });
  if (row === undefined) throw misuse("A task the request names has gone");
  return decodeTask(row);
}

/**
 * Records that operation `i` created a row (`fields` null) or wrote `fields` of one. A field of a
 * row that existed before the request keeps the first operation that wrote it; a row the request
 * created gets one create row, whatever later operations wrote to it.
 */
function wrote(
  run: Execution,
  i: number,
  entity: Entity,
  id: string,
  task: Id<"t"> | null,
  fields: readonly string[] | null,
): void {
  const key = rowKey(entity, id);
  const ofOp = run.opWrites.get(i) ?? [];
  run.opWrites.set(i, ofOp);
  if (fields === null) {
    run.rows.set(key, { entity, id, task, order: run.rows.size, created: i, fields: new Map() });
    ofOp.push({ key, field: null });
    return;
  }
  let row = run.rows.get(key);
  if (row === undefined) {
    const start = run.plan.starts.get(key);
    if (start === undefined) throw misuse("A written row has no start state");
    row = { entity, id, task, order: run.rows.size, start, fields: new Map() };
    run.rows.set(key, row);
  }
  for (const field of fields) {
    ofOp.push({ key, field });
    if (row.created === undefined && !row.fields.has(field)) row.fields.set(field, i);
  }
}

function update(conn: Connection, id: Id<"t">, values: Record<string, SqlValue>): void {
  conn.prepare(updateTaskSql(Object.keys(values))).run({ ...values, id });
}

function dueColumns(due: Due | null): Record<string, SqlValue> {
  if (due === null) return { due_date: null, due_at: null, due_tz: null };
  if ("date" in due) return { due_date: due.date, due_at: null, due_tz: null };
  return { due_date: null, due_at: due.at, due_tz: due.tz };
}

/** The columns `values` sets, by logical field. */
function valueColumns(values: TaskValues): Map<TaskField, Record<string, SqlValue>> {
  const columns = new Map<TaskField, Record<string, SqlValue>>();
  const one = (field: Exclude<PatchableField, "due">, value: SqlValue | undefined): void => {
    if (value !== undefined) columns.set(field, { [TASK_FIELDS[field][0]]: value });
  };
  one("title", values.title);
  one("summary", values.summary);
  one("context", values.context);
  one("status", values.status);
  one("inbox", values.inbox === undefined ? undefined : values.inbox ? 1 : 0);
  one("priority", values.priority);
  one("effort", values.effort);
  one("planned_for", values.planned_for);
  one("focus", values.focus);
  one("owner", values.owner);
  one("waiting_on", values.waiting_on);
  one("source_at", values.source_at);
  one("reviewed_at", values.reviewed_at);
  if (values.due !== undefined) columns.set("due", dueColumns(values.due));
  return columns;
}

const defaultStatus = (statuses: readonly string[]): string =>
  statuses.includes("open") ? "open" : (statuses[0] ?? "open");

/** What `task.patch` writes when it clears a field (A1 3.6: `unset priority` sets 4). */
function clearedColumns(
  field: PatchableField,
  statuses: readonly string[],
): Record<string, SqlValue> {
  switch (field) {
    case "summary":
    case "context":
      return { [field]: "" };
    case "status":
      return { status: defaultStatus(statuses) };
    case "inbox":
      return { inbox: 0 };
    case "priority":
      return { priority: 4 };
    case "due":
      return dueColumns(null);
    case "title":
      throw misuse("A title cannot be cleared");
    default:
      return { [TASK_FIELDS[field][0]]: null };
  }
}

/** A position query in `group`, excluding `self`. */
function positionIn(
  conn: Connection,
  sql: { project: string; area: string },
  group: Group,
  self: Id<"t">,
  at?: string,
): string | undefined {
  const params = { self, ...(at === undefined ? {} : { at }) };
  const row =
    group.projectId === null
      ? conn.prepare(sql.area).get({ ...params, area: group.areaId })
      : conn.prepare(sql.project).get({ ...params, project: group.projectId });
  const value = row?.["p"];
  if (value === null || value === undefined) return undefined;
  if (!isPosition(value)) throw invalidValue("tasks", "position");
  return value;
}

/**
 * The group and position a task takes: the explicit group, else the sibling's, else its own;
 * right next to the sibling, else at the end of a new group, else where it is. A task that
 * already stands where it is asked to keeps its position.
 */
function place(
  conn: Connection,
  staged: StagedOp,
  self: Id<"t">,
  current: TaskRow | undefined,
): Group & { position: string } {
  const sibling = staged.sibling === undefined ? undefined : readTask(conn, staged.sibling.id);
  const intent = staged.group;
  const group: Group =
    intent !== undefined
      ? {
          areaId: intent.area === "keep" ? (current?.areaId ?? null) : intent.area,
          projectId: intent.project,
        }
      : (sibling ?? current ?? { areaId: null, projectId: null });
  const target = { areaId: group.areaId, projectId: group.projectId };
  const kept = current !== undefined && sameGroup(current, target) ? current.position : undefined;
  if (sibling !== undefined && staged.sibling !== undefined) {
    if (!sameGroup(sibling, target)) {
      problem(
        "VALIDATION_FAILED",
        "The sibling is in another group",
        staged.i,
        staged.sibling.side,
      );
    }
    const [low, high] =
      staged.sibling.side === "after"
        ? [sibling.position, positionIn(conn, SQL.next, target, self, sibling.position)]
        : [positionIn(conn, SQL.previous, target, self, sibling.position), sibling.position];
    if (
      kept !== undefined &&
      (low === undefined || low < kept) &&
      (high === undefined || kept < high)
    ) {
      return { ...target, position: kept };
    }
    return { ...target, position: positionBetween(low, high) };
  }
  if (kept !== undefined) return { ...target, position: kept };
  const last = positionIn(conn, SQL.last, target, self);
  return { ...target, position: positionBetween(last, undefined) };
}

/** The fields of a source's input that an existing source holds otherwise (A1 3.6). */
function sourceDiffers(row: Row, source: SourceFields): string[] {
  const given: [string, unknown, unknown][] = [
    ["kind", source.kind, row["kind"]],
    ["title", source.title, row["title"]],
    ["who", source.who, row["who"]],
    ["ref", source.ref, row["ref"]],
    ["url", source.url, row["url"]],
    ["at", source.at, row["at"]],
  ];
  return given
    .filter(([, input, stored]) => input !== undefined && input !== stored)
    .map(([field]) => field);
}

function apply(conn: Connection, run: Execution, staged: StagedOp): void {
  // A matched draft, or an operation of it that the rebinding rules leave out: nothing to write.
  if (staged.existing !== undefined) return;
  const { op, i } = staged;
  const { actor } = run.request;
  const author = actor.author_id ?? actor.principal_id;
  // A request marked `active` changes active tasks only (A3 3.4.6), checked on the state the
  // request sees, so the refusal is decided here and has its receipt. A task the request creates
  // is active.
  if (
    run.request.active === true &&
    op.kind !== "task.create" &&
    staged.task !== null &&
    readTask(conn, staged.task).lifecycle !== "active"
  ) {
    problem("TASK_NOT_ACTIVE", "Only an active task changes here", i, "task");
  }
  switch (op.kind) {
    case "task.create": {
      const target = staged.target as Id<"t">;
      const values = valueColumns(op);
      const column = (field: TaskField, name: string, fallback: SqlValue): SqlValue =>
        values.get(field)?.[name] ?? fallback;
      const placed = place(conn, staged, target, undefined);
      conn.prepare(SQL.insertTask).run({
        id: target,
        ref: takeTaskRef(conn),
        title: op.title,
        summary: column("summary", "summary", ""),
        context: column("context", "context", ""),
        status: column("status", "status", defaultStatus(run.plan.statuses)),
        inbox: column("inbox", "inbox", 0),
        priority: column("priority", "priority", 4),
        effort: column("effort", "effort", null),
        due_date: column("due", "due_date", null),
        due_at: column("due", "due_at", null),
        due_tz: column("due", "due_tz", null),
        planned_for: column("planned_for", "planned_for", null),
        focus_on: column("focus", "focus_on", null),
        owner: column("owner", "owner", null),
        waiting_on: column("waiting_on", "waiting_on", null),
        area_id: placed.areaId,
        project_id: placed.projectId,
        position: placed.position,
        source_at: column("source_at", "source_at", null),
        reviewed_at: column("reviewed_at", "reviewed_at", null),
        at: run.at,
        author,
        session: actor.session_id ?? null,
        seq: run.seq,
      });
      wrote(run, i, "tasks", target, target, null);
      return;
    }
    case "task.patch": {
      const target = staged.target as Id<"t">;
      const columns = valueColumns(op.set ?? {});
      for (const field of op.unset ?? [])
        columns.set(field, clearedColumns(field, run.plan.statuses));
      const values: Record<string, SqlValue> = {};
      for (const part of columns.values()) Object.assign(values, part);
      update(conn, target, values);
      wrote(run, i, "tasks", target, target, [...columns.keys()]);
      return;
    }
    case "task.context_append": {
      // On the context as it is now: an earlier operation of the request may have changed it.
      const target = staged.target as Id<"t">;
      const current = new RowReader("tasks", readTask(conn, target).raw).text("context");
      const context = current === "" ? op.text : `${current}\n\n${op.text}`;
      if (Buffer.byteLength(context, "utf8") > WRITE_LIMITS.context) {
        problem("TOO_LARGE", "The context would be larger than 64 KiB", i, "text");
      }
      update(conn, target, { context });
      wrote(run, i, "tasks", target, target, ["context"]);
      return;
    }
    case "task.move": {
      const target = staged.target as Id<"t">;
      const placed = place(conn, staged, target, readTask(conn, target));
      update(conn, target, {
        area_id: placed.areaId,
        project_id: placed.projectId,
        position: placed.position,
      });
      wrote(run, i, "tasks", target, target, ["grouping"]);
      return;
    }
    case "task.complete": {
      const target = staged.target as Id<"t">;
      if (readTask(conn, target).lifecycle !== "active") {
        // complete_task leaves a task the user finished first as it is (A3 3.4.8).
        if (op.if_active === true) return;
        problem("INVALID_TRANSITION", "Only an active task can be completed", i, "task");
      }
      // A1 3.11.1: with an outcome the task is wrapped at once, else it waits for its wrap-up.
      // An earlier outcome stays until a new one replaces it (A1 3.11.3).
      update(conn, target, {
        lifecycle: "completed",
        completed_at: run.at,
        completed_by: actor.principal_id,
        archived_reason: null,
        ...(op.outcome === undefined
          ? { wrap_state: "pending" }
          : { wrap_state: "wrapped", outcome: op.outcome, wrapped_at: run.at, wrapped_by: author }),
      });
      wrote(run, i, "tasks", target, target, ["lifecycle", "wrap"]);
      return;
    }
    case "task.reopen": {
      const target = staged.target as Id<"t">;
      if (readTask(conn, target).lifecycle === "active") {
        problem(
          "INVALID_TRANSITION",
          "Only a completed or archived task can be reopened",
          i,
          "task",
        );
      }
      // A1 3.11.3: back to active, wrap_state cleared, the outcome kept as the previous result.
      // completed_at and completed_by are cleared, and their values stay in history.
      update(conn, target, {
        lifecycle: "active",
        completed_at: null,
        completed_by: null,
        archived_reason: null,
        wrap_state: null,
      });
      wrote(run, i, "tasks", target, target, ["lifecycle", "wrap"]);
      return;
    }
    case "task.archive": {
      const target = staged.target as Id<"t">;
      if (readTask(conn, target).lifecycle !== "active") {
        if (op.if_active === true) return;
        problem("INVALID_TRANSITION", "Only an active task can be archived", i, "task");
      }
      // A1 3.11.3: work that will not be done. No completion time, and no wrap-up waits for it;
      // an earlier outcome stays as the previous result.
      update(conn, target, {
        lifecycle: "archived",
        completed_at: null,
        completed_by: null,
        archived_reason: op.reason ?? null,
      });
      wrote(run, i, "tasks", target, target, ["lifecycle"]);
      return;
    }
    case "task.wrap_up": {
      const target = staged.target as Id<"t">;
      if (readTask(conn, target).lifecycle === "active") {
        problem("INVALID_TRANSITION", "Only a completed or archived task is wrapped up", i, "task");
      }
      if (staged.skip === true) return;
      // A1 3.11.2: additive. The outcome, the mark and, when asked, the short planning scalars.
      // Context, notes, log entries, sources and places are never written here.
      const values: Record<string, SqlValue> = {
        wrap_state: "wrapped",
        wrapped_at: run.at,
        wrapped_by: author,
        ...(op.outcome === undefined ? {} : { outcome: op.outcome }),
      };
      const fields: TaskField[] = ["wrap"];
      if (op.clear_planning === true) {
        Object.assign(values, { planned_for: null, focus_on: null });
        fields.push("planned_for", "focus");
      }
      update(conn, target, values);
      wrote(run, i, "tasks", target, target, fields);
      wrapLearnings(conn, run, staged, op, target, author);
      return;
    }
    case "task.delete":
    case "task.restore": {
      // A1 3.11.4: the tombstone only. Every row of the task and its history stay.
      const target = staged.target as Id<"t">;
      if (op.kind === "task.restore" && !readTask(conn, target).deleted) {
        problem("INVALID_TRANSITION", "Only a deleted task can be restored", i, "task");
      }
      update(
        conn,
        target,
        op.kind === "task.delete"
          ? { deleted_at: run.at, deleted_by: actor.principal_id }
          : { deleted_at: null, deleted_by: null },
      );
      wrote(run, i, "tasks", target, target, ["deleted"]);
      return;
    }
    case "note.add": {
      const task = must(staged.task, "A note has a task");
      conn.prepare(SQL.insertNote).run({
        id: staged.target,
        task,
        ordinal: nextEntryOrdinal(conn, "note", task),
        author,
        addressee: op.addressee ?? "self",
        body: op.body,
        at: run.at,
        seq: run.seq,
      });
      wrote(run, i, "notes", staged.target, task, null);
      return;
    }
    case "log.add": {
      const task = must(staged.task, "A log entry has a task");
      conn.prepare(SQL.insertLog).run({
        id: staged.target,
        task,
        ordinal: nextEntryOrdinal(conn, "log", task),
        author,
        session: actor.session_id ?? null,
        run: actor.run_id ?? null,
        kind: op.log_kind ?? "progress",
        body: op.body,
        at: run.at,
        seq: run.seq,
      });
      wrote(run, i, "log_entries", staged.target, task, null);
      return;
    }
    case "source.add": {
      const task = must(staged.task, "A source link has a task");
      const source = staged.target;
      const { source: fields } = op;
      // An earlier operation of the request may have created the source: read it as it is now.
      const existing = conn.prepare(SQL.source).get({ id: source });
      if (existing === undefined) {
        conn.prepare(SQL.insertSource).run({
          id: source,
          key: fields.key ?? null,
          kind: fields.kind,
          title: fields.title,
          who: fields.who ?? null,
          ref: fields.ref ?? null,
          url: fields.url ?? null,
          sent: fields.at ?? null,
          at: run.at,
          author,
          seq: run.seq,
        });
        wrote(run, i, "sources", source, task, null);
      } else {
        // An existing source keeps its metadata: the result lists what differs (A1 3.6).
        run.differs.set(i, sourceDiffers(existing, fields));
      }
      const link = conn.prepare(SQL.link).get({ task, source });
      if (link === undefined) {
        // A new link goes after the task's other links, removed ones included.
        const last = conn.prepare(SQL.lastLink).get({ task })?.["p"] ?? undefined;
        if (last !== undefined && !isPosition(last)) throw invalidValue("task_sources", "position");
        conn.prepare(SQL.insertLink).run({
          task,
          source,
          role: op.role ?? "origin",
          position: positionBetween(last, undefined),
          author,
          seq: run.seq,
        });
        wrote(run, i, "task_sources", `${task}|${source}`, task, null);
      } else if (link["removed_at"] !== null) {
        conn.prepare(SQL.reviveLink).run({ task, source });
        wrote(run, i, "task_sources", `${task}|${source}`, task, ["removed"]);
      }
      // A live link is unchanged (A1 3.6).
      return;
    }
    case "place.set": {
      const owner = must(staged.owner, "A place has an owner");
      const values = {
        root: op.root,
        path: op.path,
        kind: op.place_kind ?? "folder",
        identity:
          op.git_remote === undefined ? null : JSON.stringify({ git_remote: op.git_remote }),
      };
      const row = conn
        .prepare(SQL.placeOf)
        .get({ kind: owner.kind, owner: owner.id, machine: actor.machine_id });
      if (row === undefined) {
        conn.prepare(SQL.insertPlace).run({
          id: staged.target,
          owner_kind: owner.kind,
          owner: owner.id,
          machine: actor.machine_id,
          ...values,
          at: run.at,
          seq: run.seq,
        });
        wrote(run, i, "places", staged.target, staged.task, null);
        return;
      }
      if (row["id"] !== staged.target) throw misuse("A place is not the one staging found");
      conn.prepare(SQL.updatePlace).run({ id: staged.target, ...values });
      wrote(run, i, "places", staged.target, staged.task, ["folder"]);
      return;
    }
    case "place.clear": {
      const owner = must(staged.owner, "A place has an owner");
      if (owner.bound !== true) return;
      // A second clear of the same place in the request finds it cleared: nothing more to do.
      if (readRow(conn, "places", staged.target)["deleted_at"] !== null) return;
      conn.prepare(SQL.clearPlace).run({ id: staged.target, at: run.at });
      wrote(run, i, "places", staged.target, staged.task, ["deleted"]);
      return;
    }
    case "launch.create": {
      const launch = must(staged.launch, "A launch is staged with its task and reference");
      // The intent in flight is returned as it is: nothing is written.
      if (launch.existing) return;
      conn.prepare(LAUNCH_SQL.insert).run({
        id: staged.target,
        reference: launch.reference,
        task: launch.task,
        session: op.session ?? null,
        instance: op.instance,
        machine: actor.machine_id,
        route: op.route,
        place: op.place,
        task_version: op.task_version,
        brief_hash: op.brief_hash,
        // The time of each state is the wall clock's (Plan.wall); created_at stays the commit's.
        detail: detailText({ evidence: op.evidence ?? {}, at: { prepared: run.plan.wall } }),
        at: run.at,
        seq: run.seq,
      });
      wrote(run, i, "launches", staged.target, null, null);
      return;
    }
    case "launch.transition": {
      // One compare-and-set (A4 3.16.1): the launch moves only from the state the caller saw.
      const current = decodeLaunch(readRow(conn, "launches", staged.target));
      if (current.state !== op.expect) {
        problem("INVALID_TRANSITION", "The launch moved on: read it again", i, "expect");
      }
      // The record the caller decided on: any change since, a self edge's evidence included,
      // makes the decision stale (a sweep that read the launch before its claim).
      if (op.expect_version !== undefined && current.version !== op.expect_version) {
        problem("INVALID_TRANSITION", "The launch changed: read it again", i, "expect_version");
      }
      // Evidence only grows: a key the record holds keeps its value, so a claim is recorded once.
      const held = current.evidence;
      const incoming = op.evidence ?? {};
      for (const [key, value] of Object.entries(incoming)) {
        if (Object.hasOwn(held, key) && held[key] !== value) {
          problem("INVALID_TRANSITION", "The launch holds other evidence", i, `evidence.${key}`);
        }
      }
      const entering = op.next !== current.state;
      const grows = Object.keys(incoming).some((key) => !Object.hasOwn(held, key));
      if (!entering && !grows) return;
      conn.prepare(LAUNCH_SQL.update).run({
        id: staged.target,
        state: op.next,
        reason: entering ? (op.reason ?? null) : current.reason,
        detail: detailText({
          evidence: { ...held, ...incoming },
          at: entering ? { ...current.at, [op.next]: run.plan.wall } : current.at,
        }),
        at: run.at,
      });
      wrote(run, i, "launches", staged.target, null, ["state"]);
      return;
    }
    case "run.create": {
      conn.prepare(RUN_SQL.insert).run({
        id: staged.target,
        task: staged.runTask ?? null,
        routine: op.routine ?? null,
        session: op.session ?? null,
        instance: op.instance,
        machine: actor.machine_id,
        adapter: op.adapter,
        place: op.place,
        request: op.request ?? null,
        spec: sortedJson({
          brief_hash: op.brief_hash,
          permission: op.permission,
          limits: op.limits,
        }),
        // The time of each state is the wall clock's (Plan.wall), as a launch's.
        detail: runDetailText({ evidence: {}, at: { queued: run.plan.wall } }),
        at: run.plan.wall,
        seq: run.seq,
      });
      wrote(run, i, "runs", staged.target, null, null);
      return;
    }
    case "run.transition": {
      // One compare-and-set (A4 3.11.2, 3.16.1): the run moves only from the record the caller saw.
      const current = decodeRun(readRow(conn, "runs", staged.target));
      if (current.state !== op.expect) {
        problem("INVALID_TRANSITION", "The run moved on: read it again", i, "expect");
      }
      if (current.version !== op.expect_version) {
        problem("INVALID_TRANSITION", "The run changed: read it again", i, "expect_version");
      }
      // Evidence only grows: a key the record holds keeps its value, so a claim is recorded once.
      const held = current.evidence;
      const incoming = op.evidence ?? {};
      for (const [key, value] of Object.entries(incoming)) {
        if (Object.hasOwn(held, key) && held[key] !== value) {
          problem("INVALID_TRANSITION", "The run holds other evidence", i, `evidence.${key}`);
        }
      }
      // A result goes in once: a run settled from unknown keeps the result it already has.
      if (op.result !== undefined && current.result !== null) {
        problem("INVALID_TRANSITION", "The run holds its result", i, "result");
      }
      const entering = op.next !== current.state;
      const grows = Object.keys(incoming).some((key) => !Object.hasOwn(held, key));
      if (!entering && !grows) return;
      const wall = run.plan.wall;
      const final = (FINAL_RUN_STATES as readonly RunState[]).includes(op.next);
      conn.prepare(RUN_SQL.update).run({
        id: staged.target,
        state: op.next,
        reason: entering ? (op.reason ?? null) : current.reason,
        detail: runDetailText({
          evidence: { ...held, ...incoming },
          at: entering ? { ...current.at, [op.next]: wall } : current.at,
        }),
        result:
          op.result === undefined
            ? current.result === null
              ? "{}"
              : sortedJson(current.result)
            : sortedJson(op.result),
        started_at:
          entering && op.next === "running" ? (current.started_at ?? wall) : current.started_at,
        ended_at: entering && final ? wall : current.ended_at,
      });
      wrote(run, i, "runs", staged.target, null, ["state"]);
      return;
    }
    case "pref.set": {
      const spec = must(preferenceSpec(op.key), "A checked pref.set names a declared key");
      const values = {
        id: op.key,
        value: op.value === null ? "null" : canonicalJson(op.value),
        schema_ver: spec.schemaVer,
      };
      // An earlier operation of the request may have created the row: read it as it is now.
      if (conn.prepare(SQL.preferenceRow).get({ id: op.key }) === undefined) {
        // Nothing is set: a reset changes nothing.
        if (op.value === null) return;
        conn
          .prepare(SQL.insertPreference)
          .run({ ...values, policy: spec.policy ? 1 : 0, seq: run.seq });
        wrote(run, i, "preferences", op.key, null, null);
        return;
      }
      conn.prepare(SQL.updatePreference).run(values);
      wrote(run, i, "preferences", op.key, null, ["value"]);
      return;
    }
  }
}

/**
 * A wrap-up's learnings (A1 3.11.2): the removed ones are tombstoned, their text kept, and each new
 * text the task does not hold yet becomes a row after its others. A task holds at most 20 live
 * learnings (A1 3.7).
 */
function wrapLearnings(
  conn: Connection,
  run: Execution,
  staged: StagedOp,
  op: TaskWrapUp,
  task: Id<"t">,
  author: Id<"ac">,
): void {
  for (const id of op.learnings?.remove ?? []) {
    // Staging found it under this task. One removed already is left as it is.
    if (readRow(conn, "learnings", id)["deleted_at"] !== null) continue;
    conn.prepare(SQL.removeLearning).run({ id, at: run.at });
    wrote(run, staged.i, "learnings", id, task, ["deleted"]);
  }
  const live = conn.prepare(SQL.liveLearnings).all({ task });
  const held = new Set(live.map((row) => row["body"]));
  let count = live.length;
  const ids = must(staged.learnings, "A wrap-up is staged with its learnings' IDs");
  (op.learnings?.add ?? []).forEach((body, k) => {
    if (held.has(body)) return;
    held.add(body);
    count += 1;
    const last = conn.prepare(SQL.lastLearning).get({ task })?.["p"] ?? undefined;
    if (last !== undefined && !isPosition(last)) throw invalidValue("learnings", "position");
    const id = must(ids[k], "A learning to add has its ID");
    conn.prepare(SQL.insertLearning).run({
      id,
      task,
      position: positionBetween(last, undefined),
      body,
      author,
      at: run.at,
      seq: run.seq,
    });
    wrote(run, staged.i, "learnings", id, task, null);
  });
  // The limit refuses an addition past it, never a wrap-up that adds nothing.
  if (count > WRITE_LIMITS.learnings && count > live.length) {
    problem("TOO_LARGE", "A task holds at most 20 learnings", staged.i, "learnings.add");
  }
}

function withoutDerived(row: Row): Row {
  const derived = new Set<string>(DERIVED_COLUMNS);
  return Object.fromEntries(Object.entries(row).filter(([column]) => !derived.has(column)));
}

/**
 * One change row per (row, field) that ended somewhere else than it started, a create row per new
 * row with its final columns, and the field versions, row versions and touched marks that follow
 * (A1 3.4, 3.5, 3.7). Change rows go in the order their rows, then fields, were first written. A
 * task whose child rows changed is touched, and keeps its own version (A1 3.5).
 */
function coalesce(conn: Connection, run: Execution): ChangeRow[] {
  const changes: ChangeRow[] = [];
  const touched = new Set<Id<"t">>();
  for (const row of [...run.rows.values()].sort((a, b) => a.order - b.order)) {
    const final = readRow(conn, row.entity, row.id);
    if (row.created !== undefined) {
      changes.push({
        op: row.created,
        entity: row.entity,
        entityId: row.id,
        taskId: row.task,
        action: "create",
        field: null,
        before: null,
        after: JSON.stringify(withoutDerived(final)),
        beforeVer: null,
        beforeProv: null,
      });
      if (row.task !== null) touched.add(row.task);
      continue;
    }
    const start = must(row.start, "A written row has no start state");
    const fv = { ...start.fv };
    const fp = { ...start.fp };
    let changed = false;
    for (const [field, op] of row.fields) {
      const columns = columnsOf(row.entity, field);
      const before = fieldJson(columnsValue(start.raw, columns));
      const after = fieldJson(columnsValue(final, columns));
      if (before === after) continue;
      changes.push({
        op,
        entity: row.entity,
        entityId: row.id,
        taskId: row.task,
        action: "set",
        field,
        before,
        after,
        beforeVer: versionOf(start, field),
        beforeProv: provenanceOf(start, field),
      });
      fv[field] = run.seq;
      fp[field] = run.seq;
      changed = true;
    }
    if (changed) {
      setVersions(conn, row, run.seq, fv, fp);
      if (row.task !== null) touched.add(row.task);
    }
  }
  for (const task of touched) conn.prepare(SQL.touched).run({ id: task, seq: run.seq });
  return changes;
}

function insertChanges(conn: Connection, seq: number, changes: readonly ChangeRow[]): void {
  const insert = conn.prepare(SQL.insertChange);
  changes.forEach((change, index) => {
    insert.run({
      seq,
      n: index + 1,
      op: change.op,
      entity: change.entity,
      entity_id: change.entityId,
      task_id: change.taskId,
      action: change.action,
      field: change.field,
      before: change.before,
      after: change.after,
      before_ver: change.beforeVer,
      before_prov: change.beforeProv,
      after_prov: change.afterProv ?? seq,
    });
  });
}
