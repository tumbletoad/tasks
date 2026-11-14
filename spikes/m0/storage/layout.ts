// History layout measurement (run.ts --layout, result file history-layout.json). The indicative run
// found the history larger than A1 3.20 estimates, with the changes table holding many overflow
// pages that carry little payload. This builds the changes table twice from the same rows of the
// primary space, once WITHOUT ROWID (A1 3.4, the bench's schema) and once with a rowid, each in a
// fresh database with the same indexes, and reports both sizes with their overflow figures. The
// bench's schema does not change: A1 owns it and M1 decides.
//
// Why the layouts differ: a WITHOUT ROWID table is an index b-tree, which keeps at most about a
// quarter of a page of each row on the leaf (`maxLocal`) and spills the rest to overflow pages. A
// rowid table keeps nearly a whole page. Change rows of one to a few KB therefore spill in the first
// layout and not in the second, and each spill takes a whole overflow page for its tail.
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withConnection } from "./connection.ts";
import { CHANGES } from "./schema.ts";

export interface BtreeSize {
  bytes: number;
  pages: number;
  leafPages: number;
  interiorPages: number;
  overflowPages: number;
  overflowBytes: number;
  /** Payload bytes of the rows, on leaf and overflow pages. */
  payloadBytes: number;
  overflowPayloadBytes: number;
  unusedBytes: number;
}

export interface LayoutSize {
  rows: number;
  /** The database file after a TRUNCATE checkpoint. Copies only. */
  fileBytes: number | null;
  /** The table and all of its indexes. */
  totalBytes: number;
  table: BtreeSize;
  indexes: Record<string, BtreeSize>;
}

export interface HistoryLayout {
  /** Rows copied: the changes rows of the generated corpus (seq <= its last commit). */
  rows: number;
  pageSize: number;
  /** The largest payload kept on a leaf page before the rest spills (SQLite file format 1.6). */
  maxLocalPayload: { withoutRowid: number; rowid: number };
  /** The primary's own changes table as the bench left it, rows from the benchmarks included. */
  inPlace: LayoutSize;
  withoutRowid: LayoutSize;
  rowid: LayoutSize;
}

function btrees(db: DatabaseSync, schema: string): LayoutSize {
  const names = db
    .prepare(`SELECT name FROM ${schema}.sqlite_schema WHERE tbl_name = 'changes'`)
    .all() as { name: string }[];
  const stat = db.prepare(`SELECT pagetype, count(*) AS pages, sum(pgsize) AS bytes,
      sum(payload) AS payload, sum(unused) AS unused
    FROM dbstat(?) WHERE name = ? GROUP BY pagetype`);
  const size = (name: string): BtreeSize => {
    const out: BtreeSize = {
      bytes: 0,
      pages: 0,
      leafPages: 0,
      interiorPages: 0,
      overflowPages: 0,
      overflowBytes: 0,
      payloadBytes: 0,
      overflowPayloadBytes: 0,
      unusedBytes: 0,
    };
    const rows = stat.all(schema, name) as {
      pagetype: string;
      pages: number;
      bytes: number;
      payload: number;
      unused: number;
    }[];
    for (const r of rows) {
      out.bytes += r.bytes;
      out.pages += r.pages;
      out.payloadBytes += r.payload;
      out.unusedBytes += r.unused;
      if (r.pagetype === "leaf") out.leafPages += r.pages;
      else if (r.pagetype === "internal") out.interiorPages += r.pages;
      else if (r.pagetype === "overflow") {
        out.overflowPages += r.pages;
        out.overflowBytes += r.bytes;
        out.overflowPayloadBytes += r.payload;
      }
    }
    return out;
  };
  const table = size("changes");
  const indexes: Record<string, BtreeSize> = {};
  for (const { name } of names) if (name !== "changes") indexes[name] = size(name);
  const rows = (db.prepare(`SELECT count(*) AS n FROM ${schema}.changes`).get() as { n: number }).n;
  return {
    rows,
    fileBytes: null,
    totalBytes: table.bytes + Object.values(indexes).reduce((a, b) => a + b.bytes, 0),
    table,
    indexes,
  };
}

/** Copies the corpus rows into a fresh database with the given DDL and measures it. */
function copy(primary: string, path: string, ddl: string, lastSeq: number): LayoutSize {
  const measured = withConnection(new DatabaseSync(path), (db) => {
    db.exec(
      "PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;",
    );
    db.exec(ddl);
    db.prepare("ATTACH DATABASE ? AS src").run(primary);
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO main.changes SELECT * FROM src.changes WHERE seq <= ? ORDER BY seq, n",
    ).run(lastSeq);
    db.exec("COMMIT");
    db.exec("DETACH DATABASE src");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return btrees(db, "main");
  });
  return { ...measured, fileBytes: statSync(path).size };
}

/**
 * Measures the changes table of `primary` in both layouts. `lastSeq` is the corpus's last commit,
 * so both copies hold exactly the generated rows. The copies are made in `dir` and removed.
 */
export function historyLayout(primary: string, lastSeq: number, dir: string): HistoryLayout {
  const { inPlace, pageSize } = withConnection(
    new DatabaseSync(primary, { readOnly: true }),
    (db) => ({
      inPlace: btrees(db, "main"),
      pageSize: (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size,
    }),
  );
  const rowidDdl = CHANGES.replace("STRICT, WITHOUT ROWID;", "STRICT;");
  if (rowidDdl === CHANGES) throw new Error("the changes DDL has no WITHOUT ROWID clause");
  const paths = [join(dir, "layout-without-rowid.db"), join(dir, "layout-rowid.db")] as const;
  try {
    const withoutRowid = copy(primary, paths[0], CHANGES, lastSeq);
    const rowid = copy(primary, paths[1], rowidDdl, lastSeq);
    // File format 1.6: usable size U (no reserved bytes here). Index b-tree leaves keep at most
    // (U-12)*64/255-23 bytes of a cell, table b-tree leaves U-35.
    const usable = pageSize;
    return {
      rows: withoutRowid.rows,
      pageSize,
      maxLocalPayload: {
        withoutRowid: Math.floor(((usable - 12) * 64) / 255) - 23,
        rowid: usable - 35,
      },
      inPlace,
      withoutRowid,
      rowid,
    };
  } finally {
    // Frees the disk early. Best effort: the run folder is removed at the end in any case, and that
    // removal reports a failure.
    for (const path of paths) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(`${path}${suffix}`, { force: true });
        } catch {
          // See above.
        }
      }
    }
  }
}
