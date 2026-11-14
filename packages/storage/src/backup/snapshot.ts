// Checking a copy of a space database: a backup's snapshot before it is compressed, and a restored
// database before it is used (A1 3.18). The copy opens read-only, passes PRAGMA integrity_check, and
// gives the facts a sidecar records. Nothing here trusts the copy: every value is decoded.
import { lstatSync } from "node:fs";
import type { Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { removeQuietly } from "../files.ts";
import { openReader } from "../open.ts";
import { decodeSpaceRow, inRange, type SpaceRow } from "../rows.ts";
import { APP_ID } from "../schema.ts";
import type { CheckedDriver } from "../startup-check.ts";

/** What a checked snapshot holds. */
export interface SnapshotFacts {
  userVersion: number;
  space: SpaceRow;
  /** Rows per table, by table name. */
  counts: Record<string, number>;
}

/** A table name Tasks can quote safely: the names its schema steps create. */
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,63}$/;

/** Rows per table of the main schema. */
export function tableCounts(conn: Connection): Record<string, number> {
  const counts: Record<string, number> = {};
  const names = conn
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "ORDER BY name",
    )
    .all<{ name: unknown }>();
  for (const { name } of names) {
    if (typeof name !== "string" || !TABLE_NAME.test(name)) {
      throw new StorageError("SPACE_INVALID", "The database has a table that is not a space's");
    }
    const n = conn.prepare(`SELECT count(*) AS n FROM "${name}"`).get()?.["n"];
    if (!inRange(n, "seq"))
      throw new StorageError("SPACE_INVALID", "A table count is out of range");
    counts[name] = n;
  }
  return counts;
}

/** Reads the facts of a space database in one read transaction on `conn`. */
export function readSnapshotFacts(conn: Connection): SnapshotFacts {
  return conn.transaction("deferred", () => {
    if (conn.pragma("integrity_check") !== "ok") {
      throw new StorageError("STORAGE_CORRUPT", "The copy fails its integrity check");
    }
    if (conn.pragma("application_id") !== APP_ID) {
      throw new StorageError("SPACE_INVALID", "The copy is not a space database");
    }
    const userVersion = conn.pragma("user_version");
    if (!inRange(userVersion, "count") || userVersion === 0) {
      throw new StorageError("SPACE_VERSION_UNKNOWN", "The copy has no schema revision");
    }
    const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
    return { userVersion, space, counts: tableCounts(conn) };
  });
}

/**
 * Opens the database file `path` read-only, checks it and reads its facts, then closes it and
 * removes the empty `-wal` and the `-shm` that a read-only open of a WAL database leaves (A1
 * 3.1). The file must be a private copy: nothing else may have it open.
 */
export function checkSnapshot(
  checked: CheckedDriver,
  path: string,
  busyTimeoutMs?: number,
): SnapshotFacts {
  if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new StorageError("SPACE_NOT_FOUND", "The copy is missing");
  }
  const conn = openReader(checked, path, busyTimeoutMs === undefined ? {} : { busyTimeoutMs });
  try {
    return readSnapshotFacts(conn);
  } finally {
    conn.close();
    removeQuietly(`${path}-wal`);
    removeQuietly(`${path}-shm`);
  }
}
