// The request path's reads (A3 3.4.2, 3.4.4): through a space's reader connection, never its
// writer (A1 3.9). Every read is one deferred transaction of constant statements on the reader, so
// it sees one snapshot, and its `as_of` is that snapshot's. Values are bound as parameters.
//
// What a read returns is plain rows; task-view.ts makes the digest v0 and the pages of a sections
// read from them, and the handlers the registry's results. A task's notes the user addressed to
// agents are read apart from its other notes (A3 3.10: only those are instructions), each list
// newest first from an ordinal down, so a page can start where the last one ended.
import {
  decodeReceipt,
  decodeSpaceRow,
  formatAsOf,
  formatTaskRef,
  isId,
  RECEIPT_SQL,
  type Receipt,
  type ReceiptLookup,
  type Row,
  type WorkerConnection,
} from "@tasks/storage";
import { AppError } from "@tasks/contracts";

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
const PLACE: Statement = {
  sql:
    "SELECT root_id, rel_path, kind, identity FROM places WHERE owner_kind = 'task' " +
    "AND machine_id = $machine " +
    `AND deleted_at IS NULL AND owner_id = ${MATCH}`,
  mode: "get",
};
/** The task's own learnings in their order, those its wrap-ups left (A1 3.11.2). */
const LEARNINGS: Statement = {
  sql:
    `SELECT body FROM learnings WHERE task_id = ${MATCH} AND deleted_at IS NULL ` +
    "ORDER BY position",
  mode: "all",
};
const LEARNINGS_TABLE: Statement = {
  sql: "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'learnings'",
  mode: "get",
};
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
  readonly place: Row | undefined;
  readonly history: Row[];
  /** The task's own learnings, in their order. */
  readonly learnings: string[];
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
    place,
    history,
    learnings,
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
      PLACE,
      HISTORY,
      ...(learned ? [LEARNINGS] : []),
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
    place: (place as Row | null) ?? undefined,
    history: history as Row[],
    learnings: ((learnings ?? []) as Row[]).map((learning) => text(learning["body"])),
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
  sql: "SELECT value FROM preferences WHERE key = 'tasks.statuses'",
  mode: "get",
};
const AUTONOMY: Statement = {
  sql: "SELECT value FROM preferences WHERE key = 'autonomy.level'",
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

/** Active tasks with a place on this machine under one of the roots in `$roots` (JSON). */
const PLACED: Statement = {
  sql:
    "SELECT t.*, a.title AS area_title, p.title AS project_title, pl.root_id AS place_root, " +
    "pl.rel_path AS place_path, pl.kind AS place_kind, pl.identity AS place_identity " +
    "FROM tasks t JOIN places pl ON pl.owner_kind = 'task' " +
    "AND pl.owner_id = t.id AND pl.machine_id = $machine AND pl.deleted_at IS NULL " +
    "LEFT JOIN areas a ON a.id = t.area_id LEFT JOIN projects p ON p.id = t.project_id " +
    "WHERE t.deleted_at IS NULL AND t.lifecycle = 'active' " +
    "AND pl.root_id IN (SELECT value FROM json_each($roots))",
  mode: "all",
};

/** The active tasks placed on this machine under `roots`, with the space's facts. */
export async function readPlaced(
  reader: WorkerConnection,
  machine: string,
  roots: readonly string[],
): Promise<{ space: SpaceFacts; placed: Row[] }> {
  const [space, placed] = await snapshot(reader, [SPACE, PLACED], {
    machine,
    roots: JSON.stringify(roots),
  });
  return { space: spaceFacts(space), placed: placed as Row[] };
}

export const DEFAULT_STATUS_ORDER = ["open", "waiting", "review", "backlog"] as const;

function keysOf(value: unknown, fallback: readonly string[]): string[] {
  if (typeof value !== "string") return [...fallback];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [...fallback];
    const keys = parsed.map((item: unknown) =>
      typeof item === "string"
        ? item
        : typeof item === "object" && item !== null && "key" in item
          ? String(item.key)
          : "",
    );
    return keys.every((k) => k !== "") && keys.length > 0 ? keys : [...fallback];
  } catch {
    return [...fallback];
  }
}

function levelOf(value: unknown): "full" | "review" | "suggest" {
  try {
    const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : undefined;
    return parsed === "full" || parsed === "suggest" ? parsed : "review";
  } catch {
    return "review";
  }
}

/** space.status for a connection that is not bound (A3 3.4.2). */
export async function readStatus(
  reader: WorkerConnection,
  options: {
    readonly today: string;
    readonly week: string;
    readonly since: number;
    readonly include: readonly string[];
    /** Read the active tasks placed on this machine under these roots, for `here`. */
    readonly placed?: { readonly machine: string; readonly roots: readonly string[] };
    /** The bound task's ID: its reference and notes for agents, for the session line. */
    readonly bound?: string;
  },
): Promise<{
  space: SpaceFacts;
  autonomy: "full" | "review" | "suggest";
  statuses: { status: string; count: number }[];
  inbox: number;
  sections: { name: string; tasks: Record<string, unknown>[] }[];
  /** Each task row with its place's `place_root`, `place_path`, `place_kind` and `place_identity`. */
  placed: Row[];
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
      ...(options.placed === undefined ? [] : [PLACED]),
      ...include.map((name) => SECTION_SQL[name] as Statement),
    ],
    {
      today: options.today,
      week: options.week,
      since: options.since,
      machine: options.placed?.machine ?? null,
      roots: JSON.stringify(options.placed?.roots ?? []),
      bound: options.bound ?? null,
    },
  );
  const [space, order, autonomy, counts, inbox, ...rest] = results;
  const boundRow = options.bound === undefined ? undefined : rest.shift();
  const placed = options.placed === undefined ? [] : ((rest.shift() ?? []) as Row[]);
  const found = rest;
  const facts = spaceFacts(space);
  const byStatus = new Map(
    (counts as Row[]).map((row) => [String(row["status"]), Number(row["n"])] as const),
  );
  const keys = keysOf((order as Row | null)?.["value"], DEFAULT_STATUS_ORDER);
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
    autonomy: levelOf((autonomy as Row | null)?.["value"]),
    statuses: keys.map((status) => ({ status, count: byStatus.get(status) ?? 0 })),
    inbox: Number((inbox as Row | null)?.["n"] ?? 0),
    sections,
    placed,
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

// ---------------------------------------------------------------------------------------------
// A task to launch (A4 3.3, 3.15; `launch.open`)

const LAUNCH_PLACE: Statement = {
  sql:
    "SELECT id, root_id, rel_path, kind, identity FROM places WHERE owner_kind = 'task' " +
    `AND machine_id = $machine AND deleted_at IS NULL AND owner_id = ${MATCH}`,
  mode: "get",
};
/** A place of the task on another machine (A4 3.3 step 1: it opens there, never here). */
const PLACED_ELSEWHERE: Statement = {
  sql:
    "SELECT 1 AS elsewhere FROM places WHERE owner_kind = 'task' AND machine_id <> $machine " +
    `AND deleted_at IS NULL AND owner_id = ${MATCH} LIMIT 1`,
  mode: "get",
};

/** What a launch reads about a task, in one snapshot: the task, its place here, one elsewhere. */
export interface LaunchTaskRead {
  readonly space: SpaceFacts;
  readonly id: string;
  readonly ref: string;
  readonly title: string;
  readonly version: number;
  readonly place: {
    readonly id: string;
    readonly root: string;
    readonly path: string;
    readonly gitRemote?: string;
  } | null;
  readonly elsewhere: boolean;
}

/**
 * The task a launch names, as `readTask` resolves a reference: another space's prefix and a
 * deleted task are `not_found`. Its place on this machine (a file place resolves as no folder, so
 * a launch refuses it), and whether it has one on another machine.
 */
export async function readLaunchTask(
  reader: WorkerConnection,
  ref: string,
  machine: string,
): Promise<LaunchTaskRead> {
  const key = taskKey(ref);
  const params = { id: key.id, ref: key.ref, alias: key.alias, prefix: key.prefix, machine };
  const [space, alias, row, place, elsewhere] = await snapshot(
    reader,
    [SPACE, PREFIX_ALIAS, TASK, LAUNCH_PLACE, PLACED_ELSEWHERE],
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
  const here = place as Row | null;
  const remote = here === null ? undefined : remoteOfIdentity(here["identity"]);
  return {
    space: facts,
    id: String(task["id"]),
    ref: formatTaskRef(facts.refPrefix, Number(task["ref"])),
    title: String(task["title"]),
    version: Number(task["version"]),
    place:
      here === null
        ? null
        : {
            id: String(here["id"]),
            root: String(here["root_id"]),
            path: String(here["rel_path"]),
            ...(remote === undefined ? {} : { gitRemote: remote }),
          },
    elsewhere: elsewhere !== null && elsewhere !== undefined,
  };
}

/** The Git remote a place recorded in its `identity` (A1 3.15), if any. */
function remoteOfIdentity(identity: unknown): string | undefined {
  try {
    const parsed: unknown = typeof identity === "string" ? JSON.parse(identity) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const remote = (parsed as Record<string, unknown>)["git_remote"];
    return typeof remote === "string" ? remote : undefined;
  } catch {
    return undefined;
  }
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
