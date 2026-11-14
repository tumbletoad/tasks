// Simulated SQLite builds for the start-up check (A1 5: "the start-up check against a build
// without FTS5 (simulated), which must refuse to open"). A simulated build wraps a real driver and
// answers the probes the way a build that lacks one capability would. Nothing here imports
// vitest, so a test worker entry can load it.
import type {
  BackupOptions,
  Connection,
  NotPromise,
  OpenOptions,
  RunResult,
  SqliteDriver,
  Statement,
  TransactionMode,
} from "../src/driver.ts";
import { sqliteError, StorageError } from "../src/errors.ts";
import { PROBE_SQL } from "../src/startup-check.ts";

export const MISSING = ["fts5", "version", "json", "strict", "backup"] as const;
export type Missing = (typeof MISSING)[number];

/** The SQLite version the "version" build reports: one below A1's minimum of 3.45.0. */
export const OLD_VERSION = "3.44.2";

/** A statement that returns fixed rows. */
function fixed(rows: Record<string, unknown>[]): Statement {
  const result: RunResult = { changes: 0, lastInsertRowid: 0n };
  return {
    run: () => result,
    get: (() => rows[0]) as Statement["get"],
    all: (() => rows) as Statement["all"],
    iterate: (() => rows[Symbol.iterator]()) as Statement["iterate"],
  };
}

/** What the simulated build does with `sql`: undefined passes it to the real connection. */
function intercept(missing: Missing, sql: string, real: Connection): Statement | undefined {
  switch (missing) {
    case "fts5":
      if (/\busing\s+fts5\b/i.test(sql)) throw sqliteError(1); // "no such module: fts5"
      if (sql === PROBE_SQL.fts5Option) return fixed([{ value: 0 }]);
      if (sql === PROBE_SQL.compileOptions) {
        const options = real.prepare(sql).all<{ compile_options: string }>();
        return fixed(options.filter((o) => !o.compile_options.includes("FTS5")));
      }
      return undefined;
    case "version":
      return sql === PROBE_SQL.version ? fixed([{ value: OLD_VERSION }]) : undefined;
    case "json":
      if (/\bjson_\w+\s*\(/i.test(sql)) throw sqliteError(1); // "no such function: json_valid"
      return undefined;
    case "strict":
      // Before SQLite 3.37, STRICT is an unknown table option.
      if (/\)\s*strict\b/i.test(sql)) throw sqliteError(1); // "unknown table option: STRICT"
      return undefined;
    case "backup":
      return undefined;
  }
}

const inner = new WeakMap<Connection, Connection>();

class SimulatedConnection implements Connection {
  readonly #real: Connection;
  readonly #missing: Missing;

  constructor(real: Connection, missing: Missing) {
    this.#real = real;
    this.#missing = missing;
  }

  get inTransaction(): boolean {
    return this.#real.inTransaction;
  }

  exec(sql: string): void {
    if (intercept(this.#missing, sql, this.#real) === undefined) this.#real.exec(sql);
  }

  prepare(sql: string): Statement {
    return intercept(this.#missing, sql, this.#real) ?? this.#real.prepare(sql);
  }

  pragma(name: string, value?: string | number): unknown {
    return this.#real.pragma(name, value);
  }

  transaction<T>(mode: TransactionMode, fn: () => NotPromise<T>): T {
    return this.#real.transaction(mode, fn);
  }

  close(): void {
    this.#real.close();
  }
}

/** The driver as a build that lacks `missing` would behave. */
export function simulateBuild(driver: SqliteDriver, missing: Missing): SqliteDriver {
  return {
    name: driver.name,
    open(path: string, opts: OpenOptions): Connection {
      const real = driver.open(path, opts);
      const conn = new SimulatedConnection(real, missing);
      inner.set(conn, real);
      return conn;
    },
    async backup(src: Connection, destPath: string, opts: BackupOptions): Promise<number> {
      if (missing === "backup") {
        throw new StorageError("STORAGE_SQL", "simulated build without the backup API");
      }
      return driver.backup(inner.get(src) ?? src, destPath, opts);
    },
  };
}
