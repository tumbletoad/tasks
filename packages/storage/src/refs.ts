// Short references (A1 3.3): a task's `M-14` from the space's prefix and counter, and a note's or
// log entry's per-task ordinal, `n2` or `l1`. References are aliases for people and agents, never
// identity. The writer allocates them inside the creating transaction. The single writer worker
// (A1 3.9) is what makes that safe under concurrency, so this module only reads and moves the
// counter of the transaction it runs in. M1.04's write path calls these from its handlers.
import type { Connection } from "./driver.ts";
import { misuse, StorageError } from "./errors.ts";
import { RANGES, REF_PREFIX, invalidValue } from "./rows.ts";

export { REF_PREFIX };

const TASK_REF = /^([A-Z]{1,6})-([1-9][0-9]{0,9})$/;
const ENTRY_REF = /^([nl])([1-9][0-9]{0,5})$/;

/** A note or a log entry. */
export type EntryKind = "note" | "log";

const ENTRY_LETTER: Record<EntryKind, "n" | "l"> = { note: "n", log: "l" };
const ENTRY_TABLE: Record<EntryKind, "notes" | "log_entries"> = {
  note: "notes",
  log: "log_entries",
};

export const isRefPrefix = (value: unknown): value is string =>
  typeof value === "string" && REF_PREFIX.test(value);

/** `M-14`. */
export function formatTaskRef(prefix: string, ref: number): string {
  if (!isRefPrefix(prefix)) throw misuse("A reference prefix is 1 to 6 upper-case letters");
  if (!Number.isSafeInteger(ref) || ref < RANGES.taskRef.min || ref > RANGES.taskRef.max) {
    throw misuse("A task reference is an integer from 1 to 9,999,999,999");
  }
  return `${prefix}-${String(ref)}`;
}

/** The prefix and number of a task reference such as `M-14`, or undefined. */
export function parseTaskRef(text: unknown): { prefix: string; ref: number } | undefined {
  if (typeof text !== "string") return undefined;
  const match = TASK_REF.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { prefix: match[1], ref: Number(match[2]) };
}

/** `n2` or `l1`. */
export function formatEntryRef(kind: EntryKind, ordinal: number): string {
  const letter = (ENTRY_LETTER as Partial<Record<string, string>>)[kind];
  if (letter === undefined) throw misuse("An entry is a note or a log entry");
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < RANGES.ordinal.min ||
    ordinal > RANGES.ordinal.max
  ) {
    throw misuse("An entry ordinal is an integer from 1 to 999,999");
  }
  return `${letter}${String(ordinal)}`;
}

/** The kind and ordinal of an entry reference such as `n2`, or undefined. */
export function parseEntryRef(text: unknown): { kind: EntryKind; ordinal: number } | undefined {
  if (typeof text !== "string") return undefined;
  const match = ENTRY_REF.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { kind: match[1] === "n" ? "note" : "log", ordinal: Number(match[2]) };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The default prefix for a new space (A1 3.3): the first letter of its name, with a second letter
 * when another space on this machine already uses it. The letters are the name's ASCII letters
 * after its accents are removed. A name without letters starts from S (space). When every
 * one- and two-letter candidate is taken, three letters follow.
 */
export function defaultRefPrefix(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const letters = name
    .normalize("NFKD")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
  const first = letters.charAt(0) || "S";
  const seconds = `${letters.slice(1)}${LETTERS}`;
  if (!used.has(first)) return first;
  for (let i = 0; i < seconds.length; i += 1) {
    const candidate = `${first}${seconds.charAt(i)}`;
    if (!used.has(candidate)) return candidate;
  }
  for (let a = 0; a < LETTERS.length; a += 1) {
    for (let b = 0; b < LETTERS.length; b += 1) {
      const candidate = `${first}${LETTERS.charAt(a)}${LETTERS.charAt(b)}`;
      if (!used.has(candidate)) return candidate;
    }
  }
  throw misuse("Every default reference prefix for this name is taken: choose one");
}

function requireWrite(conn: Connection): void {
  if (!conn.inTransaction) {
    throw misuse("A reference is allocated inside the transaction that creates its row");
  }
}

/**
 * Takes the space's next task reference and moves the counter on, inside the caller's write
 * transaction. References are never reused (A1 3.3): the counter only grows, and it stops with
 * STORAGE_CONSTRAINT after 9,999,999,999, the largest reference the wire format carries. The
 * counter then holds one more, which means "used up". A counter above that was never written by
 * Tasks: SPACE_INVALID.
 */
export function takeTaskRef(conn: Connection): number {
  requireWrite(conn);
  const row = conn.prepare("SELECT next_ref FROM space WHERE one = 1").get();
  const ref = row?.["next_ref"];
  if (
    typeof ref !== "number" ||
    !Number.isSafeInteger(ref) ||
    ref < RANGES.taskRef.min ||
    ref > RANGES.taskRef.max + 1
  ) {
    throw invalidValue("space", "next_ref");
  }
  if (ref === RANGES.taskRef.max + 1) {
    throw new StorageError("STORAGE_CONSTRAINT", "The space has used every task reference");
  }
  conn.prepare("UPDATE space SET next_ref = $next WHERE one = 1").run({ next: ref + 1 });
  return ref;
}

/**
 * The next ordinal for a note or log entry of one task, inside the caller's write transaction:
 * one more than the highest the task has. Tombstoned entries keep their rows, so an ordinal is
 * never given twice. (Redaction, M3, removes rows and must keep this rule.)
 */
export function nextEntryOrdinal(conn: Connection, kind: EntryKind, taskId: string): number {
  requireWrite(conn);
  const table = (ENTRY_TABLE as Partial<Record<string, string>>)[kind];
  if (table === undefined) throw misuse("An entry is a note or a log entry");
  const row = conn
    .prepare(`SELECT coalesce(max(ordinal), 0) AS last FROM ${table} WHERE task_id = $task`)
    .get({ task: taskId });
  const last = row?.["last"];
  if (typeof last !== "number" || !Number.isSafeInteger(last) || last < 0) {
    throw invalidValue(table, "ordinal");
  }
  if (last >= RANGES.ordinal.max) {
    throw new StorageError("STORAGE_CONSTRAINT", "The task has used every entry ordinal");
  }
  return last + 1;
}
