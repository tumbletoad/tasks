// The search index tables (A1 3.12): one FTS5 table with its own copy of each document's text,
// and `search_docs`, which maps each document to its entity, owning task, lifecycle and audience.
//
// Released schemas are frozen and 0.2 does not hold these tables: A1 3.4 places them in a later
// schema step. That step runs SEARCH_TABLE_STATEMENTS and then rebuildSearchIndex (documents.ts)
// in its `up`, so a migrated space starts with a complete index. Until a space has them, the
// writer keeps no index (hasSearchTables) and search answers text queries with its own refusal.
import type { Connection } from "../driver.ts";

/** The statements that create the search tables, one SQL statement per entry, in order. */
export const SEARCH_TABLE_STATEMENTS: readonly string[] = [
  // `doc` is an explicit rowid alias, stable across VACUUM, and the FTS rowid of the document.
  `CREATE TABLE search_docs (
  doc       INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('task','note','log','learning','project','area')),
  entity_id TEXT NOT NULL UNIQUE,
  task_id   TEXT,
  lifecycle TEXT,
  audience  TEXT NOT NULL DEFAULT 'all',
  seq       INTEGER NOT NULL
) STRICT`,
  "CREATE INDEX search_docs_task ON search_docs(task_id)",
  "CREATE VIRTUAL TABLE search_fts USING fts5(title, body, extra, " +
    "tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')",
];

/** The document kinds of `search_docs.kind`. */
export const SEARCH_DOC_KINDS = ["task", "note", "log", "learning", "project", "area"] as const;
export type SearchDocKind = (typeof SEARCH_DOC_KINDS)[number];

/** Finds both search tables in the main schema; the FTS table is a virtual `table` row. */
export const HAS_SEARCH_TABLES_SQL =
  "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' " +
  "AND name IN ('search_docs', 'search_fts')";

/** Whether the space's schema holds the search tables. */
export function hasSearchTables(conn: Connection): boolean {
  return conn.prepare(HAS_SEARCH_TABLES_SQL).get<{ n: number }>()?.n === 2;
}
