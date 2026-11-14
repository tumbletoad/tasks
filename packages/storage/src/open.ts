// Opening a space database as the writer or as a reader (A1 3.9), in the order the M0 storage
// bench proved: the busy timeout is in place before the first statement, because journal_mode
// reads the database and can find it locked by a connection that opens at the same moment. The
// driver installs it at open, and it is set again as the first statement, so a driver that
// ignored the option would still be covered. Then the role's pragmas, each read back. The caller
// opens the writer and lets it finish before any reader opens (worker/client.ts).
//
// The open comes in two halves, openUnconfigured and configureConnection, so a storage worker can
// stop between them: a writable connection is configured only once the process's claim holds the
// file SQLite opened (A1 3.9).
import type { Connection } from "./driver.ts";
import { misuse, StorageError } from "./errors.ts";
import { CheckedDriver } from "./startup-check.ts";

/** A1 3.9's busy timeout, for every connection. */
export const BUSY_TIMEOUT_MS = 5000;

export interface PragmaSetting {
  name: string;
  value: string | number;
  /** What `PRAGMA name` reads back once the value took. */
  expect: string | number;
}

/** The writer's pragmas after busy_timeout, in order (A1 3.9, A1-3). */
export const WRITER_PRAGMAS: readonly PragmaSetting[] = [
  { name: "journal_mode", value: "WAL", expect: "wal" },
  { name: "synchronous", value: "FULL", expect: 2 },
  { name: "foreign_keys", value: "ON", expect: 1 },
  { name: "temp_store", value: "MEMORY", expect: 2 },
  { name: "cache_size", value: -32000, expect: -32000 },
  { name: "trusted_schema", value: "OFF", expect: 0 },
];

/** A reader's pragmas after busy_timeout, in order: read-only plus query_only (A1 3.9). */
export const READER_PRAGMAS: readonly PragmaSetting[] = [
  { name: "query_only", value: 1, expect: 1 },
  { name: "temp_store", value: "MEMORY", expect: 2 },
  { name: "cache_size", value: -32000, expect: -32000 },
  { name: "trusted_schema", value: "OFF", expect: 0 },
];

export type Role = "writer" | "reader";

const ROLE_PRAGMAS: Record<Role, readonly PragmaSetting[]> = {
  writer: WRITER_PRAGMAS,
  reader: READER_PRAGMAS,
};

export interface SpaceOpenOptions {
  /** Writer only: create the database when it is missing. Default false. */
  create?: boolean;
  busyTimeoutMs?: number;
  /**
   * Writer only: file-format pragmas of a new, empty database, set after busy_timeout and before
   * the role's pragmas. auto_vacuum must come before journal_mode, which writes the header and
   * fixes it (space.ts).
   */
  formatPragmas?: readonly PragmaSetting[];
  /**
   * Writer only, for an existing database: runs before any pragma that persists. It runs after
   * busy_timeout and trusted_schema=OFF, which only configure the connection, and before
   * journal_mode=WAL, the one writer pragma that writes to the file. A database it refuses has had
   * no persistent pragma applied. This does not stop SQLite's own work at the hook's first read,
   * such as playing back a hot rollback journal, so openSpace runs its file-system checks in the
   * hook before that read (space.ts). A throw closes the connection and is passed on.
   */
  inspect?: (conn: Connection) => void;
}

const TRUSTED_SCHEMA_OFF: PragmaSetting = { name: "trusted_schema", value: "OFF", expect: 0 };

/** Sets each pragma and reads it back. A value that did not take refuses the connection. */
export function applyPragmas(conn: Connection, settings: readonly PragmaSetting[]): void {
  for (const { name, value, expect } of settings) {
    conn.pragma(name, value);
    const actual = conn.pragma(name);
    if (actual !== expect) {
      throw new StorageError(
        "STORAGE_UNSUPPORTED",
        `PRAGMA ${name} reads ${String(actual)} after setting it, expected ${String(expect)}`,
      );
    }
  }
}

/** The pragmas of `role`. The role can come from another thread, so it is checked at run time. */
function rolePragmas(role: Role): readonly PragmaSetting[] {
  const pragmas = (ROLE_PRAGMAS as Partial<Record<string, readonly PragmaSetting[]>>)[role];
  if (pragmas === undefined) throw misuse("A space connection is a writer or a reader");
  return pragmas;
}

/** Opens a connection to a space database for `role`, configured, or throws and leaves none open. */
export function openSpaceConnection(
  checked: CheckedDriver,
  path: string,
  role: Role,
  options: SpaceOpenOptions = {},
): Connection {
  return configureConnection(openUnconfigured(checked, path, role, options), role, options);
}

/**
 * The first half of openSpaceConnection: the driver opens (or creates) the file, and nothing runs
 * on the connection yet. The driver installs the busy timeout, which only configures the
 * connection. A storage worker takes the identity of the file SQLite opened here, and configures
 * the connection only once its process's claim holds that file (worker/client.ts).
 */
export function openUnconfigured(
  checked: CheckedDriver,
  path: string,
  role: Role,
  options: SpaceOpenOptions = {},
): Connection {
  // A build that failed the start-up check never touches a space file (A1 3.19), and neither does
  // an object that only looks like a checked driver.
  if (!CheckedDriver.isChecked(checked)) {
    throw misuse("A space opens only through a driver that passed the start-up check");
  }
  rolePragmas(role);
  const readOnly = role === "reader";
  // Options that do not fit the role are refused before the driver opens, or creates, the file.
  if (
    options.inspect !== undefined &&
    (readOnly || options.formatPragmas !== undefined || options.create === true)
  ) {
    throw misuse("Only the writer inspects an existing database before its pragmas");
  }
  if (readOnly && options.formatPragmas !== undefined) {
    throw misuse("Only the writer sets a new database's format pragmas");
  }
  return checked.driver.open(path, {
    readOnly,
    busyTimeoutMs: options.busyTimeoutMs ?? BUSY_TIMEOUT_MS,
    create: !readOnly && options.create === true,
  });
}

/**
 * The second half of openSpaceConnection: busy_timeout as the first statement, the inspection
 * hook, the format pragmas and the role's pragmas, each read back. A failure closes the
 * connection and is passed on.
 */
export function configureConnection(
  conn: Connection,
  role: Role,
  options: SpaceOpenOptions = {},
): Connection {
  const busyTimeoutMs = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  try {
    const pragmas = rolePragmas(role);
    applyPragmas(conn, [{ name: "busy_timeout", value: busyTimeoutMs, expect: busyTimeoutMs }]);
    if (options.inspect !== undefined) {
      // A file that has not passed inspection is not trusted to run functions from its schema.
      applyPragmas(conn, [TRUSTED_SCHEMA_OFF]);
      options.inspect(conn);
    }
    if (options.formatPragmas !== undefined) applyPragmas(conn, options.formatPragmas);
    applyPragmas(conn, pragmas);
  } catch (error) {
    // An open handle keeps the file locked on Windows, so a failed open closes it.
    try {
      conn.close();
    } catch {
      // The error on its way explains what went wrong.
    }
    throw error;
  }
  return conn;
}

export const openWriter = (
  checked: CheckedDriver,
  path: string,
  options: SpaceOpenOptions = {},
): Connection => openSpaceConnection(checked, path, "writer", options);

export const openReader = (
  checked: CheckedDriver,
  path: string,
  options: Omit<SpaceOpenOptions, "create" | "formatPragmas" | "inspect"> = {},
): Connection => openSpaceConnection(checked, path, "reader", options);
