// Every connection the bench opens is released on every path, failures included: an open handle
// keeps the database file locked on Windows, so the run folder could not be removed afterwards.
import type { DatabaseSync } from "node:sqlite";

/** Rolls back an open transaction and closes the connection. Safe to call twice. */
export function closeConnection(db: DatabaseSync): void {
  if (!db.isOpen) return;
  try {
    if (db.isTransaction) db.exec("ROLLBACK");
  } finally {
    db.close();
  }
}

/**
 * Closes connections after a failure. Errors while closing are dropped, because the failure that
 * is already on its way explains what went wrong.
 */
export function closeAfterFailure(...dbs: DatabaseSync[]): void {
  for (const db of dbs) {
    try {
      closeConnection(db);
    } catch {
      // See above.
    }
  }
}

/**
 * Runs `fn` with the connection, then rolls back what is still open and closes it. When `fn`
 * throws, its error is the one reported, even if closing fails as well.
 */
export function withConnection<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
  let result: T;
  try {
    result = fn(db);
  } catch (error) {
    closeAfterFailure(db);
    throw error;
  }
  closeConnection(db);
  return result;
}
