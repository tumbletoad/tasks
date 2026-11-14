// The storage adapter of A1 3.19. Domain and repository code use these interfaces, and only the
// driver modules import a SQLite binding. The interfaces are synchronous: a connection lives in
// one worker thread (A1 3.9), and the main thread reaches it through the worker protocol in
// worker/. Every method throws StorageError, never a binding's own error.
import { misuse, type StorageError } from "./errors.ts";

export type DriverName = "node:sqlite" | "better-sqlite3";

export interface OpenOptions {
  readOnly: boolean;
  /** Installed when the connection opens, before any statement runs (the M0 bench's lesson). */
  busyTimeoutMs: number;
  /**
   * Create the file when it is missing. Without it a missing file fails with STORAGE_CANT_OPEN
   * and nothing is created, so a space whose database went missing never reopens empty. Ignored
   * for read-only connections, which never create a file.
   */
  create?: boolean;
}

export interface BackupOptions {
  /**
   * Pages per backup step. A single-step backup passes SINGLE_STEP. Never -1: backup() refuses a
   * step below 1.
   */
  pagesPerStep: number;
}

/** A page count larger than any database, so a backup copies everything in one step. */
export const SINGLE_STEP = 2_147_483_647;

/** The path that opens, or backs up into, a private in-memory database. */
export const MEMORY = ":memory:";

/**
 * Every file name a driver hands SQLite is the literal path of sqlite-uri.ts, and its SQL names no
 * file (A1 3.19).
 */
export interface SqliteDriver {
  readonly name: DriverName;
  /**
   * Opens `path`, which is a path and never a URI, through its literal path. On the connection,
   * ATTACH of any name but the empty one, and so VACUUM INTO, fail with SQLITE_AUTH (STORAGE_SQL).
   */
  open(path: string, opts: OpenOptions): Connection;
  /**
   * Copies the main database of `src` to `destPath` and resolves to the number of pages copied.
   * `destPath` is a new file: one that does not exist, or an empty file with no other name that
   * the caller created for the backup. Any other file is refused with STORAGE_MISUSE.
   */
  backup(src: Connection, destPath: string, opts: BackupOptions): Promise<number>;
}

export interface Connection {
  /**
   * Runs one or more statements without parameters. SQL with a placeholder is refused before any
   * of it runs, because SQLite would bind NULL to it.
   */
  exec(sql: string): void;
  /**
   * Prepares one statement. The connection caches statements by SQL text, so the same text
   * returns the same statement. Text after the first statement, other than comments, is refused.
   */
  prepare(sql: string): Statement;
  /**
   * Runs `PRAGMA name` or `PRAGMA name = value` and returns the first column of the first row,
   * or undefined when the pragma returns no row. The name is a plain identifier and the value a
   * number or a plain keyword, so no SQL can be smuggled in.
   */
  pragma(name: string, value?: string | number): unknown;
  /**
   * BEGIN IMMEDIATE or BEGIN DEFERRED, then `fn`, then COMMIT. ROLLBACK when `fn` throws, and the
   * error is rethrown unchanged. Transactions do not nest.
   *
   * `fn` is synchronous: its type rejects a function that returns a promise, and an async or
   * generator function is refused before it runs. A promise or thenable returned anyway is rolled
   * back and given a rejection handler, and the connection is invalidated: every later call on it
   * fails with STORAGE_MISUSE until it is closed, so the promise's continuation cannot write.
   */
  transaction<T>(mode: TransactionMode, fn: () => NotPromise<T>): T;
  readonly inTransaction: boolean;
  /** Rolls back an open transaction and closes the connection. Safe to call twice. */
  close(): void;
}

export type TransactionMode = "immediate" | "deferred";

/** `T`, unless it is a promise: a transaction function's return type (A1 3.19). */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * What run() reports (A1 3.19). The last rowid is always a bigint, so a rowid beyond 2^53
 * converts without loss and without failing after the write committed. `changes` is a number: a
 * statement cannot change 2^53 rows, because SQLite cannot hold that many, so it is exact.
 */
export interface RunResult {
  changes: number;
  lastInsertRowid: bigint;
}

/**
 * A value a parameter binds. A bigint binds as an exact 64-bit integer. NaN is refused, because
 * SQLite would store it as NULL.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * Named parameters. SQL uses $name (or :name, @name), objects use bare keys. Every name the
 * statement uses must be given (null is a value), and no other key, or the call is refused with
 * STORAGE_MISUSE before anything runs.
 */
export type Params = Record<string, SqlValue>;

/**
 * A row. An INTEGER reads as a number when it lies within ±(2^53 − 1) and as a bigint beyond, so
 * no integer is rounded and no read fails because of its size (A1 3.19).
 */
export type Row = Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters --
   A1 3.19's interface: the row type is the caller's statement about its own SQL. */
export interface Statement {
  run(params?: Params): RunResult;
  get<T = Row>(params?: Params): T | undefined;
  all<T = Row>(params?: Params): T[];
  /**
   * Rows one at a time. The statement holds a read snapshot until the iteration ends: when it
   * runs out, or on break, return or throw in a for…of loop, or a call to return(). An iterator
   * left unfinished holds it until the statement's next use or the connection closes.
   */
  iterate<T = Row>(params?: Params): IterableIterator<T>;
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

const BEGIN: Record<TransactionMode, string> = {
  immediate: "BEGIN IMMEDIATE",
  deferred: "BEGIN DEFERRED",
};

/**
 * Functions whose body runs later than the call: after an await, or when the returned generator
 * is iterated. The tag survives bind() and a Proxy, and is the same in every realm. A plain
 * function that returns a promise, or async code compiled down to plain functions, cannot be
 * told apart before the call: runTransaction catches those by their return value.
 */
const DEFERRED_BODIES = new Set([
  "[object AsyncFunction]",
  "[object GeneratorFunction]",
  "[object AsyncGeneratorFunction]",
]);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

const inTransaction = (conn: Pick<Connection, "inTransaction">): boolean => conn.inTransaction;

/** The connection a transaction runs on, as runTransaction needs it. */
export interface TransactionHost {
  exec(sql: string): void;
  readonly inTransaction: boolean;
  /** Makes every later call on the connection fail with `reason` until it is closed. */
  invalidate(reason: StorageError): void;
}

/**
 * The transaction rule every driver shares (A1 3.19): BEGIN … COMMIT, ROLLBACK on throw, and no
 * asynchronous function. A driver's Connection.transaction calls this.
 */
export function runTransaction<T>(
  conn: TransactionHost,
  mode: TransactionMode,
  fn: () => NotPromise<T>,
): T {
  // The mode can come from another thread, so it is checked at run time too.
  const begin = (BEGIN as Partial<Record<string, string>>)[mode];
  if (begin === undefined) throw misuse("Unknown transaction mode");
  if (DEFERRED_BODIES.has(Object.prototype.toString.call(fn))) {
    throw misuse("A transaction function must be synchronous, not an async or generator function");
  }
  if (conn.inTransaction) throw misuse("A transaction is already open on this connection");
  conn.exec(begin);
  let abandoned: StorageError | undefined;
  try {
    const result: unknown = fn();
    if (isThenable(result)) {
      // Nothing may stay unhandled, and nothing the promise does later may reach the database.
      Promise.resolve(result).then(undefined, () => undefined);
      abandoned = misuse("A transaction function must be synchronous. It returned a promise");
      throw abandoned;
    }
    conn.exec("COMMIT");
    return result as T;
  } catch (error) {
    // COMMIT itself can fail and leave the transaction open (SQLITE_BUSY), and some errors make
    // SQLite roll back on its own, so roll back only what is still open. (Read through a call:
    // the check above narrowed the property, but the statements since then changed it.)
    if (inTransaction(conn)) {
      try {
        conn.exec("ROLLBACK");
      } catch {
        // The error on its way explains what went wrong.
      }
    }
    if (abandoned !== undefined) {
      conn.invalidate(
        misuse(
          "This connection was invalidated: a transaction function returned a promise. Close it",
        ),
      );
    }
    throw error;
  }
}

const PRAGMA_NAME = /^[a-z_]+$/i;
const PRAGMA_KEYWORD = /^[a-z_][a-z0-9_]*$/i;

/** The text of `PRAGMA name [= value]`, after checking that it holds nothing but those. */
export function pragmaSql(name: string, value?: string | number): string {
  if (!PRAGMA_NAME.test(name)) throw misuse("A pragma name must be a plain identifier");
  if (value === undefined) return `PRAGMA ${name}`;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw misuse("A numeric pragma value must be an integer");
    return `PRAGMA ${name} = ${String(value)}`;
  }
  if (!PRAGMA_KEYWORD.test(value)) throw misuse("A pragma value must be a number or a keyword");
  return `PRAGMA ${name} = ${value}`;
}

/** Checks the options every driver's open() receives. */
export function checkOpenOptions(opts: OpenOptions): void {
  if (!Number.isSafeInteger(opts.busyTimeoutMs) || opts.busyTimeoutMs < 0) {
    throw misuse("busyTimeoutMs must be a non-negative integer");
  }
}

/** Checks backup options. node:sqlite refuses a rate below 1, and -1 means nothing to it. */
export function checkBackupOptions(opts: BackupOptions): void {
  const n = opts.pagesPerStep;
  if (!Number.isSafeInteger(n) || n < 1 || n > SINGLE_STEP) {
    throw misuse(`pagesPerStep must be an integer from 1 to ${String(SINGLE_STEP)}`);
  }
}
