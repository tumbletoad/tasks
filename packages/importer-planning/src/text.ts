// Text rules shared by the parsers, written to match the prototype's Python (A7 3.15.2):
// its line split, its whitespace, its string order and its file decoding.

import { problem, type Problem } from "./problems.ts";

/** Text or the raw bytes of a file. */
export type Source = string | Uint8Array;

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenient = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/**
 * Decodes a file as UTF-8. Invalid bytes become U+FFFD and give `invalid-utf8`, where the
 * prototype's own read would fail. A byte-order mark stays in the text, as Python's "utf-8" codec
 * keeps it, and gives `byte-order-mark`.
 */
export function decode(source: Source, file: string): { text: string; problems: Problem[] } {
  const problems: Problem[] = [];
  let text: string;
  if (typeof source === "string") {
    text = source;
  } else {
    try {
      text = strict.decode(source);
    } catch {
      text = lenient.decode(source);
      problems.push(problem("invalid-utf8", { file }));
    }
  }
  if (text.startsWith("﻿")) problems.push(problem("byte-order-mark", { file }));
  return { text, problems };
}

/** The size of a source in bytes, as the file holds it. */
export function byteLength(source: Source): number {
  return typeof source === "string" ? Buffer.byteLength(source, "utf8") : source.byteLength;
}

/** The line ends of Python's str.splitlines(). CR followed by LF is one line end. */
// eslint-disable-next-line no-control-regex -- Python ends lines at U+001C to U+001E too.
const LINE_END = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]", "g");

export interface Line {
  readonly text: string;
  /** The line end that closed this line, empty for a last line without one. */
  readonly end: string;
}

/** The lines of Python's str.splitlines(), one at a time: no empty last line after a final end. */
export function* eachLine(text: string): Generator<Line, void, undefined> {
  let start = 0;
  for (const match of text.matchAll(LINE_END)) {
    yield { text: text.slice(start, match.index), end: match[0] };
    start = match.index + match[0].length;
  }
  if (start < text.length) yield { text: text.slice(start), end: "" };
}

/** Splits text as Python's str.splitlines() does, into an array. */
export function splitLines(text: string): Line[] {
  return [...eachLine(text)];
}

/**
 * Python's whitespace (str.isspace() and `\s` in a str pattern). It differs from JavaScript's
 * `\s`: Python counts U+001C to U+001F and U+0085, JavaScript counts U+FEFF.
 */
export const PY_SPACE =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE = new RegExp(`^[${PY_SPACE}]$`);

/**
 * Python's str.strip() with no argument. Index loops, not `[\s]+$`: that pattern retries from every
 * position of a long run of inner whitespace and takes quadratic time.
 */
export function pyStrip(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && SPACE.test(value.charAt(start))) start += 1;
  while (end > start && SPACE.test(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/** Python's string order: by code point, where JavaScript's `<` compares UTF-16 units. */
export function compareCodePoints(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done === true) return q.done === true ? 0 : -1;
    if (q.done === true) return 1;
    const d = (p.value.codePointAt(0) ?? 0) - (q.value.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
}

/** A calendar date written YYYY-MM-DD: 2026-02-30 and 2026-13-01 are not dates. */
export function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

export function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
