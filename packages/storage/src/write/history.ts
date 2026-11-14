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
//   attachments, source links, label links and places; a source's links) was created by them. The
//   tombstone is a write of its own (after_prov is the inverting commit), so a redo clears it
//   under that guard.
// - Clearing a tombstone (a redo of a create's undo, or the undo of a delete) brings a row back. A
//   source whose key, or a place whose owner and machine, another live row holds now stays
//   tombstoned, and that row is the conflict: the unique indexes allow one live row each. A task
//   or a link that would make an active task hold a source key another active task holds stays
//   too, and that task's link is the conflict: dedupe never makes two active tasks for one item.
// - Launch, session, run and machine records are never inverted (A1 3.6, 3.10.3).
//
// A task's lifecycle and wrap-up obey one CHECK (an active task has no wrap state). An inversion of
// both, where both pass, restores a state the task had; a partial one could split them, so with
// `partial` the two stay together: when one conflicts, the other stays too, named with the write
// that holds its partner.
//
// Every statement is built from the constant table, column and field names below and in
// fields.ts, with values bound as parameters (A1 3.7).
import type { Connection, Row, SqlValue } from "../driver.ts";
import { misuse, StorageError } from "../errors.ts";
import { isId, type Id } from "../ids.ts";
import { formatTaskRef } from "../refs.ts";
import { inRange, invalidValue, RowReader } from "../rows.ts";
import { CHILD_FIELDS, columnsValue, fieldJson, TASK_FIELDS } from "./fields.ts";
import { RequestProblem, type ConflictEntity, type FieldConflict } from "./request.ts";
import { provenanceOf, rowState, versionOf, type RowState } from "./row-state.ts";

/** The tables whose rows an inversion writes. */
export type InvertibleEntity =
  "tasks" | "notes" | "log_entries" | "sources" | "task_sources" | "places";

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
  sources: { fields: CHILD_FIELDS.sources, tombstone: "deleted", where: BY_ID },
  task_sources: {
    fields: CHILD_FIELDS.task_sources,
    tombstone: "removed",
    where: "task_id = $task AND source_id = $source",
  },
  places: { fields: CHILD_FIELDS.places, tombstone: "deleted", where: BY_ID },
};

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
  /** Its tombstone field and that field's column. */
  readonly field: "deleted" | "removed";
  readonly column: "deleted_at" | "removed_at";
}

const LINK_KEY = "task_id || '|' || source_id";

/** A1 3.10: a task's notes, log entries, learnings, links, attachments and places. */
const TASK_CHILDREN: readonly Child[] = [
  ...(["notes", "log_entries"] as const).map((entity): Child => ({
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
  ...(["learnings", "attachments"] as const).map((entity): Child => ({
    entity,
    key: "id",
    task: "task_id",
    parent: "task_id",
    where: "",
    fields: { deleted: ["deleted_at"] },
    field: "deleted",
    column: "deleted_at",
  })),
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

const CHILDREN: Readonly<Partial<Record<InvertibleEntity, readonly Child[]>>> = {
  tasks: TASK_CHILDREN,
  sources: SOURCE_CHILDREN,
};

/**
 * The live children of every parent in `$parents` (a JSON array of IDs), in one statement per
 * child table: an importer's commit creates thousands of rows, and a source's links have no index
 * by source, so a statement per created row would scan the links once per source.
 */
const childSql = (c: Child): string =>
  `SELECT ${c.key} AS key, ${c.task} AS task, ${c.parent} AS parent, * FROM ${c.entity} ` +
  `WHERE ${c.parent} IN (SELECT value FROM json_each($parents))${c.where} AND ${c.column} IS NULL ` +
  `ORDER BY created_seq, key`;

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

const SQL = {
  changes: "SELECT * FROM changes WHERE seq = $seq ORDER BY n",
  newestDone:
    `SELECT ${COMMIT_COLUMNS} FROM commits WHERE principal_id = $principal ` +
    "AND undo_status = 'done' ORDER BY seq DESC LIMIT 1",
  oldestUndone:
    `SELECT ${COMMIT_COLUMNS} FROM commits WHERE principal_id = $principal ` +
    "AND undo_status = 'undone' AND seq > $after ORDER BY seq LIMIT 1",
  author:
    "SELECT k.at AS at, k.author_id AS actor, a.kind AS kind, a.label AS label, " +
    "k.origin AS origin FROM commits k JOIN actors a ON a.id = k.author_id WHERE k.seq = $seq",
  taskRef: "SELECT ref FROM tasks WHERE id = $id",
  sourceTaken: "SELECT * FROM sources WHERE source_key = $key AND deleted_at IS NULL AND id <> $id",
  placeTaken:
    "SELECT * FROM places WHERE owner_kind = $kind AND owner_id = $owner " +
    "AND machine_id = $machine AND deleted_at IS NULL AND id <> $id",
  /** The links to keyed sources of tasks a plan brings back or relinks, with their tasks' state. */
  keyedLinks:
    "SELECT ts.task_id AS task_id, ts.source_id AS source_id, ts.removed_at AS removed_at, " +
    "s.source_key AS source_key, t.lifecycle AS lifecycle, t.deleted_at AS deleted_at " +
    "FROM task_sources ts JOIN sources s ON s.id = ts.source_id JOIN tasks t ON t.id = ts.task_id " +
    "WHERE ts.task_id IN (SELECT value FROM json_each($tasks)) AND s.source_key IS NOT NULL",
  liveSources:
    "SELECT id, source_key FROM sources WHERE deleted_at IS NULL " +
    "AND source_key IN (SELECT value FROM json_each($keys))",
  /** The live links of live tasks to these sources: one pass, as `task_sources` has no index. */
  keyHolders:
    "SELECT ts.task_id AS task_id, ts.source_id AS source_id, ts.created_seq AS created_seq, " +
    "ts.version AS version, ts.fv AS fv, ts.fp AS fp, t.lifecycle AS lifecycle " +
    "FROM task_sources ts JOIN tasks t ON t.id = ts.task_id " +
    "WHERE ts.source_id IN (SELECT value FROM json_each($sources)) AND ts.removed_at IS NULL " +
    "AND t.deleted_at IS NULL",
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

/** What undo takes: the principal's newest `done` commit (A1 3.10.1). */
export function undoTarget(conn: Connection, principal: Id<"ac">): StackCommit | undefined {
  return decodeStackCommit(conn.prepare(SQL.newestDone).get({ principal }));
}

/** What redo takes: the oldest `undone` commit newer than the principal's newest `done` one. */
export function redoTarget(conn: Connection, principal: Id<"ac">): StackCommit | undefined {
  const after = undoTarget(conn, principal)?.seq ?? 0;
  return decodeStackCommit(conn.prepare(SQL.oldestUndone).get({ principal, after }));
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
}

const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw invalidValue("changes", "after");
  }
};

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
  const plan: InversionPlan = { inversions: [], conflicts: [] };
  const rows = new Map<string, RowState>();
  const refs = new Map<string, string>();
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
  const conflict = (
    where: Omit<FieldConflict, "op" | "ref" | "by" | "at" | "version">,
    version: number,
  ): FieldConflict => {
    const by = conn.prepare(SQL.author).get({ seq: version });
    if (by === undefined) throw invalidValue(where.entity, "fv");
    const r = new RowReader("commits", by);
    let ref: string | undefined;
    if (where.task !== undefined) {
      ref = refs.get(where.task);
      if (ref === undefined) {
        const found = conn.prepare(SQL.taskRef).get({ id: where.task });
        if (found === undefined) throw invalidValue("changes", "task_id");
        ref = formatTaskRef(options.refPrefix, new RowReader("tasks", found).int("ref", "taskRef"));
        refs.set(where.task, ref);
      }
    }
    return {
      op: options.op,
      ...where,
      ...(ref === undefined ? {} : { ref }),
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
        value: columnsValue(row.raw, TABLES[entity].fields[field] ?? []),
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
      const columns = table.fields[field];
      if (columns === undefined) throw invalidValue("changes", "field");
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
    for (const [field, columns] of Object.entries(table.fields)) {
      if (options.creating.has(provenanceOf(row, field))) continue;
      passes = false;
      blocked(
        fieldConflict(entity, id, change.taskId, field, {
          wrote: columnsValue(created as Record<string, unknown>, columns),
        }),
      );
    }
    for (const kid of kids.get(`${entity}|${id}`) ?? []) {
      const { child, state } = kid;
      // Another's row is named by its tombstone, with who created or revived it; a row of the
      // creating commits by each field another wrote since, so that a partial inversion keeps the
      // parent, and the row stays reachable, too.
      const theirs = !options.creating.has(state.createdSeq);
      const fields = theirs
        ? [child.field]
        : Object.keys(child.fields).filter((f) => !options.creating.has(provenanceOf(state, f)));
      for (const field of fields) {
        passes = false;
        blocked(
          conflict(
            {
              entity: child.entity,
              id: kid.id,
              ...(kid.task === null ? {} : { task: kid.task }),
              field,
              value: theirs ? null : columnsValue(state.raw, child.fields[field] ?? []),
            },
            versionOf(state, field),
          ),
        );
      }
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
  const name = (
    where: Omit<FieldConflict, "op" | "ref" | "by" | "at" | "version">,
    version: number,
  ): void => {
    blocked(conflict(where, version));
  };
  keepActiveUnwrapped(plan, read, name);
  keepOneActiveHolder(conn, plan, name);
  return plan;
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
  name: (
    where: Omit<FieldConflict, "op" | "ref" | "by" | "at" | "version">,
    version: number,
  ) => void,
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

/**
 * A restore never makes a second active holder of a source key (A1 3.6, 3.10). A row the plan
 * brings back, a task's tombstone cleared or a task's link to a keyed source revived, takes the
 * place of the create or the link that made it, and dedupe never creates a task, or links a key
 * to one, beside an active task that holds that key. So when the task is active after the plan
 * and another active task outside the restore holds one of its keys by a live link, the restore
 * stays undone and that holder's link is the conflict, named with who created or revived it. A
 * finished holder never blocks: a task beside a finished one is what `dedupe: "new"` makes.
 * Setting a lifecycle back is not a restore: it repeats a complete or a reopen, which dedupe does
 * not guard either.
 *
 * The plan as it will stand decides: rows it tombstones hold nothing, lifecycles it sets back
 * count with their new value. A task's keys are those of the sources its live links name, whatever
 * the source's own state, so a source that a unique key keeps tombstoned still names the holder.
 * Three statements, whatever the plan's size: a redo of an importer's commit restores thousands.
 */
function keepOneActiveHolder(
  conn: Connection,
  plan: InversionPlan,
  name: (
    where: Omit<FieldConflict, "op" | "ref" | "by" | "at" | "version">,
    version: number,
  ) => void,
): void {
  const planned = new Map<string, Inversion>();
  for (const i of plan.inversions) planned.set(`${i.entity}|${i.id}|${i.field}`, i);
  /** Whether a row is live once the plan applies: what it sets its tombstone to, else as now. */
  const liveAfter = (entity: InvertibleEntity, id: string, now: boolean): boolean => {
    const i = planned.get(`${entity}|${id}|${TABLES[entity].tombstone}`);
    if (i === undefined) return now;
    return i.kind === "restore" && isLive(parsed(i.value));
  };
  const activeAfter = (task: string, now: unknown): boolean => {
    const i = planned.get(`tasks|${task}|lifecycle`);
    return (i?.kind === "restore" ? columnOf(i.value, "lifecycle") : now) === "active";
  };
  /** What the plan brings back: tasks by ID, links by `task|source`. */
  const tasks = new Map<string, Inversion>();
  const links = new Map<string, Inversion>();
  for (const i of plan.inversions) {
    if (i.kind !== "restore" || !isLive(parsed(i.value))) continue;
    if (i.entity === "tasks" && i.field === "deleted") tasks.set(i.id, i);
    if (i.entity === "task_sources" && i.field === "removed") links.set(i.id, i);
  }
  if (tasks.size === 0 && links.size === 0) return;
  const owners = new Set(tasks.keys());
  for (const link of links.keys()) owners.add(keyOf("task_sources", link)["task"] ?? "");
  /** Each key a restore makes an active task hold, with the inversions that make it. */
  const claims = new Map<string, { tasks: Set<string>; by: Set<Inversion> }>();
  for (const row of conn.prepare(SQL.keyedLinks).all({ tasks: JSON.stringify([...owners]) })) {
    const r = new RowReader("task_sources", row);
    const task = r.text("task_id");
    const link = `${task}|${r.text("source_id")}`;
    const restored = tasks.get(task);
    const revived = links.get(link);
    const by = restored ?? revived;
    if (by === undefined) continue;
    if (!liveAfter("task_sources", link, r.optInt("removed_at", "instant") === null)) continue;
    if (!liveAfter("tasks", task, r.optInt("deleted_at", "instant") === null)) continue;
    if (!activeAfter(task, r.text("lifecycle"))) continue;
    const key = r.text("source_key");
    const claim = claims.get(key) ?? { tasks: new Set<string>(), by: new Set<Inversion>() };
    claim.tasks.add(task);
    claim.by.add(by);
    claims.set(key, claim);
  }
  if (claims.size === 0) return;
  const sources = new Map<string, string>();
  for (const row of conn
    .prepare(SQL.liveSources)
    .all({ keys: JSON.stringify([...claims.keys()]) })) {
    const r = new RowReader("sources", row);
    const id = r.text("id");
    if (liveAfter("sources", id, true)) sources.set(id, r.text("source_key"));
  }
  if (sources.size === 0) return;
  const blocking = new Set<Inversion>();
  for (const row of conn
    .prepare(SQL.keyHolders)
    .all({ sources: JSON.stringify([...sources.keys()]) })) {
    const r = new RowReader("task_sources", row);
    const task = r.text("task_id");
    const source = r.text("source_id");
    const claim = claims.get(sources.get(source) ?? "");
    if (claim === undefined || claim.tasks.has(task)) continue;
    const link = `${task}|${source}`;
    if (!liveAfter("task_sources", link, true) || !liveAfter("tasks", task, true)) continue;
    if (!activeAfter(task, r.text("lifecycle"))) continue;
    for (const by of claim.by) blocking.add(by);
    const state = rowState("task_sources", row, TABLES.task_sources.fields);
    name(
      {
        entity: "task_sources",
        id: link,
        task: task as Id<"t">,
        field: TABLES.task_sources.tombstone,
        value: null,
      },
      versionOf(state, TABLES.task_sources.tombstone),
    );
  }
  if (blocking.size > 0) plan.inversions = plan.inversions.filter((i) => !blocking.has(i));
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
  const known = new Set(Object.values(TABLES[entity].fields).flat());
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

/**
 * Applies `inversions` as commit `seq`: one UPDATE per row with every field it sets (the task
 * CHECKs hold only on the whole row), its version, `fv` and `fp`, and the touched mark of each task
 * whose row or child row changed. Returns the change rows to insert, in the plan's order, and the
 * tasks it touched.
 */
export function applyInversions(
  conn: Connection,
  inversions: readonly Inversion[],
  commit: { seq: number; at: number; principal: Id<"ac">; op: number },
): { changes: InvertedChange[]; tasks: Set<Id<"t">> } {
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
      const columns = table.fields[field];
      if (columns === undefined) throw misuse("An inversion names a field its row does not have");
      const before = fieldJson(columnsValue(row.raw, columns));
      const after =
        inversion.kind === "restore"
          ? inversion.value
          : tombstoneJson(entity, commit.at, commit.principal);
      // The guard found the write the inverted row made; its value is never the one restored.
      if (before === after) {
        throw new StorageError("SPACE_INVALID", "A field does not hold the write it names");
      }
      Object.assign(values, columnValues(columns, after));
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
