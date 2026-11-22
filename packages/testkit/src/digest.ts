// A content digest of a space: SHA-256 over every row of every table in a defined order, the
// schema revision and application ID, and space.json. Two spaces with the same digest hold the
// same data, whatever their file bytes (page layout, free pages, WAL state) are.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasSearchTables,
  isSearchObject,
  MANIFEST_FILE,
  openSpace,
  type CheckedDriver,
  type Connection,
} from "@ttasks/storage";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const SEARCH_DOCUMENTS =
  "SELECT d.entity_id, d.kind, d.task_id, d.lifecycle, d.audience, f.title, f.body, f.extra " +
  "FROM search_docs d LEFT JOIN search_fts f ON f.rowid = d.doc ORDER BY d.entity_id";

/** A row value as digest text: JSON, with integers beyond 2^53 and blobs spelt out. */
function value(v: unknown): unknown {
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (v instanceof Uint8Array) return { $hex: Buffer.from(v).toString("hex") };
  return v;
}

/** The digest of the database behind `conn`: every table in name order, rows by primary key. */
export function digestDatabase(conn: Connection): string {
  const hash = createHash("sha256");
  const line = (data: unknown): void => {
    hash.update(`${JSON.stringify(data)}\n`, "utf8");
  };
  line({
    user_version: conn.pragma("user_version"),
    application_id: conn.pragma("application_id"),
  });
  const tables = conn
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all<{ name: string }>()
    .map((t) => t.name)
    .filter((name) => !isSearchObject(name, name));
  // The search index is derived, and a rebuild numbers its documents and lays out its segments
  // anew: what it holds is each document's facts and text, by entity.
  if (hasSearchTables(conn)) {
    line({ search: "documents" });
    for (const row of conn.prepare(SEARCH_DOCUMENTS).iterate()) line(Object.values(row));
  }
  for (const table of tables) {
    if (!IDENTIFIER.test(table)) throw new Error("A table name is not a plain identifier");
    const columns = conn
      .prepare("SELECT name, pk FROM pragma_table_info($t) ORDER BY cid")
      .all<{ name: string; pk: number }>({ t: table });
    const key = columns
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    const names = columns.map((c) => c.name);
    if (![...names, ...key].every((n) => IDENTIFIER.test(n))) {
      throw new Error("A column name is not a plain identifier");
    }
    line({ table, columns: names });
    const order = key.length > 0 ? key.join(", ") : "rowid";
    for (const row of conn.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
      line(names.map((n) => value(row[n])));
    }
  }
  return hash.digest("hex");
}

/**
 * The digest of the schema behind `conn`: every table, index and trigger with the SQL SQLite keeps
 * for it, in type and name order. digestDatabase sees tables and columns only, so this is what
 * pins an index, a CHECK or a foreign key. A virtual table's shadow tables are left out: their
 * text is the module's, not the steps'.
 */
export function digestSchema(conn: Connection): string {
  const hash = createHash("sha256");
  for (const row of conn
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' " +
        "AND name NOT IN (SELECT name FROM pragma_table_list WHERE schema = 'main' " +
        "AND type = 'shadow') ORDER BY type, name",
    )
    .iterate()) {
    hash.update(`${JSON.stringify([row["type"], row["name"], row["tbl_name"], row["sql"]])}\n`);
  }
  return hash.digest("hex");
}

/** The digest of a space folder: its database through a reader, and its space.json. */
export function digestSpace(checked: CheckedDriver, folder: string): string {
  const { conn } = openSpace(checked, folder, { role: "reader" });
  let rows: string;
  try {
    rows = digestDatabase(conn);
  } finally {
    conn.close();
  }
  const manifest = readFileSync(join(folder, MANIFEST_FILE), "utf8");
  return createHash("sha256").update(`${rows}\n${manifest}`, "utf8").digest("hex");
}
