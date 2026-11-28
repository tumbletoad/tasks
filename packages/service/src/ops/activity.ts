// The Activity screen's lines: the commits of agents and routines, a page at a time by commit
// number, each with the tasks it touched and what it did. Commits only grow at the end and a commit
// never changes, so a page is the commits before or after a number, read by their key: a space with
// a long history costs no more than a short one. Values travel only for fields that hold no text,
// and a move's or a create's place by its name.
import type { Row, WorkerConnection } from "@ttasks/storage";

/** The actors whose changes the Activity screen lists: not the person, the system or an import. */
const ACTORS = "c.actor_kind IN ('agent', 'routine')";
/** A task's fields of text: a line says that they changed, not what they say. */
const TEXT_FIELDS = "('title', 'summary', 'context', 'wrap')";
/** The tasks a line names; the rest it counts. */
const NAMED = 3;
/** The acts a line holds at most. */
const ACTS = 40;

const page = (order: "before" | "after") =>
  "SELECT c.seq, c.at, c.kind, c.actor_kind, a.label FROM commits c JOIN actors a ON a.id = " +
  `c.principal_id WHERE ${order === "before" ? "c.seq < $at" : "c.seq > $at"} AND ${ACTORS} ` +
  `ORDER BY c.seq ${order === "before" ? "DESC" : "ASC"} LIMIT $limit`;

const SEQS = "SELECT value FROM json_each($seqs)";
const OPS = `SELECT c.seq, j.key AS i, json_extract(j.value, '$.op') AS op FROM commits c, json_each(c.ops) j WHERE c.seq IN (${SEQS})`;
/**
 * The changes of the page's commits, without their values of text: of a task's field that holds
 * no text its value, of a created task or a moved one its place, of a created area or project
 * its name.
 */
const CHANGES =
  "SELECT seq, op, entity, task_id, action, field, " +
  `CASE WHEN entity = 'tasks' AND action = 'set' AND field NOT IN ${TEXT_FIELDS} THEN before END AS before, ` +
  `CASE WHEN entity = 'tasks' AND action = 'set' AND field NOT IN ${TEXT_FIELDS} THEN after ` +
  "WHEN entity = 'tasks' THEN json_object('project_id', json_extract(after, '$.project_id'), " +
  "'area_id', json_extract(after, '$.area_id')) " +
  "WHEN entity IN ('areas', 'projects') AND action = 'create' THEN json_object('title', " +
  "json_extract(after, '$.title')) END AS after " +
  `FROM changes WHERE seq IN (${SEQS}) ORDER BY seq, n`;

/** A value a line shows. */
export type ActivityValue = string | number | boolean | null;

export interface ActivityAct {
  readonly op: string;
  readonly field?: string;
  readonly from?: ActivityValue;
  readonly to?: ActivityValue;
}

export interface ActivityLine {
  readonly seq: number;
  readonly at: number;
  readonly actor: "agent" | "routine";
  readonly by: string;
  readonly kind?: string;
  readonly tasks: { id: string; ref: string; title: string; trash?: true }[];
  readonly count: number;
  readonly acts: ActivityAct[];
}

export interface ActivityRequest {
  /** Lines before this commit number; with neither, the newest. */
  readonly before?: number | undefined;
  /** Lines after this commit number. */
  readonly after?: number | undefined;
  readonly limit: number;
}

const parse = (text: unknown): unknown => {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * A page of lines, newest first: up to `limit`, and whether more lie past it (older ones, or with
 * `after`, newer ones).
 */
export async function readActivity(
  reader: WorkerConnection,
  request: ActivityRequest,
): Promise<{ lines: ActivityLine[]; more: boolean }> {
  const newer = request.after !== undefined;
  const at = request.after ?? request.before ?? Number.MAX_SAFE_INTEGER;
  const [prefixRow, commitRows] = await reader.transaction("deferred", [
    { sql: "SELECT ref_prefix FROM space WHERE one = 1", mode: "get" },
    {
      sql: page(newer ? "after" : "before"),
      mode: "all",
      params: { at, limit: request.limit + 1 },
    },
  ]);
  const found = (commitRows as Row[]).slice(0, request.limit);
  const more = (commitRows as Row[]).length > request.limit;
  if (newer) found.reverse();
  if (found.length === 0) return { lines: [], more };
  const prefixValue = (prefixRow as Row | null)?.["ref_prefix"];
  const prefix = typeof prefixValue === "string" ? prefixValue : "";
  const seqs = JSON.stringify(found.map((c) => Number(c["seq"])));
  const [opRows, changeRows] = await reader.transaction("deferred", [
    { sql: OPS, mode: "all", params: { seqs } },
    { sql: CHANGES, mode: "all", params: { seqs } },
  ]);

  const opOf = new Map<string, string>();
  for (const row of opRows as Row[]) {
    const op = row["op"];
    opOf.set(`${String(row["seq"])}:${String(row["i"])}`, typeof op === "string" ? op : "");
  }
  const bySeq = new Map<number, Row[]>();
  for (const change of changeRows as Row[]) {
    const seq = Number(change["seq"]);
    const list = bySeq.get(seq) ?? [];
    list.push(change);
    bySeq.set(seq, list);
  }

  // Names of the areas and projects the values point at, and the tasks the lines name.
  const groups = new Set<string>();
  const named = new Set<string>();
  const drafts = found.map((commit) => {
    const seq = Number(commit["seq"]);
    const tasks: string[] = [];
    const acts: { op: string; field?: string; from?: unknown; to?: unknown }[] = [];
    const seen = new Set<string>();
    for (const change of bySeq.get(seq) ?? []) {
      const task = change["task_id"];
      if (typeof task === "string" && !tasks.includes(task)) tasks.push(task);
      const op = opOf.get(`${String(seq)}:${String(change["op"])}`) || "change";
      const entity = String(change["entity"]);
      const set = change["action"] === "set" && entity === "tasks";
      const field = set && typeof change["field"] === "string" ? change["field"] : undefined;
      const key = `${op}:${field ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const before = parse(change["before"]);
      const after = parse(change["after"]);
      if (field === "grouping" || (entity === "tasks" && change["action"] === "create")) {
        for (const value of [before, after]) {
          for (const id of [record(value)["project_id"], record(value)["area_id"]]) {
            if (typeof id === "string") groups.add(id);
          }
        }
      }
      acts.push({
        op,
        ...(field === undefined ? {} : { field }),
        ...(before === undefined ? {} : { from: before }),
        ...(after === undefined ? {} : { to: after }),
      });
    }
    for (const task of tasks.slice(0, NAMED)) named.add(task);
    return { commit, tasks, acts };
  });

  const ids = (set: Set<string>) => JSON.stringify([...set]);
  const [taskRows, groupRows] = await reader.transaction("deferred", [
    {
      sql: "SELECT id, ref, title, deleted_at FROM tasks WHERE id IN (SELECT value FROM json_each($ids))",
      mode: "all",
      params: { ids: ids(named) },
    },
    {
      sql:
        "SELECT id, title FROM projects WHERE id IN (SELECT value FROM json_each($ids)) " +
        "UNION ALL SELECT id, title FROM areas WHERE id IN (SELECT value FROM json_each($ids))",
      mode: "all",
      params: { ids: ids(groups) },
    },
  ]);
  const taskOf = new Map((taskRows as Row[]).map((t) => [String(t["id"]), t]));
  const groupName = new Map((groupRows as Row[]).map((g) => [String(g["id"]), String(g["title"])]));
  /** A task's place by its name: its project's, else its area's; null for neither. */
  const place = (value: unknown): ActivityValue => {
    const { project_id: project, area_id: area } = record(value);
    if (typeof project === "string") return groupName.get(project) ?? null;
    if (typeof area === "string") return groupName.get(area) ?? null;
    return null;
  };
  /** A field's value as a line shows it: a scalar, or none for a value of several parts. */
  const shown = (field: string | undefined, value: unknown): ActivityValue | undefined => {
    if (field === "grouping") return place(value);
    if (field === "due") {
      const due = record(value);
      if (value === null) return null;
      return typeof due["due_date"] === "string"
        ? due["due_date"]
        : typeof due["due_at"] === "number"
          ? due["due_at"]
          : null;
    }
    if (field === undefined) {
      const title = record(value)["title"];
      if (typeof title === "string") return title;
      return "project_id" in record(value) ? place(value) : undefined;
    }
    if (typeof value === "string") return value.length <= 300 ? value : undefined;
    return value === null || typeof value === "number" || typeof value === "boolean"
      ? value
      : undefined;
  };

  const lines = drafts.map(({ commit, tasks, acts }): ActivityLine => {
    const kind = String(commit["kind"]);
    return {
      seq: Number(commit["seq"]),
      at: Number(commit["at"]),
      actor: commit["actor_kind"] === "routine" ? "routine" : "agent",
      by: String(commit["label"]),
      ...(kind === "ops" ? {} : { kind }),
      tasks: tasks.slice(0, NAMED).flatMap((id) => {
        const row = taskOf.get(id);
        if (row === undefined) return [];
        return [
          {
            id,
            ref: `${prefix}-${String(row["ref"])}`,
            title: String(row["title"]),
            ...(row["deleted_at"] === null || row["deleted_at"] === undefined
              ? {}
              : { trash: true as const }),
          },
        ];
      }),
      count: tasks.length,
      acts: acts.slice(0, ACTS).map((act) => {
        const from = shown(act.field, act.from);
        const to = shown(act.field, act.to);
        return {
          op: act.op,
          ...(act.field === undefined ? {} : { field: act.field }),
          ...(from === undefined || act.field === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        };
      }),
    };
  });
  return { lines, more };
}
