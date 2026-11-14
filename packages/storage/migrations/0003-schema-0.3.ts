// Schema 0.3 (A7 3.13 M6.01): A4's execution records, the `sessions` and `runs` tables of A1 3.4.
// Creating a space runs 0001, 0002 and then this step, and the migration runner runs this step on
// a 0.1 or 0.2 space behind its verified barrier backup, in the one transaction of every pending
// step, so a migrated space and a new one have the same schema, byte for byte in `sqlite_schema`.
//
// Each statement runs on its own, in order, inside the caller's transaction (the runner's one
// BEGIN IMMEDIATE for every pending step, or create's). A failure at any of them rolls the whole
// migration back and leaves the space at its old revision (A1 3.17).
//
// The tables are written only through A4's execution store (A1 3.4, A4 3.16.1). Their content is
// the store's: once a real space holds this schema it is frozen like 0.1 and 0.2, so each table
// keeps what later steps of the same records will need in a JSON column the writer checks key by
// key, which grows without a migration.
//
// Departures from A1 3.4's DDL:
// - Both tables get `fv` and `fp` like every mutable row (A1 open item 13, settled): a transition
//   writes change rows, and the field versions name them. The schema lint requires both maps on
//   every row with `created_seq`.
// - `sessions.bound` is an integer flag, so it gets `CHECK (bound IN (0,1))` like `inbox`.
// - `sessions.detail` holds what A4 3.10's session carries beyond A1's columns: how it bound, its
//   launches, the native IDs its connections presented, and the snapshot of its instance's label
//   and account. Binding's records move into the table later (A4 3.10), without a new step.
// - `runs` gets what A4 3.16 lists beyond A1's columns: `adapter` (an open set the writer checks,
//   like `launches.route`), `place_id` (the place, as a launch names it: never a folder), `request`
//   (the person's instruction, A4 3.11.5), `spec` (the brief's hash, the permission and the limits,
//   written once), `reason` (the code of a final state) and `detail` (the evidence and the time of
//   each state, as a launch's).
// - `runs.state` has no CHECK, as A1 3.4 gives it: the writer checks A4's states, so a later
//   adapter's state (A4 3.11.12) needs no table rebuild. `runs` belongs to a task or a routine,
//   exactly one (a CHECK).
// - Indexes A1 leaves out, for the reads the execution store makes: a machine's open sessions and
//   runs (`openWork`, A4 3.16.1: also the `unknown` runs whose stop timed out, which a later exit
//   still settles) and a task's.
import type { Connection } from "../src/driver.ts";
import { misuse } from "../src/errors.ts";
import type { SchemaStep } from "../src/schema.ts";
import { step0002 } from "./0002-schema-0.2.ts";

/** The tables schema 0.3 adds. */
export const TABLES_0_3_NEW = ["sessions", "runs"] as const;

const TABLES = [...step0002.tables, ...TABLES_0_3_NEW] as const;

/**
 * The step's statements, in the order they run, one per entry. Tests inject a fault before each
 * of them, so every entry is exactly one SQL statement.
 */
export const SCHEMA_0_3_STATEMENTS: readonly string[] = [
  // A4 3.10's session: one agent conversation and the launches that open or resume it.
  `CREATE TABLE sessions (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('interactive','run')),
  instance_id TEXT NOT NULL, machine_id TEXT NOT NULL REFERENCES machines(id),
  native_id TEXT, native_id_source TEXT,
  state TEXT NOT NULL CHECK (state IN ('opening','live','ended','unknown')),
  end_reason TEXT, exit_code INTEGER,
  bound INTEGER NOT NULL DEFAULT 0 CHECK (bound IN (0,1)), actor_id TEXT REFERENCES actors(id),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  created_at INTEGER NOT NULL, ended_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT`,
  "CREATE INDEX sessions_task ON sessions(task_id, created_at)",
  "CREATE INDEX sessions_open ON sessions(machine_id, created_at) WHERE state IN ('opening','live')",

  // A4 3.11's run: written in `queued` before anything spawns (R8), moved only by compare-and-set
  // transitions. A task's run or a routine's, never both.
  `CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), routine_id TEXT, session_id TEXT,
  instance_id TEXT NOT NULL, machine_id TEXT NOT NULL REFERENCES machines(id),
  adapter TEXT NOT NULL, place_id TEXT REFERENCES places(id),
  request TEXT,
  spec TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(spec)),
  state TEXT NOT NULL, reason TEXT, attempt INTEGER NOT NULL DEFAULT 1,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  result TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result)),
  queued_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  CHECK ((task_id IS NULL) <> (routine_id IS NULL))
) STRICT`,
  "CREATE INDEX runs_task ON runs(task_id, queued_at)",
  "CREATE INDEX runs_open ON runs(machine_id, queued_at) " +
    "WHERE (state IN ('queued','starting','running','waiting_for_input','cancelling'," +
    "'reconciling') OR (state = 'unknown' AND reason = 'stop_timed_out'))",
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

export const step0003: SchemaStep = {
  id: 3,
  from: 2,
  revision: { major: 0, minor: 3 },
  // Only new tables and indexes: nothing an older reader reads changes.
  kind: "additive",
  format: { major: 0, minor: 3 },
  // A build that knows only 0.2 reads a 0.3 space (it reads neither new table) and never writes it:
  // an older build refuses a newer revision as a writer whatever space.json says (A1 3.17). No
  // release version exists yet to name as the floor, so both stay 0.0.0, as 0.2's do.
  minReader: "0.0.0",
  minWriter: "0.0.0",
  undoFloor: false,
  tables: TABLES,
  up(conn) {
    for (const statement of SCHEMA_0_3_STATEMENTS) conn.exec(statement);
  },
  verify(conn) {
    const found = userTables(conn);
    const expected = new Set<string>(TABLES);
    if (found.size !== expected.size || [...found].some(([n, s]) => !expected.has(n) || !s)) {
      throw misuse("Schema 0.3 did not produce its tables as STRICT tables");
    }
  },
};
