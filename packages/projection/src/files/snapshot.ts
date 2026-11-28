// The tree's rows the readable files show, read in one read transaction of a tree space: snapshot
// S, the `last_seq` of that transaction. Only what is live is read; a row the Trash took, a note
// taken back and a link removed are not. Folders are this machine's only: the files are written on
// the space's home, and a folder on another machine opens nothing there.
import type { Connection, Row } from "@ttasks/storage";

export type NodeKind = "space" | "project" | "task" | "routine";
export type Lifecycle = "active" | "completed" | "archived";

/** What a task and a routine have beyond a node. */
export interface TaskFields {
  readonly ref: number;
  readonly lifecycle: Lifecycle;
  readonly status: string;
  readonly inbox: boolean;
  readonly priority: number;
  readonly effort: string | null;
  /** An ISO date, or the ISO instant of a due time. */
  readonly due: string | null;
  readonly waitingOn: string | null;
  readonly completedAt: number | null;
  readonly outcome: string | null;
  /** Why a dropped task was dropped. */
  readonly dropped: string | null;
}

export interface RoutineFields {
  readonly rule: string;
  readonly tz: string;
  /** The open time: an ISO date, or the ISO instant of a time of day. */
  readonly next: string;
  /** The agent instance that does it, null for the person. */
  readonly instance: string | null;
  readonly paused: boolean;
}

export interface SnapshotNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly parent: string | null;
  readonly position: string;
  readonly title: string;
  readonly brief: string;
  readonly description: string;
  readonly forAgents: string;
  readonly slug: string | null;
  readonly archivedAt: number | null;
  /** The commit of its last change, and that commit's time. */
  readonly touched: number;
  readonly changedAt: number;
  readonly task: TaskFields | null;
  readonly routine: RoutineFields | null;
}

export interface SnapshotPage {
  readonly id: string;
  readonly ref: number;
  readonly owner: string;
  readonly title: string;
  readonly brief: string;
  readonly body: string;
  readonly version: number;
  readonly changedAt: number;
  /** The label of the last change's author. */
  readonly changedBy: string;
}

export interface SnapshotSource {
  readonly id: string;
  readonly ref: number;
  readonly owner: string;
  readonly kind: string;
  readonly title: string;
  readonly brief: string;
  readonly body: string;
  readonly who: string | null;
  readonly outsideRef: string | null;
  readonly url: string | null;
  readonly at: number | null;
  readonly key: string | null;
  readonly version: number;
  readonly changedAt: number;
}

export interface SnapshotLink {
  readonly owner: string;
  readonly target: string;
  readonly position: string;
}

export interface SnapshotNote {
  /** A node, or a page for its comments. */
  readonly owner: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly forAgents: boolean;
  readonly author: string;
  readonly body: string;
  readonly at: number;
}

export interface SnapshotFolder {
  readonly owner: string;
  readonly path: string;
  readonly isDefault: boolean;
  readonly label: string | null;
}

export interface SnapshotOccurrence {
  readonly routine: string;
  readonly due: string | null;
  readonly state: "done" | "skipped";
  readonly author: string;
  readonly at: number;
}

export interface Snapshot {
  /** S: every commit up to it is in these rows. */
  readonly seq: number;
  /** The time of commit S. */
  readonly at: number;
  readonly refPrefix: string;
  readonly spaceId: string;
  readonly nodes: readonly SnapshotNode[];
  readonly pages: readonly SnapshotPage[];
  readonly sources: readonly SnapshotSource[];
  readonly links: readonly SnapshotLink[];
  readonly notes: readonly SnapshotNote[];
  readonly folders: readonly SnapshotFolder[];
  readonly occurrences: readonly SnapshotOccurrence[];
}

const AT = (seq: string): string => `(SELECT k.at FROM commits k WHERE k.seq = ${seq})`;

const SQL = {
  space: `SELECT space_id, ref_prefix, last_seq, ${AT("last_seq")} AS at FROM space WHERE one = 1`,
  nodes:
    "SELECT n.id, n.kind, n.parent_id, n.position, n.title, n.brief, n.description, " +
    `n.for_agents, n.slug, n.archived_at, n.touched, ${AT("n.touched")} AS changed_at, ` +
    "t.ref, t.lifecycle, t.status, t.inbox, t.priority, t.effort, t.due_date, t.due_at, " +
    "t.waiting_on, t.completed_at, t.outcome, t.archived_reason, " +
    "r.rule, r.tz, r.due_date AS r_due_date, r.due_at AS r_due_at, r.instance, r.paused " +
    "FROM nodes n LEFT JOIN tasks t ON t.id = n.id LEFT JOIN routines r ON r.id = n.id " +
    "WHERE n.deleted_at IS NULL ORDER BY n.parent_id, n.position, n.id",
  pages:
    `SELECT p.id, p.ref, p.owner_id, p.title, p.brief, p.body, p.version, ${AT("p.version")} ` +
    "AS changed_at, (SELECT a.label FROM commits k JOIN actors a ON a.id = k.author_id " +
    "WHERE k.seq = p.version) AS changed_by FROM pages p WHERE p.deleted_at IS NULL ORDER BY p.ref",
  sources:
    "SELECT s.id, s.ref, s.owner_id, s.kind, s.title, s.brief, s.body, s.who, s.outside_ref, " +
    `s.url, s.at, s.source_key, s.version, ${AT("s.version")} AS changed_at FROM sources s ` +
    "WHERE s.deleted_at IS NULL ORDER BY s.ref",
  links:
    "SELECT owner_id, target_id, position FROM links WHERE removed_at IS NULL " +
    "ORDER BY owner_id, position, id",
  notes:
    "SELECT n.owner_id, n.ordinal, n.kind, n.for_agents, n.body, n.created_at, a.label AS author " +
    "FROM notes n JOIN actors a ON a.id = n.author_id WHERE n.deleted_at IS NULL " +
    "ORDER BY n.owner_id, n.ordinal",
  folders:
    "SELECT owner_id, path, is_default, label FROM folders WHERE deleted_at IS NULL " +
    "AND machine_id = $machine ORDER BY owner_id, is_default DESC, path, id",
  occurrences:
    "SELECT o.routine_id, o.due_date, o.due_at, o.state, o.at, a.label AS author " +
    "FROM occurrences o JOIN actors a ON a.id = o.actor_id WHERE o.deleted_at IS NULL " +
    "ORDER BY o.routine_id, o.at, o.id",
} as const;

const opt = (row: Row, key: string): string | null => {
  const value = row[key];
  if (typeof value === "string") return value;
  return typeof value === "number" || typeof value === "bigint" ? String(value) : null;
};
const str = (row: Row, key: string): string => opt(row, key) ?? "";
const num = (row: Row, key: string): number => Number(row[key] ?? 0);
const optNum = (row: Row, key: string): number | null => {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
};
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function nodeOf(row: Row): SnapshotNode {
  const kind = str(row, "kind") as NodeKind;
  const hasTask = kind === "task" || kind === "routine";
  return {
    id: str(row, "id"),
    kind,
    parent: opt(row, "parent_id"),
    position: str(row, "position"),
    title: str(row, "title"),
    brief: str(row, "brief"),
    description: str(row, "description"),
    forAgents: str(row, "for_agents"),
    slug: opt(row, "slug"),
    archivedAt: optNum(row, "archived_at"),
    touched: num(row, "touched"),
    changedAt: num(row, "changed_at"),
    task: hasTask
      ? {
          ref: num(row, "ref"),
          lifecycle: str(row, "lifecycle") as Lifecycle,
          status: str(row, "status"),
          inbox: num(row, "inbox") === 1,
          priority: num(row, "priority"),
          effort: opt(row, "effort"),
          due: opt(row, "due_date") ?? iso(optNum(row, "due_at")),
          waitingOn: opt(row, "waiting_on"),
          completedAt: optNum(row, "completed_at"),
          outcome: opt(row, "outcome"),
          dropped: opt(row, "archived_reason"),
        }
      : null,
    routine:
      kind === "routine" && row["rule"] !== null
        ? {
            rule: str(row, "rule"),
            tz: str(row, "tz"),
            next: iso(optNum(row, "r_due_at")) ?? str(row, "r_due_date"),
            instance: opt(row, "instance"),
            paused: num(row, "paused") === 1,
          }
        : null,
  };
}

/** The snapshot of a tree space, with the folders of `machine`. */
export function readSnapshot(conn: Connection, machine: string): Snapshot {
  return conn.transaction("deferred", () => {
    const space = conn.prepare(SQL.space).get() ?? {};
    return {
      seq: num(space, "last_seq"),
      at: num(space, "at"),
      refPrefix: str(space, "ref_prefix"),
      spaceId: str(space, "space_id"),
      nodes: conn.prepare(SQL.nodes).all().map(nodeOf),
      pages: conn
        .prepare(SQL.pages)
        .all()
        .map((r) => ({
          id: str(r, "id"),
          ref: num(r, "ref"),
          owner: str(r, "owner_id"),
          title: str(r, "title"),
          brief: str(r, "brief"),
          body: str(r, "body"),
          version: num(r, "version"),
          changedAt: num(r, "changed_at"),
          changedBy: str(r, "changed_by"),
        })),
      sources: conn
        .prepare(SQL.sources)
        .all()
        .map((r) => ({
          id: str(r, "id"),
          ref: num(r, "ref"),
          owner: str(r, "owner_id"),
          kind: str(r, "kind"),
          title: str(r, "title"),
          brief: str(r, "brief"),
          body: str(r, "body"),
          who: opt(r, "who"),
          outsideRef: opt(r, "outside_ref"),
          url: opt(r, "url"),
          at: optNum(r, "at"),
          key: opt(r, "source_key"),
          version: num(r, "version"),
          changedAt: num(r, "changed_at"),
        })),
      links: conn
        .prepare(SQL.links)
        .all()
        .map((r) => ({
          owner: str(r, "owner_id"),
          target: str(r, "target_id"),
          position: str(r, "position"),
        })),
      notes: conn
        .prepare(SQL.notes)
        .all()
        .map((r) => ({
          owner: str(r, "owner_id"),
          ordinal: num(r, "ordinal"),
          kind: str(r, "kind"),
          forAgents: num(r, "for_agents") === 1,
          author: str(r, "author"),
          body: str(r, "body"),
          at: num(r, "created_at"),
        })),
      folders: conn
        .prepare(SQL.folders)
        .all({ machine })
        .map((r) => ({
          owner: str(r, "owner_id"),
          path: str(r, "path"),
          isDefault: num(r, "is_default") === 1,
          label: opt(r, "label"),
        })),
      occurrences: conn
        .prepare(SQL.occurrences)
        .all()
        .map((r) => ({
          routine: str(r, "routine_id"),
          due: iso(optNum(r, "due_at")) ?? opt(r, "due_date"),
          state: str(r, "state") as "done" | "skipped",
          author: str(r, "author"),
          at: num(r, "at"),
        })),
    };
  });
}
