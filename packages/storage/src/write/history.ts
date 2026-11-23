// Inverting history (A1 3.10): the engine under undo and redo (3.10.1) and, from M3.03, revert
// (3.10.2, 3.10.3). It reads a commit's change rows, plans their inversion under each field's
// provenance, and applies a plan on the writer's connection, inside the writer's transaction. The
// writer (writer.ts) chooses what to invert, writes the inverting commit with its change rows and
// outbox rows, and moves the undo stack.
//
// Every field has two numbers (A1 3.10): `fv`, its physical version, the seq of the last commit
// that wrote it, which only grows; and `fp`, its provenance, the seq of the commit whose write it
// holds (row-state.ts). Inversions are guarded by provenance, never by value (R2): a field that
// someone else set away and back holds their write, not the original.
//
// - A `set` row `ch` of field f inverts only while f holds the write ch made: fp[f] = ch.after_prov.
//   f then gets ch.before back with fp[f] = ch.before_prov, and fv[f] the inverting commit's seq,
//   so a stale base still conflicts after an undo. The inverting row records
//   before_prov = ch.after_prov and after_prov = ch.before_prov: inverting it in turn (a redo) is
//   guarded by the provenance this inversion restored, and brings ch's value back with ch's own
//   provenance.
// - A `create` row inverts by tombstoning its row, while every field of the row holds a write of
//   the creating commits and every live child row (a task's notes, log entries, learnings,
//   attachments, source links, label links, places and runs; a source's links) was created by
//   them. A run has no tombstone and is never the creating commits', so a task with a run keeps
//   its create. The tombstone is a write of its own (after_prov is the inverting commit), so a
//   redo clears it under that guard.
// - Setting a tombstone back (a redo of a removal, the undo of a restore) puts a row out of sight
//   again, a step the person decided before anything done to the row since. Another's change to
//   the row after the step was last applied (its commit, or a redo of it since), and for a task to
//   anything on it (a field, a note, a log entry, a link, a run, a folder), keeps it in sight, as a
//   conflict that names the newest such change. The principal's own steps (its undoable writes,
//   undos and redos) do not count: the person made them.
// - Clearing a tombstone (a redo of a create's undo, or the undo of a delete) brings a row back. A
//   source whose key, or a place whose owner and machine, another live row holds now stays
//   tombstoned, and that row is the conflict: the unique indexes allow one live row each.
// - A restore never makes a second active holder of a source key (dedupe never makes two active
//   tasks for one item), and never leaves a task more than 20 live learnings. These rules span
//   rows, so they are decided on the state the inversion makes, not predicted from the state
//   before it (applyInversions below).
// - Launch, session, run and machine records are never inverted (A1 3.6, 3.10.3), so no inversion
//   writes one, and none re-attaches a run that redaction detached.
//
// A task's lifecycle and wrap-up obey one CHECK (an active task has no wrap state). An inversion of
// both, where both pass, restores a state the task had; a partial one could split them, so with
// `partial` the two stay together: when one conflicts, the other stays too, named with the write
// that holds its partner.
//
// Every statement is built from the constant table, column and field names below and in
// fields.ts, with values bound as parameters (A1 3.7).
import { newerBy } from "@ttasks/contracts/newer-work";
import type { Connection, Row, SqlValue } from "../driver.ts";
import { misuse, StorageError } from "../errors.ts";
import { isId, type Id } from "../ids.ts";
import { formatTaskRef } from "../refs.ts";
import { inRange, invalidValue, RowReader } from "../rows.ts";
import {
  decodeFolder,
  FOLDER_SQL,
  folderKey,
  hasFolders,
  machineOs,
  type FolderOs,
  type FolderRow,
} from "./folders.ts";
import { CHILD_FIELDS, columnsValue, fieldJson, TASK_FIELDS } from "./fields.ts";
import {
  RequestProblem,
  WRITE_LIMITS,
  type ConflictEntity,
  type FieldConflict,
  type NewerWork,
} from "./request.ts";
import { provenanceOf, rowState, versionOf, type RowState } from "./row-state.ts";

/** The tables whose rows an inversion writes. */
export type InvertibleEntity =
  | "tasks"
  | "notes"
  | "log_entries"
  | "learnings"
  | "sources"
  | "task_sources"
  | "places"
  | "areas"
  | "projects"
  | "folders";

interface Table {
  readonly fields: Readonly<Record<string, readonly string[]>>;
  /** The logical field a tombstone sets: `deleted`, or `removed` for a link. */
  readonly tombstone: string;
  /** The row by its `changes.entity_id`: `$id`, or `$task` and `$source` for a link. */
  readonly where: string;
}

const BY_ID = "id = $id";

const TABLES: Readonly<Record<InvertibleEntity, Table>> = {
  tasks: { fields: TASK_FIELDS, tombstone: "deleted", where: BY_ID },
  notes: { fields: CHILD_FIELDS.notes, tombstone: "deleted", where: BY_ID },
  log_entries: { fields: CHILD_FIELDS.log_entries, tombstone: "deleted", where: BY_ID },
  learnings: { fields: CHILD_FIELDS.learnings, tombstone: "deleted", where: BY_ID },
  sources: { fields: CHILD_FIELDS.sources, tombstone: "deleted", where: BY_ID },
  task_sources: {
    fields: CHILD_FIELDS.task_sources,
    tombstone: "removed",
    where: "task_id = $task AND source_id = $source",
  },
  places: { fields: CHILD_FIELDS.places, tombstone: "deleted", where: BY_ID },
  areas: { fields: CHILD_FIELDS.areas, tombstone: "deleted", where: BY_ID },
  projects: { fields: CHILD_FIELDS.projects, tombstone: "deleted", where: BY_ID },
  folders: { fields: CHILD_FIELDS.folders, tombstone: "deleted", where: BY_ID },
};

/**
 * A logical field's value in a row: its columns'. An `ext.<key>` field (A1 3.4) only the prototype
 * import wrote, in commits no undo or redo reaches, so no inversion names one.
 */
function valueIn(
  entity: InvertibleEntity,
  raw: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  return columnsValue(raw, TABLES[entity].fields[field] ?? []);
}

/** Whether `field` is a logical field of `entity`'s rows. */
const hasField = (entity: InvertibleEntity, field: string): boolean =>
  Object.hasOwn(TABLES[entity].fields, field);

const isInvertible = (entity: string): entity is InvertibleEntity => Object.hasOwn(TABLES, entity);

/** A row's key parameters from its `changes.entity_id` (`task_id|source_id` for a link). */
function keyOf(entity: InvertibleEntity, id: string): Record<string, string> {
  if (entity !== "task_sources") return { id };
  const [task = "", source = ""] = id.split("|");
  return { task, source };
}

/**
 * A child row whose life keeps its parent's create from being inverted: one that another commit
 * created or revived, or one the creating commits made that holds another's write in any field.
 */
interface Child {
  readonly entity: ConflictEntity;
  /** Its `changes.entity_id`, as SQL. */
  readonly key: string;
  /** The task it belongs to, as SQL. */
  readonly task: string;
  /** The column naming its parent, which the query matches against `$parents`. */
  readonly parent: string;
  /** A further condition on its rows, as SQL, or "". */
  readonly where: string;
  /** Its logical fields (fields.ts), its tombstone among them. */
  readonly fields: Readonly<Record<string, readonly string[]>>;
  /**
   * Its tombstone field and that field's column. A run has no tombstone: every run is live, and
   * its conflict names its `state` with who created it.
   */
  readonly field: "deleted" | "removed" | "state";
  readonly column: "deleted_at" | "removed_at" | null;
  /** A table a later schema step added (runs, 0.3): a space without it has no such children. */
  readonly since?: true;
}

const LINK_KEY = "task_id || '|' || source_id";

/** A1 3.10: a task's notes, log entries, learnings, links, attachments, places and runs. */
const TASK_CHILDREN: readonly Child[] = [
  ...(["notes", "log_entries", "learnings"] as const).map((entity): Child => ({
    entity,
    key: "id",
    task: "task_id",
    parent: "task_id",
    where: "",
    fields: CHILD_FIELDS[entity],
    field: "deleted",
    column: "deleted_at",
  })),
  // Schema 0.2's rows that no operation writes yet: their tombstone is their one field so far.
  {
    entity: "attachments",
    key: "id",
    task: "task_id",
    parent: "task_id",
    where: "",
    fields: { deleted: ["deleted_at"] },
    field: "deleted",
    column: "deleted_at",
  },
  {
    entity: "task_sources",
    key: LINK_KEY,
    task: "task_id",
    parent: "task_id",
    where: "",
    fields: CHILD_FIELDS.task_sources,
    field: "removed",
    column: "removed_at",
  },
  {
    entity: "task_labels",
    key: "task_id || '|' || label_id",
    task: "task_id",
    parent: "task_id",
    where: "",
    fields: { removed: ["removed_at"] },
    field: "removed",
    column: "removed_at",
  },
  {
    entity: "places",
    key: "id",
    task: "owner_id",
    parent: "owner_id",
    where: " AND owner_kind = 'task'",
    fields: CHILD_FIELDS.places,
    field: "deleted",
    column: "deleted_at",
  },
  // A run holds the person's request and the agent's result, task text a tombstone would hide, so
  // it keeps its task's create in any state (A1 3.10). It is always another commit's: a run
  // request holds run operations only (A1 3.6). A detached run names no task and keeps nothing.
  {
    entity: "runs",
    key: "id",
    task: "task_id",
    parent: "task_id",
    where: "",
    fields: CHILD_FIELDS.runs,
    field: "state",
    column: null,
    since: true,
  },
  folderChild("task", "owner_id"),
];

/** A source's links: a source another task links to stays. */
const SOURCE_CHILDREN: readonly Child[] = [
  {
    entity: "task_sources",
    key: LINK_KEY,
    task: "task_id",
    parent: "source_id",
    where: "",
    fields: CHILD_FIELDS.task_sources,
    field: "removed",
    column: "removed_at",
  },
];

/** An owner's folders (schema 0.5): a folder another commit set keeps its owner's create. */
function folderChild(kind: "task" | "project", task: string): Child {
  return {
    entity: "folders",
    key: "id",
    task,
    parent: "owner_id",
    where: ` AND owner_kind = '${kind}'`,
    fields: CHILD_FIELDS.folders,
    field: "deleted",
    column: "deleted_at",
    since: true,
  };
}

/** A group's places: a place another commit bound to it keeps it. */
const groupPlaces = (kind: "area" | "project"): Child => ({
  entity: "places",
  key: "id",
  task: "NULL",
  parent: "owner_id",
  where: ` AND owner_kind = '${kind}'`,
  fields: CHILD_FIELDS.places,
  field: "deleted",
  column: "deleted_at",
});

/** A group's tasks: a task in it that another commit created or moved there keeps it. */
const groupTasks = (column: "area_id" | "project_id"): Child => ({
  entity: "tasks",
  key: "id",
  task: "id",
  parent: column,
  where: "",
  fields: TASK_FIELDS,
  field: "deleted",
  column: "deleted_at",
});

/** An area's tasks, projects and places, and a project's tasks and places (A7 3.15.5). */
const AREA_CHILDREN: readonly Child[] = [
  groupTasks("area_id"),
  {
    entity: "projects",
    key: "id",
    task: "NULL",
    parent: "area_id",
    where: "",
    fields: CHILD_FIELDS.projects,
    field: "deleted",
    column: "deleted_at",
  },
  groupPlaces("area"),
];
const PROJECT_CHILDREN: readonly Child[] = [
  groupTasks("project_id"),
  groupPlaces("project"),
  folderChild("project", "NULL"),
];

const CHILDREN: Readonly<Partial<Record<InvertibleEntity, readonly Child[]>>> = {
  tasks: TASK_CHILDREN,
  sources: SOURCE_CHILDREN,
  areas: AREA_CHILDREN,
  projects: PROJECT_CHILDREN,
};

/**
 * The live children of every parent in `$parents` (a JSON array of IDs), in one statement per
 * child table: a commit can create many rows, and a source's links have no index by source, so a
 * statement per created row would scan the links once per source.
 */
const childSql = (c: Child): string =>
  `SELECT ${c.key} AS key, ${c.task} AS task, ${c.parent} AS parent, * FROM ${c.entity} ` +
  `WHERE ${c.parent} IN (SELECT value FROM json_each($parents))${c.where}` +
  `${c.column === null ? "" : ` AND ${c.column} IS NULL`} ORDER BY created_seq, key`;

const TABLE_EXISTS = "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = $name";

/** A live child row of a parent the plan may tombstone. */
interface Kid {
  readonly child: Child;
  /** Its `changes.entity_id`. */
  readonly id: string;
  readonly task: Id<"t"> | null;
  readonly state: RowState;
}

/** The live children of each row `changes` creates, by `<entity>|<id>` of the parent. */
function liveChildren(conn: Connection, changes: readonly StoredChange[]): Map<string, Kid[]> {
  const kids = new Map<string, Kid[]>();
  for (const [entity, children] of Object.entries(CHILDREN)) {
    const parents = changes
      .filter((ch) => ch.action === "create" && ch.entity === entity)
      .map((ch) => ch.entityId);
    if (parents.length === 0) continue;
    for (const child of children) {
      // A space at 0.2 has no runs: its undo works as before the table existed.
      if (
        child.since === true &&
        conn.prepare(TABLE_EXISTS).get({ name: child.entity }) === undefined
      ) {
        continue;
      }
      const rows = conn.prepare(childSql(child)).all({ parents: JSON.stringify(parents) });
      for (const row of rows) {
        const r = new RowReader(child.entity, row);
        const key = `${entity}|${r.text("parent")}`;
        const kid: Kid = {
          child,
          id: r.text("key"),
          task: r.optText("task", (v) => isId(v, "t")) as Id<"t"> | null,
          state: rowState(child.entity, row, child.fields),
        };
        const list = kids.get(key);
        if (list === undefined) kids.set(key, [kid]);
        else list.push(kid);
      }
    }
  }
  return kids;
}

const COMMIT_COLUMNS = "seq, id, undo_status, undone_by";

/** Changes after `$since` of row `$entity` `$id`, and of everything of task `$task`, by others. */
function newerWhere(runs: string): string {
  return (
    "WHERE c.seq > $since " +
    `AND (c.task_id = $task OR (c.entity = $entity AND c.entity_id = $id)${runs}) ` +
    "AND NOT (k.principal_id = $principal AND (k.undo_status IS NOT NULL " +
    "OR k.kind IN ('undo', 'redo')))"
  );
}

function newerWorkSql(runs: string): string {
  return (
    "SELECT c.entity AS entity, c.entity_id AS id, " +
    "coalesce(c.task_id, CASE c.entity WHEN 'runs' THEN $task END) AS task, c.field AS field, " +
    `max(c.seq) AS version FROM changes c JOIN commits k ON k.seq = c.seq ${newerWhere(runs)} ` +
    "GROUP BY c.entity, c.entity_id, c.field ORDER BY min(c.seq), c.entity, c.entity_id, c.field"
  );
}

/** Who made those changes: each author once, with the time of their newest, a run's apart. */
function newerAuthorsSql(runs: string): string {
  return (
    "SELECT c.entity = 'runs' AS run, k.author_id AS actor, a.kind AS kind, a.label AS label, " +
    "k.origin AS origin, max(k.at) AS at FROM changes c JOIN commits k ON k.seq = c.seq " +
    `JOIN actors a ON a.id = k.author_id ${newerWhere(runs)} ` +
    "GROUP BY c.entity = 'runs', k.author_id, k.origin"
  );
}

const RUNS_OF_TASK =
  " OR (c.entity = 'runs' AND c.entity_id IN (SELECT id FROM runs WHERE task_id = $task))";

const SQL = {
  changes: "SELECT * FROM changes WHERE seq = $seq ORDER BY n",
  newestDone:
    `SELECT ${COMMIT_COLUMNS} FROM commits WHERE principal_id = $principal ` +
    "AND undo_status = 'done' ORDER BY seq DESC LIMIT 1",
  /** The `done` commit of the principal's newest redo after `$after`, if any. */
  newestRedone:
    "SELECT t.seq AS seq, t.id AS id, t.undo_status AS undo_status, t.undone_by AS undone_by " +
    "FROM commits r JOIN commits t ON t.seq = r.redo_of WHERE r.seq > $after " +
    "AND r.principal_id = $principal AND r.kind = 'redo' AND t.undo_status = 'done' " +
    "ORDER BY r.seq DESC LIMIT 1",
  undone:
    `SELECT ${COMMIT_COLUMNS} FROM commits WHERE principal_id = $principal ` +
    "AND undo_status = 'undone' ORDER BY seq",
  /** Of the commits in `$seqs`, the principal's own steps: undoable writes, undos and redos. */
  ownSteps:
    "SELECT seq FROM commits WHERE seq IN (SELECT value FROM json_each($seqs)) " +
    "AND principal_id = $principal AND (undo_status IS NOT NULL OR kind IN ('undo', 'redo'))",
  /** The newest redo of commit `$seq`, if any. */
  lastRedo: "SELECT max(seq) AS seq FROM commits WHERE seq > $seq AND redo_of = $seq",
  author:
    "SELECT k.at AS at, k.author_id AS actor, a.kind AS kind, a.label AS label, " +
    "k.origin AS origin FROM commits k JOIN actors a ON a.id = k.author_id WHERE k.seq = $seq",
  taskRef: "SELECT ref FROM tasks WHERE id = $id",
  sourceTaken: "SELECT * FROM sources WHERE source_key = $key AND deleted_at IS NULL AND id <> $id",
  placeTaken:
    "SELECT * FROM places WHERE owner_kind = $kind AND owner_id = $owner " +
    "AND machine_id = $machine AND deleted_at IS NULL AND id <> $id",
  areaTaken: "SELECT * FROM areas WHERE slug = $slug AND deleted_at IS NULL AND id <> $id",
  projectTaken: "SELECT * FROM projects WHERE slug = $slug AND deleted_at IS NULL AND id <> $id",
  folderTaken:
    "SELECT * FROM folders WHERE owner_kind = $kind AND owner_id = $owner " +
    "AND machine_id = $machine AND deleted_at IS NULL AND id <> $id",
  /** A project's live folders while the project is live. */
  liveFoldersOfProject:
    "SELECT f.id AS id FROM folders f JOIN projects p ON p.id = f.owner_id " +
    "WHERE f.owner_kind = 'project' AND f.owner_id = $id AND f.deleted_at IS NULL " +
    "AND p.deleted_at IS NULL",
  liveProject: "SELECT 1 AS found FROM projects WHERE id = $id AND deleted_at IS NULL",
  /** The projects that the tasks in `$tasks` are in now. */
  projectsOfTasks:
    "SELECT id, project_id AS project FROM tasks WHERE id IN (SELECT value FROM json_each($tasks)) " +
    "AND project_id IS NOT NULL",
  /** The project owners of the folders in `$folders`. */
  ownersOfFolders:
    "SELECT owner_id AS project FROM folders WHERE id IN (SELECT value FROM json_each($folders)) " +
    "AND owner_kind = 'project'",
  /** The live tasks of the deleted projects in `$projects`. */
  liveTasksOfDeleted:
    "SELECT t.id AS id, t.project_id AS project FROM tasks t JOIN projects p ON p.id = t.project_id " +
    "WHERE p.id IN (SELECT value FROM json_each($projects)) AND p.deleted_at IS NOT NULL " +
    "AND t.deleted_at IS NULL ORDER BY t.project_id, t.ref",
  /** The live folders of the deleted projects in `$projects`. */
  liveFoldersOfDeleted:
    "SELECT f.id AS id, f.owner_id AS project FROM folders f JOIN projects p ON p.id = f.owner_id " +
    "WHERE f.owner_kind = 'project' AND p.id IN (SELECT value FROM json_each($projects)) " +
    "AND p.deleted_at IS NOT NULL AND f.deleted_at IS NULL ORDER BY f.owner_id, f.id",
  /** The tasks in `$tasks`, or in a project in `$projects`, whose area is not their project's. */
  outOfArea:
    "SELECT t.id AS id, t.project_id AS project FROM tasks t JOIN projects p ON p.id = t.project_id " +
    "WHERE (t.id IN (SELECT value FROM json_each($tasks)) " +
    "OR t.project_id IN (SELECT value FROM json_each($projects))) " +
    "AND t.area_id IS NOT p.area_id ORDER BY t.id",
  /**
   * The active holders, as they stand, of the keyed sources in `$sources` and of those the tasks
   * in `$tasks` link to (A1 3.6): an active task that is not deleted, with a live link to the live
   * source. One pass over `task_sources`, which has no index by source; the tasks' own links are
   * read by its primary key.
   */
  activeHolders:
    "SELECT ts.task_id AS task_id, ts.source_id AS source_id " +
    "FROM task_sources ts JOIN sources s ON s.id = ts.source_id JOIN tasks t ON t.id = ts.task_id " +
    "WHERE ts.source_id IN (SELECT value FROM json_each($sources) UNION " +
    "SELECT source_id FROM task_sources WHERE task_id IN (SELECT value FROM json_each($tasks))) " +
    "AND s.source_key IS NOT NULL AND s.deleted_at IS NULL AND ts.removed_at IS NULL " +
    "AND t.deleted_at IS NULL AND t.lifecycle = 'active' ORDER BY ts.source_id, t.ref",
  /** The live learnings of the tasks in `$tasks` (A1 3.11.2). */
  liveLearnings:
    "SELECT task_id, id FROM learnings WHERE deleted_at IS NULL " +
    "AND task_id IN (SELECT value FROM json_each($tasks)) ORDER BY task_id, position",
  /**
   * The rows and fields others changed after `$since`: of row `$entity` `$id`, and of everything
   * of task `$task`. Each once, with its newest change; a create has no field.
   */
  newerWork: newerWorkSql(""),
  /** The same, with the task's runs, whose changes name no task (runs.ts). */
  newerWorkWithRuns: newerWorkSql(RUNS_OF_TASK),
  /** Who made them: each author once, with the time of their newest. */
  newerAuthors: newerAuthorsSql(""),
  newerAuthorsWithRuns: newerAuthorsSql(RUNS_OF_TASK),
  touched: "UPDATE tasks SET touched = $seq WHERE id = $id",
} as const;

// ---------------------------------------------------------------------------------------------
// History as stored

/** One `changes` row (A1 3.4), decoded. `before` and `after` stay JSON text. */
export interface StoredChange {
  seq: number;
  n: number;
  op: number;
  entity: string;
  /** The row: its ID, or `task_id|source_id` for a link. */
  entityId: string;
  taskId: Id<"t"> | null;
  action: "create" | "set";
  /** The logical field of a `set` row. */
  field: string | null;
  before: string | null;
  after: string;
  beforeVer: number | null;
  beforeProv: number | null;
  afterProv: number;
}

function decodeChange(row: Row): StoredChange {
  const r = new RowReader("changes", row);
  const action = r.oneOf("action", ["create", "set"]);
  const change: StoredChange = {
    seq: r.int("seq", "seq"),
    n: r.int("n", "count"),
    op: r.int("op", "count"),
    entity: r.text("entity"),
    entityId: r.text("entity_id"),
    taskId: r.optText("task_id", (v) => isId(v, "t")) as Id<"t"> | null,
    action,
    field: r.optText("field"),
    before: r.optText("before"),
    after: r.text("after"),
    beforeVer: r.optInt("before_ver", "seq"),
    beforeProv: r.optInt("before_prov", "seq"),
    afterProv: r.int("after_prov", "seq"),
  };
  // A set row names its field and what it held before; a create row neither.
  if (action === "set" && change.field === null) throw invalidValue("changes", "field");
  if (action === "set" && (change.before === null || change.beforeProv === null)) {
    throw invalidValue("changes", "before");
  }
  return change;
}

/** A commit's change rows, in their order. */
export function readChanges(conn: Connection, seq: number): StoredChange[] {
  return conn.prepare(SQL.changes).all({ seq }).map(decodeChange);
}

/** A commit on a principal's undo stack (A1 3.10.1). */
export interface StackCommit {
  seq: number;
  id: Id<"op">;
  /** The undo that undid it, while it is `undone`. */
  undoneBy: number | null;
}

function decodeStackCommit(row: Row | undefined): StackCommit | undefined {
  if (row === undefined) return undefined;
  const r = new RowReader("commits", row);
  const status = r.oneOf("undo_status", ["done", "undone"]);
  const undoneBy = r.optInt("undone_by", "seq");
  // An undone commit names its undo; a done one names none (a redo clears it).
  if ((status === "undone") !== (undoneBy !== null)) throw invalidValue("commits", "undone_by");
  return { seq: r.int("seq", "seq"), id: r.id("id", "op"), undoneBy };
}

/**
 * What undo takes (A1 3.10.1): the principal's `done` commit applied last, by its newest redo or
 * else by its own seq. A redo can apply a step before an older one it passed over, so a step's own
 * seq does not say which came last: a redo after the newest `done` commit does.
 */
export function undoTarget(conn: Connection, principal: Id<"ac">): StackCommit | undefined {
  const newest = decodeStackCommit(conn.prepare(SQL.newestDone).get({ principal }));
  const after = newest?.seq ?? 0;
  return decodeStackCommit(conn.prepare(SQL.newestRedone).get({ principal, after })) ?? newest;
}

/** What redo tries, in this order: the principal's `undone` commits, oldest first (A1 3.10.1). */
export function redoSteps(conn: Connection, principal: Id<"ac">): StackCommit[] {
  return conn
    .prepare(SQL.undone)
    .all({ principal })
    .map((row) => {
      const step = decodeStackCommit(row);
      if (step === undefined) throw invalidValue("commits", "undo_status");
      return step;
    });
}

/** The commit that last applied a `done` commit's rows: its newest redo, else the commit itself. */
export function lastApplied(conn: Connection, seq: number): number {
  const redo = conn.prepare(SQL.lastRedo).get({ seq })?.["seq"];
  return typeof redo === "number" ? redo : seq;
}

// ---------------------------------------------------------------------------------------------
// Planning

/** A field set back to a change row's before-value, with the provenance that came with it. */
export interface Restore {
  kind: "restore";
  entity: InvertibleEntity;
  id: string;
  task: Id<"t"> | null;
  field: string;
  /** The value, as `changes` holds it. */
  value: string;
  prov: number;
  /** The row it inverts. */
  change: StoredChange;
}

/** A row the creating commits made, tombstoned. */
export interface Tombstone {
  kind: "tombstone";
  entity: InvertibleEntity;
  id: string;
  task: Id<"t"> | null;
  /** The table's tombstone field. */
  field: string;
  change: StoredChange;
}

export type Inversion = Restore | Tombstone;

export interface InversionPlan {
  /** What passes its guard, in the order of the rows it inverts. */
  inversions: Inversion[];
  /** Each field whose guard fails, and each live child row that blocks a create's inversion. */
  conflicts: FieldConflict[];
  /** PlanOptions.applied: what the rules across rows count from too (applyInversions). */
  applied: number;
}

export interface PlanOptions {
  /** The commits whose create rows may be inverted: the commit undone, or a session's (M3.03). */
  creating: ReadonlySet<number>;
  /** The space's reference prefix, for the conflicts' task references. */
  refPrefix: string;
  /** A partial inversion keeps a task's lifecycle and wrap-up together (the header). */
  partial: boolean;
  /** The request's operation index the conflicts name. */
  op: number;
  /** Whose undo or redo it is: its own steps since are no newer work (the header). */
  principal: Id<"ac">;
  /**
   * The commit that last applied the rows inverted: their own, or a redo of them since. Others'
   * changes after it are newer work (the header).
   */
  applied: number;
}

const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw invalidValue("changes", "after");
  }
};

/** Where a conflict is: what a guard knows. The namer adds who wrote it, when, and the reference. */
type Where = Omit<FieldConflict, "op" | "ref" | "by" | "at" | "version">;

/** A task's reference, such as `M-14`, read once per task. */
function refsOf(conn: Connection, refPrefix: string): (task: Id<"t">) => string {
  const refs = new Map<string, string>();
  return (task) => {
    let ref = refs.get(task);
    if (ref === undefined) {
      const found = conn.prepare(SQL.taskRef).get({ id: task });
      if (found === undefined) throw invalidValue("changes", "task_id");
      ref = formatTaskRef(refPrefix, new RowReader("tasks", found).int("ref", "taskRef"));
      refs.set(task, ref);
    }
    return ref;
  };
}

/**
 * Names conflicts for operation `op`: a conflict on `where`, with the commit at `version` (who
 * wrote the field, and when) and its task's reference.
 */
function namer(
  conn: Connection,
  options: { op: number },
  refOf: (task: Id<"t">) => string,
): (where: Where, version: number) => FieldConflict {
  return (where, version) => {
    const by = conn.prepare(SQL.author).get({ seq: version });
    if (by === undefined) throw invalidValue(where.entity, "fv");
    const r = new RowReader("commits", by);
    return {
      op: options.op,
      ...where,
      ...(where.task === undefined ? {} : { ref: refOf(where.task) }),
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
}

/**
 * Plans the inversion of `changes` (A1 3.10): each set row under its provenance guard, each create
 * row under the create guard with `creating` as the creating commits. Reads only; a refusal that
 * no guard decides (a launch record) is a RequestProblem.
 */
export function planInversions(
  conn: Connection,
  changes: readonly StoredChange[],
  options: PlanOptions,
): InversionPlan {
  const plan: InversionPlan = {
    inversions: [],
    conflicts: [],
    applied: options.applied,
  };
  const refOf = refsOf(conn, options.refPrefix);
  const rows = new Map<string, RowState>();
  const kids = liveChildren(conn, changes);
  /**
   * Each (row, field) is named once: a child row of a create can block both its own create and
   * its parent's. The first naming stays, completed by what a later one knows (`wrote`).
   */
  const named = new Map<string, FieldConflict>();
  const blocked = (c: FieldConflict): void => {
    const key = `${c.entity}|${c.id}|${c.field}`;
    const earlier = named.get(key);
    if (earlier === undefined) {
      named.set(key, c);
      plan.conflicts.push(c);
    } else {
      for (const [k, v] of Object.entries(c)) {
        if (!Object.hasOwn(earlier, k)) Object.assign(earlier, { [k]: v as unknown });
      }
    }
  };
  const read = (entity: InvertibleEntity, id: string): RowState => {
    const key = `${entity}|${id}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = readRow(conn, entity, id);
      if (row === undefined) throw invalidValue("changes", "entity_id");
      rows.set(key, row);
    }
    return row;
  };
  /** A conflict on `where`, named with the commit at `version`: who wrote it and when. */
  const conflict = namer(conn, options, refOf);
  /** A field of a row that does not hold the write an inversion needs. */
  const fieldConflict = (
    entity: InvertibleEntity,
    id: string,
    task: Id<"t"> | null,
    field: string,
    values: { wrote?: unknown; restore?: unknown },
  ): FieldConflict => {
    const row = read(entity, id);
    return conflict(
      {
        entity,
        id,
        ...(task === null ? {} : { task }),
        field,
        value: valueIn(entity, row.raw, field),
        ...values,
      },
      versionOf(row, field),
    );
  };

  for (const change of changes) {
    const { entity } = change;
    if (!isInvertible(entity)) {
      throw new RequestProblem({
        code: "VALIDATION_FAILED",
        message: "The change holds records that are never undone",
        op: options.op,
      });
    }
    const id = change.entityId;
    const row = read(entity, id);
    const table = TABLES[entity];

    if (change.action === "set") {
      const field = change.field ?? "";
      if (!hasField(entity, field)) throw invalidValue("changes", "field");
      const restore = change.before ?? "null";
      if (provenanceOf(row, field) !== change.afterProv) {
        blocked(
          fieldConflict(entity, id, change.taskId, field, {
            wrote: parsed(change.after),
            restore: parsed(restore),
          }),
        );
        continue;
      }
      // A row brought back must not take a key another live row holds now.
      const taken =
        field === table.tombstone && restore === "null" ? takenBy(conn, entity, row) : undefined;
      if (taken !== undefined) {
        const other = rowState(entity, taken.row, table.fields);
        blocked(
          conflict(
            {
              entity,
              id: taken.id,
              ...(taken.task === null ? {} : { task: taken.task }),
              field,
              value: null,
            },
            versionOf(other, field),
          ),
        );
        continue;
      }
      if (field === table.tombstone && !isLive(parsed(restore))) {
        const newer = newerWork(conn, entity, id, options.applied, options.principal);
        for (const work of newer) blocked(conflict(work.where, work.version));
        if (newer.length > 0) continue;
      }
      plan.inversions.push({
        kind: "restore",
        entity,
        id,
        task: change.taskId,
        field,
        value: restore,
        prov: change.beforeProv ?? 0,
        change,
      });
      continue;
    }

    // A create: every field holds a write of the creating commits, and every live child row is
    // theirs and holds only their writes (A1 3.10).
    const created = parsed(change.after);
    if (typeof created !== "object" || created === null || Array.isArray(created)) {
      throw invalidValue("changes", "after");
    }
    let passes = true;
    for (const field of Object.keys(table.fields)) {
      if (options.creating.has(provenanceOf(row, field))) continue;
      passes = false;
      blocked(
        fieldConflict(entity, id, change.taskId, field, {
          wrote: valueIn(entity, created as Record<string, unknown>, field),
        }),
      );
    }
    for (const kid of kids.get(`${entity}|${id}`) ?? []) {
      const { child, state } = kid;
      // Another's row, or a row of the creating commits that another wrote since, keeps the
      // parent, so that a partial inversion keeps it and the row stays reachable. It is named once,
      // by its newest change (one no one changed since by its tombstone, a run by its state), with
      // that field's value now.
      const theirs = !options.creating.has(state.createdSeq);
      const written = Object.keys(child.fields).filter(
        (f) => theirs || !options.creating.has(provenanceOf(state, f)),
      );
      if (written.length === 0) continue;
      passes = false;
      const field = written.reduce(
        (newest, f) => (versionOf(state, f) > versionOf(state, newest) ? f : newest),
        written.includes(child.field) ? child.field : (written[0] ?? child.field),
      );
      blocked(
        conflict(
          {
            entity: child.entity,
            id: kid.id,
            ...(kid.task === null ? {} : { task: kid.task }),
            field,
            value: columnsValue(state.raw, child.fields[field] ?? []),
          },
          versionOf(state, field),
        ),
      );
    }
    if (!passes) continue;
    // Tombstoned already by the creating commits themselves: nothing more to invert.
    const tombstone = columnsValue(row.raw, table.fields[table.tombstone] ?? []);
    if (!isLive(tombstone)) continue;
    plan.inversions.push({
      kind: "tombstone",
      entity,
      id,
      task: change.taskId,
      field: table.tombstone,
      change,
    });
  }
  if (options.partial) keepTogether(plan, read);
  keepActiveUnwrapped(plan, read, (where, version) => {
    blocked(conflict(where, version));
  });
  return plan;
}

/**
 * A row a change names, as it is now, with its logical fields and the field that names a row
 * created since: its tombstone, or a run's state.
 */
function rowNow(
  conn: Connection,
  entity: string,
  id: string,
): { fields: Child["fields"]; field: string; row: Row | undefined } {
  if (isInvertible(entity)) {
    const table = TABLES[entity];
    return { fields: table.fields, field: table.tombstone, row: readRow(conn, entity, id)?.raw };
  }
  const child = TASK_CHILDREN.find((c) => c.entity === entity);
  if (child === undefined) throw invalidValue("changes", "entity");
  const row = conn.prepare(`SELECT * FROM ${child.entity} WHERE ${child.key} = $id`).get({ id });
  return { fields: child.fields, field: child.field, row };
}

/**
 * Others' changes to a row after commit `since`, and for a task to anything of it (the header).
 * Each field of the row itself is named once; every other row once, by its newest change: that
 * change's field (a creation sets its tombstone, or a run's state), with the field's value now. A
 * folder set by one agent and repointed by another is named once, by the second.
 */
function newerWork(
  conn: Connection,
  entity: InvertibleEntity,
  id: string,
  since: number,
  principal: Id<"ac">,
): { where: Where; version: number }[] {
  const runs = entity === "tasks" && conn.prepare(TABLE_EXISTS).get({ name: "runs" }) !== undefined;
  const found = conn.prepare(runs ? SQL.newerWorkWithRuns : SQL.newerWork).all({
    since,
    principal,
    entity,
    id,
    task: entity === "tasks" ? id : null,
  });
  const work = new Map<string, { where: Where; version: number }>();
  for (const row of found) {
    const r = new RowReader("changes", row);
    const changed = r.text("entity");
    const rowId = r.text("id");
    const task = r.optText("task", (v) => isId(v, "t")) as Id<"t"> | null;
    const now = rowNow(conn, changed, rowId);
    if (now.row === undefined) throw invalidValue("changes", "entity_id");
    const field = r.optText("field") ?? now.field;
    const version = r.int("version", "seq");
    const own = changed === entity && rowId === id;
    const key = own ? `${changed}|${rowId}|${field}` : `${changed}|${rowId}`;
    if ((work.get(key)?.version ?? 0) >= version) continue;
    work.set(key, {
      where: {
        entity: changed as ConflictEntity,
        id: rowId,
        ...(task === null ? {} : { task }),
        field,
        value: columnsValue(now.row, now.fields[field] ?? []),
      },
      version,
    });
  }
  return [...work.values()];
}

/** A step an undo or a redo could not take whole: what it last applied, and what held it back. */
export interface Held {
  /** PlanOptions.applied: others' changes after it are newer work. */
  readonly since: number;
  readonly conflicts: readonly FieldConflict[];
}

/**
 * Who changed which task since (WriteResult.newer): for each task a held step's conflicts name,
 * every author of a change to it or to what belongs to it after the step was last applied, with the
 * time of that author's newest change there; a row of no task (an area, a project, a source) by
 * its own changes. The conflicts' own authors are named too: a key another row took counts. The
 * principal's own steps (its undoable writes, undos and redos) are no one's newer work: they hold
 * a redo back only after an earlier step of the person's was passed over, and that step's
 * conflicts say why. A run's own progress is the run's, whichever credential wrote it.
 */
export function newerWorkOf(
  conn: Connection,
  held: readonly Held[],
  principal: Id<"ac">,
): NewerWork {
  const conflicts = held.flatMap((h) => h.conflicts);
  const own = new Set(
    conn
      .prepare(SQL.ownSteps)
      .all({ seqs: JSON.stringify([...new Set(conflicts.map((c) => c.version))]), principal })
      .map((row) => new RowReader("commits", row).int("seq", "seq")),
  );
  const work = new Map<string, NewerWork["work"][number]>();
  const named = (
    where: { task?: Id<"t">; ref?: string },
    by: FieldConflict["by"],
    run: boolean,
    at: number,
  ): void => {
    const key = `${where.task ?? ""}|${newerBy(by, run)}`;
    const entry = work.get(key);
    if (entry !== undefined && entry.at >= at) return;
    work.set(key, {
      ...(where.task === undefined ? {} : { task: where.task }),
      ...(where.ref === undefined ? {} : { ref: where.ref }),
      by,
      run,
      at,
    });
  };
  const runs = conn.prepare(TABLE_EXISTS).get({ name: "runs" }) !== undefined;
  for (const { since, conflicts: theirs } of held) {
    const asked = new Set<string>();
    for (const c of theirs) {
      if (!own.has(c.version)) named(c, c.by, c.entity === "runs", c.at);
      const scope =
        c.task === undefined
          ? { entity: c.entity, id: c.id, task: null }
          : { entity: "tasks", id: c.task, task: c.task };
      const key = `${scope.entity}|${scope.id}`;
      if (asked.has(key)) continue;
      asked.add(key);
      const sql = runs && scope.task !== null ? SQL.newerAuthorsWithRuns : SQL.newerAuthors;
      for (const row of conn.prepare(sql).all({ since, principal, ...scope })) {
        const r = new RowReader("commits", row);
        named(
          c.task === undefined
            ? {}
            : { task: c.task, ...(c.ref === undefined ? {} : { ref: c.ref }) },
          {
            actor: r.id("actor", "ac"),
            kind: r.text("kind"),
            label: r.text("label"),
            origin: r.text("origin"),
          },
          r.int("run", "count") === 1,
          r.int("at", "instant"),
        );
      }
    }
  }
  return { work: [...work.values()] };
}

/** Whether a tombstone field's value says the row is live: every column null. */
function isLive(value: unknown): boolean {
  if (value === null) return true;
  return (
    typeof value === "object" &&
    Object.values(value as Record<string, unknown>).every((v) => v === null)
  );
}

/** The live row that holds the unique key a restored source or place would take, if any. */
function takenBy(
  conn: Connection,
  entity: InvertibleEntity,
  row: RowState,
): { id: string; task: Id<"t"> | null; row: Row } | undefined {
  const raw = row.raw;
  let found: Row | undefined;
  if (entity === "sources") {
    const key = raw["source_key"];
    if (typeof key !== "string") return undefined;
    found = conn.prepare(SQL.sourceTaken).get({ key, id: raw["id"] as string });
  } else if (entity === "places") {
    found = conn.prepare(SQL.placeTaken).get({
      kind: raw["owner_kind"] as string,
      owner: raw["owner_id"] as string,
      machine: raw["machine_id"] as string,
      id: raw["id"] as string,
    });
  } else if (entity === "areas" || entity === "projects") {
    // A slug is unique among live areas, and among live projects (A1 3.3).
    found = conn
      .prepare(entity === "areas" ? SQL.areaTaken : SQL.projectTaken)
      .get({ slug: raw["slug"] as string, id: raw["id"] as string });
  } else if (entity === "folders") {
    // One live folder per owner and machine. Two live projects on one folder is a rule across
    // rows, decided on the state the inversion makes (applyInversions).
    found = conn.prepare(SQL.folderTaken).get({
      kind: raw["owner_kind"] as string,
      owner: raw["owner_id"] as string,
      machine: raw["machine_id"] as string,
      id: raw["id"] as string,
    });
  }
  if (found === undefined) return undefined;
  const r = new RowReader(entity, found);
  const owner = found["owner_kind"] === "task" ? r.id("owner_id", "t") : null;
  return { id: r.text("id"), task: owner, row: found };
}

const PAIR: Readonly<Record<string, string>> = { lifecycle: "wrap", wrap: "lifecycle" };

/**
 * A partial inversion leaves a task's lifecycle and wrap-up together: a restore of one whose
 * partner conflicts stays too, as a conflict named with the partner's write (the header).
 */
function keepTogether(
  plan: InversionPlan,
  read: (entity: InvertibleEntity, id: string) => RowState,
): void {
  const blocking = new Map<string, FieldConflict>();
  for (const c of plan.conflicts) {
    if (c.entity === "tasks" && PAIR[c.field] !== undefined) blocking.set(`${c.id}|${c.field}`, c);
  }
  plan.inversions = plan.inversions.filter((inversion) => {
    const partner = PAIR[inversion.field];
    if (inversion.kind !== "restore" || inversion.entity !== "tasks" || partner === undefined) {
      return true;
    }
    const held = blocking.get(`${inversion.id}|${partner}`);
    if (held === undefined) return true;
    const row = read("tasks", inversion.id);
    plan.conflicts.push({
      ...held,
      field: inversion.field,
      value: columnsValue(row.raw, TABLES.tasks.fields[inversion.field] ?? []),
      wrote: parsed(inversion.change.after),
      restore: parsed(inversion.value),
    });
    return false;
  });
}

/** A column of a lifecycle or wrap value, as `changes` holds the field. */
function columnOf(json: string, column: string): unknown {
  const value = parsed(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidValue("changes", "after");
  }
  return (value as Record<string, unknown>)[column] ?? null;
}

/**
 * No inversion leaves a task active with a wrap state (the row CHECK), in a full inversion or a
 * partial one. Its lifecycle and wrap-up can come from different commits: an archive writes the
 * lifecycle alone and a later wrap-up the wrap alone, so undoing the archive would make the task
 * active under that wrap-up. Each of the two the plan would set back is then a conflict, named
 * with the write that holds its partner (unless that partner is a conflict already: the refusal
 * names it), and the plan sets back neither. A refusal here, rather than a failed UPDATE, keeps
 * the request decided: a storage error would leave the change on top of the stack for good.
 */
function keepActiveUnwrapped(
  plan: InversionPlan,
  read: (entity: InvertibleEntity, id: string) => RowState,
  name: (where: Where, version: number) => void,
): void {
  const planned = new Map<string, Restore[]>();
  for (const inversion of plan.inversions) {
    if (inversion.kind !== "restore" || inversion.entity !== "tasks") continue;
    if (PAIR[inversion.field] === undefined) continue;
    const list = planned.get(inversion.id);
    if (list === undefined) planned.set(inversion.id, [inversion]);
    else list.push(inversion);
  }
  const unsafe = new Set<string>();
  for (const [id, restores] of planned) {
    const row = read("tasks", id);
    const lifecycle = restores.find((r) => r.field === "lifecycle");
    const wrap = restores.find((r) => r.field === "wrap");
    const state =
      lifecycle === undefined ? row.raw["lifecycle"] : columnOf(lifecycle.value, "lifecycle");
    const wrapState =
      wrap === undefined ? (row.raw["wrap_state"] ?? null) : columnOf(wrap.value, "wrap_state");
    if (state !== "active" || wrapState === null) continue;
    unsafe.add(id);
    for (const restore of restores) {
      const partner = PAIR[restore.field] ?? restore.field;
      const named = plan.conflicts.some(
        (c) => c.entity === "tasks" && c.id === id && c.field === partner,
      );
      if (named) continue;
      const holder = restores.some((r) => r.field === partner) ? restore.field : partner;
      name(
        {
          entity: "tasks",
          id,
          ...(restore.task === null ? {} : { task: restore.task }),
          field: restore.field,
          value: columnsValue(row.raw, TABLES.tasks.fields[restore.field] ?? []),
          wrote: parsed(restore.change.after),
          restore: parsed(restore.value),
        },
        versionOf(row, holder),
      );
    }
  }
  if (unsafe.size === 0) return;
  plan.inversions = plan.inversions.filter(
    (i) =>
      !(
        i.kind === "restore" &&
        i.entity === "tasks" &&
        PAIR[i.field] !== undefined &&
        unsafe.has(i.id)
      ),
  );
}

// ---------------------------------------------------------------------------------------------
// Applying

/** One change row an inversion writes (A1 3.10): its provenance on both sides. */
export interface InvertedChange {
  op: number;
  entity: InvertibleEntity;
  entityId: string;
  taskId: Id<"t"> | null;
  field: string;
  before: string;
  after: string;
  beforeVer: number;
  beforeProv: number;
  afterProv: number;
}

function readRow(conn: Connection, entity: InvertibleEntity, id: string): RowState | undefined {
  const table = TABLES[entity];
  const row = conn.prepare(`SELECT * FROM ${entity} WHERE ${table.where}`).get(keyOf(entity, id));
  return row === undefined ? undefined : rowState(entity, row, table.fields);
}

/** `UPDATE <entity> SET <columns> WHERE <its key>`, for the columns of its fields only. */
function updateSql(entity: InvertibleEntity, columns: readonly string[]): string {
  const known = new Set<string>(Object.values(TABLES[entity].fields).flat());
  if (columns.length === 0 || columns.some((c) => !known.has(c))) {
    throw misuse("An inversion names only the columns of its fields");
  }
  const set = columns.map((c) => `${c} = $${c}`).join(", ");
  return `UPDATE ${entity} SET ${set} WHERE ${TABLES[entity].where}`;
}

function versionsSql(entity: InvertibleEntity): string {
  const touched = entity === "tasks" ? ", touched = $seq" : "";
  return (
    `UPDATE ${entity} SET version = $seq${touched}, fv = $fv, fp = $fp ` +
    `WHERE ${TABLES[entity].where}`
  );
}

/** A field's value as `changes` holds it, as the values of its columns. */
function columnValues(columns: readonly string[], json: string): Record<string, SqlValue> {
  const value = parsed(json);
  const sql = (v: unknown): SqlValue => {
    if (v === null || typeof v === "string" || inRange(v, "instant")) return v;
    throw invalidValue("changes", "before");
  };
  if (columns.length === 1) return { [columns[0] ?? ""]: sql(value) };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidValue("changes", "before");
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(columns.map((c) => [c, sql(record[c] ?? null)]));
}

/** A tombstone's value: when, and for a task who (A1 3.4 `deleted_at`, `deleted_by`). */
function tombstoneJson(entity: InvertibleEntity, at: number, principal: Id<"ac">): string {
  return entity === "tasks" ? fieldJson({ deleted_at: at, deleted_by: principal }) : fieldJson(at);
}

/** The commit an inversion writes, and how its conflicts are named. */
export interface ApplyOptions {
  seq: number;
  at: number;
  principal: Id<"ac">;
  /** The request's operation index the conflicts name. */
  op: number;
  /** The space's reference prefix, for the conflicts' task references. */
  refPrefix: string;
  /** A partial inversion applies what the rules across rows leave; a full one then nothing. */
  partial: boolean;
  /** A redo's: no row it writes, and no owner of one, is out of sight after it (ownersLive). */
  owners: boolean;
}

/** What an inversion wrote: its change rows, in the plan's order, and the tasks it touched. */
export interface Applied {
  changes: InvertedChange[];
  tasks: Set<Id<"t">>;
}

/**
 * Applies `plan` as commit `seq` (A1 3.10), and decides the rules that span rows on the state it
 * made. The guards before it (planInversions) are decided on the state before the plan, which is
 * exact for the fields of one row and for the unique keys; a rule across rows is not, because what
 * the plan makes of it depends on every row it brings back at once.
 *
 * A **restore** is an inversion that clears a tombstone. Two rules count restores, each read in
 * one statement after the plan applies:
 * - **One active holder of a source key** (A1 3.6). The statement reads the active holders of every
 *   keyed source the plan brought back, linked again, or that a task it brought back links to. A
 *   key is **broken** when it has two or more active holders and the plan restored the key's
 *   source, or the task or the link of one of them. A holder whose task, link and source were all
 *   live before the plan **stands**: a key whose active holders all stand was double before the
 *   plan, or became so by a lifecycle the plan set back (not a restore: it repeats a complete or a
 *   reopen, which dedupe does not guard either), and is not the plan's doing. On a broken key none
 *   of the plan's restores of its holders and its source applies. The conflict names each standing
 *   holder's link, with who created or revived it; when every holder is one the plan brings back,
 *   none of them comes back, and the conflict names each one's lifecycle, with who made it active.
 * - **At most 20 live learnings a task** (A1 3.11.2). The statement counts the live learnings of
 *   every task the plan brought a learning back to. A task over the limit gets none of them back,
 *   and the conflict names each live learning the plan did not bring back, with who wrote it.
 *
 * - **Two live projects never share one folder on one machine.** The statement reads the live
 *   project folders of every machine whose folder the plan brought back or set back. A folder of
 *   the plan's that another live project's folder holds by the machine's case rule does not come
 *   back, and the conflict names that other folder's path, with who set it.
 * - **A project and what is in it** (groupRules): a deleted project holds no live task and no live
 *   folder, and a task in a project is in that project's area.
 * - **A redo writes nothing out of sight** (ownersLive, with `owners`).
 *
 * When a rule breaks, the writes roll back to a savepoint, the conflicts are named on the state
 * before the plan, and a partial inversion applies the rest, checked again, since a folder left
 * where it is can meet another the plan moves. A full inversion then applies nothing and returns
 * undefined, and `plan.conflicts` says why.
 */
export function applyInversions(
  conn: Connection,
  plan: InversionPlan,
  options: ApplyOptions,
): Applied | undefined {
  const checked = (inversions: readonly Inversion[]): boolean =>
    (options.owners && inversions.length > 0) ||
    restoresOf(inversions).size > 0 ||
    inversions.some(inGroupRules);
  if (!checked(plan.inversions)) return writeInversions(conn, plan.inversions, options);
  const since = plan.applied;
  const refOf = refsOf(conn, options.refPrefix);
  for (;;) {
    conn.exec("SAVEPOINT restores");
    const applied = writeInversions(conn, plan.inversions, options);
    const restores = restoresOf(plan.inversions);
    const broken: Broken = { undone: new Set(), named: [] };
    brokenKeys(conn, restores, broken);
    tooManyLearnings(conn, restores, broken);
    sharedFolders(conn, plan.inversions, broken);
    groupRules(conn, plan.inversions, broken, { seq: options.seq, since });
    if (options.owners) ownersLive(conn, plan.inversions, broken, since);
    if (broken.undone.size === 0) {
      conn.exec("RELEASE restores");
      return applied;
    }
    conn.exec("ROLLBACK TO restores");
    const conflict = namer(conn, options, refOf);
    const named = new Set(plan.conflicts.map((c) => `${c.entity}|${c.id}|${c.field}`));
    for (const n of broken.named) {
      if (named.has(`${n.entity}|${n.id}|${n.field}`)) continue;
      named.add(`${n.entity}|${n.id}|${n.field}`);
      const row = readRow(conn, n.entity, n.id);
      if (row === undefined) throw misuse("A row the plan read has gone");
      plan.conflicts.push(
        conflict(
          {
            entity: n.entity,
            id: n.id,
            ...(n.task === null ? {} : { task: n.task }),
            field: n.field,
            value: valueIn(n.entity, row.raw, n.field),
          },
          versionOf(row, n.field),
        ),
      );
    }
    plan.inversions = plan.inversions.filter((i) => !broken.undone.has(i));
    conn.exec("RELEASE restores");
    if (!options.partial) return undefined;
    if (!checked(plan.inversions)) return writeInversions(conn, plan.inversions, options);
  }
}

/**
 * Two live projects on one folder of one machine (applyInversions): each folder row the plan wrote
 * that is now a live project's live folder, compared with every other live project folder of its
 * machine by that machine's case rule. On a clash the plan's inversions of that row stay undone,
 * and the other row is named by its path.
 */
function sharedFolders(conn: Connection, inversions: readonly Inversion[], broken: Broken): void {
  const mine = new Map<string, Inversion[]>();
  const add = (id: string, inversion: Inversion): void => {
    const list = mine.get(id);
    if (list === undefined) mine.set(id, [inversion]);
    else list.push(inversion);
  };
  for (const i of inversions) {
    if (i.entity === "folders") add(i.id, i);
    // A project brought back brings its live folders back into the rule.
    if (i.entity === "projects" && i.field === "deleted") {
      for (const row of conn.prepare(SQL.liveFoldersOfProject).all({ id: i.id })) {
        add(String(row["id"]), i);
      }
    }
  }
  if (mine.size === 0) return;
  const machines = new Map<string, { os: FolderOs; rows: FolderRow[] }>();
  const machineRows = (machine: string) => {
    let found = machines.get(machine);
    if (found === undefined) {
      const os = machineOs(conn, machine);
      if (os === undefined) throw invalidValue("folders", "machine_id");
      found = {
        os,
        rows: conn.prepare(FOLDER_SQL.liveProjectFolders).all({ machine }).map(decodeFolder),
      };
      machines.set(machine, found);
    }
    return found;
  };
  for (const [id, made] of mine) {
    const row = conn.prepare(FOLDER_SQL.folder).get({ id });
    if (row === undefined) throw misuse("A folder the plan wrote has gone");
    const folder = decodeFolder(row);
    if (folder.deleted || folder.ownerKind !== "project") continue;
    // A deleted project's folder holds no folder from anyone (groupRules keeps it from staying).
    if (conn.prepare(SQL.liveProject).get({ id: folder.ownerId }) === undefined) continue;
    const { os, rows } = machineRows(folder.machineId);
    const key = folderKey(folder.path, os);
    const other = rows.find(
      (r) => r.id !== folder.id && r.ownerId !== folder.ownerId && folderKey(r.path, os) === key,
    );
    if (other === undefined) continue;
    // The folder's own inversions stay undone, and a project's restore comes back without it. A
    // folder that is live already keeps the project from coming back.
    const own = made.filter((i) => i.entity === "folders");
    for (const i of own.length > 0 ? own : made) broken.undone.add(i);
    broken.named.push({ entity: "folders", id: other.id, task: null, field: "path" });
  }
}

/** The inversions the group rules (groupRules) look at. */
const inGroupRules = (i: Inversion): boolean =>
  i.entity === "projects" ||
  i.entity === "folders" ||
  (i.entity === "tasks" && (i.field === "deleted" || i.field === "grouping"));

/** The rows a write touched that the group rules look at, by ID. */
export interface GroupTouch {
  readonly projects: readonly string[];
  readonly tasks: readonly string[];
  readonly folders: readonly string[];
  /** The projects whose area the write set, and the tasks whose project or area it set. */
  readonly moved: readonly string[];
  readonly regrouped: readonly string[];
}

/**
 * Where a project and what is in it break their rules after a write: a deleted project that holds
 * a live task or a live folder (`held`), or a task whose area is not its project's (`stray`).
 */
export interface GroupBreak {
  readonly rule: "held" | "stray";
  readonly project: string;
  readonly child: { readonly entity: "tasks" | "folders"; readonly id: string };
}

/**
 * The group rules on the state a write made, for the projects it touched, the projects of the
 * tasks and folders it touched, and the tasks it moved: a deleted project holds no live task and no
 * live folder, and a task in a project is in that project's area. Also the project each touched
 * task is in now.
 */
export function groupBreaks(
  conn: Connection,
  touch: GroupTouch,
): { breaks: GroupBreak[]; projectOf: Map<string, string> } {
  const folders = hasFolders(conn) ? touch.folders : [];
  const projectOf = new Map(
    conn
      .prepare(SQL.projectsOfTasks)
      .all({ tasks: JSON.stringify(touch.tasks) })
      .map((row) => [String(row["id"]), String(row["project"])]),
  );
  const projects = [
    ...new Set([
      ...touch.projects,
      ...projectOf.values(),
      ...(folders.length === 0
        ? []
        : conn
            .prepare(SQL.ownersOfFolders)
            .all({ folders: JSON.stringify(folders) })
            .map((row) => String(row["project"]))),
    ]),
  ];
  const breaks: GroupBreak[] = [];
  const held = (entity: "tasks" | "folders", sql: string): void => {
    for (const row of conn.prepare(sql).all({ projects: JSON.stringify(projects) })) {
      breaks.push({
        rule: "held",
        project: String(row["project"]),
        child: { entity, id: String(row["id"]) },
      });
    }
  };
  if (projects.length > 0) {
    held("tasks", SQL.liveTasksOfDeleted);
    if (hasFolders(conn)) held("folders", SQL.liveFoldersOfDeleted);
  }
  if (touch.moved.length > 0 || touch.regrouped.length > 0) {
    const stray = conn.prepare(SQL.outOfArea).all({
      tasks: JSON.stringify(touch.regrouped),
      projects: JSON.stringify(touch.moved),
    });
    for (const row of stray) {
      breaks.push({
        rule: "stray",
        project: String(row["project"]),
        child: { entity: "tasks", id: String(row["id"]) },
      });
    }
  }
  return { breaks, projectOf };
}

/** Whether `found` holds between the rows `rowOf` gives (groupBreaks' statements, on any state). */
export function brokenIn(
  found: GroupBreak,
  rowOf: (entity: "projects" | "tasks" | "folders", id: string) => Row | undefined,
): boolean {
  const project = rowOf("projects", found.project);
  const child = rowOf(found.child.entity, found.child.id);
  if (project === undefined || child === undefined) return false;
  if (found.rule === "stray") {
    return child["project_id"] === found.project && child["area_id"] !== project["area_id"];
  }
  const inside =
    found.child.entity === "tasks"
      ? child["project_id"] === found.project
      : child["owner_kind"] === "project" && child["owner_id"] === found.project;
  return inside && project["deleted_at"] !== null && child["deleted_at"] === null;
}

/**
 * The group rules (groupBreaks) on the state the plan makes (applyInversions). When the plan
 * breaks one, its inversions on its own side stay undone: a project's tombstone or move together
 * with its folders' tombstones and its tasks' moves, or the task or folder it would bring into a
 * deleted project. The other side is named, with who wrote it: for a task, who put it into the
 * project.
 *
 * A break whose every side the plan set back (`seq`) or is older than the step's latest
 * application (`since`) is as it was before it: the plan brings back what a person had, also a
 * break that an earlier version let in. Only a side written since by another makes it the plan's.
 */
function groupRules(
  conn: Connection,
  inversions: readonly Inversion[],
  broken: Broken,
  { seq, since }: { seq: number; since: number },
): void {
  const mine = new Map<string, Inversion[]>();
  for (const i of inversions) {
    if (!inGroupRules(i)) continue;
    const key = `${i.entity}|${i.id}`;
    const list = mine.get(key);
    if (list === undefined) mine.set(key, [i]);
    else list.push(i);
  }
  if (mine.size === 0) return;
  const of = (entity: InvertibleEntity, id: string, field?: string): Inversion[] =>
    (mine.get(`${entity}|${id}`) ?? []).filter((i) => field === undefined || i.field === field);
  const ids = (entity: InvertibleEntity, field?: string): string[] =>
    [...mine.keys()]
      .filter((k) => k.startsWith(`${entity}|`))
      .map((k) => k.slice(entity.length + 1))
      .filter((id) => of(entity, id, field).length > 0);
  const regrouped = ids("tasks", "grouping");
  const { breaks, projectOf } = groupBreaks(conn, {
    projects: ids("projects"),
    tasks: ids("tasks"),
    folders: ids("folders"),
    moved: ids("projects", "grouping"),
    regrouped,
  });
  const undo = (list: readonly Inversion[]): void => {
    for (const i of list) broken.undone.add(i);
  };
  /** A project's own side: its tombstone with its folders', or its move with its tasks'. */
  const projectSide = (project: string, field: "deleted" | "grouping"): Inversion[] => {
    const own = of("projects", project, field);
    if (own.length === 0) return own;
    if (field === "grouping") {
      return [
        ...own,
        ...regrouped
          .filter((t) => projectOf.get(t) === project)
          .flatMap((t) => of("tasks", t, "grouping")),
      ];
    }
    const theirs = conn
      .prepare(FOLDER_SQL.allOfOwner)
      .all({ kind: "project", owner: project })
      .flatMap((row) => of("folders", String(row["id"]), "deleted"));
    return [...own, ...theirs];
  };
  const asBefore = ([entity, id, field]: readonly [InvertibleEntity, string, string]): boolean => {
    const row = readRow(conn, entity, id);
    if (row === undefined) throw misuse("A row the plan read has gone");
    const version = versionOf(row, field);
    return version === seq || version < since;
  };
  const sides = ({ rule, project, child }: GroupBreak) =>
    rule === "stray"
      ? ([
          ["projects", project, "grouping"],
          ["tasks", child.id, "grouping"],
        ] as const)
      : ([
          ["projects", project, "deleted"],
          [child.entity, child.id, "deleted"],
          ...(child.entity === "tasks" ? ([["tasks", child.id, "grouping"]] as const) : []),
        ] as const);
  for (const found of breaks) {
    if (sides(found).every(asBefore)) continue;
    const { rule, project, child } = found;
    const task = child.entity === "tasks" ? (child.id as Id<"t">) : null;
    const side = projectSide(project, rule === "held" ? "deleted" : "grouping");
    const brought =
      rule === "held" ? of(child.entity, child.id) : of("tasks", child.id, "grouping");
    if (side.length > 0) {
      undo(side);
      const field = child.entity === "tasks" ? "grouping" : "deleted";
      broken.named.push({ entity: child.entity, id: child.id, task, field });
    } else if (brought.length > 0) {
      undo(brought);
      const field = rule === "held" ? "deleted" : "grouping";
      broken.named.push({ entity: "projects", id: project, task: null, field });
    }
  }
}

/** The rows that own a row (A1 3.4): a child's task, a link's source, a group's area, a folder's owner. */
function ownersOf(entity: InvertibleEntity, raw: Row): { entity: InvertibleEntity; id: string }[] {
  const of = (owner: InvertibleEntity, id: unknown) =>
    typeof id === "string" ? [{ entity: owner, id }] : [];
  switch (entity) {
    case "tasks":
      return [...of("areas", raw["area_id"]), ...of("projects", raw["project_id"])];
    case "projects":
      return of("areas", raw["area_id"]);
    case "notes":
    case "log_entries":
    case "learnings":
      return of("tasks", raw["task_id"]);
    case "task_sources":
      return [...of("tasks", raw["task_id"]), ...of("sources", raw["source_id"])];
    case "places":
    case "folders": {
      const kind = raw["owner_kind"];
      const owner = kind === "task" ? "tasks" : kind === "area" ? "areas" : "projects";
      return of(owner, raw["owner_id"]);
    }
    case "sources":
    case "areas":
      return [];
  }
}

/**
 * A redo writes nothing out of sight (applyInversions). It never brings back a row whose owner is
 * not there: a note of a task that is not there, a link to a source in the Trash, a project of an
 * area that is not there. And it never writes a row, or under an owner, that went out of sight
 * after the step was undone (`since`): a step before it passed over, or another's removal, took it
 * away. A row out of sight before that stays as the step and its undo wrote it: a project's move
 * also sets the area of its tasks in the Trash. Each row the plan writes is checked on the state
 * the plan made, unless the plan takes the row away itself; one that fails keeps the plan's writes
 * of it undone, and the row or its owner is named by its tombstone, with who took it away.
 */
function ownersLive(
  conn: Connection,
  inversions: readonly Inversion[],
  broken: Broken,
  since: number,
): void {
  const rows = new Map<string, Inversion[]>();
  for (const i of inversions) {
    const key = `${i.entity}|${i.id}`;
    const list = rows.get(key);
    if (list === undefined) rows.set(key, [i]);
    else list.push(i);
  }
  for (const list of rows.values()) {
    const first = list[0];
    if (first === undefined) continue;
    const { entity, id } = first;
    const tombstone = TABLES[entity].tombstone;
    const writes = list.filter((i) => i.field === tombstone);
    if (writes.some((i) => i.kind === "tombstone" || !isLive(parsed(i.value)))) continue;
    const back = writes.length > 0;
    const row = readRow(conn, entity, id);
    if (row === undefined) throw misuse("A row the plan wrote has gone");
    /** Out of sight now: for good when a row comes back under it, else when taken away since. */
    const gone = (state: RowState, of: InvertibleEntity, owner: boolean): boolean => {
      const field = TABLES[of].tombstone;
      if (isLive(valueIn(of, state.raw, field))) return false;
      return (back && owner) || versionOf(state, field) > since;
    };
    const named: Broken["named"] = [];
    if (gone(row, entity, false)) named.push({ entity, id, task: first.task, field: tombstone });
    for (const owner of ownersOf(entity, row.raw)) {
      const found = readRow(conn, owner.entity, owner.id);
      if (found === undefined) throw invalidValue(entity, "owner");
      if (!gone(found, owner.entity, true)) continue;
      const task = owner.entity === "tasks" ? (owner.id as Id<"t">) : null;
      named.push({
        entity: owner.entity,
        id: owner.id,
        task,
        field: TABLES[owner.entity].tombstone,
      });
    }
    if (named.length === 0) continue;
    for (const i of list) broken.undone.add(i);
    broken.named.push(...named);
  }
}

/** The entities whose restores a rule across rows counts. */
const COUNTED = new Set<InvertibleEntity>(["tasks", "task_sources", "sources", "learnings"]);

/** A plan's restores, by `<entity>|<id>`: the inversions that clear a counted row's tombstone. */
function restoresOf(inversions: readonly Inversion[]): Map<string, Inversion> {
  const restores = new Map<string, Inversion>();
  for (const i of inversions) {
    if (i.kind !== "restore" || i.field !== TABLES[i.entity].tombstone) continue;
    if (COUNTED.has(i.entity) && isLive(parsed(i.value))) restores.set(`${i.entity}|${i.id}`, i);
  }
  return restores;
}

/** What the rules across rows found: the restores that stay undone, and the rows that block them. */
interface Broken {
  undone: Set<Inversion>;
  /**
   * A standing holder's link, a holder's lifecycle, a live learning, another's folder, a project
   * and what is in it, or a row or owner out of sight.
   */
  named: {
    entity: InvertibleEntity;
    id: string;
    task: Id<"t"> | null;
    field: string;
  }[];
}

/** One active holder of a source key (applyInversions), in key order, then reference order. */
function brokenKeys(conn: Connection, restores: ReadonlyMap<string, Inversion>, broken: Broken) {
  const tasks: string[] = [];
  const sources = new Set<string>();
  for (const i of restores.values()) {
    if (i.entity === "tasks") tasks.push(i.id);
    else if (i.entity === "sources") sources.add(i.id);
    else if (i.entity === "task_sources") sources.add(keyOf("task_sources", i.id)["source"] ?? "");
  }
  if (tasks.length === 0 && sources.size === 0) return;
  /** Each touched key's active holders, by its live source: one live source per key. */
  const holders = new Map<string, Id<"t">[]>();
  for (const row of conn.prepare(SQL.activeHolders).all({
    tasks: JSON.stringify(tasks),
    sources: JSON.stringify([...sources]),
  })) {
    const r = new RowReader("task_sources", row);
    const source = r.text("source_id");
    const list = holders.get(source);
    if (list === undefined) holders.set(source, [r.id("task_id", "t")]);
    else list.push(r.id("task_id", "t"));
  }
  for (const [source, active] of holders) {
    if (active.length < 2) continue;
    /** The restores that make each holder one: its task's, its link's. */
    const made = active.map((task) =>
      [restores.get(`tasks|${task}`), restores.get(`task_sources|${task}|${source}`)].filter(
        (i): i is Inversion => i !== undefined,
      ),
    );
    const sourceBack = restores.get(`sources|${source}`);
    if (sourceBack === undefined && made.every((m) => m.length === 0)) continue;
    if (sourceBack !== undefined) broken.undone.add(sourceBack);
    for (const m of made) for (const i of m) broken.undone.add(i);
    const standing = active.filter((_, k) => made[k]?.length === 0);
    for (const task of standing) {
      broken.named.push({
        entity: "task_sources",
        id: `${task}|${source}`,
        task,
        field: "removed",
      });
    }
    if (standing.length > 0) continue;
    for (const task of active) {
      broken.named.push({ entity: "tasks", id: task, task, field: "lifecycle" });
    }
  }
}

/** At most 20 live learnings a task (applyInversions), in task order, then position order. */
function tooManyLearnings(
  conn: Connection,
  restores: ReadonlyMap<string, Inversion>,
  broken: Broken,
): void {
  /** The learnings the plan brings back, by their task. */
  const back = new Map<Id<"t">, Inversion[]>();
  for (const i of restores.values()) {
    if (i.entity !== "learnings" || i.task === null) continue;
    const list = back.get(i.task);
    if (list === undefined) back.set(i.task, [i]);
    else list.push(i);
  }
  if (back.size === 0) return;
  const live = new Map<string, string[]>();
  for (const row of conn
    .prepare(SQL.liveLearnings)
    .all({ tasks: JSON.stringify([...back.keys()]) })) {
    const r = new RowReader("learnings", row);
    const task = r.text("task_id");
    const list = live.get(task);
    if (list === undefined) live.set(task, [r.text("id")]);
    else list.push(r.text("id"));
  }
  for (const [task, restored] of back) {
    const ids = live.get(task) ?? [];
    if (ids.length <= WRITE_LIMITS.learnings) continue;
    for (const i of restored) broken.undone.add(i);
    const mine = new Set(restored.map((i) => i.id));
    for (const id of ids) {
      if (!mine.has(id)) broken.named.push({ entity: "learnings", id, task, field: "deleted" });
    }
  }
}

/**
 * Writes `inversions` as commit `seq`: one UPDATE per row with every field it sets (the task
 * CHECKs hold only on the whole row), its version, `fv` and `fp`, and the touched mark of each task
 * whose row or child row changed. Returns the change rows to insert, in the plan's order, and the
 * tasks it touched.
 */
function writeInversions(
  conn: Connection,
  inversions: readonly Inversion[],
  commit: { seq: number; at: number; principal: Id<"ac">; op: number },
): Applied {
  const groups = new Map<string, Inversion[]>();
  for (const inversion of inversions) {
    const key = `${inversion.entity}|${inversion.id}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [inversion]);
    else group.push(inversion);
  }
  const changes: InvertedChange[] = [];
  const tasks = new Set<Id<"t">>();
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) throw misuse("An inversion group is never empty");
    const { entity, id } = first;
    const row = readRow(conn, entity, id);
    if (row === undefined) throw misuse("A row the plan inverts has gone");
    const table = TABLES[entity];
    const values: Record<string, SqlValue> = {};
    const fv = { ...row.fv };
    const fp = { ...row.fp };
    for (const inversion of group) {
      const { field } = inversion;
      if (!hasField(entity, field)) {
        throw misuse("An inversion names a field its row does not have");
      }
      const before = fieldJson(valueIn(entity, row.raw, field));
      const after =
        inversion.kind === "restore"
          ? inversion.value
          : tombstoneJson(entity, commit.at, commit.principal);
      // The guard found the write the inverted row made; its value is never the one restored.
      if (before === after) {
        throw new StorageError("SPACE_INVALID", "A field does not hold the write it names");
      }
      Object.assign(values, columnValues(table.fields[field] ?? [], after));
      const prov = inversion.kind === "restore" ? inversion.prov : commit.seq;
      changes.push({
        op: commit.op,
        entity,
        entityId: id,
        taskId: inversion.task,
        field,
        before,
        after,
        beforeVer: versionOf(row, field),
        beforeProv: provenanceOf(row, field),
        afterProv: prov,
      });
      fv[field] = commit.seq;
      fp[field] = prov;
      if (inversion.task !== null) tasks.add(inversion.task);
    }
    const key = keyOf(entity, id);
    conn.prepare(updateSql(entity, Object.keys(values))).run({ ...values, ...key });
    conn
      .prepare(versionsSql(entity))
      .run({ seq: commit.seq, fv: JSON.stringify(fv), fp: JSON.stringify(fp), ...key });
  }
  // A child row's change touches its task, which keeps its own version (A1 3.5).
  for (const task of tasks) conn.prepare(SQL.touched).run({ id: task, seq: commit.seq });
  return { changes, tasks };
}
