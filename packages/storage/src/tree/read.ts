// Reading a task of a tree space with what is known above it: one walk up the parents gives the
// trail, nearest level first, and one walk down gives its subtasks. Briefs, notes and texts are
// returned as stored; a caller frames them as data.
import type { Connection, Row } from "../driver.ts";
import { formatTaskRef, parseTaskRef } from "../refs.ts";

const SQL = {
  prefix: "SELECT ref_prefix FROM space WHERE one = 1",
  byRef: "SELECT id FROM tasks WHERE ref = $ref",
  task:
    "SELECT n.id, n.parent_id, n.title, n.brief, n.description, n.deleted_at, n.version AS node_version, " +
    "t.ref, t.lifecycle, t.status, t.inbox, t.priority, t.outcome, t.version " +
    "FROM nodes n JOIN tasks t ON t.id = n.id WHERE n.id = $id",
  /** Every level above `$id`, nearest first, up to the space. */
  trail:
    "WITH RECURSIVE up(id, depth) AS (SELECT parent_id, 1 FROM nodes WHERE id = $id " +
    "UNION ALL SELECT n.parent_id, depth + 1 FROM nodes n JOIN up ON n.id = up.id " +
    "WHERE n.parent_id IS NOT NULL) " +
    "SELECT n.id, n.kind, n.title, n.brief, n.for_agents, t.ref FROM up JOIN nodes n ON n.id = up.id " +
    "LEFT JOIN tasks t ON t.id = n.id ORDER BY up.depth",
  subtasks:
    "SELECT n.id, n.title, t.ref, t.lifecycle FROM nodes n JOIN tasks t ON t.id = n.id " +
    "WHERE n.parent_id = $id AND n.deleted_at IS NULL ORDER BY n.position",
  notes:
    "SELECT ordinal, kind, for_agents, author_id, body, created_at FROM notes " +
    "WHERE owner_id = $id AND deleted_at IS NULL ORDER BY ordinal",
} as const;

export interface TrailLevel {
  id: string;
  kind: "space" | "project" | "task";
  title: string;
  brief: string;
  /** The person's text for agents on that level; empty when none. */
  for_agents: string;
  ref?: string;
}

export interface TreeTask {
  id: string;
  ref: string;
  title: string;
  brief: string;
  description: string;
  lifecycle: string;
  status: string;
  inbox: boolean;
  priority: number;
  outcome: string | null;
  in_trash: boolean;
  /** The highest version of its rows: the base for an edit of what this read showed. */
  version: number;
  /** From the task's parent up to the space. */
  trail: TrailLevel[];
  subtasks: { id: string; ref: string; title: string; lifecycle: string }[];
  notes: {
    ordinal: number;
    kind: string;
    for_agents: boolean;
    author: string;
    body: string;
    at: number;
  }[];
}

/** A task by ID or reference with its trail, or undefined when the space has none. */
export function readTreeTask(conn: Connection, key: string): TreeTask | undefined {
  return conn.transaction("deferred", () => {
    const prefix = String(conn.prepare(SQL.prefix).get()?.["ref_prefix"]);
    const ref = parseTaskRef(key);
    const id = ref === undefined ? key : conn.prepare(SQL.byRef).get({ ref: ref.ref })?.["id"];
    if (typeof id !== "string" || (ref !== undefined && ref.prefix !== prefix)) return undefined;
    const row = conn.prepare(SQL.task).get({ id });
    if (row === undefined) return undefined;
    const refOf = (r: Row) => formatTaskRef(prefix, Number(r["ref"]));
    return {
      id,
      ref: refOf(row),
      title: String(row["title"]),
      brief: String(row["brief"]),
      description: String(row["description"]),
      lifecycle: String(row["lifecycle"]),
      status: String(row["status"]),
      inbox: row["inbox"] === 1,
      priority: Number(row["priority"]),
      outcome: typeof row["outcome"] === "string" ? row["outcome"] : null,
      in_trash: row["deleted_at"] !== null,
      version: Math.max(Number(row["version"]), Number(row["node_version"])),
      trail: conn
        .prepare(SQL.trail)
        .all({ id })
        .map((r) => ({
          id: String(r["id"]),
          kind: r["kind"] as TrailLevel["kind"],
          title: String(r["title"]),
          brief: String(r["brief"]),
          for_agents: String(r["for_agents"]),
          ...(typeof r["ref"] === "number" ? { ref: refOf(r) } : {}),
        })),
      subtasks: conn
        .prepare(SQL.subtasks)
        .all({ id })
        .map((r) => ({
          id: String(r["id"]),
          ref: refOf(r),
          title: String(r["title"]),
          lifecycle: String(r["lifecycle"]),
        })),
      notes: conn
        .prepare(SQL.notes)
        .all({ id })
        .map((r) => ({
          ordinal: Number(r["ordinal"]),
          kind: String(r["kind"]),
          for_agents: r["for_agents"] === 1,
          author: String(r["author_id"]),
          body: String(r["body"]),
          at: Number(r["created_at"]),
        })),
    };
  });
}
