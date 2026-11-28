// Undo and redo (A1 3.10.1). A person's commit is a step on their undo stack when every row it
// changed is of the few kinds Undo is for: a check-off or a reopen, the Trash and out of it, a
// removed note, words, out of the Inbox, a first filing or one into a group just made, a new group
// or an unarchive (stepSql).
// Undo takes a step back with the ordinary operations that write what its change rows held
// before (oppositeOf), and Redo does the same to the undo's own commit, so both change only what
// the commit they answer changed. Neither writes over someone else's newer work (newerOn).
import { newerBy } from "@ttasks/contracts/newer-work";
import type { Connection, Row } from "../driver.ts";
import { misuse } from "../errors.ts";
import { isId, type Id } from "../ids.ts";
import { formatTaskRef } from "../refs.ts";
import { invalidValue, RowReader } from "../rows.ts";
import type { NewerWork, Operation } from "./request.ts";

/** A change row of commit `c` whose task `c` also changed `field`. */
const sameTask = (field: string): string =>
  "EXISTS (SELECT 1 FROM changes d WHERE d.seq = c.seq AND d.entity = 'tasks' " +
  `AND d.entity_id = c.task_id AND d.field = '${field}')`;

/**
 * A move of task row `c` into an area or project that the same person's commit right before made:
 * the page's new area or project, made and then filed into.
 */
const INTO_NEW_GROUP =
  "EXISTS (SELECT 1 FROM changes g WHERE g.action = 'create' AND g.entity IN ('areas', 'projects') " +
  "AND g.entity_id IN (json_extract(c.after, '$.area_id'), json_extract(c.after, '$.project_id')) " +
  "AND g.seq = (SELECT max(p.seq) FROM commits p JOIN commits me ON me.seq = c.seq " +
  "WHERE p.principal_id = me.principal_id AND p.seq < c.seq))";

/** A change row `c` of a kind Undo is for, or one that comes with such a row in its commit. */
const KEPT_ROW =
  "(c.entity = 'tasks' AND c.field IN ('lifecycle', 'deleted', 'title', 'summary', 'context')) " +
  `OR (c.entity = 'tasks' AND c.field = 'wrap' AND ${sameTask("lifecycle")}) ` +
  "OR (c.entity = 'tasks' AND c.field = 'inbox' AND c.before = '1' AND c.after = '0') " +
  `OR (c.entity = 'tasks' AND c.field = 'status' AND ${sameTask("inbox")}) ` +
  "OR (c.entity = 'tasks' AND c.field = 'grouping' " +
  "AND json_extract(c.before, '$.area_id') IS NULL AND json_extract(c.before, '$.project_id') IS NULL) " +
  `OR (c.entity = 'tasks' AND c.field = 'grouping' AND ${INTO_NEW_GROUP}) ` +
  "OR (c.entity IN ('tasks', 'task_sources') AND c.field IN ('grouping', 'inbox', 'removed') " +
  `AND ${sameTask("deleted")}) ` +
  "OR (c.entity = 'notes' AND c.field IN ('deleted', 'body')) " +
  "OR (c.entity = 'log_entries' AND c.field = 'body') " +
  "OR (c.entity IN ('areas', 'projects') " +
  "AND (c.action = 'create' OR (c.field = 'lifecycle' AND c.before = '\"archived\"'))) " +
  "OR (c.entity IN ('folders', 'places') AND c.action = 'create' AND EXISTS (SELECT 1 FROM changes p " +
  "WHERE p.seq = c.seq AND p.entity = 'projects' AND p.action = 'create'))";

/**
 * Whether commit `seq` (an SQL expression) is a step: it changed something, and every row it
 * changed is of a kind Undo is for. A commit with one row of another kind is no step, whole. The
 * writer marks a person's commit by it, and Undo and Redo choose their target by it, so a step an
 * earlier version stored of a kind that has left Undo is passed over.
 */
export const stepSql = (seq: string): string =>
  `(EXISTS (SELECT 1 FROM changes c WHERE c.seq = ${seq}) AND NOT EXISTS (SELECT 1 FROM changes c ` +
  `WHERE c.seq = ${seq} AND NOT coalesce(${KEPT_ROW}, 0)))`;

/**
 * When the person last applied commit `seq` before commit `before` (SQL expressions): its newest
 * redo before then that wrote something again, else the commit itself.
 */
export const appliedSql = (seq: string, before: string): string =>
  `(SELECT coalesce(max(r.seq), ${seq}) FROM commits r WHERE r.seq > ${seq} ` +
  `AND r.seq < ${before} AND r.redo_of = ${seq} ` +
  "AND EXISTS (SELECT 1 FROM changes c WHERE c.seq = r.seq))";

/**
 * The step an undo of principal `$principal` takes, with `applied`, the commit that last applied
 * it: of its `done` steps, the one applied last, by its newest redo or else by its own seq. The
 * writer and the service's question before an undo both read it here.
 */
export const UNDO_TARGET_SQL =
  "WITH newest AS (SELECT seq, id, undo_status, undone_by, seq AS applied FROM commits k " +
  `WHERE principal_id = $principal AND undo_status = 'done' AND ${stepSql("k.seq")} ` +
  "ORDER BY seq DESC LIMIT 1) " +
  "SELECT * FROM (SELECT t.seq AS seq, t.id AS id, t.undo_status AS undo_status, " +
  "t.undone_by AS undone_by, r.seq AS applied FROM commits r JOIN commits t ON t.seq = r.redo_of " +
  "WHERE r.seq > coalesce((SELECT seq FROM newest), 0) AND r.principal_id = $principal " +
  `AND r.kind = 'redo' AND t.undo_status = 'done' AND ${stepSql("t.seq")} ` +
  "ORDER BY r.seq DESC LIMIT 1) " +
  "UNION ALL SELECT * FROM newest ORDER BY applied DESC LIMIT 1";

/** The step a redo takes: the one the principal undid last. */
const REDO_TARGET_SQL =
  "SELECT seq, id, undo_status, undone_by, undone_by AS applied FROM commits k " +
  `WHERE principal_id = $principal AND undo_status = 'undone' AND ${stepSql("k.seq")} ` +
  "ORDER BY undone_by DESC LIMIT 1";

/** A step on a principal's undo stack. */
export interface StackCommit {
  seq: number;
  id: Id<"op">;
  /** The commit whose rows Undo or Redo answers: the step's last application, or its undo. */
  applied: number;
}

function stackCommit(row: Row | undefined): StackCommit | undefined {
  if (row === undefined) return undefined;
  const r = new RowReader("commits", row);
  return { seq: r.int("seq", "seq"), id: r.id("id", "op"), applied: r.int("applied", "seq") };
}

export const undoTarget = (conn: Connection, principal: Id<"ac">): StackCommit | undefined =>
  stackCommit(conn.prepare(UNDO_TARGET_SQL).get({ principal }));

export const redoTarget = (conn: Connection, principal: Id<"ac">): StackCommit | undefined =>
  stackCommit(conn.prepare(REDO_TARGET_SQL).get({ principal }));

/** One `changes` row, decoded. `before` and `after` stay JSON text. */
export interface StoredChange {
  entity: string;
  entityId: string;
  taskId: Id<"t"> | null;
  action: "create" | "set";
  field: string | null;
  before: string | null;
  after: string;
}

export function readChanges(conn: Connection, seq: number): StoredChange[] {
  return conn
    .prepare("SELECT * FROM changes WHERE seq = $seq ORDER BY n")
    .all({ seq })
    .map((row) => {
      const r = new RowReader("changes", row);
      return {
        entity: r.text("entity"),
        entityId: r.text("entity_id"),
        taskId: r.optText("task_id", (v) => isId(v, "t")) as Id<"t"> | null,
        action: r.oneOf("action", ["create", "set"]),
        field: r.optText("field"),
        before: r.optText("before"),
        after: r.text("after"),
      };
    });
}

const parsed = (json: string | null): unknown => (json === null ? null : JSON.parse(json));

const columns = (json: string | null): Record<string, unknown> => {
  const value = parsed(json);
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
};

/** Whether a `deleted` value holds a tombstone: a task's has its author beside it, a child's not. */
function tombstoned(json: string | null): boolean {
  const value = parsed(json);
  return (
    (typeof value === "object" && value !== null ? columns(json)["deleted_at"] : value) != null
  );
}

/** Whether a change row's opposite takes its row out of sight: a task done again, or a removal. */
function hides(c: StoredChange): boolean {
  if (c.field === "deleted") return !tombstoned(c.after);
  return (
    c.entity === "tasks" && c.field === "lifecycle" && columns(c.after)["lifecycle"] === "active"
  );
}

const ENTRY = "SELECT task_id, ordinal FROM %s WHERE id = $id";

function entryOf(conn: Connection, table: "notes" | "log_entries", id: string) {
  const row = conn.prepare(ENTRY.replace("%s", table)).get({ id });
  if (row === undefined) throw invalidValue("changes", "entity_id");
  const r = new RowReader(table, row);
  return { task: r.text("task_id"), ordinal: r.int("ordinal", "ordinal") };
}

/** The ordinary operations that write back what `changes` held before, row by row. */
export function oppositeOf(conn: Connection, changes: readonly StoredChange[]): Operation[] {
  const rows = new Map<string, StoredChange[]>();
  for (const c of changes) {
    const key = `${c.entity}|${c.entityId}`;
    rows.set(key, [...(rows.get(key) ?? []), c]);
  }
  const ops: Operation[] = [];
  for (const group of rows.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const id = first.entityId;
    const of = (field: string) => group.find((c) => c.field === field);
    switch (first.entity) {
      case "tasks": {
        const deleted = of("deleted");
        if (deleted !== undefined) {
          // A restore's regrouping and the links it gave up stay: the task goes back to the Trash.
          const removed = !tombstoned(deleted.before);
          ops.push({ kind: removed ? "task.restore" : "task.delete", task: id });
          continue;
        }
        const life = of("lifecycle");
        if (life !== undefined) {
          const was = columns(life.before);
          if (was["lifecycle"] === "active") ops.push({ kind: "task.reopen", task: id });
          else if (was["lifecycle"] === "archived") {
            const reason = was["archived_reason"];
            ops.push({
              kind: "task.archive",
              task: id,
              ...(typeof reason === "string" ? { reason } : {}),
            });
          } else {
            const wrap = columns(of("wrap")?.before ?? null);
            const outcome = wrap["wrap_state"] === "wrapped" ? wrap["outcome"] : undefined;
            ops.push({
              kind: "task.complete",
              task: id,
              ...(typeof was["completed_at"] === "number" ? { at: was["completed_at"] } : {}),
              ...(typeof outcome === "string" ? { outcome } : {}),
            });
          }
          continue;
        }
        const set: Record<string, unknown> = {};
        for (const c of group) {
          if (c.field === "grouping") {
            const was = columns(c.before);
            const project = was["project_id"];
            ops.push({
              kind: "task.move",
              task: id,
              ...(typeof project === "string"
                ? { project }
                : { area: (was["area_id"] as string | null) ?? null }),
            });
          } else if (c.field === "inbox") set["inbox"] = parsed(c.before) === 1;
          else if (c.field !== null) set[c.field] = parsed(c.before);
        }
        if (Object.keys(set).length > 0) ops.push({ kind: "task.patch", task: id, set });
        continue;
      }
      case "notes":
      case "log_entries": {
        const entry = entryOf(conn, first.entity, id);
        const deleted = of("deleted");
        if (deleted !== undefined && first.entity === "notes") {
          const kind = tombstoned(deleted.before) ? "note.delete" : "note.restore";
          ops.push({ kind, ...entry });
        }
        const body = of("body");
        if (body !== undefined) {
          const kind = first.entity === "notes" ? "note.patch" : "log.patch";
          ops.push({ kind, ...entry, body: String(parsed(body.before)) });
        }
        continue;
      }
      case "areas":
      case "projects": {
        const area = first.entity === "areas";
        const life = of("lifecycle");
        const archive = first.action === "create" || parsed(life?.before ?? null) === "archived";
        const kind = `${area ? "area" : "project"}.${archive ? "archive" : "unarchive"}` as const;
        ops.push({ kind, ...(area ? { area: id } : { project: id }) });
        continue;
      }
      default:
        // What comes with a step and goes with its main row: a restore's links, a project's folder.
        continue;
    }
  }
  if (ops.length === 0) throw misuse("A step's change rows have no opposite");
  return ops;
}

/** A person's Stop of a run: a queued run straight to cancelled, a working one into cancelling. */
const STOP =
  "(c.entity = 'runs' AND c.field = 'state' AND (" +
  "(json_extract(c.before, '$.state') = 'queued' AND json_extract(c.after, '$.state') = 'cancelled') " +
  "OR (json_extract(c.after, '$.state') = 'cancelling' " +
  "AND json_extract(c.before, '$.state') <> 'cancelling')))";

/** A run's own change: every move of its state but a person's Stop. Its queue is the person's. */
const RUN_WORK = `(c.entity = 'runs' AND c.action = 'set' AND NOT ${STOP})`;

const RUNS_OF_TASK =
  " OR (c.entity = 'runs' AND c.entity_id IN (SELECT id FROM runs WHERE task_id = $task))";

/**
 * Who changed, after `$since`, field `$field` of row `$entity` `$id` (every field when it is
 * null), or anything of task `$task`: each author once with the time of their newest change. The
 * principal's own changes do not count, but for a run's own work, which the run machine writes
 * with the person's credential.
 */
const newerSql = (runs: string): string =>
  "SELECT coalesce(c.task_id, CASE c.entity WHEN 'runs' THEN $task END) AS task, " +
  `(c.entity = 'runs' AND NOT ${STOP}) AS run, k.author_id AS actor, a.kind AS kind, ` +
  "a.label AS label, k.origin AS origin, max(k.at) AS at " +
  "FROM changes c JOIN commits k ON k.seq = c.seq JOIN actors a ON a.id = k.author_id " +
  "WHERE c.seq > $since AND NOT (k.principal_id = $principal AND NOT " +
  `${RUN_WORK}) AND ((c.entity = $entity AND c.entity_id = $id AND ($field IS NULL OR c.field = $field)) ` +
  `OR ($task IS NOT NULL AND (c.task_id = $task${runs}))) ` +
  "GROUP BY 1, 2, k.author_id, k.origin";

const SQL = {
  newer: newerSql(""),
  newerWithRuns: newerSql(RUNS_OF_TASK),
  runs: "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'runs'",
  taskRef: "SELECT ref FROM tasks WHERE id = $id",
} as const;

/**
 * Someone else's work since commit `since` that undoing its rows would write over: a field it
 * changed, and anything on a task or a note that the opposite takes out of sight again. Each task
 * and author once, with their newest time.
 */
export function newerOn(
  conn: Connection,
  changes: readonly StoredChange[],
  since: number,
  principal: Id<"ac">,
  refPrefix: string,
): NewerWork["work"] {
  const runs = conn.prepare(SQL.runs).get() !== undefined;
  const work = new Map<string, NewerWork["work"][number]>();
  const refs = new Map<string, string>();
  const refOf = (task: string): string => {
    let ref = refs.get(task);
    if (ref === undefined) {
      const row = conn.prepare(SQL.taskRef).get({ id: task });
      if (row === undefined) throw invalidValue("changes", "task_id");
      ref = formatTaskRef(refPrefix, new RowReader("tasks", row).int("ref", "taskRef"));
      refs.set(task, ref);
    }
    return ref;
  };
  for (const c of changes) {
    const whole = hides(c);
    const task = whole && c.entity === "tasks" ? c.entityId : null;
    const rows = conn.prepare(runs && task !== null ? SQL.newerWithRuns : SQL.newer).all({
      since,
      principal,
      entity: c.entity,
      id: c.entityId,
      field: whole || c.action === "create" ? null : c.field,
      task,
    });
    for (const row of rows) {
      const r = new RowReader("commits", row);
      const at = r.int("at", "instant");
      const by = {
        actor: r.id("actor", "ac"),
        kind: r.text("kind"),
        label: r.text("label"),
        origin: r.text("origin"),
      };
      const run = r.int("run", "count") === 1;
      const changed = r.optText("task", (v) => isId(v, "t")) as Id<"t"> | null;
      const key = `${changed ?? ""}|${newerBy(by, run)}`;
      if ((work.get(key)?.at ?? -1) >= at) continue;
      work.set(key, {
        ...(changed === null ? {} : { task: changed, ref: refOf(changed) }),
        by,
        run,
        at,
      });
    }
  }
  return [...work.values()];
}
