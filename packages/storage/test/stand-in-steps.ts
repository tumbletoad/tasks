// Stand-in schema steps after the real ones, for the migration runner's tests only (A7 M1.06's
// Verify line). They never ship: migrations/index.ts holds the real steps. The real chain ends at
// 0.3 (M6.01), so the stand-in is a 0.4: a table, a column and an index, and it raises the undo
// floor. A space built at 0.1 (revisions.ts) migrates through the real 0.2 and 0.3 and the stand-in
// 0.4 in one migration of three steps. The failing variants of 0.4 fail midway through their `up`,
// in their `verify`, or leave a broken foreign key behind, after the real steps ran in the same
// transaction. A new real step rebases the stand-in above it (A1 3.17).
// A failing 0.2 serves the service's tests of a failed migration (A1 3.17) and, with a slow
// barrier backup, of an open that runs past its bound; so does the real 0.2 with a slow barrier.
import type { Connection } from "../src/driver.ts";
import { StorageError } from "../src/errors.ts";
import type { SchemaStep } from "../src/schema.ts";
import { step0002 } from "../migrations/0002-schema-0.2.ts";
import { step0003 } from "../migrations/0003-schema-0.3.ts";
import { SCHEMA_STEPS } from "../migrations/index.ts";
import { STEPS_0_1, STEPS_0_2 } from "./revisions.ts";

const TABLES_0_4 = [...step0003.tables, "test_labels"];

function tableNames(conn: Connection): string[] {
  return conn
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
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

export const standIn0004: SchemaStep = {
  id: 9004,
  from: 3,
  revision: { major: 0, minor: 4 },
  kind: "additive",
  format: { major: 0, minor: 4 },
  minReader: "0.0.0",
  minWriter: "0.0.0",
  undoFloor: true,
  tables: TABLES_0_4,
  up(conn) {
    conn.exec(
      "CREATE TABLE test_labels (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), " +
        "name TEXT NOT NULL) STRICT; " +
        "ALTER TABLE tasks ADD COLUMN test_flag INTEGER NOT NULL DEFAULT 0; " +
        "CREATE INDEX test_labels_name ON test_labels(name)",
    );
  },
  verify(conn) {
    expectTables(conn, TABLES_0_4);
  },
};

/** A 0.4 that creates its table, then fails before it finishes. */
export const failingMidway: SchemaStep = {
  ...standIn0004,
  up(conn) {
    conn.exec(
      "CREATE TABLE test_labels (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), " +
        "name TEXT NOT NULL) STRICT",
    );
    throw new StorageError("STORAGE_SQL", "The stand-in step failed midway");
  },
};

/** A 0.4 whose own verify refuses what its up did. */
export const failingVerify: SchemaStep = {
  ...standIn0004,
  verify() {
    throw new StorageError("SPACE_INVALID", "The stand-in step's verify refused");
  },
};

/** A 0.4 that leaves a label pointing at a task that does not exist (foreign keys are off). */
export const brokenForeignKey: SchemaStep = {
  ...standIn0004,
  up(conn) {
    standIn0004.up(conn);
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

/**
 * How long a "slow-…" worker's barrier backup holds still once its snapshot is checked
 * (stand-in-steps-worker.ts): far past the reduced open bound of the service's tests.
 */
export const SLOW_BARRIER_MS = 3_000;

/** This build's real steps, then the stand-in 0.4. */
export const STEPS_0_4: readonly SchemaStep[] = [...SCHEMA_STEPS, standIn0004];

/** The step lists a test storage worker can serve (stand-in-steps-worker.ts), by name. */
export const STEP_SETS = {
  /** A released 0.1 build: it knows 0.1 only, so a 0.2 space is newer than it. */
  "0.1": STEPS_0_1,
  /** A released 0.2 build: a 0.3 space is newer than it. */
  "0.2": STEPS_0_2,
  "0.4": STEPS_0_4,
  midway: [...SCHEMA_STEPS, failingMidway],
  verify: [...SCHEMA_STEPS, failingVerify],
  "foreign-key": [...SCHEMA_STEPS, brokenForeignKey],
  /** A 0.2 build whose 0.2 fails at once, after its barrier backup. */
  "failing-0.2": [...STEPS_0_1, failing0002],
  /** A 0.2 build whose barrier backup is slow (SLOW_BARRIER_MS) and whose 0.2 then fails. */
  "slow-failing": [...STEPS_0_1, failing0002],
  /** This build's real steps, with a slow barrier backup (SLOW_BARRIER_MS): the migration succeeds. */
  "slow-real": SCHEMA_STEPS,
} as const satisfies Record<string, readonly SchemaStep[]>;

export type StepSet = keyof typeof STEP_SETS;

/** The environment variable that names a test worker's step list. */
export const STEP_SET_VARIABLE = "TASKS_TEST_STEP_SET";
