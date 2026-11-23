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
  inTrashSql,
  isId,
  RECEIPT_SQL,
  removalSeqSql,
  storedPreference,
  type FolderView,
  type LaunchFolder,
  type Receipt,
  type ReceiptLookup,
  type Row,
  type WorkerConnection,
} from "@ttasks/storage";
import {
  AppError,
  CAPTURES_TO_MAX,
  dayOf,
  PREFERENCES,
  weekLastDay,
  type DayClock,
  preferenceValue,
  readPreference,
  REMOVED_NOTES,
  REQUEST_LAUNCHES,
  type PreferenceRead,
} from "@ttasks/contracts";
import { sessionRecord } from "@ttasks/launch";
import { byOf } from "./errors.ts";
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

/** A deleted task's removal: the change that moved it to the Trash. */
export interface Removal {
  /** The change's commit. */
  readonly change?: string;
  readonly at: number;
  /** As people read it: user, import or the actor's label. */
  readonly by: string;
  /**
   * The tombstone is an undone creation, not a removal: it is not in the Trash, and Redo brings the
   * task back with its notes and links together.
   */
  readonly undone: boolean;
}

/** The removal of a task row read by `TASK`, or undefined when it is not deleted. */
export function removalOf(row: Row): Removal | undefined {
  const deletedAt = row["deleted_at"];
  if (typeof deletedAt !== "number") return undefined;
  const change = row["x_removed_change"];
  const at = row["x_removed_at"];
  return {
    ...(typeof change === "string" ? { change } : {}),
    at: typeof at === "number" ? at : deletedAt,
    by:
      typeof row["x_removed_kind"] === "string"
        ? byOf({
            kind: row["x_removed_kind"],
            label: String(row["x_removed_label"]),
            origin: String(row["x_removed_origin"]),
          })
        : "user",
    undone: row["x_in_trash"] !== 1,
  };
}

const TASK: Statement = {
  sql:
    "SELECT t.*, a.title AS area_title, p.title AS project_title, c.id AS x_removed_change, " +
    `c.at AS x_removed_at, ${inTrashSql("t")} AS x_in_trash, c.origin AS x_removed_origin, ` +
    "x.kind AS x_removed_kind, x.label AS x_removed_label FROM tasks t " +
    "LEFT JOIN areas a ON a.id = t.area_id LEFT JOIN projects p ON p.id = t.project_id " +
    `LEFT JOIN commits c ON t.deleted_at IS NOT NULL AND c.seq = ${removalSeqSql("t")} ` +
    `LEFT JOIN actors x ON x.id = c.author_id WHERE t.id = ${MATCH}`,
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
/** The launches that name note `n` as their request, oldest first: `[[reference, instance]]`. */
const REQUEST_FOR =
  "(SELECT json_group_array(json_array(l.reference, l.instance_id) ORDER BY l.created_at, l.id) " +
  "FROM launches l WHERE l.task_id = n.task_id " +
  "AND json_extract(l.detail, '$.evidence.request') = 'n' || n.ordinal)";
const NOTE_COLUMNS = `n.ordinal, n.addressee, n.body, n.created_at, ${authorOf("n")} AS author, ${REQUEST_FOR} AS request_for`;
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
/** The notes whose ordinals `$named` lists (a JSON array), whatever their age, newest first. */
const NAMED: Statement = {
  sql:
    `SELECT ${NOTE_COLUMNS} ${NOTES_FROM} ` +
    "AND n.ordinal IN (SELECT value FROM json_each($named)) ORDER BY n.ordinal DESC",
  mode: "all",
};

/**
 * The notes taken back from the task, newest removal first, with who removed them: the person's
 * alone to see and put back. A note removed by an undo of its writing is not one: Redo brings it
 * back with the rest of that change.
 */
const REMOVED_NOTE_ROWS: Statement = {
  sql:
    `SELECT ${NOTE_COLUMNS}, n.deleted_at, CASE WHEN c.origin = 'import' THEN 'import' ` +
    "WHEN rx.kind = 'human' THEN 'user' ELSE rx.label END AS removed_by " +
    "FROM notes n JOIN actors x ON x.id = n.author_id " +
    "JOIN commits c ON c.seq = json_extract(n.fp, '$.deleted') " +
    `JOIN actors rx ON rx.id = c.author_id WHERE n.task_id = ${MATCH} ` +
    "AND n.deleted_at IS NOT NULL AND c.undo_of IS NULL " +
    `ORDER BY n.deleted_at DESC, n.ordinal DESC LIMIT ${String(REMOVED_NOTES)}`,
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
/**
 * Where captures of a source's item go when this link does not decide it: for a source linked as
 * plain context (its key kept as its reference) and for a detached keyed link, every active task a
 * live link to the key's source joins, the read's own task included when another of its links
 * holds the key, by reference, as a JSON array. Several make a capture ask which. Read each time,
 * so it holds after any change of a holder.
 */
const CAPTURES_TO =
  "CASE WHEN ts.removed_at IS NOT NULL OR s.source_key IS NULL THEN (SELECT json_group_array(r) " +
  "FROM (SELECT (SELECT ref_prefix FROM space WHERE one = 1) || '-' || h.ref AS r FROM sources k " +
  "JOIN task_sources hl ON hl.source_id = k.id JOIN tasks h ON h.id = hl.task_id " +
  "WHERE k.source_key = coalesce(s.source_key, s.ref) AND k.deleted_at IS NULL " +
  "AND hl.removed_at IS NULL AND h.deleted_at IS NULL AND h.lifecycle = 'active' " +
  "ORDER BY h.ref)) END";
const SOURCE_COLUMNS =
  "s.id, s.source_key, s.kind, s.title, s.who, s.url, s.at, s.ref, ts.task_id, ts.version, " +
  `ts.removed_at, ${CAPTURES_TO} AS captures_to`;
const SOURCES: Statement = {
  sql:
    `SELECT ${SOURCE_COLUMNS} FROM task_sources ts ` +
    `JOIN sources s ON s.id = ts.source_id WHERE ts.task_id = ${MATCH} ` +
    "AND ts.removed_at IS NULL AND s.deleted_at IS NULL ORDER BY ts.position",
  mode: "all",
};
/**
 * The links detached from the task, newest first, with who detached them. A link removed by an
 * undo of its creation is not one: Redo brings it back with the rest of that change.
 */
const REMOVED_SOURCES: Statement = {
  sql:
    `SELECT ${SOURCE_COLUMNS}, ` +
    "CASE WHEN c.origin = 'import' THEN 'import' WHEN x.kind = 'human' THEN 'user' " +
    "ELSE x.label END AS removed_by FROM task_sources ts JOIN sources s ON s.id = ts.source_id " +
    "JOIN commits c ON c.seq = json_extract(ts.fp, '$.removed') " +
    `JOIN actors x ON x.id = c.author_id WHERE ts.task_id = ${MATCH} ` +
    "AND ts.removed_at IS NOT NULL AND s.deleted_at IS NULL AND c.undo_of IS NULL " +
    "ORDER BY ts.removed_at DESC, s.id",
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
    ...trashOf(row),
  };
}

/** `deleted` of a task row read with its removal (`TASK`): who moved it to the Trash, and when. */
function trashOf(row: Row): { deleted?: Record<string, string> } {
  if (!("x_removed_change" in row)) return {};
  const removal = removalOf(row);
  if (removal === undefined) return {};
  return {
    deleted: {
      at: iso(removal.at),
      by: removal.by,
      ...(removal.change === undefined ? {} : { change: removal.change }),
    },
  };
}

/**
 * A note as the results show it: `text` is its body, in full, and `request_for` the launches it
 * was the person's request for, the newest REQUEST_LAUNCHES.
 */
export const noteOf = (row: Row) => {
  const launches = requestFor(row["request_for"]);
  return {
    ref: `n${String(row["ordinal"])}`,
    author: text(row["author"]),
    for_agents: row["addressee"] === "agents",
    at: iso(row["created_at"]),
    text: text(row["body"]),
    ...(launches.length === 0 ? {} : { request_for: launches }),
    ...(typeof row["deleted_at"] === "number"
      ? { removed: { at: iso(row["deleted_at"]), by: text(row["removed_by"]) } }
      : {}),
  };
};

function requestFor(value: unknown): { launch: string; instance: string }[] {
  let list: unknown;
  try {
    list = typeof value === "string" ? JSON.parse(value) : [];
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((pair: unknown) =>
      Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"
        ? [{ launch: pair[0], instance: pair[1] }]
        : [],
    )
    .slice(-REQUEST_LAUNCHES);
}

export const logOf = (row: Row) => ({
  ref: `l${String(row["ordinal"])}`,
  kind: row["kind"] as string,
  author: text(row["author"]),
  at: iso(row["created_at"]),
  text: text(row["body"]),
});

/** The tasks a read names as holding a source's key, when any do, and how many more there are. */
function capturesTo(value: unknown): { captures_to?: string[]; captures_more?: number } {
  if (typeof value !== "string") return {};
  const refs = (JSON.parse(value) as unknown[]).filter((r): r is string => typeof r === "string");
  if (refs.length === 0) return {};
  const more = refs.length - CAPTURES_TO_MAX;
  return {
    captures_to: refs.slice(0, CAPTURES_TO_MAX),
    ...(more > 0 ? { captures_more: more } : {}),
  };
}

export const sourceOf = (row: Row) => ({
  id: text(row["id"]),
  ...present("key", row["source_key"]),
  kind: row["kind"] as string,
  title: text(row["title"]),
  ...present("who", row["who"]),
  ...present("url", row["url"]),
  ...(typeof row["at"] === "number" ? { at: iso(row["at"]) } : {}),
  ...present("ref", row["ref"]),
  ...capturesTo(row["captures_to"]),
  ...(typeof row["removed_at"] === "number"
    ? { removed: { at: iso(row["removed_at"]), by: text(row["removed_by"]) } }
    : {}),
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
    hint: "Check the reference with ttasks status or ttasks find.",
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
  /** The notes `named` asked for by ordinal, of either kind, newest first. */
  readonly named: Row[];
  readonly log: Row[];
  readonly sources: Row[];
  /** The links detached from it, newest first: the card's Removed line. */
  readonly removedSources: Row[];
  /** The notes taken back from it, newest first, when `removed` asked for them. */
  readonly removedNotes: Row[];
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
 * ranges asked for, and the notes named by ordinal. A reference with another space's prefix is
 * `not_found`, never a task elsewhere (A3 3.4.1), and so is a deleted task (A1 3.5), unless
 * `trash` asks for one in the Trash. A creation that was undone is `not_found` either way.
 */
export async function readTask(
  reader: WorkerConnection,
  ref: string,
  options: {
    readonly machine: string;
    readonly instructions: EntryRange;
    readonly notes: EntryRange;
    readonly log: EntryRange;
    readonly named?: readonly number[];
    readonly trash?: boolean;
    /** The notes taken back too: for the person, never for an agent. */
    readonly removed?: boolean;
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
    named: JSON.stringify(options.named ?? []),
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
    removedSources,
    history,
    learnings,
    named,
    removedNotes,
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
      REMOVED_SOURCES,
      HISTORY,
      learned ? LEARNINGS : NOTHING,
      options.named === undefined || options.named.length === 0 ? NOTHING : NAMED,
      options.removed === true ? REMOVED_NOTE_ROWS : NOTHING,
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
  if (task === null) throw notFound();
  const removal = removalOf(task);
  if (removal !== undefined && (options.trash !== true || removal.undone)) throw notFound();
  const noteCounts = counts as Row | null;
  const sourceRows = sources as Row[];
  return {
    space: facts,
    row: task,
    instructions: instructions as Row[],
    notes: notes as Row[],
    named: (named ?? []) as Row[],
    log: log as Row[],
    sources: sourceRows,
    removedSources: removedSources as Row[],
    removedNotes: (removedNotes ?? []) as Row[],
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

/**
 * The removal of the deleted task a reference names, with its reference: who moved it to the Trash,
 * or that its creation was undone (`undone`). None for a live task or no task.
 */
export async function readRemoval(
  reader: WorkerConnection,
  ref: string,
): Promise<{ readonly ref: string; readonly removal: Removal } | undefined> {
  const key = taskKey(ref);
  const [space, row] = await snapshot(reader, [SPACE, TASK], {
    id: key.id,
    ref: key.ref,
    alias: key.alias,
  });
  const task = row as Row | null;
  const removal = task === null ? undefined : removalOf(task);
  if (task === null || removal === undefined) return undefined;
  return { ref: formatTaskRef(spaceFacts(space).refPrefix, Number(task["ref"])), removal };
}

/** A task's live links, then those detached from it, as its read lists them. */
export async function readTaskLinks(reader: WorkerConnection, ref: string): Promise<Row[]> {
  const { id, ref: number, alias } = taskKey(ref);
  const [live, removed] = await snapshot(reader, [SOURCES, REMOVED_SOURCES], {
    id,
    ref: number,
    alias,
  });
  return [...(live as Row[]), ...(removed as Row[])];
}

/**
 * The question `ordinal` of the task, if it is one: when it arrived, whether a later question
 * arrived in the same millisecond, and the task's `reviewed_at`.
 */
const QUESTION_ARRIVAL: Statement = {
  sql:
    "SELECT k.at AS at, t.reviewed_at AS reviewed, EXISTS (SELECT 1 FROM log_entries l JOIN " +
    "commits c ON c.seq = l.created_seq WHERE l.task_id = q.task_id AND l.kind = 'question' AND " +
    "l.created_seq > q.created_seq AND c.at = k.at) AS tied FROM log_entries q JOIN commits k " +
    `ON k.seq = q.created_seq JOIN tasks t ON t.id = q.task_id WHERE q.task_id = ${MATCH} AND ` +
    "q.ordinal = $ordinal AND q.kind = 'question' AND q.deleted_at IS NULL",
  mode: "get",
};

/**
 * The task's `reviewed_at` once the person dismissed its question `ordinal` and those before it:
 * that question's arrival (task-rows.ts's `WAITS`), a millisecond before it when a later question
 * arrived in the same millisecond, so the one the person did not see still waits. Never earlier
 * than the mark the task has. `mark` is undefined when the entry is no question of the task;
 * `asOf` is the read's.
 */
export async function readReviewedMark(
  reader: WorkerConnection,
  ref: string,
  ordinal: number,
): Promise<{ readonly mark: number | undefined; readonly asOf: string }> {
  const { id, ref: number, alias } = taskKey(ref);
  const [space, found] = await snapshot(reader, [SPACE, QUESTION_ARRIVAL], {
    id,
    ref: number,
    alias,
    ordinal,
  });
  const { asOf } = spaceFacts(space);
  if (found === undefined || found === null) return { mark: undefined, asOf };
  const row = found as Row;
  const mark = Number(row["at"]) - (Number(row["tied"]) === 1 ? 1 : 0);
  const reviewed = row["reviewed"];
  return { mark: typeof reviewed === "number" && reviewed > mark ? reviewed : mark, asOf };
}

// ---------------------------------------------------------------------------------------------
// Launches and the bound task (A3 3.7.3, 3.4.2)

/** A launch by its reference: the newest with it; launches 90 days apart may share one. */
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

/** A note the space's human wrote on a task, not imported and not removed, by its ordinal. */
const PERSONS_NOTE: Statement = {
  sql:
    "SELECT n.body FROM notes n JOIN actors x ON x.id = n.author_id WHERE n.task_id = $task " +
    `AND n.ordinal = $ordinal AND n.deleted_at IS NULL AND x.kind = 'human' AND NOT ${imported("n")}`,
  mode: "get",
};

/**
 * The text of a note the person wrote on task `task` (an ID), by its reference such as `n2`:
 * undefined when the task has none, or it was removed or written by anyone else.
 */
export async function readPersonsNote(
  reader: WorkerConnection,
  task: string,
  ref: string,
): Promise<string | undefined> {
  const ordinal = /^n([1-9][0-9]{0,5})$/u.exec(ref)?.[1];
  if (ordinal === undefined) return undefined;
  const [row] = await snapshot(reader, [PERSONS_NOTE], { task, ordinal: Number(ordinal) });
  return isPlain(row) ? text(row["body"]) : undefined;
}

/** The bound task's reference and how many notes the user addressed to agents it has. */
const BOUND: Statement = {
  sql:
    "SELECT t.ref, (SELECT count(*) FROM notes n JOIN actors x ON x.id = n.author_id " +
    `WHERE n.task_id = t.id AND n.deleted_at IS NULL AND ${INSTRUCTION}) AS instructions ` +
    "FROM tasks t WHERE t.id = $bound",
  mode: "get",
};

const TITLES: Statement = {
  sql: "SELECT id, title FROM tasks WHERE id IN (SELECT value FROM json_each($ids))",
  mode: "all",
};

/** The stored titles of the tasks `ids` names, by ID. */
export async function readTaskTitles(
  reader: WorkerConnection,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const [rows] = await snapshot(reader, [TITLES], { ids: JSON.stringify(ids) });
  return new Map((rows as Row[]).map((row) => [String(row["id"]), String(row["title"])]));
}

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
// Agent sessions this machine started

// Only what the space's current authority made links a session: a record a claim or a restore in
// place brought back from a backup (made before `authority_since`) is history, whatever its state,
// and its session ID names a conversation of the copy it was made in.
const AGENT_LAUNCHES: Statement = {
  sql:
    "SELECT l.id, l.task_id, l.detail, t.ref AS task_ref FROM launches l " +
    "JOIN tasks t ON t.id = l.task_id " +
    "JOIN space s ON s.one = 1 AND l.created_seq >= s.authority_since " +
    "WHERE l.machine_id = $machine AND l.route = 'terminal' " +
    "AND (l.updated_at >= $since OR l.id IN (SELECT value FROM json_each($running)))",
  mode: "all",
};
const AGENT_RUNS: Statement = {
  sql:
    "SELECT r.id, r.task_id, r.adapter, r.detail, r.ended_at, t.ref AS task_ref FROM runs r " +
    "JOIN tasks t ON t.id = r.task_id " +
    "JOIN space s ON s.one = 1 AND r.created_seq >= s.authority_since " +
    "WHERE r.machine_id = $machine AND r.started_at IS NOT NULL " +
    "AND (r.ended_at IS NULL OR r.ended_at >= $since)",
  mode: "all",
};

/**
 * A terminal launch or a background run of this machine, with its agent app, the home it started
 * the app in and the app's session ID, all as its record holds them.
 */
export interface AgentSessionRow {
  readonly started: "terminal" | "run";
  /** The `la_` or `ru_` ID. */
  readonly id: string;
  readonly task: string;
  readonly ref: string;
  readonly provider: "claude" | "codex";
  /** The agent home's digest, as the click or the run's start recorded it (`homeDigest`). */
  readonly home: string;
  /** Claude Code's preset session or Codex's thread for a launch, the reported one for a run. */
  readonly sessionId: string;
  /** A launch whose record says its agent ended. */
  readonly ended: boolean;
}

const evidenceOf = (detail: unknown): Readonly<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(String(detail));
    const evidence = isPlain(parsed) ? parsed["evidence"] : undefined;
    return isPlain(evidence) ? evidence : {};
  } catch {
    return {};
  }
};

/**
 * The terminal launches and background runs of `machine` whose record holds the agent app, its
 * home and its session ID: those that changed or ended since `since`, and the launches `running`
 * names whatever their age. A record without its home is left out. One of a task in the Trash is
 * kept: its agent may still work, and the Agents page shows it with Stop.
 */
export async function readAgentSessions(
  reader: WorkerConnection,
  query: { readonly machine: string; readonly since: number; readonly running: readonly string[] },
): Promise<{ space: SpaceFacts; rows: AgentSessionRow[] }> {
  const [space, launches, runs] = await snapshot(reader, [SPACE, AGENT_LAUNCHES, AGENT_RUNS], {
    machine: query.machine,
    since: query.since,
    running: JSON.stringify(query.running),
  });
  const facts = spaceFacts(space);
  const rows: AgentSessionRow[] = [];
  const add = (
    row: Row,
    held: Pick<AgentSessionRow, "started" | "provider" | "ended">,
    evidence: Readonly<Record<string, unknown>>,
    sessionId: unknown,
  ): void => {
    const home = evidence["home"];
    if (typeof sessionId !== "string" || sessionId === "") return;
    if (typeof home !== "string" || home === "") return;
    rows.push({
      ...held,
      id: text(row["id"]),
      task: text(row["task_id"]),
      ref: formatTaskRef(facts.refPrefix, Number(row["task_ref"])),
      home,
      sessionId,
    });
  };
  for (const row of launches as Row[]) {
    const evidence = evidenceOf(row["detail"]);
    const ended = sessionRecord(evidence) !== "open";
    // A terminal launch's session ID says which app it started: the click presets Claude Code's,
    // and Codex's thread is found in its session files.
    const preset = evidence["preset"];
    const thread = evidence["thread"];
    if (preset !== undefined) {
      add(row, { started: "terminal", provider: "claude", ended }, evidence, preset);
    } else if (thread !== undefined) {
      add(row, { started: "terminal", provider: "codex", ended }, evidence, thread);
    }
  }
  for (const row of runs as Row[]) {
    const evidence = evidenceOf(row["detail"]);
    const provider = row["adapter"] === "claude-print" ? "claude" : "codex";
    const ended = row["ended_at"] !== null;
    add(row, { started: "run", provider, ended }, evidence, evidence["native_id"]);
  }
  return { space: facts, rows };
}

// ---------------------------------------------------------------------------------------------
// Runs

/** How many runs a list reads at most: the newest. */
export const RUNS_LISTED = 50;

const RUNS_ALL: Statement = {
  sql:
    "SELECT r.*, t.ref AS task_ref FROM runs r LEFT JOIN tasks t ON t.id = r.task_id " +
    `ORDER BY r.queued_at DESC, r.id DESC LIMIT ${String(RUNS_LISTED)}`,
  mode: "all",
};
const RUNS_OF_TASK: Statement = {
  sql:
    "SELECT r.*, t.ref AS task_ref FROM runs r LEFT JOIN tasks t ON t.id = r.task_id " +
    `WHERE r.task_id = $task ORDER BY r.queued_at DESC, r.id DESC LIMIT ${String(RUNS_LISTED)}`,
  mode: "all",
};

const RUN_BY_ID: Statement = {
  sql: "SELECT r.*, t.ref AS task_ref FROM runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.id = $run",
  mode: "get",
};

/** One run's row, with its task's reference, as RUNS_ALL reads it; undefined when there is none. */
export async function readRunRow(
  reader: WorkerConnection,
  run: string,
): Promise<{ row: Row; ref: string | null } | undefined> {
  const [space, row] = await snapshot(reader, [SPACE, RUN_BY_ID], { run });
  if (row === undefined || row === null) return undefined;
  const ref = (row as Row)["task_ref"];
  return {
    row: row as Row,
    ref: typeof ref === "number" ? formatTaskRef(spaceFacts(space).refPrefix, ref) : null,
  };
}

/**
 * The space's newest runs, or a task's (`task`, a `t_` ID), newest first, each row with its task's
 * reference (`task_ref`, formatted). Rows as the runs table holds them.
 */
export async function readRunRows(
  reader: WorkerConnection,
  task?: string,
): Promise<{ row: Row; ref: string | null }[]> {
  const [space, rows] = await snapshot(
    reader,
    [SPACE, task === undefined ? RUNS_ALL : RUNS_OF_TASK],
    { task: task ?? null },
  );
  const prefix = spaceFacts(space).refPrefix;
  return (rows as Row[]).map((row) => {
    const ref = row["task_ref"];
    return { row, ref: typeof ref === "number" ? formatTaskRef(prefix, ref) : null };
  });
}

/**
 * The open runs that the space's current authority did not make: recorded before its claim
 * (`authority_since`), so a claim or a restore in place brought them back from a backup, whichever
 * machine made them.
 */
const RUNS_RESTORED: Statement = {
  sql:
    "SELECT r.id FROM runs r, space s WHERE s.one = 1 " +
    "AND r.created_seq < s.authority_since AND (r.state IN ('queued','starting','running'," +
    "'waiting_for_input','cancelling','reconciling') " +
    "OR (r.state = 'unknown' AND r.reason = 'stop_timed_out'))",
  mode: "all",
};

/** The IDs of RUNS_RESTORED: open runs a claim or a restore brought back. */
export async function readRestoredRuns(reader: WorkerConnection): Promise<Set<string>> {
  const [rows] = await snapshot(reader, [RUNS_RESTORED]);
  return new Set(
    (rows as Row[]).flatMap((row) => (typeof row["id"] === "string" ? [row["id"]] : [])),
  );
}

/**
 * The launches that were open (isOpenLaunch) when the backup a claim or a restore in place brought
 * back was made, whichever machine made them: still opening, or a terminal session whose end is not
 * recorded. Each is ended before the space is served (LaunchService.settleRestored).
 */
const LAUNCHES_RESTORED: Statement = {
  sql:
    "SELECT l.id FROM launches l, space s WHERE s.one = 1 AND l.created_seq < s.authority_since " +
    "AND (l.state IN ('prepared','dispatching') OR (l.route = 'terminal' AND (l.state = 'dispatched' " +
    "OR (l.state = 'confirmed' AND json_extract(l.detail, '$.evidence.ran_ms') IS NULL " +
    "AND json_extract(l.detail, '$.evidence.exit_code') IS NULL " +
    "AND json_extract(l.detail, '$.evidence.restored_at') IS NULL " +
    "AND json_extract(l.detail, '$.evidence.lost_at') IS NULL))))",
  mode: "all",
};

/** The IDs of LAUNCHES_RESTORED: open launches a claim or a restore brought back. */
export async function readRestoredLaunches(reader: WorkerConnection): Promise<Set<string>> {
  const [rows] = await snapshot(reader, [LAUNCHES_RESTORED]);
  return new Set(
    (rows as Row[]).flatMap((row) => (typeof row["id"] === "string" ? [row["id"]] : [])),
  );
}

// ---------------------------------------------------------------------------------------------
// Status

const STATUS_ORDER: Statement = {
  sql: "SELECT value, schema_ver FROM preferences WHERE key = 'tasks.statuses'",
  mode: "get",
};
/** A task counts once, as on the page: in the Inbox by its flag, else under its status (day.ts). */
const COUNTS: Statement = {
  sql:
    "SELECT status, count(*) AS n FROM tasks WHERE lifecycle = 'active' AND deleted_at IS NULL " +
    "AND inbox = 0 GROUP BY status",
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
 * 8 rows for each of the 5 other sections, plus its own 8. One row more says whether there are
 * more than it counts.
 */
const SECTION_READ = SECTION_ROWS * 6;
const SECTION_LIMIT = `LIMIT ${String(SECTION_READ + 1)}`;
const SECTION_SQL: Readonly<Record<string, Statement>> = {
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

/**
 * The active tasks Today or the week may hold: starred, or due or planned up to the week's last
 * day. A due time is read up to `$until`, past that day in any time zone. The rule that decides
 * is the page's (day.ts), so these sections hold what the person sees there, in that order.
 */
const DAY_CANDIDATES: Statement = {
  sql:
    ROW_SQL +
    "t.lifecycle = 'active' AND (t.focus_on IS NOT NULL OR t.due_date <= $last " +
    "OR t.planned_for <= $last OR t.due_at < $until)",
  mode: "all",
};
const DAY_SECTIONS = new Set(["today", "week"]);

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** Today's and the week's rows, each in its order. */
function daySections(rows: readonly Row[], clock: DayClock): Record<"today" | "week", Row[]> {
  const day = dayOf(
    rows.map((row) => ({
      row,
      id: String(row["id"]),
      lifecycle: String(row["lifecycle"]),
      status: String(row["status"]),
      inbox: row["inbox"] === 1,
      priority: numberOrNull(row["priority"]),
      due_date: textOrNull(row["due_date"]),
      due_at: numberOrNull(row["due_at"]),
      planned_for: textOrNull(row["planned_for"]),
      focus_on: textOrNull(row["focus_on"]),
      created_at: Number(row["created_at"]),
    })),
    clock,
  );
  return { today: day.today.map((t) => t.row), week: day.week.map((t) => t.row) };
}

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
 * The keys of `tasks.statuses` or `tasks.effort_scale` from its row (`value`, `schema_ver`), as the
 * registry reads them (A1 3.16).
 */
export function keysOf(key: "tasks.statuses" | "tasks.effort_scale", row: unknown): string[] {
  const { value } = readPreference(key, storedOf(row));
  return Array.isArray(value)
    ? value.map((item: unknown) =>
        typeof item === "string" ? item : String((item as { key?: unknown }).key),
      )
    : [];
}

const EFFORT_SCALE: Statement = {
  sql: "SELECT value, schema_ver FROM preferences WHERE key = 'tasks.effort_scale'",
  mode: "get",
};

/** The status keys and the effort keys a task of the space may take, in their order. */
export async function readTaskKeys(
  reader: WorkerConnection,
): Promise<{ status: string[]; effort: string[] }> {
  const [statuses, efforts] = await snapshot(reader, [STATUS_ORDER, EFFORT_SCALE]);
  return {
    status: keysOf("tasks.statuses", statuses),
    effort: keysOf("tasks.effort_scale", efforts),
  };
}

/** How many active tasks a refusal names at most. */
const HOLDERS_SHOWN = 10;

/**
 * The active tasks whose status or effort is one of `keys`, by reference, at most HOLDERS_SHOWN,
 * and how many there are.
 */
export async function readKeyHolders(
  reader: WorkerConnection,
  field: "status" | "effort",
  keys: readonly string[],
): Promise<{ tasks: { ref: string; key: string }[]; count: number }> {
  if (keys.length === 0) return { tasks: [], count: 0 };
  const held =
    `FROM tasks WHERE lifecycle = 'active' AND deleted_at IS NULL ` +
    `AND ${field} IN (SELECT value FROM json_each($keys))`;
  const [space, rows, count] = await snapshot(
    reader,
    [
      SPACE,
      {
        sql: `SELECT ref, ${field} AS key ${held} ORDER BY ref LIMIT ${String(HOLDERS_SHOWN)}`,
        mode: "all",
      },
      { sql: `SELECT count(*) AS n ${held}`, mode: "get" },
    ],
    { keys: JSON.stringify(keys) },
  );
  const prefix = spaceFacts(space).refPrefix;
  return {
    tasks: (rows as Row[]).map((row) => ({
      ref: formatTaskRef(prefix, Number(row["ref"])),
      key: String(row["key"]),
    })),
    count: Number((count as Row)["n"]),
  };
}

/** space.status for a connection that is not bound (A3 3.4.2). */
export async function readStatus(
  reader: WorkerConnection,
  options: {
    readonly clock: DayClock;
    readonly since: number;
    readonly include: readonly string[];
    /** Read the active tasks `here` matched, for `here`. */
    readonly here?: HereIds;
    /** The bound task's ID: its reference and notes for agents, for the session line. */
    readonly bound?: string;
  },
): Promise<{
  space: SpaceFacts;
  statuses: { status: string; count: number }[];
  inbox: number;
  sections: {
    name: string;
    tasks: Record<string, unknown>[];
    total: number;
    more?: true;
    above?: number;
  }[];
  /** The task rows `here` asked for, each with `x_own_here`. */
  here: Row[];
  /** The bound task, when one was asked for and it exists. */
  bound: { ref: string; instructions: number } | undefined;
}> {
  const include = [...new Set(options.include)].filter(
    (name) => DAY_SECTIONS.has(name) || Object.hasOwn(SECTION_SQL, name),
  );
  const queried = include.filter((name) => !DAY_SECTIONS.has(name));
  const day = include.some((name) => DAY_SECTIONS.has(name));
  const { clock } = options;
  const results = await snapshot(
    reader,
    [
      SPACE,
      STATUS_ORDER,
      COUNTS,
      INBOX,
      ...(options.bound === undefined ? [] : [BOUND]),
      ...(options.here === undefined ? [] : [HERE_TASKS]),
      ...(day ? [DAY_CANDIDATES] : []),
      ...queried.map((name) => SECTION_SQL[name] as Statement),
    ],
    {
      last: weekLastDay(clock),
      // The week's last day ends less than 8 days from now, in any time zone.
      until: clock.now + 8 * 86_400_000,
      since: options.since,
      ...hereParams(options.here ?? { machine: "", tasks: [], projects: [] }),
      bound: options.bound ?? null,
    },
  );
  const [space, order, counts, inbox, ...rest] = results;
  const boundRow = options.bound === undefined ? undefined : rest.shift();
  const here = options.here === undefined ? [] : ((rest.shift() ?? []) as Row[]);
  const days = day ? daySections((rest.shift() ?? []) as Row[], clock) : undefined;
  const found = new Map(queried.map((name, i) => [name, (rest[i] ?? []) as Row[]]));
  if (days !== undefined) found.set("today", days.today).set("week", days.week);
  const facts = spaceFacts(space);
  const byStatus = new Map(
    (counts as Row[]).map((row) => [String(row["status"]), Number(row["n"])] as const),
  );
  const keys = keysOf("tasks.statuses", order);
  for (const key of byStatus.keys()) if (!keys.includes(key)) keys.push(key);
  // A task appears once, in its first section (A3 3.4.2).
  const shown = new Set<unknown>();
  const sections = include.map((name) => {
    // Today and the week are read whole; the other sections up to their statement's limit.
    const read = found.get(name) ?? [];
    const more = read.length > SECTION_READ && !DAY_SECTIONS.has(name);
    const all = more ? read.slice(0, SECTION_READ) : read;
    const rows = all.filter((row) => !shown.has(row["id"]));
    const kept = rows.slice(0, SECTION_ROWS);
    for (const row of kept) shown.add(row["id"]);
    const above = all.length - rows.length;
    return {
      name,
      tasks: kept.map((row) => taskRow(row, facts.refPrefix)),
      total: rows.length,
      // The statement's own limit cut the section: its count is a lower bound.
      ...(more ? { more: true as const } : {}),
      ...(above === 0 ? {} : { above }),
    };
  });
  return {
    space: facts,
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
  | {
      readonly kind: "task" | "project";
      readonly path: string;
      /** The task's or the project's ID: whose folder it is. */
      readonly owner: string;
    }
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
  const owners = new Map([...own, ...project].map((r) => [text(r["id"]), text(r["owner_id"])]));
  const decided = decideLaunchFolder(ownRows, projectRows, machine, (id) => names.get(id));
  switch (decided.kind) {
    case "task":
    case "project":
      return {
        kind: decided.kind,
        path: decided.folder.path,
        owner: owners.get(decided.folder.id) ?? "",
      };
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
 * deleted task are `not_found`, unless `trash` asks for one in the Trash (its runs). With it, the
 * folder it opens in on `machine`.
 */
export async function readLaunchTask(
  reader: WorkerConnection,
  ref: string,
  machine: string,
  options: { readonly trash?: boolean } = {},
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
  if (task === null) throw notFound();
  const removal = removalOf(task);
  if (removal !== undefined && (options.trash !== true || removal.undone)) throw notFound();
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

const GROUP_COLUMNS = "id, slug, title, lifecycle, position";
const AREA_LIST: Statement = {
  sql:
    `SELECT ${GROUP_COLUMNS}, ${ACTIVE_IN("area_id", "a")} AS active FROM areas a ` +
    "WHERE a.deleted_at IS NULL ORDER BY a.position, a.id",
  mode: "all",
};
const PROJECT_LIST: Statement = {
  sql:
    `SELECT ${GROUP_COLUMNS}, area_id, ${ACTIVE_IN("project_id", "p")} AS active ` +
    "FROM projects p WHERE p.deleted_at IS NULL ORDER BY p.position, p.id",
  mode: "all",
};

/** The space's areas and projects that are not deleted, archived ones too, in the space's order. */
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
  readonly archived?: boolean;
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
  sql: "SELECT id, slug, title, lifecycle FROM areas WHERE deleted_at IS NULL ORDER BY position, id",
  mode: "all",
};
const PROJECT_NAMES: Statement = {
  sql:
    "SELECT id, area_id, slug, title, lifecycle FROM projects WHERE deleted_at IS NULL " +
    "ORDER BY position, id",
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
  ...(row["lifecycle"] === "active" ? {} : { archived: true }),
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

const PROJECT_FOLDERS_ALL: Statement = {
  sql:
    "SELECT f.machine_id AS machine, m.name AS machine_name, f.path AS path FROM folders f " +
    "JOIN machines m ON m.id = f.machine_id JOIN projects p ON p.id = f.owner_id " +
    "WHERE f.owner_kind = 'project' AND f.owner_id = $project AND f.deleted_at IS NULL " +
    "AND p.deleted_at IS NULL ORDER BY m.name, f.id",
  mode: "all",
};

/** A live project's live folders on every machine, with each machine's name. */
export async function readProjectFolderAll(
  reader: WorkerConnection,
  project: string,
): Promise<{ machine: string; machineName: string; stored: string }[]> {
  if (!(await hasFolderTable(reader))) return [];
  const [rows] = await snapshot(reader, [PROJECT_FOLDERS_ALL], { project });
  return (rows as Row[]).map((r) => ({
    machine: text(r["machine"]),
    machineName: text(r["machine_name"]),
    stored: text(r["path"]),
  }));
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
 * A request's receipt in a writer scope: `receipt.get`, a read like any other, so through the
 * reader (A1 3.9). It works on a read-only space too, whose receipts came with it from its backup.
 * The writer's own lookup (receipts.ts) is the same query.
 */
export async function readReceipt(
  reader: WorkerConnection,
  lookup: ReceiptLookup,
): Promise<Receipt | undefined> {
  const [row] = (await reader.transaction("deferred", [
    {
      sql: RECEIPT_SQL,
      mode: "get" as const,
      params: { scope: lookup.scope_id, request: lookup.request_id },
    },
  ])) as (Row | null)[];
  return row === undefined || row === null ? undefined : decodeReceipt(row);
}
