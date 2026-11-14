// The start-up check of A1 3.19, with the backup API from A2 3.12.1's runtime gate. It asks the
// driver it is given, through a private in-memory connection, for its own SQLite version and
// capabilities. It never reads process.versions.sqlite: that is Node's SQLite, and another driver
// bundles its own (better-sqlite3 13.0.3 has 3.53.4, A1 3.19).
//
// A space connection can only be opened through a CheckedDriver (open.ts), and CheckedDriver.check
// is the only way to get one, so a build that fails the check never opens a space file.
import {
  MEMORY,
  SINGLE_STEP,
  type Connection,
  type DriverName,
  type SqliteDriver,
} from "./driver.ts";
import { StorageError } from "./errors.ts";

export const MIN_SQLITE_VERSION = "3.45.0";

/** The probe statements, exported so a test can simulate a build that lacks a capability. */
export const PROBE_SQL = {
  version: "SELECT sqlite_version() AS value",
  compileOptions: "PRAGMA compile_options",
  fts5Option: "SELECT sqlite_compileoption_used('ENABLE_FTS5') AS value",
  fts5Create: "CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x)",
  fts5Insert: "INSERT INTO temp.fts_probe(x) VALUES ('start-up probe')",
  fts5Match: "SELECT count(*) AS value FROM temp.fts_probe WHERE fts_probe MATCH 'probe'",
  fts5Drop: "DROP TABLE temp.fts_probe",
  json: "SELECT json_valid('{}') AS value",
  strictCreate: "CREATE TEMP TABLE strict_probe(x INTEGER) STRICT",
  strictInsert: "INSERT INTO temp.strict_probe(x) VALUES ('not an integer')",
  strictDrop: "DROP TABLE temp.strict_probe",
  backupSource: "CREATE TABLE backup_probe(x INTEGER); INSERT INTO backup_probe VALUES (1)",
} as const;

/** What the driver's own SQLite can do, as the probes found it. */
export interface Capabilities {
  sqliteVersion: string;
  compileOptions: string[];
  /** sqlite_compileoption_used('ENABLE_FTS5') = 1. */
  fts5Compiled: boolean;
  /** A temporary FTS5 table could be created, filled, matched and dropped. */
  fts5Works: boolean;
  /** json_valid('{}') = 1. */
  json: boolean;
  /** A STRICT temporary table rejected a value of the wrong type. */
  strict: boolean;
  /** A single-step backup into an in-memory database copied at least one page. */
  backup: boolean;
}

/** What `tasks doctor` prints about the driver (A1 3.19). */
export interface DriverReport {
  driver: DriverName;
  sqliteVersion: string;
  compileOptions: string[];
}

function parseVersion(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? undefined : match.slice(1, 4).map(Number);
}

/** Whether `version` is at least `min`, both as major.minor.patch. */
export function versionAtLeast(version: string, min: string): boolean {
  const v = parseVersion(version);
  const m = parseVersion(min);
  if (v === undefined || m === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    const a = v[i] ?? 0;
    const b = m[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** One line per requirement the capabilities miss. Empty when the build is good. */
export function capabilityProblems(c: Capabilities): string[] {
  const problems: string[] = [];
  if (!versionAtLeast(c.sqliteVersion, MIN_SQLITE_VERSION)) {
    problems.push(`SQLite ${c.sqliteVersion} is older than ${MIN_SQLITE_VERSION}`);
  }
  if (!c.fts5Compiled) problems.push("FTS5 is not compiled in (ENABLE_FTS5)");
  if (!c.fts5Works) problems.push("an FTS5 table cannot be created and matched");
  if (!c.json) problems.push("the JSON functions are missing");
  if (!c.strict) problems.push("a STRICT table does not reject a value of the wrong type");
  if (!c.backup) problems.push("the online backup API does not work");
  return problems;
}

const valueOf = (conn: Connection, sql: string): unknown =>
  conn.prepare(sql).get<{ value: unknown }>()?.value;

/** Runs `probe` and returns its answer, or `fallback` when it throws. */
function attempt<T>(probe: () => T, fallback: T): T {
  try {
    return probe();
  } catch {
    return fallback;
  }
}

/** Whether `probe` held. A probe that throws did not hold. */
const holds = (probe: () => boolean): boolean => attempt(probe, false);

/** Probes the driver's SQLite through a private in-memory connection. Opens no file. */
export async function probeCapabilities(driver: SqliteDriver): Promise<Capabilities> {
  const conn = driver.open(MEMORY, { readOnly: false, busyTimeoutMs: 0, create: true });
  try {
    const version = attempt(() => {
      const v = valueOf(conn, PROBE_SQL.version);
      return typeof v === "string" ? v : "unknown";
    }, "unknown");
    const compileOptions = attempt(
      () =>
        conn
          .prepare(PROBE_SQL.compileOptions)
          .all()
          .map((row) => String(Object.values(row)[0])),
      [],
    );
    const fts5Compiled = holds(() => valueOf(conn, PROBE_SQL.fts5Option) === 1);
    const fts5Works = holds(() => {
      conn.exec(PROBE_SQL.fts5Create);
      try {
        conn.exec(PROBE_SQL.fts5Insert);
        return valueOf(conn, PROBE_SQL.fts5Match) === 1;
      } finally {
        conn.exec(PROBE_SQL.fts5Drop);
      }
    });
    const json = holds(() => valueOf(conn, PROBE_SQL.json) === 1);
    const strict = holds(() => {
      conn.exec(PROBE_SQL.strictCreate);
      try {
        conn.exec(PROBE_SQL.strictInsert);
        return false;
      } catch (error) {
        return error instanceof StorageError && error.code === "STORAGE_CONSTRAINT";
      } finally {
        conn.exec(PROBE_SQL.strictDrop);
      }
    });
    let backup = false;
    try {
      conn.exec(PROBE_SQL.backupSource);
      backup = (await driver.backup(conn, MEMORY, { pagesPerStep: SINGLE_STEP })) > 0;
    } catch {
      backup = false;
    }
    return {
      sqliteVersion: version,
      compileOptions,
      fts5Compiled,
      fts5Works,
      json,
      strict,
      backup,
    };
  } finally {
    conn.close();
  }
}

/** Every CheckedDriver that check() produced. Only check() adds to it. */
const passed = new WeakSet<object>();

/**
 * A driver that passed the start-up check. Space connections open only through one (open.ts).
 *
 * The private field makes the type nominal, so an object with the same fields is a type error.
 * JavaScript can still call the private constructor or build an object on the prototype, so
 * open.ts also asks isChecked(), which knows only the instances check() produced.
 */
export class CheckedDriver {
  readonly #driver: SqliteDriver;
  readonly report: DriverReport;

  private constructor(driver: SqliteDriver, report: DriverReport) {
    this.#driver = driver;
    this.report = report;
  }

  get driver(): SqliteDriver {
    return this.#driver;
  }

  /** Whether `value` is a CheckedDriver that check() produced. */
  static isChecked(value: unknown): value is CheckedDriver {
    return typeof value === "object" && value !== null && passed.has(value);
  }

  /**
   * Runs the start-up check. Rejects with STORAGE_UNSUPPORTED, naming every missing requirement,
   * when the driver's SQLite build cannot hold a space.
   */
  static async check(driver: SqliteDriver): Promise<CheckedDriver> {
    let capabilities: Capabilities;
    try {
      capabilities = await probeCapabilities(driver);
    } catch (error) {
      const code = error instanceof StorageError ? ` (${error.code})` : "";
      throw new StorageError(
        "STORAGE_UNSUPPORTED",
        `The ${driver.name} driver could not run the SQLite start-up check${code}`,
      );
    }
    const problems = capabilityProblems(capabilities);
    if (problems.length > 0) {
      throw new StorageError(
        "STORAGE_UNSUPPORTED",
        `Refusing to open spaces: the ${driver.name} driver's SQLite ` +
          `${capabilities.sqliteVersion} fails the start-up check: ${problems.join("; ")}`,
      );
    }
    const checked = new CheckedDriver(driver, {
      driver: driver.name,
      sqliteVersion: capabilities.sqliteVersion,
      compileOptions: capabilities.compileOptions,
    });
    passed.add(checked);
    return checked;
  }
}
