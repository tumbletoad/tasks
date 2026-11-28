// The projection's reads: one read transaction on a reader connection of the
// space, so a batch sees one snapshot T, the `last_seq` of that transaction. Constant statements,
// values bound as parameters; a batch's task IDs travel as one JSON array.
//
// Only what the projection shows is read: notes for every audience (notes with an
// audience other than `all` are never written), live child rows, and the area and project slugs.
// A task that is deleted, or that no row names any more (redaction), reads as gone, and its
// files go with it.
import {
  decideLaunchFolder,
  decodeSpaceRow,
  foldersOf,
  type Connection,
  type FolderView,
  type Row,
} from "@ttasks/storage";
import {
  LIFECYCLES,
  type Groups,
  type Lifecycle,
  type LogInput,
  type FolderInput,
  type NoteInput,
  type SourceInput,
  type SpaceIdentity,
  type TaskInput,
} from "./render.ts";

const IDS = "(SELECT value FROM json_each($ids))";
/** Tasks whose file could not be placed, each waiting its pause (projector.ts): not read yet. */
const WAITING = "key NOT IN (SELECT value FROM json_each($waiting))";

const SQL = {
  space: "SELECT * FROM space WHERE one = 1",
  // Tasks that failed before come after every task that did not, oldest first within each.
  dirty:
    `SELECT key, first_seq FROM outbox WHERE topic = 'projection' AND key <> '*' AND ${WAITING} ` +
    "ORDER BY key IN (SELECT value FROM json_each($retried)), first_seq, key LIMIT $limit",
  all: "SELECT 1 AS dirty FROM outbox WHERE topic = 'projection' AND key = '*'",
  pending:
    "SELECT count(*) AS n, coalesce(max(seq), 0) AS newest FROM outbox " +
    `WHERE topic = 'projection' AND ${WAITING}`,
  held:
    "SELECT count(*) AS n FROM outbox WHERE topic = 'projection' " +
    "AND key IN (SELECT value FROM json_each($waiting))",
  tasks:
    "SELECT t.id, t.ref, t.title, t.summary, t.context, t.lifecycle, t.status, t.priority, " +
    "t.waiting_on, t.effort, t.due_date, t.due_at, t.completed_at, t.created_at, " +
    "t.outcome, t.archived_reason, t.deleted_at, t.version, t.touched, t.project_id, " +
    "coalesce(a.slug, pa.slug) AS area, p.slug AS project FROM tasks t " +
    "LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN areas a ON a.id = t.area_id " +
    `LEFT JOIN areas pa ON pa.id = p.area_id WHERE t.id IN ${IDS}`,
  notes:
    "SELECT n.task_id, n.ordinal, n.addressee, n.body, n.created_at, CASE WHEN EXISTS " +
    "(SELECT 1 FROM commits k WHERE k.seq = n.created_seq AND k.origin = 'import') " +
    "THEN 'import' ELSE x.label END AS author FROM notes n JOIN actors x ON x.id = n.author_id " +
    `WHERE n.task_id IN ${IDS} AND n.deleted_at IS NULL AND n.audience = 'all' ` +
    "ORDER BY n.task_id, n.ordinal",
  log:
    "SELECT l.task_id, l.ordinal, l.kind, l.body, l.created_at, CASE WHEN EXISTS " +
    "(SELECT 1 FROM commits k WHERE k.seq = l.created_seq AND k.origin = 'import') " +
    "THEN 'import' ELSE x.label END AS author FROM log_entries l " +
    `JOIN actors x ON x.id = l.author_id WHERE l.task_id IN ${IDS} AND l.deleted_at IS NULL ` +
    "ORDER BY l.task_id, l.ordinal",
  sources:
    "SELECT ts.task_id, s.kind, s.title, s.who, s.ref, s.url, s.at, s.source_key " +
    `FROM task_sources ts JOIN sources s ON s.id = ts.source_id WHERE ts.task_id IN ${IDS} ` +
    "AND ts.removed_at IS NULL AND s.deleted_at IS NULL ORDER BY ts.task_id, ts.position",
  machines: "SELECT id, name FROM machines",
  labels:
    "SELECT tl.task_id, l.slug FROM task_labels tl JOIN labels l ON l.id = tl.label_id " +
    `WHERE tl.task_id IN ${IDS} AND tl.removed_at IS NULL AND l.deleted_at IS NULL ` +
    "ORDER BY tl.task_id, l.slug",
  learnings:
    `SELECT task_id, body FROM learnings WHERE task_id IN ${IDS} AND deleted_at IS NULL ` +
    "ORDER BY task_id, position, id",
  areas: "SELECT slug, title FROM areas WHERE deleted_at IS NULL ORDER BY position, id",
  projects:
    "SELECT p.slug, p.title, a.slug AS area FROM projects p LEFT JOIN areas a " +
    "ON a.id = p.area_id WHERE p.deleted_at IS NULL ORDER BY p.position, p.id",
  missing: `SELECT value AS id FROM json_each($ids) WHERE value NOT IN (SELECT id FROM tasks)`,
} as const;

/** What one batch reads at its snapshot. */
export interface BatchRead {
  readonly space: SpaceIdentity & { readonly refPrefix: string };
  /** The snapshot T: `last_seq` of the read transaction. */
  readonly seq: number;
  /** The dirty task keys, oldest `first_seq` first, at most the batch's limit. */
  readonly keys: readonly string[];
  /** Each dirty task that the projection shows. A key without one is gone. */
  readonly tasks: ReadonlyMap<string, TaskInput>;
  /** Whether `*` is dirty: the catalogue or an index changed. */
  readonly all: boolean;
  readonly groups: Groups;
}

/** A cheap look at the outbox, for the projection's schedule. */
export interface Pending {
  readonly spaceId: string;
  readonly epoch: number;
  readonly incarnation: string;
  readonly lastSeq: number;
  /** Projection rows to render, `*` included, those of tasks waiting their pause left out. */
  readonly rows: number;
  /** The newest commit a waiting row stands for. */
  readonly newest: number;
  /** Rows of tasks waiting their pause: they hold the watermark below them. */
  readonly held: number;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const numOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

function lifecycleOf(value: unknown): Lifecycle {
  return (LIFECYCLES as readonly unknown[]).includes(value) ? (value as Lifecycle) : "active";
}

/**
 * Where the task opens on each machine that has its folder or its project's: the folder storage's
 * launch rule picks there, the one Open uses. By machine name.
 */
function foldersOpened(
  conn: Connection,
  task: string,
  project: string | null,
  machines: ReadonlyMap<string, string>,
): FolderInput[] {
  const own = foldersOf(conn, "task", task);
  const inherited = project === null ? [] : foldersOf(conn, "project", project);
  const on = new Set<string>([...own, ...inherited].map((f: FolderView) => f.machine));
  const opened: FolderInput[] = [];
  for (const machine of on) {
    const decided = decideLaunchFolder(own, inherited, machine, (id) => machines.get(id));
    if (decided.kind !== "task" && decided.kind !== "project") continue;
    opened.push({ machine: machines.get(machine) ?? machine, path: decided.folder.path });
  }
  return opened.sort((a, b) => (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0));
}

/** Rows grouped by their `task_id`. */
function byTask<T>(rows: readonly Row[], map: (row: Row) => T): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = str(row["task_id"]);
    const list = grouped.get(id) ?? [];
    list.push(map(row));
    grouped.set(id, list);
  }
  return grouped;
}

function spaceOf(conn: Connection): SpaceIdentity & { refPrefix: string; lastSeq: number } {
  const space = decodeSpaceRow(conn.prepare(SQL.space).get());
  return {
    spaceId: space.spaceId,
    epoch: space.authority.epoch,
    incarnation: space.authority.incarnation,
    refPrefix: space.refPrefix,
    lastSeq: space.lastSeq,
  };
}

/** The outbox's state, in one read transaction, without the rows of the `waiting` tasks. */
export function readPending(conn: Connection, waiting: readonly string[] = []): Pending {
  return conn.transaction("deferred", () => {
    const space = spaceOf(conn);
    const params = { waiting: JSON.stringify(waiting) };
    const row = conn.prepare(SQL.pending).get(params);
    const held = waiting.length === 0 ? undefined : conn.prepare(SQL.held).get(params);
    return {
      spaceId: space.spaceId,
      epoch: space.epoch,
      incarnation: space.incarnation,
      lastSeq: space.lastSeq,
      rows: num(row?.["n"]),
      newest: num(row?.["newest"]),
      held: num(held?.["n"]),
    };
  });
}

/**
 * Of `ids`, those no task row has: tasks the projection's record names that the space no longer
 * has (another identity of it, a redaction), so a full rebuild queues them and their files retire.
 */
export function missingTasks(conn: Connection, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  return conn
    .prepare(SQL.missing)
    .all({ ids: JSON.stringify(ids) })
    .map((row) => str(row["id"]));
}

/**
 * One batch at one snapshot: at most `limit` dirty tasks, oldest first, none of
 * the `waiting` tasks (in their pause), and the `retried` ones (whose file could not be placed
 * before) only after every other: tasks that cannot be placed never fill a batch.
 */
export function readBatch(
  conn: Connection,
  limit: number,
  waiting: readonly string[] = [],
  retried: readonly string[] = [],
): BatchRead {
  return conn.transaction("deferred", () => {
    const space = spaceOf(conn);
    const keys = conn
      .prepare(SQL.dirty)
      .all({ limit, waiting: JSON.stringify(waiting), retried: JSON.stringify(retried) })
      .map((row) => str(row["key"]));
    const all = conn.prepare(SQL.all).get() !== undefined;
    const params = { ids: JSON.stringify(keys) };
    const notes = byTask<NoteInput>(conn.prepare(SQL.notes).all(params), (row) => ({
      ordinal: num(row["ordinal"]),
      addressee: str(row["addressee"]),
      author: str(row["author"]),
      at: num(row["created_at"]),
      body: str(row["body"]),
    }));
    const log = byTask<LogInput>(conn.prepare(SQL.log).all(params), (row) => ({
      ordinal: num(row["ordinal"]),
      kind: str(row["kind"]),
      author: str(row["author"]),
      at: num(row["created_at"]),
      body: str(row["body"]),
    }));
    const sources = byTask<SourceInput>(conn.prepare(SQL.sources).all(params), (row) => ({
      kind: str(row["kind"]),
      title: str(row["title"]),
      who: strOrNull(row["who"]),
      ref: strOrNull(row["ref"]),
      url: strOrNull(row["url"]),
      at: numOrNull(row["at"]),
      key: strOrNull(row["source_key"]),
    }));
    const machines = new Map(
      conn
        .prepare(SQL.machines)
        .all()
        .map((row) => [str(row["id"]), str(row["name"])]),
    );
    const labels = byTask(conn.prepare(SQL.labels).all(params), (row) => str(row["slug"]));
    const learnings = byTask(conn.prepare(SQL.learnings).all(params), (row) => str(row["body"]));
    const tasks = new Map<string, TaskInput>();
    for (const row of conn.prepare(SQL.tasks).all(params)) {
      if (row["deleted_at"] !== null) continue;
      const id = str(row["id"]);
      const dueAt = numOrNull(row["due_at"]);
      tasks.set(id, {
        id,
        ref: num(row["ref"]),
        title: str(row["title"]),
        summary: str(row["summary"]),
        context: str(row["context"]),
        lifecycle: lifecycleOf(row["lifecycle"]),
        status: str(row["status"]),
        waitingOn: strOrNull(row["waiting_on"]),
        priority: num(row["priority"]),
        effort: strOrNull(row["effort"]),
        due:
          strOrNull(row["due_date"]) ??
          (dueAt === null ? null : new Date(dueAt).toISOString().replace(".000Z", "Z")),
        area: strOrNull(row["area"]),
        project: strOrNull(row["project"]),
        version: num(row["version"]),
        touched: num(row["touched"]),
        createdAt: num(row["created_at"]),
        completedAt: numOrNull(row["completed_at"]),
        outcome: strOrNull(row["outcome"]),
        dropped: strOrNull(row["archived_reason"]),
        labels: labels.get(id) ?? [],
        folders: foldersOpened(conn, id, strOrNull(row["project_id"]), machines),
        notes: notes.get(id) ?? [],
        log: log.get(id) ?? [],
        sources: sources.get(id) ?? [],
        learnings: learnings.get(id) ?? [],
      });
    }
    const groups: Groups = {
      areas: conn
        .prepare(SQL.areas)
        .all()
        .map((row) => ({ slug: str(row["slug"]), title: str(row["title"]) })),
      projects: conn
        .prepare(SQL.projects)
        .all()
        .map((row) => ({
          slug: str(row["slug"]),
          title: str(row["title"]),
          area: strOrNull(row["area"]),
        })),
    };
    return {
      space: {
        spaceId: space.spaceId,
        epoch: space.epoch,
        incarnation: space.incarnation,
        refPrefix: space.refPrefix,
      },
      seq: space.lastSeq,
      keys,
      tasks,
      all,
      groups,
    };
  });
}
