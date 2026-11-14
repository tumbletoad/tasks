// The primary driver: node:sqlite in the pinned Node runtime (A1 3.19). The only
// module in the repository that imports node:sqlite, apart from lab code in spikes/.
//
// Node 26 exports the class as `Database` and keeps `DatabaseSync` as a deprecated alias
// (DEP0210). The driver takes whichever the runtime exports. Options used: readOnly, timeout
// (the busy timeout, installed before any statement runs), enableForeignKeyConstraints, and
// defensive, which stays on. A file name reaches SQLite only through sqlite-uri.ts, and an
// authorizer keeps SQL from naming one (ATTACH, VACUUM INTO). Extension loading stays off, as
// node:sqlite leaves it. Every statement reads integers as bigints, and the driver turns the
// ones within ±(2^53 − 1) back into numbers, so no integer is rounded and no conversion fails
// after a write (A1 3.19).
import * as sqlite from "node:sqlite";
import {
  checkBackupOptions,
  checkOpenOptions,
  pragmaSql,
  runTransaction,
  type BackupOptions,
  type Connection,
  type NotPromise,
  type OpenOptions,
  type Params,
  type Row,
  type RunResult,
  type SqliteDriver,
  type SqlValue,
  type Statement,
  type TransactionHost,
  type TransactionMode,
} from "./driver.ts";
import { misuse, sqliteError, StorageError } from "./errors.ts";
import { isTrivia, namedParameters, PARAMETER_NAME, placeholders } from "./sql-text.ts";
import { backupTarget, sqliteUri } from "./sqlite-uri.ts";

const binding = sqlite as typeof sqlite & { Database?: typeof sqlite.DatabaseSync };
const NativeDatabase = binding.Database ?? binding.DatabaseSync;
type NativeDb = InstanceType<typeof NativeDatabase>;
type NativeStatement = ReturnType<NativeDb["prepare"]>;
type NativeParams = Record<string, string | number | bigint | null | Uint8Array>;

/** Statements kept per connection. The writer's working set is small, so this is generous. */
const STATEMENT_CACHE_LIMIT = 256;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;
const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);
const NODE_ERROR_CODE = /^ERR_[A-Z0-9_]{1,60}$/;

/**
 * Turns whatever node:sqlite threw into a StorageError with a fixed message (errors.ts). The
 * native message is never read and the native error is not kept.
 */
function toStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  if (error instanceof Error) {
    const { code, errcode } = error as Error & { code?: unknown; errcode?: unknown };
    if (code === "ERR_SQLITE_ERROR" && typeof errcode === "number") {
      return sqliteError(errcode);
    }
    // ERR_INVALID_STATE, ERR_INVALID_ARG_TYPE and the like: a caller's bug. Node's message can
    // quote the argument, so only the code goes on.
    if (typeof code === "string" && NODE_ERROR_CODE.test(code)) {
      return new StorageError("STORAGE_MISUSE", `node:sqlite refused the call (${code})`);
    }
    return new StorageError("STORAGE_SQL", "node:sqlite failed with an unexpected error");
  }
  return new StorageError("STORAGE_SQL", "node:sqlite threw a non-error value");
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw toStorageError(error);
  }
}

/** An integer as the interface returns it: a number when it is safe, else the exact bigint. */
const exact = (value: unknown): unknown =>
  typeof value === "bigint" && value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value;

/** A native row with its integers made exact. Rows are fresh objects, so this edits in place. */
function exactRow(row: unknown): Row {
  const record = row as Row;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value === "bigint") record[key] = exact(value);
  }
  return record;
}

const shown = (name: string): string => (PARAMETER_NAME.test(name) ? name : "(unprintable)");

/** Checks one parameter value. Anything else would bind wrongly or not at all. */
function checkValue(name: string, value: SqlValue | undefined): void {
  if (value === undefined) throw misuse(`The parameter ${shown(name)} has no value`);
  if (value === null || typeof value === "string" || value instanceof Uint8Array) return;
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw misuse(`The parameter ${shown(name)} is NaN`);
    return;
  }
  if (typeof value === "bigint") {
    if (value < INT64_MIN || value > INT64_MAX) {
      throw misuse(`The parameter ${shown(name)} does not fit in a 64-bit integer`);
    }
    return;
  }
  throw misuse(`The parameter ${shown(name)} is not a SQL value`);
}

class NodeStatement implements Statement {
  readonly #stmt: NativeStatement;
  readonly #names: ReadonlySet<string>;
  readonly #usable: () => void;
  /**
   * Counts the executions of this statement. SQLite has one execution per prepared statement:
   * starting another resets the first. An iteration remembers the number it started with, so an
   * earlier iteration can neither advance nor reset the execution that replaced it.
   */
  #execution = 0;

  constructor(stmt: NativeStatement, names: readonly string[], usable: () => void) {
    this.#stmt = stmt;
    this.#names = new Set(names);
    this.#usable = usable;
  }

  /**
   * The parameters to bind, checked before anything runs: every name the statement uses, and
   * nothing else. Undefined when the statement takes none.
   */
  #bind(params: Params | undefined): NativeParams | undefined {
    this.#usable();
    const keys = params === undefined ? [] : Object.keys(params);
    for (const key of keys) {
      if (!this.#names.has(key)) {
        throw misuse(`The statement has no parameter named ${shown(key)}`);
      }
    }
    if (this.#names.size === 0) return undefined;
    const bound: NativeParams = Object.create(null) as NativeParams;
    for (const name of this.#names) {
      const value = params !== undefined && Object.hasOwn(params, name) ? params[name] : undefined;
      checkValue(name, value);
      bound[name] = value as SqlValue;
    }
    return bound;
  }

  run(params?: Params): RunResult {
    const bound = this.#bind(params);
    this.#execution += 1;
    const result = guard(() => (bound === undefined ? this.#stmt.run() : this.#stmt.run(bound)));
    // Both are bigints (setReadBigInts), so neither conversion can fail after the write.
    return {
      changes: Number(result.changes),
      lastInsertRowid: BigInt(result.lastInsertRowid),
    };
  }

  /* eslint-disable @typescript-eslint/no-unnecessary-type-parameters --
     The generic methods of A1 3.19's Statement interface. */
  get<T = Row>(params?: Params): T | undefined {
    const bound = this.#bind(params);
    this.#execution += 1;
    const row = guard(() => (bound === undefined ? this.#stmt.get() : this.#stmt.get(bound)));
    return (row === undefined ? undefined : exactRow(row)) as T | undefined;
  }

  all<T = Row>(params?: Params): T[] {
    const bound = this.#bind(params);
    this.#execution += 1;
    const rows = guard(() => (bound === undefined ? this.#stmt.all() : this.#stmt.all(bound)));
    return rows.map(exactRow) as T[];
  }

  iterate<T = Row>(params?: Params): IterableIterator<T> {
    // The parameters are checked now, the rows read when asked for.
    return this.#rows<T>(this.#bind(params));
  }

  *#rows<T>(bound: NativeParams | undefined): Generator<T, undefined, undefined> {
    const mine = (this.#execution += 1);
    const rows = guard(() =>
      bound === undefined ? this.#stmt.iterate() : this.#stmt.iterate(bound),
    );
    try {
      for (;;) {
        this.#usable();
        if (this.#execution !== mine) {
          throw misuse("The iteration ended when its statement was used again");
        }
        const next = guard(() => rows.next());
        if (next.done === true) return undefined;
        yield exactRow(next.value) as T;
      }
    } finally {
      // Reset the statement whichever way the iteration ended (break, return, throw), so it
      // does not keep its read snapshot and hold back WAL checkpoints. Only while this iteration
      // still owns the execution: resetting a later one would make it run again from the start,
      // and an INSERT ... RETURNING would insert twice.
      if (this.#execution === mine) {
        try {
          rows.return?.();
        } catch {
          // A closed connection has nothing left to reset.
        }
      }
    }
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */
}

/**
 * Confirms the scan of a statement's placeholders against SQLite (sql-text.ts). It binds a
 * distinct integer to each scanned name (node:sqlite refuses a name the statement lacks) and asks
 * SQLite to expand the statement (sqlite3_expanded_sql, which finds placeholders with SQLite's own
 * tokenizer). The expansion must equal the text with each scanned placeholder replaced by its
 * integer: a placeholder the scan missed would read NULL, a false one would stay unreplaced.
 */
function confirmParameters(stmt: NativeStatement, source: string): readonly string[] {
  const { names, placeholders: found } = namedParameters(source);
  const markers = new Map(names.map((name, index) => [name, BigInt(index + 1)]));
  let expected = "";
  let from = 0;
  for (const p of found) {
    expected += `${source.slice(from, p.start)}${String(markers.get(p.name))}`;
    from = p.end;
  }
  expected += source.slice(from);
  const rows =
    names.length === 0
      ? undefined
      : guard(() => stmt.iterate(Object.fromEntries(markers) as NativeParams));
  try {
    if (guard(() => stmt.expandedSQL) !== expected) {
      throw misuse("SQLite reads this statement's parameters differently from the driver");
    }
  } finally {
    rows?.return?.();
  }
  return names;
}

/** The native database behind each connection, for backup(). Not reachable from outside. */
const natives = new WeakMap<Connection, NativeDb>();

class NodeConnection implements Connection {
  readonly #db: NativeDb;
  readonly #statements = new Map<string, NodeStatement>();
  #invalid: StorageError | undefined;
  readonly #usable = (): void => {
    if (this.#invalid !== undefined) throw this.#invalid;
    if (!this.#db.isOpen) throw misuse("The connection is closed");
  };
  /** What runTransaction drives: the native exec, and a way to invalidate this connection. */
  readonly #host: TransactionHost;

  constructor(db: NativeDb) {
    this.#db = db;
    this.#host = {
      exec: (sql) => {
        guard(() => {
          db.exec(sql);
        });
      },
      get inTransaction() {
        return db.isOpen && db.isTransaction;
      },
      invalidate: (reason) => {
        this.#invalid = reason;
      },
    };
  }

  get inTransaction(): boolean {
    return this.#db.isOpen && this.#db.isTransaction;
  }

  exec(sql: string): void {
    this.#usable();
    if (typeof sql !== "string") throw misuse("exec() takes SQL text");
    if (sql.includes("\0")) throw misuse("SQL text cannot contain a NUL character");
    if (placeholders(sql).length > 0) {
      throw misuse("exec() runs SQL without parameters: prepare a statement with a placeholder");
    }
    guard(() => {
      this.#db.exec(sql);
    });
  }

  prepare(sql: string): Statement {
    this.#usable();
    const cached = this.#statements.get(sql);
    if (cached !== undefined) {
      // Most recently used goes last, so the first key is the one to evict.
      this.#statements.delete(sql);
      this.#statements.set(sql, cached);
      return cached;
    }
    if (typeof sql !== "string") throw misuse("prepare() takes SQL text");
    if (sql.includes("\0")) throw misuse("SQL text cannot contain a NUL character");
    const native = guard(() => this.#db.prepare(sql));
    // SQLite prepares the first statement and returns the rest unread: refuse a second one.
    const source = guard(() => native.sourceSQL);
    if (!sql.startsWith(source) || !isTrivia(sql.slice(source.length))) {
      throw misuse("prepare() takes one statement");
    }
    native.setReadBigInts(true);
    const statement = new NodeStatement(native, confirmParameters(native, source), this.#usable);
    if (this.#statements.size >= STATEMENT_CACHE_LIMIT) {
      const oldest = this.#statements.keys().next();
      if (oldest.done !== true) this.#statements.delete(oldest.value);
    }
    this.#statements.set(sql, statement);
    return statement;
  }

  pragma(name: string, value?: string | number): unknown {
    this.#usable();
    const sql = pragmaSql(name, value);
    const row = guard(() => {
      const native = this.#db.prepare(sql);
      native.setReadBigInts(true);
      return native.get();
    });
    return row === undefined ? undefined : exact(Object.values(row)[0]);
  }

  transaction<T>(mode: TransactionMode, fn: () => NotPromise<T>): T {
    this.#usable();
    return runTransaction<T>(this.#host, mode, fn);
  }

  close(): void {
    if (!this.#db.isOpen) return;
    this.#statements.clear();
    try {
      if (this.#db.isTransaction) {
        guard(() => {
          this.#db.exec("ROLLBACK");
        });
      }
    } finally {
      guard(() => {
        this.#db.close();
      });
    }
  }
}

const { SQLITE_ATTACH, SQLITE_DENY, SQLITE_OK, SQLITE_PRAGMA } = sqlite.constants;

/** The pragmas that name a folder for SQLite's files, for every connection in the process. */
const FOLDER_PRAGMAS: ReadonlySet<string> = new Set([
  "temp_store_directory",
  "data_store_directory",
]);

/**
 * The authorizer every connection gets before its first statement: SQL names no file (A1
 * 3.19). SQLite asks it while it prepares a statement, after its own parser
 * has read the statement, so case, comments, quotes and a string of several statements change
 * nothing. ATTACH is refused (SQLITE_AUTH) for every name but the empty one, SQLite's private
 * temporary database: a name in a string, an expression or a parameter (which the authorizer sees
 * as null), a URI and :memory: alike. VACUUM INTO attaches its target the same way when it runs,
 * so it is refused too, while VACUUM, which attaches the empty name, still runs. The pragmas that
 * set a folder for SQLite's files are refused as well.
 */
const namesNoFile = (action: number, name: string | null): number =>
  (action === SQLITE_ATTACH && name !== "") ||
  (action === SQLITE_PRAGMA && name !== null && FOLDER_PRAGMAS.has(name.toLowerCase()))
    ? SQLITE_DENY
    : SQLITE_OK;

export const nodeSqliteDriver: SqliteDriver = {
  name: "node:sqlite",

  open(path: string, opts: OpenOptions): Connection {
    checkOpenOptions(opts);
    const mode = opts.readOnly ? "ro" : opts.create === true ? "rwc" : "rw";
    // sqliteUri refuses what is not a path before anything opens.
    const name = sqliteUri(path, mode);
    const db = guard(
      () =>
        new NativeDatabase(name, {
          readOnly: opts.readOnly,
          timeout: opts.busyTimeoutMs,
          enableForeignKeyConstraints: true,
          defensive: true,
        }),
    );
    try {
      guard(() => {
        db.setAuthorizer(namesNoFile);
      });
    } catch (error) {
      db.close();
      throw error;
    }
    const conn = new NodeConnection(db);
    natives.set(conn, db);
    return conn;
  },

  async backup(src: Connection, destPath: string, opts: BackupOptions): Promise<number> {
    checkBackupOptions(opts);
    const db = natives.get(src);
    if (db === undefined) throw misuse("backup() needs a connection opened by this driver");
    // A new file only, written through its literal path (sqlite-uri.ts).
    const target = backupTarget(destPath);
    try {
      return await sqlite.backup(db, target, { rate: opts.pagesPerStep });
    } catch (error) {
      throw toStorageError(error);
    }
  },
};
