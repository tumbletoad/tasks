// The Trash: the tasks someone moved there on purpose (storage's trash.ts decides which), read a
// page at a time, newest change first, each with the change that moved it there.
import { inTrashSql, removalSeqSql, type Row, type WorkerConnection } from "@ttasks/storage";
import { byOf } from "./errors.ts";
import { hasFolderTable } from "./read.ts";
import { OPEN_RUN, taskColumns, taskRows, type CompactRow, type FeedHere } from "./task-rows.ts";

/** What a page of the Trash asks for. */
export interface TrashRequest {
  /** Words of a title, all of them, or a reference's number. */
  readonly words: readonly string[];
  readonly ref?: number | undefined;
  /**
   * Only the tasks an agent may still work on: a run that may hold processes or whose newest asks
   * the person, or a terminal launch that changed since this instant.
   */
  readonly working?: number | undefined;
  readonly limit: number;
  /** The last row of the page before: its change's seq and its reference number. */
  readonly after?: { readonly seq: number; readonly ref: number } | undefined;
}

/** A row of the Trash: the task's compact row, where it was, and the change that moved it. */
export interface TrashEntry {
  readonly row: CompactRow;
  readonly seq: number;
  /** Its reference's number: with `seq`, where the next page starts. */
  readonly ref: number;
  readonly area?: string;
  readonly project?: string;
  readonly removed: {
    readonly id: string;
    readonly at: string;
    readonly by: string;
    readonly reason?: string;
    readonly count: number;
  };
}

/**
 * The Trash's tasks with their change's seq, and how many of each change are there. The page's
 * keys are chosen first and the rows built only for them, as Completed's are.
 */
function trashSql(request: TrashRequest, folders: boolean): string {
  const find: string[] = [];
  if (request.ref !== undefined) find.push("t.ref = $ref");
  if (request.words.length > 0) {
    find.push(
      "NOT EXISTS (SELECT 1 FROM json_each($words) w WHERE instr(lower(t.title), w.value) = 0)",
    );
  }
  const where = find.length === 0 ? [] : [`(${find.join(" OR ")})`];
  if (request.working !== undefined) {
    // Without the runs table (a space served at an older revision) no agent works on any of them.
    where.push(
      folders
        ? `(EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND ${OPEN_RUN}) OR ` +
            "(SELECT r.state = 'failed' AND r.reason = 'needs_input' FROM runs r WHERE " +
            "r.task_id = t.id ORDER BY r.queued_at DESC, r.id DESC LIMIT 1) OR EXISTS (SELECT 1 " +
            "FROM launches l WHERE l.task_id = t.id AND l.route = 'terminal' AND l.updated_at >= $since))"
        : "0",
    );
  }
  if (request.after !== undefined)
    where.push("(k.seq < $seq OR (k.seq = $seq AND t.ref > $after))");
  return (
    "WITH k AS (SELECT t.id, " +
    `${removalSeqSql("t")} AS seq FROM tasks t WHERE ${inTrashSql("t")}), ` +
    "counts AS (SELECT seq, count(*) AS n FROM k GROUP BY seq), " +
    "page AS (SELECT k.id, k.seq, t.ref FROM k JOIN tasks t ON t.id = k.id " +
    `${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`} ` +
    "ORDER BY k.seq DESC, t.ref LIMIT $limit) " +
    `SELECT ${taskColumns(folders)}, page.seq AS x_seq, n.n AS x_count, a.title AS x_area, ` +
    "p.title AS x_project, c.id AS x_change, c.at AS x_at, c.reason AS x_why, " +
    "c.origin AS x_origin, x.kind AS x_kind, x.label AS x_label FROM page " +
    "JOIN tasks t ON t.id = page.id JOIN counts n ON n.seq = page.seq " +
    "LEFT JOIN commits c ON c.seq = page.seq LEFT JOIN actors x ON x.id = c.author_id " +
    "LEFT JOIN areas a ON a.id = t.area_id LEFT JOIN projects p ON p.id = t.project_id " +
    "ORDER BY page.seq DESC, page.ref"
  );
}

const TRASH_OWN = [
  "x_seq",
  "x_count",
  "x_area",
  "x_project",
  "x_change",
  "x_at",
  "x_why",
  "x_origin",
  "x_kind",
  "x_label",
] as const;

/**
 * A page of the Trash, newest change first, then by task ID: up to `limit` rows, and whether
 * more follow. Words find a task whose title holds every one of them, a reference that task.
 */
export async function readTrash(
  reader: WorkerConnection,
  request: TrashRequest,
  here?: FeedHere,
): Promise<{ entries: TrashEntry[]; more: boolean }> {
  const folders = await hasFolderTable(reader);
  const [space, rows] = await reader.transaction("deferred", [
    { sql: "SELECT ref_prefix FROM space WHERE one = 1", mode: "get" },
    {
      sql: trashSql(request, folders),
      mode: "all",
      params: {
        limit: request.limit + 1,
        ...(request.words.length === 0 ? {} : { words: JSON.stringify(request.words) }),
        ...(request.ref === undefined ? {} : { ref: request.ref }),
        ...(request.working === undefined || !folders ? {} : { since: request.working }),
        ...(request.after === undefined
          ? {}
          : { seq: request.after.seq, after: request.after.ref }),
      },
    },
  ]);
  const found = (rows as Row[]).slice(0, request.limit);
  const prefix = (space as Row | null)?.["ref_prefix"];
  const own = found.map((row) => Object.fromEntries(TRASH_OWN.map((key) => [key, row[key]])));
  const plain = found.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !(TRASH_OWN as readonly string[]).includes(key)),
    ),
  );
  const compact = await taskRows(plain, typeof prefix === "string" ? prefix : "", here);
  const entries = compact.map((row, i): TrashEntry => {
    const x = own[i] ?? {};
    const at = typeof x["x_at"] === "number" ? x["x_at"] : Number(row["deleted_at"] ?? 0);
    const why = x["x_why"];
    return {
      row,
      seq: Number(x["x_seq"]),
      ref: Number(found[i]?.["ref"]),
      ...(typeof x["x_area"] === "string" ? { area: x["x_area"] } : {}),
      ...(typeof x["x_project"] === "string" ? { project: x["x_project"] } : {}),
      removed: {
        id: String(x["x_change"]),
        at: new Date(at).toISOString(),
        by:
          typeof x["x_kind"] === "string"
            ? byOf({
                kind: x["x_kind"],
                label: String(x["x_label"]),
                origin: String(x["x_origin"]),
              })
            : "user",
        ...(typeof why === "string" && why !== "" ? { reason: why } : {}),
        count: Number(x["x_count"]),
      },
    };
  });
  return { entries, more: (rows as Row[]).length > request.limit };
}

/** A change of the space: its seq, and the tasks whose tombstone it set, in reference order. */
export interface ChangeTasks {
  readonly seq: number;
  readonly tasks: readonly string[];
}

/**
 * The tasks a change moved to the Trash: every task whose tombstone its commit set, whether still
 * there or not. Undefined for a commit the space does not have, such as one from before a backup
 * was restored over it.
 */
export async function readChangeTasks(
  reader: WorkerConnection,
  change: string,
): Promise<ChangeTasks | undefined> {
  const [commit, tasks] = await reader.transaction("deferred", [
    { sql: "SELECT seq FROM commits WHERE id = $id", mode: "get", params: { id: change } },
    {
      sql:
        "SELECT t.id FROM commits k JOIN changes ch ON ch.seq = k.seq JOIN tasks t ON " +
        "t.id = ch.entity_id WHERE k.id = $id AND ch.entity = 'tasks' AND ch.field = 'deleted' " +
        "ORDER BY t.ref",
      mode: "all",
      params: { id: change },
    },
  ]);
  if (commit === null || commit === undefined) return undefined;
  return {
    seq: Number((commit as Row)["seq"]),
    tasks: [...new Set((tasks as Row[]).map((row) => String(row["id"])))],
  };
}
