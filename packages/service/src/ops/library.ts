// The library's reads: a page, a node's texts with the levels above it and its pages, the trail
// above a task, the versions of a page or a description, the page Trash, and the pages the feed
// carries. Every read is one snapshot of the reader. Who changed a page last is the commit at its
// row version, never its provenance, which an Undo can move back to an earlier author.
import { AppError } from "@ttasks/contracts";
import { formatTaskRef, PAGE_SHOWN, type Row, type WorkerConnection } from "@ttasks/storage";
import { byOf } from "./errors.ts";
import { resolveGroup } from "./groups.ts";
import { hasPageTable, spaceFacts, type GroupNames, type SpaceFacts } from "./read.ts";

/** The rows of one list in one answer; a longer one goes on with the cursor. */
export const LIST = 25;
/** Characters of a body or a description in one answer; the cursor reads on. */
export const TEXT_CHARS = 4_000;

export type NodeKind = "space" | "area" | "project";
export interface Node {
  readonly kind: NodeKind;
  readonly id: string;
}

/** What a read or a write names: a page by its reference or ID, or a node. */
export type Target = { readonly page: string } | { readonly node: Node };

/** Who and when of a commit, as answers name them. */
const WHO =
  "k.at AS at, k.reason AS why, a.kind AS actor_kind, a.label AS label, k.origin AS origin";
const BY_SEQ = (seq: string) =>
  `JOIN commits k ON k.seq = ${seq} JOIN actors a ON a.id = k.author_id`;

const SQL = {
  space: "SELECT * FROM space WHERE one = 1",
  pageByRef: `SELECT p.*, ${PAGE_SHOWN} AS shown, ${WHO} FROM pages p ${BY_SEQ("p.version")} WHERE p.ref = $ref`,
  pageById: `SELECT p.*, ${PAGE_SHOWN} AS shown, ${WHO} FROM pages p ${BY_SEQ("p.version")} WHERE p.id = $id`,
  texts:
    `SELECT x.*, coalesce(json_extract(x.fp, '$.for_agents'), x.created_seq) AS instructed, ` +
    "(SELECT at FROM commits WHERE seq = coalesce(json_extract(x.fp, '$.for_agents'), " +
    "x.created_seq)) AS instructed_at FROM node_texts x WHERE x.owner_id = $id",
  textsWho: `SELECT ${WHO} FROM node_texts x ${BY_SEQ("x.version")} WHERE x.owner_id = $id`,
  area: "SELECT id, title, brief, deleted_at FROM areas WHERE id = $id",
  project: "SELECT id, title, brief, area_id, deleted_at FROM projects WHERE id = $id",
  task: "SELECT id, ref, title, area_id, project_id, deleted_at FROM tasks WHERE id = $id",
  ownPages:
    `SELECT p.ref, p.title, p.brief, ${WHO} FROM pages p ${BY_SEQ("p.version")} ` +
    "WHERE p.owner_id = $id AND p.deleted_at IS NULL ORDER BY p.title, p.ref " +
    "LIMIT $limit OFFSET $offset",
  ownCount: "SELECT count(*) AS n FROM pages WHERE owner_id = $id AND deleted_at IS NULL",
  taskPages:
    `SELECT p.ref, p.title, p.brief, t.ref AS task_ref, ${WHO} FROM pages p ` +
    `JOIN tasks t ON t.id = p.owner_id ${BY_SEQ("p.version")} ` +
    "WHERE p.owner_kind = 'task' AND p.deleted_at IS NULL AND t.deleted_at IS NULL " +
    "AND (t.project_id = $id OR t.area_id = $id) ORDER BY p.title, p.ref LIMIT $limit OFFSET $offset",
  taskCount:
    "SELECT count(*) AS n FROM pages p JOIN tasks t ON t.id = p.owner_id WHERE p.owner_kind = " +
    "'task' AND p.deleted_at IS NULL AND t.deleted_at IS NULL AND (t.project_id = $id OR t.area_id = $id)",
  versions:
    `SELECT c.seq, ${WHO}, json_extract(k.ops, '$[0].input.from_seq') AS restored_from, ` +
    "length(CASE c.action WHEN 'create' THEN json_extract(c.after, $path) " +
    "ELSE json_extract(c.after, '$') END) AS chars FROM changes c " +
    `${BY_SEQ("c.seq")} WHERE c.entity = $entity AND c.entity_id = $id ` +
    "AND (c.action = 'create' OR c.field = $field) AND c.seq < $before " +
    "ORDER BY c.seq DESC LIMIT $limit",
  version:
    `SELECT c.seq, ${WHO}, json_extract(k.ops, '$[0].input.from_seq') AS restored_from, ` +
    "CASE c.action WHEN 'create' THEN json_extract(c.after, $path) " +
    "ELSE json_extract(c.after, '$') END AS text FROM changes c " +
    `${BY_SEQ("c.seq")} WHERE c.entity = $entity AND c.entity_id = $id AND c.seq = $seq ` +
    "AND (c.action = 'create' OR c.field = $field)",
} as const;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const iso = (at: unknown): string => new Date(Number(at)).toISOString();

/** The last change a row shows, from its WHO columns. */
function lastOf(row: Row): { by: string; at: string; why?: string } {
  const why = row["why"];
  return {
    by: byOf({
      kind: text(row["actor_kind"]),
      label: text(row["label"]),
      origin: text(row["origin"]),
    }),
    at: iso(row["at"]),
    ...(typeof why === "string" && why !== "" ? { why } : {}),
  };
}

const notFound = (field: string, what: string): AppError =>
  new AppError({
    code: "not_found",
    message: `The space has no ${what} there.`,
    hint: 'Name a page by its reference (M-180), a project as "Area/Project", or "space".',
    data: { field },
  });

/**
 * The node `given` names: "space", an area's or a project's ID, "Area", or "Area/Project". A page
 * reference is a page; undefined for one, so the caller reads it as a page.
 */
export function targetOf(
  given: string,
  names: GroupNames,
  refPrefix: string,
  field: string,
): Target {
  const whole = given.trim();
  if (new RegExp(`^${refPrefix}-[1-9][0-9]{0,9}$`, "u").test(whole) || /^pg_/u.test(whole)) {
    return { page: whole };
  }
  if (whole.toLowerCase() === "space") return { node: { kind: "space", id: "" } };
  if (/^a_/u.test(whole)) return { node: { kind: "area", id: whole } };
  if (/^p_/u.test(whole)) return { node: { kind: "project", id: whole } };
  const [areaName = "", projectName, ...more] = whole.split("/").map((part) => part.trim());
  if (areaName === "" || more.length > 0 || projectName === "")
    throw notFound(field, "page or node");
  const area = resolveGroup(names, "area", areaName, field, { lookup: true }) ?? "";
  if (projectName === undefined) return { node: { kind: "area", id: area } };
  const project = resolveGroup(names, "project", projectName, field, { lookup: true, area }) ?? "";
  return { node: { kind: "project", id: project } };
}

/** A page row by its reference or ID, shown or not, with its last change; undefined for none. */
export async function readPageRow(
  reader: WorkerConnection,
  given: string,
): Promise<{ space: SpaceFacts; row: Row | undefined }> {
  const ref = /-([1-9][0-9]{0,9})$/u.exec(given)?.[1];
  const [spaceRow, row] = await reader.transaction("deferred", [
    { sql: SQL.space, mode: "get" },
    ref === undefined
      ? { sql: SQL.pageById, mode: "get", params: { id: given } }
      : { sql: SQL.pageByRef, mode: "get", params: { ref: Number(ref) } },
  ]);
  return { space: spaceFacts(spaceRow), row: (row as Row | null) ?? undefined };
}

/** The headings of a Markdown text, in order, with their levels and where they stand. */
function headings(body: string): { level: number; text: string; at: number }[] {
  const found: { level: number; text: string; at: number }[] = [];
  let at = 0;
  for (const line of body.split("\n")) {
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (match !== null) found.push({ level: (match[1] ?? "").length, text: match[2] ?? "", at });
    at += line.length + 1;
  }
  return found;
}

/** The part of `body` under the heading `name`, up to the next heading at its level or higher. */
function sectionOf(body: string, name: string): string | undefined {
  const all = headings(body);
  const wanted = name.trim().toLowerCase();
  const i = all.findIndex((h) => h.text.toLowerCase() === wanted);
  const start = all[i];
  if (start === undefined) return undefined;
  const next = all.slice(i + 1).find((h) => h.level <= start.level);
  return body.slice(start.at, next?.at ?? body.length).replace(/\n+$/u, "");
}

/** A text read a part at a time: this answer's part, its slice, and the cursor for the rest. */
function paged(
  whole: string,
  cursor: string | undefined,
): {
  text: string;
  slice?: { from: number; to: number; of: number };
  cursor?: string;
} {
  const chars = Array.from(whole);
  const from = cursor?.startsWith("b") === true ? Number(cursor.slice(1)) || 0 : 0;
  if (from === 0 && chars.length <= TEXT_CHARS) return { text: whole };
  const to = Math.min(chars.length, from + TEXT_CHARS);
  return {
    text: chars.slice(from, to).join(""),
    slice: { from, to, of: chars.length },
    ...(to < chars.length ? { cursor: `b${String(to)}` } : {}),
  };
}

/** `read` of a page: its words whole, one heading's part, or a part at a time. */
export function pageView(
  space: SpaceFacts,
  row: Row,
  owner: { kind: string; id: string; title: string; read: string },
  section: string | undefined,
  cursor: string | undefined,
): Record<string, unknown> {
  const body = text(row["body"]);
  const base = {
    view: "page",
    as_of: space.asOf,
    id: row["id"],
    ref: formatTaskRef(space.refPrefix, Number(row["ref"])),
    title: text(row["title"]),
    brief: text(row["brief"]),
    owner,
    last: lastOf(row),
    version: Number(row["version"]),
  };
  if (section !== undefined) {
    const part = sectionOf(body, section);
    if (part === undefined)
      return {
        ...base,
        headings: headings(body)
          .map((h) => h.text)
          .slice(0, 200),
      };
    const { text: shown, slice, cursor: next } = paged(part, cursor);
    return {
      ...base,
      section,
      body: shown,
      ...(slice ? { slice } : {}),
      ...(next ? { cursor: next } : {}),
    };
  }
  const { text: shown, slice, cursor: next } = paged(body, cursor);
  return { ...base, body: shown, ...(slice ? { slice } : {}), ...(next ? { cursor: next } : {}) };
}

/** What holds a page, by name and with its own `read` target. */
export async function ownerOf(
  reader: WorkerConnection,
  space: SpaceFacts,
  row: Row,
): Promise<{ kind: string; id: string; title: string; read: string }> {
  const kind = text(row["owner_kind"]);
  const id = text(row["owner_id"]);
  if (kind === "space") return { kind, id, title: space.name, read: "space" };
  const sql = kind === "task" ? SQL.task : kind === "area" ? SQL.area : SQL.project;
  const [found] = await reader.transaction("deferred", [{ sql, mode: "get", params: { id } }]);
  const owner = (found as Row | null) ?? {};
  if (kind === "task") {
    const ref = formatTaskRef(space.refPrefix, Number(owner["ref"]));
    return { kind, id, title: text(owner["title"]), read: ref };
  }
  return { kind, id, title: text(owner["title"]), read: id };
}

/** One page in a list. */
const pageRow = (prefix: string, row: Row) => ({
  ref: formatTaskRef(prefix, Number(row["ref"])),
  title: text(row["title"]),
  brief: text(row["brief"]),
  by: lastOf(row).by,
  at: lastOf(row).at,
});

/** A node as a level: what it is, its texts, and its first pages, nearest first in a trail. */
export async function levelOf(
  reader: WorkerConnection,
  space: SpaceFacts,
  node: Node,
  limit = LIST,
): Promise<Record<string, unknown>> {
  const id = node.kind === "space" ? space.id : node.id;
  const own =
    node.kind === "space"
      ? undefined
      : {
          sql: node.kind === "area" ? SQL.area : SQL.project,
          mode: "get" as const,
          params: { id },
        };
  const [texts, pages, count, row] = await reader.transaction("deferred", [
    { sql: SQL.texts, mode: "get", params: { id } },
    { sql: SQL.ownPages, mode: "all", params: { id, limit, offset: 0 } },
    { sql: SQL.ownCount, mode: "get", params: { id } },
    own ?? { sql: SQL.space, mode: "get" },
  ]);
  const t = (texts as Row | null) ?? undefined;
  const r = (row as Row | null) ?? {};
  const forAgents = text(t?.["for_agents"]);
  return {
    kind: node.kind,
    id,
    title: node.kind === "space" ? space.name : text(r["title"]),
    brief: node.kind === "space" ? text(t?.["brief"]) : text(r["brief"]),
    read: node.kind === "space" ? "space" : id,
    has_description: text(t?.["description"]) !== "",
    ...(forAgents === "" ? {} : { for_agents: { text: forAgents, at: iso(t?.["instructed_at"]) } }),
    pages: (pages as Row[]).map((p) => pageRow(space.refPrefix, p)),
    count: Number((count as Row | null)?.["n"] ?? 0),
  };
}

/** The levels above a node or a task, nearest first: its project, its area, the space. */
export async function levelsAbove(
  reader: WorkerConnection,
  space: SpaceFacts,
  groups: { readonly project?: string | null; readonly area?: string | null },
): Promise<Record<string, unknown>[]> {
  const nodes: Node[] = [];
  if (typeof groups.project === "string") nodes.push({ kind: "project", id: groups.project });
  if (typeof groups.area === "string") nodes.push({ kind: "area", id: groups.area });
  nodes.push({ kind: "space", id: space.id });
  return Promise.all(nodes.map((node) => levelOf(reader, space, node)));
}

/** `read` of a node: its texts, the levels above it, and its pages and its tasks' pages. */
export async function nodeView(
  reader: WorkerConnection,
  node: Node,
  cursor: string | undefined,
): Promise<Record<string, unknown>> {
  const [spaceRow] = await reader.transaction("deferred", [{ sql: SQL.space, mode: "get" }]);
  const space = spaceFacts(spaceRow);
  const id = node.kind === "space" ? space.id : node.id;
  const offset = cursor?.startsWith("l") === true ? Number(cursor.slice(1)) || 0 : 0;
  const own =
    node.kind === "space"
      ? { sql: SQL.space, mode: "get" as const }
      : {
          sql: node.kind === "area" ? SQL.area : SQL.project,
          mode: "get" as const,
          params: { id },
        };
  const [row, texts, who, pages, count, taskPages, taskCount] = await reader.transaction(
    "deferred",
    [
      own,
      { sql: SQL.texts, mode: "get", params: { id } },
      { sql: SQL.textsWho, mode: "get", params: { id } },
      { sql: SQL.ownPages, mode: "all", params: { id, limit: LIST, offset } },
      { sql: SQL.ownCount, mode: "get", params: { id } },
      { sql: SQL.taskPages, mode: "all", params: { id, limit: LIST, offset } },
      { sql: SQL.taskCount, mode: "get", params: { id } },
    ],
  );
  const r = (row as Row | null) ?? undefined;
  if (r === undefined || (node.kind !== "space" && r["deleted_at"] !== null)) {
    throw notFound("target", "project or area");
  }
  const t = (texts as Row | null) ?? undefined;
  const above =
    node.kind === "space"
      ? []
      : await levelsAbove(reader, space, {
          area: node.kind === "project" ? (r["area_id"] as string | null) : null,
        });
  const forAgents = text(t?.["for_agents"]);
  const description = paged(
    text(t?.["description"]),
    cursor?.startsWith("b") === true ? cursor : undefined,
  );
  const ownTotal = Number((count as Row | null)?.["n"] ?? 0);
  const taskTotal = Number((taskCount as Row | null)?.["n"] ?? 0);
  const listed = (pages as Row[]).length;
  const tasksListed = (taskPages as Row[]).length;
  const further = offset + Math.max(listed, tasksListed);
  const more = further < Math.max(ownTotal, taskTotal);
  return {
    view: "node",
    as_of: space.asOf,
    kind: node.kind,
    id,
    title: node.kind === "space" ? space.name : text(r["title"]),
    brief: node.kind === "space" ? text(t?.["brief"]) : text(r["brief"]),
    ...(forAgents === "" ? {} : { for_agents: { text: forAgents, at: iso(t?.["instructed_at"]) } }),
    description: description.text,
    ...(description.slice ? { slice: description.slice } : {}),
    ...(who === null || who === undefined ? {} : { last: lastOf(who as Row) }),
    ...(t === undefined ? {} : { version: Number(t["version"]) }),
    above,
    pages: (pages as Row[]).map((p) => pageRow(space.refPrefix, p)),
    task_pages: (taskPages as Row[]).map((p) => ({
      ...pageRow(space.refPrefix, p),
      task: formatTaskRef(space.refPrefix, Number(p["task_ref"])),
    })),
    more: {
      pages: Math.max(0, ownTotal - offset - listed),
      task_pages: Math.max(0, taskTotal - offset - tasksListed),
    },
    ...(description.cursor
      ? { cursor: description.cursor }
      : more
        ? { cursor: `l${String(further)}` }
        : {}),
  };
}

/** `page.history`: the versions of a page's body or a node's description, or one version's words. */
export async function readHistory(
  reader: WorkerConnection,
  target: { entity: "pages" | "node_texts"; id: string },
  input: { seq?: number | undefined; cursor?: string | undefined; limit: number },
): Promise<Record<string, unknown>> {
  const field = target.entity === "pages" ? "body" : "description";
  const params = { entity: target.entity, id: target.id, field, path: `$.${field}` };
  const [spaceRow, rows] = await reader.transaction("deferred", [
    { sql: SQL.space, mode: "get" },
    input.seq !== undefined
      ? { sql: SQL.version, mode: "get", params: { ...params, seq: input.seq } }
      : {
          sql: SQL.versions,
          mode: "all",
          params: {
            ...params,
            before: input.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(input.cursor),
            limit: input.limit + 1,
          },
        },
  ]);
  const space = spaceFacts(spaceRow);
  const version = (row: Row, chars: number) => {
    const from = row["restored_from"];
    return {
      seq: Number(row["seq"]),
      ...lastOf(row),
      ...(typeof from === "number" ? { restored_from: from } : {}),
      chars,
    };
  };
  if (input.seq !== undefined) {
    const row = (rows as Row | null) ?? undefined;
    if (row === undefined) throw notFound("seq", "version made by that change");
    const words = text(row["text"]);
    return {
      view: "version",
      as_of: space.asOf,
      version: version(row, Array.from(words).length),
      text: words,
    };
  }
  const list = rows as Row[];
  const shown = list.slice(0, input.limit);
  const last = shown.at(-1);
  return {
    view: "versions",
    as_of: space.asOf,
    versions: shown.map((row) => version(row, Number(row["chars"] ?? 0))),
    ...(list.length > input.limit && last !== undefined ? { cursor: String(last["seq"]) } : {}),
  };
}

/**
 * The feed's and the Trash's page row: everything but the body, with what holds it, and who made
 * the change `seq` names (an SQL expression).
 */
const compactSql = (seq: string, extra = ""): string =>
  "SELECT p.id, p.ref, p.title, p.brief, p.owner_kind, p.owner_id, p.version, p.deleted_at AS own_deleted, " +
  `${PAGE_SHOWN} AS shown, t.ref AS task_ref, t.title AS task_title, t.lifecycle AS task_lifecycle, ` +
  "coalesce(t.deleted_at, r.deleted_at, ar.deleted_at) AS owner_deleted, " +
  "coalesce(t.project_id, r.id) AS project_id, coalesce(t.area_id, r.area_id, ar.id) AS area_id, " +
  "coalesce(t.title, r.title, ar.title) AS owner_title, " +
  `${WHO}${extra} FROM pages p LEFT JOIN tasks t ON p.owner_kind = 'task' AND t.id = p.owner_id ` +
  "LEFT JOIN projects r ON p.owner_kind = 'project' AND r.id = p.owner_id " +
  "LEFT JOIN areas ar ON p.owner_kind = 'area' AND ar.id = p.owner_id " +
  BY_SEQ(seq);
export const COMPACT_PAGE = compactSql("p.version");

/** A compact page row (contracts' CompactPage) from a COMPACT_PAGE row. */
export function compactPage(prefix: string, row: Row): Record<string, unknown> {
  const deleted = row["own_deleted"] ?? row["owner_deleted"];
  const why = row["why"];
  return {
    id: row["id"],
    ref: formatTaskRef(prefix, Number(row["ref"])),
    title: text(row["title"]),
    brief: text(row["brief"]),
    owner_kind: row["owner_kind"],
    owner_id: row["owner_id"],
    ...(row["owner_kind"] === "task"
      ? {
          task: {
            ref: formatTaskRef(prefix, Number(row["task_ref"])),
            title: text(row["task_title"]),
            lifecycle: text(row["task_lifecycle"]),
          },
        }
      : {}),
    ...(typeof row["area_id"] === "string" ? { area_id: row["area_id"] } : {}),
    ...(typeof row["project_id"] === "string" ? { project_id: row["project_id"] } : {}),
    version: Number(row["version"]),
    by: lastOf(row).by,
    at: Number(row["at"]),
    ...(typeof why === "string" && why !== "" ? { why } : {}),
    ...(typeof deleted === "number" ? { deleted_at: deleted } : {}),
  };
}

/** Every page the snapshot carries: those shown, without their bodies. */
export const LIVE_PAGES = `${COMPACT_PAGE} WHERE p.deleted_at IS NULL AND ${PAGE_SHOWN} ORDER BY p.ref`;

/** The pages a batch's commits touched, or whose holder they touched, as they stand. */
export const TOUCHED_PAGES =
  `${COMPACT_PAGE} WHERE p.id IN (SELECT value FROM json_each($pages)) ` +
  "OR p.owner_id IN (SELECT value FROM json_each($owners)) ORDER BY p.ref";

/** `page.trashed`: the pages someone moved to the Trash, newest first, each with its change. */
export async function readPageTrash(
  reader: WorkerConnection,
  input: { q?: string | undefined; limit: number; cursor?: string | undefined },
): Promise<Record<string, unknown>> {
  const [seq, ref] = (input.cursor ?? "").split(".").map(Number);
  const words = input.q?.trim().toLowerCase() ?? "";
  const [spaceRow, rows] = await reader.transaction("deferred", [
    { sql: SQL.space, mode: "get" },
    {
      sql:
        `${compactSql("json_extract(p.fp, '$.deleted')", ", k.id AS commit_id, k.seq AS commit_seq")} ` +
        "WHERE p.deleted_at IS NOT NULL AND " +
        `${PAGE_SHOWN} AND ($q = '' OR lower(p.title) LIKE '%' || $q || '%' OR $ref = p.ref) ` +
        "AND ($seq IS NULL OR k.seq < $seq OR (k.seq = $seq AND p.ref < $cref)) " +
        "ORDER BY k.seq DESC, p.ref DESC LIMIT $limit",
      mode: "all",
      params: {
        q: words,
        ref: Number(/-([0-9]+)$/u.exec(words)?.[1] ?? 0),
        seq: Number.isFinite(seq) && input.cursor !== undefined ? (seq ?? null) : null,
        cref: ref ?? 0,
        limit: input.limit + 1,
      },
    },
  ]);
  const space = spaceFacts(spaceRow);
  const list = rows as Row[];
  const shown = list.slice(0, input.limit);
  const last = shown.at(-1);
  return {
    rows: shown.map((row) => ({
      ...compactPage(space.refPrefix, row),
      on: row["owner_kind"] === "space" ? space.name : text(row["owner_title"]),
      removed: {
        id: row["commit_id"],
        at: iso(row["at"]),
        by: lastOf(row).by,
        ...(typeof row["why"] === "string" && row["why"] !== "" ? { reason: row["why"] } : {}),
        count: 1,
      },
    })),
    ...(list.length > input.limit && last !== undefined
      ? { cursor: `${String(last["commit_seq"])}.${String(last["ref"])}` }
      : {}),
  };
}

/** A task by its reference or ID, with its project and area; undefined for none. */
export async function taskGroups(
  reader: WorkerConnection,
  given: string,
): Promise<{ id: string; project: string | null; area: string | null } | undefined> {
  const ref = /^[A-Z]{1,6}-([1-9][0-9]{0,9})$/u.exec(given)?.[1];
  const [row] = await reader.transaction("deferred", [
    {
      sql: "SELECT id, project_id, area_id FROM tasks WHERE (id = $id OR ref = $ref) AND deleted_at IS NULL",
      mode: "get",
      params: { id: given, ref: ref === undefined ? 0 : Number(ref) },
    },
  ]);
  const found = (row as Row | null) ?? undefined;
  if (found === undefined) return undefined;
  return {
    id: text(found["id"]),
    project: typeof found["project_id"] === "string" ? found["project_id"] : null,
    area: typeof found["area_id"] === "string" ? found["area_id"] : null,
  };
}

/** What holds a page now, by name. */
export async function holderName(
  reader: WorkerConnection,
  owner: { kind: string; id: string },
): Promise<string> {
  const [spaceRow] = await reader.transaction("deferred", [{ sql: SQL.space, mode: "get" }]);
  const space = spaceFacts(spaceRow);
  return (await ownerOf(reader, space, { owner_kind: owner.kind, owner_id: owner.id })).title;
}

/** A node as the writer's operations name it. */
export function textNode(
  node: Node,
): { kind: "space" } | { kind: "area"; area: string } | { kind: "project"; project: string } {
  if (node.kind === "space") return { kind: "space" };
  return node.kind === "area"
    ? { kind: "area", area: node.id }
    : { kind: "project", project: node.id };
}

/** A space at a revision before pages: it has no library until its migration runs. */
export const noLibrary = (): AppError =>
  new AppError({
    code: "not_found",
    message: "This space has no library yet: it opens at an older version.",
    hint: "Ask the user to open the space for writing, so it upgrades.",
  });

export const noPage = (field: string): AppError => notFound(field, "page");

/** The library's documents: pages, and the lessons of tasks finished before pages existed. */
const LIBRARY_DOCS =
  "SELECT d.kind, d.entity_id, bm25(search_fts, 10.0, 3.0, 2.0) AS score, " +
  "snippet(search_fts, 1, '', '', '...', 12) AS snippet FROM search_fts " +
  "JOIN search_docs d ON d.doc = search_fts.rowid WHERE search_fts MATCH $match " +
  "AND d.kind IN ('page', 'learning') AND ($agent = 0 OR d.audience = 'all') " +
  "ORDER BY score LIMIT $limit";
/** With no words: the pages changed last. */
const NEWEST_PAGES =
  `SELECT 'page' AS kind, p.id AS entity_id, NULL AS snippet FROM pages p WHERE p.deleted_at IS NULL ` +
  `AND ${PAGE_SHOWN} ORDER BY p.version DESC LIMIT $limit`;
const LIBRARY_PAGE = `SELECT p.*, ${WHO} FROM pages p ${BY_SEQ("p.version")} WHERE p.id = $id`;
const LIBRARY_LEARNING =
  "SELECT l.id, l.body, l.created_at, t.ref, t.title, a.title AS area_title, r.title AS project_title " +
  "FROM learnings l JOIN tasks t ON t.id = l.task_id LEFT JOIN areas a ON a.id = t.area_id " +
  "LEFT JOIN projects r ON r.id = t.project_id WHERE l.id = $id";

/**
 * `search` in scope `library`: pages and lessons together, best match first, one page of rows. A
 * page shows what holds it by name; a lesson its task.
 */
export async function searchLibrary(
  reader: WorkerConnection,
  input: { match: string | null; limit: number; agent: boolean; parsed: string },
): Promise<Record<string, unknown>> {
  const [spaceRow, found] = await reader.transaction("deferred", [
    { sql: SQL.space, mode: "get" },
    input.match === null
      ? { sql: NEWEST_PAGES, mode: "all", params: { limit: input.limit } }
      : {
          sql: LIBRARY_DOCS,
          mode: "all",
          params: { match: input.match, agent: input.agent ? 1 : 0, limit: input.limit },
        },
  ]);
  const space = spaceFacts(spaceRow);
  const hits = found as Row[];
  const reads = await reader.transaction(
    "deferred",
    hits.map((hit) => ({
      sql: hit["kind"] === "page" ? LIBRARY_PAGE : LIBRARY_LEARNING,
      mode: "get" as const,
      params: { id: text(hit["entity_id"]) },
    })),
  );
  const rows: Record<string, unknown>[] = [];
  for (const [i, hit] of hits.entries()) {
    const row = (reads[i] as Row | null) ?? undefined;
    if (row === undefined) continue;
    const snippet = text(hit["snippet"]);
    if (hit["kind"] === "page") {
      const owner = await ownerOf(reader, space, row);
      rows.push({
        kind: "page",
        ...pageRow(space.refPrefix, row),
        on: owner.title,
        ...(snippet === "" ? {} : { snippet: snippet.slice(0, 100) }),
      });
      continue;
    }
    rows.push({
      kind: "learning",
      id: row["id"],
      task: formatTaskRef(space.refPrefix, Number(row["ref"])),
      title: text(row["title"]).slice(0, 90),
      date: iso(row["created_at"]).slice(0, 10),
      ...(typeof row["area_title"] === "string" ? { area: row["area_title"] } : {}),
      ...(typeof row["project_title"] === "string" ? { project: row["project_title"] } : {}),
      text: text(row["body"]).slice(0, 200),
    });
  }
  return {
    as_of: space.asOf,
    scope: "library",
    parsed: input.parsed,
    total: rows.length,
    first: rows.length === 0 ? 0 : 1,
    rows,
  };
}

/**
 * The trail above a task, for get_task's digest: its project, its area and the space, nearest
 * first, each with its first pages, and the task's own pages. Undefined on a space before pages.
 */
export async function trailOf(
  reader: WorkerConnection,
  space: SpaceFacts,
  task: Row,
): Promise<{ trail: Record<string, unknown>[]; pages: unknown[]; count: number } | undefined> {
  if (!(await hasPageTable(reader))) return undefined;
  const id = text(task["id"]);
  const [pages, count] = await reader.transaction("deferred", [
    { sql: SQL.ownPages, mode: "all", params: { id, limit: LIST, offset: 0 } },
    { sql: SQL.ownCount, mode: "get", params: { id } },
  ]);
  const trail = await levelsAbove(reader, space, {
    project: typeof task["project_id"] === "string" ? task["project_id"] : null,
    area: typeof task["area_id"] === "string" ? task["area_id"] : null,
  });
  return {
    trail,
    pages: (pages as Row[]).map((p) => pageRow(space.refPrefix, p)),
    count: Number((count as Row | null)?.["n"] ?? 0),
  };
}
