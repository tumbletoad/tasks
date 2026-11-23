// The change feed (A1 3.7 "Change feed (X8)", A5 3.15), read from a space's reader connection: a
// `snapshot` of the open working set with its cursor, then `batch`es of compact events, each with
// its coverage interval `(from, through]` and the cursor `(epoch, incarnation, seq)` it brings the
// subscriber to. Every read is one deferred transaction on the reader, so a snapshot and each batch
// see one state of the space. A batch's rows are as of its `through`: a row that a later commit
// changed, or that a commit hidden from the subscriber changed in the batch, is withheld (null).
//
// - A batch accounts for every commit in its interval, whether it carries it or leaves it out for a
//   subscriber that may not see it. `visible` is that filter: in v1 every commit is visible to
//   every local subscriber, so batches are never filtered, but a hidden commit already gives an
//   empty batch that still advances coverage, and the feed sends empty batches as heartbeats.
// - The compact form: each event names its commit (`seq`, `op_id`, `request_id`, actor, kind) and
//   the entities it touched, `{type, id, task?, row, changed, created?}`. `row` is the compact row
//   of a task, area or project (the working set's kinds) and null for the rest (notes, log
//   entries, sources, links, places, launches): a client refetches the task those touch. No body
//   of a note or log entry, no context, outcome or other long text is in the feed.
// - A task's compact row (ops/task-rows.ts) also carries what its row shows of its children
//   (A5 3.6): its first three sources with their own text and URL (`sources`), how many more it
//   has (`sources_more`), where it opens on this machine (`place`), from its own folder or its
//   project's, and whether its newest background run works or needs the person (`run`). A commit
//   that changes a source, a link, a folder or a run of a task therefore carries the task's row
//   too, as an entity of its own, and one that changes a project's folder carries the rows of the
//   project's tasks the batch holds, so the row the client holds never shows a source, a folder
//   or a run state the space no longer has.
import type { PreferenceRead } from "@ttasks/contracts";
import type { Row, WorkerConnection } from "@ttasks/storage";
import { hasFolderTable } from "../ops/read.ts";
import {
  compact,
  taskColumns,
  taskRows,
  type CompactRow,
  type FeedHere,
} from "../ops/task-rows.ts";
import { PREFERENCE_ROWS, spacePreferencesOf } from "../ops/preferences.ts";

export type { FeedHere } from "../ops/task-rows.ts";

/** The applied-through cursor (A1 3.7). */
export interface Cursor {
  readonly epoch: number;
  readonly incarnation: string;
  readonly seq: number;
}

export interface SpaceHead {
  readonly id: string;
  readonly name: string;
  readonly ref_prefix: string;
  readonly cursor: Cursor;
}

export interface FeedEntity {
  readonly type: string;
  readonly id: string;
  readonly task?: string;
  readonly row: CompactRow | null;
  readonly changed: readonly string[];
  readonly created?: true;
}

export interface FeedEvent {
  readonly seq: number;
  readonly op_id: string;
  readonly request_id: string;
  readonly actor: { readonly kind: string; readonly label: string };
  readonly kind: string;
  readonly entities: readonly FeedEntity[];
}

/** Why the copy a page shows takes no change: the space's reason and its way out, for people. */
export interface SpaceReadOnly {
  readonly reason: string;
  readonly message?: string;
}

export interface SnapshotMessage {
  readonly type: "snapshot";
  readonly space: {
    readonly id: string;
    readonly name: string;
    readonly ref_prefix: string;
    /** The key of the copy it is of, which a subscription resumes by (the feed adds it: ws.ts). */
    readonly copy?: string;
    /** Set when the copy is read-only (the feed adds it: ws.ts). */
    readonly read_only?: SpaceReadOnly;
  };
  readonly cursor: Cursor;
  readonly tasks: readonly CompactRow[];
  readonly areas: readonly CompactRow[];
  readonly projects: readonly CompactRow[];
  /**
   * Every space preference and flag the registry declares, with its value as readers take it and
   * its state (A1 3.16, A5 3.15 step 1). A batch names a changed preference as an entity of type
   * `preference` without a row: the page takes a snapshot for its new value.
   */
  readonly preferences: readonly PreferenceRead[];
  /** Why a subscriber with a cursor got a snapshot instead of batches. */
  readonly reason?: "epoch" | "cursor_ahead";
}

export interface BatchMessage {
  readonly type: "batch";
  readonly space_id: string;
  readonly epoch: number;
  readonly incarnation: string;
  readonly from: number;
  readonly through: number;
  readonly events: readonly FeedEvent[];
}

/** What a commit looks like to the filter. */
export interface CommitFacts {
  readonly seq: number;
  readonly kind: string;
  readonly actor_kind: string;
  readonly origin: string;
}

/**
 * Which commits a subscriber may see. v1: every one (A1 3.7, "unfiltered in v1"). It filters
 * commits, and with them the rows a hidden commit in a batch touched. It does not filter state: a
 * snapshot, and a row that an earlier hidden commit shaped, show the space as it is. The audience
 * filter that M3.12 tests needs a row-level rule as well, applied to snapshots and rows.
 */
export type Visibility = (commit: CommitFacts) => boolean;
export const ALL_VISIBLE: Visibility = () => true;

/** A2's batch bound: at most this many commits in one batch. */
export const BATCH_COMMITS = 100;

const SPACE_SQL =
  "SELECT space_id, name, ref_prefix, authority_epoch, authority_incarnation, last_seq " +
  "FROM space WHERE one = 1";

const AREA_COLUMNS =
  "a.id, a.slug, a.title, a.position, a.color, a.lifecycle, a.deleted_at, a.version";
const PROJECT_COLUMNS =
  "p.id, p.area_id, p.slug, p.title, p.position, p.color, p.lifecycle, p.deleted_at, p.version";

const openTasks = (folders: boolean) =>
  `SELECT ${taskColumns(folders)} FROM tasks t WHERE t.lifecycle = 'active' AND t.deleted_at IS NULL ORDER BY t.position, t.id`;
const LIVE_AREAS = `SELECT ${AREA_COLUMNS} FROM areas a WHERE a.deleted_at IS NULL ORDER BY a.position, a.id`;
const LIVE_PROJECTS = `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.deleted_at IS NULL ORDER BY p.position, p.id`;

const IN_BATCH = "seq > $after AND seq <= $upto";
const COMMITS =
  "SELECT seq, id, request_id, kind, actor_kind, origin, principal_id FROM commits " +
  `WHERE ${IN_BATCH} ORDER BY seq`;
const CHANGES =
  "SELECT seq, n, entity, entity_id, task_id, action, field FROM changes " +
  `WHERE ${IN_BATCH} ORDER BY seq, n`;
const ACTORS = `SELECT id, kind, label FROM actors WHERE id IN (SELECT principal_id FROM commits WHERE ${IN_BATCH})`;
/** The entities a commit after the batch's reach touched: their rows are past its `through`. */
const LATER = "SELECT DISTINCT entity, entity_id, task_id FROM changes WHERE seq > $upto";
const touched = (entity: string) =>
  `SELECT entity_id FROM changes WHERE ${IN_BATCH} AND entity = '${entity}'`;
/** The tables whose rows a task's compact row shows (A5 3.6): a change to one carries the row. */
const ROW_CHILDREN = ["sources", "task_sources", "folders"] as const;
/** The projects whose folders a commit after `$after` changed: their tasks' rows show them. */
const PROJECT_FOLDERS_CHANGED =
  "SELECT id, owner_id FROM folders WHERE owner_kind = 'project' AND id IN " +
  "(SELECT entity_id FROM changes WHERE seq > $after AND entity = 'folders')";
/**
 * The tasks of the runs a commit after `$after` changed. A run's changes name no task (it is no
 * child of its task, as a launch is not), but its task's row shows its newest run.
 */
const RUN_TASKS =
  "SELECT id, task_id FROM runs WHERE task_id IS NOT NULL AND id IN " +
  "(SELECT entity_id FROM changes WHERE seq > $after AND entity = 'runs')";
const taskRowsSql = (folders: boolean) =>
  `SELECT ${taskColumns(folders)} FROM tasks t WHERE t.id IN (${touched("tasks")}) OR t.id IN ` +
  `(SELECT task_id FROM changes WHERE ${IN_BATCH} AND task_id IS NOT NULL AND entity IN ` +
  `(${ROW_CHILDREN.map((c) => `'${c}'`).join(", ")}))` +
  (folders
    ? " OR t.project_id IN (SELECT owner_id FROM folders WHERE owner_kind = 'project' AND id IN " +
      `(${touched("folders")})) OR t.id IN (SELECT task_id FROM runs WHERE id IN ` +
      `(${touched("runs")}))`
    : "");
/**
 * The tasks of the launches the batch touched. A launch's changes name no task (it is no child of
 * its task), but a tab that shows the task's tile follows it by the task.
 */
const LAUNCH_TASKS = `SELECT id, task_id FROM launches WHERE id IN (${touched("launches")})`;
const AREA_ROWS = `SELECT ${AREA_COLUMNS} FROM areas a WHERE a.id IN (${touched("areas")})`;
const PROJECT_ROWS = `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id IN (${touched("projects")})`;

/** The words entities are named by in the feed. Another table is `other`. */
export const ENTITY_TYPES: Readonly<Record<string, string>> = {
  tasks: "task",
  areas: "area",
  projects: "project",
  notes: "note",
  log_entries: "log",
  sources: "source",
  task_sources: "link",
  places: "place",
  folders: "folder",
  launches: "launch",
  runs: "run",
  machines: "machine",
  learnings: "learning",
  preferences: "preference",
};

function headOf(row: unknown): SpaceHead {
  const r = (row ?? {}) as Row;
  return {
    id: String(r["space_id"]),
    name: String(r["name"]),
    ref_prefix: String(r["ref_prefix"]),
    cursor: {
      epoch: Number(r["authority_epoch"]),
      incarnation: String(r["authority_incarnation"]),
      seq: Number(r["last_seq"]),
    },
  };
}

/** The space's head: its ID, name and current cursor. */
export async function readHead(reader: WorkerConnection): Promise<SpaceHead> {
  return headOf(await reader.get(SPACE_SQL));
}

/**
 * The open working set (A5 3.15 step 1) with its cursor, in one snapshot. With `here`, each task's
 * row carries its place's state on that machine.
 */
export async function readSnapshot(
  reader: WorkerConnection,
  here?: FeedHere,
): Promise<SnapshotMessage> {
  const folders = await hasFolderTable(reader);
  const [space, tasks, areas, projects, preferences] = await reader.transaction("deferred", [
    { sql: SPACE_SQL, mode: "get" },
    { sql: openTasks(folders), mode: "all" },
    { sql: LIVE_AREAS, mode: "all" },
    { sql: LIVE_PROJECTS, mode: "all" },
    { sql: PREFERENCE_ROWS, mode: "all" },
  ]);
  const head = headOf(space);
  return {
    type: "snapshot",
    space: { id: head.id, name: head.name, ref_prefix: head.ref_prefix },
    cursor: head.cursor,
    tasks: await taskRows(tasks as Row[], head.ref_prefix, here),
    areas: (areas as Row[]).map((row) => compact(row)),
    projects: (projects as Row[]).map((row) => compact(row)),
    preferences: spacePreferencesOf(preferences as Row[]),
  };
}

/**
 * The batch after `after`: the commits up to `after + limit` that exist in one snapshot, their
 * entities and rows. `through` is the last seq the batch accounts for; when nothing is newer it
 * equals `after` and the batch is an empty heartbeat. The head says whether the epoch or
 * incarnation moved: the caller then sends a snapshot instead.
 *
 * Rows are read from the tables, which hold the state at the head. A row is carried only when that
 * is its state as of `through` and nothing hidden from this subscriber shaped it in the batch:
 * an entity that a commit after `through` touched, or that a hidden commit in the batch touched,
 * travels with `row: null`, and the client refetches it. So no batch carries state its coverage
 * does not reach, and a hidden commit's content never rides on a visible event.
 */
export async function readBatch(
  reader: WorkerConnection,
  after: number,
  options: { limit?: number; visible?: Visibility; here?: FeedHere } = {},
): Promise<{ head: SpaceHead; batch: BatchMessage }> {
  const limit = options.limit ?? BATCH_COMMITS;
  const visible = options.visible ?? ALL_VISIBLE;
  const params = { after, upto: after + limit };
  const folders = await hasFolderTable(reader);
  const [
    space,
    commits,
    changes,
    actors,
    tasks,
    areas,
    projects,
    launches,
    later,
    projectFolders,
    runs,
  ] = await reader.transaction("deferred", [
    { sql: SPACE_SQL, mode: "get" },
    { sql: COMMITS, mode: "all", params },
    { sql: CHANGES, mode: "all", params },
    { sql: ACTORS, mode: "all", params },
    { sql: taskRowsSql(folders), mode: "all", params },
    { sql: AREA_ROWS, mode: "all", params },
    { sql: PROJECT_ROWS, mode: "all", params },
    { sql: LAUNCH_TASKS, mode: "all", params },
    { sql: LATER, mode: "all", params: { upto: params.upto } },
    ...(folders
      ? [
          { sql: PROJECT_FOLDERS_CHANGED, mode: "all" as const, params: { after } },
          { sql: RUN_TASKS, mode: "all" as const, params: { after } },
        ]
      : []),
  ]);
  const head = headOf(space);
  const through = Math.max(after, Math.min(head.cursor.seq, after + limit));
  const actorOf = new Map((actors as Row[]).map((a) => [String(a["id"]), a]));
  const launchTask = new Map(
    (launches as Row[]).flatMap((l) => {
      const task = l["task_id"];
      return typeof task === "string" ? [[String(l["id"]), task] as const] : [];
    }),
  );
  const rows = new Map<string, CompactRow>();
  for (const row of await taskRows(tasks as Row[], head.ref_prefix, options.here)) {
    const id = row["id"];
    if (typeof id === "string") rows.set(`tasks:${id}`, row);
  }
  for (const row of areas as Row[]) rows.set(`areas:${String(row["id"])}`, compact(row));
  for (const row of projects as Row[]) rows.set(`projects:${String(row["id"])}`, compact(row));

  // Which commits this subscriber sees. A hidden commit is accounted for by the interval only.
  const shown = new Map<number, Row>();
  for (const commit of commits as Row[]) {
    const seq = Number(commit["seq"]);
    if (seq > through) continue;
    const facts: CommitFacts = {
      seq,
      kind: String(commit["kind"]),
      actor_kind: String(commit["actor_kind"]),
      origin: String(commit["origin"]),
    };
    if (visible(facts)) shown.set(seq, commit);
  }

  // Rows that are not the state as of `through` for this subscriber: withheld. A change to a
  // task's note, log entry or other child also changes the task's own row (its `touched`), so
  // the change's task is withheld with it.
  // A project's folder is part of what the rows of its tasks show.
  const folderOwner = new Map(
    ((projectFolders ?? []) as Row[]).map((r) => [String(r["id"]), String(r["owner_id"])]),
  );
  const tasksOf = (project: string | undefined): string[] =>
    project === undefined
      ? []
      : [...rows]
          .filter(([k, r]) => k.startsWith("tasks:") && r["project_id"] === project)
          .map(([k]) => k);
  // A run's task: its row shows the task's newest run.
  const runTask = new Map(
    ((runs ?? []) as Row[]).map((r) => [String(r["id"]), String(r["task_id"])]),
  );
  /** The task whose row a change shows on: its own, or a run's. */
  const taskOf = (change: Row): string | undefined => {
    const task = change["task_id"];
    if (typeof task === "string") return task;
    return change["entity"] === "runs" ? runTask.get(String(change["entity_id"])) : undefined;
  };
  const withheld = new Set<string>();
  const withhold = (change: Row) => {
    withheld.add(`${String(change["entity"])}:${String(change["entity_id"])}`);
    const task = taskOf(change);
    if (task !== undefined) withheld.add(`tasks:${task}`);
    if (change["entity"] === "folders") {
      for (const key of tasksOf(folderOwner.get(String(change["entity_id"])))) withheld.add(key);
    }
  };
  for (const row of (later ?? []) as Row[]) withhold(row);
  for (const change of changes as Row[]) {
    const seq = Number(change["seq"]);
    if (seq <= through && !shown.has(seq)) withhold(change);
  }

  // Entities per shown commit, in change order: one per (table, row), with the fields it set.
  const bySeq = new Map<number, Map<string, { entity: FeedEntity; changed: string[] }>>();
  for (const change of changes as Row[]) {
    const seq = Number(change["seq"]);
    if (!shown.has(seq)) continue;
    const table = String(change["entity"]);
    const id = String(change["entity_id"]);
    const key = `${table}:${id}`;
    let entities = bySeq.get(seq);
    if (entities === undefined) {
      entities = new Map();
      bySeq.set(seq, entities);
    }
    const task = table === "launches" ? launchTask.get(id) : taskOf(change);
    let found = entities.get(key);
    if (found === undefined) {
      const changed: string[] = [];
      found = {
        changed,
        entity: {
          type: ENTITY_TYPES[table] ?? "other",
          id,
          ...(task === undefined ? {} : { task }),
          row: withheld.has(key) ? null : (rows.get(key) ?? null),
          changed,
          ...(change["action"] === "create" ? { created: true as const } : {}),
        },
      };
      entities.set(key, found);
    }
    const field = change["field"];
    if (typeof field === "string" && !found.changed.includes(field)) found.changed.push(field);
    // A source, link, folder or run of a task, and a folder of its project, change what the task's
    // row shows: the event carries the task's row too, after the child, as a change that names no
    // field of the task.
    const owners =
      task !== undefined
        ? (ROW_CHILDREN as readonly string[]).includes(table) || table === "runs"
          ? [`tasks:${task}`]
          : []
        : table === "folders"
          ? tasksOf(folderOwner.get(id))
          : [];
    for (const owner of owners) {
      if (entities.has(owner)) continue;
      const of = owner.slice("tasks:".length);
      // One array, as above: a later change of the task's own fields in the commit adds to it.
      const fields: string[] = [];
      entities.set(owner, {
        changed: fields,
        entity: {
          type: "task",
          id: of,
          task: of,
          row: withheld.has(owner) ? null : (rows.get(owner) ?? null),
          changed: fields,
        },
      });
    }
  }

  const events: FeedEvent[] = [];
  for (const [seq, commit] of shown) {
    const actor = actorOf.get(String(commit["principal_id"]));
    events.push({
      seq,
      op_id: String(commit["id"]),
      request_id: String(commit["request_id"]),
      actor: {
        kind: typeof actor?.["kind"] === "string" ? actor["kind"] : String(commit["actor_kind"]),
        label: typeof actor?.["label"] === "string" ? actor["label"] : "",
      },
      kind: String(commit["kind"]),
      entities: [...(bySeq.get(seq)?.values() ?? [])].map((e) => e.entity),
    });
  }
  return {
    head,
    batch: {
      type: "batch",
      space_id: head.id,
      epoch: head.cursor.epoch,
      incarnation: head.cursor.incarnation,
      from: after,
      through,
      events,
    },
  };
}

/** Whether a subscriber's cursor belongs to the space's current authority. */
export function sameAuthority(a: Cursor, b: Cursor): boolean {
  return a.epoch === b.epoch && a.incarnation === b.incarnation;
}
