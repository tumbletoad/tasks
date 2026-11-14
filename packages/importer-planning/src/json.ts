// Reading one JSON file of the prototype, bounded and total.

import { problem, type Problem } from "./problems.ts";
import { byteLength, decode, type Source } from "./text.ts";

export type JsonRead =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly problems: Problem[];
      /** With `numbers`: what JSON.parse made of each number it could not keep as written. */
      readonly inexact?: ReadonlySet<number>;
    }
  | { readonly ok: false; readonly problems: Problem[] };

/**
 * Parses a JSON file. Over `maxBytes` it is not read (`file-too-large`). Text that is no JSON gives
 * `json-invalid`, and the parser's own message is never kept, because it quotes the input. With
 * `numbers`, the result also holds `inexact` (`inexactNumbers`).
 */
export function readJson(
  source: Source,
  file: string,
  maxBytes: number,
  options: { readonly numbers?: boolean } = {},
): JsonRead {
  if (byteLength(source) > maxBytes) {
    return { ok: false, problems: [problem("file-too-large", { file })] };
  }
  const { text, problems } = decode(source, file);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // SyntaxError, or a RangeError from very deep nesting.
    problems.push(problem("json-invalid", { file }));
    return { ok: false, problems };
  }
  return options.numbers === true
    ? { ok: true, value, problems, inexact: inexactNumbers(text) }
    : { ok: true, value, problems };
}

/** A JSON string or a JSON number. Strings are matched whole, so a digit inside one is skipped. */
const TOKEN = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * The values JSON.parse gives the numbers of `text` (valid JSON) that it could not keep as written:
 * `1e400` gives Infinity, `1e-400` zero and `9007199254740993` 9007199254740992. A value of the
 * parse that is in this set may stand for such a number, so its key is left out. One linear scan
 * of the text: no reviver, whose recursion overflows on deep nesting and would fail the whole file.
 */
export function inexactNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const [token] of text.matchAll(TOKEN)) {
    if (token.startsWith('"')) continue;
    const value = Number(token);
    if (!exactNumber(token, value)) out.add(value);
  }
  return out;
}

/**
 * Whether the number JSON.parse gave is the number its text writes: the same decimal value, so
 * `1.50` and `1E2` are exact, while `9007199254740993` (rounded), `1e400` (Infinity) and `1e-400`
 * (zero) are not. The sign of a zero does not count.
 */
export function exactNumber(source: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const written = decimal(source);
  return written !== undefined && written === decimal(String(value));
}

/**
 * A decimal number's text in one form: its significant digits and the power of ten after them.
 * Index loops, not `/0+$/`, which retries from every position of a long run of zeros.
 */
function decimal(text: string): string | undefined {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (m === null) return undefined;
  const fraction = m[3] ?? "";
  const digits = `${m[2] ?? ""}${fraction}`;
  let start = 0;
  while (start < digits.length && digits.charAt(start) === "0") start += 1;
  if (start === digits.length) return "0";
  let end = digits.length;
  while (digits.charAt(end - 1) === "0") end -= 1;
  const exponent = Number(m[4] ?? "0") - fraction.length + (digits.length - end);
  return `${m[1] ?? ""}${digits.slice(start, end)}e${String(exponent)}`;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
