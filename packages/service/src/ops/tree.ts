// A tree space, served by the same handlers as today's: its writer takes today's requests
// (storage's tree/plan.ts), and its reader shows the tree's tables under today's names, so one
// handler per entry decides, plans and answers for both backends. Only test and trial spaces are
// trees until the switch; an entry, a field or an operation whose family has not moved yet is
// refused on them by name.
import { AppError, type AnyEntry } from "@ttasks/contracts";
import type { Operation, Query, SpaceWriterHandle, WorkerConnection } from "@ttasks/storage";
import { planGap } from "@ttasks/storage";

/** Whether a space is a tree: its writer or its reader says so. */
export const isTree = (space: {
  readonly writer?: Pick<SpaceWriterHandle, "backend"> | undefined;
  readonly reader?: Pick<WorkerConnection, "backend"> | undefined;
}): boolean => space.writer?.backend === "tree" || space.reader?.backend === "tree";

/** The refusal of an entry, a field or a form whose family has not moved to the tree yet. */
export const notOnTreeYet = (what: string): AppError =>
  new AppError({
    code: "op_unknown",
    message: `${what} does not work on a tree space yet.`,
    hint: "Use a space made before the tree, or wait for the step that moves it.",
  });

/** The entries a tree space serves, with the fields of each whose family has not moved yet. */
const ON_TREE: Readonly<Record<string, readonly string[]>> = {
  "task.add": [],
  "task.update": ["folder", "add_sources", "remove_sources", "put_back_sources"],
  "task.finish": [],
  "task.reopen": [],
  "task.delete": [],
  "task.get": ["launch", "notes"],
  "entry.add": [],
  "entry.edit": [],
  "note.remove": [],
  "node.instruct": [],
  "history.undo": [],
  "history.redo": [],
  "page.write": [],
  "page.read": [],
  "page.history": [],
  "page.trashed": [],
  "receipt.get": [],
};

/** Refuses on a tree space an entry, or a field of one, that the tree does not take yet. */
export function checkOnTree(entry: AnyEntry, input: Record<string, unknown>): void {
  const later = ON_TREE[entry.name];
  if (later === undefined) throw notOnTreeYet(entry.name);
  const listed = (key: string, value: string) =>
    Array.isArray(input[key]) && (input[key] as unknown[]).includes(value) ? value : undefined;
  const field =
    later.find((key) => input[key] !== undefined) ??
    listed("clear", "folder") ??
    // A task's history is read from today's commits; the tree's comes with the reads.
    (entry.name === "task.get" ? listed("sections", "history") : undefined);
  if (field !== undefined) throw notOnTreeYet(`${entry.name} with ${field}`);
}

/** Refuses a plan with an operation, or a field of one, that the tree does not take yet. */
export function checkPlan(entry: AnyEntry, ops: readonly Operation[]): void {
  for (const op of ops) {
    const gap = planGap(op);
    if (gap !== undefined) throw notOnTreeYet(`${entry.name} with ${gap}`);
  }
}

// The tree's tables under the names today's reads use. Each statement is prefixed with common
// table expressions named as today's tables; inside them `main.` names the tree's own. A task under
// a top-level project is in that project as its area; under a project inside one, in both.

/** A task's field versions or provenance: its node row's under today's names, with its task row's. */
const FIELD_SEQS = (map: "fp" | "fv") =>
  `json_patch(t.${map}, json_object('title', json_extract(n.${map}, '$.title'), ` +
  `'summary', json_extract(n.${map}, '$.brief'), ` +
  `'context', json_extract(n.${map}, '$.description'), ` +
  `'grouping', json_extract(n.${map}, '$.place'), ` +
  `'deleted', json_extract(n.${map}, '$.deleted')))`;

const TASKS =
  "tasks AS (SELECT t.id, t.ref, n.title, n.brief AS summary, n.description AS context, " +
  "t.lifecycle, t.status, t.inbox, t.priority, t.effort, t.due_date, t.due_at, t.due_tz, " +
  "t.focus_on, t.waiting_on, t.completed_at, t.completed_by, t.outcome, t.archived_reason, " +
  "t.wrap_state, t.reviewed_at, n.touched, max(n.version, t.version) AS version, n.deleted_at, " +
  `n.deleted_by, n.created_at, n.created_by, t.created_seq, ${FIELD_SEQS("fp")} AS fp, ` +
  `${FIELD_SEQS("fv")} AS fv, n.position, ` +
  "CASE WHEN p.kind = 'project' THEN coalesce(g.id, p.id) END AS area_id, " +
  "CASE WHEN p.kind = 'project' AND g.id IS NOT NULL THEN p.id END AS project_id " +
  "FROM main.tasks t JOIN main.nodes n ON n.id = t.id LEFT JOIN main.nodes p ON p.id = n.parent_id " +
  "LEFT JOIN main.nodes g ON g.id = p.parent_id AND g.kind = 'project' WHERE n.kind = 'task')";

const GROUP_COLUMNS =
  "n.id, n.slug, n.title, n.brief, n.color, n.position, n.deleted_at, n.created_seq, n.version, " +
  "n.fv, n.fp, CASE WHEN n.archived_at IS NULL THEN 'active' ELSE 'archived' END AS lifecycle";

/** What a node is by today's kinds: the space, an area at the top, or a project inside one. */
const KIND_OF = (n: string, above: string) =>
  `CASE ${n}.kind WHEN 'project' THEN CASE ${above}.kind WHEN 'space' THEN 'area' ` +
  `ELSE 'project' END ELSE ${n}.kind END`;

const PAGES =
  `pages AS (SELECT p.id, p.ref, ${KIND_OF("o", "a")} AS owner_kind, p.owner_id, p.title, ` +
  "p.brief, p.body, p.created_at, p.created_by, p.deleted_at, p.deleted_by, p.created_seq, " +
  "p.version, p.fv, p.fp FROM main.pages p JOIN main.nodes o ON o.id = p.owner_id " +
  "LEFT JOIN main.nodes a ON a.id = o.parent_id)";

/**
 * A node's texts, once they were written: the space's brief is here, an area's and a project's in
 * their own rows.
 */
const NODE_TEXTS =
  `node_texts AS (SELECT n.id AS owner_id, ${KIND_OF("n", "a")} AS owner_kind, ` +
  "CASE n.kind WHEN 'space' THEN n.brief ELSE '' END AS brief, n.description, n.for_agents, " +
  "n.created_seq, n.version, n.fv, n.fp FROM main.nodes n LEFT JOIN main.nodes a " +
  "ON a.id = n.parent_id WHERE (n.kind = 'space' AND json_type(n.fv, '$.brief') IS NOT NULL) " +
  "OR (n.kind IN ('space', 'project') AND (json_type(n.fv, '$.description') IS NOT NULL " +
  "OR json_type(n.fv, '$.for_agents') IS NOT NULL)))";

const AREAS =
  `areas AS (SELECT ${GROUP_COLUMNS} FROM main.nodes n JOIN main.nodes s ON s.id = n.parent_id ` +
  "WHERE n.kind = 'project' AND s.kind = 'space')";

const PROJECTS =
  `projects AS (SELECT ${GROUP_COLUMNS}, n.parent_id AS area_id FROM main.nodes n ` +
  "JOIN main.nodes a ON a.id = n.parent_id WHERE n.kind = 'project' AND a.kind = 'project')";

/**
 * Today's area and project of the tree's node `$p` (an SQL expression), as JSON: a task under a
 * project at the top is in that area; under a project inside one, in both.
 */
const GROUPING = (p: string) =>
  `(SELECT json_object('area_id', CASE WHEN g.kind = 'project' THEN g.id ELSE x.id END, ` +
  `'project_id', CASE WHEN g.kind = 'project' THEN x.id END) FROM main.nodes x ` +
  `LEFT JOIN main.nodes g ON g.id = x.parent_id WHERE x.id = ${p} AND x.kind = 'project')`;

/** A place's change as today's `grouping`: the area and project before or after it. */
const AS_GROUPING = (side: "before" | "after") =>
  `coalesce(${GROUPING(`json_extract(c.${side}, '$.parent_id')`)}, ` +
  `json_object('area_id', NULL, 'project_id', NULL))`;

/**
 * The tree's changes under today's names: a task's node row and its task row are today's `tasks`,
 * a project's node row an area's or a project's, a node's texts its `node_texts`, a note by its
 * kind, a link a task's source. A place is today's `grouping`, an archive its lifecycle, a task's
 * brief and description its summary and context. A task's create is one row, as today's.
 */
const CHANGES =
  "changes AS (SELECT c.seq, c.n, c.op, CASE " +
  "WHEN c.entity = 'nodes' AND c.field IN ('description', 'for_agents') THEN 'node_texts' " +
  "WHEN c.entity = 'nodes' AND nk.kind = 'space' AND c.field = 'brief' THEN 'node_texts' " +
  "WHEN c.entity = 'nodes' AND nk.kind = 'task' THEN 'tasks' " +
  "WHEN c.entity = 'nodes' AND nk.kind = 'project' THEN " +
  "CASE pk.kind WHEN 'space' THEN 'areas' ELSE 'projects' END " +
  "WHEN c.entity = 'notes' THEN CASE nt.kind WHEN 'note' THEN 'notes' " +
  "WHEN 'learning' THEN 'learnings' ELSE 'log_entries' END " +
  "WHEN c.entity = 'links' THEN 'task_sources' ELSE c.entity END AS entity, " +
  "c.entity_id, CASE WHEN substr(c.node_id, 1, 2) = 't_' THEN c.node_id END AS task_id, " +
  "c.node_id, c.action, CASE WHEN c.entity = 'nodes' AND nk.kind IN ('task', 'project') THEN " +
  "CASE c.field WHEN 'brief' THEN CASE nk.kind WHEN 'task' THEN 'summary' ELSE 'brief' END " +
  "WHEN 'description' THEN CASE nk.kind WHEN 'task' THEN 'context' ELSE 'description' END " +
  "WHEN 'place' THEN 'grouping' WHEN 'archived' THEN 'lifecycle' ELSE c.field END " +
  "ELSE c.field END AS field, " +
  "CASE WHEN c.entity = 'nodes' AND c.field = 'place' THEN " +
  `${AS_GROUPING("before")} WHEN c.entity = 'nodes' AND c.field = 'archived' THEN ` +
  "CASE WHEN json_extract(c.before, '$') IS NULL THEN '\"active\"' ELSE '\"archived\"' END " +
  "ELSE c.before END AS before, " +
  "CASE WHEN c.entity = 'nodes' AND c.field = 'place' THEN " +
  `${AS_GROUPING("after")} WHEN c.entity = 'nodes' AND c.field = 'archived' THEN ` +
  "CASE WHEN json_extract(c.after, '$') IS NULL THEN '\"active\"' ELSE '\"archived\"' END " +
  "WHEN c.entity = 'nodes' AND c.action = 'create' AND nk.kind = 'task' THEN " +
  `json_patch(c.after, ${AS_GROUPING("after")}) ELSE c.after END AS after, ` +
  "c.before_ver, c.before_prov, c.after_prov FROM main.changes c " +
  "LEFT JOIN main.nodes nk ON c.entity = 'nodes' AND nk.id = c.entity_id " +
  "LEFT JOIN main.nodes pk ON pk.id = nk.parent_id " +
  "LEFT JOIN main.notes nt ON c.entity = 'notes' AND nt.id = c.entity_id " +
  "WHERE NOT (c.entity = 'tasks' AND c.action = 'create'))";

/** A tree space keeps no aliases: none is found. */
const ALIASES =
  "aliases AS (SELECT NULL AS namespace, NULL AS alias, NULL AS entity_kind, NULL AS entity_id " +
  "WHERE 0)";

const VIEWS = [TASKS, AREAS, PROJECTS, PAGES, NODE_TEXTS, CHANGES, ALIASES].join(", ");

/** A statement of today's reads as it runs on a tree space. */
export function treeSql(sql: string): string {
  const own = /^\s*WITH(\s+RECURSIVE)?\s/iu.exec(sql);
  if (own === null) return `WITH ${VIEWS} ${sql}`;
  return `WITH${own[1] ?? ""} ${VIEWS}, ${sql.slice(own[0].length)}`;
}

const views = new WeakMap<WorkerConnection, WorkerConnection>();
const tables = new WeakMap<WorkerConnection, WorkerConnection>();

/**
 * A space's reader as the request path reads it: a tree space's with its tables under today's
 * names, the same connection for each call; today's as it is. It reads; a write goes through the
 * writer.
 */
export function servedReader(reader: WorkerConnection): WorkerConnection {
  if (reader.backend !== "tree") return reader;
  const known = views.get(reader);
  if (known !== undefined) return known;
  const named = (q: Query): Query => ({ ...q, sql: treeSql(q.sql) });
  const view = new Proxy(reader, {
    get(target, key) {
      switch (key) {
        case "transaction":
          return (mode: Parameters<WorkerConnection["transaction"]>[0], queries: Query[]) =>
            target.transaction(mode, queries.map(named));
        case "get":
          return (sql: string, params?: Parameters<WorkerConnection["get"]>[1]) =>
            target.get(treeSql(sql), params);
        case "all":
          return (sql: string, params?: Parameters<WorkerConnection["all"]>[1]) =>
            target.all(treeSql(sql), params);
        default: {
          // Its own methods run on the reader itself, whose fields are private.
          const value = Reflect.get(target, key) as unknown;
          return typeof value === "function" ? (value as () => unknown).bind(target) : value;
        }
      }
    },
  });
  views.set(reader, view);
  tables.set(view, reader);
  return view;
}

/** The tree's own tables behind a served reader, for the reads written for the tree. */
export const treeTables = (reader: WorkerConnection): WorkerConnection =>
  tables.get(reader) ?? reader;
