// Receipts (A1 3.7, 3.8; X12; A7 3.8 M1.05). Every request the writer decides gets one `receipts`
// row, written in the request's own transaction, so a request's commit and its receipt exist
// together or not at all. The row is keyed by the writer scope and the request ID (A3 3.7.9),
// carries the fingerprint of the intent and stores the result. A request whose ID its scope already
// holds is not run again: the same fingerprint returns the stored result with `replayed: true`,
// whatever the state is now, and another fingerprint is REQUEST_ID_REUSED. The lookup comes before staging, so before references, dedupe, policy and
// expansion (A1 3.7).
//
// The fingerprint is SHA-256 over the RFC 8785 form of `{space_id, entry, input, reason}` (A1 3.8):
// the caller's intent, never its base or request ID. With an intent from the registry it covers
// the entry and its input as sent; without one, the operations as checked (normalised text), under
// no entry name, which no registry entry can have. The scope is not part of it: the key holds the
// scope, so two scopes never share a receipt.
//
// What a receipt stores is the result with one change: a conflict keeps the field, version, author
// and time of each conflicting field but not its values (the current one, and an undo's value
// written and value to restore). The current value was a read at the time of the decision, and a
// replay is no fresh read. The stored result is bounded by its request: at most one result per
// operation, and at most one conflict per (row, field) the request touches, each a few hundred
// bytes. Once the service has built its answer, the receipt also keeps that answer as the caller
// was given it (`keepGiven`), bounded as the answer was: the titles and names it showed among it.
import { createHash } from "node:crypto";
import type { Connection, Row } from "../driver.ts";
import { misuse } from "../errors.ts";
import type { Id } from "../ids.ts";
import { invalidValue, RowReader } from "../rows.ts";
import { canonicalJson } from "./canonical.ts";
import {
  INSIDE_KEPT,
  type CheckedRequest,
  type Given,
  type WriteResult,
  type WriteStatus,
} from "./request.ts";

/** A stored receipt. */
export interface Receipt {
  scope_id: string;
  request_id: string;
  /** SHA-256 of the intent, 64 lower-case hex digits. */
  fingerprint: string;
  status: WriteStatus;
  /** The commit the request wrote: `applied` only. */
  seq: number | null;
  /** The authority the request was decided under. */
  epoch: number;
  incarnation: Id<"ai">;
  /** When it was decided, in milliseconds. */
  at: number;
  /** The stored result, as a replay returns it: marked `replayed`. */
  result: WriteResult;
}

/** Where a receipt is looked up: its writer scope and its request ID. */
export interface ReceiptLookup {
  scope_id: string;
  request_id: string;
}

/** The parts of an intent the fingerprint covers (A1 3.8). */
export interface IntentParts {
  space_id: string;
  /** The registry entry, or null for a request of A1 operations. */
  entry: string | null;
  input: unknown;
  reason: string | null;
}

const STATUSES: readonly WriteStatus[] = ["applied", "unchanged", "conflict", "rejected"];
const FINGERPRINT = /^[0-9a-f]{64}$/;

const SQL = {
  get: "SELECT * FROM receipts WHERE scope_id = $scope AND request_id = $request",
  insert:
    "INSERT INTO receipts (scope_id, request_id, fingerprint, status, seq, epoch, incarnation, " +
    "result, at) VALUES ($scope, $request, $fingerprint, $status, $seq, $epoch, $incarnation, " +
    "$result, $at)",
  result:
    "UPDATE receipts SET result = $result WHERE scope_id = $scope AND request_id = $request " +
    "AND fingerprint = $fingerprint",
} as const;

/**
 * The fields of an entry's input that are the request's envelope, not its intent (A1 3.8: "without
 * request_id and without base"; A3 3.4.1: "never the generated base"). The service passes an
 * entry's parsed input, which still holds them, so the fingerprint leaves them out at the input's
 * top level. A nested field of the same name is input.
 */
const ENVELOPE = new Set(["request_id", "base"]);

/**
 * The intent's input without its envelope fields. Its strings are hashed as sent: the registry
 * has normalised the entry's text fields (SafeText, A3 3.10) and checkRequest the operations,
 * and what is left, such as `cwd` or a path, is opaque. `café` in NFC and in NFD, or a name with
 * and without a control, can be two folders on disk, so folding them would replay one intent
 * for another. Two encodings of one text that reach the writer are another intent: the caller
 * gets REQUEST_ID_REUSED and reviews, which never applies a change twice.
 */
function intentInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([name]) => !ENVELOPE.has(name)));
}

/** SHA-256 over the RFC 8785 form of the intent, as 64 hex digits. */
export function intentFingerprint(parts: IntentParts): string {
  const intent = {
    space_id: parts.space_id,
    entry: parts.entry,
    input: intentInput(parts.input),
    reason: parts.reason,
  };
  return createHash("sha256").update(canonicalJson(intent), "utf8").digest("hex");
}

/** The fingerprint of a checked request: its intent, or its operations without one. */
export function requestFingerprint(request: CheckedRequest): string {
  return intentFingerprint({
    space_id: request.space_id,
    entry: request.intent?.entry ?? null,
    input: request.intent === undefined ? { ops: request.ops } : request.intent.input,
    reason: request.reason ?? null,
  });
}

/** The SQL of one receipt by writer scope and request ID, for a reader connection's lookup. */
export const RECEIPT_SQL = SQL.get;

/**
 * A `receipts` row as a Receipt. The service's request path reads receipts through a space's
 * reader connection with RECEIPT_SQL (a read-only copy has no writer) and decodes them here.
 */
export function decodeReceipt(row: Row): Receipt {
  const r = new RowReader("receipts", row);
  const status = r.oneOf("status", STATUSES);
  const result = r.json("result");
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    (result as { status?: unknown }).status !== status
  ) {
    throw invalidValue("receipts", "result");
  }
  return {
    scope_id: r.text("scope_id"),
    request_id: r.text("request_id"),
    fingerprint: r.text("fingerprint", (v) => FINGERPRINT.test(v)),
    status,
    seq: r.optInt("seq", "seq"),
    epoch: r.int("epoch", "epoch"),
    incarnation: r.id("incarnation", "ai"),
    at: r.int("at", "instant"),
    result: { ...(result as WriteResult), replayed: true },
  };
}

/**
 * The receipt of a request in its writer scope, or undefined. Another scope's receipts are never
 * found: the scope is part of the key. It reads on the caller's connection, inside the caller's
 * transaction when there is one.
 */
export function readReceipt(conn: Connection, lookup: ReceiptLookup): Receipt | undefined {
  const { scope_id, request_id } = lookup;
  if (typeof scope_id !== "string" || typeof request_id !== "string") {
    throw misuse("A receipt is looked up by writer scope and request ID");
  }
  const row = conn.prepare(SQL.get).get({ scope: scope_id, request: request_id });
  return row === undefined ? undefined : decodeReceipt(row);
}

/**
 * The result as a receipt stores it: without `replayed`, conflicts without their values (the
 * value now, and an undo's value written and value to restore), and of the folders a move took
 * along or left, the first INSIDE_KEPT with their counts.
 */
function storedResult(result: WriteResult): string {
  const decided: WriteResult = {
    ...result,
    results: result.results.map((op) =>
      op.inside === undefined
        ? op
        : {
            ...op,
            inside: {
              ...op.inside,
              along: op.inside.along.slice(0, INSIDE_KEPT),
              left: op.inside.left.slice(0, INSIDE_KEPT),
            },
          },
    ),
    conflicts: result.conflicts.map((conflict) => {
      const kept = { ...conflict };
      delete kept.value;
      delete kept.wrote;
      delete kept.restore;
      return kept;
    }),
  };
  delete decided.replayed;
  return JSON.stringify(decided);
}

/**
 * Keeps the answer the caller was given with the receipt of its request (WriteResult.given), in
 * the caller's transaction: once, and only on the receipt of the intent with `fingerprint`. A
 * receipt of another intent, one that keeps an answer already, or none at all, is left as it is.
 * Returns whether it kept it.
 */
export function keepGiven(
  conn: Connection,
  lookup: ReceiptLookup & { readonly fingerprint: string },
  given: Given,
): boolean {
  if (!conn.inTransaction) throw misuse("An answer is kept in a transaction");
  const plain = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const kept = given.result;
  if (!FINGERPRINT.test(given.sent) || !FINGERPRINT.test(lookup.fingerprint) || !plain(kept)) {
    throw misuse("An answer is kept as an object, under the fingerprints of its intent");
  }
  const found = readReceipt(conn, lookup);
  if (found?.fingerprint !== lookup.fingerprint || found.result.given !== undefined) return false;
  const result = { ...found.result, given };
  conn.prepare(SQL.result).run({
    scope: lookup.scope_id,
    request: lookup.request_id,
    fingerprint: lookup.fingerprint,
    result: storedResult(result),
  });
  return true;
}

/**
 * Writes the receipt of a decided request, inside the request's write transaction, under the
 * request's current writer scope.
 */
export function writeReceipt(
  conn: Connection,
  receipt: { request: CheckedRequest; fingerprint: string; result: WriteResult; at: number },
): void {
  if (!conn.inTransaction) throw misuse("A receipt is written in its request's transaction");
  const { request, fingerprint, result, at } = receipt;
  conn.prepare(SQL.insert).run({
    scope: request.actor.scope_id,
    request: request.request_id,
    fingerprint,
    status: result.status,
    seq: result.status === "applied" ? result.seq : null,
    epoch: result.epoch,
    incarnation: result.incarnation,
    result: storedResult(result),
    at,
  });
}
