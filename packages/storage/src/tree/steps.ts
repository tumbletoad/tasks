// Undo and Redo on the tree, by the one rule of undo-rule.ts: a person's commit is a step when every
// row it changed is of the few kinds Undo is for (a check-off or a reopen, the Trash and out of it,
// a removed note, words, out of the Inbox, a first filing or one into a project just made, a
// dismissal, a new project, an archive or unarchive, a routine's time done or skipped). Undo takes a step back with the ordinary
// commands that write what its change rows held before, and Redo does the same to the undo's own
// commit. Neither writes over a change made since, by anyone: only where every field it writes
// still stands as the step left it, and never taking a task or a note out of sight that someone
// else worked on since. A step that newer work keeps, or whose opposite cannot be applied, leaves
// the stack, and the answer says whose work or why.
import { newerBy } from "@ttasks/contracts/newer-work";
import type { Connection, Row } from "../driver.ts";
import { misuse } from "../errors.ts";
import { formatTaskRef } from "../refs.ts";
import { columnsValue, fieldJson } from "../write/fields.ts";
import type { HistoryRun, Tx } from "./tx.ts";
import { columnsOf, isEntity, TreeProblem } from "./fields.ts";
import { filedIntoNewGroup, undoRule, type KindRows } from "../undo-rule.ts";

/** A change row `c` of commit `c.seq` whose node the same commit also changed `field` of. */
const sameNode = (field: string): string =>
  "EXISTS (SELECT 1 FROM changes d WHERE d.seq = c.seq AND d.entity IN ('nodes', 'tasks') " +
  `AND d.node_id = c.node_id AND d.field = '${field}')`;

const IS_TASK = "EXISTS (SELECT 1 FROM tasks k WHERE k.id = c.entity_id)";
const IS_PROJECT = "EXISTS (SELECT 1 FROM nodes p WHERE p.id = c.entity_id AND p.kind = 'project')";

/** A move of node row `c` into a project the same person's commit right before made. */
const INTO_NEW_PROJECT = filedIntoNewGroup(
  "json_extract(c.after, '$.parent_id')",
  "g.entity = 'nodes' AND json_extract(g.after, '$.kind') = 'project'",
);

/** How the tree's change rows show each kind Undo is for (undo-rule.ts). */
const KINDS: KindRows = {
  // A routine's time done or skipped is its check-off, with the open time it moves on and the
  // queued run it cancels.
  finish:
    "(c.entity = 'tasks' AND c.field = 'lifecycle') " +
    `OR (c.entity = 'tasks' AND c.field = 'wrap' AND ${sameNode("lifecycle")}) ` +
    "OR c.entity = 'occurrences' " +
    `OR (c.entity IN ('routines', 'runs') AND c.field IN ('open', 'state') ` +
    `AND EXISTS (SELECT 1 FROM changes d WHERE d.seq = c.seq AND d.entity = 'occurrences' ` +
    "AND d.node_id = c.node_id))",
  trash:
    `(c.entity = 'nodes' AND c.field = 'deleted' AND ${IS_TASK}) ` +
    "OR (c.entity = 'pages' AND c.field = 'deleted') " +
    `OR (c.entity = 'routines' AND c.field = 'paused' AND ${sameNode("deleted")})`,
  note: "c.entity = 'notes' AND c.field = 'deleted'",
  words:
    `(c.entity = 'nodes' AND c.field IN ('title', 'brief', 'description') AND ${IS_TASK}) ` +
    "OR (c.entity = 'notes' AND c.field = 'body') " +
    // A page's words; the space's and a project's words and their text for agents.
    "OR (c.entity = 'pages' AND c.field IN ('title', 'brief', 'body')) " +
    `OR (c.entity = 'nodes' AND c.field IN ('brief', 'description', 'for_agents') AND NOT ${IS_TASK})`,
  inbox:
    "(c.entity = 'tasks' AND c.field = 'inbox') " +
    `OR (c.entity = 'tasks' AND c.field = 'status' AND ${sameNode("inbox")})`,
  filing:
    `(c.entity = 'nodes' AND c.field = 'place' AND ${IS_TASK} ` +
    "AND json_extract(c.before, '$.parent_id') = (SELECT space_id FROM space)) " +
    `OR (c.entity = 'nodes' AND c.field = 'place' AND ${IS_TASK} AND ${INTO_NEW_PROJECT})`,
  // An archive pauses the routines in its project, and an unarchive leaves them paused.
  group:
    `(c.entity = 'nodes' AND ${IS_PROJECT} AND (c.action = 'create' OR c.field = 'archived')) ` +
    "OR (c.entity = 'routines' AND c.field = 'paused' AND EXISTS (SELECT 1 FROM changes d " +
    "WHERE d.seq = c.seq AND d.entity = 'nodes' AND d.field = 'archived'))",
  dismissal: "c.entity = 'tasks' AND c.field = 'reviewed_at'",
};

const RULE = undoRule(KINDS);

/** Whether commit `seq` (an SQL expression) is a step. */
export const STEP_SQL = RULE.step;

const SQL = {
  commit: "SELECT seq FROM commits WHERE id = $id",
  changes: "SELECT * FROM changes WHERE seq = $seq ORDER BY n",
  node: "SELECT kind, parent_id FROM nodes WHERE id = $id",
  /** The live tasks below `$id`, at any depth. */
  below:
    "WITH RECURSIVE down(id) AS (SELECT id FROM nodes WHERE parent_id = $id AND kind = 'task' " +
    "AND deleted_at IS NULL UNION ALL SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id " +
    "WHERE n.kind = 'task' AND n.deleted_at IS NULL) SELECT id FROM down",
  ref: "SELECT ref FROM tasks WHERE id = $id",
  /** Who changed, after `$since`, field `$field` of row `$entity` `$id` (every field when null), or anything of node `$task`. */
  comments: "SELECT id FROM notes WHERE owner_id = $id",
  newer:
    "SELECT c.node_id AS task, k.author_id AS actor, a.kind AS kind, a.label AS label, " +
    "k.origin AS origin, max(k.at) AS at FROM changes c JOIN commits k ON k.seq = c.seq " +
    "JOIN actors a ON a.id = k.author_id WHERE c.seq > $since " +
    "AND ($anyone = 1 OR k.principal_id <> $principal) " +
    "AND ((c.entity = $entity AND c.entity_id = $id AND ($field IS NULL OR c.field = $field)) " +
    "OR ($task IS NOT NULL AND c.node_id = $task)) GROUP BY 1, k.author_id, k.origin",
} as const;

interface Stored {
  entity: string;
  id: string;
  node: string | null;
  action: "create" | "set";
  field: string | null;
  before: string | null;
  after: string;
}

const parsed = (json: string | null): unknown => (json === null ? null : JSON.parse(json));

const columns = (json: string | null): Record<string, unknown> => {
  const value = parsed(json);
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
};

/** Whether a `deleted` value holds a tombstone: a node's has its author beside it, a note's not. */
const tombstoned = (json: string | null): boolean => {
  const value = parsed(json);
  return (
    (typeof value === "object" && value !== null ? columns(json)["deleted_at"] : value) != null
  );
};

function readChanges(conn: Connection, seq: number): Stored[] {
  return conn
    .prepare(SQL.changes)
    .all({ seq })
    .map((row) => ({
      entity: String(row["entity"]),
      id: String(row["entity_id"]),
      node: typeof row["node_id"] === "string" ? row["node_id"] : null,
      action: row["action"] === "create" ? "create" : "set",
      field: typeof row["field"] === "string" ? row["field"] : null,
      before: typeof row["before"] === "string" ? row["before"] : null,
      after: String(row["after"]),
    }));
}

type Call = HistoryRun["calls"][number];

/** The ordinary commands that write back what `changes` held before, row by row. */
function oppositeOf(conn: Connection, changes: readonly Stored[]): Call[] {
  const rows = new Map<string, Stored[]>();
  for (const c of changes)
    rows.set(`${c.entity}|${c.id}`, [...(rows.get(`${c.entity}|${c.id}`) ?? []), c]);
  // A Trash or a restore of a subtree is one command on the subtree's top task.
  const trashed = new Set(
    changes.filter((c) => c.entity === "nodes" && c.field === "deleted").map((c) => c.id),
  );
  const calls: Call[] = [];
  for (const group of rows.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const id = first.id;
    const of = (field: string) => group.find((c) => c.field === field);
    if (first.entity === "nodes") {
      const node = conn.prepare(SQL.node).get({ id });
      const routine = node?.["kind"] === "routine";
      if (node?.["kind"] !== "task" && !routine) {
        // The space's or a project's words, and its text for agents, are written back as they were.
        const words: Record<string, unknown> = {};
        for (const field of ["brief", "description"]) {
          const c = of(field);
          if (c !== undefined) words[field] = parsed(c.before);
        }
        if (Object.keys(words).length > 0) {
          calls.push({ command: "node.set", input: { node: id, ...words } });
        }
        const agents = of("for_agents");
        if (agents !== undefined) {
          calls.push({
            command: "node.instruct",
            input: { node: id, text: parsed(agents.before) },
          });
        }
        if (first.action !== "create" && of("archived") === undefined) continue;
        // A new project is undone by its archive; an archive by an unarchive, and back.
        const archiveAgain =
          first.action === "create" || parsed(of("archived")?.before ?? null) !== null;
        calls.push({
          command: archiveAgain ? "project.archive" : "project.unarchive",
          input: { project: id },
        });
        continue;
      }
      const deleted = of("deleted");
      if (deleted !== undefined) {
        if (!trashed.has(String(node["parent_id"]))) {
          const command = tombstoned(deleted.before) ? "nodes.trash" : "nodes.restore";
          calls.push({ command, input: { task: id } });
        }
        continue;
      }
      const set: Record<string, unknown> = {};
      for (const c of group) {
        if (c.field === "place")
          calls.push({
            command: "task.move",
            input: { task: id, under: columns(c.before)["parent_id"] },
          });
        else if (c.field !== null) set[c.field] = parsed(c.before);
      }
      if (Object.keys(set).length > 0)
        calls.push(
          routine
            ? { command: "routine.set", input: { routine: id, ...set } }
            : { command: "task.update", input: { task: id, set } },
        );
      continue;
    }
    if (first.entity === "tasks") {
      const life = of("lifecycle");
      if (life !== undefined && conn.prepare(SQL.node).get({ id })?.["kind"] === "routine") {
        const reopen = columns(life.before)["lifecycle"] === "active";
        calls.push({
          command: reopen ? "routine.reopen" : "routine.finish",
          input: { routine: id },
        });
        continue;
      }
      if (life !== undefined) {
        const was = columns(life.before);
        const wrap = columns(of("wrap")?.before ?? null);
        const outcome =
          wrap["wrap_state"] === "wrapped" && typeof wrap["outcome"] === "string"
            ? { outcome: wrap["outcome"] }
            : {};
        if (was["lifecycle"] === "active")
          calls.push({ command: "task.reopen", input: { task: id } });
        else if (was["lifecycle"] === "archived") {
          const reason =
            typeof was["archived_reason"] === "string" ? { reason: was["archived_reason"] } : {};
          calls.push({
            command: "task.finish",
            input: { task: id, status: "dropped", subtasks: "only", ...reason, ...outcome },
          });
        } else {
          calls.push({
            command: "task.finish",
            input: { task: id, at: was["completed_at"], subtasks: "only", ...outcome },
          });
        }
        continue;
      }
      const set: Record<string, unknown> = {};
      for (const c of group) {
        if (c.field === "inbox") set["inbox"] = parsed(c.before) === 1;
        else if (c.field !== null) set[c.field] = parsed(c.before);
      }
      if (Object.keys(set).length > 0)
        calls.push({ command: "task.update", input: { task: id, set } });
      continue;
    }
    // A time's entry is taken back or put back with the open time it moved; a routine's pause comes
    // along with the Trash, and Restore leaves it paused.
    if (first.entity === "occurrences") {
      const deleted = of("deleted");
      const open = changes.find(
        (c) => c.entity === "routines" && c.id === first.node && c.field === "open",
      );
      calls.push({
        command: "routine.entry",
        input: {
          entry: id,
          removed: deleted === undefined || tombstoned(deleted.before),
          ...(open === undefined ? {} : { open: columns(open.before) }),
        },
      });
      continue;
    }
    // A routine's open time goes back with its entry; its pause and a cancelled run stay.
    if (first.entity === "routines" || first.entity === "runs") continue;
    if (first.entity === "pages") {
      const deleted = of("deleted");
      if (deleted !== undefined) {
        const command = tombstoned(deleted.before) ? "page.trash" : "page.restore";
        calls.push({ command, input: { page: id } });
        continue;
      }
      const set: Record<string, unknown> = {};
      for (const field of ["title", "brief", "body"]) {
        const c = of(field);
        if (c !== undefined) set[field] = parsed(c.before);
      }
      if (Object.keys(set).length > 0)
        calls.push({ command: "page.set", input: { page: id, ...set } });
      continue;
    }
    if (first.entity === "notes") {
      const deleted = of("deleted");
      if (deleted !== undefined) {
        calls.push({
          command: tombstoned(deleted.before) ? "note.remove" : "note.put_back",
          input: { note: id },
        });
      }
      const body = of("body");
      if (body !== undefined)
        calls.push({
          command: "note.edit",
          input: { note: id, body: columns(body.before)["body"] },
        });
    }
  }
  if (calls.length === 0) throw misuse("A step's change rows have no opposite");
  return calls;
}

/** The change rows whose fields an opposite writes: not what comes along with them. */
function written(changes: readonly Stored[]): Stored[] {
  const deleted = new Set(
    changes.filter((c) => c.field === "deleted" && c.entity === "nodes").map((c) => c.id),
  );
  const finished = new Set(changes.filter((c) => c.field === "lifecycle").map((c) => c.id));
  return changes.filter((c) => {
    if (!isEntity(c.entity)) return false;
    if (c.entity === "nodes" && deleted.has(c.id)) return c.field === "deleted";
    if (c.entity === "tasks" && finished.has(c.id))
      return c.field === "lifecycle" || c.field === "wrap";
    return true;
  });
}

/** The field a create's Undo writes: a new project's archive, a time's entry taken back. */
const createdField = (c: Stored): "archived" | "deleted" =>
  c.entity === "occurrences" ? "deleted" : "archived";

/** What `c`'s field holds now, as a change row writes it; undefined for a row that is gone. */
function valueNow(conn: Connection, c: Stored): string | undefined {
  if (!isEntity(c.entity)) return undefined;
  const row = conn.prepare(`SELECT * FROM ${c.entity} WHERE id = $id`).get({ id: c.id });
  if (row === undefined) return undefined;
  const field = c.action === "create" ? createdField(c) : (c.field ?? "");
  return fieldJson(columnsValue(row, columnsOf(c.entity, field)));
}

const wrote = (c: Stored): string =>
  c.action === "create" ? fieldJson(columns(c.after)[`${createdField(c)}_at`] ?? null) : c.after;

/** The state a value stands for, as a person sees it: never when it was written. */
function stateOf(c: Stored, json: string | undefined): string | undefined {
  if (json === undefined || c.action === "create") return json;
  const value = columns(json);
  switch (c.field) {
    case "deleted":
      return String(tombstoned(json));
    case "lifecycle":
      return String(value["lifecycle"]);
    case "wrap":
      return fieldJson([value["wrap_state"] ?? null, value["outcome"] ?? null]);
    case "place":
      return fieldJson(value["parent_id"] ?? null);
    case "body":
      // A note's words, not when they were edited; a page's body is its words alone.
      return c.entity === "notes" ? fieldJson(value["body"] ?? null) : json;
    case "archived":
      return String(parsed(json) !== null);
    default:
      return json;
  }
}

/** Whether a change row's opposite takes its row out of sight: a task done again, or a removal. */
const hides = (c: Stored): boolean =>
  (c.field === "deleted" && !tombstoned(c.after)) ||
  (c.entity === "tasks" && c.field === "lifecycle" && columns(c.after)["lifecycle"] === "active");

interface WorkItem {
  task?: string;
  ref?: string;
  by: { actor: string; kind: string; label: string; origin: string };
  run: boolean;
  at: number;
}

/** Who worked since: each node and author once, with their newest time. */
class Work {
  readonly #conn: Connection;
  readonly #prefix: string;
  readonly #work = new Map<string, WorkItem>();
  constructor(conn: Connection, prefix: string) {
    this.#conn = conn;
    this.#prefix = prefix;
  }

  add(p: {
    since: number;
    principal: string;
    anyone: boolean;
    entity: string;
    id: string;
    field: string | null;
    task: string | null;
  }): boolean {
    const rows = this.#conn.prepare(SQL.newer).all({ ...p, anyone: p.anyone ? 1 : 0 });
    for (const row of rows) {
      const by = {
        actor: String(row["actor"]),
        kind: String(row["kind"]),
        label: String(row["label"]),
        origin: String(row["origin"]),
      };
      const at = Number(row["at"]);
      const task = typeof row["task"] === "string" ? row["task"] : undefined;
      const key = `${task ?? ""}|${newerBy(by, false)}`;
      if ((this.#work.get(key)?.at ?? -1) >= at) continue;
      const ref =
        task === undefined ? undefined : this.#conn.prepare(SQL.ref).get({ id: task })?.["ref"];
      this.#work.set(key, {
        ...(task === undefined ? {} : { task }),
        ...(typeof ref === "number" ? { ref: formatTaskRef(this.#prefix, ref) } : {}),
        by,
        run: false,
        at,
      });
    }
    return rows.length > 0;
  }

  get list(): WorkItem[] {
    return [...this.#work.values()];
  }
}

/** Whose change since stands in the way of undoing `changes`; undefined when none does. */
function newerOn(
  conn: Connection,
  changes: readonly Stored[],
  since: number,
  principal: string,
  prefix: string,
): WorkItem[] | undefined {
  const work = new Work(conn, prefix);
  let moved = false;
  for (const c of written(changes)) {
    if (stateOf(c, valueNow(conn, c)) === stateOf(c, wrote(c))) continue;
    moved = true;
    work.add({
      since,
      principal,
      anyone: true,
      entity: c.entity,
      id: c.id,
      field: c.action === "create" ? null : c.field,
      task: null,
    });
  }
  // A routine's open time written back under a schedule changed since would follow the old one.
  for (const c of changes) {
    if (c.entity !== "routines" || c.field !== "open") continue;
    const schedule = { entity: "routines", id: c.id, field: "schedule", task: null };
    if (work.add({ since, principal, anyone: true, ...schedule })) moved = true;
  }
  // A finish that left no wrap-up of its own: one written since is newer work a reopen would clear.
  for (const c of changes) {
    if (
      c.entity !== "tasks" ||
      c.field !== "lifecycle" ||
      columns(c.after)["lifecycle"] === "active"
    )
      continue;
    if (changes.some((d) => d.id === c.id && d.field === "wrap")) continue;
    if (
      conn.prepare("SELECT wrap_state FROM tasks WHERE id = $id").get({ id: c.id })?.[
        "wrap_state"
      ] == null
    )
      continue;
    moved = true;
    work.add({
      since,
      principal,
      anyone: true,
      entity: "tasks",
      id: c.id,
      field: "wrap",
      task: null,
    });
  }
  let hidden = false;
  const stepRows = new Set(changes.map((c) => c.id));
  for (const c of changes.filter(hides)) {
    const task = c.entity === "nodes" || c.entity === "tasks" ? c.id : null;
    const own = { since, principal, anyone: false, field: null };
    if (work.add({ ...own, entity: c.entity, id: c.id, task })) hidden = true;
    // A page put back in the Trash takes its comments along, as a task takes its notes: one someone
    // else wrote or changed since keeps the step.
    if (c.entity === "pages") {
      for (const note of conn.prepare(SQL.comments).all({ id: c.id })) {
        const id = String(note["id"]);
        if (work.add({ ...own, entity: "notes", id, task: null })) hidden = true;
      }
      continue;
    }
    // A task put back in the Trash takes the tasks below it along: one someone else made or
    // changed since, outside what the step wrote, keeps the step.
    if (c.entity !== "nodes" || c.field !== "deleted") continue;
    for (const below of conn.prepare(SQL.below).all({ id: c.id })) {
      const id = String(below["id"]);
      if (stepRows.has(id)) continue;
      if (work.add({ ...own, entity: "nodes", id, task: id })) hidden = true;
    }
  }
  return moved || hidden ? work.list : undefined;
}

function target(conn: Connection, kind: "undo" | "redo", principal: string): Row | undefined {
  return conn.prepare(kind === "undo" ? RULE.undoTarget : RULE.redoTarget).get({ principal });
}

/** What an undo or a redo runs, or why it runs nothing. */
export function planHistory(
  tx: Tx,
  kind: "undo" | "redo",
  input: Record<string, unknown>,
): HistoryRun {
  const principal = tx.request.actor.principal_id;
  const named = typeof input["commit"] === "string" ? input["commit"] : undefined;
  if (named !== undefined && tx.get(SQL.commit, { id: named }) === undefined) {
    throw new TreeProblem("NOT_FOUND", "The space has no change with this ID", "commit");
  }
  const step = target(tx.conn, kind, principal);
  if (step === undefined) {
    throw kind === "undo"
      ? new TreeProblem("NOTHING_TO_UNDO", "Nothing of yours is left to undo here")
      : new TreeProblem("NOTHING_TO_REDO", "Nothing of yours is left to redo here");
  }
  if (named !== undefined && named !== step["id"]) {
    throw new TreeProblem(
      "INVALID_TRANSITION",
      "That change is not the one Undo or Redo takes now: read again",
      "commit",
    );
  }
  const seq = Number(step["seq"]);
  const applied = Number(step["applied"]);
  const answered = readChanges(tx.conn, applied);
  const work = newerOn(tx.conn, answered, applied, principal, tx.space.refPrefix);
  if (work !== undefined) {
    throw new TreeProblem("STEP_KEPT", "A change since stands in the way", undefined, {
      target: seq,
      work,
    });
  }
  return { kind, target: seq, calls: oppositeOf(tx.conn, answered) };
}
