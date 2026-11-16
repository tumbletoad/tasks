// Schema 0.4: the search index. Creating a space runs 0001 to 0003 and then this step, and the
// migration runner runs it on an older space behind its verified barrier backup, in the one
// transaction of every pending step, so a migrated space and a new one have the same schema.
//
// The step creates tables and indexes only, and changes no row of any other table. The two search
// tables are derived from the tasks and their text: the runner fills them after the last step of
// every migration (migrate/runner.ts), with this build's documents on this build's schema, so the
// statements below stay frozen while what a document holds may change. A restore drops and
// rebuilds them, and the exact-schema rule leaves them out (search/tables.ts isSearchObject).
//
// Each statement runs on its own, in order, inside the caller's transaction. A failure at any of
// them rolls the whole migration back and leaves the space at its old revision.
import type { Connection } from "../src/driver.ts";
import { misuse } from "../src/errors.ts";
import type { SchemaStep } from "../src/schema.ts";
import { step0003 } from "./0003-schema-0.3.ts";

/** The tables schema 0.4 adds: `search_fts` is an FTS5 virtual table with its shadow tables. */
export const TABLES_0_4_NEW = ["search_docs", "search_fts"] as const;

const TABLES = [...step0003.tables, ...TABLES_0_4_NEW] as const;

/**
 * The step's statements, in the order they run, one per entry. Tests inject a fault before each
 * of them, so every entry is exactly one SQL statement.
 */
export const SCHEMA_0_4_STATEMENTS: readonly string[] = [
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
  // A change to an existing source, area or project re-indexes the tasks that show it, inside the
  // commit: these find them without a scan (labels have `task_labels_label` since 0.2).
  "CREATE INDEX task_sources_source ON task_sources(source_id)",
  "CREATE INDEX tasks_area ON tasks(area_id)",
  "CREATE INDEX tasks_project ON tasks(project_id)",
];

/** The tables of the main schema by SQLite's kind: `table`, `virtual` or `shadow`. */
function tablesByKind(conn: Connection): Map<string, { type: string; strict: boolean }> {
  const rows = conn
    .prepare(
      "SELECT name, type, strict FROM pragma_table_list " +
        "WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'",
    )
    .all<{ name: string; type: string; strict: number }>();
  return new Map(rows.map((row) => [row.name, { type: row.type, strict: row.strict === 1 }]));
}

export const step0004: SchemaStep = {
  id: 4,
  from: 3,
  revision: { major: 0, minor: 4 },
  // Only new tables and indexes: nothing an older reader reads changes.
  kind: "additive",
  format: { major: 0, minor: 4 },
  // A 0.3 build reads a 0.4 space (it reads neither new table) and never writes it: an older build
  // refuses a newer revision as a writer whatever space.json says. No release version exists yet
  // to name as the floor, so both stay 0.0.0, as 0.2's and 0.3's do.
  minReader: "0.0.0",
  minWriter: "0.0.0",
  undoFloor: false,
  tables: TABLES,
  up(conn) {
    for (const statement of SCHEMA_0_4_STATEMENTS) conn.exec(statement);
  },
  verify(conn) {
    const found = tablesByKind(conn);
    const plain = [...found].filter(([, t]) => t.type === "table");
    const expected = new Set<string>(TABLES.filter((name) => name !== "search_fts"));
    if (
      plain.length !== expected.size ||
      plain.some(([name, t]) => !expected.has(name) || !t.strict) ||
      found.get("search_fts")?.type !== "virtual"
    ) {
      throw misuse("Schema 0.4 did not produce its tables");
    }
  },
};
