// Making the search index of a database again: what a restore does before its first write, an
// export to its private snapshot, a backup to a copy whose index fails its check, and a writer's
// open to a space whose index is damaged. The index is derived (tables.ts), so the copy's own index
// is never kept or judged: whatever stands under its names is dropped, the tables are made again
// from the statements the schema steps use at the copy's revision, and they are filled from the
// copy's tasks (documents.ts rebuildSearchIndex). A copy at a revision before the index gets none.
// A writer's open brings a sound index's documents up to date instead (repairSearchIndex).
import type { Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { removeQuietly } from "../files.ts";
import { openWriter } from "../open.ts";
import { inRange } from "../rows.ts";
import type { SchemaStep } from "../schema.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { ALL_OBJECTS, referenceSearch } from "../backup/snapshot.ts";
import { rebuildSearchIndex, refreshSearchIndex } from "./documents.ts";
import { hasSearchTables, isSearchObject, SEARCH_FTS } from "./tables.ts";

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
 * Whether the search index on `conn`, a writable connection, holds together: FTS5's own check of
 * its index against its text, and one text for each document and no other. A check that fails to
 * run counts as damage too. It changes nothing.
 */
export function searchIndexSound(conn: Connection): boolean {
  try {
    conn.exec(`INSERT INTO ${SEARCH_FTS}(${SEARCH_FTS}) VALUES ('integrity-check')`);
    const row = conn
      .prepare(
        "SELECT (SELECT count(*) FROM search_docs) AS docs, " +
          `(SELECT count(*) FROM ${SEARCH_FTS}_docsize) AS texts, ` +
          `(SELECT count(*) FROM search_docs d LEFT JOIN ${SEARCH_FTS}_docsize z ` +
          "ON z.id = d.doc WHERE z.id IS NULL) AS bare",
      )
      .get();
    return row?.["docs"] === row?.["texts"] && row?.["bare"] === 0;
  } catch {
    return false;
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

/**
 * Checks the search index of a space on its writer's connection. A sound index gets the documents
 * this build defines where they differ (refreshSearchIndex); a damaged one is made again. Each in
 * a transaction of its own. The tasks are not touched either way, and a remake that fails leaves
 * the space as it was: `damaged`, with search failing until the next try.
 */
export function repairSearchIndex(
  checked: CheckedDriver,
  conn: Connection,
  steps: readonly SchemaStep[],
): "sound" | "remade" | "damaged" {
  if (!hasSearchTables(conn)) return "sound";
  if (searchIndexSound(conn)) {
    try {
      const written = conn.transaction("immediate", () => refreshSearchIndex(conn));
      return written === 0 ? "sound" : "remade";
    } catch {
      // An index that takes no writes is no longer one to trust: it is made again.
    }
  }
  try {
    conn.transaction("immediate", () => {
      remakeSearchIndex(checked, conn, steps);
    });
  } catch {
    return "damaged";
  }
  return searchIndexSound(conn) ? "remade" : "damaged";
}

/**
 * Makes the search index of the database file `path` again (remakeSearchIndex). The file must be a
 * private copy: nothing else may have it open.
 */
export function remakeCopyIndex(
  checked: CheckedDriver,
  path: string,
  busyTimeoutMs: number | undefined,
  steps: readonly SchemaStep[],
): void {
  const conn = openWriter(checked, path, busyTimeoutMs === undefined ? {} : { busyTimeoutMs });
  try {
    conn.transaction("immediate", () => {
      remakeSearchIndex(checked, conn, steps);
    });
  } finally {
    conn.close();
    removeQuietly(`${path}-wal`);
    removeQuietly(`${path}-shm`);
  }
}
