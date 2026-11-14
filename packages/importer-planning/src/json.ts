// Reading one JSON file of the prototype, bounded and total.

import { problem, type Problem } from "./problems.ts";
import { byteLength, decode, type Source } from "./text.ts";

export type JsonRead =
  | { readonly ok: true; readonly value: unknown; readonly problems: Problem[] }
  | { readonly ok: false; readonly problems: Problem[] };

/**
 * Where JSON.parse could not keep a number as written: for each object or array of a parsed value,
 * its keys whose value is such a number or holds one at any depth.
 */
export type Inexact = WeakMap<object, Set<string>>;

/**
 * Parses a JSON file. Over `maxBytes` it is not read (`file-too-large`). Text that is no JSON gives
 * `json-invalid`, and the parser's own message is never kept, because it quotes the input. With
 * `inexact`, every number whose value differs from its text (`exactNumber`) is recorded there.
 */
export function readJson(
  source: Source,
  file: string,
  maxBytes: number,
  inexact?: Inexact,
): JsonRead {
  if (byteLength(source) > maxBytes) {
    return { ok: false, problems: [problem("file-too-large", { file })] };
  }
  const { text, problems } = decode(source, file);
  try {
    const value: unknown =
      inexact === undefined ? JSON.parse(text) : JSON.parse(text, recorder(inexact));
    return { ok: true, value, problems };
  } catch {
    // SyntaxError, or a RangeError from very deep nesting.
    problems.push(problem("json-invalid", { file }));
    return { ok: false, problems };
  }
}

/**
 * A reviver that records inexact numbers and returns every value as it is. JSON.parse revives
 * children before their holder, so a holder that holds an inexact value is known by the time its
 * own holder is revived.
 */
function recorder(inexact: Inexact) {
  return function (this: object, key: string, value: unknown, context?: { source?: string }) {
    const off =
      typeof value === "number"
        ? context?.source !== undefined && !exactNumber(context.source, value)
        : typeof value === "object" && value !== null && inexact.has(value);
    if (off) {
      const keys = inexact.get(this) ?? new Set<string>();
      keys.add(key);
      inexact.set(this, keys);
    }
    return value;
  };
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
