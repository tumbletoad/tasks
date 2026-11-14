// Rows as JSON lines (A1 3.18): an export's optional `data.jsonl`, every table for other tools, and
// the rescue of a space whose check failed (A1 3.2), which keeps the rows that can still be read.
//
// One record per line: `{"table": <name>, "row": {<column>: <value>}}`, tables by name, rows in the
// table's own order. Text and numbers are themselves, an integer past 2^53 is its decimal text, and
// a BLOB is `{"$base64": "…"}`. The tables and columns are the product's own at the database's
// revision (backup/snapshot.ts productTables), never names read out of the database: a virtual
// table (FTS5) and its shadow tables are left out, since they are derived from the others, and so
// is anything the product's schema does not have.
import { fstatSync, fsyncSync, writeSync } from "node:fs";
import type { Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { closeQuietly, createFileExact, FILE_MODE, fsError } from "../files.ts";
import type { ProductTable } from "../backup/snapshot.ts";

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The query of every row of `table`, its product columns named one by one. */
const selectAll = (table: ProductTable): string =>
  `SELECT ${table.columns.map(quoted).join(", ")} FROM ${quoted(table.name)}`;

const value = (v: unknown): unknown => {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return { $base64: Buffer.from(v).toString("base64") };
  return v;
};

/**
 * Calls `see` with every text value of every row of `tables`, by the product's table and column
 * names (the export's secret scan when it writes no data.jsonl). `see` may throw to stop.
 */
export function scanText(
  conn: Connection,
  tables: readonly ProductTable[],
  see: (table: string, column: string, text: string) => void,
): void {
  for (const table of tables) {
    for (const row of conn.prepare(selectAll(table)).iterate()) {
      for (const column of table.columns) {
        const v = row[column];
        if (typeof v === "string") see(table.name, column, v);
      }
    }
  }
}

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
 * Writes every row of `tables` on `conn` into the new file `dest` (exclusive, owner-only, flushed)
 * and returns what it wrote. `tolerant` (the rescue) goes on past a table that fails, keeping the
 * rows read before the failure; otherwise the first failure is thrown. `seeText` sees every text
 * value (the export's secret scan); it may throw to stop.
 */
export function writeJsonl(
  conn: Connection,
  dest: string,
  tables: readonly ProductTable[],
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
    for (const table of tables) {
      try {
        for (const row of conn.prepare(selectAll(table)).iterate()) {
          const out: Record<string, unknown> = {};
          for (const column of table.columns) {
            const v = row[column];
            if (typeof v === "string") options.seeText?.(table.name, column, v);
            out[column] = value(v);
          }
          const line = `${JSON.stringify({ table: table.name, row: out })}\n`;
          pending.push(line);
          pendingBytes += line.length;
          report.rows += 1;
          if (pendingBytes >= FLUSH_AT) flush();
        }
        report.tables += 1;
      } catch (error) {
        if (options.tolerant !== true || !(error instanceof StorageError)) throw error;
        // The rows read before the failure stay: that is what the rescue is for.
        report.failed.push(table.name);
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
