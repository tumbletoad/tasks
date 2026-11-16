// Stand-in schema steps after the real ones, for the migration runner's tests and the restore's (a
// schema whose restore fails at its first write). They never ship: migrations/index.ts holds the
// real steps. The real chain ends at 0.5, so the stand-in is a 0.6: a table, a column and an index,
// and it raises the undo floor. A space built at 0.1 (revisions.ts) migrates through the real 0.2
// to 0.5 and the stand-in 0.6 in one migration of five steps. The failing variants of 0.6 fail
// midway through their `up`, in their `verify`, or leave a broken foreign key behind, after the
// real steps ran in the same transaction. A new real step rebases the stand-ins above it.
// A failing 0.2 serves the service's tests of a failed migration and, with a slow barrier backup,
// of an open that runs past its bound; so does the real chain with a slow barrier. A failing 0.4
// serves the tests of a space that stays at 0.3, without the search index.
import type { Connection } from "../src/driver.ts";
import { StorageError } from "../src/errors.ts";
import type { SchemaStep } from "../src/schema.ts";
import { step0002 } from "../migrations/0002-schema-0.2.ts";
import { step0004 } from "../migrations/0004-schema-0.4.ts";
import { step0005 } from "../migrations/0005-schema-0.5.ts";
import { SCHEMA_STEPS } from "../migrations/index.ts";
import { STEPS_0_1, STEPS_0_2, STEPS_0_3, STEPS_0_4, STEPS_0_5 } from "./revisions.ts";

const TABLES_0_6 = [...step0005.tables, "test_labels"];

/** The plain tables: an FTS5 table's shadow tables are SQLite's business. */
function tableNames(conn: Connection): string[] {
  return conn
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "AND name NOT LIKE 'search_fts_%' ORDER BY name",
    )
    .all<{ name: string }>()
    .map((row) => row.name);
}

function expectTables(conn: Connection, tables: readonly string[]): void {
  const found = tableNames(conn);
  if (found.join() !== [...tables].sort().join()) {
    throw new StorageError("SPACE_INVALID", "The stand-in step's tables are not as promised");
  }
}

export const standIn0006: SchemaStep = {
  id: 9006,
  from: 5,
  revision: { major: 0, minor: 6 },
  kind: "additive",
  format: { major: 0, minor: 6 },
  minReader: "0.0.0",
  minWriter: "0.0.0",
  undoFloor: true,
  tables: TABLES_0_6,
  up(conn) {
    conn.exec(
      "CREATE TABLE test_labels (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), " +
        "name TEXT NOT NULL) STRICT; " +
        "ALTER TABLE tasks ADD COLUMN test_flag INTEGER NOT NULL DEFAULT 0; " +
        "CREATE INDEX test_labels_name ON test_labels(name)",
    );
  },
  verify(conn) {
    expectTables(conn, TABLES_0_6);
  },
};

/** A 0.6 that creates its table, then fails before it finishes. */
export const failingMidway: SchemaStep = {
  ...standIn0006,
  up(conn) {
    conn.exec(
      "CREATE TABLE test_labels (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), " +
        "name TEXT NOT NULL) STRICT",
    );
    throw new StorageError("STORAGE_SQL", "The stand-in step failed midway");
  },
};

/** A 0.6 whose own verify refuses what its up did. */
export const failingVerify: SchemaStep = {
  ...standIn0006,
  verify() {
    throw new StorageError("SPACE_INVALID", "The stand-in step's verify refused");
  },
};

/** A 0.6 that leaves a label pointing at a task that does not exist (foreign keys are off). */
export const brokenForeignKey: SchemaStep = {
  ...standIn0006,
  up(conn) {
    standIn0006.up(conn);
    conn.exec("INSERT INTO test_labels (id, task_id, name) VALUES ('lb_x', 't_missing', 'x')");
  },
};

/** A 0.2 that fails at once: the space stays at 0.1 whenever its worker is stopped. */
export const failing0002: SchemaStep = {
  ...step0002,
  up() {
    throw new StorageError("STORAGE_SQL", "The stand-in 0.2 failed");
  },
};

/** A 0.4 that fails at once: the space stays at 0.3, without the search index. */
export const failing0004: SchemaStep = {
  ...step0004,
  up() {
    throw new StorageError("STORAGE_SQL", "The stand-in 0.4 failed");
  },
};

/**
 * How long a "slow-…" worker's barrier backup holds still once its snapshot is checked
 * (stand-in-steps-worker.ts): far past the reduced open bound of the service's tests.
 */
export const SLOW_BARRIER_MS = 3_000;

/** This build's real steps, then the stand-in 0.6. */
export const STEPS_0_6: readonly SchemaStep[] = [...SCHEMA_STEPS, standIn0006];

/**
 * A 0.6 whose schema refuses a restore's first write once the space has three commits: an index on
 * `space` whose expression overflows when `transfer` is set. The exact-schema rule passes it (its
 * own steps made it), so only a restore that runs its first write finds it (the trial restore).
 * Backups taken before the third commit restore; later ones do not.
 */
export const markGuard0006: SchemaStep = {
  ...standIn0006,
  id: 9016,
  up(conn) {
    standIn0006.up(conn);
    conn.exec(
      "CREATE INDEX space_mark_guard ON space ((CASE WHEN transfer IS NOT NULL AND last_seq >= 3 " +
        "THEN abs(-9223372036854775808) ELSE 0 END))",
    );
  },
};

/** This build's real steps, then the 0.6 whose schema refuses a later restore's first write. */
export const STEPS_MARK_GUARD: readonly SchemaStep[] = [...SCHEMA_STEPS, markGuard0006];

/** The step lists a test storage worker can serve (stand-in-steps-worker.ts), by name. */
export const STEP_SETS = {
  /** A released 0.1 build: it knows 0.1 only, so a 0.2 space is newer than it. */
  "0.1": STEPS_0_1,
  /** A released 0.2 build: a 0.3 space is newer than it. */
  "0.2": STEPS_0_2,
  /** A released 0.3 build: it keeps no search index, and a 0.4 space is newer than it. */
  "0.3": STEPS_0_3,
  /** A released 0.4 build: it knows no folders, and a 0.5 space is newer than it. */
  "0.4": STEPS_0_4,
  /** A released 0.5 build: folders. */
  "0.5": STEPS_0_5,
  "0.6": STEPS_0_6,
  midway: [...SCHEMA_STEPS, failingMidway],
  verify: [...SCHEMA_STEPS, failingVerify],
  "foreign-key": [...SCHEMA_STEPS, brokenForeignKey],
  /** A 0.2 build whose 0.2 fails at once, after its barrier backup. */
  "failing-0.2": [...STEPS_0_1, failing0002],
  /** A 0.4 build whose 0.4 fails at once, after its barrier backup. */
  "failing-0.4": [...STEPS_0_3, failing0004],
  /** A 0.2 build whose barrier backup is slow (SLOW_BARRIER_MS) and whose 0.2 then fails. */
  "slow-failing": [...STEPS_0_1, failing0002],
  /** This build's real steps, with a slow barrier backup (SLOW_BARRIER_MS): the migration succeeds. */
  "slow-real": SCHEMA_STEPS,
} as const satisfies Record<string, readonly SchemaStep[]>;

export type StepSet = keyof typeof STEP_SETS;

/** The environment variable that names a test worker's step list. */
export const STEP_SET_VARIABLE = "TASKS_TEST_STEP_SET";
