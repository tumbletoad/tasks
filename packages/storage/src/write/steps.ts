// Undo and redo (A1 3.10.1). A person's commit is a step on their undo stack when every row it
// changed is of the few kinds Undo is for: a check-off or a reopen, the Trash and out of it, a
// removed note, words, out of the Inbox or into it, a first filing or one into a group just made,
// a dismissal of questions, a new group, or a group archived or unarchived, a page's words and its
// Trash, and the words of a node's texts (stepSql).
// Undo takes a step back with the ordinary operations that write what its change rows held
// before (oppositeOf), and Redo does the same to the undo's own commit, so both change only what
// the commit they answer changed. Neither writes over a change made since (newerOn): only where
// every field it writes still stands as the step left it, in the state a person sees (stateOf), a
// finish's wrap-up included, and never takes a task or a note out of sight that someone else
// worked on since.
import { newerBy } from "@ttasks/contracts/newer-work";
import type { Connection, Row } from "../driver.ts";
import { misuse } from "../errors.ts";
import { isId, type Id } from "../ids.ts";
import { formatTaskRef } from "../refs.ts";
import { invalidValue, RowReader } from "../rows.ts";
import { CHILD_FIELDS, columnsValue, fieldJson, TASK_FIELDS } from "./fields.ts";
import type { NewerWork, NodeSet, Operation, PageSet, TextNode } from "./request.ts";
import { undoRule, type KindRows } from "../undo-rule.ts";

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

/** How this schema's change rows show each kind Undo is for (undo-rule.ts). */
const KINDS: KindRows = {
  finish:
    "(c.entity = 'tasks' AND c.field = 'lifecycle') " +
    `OR (c.entity = 'tasks' AND c.field = 'wrap' AND ${sameTask("lifecycle")})`,
  trash:
    "(c.entity = 'tasks' AND c.field = 'deleted') " +
    "OR (c.entity = 'pages' AND c.field = 'deleted') " +
    "OR (c.entity IN ('tasks', 'task_sources') AND c.field IN ('grouping', 'inbox', 'removed') " +
    `AND ${sameTask("deleted")})`,
  note: "c.entity = 'notes' AND c.field = 'deleted'",
  words:
    "(c.entity = 'tasks' AND c.field IN ('title', 'summary', 'context')) " +
    "OR (c.entity IN ('notes', 'log_entries') AND c.field = 'body') " +
    // A page's words; a node's texts, the words alone.
    "OR (c.entity = 'pages' AND c.field IN ('title', 'brief', 'body')) " +
    "OR (c.entity = 'node_texts')",
  inbox:
    "(c.entity = 'tasks' AND c.field = 'inbox') " +
    `OR (c.entity = 'tasks' AND c.field = 'status' AND ${sameTask("inbox")})`,
  filing:
    "(c.entity = 'tasks' AND c.field = 'grouping' " +
    "AND json_extract(c.before, '$.area_id') IS NULL AND json_extract(c.before, '$.project_id') IS NULL) " +
    `OR (c.entity = 'tasks' AND c.field = 'grouping' AND ${INTO_NEW_GROUP})`,
  group:
    "(c.entity IN ('areas', 'projects') " +
    "AND (c.action = 'create' OR (c.field = 'lifecycle' " +
    "AND '\"archived\"' IN (c.before, c.after)))) " +
    "OR (c.entity IN ('folders', 'places') AND c.action = 'create' AND EXISTS (SELECT 1 FROM changes p " +
    "WHERE p.seq = c.seq AND p.entity = 'projects' AND p.action = 'create'))",
  dismissal: "c.entity = 'tasks' AND c.field = 'reviewed_at'",
};

const RULE = undoRule(KINDS);

/**
 * Whether commit `seq` (an SQL expression) is a step: it changed something, and every row it
 * changed is of a kind Undo is for. A commit with one row of another kind is no step, whole. The
 * writer marks a person's commit by it, and Undo and Redo choose their target by it, so a step an
 * earlier version stored of a kind that has left Undo is passed over.
 */
export const stepSql = RULE.step;

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
 * it. The writer and the service's question before an undo both read it here.
 */
export const UNDO_TARGET_SQL = RULE.undoTarget;

/** The step a redo takes: the one the principal undid last. */
const REDO_TARGET_SQL = RULE.redoTarget;

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

/** The node a texts row is of, as an operation names it. */
function nodeOf(conn: Connection, id: string): TextNode {
  const row = conn.prepare("SELECT owner_kind FROM node_texts WHERE owner_id = $id").get({ id });
  if (row === undefined) throw invalidValue("changes", "entity_id");
  const kind = new RowReader("node_texts", row).oneOf("owner_kind", ["space", "area", "project"]);
  if (kind === "space") return { kind };
  return kind === "area" ? { kind, area: id } : { kind, project: id };
}

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
            // A dropped task wrapped up goes back with its outcome as the result.
            if (columns(of("wrap")?.before ?? null)["wrap_state"] === "wrapped") {
              ops.push({ kind: "task.wrap_up", task: id });
            }
          } else {
            const wrap = columns(of("wrap")?.before ?? null);
            const wrapped = wrap["wrap_state"] === "wrapped";
            const outcome = wrapped ? wrap["outcome"] : undefined;
            ops.push({
              kind: "task.complete",
              task: id,
              ...(typeof was["completed_at"] === "number" ? { at: was["completed_at"] } : {}),
              ...(typeof outcome === "string" ? { outcome } : {}),
            });
            // Wrapped up without words, such as with a learning alone.
            if (wrapped && typeof outcome !== "string")
              ops.push({ kind: "task.wrap_up", task: id });
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
      case "pages": {
        const deleted = of("deleted");
        if (deleted !== undefined) {
          const kind = tombstoned(deleted.before) ? "page.trash" : "page.restore";
          ops.push({ kind, page: id });
          continue;
        }
        const set: PageSet = { kind: "page.set", page: id };
        for (const c of group) {
          if (c.field === "title" || c.field === "brief" || c.field === "body") {
            set[c.field] = String(parsed(c.before));
          }
        }
        ops.push(set);
        continue;
      }
      case "node_texts": {
        // A create made the row with its first words: their opposite is the empty text.
        const before = (field: string): string | undefined => {
          if (first.action === "create") return columns(first.after)[field] === "" ? undefined : "";
          const c = of(field);
          return c === undefined ? undefined : String(parsed(c.before));
        };
        const node = nodeOf(conn, id);
        const set: NodeSet = { kind: "node.set", node };
        const brief = before("brief");
        const description = before("description");
        if (brief !== undefined) set.brief = brief;
        if (description !== undefined) set.description = description;
        if (brief !== undefined || description !== undefined) ops.push(set);
        const forAgents = before("for_agents");
        if (forAgents !== undefined) ops.push({ kind: "node.instruct", node, text: forAgents });
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
 * null), or anything of task `$task`: each author once with the time of their newest change. With
 * `$anyone` 0 the principal's own changes do not count, but for a run's own work, which the run
 * machine writes with the person's credential.
 */
const newerSql = (runs: string): string =>
  "SELECT coalesce(c.task_id, CASE c.entity WHEN 'runs' THEN $task END) AS task, " +
  `(c.entity = 'runs' AND NOT ${STOP}) AS run, k.author_id AS actor, a.kind AS kind, ` +
  "a.label AS label, k.origin AS origin, max(k.at) AS at " +
  "FROM changes c JOIN commits k ON k.seq = c.seq JOIN actors a ON a.id = k.author_id " +
  `WHERE c.seq > $since AND ($anyone = 1 OR NOT (k.principal_id = $principal AND NOT ${RUN_WORK})) ` +
  "AND ((c.entity = $entity AND c.entity_id = $id AND ($field IS NULL OR c.field = $field)) " +
  `OR ($task IS NOT NULL AND (c.task_id = $task${runs}))) ` +
  "GROUP BY 1, 2, k.author_id, k.origin";

const SQL = {
  newer: newerSql(""),
  newerWithRuns: newerSql(RUNS_OF_TASK),
  runs: "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'runs'",
  taskRef: "SELECT ref FROM tasks WHERE id = $id",
  row: {
    tasks: "SELECT * FROM tasks WHERE id = $id",
    notes: "SELECT * FROM notes WHERE id = $id",
    log_entries: "SELECT * FROM log_entries WHERE id = $id",
    areas: "SELECT * FROM areas WHERE id = $id",
    projects: "SELECT * FROM projects WHERE id = $id",
    pages: "SELECT * FROM pages WHERE id = $id",
    node_texts: "SELECT * FROM node_texts WHERE owner_id = $id",
  },
} as const;

type Rowed = keyof typeof SQL.row;
const isRowed = (entity: string): entity is Rowed => Object.hasOwn(SQL.row, entity);

/**
 * The change rows whose fields an opposite writes (oppositeOf): not what comes along with them,
 * such as a restore's regrouping or a new project's folder.
 */
function written(changes: readonly StoredChange[]): StoredChange[] {
  const deletedTasks = new Set(
    changes.filter((c) => c.entity === "tasks" && c.field === "deleted").map((c) => c.entityId),
  );
  const finished = new Set(
    changes.filter((c) => c.entity === "tasks" && c.field === "lifecycle").map((c) => c.entityId),
  );
  return changes.filter((c) => {
    if (!isRowed(c.entity)) return false;
    if (c.entity !== "tasks") return true;
    if (deletedTasks.has(c.entityId)) return c.field === "deleted";
    if (finished.has(c.entityId)) return c.field === "lifecycle" || c.field === "wrap";
    return true;
  });
}

/** What field `c` holds now, in the form of a change row's value; undefined for a row that is gone. */
function valueNow(conn: Connection, c: StoredChange): string | undefined {
  if (!isRowed(c.entity)) return undefined;
  const row = conn.prepare(SQL.row[c.entity]).get({ id: c.entityId });
  if (row === undefined) return undefined;
  if (c.entity === "node_texts" && c.action === "create") return textsOf(row, created(c));
  // A new group's create is undone by its archive: what it wrote there is its lifecycle.
  const field = c.action === "create" ? "lifecycle" : (c.field ?? "");
  const fields: Readonly<Record<string, readonly string[]>> =
    c.entity === "tasks" ? TASK_FIELDS : CHILD_FIELDS[c.entity];
  return fieldJson(columnsValue(row, fields[field] ?? []));
}

/**
 * The texts a node row's create wrote: the ones its undo empties, and the only ones it compares, so
 * a description written since never keeps the first text for agents from being undone.
 */
const created = (c: StoredChange): string[] =>
  ["brief", "description", "for_agents"].filter((field) => (columns(c.after)[field] ?? "") !== "");

/** Those texts of a node row, together. */
const textsOf = (row: Readonly<Record<string, unknown>>, fields: readonly string[]): string =>
  fieldJson(fields.map((field) => row[field] ?? null));

/** What `c` wrote, as valueNow gives it. */
const wrote = (c: StoredChange): string =>
  c.action !== "create"
    ? c.after
    : c.entity === "node_texts"
      ? textsOf(columns(c.after), created(c))
      : fieldJson(columns(c.after)["lifecycle"] ?? null);

/**
 * The state a value of `c`'s field stands for, as a person sees it: in the Trash or not; open,
 * completed or dropped; wrapped up or not, with which words; the group a task is in; the words.
 * Never when it was written: an undo writes a state again with a time of its own.
 */
function stateOf(c: StoredChange, json: string | undefined): string | undefined {
  if (json === undefined || c.action === "create") return json;
  const value = columns(json);
  switch (c.field) {
    case "deleted":
    case "removed":
      return String(tombstoned(json));
    case "lifecycle":
      return c.entity === "tasks" ? String(value["lifecycle"]) : json;
    case "wrap":
      return fieldJson([value["wrap_state"] ?? null, value["outcome"] ?? null]);
    case "grouping":
      return fieldJson([value["area_id"] ?? null, value["project_id"] ?? null]);
    default:
      return json;
  }
}

/** Who worked since, as newerSql reads it, each task and author once with their newest time. */
class Work {
  readonly #conn: Connection;
  readonly #refPrefix: string;
  readonly #runs: boolean;
  readonly #work = new Map<string, NewerWork["work"][number]>();
  readonly #refs = new Map<string, string>();
  constructor(conn: Connection, refPrefix: string) {
    this.#conn = conn;
    this.#refPrefix = refPrefix;
    this.#runs = conn.prepare(SQL.runs).get() !== undefined;
  }

  add(params: {
    since: number;
    principal: Id<"ac">;
    anyone: boolean;
    entity: string;
    id: string;
    field: string | null;
    task: string | null;
  }): boolean {
    const sql = this.#runs && params.task !== null ? SQL.newerWithRuns : SQL.newer;
    const rows = this.#conn.prepare(sql).all({ ...params, anyone: params.anyone ? 1 : 0 });
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
      if ((this.#work.get(key)?.at ?? -1) >= at) continue;
      this.#work.set(key, {
        ...(changed === null ? {} : { task: changed, ref: this.#refOf(changed) }),
        by,
        run,
        at,
      });
    }
    return rows.length > 0;
  }

  get list(): NewerWork["work"] {
    return [...this.#work.values()];
  }

  #refOf(task: string): string {
    let ref = this.#refs.get(task);
    if (ref === undefined) {
      const row = this.#conn.prepare(SQL.taskRef).get({ id: task });
      if (row === undefined) throw invalidValue("changes", "task_id");
      ref = formatTaskRef(this.#refPrefix, new RowReader("tasks", row).int("ref", "taskRef"));
      this.#refs.set(task, ref);
    }
    return ref;
  }
}

/**
 * Whether a change since stands in the way of undoing `changes`, and whose it is: a field the
 * opposite would write that no longer holds what the step wrote, whoever changed it, the person
 * included; or someone else's work on a task or a note the opposite takes out of sight again.
 * Undefined when nothing does.
 */
export function newerOn(
  conn: Connection,
  changes: readonly StoredChange[],
  since: number,
  principal: Id<"ac">,
  refPrefix: string,
): NewerWork["work"] | undefined {
  const work = new Work(conn, refPrefix);
  let moved = false;
  for (const c of written(changes)) {
    if (stateOf(c, valueNow(conn, c)) === stateOf(c, wrote(c))) continue;
    moved = true;
    const field = c.action === "create" ? null : c.field;
    work.add({
      since,
      principal,
      anyone: true,
      entity: c.entity,
      id: c.entityId,
      field,
      task: null,
    });
  }
  // A finish that left no wrap-up of its own: one written since is newer work its undo, a reopen,
  // would clear.
  for (const c of changes) {
    if (c.entity !== "tasks" || c.field !== "lifecycle") continue;
    if (columns(c.after)["lifecycle"] === "active") continue;
    if (changes.some((d) => d.entityId === c.entityId && d.field === "wrap")) continue;
    if (conn.prepare(SQL.row.tasks).get({ id: c.entityId })?.["wrap_state"] == null) continue;
    moved = true;
    const id = c.entityId;
    work.add({ since, principal, anyone: true, entity: "tasks", id, field: "wrap", task: null });
  }
  let hidden = false;
  for (const c of changes.filter(hides)) {
    const task = c.entity === "tasks" ? c.entityId : null;
    const id = c.entityId;
    if (work.add({ since, principal, anyone: false, entity: c.entity, id, field: null, task })) {
      hidden = true;
    }
  }
  return moved || hidden ? work.list : undefined;
}

/** Someone else's work since on the tasks of `changes`: who to name when an opposite cannot apply. */
export function workOnTasks(
  conn: Connection,
  changes: readonly StoredChange[],
  since: number,
  principal: Id<"ac">,
  refPrefix: string,
): NewerWork["work"] {
  const work = new Work(conn, refPrefix);
  const tasks = new Set(changes.flatMap((c) => (c.taskId === null ? [] : [c.taskId])));
  for (const task of tasks) {
    work.add({ since, principal, anyone: false, entity: "tasks", id: task, field: null, task });
  }
  return work.list;
}
