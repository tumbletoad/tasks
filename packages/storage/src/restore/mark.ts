// A restore's first write on a copy in its staging folder (A1 3.18): the read-only mark of a copy
// restored into a new folder, with the triggers dropped before it. A restore in place's first write
// is its claim (claim.ts), after the same drop (restore.ts).
//
// The mark is `space.transfer` = `{state: "restored_copy", at}`: every open of the copy is then
// read-only with the reason `read_only_copy` until it is claimed (A6 3.5). It writes no commit: the
// space row has no history (A1 3.4), and the copy's history stays the backup's.
import type { Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { openWriter } from "../open.ts";
import { decodeSpaceRow, type SpaceRow } from "../rows.ts";
import type { CheckedDriver } from "../startup-check.ts";

/** The state `space.transfer` holds for a read-only copy (A6 3.5's `read_only_copy`). */
export const READ_ONLY_COPY = "restored_copy";

/**
 * Drops every trigger of a restored database, inside the caller's write transaction, before the
 * restore's first write. Tasks' schema has none (A1 3.4); one in a copied or crafted database would
 * run on the restore's own writes, and could clear the read-only mark or undo a claim.
 */
export function dropTriggers(conn: Connection): void {
  const names = conn
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'")
    .all<{ name: unknown }>();
  for (const { name } of names) {
    conn.exec(`DROP TRIGGER IF EXISTS "${String(name).replaceAll('"', '""')}"`);
  }
}

/**
 * Marks the space on `conn`, a writer on a restored copy in its staging folder, as a read-only
 * copy, its triggers dropped first in the same transaction. Returns the marked row, which must
 * hold the mark.
 */
export function markReadOnlyCopy(conn: Connection, now: number): SpaceRow {
  return conn.transaction("immediate", () => {
    dropTriggers(conn);
    conn
      .prepare("UPDATE space SET transfer = $transfer WHERE one = 1")
      .run({ transfer: JSON.stringify({ state: READ_ONLY_COPY, at: now }) });
    const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
    if (space.transfer?.["state"] !== READ_ONLY_COPY) {
      throw new StorageError("SPACE_INVALID", "The restored copy did not keep its read-only mark");
    }
    return space;
  });
}

/**
 * The first write on the unpacked copy `db`, which no other connection has open: the mark through
 * its own writer, whose close checkpoints the -wal into the file. A refusal by the copy itself (a
 * definition that fails the write, or a mark it did not keep) is the source's fault: `invalid`,
 * with the cause's code. A full or failing disk (DURABILITY_FAILED) is not, and passes on.
 */
export function markCopy(
  checked: CheckedDriver,
  db: string,
  now: number,
  options: { busyTimeoutMs?: number },
  invalid: (why: string) => StorageError,
): SpaceRow {
  try {
    const conn = openWriter(checked, db, options);
    try {
      return markReadOnlyCopy(conn, now);
    } finally {
      // The last connection to close checkpoints the -wal into the file and removes it.
      conn.close();
    }
  } catch (error) {
    if (error instanceof StorageError && error.code === "DURABILITY_FAILED") throw error;
    const cause = error instanceof StorageError ? error.code : "an unexpected error";
    throw invalid(`its database refuses the restore's first write (${cause})`);
  }
}
