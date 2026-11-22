// Row decoders and the integer domain (A1 3.4). The driver reads an INTEGER
// as a number within ±(2^53 − 1) and as a bigint beyond. Every INTEGER column TTasks writes holds a
// count, a flag, a sequence number, a reference, an ordinal or a millisecond instant inside the
// ranges below, so a decoder refuses a bigint, a fraction, a value of another type or a value out
// of range: the space then holds data TTasks did not write, and it is SPACE_INVALID. The errors
// name the table and column, never the value.
import type { Row } from "./driver.ts";
import { StorageError } from "./errors.ts";
import { isId, type Id, type IdPrefix } from "./ids.ts";

/**
 * The guarded integer ranges. Each fits in a JavaScript number and matches the wire patterns in
 * packages/contracts: `as_of` allows 10 digits of epoch and 15 of seq, a task reference 10 digits,
 * an entry ordinal 6 and an instant a four-digit year.
 */
export const RANGES = {
  /** A commit sequence number, and every version, provenance and seq column. */
  seq: { min: 0, max: 999_999_999_999_999 },
  /** An authority epoch. */
  epoch: { min: 1, max: 9_999_999_999 },
  /** A task reference number, as in `M-14`. */
  taskRef: { min: 1, max: 9_999_999_999 },
  /** A note or log entry ordinal within its task, as in `n2`. */
  ordinal: { min: 1, max: 999_999 },
  /**
   * A millisecond instant in UTC, from 1970 to 9999-12-31T23:59:59.999Z: the contracts instant
   * pattern has a four-digit year, and Date writes a later instant with six digits and a sign.
   */
  instant: { min: 0, max: 253_402_300_799_999 },
  /** A count, a flag or a small number such as a format version or a priority. */
  count: { min: 0, max: 2_147_483_647 },
} as const;

export type RangeName = keyof typeof RANGES;

/** Whether `value` is an integer number inside the named range. */
export function inRange(value: unknown, range: RangeName): value is number {
  const { min, max } = RANGES[range];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** The error for a stored value outside its domain. Names the column, never the value. */
export function invalidValue(table: string, column: string): StorageError {
  return new StorageError("SPACE_INVALID", `The ${table}.${column} value is outside its domain`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the columns of one row, each checked against its domain. */
export class RowReader {
  readonly #table: string;
  readonly #row: Row;

  constructor(table: string, row: Row) {
    this.#table = table;
    this.#row = row;
  }

  #fail(column: string): never {
    throw invalidValue(this.#table, column);
  }

  int(column: string, range: RangeName): number {
    const value = this.#row[column];
    return inRange(value, range) ? value : this.#fail(column);
  }

  optInt(column: string, range: RangeName): number | null {
    return this.#row[column] === null ? null : this.int(column, range);
  }

  text(column: string, check?: (value: string) => boolean): string {
    const value = this.#row[column];
    if (typeof value !== "string" || (check !== undefined && !check(value))) this.#fail(column);
    return value;
  }

  optText(column: string, check?: (value: string) => boolean): string | null {
    return this.#row[column] === null ? null : this.text(column, check);
  }

  id<P extends IdPrefix>(column: string, prefix: P): Id<P> {
    const value = this.#row[column];
    return isId(value, prefix) ? value : this.#fail(column);
  }

  oneOf<const T extends string>(column: string, values: readonly T[]): T {
    const value = this.#row[column];
    return values.includes(value as T) ? (value as T) : this.#fail(column);
  }

  /** A JSON column, parsed. The schema's json_valid CHECK makes a failure here a broken file. */
  json(column: string): unknown {
    const text = this.text(column);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return this.#fail(column);
    }
  }

  optJson(column: string): unknown {
    return this.#row[column] === null ? null : this.json(column);
  }
}

// ---------------------------------------------------------------------------------------------
// The space row (A1 3.4)

/** How an authority incarnation began (A1 3.1, A6 3.5). */
export const LINEAGE_KINDS = [
  "create",
  "transfer",
  "claim",
  "restore_claim",
  "transfer_cancelled",
] as const;
export type LineageKind = (typeof LINEAGE_KINDS)[number];

/** One entry of the lineage, stored as JSON in `space.lineage` and copied into space.json. */
export interface LineageEntry {
  incarnation: Id<"ai">;
  epoch: number;
  kind: LineageKind;
  parent: { incarnation: Id<"ai">; through_seq: number } | null;
  machine_id: Id<"m">;
  at: number;
}

export interface Lineage {
  forked_from: string | null;
  incarnations: LineageEntry[];
}

export interface SpaceFormat {
  major: number;
  minor: number;
}

/** The `space` row, decoded. */
export interface SpaceRow {
  spaceId: Id<"sp">;
  name: string;
  refPrefix: string;
  format: SpaceFormat;
  lastSeq: number;
  /** The next task reference. One past the last allowed reference when they are used up. */
  nextRef: number;
  authority: { machineId: Id<"m">; epoch: number; incarnation: Id<"ai">; sinceSeq: number };
  lineage: Lineage;
  transfer: Record<string, unknown> | null;
  undoFloorSeq: number;
  createdAt: number;
}

/** C0 and C1 controls, and the line and paragraph separators. */
const isControl = (code: number): boolean =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

/** The space's display name: one line of 1 to 100 characters with no control characters. */
export function isSpaceName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value !== value.normalize("NFC") || value.trim() !== value) return false;
  let count = 0;
  for (const char of value) {
    count += 1;
    if (count > 100 || isControl(char.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/** 1 to 6 upper-case ASCII letters (A1 3.3). */
export const REF_PREFIX = /^[A-Z]{1,6}$/;

function decodeLineageEntry(value: unknown): LineageEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { incarnation, epoch, kind, parent, machine_id, at } = value;
  if (!isId(incarnation, "ai") || !inRange(epoch, "epoch") || !isId(machine_id, "m")) {
    return undefined;
  }
  if (!LINEAGE_KINDS.includes(kind as LineageKind) || !inRange(at, "instant")) return undefined;
  let decodedParent: LineageEntry["parent"] = null;
  if (parent !== null) {
    if (!isRecord(parent)) return undefined;
    const { incarnation: from, through_seq } = parent;
    if (!isId(from, "ai") || !inRange(through_seq, "seq")) return undefined;
    decodedParent = { incarnation: from, through_seq };
  }
  return {
    incarnation,
    epoch,
    kind: kind as LineageKind,
    parent: decodedParent,
    machine_id,
    at,
  };
}

/** Decodes a lineage document, or undefined when it breaks its shape. */
export function decodeLineage(value: unknown): Lineage | undefined {
  if (!isRecord(value)) return undefined;
  const { forked_from, incarnations } = value;
  if (forked_from !== null && typeof forked_from !== "string") return undefined;
  if (!Array.isArray(incarnations) || incarnations.length === 0) return undefined;
  const entries: LineageEntry[] = [];
  for (const raw of incarnations) {
    const entry = decodeLineageEntry(raw);
    if (entry === undefined) return undefined;
    entries.push(entry);
  }
  return { forked_from, incarnations: entries };
}

/** Decodes the one `space` row. A missing row or a value outside its domain is SPACE_INVALID. */
export function decodeSpaceRow(row: Row | undefined): SpaceRow {
  if (row === undefined) {
    throw new StorageError("SPACE_INVALID", "The database has no space row");
  }
  const r = new RowReader("space", row);
  const lastSeq = r.int("last_seq", "seq");
  const nextRef = r.int("next_ref", "seq");
  if (nextRef < RANGES.taskRef.min || nextRef > RANGES.taskRef.max + 1) {
    throw invalidValue("space", "next_ref");
  }
  const sinceSeq = r.int("authority_since", "seq");
  if (sinceSeq > lastSeq) throw invalidValue("space", "authority_since");
  const incarnation = r.id("authority_incarnation", "ai");
  const epoch = r.int("authority_epoch", "epoch");
  const lineage = decodeLineage(r.json("lineage"));
  if (
    lineage?.incarnations.some((e) => e.incarnation === incarnation && e.epoch === epoch) !== true
  ) {
    throw invalidValue("space", "lineage");
  }
  const transfer = r.optJson("transfer");
  if (transfer !== null && !isRecord(transfer)) throw invalidValue("space", "transfer");
  return {
    spaceId: r.id("space_id", "sp"),
    name: r.text("name", isSpaceName),
    refPrefix: r.text("ref_prefix", (v) => REF_PREFIX.test(v)),
    format: { major: r.int("format_major", "count"), minor: r.int("format_minor", "count") },
    lastSeq,
    nextRef,
    authority: {
      machineId: r.id("authority_machine", "m"),
      epoch,
      incarnation,
      sinceSeq,
    },
    lineage,
    transfer,
    undoFloorSeq: r.int("undo_floor_seq", "seq"),
    createdAt: r.int("created_at", "instant"),
  };
}
