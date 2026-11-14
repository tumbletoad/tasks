// A driver that fails one chosen statement of a migration, for the fault sweep of schema 0.2
// (A7 M3.01: "a fault injected at every statement boundary of the migration, not at one point").
// It wraps a real driver. Once armed, the next BEGIN IMMEDIATE on a writable connection is the
// migration's transaction: every statement run inside it (exec, a prepared statement's run, get,
// all or iterate, a pragma) counts as one boundary, and so does the moment after the last one,
// just before COMMIT. At the chosen boundary it throws SQLite's disk I/O error before the
// statement runs. With `refuseCommit`, SQLite itself refuses the COMMIT instead: a write statement
// is left in progress after the last boundary, which SQLite does not commit past, so the driver's
// own failed-COMMIT path runs. The product has no such hook: tests reach the runner through this
// driver only.
import type {
  BackupOptions,
  Connection,
  NotPromise,
  OpenOptions,
  Params,
  RunResult,
  SqliteDriver,
  Statement,
  TransactionMode,
} from "../../packages/storage/src/driver.ts";
import { sqliteError } from "../../packages/storage/src/errors.ts";

/** SQLITE_IOERR: what a disk that fails under a statement gives. */
const DISK_IO_ERROR = 10;

/** Which boundary fails, and what the sweep saw. */
export class StatementFault {
  /** The boundary to fail, from 0. Undefined: none fails, the boundaries are only counted. */
  failAt: number | undefined;
  /** Whether SQLite refuses the armed transaction's own COMMIT (see the top of the file). */
  refuseCommit = false;
  /** Set when the migration's transaction may begin: the runner's `backed-up` point. */
  armed = false;
  /** The boundaries the armed transaction reached. */
  count = 0;
  /** Whether the chosen boundary was reached and failed. */
  hit = false;
  /** Whether the armed transaction began. */
  began = false;
  /** What ran at each boundary: the SQL, `PRAGMA <name>`, or `COMMIT` for the last one. */
  trace: string[] = [];

  reset(failAt: number | undefined, refuseCommit = false): void {
    this.failAt = failAt;
    this.refuseCommit = refuseCommit;
    this.armed = false;
    this.count = 0;
    this.hit = false;
    this.began = false;
    this.trace = [];
  }
}

const inner = new WeakMap<Connection, Connection>();

class FaultingConnection implements Connection {
  readonly #real: Connection;
  readonly #fault: StatementFault;
  #inside = false;

  constructor(real: Connection, fault: StatementFault) {
    this.#real = real;
    this.#fault = fault;
  }

  get inTransaction(): boolean {
    return this.#real.inTransaction;
  }

  /** One boundary inside the migration's transaction: fails it when it is the chosen one. */
  #boundary(what: string): void {
    if (!this.#inside) return;
    const n = this.#fault.count;
    this.#fault.count += 1;
    this.#fault.trace.push(what);
    if (n === this.#fault.failAt) {
      this.#fault.hit = true;
      throw sqliteError(DISK_IO_ERROR);
    }
  }

  exec(sql: string): void {
    this.#boundary(sql);
    this.#real.exec(sql);
  }

  prepare(sql: string): Statement {
    const statement = this.#real.prepare(sql);
    const boundary = (): void => {
      this.#boundary(sql);
    };
    return {
      run(params?: Params): RunResult {
        boundary();
        return statement.run(params);
      },
      get: (params?: Params) => {
        boundary();
        return statement.get(params);
      },
      all: (params?: Params) => {
        boundary();
        return statement.all(params);
      },
      iterate: ((params?: Params) => {
        boundary();
        return statement.iterate(params);
      }) as Statement["iterate"],
    };
  }

  pragma(name: string, value?: string | number): unknown {
    this.#boundary(`PRAGMA ${name}`);
    return this.#real.pragma(name, value);
  }

  transaction<T>(mode: TransactionMode, fn: () => NotPromise<T>): T {
    if (mode !== "immediate" || !this.#fault.armed || this.#fault.began) {
      return this.#real.transaction(mode, fn);
    }
    this.#fault.began = true;
    let held: Iterator<unknown> | undefined;
    try {
      return this.#real.transaction(mode, () => {
        this.#inside = true;
        try {
          const result = fn();
          // The last boundary: every statement ran, COMMIT has not.
          this.#boundary("COMMIT");
          if (this.#fault.refuseCommit) {
            // A write statement stepped once and not finished: SQLite refuses to COMMIT past it.
            held = this.#real
              .prepare("UPDATE space SET one = one WHERE one = 1 RETURNING one")
              .iterate();
            held.next();
            this.#fault.hit = true;
          }
          return result;
        } finally {
          this.#inside = false;
        }
      });
    } finally {
      held?.return?.();
    }
  }

  close(): void {
    this.#real.close();
  }
}

/** `real`, with the migration's statements failing as `fault` says. */
export function faultingDriver(real: SqliteDriver, fault: StatementFault): SqliteDriver {
  return {
    name: real.name,
    open(path: string, opts: OpenOptions): Connection {
      const conn = real.open(path, opts);
      if (opts.readOnly) return conn;
      const wrapped = new FaultingConnection(conn, fault);
      inner.set(wrapped, conn);
      return wrapped;
    },
    backup(src: Connection, destPath: string, opts: BackupOptions): Promise<number> {
      return real.backup(inner.get(src) ?? src, destPath, opts);
    },
  };
}
