// Checking a copy of a space database: a backup's snapshot before it is compressed, and a restored
// database before it is used (A1 3.18). The copy opens read-only, passes PRAGMA integrity_check, and
// gives the facts a sidecar records. Nothing here trusts the copy: every value is decoded.
//
// THE EXACT-SCHEMA RULE (A1 3.18 "Restore and import of a bundle", step 3), in one place
// (requireOwnSchema): a database a restore writes to, or an export writes out, has exactly the
// tables, indexes and views that the schema steps up to its revision create. The comparison covers
// every object of the main schema, those with SQLite's reserved prefix `sqlite_` included (the
// steps make the same `sqlite_autoindex_…` indexes in the reference), except two groups:
// - what a restore drops before its first write and an export drops from its private snapshot
//   (isDropped, restore/mark.ts dropUnchecked): a trigger, since one would run on those writes,
//   and SQLite's statistics tables `sqlite_stat1` and `sqlite_stat4`, which ANALYZE makes and only
//   the query planner reads, by their exact names;
// - the search index (search/tables.ts isSearchObject), which is derived from the tasks: a restore
//   and an export drop whatever stands under its names and make it again from the steps' own
//   statements (search/remake.ts). So a copy whose index is missing, damaged or written by an
//   SQLite whose FTS5 lays out its shadow tables otherwise still restores, and nothing planted
//   under those names survives to act on a later write.
// Nothing else is left out, and everything compared is compared by its full text: an object SQLite
// would let no statement create, such as an index named `sqlite_autoindex_…` with a definition of
// its own, can be planted in a file, and it would act on every later write, not only on the
// restore's first one.
//
// Every name a diagnostic gives comes from the product's own list of its tables and columns
// (productTables), built from the schema steps, never from a name read out of the database being
// inspected (A6 3.16.4).
import { lstatSync, statSync } from "node:fs";
import { MEMORY, SINGLE_STEP, type Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { fsCall, removeQuietly } from "../files.ts";
import { openReader } from "../open.ts";
import { decodeSpaceRow, inRange, type SpaceRow } from "../rows.ts";
import { APP_ID, encodeRevision, type SchemaStep } from "../schema.ts";
import { isSearchObject } from "../search/tables.ts";
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
  checkDatabaseSize(databaseBytes(source), policy);
  await checked.driver.backup(source, dest, { pagesPerStep: SINGLE_STEP });
  checkDatabaseSize(
    fsCall(() => statSync(dest).size),
    policy,
  );
}

/** The size of the database on `conn`: its pages times their size. */
export function databaseBytes(conn: Connection): number {
  return Number(conn.pragma("page_count")) * Number(conn.pragma("page_size"));
}

/** What a checked snapshot holds. */
export interface SnapshotFacts {
  userVersion: number;
  space: SpaceRow;
  /** The bytes the space row's values hold: what a restore's first write rewrites. */
  spaceRowBytes: number;
  /** Rows per table, by table name. */
  counts: Record<string, number>;
  /** Its schema objects as the exact-schema rule compares them (schemaObjects). */
  schema: readonly string[];
}

/** The bytes the values of a row hold: text in UTF-8, a BLOB's own length, 8 for a number. */
function rowBytes(row: Record<string, unknown> | undefined): number {
  let total = 0;
  for (const value of Object.values(row ?? {})) {
    if (typeof value === "string") total += Buffer.byteLength(value, "utf8");
    else if (value instanceof Uint8Array) total += value.length;
    else if (value !== null) total += 8;
  }
  return total;
}

/** SQLite's literal reserved prefix: what SQLite names so is its own. */
export const SQLITE_RESERVED_PREFIX = "sqlite_";

const isReserved = (name: unknown): boolean =>
  typeof name === "string" && name.startsWith(SQLITE_RESERVED_PREFIX);

/** SQLite's statistics tables, which ANALYZE makes: dropped, never compared (see the header). */
export const STATISTICS_TABLES: readonly string[] = ["sqlite_stat1", "sqlite_stat4"];

/**
 * Whether a main-schema object is one the exact-schema rule leaves out because a restore drops it
 * before its first write, and an export from its private snapshot (see the header): a trigger, or a
 * statistics table by its exact name. The one test of it: schemaObjects skips what it passes, and
 * restore/mark.ts dropUnchecked drops exactly that.
 */
export function isDropped(type: unknown, name: unknown): boolean {
  return (
    type === "trigger" ||
    (type === "table" && typeof name === "string" && STATISTICS_TABLES.includes(name))
  );
}

/** Every object of the main schema, triggers included, in a fixed order. */
export const ALL_OBJECTS =
  "SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name";

/** The main schema's tables as SQLite classifies them: `table`, `view`, `virtual` or `shadow`. */
const TABLE_LIST = "SELECT name, type FROM pragma_table_list WHERE schema = 'main'";

/** One object of the main schema as sqlite_schema keeps it. */
interface SchemaRow {
  type: unknown;
  name: unknown;
  tbl_name: unknown;
  sql: unknown;
}

/**
 * The schema objects of the database on `conn` as the exact-schema rule compares them (see the
 * header): each table, index and view, SQLite's own included, with the SQL text SQLite keeps for it
 * (none for an index SQLite made for a key), which holds every column, constraint, key and
 * generated value. What isDropped passes and the search index are left out.
 */
export function schemaObjects(conn: Connection): string[] {
  return conn
    .prepare(ALL_OBJECTS)
    .all<SchemaRow>()
    .filter((row) => !isDropped(row.type, row.name) && !isSearchObject(row.name, row.tbl_name))
    .map((row) => JSON.stringify([row.type, row.name, row.tbl_name, row.sql]));
}

/**
 * The statements that make the search index on `conn`, a database the schema steps built, in an
 * order that runs: plain tables, then virtual tables, then indexes. A virtual table's shadow tables
 * and the indexes SQLite makes for keys have no statement of their own.
 */
function searchStatements(conn: Connection): string[] {
  const rows = conn
    .prepare(ALL_OBJECTS)
    .all<SchemaRow>()
    .filter((row) => isSearchObject(row.name, row.tbl_name) && typeof row.sql === "string");
  const isVirtual = (row: SchemaRow): boolean => /^CREATE VIRTUAL TABLE/iu.test(String(row.sql));
  const virtual = rows.filter((row) => row.type === "table" && isVirtual(row));
  const isShadow = (row: SchemaRow): boolean =>
    virtual.some((v) => String(row.name).startsWith(`${String(v.name)}_`));
  const plain = rows.filter((row) => row.type === "table" && !isVirtual(row) && !isShadow(row));
  const indexes = rows.filter((row) => row.type === "index");
  return [...plain, ...virtual, ...indexes].map((row) => String(row.sql));
}

/** A table of the product's schema that holds data, with its columns, as the schema steps make it. */
export interface ProductTable {
  name: string;
  columns: readonly string[];
}

/**
 * What the schema steps make at one revision: the objects compared, the data tables, and the
 * statements that make the search index.
 */
interface Reference {
  objects: readonly string[];
  tables: readonly ProductTable[];
  search: readonly string[];
}

const REFERENCES = new WeakMap<readonly SchemaStep[], Map<number, Reference>>();

/**
 * The product's data tables on `conn`: every plain table but SQLite's and the search index's, with
 * its columns.
 */
function dataTablesOf(conn: Connection): ProductTable[] {
  return conn
    .prepare(TABLE_LIST)
    .all<{ name: unknown; type: unknown }>()
    .filter(
      (row) =>
        row.type === "table" &&
        typeof row.name === "string" &&
        !isReserved(row.name) &&
        !isSearchObject(row.name, row.name),
    )
    .map((row) => String(row.name))
    .sort()
    .map((name) => ({
      name,
      // Every column a SELECT * returns: the plain ones and the generated ones.
      columns: conn
        .prepare(
          "SELECT name FROM pragma_table_xinfo($table) WHERE hidden IN (0, 2, 3) ORDER BY cid",
        )
        .all<{ name: unknown }>({ table: name })
        .map((column) => String(column.name)),
    }));
}

/**
 * What `steps` make from an empty database up to `userVersion`, in a private in-memory database, as
 * creating a space and migrating one run them. Undefined when the steps never reach it. Kept per
 * chain of steps and revision.
 */
function reference(
  checked: CheckedDriver,
  steps: readonly SchemaStep[],
  userVersion: number,
): Reference | undefined {
  const known = REFERENCES.get(steps)?.get(userVersion);
  if (known !== undefined) return known;
  const conn = checked.driver.open(MEMORY, { readOnly: false, busyTimeoutMs: 0, create: true });
  let made: Reference | undefined;
  try {
    let current = 0;
    for (const step of steps) {
      if (step.from !== current) break;
      step.up(conn);
      current = encodeRevision(step.revision);
      if (current === userVersion) {
        made = {
          objects: schemaObjects(conn),
          tables: dataTablesOf(conn),
          search: searchStatements(conn),
        };
        break;
      }
    }
  } finally {
    conn.close();
  }
  if (made === undefined) return undefined;
  const byVersion = REFERENCES.get(steps) ?? new Map<number, Reference>();
  byVersion.set(userVersion, made);
  REFERENCES.set(steps, byVersion);
  return made;
}

/** The schema objects a space has at `userVersion` (schemaObjects), or undefined: never reached. */
export function referenceSchema(
  checked: CheckedDriver,
  steps: readonly SchemaStep[],
  userVersion: number,
): readonly string[] | undefined {
  return reference(checked, steps, userVersion)?.objects;
}

/**
 * The statements the schema steps make the search index with at `userVersion`, in an order that
 * runs: none when that revision has no index, undefined when the steps never reach it. What a
 * restore or an export makes the index again with, never text read out of the database at hand.
 */
export function referenceSearch(
  checked: CheckedDriver,
  steps: readonly SchemaStep[],
  userVersion: number,
): readonly string[] | undefined {
  return reference(checked, steps, userVersion)?.search;
}

/**
 * The product's data tables at `userVersion`, with their columns: the names a diagnostic, a rescue
 * or `data.jsonl` may give, never ones read out of the database at hand. Undefined when the steps
 * never reach that revision.
 */
export function productTables(
  checked: CheckedDriver,
  steps: readonly SchemaStep[],
  userVersion: number,
): readonly ProductTable[] | undefined {
  return reference(checked, steps, userVersion)?.tables;
}

/**
 * The exact-schema rule (see the header): `schema` (schemaObjects of a database at `userVersion`)
 * must be exactly what `steps` make at that revision. SPACE_SCHEMA_FOREIGN otherwise, whose message
 * names no object: a foreign definition, such as a cascading key or a generated column, would act
 * on Tasks' own writes, and its name is the database's, not the product's.
 */
export function requireOwnSchema(
  checked: CheckedDriver,
  schema: readonly string[],
  userVersion: number,
  steps: readonly SchemaStep[],
): void {
  const expected = referenceSchema(checked, steps, userVersion);
  if (
    expected === undefined ||
    expected.length !== schema.length ||
    !expected.every((object, i) => object === schema[i])
  ) {
    throw new StorageError(
      "SPACE_SCHEMA_FOREIGN",
      "The database has tables, indexes or views that its schema revision does not create",
    );
  }
}

/** A table name Tasks can quote safely: the names its schema steps create. */
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,63}$/;

/**
 * Rows per table of the main schema. SQLite's own tables are left out by their literal prefix, and
 * the search index's, whose rows a restore makes again.
 */
export function tableCounts(conn: Connection): Record<string, number> {
  const counts: Record<string, number> = {};
  const names = conn
    .prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table' ORDER BY name")
    .all<{ name: unknown }>()
    .map((row) => row.name)
    .filter((name) => !isReserved(name) && !isSearchObject(name, name));
  for (const name of names) {
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
    const row = conn.prepare("SELECT * FROM space WHERE one = 1").get();
    const space = decodeSpaceRow(row);
    return {
      userVersion,
      space,
      spaceRowBytes: rowBytes(row),
      counts: tableCounts(conn),
      schema: schemaObjects(conn),
    };
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
