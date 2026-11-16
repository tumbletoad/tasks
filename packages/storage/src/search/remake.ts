// Making the search index of a copied database again: what a restore does before its first write,
// and an export to its private snapshot. The index is derived (tables.ts), so the copy's own index
// is never kept or judged: whatever stands under its names is dropped, the tables are made again
// from the statements the schema steps use at the copy's revision, and they are filled from the
// copy's tasks (documents.ts rebuildSearchIndex). A copy at a revision before the index gets none.
import type { Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { inRange } from "../rows.ts";
import type { SchemaStep } from "../schema.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { ALL_OBJECTS, referenceSearch } from "../backup/snapshot.ts";
import { rebuildSearchIndex } from "./documents.ts";
import { hasSearchTables, isSearchObject } from "./tables.ts";

interface ObjectRow {
  type: unknown;
  name: unknown;
  tbl_name: unknown;
  sql: unknown;
}

const quoted = (name: unknown): string => `"${String(name).replaceAll('"', '""')}"`;

/**
 * Drops every object under the search index's names, inside the caller's write transaction.
 * Triggers are not among them: dropUnchecked (restore/mark.ts) drops every trigger first.
 */
function dropSearchObjects(conn: Connection): void {
  const present = (): ObjectRow[] =>
    conn
      .prepare(ALL_OBJECTS)
      .all<ObjectRow>()
      .filter((row) => row.type !== "trigger" && isSearchObject(row.name, row.tbl_name));
  // A virtual table first: its module drops its own shadow tables, which SQLite may refuse to drop
  // one by one while the virtual table exists.
  for (const row of present()) {
    if (row.type === "table" && /^CREATE VIRTUAL TABLE/iu.test(String(row.sql))) {
      conn.exec(`DROP TABLE ${quoted(row.name)}`);
    }
  }
  for (const row of present()) {
    if (row.type === "table") conn.exec(`DROP TABLE ${quoted(row.name)}`);
    else if (row.type === "view") conn.exec(`DROP VIEW ${quoted(row.name)}`);
  }
  for (const row of present()) {
    if (row.type === "index") conn.exec(`DROP INDEX ${quoted(row.name)}`);
  }
  if (present().length > 0) {
    throw new StorageError("SPACE_SCHEMA_FOREIGN", "The search index could not be made again");
  }
}

/**
 * Drops the search index of the database on `conn` and makes it again for its revision, filled
 * from its tasks, inside the caller's write transaction. Returns the number of documents.
 */
export function remakeSearchIndex(
  checked: CheckedDriver,
  conn: Connection,
  steps: readonly SchemaStep[],
): number {
  const userVersion = conn.pragma("user_version");
  const statements = inRange(userVersion, "count")
    ? referenceSearch(checked, steps, userVersion)
    : undefined;
  if (statements === undefined) {
    throw new StorageError("SPACE_VERSION_UNKNOWN", "The database's schema revision is unknown");
  }
  dropSearchObjects(conn);
  for (const statement of statements) conn.exec(statement);
  return hasSearchTables(conn) ? rebuildSearchIndex(conn) : 0;
}
