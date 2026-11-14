// Schema 0.2 (A7 3.10 M3.01), frozen for the importer: the tables A1 3.4 and 3.14 give for labels,
// learnings, attachments (schema only), proposals and exchanges, and the `hold` column of `space`
// (A1 3.6). The trash and wrap fields of `tasks` are in 0.1 already (A1 3.4). Creating a
// space runs 0001 and then this step, and the migration runner runs this step on a 0.1 space behind
// its verified barrier backup, so a migrated space and a new one have the same schema, byte for
// byte in `sqlite_schema`.
//
// Each statement runs on its own, in order, inside the caller's transaction (the runner's one
// BEGIN IMMEDIATE for every pending step, or create's). A failure at any of them rolls the whole
// migration back and leaves the space at 0.1 (A1 3.17).
//
// Departures from A1 3.4 and 3.14:
// - `space.hold` is added at the end of the row (ALTER TABLE ADD COLUMN appends), not between
//   `transfer` and `undo_floor_seq` as A1 3.4 shows it.
// - `proposals` and `exchanges` get `fv` and `fp`, like every mutable row (A1 3.4's convention,
//   as 0.1 did for `machines` and `launches`): their state changes.
// - `exchange_items` keeps a rowid: its `base` holds field values and note bodies as JSON, and the
//   WITHOUT ROWID rule (A1 3.4) keeps rows with free text or JSON in a rowid table.
// - Three indexes A1 leaves out, for the reads that name a task or a label: `learnings_task`,
//   `attachments_task` and `task_labels_label`.
import type { Connection } from "../src/driver.ts";
import { misuse } from "../src/errors.ts";
import type { SchemaStep } from "../src/schema.ts";
import { step0001 } from "./0001-schema-0.1.ts";

/** The tables schema 0.2 adds. */
export const TABLES_0_2_NEW = [
  "labels",
  "task_labels",
  "learnings",
  "attachments",
  "proposals",
  "exchanges",
  "exchange_items",
] as const;

const TABLES = [...step0001.tables, ...TABLES_0_2_NEW] as const;

/**
 * The step's statements, in the order they run, one per entry. Tests inject a fault before each
 * of them, so every entry is exactly one SQL statement.
 */
export const SCHEMA_0_2_STATEMENTS: readonly string[] = [
  // The user-only space hold {by, at, reason, exchange_id?} (A1 3.6). Its operations are M7.07's.
  "ALTER TABLE space ADD COLUMN hold TEXT CHECK (hold IS NULL OR json_valid(hold))",

  `CREATE TABLE labels (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT NOT NULL, color TEXT,
  deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT`,
  "CREATE UNIQUE INDEX labels_slug ON labels(slug) WHERE deleted_at IS NULL",

  // A link row: its one logical field is `removed` (removed_at), its version the link version.
  `CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id), label_id TEXT NOT NULL REFERENCES labels(id),
  added_by TEXT NOT NULL REFERENCES actors(id), removed_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  PRIMARY KEY (task_id, label_id)
) STRICT, WITHOUT ROWID`,
  "CREATE INDEX task_labels_label ON task_labels(label_id)",

  `CREATE TABLE learnings (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  position TEXT NOT NULL, body TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id), created_at INTEGER NOT NULL, deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT`,
  "CREATE INDEX learnings_task ON learnings(task_id, position)",

  // Schema only (A7 M3.01): attachment ingestion is outside v1 (A7 P4), so nothing writes it yet.
  `CREATE TABLE attachments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT NOT NULL, filename TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id), created_at INTEGER NOT NULL, deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT`,
  "CREATE INDEX attachments_task ON attachments(task_id)",

  // A staged plan waiting for a person (A1 3.10.5): its operations with references resolved and
  // dates fixed, and the base it was staged on.
  `CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  author_id TEXT NOT NULL REFERENCES actors(id), session_id TEXT,
  origin TEXT NOT NULL
         CHECK (origin IN ('autonomy','import_conflict','burst_brake','migration_review')),
  ops TEXT NOT NULL CHECK (json_valid(ops)),
  base_epoch INTEGER NOT NULL, base_incarnation TEXT NOT NULL, base_seq INTEGER NOT NULL,
  alternatives TEXT CHECK (alternatives IS NULL OR json_valid(alternatives)),
  reason TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','accepted','rejected','superseded')),
  resolved_by TEXT REFERENCES actors(id), resolved_at INTEGER, applied_seq INTEGER,
  created_at INTEGER NOT NULL,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT`,
  "CREATE INDEX proposals_pending ON proposals(state, task_id) WHERE state = 'pending'",

  // An explicit exchange (A1 3.14): the importer's input copy and each export to the prototype's
  // format (A7 3.15.5, 3.15.8). `dir` is the working copy's folder as the writer records it.
  `CREATE TABLE exchanges (
  id TEXT PRIMARY KEY, dir TEXT NOT NULL, base_seq INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id), created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','applied','abandoned')),
  applied_seq INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT`,

  // One per task of an exchange, written once with it: the values as exported or imported (the
  // base of the three-way compare) and the file, or the prototype's marker. Keeps a rowid.
  `CREATE TABLE exchange_items (
  exchange_id TEXT NOT NULL REFERENCES exchanges(id), task_id TEXT NOT NULL,
  file TEXT NOT NULL, base TEXT NOT NULL CHECK (json_valid(base)),
  PRIMARY KEY (exchange_id, task_id)
) STRICT`,
];

/** The user tables of the main schema with whether each is STRICT. */
function userTables(conn: Connection): Map<string, boolean> {
  const rows = conn
    .prepare(
      "SELECT name, strict FROM pragma_table_list " +
        "WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all<{ name: string; strict: number }>();
  return new Map(rows.map((row) => [row.name, row.strict === 1]));
}

export const step0002: SchemaStep = {
  id: 2,
  from: 1,
  revision: { major: 0, minor: 2 },
  // Only new tables, indexes and a nullable column: nothing an older reader reads changes.
  kind: "additive",
  format: { major: 0, minor: 2 },
  // A build that knows only 0.1 reads a 0.2 space (it reads none of the new tables, and the space
  // row's decoder takes the columns it knows) and never writes it: an older build refuses a newer
  // revision as a writer whatever space.json says (A1 3.17). No release version exists yet
  // to name as the floor (builds are 0.1.0-dev.<n>), so both stay 0.0.0.
  minReader: "0.0.0",
  minWriter: "0.0.0",
  undoFloor: false,
  tables: TABLES,
  up(conn) {
    for (const statement of SCHEMA_0_2_STATEMENTS) conn.exec(statement);
  },
  verify(conn) {
    const found = userTables(conn);
    const expected = new Set<string>(TABLES);
    if (found.size !== expected.size || [...found].some(([n, s]) => !expected.has(n) || !s)) {
      throw misuse("Schema 0.2 did not produce its tables as STRICT tables");
    }
    const hold = conn
      .prepare("SELECT count(*) AS n FROM pragma_table_info('space') WHERE name = 'hold'")
      .get<{ n: number }>();
    if (hold?.n !== 1) throw misuse("Schema 0.2 did not add the space's hold");
  },
};
