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
//   of a task, a node of the tree or a page (the working set's kinds) and null for the rest (notes, log
//   entries, sources, links, places, launches): a client refetches the task those touch. No body
//   of a note, no context, outcome or other long text is in the feed, and of a log entry only the
//   start of an agent's question that waits for the person, on its task's row.
// - Each event carries its commit's time (`at`), which only moves forward.
// - A task's compact row (ops/task-rows.ts) also carries what its row shows of its children
//   (A5 3.6): its first three sources with their own text and URL (`sources`), how many more it
//   has (`sources_more`), where it opens on this machine (`place`), from its own folder or its
//   project's, whether its newest background run works or needs the person (`run`), the agents
//   it was last opened in and ran with (`last`), and the questions agents asked that wait for the
//   person (`questions`). A commit that changes a source, a link, a folder, a note, a log entry, a
//   run or a launch of a task therefore carries the task's row too, as an entity of its own, and
//   one that changes a project's folder carries the rows of the project's tasks the batch holds,
//   so the row the client holds never shows a source, a folder, a run state or a question the
//   space no longer has.
import type { CompactNode, PreferenceRead } from "@ttasks/contracts";
import { RUN_WAITS, WAITS, type Row, type WorkerConnection } from "@ttasks/storage";
import { hasFolderTable, hasPageTable } from "../ops/read.ts";
import { COMPACT_PAGE, compactPage, LIVE_PAGES } from "../ops/library.ts";
import { taskColumns, taskRows, type CompactRow, type FeedHere } from "../ops/task-rows.ts";
import { PREFERENCE_ROWS, spacePreferencesOf } from "../ops/preferences.ts";
import { compactRoutine, LIVE_ROUTINES, ROUTINE_ROWS } from "../ops/routines.ts";

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
  /** The commit's time. */
  readonly at: number;
  readonly op_id: string;
  readonly request_id: string;
  readonly actor: { readonly kind: string; readonly label: string };
  readonly kind: string;
  readonly entities: readonly FeedEntity[];
}

/**
 * A task agents changed lately: who changed it last of them, and when. `row` is the row of a task
 * the snapshot's open tasks do not hold, one an agent finished among them.
 */
export interface AgentChange {
  readonly task: string;
  readonly actor: string;
  readonly at: number;
  readonly row?: CompactRow;
}

export interface SnapshotMessage {
  readonly type: "snapshot";
  readonly space: { readonly id: string; readonly name: string; readonly ref_prefix: string };
  readonly cursor: Cursor;
  readonly tasks: readonly CompactRow[];
  /**
   * The tasks an agent or a routine changed in the last `AGENT_CHANGE_DAYS` days, newest change
   * first, at most `AGENT_CHANGE_TASKS`: as of the snapshot's cursor, so the batches after it go on
   * from there.
   */
  readonly agent_changes: readonly AgentChange[];
  /**
   * The rows of the finished and dropped tasks on which a question waits for the person: the open
   * tasks' rows carry theirs.
   */
  readonly asking: readonly CompactRow[];
  /**
   * The space's tree above its tasks: the space, then every live project, each under its parent.
   * A task row's `parent` names one of them. A batch carries a changed project's row as an entity
   * of type `node`.
   */
  readonly nodes: readonly CompactNode[];
  /**
   * Every page the space shows, without its body (contracts' CompactPage). A batch carries a
   * page's row as an entity of type `page`; one whose row has `deleted_at` leaves the lists, also
   * when its task or project went to the Trash, and its `under` follows a task filed elsewhere. A
   * change to a node's texts is an entity of type `node_text` without a row. Absent on a space
   * before pages.
   */
  readonly pages?: readonly Record<string, unknown>[];
  /**
   * Every space preference and flag the registry declares, with its value as readers take it and
   * its state (A1 3.16, A5 3.15 step 1). A batch names a changed preference as an entity of type
   * `preference` without a row: the page takes a snapshot for its new value.
   */
  /**
   * A tree space's routines that are not finished, each with its schedule, its open time and its
   * newest entry (ops/routines.ts compactRoutine). A batch carries a changed routine's row as an
   * entity of type `routine`, also when it went to the Trash or was finished. Absent on today's
   * storage, which has none.
   */
  readonly routines?: readonly CompactRow[];
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

/** How far back the agents' changes in a snapshot reach, in days. */
export const AGENT_CHANGE_DAYS = 7;
/** At most this many tasks agents changed are in a snapshot. */
export const AGENT_CHANGE_TASKS = 100;
/**
 * Each live task's newest commit by an agent or a routine since `$since`, newest first, at most
 * `AGENT_CHANGE_TASKS`. Commit times only move forward, so the week is the newest commits: the
 * walk goes back from the newest one by one and stops at the first one older.
 */
const AGENT_CHANGED =
  "WITH RECURSIVE week(seq) AS (SELECT seq FROM commits WHERE seq = (SELECT max(seq) FROM " +
  "commits) AND at >= $since UNION ALL SELECT c.seq FROM week w JOIN commits c ON c.seq = " +
  "(SELECT max(seq) FROM commits WHERE seq < w.seq) WHERE c.at >= $since), recent AS (SELECT " +
  "c.task_id AS task, max(w.seq) AS seq FROM week w JOIN commits k ON k.seq = w.seq JOIN changes " +
  "c ON c.seq = w.seq JOIN tasks t ON t.id = c.task_id WHERE k.actor_kind IN ('agent', " +
  "'routine') AND t.deleted_at IS NULL GROUP BY c.task_id ORDER BY seq DESC LIMIT " +
  `${String(AGENT_CHANGE_TASKS)}) `;
const AGENT_CHANGES =
  AGENT_CHANGED +
  "SELECT r.task AS task, k.at AS at, a.label AS actor FROM recent r JOIN commits k ON " +
  "k.seq = r.seq JOIN actors a ON a.id = k.principal_id ORDER BY r.seq DESC";
/** The rows of the tasks agents changed that the open tasks do not hold. */
const agentChangedRows = (folders: boolean) =>
  `${AGENT_CHANGED}SELECT ${taskColumns(folders)} FROM tasks t WHERE t.id IN ` +
  "(SELECT task FROM recent) AND t.lifecycle <> 'active'";
/** The rows of the finished and dropped tasks a question waits on (task-rows.ts's `WAITS`). */
const askingRows = (folders: boolean) =>
  `SELECT ${taskColumns(folders)} FROM tasks t WHERE t.lifecycle <> 'active' AND ` +
  "t.deleted_at IS NULL AND ((t.id IN (SELECT task_id FROM log_entries WHERE kind = 'question' " +
  `AND deleted_at IS NULL) AND EXISTS (SELECT 1 FROM log_entries q WHERE ${WAITS}))` +
  (folders
    ? " OR (t.id IN (SELECT task_id FROM runs WHERE state = 'failed' AND reason = 'needs_input') " +
      `AND EXISTS (SELECT 1 FROM runs r WHERE ${RUN_WAITS}))`
    : "") +
  ")";

const IN_BATCH = "seq > $after AND seq <= $upto";
const COMMITS =
  "SELECT seq, id, at, request_id, kind, actor_kind, origin, principal_id FROM commits " +
  `WHERE ${IN_BATCH} ORDER BY seq`;
const CHANGES =
  "SELECT seq, n, entity, entity_id, task_id, action, field FROM changes " +
  `WHERE ${IN_BATCH} ORDER BY seq, n`;
const ACTORS = `SELECT id, kind, label FROM actors WHERE id IN (SELECT principal_id FROM commits WHERE ${IN_BATCH})`;
/** The entities a commit after the batch's reach touched: their rows are past its `through`. */
const LATER = "SELECT DISTINCT entity, entity_id, task_id FROM changes WHERE seq > $upto";
const touched = (entity: string) =>
  `SELECT entity_id FROM changes WHERE ${IN_BATCH} AND entity = '${entity}'`;
/**
 * The tables whose rows a task's compact row shows (A5 3.6), its waiting question among them: a
 * change to one carries the row.
 */
const ROW_CHILDREN = ["sources", "task_sources", "folders", "notes", "log_entries"] as const;
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
      `(${touched("runs")})) OR t.id IN (SELECT task_id FROM launches WHERE id IN ` +
      `(${touched("launches")}))`
    : "");
/**
 * The tasks of the launches a commit after `$after` changed. A launch's changes name no task (it is
 * no child of its task), but its task's row shows the agent it was last opened in, and a tab that
 * shows the task's tile follows it by the task.
 */
const LAUNCH_TASKS =
  "SELECT id, task_id FROM launches WHERE task_id IS NOT NULL AND id IN " +
  "(SELECT entity_id FROM changes WHERE seq > $after AND entity = 'launches')";
const AREA_ROWS = `SELECT ${AREA_COLUMNS} FROM areas a WHERE a.id IN (${touched("areas")})`;
const PROJECT_ROWS = `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id IN (${touched("projects")})`;

/** A tree space's projects, read from its tree at any depth: the feed sends them as they are. */
const TREE_NODE_COLUMNS =
  "n.id, n.parent_id, n.title, n.position, n.color, n.archived_at, n.deleted_at";
const LIVE_TREE_NODES =
  `SELECT ${TREE_NODE_COLUMNS} FROM nodes n JOIN nodes p ON p.id = n.parent_id ` +
  "WHERE n.kind = 'project' AND n.deleted_at IS NULL ORDER BY p.kind <> 'space', n.position, n.id";
const TREE_NODE_ROWS =
  `SELECT ${TREE_NODE_COLUMNS}, CASE p.kind WHEN 'space' THEN 'areas' ELSE 'projects' END ` +
  "AS entity FROM nodes n JOIN nodes p ON p.id = n.parent_id WHERE n.kind = 'project' AND n.id IN " +
  `(${touched("areas")} UNION ${touched("projects")})`;

/** No rows, for a batch's parameters. */
const NO_ROWS = "SELECT 1 WHERE $after < 0 AND $upto < 0";

/** A project of a tree space as the feed sends a node, under the node it sits in. */
function treeNodeOf(row: Row): CompactNode & CompactRow {
  const color = row["color"];
  const deleted = row["deleted_at"];
  return {
    id: String(row["id"]),
    kind: "project",
    parent: String(row["parent_id"]),
    title: String(row["title"]),
    position: String(row["position"]),
    ...(typeof color === "string" ? { color } : {}),
    state: row["archived_at"] === null ? "active" : "archived",
    ...(typeof deleted === "number" ? { deleted_at: deleted } : {}),
  };
}
/**
 * The pages a batch's commits changed, and those whose task, project or area they moved to the
 * Trash, brought back or filed elsewhere: their rows say whether they are shown, and where.
 */
const PAGE_ROWS =
  `${COMPACT_PAGE} WHERE p.id IN (SELECT entity_id FROM changes WHERE seq > $after AND seq <= $upto ` +
  "AND entity = 'pages') OR p.owner_id IN (SELECT entity_id FROM changes WHERE seq > $after " +
  "AND seq <= $upto AND entity IN ('tasks', 'projects', 'areas') AND field IN ('deleted', 'grouping'))";

/**
 * The feed's adapter from today's areas and projects to the tree, which lives until the tree is
 * the space's own: an area is a top-level project, and a project sits under its area, or under
 * the space when it has none. A project without an area sorts after every area, as the side menu
 * lists it: `~` sorts after every position.
 */
function nodeOf(table: "areas" | "projects", row: Row, space: string): CompactNode & CompactRow {
  const area = table === "projects" ? row["area_id"] : undefined;
  const position = String(row["position"]);
  const color = row["color"];
  const deleted = row["deleted_at"];
  return {
    id: String(row["id"]),
    kind: "project",
    parent: typeof area === "string" ? area : space,
    title: String(row["title"]),
    position: table === "projects" && typeof area !== "string" ? `~${position}` : position,
    ...(typeof color === "string" ? { color } : {}),
    state: row["lifecycle"] === "archived" ? "archived" : "active",
    ...(typeof deleted === "number" ? { deleted_at: deleted } : {}),
  };
}

/** The node's field each of an area's or a project's changed fields is; a brief is none. */
const NODE_FIELDS: Readonly<Record<string, string>> = {
  title: "title",
  color: "color",
  lifecycle: "state",
  grouping: "place",
  deleted: "deleted",
};

/** The words entities are named by in the feed. Another table is `other`. */
export const ENTITY_TYPES: Readonly<Record<string, string>> = {
  tasks: "task",
  areas: "node",
  projects: "node",
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
  pages: "page",
  node_texts: "node_text",
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
 * The open working set (A5 3.15 step 1) with its cursor, and the tasks agents changed lately, in
 * one snapshot. With `here`, each task's row carries its place's state on that machine.
 */
export async function readSnapshot(
  reader: WorkerConnection,
  here?: FeedHere,
  now: number = Date.now(),
): Promise<SnapshotMessage> {
  const folders = await hasFolderTable(reader);
  const since = { since: now - AGENT_CHANGE_DAYS * 86_400_000 };
  const withPages = await hasPageTable(reader);
  const tree = reader.backend === "tree";
  const [space, tasks, areas, projects, preferences, changed, finished, asking, ...rest] =
    await reader.transaction("deferred", [
      { sql: SPACE_SQL, mode: "get" },
      { sql: openTasks(folders), mode: "all" },
      { sql: tree ? LIVE_TREE_NODES : LIVE_AREAS, mode: "all" },
      { sql: tree ? "SELECT 1 WHERE 0" : LIVE_PROJECTS, mode: "all" },
      { sql: PREFERENCE_ROWS, mode: "all" },
      { sql: AGENT_CHANGES, mode: "all", params: since },
      { sql: agentChangedRows(folders), mode: "all", params: since },
      { sql: askingRows(folders), mode: "all" },
      ...(withPages ? [{ sql: LIVE_PAGES, mode: "all" as const }] : []),
      ...(tree ? [{ sql: LIVE_ROUTINES, mode: "all" as const }] : []),
    ]);
  const head = headOf(space);
  const rows = new Map(
    (await taskRows(finished as Row[], head.ref_prefix, here)).map((row) => [row["id"], row]),
  );
  const [livePages, liveRoutines] = withPages ? rest : [undefined, ...rest];
  const pages = withPages
    ? ((livePages ?? []) as Row[]).map((row) => compactPage(head.ref_prefix, row))
    : undefined;
  return {
    type: "snapshot",
    space: { id: head.id, name: head.name, ref_prefix: head.ref_prefix },
    cursor: head.cursor,
    tasks: await taskRows(tasks as Row[], head.ref_prefix, here),
    agent_changes: (changed as Row[]).map((change) => {
      const task = String(change["task"]);
      const row = rows.get(task);
      return {
        task,
        actor: typeof change["actor"] === "string" ? change["actor"] : "",
        at: Number(change["at"]),
        ...(row === undefined ? {} : { row }),
      };
    }),
    asking: await taskRows(asking as Row[], head.ref_prefix, here),
    nodes: [
      { id: head.id, kind: "space", title: head.name, state: "active" },
      ...(tree
        ? (areas as Row[]).map(treeNodeOf)
        : [
            ...(areas as Row[]).map((row) => nodeOf("areas", row, head.id)),
            ...(projects as Row[]).map((row) => nodeOf("projects", row, head.id)),
          ]),
    ],
    ...(pages === undefined ? {} : { pages }),
    ...(tree
      ? {
          routines: ((liveRoutines ?? []) as Row[]).map((row) =>
            compactRoutine(row, head.ref_prefix),
          ),
        }
      : {}),
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
  const withPages = await hasPageTable(reader);
  const folders = await hasFolderTable(reader);
  const tree = reader.backend === "tree";
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
    routineRows,
    projectFolders,
    runs,
    pageRows,
  ] = await reader.transaction("deferred", [
    { sql: SPACE_SQL, mode: "get" },
    { sql: COMMITS, mode: "all", params },
    { sql: CHANGES, mode: "all", params },
    { sql: ACTORS, mode: "all", params },
    { sql: taskRowsSql(folders), mode: "all", params },
    { sql: tree ? TREE_NODE_ROWS : AREA_ROWS, mode: "all", params },
    // A tree space's projects are all in the one read above.
    { sql: tree ? NO_ROWS : PROJECT_ROWS, mode: "all", params },
    { sql: LAUNCH_TASKS, mode: "all", params: { after } },
    { sql: LATER, mode: "all", params: { upto: params.upto } },
    { sql: tree ? ROUTINE_ROWS : NO_ROWS, mode: "all", params },
    ...(folders
      ? [
          { sql: PROJECT_FOLDERS_CHANGED, mode: "all" as const, params: { after } },
          { sql: RUN_TASKS, mode: "all" as const, params: { after } },
        ]
      : []),
    ...(withPages ? [{ sql: PAGE_ROWS, mode: "all" as const, params }] : []),
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
  if (tree) {
    for (const row of areas as Row[]) {
      rows.set(`${String(row["entity"])}:${String(row["id"])}`, treeNodeOf(row));
    }
  } else {
    for (const [table, list] of [
      ["areas", areas],
      ["projects", projects],
    ] as const) {
      for (const row of list as Row[]) {
        rows.set(`${table}:${String(row["id"])}`, nodeOf(table, row, head.id));
      }
    }
  }
  // A routine's changes, of any of its rows, carry its one row: the page draws it from that alone.
  const routineIds = new Set<string>();
  for (const row of routineRows as Row[]) {
    const id = String(row["id"]);
    routineIds.add(id);
    rows.set(`routines:${id}`, compactRoutine(row, head.ref_prefix));
  }
  /** The pages of each task, project or area a batch moved to the Trash, back or elsewhere. */
  const pagesOn = new Map<string, string[]>();
  for (const row of (pageRows ?? []) as Row[]) {
    const key = `pages:${String(row["id"])}`;
    rows.set(key, compactPage(head.ref_prefix, row) as CompactRow);
    const owner = String(row["owner_id"]);
    pagesOn.set(owner, [...(pagesOn.get(owner) ?? []), key]);
  }

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
          .filter(([k, r]) => k.startsWith("tasks:") && r["parent"] === project)
          .map(([k]) => k);
  // A run's task: its row shows the task's newest run.
  const runTask = new Map(
    ((runs ?? []) as Row[]).map((r) => [String(r["id"]), String(r["task_id"])]),
  );
  /** The task whose row a change shows on: its own, or a run's or a launch's. */
  const taskOf = (change: Row): string | undefined => {
    const task = change["task_id"];
    if (typeof task === "string") return task;
    const id = String(change["entity_id"]);
    if (change["entity"] === "runs") return runTask.get(id);
    return change["entity"] === "launches" ? launchTask.get(id) : undefined;
  };
  const withheld = new Set<string>();
  const withhold = (change: Row) => {
    withheld.add(`${String(change["entity"])}:${String(change["entity_id"])}`);
    const task = taskOf(change);
    if (task !== undefined) {
      withheld.add(`tasks:${task}`);
      withheld.add(`routines:${task}`);
    }
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
    const task = taskOf(change);
    if (task !== undefined && routineIds.has(task)) {
      const own = `routines:${task}`;
      let routine = entities.get(own);
      if (routine === undefined) {
        const changed: string[] = [];
        routine = {
          changed,
          entity: {
            type: "routine",
            id: task,
            task,
            row: withheld.has(own) ? null : (rows.get(own) ?? null),
            changed,
          },
        };
        entities.set(own, routine);
      }
      const field = change["field"];
      if (typeof field === "string" && !routine.changed.includes(field))
        routine.changed.push(field);
      continue;
    }
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
    const given = change["field"];
    const field =
      typeof given === "string" && (table === "areas" || table === "projects")
        ? NODE_FIELDS[given]
        : given;
    if (typeof field === "string" && !found.changed.includes(field)) found.changed.push(field);
    // A source, link, folder, run or launch of a task, and a folder of its project, change what
    // the task's row shows: the event carries the task's row too, after the child, as a change
    // that names no field of the task.
    const owners =
      task !== undefined
        ? (ROW_CHILDREN as readonly string[]).includes(table) ||
          ((table === "runs" || table === "launches") && folders)
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
    // A task, project or area moved to the Trash, back or elsewhere takes its pages with it: their
    // rows say whether they are shown and what they lie under.
    if (
      (given === "deleted" || given === "grouping") &&
      (table === "tasks" || table === "projects" || table === "areas")
    ) {
      for (const key of pagesOn.get(id) ?? []) {
        if (entities.has(key)) continue;
        entities.set(key, {
          changed: [],
          entity: {
            type: "page",
            id: key.slice("pages:".length),
            row: withheld.has(key) ? null : (rows.get(key) ?? null),
            changed: [],
          },
        });
      }
    }
  }

  const events: FeedEvent[] = [];
  for (const [seq, commit] of shown) {
    const actor = actorOf.get(String(commit["principal_id"]));
    events.push({
      seq,
      at: Number(commit["at"]),
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
