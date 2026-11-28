// The tree's search index: a document for every live task and project, note, page and page comment,
// kept current inside the commit that changes them, with what today's documents hold
// (search/documents.ts). Each document belongs to the node that holds it, so a search can keep to
// what lies under one node; the task facts a search filters on are read from that node.
//
//   task      title | brief, description, outcome | sources' words, the parent's title, reference
//   project   title | brief, description           | slug
//   note      what it is on, by title | body       | author label
//   page      title | brief, body                  | what holds it, by title, and its reference
//
// One function builds a node's documents from the current state and both paths use it: a commit
// re-derives the documents of the nodes its change rows name, and a rebuild derives every one. So
// the index after any history equals a fresh rebuild, which the history check of every tree test
// asserts.
import type { Connection, Row } from "../driver.ts";
import { misuse } from "../errors.ts";
import { formatTaskRef } from "../refs.ts";
import { lines, sourceWords } from "../search/documents.ts";
import type { ChangeRow } from "./tx.ts";

export interface TreeDocument {
  kind: "task" | "project" | "note" | "log" | "learning" | "page";
  entityId: string;
  nodeId: string;
  title: string;
  body: string;
  extra: string;
}

/** Who wrote note `e`, as the reads label it: an import, the user, else the actor. */
const AUTHOR =
  "CASE WHEN EXISTS (SELECT 1 FROM commits k WHERE k.seq = e.created_seq AND k.origin = 'import') " +
  "THEN 'import' WHEN x.kind = 'human' THEN 'user' ELSE x.label END";

const SQL = {
  prefix: "SELECT ref_prefix FROM space WHERE one = 1",
  lastSeq: "SELECT last_seq FROM space WHERE one = 1",
  node:
    "SELECT n.*, t.ref, t.outcome, p.kind AS parent_kind, p.title AS parent_title FROM nodes n " +
    "LEFT JOIN tasks t ON t.id = n.id LEFT JOIN nodes p ON p.id = n.parent_id WHERE n.id = $id",
  live: "SELECT id FROM nodes WHERE deleted_at IS NULL ORDER BY id",
  /** A node's sources: those it holds, and those its live links point at, as today's links. */
  sources:
    "SELECT title, who, outside_ref, source_key, url FROM sources s WHERE s.deleted_at IS NULL " +
    "AND (s.owner_id = $id OR EXISTS (SELECT 1 FROM links l WHERE l.owner_id = $id " +
    "AND l.target_id = s.id AND l.removed_at IS NULL)) ORDER BY s.ref",
  linkedTo: "SELECT owner_id AS id FROM links WHERE target_id = $id AND removed_at IS NULL",
  pages: "SELECT * FROM pages WHERE owner_id = $id AND deleted_at IS NULL ORDER BY ref",
  notes:
    `SELECT e.id, e.kind, e.body, ${AUTHOR} AS author FROM notes e ` +
    "JOIN actors x ON x.id = e.author_id WHERE e.owner_id = $id AND e.deleted_at IS NULL",
  childTasks: "SELECT id FROM nodes WHERE parent_id = $id AND kind = 'task'",
  stored:
    "SELECT d.doc, d.kind, d.entity_id, d.node_id, f.title, f.body, f.extra FROM search_docs d " +
    "LEFT JOIN search_fts f ON f.rowid = d.doc",
  storedOne: "WHERE d.entity_id = $id",
  storedOf: "WHERE d.node_id = $id",
  insertDoc:
    "INSERT INTO search_docs (kind, entity_id, node_id, seq) VALUES ($kind, $entity, $node, $seq) " +
    "RETURNING doc",
  updateDoc: "UPDATE search_docs SET kind = $kind, node_id = $node, seq = $seq WHERE doc = $doc",
  deleteDoc: "DELETE FROM search_docs WHERE doc = $doc",
  insertText:
    "INSERT INTO search_fts (rowid, title, body, extra) VALUES ($doc, $title, $body, $extra)",
  deleteText: "DELETE FROM search_fts WHERE rowid = $doc",
  strayText:
    "SELECT count(*) AS n FROM search_fts WHERE rowid NOT IN (SELECT doc FROM search_docs)",
  search:
    "SELECT d.kind, d.entity_id, d.node_id FROM search_fts f JOIN search_docs d ON d.doc = f.rowid " +
    "WHERE search_fts MATCH $match",
  under:
    "AND d.node_id IN (WITH RECURSIVE sub(id) AS (SELECT $under UNION ALL " +
    "SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub)",
  // Equal ranks are ordered by what they are, so a rebuild orders them as the commits did.
  ranked: "ORDER BY bm25(search_fts), d.entity_id LIMIT $limit",
} as const;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A note's document kind: a learning, an entry of the log, or a note. */
const noteKind = (kind: unknown): TreeDocument["kind"] =>
  kind === "learning" ? "learning" : kind === "note" ? "note" : "log";

function noteDocuments(conn: Connection, owner: string, node: string, title: string) {
  return conn
    .prepare(SQL.notes)
    .all({ id: owner })
    .map((row): TreeDocument => ({
      kind: noteKind(row["kind"]),
      entityId: str(row["id"]),
      nodeId: node,
      title,
      body: str(row["body"]),
      extra: str(row["author"]),
    }));
}

/** The documents a live node holds: its own (a routine's as a task's), its notes, and its pages with their comments. */
function nodeDocuments(conn: Connection, prefix: string, id: string): TreeDocument[] {
  const node = conn.prepare(SQL.node).get({ id });
  if (node === undefined || node["deleted_at"] !== null) return [];
  const title = str(node["title"]);
  const docs: TreeDocument[] = [];
  if (node["kind"] === "task" || node["kind"] === "routine") {
    const sources = conn.prepare(SQL.sources).all({ id });
    docs.push({
      kind: "task",
      entityId: id,
      nodeId: id,
      title,
      body: lines([node["brief"], node["description"], node["outcome"]]),
      extra: lines([
        ...sources.flatMap((s: Row) =>
          sourceWords({
            title: s["title"],
            who: s["who"],
            ref: s["outside_ref"],
            key: s["source_key"],
            url: s["url"],
          }),
        ),
        node["parent_kind"] === "space" ? null : node["parent_title"],
        formatTaskRef(prefix, Number(node["ref"])),
      ]),
    });
  } else if (node["kind"] === "project") {
    docs.push({
      kind: "project",
      entityId: id,
      nodeId: id,
      title,
      body: lines([node["brief"], node["description"]]),
      extra: str(node["slug"]),
    });
  }
  docs.push(...noteDocuments(conn, id, id, title));
  for (const page of conn.prepare(SQL.pages).all({ id })) {
    const pageId = str(page["id"]);
    const pageTitle = str(page["title"]);
    docs.push({
      kind: "page",
      entityId: pageId,
      nodeId: id,
      title: pageTitle,
      body: lines([page["brief"], page["body"]]),
      extra: lines([title, formatTaskRef(prefix, Number(page["ref"]))]),
    });
    docs.push(...noteDocuments(conn, pageId, id, pageTitle));
  }
  return docs;
}

const prefixOf = (conn: Connection): string => str(conn.prepare(SQL.prefix).get()?.["ref_prefix"]);

/** Every document the current state defines, by entity ID: what a rebuild writes. */
export function treeDocuments(conn: Connection): Map<string, TreeDocument> {
  const prefix = prefixOf(conn);
  const docs = conn
    .prepare(SQL.live)
    .all()
    .flatMap((row) => nodeDocuments(conn, prefix, str(row["id"])));
  return new Map(docs.map((doc) => [doc.entityId, doc]));
}

const storedDoc = (row: Row): TreeDocument => ({
  kind: row["kind"] as TreeDocument["kind"],
  entityId: str(row["entity_id"]),
  nodeId: str(row["node_id"]),
  title: str(row["title"]),
  body: str(row["body"]),
  extra: str(row["extra"]),
});

/** What the index holds, by entity ID, and the number of texts no document names. */
export function storedTreeDocuments(conn: Connection): {
  docs: Map<string, TreeDocument>;
  stray: number;
} {
  const docs = new Map(
    conn
      .prepare(SQL.stored)
      .all()
      .map((row) => [str(row["entity_id"]), storedDoc(row)] as const),
  );
  return { docs, stray: Number(conn.prepare(SQL.strayText).get()?.["n"] ?? 0) };
}

function insert(conn: Connection, seq: number, doc: TreeDocument): void {
  const number = conn
    .prepare(SQL.insertDoc)
    .get({ kind: doc.kind, entity: doc.entityId, node: doc.nodeId, seq })?.["doc"];
  if (typeof number !== "number") throw misuse("A search document got no number");
  conn
    .prepare(SQL.insertText)
    .run({ doc: number, title: doc.title, body: doc.body, extra: doc.extra });
}

/** Makes the stored document of `want.entityId` equal `want`, writing only what differs. */
function put(conn: Connection, seq: number, want: TreeDocument): void {
  const row = conn.prepare(`${SQL.stored} ${SQL.storedOne}`).get({ id: want.entityId });
  if (row === undefined) {
    insert(conn, seq, want);
    return;
  }
  const have = storedDoc(row);
  const doc = Number(row["doc"]);
  const sameText =
    have.title === want.title && have.body === want.body && have.extra === want.extra;
  if (sameText && have.kind === want.kind && have.nodeId === want.nodeId) return;
  if (!sameText) {
    conn.prepare(SQL.deleteText).run({ doc });
    conn
      .prepare(SQL.insertText)
      .run({ doc, title: want.title, body: want.body, extra: want.extra });
  }
  conn.prepare(SQL.updateDoc).run({ doc, kind: want.kind, node: want.nodeId, seq });
}

function remove(conn: Connection, doc: number): void {
  conn.prepare(SQL.deleteText).run({ doc });
  conn.prepare(SQL.deleteDoc).run({ doc });
}

/** The tables whose rows search documents show. */
const SHOWN: ReadonlySet<string> = new Set([
  "nodes",
  "tasks",
  "notes",
  "pages",
  "sources",
  "links",
]);

/**
 * Brings the documents a commit's change rows reach up to date, inside its transaction: those of
 * each node a change row names, of the node a page or a source left, of the tasks under a node
 * whose title changed, and of the nodes linked to a source that changed, which their documents
 * show.
 */
export function indexTreeChanges(conn: Connection, seq: number, changes: readonly ChangeRow[]) {
  if (!conn.inTransaction) throw misuse("The search index changes inside a write transaction");
  const nodes = new Set<string>();
  for (const change of changes) {
    if (!SHOWN.has(change.entity) || change.node === null) continue;
    nodes.add(change.node);
    if (change.field === "owner" && change.before !== null) {
      nodes.add(String(JSON.parse(change.before)));
    }
    if (change.entity === "nodes" && change.field === "title") {
      for (const row of conn.prepare(SQL.childTasks).all({ id: change.node })) {
        nodes.add(str(row["id"]));
      }
    }
    // A source's words show in the documents of the nodes that link to it too.
    if (change.entity === "sources") {
      for (const row of conn.prepare(SQL.linkedTo).all({ id: change.entityId })) {
        nodes.add(str(row["id"]));
      }
    }
  }
  if (nodes.size === 0) return;
  const prefix = prefixOf(conn);
  for (const node of nodes) {
    const want = nodeDocuments(conn, prefix, node);
    const kept = new Set(want.map((doc) => doc.entityId));
    for (const row of conn.prepare(`${SQL.stored} ${SQL.storedOf}`).all({ id: node })) {
      if (!kept.has(str(row["entity_id"]))) remove(conn, Number(row["doc"]));
    }
    for (const doc of want) put(conn, seq, doc);
  }
}

/** Empties the index and fills it from the current state, inside the caller's transaction. */
export function rebuildTreeIndex(conn: Connection): number {
  if (!conn.inTransaction) throw misuse("The search index is rebuilt inside a write transaction");
  const seq = Number(conn.prepare(SQL.lastSeq).get()?.["last_seq"]);
  conn.exec("DELETE FROM search_fts");
  conn.exec("DELETE FROM search_docs");
  const docs = treeDocuments(conn);
  for (const doc of docs.values()) insert(conn, seq, doc);
  return docs.size;
}

export interface TreeHit {
  kind: TreeDocument["kind"];
  entityId: string;
  nodeId: string;
}

/**
 * The documents an FTS5 expression matches, best first, within what lies under `under` when it is
 * given (a node in the Trash holds none). The caller builds the expression from what a person
 * typed; a malformed one throws SQLite's error.
 */
export function searchTree(
  conn: Connection,
  match: string,
  options: { under?: string; limit?: number } = {},
): TreeHit[] {
  const sql = [SQL.search, options.under === undefined ? "" : SQL.under, SQL.ranked].join(" ");
  return conn
    .prepare(sql)
    .all({
      match,
      limit: options.limit ?? 50,
      ...(options.under === undefined ? {} : { under: options.under }),
    })
    .map((row) => ({
      kind: row["kind"] as TreeDocument["kind"],
      entityId: str(row["entity_id"]),
      nodeId: str(row["node_id"]),
    }));
}
