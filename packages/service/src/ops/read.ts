// The request path's reads (A3 3.4.2, 3.4.4): through a space's reader connection, never its
// writer (A1 3.9). Every read is one deferred transaction of constant statements on the reader, so
// it sees one snapshot, and its `as_of` is that snapshot's. Values are bound as parameters.
//
// What a read returns is plain rows; task-view.ts makes the digest v0 and the pages of a sections
// read from them, and the handlers the registry's results. A task's notes the user addressed to
// agents are read apart from its other notes (A3 3.10: only those are instructions), each list
// newest first from an ordinal down, so a page can start where the last one ended.
import {
  decideLaunchFolder,
  decodeReceipt,
  decodeSpaceRow,
  folderView,
  formatAsOf,
  formatTaskRef,
  isId,
  RECEIPT_SQL,
  storedPreference,
  type FolderView,
  type LaunchFolder,
  type Receipt,
  type ReceiptLookup,
  type Row,
  type WorkerConnection,
} from "@tasks/storage";
import {
  AppError,
  PREFERENCES,
  preferenceValue,
  readPreference,
  type PreferenceRead,
} from "@tasks/contracts";
import type { FoldersHere } from "./here.ts";

/** One statement of a read. Only the parameters the statement names are bound. */
interface Statement {
  readonly sql: string;
  readonly mode: "get" | "all";
}

const PARAM = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

function bindFor(sql: string, params: Readonly<Record<string, string | number | null>>) {
  const bound: Record<string, string | number | null> = {};
  for (const match of sql.matchAll(PARAM)) {
    const name = match[1] ?? "";
    bound[name] = params[name] ?? null;
  }
  return bound;
}

/** Runs the statements in one deferred transaction on the reader: one snapshot. */
async function snapshot(
  reader: WorkerConnection,
  statements: readonly Statement[],
  params: Readonly<Record<string, string | number | null>> = {},
): Promise<unknown[]> {
  return reader.transaction(
    "deferred",
    statements.map((s) => ({ sql: s.sql, mode: s.mode, params: bindFor(s.sql, params) })),
  );
}

// ---------------------------------------------------------------------------------------------
// The space

export interface SpaceFacts {
  readonly id: string;
  readonly name: string;
  readonly refPrefix: string;
  readonly asOf: string;
}

const SPACE: Statement = { sql: "SELECT * FROM space WHERE one = 1", mode: "get" };

function spaceFacts(row: unknown): SpaceFacts {
  const space = decodeSpaceRow(row as Row);
  return {
    id: space.spaceId,
    name: space.name,
    refPrefix: space.refPrefix,
    asOf: formatAsOf({
      epoch: space.authority.epoch,
      incarnation: space.authority.incarnation,
      seq: space.lastSeq,
    }),
  };
}

/** The space's name, prefix and current `as_of`. */
export async function readSpace(reader: WorkerConnection): Promise<SpaceFacts> {
  const [row] = await snapshot(reader, [SPACE]);
  return spaceFacts(row);
}

// ---------------------------------------------------------------------------------------------
// What an import plan meets in the space (A7 3.15.4)

/** The values an import plan names, each list sent as one JSON array. */
export interface ImportNames {
  readonly aliases: readonly string[];
  readonly keys: readonly string[];
  readonly areas: readonly string[];
}

export interface ImportRows {
  readonly spaceId: string;
  readonly epoch: number;
  readonly incarnation: string;
  readonly refPrefix: string;
  readonly nextRef: number;
  /** The space's `as_of` of the snapshot: an apply's base (A1 3.5). */
  readonly asOf: string;
  /** The snapshot's last seq: the state an apply decides on, and its barrier expects. */
  readonly seq: number;
  readonly aliases: { alias: string; task: string; version: number }[];
  readonly sources: { key: string; id: string; version: number }[];
  readonly areas: { slug: string; id: string; version: number; title: string }[];
  readonly projects: {
    slug: string;
    id: string;
    version: number;
    area: string | null;
    title: string;
  }[];
  /**
   * Where earlier imports landed groups: by a planned group's identity, the group ID of the newest
   * record (the importer's ItemBase.groups).
   */
  readonly landed: {
    readonly areas: ReadonlyMap<string, string>;
    readonly projects: ReadonlyMap<string, string>;
  };
}

const IN = (param: string) => `IN (SELECT value FROM json_each(${param}))`;
const IMPORT_READS: readonly Statement[] = [
  SPACE,
  {
    sql:
      "SELECT a.alias, t.id AS task, t.version FROM aliases a JOIN tasks t ON t.id = a.entity_id " +
      `WHERE a.namespace = 'planning' AND a.entity_kind = 'task' AND a.alias ${IN("$aliases")}`,
    mode: "all",
  },
  {
    sql: `SELECT source_key AS key, id, version FROM sources WHERE deleted_at IS NULL AND source_key ${IN("$keys")}`,
    mode: "all",
  },
  {
    // Every live area with its title: a planned area is the live area with its identity first,
    // whatever its slug (placeGroups). A space has few areas.
    sql: "SELECT slug, id, version, title FROM areas WHERE deleted_at IS NULL",
    mode: "all",
  },
  {
    // Every live project with its live area's slug and its title: a project slug is unique in the
    // space, so a planned project's slug depends on the slugs of other areas' projects too, and a
    // planned project is the live one with its identity in its area first (placeGroups).
    sql:
      "SELECT p.slug, p.id, p.version, a.slug AS area, p.title FROM projects p " +
      "LEFT JOIN areas a ON a.id = p.area_id AND a.deleted_at IS NULL WHERE p.deleted_at IS NULL",
    mode: "all",
  },
  {
    // Where each applied import landed its groups, once per distinct record with its newest seq:
    // an import's items repeat one record for every task of a group.
    sql:
      "SELECT json_extract(ei.base, '$.groups') AS groups, max(x.applied_seq) AS seq " +
      "FROM exchange_items ei JOIN exchanges x ON x.id = ei.exchange_id " +
      "WHERE x.state = 'applied' AND json_extract(ei.base, '$.import') = 'planning' " +
      "AND json_extract(ei.base, '$.groups') IS NOT NULL GROUP BY 1",
    mode: "all",
  },
];

/** The newest record of each group identity, from the rows of IMPORT_READS' last statement. */
function landedOf(rows: Row[]): ImportRows["landed"] {
  const newest = {
    areas: new Map<string, [number, string]>(),
    projects: new Map<string, [number, string]>(),
  };
  const note = (into: Map<string, [number, string]>, record: unknown, seq: number) => {
    if (typeof record !== "object" || record === null) return;
    const { key, id } = record as { key?: unknown; id?: unknown };
    if (typeof key !== "string" || typeof id !== "string") return;
    const known = into.get(key);
    if (known === undefined || known[0] < seq) into.set(key, [seq, id]);
  };
  for (const row of rows) {
    let groups: unknown;
    try {
      groups = JSON.parse(String(row["groups"]));
    } catch {
      continue;
    }
    if (typeof groups !== "object" || groups === null) continue;
    const seq = Number(row["seq"]);
    const { area, project } = groups as { area?: unknown; project?: unknown };
    note(newest.areas, area, seq);
    note(newest.projects, project, seq);
  }
  const ids = (m: Map<string, [number, string]>) => new Map([...m].map(([k, [, id]]) => [k, id]));
  return { areas: ids(newest.areas), projects: ids(newest.projects) };
}

/** The tasks that hold one of `$aliases` as a planning alias, as SQL. */
const ALIASED = `SELECT entity_id FROM aliases WHERE namespace = 'planning' AND entity_kind = 'task' AND alias ${IN("$aliases")}`;

/**
 * What an import's apply reads besides the rows its preview met (A7 3.15.5, 3.15.6), in the same
 * snapshot: each task that holds a legacy ID of the plan, with its grouping's slugs and what made
 * its tombstone; its place on this machine; its live source links; its recorded bases from every
 * applied import; the fields an import's undo set back since; and the legacy IDs of live tasks.
 */
const APPLY_READS: readonly Statement[] = [
  {
    sql:
      "SELECT a.alias AS alias, t.*, ar.slug AS area_slug, pr.slug AS project_slug, " +
      "(SELECT k.id FROM commits k WHERE k.seq = t.created_seq) AS created_commit, " +
      "(SELECT k.kind FROM commits k WHERE t.deleted_at IS NOT NULL " +
      "AND k.seq = coalesce(json_extract(t.fp, '$.deleted'), t.created_seq)) AS deleted_kind, " +
      "(SELECT coalesce(k.revert_of, (SELECT u.id FROM commits u WHERE u.seq = k.undo_of)) " +
      "FROM commits k WHERE t.deleted_at IS NOT NULL " +
      "AND k.seq = coalesce(json_extract(t.fp, '$.deleted'), t.created_seq)) AS deleted_of " +
      "FROM aliases a JOIN tasks t ON t.id = a.entity_id " +
      "LEFT JOIN areas ar ON ar.id = t.area_id LEFT JOIN projects pr ON pr.id = t.project_id " +
      `WHERE a.namespace = 'planning' AND a.entity_kind = 'task' AND a.alias ${IN("$aliases")}`,
    mode: "all",
  },
  {
    // Each task's live place on this machine with its folder's version, else the newest version
    // of a place it had here: a cleared place is a change too.
    sql:
      "SELECT owner_id AS task, root_id, rel_path, deleted_at, " +
      "coalesce(json_extract(fv, '$.folder'), created_seq) AS folder_version, " +
      "coalesce(json_extract(fv, '$.deleted'), created_seq) AS deleted_version FROM places " +
      `WHERE owner_kind = 'task' AND machine_id = $machine AND owner_id IN (${ALIASED})`,
    mode: "all",
  },
  {
    sql:
      "SELECT ts.task_id AS task, s.source_key AS key, s.url AS url FROM task_sources ts " +
      "JOIN sources s ON s.id = ts.source_id WHERE ts.removed_at IS NULL " +
      `AND s.deleted_at IS NULL AND ts.task_id IN (${ALIASED})`,
    mode: "all",
  },
  {
    sql:
      "SELECT ei.task_id AS task, ei.base AS base, x.applied_seq AS seq, k.reverted_by AS undone " +
      "FROM exchange_items ei JOIN exchanges x ON x.id = ei.exchange_id " +
      "JOIN commits k ON k.seq = x.applied_seq " +
      `WHERE x.state = 'applied' AND ei.task_id IN (${ALIASED}) ORDER BY x.applied_seq DESC`,
    mode: "all",
  },
  {
    // What each import's undo set back, by task: its fields, and its links, places and entries.
    sql:
      "SELECT c.seq AS seq, c.entity AS entity, c.task_id AS task, c.field AS field FROM changes c " +
      "WHERE c.seq IN (SELECT k.reverted_by FROM exchanges x JOIN commits k ON k.seq = x.applied_seq " +
      `WHERE k.reverted_by IS NOT NULL) AND c.task_id IN (${ALIASED})`,
    mode: "all",
  },
  {
    sql:
      "SELECT a.alias AS alias FROM aliases a JOIN tasks t ON t.id = a.entity_id " +
      "WHERE a.namespace = 'planning' AND a.entity_kind = 'task' AND t.deleted_at IS NULL",
    mode: "all",
  },
];

/** What an import's apply read (APPLY_READS), as rows. */
export interface ApplyRows {
  readonly tasks: Row[];
  readonly places: Row[];
  readonly links: Row[];
  readonly bases: Row[];
  readonly undone: Row[];
  readonly aliases: Row[];
}

function importRows(row: unknown, lists: unknown[]): ImportRows {
  const [aliases, sources, areas, projects, groups] = lists;
  const space = decodeSpaceRow(row as Row);
  return {
    spaceId: space.spaceId,
    epoch: space.authority.epoch,
    incarnation: space.authority.incarnation,
    refPrefix: space.refPrefix,
    nextRef: space.nextRef,
    asOf: formatAsOf({
      epoch: space.authority.epoch,
      incarnation: space.authority.incarnation,
      seq: space.lastSeq,
    }),
    seq: space.lastSeq,
    aliases: aliases as ImportRows["aliases"],
    sources: sources as ImportRows["sources"],
    areas: areas as ImportRows["areas"],
    projects: projects as ImportRows["projects"],
    landed: landedOf((groups as Row[] | undefined) ?? []),
  };
}

/**
 * The rows an import plan meets, in one snapshot: the space's authority and next reference, the
 * tasks that hold its legacy IDs as planning aliases, the live sources and areas with its keys and
 * slugs, and every live project, each with its version.
 */
export async function readImportRows(
  reader: WorkerConnection,
  names: ImportNames,
): Promise<ImportRows> {
  const [row, ...lists] = await snapshot(reader, IMPORT_READS, {
    aliases: JSON.stringify(names.aliases),
    keys: JSON.stringify(names.keys),
    areas: JSON.stringify(names.areas),
  });
  return importRows(row, lists);
}

/** The commit that applied an import's run (its exchange), or undefined: `--undo` reverts it. */
export async function readImportCommit(
  reader: WorkerConnection,
  run: string,
): Promise<{ id: string; seq: number; undone: boolean } | undefined> {
  const [row] = await snapshot(
    reader,
    [
      {
        sql:
          "SELECT k.id AS id, k.seq AS seq, k.reverted_by AS undone FROM exchanges x " +
          "JOIN commits k ON k.seq = x.applied_seq " +
          "WHERE x.id = $run AND x.state = 'applied' AND k.origin = 'import'",
        mode: "get",
      },
    ],
    { run },
  );
  const found = row as Row | null | undefined;
  if (found === null || found === undefined) return undefined;
  return {
    id: String(found["id"]),
    seq: Number(found["seq"]),
    undone: found["undone"] !== null,
  };
}

/**
 * What an applied run's commit did to each task of its exchange, from the space alone: created
 * there, changed by it, or neither. A replay answers with it when the run's apply.json is gone.
 */
export async function readImportOutcome(
  reader: WorkerConnection,
  run: string,
): Promise<{ legacy: string; ref: string; outcome: "created" | "updated" | "unchanged" }[]> {
  const [rows] = await snapshot(
    reader,
    [
      {
        sql:
          "SELECT ei.file AS legacy, t.ref AS ref, " +
          "(SELECT ref_prefix FROM space WHERE one = 1) AS prefix, " +
          "t.created_seq = x.applied_seq AS created, " +
          "EXISTS (SELECT 1 FROM changes c WHERE c.seq = x.applied_seq AND c.task_id = t.id) " +
          "AS changed FROM exchange_items ei JOIN exchanges x ON x.id = ei.exchange_id " +
          "JOIN tasks t ON t.id = ei.task_id WHERE x.id = $run AND x.state = 'applied' " +
          "ORDER BY ei.rowid",
        mode: "all",
      },
    ],
    { run },
  );
  return ((rows as Row[] | undefined) ?? []).map((r) => ({
    legacy: String(r["legacy"]),
    ref: formatTaskRef(String(r["prefix"]), Number(r["ref"])),
    outcome: r["created"] === 1 ? "created" : r["changed"] === 1 ? "updated" : "unchanged",
  }));
}

/**
 * The tasks a commit changed, with the table and field of each change, a task's child rows
 * included (its entries, links, place): what an import's undo removed and set back.
 */
export async function readCommitFields(
  reader: WorkerConnection,
  seq: number,
): Promise<{ task: string; entity: string; field: string | null }[]> {
  const [rows] = await snapshot(
    reader,
    [
      {
        sql:
          "SELECT task_id AS task, entity, field FROM changes " +
          "WHERE seq = $seq AND task_id IS NOT NULL",
        mode: "all",
      },
    ],
    { seq },
  );
  return (rows as { task: string; entity: string; field: string | null }[] | undefined) ?? [];
}

/** The rows an import plan meets and what its apply reads (APPLY_READS), in one snapshot. */
export async function readApplyRows(
  reader: WorkerConnection,
  names: ImportNames,
  machine: string,
): Promise<{ rows: ImportRows; apply: ApplyRows }> {
  const [row, aliases, sources, areas, projects, groups, ...apply] = await snapshot(
    reader,
    [...IMPORT_READS, ...APPLY_READS],
    {
      aliases: JSON.stringify(names.aliases),
      keys: JSON.stringify(names.keys),
      areas: JSON.stringify(names.areas),
      machine,
    },
  );
  const [tasks, places, links, bases, undone, all] = apply as Row[][];
  return {
    rows: importRows(row, [aliases, sources, areas, projects, groups]),
    apply: {
      tasks: tasks ?? [],
      places: places ?? [],
      links: links ?? [],
      bases: bases ?? [],
      undone: undone ?? [],
      aliases: all ?? [],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Tasks

/** A task reference as A1 3.3 resolves it for a read: an ID, a reference, or a legacy alias. */
interface TaskKey {
  readonly id: string | null;
  readonly ref: number | null;
  readonly prefix: string | null;
  readonly alias: string | null;
}

const TASK_REF = /^([A-Z]{1,6})-([1-9][0-9]{0,9})$/;

export function taskKey(text: string): TaskKey {
  if (isId(text, "t")) return { id: text, ref: null, prefix: null, alias: null };
  const match = TASK_REF.exec(text);
  if (match !== null) {
    return { id: null, ref: Number(match[2]), prefix: match[1] ?? null, alias: null };
  }
  return { id: null, ref: null, prefix: null, alias: text };
}

/** The ID of the live task a key names, as a subquery. */
const MATCH =
  "(SELECT id FROM tasks WHERE id = $id OR ref = $ref OR id = (SELECT entity_id FROM aliases " +
  "WHERE namespace = 'planning' AND alias = $alias AND entity_kind = 'task') LIMIT 1)";

const TASK: Statement = {
  sql:
    "SELECT t.*, a.title AS area_title, p.title AS project_title FROM tasks t " +
    "LEFT JOIN areas a ON a.id = t.area_id LEFT JOIN projects p ON p.id = t.project_id " +
    `WHERE t.id = ${MATCH}`,
  mode: "get",
};
const PREFIX_ALIAS: Statement = {
  sql: "SELECT entity_kind FROM aliases WHERE namespace = 'ref_prefix' AND alias = $prefix",
  mode: "get",
};
/**
 * Whether the commit that created entry `e` (a note or a log entry) brought it in through an
 * import (A3 3.10: "Text that arrived through a file import is labelled [import] although the
 * user applied it"). Commit rows always stay (A1 3.11.5).
 */
const imported = (e: string): string =>
  `EXISTS (SELECT 1 FROM commits k WHERE k.seq = ${e}.created_seq AND k.origin = 'import')`;
/**
 * Who wrote entry `e`, from history: `import`, `user` for the space's human, else the actor. The
 * same rule labels a conflict's `by` (errors.ts) and a history row's actor (HISTORY below).
 */
const authorOf = (e: string): string =>
  `CASE WHEN ${imported(e)} THEN 'import' WHEN x.kind = 'human' THEN 'user' ELSE x.label END`;
/**
 * A note the user addressed to agents: the only stored text presented as instructions (A3 3.10).
 * Written by the space's human directly, never through an import; a note for agents by anyone
 * else, or imported, is a note like the others.
 */
const INSTRUCTION = `(n.addressee = 'agents' AND x.kind = 'human' AND NOT ${imported("n")})`;
const NOTE_COLUMNS = `n.ordinal, n.addressee, n.body, n.created_at, ${authorOf("n")} AS author`;
const NOTES_FROM = `FROM notes n JOIN actors x ON x.id = n.author_id WHERE n.task_id = ${MATCH} AND n.deleted_at IS NULL`;
/** Newest first, from ordinal `$iupto` down (all when null), at most `$ilimit`. */
const INSTRUCTIONS: Statement = {
  sql:
    `SELECT ${NOTE_COLUMNS} ${NOTES_FROM} AND ${INSTRUCTION} ` +
    "AND ($iupto IS NULL OR n.ordinal <= $iupto) ORDER BY n.ordinal DESC LIMIT $ilimit",
  mode: "all",
};
const NOTES: Statement = {
  sql:
    `SELECT ${NOTE_COLUMNS} ${NOTES_FROM} AND NOT ${INSTRUCTION} ` +
    "AND ($nupto IS NULL OR n.ordinal <= $nupto) ORDER BY n.ordinal DESC LIMIT $nlimit",
  mode: "all",
};
const NOTE_COUNTS: Statement = {
  sql: `SELECT count(*) FILTER (WHERE ${INSTRUCTION}) AS i, count(*) FILTER (WHERE NOT ${INSTRUCTION}) AS n ${NOTES_FROM}`,
  mode: "get",
};
const LOG: Statement = {
  sql:
    `SELECT l.ordinal, l.kind, l.body, l.created_at, ${authorOf("l")} AS author FROM log_entries l ` +
    `JOIN actors x ON x.id = l.author_id WHERE l.task_id = ${MATCH} AND l.deleted_at IS NULL ` +
    "AND ($lupto IS NULL OR l.ordinal <= $lupto) ORDER BY l.ordinal DESC LIMIT $llimit",
  mode: "all",
};
const LOG_COUNT: Statement = {
  sql: `SELECT count(*) AS n FROM log_entries WHERE task_id = ${MATCH} AND deleted_at IS NULL`,
  mode: "get",
};
const SOURCES: Statement = {
  sql:
    "SELECT s.source_key, s.kind, s.title, s.who, s.url, s.at FROM task_sources ts " +
    `JOIN sources s ON s.id = ts.source_id WHERE ts.task_id = ${MATCH} ` +
    "AND ts.removed_at IS NULL AND s.deleted_at IS NULL ORDER BY ts.position",
  mode: "all",
};
/**
 * The task's own learnings in their order, removed ones too (A1 3.11.2): a learning's rank among
 * them is its key on a page, which no later wrap-up moves, because a new learning goes after the
 * others and a removed one keeps its row.
 */
const LEARNINGS: Statement = {
  sql: `SELECT body, deleted_at FROM learnings WHERE task_id = ${MATCH} ORDER BY position, id`,
  mode: "all",
};
const LEARNINGS_TABLE: Statement = {
  sql: "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'learnings'",
  mode: "get",
};
/** A statement in a list whose slot is not read: it holds no row. */
const NOTHING: Statement = { sql: "SELECT 1 WHERE 0", mode: "all" };
/** The readers whose space has the learnings table: a table, once there, stays. */
const learningReaders = new WeakSet<WorkerConnection>();

/**
 * Whether the reader's space has learnings to read: schema 0.2 on. A space at 0.1, served
 * read-only until its migration runs (A1 3.17), has none, and its tasks still read.
 */
async function readsLearnings(reader: WorkerConnection): Promise<boolean> {
  if (learningReaders.has(reader)) return true;
  const [found] = await snapshot(reader, [LEARNINGS_TABLE]);
  if (Number((found as Row | null)?.["n"] ?? 0) === 0) return false;
  learningReaders.add(reader);
  return true;
}
/** One row per commit that changed the task or a row under it, newest first. */
const HISTORY: Statement = {
  sql:
    "SELECT k.seq AS seq, CASE WHEN k.origin = 'import' THEN 'import' " +
    "WHEN x.kind = 'human' THEN 'user' ELSE x.label END AS actor, " +
    "(SELECT group_concat(DISTINCT json_extract(value, '$.op')) FROM json_each(k.ops)) AS ops, " +
    "(SELECT group_concat(DISTINCT field) FROM changes " +
    "WHERE seq = k.seq AND entity = 'tasks' AND field IS NOT NULL) AS fields, " +
    "(SELECT group_concat(CASE entity WHEN 'notes' THEN 'n' ELSE 'l' END || " +
    "json_extract(after, '$.ordinal'), ',') FROM changes WHERE seq = k.seq AND action = 'create' " +
    "AND entity IN ('notes', 'log_entries')) AS entries " +
    "FROM commits k JOIN actors x ON x.id = k.author_id WHERE k.seq IN " +
    `(SELECT DISTINCT seq FROM changes WHERE task_id = ${MATCH}) ORDER BY k.seq DESC LIMIT 20`,
  mode: "all",
};

const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
/** A stored text column, or "" for none. */
export const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** `{key: value}` when the value is text that is not empty, else nothing. */
export function present<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === "string" && value !== "" ? ({ [key]: value } as Record<K, string>) : {};
}

/** A3 3.4.2's task row. */
export function taskRow(row: Row, prefix: string): Record<string, unknown> {
  const dueAt = row["due_at"];
  const due =
    typeof row["due_date"] === "string"
      ? { due: row["due_date"] }
      : typeof dueAt === "number" && typeof row["due_tz"] === "string"
        ? { due: { at: iso(dueAt), tz: row["due_tz"] } }
        : {};
  return {
    id: row["id"],
    ref: formatTaskRef(prefix, Number(row["ref"])),
    title: text(row["title"]),
    lifecycle: row["lifecycle"],
    status: row["status"],
    inbox: row["inbox"] === 1,
    priority: Number(row["priority"]),
    ...present("effort", row["effort"]),
    ...due,
    ...present("area", row["area_title"]),
    ...present("project", row["project_title"]),
  };
}

/** A note as the results show it: `text` is its body, in full. */
export const noteOf = (row: Row) => ({
  ref: `n${String(row["ordinal"])}`,
  author: text(row["author"]),
  for_agents: row["addressee"] === "agents",
  at: iso(row["created_at"]),
  text: text(row["body"]),
});

export const logOf = (row: Row) => ({
  ref: `l${String(row["ordinal"])}`,
  kind: row["kind"] as string,
  author: text(row["author"]),
  at: iso(row["created_at"]),
  text: text(row["body"]),
});

export const sourceOf = (row: Row) => ({
  ...present("key", row["source_key"]),
  kind: row["kind"] as string,
  title: text(row["title"]),
  ...present("who", row["who"]),
  ...present("url", row["url"]),
  ...(typeof row["at"] === "number" ? { at: iso(row["at"]) } : {}),
});

/** An entry's ordinal, for paging. */
export const ordinalOf = (row: Row): number => Number(row["ordinal"]);

export function historyOf(row: Row): { seq: number; actor: string; what: string } {
  const list = (value: unknown) =>
    typeof value === "string" && value !== "" ? value.split(",") : [];
  const parts = [list(row["ops"]).join(", "), list(row["fields"]).join(", ")];
  const entries = list(row["entries"]).join(", ");
  return {
    seq: Number(row["seq"]),
    actor: text(row["actor"]),
    what: [...parts, entries].filter((part) => part !== "").join(" "),
  };
}

const notFound = (): AppError =>
  new AppError({
    code: "not_found",
    message: "No task has this reference in this space.",
    hint: "Check the reference with tasks status or tasks find.",
  });

/** Which entries of a list a read takes: newest first, from ordinal `upto` down, at most `limit`. */
export interface EntryRange {
  /** The newest ordinal to take; null: from the newest. */
  readonly upto: number | null;
  readonly limit: number;
}

export interface TaskRead {
  readonly space: SpaceFacts;
  readonly row: Row;
  /** The notes the user addressed to agents, newest first, as `instructions` asked. */
  readonly instructions: Row[];
  /** The other notes, newest first, as `notes` asked. */
  readonly notes: Row[];
  readonly log: Row[];
  readonly sources: Row[];
  /** Where the task opens on the read's machine. */
  readonly folder: TaskFolder;
  readonly history: Row[];
  /** The task's own learnings in their order, each with its rank among all of them (`key`). */
  readonly learnings: readonly { readonly key: number; readonly text: string }[];
  /** How many of each the task holds in all. */
  readonly counts: {
    readonly instructions: number;
    readonly notes: number;
    readonly log: number;
    readonly sources: number;
  };
}

/**
 * Reads one task and what hangs from it in one snapshot: of the instructions, notes and log the
 * ranges asked for. A reference with another space's prefix is `not_found`, never a task
 * elsewhere (A3 3.4.1), and so is a deleted task (A1 3.5).
 */
export async function readTask(
  reader: WorkerConnection,
  ref: string,
  options: {
    readonly machine: string;
    readonly instructions: EntryRange;
    readonly notes: EntryRange;
    readonly log: EntryRange;
  },
): Promise<TaskRead> {
  const key = taskKey(ref);
  const params = {
    id: key.id,
    ref: key.ref,
    alias: key.alias,
    prefix: key.prefix,
    machine: options.machine,
    iupto: options.instructions.upto,
    ilimit: options.instructions.limit,
    nupto: options.notes.upto,
    nlimit: options.notes.limit,
    lupto: options.log.upto,
    llimit: options.log.limit,
  };
  const learned = await readsLearnings(reader);
  const folders = await hasFolderTable(reader);
  const [
    space,
    alias,
    row,
    instructions,
    notes,
    counts,
    log,
    logCount,
    sources,
    history,
    learnings,
    own,
    project,
  ] = await snapshot(
    reader,
    [
      SPACE,
      PREFIX_ALIAS,
      TASK,
      INSTRUCTIONS,
      NOTES,
      NOTE_COUNTS,
      LOG,
      LOG_COUNT,
      SOURCES,
      HISTORY,
      learned ? LEARNINGS : NOTHING,
      ...(folders ? [OWN_FOLDERS_OF_MATCH, PROJECT_FOLDERS_OF_MATCH] : []),
    ],
    params,
  );
  const facts = spaceFacts(space);
  if (
    key.prefix !== null &&
    key.prefix !== facts.refPrefix &&
    (alias as Row | null)?.["entity_kind"] !== "space"
  ) {
    throw notFound();
  }
  const task = row as Row | null;
  if (task === null || task["deleted_at"] !== null) throw notFound();
  const noteCounts = counts as Row | null;
  const sourceRows = sources as Row[];
  return {
    space: facts,
    row: task,
    instructions: instructions as Row[],
    notes: notes as Row[],
    log: log as Row[],
    sources: sourceRows,
    folder: taskFolderOf((own ?? []) as Row[], (project ?? []) as Row[], options.machine),
    history: history as Row[],
    learnings: ((learnings ?? []) as Row[]).flatMap((learning, k) =>
      learning["deleted_at"] === null ? [{ key: k + 1, text: text(learning["body"]) }] : [],
    ),
    counts: {
      instructions: Number(noteCounts?.["i"] ?? 0),
      notes: Number(noteCounts?.["n"] ?? 0),
      log: Number((logCount as Row | null)?.["n"] ?? 0),
      sources: sourceRows.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Launches and the bound task (A3 3.7.3, 3.4.2)

/** A launch by its reference: the newest with it (references are unique for 90 days, A4 3.1). */
const LAUNCH_BY_REF: Statement = {
  sql:
    "SELECT l.id, l.reference, l.task_id, l.state, l.route, l.machine_id, l.created_at, " +
    "l.detail, t.ref AS task_ref FROM launches l LEFT JOIN tasks t ON t.id = l.task_id " +
    "WHERE l.reference = $reference ORDER BY l.created_at DESC, l.id DESC LIMIT 1",
  mode: "get",
};

/** A launch as a reference finds it, with what binding decides by. */
export interface LaunchRow {
  readonly id: string;
  readonly reference: string;
  readonly task: string | null;
  readonly taskRef: string | undefined;
  readonly state: string;
  readonly route: string;
  readonly machine: string;
  /** When the person clicked, on the wall clock (`detail.at.prepared`), else the commit instant. */
  readonly clickedAt: number;
  readonly evidence: Readonly<Record<string, unknown>>;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The launch the reference names in this space, or undefined. */
export async function readLaunch(
  reader: WorkerConnection,
  reference: string,
): Promise<{ space: SpaceFacts; launch: LaunchRow | undefined }> {
  const [space, row] = await snapshot(reader, [SPACE, LAUNCH_BY_REF], { reference });
  const facts = spaceFacts(space);
  if (!isPlain(row)) return { space: facts, launch: undefined };
  let detail: unknown;
  try {
    detail = JSON.parse(text(row["detail"]));
  } catch {
    detail = {};
  }
  const at = isPlain(detail) && isPlain(detail["at"]) ? detail["at"] : {};
  const evidence = isPlain(detail) && isPlain(detail["evidence"]) ? detail["evidence"] : {};
  const prepared = at["prepared"];
  const taskRef = row["task_ref"];
  return {
    space: facts,
    launch: {
      id: text(row["id"]),
      reference: text(row["reference"]),
      task: typeof row["task_id"] === "string" ? row["task_id"] : null,
      taskRef: typeof taskRef === "number" ? formatTaskRef(facts.refPrefix, taskRef) : undefined,
      state: text(row["state"]),
      route: text(row["route"]),
      machine: text(row["machine_id"]),
      clickedAt: typeof prepared === "number" ? prepared : Number(row["created_at"]),
      evidence,
    },
  };
}

/** The bound task's reference and how many notes the user addressed to agents it has. */
const BOUND: Statement = {
  sql:
    "SELECT t.ref, (SELECT count(*) FROM notes n JOIN actors x ON x.id = n.author_id " +
    `WHERE n.task_id = t.id AND n.deleted_at IS NULL AND ${INSTRUCTION}) AS instructions ` +
    "FROM tasks t WHERE t.id = $bound",
  mode: "get",
};

/** A task's reference by its ID, or undefined when there is no such task. */
export async function readTaskRef(
  reader: WorkerConnection,
  id: string,
): Promise<string | undefined> {
  const [space, row] = await snapshot(reader, [SPACE, BOUND], { bound: id });
  const ref = isPlain(row) ? row["ref"] : undefined;
  return typeof ref === "number" ? formatTaskRef(spaceFacts(space).refPrefix, ref) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Status

const STATUS_ORDER: Statement = {
  sql: "SELECT value, schema_ver FROM preferences WHERE key = 'tasks.statuses'",
  mode: "get",
};
const AUTONOMY: Statement = {
  sql: "SELECT value, schema_ver FROM preferences WHERE key = 'autonomy.level'",
  mode: "get",
};
const COUNTS: Statement = {
  sql:
    "SELECT status, count(*) AS n FROM tasks WHERE lifecycle = 'active' AND deleted_at IS NULL " +
    "GROUP BY status",
  mode: "all",
};
const INBOX: Statement = {
  sql: "SELECT count(*) AS n FROM tasks WHERE lifecycle = 'active' AND deleted_at IS NULL AND inbox = 1",
  mode: "get",
};
const ROW_SQL =
  "SELECT t.*, a.title AS area_title, p.title AS project_title FROM tasks t " +
  "LEFT JOIN areas a ON a.id = t.area_id LEFT JOIN projects p ON p.id = t.project_id " +
  "WHERE t.deleted_at IS NULL AND ";

/** Rows per section (A3 3.4.2). */
const SECTION_ROWS = 8;

/**
 * The sections `include` asks for (A3 3.4.2). A task appears once, in its first section, so each
 * statement reads enough rows to fill its section after the earlier sections took theirs: at most
 * 8 rows for each of the 5 other sections, plus its own 8.
 */
const SECTION_LIMIT = `LIMIT ${String(SECTION_ROWS * 6)}`;
const SECTION_SQL: Readonly<Record<string, Statement>> = {
  today: {
    sql:
      ROW_SQL +
      "t.lifecycle = 'active' AND (t.due_date <= $today OR t.focus_on = $today) " +
      `ORDER BY t.priority, t.due_date, t.ref ${SECTION_LIMIT}`,
    mode: "all",
  },
  week: {
    sql:
      ROW_SQL +
      "t.lifecycle = 'active' AND t.due_date > $today AND t.due_date <= $week " +
      `ORDER BY t.due_date, t.priority, t.ref ${SECTION_LIMIT}`,
    mode: "all",
  },
  review: {
    sql:
      ROW_SQL +
      "((t.lifecycle = 'active' AND t.status = 'review') OR t.wrap_state = 'pending') " +
      `ORDER BY t.touched DESC ${SECTION_LIMIT}`,
    mode: "all",
  },
  waiting: {
    sql:
      ROW_SQL +
      "t.lifecycle = 'active' AND (t.status = 'waiting' OR t.waiting_on IS NOT NULL) " +
      `ORDER BY t.touched DESC ${SECTION_LIMIT}`,
    mode: "all",
  },
  inbox: {
    sql: ROW_SQL + `t.lifecycle = 'active' AND t.inbox = 1 ORDER BY t.ref DESC ${SECTION_LIMIT}`,
    mode: "all",
  },
  changes: {
    sql:
      ROW_SQL +
      "t.touched IN (SELECT seq FROM commits WHERE at >= $since) " +
      `ORDER BY t.touched DESC ${SECTION_LIMIT}`,
    mode: "all",
  },
};

/** The live folders on `$machine` of live projects: `here`'s project folders. */
const PROJECT_FOLDERS_ON: Statement = {
  sql:
    "SELECT f.owner_id AS project, f.path AS path FROM folders f JOIN projects p " +
    "ON p.id = f.owner_id WHERE f.machine_id = $machine AND f.owner_kind = 'project' " +
    "AND f.deleted_at IS NULL AND p.deleted_at IS NULL",
  mode: "all",
};
/** The live folders on `$machine` of tasks that are not deleted. */
const TASK_FOLDERS_ON: Statement = {
  sql:
    "SELECT f.owner_id AS task, f.path AS path FROM folders f JOIN tasks t ON t.id = f.owner_id " +
    "WHERE f.machine_id = $machine AND f.owner_kind = 'task' AND f.deleted_at IS NULL " +
    "AND t.deleted_at IS NULL",
  mode: "all",
};

/** The folders on `machine` that `here` compares with a working folder (here.ts). */
export async function readFoldersHere(
  reader: WorkerConnection,
  machine: string,
): Promise<FoldersHere> {
  if (!(await hasFolderTable(reader))) return { projects: [], tasks: [] };
  const [projects, tasks] = await snapshot(reader, [PROJECT_FOLDERS_ON, TASK_FOLDERS_ON], {
    machine,
  });
  return { projects: projects as Row[], tasks: tasks as Row[] };
}

/** A task's own live folder on `$machine`: such a task works there, never in its project's. */
export const OWN_FOLDER_HERE =
  "EXISTS (SELECT 1 FROM folders f WHERE f.owner_kind = 'task' AND f.owner_id = t.id " +
  "AND f.machine_id = $machine AND f.deleted_at IS NULL)";

/**
 * The active tasks `here` names: those in `$tasks` (JSON), by their own folder, and those of the
 * projects in `$projects` that have no folder of their own here.
 */
const HERE_TASKS: Statement = {
  sql:
    "SELECT t.*, a.title AS area_title, p.title AS project_title, " +
    `CASE WHEN ${OWN_FOLDER_HERE} THEN 1 END AS x_own_here FROM tasks t ` +
    "LEFT JOIN areas a ON a.id = t.area_id LEFT JOIN projects p ON p.id = t.project_id " +
    "WHERE t.deleted_at IS NULL AND t.lifecycle = 'active' AND (t.id IN " +
    "(SELECT value FROM json_each($tasks)) OR t.project_id IN (SELECT value FROM " +
    `json_each($projects)))`,
  mode: "all",
};

/** What `here` matched, as the reads take it: task IDs and project IDs. */
export interface HereIds {
  readonly machine: string;
  readonly tasks: readonly string[];
  readonly projects: readonly string[];
}

const hereParams = (ids: HereIds) => ({
  machine: ids.machine,
  tasks: JSON.stringify(ids.tasks),
  projects: JSON.stringify(ids.projects),
});

/** The active tasks of `ids`, with the space's facts: the candidates of a call with no task. */
export async function readHereTasks(
  reader: WorkerConnection,
  ids: HereIds,
): Promise<{ space: SpaceFacts; rows: Row[] }> {
  const [space, rows] = await snapshot(reader, [SPACE, HERE_TASKS], hereParams(ids));
  return { space: spaceFacts(space), rows: rows as Row[] };
}

/** A preference's row as a read returned it, for the registry (A1 3.16). */
const storedOf = (row: unknown) => storedPreference(isPlain(row) ? row : undefined);

/**
 * The keys of `tasks.statuses` or `tasks.effort_scale` from its row (`value`, `schema_ver`): the
 * stored list when it fits its declared shape, else the default (A1 3.16).
 */
export function keysOf(key: "tasks.statuses" | "tasks.effort_scale", row: unknown): string[] {
  const { value } = readPreference(key, storedOf(row));
  return Array.isArray(value)
    ? value.map((item: unknown) =>
        typeof item === "string" ? item : String((item as { key?: unknown }).key),
      )
    : [];
}

function levelOf(row: unknown): "full" | "review" | "suggest" {
  const { value } = readPreference("autonomy.level", storedOf(row));
  return value === "full" || value === "suggest" ? value : "review";
}

/** space.status for a connection that is not bound (A3 3.4.2). */
export async function readStatus(
  reader: WorkerConnection,
  options: {
    readonly today: string;
    readonly week: string;
    readonly since: number;
    readonly include: readonly string[];
    /** Read the active tasks `here` matched, for `here`. */
    readonly here?: HereIds;
    /** The bound task's ID: its reference and notes for agents, for the session line. */
    readonly bound?: string;
  },
): Promise<{
  space: SpaceFacts;
  autonomy: "full" | "review" | "suggest";
  statuses: { status: string; count: number }[];
  inbox: number;
  sections: { name: string; tasks: Record<string, unknown>[] }[];
  /** The task rows `here` asked for, each with `x_own_here`. */
  here: Row[];
  /** The bound task, when one was asked for and it exists. */
  bound: { ref: string; instructions: number } | undefined;
}> {
  const include = [...new Set(options.include)].filter((name) => Object.hasOwn(SECTION_SQL, name));
  const results = await snapshot(
    reader,
    [
      SPACE,
      STATUS_ORDER,
      AUTONOMY,
      COUNTS,
      INBOX,
      ...(options.bound === undefined ? [] : [BOUND]),
      ...(options.here === undefined ? [] : [HERE_TASKS]),
      ...include.map((name) => SECTION_SQL[name] as Statement),
    ],
    {
      today: options.today,
      week: options.week,
      since: options.since,
      ...hereParams(options.here ?? { machine: "", tasks: [], projects: [] }),
      bound: options.bound ?? null,
    },
  );
  const [space, order, autonomy, counts, inbox, ...rest] = results;
  const boundRow = options.bound === undefined ? undefined : rest.shift();
  const here = options.here === undefined ? [] : ((rest.shift() ?? []) as Row[]);
  const found = rest;
  const facts = spaceFacts(space);
  const byStatus = new Map(
    (counts as Row[]).map((row) => [String(row["status"]), Number(row["n"])] as const),
  );
  const keys = keysOf("tasks.statuses", order);
  for (const key of byStatus.keys()) if (!keys.includes(key)) keys.push(key);
  // A task appears once, in its first section (A3 3.4.2).
  const shown = new Set<unknown>();
  const sections = include.map((name, i) => {
    const rows = ((found[i] ?? []) as Row[]).filter((row) => !shown.has(row["id"]));
    const kept = rows.slice(0, SECTION_ROWS);
    for (const row of kept) shown.add(row["id"]);
    return { name, tasks: kept.map((row) => taskRow(row, facts.refPrefix)) };
  });
  return {
    space: facts,
    autonomy: levelOf(autonomy),
    statuses: keys.map((status) => ({ status, count: byStatus.get(status) ?? 0 })),
    inbox: Number((inbox as Row | null)?.["n"] ?? 0),
    sections,
    here,
    bound:
      isPlain(boundRow) && typeof boundRow["ref"] === "number"
        ? {
            ref: formatTaskRef(facts.refPrefix, boundRow["ref"]),
            instructions: Number(boundRow["instructions"] ?? 0),
          }
        : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// What a write's commit did, for its result

/** One change row of a commit: the entity, the logical field (null for a created row), values. */
export interface CommitChange {
  readonly entity: string;
  readonly field: string | null;
  readonly before: unknown;
  readonly after: unknown;
}

export interface CommitFacts {
  /** The change rows the commit wrote for the task and the rows under it. */
  readonly changes: readonly CommitChange[];
  /** The task's status as of the commit. */
  readonly status: string | undefined;
  /** The task's lifecycle and wrap-up state as of the commit (A1 3.11). */
  readonly lifecycle: string | undefined;
  readonly wrapState: string | undefined;
}

const COMMIT_CHANGES: Statement = {
  sql: "SELECT entity, field, before, after FROM changes WHERE seq = $seq AND task_id = $task",
  mode: "all",
};
/**
 * A field's column as of $seq: from the first later change of the field its `before`, else the
 * column now. `wrap_state` may be null, so the later change is found first, not coalesced.
 */
const columnAt = (field: string, path: string, column: string): string =>
  `(SELECT CASE WHEN c.before IS NULL THEN t.${column} ELSE json_extract(c.before, '${path}') END ` +
  "FROM tasks t LEFT JOIN (SELECT before FROM changes WHERE entity = 'tasks' " +
  `AND entity_id = $task AND field = '${field}' AND seq > $seq ORDER BY seq, n LIMIT 1) c ` +
  "WHERE t.id = $task)";
/** The status, lifecycle and wrap-up state as of $seq. */
const STATE_AT: Statement = {
  sql:
    `SELECT ${columnAt("status", "$", "status")} AS status, ` +
    `${columnAt("lifecycle", "$.lifecycle", "lifecycle")} AS lifecycle, ` +
    `${columnAt("wrap", "$.wrap_state", "wrap_state")} AS wrap_state`,
  mode: "get",
};

const json = (value: unknown): unknown => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

/**
 * What commit `seq` did to `task`, read from history in one snapshot. A write's result names its
 * commit, and history never changes, so the first answer and every replay of the request read
 * the same facts, whatever happened since (A3 3.4.1). A result value that the writer's result does
 * not carry is read here, never from the task's current state.
 */
export async function readCommit(
  reader: WorkerConnection,
  task: string,
  seq: number,
): Promise<CommitFacts> {
  const [changes, state] = await snapshot(reader, [COMMIT_CHANGES, STATE_AT], { task, seq });
  const at = (name: string): string | undefined => {
    const value = (state as Row | null)?.[name];
    return typeof value === "string" ? value : undefined;
  };
  return {
    changes: (changes as Row[]).map((row) => ({
      entity: text(row["entity"]),
      field: typeof row["field"] === "string" ? row["field"] : null,
      before: json(row["before"]),
      after: json(row["after"]),
    })),
    status: at("status"),
    lifecycle: at("lifecycle"),
    wrapState: at("wrap_state"),
  };
}

/** A1 3.4: a task's references come from its row; the first 50 a commit changed, in its order. */
const COMMIT_TASKS: Statement = {
  sql:
    "SELECT t.ref AS ref FROM (SELECT task_id, min(n) AS first FROM changes WHERE seq = $seq " +
    "AND task_id IS NOT NULL GROUP BY task_id) c JOIN tasks t ON t.id = c.task_id " +
    "ORDER BY c.first LIMIT 50",
  mode: "all",
};
const COMMIT_TASK_COUNT: Statement = {
  sql: "SELECT count(DISTINCT task_id) AS n FROM changes WHERE seq = $seq AND task_id IS NOT NULL",
  mode: "get",
};

/**
 * The tasks commit `seq` changed (an undo's or a redo's), from history in one snapshot: the
 * references of the first 50 in the order it changed them, and how many there are. History never
 * changes, so a replay of the request answers the same.
 */
export async function readCommitTasks(
  reader: WorkerConnection,
  seq: number,
): Promise<{ refs: string[]; count: number }> {
  const [space, rows, total] = await snapshot(reader, [SPACE, COMMIT_TASKS, COMMIT_TASK_COUNT], {
    seq,
  });
  const { refPrefix } = spaceFacts(space);
  return {
    refs: (rows as Row[]).map((row) => formatTaskRef(refPrefix, Number(row["ref"]))),
    count: Number((total as Row | null)?.["n"] ?? 0),
  };
}

/**
 * The change an undo of `$principal` would take back: its newest commit still on its undo stack,
 * with the kind of the first operation that changed a task.
 */
const UNDO_TARGET: Statement = {
  sql:
    "SELECT k.id AS id, k.seq AS seq, (SELECT json_extract(k.ops, '$[' || c.op || '].op') " +
    "FROM changes c WHERE c.seq = k.seq AND c.task_id IS NOT NULL ORDER BY c.n LIMIT 1) AS change " +
    "FROM commits k WHERE k.principal_id = $principal AND k.undo_status = 'done' " +
    "ORDER BY k.seq DESC LIMIT 1",
  mode: "get",
};

/** What an undo would take back now, when the actor `principal` has a change on its stack. */
export async function readUndoTarget(
  reader: WorkerConnection,
  principal: string,
): Promise<
  { commit: string; seq: number; change?: string; tasks: string[]; count: number } | undefined
> {
  const [row] = await snapshot(reader, [UNDO_TARGET], { principal });
  const found = row as Row | null;
  if (found === null || typeof found["id"] !== "string") return undefined;
  const seq = Number(found["seq"]);
  const tasks = await readCommitTasks(reader, seq);
  return {
    commit: found["id"],
    seq,
    ...(typeof found["change"] === "string" ? { change: found["change"] } : {}),
    tasks: tasks.refs,
    count: tasks.count,
  };
}

/**
 * The newest commit under writer scope `$scope` after the commit `$undone` and before `$seq`, with
 * the first task it changed and the kind of the operation that changed it (`commits.ops[op].op`).
 */
const SCRIPT_CHANGE: Statement = {
  sql:
    "SELECT k.at AS at, t.ref AS ref, json_extract(k.ops, '$[' || c.op || '].op') AS change " +
    "FROM commits k JOIN changes c ON c.seq = k.seq AND c.task_id IS NOT NULL " +
    "JOIN tasks t ON t.id = c.task_id WHERE k.scope_id = $scope AND k.seq < $seq " +
    "AND k.seq > (SELECT seq FROM commits WHERE id = $undone) ORDER BY k.seq DESC, c.n LIMIT 1",
  mode: "get",
};

/**
 * A change a script of the same person made after the change an undo took back (A3 3.7.4): the
 * newest under the script's writer scope between the undone commit and the undo's own, so a
 * replay of the undo answers the same. Undefined when there is none.
 */
export async function readScriptChange(
  reader: WorkerConnection,
  query: { readonly scope: string; readonly undone: string; readonly seq: number },
): Promise<{ task: string; change: string; at: string } | undefined> {
  const [space, row] = await snapshot(reader, [SPACE, SCRIPT_CHANGE], { ...query });
  const found = row as Row | null;
  if (found === null || typeof found["change"] !== "string") return undefined;
  const { refPrefix } = spaceFacts(space);
  return {
    task: formatTaskRef(refPrefix, Number(found["ref"])),
    change: found["change"],
    at: iso(found["at"]),
  };
}

// ---------------------------------------------------------------------------------------------
// A task to launch (A4 3.3, 3.15; `launch.open`)

/** The task's own live folders, newest first: the task named as `MATCH` names it. */
const OWN_FOLDERS_OF_MATCH: Statement = {
  sql:
    "SELECT f.*, m.name AS machine_name FROM folders f JOIN machines m ON m.id = f.machine_id " +
    `WHERE f.owner_kind = 'task' AND f.deleted_at IS NULL AND f.owner_id = ${MATCH} ` +
    "ORDER BY f.created_seq DESC, f.id",
  mode: "all",
};
/** The live folders of the project of the task `MATCH` names, newest first. */
const PROJECT_FOLDERS_OF_MATCH: Statement = {
  sql:
    "SELECT f.*, m.name AS machine_name FROM folders f JOIN tasks t ON t.project_id = f.owner_id " +
    `JOIN machines m ON m.id = f.machine_id WHERE t.id = ${MATCH} AND f.owner_kind = 'project' ` +
    "AND f.deleted_at IS NULL ORDER BY f.created_seq DESC, f.id",
  mode: "all",
};

/** What a launch reads about a task, in one snapshot: the task and the folder it opens in. */
export interface LaunchTaskRead {
  readonly space: SpaceFacts;
  readonly id: string;
  readonly ref: string;
  readonly title: string;
  readonly version: number;
  /** Not finished or archived. */
  readonly active: boolean;
  readonly folder: TaskFolder;
}

/**
 * Where a task opens on one machine (storage's `decideLaunchFolder`), as the launch, the digest and
 * the row read it: its own folder or its project's there, in stored form; the name of the machine
 * where one is; or none, when it uses the space's work folder.
 */
export type TaskFolder =
  | { readonly kind: "task" | "project"; readonly path: string }
  | { readonly kind: "other_machine"; readonly machine: string }
  | { readonly kind: "none" };

/** A launch folder decided from the task's and its project's folder rows, read newest first. */
export function taskFolderOf(
  own: readonly Row[],
  project: readonly Row[],
  machine: string,
): TaskFolder {
  const ownRows = own.map(ownerFolder);
  const projectRows = project.map(ownerFolder);
  const names = new Map([...ownRows, ...projectRows].map((f) => [f.machine, f.machineName]));
  const decided = decideLaunchFolder(ownRows, projectRows, machine, (id) => names.get(id));
  switch (decided.kind) {
    case "task":
    case "project":
      return { kind: decided.kind, path: decided.folder.path };
    case "other_machine":
      return { kind: "other_machine", machine: decided.machine.name };
    case "none":
      return { kind: "none" };
  }
}

const HAS_FOLDERS: Statement = {
  sql: "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'folders'",
  mode: "get",
};
/** The readers whose space has the folders table: a table, once there, stays. */
const folderReaders = new WeakSet<WorkerConnection>();

/**
 * Whether the reader's space has folders to read: schema 0.5 on. A space served read-only at an
 * older revision until its migration runs has none, and its tasks open in the work folder.
 */
export async function hasFolderTable(reader: WorkerConnection): Promise<boolean> {
  if (folderReaders.has(reader)) return true;
  const [found] = await snapshot(reader, [HAS_FOLDERS]);
  if (Number((found as Row | null)?.["n"] ?? 0) === 0) return false;
  folderReaders.add(reader);
  return true;
}

/**
 * The task a launch names, as `readTask` resolves a reference: another space's prefix and a
 * deleted task are `not_found`. With it, the folder it opens in on `machine`.
 */
export async function readLaunchTask(
  reader: WorkerConnection,
  ref: string,
  machine: string,
): Promise<LaunchTaskRead> {
  const key = taskKey(ref);
  const params = { id: key.id, ref: key.ref, alias: key.alias, prefix: key.prefix, machine };
  const folders = await hasFolderTable(reader);
  const [space, alias, row, own, project] = await snapshot(
    reader,
    [
      SPACE,
      PREFIX_ALIAS,
      TASK,
      ...(folders ? [OWN_FOLDERS_OF_MATCH, PROJECT_FOLDERS_OF_MATCH] : []),
    ],
    params,
  );
  const facts = spaceFacts(space);
  if (
    key.prefix !== null &&
    key.prefix !== facts.refPrefix &&
    (alias as Row | null)?.["entity_kind"] !== "space"
  ) {
    throw notFound();
  }
  const task = row as Row | null;
  if (task === null || task["deleted_at"] !== null) throw notFound();
  return {
    space: facts,
    id: String(task["id"]),
    ref: formatTaskRef(facts.refPrefix, Number(task["ref"])),
    title: String(task["title"]),
    version: Number(task["version"]),
    active: task["lifecycle"] === "active",
    folder: taskFolderOf((own ?? []) as Row[], (project ?? []) as Row[], machine),
  };
}

// ---------------------------------------------------------------------------------------------
// Areas and projects (A3 3.4.5, 3.4.10)

/** Active tasks of a group, its projects' included for an area. Tombstoned tasks never count. */
const ACTIVE_IN = (column: string, owner: string): string =>
  `(SELECT count(*) FROM tasks t WHERE t.${column} = ${owner}.id AND t.lifecycle = 'active' ` +
  "AND t.deleted_at IS NULL)";

const AREA_LIST: Statement = {
  sql:
    `SELECT a.id, a.slug, a.title, ${ACTIVE_IN("area_id", "a")} AS active FROM areas a ` +
    "WHERE a.deleted_at IS NULL AND a.lifecycle = 'active' ORDER BY a.position, a.id",
  mode: "all",
};
const PROJECT_LIST: Statement = {
  sql:
    `SELECT p.id, p.area_id, p.slug, p.title, ${ACTIVE_IN("project_id", "p")} AS active ` +
    "FROM projects p WHERE p.deleted_at IS NULL AND p.lifecycle = 'active' " +
    "ORDER BY p.position, p.id",
  mode: "all",
};

/** The space's active areas and projects with their active task counts, in the space's order. */
export async function readGroups(
  reader: WorkerConnection,
): Promise<{ space: SpaceFacts; areas: Row[]; projects: Row[] }> {
  const [space, areas, projects] = await snapshot(reader, [SPACE, AREA_LIST, PROJECT_LIST]);
  return { space: spaceFacts(space), areas: areas as Row[], projects: projects as Row[] };
}

/** One area or project as a name resolves against it (groups.ts). */
export interface GroupName {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  /** A project's area. */
  readonly area: string | null;
}

/** Every area and project that is not deleted, and their old slugs (A1 3.3 aliases). */
export interface GroupNames {
  readonly areas: readonly GroupName[];
  readonly projects: readonly GroupName[];
  /** An old slug and the area or project it names now. */
  readonly aliases: readonly {
    readonly alias: string;
    readonly kind: string;
    readonly id: string;
  }[];
}

const AREA_NAMES: Statement = {
  sql: "SELECT id, slug, title FROM areas WHERE deleted_at IS NULL ORDER BY position, id",
  mode: "all",
};
const PROJECT_NAMES: Statement = {
  sql: "SELECT id, area_id, slug, title FROM projects WHERE deleted_at IS NULL ORDER BY position, id",
  mode: "all",
};
const GROUP_ALIASES: Statement = {
  sql:
    "SELECT alias, entity_kind, entity_id FROM aliases WHERE namespace = 'slug' " +
    "AND entity_kind IN ('area', 'project')",
  mode: "all",
};

const nameOf = (row: Row): GroupName => ({
  id: text(row["id"]),
  slug: text(row["slug"]),
  title: text(row["title"]),
  area: typeof row["area_id"] === "string" ? row["area_id"] : null,
});

/** The names a draft's area and project resolve against (A3 3.4.5), in one snapshot. */
export async function readGroupNames(reader: WorkerConnection): Promise<GroupNames> {
  const [areas, projects, aliases] = await snapshot(reader, [
    AREA_NAMES,
    PROJECT_NAMES,
    GROUP_ALIASES,
  ]);
  return {
    areas: (areas as Row[]).map(nameOf),
    projects: (projects as Row[]).map(nameOf),
    aliases: (aliases as Row[]).map((row) => ({
      alias: text(row["alias"]),
      kind: text(row["entity_kind"]),
      id: text(row["entity_id"]),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Folders (schema 0.5)

/** A live folder of an owner, with the name of the machine it is on. */
export interface OwnerFolder extends FolderView {
  readonly machineName: string;
}

const OWNER_FOLDERS: Statement = {
  sql:
    "SELECT f.*, m.name AS machine_name FROM folders f JOIN machines m ON m.id = f.machine_id " +
    "WHERE f.owner_kind = $kind AND f.owner_id = $owner AND f.deleted_at IS NULL " +
    "ORDER BY f.created_seq DESC, f.id",
  mode: "all",
};
const TASK_PROJECT_FOLDERS: Statement = {
  sql:
    "SELECT f.*, m.name AS machine_name FROM folders f JOIN tasks t ON t.project_id = f.owner_id " +
    "JOIN machines m ON m.id = f.machine_id WHERE t.id = $owner AND f.owner_kind = 'project' " +
    "AND f.deleted_at IS NULL ORDER BY f.created_seq DESC, f.id",
  mode: "all",
};

const ownerFolder = (row: Row): OwnerFolder => ({
  ...folderView(row),
  machineName: text(row["machine_name"]),
});

/** A project's or a task's live folders, one per machine, newest first. */
export async function readFolders(
  reader: WorkerConnection,
  kind: "project" | "task",
  owner: string,
): Promise<OwnerFolder[]> {
  const [rows] = await snapshot(reader, [OWNER_FOLDERS], { kind, owner });
  return (rows as Row[]).map(ownerFolder);
}

/**
 * The folder a launch of `task` uses on `machine` (storage's decideLaunchFolder): the task's own
 * folder there, else its project's there, else the machine where one of them is, else none, when
 * the launch uses the space's work folder. The one function the launch, the row, the digest and
 * the remote checks call.
 */
export async function readLaunchFolder(
  reader: WorkerConnection,
  task: string,
  machine: string,
): Promise<LaunchFolder> {
  const [own, project] = await snapshot(reader, [OWNER_FOLDERS, TASK_PROJECT_FOLDERS], {
    kind: "task",
    owner: task,
  });
  const ownRows = (own as Row[]).map(ownerFolder);
  const projectRows = (project as Row[]).map(ownerFolder);
  const names = new Map([...ownRows, ...projectRows].map((f) => [f.machine, f.machineName]));
  return decideLaunchFolder(ownRows, projectRows, machine, (id) => names.get(id));
}

const FOLDER_OWNER: Statement = {
  sql: "SELECT owner_id FROM folders WHERE id = $id",
  mode: "get",
};

/** The owner of a folder row, by the row's ID. */
export async function readFolderOwner(
  reader: WorkerConnection,
  id: string,
): Promise<string | undefined> {
  const [row] = await snapshot(reader, [FOLDER_OWNER], { id });
  const owner = (row as Row | null | undefined)?.["owner_id"];
  return typeof owner === "string" ? owner : undefined;
}

/** A live project's live folder on one machine. */
export interface ProjectFolderRow {
  readonly project: string;
  readonly name: string;
  readonly stored: string;
  readonly archived: boolean;
}

/** What binding a folder on this machine reads first (folders.ts in ops). */
export interface BindRead {
  readonly space: SpaceFacts;
  /** The owner's live folder on this machine. */
  readonly current: FolderView | undefined;
  /** Every live project's live folder on this machine, with the project's name. */
  readonly projects: readonly ProjectFolderRow[];
  /** A project's tasks' live folders on this machine, with each task's reference. */
  readonly tasks: readonly { id: string; ref: string; path: string }[];
}

const FOLDER_HERE: Statement = {
  sql:
    "SELECT * FROM folders WHERE owner_kind = $kind AND owner_id = $owner " +
    "AND machine_id = $machine AND deleted_at IS NULL",
  mode: "get",
};
const PROJECT_FOLDERS_HERE: Statement = {
  sql:
    "SELECT f.owner_id AS project, p.title AS name, f.path AS path, p.lifecycle AS lifecycle " +
    "FROM folders f " +
    "JOIN projects p ON p.id = f.owner_id WHERE f.machine_id = $machine " +
    "AND f.owner_kind = 'project' AND f.deleted_at IS NULL AND p.deleted_at IS NULL " +
    "ORDER BY f.created_seq, f.id",
  mode: "all",
};
const TASK_FOLDERS_HERE: Statement = {
  sql:
    "SELECT t.id AS id, t.ref AS ref, f.path AS path FROM folders f JOIN tasks t " +
    "ON t.id = f.owner_id WHERE f.machine_id = $machine AND f.owner_kind = 'task' " +
    "AND f.deleted_at IS NULL AND t.project_id = $owner ORDER BY t.ref",
  mode: "all",
};

const projectFolderRow = (r: Row): ProjectFolderRow => ({
  project: text(r["project"]),
  name: text(r["name"]),
  stored: text(r["path"]),
  archived: r["lifecycle"] === "archived",
});

/** Every live project's live folder on `machine`, oldest first. */
export async function readProjectFolders(
  reader: WorkerConnection,
  machine: string,
): Promise<ProjectFolderRow[]> {
  const [rows] = await snapshot(reader, [PROJECT_FOLDERS_HERE], { machine });
  return (rows as Row[]).map(projectFolderRow);
}

/** One snapshot of what a folder's bind on `machine` checks (BindRead). */
export async function readBind(
  reader: WorkerConnection,
  owner: { kind: "project" | "task"; id: string },
  machine: string,
): Promise<BindRead> {
  const [space, current, projects, tasks] = await snapshot(
    reader,
    [SPACE, FOLDER_HERE, PROJECT_FOLDERS_HERE, TASK_FOLDERS_HERE],
    { kind: owner.kind, owner: owner.id, machine },
  );
  const facts = spaceFacts(space);
  return {
    space: facts,
    current: current === null || current === undefined ? undefined : folderView(current as Row),
    projects: (projects as Row[]).map(projectFolderRow),
    tasks:
      owner.kind === "project"
        ? (tasks as Row[]).map((r) => ({
            id: text(r["id"]),
            ref: formatTaskRef(facts.refPrefix, Number(r["ref"])),
            path: text(r["path"]),
          }))
        : [],
  };
}

/** A live folder on this machine with its owner, as a move's answer names it. */
export interface FolderHere {
  readonly kind: "project" | "task";
  readonly owner: string;
  /** A project's name, or a task's reference. */
  readonly label: string;
  readonly path: string;
}

/** What a folder change on this machine reads first: the owner's folder and every live one here. */
export interface MoveRead {
  readonly current: string | undefined;
  /** The owner's ID, when it has a folder here. */
  readonly owner: string | undefined;
  readonly here: readonly FolderHere[];
}

const FOLDERS_ON: Statement = {
  sql:
    "SELECT f.owner_kind AS kind, f.owner_id AS owner, f.path AS path, p.title AS name, " +
    "t.ref AS ref FROM folders f " +
    "LEFT JOIN projects p ON f.owner_kind = 'project' AND p.id = f.owner_id " +
    "LEFT JOIN tasks t ON f.owner_kind = 'task' AND t.id = f.owner_id " +
    "WHERE f.machine_id = $machine AND f.deleted_at IS NULL ORDER BY f.id",
  mode: "all",
};
const TASK_FOLDER_HERE_OF_MATCH: Statement = {
  sql:
    "SELECT owner_id, path FROM folders WHERE owner_kind = 'task' AND machine_id = $machine " +
    `AND deleted_at IS NULL AND owner_id = ${MATCH}`,
  mode: "get",
};
const PROJECT_FOLDER_HERE: Statement = {
  sql:
    "SELECT owner_id, path FROM folders WHERE owner_kind = 'project' AND owner_id = $owner " +
    "AND machine_id = $machine AND deleted_at IS NULL",
  mode: "get",
};

/**
 * One snapshot of what a folder change on `machine` reads: the owner's folder there (a project by
 * ID, a task by reference or ID) and every live folder there.
 */
export async function readMove(
  reader: WorkerConnection,
  owner: { readonly kind: "project" | "task"; readonly id: string },
  machine: string,
): Promise<MoveRead> {
  const key = taskKey(owner.id);
  const [space, current, here] = await snapshot(
    reader,
    [SPACE, owner.kind === "task" ? TASK_FOLDER_HERE_OF_MATCH : PROJECT_FOLDER_HERE, FOLDERS_ON],
    { owner: owner.id, machine, id: key.id, ref: key.ref, alias: key.alias },
  );
  const facts = spaceFacts(space);
  const found = current as Row | null | undefined;
  const path = found?.["path"];
  const id = found?.["owner_id"];
  return {
    current: typeof path === "string" ? path : undefined,
    owner: typeof id === "string" ? id : undefined,
    here: (here as Row[]).map((r) => ({
      kind: r["kind"] === "task" ? "task" : "project",
      owner: text(r["owner"]),
      label:
        r["kind"] === "task" ? formatTaskRef(facts.refPrefix, Number(r["ref"])) : text(r["name"]),
      path: text(r["path"]),
    })),
  };
}

/** Where a new task lands, as a duplicate check compares it (similar.ts). */
export interface Destination {
  readonly project: string | null;
  readonly area: string | null;
  readonly inbox: boolean;
}

/** The newest active tasks a duplicate check reads per call: enough for any one group. */
export const SIBLING_LIMIT = 2000;

const SIBLINGS: Statement = {
  sql:
    "SELECT id, ref, title, area_id, project_id, inbox FROM tasks WHERE lifecycle = 'active' " +
    "AND deleted_at IS NULL AND (project_id IN (SELECT value FROM json_each($projects)) " +
    "OR (project_id IS NULL AND area_id IN (SELECT value FROM json_each($areas))) " +
    "OR ($loose = 1 AND project_id IS NULL AND area_id IS NULL)) " +
    `ORDER BY touched DESC, id LIMIT ${String(SIBLING_LIMIT)}`,
  mode: "all",
};

/** An active task as a duplicate check sees it: its reference, title and group. */
export interface Sibling {
  readonly ref: string;
  readonly title: string;
  readonly destination: Destination;
}

/** The active tasks in the groups of `destinations`, newest first, with the space's facts. */
export async function readSiblings(
  reader: WorkerConnection,
  destinations: readonly Destination[],
): Promise<Sibling[]> {
  const projects = destinations.flatMap((d) => (d.project === null ? [] : [d.project]));
  const areas = destinations.flatMap((d) =>
    d.project === null && d.area !== null ? [d.area] : [],
  );
  const loose = destinations.some((d) => d.project === null && d.area === null);
  const [space, rows] = await snapshot(reader, [SPACE, SIBLINGS], {
    projects: JSON.stringify([...new Set(projects)]),
    areas: JSON.stringify([...new Set(areas)]),
    loose: loose ? 1 : 0,
  });
  const prefix = spaceFacts(space).refPrefix;
  return (rows as Row[]).map((row) => ({
    ref: formatTaskRef(prefix, Number(row["ref"])),
    title: text(row["title"]),
    destination: {
      project: typeof row["project_id"] === "string" ? row["project_id"] : null,
      area: typeof row["area_id"] === "string" ? row["area_id"] : null,
      inbox: row["inbox"] === 1,
    },
  }));
}

// ---------------------------------------------------------------------------------------------
// Preferences (A1 3.16, A3 3.4.11)

/** Every preferences row: unknown keys are skipped by the readers, never dropped from the table. */
export const PREFERENCE_ROWS = "SELECT key, value, schema_ver FROM preferences";

/** Every space preference and flag the registry declares, in its order, from the stored rows. */
export function spacePreferencesOf(rows: readonly Row[]): PreferenceRead[] {
  const byKey = new Map<string, Row>();
  for (const row of rows) if (typeof row["key"] === "string") byKey.set(row["key"], row);
  return PREFERENCES.filter((spec) => spec.scope === "space").map((spec) =>
    preferenceValue(spec, storedPreference(byKey.get(spec.key))),
  );
}

/**
 * Every space preference as the registry reads it (`spacePreferencesOf`: the value when it fits
 * its shape, else the default), with the space's facts, in one snapshot: the `preferences` tool.
 */
export async function readSpacePreferences(
  reader: WorkerConnection,
): Promise<{ space: SpaceFacts; reads: Map<string, PreferenceRead> }> {
  const [space, rows] = await snapshot(reader, [SPACE, { sql: PREFERENCE_ROWS, mode: "all" }]);
  return {
    space: spaceFacts(space),
    reads: new Map(spacePreferencesOf(rows as Row[]).map((read) => [read.key, read])),
  };
}

// ---------------------------------------------------------------------------------------------
// Receipts

/**
 * A request's receipt in a writer scope, else in the connection's earlier scope: `receipt.get`,
 * a read like any other, so through the reader (A1 3.9). It works on a read-only space too, whose
 * receipts came with it from its backup. The writer's own lookup (receipts.ts) is the same query.
 */
export async function readReceipt(
  reader: WorkerConnection,
  lookup: ReceiptLookup,
): Promise<Receipt | undefined> {
  const scopes =
    lookup.earlier_scope_id === undefined
      ? [lookup.scope_id]
      : [lookup.scope_id, lookup.earlier_scope_id];
  const rows = await reader.transaction(
    "deferred",
    scopes.map((scope) => ({
      sql: RECEIPT_SQL,
      mode: "get" as const,
      params: { scope, request: lookup.request_id },
    })),
  );
  const found = (rows as (Row | null)[]).find((row): row is Row => row !== null);
  return found === undefined ? undefined : decodeReceipt(found);
}
