// Checking a copy of a space database: a backup's snapshot before it is compressed, and a restored
// database before it is used (A1 3.18). The copy opens read-only, passes PRAGMA integrity_check, and
// gives the facts a sidecar records. Nothing here trusts the copy: every value is decoded. A
// restore also requires the copy's own schema (hasOwnSchema) before it writes to it.
import { lstatSync, statSync } from "node:fs";
import { MEMORY, SINGLE_STEP, type Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { fsCall, removeQuietly } from "../files.ts";
import { openReader } from "../open.ts";
import { decodeSpaceRow, inRange, type SpaceRow } from "../rows.ts";
import { APP_ID, encodeRevision, type SchemaStep } from "../schema.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { checkDatabaseSize, type BundlePolicy } from "./policy.ts";

/**
 * Copies the database on `source`, a read-only connection that holds no transaction, into the new
 * file `dest` with the driver's backup API in ONE step: one consistent snapshot taken inside one
 * read transaction, while WAL lets the writer go on (node:sqlite restarts a multi-step backup
 * whenever another connection writes, A1 3.18). The driver creates `dest` exclusively and
 * owner-only. A database over the policy's limit is refused before and after the copy.
 */
export async function copySnapshot(
  checked: CheckedDriver,
  source: Connection,
  dest: string,
  policy: BundlePolicy,
): Promise<void> {
  // The driver's backup() does not check its connection (A1 3.19): a closed or invalidated
  // connection fails here instead.
  source.pragma("user_version");
  const pages = Number(source.pragma("page_count"));
  const pageSize = Number(source.pragma("page_size"));
  checkDatabaseSize(pages * pageSize, policy);
  await checked.driver.backup(source, dest, { pagesPerStep: SINGLE_STEP });
  checkDatabaseSize(
    fsCall(() => statSync(dest).size),
    policy,
  );
}

/** What a checked snapshot holds. */
export interface SnapshotFacts {
  userVersion: number;
  space: SpaceRow;
  /** Rows per table, by table name. */
  counts: Record<string, number>;
  /** Its tables, indexes and views as SQLite stores them (schemaObjects). */
  schema: readonly string[];
}

/** Every table, index and view of the main schema but SQLite's own, by type and name. */
const SCHEMA_OBJECTS =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
  "WHERE type IN ('table', 'index', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name";

/**
 * The schema objects of the database on `conn`: each table, index and view with the SQL text
 * SQLite keeps for it, which holds every column, constraint, key and generated value. Triggers are
 * not among them: a restore drops them (restore.ts).
 */
export function schemaObjects(conn: Connection): string[] {
  return conn
    .prepare(SCHEMA_OBJECTS)
    .all<Record<string, unknown>>()
    .map((row) => JSON.stringify([row["type"], row["name"], row["tbl_name"], row["sql"]]));
}

const REFERENCES = new WeakMap<readonly SchemaStep[], Map<number, readonly string[]>>();

/**
 * The schema objects a space has at `userVersion`: what `steps`, from an empty database up to that
 * revision, create in a private in-memory database, as creating a space and migrating one run
 * them. Undefined when the steps never reach it. Kept per chain of steps and revision.
 */
export function referenceSchema(
  checked: CheckedDriver,
  steps: readonly SchemaStep[],
  userVersion: number,
): readonly string[] | undefined {
  const known = REFERENCES.get(steps)?.get(userVersion);
  if (known !== undefined) return known;
  const conn = checked.driver.open(MEMORY, { readOnly: false, busyTimeoutMs: 0, create: true });
  let objects: string[] | undefined;
  try {
    let current = 0;
    for (const step of steps) {
      if (step.from !== current) break;
      step.up(conn);
      current = encodeRevision(step.revision);
      if (current === userVersion) {
        objects = schemaObjects(conn);
        break;
      }
    }
  } finally {
    conn.close();
  }
  if (objects === undefined) return undefined;
  const byVersion = REFERENCES.get(steps) ?? new Map<number, readonly string[]>();
  byVersion.set(userVersion, objects);
  REFERENCES.set(steps, byVersion);
  return objects;
}

/**
 * Whether a restored database has exactly the tables, indexes and views of its revision (A1 3.18
 * "Restore and import of a bundle", step 3). A table defined otherwise (a foreign key that
 * cascades into another table, a generated or checked column, an extra table or index) would run
 * or refuse on Tasks' own writes, the read-only mark and a claim first: a restore never writes to
 * a database it has not recognised.
 */
export function hasOwnSchema(
  checked: CheckedDriver,
  facts: SnapshotFacts,
  steps: readonly SchemaStep[],
): boolean {
  const reference = referenceSchema(checked, steps, facts.userVersion);
  return (
    reference !== undefined &&
    reference.length === facts.schema.length &&
    reference.every((object, i) => object === facts.schema[i])
  );
}

/** A table name Tasks can quote safely: the names its schema steps create. */
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,63}$/;

/** Rows per table of the main schema. */
export function tableCounts(conn: Connection): Record<string, number> {
  const counts: Record<string, number> = {};
  const names = conn
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "ORDER BY name",
    )
    .all<{ name: unknown }>();
  for (const { name } of names) {
    if (typeof name !== "string" || !TABLE_NAME.test(name)) {
      throw new StorageError("SPACE_INVALID", "The database has a table that is not a space's");
    }
    const n = conn.prepare(`SELECT count(*) AS n FROM "${name}"`).get()?.["n"];
    if (!inRange(n, "seq"))
      throw new StorageError("SPACE_INVALID", "A table count is out of range");
    counts[name] = n;
  }
  return counts;
}

/** Reads the facts of a space database in one read transaction on `conn`. */
export function readSnapshotFacts(conn: Connection): SnapshotFacts {
  return conn.transaction("deferred", () => {
    if (conn.pragma("integrity_check") !== "ok") {
      throw new StorageError("STORAGE_CORRUPT", "The copy fails its integrity check");
    }
    if (conn.pragma("application_id") !== APP_ID) {
      throw new StorageError("SPACE_INVALID", "The copy is not a space database");
    }
    const userVersion = conn.pragma("user_version");
    if (!inRange(userVersion, "count") || userVersion === 0) {
      throw new StorageError("SPACE_VERSION_UNKNOWN", "The copy has no schema revision");
    }
    const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
    return { userVersion, space, counts: tableCounts(conn), schema: schemaObjects(conn) };
  });
}

/**
 * Opens the database file `path` read-only, checks it and reads its facts, then closes it and
 * removes the empty `-wal` and the `-shm` that a read-only open of a WAL database leaves (A1
 * 3.1). The file must be a private copy: nothing else may have it open.
 */
export function checkSnapshot(
  checked: CheckedDriver,
  path: string,
  busyTimeoutMs?: number,
): SnapshotFacts {
  if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new StorageError("SPACE_NOT_FOUND", "The copy is missing");
  }
  const conn = openReader(checked, path, busyTimeoutMs === undefined ? {} : { busyTimeoutMs });
  try {
    return readSnapshotFacts(conn);
  } finally {
    conn.close();
    removeQuietly(`${path}-wal`);
    removeQuietly(`${path}-shm`);
  }
}
