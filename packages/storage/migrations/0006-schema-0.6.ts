// Schema 0.6: knowledge pages, and the texts every task below a node inherits. Creating a space runs
// 0001 to 0005 and then this step, and the migration runner runs it on an older space behind its
// verified barrier backup, in the one transaction of every pending step.
//
// The step changes no row of any other table, and alters none: an area's and a project's brief
// stay in their rows, written as before.
// - `pages`: Markdown knowledge on the space, an area, a project or a task. A page's `ref` comes
//   from the space's one counter (`space.next_ref`), as a task's, so a reference names a task or a
//   page, never both. A page in the Trash keeps its row, and every version is in `changes`.
// - `node_texts`: one row per node that has a text, made on its first write: a description on the
//   space, an area or a project, the space's own brief, and the person's text for agents there.
//   The row is keyed by its node's ID, which is its change rows' entity ID.
// - The search index is derived, so its two tables are dropped and made again with `page` among
//   the document kinds; the runner fills them after the last step.
//
// Each statement runs on its own, in order, inside the caller's transaction. A failure at any of
// them rolls the whole migration back and leaves the space at its old revision.
import type { Connection } from "../src/driver.ts";
import { misuse } from "../src/errors.ts";
import type { SchemaStep } from "../src/schema.ts";
import { step0005 } from "./0005-schema-0.5.ts";

/** The tables schema 0.6 adds. */
export const TABLES_0_6_NEW = ["pages", "node_texts"] as const;

const TABLES = [...step0005.tables, ...TABLES_0_6_NEW] as const;

/**
 * The step's statements, in the order they run, one per entry. Tests inject a fault before each
 * of them, so every entry is exactly one SQL statement.
 */
export const SCHEMA_0_6_STATEMENTS: readonly string[] = [
  // A person may give a page a title only; an agent gives a brief on every page it makes.
  `CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  ref INTEGER NOT NULL UNIQUE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('space','area','project','task')),
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300 AND instr(title, char(10)) = 0),
  brief TEXT NOT NULL DEFAULT '' CHECK (length(brief) <= 400 AND instr(brief, char(10)) = 0),
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES actors(id),
  deleted_at INTEGER, deleted_by TEXT REFERENCES actors(id),
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT`,
  // A node's live pages, for its Library and every trail through it.
  "CREATE INDEX pages_owner ON pages(owner_id) WHERE deleted_at IS NULL",
  // `brief` is the space's alone: an area's and a project's brief stay in their rows.
  `CREATE TABLE node_texts (
  owner_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('space','area','project')),
  brief TEXT NOT NULL DEFAULT '' CHECK (length(brief) <= 400 AND instr(brief, char(10)) = 0),
  description TEXT NOT NULL DEFAULT '',
  for_agents TEXT NOT NULL DEFAULT '',
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT`,
  // The FTS table first: its module drops its own shadow tables.
  "DROP TABLE search_fts",
  "DROP TABLE search_docs",
  `CREATE TABLE search_docs (
  doc       INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('task','note','log','learning','project','area','page')),
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

export const step0006: SchemaStep = {
  id: 6,
  from: 5,
  revision: { major: 0, minor: 6 },
  // New tables, and a derived index made again: nothing an older reader reads changes.
  kind: "additive",
  format: { major: 0, minor: 6 },
  // No release version exists yet to name as the floor, so both stay 0.0.0, as the earlier
  // steps' do.
  minReader: "0.0.0",
  minWriter: "0.0.0",
  undoFloor: false,
  tables: TABLES,
  up(conn) {
    for (const statement of SCHEMA_0_6_STATEMENTS) conn.exec(statement);
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
      throw misuse("Schema 0.6 did not produce its tables");
    }
  },
};
