// The write path (A1 3.7, 3.8, X11, X12): the one way a space changes. A request of one or more
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
import { mayWrite, preferenceSpec } from "@ttasks/contracts/preferences";
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
import { REPLIED_SQL } from "../questions.ts";
import type { SchemaStep } from "../schema.ts";
import { indexChanges } from "../search/documents.ts";
import { repairSearchIndex } from "../search/remake.ts";
import { hasSearchTables } from "../search/tables.ts";
import type { OpenedSpace } from "../space.ts";
import type { CheckedDriver } from "../startup-check.ts";
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
  carriedTo,
  decodeFolder,
  FOLDER_SQL,
  folderHolder,
  folderProblem,
  machineOs,
  type FolderOs,
} from "./folders.ts";
import {
  applyInversions,
  brokenIn,
  groupBreaks,
  lastApplied,
  newerWorkOf,
  type Held,
  planInversions,
  readChanges,
  redoSteps,
  undoTarget,
  type GroupTouch,
  type Inversion,
} from "./history.ts";
import {
  decodeLaunch,
  detailText,
  LAUNCH_EDGES,
  LAUNCH_SQL,
  newLaunchRef,
  readLaunch,
  readOpenLaunches,
  type LaunchRecord,
} from "./launches.ts";
import { canonicalJson } from "./canonical.ts";
import { markProjected, queueProjection, type ProjectedBatch } from "./outbox.ts";
import { isPosition, positionBetween } from "./positions.ts";
import { freeSlug } from "./slugs.ts";
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
  requestFingerprint,
  writeReceipt,
  type Receipt,
  type ReceiptLookup,
} from "./receipts.ts";
import { provenanceOf, rowState, versionOf, type RowState } from "./row-state.ts";
import { inTrashSql } from "./trash.ts";
import {
  checkRequest,
  FOLDER_OPERATIONS,
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
 * that did not would make the history differ from the rows, so it is refused as a bug. A folder's
 * path is the one exception: the row holds it exactly as sent, and so does its operation.
 */
function opsText(entries: readonly OpsEntry[]): string {
  const raw = new Set<unknown>();
  for (const entry of entries) {
    if (FOLDER_OPERATIONS.has(entry.op as Operation["kind"])) raw.add(entry.input["path"]);
  }
  return JSON.stringify(entries, (key, value: unknown) => {
    if (
      typeof value === "string" &&
      normaliseStored(value) !== value &&
      !(key === "path" && raw.has(value))
    ) {
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
  | "preferences"
  | "areas"
  | "projects"
  | "folders";

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
          entity === "notes" ||
          entity === "preferences" ||
          entity === "areas" ||
          entity === "projects" ||
          entity === "folders"
        ? CHILD_FIELDS[entity]
        : undefined;
  const columns = fields?.[field];
  if (columns === undefined) throw misuse("A write names a field its row does not have");
  return columns;
}

/** A logical field's value in a row (A1 3.4): its columns' value. */
function valueOf(entity: Entity, row: Readonly<Record<string, unknown>>, field: string): unknown {
  return columnsValue(row, columnsOf(entity, field));
}

interface Group {
  areaId: Id<"a"> | null;
  projectId: Id<"p"> | null;
}

/** A project's tasks are one group, as their positions are, whatever area an older one holds. */
const sameGroup = (a: Group, b: Group): boolean =>
  a.projectId === b.projectId && (a.projectId !== null || a.areaId === b.areaId);

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
  /** `source.add`: the active task that holds the source's key, so it was linked without it. */
  heldBy?: Id<"t">;
  /**
   * `task.restore` of an active task: its live links whose key another active task holds by
   * then, with that task. The restore leaves them removed, so one item never has two holders.
   */
  held?: { source: Id<"s">; by: Id<"t"> }[];
  /** `task.wrap_up`: the IDs of the learnings it adds, one per text of `learnings.add`. */
  learnings?: Id<"lr">[];
  /**
   * No write: `task.wrap_up` with `once` on a task wrapped already that it would not change, a
   * matched draft's `log.add` whose entry the task has already, or a `task.delete` or
   * `task.restore` that finds the task as it asks.
   */
  skip?: true;
  /** A skipped `task.restore` of a change: the task is in the Trash from a later change. */
  later?: true;
  /** A folder operation: the request's machine and its OS, whose case rule compares paths. */
  folder?: { machine: Id<"m">; os: FolderOs };
  /** `area.create` and `project.create`: the slug the new group takes. */
  slug?: string;
  /** `project.move`: the project's new area. */
  area?: Id<"a"> | null;
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
   * it enters (A4 3.16): commit instants stand still while the clock is behind the newest commit
   * (A1 3.9), so they cannot tell how long ago a click was.
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
  /**
   * What an applied request left as it found it, and why: a folder a project's restore did not
   * bring back because another live project holds that folder now.
   */
  conflicts: FieldConflict[];
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
    "NULL, $created_at, $created_by, $session, NULL, NULL, $seq, $seq, $seq, '{}', '{}', '{}')",
  taskVersions:
    "UPDATE tasks SET version = $seq, touched = $seq, fv = $fv, fp = $fp WHERE id = $id",
  touched: "UPDATE tasks SET touched = $seq WHERE id = $id",
  outbox:
    "INSERT INTO outbox (topic, key, first_seq, seq) VALUES ('projection', $key, $seq, $seq) " +
    "ON CONFLICT (topic, key) DO UPDATE SET seq = excluded.seq",
  /** The live tasks of the project a folder belongs to: none for a task's folder. */
  folderTasks:
    "SELECT t.id FROM folders f JOIN tasks t ON t.project_id = f.owner_id " +
    "WHERE f.id = $id AND f.owner_kind = 'project' AND t.deleted_at IS NULL",
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
  noteOf: "SELECT * FROM notes WHERE task_id = $task AND ordinal = $ordinal",
  removeNote: "UPDATE notes SET deleted_at = $at WHERE id = $id",
  reviveNote: "UPDATE notes SET deleted_at = NULL WHERE id = $id",
  noteVersions: "UPDATE notes SET version = $seq, fv = $fv, fp = $fp WHERE id = $id",
  insertNote:
    "INSERT INTO notes (id, task_id, ordinal, author_id, addressee, audience, body, created_at, " +
    "edited_at, deleted_at, created_seq, version, fv, fp) VALUES ($id, $task, $ordinal, $author, " +
    "$addressee, 'all', $body, $at, NULL, NULL, $seq, $seq, '{}', '{}')",
  log: "SELECT * FROM log_entries WHERE id = $id",
  sameLog:
    "SELECT id FROM log_entries WHERE task_id = $task AND body = $body AND deleted_at IS NULL " +
    "ORDER BY ordinal LIMIT 1",
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
  removeLink:
    "UPDATE task_sources SET removed_at = $at WHERE task_id = $task AND source_id = $source",
  undoOf: "SELECT undo_of FROM commits WHERE seq = $seq",
  commitSeq: "SELECT seq FROM commits WHERE id = $id",
  inTrash: `SELECT ${inTrashSql("t")} AS yes FROM tasks t WHERE t.id = $id`,
  /** A task's links to live keyed sources, removed ones too, with each source's key. */
  keyedLinks:
    "SELECT ts.*, s.source_key AS k FROM task_sources ts JOIN sources s ON s.id = ts.source_id " +
    "WHERE ts.task_id = $task AND s.source_key IS NOT NULL AND s.deleted_at IS NULL " +
    "ORDER BY ts.position, ts.source_id",
  projectGroup: "SELECT area_id, deleted_at FROM projects WHERE id = $id",
  /** Where a restored task is back: its list and the names of its area and project. */
  backIn:
    "SELECT t.status, t.inbox, a.title AS area, p.title AS project FROM tasks t " +
    "LEFT JOIN areas a ON a.id = t.area_id LEFT JOIN projects p ON p.id = t.project_id " +
    "WHERE t.id = $id",
  areaGone: "SELECT 1 AS found FROM areas WHERE id = $id AND deleted_at IS NOT NULL",
  sharedWith:
    "SELECT t.ref FROM task_sources ts JOIN tasks t ON t.id = ts.task_id " +
    "JOIN sources s ON s.id = ts.source_id WHERE ts.source_id = $source AND ts.task_id <> $task " +
    "AND ts.removed_at IS NULL AND s.source_key IS NOT NULL AND t.deleted_at IS NULL " +
    "AND t.lifecycle = 'active' ORDER BY t.ref",
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
  // An active task that holds one of the keys, by scale: a change that drops it is refused.
  statusInUse:
    "SELECT 1 FROM tasks WHERE lifecycle = 'active' AND deleted_at IS NULL " +
    "AND status IN (SELECT value FROM json_each($keys)) LIMIT 1",
  effortInUse:
    "SELECT 1 FROM tasks WHERE lifecycle = 'active' AND deleted_at IS NULL " +
    "AND effort IN (SELECT value FROM json_each($keys)) LIMIT 1",
  areaRow: "SELECT * FROM areas WHERE id = $id",
  projectRow: "SELECT * FROM projects WHERE id = $id",
  lastArea: "SELECT max(position) AS p FROM areas",
  lastProject: "SELECT max(position) AS p FROM projects WHERE area_id IS $area",

  // Areas and projects (A1 3.6): their fields, by the column names of fields.ts.
  areaBySlugAny: "SELECT id FROM areas WHERE slug = $slug AND deleted_at IS NULL",
  projectSlugTaken: "SELECT id FROM projects WHERE slug = $slug AND deleted_at IS NULL",
  deletedProjectsBySlug: "SELECT id FROM projects WHERE slug = $slug AND deleted_at IS NOT NULL",
  insertAreaWith:
    "INSERT INTO areas (id, slug, title, position, color, brief, lifecycle, created_at, " +
    "created_by, deleted_at, created_seq, version, fv, fp, ext) VALUES ($id, $slug, $title, " +
    "$position, $color, $brief, 'active', $at, $author, NULL, $seq, $seq, '{}', '{}', '{}')",
  insertProjectWith:
    "INSERT INTO projects (id, area_id, slug, title, position, color, brief, defaults, lifecycle, " +
    "created_at, created_by, deleted_at, created_seq, version, fv, fp, ext) VALUES ($id, $area, " +
    "$slug, $title, $position, $color, $brief, '{}', 'active', $at, $author, NULL, $seq, $seq, " +
    "'{}', '{}', '{}')",
  areaVersions: "UPDATE areas SET version = $seq, fv = $fv, fp = $fp WHERE id = $id",
  projectVersions: "UPDATE projects SET version = $seq, fv = $fv, fp = $fp WHERE id = $id",
  tasksOfProject: "SELECT id FROM tasks WHERE project_id = $id ORDER BY id",
  liveTaskIn: "SELECT 1 AS found FROM tasks WHERE project_id = $id AND deleted_at IS NULL LIMIT 1",
  taskArea: "UPDATE tasks SET area_id = $area WHERE id = $id",
  // Folders (schema 0.5): one live folder per owner and machine.
  insertFolder:
    "INSERT INTO folders (id, owner_kind, owner_id, machine_id, path, created_at, deleted_at, " +
    "created_seq, version, fv, fp) VALUES ($id, $kind, $owner, $machine, $path, $at, NULL, $seq, " +
    "$seq, '{}', '{}')",
  folderPath: "UPDATE folders SET path = $path WHERE id = $id",
  folderDeleted: "UPDATE folders SET deleted_at = $at WHERE id = $id",
  folderVersions: "UPDATE folders SET version = $seq, fv = $fv, fp = $fp WHERE id = $id",
} as const;

/** `UPDATE <areas|projects> SET <columns> WHERE id = $id`, for the columns of their fields only. */
function updateGroupSql(entity: "areas" | "projects", columns: readonly string[]): string {
  const known = new Set<string>(Object.values(CHILD_FIELDS[entity]).flat());
  if (columns.length === 0 || columns.some((c) => !known.has(c))) {
    throw misuse("A group update names only the columns of its fields");
  }
  return `UPDATE ${entity} SET ${columns.map((c) => `${c} = $${c}`).join(", ")} WHERE id = $id`;
}

/** A new commit's instant: `now`, or the newest commit's when the clock stepped back (A1 3.9). */
function commitInstant(conn: Connection, now: number): number {
  if (!inRange(now, "instant")) throw misuse("The clock gave an instant outside its range");
  const row = conn.prepare(SQL.lastAt).get();
  const previous = row === undefined ? 0 : row["at"];
  if (!inRange(previous, "instant")) throw invalidValue("commits", "at");
  return Math.max(now, previous);
}

/**
 * A commit TTasks makes on its own, as the space's system actor in the system scope: an operation
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
      areas: SQL.areaRow,
      projects: SQL.projectRow,
      folders: FOLDER_SQL.folder,
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
  } else if (row.entity === "notes") {
    conn.prepare(SQL.noteVersions).run({ ...maps, id: row.id });
  } else if (row.entity === "preferences") {
    conn.prepare(SQL.preferenceVersions).run({ ...maps, id: row.id });
  } else if (row.entity === "task_sources") {
    const [task, source] = row.id.split("|");
    conn.prepare(SQL.linkVersions).run({ ...maps, task: task ?? "", source: source ?? "" });
  } else if (row.entity === "areas") {
    conn.prepare(SQL.areaVersions).run({ ...maps, id: row.id });
  } else if (row.entity === "projects") {
    conn.prepare(SQL.projectVersions).run({ ...maps, id: row.id });
  } else if (row.entity === "folders") {
    conn.prepare(SQL.folderVersions).run({ ...maps, id: row.id });
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

/** The keys of `tasks.statuses` or `tasks.effort_scale` as the registry reads them (A1 3.16). */
function listPreference(conn: Connection, key: ScaleKey): string[] {
  return scaleKeys(readSpacePreference(conn, key).value);
}

type ScaleKey = "tasks.statuses" | "tasks.effort_scale";

const isScaleKey = (key: string): key is ScaleKey =>
  key === "tasks.statuses" || key === "tasks.effort_scale";

/** A scale's keys from its value: a list of keys, or of `{key}` objects. */
function scaleKeys(value: unknown): string[] {
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
   * Whether the space holds the search tables, which schema 0.4 adds: each commit then writes the
   * documents it changed. A space of an older build's chain (tests write those) keeps no index.
   */
  readonly #search: boolean;
  readonly spaceId: Id<"sp">;
  /** The space's folder. */
  readonly folder: string;
  #registered = false;
  #closed = false;

  private constructor(opened: OpenedSpace, options: WriterOptions, seams: WriteSeams) {
    this.#conn = opened.conn;
    this.folder = opened.folder;
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
   * clock steps back, so the instant may be the newest commit's.
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
   * A request's receipt in a writer scope: what `receipt.get` returns (A3 3.2.3). Undefined when
   * the scope holds none: another scope's receipts are never found.
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
   * The projection rendered `keys` at the snapshot `seq` (A1 3.13 step 5): their outbox rows are
   * done, or wait for the commits after `seq`. Returns the watermark (step 6). A bookkeeping write
   * (A1 3.7): no commit, no history (outbox.ts).
   */
  projected(batch: ProjectedBatch): number {
    const conn = this.#usable();
    return conn.transaction("immediate", () => markProjected(conn, batch));
  }

  /**
   * Queues tasks for the projection (outbox.ts): every task, a full rebuild, or only `keys`, the
   * tasks a reconciliation found missing or different. Returns the tasks queued.
   */
  queueProjection(keys?: readonly string[]): number {
    const conn = this.#usable();
    return conn.transaction("immediate", () => queueProjection(conn, keys));
  }

  /**
   * Checks the search index and makes it again when it is damaged (search/remake.ts). The index is
   * derived from the tasks, so this changes no task and writes no commit.
   */
  repairSearchIndex(
    checked: CheckedDriver,
    steps: readonly SchemaStep[],
  ): "sound" | "remade" | "damaged" {
    return repairSearchIndex(checked, this.#usable(), steps);
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
    // The receipt, before staging and expansion (A1 3.7, 3.8).
    const prior = readReceipt(conn, {
      scope_id: request.actor.scope_id,
      request_id: request.request_id,
    });
    if (prior?.fingerprint === fingerprint) return prior.result;
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
    const dedupe = new Dedupe(conn, request.ops, at, restoredKeys(conn, space, request.ops));
    const matched = new Map<string, Match>();
    /**
     * The keys of a created draft that another active task holds, by `<draft>|<key>`, with that
     * task: the draft's source of that key is linked without the key (Dedupe.decide).
     */
    const heldKeys = new Map<string, Id<"t">>();
    /** Links earlier operations removed (`false`) or brought back (`true`), by `task|source`. */
    const links = new Map<string, boolean>();
    /** Notes earlier operations retracted (`false`) or put back (`true`), by note ID. */
    const notes = new Map<string, boolean>();
    /** The log entries earlier operations add, by task and text: a matched draft's same one. */
    const stagedLogs = new Map<string, string>();
    /**
     * The tombstones earlier operations set (`true`) or clear (`false`): a later operation sees
     * the task as they leave it, so a restored task takes changes and a deleted one refuses them.
     */
    const tombstones = new Map<Id<"t">, boolean>();
    /** The lifecycle earlier operations leave each task in, as execution will find it. */
    const lifecycles = new Map<Id<"t">, TaskLifecycle>();
    /**
     * Areas and projects that earlier operations create, by slug and by ID, so a later operation
     * of the request names them before their rows exist.
     */
    const draftAreas = new Map<string, Id<"a">>();
    const draftProjects = new Map<string, { id: Id<"p">; areaId: Id<"a"> | null }>();
    /** Areas and projects earlier operations create: they have no row before the request. */
    const createdGroups = new Set<string>();
    /** Slugs earlier operations give new areas and projects. */
    const draftSlugs = { areas: new Set<string>(), projects: new Set<string>() };
    /** Projects earlier operations move, with their new area: tasks filed into them follow it. */
    const movedProjects = new Map<string, Id<"a"> | null>();
    /**
     * The owners whose folder an earlier operation sets or clears, by `kind|id`: once a request,
     * so each operation is staged against the folders it changes.
     */
    const changedFolders = new Set<string>();

    const ops = request.ops.map((op, i): StagedOp => {
      /** An area or project by ID or slug: first those the request creates, then the space's. */
      const areaOf = (ref: string): Id<"a"> => draftAreas.get(ref) ?? resolveArea(conn, ref, i);
      const projectOf = (ref: string): { id: Id<"p">; areaId: Id<"a"> | null } => {
        const found = draftProjects.get(ref) ?? resolveProject(conn, ref, i);
        const moved = movedProjects.get(found.id);
        return moved === undefined ? found : { id: found.id, areaId: moved };
      };
      /**
       * The touches of `fields` of an existing area or project, whose start state the base covers.
       * One the request creates has no start: an earlier operation of the request wrote it whole.
       */
      const groupTouches = (entity: "areas" | "projects", id: string, fields: string[]) => {
        if (createdGroups.has(id)) return [];
        const key = rowKey(entity, id);
        if (!starts.has(key)) {
          const row = conn.prepare(entity === "areas" ? SQL.areaRow : SQL.projectRow).get({ id });
          if (row === undefined) throw misuse("A group staging resolved has gone");
          starts.set(key, rowState(entity, row, CHILD_FIELDS[entity]));
        }
        return fields.map((field): Touch => ({ entity, id, field, task: null }));
      };
      /** An existing folder row the operation writes, whose start state the base covers. */
      const folderTouches = (row: Row, fields: string[], task: Id<"t"> | null): Touch[] => {
        const id = new RowReader("folders", row).id("id", "fo");
        const key = rowKey("folders", id);
        if (!starts.has(key)) starts.set(key, rowState("folders", row, CHILD_FIELDS.folders));
        return fields.map((field) => ({ entity: "folders", id, field, task }));
      };
      /** A folder operation's machine, which must have its record, and the path's form there. */
      const folderMachine = (path?: string): { machine: Id<"m">; os: FolderOs } => {
        const machine = request.actor.machine_id;
        const os = machineOs(conn, machine);
        if (os === undefined) {
          return problem(
            "VALIDATION_FAILED",
            "The request's machine has no record in this space",
            i,
            "actor.machine_id",
          );
        }
        if (path !== undefined) {
          const wrong = folderProblem(path, os);
          if (wrong !== undefined) problem("VALIDATION_FAILED", wrong, i, "path");
        }
        return { machine, os };
      };
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
          area = placement.area === null ? null : areaOf(placement.area);
          record["area"] = area;
        }
        if (placement.project !== undefined && placement.project !== null) {
          // The task's area follows its project's (A1 3.6), whatever area the input named.
          const project = projectOf(placement.project);
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
      const taskTouches = (target: Id<"t">, fields: string[]): Touch[] =>
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
              ? { kind: "project" as const, id: projectOf(op.project).id as string }
              : { kind: "area" as const, id: areaOf(op.area ?? "") as string };
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
        if (op.kind === "task.folder_set") folderMachine(op.path);
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
          let held: ReadonlyMap<string, Id<"t">> = new Map();
          if (mode === "new" && keys.length > 0) {
            held = dedupe.held(keys);
          } else if (mode === "source_key" && keys.length > 0) {
            const found = dedupe.decide(keys, op.link_sources === true);
            const hit = found.match;
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
            held = found.held;
          }
          drafts.add(id);
          for (const [key, holder] of held) heldKeys.set(`${id}|${key}`, holder);
          dedupe.created(
            id,
            keys.filter((key) => !held.has(key)),
          );
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
            record: {
              ...valuesRecord(op),
              ...record,
              ...(op.created_at === undefined ? {} : { created_at: op.created_at }),
            },
            ...placed,
          };
        }
        case "task.patch": {
          const target = task(op.task, "task");
          const fields = [...Object.keys(op.set ?? {}), ...(op.unset ?? [])];
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
          const target = task(op.task, "task", true);
          const start = tasks.get(target);
          const change = op.kind === "task.restore" ? op.change : undefined;
          const record = { task: target, ...(change === undefined ? {} : { change }) };
          const skip: StagedOp = { i, op, target, task: target, touches: [], record, skip: true };
          let from: number | undefined;
          if (change !== undefined) {
            const commit = conn.prepare(SQL.commitSeq).get({ id: change });
            if (commit === undefined) {
              return problem("NOT_FOUND", "The space has no change with this ID", i, "change");
            }
            from = new RowReader("commits", commit).int("seq", "seq");
          }
          const deleted = tombstones.get(target) ?? start?.deleted ?? false;
          // Only a task removed on purpose is in the Trash (trash.ts): an undone creation is Redo's,
          // which brings its notes and links with it. Neither a restore nor a removal takes it, and
          // neither calls it there already: the whole request is refused, naming it.
          if (deleted && !tombstones.has(target)) {
            const found = conn.prepare(SQL.inTrash).get({ id: target });
            if (found?.["yes"] !== 1) {
              throw new RequestProblem({
                code: "NOT_FOUND",
                message: "The task's creation was undone: Redo brings it back",
                op: i,
                field: "task",
                reason: "creation_undone",
              });
            }
          }
          // A task already as asked is no change: two tabs that both asked get the same answer.
          if (deleted === deleting) return skip;
          // Restoring a change: only a tombstone that change set and nothing since. Provenance, not
          // a base, says so, so a task restored and removed again since stays with the later change.
          if (from !== undefined) {
            if (tombstones.has(target) || start === undefined) return skip;
            // In the Trash from a later change: it stays there, with that change.
            if (provenanceOf(start, "deleted") !== from) return { ...skip, later: true };
          }
          if (deleting) affected.add(target);
          tombstones.set(target, deleting);
          // A deleted task holds no key, and a restored one holds its keys again (A1 3.6), except
          // a key another active task took meanwhile: that link stays removed, and captures of the
          // item go on to that task. Two restores of one key in one request: the first holds it.
          dedupe.deleted(target, deleting);
          const held: { source: Id<"s">; by: Id<"t"> }[] = [];
          const active = (lifecycles.get(target) ?? start?.lifecycle) === "active";
          if (!deleting && active) {
            for (const row of conn.prepare(SQL.keyedLinks).all({ task: target })) {
              const r = new RowReader("task_sources", row);
              const source = r.id("source_id", "s");
              const id = `${target}|${source}`;
              if (!(links.get(id) ?? row["removed_at"] === null)) continue;
              const key = r.text("k");
              const [by] = dedupe.match([key], false).active.filter((other) => other !== target);
              if (by === undefined) continue;
              links.set(id, false);
              dedupe.unlinked(key, target);
              const startKey = rowKey("task_sources", id);
              if (!starts.has(startKey)) starts.set(startKey, linkState(row));
              held.push({ source, by });
            }
          }
          // A removal is based on the task as the person saw it: any field changed since makes the
          // request a conflict, so a task someone repurposed meanwhile never leaves unseen. A
          // restore is based on its tombstone; one of a change, on the change's provenance.
          const guarded = deleting ? (Object.keys(TASK_FIELDS) as TaskField[]) : ["deleted"];
          return {
            i,
            op,
            target,
            task: target,
            touches: change === undefined ? taskTouches(target, guarded) : [],
            record,
            ...(held.length === 0 ? {} : { held }),
          };
        }
        case "note.add":
        case "log.add": {
          // Base-free inserts: they fail only when the task is deleted (A1 3.5).
          const parent = task(op.task, "task");
          // A matched draft's entry that the task has already, before the request or from an
          // earlier operation of it: the same work sent again adds it once, so a second pass of
          // an agent recreating its tasks adds nothing.
          const entryKey = `${parent}\n${op.kind === "log.add" ? op.body : ""}`;
          if (op.kind === "log.add" && matched.has(op.task)) {
            const row = conn.prepare(SQL.sameLog).get({ task: parent, body: op.body });
            const same =
              row === undefined
                ? stagedLogs.get(entryKey)
                : new RowReader("log_entries", row).id("id", "l");
            if (same !== undefined) {
              return {
                i,
                op,
                target: same,
                task: parent,
                touches: [],
                record: { task: parent, ...inputOf(op, "task") },
                skip: true,
              };
            }
          }
          const id = op.kind === "note.add" ? newId("n", random) : newId("l", random);
          if (op.kind === "log.add" && !stagedLogs.has(entryKey)) stagedLogs.set(entryKey, id);
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
          const heldBy =
            op.source.key === undefined ? undefined : heldKeys.get(`${parent}|${op.source.key}`);
          if (heldBy !== undefined && op.source.key !== undefined) {
            // The key stays as the source's plain reference: the person sees which ticket it is,
            // and a draft sent again finds this task by it (Dedupe.decide).
            const { key: held, ...rest } = op.source;
            const unkeyed = rest.ref === undefined ? { ...rest, ref: held } : rest;
            dedupe.plain(held, parent);
            const plain: Operation = { ...op, source: unkeyed };
            return {
              i,
              op: plain,
              target: newId("s", random),
              task: parent,
              touches: [],
              record: { task: parent, ...inputOf(plain, "task") },
              heldBy,
            };
          }
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
              // A link that exists at the start and is removed, as the request's earlier
              // operations leave it: reviving it changes its one field, which needs its link
              // version or a base (A1 3.5).
              const link = drafts.has(parent)
                ? undefined
                : conn.prepare(SQL.link).get({ task: parent, source });
              const id = `${parent}|${source}`;
              if (link !== undefined && !(links.get(id) ?? link["removed_at"] === null)) {
                links.set(id, true);
                const startKey = rowKey("task_sources", id);
                if (!starts.has(startKey)) starts.set(startKey, linkState(link));
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
        case "note.delete":
        case "note.restore": {
          const parent = task(op.task, "task");
          const row = drafts.has(parent)
            ? undefined
            : conn.prepare(SQL.noteOf).get({ task: parent, ordinal: op.ordinal });
          if (row === undefined) {
            return problem("NOT_FOUND", "The task has no note with this number", i, "ordinal");
          }
          const id = new RowReader("notes", row).id("id", "n");
          const record = { task: parent, ordinal: op.ordinal };
          const live = notes.get(id) ?? row["deleted_at"] === null;
          if (op.kind === "note.delete" ? !live : live) {
            return { i, op, target: id, task: parent, touches: [], record, skip: true };
          }
          const start = rowState("notes", row, CHILD_FIELDS.notes);
          if (op.kind === "note.restore" && !notes.has(id)) {
            // An undo that took back the note's writing removed it: Redo brings it back with the
            // rest of that change, which putting it back here would take away from Redo.
            const removal = conn.prepare(SQL.undoOf).get({ seq: provenanceOf(start, "deleted") });
            if (removal === undefined || removal["undo_of"] !== null) {
              return problem(
                "INVALID_TRANSITION",
                "The note was removed by undoing its writing: Redo brings it back",
                i,
                "ordinal",
              );
            }
          }
          notes.set(id, op.kind === "note.restore");
          const startKey = rowKey("notes", id);
          if (!starts.has(startKey)) starts.set(startKey, start);
          const touch: Touch = { entity: "notes", id, field: "deleted", task: parent };
          return { i, op, target: id, task: parent, touches: [touch], record };
        }
        case "source.unlink":
        case "source.relink": {
          const parent = task(op.task, "task");
          const id = `${parent}|${op.source}`;
          const link = drafts.has(parent)
            ? undefined
            : conn.prepare(SQL.link).get({ task: parent, source: op.source });
          const source = conn.prepare(SQL.source).get({ id: op.source });
          if (link === undefined || source === undefined || source["deleted_at"] !== null) {
            return problem("NOT_FOUND", "The task has no link to this source", i, "source");
          }
          const record = { task: parent, source: op.source };
          const live = links.get(id) ?? link["removed_at"] === null;
          if (op.kind === "source.unlink" ? !live : live) {
            return { i, op, target: op.source, task: parent, touches: [], record, skip: true };
          }
          const start = linkState(link);
          const r = new RowReader("sources", source);
          const key = r.optText("source_key");
          if (op.kind === "source.relink" && !links.has(id)) {
            // An undo that took back the link's creation removed it: Redo brings it back with the
            // rest of that change, which a revival here would take away from Redo.
            const removal = conn.prepare(SQL.undoOf).get({ seq: provenanceOf(start, "removed") });
            if (removal === undefined || removal["undo_of"] !== null) {
              return problem(
                "INVALID_TRANSITION",
                "The link was removed by undoing its creation: Redo brings it back",
                i,
                "source",
              );
            }
          }
          const active =
            (lifecycles.get(parent) ?? tasks.get(parent)?.lifecycle ?? "active") === "active";
          if (op.kind === "source.relink" && key !== null && active) {
            // A link has one identity: while another active task holds its key, captures of the
            // item go there, and putting this link back on an active task would make a second
            // active holder. Refused, naming each holder's link; one the request itself made has
            // no row to name. A finished task takes its link back as undo does: an active holder
            // comes first for captures.
            const holders = dedupe.match([key], false).active.filter((other) => other !== parent);
            const touches: Touch[] = [];
            for (const holder of holders) {
              const held = drafts.has(holder)
                ? undefined
                : conn.prepare(SQL.link).get({ task: holder, source: op.source });
              if (held === undefined || held["removed_at"] !== null) {
                return problem(
                  "INVALID_TRANSITION",
                  "Another task of the request holds the source's key",
                  i,
                  "source",
                );
              }
              task(holder, "source");
              const heldId = `${holder}|${op.source}`;
              starts.set(rowKey("task_sources", heldId), linkState(held));
              touches.push({
                entity: "task_sources",
                id: heldId,
                field: "removed",
                task: holder,
                held: true,
              });
            }
            if (touches.length > 0) {
              return { i, op, target: op.source, task: parent, touches, record };
            }
          }
          links.set(id, op.kind === "source.relink");
          if (key !== null) {
            if (op.kind === "source.relink") dedupe.link(key, parent);
            else dedupe.unlinked(key, parent);
          }
          const startKey = rowKey("task_sources", id);
          if (!starts.has(startKey)) starts.set(startKey, start);
          const touch: Touch = { entity: "task_sources", id, field: "removed", task: parent };
          if (op.link_version !== undefined) touch.linkVersion = op.link_version;
          return { i, op, target: op.source, task: parent, touches: [touch], record };
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
          const asked = op.evidence?.["request"];
          if (asked !== undefined) {
            const ordinal = /^n([1-9][0-9]{0,5})$/u.exec(String(asked))?.[1];
            const found =
              ordinal === undefined
                ? undefined
                : conn.prepare(LAUNCH_SQL.request).get({ task: parent, ordinal: Number(ordinal) });
            if (found === undefined) {
              problem(
                "NOT_FOUND",
                "The task has no note with this reference",
                i,
                "evidence.request",
              );
            }
          }
          const record = { task: parent, ...inputOf(op, "task") };
          // A second click on the same task and instance while an intent of it is still opening
          // gets that intent, in this request or before it.
          const key = `${parent}|${op.instance}`;
          const found = drafts.has(parent)
            ? undefined
            : conn.prepare(LAUNCH_SQL.focus).get({ task: parent, instance: op.instance, machine });
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
          const reference = newLaunchRef(conn, draftRefs, random);
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
            // As a run's: a launch a claim or a restore in place brought back from a backup is
            // ended as restored by the machine that holds the space, whichever machine made it.
            const restored =
              Number(row["created_seq"]) <
              Number(conn.prepare(SQL.space).get()?.["authority_since"]);
            const ends =
              (op.next === "failed" && op.reason === "restored") ||
              (op.expect === "confirmed" &&
                op.next === "confirmed" &&
                Object.keys(op.evidence ?? {}).join() === "restored_at");
            if (row["machine_id"] !== request.actor.machine_id && !(restored && ends)) {
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
            // A run a claim or a restore in place brought back from a backup runs nowhere now: the
            // machine that holds the space settles it, whichever machine made it.
            const restored =
              Number(row["created_seq"]) <
              Number(conn.prepare(SQL.space).get()?.["authority_since"]);
            const settles =
              op.next === "reconciling" ||
              (FINAL_RUN_STATES as readonly RunState[]).includes(op.next);
            if (row["machine_id"] !== request.actor.machine_id && !(restored && settles)) {
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
          const row = conn.prepare(SQL.preferenceRow).get({ id: op.key });
          // A newer build's value is kept unchanged: read-only here (A1 3.16). Said before any
          // other reason, so nobody changes tasks for a change this build cannot make.
          if (
            row !== undefined &&
            new RowReader("preferences", row).int("schema_ver", "count") > spec.schemaVer
          ) {
            problem(
              "VALIDATION_FAILED",
              "A newer build wrote this preference: it is read-only here",
              i,
              "key",
            );
          }
          // A task keeps its status and effort whatever the scale says, so a scale never drops a
          // key an active task holds: the person moves those tasks first and loses nothing.
          if (isScaleKey(op.key)) {
            const kept = new Set(scaleKeys(op.value ?? spec.default));
            const removed = listPreference(conn, op.key).filter((key) => !kept.has(key));
            const inUse = op.key === "tasks.statuses" ? SQL.statusInUse : SQL.effortInUse;
            if (
              removed.length > 0 &&
              conn.prepare(inUse).get({ keys: JSON.stringify(removed) }) !== undefined
            ) {
              problem(
                "VALIDATION_FAILED",
                "Active tasks hold a key this change removes: give them another first",
                i,
                "value",
              );
            }
          }
          const touches: Touch[] = [];
          if (row !== undefined) {
            // Changing a stored value, or resetting it, needs a base (A1 3.5).
            const key = rowKey("preferences", op.key);
            if (!starts.has(key)) {
              starts.set(key, rowState("preferences", row, CHILD_FIELDS.preferences));
              touches.push({ entity: "preferences", id: op.key, field: "value", task: null });
            }
          }
          return { i, op, target: op.key, task: null, touches, record: inputOf(op) };
        }
        case "area.create":
        case "project.create": {
          const entity = op.kind === "area.create" ? "areas" : "projects";
          const prefix = op.kind === "area.create" ? "a" : "p";
          const id = op.id ?? newId(prefix, random);
          const taken =
            createdGroups.has(id) ||
            conn.prepare(entity === "areas" ? SQL.areaById : SQL.projectById).get({ id }) !==
              undefined;
          if (taken) problem("VALIDATION_FAILED", "A group with this ID exists", i, "id");
          const drafted = draftSlugs[entity];
          const held = (slug: string): boolean =>
            drafted.has(slug) ||
            conn
              .prepare(entity === "areas" ? SQL.areaBySlugAny : SQL.projectSlugTaken)
              .get({ slug }) !== undefined;
          let slug = op.slug;
          if (slug !== undefined && held(slug)) {
            problem("VALIDATION_FAILED", "A live group of this kind holds this slug", i, "slug");
          }
          slug ??= freeSlug(op.title, op.kind === "area.create" ? "area" : "project", held);
          drafted.add(slug);
          createdGroups.add(id);
          const record: Record<string, unknown> = { ...inputOf(op, "area"), id, slug };
          if (op.kind === "area.create") {
            draftAreas.set(slug, id as Id<"a">);
            draftAreas.set(id, id as Id<"a">);
            return { i, op, target: id, task: null, touches: [], record, slug };
          }
          const areaId = op.area === undefined || op.area === null ? null : areaOf(op.area);
          if (op.area !== undefined) record["area"] = areaId;
          const project = { id: id as Id<"p">, areaId };
          draftProjects.set(slug, project);
          draftProjects.set(id, project);
          return { i, op, target: id, task: null, touches: [], record, slug, area: areaId };
        }
        case "area.patch": {
          const id = areaOf(op.area);
          return {
            i,
            op,
            target: id,
            task: null,
            touches: groupTouches("areas", id, Object.keys(op.set)),
            record: { area: id, set: op.set },
          };
        }
        case "project.patch": {
          const id = projectOf(op.project).id;
          return {
            i,
            op,
            target: id,
            task: null,
            touches: groupTouches("projects", id, Object.keys(op.set)),
            record: { project: id, set: op.set },
          };
        }
        case "project.move": {
          const id = projectOf(op.project).id;
          const area = op.area === null ? null : areaOf(op.area);
          movedProjects.set(id, area);
          // Its tasks are in its area, so they move with it: each one counts for the brake.
          for (const row of conn.prepare(SQL.tasksOfProject).all({ id })) {
            const task = new RowReader("tasks", row).id("id", "t");
            if (tombstones.get(task) !== true) affected.add(task);
          }
          return {
            i,
            op,
            target: id,
            task: null,
            touches: groupTouches("projects", id, ["grouping"]),
            record: { project: id, area },
            area,
          };
        }
        case "area.archive":
        case "area.unarchive": {
          const id = areaOf(op.area ?? "");
          return {
            i,
            op,
            target: id,
            task: null,
            touches: groupTouches("areas", id, ["lifecycle"]),
            record: { area: id },
          };
        }
        case "project.archive":
        case "project.unarchive": {
          const id = projectOf(op.project ?? "").id;
          return {
            i,
            op,
            target: id,
            task: null,
            touches: groupTouches("projects", id, ["lifecycle"]),
            record: { project: id },
          };
        }
        case "project.delete": {
          const id = projectOf(op.project).id;
          // The base covers the folders the caller saw, which the delete removes with it.
          const touches = groupTouches("projects", id, ["deleted"]);
          if (!createdGroups.has(id)) {
            for (const row of conn
              .prepare(FOLDER_SQL.liveOfOwner)
              .all({ kind: "project", owner: id })) {
              touches.push(...folderTouches(row, ["deleted"], null));
            }
          }
          return { i, op, target: id, task: null, touches, record: { project: id } };
        }
        case "project.restore": {
          const id = deletedProject(conn, op.project, i);
          const touches = groupTouches("projects", id, ["deleted"]);
          // The folders its delete removed: tombstoned by the commit that tombstoned the project.
          const start = must(starts.get(rowKey("projects", id)), "A staged group has a start");
          const gone = provenanceOf(start, "deleted");
          for (const row of conn
            .prepare(FOLDER_SQL.allOfOwner)
            .all({ kind: "project", owner: id })) {
            const state = rowState("folders", row, CHILD_FIELDS.folders);
            if (row["deleted_at"] !== null && provenanceOf(state, "deleted") === gone) {
              touches.push(...folderTouches(row, ["deleted"], null));
            }
          }
          return { i, op, target: id, task: null, touches, record: { project: id } };
        }
        case "project.folder_set":
        case "task.folder_set": {
          const owner =
            op.kind === "task.folder_set"
              ? { kind: "task" as const, id: task(op.task ?? "", "task") as string }
              : { kind: "project" as const, id: projectOf(op.project ?? "").id as string };
          const folder = folderMachine(op.path);
          const key = `${owner.kind}|${owner.id}`;
          if (changedFolders.has(key)) {
            problem("VALIDATION_FAILED", "A request changes an owner's folder once", i, "path");
          }
          changedFolders.add(key);
          const parent = owner.kind === "task" ? (owner.id as Id<"t">) : null;
          const fresh = drafts.has(owner.id as Id<"t">) || createdGroups.has(owner.id);
          const row = fresh
            ? undefined
            : conn
                .prepare(FOLDER_SQL.liveOf)
                .get({ kind: owner.kind, owner: owner.id, machine: folder.machine });
          let target: Id<"fo">;
          const touches: Touch[] = [];
          if (row !== undefined) {
            // Another folder for the one there: the base covers the folder the caller saw, and
            // every folder inside it that moves along, so one set since is not moved unseen. A
            // folder Undo brought back keeps its old path version: the version of its tombstone
            // says whether the caller saw it.
            const found = decodeFolder(row);
            target = found.id;
            touches.push(...folderTouches(row, ["path", "deleted"], parent));
            if (op.carry !== undefined && op.carry.length > 0) {
              const carried = new Set(op.carry);
              for (const inside of conn
                .prepare(FOLDER_SQL.liveOn)
                .all({ machine: folder.machine })) {
                const moved = decodeFolder(inside);
                if (moved.id === found.id || !carried.has(moved.ownerId)) continue;
                if (carriedTo(moved.path, found.path, op.path, folder.os) === undefined) continue;
                const owned = moved.ownerKind === "task" ? task(moved.ownerId, "task", true) : null;
                touches.push(...folderTouches(inside, ["path", "deleted"], owned));
              }
            }
          } else {
            target = newId("fo", random);
            // A folder cleared since the caller's base is a change it has not seen.
            const gone =
              fresh || request.base === undefined
                ? []
                : conn
                    .prepare(FOLDER_SQL.removedOn)
                    .all({ kind: owner.kind, owner: owner.id, machine: folder.machine });
            for (const removed of gone)
              touches.push(...folderTouches(removed, ["deleted"], parent));
          }
          return {
            i,
            op,
            target,
            task: parent,
            touches,
            record: { [owner.kind]: owner.id, path: op.path },
            owner,
            folder,
          };
        }
        case "project.folder_clear":
        case "task.folder_clear": {
          const owner =
            op.kind === "task.folder_clear"
              ? { kind: "task" as const, id: task(op.task ?? "", "task") as string }
              : { kind: "project" as const, id: projectOf(op.project ?? "").id as string };
          const folder = folderMachine();
          const key = `${owner.kind}|${owner.id}`;
          if (changedFolders.has(key)) {
            problem("VALIDATION_FAILED", "A request changes an owner's folder once", i, owner.kind);
          }
          changedFolders.add(key);
          const parent = owner.kind === "task" ? (owner.id as Id<"t">) : null;
          const fresh = drafts.has(owner.id as Id<"t">) || createdGroups.has(owner.id);
          const row = fresh
            ? undefined
            : conn
                .prepare(FOLDER_SQL.liveOf)
                .get({ kind: owner.kind, owner: owner.id, machine: folder.machine });
          const record = { [owner.kind]: owner.id };
          if (row === undefined) {
            // Nothing is there on this machine: the clear changes nothing.
            return { i, op, target: owner.id, task: parent, touches: [], record, owner, folder };
          }
          return {
            i,
            op,
            target: decodeFolder(row).id,
            task: parent,
            touches: folderTouches(row, ["path", "deleted"], parent),
            record,
            owner: { ...owner, bound: true },
            folder,
          };
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
      conflicts: [],
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
      groupsKept(conn, run);
      changes = coalesce(conn, run);
      if (changes.length > 0) {
        insertChanges(conn, seq, changes);
        // The search rows, in the same transaction as the state they index (A1 3.7, 3.12).
        if (this.#search) indexChanges(conn, seq, changes);
        for (const id of projectionTasks(conn, changes)) {
          conn.prepare(SQL.outbox).run({ key: id, seq });
        }
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
      conflicts: run.conflicts,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Undo and redo (A1 3.10.1, 3.10.4)

  /**
   * An undo or a redo. The principal's stack decides what it inverts: an undo the change rows of
   * the `done` commit applied last, a redo the rows of an `undone` commit's undo. History
   * (history.ts) plans the inversion under each field's provenance, applies it and checks the rules
   * across rows on what it made, and one commit of kind `undo` or `redo` records it and moves the
   * stack: the undone commit becomes `undone` with `undone_by`, a redone one `done` again. An undo
   * is all or nothing unless it is partial, and a partial undo leaves the stack even when it
   * inverts nothing, so the next undo reaches the commit below. A redo is all or nothing: it tries
   * the undone commits oldest first and redoes the first that the checks let through. Those before
   * it are passed over and stay undone, for the next redo to try again. The commit itself never
   * joins the stack.
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
    // A named change the space does not have (a typo, or one from before a backup was restored
    // over the space): it is said as such, never as a change that is no longer the newest.
    if (
      op.commit !== undefined &&
      conn.prepare(SQL.commitSeq).get({ id: op.commit }) === undefined
    ) {
      problem("NOT_FOUND", "The space has no change with this ID", 0, "commit");
    }
    const newest = undo ? undoTarget(conn, principal) : undefined;
    const stack = undo ? (newest === undefined ? [] : [newest]) : redoSteps(conn, principal);
    if (stack.length === 0) {
      return undo
        ? problem("NOTHING_TO_UNDO", "Nothing of yours is left to undo here", 0)
        : problem("NOTHING_TO_REDO", "Nothing of yours is left to redo here", 0);
    }
    // A caller that names the commit it means (a toast's own undo) never moves another.
    const steps = op.commit === undefined ? stack : stack.filter((s) => s.id === op.commit);
    if (steps.length === 0) {
      problem(
        "INVALID_TRANSITION",
        undo
          ? "That change is not your newest one: read again"
          : "That change is not one you undid: read again",
        0,
        "commit",
      );
    }
    const partial = op.kind === "undo" && op.partial === true;
    const seq = nextSeq(space);
    /** The steps a redo passed over, and why: each row and field once. */
    const passed: Id<"op">[] = [];
    const why = new Map<string, FieldConflict>();
    const held: Held[] = [];
    for (const target of steps) {
      // The rows an undo inverts are the commit's own; a redo inverts its undo's.
      const inverted = undo ? target.seq : must(target.undoneBy, "An undone commit names its undo");
      if (inverted < space.undoFloorSeq) {
        problem("UNDO_BEFORE_FLOOR", "The change is older than the space's last format change", 0);
      }
      const plan = planInversions(conn, readChanges(conn, inverted), {
        creating: new Set([target.seq]),
        refPrefix: space.refPrefix,
        partial,
        op: 0,
        principal,
        // A redo applies the step's undo again; an undo takes back the step as its last redo made it.
        applied: undo ? lastApplied(conn, target.seq) : inverted,
      });
      const pass = (): void => {
        passed.push(target.id);
        if (plan.conflicts.length > 0)
          held.push({ since: plan.applied, conflicts: plan.conflicts });
        for (const c of plan.conflicts) {
          const key = `${c.entity}|${c.id}|${c.field}`;
          if (!why.has(key)) why.set(key, c);
        }
      };
      if (plan.conflicts.length > 0 && !partial) {
        pass();
        continue;
      }
      const commitId = newId("op", this.#random);
      conn.exec("SAVEPOINT exec");
      try {
        // The inversions first: the rules across rows are decided on the state they make (A1 3.10).
        const applied = applyInversions(conn, plan, {
          seq,
          at,
          principal,
          op: 0,
          refPrefix: space.refPrefix,
          partial,
          owners: !undo,
        });
        if (applied === undefined) {
          rollBack(conn);
          pass();
          continue;
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
        const changes = applied.changes.map((c) => ({ ...c, action: "set" as const }));
        insertChanges(conn, seq, changes);
        // The search rows, as for any commit (A1 3.12): a tombstone drops a task's documents and
        // its children's, a restore brings them back, a field set back rewrites its document.
        if (this.#search) indexChanges(conn, seq, changes);
        for (const task of new Set([...applied.tasks, ...projectionTasks(conn, changes)])) {
          conn.prepare(SQL.outbox).run({ key: task, seq });
        }
        if (applied.changes.length > 0) conn.prepare(SQL.outbox).run({ key: "*", seq });
        if (undo) conn.prepare(SQL.markUndone).run({ target: target.seq, seq });
        else conn.prepare(SQL.markRedone).run({ target: target.seq });
        conn.prepare(SQL.lastSeq).run({ seq });
        conn.exec("RELEASE exec");
      } catch (error) {
        if (error instanceof RequestProblem) rollBack(conn);
        throw error;
      }
      const conflicts = undo ? plan.conflicts : [...why.values()];
      if (undo && conflicts.length > 0) held.push({ since: plan.applied, conflicts });
      return {
        ...accepted("applied", { ...asOf, seq }),
        commit: commitId,
        results: [{ i: 0, status: "updated", id: target.id, version: seq }],
        // What a partial undo left as others set it, or why a redo passed over the steps before
        // the one it redid (WriteResult.conflicts).
        conflicts,
        ...(passed.length === 0 ? {} : { passed }),
        ...(held.length === 0 ? {} : { newer: newerWorkOf(conn, held, principal) }),
      };
    }
    // Nothing could be applied. The refusal names the oldest step it tried, which a caller that
    // named none (Ctrl+Z) passes to Undo the rest.
    const first = must(steps[0], "An undo or redo tries a step");
    const conflicts = [...why.values()];
    return {
      ...refused(
        "conflict",
        asOf,
        {
          code: "UNDO_CONFLICT",
          message: undo
            ? "Someone changed it since: undo the rest, or keep theirs"
            : "Someone changed what it would change since: nothing was redone",
        },
        conflicts,
      ),
      target: first.id,
      ...(undo ? {} : { passed }),
      newer: newerWorkOf(conn, held, principal),
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
      case "note.delete":
      case "note.restore": {
        const r = new RowReader("notes", readRow(conn, "notes", staged.target));
        const task = r.id("task_id", "t");
        return {
          i,
          status,
          id: staged.target,
          task,
          ref: refOf(task),
          entry: formatEntryRef("note", r.int("ordinal", "ordinal")),
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
          ...(staged.heldBy === undefined ? {} : { held_by: refOf(staged.heldBy) }),
          ...sharedWith(conn, run, task, staged.target, link),
        };
      }
      case "source.unlink":
      case "source.relink": {
        const task = must(staged.task, "A source link has a task");
        const link = readRow(conn, "task_sources", `${task}|${staged.target}`);
        return {
          i,
          status,
          id: staged.target,
          task,
          ref: refOf(task),
          version: new RowReader("task_sources", link).int("version", "seq"),
        };
      }
      case "task.delete":
      case "task.restore": {
        const task = readTask(conn, staged.target as Id<"t">);
        const fields = new Set(
          writes.filter((w) => w.key === rowKey("tasks", task.id)).map((w) => w.field),
        );
        const regrouped = fields.has("inbox") ? "inbox" : fields.has("grouping") ? "area" : null;
        const held = staged.held ?? [];
        const back =
          op.kind === "task.restore" && staged.skip !== true
            ? conn.prepare(SQL.backIn).get({ id: task.id })
            : undefined;
        return {
          i,
          status,
          id: task.id,
          task: task.id,
          ref: formatTaskRef(run.plan.refPrefix, task.ref),
          version: task.version,
          ...(held.length === 0
            ? {}
            : { held_links: held.map(({ source, by }) => ({ source, by: refOf(by) })) }),
          ...(regrouped === null ? {} : { regrouped }),
          ...(staged.later === true ? { later: true } : {}),
          ...(back === undefined
            ? {}
            : {
                back: {
                  lifecycle: task.lifecycle,
                  status: String(back["status"]),
                  inbox: back["inbox"] === 1,
                  ...(typeof back["area"] === "string" ? { area: back["area"] } : {}),
                  ...(typeof back["project"] === "string" ? { project: back["project"] } : {}),
                },
              }),
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
      case "area.create":
      case "area.patch":
      case "area.archive":
      case "area.unarchive":
      case "project.create":
      case "project.patch":
      case "project.move":
      case "project.archive":
      case "project.unarchive":
      case "project.delete":
      case "project.restore": {
        const entity = op.kind.startsWith("area.") ? "areas" : "projects";
        const row = readRow(conn, entity, staged.target);
        return {
          i,
          status,
          id: staged.target,
          version: new RowReader(entity, row).int("version", "seq"),
        };
      }
      case "project.folder_set":
      case "task.folder_set":
      case "project.folder_clear":
      case "task.folder_clear": {
        const owner = must(staged.owner, "A folder has an owner");
        const task = staged.task;
        // The folder, or the owner when nothing was there on this machine to clear.
        const cleared = op.kind === "project.folder_clear" || op.kind === "task.folder_clear";
        const version =
          !cleared || owner.bound === true
            ? new RowReader("folders", readRow(conn, "folders", staged.target)).int(
                "version",
                "seq",
              )
            : owner.kind === "task"
              ? readTask(conn, staged.target as Id<"t">).version
              : new RowReader("projects", readRow(conn, "projects", staged.target)).int(
                  "version",
                  "seq",
                );
        return {
          i,
          status,
          id: staged.target,
          ...(task === null ? {} : { task, ref: refOf(task) }),
          version,
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
      "The base is from another copy of the space, or from before it was restored: read again",
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
      value: valueOf(touch.entity, start.raw, touch.field),
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
                ? "A change of a link needs its link version or a base"
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

/**
 * The deleted project a restore names: by ID, else by the slug it had when exactly one deleted
 * project had it. A project that is not deleted is INVALID_TRANSITION.
 */
function deletedProject(conn: Connection, ref: string, op: number): Id<"p"> {
  let row = isId(ref, "p") ? conn.prepare(SQL.projectById).get({ id: ref }) : undefined;
  if (row === undefined && !isId(ref, "p")) {
    const live = conn.prepare(SQL.projectBySlug).get({ slug: ref });
    const deleted = conn.prepare(SQL.deletedProjectsBySlug).all({ slug: ref });
    row = live ?? (deleted.length === 1 ? deleted[0] : undefined);
  }
  if (row === undefined)
    return problem("NOT_FOUND", "No project has this ID or slug", op, "project");
  if (row["deleted_at"] === null) {
    problem("INVALID_TRANSITION", "Only a deleted project can be restored", op, "project");
  }
  return new RowReader("projects", row).id("id", "p");
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
 * The keys of the links of the tasks `ops` restores, so dedupe reads who holds them. A reference
 * that names no task is staging's to refuse.
 */
function restoredKeys(conn: Connection, space: SpaceRow, ops: readonly Operation[]): string[] {
  const keys: string[] = [];
  for (const op of ops) {
    if (op.kind !== "task.restore") continue;
    let id: Id<"t">;
    try {
      id = resolveTask(conn, space, op.task, new Set(), 0, "task").id;
    } catch (error) {
      if (error instanceof RequestProblem) continue;
      throw error;
    }
    for (const row of conn.prepare(SQL.keyedLinks).all({ task: id })) {
      keys.push(new RowReader("sources", row).text("k"));
    }
  }
  return keys;
}

/**
 * `source.add`'s `shared_with`: the other active tasks a live link joins to the keyed `source`,
 * when `task`'s own `link` is live and the task active after the request.
 */
function sharedWith(
  conn: Connection,
  run: Execution,
  task: Id<"t">,
  source: string,
  link: Row,
): { shared_with?: string[] } {
  if (link["removed_at"] !== null || readTask(conn, task).lifecycle !== "active") return {};
  const refs = conn
    .prepare(SQL.sharedWith)
    .all({ task, source })
    .map((row) =>
      formatTaskRef(run.plan.refPrefix, new RowReader("tasks", row).int("ref", "taskRef")),
    );
  return refs.length === 0 ? {} : { shared_with: refs };
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
 * The group rules (history.ts groupBreaks) on the state the request's operations made together:
 * a deleted project holds no live task and no live folder, and a task is in its project's area.
 * One operation keeps them; a request that breaks one through several is refused at the operation
 * that wrote the row in question. A pair the space held broken before the request stays its own:
 * an earlier version let a person get there, and their ordinary work there goes on.
 */
function groupsKept(conn: Connection, run: Execution): void {
  const touch = { projects: [], tasks: [], folders: [], moved: [], regrouped: [] } as {
    [K in keyof GroupTouch]: string[];
  };
  for (const row of run.rows.values()) {
    const grouped = row.created !== undefined || row.fields.has("grouping");
    if (row.entity === "projects") {
      touch.projects.push(row.id);
      if (grouped) touch.moved.push(row.id);
    } else if (row.entity === "tasks") {
      touch.tasks.push(row.id);
      if (grouped) touch.regrouped.push(row.id);
    } else if (row.entity === "folders") touch.folders.push(row.id);
  }
  if (touch.projects.length + touch.tasks.length + touch.folders.length === 0) return;
  /** The write of the request that makes a row's side of a rule, if it made one. */
  const made = (key: string, field: string) => {
    const row = run.rows.get(key);
    if (row === undefined) return undefined;
    if (row.created !== undefined) return row.created;
    return field === "child"
      ? (row.fields.get("deleted") ?? row.fields.get("grouping"))
      : row.fields.get(field);
  };
  /** A row as the request found it: none for one it created. */
  const before = (entity: Entity, id: string): Row | undefined => {
    const row = run.rows.get(rowKey(entity, id));
    if (row === undefined) return readRow(conn, entity, id);
    return row.created === undefined ? must(row.start, "A written row has a start").raw : undefined;
  };
  for (const found of groupBreaks(conn, touch).breaks) {
    if (brokenIn(found, before)) continue;
    const { rule, project, child } = found;
    const op =
      made(rowKey(child.entity, child.id), "child") ??
      made(rowKey("projects", project), rule === "held" ? "deleted" : "grouping");
    if (op === undefined) throw misuse("A group rule broke with no write of the request");
    if (rule === "held") problem("DELETED", "The project is deleted", op, "project");
    problem("VALIDATION_FAILED", "A task in a project is in that project's area", op, "area");
  }
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

/**
 * A restored task whose project or area is gone goes to the project's area, or with no live area
 * left to the Inbox, in the restore's own change: a deleted project holds no live task, and a task
 * filed where no list shows it would be lost from view.
 */
function regroupRestored(conn: Connection, run: Execution, staged: StagedOp, target: Id<"t">) {
  const task = readTask(conn, target);
  let area = task.areaId;
  if (task.projectId !== null) {
    const project = conn.prepare(SQL.projectGroup).get({ id: task.projectId });
    if (project === undefined || project["deleted_at"] === null) return;
    area = new RowReader("projects", project).optText("area_id", (v) =>
      isId(v, "a"),
    ) as Id<"a"> | null;
  }
  if (area !== null && conn.prepare(SQL.areaGone).get({ id: area }) !== undefined) area = null;
  if (task.projectId === null && area === task.areaId) return;
  const group: GroupIntent = { area, project: null };
  const placed = place(conn, { ...staged, group, touches: [] }, target, task);
  const inbox = area === null;
  update(conn, target, {
    area_id: placed.areaId,
    project_id: placed.projectId,
    position: placed.position,
    ...(inbox ? { inbox: 1 } : {}),
  });
  wrote(run, staged.i, "tasks", target, target, inbox ? ["grouping", "inbox"] : ["grouping"]);
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
 * already stands where it is asked to keeps its position. One placed by a sibling in a project
 * takes the project's area, also when the sibling holds another from before the group rules.
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
      : sibling !== undefined
        ? {
            areaId:
              sibling.projectId === null
                ? sibling.areaId
                : (readRow(conn, "projects", sibling.projectId)["area_id"] as Id<"a"> | null),
            projectId: sibling.projectId,
          }
        : (current ?? { areaId: null, projectId: null });
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
        created_at: op.created_at ?? run.at,
        created_by: author,
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
      if (Object.keys(values).length > 0) update(conn, target, values);
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
      const doneAt = op.at ?? run.at;
      update(conn, target, {
        lifecycle: "completed",
        completed_at: doneAt,
        completed_by: actor.principal_id,
        archived_reason: null,
        ...(op.outcome === undefined
          ? { wrap_state: "pending" }
          : { wrap_state: "wrapped", outcome: op.outcome, wrapped_at: doneAt, wrapped_by: author }),
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
      if (staged.skip === true) return;
      const target = staged.target as Id<"t">;
      update(
        conn,
        target,
        op.kind === "task.delete"
          ? { deleted_at: run.at, deleted_by: actor.principal_id }
          : { deleted_at: null, deleted_by: null },
      );
      wrote(run, i, "tasks", target, target, ["deleted"]);
      if (op.kind === "task.delete") return;
      for (const { source } of staged.held ?? []) {
        conn.prepare(SQL.removeLink).run({ task: target, source, at: run.at });
        wrote(run, i, "task_sources", `${target}|${source}`, target, ["removed"]);
      }
      regroupRestored(conn, run, staged, target);
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
    case "note.delete":
    case "note.restore": {
      if (staged.skip === true) return;
      const task = must(staged.task, "A note has a task");
      const sql = op.kind === "note.delete" ? SQL.removeNote : SQL.reviveNote;
      conn
        .prepare(sql)
        .run({ id: staged.target, ...(op.kind === "note.delete" ? { at: run.at } : {}) });
      wrote(run, i, "notes", staged.target, task, ["deleted"]);
      return;
    }
    case "log.add": {
      if (staged.skip === true) return;
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
        at: op.at ?? run.at,
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
    case "source.unlink":
    case "source.relink": {
      if (staged.skip === true) return;
      const task = must(staged.task, "A source link has a task");
      const keys = { task, source: op.source };
      if (op.kind === "source.unlink") conn.prepare(SQL.removeLink).run({ ...keys, at: run.at });
      else conn.prepare(SQL.reviveLink).run(keys);
      wrote(run, i, "task_sources", `${task}|${op.source}`, task, ["removed"]);
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
      // The questions a task's run replies to are those that wait as it is queued: the person
      // wrote to what they saw, so no later change to the task gives the run others.
      const replies =
        staged.runTask === undefined || staged.runTask === null
          ? []
          : conn.prepare(REPLIED_SQL).all({ task: staged.runTask }).map((row) => String(row["id"]));
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
          ...(replies.length === 0 ? {} : { replies }),
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
    case "area.create": {
      const last = conn.prepare(SQL.lastArea).get()?.["p"] ?? undefined;
      if (last !== undefined && !isPosition(last)) throw invalidValue("areas", "position");
      conn.prepare(SQL.insertAreaWith).run({
        id: staged.target,
        slug: must(staged.slug, "A new area has its slug"),
        title: op.title,
        position: positionBetween(last, undefined),
        color: op.color ?? null,
        brief: op.brief ?? "",
        at: run.at,
        author,
        seq: run.seq,
      });
      wrote(run, i, "areas", staged.target, null, null);
      return;
    }
    case "project.create": {
      const area = staged.area ?? null;
      const last = conn.prepare(SQL.lastProject).get({ area })?.["p"] ?? undefined;
      if (last !== undefined && !isPosition(last)) throw invalidValue("projects", "position");
      conn.prepare(SQL.insertProjectWith).run({
        id: staged.target,
        area,
        slug: must(staged.slug, "A new project has its slug"),
        title: op.title,
        position: positionBetween(last, undefined),
        color: op.color ?? null,
        brief: op.brief ?? "",
        at: run.at,
        author,
        seq: run.seq,
      });
      wrote(run, i, "projects", staged.target, null, null);
      return;
    }
    case "area.patch":
    case "project.patch": {
      const entity = op.kind === "area.patch" ? "areas" : "projects";
      const values: Record<string, SqlValue> = {};
      for (const [field, value] of Object.entries(op.set)) {
        values[field] = (value ?? null) as SqlValue;
      }
      conn
        .prepare(updateGroupSql(entity, Object.keys(values)))
        .run({ ...values, id: staged.target });
      groupWrote(conn, run, i, entity, staged.target, Object.keys(values));
      return;
    }
    case "project.move": {
      const area = staged.area ?? null;
      const row = readRow(conn, "projects", staged.target);
      if (row["area_id"] !== area) {
        // At the end of its new area's projects.
        const last = conn.prepare(SQL.lastProject).get({ area })?.["p"] ?? undefined;
        if (last !== undefined && !isPosition(last)) throw invalidValue("projects", "position");
        conn
          .prepare(updateGroupSql("projects", ["area_id", "position"]))
          .run({ id: staged.target, area_id: area, position: positionBetween(last, undefined) });
        groupWrote(conn, run, i, "projects", staged.target, ["grouping"]);
      }
      // Its tasks are in its area: every one of them, whatever its state.
      for (const found of conn.prepare(SQL.tasksOfProject).all({ id: staged.target })) {
        const task = new RowReader("tasks", found).id("id", "t");
        if (readTask(conn, task).areaId === area) continue;
        ensureStart(conn, run, "tasks", task);
        conn.prepare(SQL.taskArea).run({ id: task, area });
        wrote(run, i, "tasks", task, task, ["grouping"]);
      }
      return;
    }
    case "area.archive":
    case "area.unarchive":
    case "project.archive":
    case "project.unarchive": {
      const entity = op.kind.startsWith("area.") ? "areas" : "projects";
      const lifecycle = op.kind.endsWith(".archive") ? "archived" : "active";
      const current = readRow(conn, entity, staged.target)["lifecycle"];
      // Archiving an archived group, or the other way, leaves it as it is. A completed project
      // counts as not archived.
      if (current === lifecycle || (lifecycle === "active" && current !== "archived")) return;
      conn.prepare(updateGroupSql(entity, ["lifecycle"])).run({ id: staged.target, lifecycle });
      groupWrote(conn, run, i, entity, staged.target, ["lifecycle"]);
      return;
    }
    case "project.delete": {
      // A deleted project's tasks would be filed nowhere a person looks: they move or go first.
      if (conn.prepare(SQL.liveTaskIn).get({ id: staged.target }) !== undefined) {
        problem(
          "VALIDATION_FAILED",
          "The project holds tasks: move or delete them first",
          i,
          "project",
        );
      }
      conn
        .prepare(updateGroupSql("projects", ["deleted_at"]))
        .run({ id: staged.target, deleted_at: run.at });
      groupWrote(conn, run, i, "projects", staged.target, ["deleted"]);
      for (const row of conn
        .prepare(FOLDER_SQL.liveOfOwner)
        .all({ kind: "project", owner: staged.target })) {
        const folder = decodeFolder(row);
        ensureStart(conn, run, "folders", folder.id);
        conn.prepare(SQL.folderDeleted).run({ id: folder.id, at: run.at });
        wrote(run, i, "folders", folder.id, null, ["deleted"]);
      }
      return;
    }
    case "project.restore": {
      const start = must(run.plan.starts.get(rowKey("projects", staged.target)), "No start");
      const gone = provenanceOf(start, "deleted");
      const slug = String(start.raw["slug"]);
      if (conn.prepare(SQL.projectSlugTaken).get({ slug }) !== undefined) {
        problem("VALIDATION_FAILED", "Another live project holds its slug now", i, "project");
      }
      conn
        .prepare(updateGroupSql("projects", ["deleted_at"]))
        .run({ id: staged.target, deleted_at: null });
      groupWrote(conn, run, i, "projects", staged.target, ["deleted"]);
      for (const row of conn
        .prepare(FOLDER_SQL.allOfOwner)
        .all({ kind: "project", owner: staged.target })) {
        const folder = decodeFolder(row);
        const state = rowState("folders", row, CHILD_FIELDS.folders);
        if (!folder.deleted || provenanceOf(state, "deleted") !== gone) continue;
        const os = machineOs(conn, folder.machineId);
        if (os === undefined) throw invalidValue("folders", "machine_id");
        // A folder another live project took meanwhile stays removed: that project's is named.
        const holder = folderHolder(conn, folder.machineId, folder.path, os, staged.target);
        if (holder !== undefined) {
          run.conflicts.push(rowConflict(conn, i, "folders", holder.id, "path", null));
          continue;
        }
        ensureStart(conn, run, "folders", folder.id);
        conn.prepare(SQL.folderDeleted).run({ id: folder.id, at: null });
        wrote(run, i, "folders", folder.id, null, ["deleted"]);
      }
      return;
    }
    case "project.folder_set":
    case "task.folder_set": {
      const owner = must(staged.owner, "A folder has an owner");
      const { machine, os } = must(staged.folder, "A folder has its machine");
      const kind = owner.kind === "task" ? "task" : "project";
      const row = conn.prepare(FOLDER_SQL.liveOf).get({ kind, owner: owner.id, machine });
      const movedProjects: { id: string; moved: string }[] = [];
      if (row === undefined) {
        conn.prepare(SQL.insertFolder).run({
          id: staged.target,
          kind,
          owner: owner.id,
          machine,
          path: op.path,
          at: run.at,
          seq: run.seq,
        });
        wrote(run, i, "folders", staged.target, staged.task, null);
      } else {
        const found = decodeFolder(row);
        if (found.id !== staged.target) throw misuse("A folder is not the one staging found");
        if (found.path !== op.path) {
          conn.prepare(SQL.folderPath).run({ id: found.id, path: op.path });
          wrote(run, i, "folders", found.id, staged.task, ["path"]);
          // A moved folder takes the folders inside it that moved with it along, the rest of each
          // path as it is: one change, one undo.
          if (op.carry !== undefined && op.carry.length > 0) {
            const carried = new Set(op.carry);
            for (const inside of conn.prepare(FOLDER_SQL.liveOn).all({ machine })) {
              const other = decodeFolder(inside);
              if (other.id === found.id || !carried.has(other.ownerId)) continue;
              const moved = carriedTo(other.path, found.path, op.path, os);
              if (moved === undefined || moved === other.path) continue;
              ensureStart(conn, run, "folders", other.id);
              conn.prepare(SQL.folderPath).run({ id: other.id, path: moved });
              const task = other.ownerKind === "task" ? (other.ownerId as Id<"t">) : null;
              wrote(run, i, "folders", other.id, task, ["path"]);
              if (other.ownerKind === "project") movedProjects.push({ id: other.ownerId, moved });
            }
          }
        }
      }
      // Two live projects never share one folder on one machine, by the machine's case rule.
      if (kind === "project") movedProjects.push({ id: owner.id, moved: op.path });
      for (const project of movedProjects) {
        if (folderHolder(conn, machine, project.moved, os, project.id) !== undefined) {
          problem(
            "FOLDER_TAKEN",
            "Another live project has this folder on this machine",
            i,
            "path",
          );
        }
      }
      return;
    }
    case "project.folder_clear":
    case "task.folder_clear": {
      const owner = must(staged.owner, "A folder has an owner");
      if (owner.bound !== true) return;
      // Its project's delete earlier in the request removed it already.
      if (readRow(conn, "folders", staged.target)["deleted_at"] !== null) return;
      conn.prepare(SQL.folderDeleted).run({ id: staged.target, at: run.at });
      wrote(run, i, "folders", staged.target, staged.task, ["deleted"]);
      return;
    }
    case "undo":
    case "redo":
      throw misuse("A request of its own is never executed here");
  }
}

/**
 * Records that operation `i` wrote `fields` of an area or a project. One the request created is
 * written whole by its create row; an existing one has its start from staging.
 */
function groupWrote(
  conn: Connection,
  run: Execution,
  i: number,
  entity: "areas" | "projects",
  id: string,
  fields: readonly string[],
): void {
  ensureStart(conn, run, entity, id);
  wrote(run, i, entity, id, null, fields);
}

/**
 * Gives a row the request writes a start state when staging gave it none: a row no earlier write
 * of the request touched is as the request found it, so its live state is its start.
 */
function ensureStart(
  conn: Connection,
  run: Execution,
  entity: "tasks" | "areas" | "projects" | "folders",
  id: string,
): void {
  const key = rowKey(entity, id);
  if (run.rows.has(key) || run.plan.starts.has(key)) return;
  const row = readRow(conn, entity, id);
  run.plan.starts.set(
    key,
    entity === "tasks" ? decodeTask(row) : rowState(entity, row, CHILD_FIELDS[entity]),
  );
}

/** A conflict that names a row as it stands: its field's value, who wrote it and when. */
function rowConflict(
  conn: Connection,
  op: number,
  entity: "folders",
  id: string,
  field: string,
  task: Id<"t"> | null,
): FieldConflict {
  const row = readRow(conn, entity, id);
  const state = rowState(entity, row, CHILD_FIELDS[entity]);
  const version = versionOf(state, field);
  const by = conn.prepare(SQL.commitAuthor).get({ seq: version });
  if (by === undefined) throw invalidValue(entity, "fv");
  const r = new RowReader("commits", by);
  return {
    op,
    entity,
    id,
    ...(task === null ? {} : { task }),
    field,
    value: valueOf(entity, row, field),
    version,
    by: {
      actor: r.id("actor", "ac"),
      kind: r.text("kind"),
      label: r.text("label"),
      origin: r.text("origin"),
    },
    at: r.int("at", "instant"),
  };
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

/**
 * The tasks whose readable files a commit's changes reach: each change's task, and each task of a
 * project whose folder changed, since a task opens in its project's folder where it has none.
 */
function projectionTasks(
  conn: Connection,
  changes: readonly { entity: string; entityId: string; taskId: string | null }[],
): Set<string> {
  const tasks = new Set<string>();
  for (const c of changes) {
    if (c.taskId !== null) tasks.add(c.taskId);
    else if (c.entity === "folders") {
      for (const row of conn.prepare(SQL.folderTasks).all({ id: c.entityId })) {
        tasks.add(String(row["id"]));
      }
    }
  }
  return tasks;
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
      const before = fieldJson(valueOf(row.entity, start.raw, field));
      const after = fieldJson(valueOf(row.entity, final, field));
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
