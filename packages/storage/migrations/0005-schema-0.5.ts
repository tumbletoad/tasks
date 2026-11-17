// Schema 0.5: where a project's and a task's folders are kept. Creating a space runs 0001 to 0004
// and then this step, and the migration runner runs it on an older space behind its verified
// barrier backup, in the one transaction of every pending step.
//
// The step creates one table and its indexes and changes no row of any other table. `places` stays
// as it is, with its rows and their history: nothing converts them, because a place names a root of
// one machine's machine.toml, which a migration does not read.
//
// A folder row is an owner (a project or a task), the machine it is on and the folder's absolute
// path as that machine spells it, with the person's home written as `~`. An owner has at most one
// live folder per machine (the unique index). That two live projects never share one folder on one
// machine is the writer's rule, not an index's: the comparison follows the machine's case rule and
// skips projects that are deleted, which an index cannot express.
//
// Each statement runs on its own, in order, inside the caller's transaction. A failure at any of
// them rolls the whole migration back and leaves the space at its old revision.
import type { Connection } from "../src/driver.ts";
import { misuse } from "../src/errors.ts";
import type { SchemaStep } from "../src/schema.ts";
import { step0004 } from "./0004-schema-0.4.ts";

/** The table schema 0.5 adds. */
export const TABLES_0_5_NEW = ["folders"] as const;

const TABLES = [...step0004.tables, ...TABLES_0_5_NEW] as const;

/**
 * The step's statements, in the order they run, one per entry. Tests inject a fault before each
 * of them, so every entry is exactly one SQL statement.
 */
export const SCHEMA_0_5_STATEMENTS: readonly string[] = [
  `CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('project','task')),
  owner_id TEXT NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
  created_at INTEGER NOT NULL, deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT`,
  "CREATE UNIQUE INDEX folders_owner ON folders(owner_kind, owner_id, machine_id) " +
    "WHERE deleted_at IS NULL",
  // A machine's live project folders: the writer's same-folder rule and the deepest-project read.
  "CREATE INDEX folders_machine ON folders(machine_id, owner_kind) WHERE deleted_at IS NULL",
  // A deleted project's folders, which its restore brings back.
  "CREATE INDEX folders_of ON folders(owner_id)",
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

export const step0005: SchemaStep = {
  id: 5,
  from: 4,
  revision: { major: 0, minor: 5 },
  // Only a new table and its indexes: nothing an older reader reads changes.
  kind: "additive",
  format: { major: 0, minor: 5 },
  // A 0.4 build reads a 0.5 space (it never reads `folders`) and never writes it: an older build
  // refuses a newer revision as a writer whatever space.json says. No release version exists yet
  // to name as the floor, so both stay 0.0.0, as the earlier steps' do.
  minReader: "0.0.0",
  minWriter: "0.0.0",
  undoFloor: false,
  tables: TABLES,
  up(conn) {
    for (const statement of SCHEMA_0_5_STATEMENTS) conn.exec(statement);
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
      throw misuse("Schema 0.5 did not produce its tables");
    }
  },
};
