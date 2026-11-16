// The search index tables: one FTS5 table with its own copy of each document's text, and
// `search_docs`, which maps each document to its entity, owning task, lifecycle and audience.
// Schema 0.4 creates them (migrations/0004-schema-0.4.ts).
//
// They are DERIVED: everything in them is rebuilt from the tasks and their text
// (documents.ts rebuildSearchIndex). So a copy of a space is never judged by them. The exact-schema
// rule leaves them out of its comparison, a sidecar's and a bundle's row counts leave them out, and
// a restore or an export drops whatever stands under their names and makes them again from the
// schema steps' own definitions (remake.ts), never from text read out of the copy.
import type { Connection } from "../driver.ts";

/** The document kinds of `search_docs.kind`. */
export const SEARCH_DOC_KINDS = ["task", "note", "log", "learning", "project", "area"] as const;
export type SearchDocKind = (typeof SEARCH_DOC_KINDS)[number];

/** The FTS5 table. FTS5 names its shadow tables after it. */
export const SEARCH_FTS = "search_fts";

/** The suffixes of the shadow tables FTS5 makes for a table with stored content. */
const FTS5_SHADOWS = ["data", "idx", "content", "docsize", "config"] as const;

/** Every table name the search index uses: its two tables and the FTS5 shadow tables. */
export const SEARCH_TABLE_NAMES: ReadonlySet<string> = new Set([
  "search_docs",
  SEARCH_FTS,
  ...FTS5_SHADOWS.map((suffix) => `${SEARCH_FTS}_${suffix}`),
]);

/**
 * Whether a schema object belongs to the search index: it has one of the index's table names, or
 * it is on one of those tables (an index, SQLite's key index). Whatever its type and definition:
 * an object under these names is dropped and made again before any write.
 */
export function isSearchObject(name: unknown, table: unknown): boolean {
  return (
    (typeof name === "string" && SEARCH_TABLE_NAMES.has(name)) ||
    (typeof table === "string" && SEARCH_TABLE_NAMES.has(table))
  );
}

/** Finds both search tables in the main schema; the FTS table is a virtual `table` row. */
export const HAS_SEARCH_TABLES_SQL =
  "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' " +
  "AND name IN ('search_docs', 'search_fts')";

/** Whether the space's schema holds the search tables. */
export function hasSearchTables(conn: Connection): boolean {
  return conn.prepare(HAS_SEARCH_TABLES_SQL).get<{ n: number }>()?.n === 2;
}
