// Typed storage errors. Every driver turns its binding's errors into a StorageError, so callers
// never see a binding-specific error shape.
//
// No data reaches an error (AGENTS.md: no task text in logs). A binding's own message can carry a
// bound value (a trigger's RAISE(ABORT, NEW.title), an FTS5 query, an out-of-range integer) or SQL
// text, so a driver never passes it on: the message is a fixed text per SQLite result code with
// the codes as numbers, and the binding's error is not kept as a cause (A1 3.19). The SPACE_
// codes come from the space folder (space.ts) and name schema identifiers at most, never a value
// or a path.

export const STORAGE_ERROR_CODES = [
  /** SQLITE_BUSY or SQLITE_LOCKED after the busy timeout. Retryable with the same request (A1 3.9). */
  "STORAGE_BUSY",
  /** SQLITE_FULL or SQLITE_IOERR: the transaction did not become durable (A1 3.7). */
  "DURABILITY_FAILED",
  /** SQLITE_CORRUPT or SQLITE_NOTADB. */
  "STORAGE_CORRUPT",
  /** SQLITE_CANTOPEN: the file or its folder is missing, or not accessible. */
  "STORAGE_CANT_OPEN",
  /** SQLITE_READONLY: a write on a read-only or query_only connection. */
  "STORAGE_READ_ONLY",
  /** SQLITE_CONSTRAINT or SQLITE_MISMATCH, STRICT type errors included. */
  "STORAGE_CONSTRAINT",
  /** The start-up check refused the SQLite build, or a required pragma did not take (A1 3.19). */
  "STORAGE_UNSUPPORTED",
  /** The API was used wrongly: a closed connection, a nested transaction, a bad argument. */
  "STORAGE_MISUSE",
  /** The worker thread that held the connection failed or exited. */
  "STORAGE_WORKER_FAILED",
  /** Any other SQLite error, such as a syntax error. */
  "STORAGE_SQL",
  /** A space path breaks the path rules (space-path.ts): relative, a bad slug, a bad component. */
  "SPACE_PATH_INVALID",
  /** Creating a space found its folder already there. */
  "SPACE_EXISTS",
  /** No space at the path: the folder or its database is missing, or create found no parent. */
  "SPACE_NOT_FOUND",
  /** Not a valid space: another application's database, or a space row outside its domain. */
  "SPACE_INVALID",
  /** A newer space format or schema revision than this build may read, or write as the writer. */
  "SPACE_TOO_NEW",
  /** A schema revision this build never had (A1 3.17). */
  "SPACE_VERSION_UNKNOWN",
  /** space.json names another space than the database does, so the space opens read-only (A1 3.1). */
  "SPACE_ID_MISMATCH",
  /**
   * space.json exists but is not a manifest, or a safety field (space_id, format, min_reader,
   * min_writer) is missing or invalid. The writer refuses and never rewrites it (A1 3.1).
   */
  "SPACE_MANIFEST_DAMAGED",
  /**
   * The database or space.json changed while it was opening: between open's inspection and the
   * writer's open, or the database file went away right after SQLite opened it for a writer.
   */
  "SPACE_CHANGED",
  /**
   * A rollback journal (space.db-journal) lies beside the space's database. A space database is in
   * WAL mode, so the journal comes from a crash or another tool, and open refuses before SQLite
   * could play it back. Recovering the space is M1.06's (A1 3.18).
   */
  "SPACE_NEEDS_RECOVERY",
  /**
   * The schema revision is older than this build's and known to it. The writer opens only after
   * the migration runner moved the space to the latest revision (A1 3.17, migrate/runner.ts).
   */
  "SPACE_NEEDS_MIGRATION",
  /**
   * The space is a read-only copy, a backup restored into a new folder: it opens for readers, and
   * a writer is refused until the copy is claimed with a new epoch and incarnation (A1 3.18, A6
   * 3.5's `read_only_copy`).
   */
  "SPACE_READ_ONLY_COPY",
  /** A migration step failed. The transaction rolled back: the space stays at its revision. */
  "MIGRATION_FAILED",
  /**
   * A backup, or its verification, failed. A barrier backup's change did not start (A1 3.18).
   */
  "BACKUP_FAILED",
  /** A backup file or its sidecar does not verify: it is not restored (A1 3.18). */
  "BACKUP_INVALID",
  /** An archive passed a limit of the shared BundlePolicy (A1 3.18). The message names it. */
  "BUNDLE_LIMIT_EXCEEDED",
  /**
   * An export bundle breaks a rule of the archive or of its layout (an absolute path, `..`, a link,
   * an unknown file), or its content does not verify against its export.json (A1 3.18).
   */
  "BUNDLE_INVALID",
  /**
   * An export found a string shaped like a secret (A6 3.16.4), or a file from the secrets folder,
   * and wrote nothing. The message names the kind and the table and column, never the text.
   */
  "EXPORT_SECRET_FOUND",
  /**
   * A database has tables, indexes or views that the schema steps up to its revision do not create
   * (A1 3.18's exact-schema rule): an export refuses it before it writes anything, because a restore
   * would refuse its bundle. The message names no object.
   */
  "SPACE_SCHEMA_FOREIGN",
  /**
   * The space already has a writer in this process: the same database file by any name (its real
   * path, or its identity on its volume, before the open or as SQLite opened it), or the same
   * space ID in another folder (A1 3.9). Across processes, A2's
   * writer.lock refuses with SPACE_LOCKED_ELSEWHERE.
   */
  "SPACE_WRITER_TAKEN",
  /**
   * Another process holds the space's writer.lock (A2 3.4): a service of any state folder or OS
   * account, or a tool that opened the space for writing. Its writer.json names the holder.
   */
  "SPACE_LOCKED_ELSEWHERE",
  /**
   * The space's database file has a second name, a hard link or a symbolic link. writer.lock
   * guards a folder, so two folders that name one database would have two locks, and SQLite keeps
   * a -wal beside each name: such a space is never opened for writing.
   */
  "SPACE_DATABASE_LINKED",
  /** The writer's queue is full (A1 3.9: at most 1,000 requests wait). Retryable later. */
  "STORAGE_OVERLOADED",
  /**
   * The worker did not answer within the request's time limit (A1 3.9: 10 s). The request may
   * still be decided: retry it with the same request ID.
   */
  "STORAGE_TIMEOUT",
  /**
   * SQLite is recovering the space's WAL after a crash: another connection runs the recovery
   * (SQLITE_BUSY_RECOVERY), or a read-only connection found a WAL that needs it and cannot run it
   * (SQLITE_READONLY_RECOVERY). The writer's next open recovers it. Retryable shortly.
   */
  "STORAGE_RECOVERING",
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

/**
 * The state of the database a failed migration was tried on, which the migration runner reports
 * with its error (migrate/runner.ts): its revision and the one it was to reach (each as
 * user_version), the authority's epoch and incarnation, last_seq, and the barrier backup's name
 * when one was taken. The service records it, so that the same build does not try the same state
 * again by itself (A1 3.17). Numbers, an ID and a backup's name: no path, no value.
 */
export interface MigrationAttempt {
  from: number;
  to: number;
  epoch: number;
  incarnation: `ai_${string}`;
  lastSeq: number;
  backup?: string;
}

/** The form a StorageError takes on its way across a worker boundary. */
export interface SerializedStorageError {
  code: StorageErrorCode;
  message: string;
  sqliteCode?: number;
  attempt?: MigrationAttempt;
}

export class StorageError extends Error {
  override readonly name = "StorageError";
  readonly code: StorageErrorCode;
  /** SQLite's extended result code, when SQLite raised the error. */
  readonly sqliteCode: number | undefined;
  /** A failed migration's: the state it was tried on. */
  readonly attempt: MigrationAttempt | undefined;

  constructor(
    code: StorageErrorCode,
    message: string,
    options: { sqliteCode?: number | undefined; attempt?: MigrationAttempt | undefined } = {},
  ) {
    // Never a cause: a binding's error can carry data, and a cause prints with the error.
    super(message);
    this.code = code;
    this.sqliteCode = options.sqliteCode;
    this.attempt = options.attempt;
  }

  /** Whether the same request may be retried unchanged (A1 3.9). */
  get retryable(): boolean {
    return (
      this.code === "STORAGE_BUSY" ||
      this.code === "STORAGE_OVERLOADED" ||
      this.code === "STORAGE_TIMEOUT" ||
      this.code === "STORAGE_RECOVERING"
    );
  }

  toJSON(): SerializedStorageError {
    return {
      code: this.code,
      message: this.message,
      ...(this.sqliteCode === undefined ? {} : { sqliteCode: this.sqliteCode }),
      ...(this.attempt === undefined ? {} : { attempt: { ...this.attempt } }),
    };
  }

  static fromJSON(value: SerializedStorageError): StorageError {
    return new StorageError(value.code, value.message, {
      sqliteCode: value.sqliteCode,
      attempt: value.attempt,
    });
  }
}

/**
 * SPACE_ID_MISMATCH for a writer that named the space it is for (`SpaceWriterOptions.spaceId`):
 * the folder holds another space. It is refused before anything is claimed, locked or written. Its
 * own class, because SPACE_ID_MISMATCH also means a space.json that names another space than its
 * database (A1 3.1).
 */
export class UnexpectedSpace extends StorageError {
  constructor() {
    super("SPACE_ID_MISMATCH", "The folder holds another space than the one named");
  }
}

// SQLite's primary result codes (https://sqlite.org/rescode.html): the StorageError code, the
// name, and SQLite's own fixed text (sqlite3_errstr), which holds no data.
const PRIMARY: Partial<Record<number, [StorageErrorCode, string, string]>> = {
  1: ["STORAGE_SQL", "SQLITE_ERROR", "SQL logic error"],
  2: ["STORAGE_SQL", "SQLITE_INTERNAL", "internal error"],
  3: ["STORAGE_SQL", "SQLITE_PERM", "access permission denied"],
  4: ["STORAGE_SQL", "SQLITE_ABORT", "query aborted"],
  5: ["STORAGE_BUSY", "SQLITE_BUSY", "database is locked"],
  6: ["STORAGE_BUSY", "SQLITE_LOCKED", "database table is locked"],
  7: ["STORAGE_SQL", "SQLITE_NOMEM", "out of memory"],
  8: ["STORAGE_READ_ONLY", "SQLITE_READONLY", "attempt to write a readonly database"],
  9: ["STORAGE_SQL", "SQLITE_INTERRUPT", "interrupted"],
  10: ["DURABILITY_FAILED", "SQLITE_IOERR", "disk I/O error"],
  11: ["STORAGE_CORRUPT", "SQLITE_CORRUPT", "database disk image is malformed"],
  12: ["STORAGE_SQL", "SQLITE_NOTFOUND", "unknown operation"],
  13: ["DURABILITY_FAILED", "SQLITE_FULL", "database or disk is full"],
  14: ["STORAGE_CANT_OPEN", "SQLITE_CANTOPEN", "unable to open database file"],
  15: ["STORAGE_SQL", "SQLITE_PROTOCOL", "locking protocol"],
  17: ["STORAGE_SQL", "SQLITE_SCHEMA", "database schema has changed"],
  18: ["STORAGE_SQL", "SQLITE_TOOBIG", "string or blob too big"],
  19: ["STORAGE_CONSTRAINT", "SQLITE_CONSTRAINT", "constraint failed"],
  20: ["STORAGE_CONSTRAINT", "SQLITE_MISMATCH", "datatype mismatch"],
  21: ["STORAGE_MISUSE", "SQLITE_MISUSE", "bad parameter or other API misuse"],
  23: ["STORAGE_SQL", "SQLITE_AUTH", "authorization denied"],
  25: ["STORAGE_MISUSE", "SQLITE_RANGE", "column index out of range"],
  26: ["STORAGE_CORRUPT", "SQLITE_NOTADB", "file is not a database"],
};

// The extended constraint codes, which say which kind of constraint failed.
const CONSTRAINT_KINDS: Partial<Record<number, string>> = {
  1: "CHECK",
  2: "COMMITHOOK",
  3: "FOREIGNKEY",
  4: "FUNCTION",
  5: "NOTNULL",
  6: "PRIMARYKEY",
  7: "TRIGGER",
  8: "UNIQUE",
  9: "VTAB",
  10: "ROWID",
  11: "PINNED",
  12: "DATATYPE",
};

/**
 * The extended codes of a crash recovery that can still reach a caller, which their primary codes
 * would report as STORAGE_READ_ONLY and STORAGE_BUSY (A1 3.19). A hot
 * rollback journal that appears after open's check (SQLITE_READONLY_ROLLBACK) needs M1.06's
 * recovery, as open's own check says. A WAL that needs its recovery is a passing state.
 */
const EXTENDED: Partial<Record<number, [StorageErrorCode, string, string]>> = {
  [5 | (1 << 8)]: ["STORAGE_RECOVERING", "SQLITE_BUSY_RECOVERY", "database is being recovered"],
  [8 | (1 << 8)]: [
    "STORAGE_RECOVERING",
    "SQLITE_READONLY_RECOVERY",
    "database needs a recovery a read-only connection cannot run",
  ],
  [8 | (3 << 8)]: [
    "SPACE_NEEDS_RECOVERY",
    "SQLITE_READONLY_ROLLBACK",
    "database has a hot journal a read-only connection cannot roll back",
  ],
};

/**
 * The StorageError for an error SQLite raised, built from its extended result code alone. The
 * native message is never read: a trigger's RAISE message can be a bound value, and a value
 * shaped like an identifier cannot be told from a literal the trigger's author wrote.
 */
export function sqliteError(sqliteCode: number): StorageError {
  const extended = EXTENDED[sqliteCode];
  if (extended !== undefined) {
    const [code, name, text] = extended;
    return new StorageError(code, `SQLite: ${text} (${name}, code ${String(sqliteCode)})`, {
      sqliteCode,
    });
  }
  const primary = sqliteCode & 0xff;
  const [code, name, text] = PRIMARY[primary] ?? ["STORAGE_SQL", "SQLITE_ERROR", "unknown error"];
  const kind = primary === 19 ? CONSTRAINT_KINDS[sqliteCode >> 8] : undefined;
  const label = kind === undefined ? name : `${name}_${kind}`;
  return new StorageError(code, `SQLite: ${text} (${label}, code ${String(sqliteCode)})`, {
    sqliteCode,
  });
}

export const misuse = (message: string): StorageError =>
  new StorageError("STORAGE_MISUSE", message);
