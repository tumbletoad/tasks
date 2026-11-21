// The canonical JSON of an intent (A1 3.8: "SHA-256 over the RFC 8785 form"). RFC 8785, the JSON
// Canonicalization Scheme, serialises plain JSON data in one way: object members sorted by their
// names as UTF-16 code units, no whitespace, and numbers and strings as ECMAScript's JSON.stringify
// writes them. TTasks's intents are plain data (strings, finite numbers, booleans, null, arrays and
// plain objects), so JSON.stringify's own rules serve for every leaf, and only the member order
// needs this module.

/** Intents nest only a few levels. A deeper value is refused rather than risk the stack. */
const MAX_DEPTH = 64;

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Whether `value` is plain JSON data that `canonicalJson` serialises: strings, finite numbers,
 * booleans, null, dense arrays of such values and plain objects whose members are such values or
 * undefined (a member that is undefined counts as absent, as JSON.stringify leaves it out).
 */
export function isJsonData(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!isJsonData(value[i], depth + 1)) return false;
    }
    return true;
  }
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((item) => item === undefined || isJsonData(item, depth + 1));
}

/** The RFC 8785 form of plain JSON data. Check it with `isJsonData` first. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    // The default sort compares UTF-16 code units, which is RFC 8785's order (3.2.3).
    const names = Object.keys(record)
      .filter((name) => record[name] !== undefined)
      .sort();
    return `{${names.map((name) => `${JSON.stringify(name)}:${canonicalJson(record[name])}`).join(",")}}`;
  }
  // A finite number as Number.prototype.toString writes it (-0 as 0), a string with JSON's
  // minimal escapes, true, false and null: RFC 8785 3.2.2.
  return JSON.stringify(value);
}
