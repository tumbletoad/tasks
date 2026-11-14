// Search documents (A1 3.12): what each document holds, the index kept current inside every commit,
// and the rebuild.
//
//   task              title | summary, context, outcome | source titles, who and ref, labels,
//                                                          project and area titles, its reference
//   note, log entry   owning task's title | body | author label
//   learning          owning task's title | body | project title
//   project, area     title | brief | slug
//
// A document exists for every live row: a tombstoned task has none, and neither have its notes,
// log entries and learnings, nor any deleted row. `lifecycle` is the owning task's (null for areas
// and projects) and `audience` the note's (`all` for everything else).
//
// One function builds a document from the current state, and both paths use it: the write path
// re-derives the documents a commit touched and writes only those whose content differs (a
// document that did not change keeps its row and its seq), and the rebuild derives every one. So
// the index after any history equals a fresh rebuild, which `[A1.5.search.index]` checks.
//
// Every statement is a constant of this module and every value is bound.
import type { Connection, Row } from "../driver.ts";
import { misuse } from "../errors.ts";
import { formatTaskRef } from "../refs.ts";
import { decodeSpaceRow } from "../rows.ts";
import { hasSearchTables, type SearchDocKind } from "./tables.ts";

/** One document as A1 3.12 defines it, without its `doc` number and `seq`. */
export interface SearchDocument {
  kind: SearchDocKind;
  entityId: string;
  taskId: string | null;
  lifecycle: string | null;
  audience: string;
  title: string;
  body: string;
  extra: string;
}

/** A change row of a commit, as far as the index needs it. */
export interface IndexedChange {
  entity: string;
  entityId: string;
  taskId: string | null;
  action: "create" | "set";
  field: string | null;
}

// ---------------------------------------------------------------------------------------------
// Statements

const TASK_DOC =
  "SELECT t.id, t.ref, t.title, t.summary, t.context, t.outcome, t.lifecycle, " +
  "a.title AS area_title, p.title AS project_title FROM tasks t " +
  "LEFT JOIN areas a ON a.id = t.area_id LEFT JOIN projects p ON p.id = t.project_id " +
  "WHERE t.deleted_at IS NULL";
const TASK_SOURCES =
  "SELECT ts.task_id, s.title, s.who, s.ref FROM task_sources ts " +
  "JOIN sources s ON s.id = ts.source_id WHERE ts.removed_at IS NULL AND s.deleted_at IS NULL";
const TASK_LABELS =
  "SELECT tl.task_id, l.title FROM task_labels tl JOIN labels l ON l.id = tl.label_id " +
  "WHERE tl.removed_at IS NULL AND l.deleted_at IS NULL";
/** Who wrote entry `e`, as the reads label it (A3 3.10): an import, the user, else the actor. */
const AUTHOR =
  "CASE WHEN EXISTS (SELECT 1 FROM commits k WHERE k.seq = e.created_seq AND k.origin = 'import') " +
  "THEN 'import' WHEN x.kind = 'human' THEN 'user' ELSE x.label END";
const ENTRY_DOC = (table: string, audience: string): string =>
  `SELECT e.id, e.task_id, e.body, ${audience} AS audience, t.title AS task_title, t.lifecycle, ` +
  `${AUTHOR} AS author FROM ${table} e JOIN tasks t ON t.id = e.task_id ` +
  "JOIN actors x ON x.id = e.author_id WHERE e.deleted_at IS NULL AND t.deleted_at IS NULL";
const NOTE_DOC = ENTRY_DOC("notes", "e.audience");
const LOG_DOC = ENTRY_DOC("log_entries", "'all'");
const LEARNING_DOC =
  "SELECT e.id, e.task_id, e.body, t.title AS task_title, t.lifecycle, p.title AS project_title " +
  "FROM learnings e JOIN tasks t ON t.id = e.task_id LEFT JOIN projects p ON p.id = t.project_id " +
  "WHERE e.deleted_at IS NULL AND t.deleted_at IS NULL";
const GROUP_DOC = (table: string): string =>
  `SELECT id, title, brief, slug FROM ${table} WHERE deleted_at IS NULL`;

const SQL = {
  space: "SELECT * FROM space WHERE one = 1",
  allTasks: `${TASK_DOC} ORDER BY t.id`,
  oneTask: `${TASK_DOC} AND t.id = $id`,
  allSources: `${TASK_SOURCES} ORDER BY ts.task_id, ts.position, s.id`,
  taskSources: `${TASK_SOURCES} AND ts.task_id = $id ORDER BY ts.position, s.id`,
  allLabels: `${TASK_LABELS} ORDER BY tl.task_id, l.slug, l.id`,
  taskLabels: `${TASK_LABELS} AND tl.task_id = $id ORDER BY l.slug, l.id`,
  allNotes: `${NOTE_DOC} ORDER BY e.id`,
  oneNote: `${NOTE_DOC} AND e.id = $id`,
  taskNotes: `${NOTE_DOC} AND e.task_id = $id`,
  allLogs: `${LOG_DOC} ORDER BY e.id`,
  oneLog: `${LOG_DOC} AND e.id = $id`,
  taskLogs: `${LOG_DOC} AND e.task_id = $id`,
  allLearnings: `${LEARNING_DOC} ORDER BY e.id`,
  oneLearning: `${LEARNING_DOC} AND e.id = $id`,
  taskLearnings: `${LEARNING_DOC} AND e.task_id = $id`,
  allAreas: `${GROUP_DOC("areas")} ORDER BY id`,
  oneArea: `${GROUP_DOC("areas")} AND id = $id`,
  allProjects: `${GROUP_DOC("projects")} ORDER BY id`,
  oneProject: `${GROUP_DOC("projects")} AND id = $id`,
  // The index side.
  stored:
    "SELECT d.doc, d.kind, d.entity_id, d.task_id, d.lifecycle, d.audience, f.title, f.body, " +
    "f.extra FROM search_docs d LEFT JOIN search_fts f ON f.rowid = d.doc WHERE d.entity_id = $id",
  storedChildren:
    "SELECT entity_id FROM search_docs WHERE task_id = $id AND kind IN ('note', 'log', 'learning')",
  allStored:
    "SELECT d.doc, d.kind, d.entity_id, d.task_id, d.lifecycle, d.audience, f.title, f.body, " +
    "f.extra FROM search_docs d LEFT JOIN search_fts f ON f.rowid = d.doc ORDER BY d.entity_id",
  strayText:
    "SELECT count(*) AS n FROM search_fts WHERE rowid NOT IN (SELECT doc FROM search_docs)",
  insertDoc:
    "INSERT INTO search_docs (kind, entity_id, task_id, lifecycle, audience, seq) " +
    "VALUES ($kind, $entity, $task, $lifecycle, $audience, $seq) RETURNING doc",
  updateDoc:
    "UPDATE search_docs SET kind = $kind, task_id = $task, lifecycle = $lifecycle, " +
    "audience = $audience, seq = $seq WHERE doc = $doc",
  deleteDoc: "DELETE FROM search_docs WHERE doc = $doc",
  insertText:
    "INSERT INTO search_fts (rowid, title, body, extra) VALUES ($doc, $title, $body, $extra)",
  deleteText: "DELETE FROM search_fts WHERE rowid = $doc",
  clearDocs: "DELETE FROM search_docs",
  clearText: "DELETE FROM search_fts",
  // Whose documents a change to a shared row reaches.
  tasksOfSource: "SELECT DISTINCT task_id FROM task_sources WHERE source_id = $id",
  tasksOfLabel: "SELECT DISTINCT task_id FROM task_labels WHERE label_id = $id",
  tasksOfArea: "SELECT id AS task_id FROM tasks WHERE area_id = $id",
  tasksOfProject: "SELECT id AS task_id FROM tasks WHERE project_id = $id",
} as const;

// ---------------------------------------------------------------------------------------------
// Documents from rows

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const opt = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The non-empty texts, one per line. */
const lines = (values: readonly unknown[]): string =>
  values.filter((v): v is string => typeof v === "string" && v !== "").join("\n");

function taskDocument(
  row: Row,
  prefix: string,
  sources: readonly Row[],
  labels: readonly Row[],
): SearchDocument {
  const id = str(row["id"]);
  return {
    kind: "task",
    entityId: id,
    taskId: id,
    lifecycle: opt(row["lifecycle"]),
    audience: "all",
    title: str(row["title"]),
    body: lines([row["summary"], row["context"], row["outcome"]]),
    extra: lines([
      ...sources.flatMap((s) => [s["title"], s["who"], s["ref"]]),
      ...labels.map((l) => l["title"]),
      row["project_title"],
      row["area_title"],
      formatTaskRef(prefix, Number(row["ref"])),
    ]),
  };
}

function entryDocument(kind: "note" | "log", row: Row): SearchDocument {
  return {
    kind,
    entityId: str(row["id"]),
    taskId: str(row["task_id"]),
    lifecycle: opt(row["lifecycle"]),
    audience: str(row["audience"]),
    title: str(row["task_title"]),
    body: str(row["body"]),
    extra: str(row["author"]),
  };
}

function learningDocument(row: Row): SearchDocument {
  return {
    kind: "learning",
    entityId: str(row["id"]),
    taskId: str(row["task_id"]),
    lifecycle: opt(row["lifecycle"]),
    audience: "all",
    title: str(row["task_title"]),
    body: str(row["body"]),
    extra: str(row["project_title"]),
  };
}

function groupDocument(kind: "area" | "project", row: Row): SearchDocument {
  return {
    kind,
    entityId: str(row["id"]),
    taskId: null,
    lifecycle: null,
    audience: "all",
    title: str(row["title"]),
    body: str(row["brief"]),
    extra: str(row["slug"]),
  };
}

function refPrefix(conn: Connection): string {
  return decodeSpaceRow(conn.prepare(SQL.space).get()).refPrefix;
}

/** Rows grouped by their `task_id`. */
function byTask(rows: readonly Row[]): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const key = str(row["task_id"]);
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [row]);
    else list.push(row);
  }
  return grouped;
}

/** Every document the current state defines, by entity ID: what a rebuild writes. */
export function expectedDocuments(conn: Connection): Map<string, SearchDocument> {
  const prefix = refPrefix(conn);
  const sources = byTask(conn.prepare(SQL.allSources).all());
  const labels = byTask(conn.prepare(SQL.allLabels).all());
  const docs: SearchDocument[] = [
    ...conn
      .prepare(SQL.allTasks)
      .all()
      .map((row) => {
        const id = str(row["id"]);
        return taskDocument(row, prefix, sources.get(id) ?? [], labels.get(id) ?? []);
      }),
    ...conn
      .prepare(SQL.allNotes)
      .all()
      .map((row) => entryDocument("note", row)),
    ...conn
      .prepare(SQL.allLogs)
      .all()
      .map((row) => entryDocument("log", row)),
    ...conn.prepare(SQL.allLearnings).all().map(learningDocument),
    ...conn
      .prepare(SQL.allAreas)
      .all()
      .map((row) => groupDocument("area", row)),
    ...conn
      .prepare(SQL.allProjects)
      .all()
      .map((row) => groupDocument("project", row)),
  ];
  return new Map(docs.map((doc) => [doc.entityId, doc]));
}

/** The document of one task, or undefined when the task has none (tombstoned or gone). */
function oneTaskDocument(conn: Connection, prefix: string, id: string): SearchDocument | undefined {
  const row = conn.prepare(SQL.oneTask).get({ id });
  if (row === undefined) return undefined;
  return taskDocument(
    row,
    prefix,
    conn.prepare(SQL.taskSources).all({ id }),
    conn.prepare(SQL.taskLabels).all({ id }),
  );
}

/** The documents of a task's notes, log entries and learnings, by entity ID. */
function childDocuments(conn: Connection, id: string): Map<string, SearchDocument> {
  const docs = [
    ...conn
      .prepare(SQL.taskNotes)
      .all({ id })
      .map((row) => entryDocument("note", row)),
    ...conn
      .prepare(SQL.taskLogs)
      .all({ id })
      .map((row) => entryDocument("log", row)),
    ...conn.prepare(SQL.taskLearnings).all({ id }).map(learningDocument),
  ];
  return new Map(docs.map((doc) => [doc.entityId, doc]));
}

/** The document of one entity that is not a task, or undefined when it has none. */
function oneDocument(
  conn: Connection,
  kind: "note" | "log" | "learning" | "area" | "project",
  id: string,
): SearchDocument | undefined {
  switch (kind) {
    case "note": {
      const row = conn.prepare(SQL.oneNote).get({ id });
      return row === undefined ? undefined : entryDocument("note", row);
    }
    case "log": {
      const row = conn.prepare(SQL.oneLog).get({ id });
      return row === undefined ? undefined : entryDocument("log", row);
    }
    case "learning": {
      const row = conn.prepare(SQL.oneLearning).get({ id });
      return row === undefined ? undefined : learningDocument(row);
    }
    case "area":
    case "project": {
      const row = conn.prepare(kind === "area" ? SQL.oneArea : SQL.oneProject).get({ id });
      return row === undefined ? undefined : groupDocument(kind, row);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Writing documents

/** A stored document, as `storedDocuments` returns it. */
export interface StoredDocument extends SearchDocument {
  doc: number;
}

function stored(row: Row): StoredDocument {
  return {
    doc: Number(row["doc"]),
    kind: row["kind"] as SearchDocKind,
    entityId: str(row["entity_id"]),
    taskId: opt(row["task_id"]),
    lifecycle: opt(row["lifecycle"]),
    audience: str(row["audience"]),
    title: str(row["title"]),
    body: str(row["body"]),
    extra: str(row["extra"]),
  };
}

const sameText = (a: SearchDocument, b: SearchDocument): boolean =>
  a.title === b.title && a.body === b.body && a.extra === b.extra;

const sameFacts = (a: SearchDocument, b: SearchDocument): boolean =>
  a.kind === b.kind &&
  a.taskId === b.taskId &&
  a.lifecycle === b.lifecycle &&
  a.audience === b.audience;

function insertDocument(conn: Connection, seq: number, doc: SearchDocument): void {
  const row = conn.prepare(SQL.insertDoc).get({
    kind: doc.kind,
    entity: doc.entityId,
    task: doc.taskId,
    lifecycle: doc.lifecycle,
    audience: doc.audience,
    seq,
  });
  const number = row?.["doc"];
  if (typeof number !== "number") throw misuse("A search document got no number");
  conn
    .prepare(SQL.insertText)
    .run({ doc: number, title: doc.title, body: doc.body, extra: doc.extra });
}

/**
 * Makes the stored document of `entityId` equal `want`: removed when `want` is undefined, added
 * when there is none, and otherwise rewritten only where it differs. The FTS row keeps the
 * document's number, so `doc` stays the FTS rowid.
 */
function putDocument(
  conn: Connection,
  seq: number,
  entityId: string,
  want: SearchDocument | undefined,
): void {
  const row = conn.prepare(SQL.stored).get({ id: entityId });
  const have = row === undefined ? undefined : stored(row);
  if (have === undefined) {
    if (want !== undefined) insertDocument(conn, seq, want);
    return;
  }
  if (want === undefined) {
    conn.prepare(SQL.deleteText).run({ doc: have.doc });
    conn.prepare(SQL.deleteDoc).run({ doc: have.doc });
    return;
  }
  const textSame = sameText(have, want);
  if (textSame && sameFacts(have, want)) return;
  if (!textSame) {
    conn.prepare(SQL.deleteText).run({ doc: have.doc });
    conn
      .prepare(SQL.insertText)
      .run({ doc: have.doc, title: want.title, body: want.body, extra: want.extra });
  }
  conn.prepare(SQL.updateDoc).run({
    doc: have.doc,
    kind: want.kind,
    task: want.taskId,
    lifecycle: want.lifecycle,
    audience: want.audience,
    seq,
  });
}

/**
 * The task fields only a task's own document shows, and those its children's documents show too:
 * every child shows the task's title and lifecycle and leaves with its tombstone, and a learning
 * shows the task's project title (LEARNING_DOC), so a move reaches the learnings.
 */
const TASK_DOC_FIELDS = new Set(["summary", "context", "wrap"]);
const TASK_WIDE_FIELDS = new Set(["title", "lifecycle", "deleted", "grouping"]);

const ENTRY_KINDS: Readonly<Record<string, "note" | "log" | "learning" | undefined>> = {
  notes: "note",
  log_entries: "log",
  learnings: "learning",
};

/**
 * Brings the documents a commit's changes reach up to date, inside the commit's transaction
 * (A1 3.12: "the write handlers delete and re-insert each affected document in the write
 * transaction"). A task's title, lifecycle or tombstone reaches its notes, log entries and
 * learnings too; a source, label, area or project reaches the tasks that show it.
 */
export function indexChanges(conn: Connection, seq: number, changes: readonly IndexedChange[]) {
  if (!conn.inTransaction) throw misuse("The search index changes inside a write transaction");
  /** Task IDs, with whether their children's documents need it too. */
  const tasks = new Map<string, boolean>();
  const mark = (id: string | null, wide: boolean): void => {
    if (id === null || id === "") return;
    tasks.set(id, (tasks.get(id) ?? false) || wide);
  };
  const markAll = (sql: string, id: string, wide: boolean): void => {
    for (const row of conn.prepare(sql).all({ id })) mark(str(row["task_id"]), wide);
  };
  const others = new Map<string, "note" | "log" | "learning" | "area" | "project">();
  for (const change of changes) {
    const entry = ENTRY_KINDS[change.entity];
    if (entry !== undefined) {
      others.set(change.entityId, entry);
      continue;
    }
    switch (change.entity) {
      case "tasks":
        if (change.action === "create" || TASK_WIDE_FIELDS.has(change.field ?? "")) {
          mark(change.entityId, true);
        } else if (TASK_DOC_FIELDS.has(change.field ?? "")) mark(change.entityId, false);
        break;
      case "task_sources":
      case "task_labels":
        mark(change.taskId, false);
        break;
      // A new source, label, area or project is shown by no task yet: the links and tasks its commit
      // adds have change rows of their own, so only a change to an existing one reads its tasks.
      case "sources":
        if (change.action === "create") mark(change.taskId, false);
        else markAll(SQL.tasksOfSource, change.entityId, false);
        break;
      case "labels":
        if (change.action !== "create") markAll(SQL.tasksOfLabel, change.entityId, false);
        break;
      case "areas":
        others.set(change.entityId, "area");
        if (change.action !== "create") markAll(SQL.tasksOfArea, change.entityId, false);
        break;
      case "projects":
        // A learning shows its task's project title.
        others.set(change.entityId, "project");
        if (change.action !== "create") markAll(SQL.tasksOfProject, change.entityId, true);
        break;
      default:
        // Places, launches, machines, preferences, proposals and exchanges hold no search text.
        break;
    }
  }
  if (tasks.size === 0 && others.size === 0) return;
  const prefix = refPrefix(conn);
  for (const [id, wide] of tasks) {
    putDocument(conn, seq, id, oneTaskDocument(conn, prefix, id));
    if (!wide) continue;
    const children = childDocuments(conn, id);
    const ids = new Set([
      ...children.keys(),
      ...conn
        .prepare(SQL.storedChildren)
        .all({ id })
        .map((row) => str(row["entity_id"])),
    ]);
    for (const child of ids) {
      putDocument(conn, seq, child, children.get(child));
      others.delete(child);
    }
  }
  for (const [id, kind] of others) putDocument(conn, seq, id, oneDocument(conn, kind, id));
}

/**
 * Empties both search tables and fills them from the current state, inside the caller's write
 * transaction: `tasks index rebuild`, and the schema step that adds the tables. Every document
 * gets the space's last seq. Returns the number of documents.
 */
export function rebuildSearchIndex(conn: Connection): number {
  if (!conn.inTransaction) throw misuse("The search index is rebuilt inside a write transaction");
  if (!hasSearchTables(conn)) throw misuse("This space has no search tables to rebuild");
  const seq = decodeSpaceRow(conn.prepare(SQL.space).get()).lastSeq;
  conn.prepare(SQL.clearText).run();
  conn.prepare(SQL.clearDocs).run();
  const docs = expectedDocuments(conn);
  for (const doc of docs.values()) insertDocument(conn, seq, doc);
  return docs.size;
}

/**
 * What the index holds, by entity ID, and the number of FTS rows no `search_docs` row names. A
 * check compares it with `expectedDocuments`: equal maps and no stray text mean the index equals a
 * fresh rebuild, document numbers and seqs aside.
 */
export function storedDocuments(conn: Connection): {
  docs: Map<string, StoredDocument>;
  stray: number;
} {
  const docs = new Map(
    conn
      .prepare(SQL.allStored)
      .all()
      .map((row) => {
        const doc = stored(row);
        return [doc.entityId, doc] as const;
      }),
  );
  const stray = Number(conn.prepare(SQL.strayText).get()?.["n"] ?? 0);
  return { docs, stray };
}
