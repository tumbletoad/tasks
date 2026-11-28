// A task of a tree space as today's reads take it (read.ts `TaskRead`), so `task.get`'s digest is
// built by the same functions on both backends. The tree's columns are named as today's: a node's
// brief is the summary, its description the context. A task under a top-level project is in that
// project as its area; under a project inside one, in both. Deeper levels show the nearest two.
import type { Row, WorkerConnection } from "@ttasks/storage";
import { pageRow } from "./library.ts";
import {
  notFound,
  snapshot,
  spaceFacts,
  taskFolderOf,
  taskKey,
  text,
  type EntryRange,
  type SpaceFacts,
  type Statement,
  type TaskRead,
} from "./read.ts";

/** The task a key names: its ID or its reference, among the tree's tasks. */
const MATCH = "(SELECT id FROM tasks WHERE id = $id OR ref = $ref LIMIT 1)";

/** Who wrote entry `e`, from history: `import`, `user` for the space's human, else the actor. */
const AUTHOR =
  "CASE WHEN EXISTS (SELECT 1 FROM commits k WHERE k.seq = e.created_seq AND k.origin = 'import') " +
  "THEN 'import' WHEN x.kind = 'human' THEN 'user' ELSE x.label END";

/** A note the person addressed to agents, written by them directly: an instruction. */
const INSTRUCTION =
  "(e.for_agents = 1 AND x.kind = 'human' AND NOT EXISTS (SELECT 1 FROM commits k " +
  "WHERE k.seq = e.created_seq AND k.origin = 'import'))";

/** Entry `e`'s words as someone corrected them, while they differ from those it was written with. */
const EDITED =
  "(SELECT json_object('at', c.at, 'by', CASE WHEN c.origin = 'import' THEN 'import' " +
  "WHEN a.kind = 'human' THEN 'user' ELSE a.label END) FROM commits c " +
  "JOIN actors a ON a.id = c.author_id WHERE c.seq = json_extract(e.fp, '$.body') " +
  "AND c.seq <> e.created_seq AND e.body IS NOT (SELECT json_extract(w.after, '$.body') " +
  "FROM changes w WHERE w.seq = e.created_seq AND w.entity = 'notes' " +
  "AND w.entity_id = e.id AND w.action = 'create'))";

/** The launches that name note `e` as their request, oldest first. */
const REQUEST_FOR =
  "(SELECT json_group_array(json_array(l.reference, l.instance_id) ORDER BY l.created_at, l.id) " +
  "FROM launches l WHERE l.task_id = e.owner_id " +
  "AND json_extract(l.detail, '$.evidence.request') = 'n' || e.ordinal)";

const FROM_NOTES =
  `FROM notes e JOIN actors x ON x.id = e.author_id WHERE e.owner_id = ${MATCH} ` +
  "AND e.deleted_at IS NULL";
const NOTE_COLUMNS =
  "e.ordinal, CASE WHEN e.for_agents = 1 THEN 'agents' END AS addressee, e.body, e.created_at, " +
  `${AUTHOR} AS author, ${REQUEST_FOR} AS request_for, ${EDITED} AS edited`;
const LOG_KINDS = "e.kind NOT IN ('note', 'learning')";

const TREE: Record<string, Statement> = {
  space: { sql: "SELECT * FROM space WHERE one = 1", mode: "get" },
  task: {
    sql:
      "SELECT n.id, t.ref, n.title, t.lifecycle, t.status, t.inbox, t.priority, t.effort, " +
      "t.due_date, t.due_at, t.due_tz, n.brief AS summary, n.description AS context, " +
      "t.waiting_on, t.focus_on, n.created_at, t.wrap_state, t.outcome, " +
      "max(n.version, t.version) AS version, n.deleted_at, " +
      "CASE WHEN p.kind = 'project' THEN coalesce(g.title, p.title) END AS area_title, " +
      "CASE WHEN p.kind = 'project' AND g.id IS NOT NULL THEN p.title END AS project_title, " +
      "c.id AS x_removed_change, c.at AS x_removed_at, 1 AS x_in_trash, " +
      "c.origin AS x_removed_origin, x.kind AS x_removed_kind, x.label AS x_removed_label " +
      "FROM nodes n JOIN tasks t ON t.id = n.id LEFT JOIN nodes p ON p.id = n.parent_id " +
      "LEFT JOIN nodes g ON g.id = p.parent_id AND g.kind = 'project' " +
      "LEFT JOIN commits c ON n.deleted_at IS NOT NULL AND c.seq = json_extract(n.fp, '$.deleted') " +
      `LEFT JOIN actors x ON x.id = c.author_id WHERE n.id = ${MATCH}`,
    mode: "get",
  },
  instructions: {
    sql:
      `SELECT ${NOTE_COLUMNS} ${FROM_NOTES} AND e.kind = 'note' AND ${INSTRUCTION} ` +
      "AND ($iupto IS NULL OR e.ordinal <= $iupto) ORDER BY e.ordinal DESC LIMIT $ilimit",
    mode: "all",
  },
  notes: {
    sql:
      `SELECT ${NOTE_COLUMNS} ${FROM_NOTES} AND e.kind = 'note' AND NOT ${INSTRUCTION} ` +
      "AND ($nupto IS NULL OR e.ordinal <= $nupto) ORDER BY e.ordinal DESC LIMIT $nlimit",
    mode: "all",
  },
  counts: {
    sql:
      `SELECT count(*) FILTER (WHERE e.kind = 'note' AND ${INSTRUCTION}) AS i, ` +
      `count(*) FILTER (WHERE e.kind = 'note' AND NOT ${INSTRUCTION}) AS n, ` +
      `count(*) FILTER (WHERE ${LOG_KINDS}) AS l ${FROM_NOTES}`,
    mode: "get",
  },
  log: {
    sql:
      `SELECT e.ordinal, e.kind, e.body, e.created_at, ${AUTHOR} AS author, ${EDITED} AS edited ` +
      `${FROM_NOTES} AND ${LOG_KINDS} ` +
      "AND ($lupto IS NULL OR e.ordinal <= $lupto) ORDER BY e.ordinal DESC LIMIT $llimit",
    mode: "all",
  },
  learnings: {
    sql: `SELECT e.body, e.deleted_at FROM notes e WHERE e.owner_id = ${MATCH} AND e.kind = 'learning' ORDER BY e.ordinal`,
    mode: "all",
  },
  /** The sources it holds and those its live links point at, as today's live links. */
  sources: {
    sql:
      "SELECT s.id, s.source_key, s.kind, s.title, s.who, s.url, s.at, s.outside_ref AS ref, " +
      "$task AS task_id, s.version, NULL AS removed_at, NULL AS captures_to FROM sources s " +
      `WHERE s.deleted_at IS NULL AND (s.owner_id = ${MATCH} OR EXISTS (SELECT 1 FROM links l ` +
      `WHERE l.owner_id = ${MATCH} AND l.target_id = s.id AND l.removed_at IS NULL)) ORDER BY s.ref`,
    mode: "all",
  },
  folders: {
    sql:
      "SELECT f.*, 'task' AS owner_kind, m.name AS machine_name FROM folders f " +
      `JOIN machines m ON m.id = f.machine_id WHERE f.owner_id = ${MATCH} ` +
      "AND f.deleted_at IS NULL ORDER BY f.created_seq DESC, f.id",
    mode: "all",
  },
};

/**
 * One task of a tree space and what hangs from it in one snapshot, as `readTask` reads one of
 * today's. A reference with another space's prefix is `not_found`, and so is a task in the Trash
 * unless `trash` asks for one.
 */
export async function readTreeTask(
  reader: WorkerConnection,
  ref: string,
  options: {
    readonly machine: string;
    readonly instructions: EntryRange;
    readonly notes: EntryRange;
    readonly log: EntryRange;
    readonly trash?: boolean;
  },
): Promise<TaskRead> {
  const key = taskKey(ref);
  const params = {
    id: key.id,
    ref: key.ref,
    task: key.id,
    iupto: options.instructions.upto,
    ilimit: options.instructions.limit,
    nupto: options.notes.upto,
    nlimit: options.notes.limit,
    lupto: options.log.upto,
    llimit: options.log.limit,
  };
  const [space, row, instructions, notes, counts, log, learnings, sources, folders] =
    await snapshot(
      reader,
      [
        TREE["space"],
        TREE["task"],
        TREE["instructions"],
        TREE["notes"],
        TREE["counts"],
        TREE["log"],
        TREE["learnings"],
        TREE["sources"],
        TREE["folders"],
      ].map((s) => s as Statement),
      params,
    );
  const facts = spaceFacts(space);
  if (key.prefix !== null && key.prefix !== facts.refPrefix) throw notFound();
  const task = row as Row | null;
  if (task === null || key.alias !== null) throw notFound();
  if (task["deleted_at"] !== null && options.trash !== true) throw notFound();
  const c = (counts as Row | null) ?? {};
  const sourceRows = (sources as Row[]).map((s) => ({ ...s, task_id: task["id"] }));
  return {
    space: facts,
    row: task,
    instructions: instructions as Row[],
    notes: notes as Row[],
    named: [],
    log: log as Row[],
    sources: sourceRows,
    removedSources: [],
    removedNotes: [],
    folder: taskFolderOf(folders as Row[], [], options.machine),
    history: [],
    learnings: (learnings as Row[]).flatMap((learning, k) =>
      learning["deleted_at"] === null ? [{ key: k + 1, text: text(learning["body"]) }] : [],
    ),
    counts: {
      instructions: Number(c["i"] ?? 0),
      notes: Number(c["n"] ?? 0),
      log: Number(c["l"] ?? 0),
      sources: sourceRows.length,
    },
  };
}

const LEVELS = {
  /** Every project above the task, nearest first. */
  above:
    "WITH RECURSIVE up(id, depth) AS (SELECT parent_id, 1 FROM nodes WHERE id = $id " +
    "UNION ALL SELECT n.parent_id, depth + 1 FROM nodes n JOIN up ON n.id = up.id " +
    "WHERE n.parent_id IS NOT NULL) SELECT n.id, n.kind, n.title, n.brief, n.description, " +
    "n.for_agents, n.fp, n.created_seq FROM up JOIN nodes n ON n.id = up.id ORDER BY up.depth",
  pages:
    "SELECT p.ref, p.title, p.brief, k.at AS at, k.reason AS why, a.kind AS actor_kind, " +
    "a.label AS label, k.origin AS origin FROM pages p JOIN commits k ON k.seq = p.version " +
    "JOIN actors a ON a.id = k.author_id WHERE p.owner_id = $id AND p.deleted_at IS NULL " +
    "ORDER BY p.title, p.ref LIMIT $limit",
  count: "SELECT count(*) AS n FROM pages WHERE owner_id = $id AND deleted_at IS NULL",
  instructedAt:
    "SELECT at FROM commits WHERE seq = coalesce(json_extract($fp, '$.for_agents'), $seq)",
} as const;

/** Pages in a list, as many as today's trail shows. */
const LIST = 25;

/**
 * The trail above a tree task, as today's digest shows it: its project, its area and the space,
 * nearest first, each with its texts and first pages, and the task's own pages.
 */
export async function treeTrail(
  reader: WorkerConnection,
  space: SpaceFacts,
  task: Row,
): Promise<{ trail: Record<string, unknown>[]; pages: unknown[]; count: number }> {
  const id = text(task["id"]);
  const [levels, pages, count] = await reader.transaction("deferred", [
    { sql: LEVELS.above, mode: "all", params: { id } },
    { sql: LEVELS.pages, mode: "all", params: { id, limit: LIST } },
    { sql: LEVELS.count, mode: "get", params: { id } },
  ]);
  const above = (levels as Row[]).filter((l) => l["kind"] !== "task");
  const projects = above.filter((l) => l["kind"] === "project");
  const trail = await Promise.all(
    above.map(async (level) => {
      const levelId = text(level["id"]);
      const [own, total, instructed] = await reader.transaction("deferred", [
        { sql: LEVELS.pages, mode: "all", params: { id: levelId, limit: LIST } },
        { sql: LEVELS.count, mode: "get", params: { id: levelId } },
        {
          sql: LEVELS.instructedAt,
          mode: "get",
          params: { fp: text(level["fp"]), seq: Number(level["created_seq"]) },
        },
      ]);
      const forAgents = text(level["for_agents"]);
      const space_ = level["kind"] === "space";
      // The project nearest the space is today's area; one inside it, today's project.
      const kind = space_ ? "space" : level === projects.at(-1) ? "area" : "project";
      return {
        kind,
        id: space_ ? space.id : levelId,
        title: space_ ? space.name : text(level["title"]),
        brief: text(level["brief"]),
        read: space_ ? "space" : levelId,
        has_description: text(level["description"]) !== "",
        ...(forAgents === ""
          ? {}
          : {
              for_agents: {
                text: forAgents,
                at: new Date(Number((instructed as Row | null)?.["at"])).toISOString(),
              },
            }),
        pages: (own as Row[]).map((p) => pageRow(space.refPrefix, p)),
        count: Number((total as Row | null)?.["n"] ?? 0),
      };
    }),
  );
  return {
    trail,
    pages: (pages as Row[]).map((p) => pageRow(space.refPrefix, p)),
    count: Number((count as Row | null)?.["n"] ?? 0),
  };
}
