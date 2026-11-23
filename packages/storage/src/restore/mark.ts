// A restore's first write on a copy in its staging folder (A1 3.18), in one place (firstWrite):
// - into a new folder, the read-only mark (markReadOnlyCopy), with a claim of the copy run and taken
//   back before it;
// - in place, the claim itself (claim.ts, restore.ts).
// Both first drop what the exact-schema rule leaves out and make the search index again
// (prepareCopy).
//
// The mark is `space.transfer` = `{state: "restored_copy", at, backup}`: every open of the copy is
// then read-only with the reason `read_only_copy` until it is claimed (A6 3.5), and a person reads
// when it was restored and from which backup file. It writes no commit: the space row has no history
// (A1 3.4), and the copy's history stays the backup's.
//
// THE TRIAL CLAIM. A copy is of use only once it is claimed (`ttasks space claim`, or the restore in
// place's own claim), and a claim writes more than the mark: a commit by the space's system actor,
// the next seq, the lineage. So the mark's transaction first runs the claim's own writes
// (claim.ts claimInTransaction) under a savepoint and rolls them back: a copy that refuses a claim
// refuses the restore, and therefore never verifies (restore.ts), whatever its schema or rows.
import type { Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { newId, osRandom } from "../ids.ts";
import { openWriter } from "../open.ts";
import { decodeSpaceRow, type SpaceRow } from "../rows.ts";
import type { SchemaStep } from "../schema.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { ALL_OBJECTS, isDropped } from "../backup/snapshot.ts";
import { remakeSearchIndex } from "../search/remake.ts";
import { claimInTransaction } from "./claim.ts";
import { isContentFailure } from "./unpack.ts";

/** The state `space.transfer` holds for a read-only copy (A6 3.5's `read_only_copy`). */
export const READ_ONLY_COPY = "restored_copy";

/**
 * Drops, inside the caller's write transaction, every object of a copied database that the
 * exact-schema rule leaves out (backup/snapshot.ts isDropped): each trigger, which would run on the
 * restore's own writes and could clear the read-only mark or undo a claim (TTasks's schema has none,
 * A1 3.4), and SQLite's statistics tables. A restore runs it before its first write, an export on
 * its private snapshot. Names are only quoted here, never shown.
 */
export function dropUnchecked(conn: Connection): void {
  const rows = conn.prepare(ALL_OBJECTS).all<{ type: unknown; name: unknown }>();
  for (const { type, name } of rows) {
    if (!isDropped(type, name)) continue;
    const quoted = `"${String(name).replaceAll('"', '""')}"`;
    conn.exec(type === "trigger" ? `DROP TRIGGER IF EXISTS ${quoted}` : `DROP TABLE ${quoted}`);
  }
}

/**
 * What every first write on a copy starts with, inside the caller's write transaction: the
 * unchecked objects dropped (dropUnchecked), then the search index made again from the copy's tasks
 * (search/remake.ts), so the copy's own index, whatever it holds, is never used.
 */
export function prepareCopy(
  checked: CheckedDriver,
  conn: Connection,
  steps: readonly SchemaStep[],
): void {
  dropUnchecked(conn);
  remakeSearchIndex(checked, conn, steps);
}

/**
 * Runs a claim of the copy on `conn` inside the caller's write transaction and takes it back (see
 * the header). The trial's machine is a random one: nothing of it is kept.
 */
function trialClaim(conn: Connection, now: number): void {
  conn.exec("SAVEPOINT trial_claim");
  // A refusal throws here, and the caller's transaction rolls back whole.
  claimInTransaction(conn, {
    kind: "claim",
    machineId: newId("m", osRandom),
    now,
    random: osRandom,
  });
  // Taken back before the mark; if that fails, it throws, and nothing of the claim commits.
  conn.exec("ROLLBACK TO trial_claim");
  conn.exec("RELEASE trial_claim");
}

/**
 * Marks the space on `conn`, a writer on a restored copy in its staging folder, as a read-only
 * copy restored from the file named `backup`, in one transaction: the copy prepared (prepareCopy),
 * a claim run and taken back, then the mark. Returns the marked row, which must hold the mark.
 */
export function markReadOnlyCopy(
  checked: CheckedDriver,
  conn: Connection,
  now: number,
  steps: readonly SchemaStep[],
  backup: string,
): SpaceRow {
  return conn.transaction("immediate", () => {
    prepareCopy(checked, conn, steps);
    trialClaim(conn, now);
    conn
      .prepare("UPDATE space SET transfer = $transfer WHERE one = 1")
      .run({ transfer: JSON.stringify({ state: READ_ONLY_COPY, at: now, backup }) });
    const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
    if (space.transfer?.["state"] !== READ_ONLY_COPY) {
      throw new StorageError("SPACE_INVALID", "The restored copy did not keep its read-only mark");
    }
    return space;
  });
}

/**
 * A restore's first write `write` on the unpacked copy `db`, which no other connection has open,
 * through its own writer, whose close checkpoints the -wal into the file. A refusal by the copy
 * itself (a definition or a row that fails the write, a mark it did not keep) is the source's
 * fault: `invalid`, with the cause's code. Anything else (a full or failing disk, a file that
 * cannot be opened, a bug) is not, and passes on as itself.
 */
export function firstWrite<T>(
  checked: CheckedDriver,
  db: string,
  options: { busyTimeoutMs?: number },
  invalid: (why: string) => StorageError,
  write: (conn: Connection) => T,
): T {
  try {
    const conn = openWriter(checked, db, options);
    try {
      return write(conn);
    } finally {
      // The last connection to close checkpoints the -wal into the file and removes it.
      conn.close();
    }
  } catch (error) {
    if (!isContentFailure(error)) throw error;
    throw invalid(`its database refuses the restore's first write (${error.code})`);
  }
}

/** The first write of a restore into a new folder: the mark (markReadOnlyCopy), by firstWrite. */
export function markCopy(
  checked: CheckedDriver,
  db: string,
  now: number,
  options: { busyTimeoutMs?: number },
  invalid: (why: string) => StorageError,
  steps: readonly SchemaStep[],
  backup: string,
): SpaceRow {
  return firstWrite(checked, db, options, invalid, (conn) =>
    markReadOnlyCopy(checked, conn, now, steps, backup),
  );
}
