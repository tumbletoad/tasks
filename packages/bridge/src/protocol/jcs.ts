// RFC 8785 canonical JSON (JCS), which the transcript hash and the bound proof cover (A2 3.6.3).
// Object keys sorted by UTF-16 code units, no whitespace, strings and numbers as ECMAScript's
// JSON.stringify writes them. Values that JSON cannot carry (undefined, functions, NaN,
// Infinity, BigInt), strings or keys with a lone surrogate (RFC 8785 3.2.2.2 requires I-JSON),
// array holes and nesting deeper than the limit are refused, never skipped.
import { MAX_JSON_DEPTH } from "./constants.ts";

export class CanonicalJsonError extends Error {
  constructor(what: string) {
    super(`Cannot write canonical JSON: ${what}`);
    this.name = "CanonicalJsonError";
  }
}

/** The canonical JSON text of `value`. Throws CanonicalJsonError for anything JSON cannot hold. */
export function canonicalJson(value: unknown, maxDepth: number = MAX_JSON_DEPTH): string {
  return write(value, 0, maxDepth);
}

function write(value: unknown, depth: number, maxDepth: number): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return writeString(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("a number that is not finite");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`a value of type ${typeof value}`);
  }
  if (depth >= maxDepth) throw new CanonicalJsonError("nesting too deep");
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      // map() skips a hole, which would give "[]" or "[,]". JSON.stringify writes it as null.
      if (!Object.hasOwn(value, index)) throw new CanonicalJsonError("an array with a hole");
      items.push(write(value[index], depth + 1, maxDepth));
    }
    return `[${items.join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError("an object that is not a plain object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const members = keys.map(
    (key) => `${writeString(key)}:${write(record[key], depth + 1, maxDepth)}`,
  );
  return `{${members.join(",")}}`;
}

function writeString(text: string): string {
  if (!text.isWellFormed()) throw new CanonicalJsonError("a string with a lone surrogate");
  return JSON.stringify(text);
}
