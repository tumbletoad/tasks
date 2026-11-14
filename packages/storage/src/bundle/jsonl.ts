// Rows as JSON lines (A1 3.18): an export's optional `data.jsonl`, every table for other tools, and
// the rescue of a space whose check failed (A1 3.2), which keeps the rows that can still be read.
//
// One record per line: `{"table": <name>, "row": {<column>: <value>}}`, tables by name, rows in the
// table's own order. Text and numbers are themselves, an integer past 2^53 is its decimal text, and
// a BLOB is `{"$base64": "…"}`. A virtual table (FTS5) and its shadow tables are left out: they are
// derived from the others.
import { fstatSync, fsyncSync, writeSync } from "node:fs";
import type { Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { closeQuietly, createFileExact, FILE_MODE, fsError } from "../files.ts";

/** A table name Tasks can quote safely: the names its schema steps create. */
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,63}$/;

/** The tables to write, by name: every table but SQLite's, the virtual ones and their shadows. */
export function dataTables(conn: Connection): string[] {
  const rows = conn
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all<{ name: unknown; sql: unknown }>();
  const virtual = rows
    .filter((r) => typeof r.sql === "string" && /^CREATE VIRTUAL TABLE/i.test(r.sql))
    .map((r) => String(r.name));
  return rows
    .map((r) => r.name)
    .filter((name): name is string => typeof name === "string" && TABLE_NAME.test(name))
    .filter((name) => !name.startsWith("sqlite_"))
    .filter((name) => !virtual.some((v) => name === v || name.startsWith(`${v}_`)));
}

const value = (v: unknown): unknown => {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return { $base64: Buffer.from(v).toString("base64") };
  return v;
};

export interface JsonlReport {
  /** Tables written whole. */
  tables: number;
  rows: number;
  /** Tables that could not be read to their end (only when `tolerant`): their readable rows stay. */
  failed: string[];
  size: number;
}

const FLUSH_AT = 1024 * 1024;

/**
 * Writes every data table of the database on `conn` into the new file `dest` (exclusive,
 * owner-only, flushed) and returns what it wrote. `tolerant` (the rescue) goes on past a table
 * that fails, keeping the rows read before the failure; otherwise the first failure is thrown.
 * `seeText` sees every text value (the export's secret scan); it may throw to stop.
 */
export function writeJsonl(
  conn: Connection,
  dest: string,
  options: { tolerant?: boolean; seeText?: (table: string, column: string, text: string) => void },
): JsonlReport {
  let fd: number;
  try {
    fd = createFileExact(dest, FILE_MODE);
  } catch (error) {
    throw fsError(error);
  }
  const report: JsonlReport = { tables: 0, rows: 0, failed: [], size: 0 };
  let pending: string[] = [];
  let pendingBytes = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    const bytes = Buffer.from(pending.join(""), "utf8");
    pending = [];
    pendingBytes = 0;
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
  };
  try {
    const tables = options.tolerant === true ? safeTables(conn) : dataTables(conn);
    for (const table of tables) {
      try {
        for (const row of conn.prepare(`SELECT * FROM "${table}"`).iterate()) {
          const out: Record<string, unknown> = {};
          for (const [column, v] of Object.entries(row)) {
            if (typeof v === "string") options.seeText?.(table, column, v);
            out[column] = value(v);
          }
          const line = `${JSON.stringify({ table, row: out })}\n`;
          pending.push(line);
          pendingBytes += line.length;
          report.rows += 1;
          if (pendingBytes >= FLUSH_AT) flush();
        }
        report.tables += 1;
      } catch (error) {
        if (options.tolerant !== true || !(error instanceof StorageError)) throw error;
        // The rows read before the failure stay: that is what the rescue is for.
        report.failed.push(table);
      }
    }
    flush();
    fsyncSync(fd);
    report.size = fstatSync(fd).size;
    return report;
  } catch (error) {
    throw error instanceof StorageError ? error : fsError(error);
  } finally {
    closeQuietly(fd);
  }
}

/** The data tables, or for a schema that no longer reads, none: the rescue then writes nothing. */
function safeTables(conn: Connection): string[] {
  try {
    return dataTables(conn);
  } catch {
    return [];
  }
}
