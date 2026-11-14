// Defensive readers for parsed JSON. A stream line is untrusted input: any field may be missing,
// of another type, huge or hostile, so the parsers read every value through these and never index
// into a value they have not checked.
import { TEXT_CAP_BYTES } from "./events.ts";

export type Json = Record<string, unknown>;

export const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const record = (v: unknown): Json | undefined => (isRecord(v) ? v : undefined);

export const string = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export const array = (v: unknown): readonly unknown[] | undefined =>
  Array.isArray(v) ? v : undefined;

/** A token count: a finite, non-negative, safe integer. */
export function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** A cost: a finite, non-negative number. */
export function amount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Adds counts without leaving the safe integer range. */
export function addCounts(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a + b, Number.MAX_SAFE_INTEGER);
}

/** Native IDs are UUIDs (Claude) or thread IDs (Codex): short, plain characters only. */
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const nativeId = (v: unknown): string | undefined =>
  typeof v === "string" && NATIVE_ID.test(v) ? v : undefined;

const encoder = new TextEncoder();
const capBuffer = new Uint8Array(TEXT_CAP_BYTES);

/**
 * The text made well-formed (no lone surrogates) and cut to at most `cap` UTF-8 bytes on a code
 * point boundary. `capped` says whether anything was cut.
 */
export function capText(text: string, cap = TEXT_CAP_BYTES): { text: string; capped: boolean } {
  const whole = text.toWellFormed();
  // Each UTF-16 unit is at most 3 UTF-8 bytes, so a short text cannot be over the cap.
  if (whole.length * 3 <= cap) return { text: whole, capped: false };
  const out = cap === TEXT_CAP_BYTES ? capBuffer : new Uint8Array(cap);
  // encodeInto writes whole code points only, so `read` ends on a code point boundary.
  const { read } = encoder.encodeInto(whole, out);
  return read >= whole.length
    ? { text: whole, capped: false }
    : { text: whole.slice(0, read), capped: true };
}
