// A mutable row's versions as the write path reads them (A1 3.4, 3.5, 3.10): its created_seq, its
// version, and its two maps over its logical fields, `fv` (each field's physical version) and `fp`
// (its provenance), where a missing key means created_seq. The writer and the history engine
// (history.ts) read every row they change through these.
import type { Row } from "../driver.ts";
import { inRange, invalidValue, RowReader } from "../rows.ts";

/** An existing row's state: what coalescing, the base and the inversion guards compare. */
export interface RowState {
  createdSeq: number;
  version: number;
  fv: Record<string, number>;
  fp: Record<string, number>;
  /** Every column, as read. */
  raw: Row;
}

/** A row's `fv` or `fp`: a map from its logical fields to seqs. */
function versionMap(
  r: RowReader,
  table: string,
  column: "fv" | "fp",
  fields: Readonly<Record<string, unknown>>,
): Record<string, number> {
  const value = r.json(column);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidValue(table, column);
  }
  const map: Record<string, number> = {};
  for (const [field, seq] of Object.entries(value)) {
    if (!Object.hasOwn(fields, field) || !inRange(seq, "seq")) throw invalidValue(table, column);
    map[field] = seq;
  }
  return map;
}

export function rowState(
  table: string,
  row: Row,
  fields: Readonly<Record<string, unknown>>,
): RowState {
  const r = new RowReader(table, row);
  return {
    createdSeq: r.int("created_seq", "seq"),
    version: r.int("version", "seq"),
    fv: versionMap(r, table, "fv", fields),
    fp: versionMap(r, table, "fp", fields),
    raw: row,
  };
}

/** A field's physical version: its `fv` entry, or the row's created_seq when it has none. */
export const versionOf = (row: RowState, field: string): number => row.fv[field] ?? row.createdSeq;

/** A field's provenance: its `fp` entry, or the row's created_seq when it has none. */
export const provenanceOf = (row: RowState, field: string): number =>
  row.fp[field] ?? row.createdSeq;
