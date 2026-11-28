// The Activity screen's lines: the commits of agents and routines, a page at a time by commit
// number. A line holds each thing its commit touched (a task, a project or an area) with what the
// commit did to that thing, so no thing borrows another's words. A note, a source, a log entry, a
// task's folder or run belongs to its task, a project's folder to its project. Commits only grow
// at the end and a commit never changes, so a page is the commits before or after a number, read
// by their key. Values travel only for fields that hold no free text, and a place by its name.
import type { Row, WorkerConnection } from "@ttasks/storage";
import { hasFolderTable, hasPageTable } from "./read.ts";

/** The actors whose changes the Activity screen lists: not the person, the system or an import. */
const ACTORS = "c.actor_kind IN ('agent', 'routine')";
/** A task's fields of free text: a line says that they changed, not what they say. */
const TASK_TEXT = "('title', 'summary', 'context', 'wrap', 'owner', 'waiting_on')";
/** Stored as 0 or 1, read as a flag. */
const FLAGS: ReadonlySet<string> = new Set(["inbox"]);
/** The targets a line holds at most; `count` says how many there were. */
const TARGETS = 50;
/** The acts a target holds at most. */
const ACTS = 40;

const page = (order: "before" | "after") =>
  "SELECT c.seq, c.at, c.kind, c.actor_kind, a.label FROM commits c JOIN actors a ON a.id = " +
  `c.principal_id WHERE ${order === "before" ? "c.seq < $at" : "c.seq > $at"} AND ${ACTORS} ` +
  `ORDER BY c.seq ${order === "before" ? "DESC" : "ASC"} LIMIT $limit`;

const SEQS = "SELECT value FROM json_each($seqs)";
const OPS =
  "SELECT c.seq, j.key AS i, json_extract(j.value, '$.op') AS op FROM commits c, " +
  `json_each(c.ops) j WHERE c.seq IN (${SEQS})`;
/** A field set by a change whose value a line may show. */
const VALUED =
  `action = 'set' AND ((entity = 'tasks' AND field NOT IN ${TASK_TEXT}) OR ` +
  "(entity = 'projects' AND field = 'grouping'))";
/** The thing a change belongs to: its kind and ID. */
const subject = (folders: boolean) =>
  "CASE WHEN task_id IS NOT NULL THEN 'task' WHEN entity = 'areas' THEN 'area' " +
  "WHEN entity = 'projects' THEN 'project' WHEN entity = 'pages' THEN 'page' " +
  (folders
    ? "WHEN entity = 'folders' THEN (SELECT owner_kind FROM folders f WHERE f.id = entity_id) " +
      "WHEN entity = 'runs' AND (SELECT task_id FROM runs r WHERE r.id = entity_id) IS NOT NULL " +
      "THEN 'task' "
    : "") +
  "END AS subject, CASE WHEN task_id IS NOT NULL THEN task_id " +
  "WHEN entity IN ('areas', 'projects', 'pages') THEN entity_id " +
  (folders
    ? "WHEN entity = 'folders' THEN (SELECT owner_id FROM folders f WHERE f.id = entity_id) " +
      "WHEN entity = 'runs' THEN (SELECT task_id FROM runs r WHERE r.id = entity_id) "
    : "") +
  "END AS subject_id";
/**
 * The changes of the page's commits, without their values of free text: of a field that holds
 * none its value, of a created task or project its place.
 */
const changes = (folders: boolean) =>
  `SELECT seq, op, entity, entity_id, action, field, ${subject(folders)}, ` +
  `CASE WHEN ${VALUED} THEN before END AS before, ` +
  `CASE WHEN ${VALUED} THEN after ` +
  "WHEN action = 'create' AND entity IN ('tasks', 'projects') THEN json_object('project_id', " +
  "json_extract(after, '$.project_id'), 'area_id', json_extract(after, '$.area_id')) " +
  `END AS after FROM changes WHERE seq IN (${SEQS}) ORDER BY seq, n`;

const NAMES =
  "SELECT 'task' AS kind, id, title AS name, ref, deleted_at FROM tasks WHERE id IN " +
  "(SELECT value FROM json_each($tasks)) UNION ALL SELECT 'project', id, title, NULL, " +
  "deleted_at FROM projects WHERE id IN (SELECT value FROM json_each($groups)) UNION ALL " +
  "SELECT 'area', id, title, NULL, deleted_at FROM areas WHERE id IN " +
  "(SELECT value FROM json_each($groups))";
/** From 0.6, the pages a page of lines touched, with their references. */
const PAGE_NAMES =
  " UNION ALL SELECT 'page', id, title, ref, deleted_at FROM pages WHERE id IN " +
  "(SELECT value FROM json_each($pages))";

/** A value a line shows. */
export type ActivityValue = string | number | boolean | null;

export interface ActivityAct {
  readonly op: string;
  readonly field?: string;
  readonly from?: ActivityValue;
  readonly to?: ActivityValue;
}

export interface ActivityTarget {
  readonly kind: "task" | "project" | "area" | "page";
  readonly id: string;
  readonly name: string;
  readonly ref?: string;
  readonly trash?: true;
  readonly created?: true;
  readonly acts: ActivityAct[];
}

export interface ActivityLine {
  readonly seq: number;
  readonly at: number;
  readonly actor: "agent" | "routine";
  readonly by: string;
  readonly kind?: string;
  readonly targets: ActivityTarget[];
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

type Kind = ActivityTarget["kind"];
const isKind = (value: unknown): value is Kind =>
  value === "task" || value === "project" || value === "area" || value === "page";

interface RawAct {
  readonly op: string;
  readonly field?: string;
  readonly from?: unknown;
  readonly to?: unknown;
}

interface Draft {
  readonly kind: Kind;
  readonly id: string;
  created: boolean;
  readonly acts: RawAct[];
  readonly seen: Set<string>;
}

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
  const folders = await hasFolderTable(reader);
  const [opRows, changeRows] = await reader.transaction("deferred", [
    { sql: OPS, mode: "all", params: { seqs } },
    { sql: changes(folders), mode: "all", params: { seqs } },
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

  // Each commit's targets in the order it touched them, and the acts that touched none.
  const taskIds = new Set<string>();
  const groupIds = new Set<string>();
  const pageIds = new Set<string>();
  const drafts = found.map((commit) => {
    const seq = Number(commit["seq"]);
    const targets = new Map<string, Draft>();
    const loose: RawAct[] = [];
    const looseSeen = new Set<string>();
    for (const change of bySeq.get(seq) ?? []) {
      const op = opOf.get(`${String(seq)}:${String(change["op"])}`) || "change";
      const kind = change["subject"];
      const id = change["subject_id"];
      const own = isKind(kind) && typeof id === "string";
      const field =
        change["action"] === "set" && typeof change["field"] === "string"
          ? change["field"]
          : undefined;
      const before = parse(change["before"]);
      const after = parse(change["after"]);
      for (const value of [before, after]) {
        for (const group of [record(value)["project_id"], record(value)["area_id"]]) {
          if (typeof group === "string") groupIds.add(group);
        }
      }
      const act: RawAct = {
        op,
        ...(field === undefined ? {} : { field }),
        ...(before === undefined ? {} : { from: before }),
        ...(after === undefined ? {} : { to: after }),
      };
      if (!own) {
        if (!looseSeen.has(op)) loose.push({ op });
        looseSeen.add(op);
        continue;
      }
      (kind === "task" ? taskIds : kind === "page" ? pageIds : groupIds).add(id);
      const key = `${kind}:${id}`;
      let target = targets.get(key);
      if (target === undefined) {
        target = { kind, id, created: false, acts: [], seen: new Set() };
        targets.set(key, target);
      }
      const table = { task: "tasks", project: "projects", area: "areas", page: "pages" }[kind];
      // A field of a child (a note's body) is no field of its target: the operation says it.
      const ownField = change["entity"] === table ? field : undefined;
      if (change["entity"] === table && change["action"] === "create") target.created = true;
      const seen = `${op}:${ownField ?? ""}`;
      if (target.seen.has(seen)) continue;
      target.seen.add(seen);
      target.acts.push(ownField === undefined ? { op, ...placeOf(act) } : act);
    }
    return { commit, targets: [...targets.values()], loose };
  });

  const pages = pageIds.size > 0 && (await hasPageTable(reader));
  const [nameRows] = await reader.transaction("deferred", [
    {
      sql: pages ? NAMES + PAGE_NAMES : NAMES,
      mode: "all",
      params: {
        tasks: JSON.stringify([...taskIds]),
        groups: JSON.stringify([...groupIds]),
        ...(pages ? { pages: JSON.stringify([...pageIds]) } : {}),
      },
    },
  ]);
  const named = new Map(
    (nameRows as Row[]).map((r) => [`${String(r["kind"])}:${String(r["id"])}`, r]),
  );
  const groupName = (id: unknown): string | undefined => {
    if (typeof id !== "string") return undefined;
    const row = named.get(`project:${id}`) ?? named.get(`area:${id}`);
    return row === undefined ? undefined : String(row["name"]);
  };
  /** A place by its name: its project's, else its area's; null for neither. */
  const place = (value: unknown): ActivityValue => {
    const { project_id: project, area_id: area } = record(value);
    return groupName(project) ?? groupName(area) ?? null;
  };
  /** A field's value as a line shows it: a scalar, or none for a value of several parts. */
  const shown = (field: string | undefined, value: unknown): ActivityValue | undefined => {
    if (value === undefined) return undefined;
    if (field === undefined || field === "grouping") return place(value);
    if (FLAGS.has(field)) return value === null ? null : value === 1 || value === true;
    if (field === "due") {
      if (value === null) return null;
      const due = record(value);
      return typeof due["due_date"] === "string"
        ? due["due_date"]
        : typeof due["due_at"] === "number"
          ? due["due_at"]
          : null;
    }
    if (typeof value === "string") return value.length <= 300 ? value : undefined;
    return value === null || typeof value === "number" || typeof value === "boolean"
      ? value
      : undefined;
  };
  const actOf = (act: RawAct): ActivityAct => {
    const from = act.field === undefined ? undefined : shown(act.field, act.from);
    const to = shown(act.field, act.to);
    return {
      op: act.op,
      ...(act.field === undefined ? {} : { field: act.field }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    };
  };

  const lines = drafts.map(({ commit, targets, loose }): ActivityLine => {
    const kind = String(commit["kind"]);
    return {
      seq: Number(commit["seq"]),
      at: Number(commit["at"]),
      actor: commit["actor_kind"] === "routine" ? "routine" : "agent",
      by: String(commit["label"]),
      ...(kind === "ops" ? {} : { kind }),
      targets: targets.slice(0, TARGETS).map((target): ActivityTarget => {
        const row = named.get(`${target.kind}:${target.id}`);
        const deleted = row?.["deleted_at"];
        return {
          kind: target.kind,
          id: target.id,
          name: row === undefined ? "" : String(row["name"]),
          ...((target.kind === "task" || target.kind === "page") && row !== undefined
            ? { ref: `${prefix}-${String(row["ref"])}` }
            : {}),
          ...(deleted === null || deleted === undefined ? {} : { trash: true as const }),
          ...(target.created ? { created: true as const } : {}),
          acts: target.acts.slice(0, ACTS).map(actOf),
        };
      }),
      count: targets.length,
      acts: loose.slice(0, ACTS).map(actOf),
    };
  });
  return { lines, more };
}

/** An act without a field of its target: only the place a create gave, if any. */
function placeOf(act: RawAct): Pick<RawAct, "to"> {
  return act.field === undefined && act.to !== undefined ? { to: act.to } : {};
}
