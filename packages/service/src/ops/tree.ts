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
  "task.get": ["sections", "launch", "notes", "before"],
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
  const field =
    later.find((key) => input[key] !== undefined) ??
    (Array.isArray(input["clear"]) && input["clear"].includes("folder") ? "folder" : undefined);
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

const TASKS =
  "tasks AS (SELECT t.id, t.ref, n.title, n.brief AS summary, n.description AS context, " +
  "t.lifecycle, t.status, t.inbox, t.priority, t.effort, t.due_date, t.due_at, t.due_tz, " +
  "t.focus_on, t.waiting_on, t.completed_at, t.completed_by, t.outcome, t.archived_reason, " +
  "t.wrap_state, t.reviewed_at, n.touched, max(n.version, t.version) AS version, n.deleted_at, " +
  "n.deleted_by, n.created_at, n.created_by, t.created_seq, t.fp, n.position, " +
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

/** A node's texts change on its node row; today's name them as the texts' own. */
const CHANGES =
  "changes AS (SELECT c.seq, c.n, 0 AS op, CASE WHEN c.entity = 'nodes' AND c.action = 'set' " +
  "AND c.field IN ('description', 'for_agents') THEN 'node_texts' ELSE c.entity END AS entity, " +
  "c.entity_id, CASE WHEN substr(c.node_id, 1, 2) = 't_' THEN c.node_id END AS task_id, " +
  "c.node_id, c.action, c.field, c.before, c.after, c.before_ver, c.before_prov, c.after_prov " +
  "FROM main.changes c)";

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
