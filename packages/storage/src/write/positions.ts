// Positions inside a group (A1 3.4): `position TEXT` is a fractional index, so a move writes one
// row. The format is David Greenspan's fractional indexing ("Implementing Fractional Indexing",
// 2020), the scheme of the CC0 `fractional-indexing` package, written here from its description
// (A1 3.4).
//
// A position is an integer part followed by a fraction part, in base 62 with the digits
// `0-9A-Za-z`, which sort in ASCII order. The integer part's first character gives its length:
// `a` to `z` start integers of 2 to 27 characters that grow upwards from `a0`, and `Z` to `A`
// integers of 2 to 27 characters that grow downwards from `Zz`. The fraction part never ends in
// `0`, so every position has one spelling, and there is always room between two positions.
// Positions compare as plain strings: JavaScript's `<` and SQLite's BINARY collation agree on ASCII.
// Appending after the last position only increments the integer part, so a group that grows at its
// end keeps short positions: `a0`, `a1`, … `az`, `b00`.
import { misuse } from "../errors.ts";

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = "0";
const LAST = "z";

/** The first position of an empty group. */
export const FIRST_POSITION = "a0";

/** The smallest integer part, which no position may be on its own (nothing could sort before it). */
const SMALLEST = `A${ZERO.repeat(26)}`;

const isDigit = (char: string): boolean => char.length === 1 && DIGITS.includes(char);

/** The length of the integer part that starts with `head`, or undefined for another character. */
function integerLength(head: string): number | undefined {
  const code = head.charCodeAt(0);
  if (code >= 97 && code <= 122) return code - 97 + 2; // a to z
  if (code >= 65 && code <= 90) return 90 - code + 2; // Z to A
  return undefined;
}

/** Whether `value` is a position in the format above. */
export function isPosition(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2) return false;
  const length = integerLength(value.charAt(0));
  if (length === undefined || value.length < length) return false;
  for (let i = 1; i < value.length; i += 1) if (!isDigit(value.charAt(i))) return false;
  if (value === SMALLEST) return false;
  return !(value.length > length && value.endsWith(ZERO));
}

function split(position: string): { integer: string; fraction: string } {
  const length = integerLength(position.charAt(0)) ?? 0;
  return { integer: position.slice(0, length), fraction: position.slice(length) };
}

/**
 * A fraction strictly between `a` and `b` (`b` undefined: 1). Neither ends in `0`. A loop, not
 * recursion: a position can hold a long run of equal digits, one step each.
 */
function midpoint(a: string, b: string | undefined): string {
  let prefix = "";
  let low = a;
  let high = b;
  for (;;) {
    if (high !== undefined) {
      // Drop the common prefix, padding `low` with zeros: `high` cannot end inside the prefix.
      let n = 0;
      while ((low.charAt(n) || ZERO) === high.charAt(n)) n += 1;
      if (n > 0) {
        prefix += high.slice(0, n);
        low = low.slice(n);
        high = high.slice(n);
      }
    }
    const digitA = low === "" ? 0 : DIGITS.indexOf(low.charAt(0));
    const digitB = high === undefined ? DIGITS.length : DIGITS.indexOf(high.charAt(0));
    if (digitB - digitA > 1) return prefix + DIGITS.charAt(Math.round((digitA + digitB) / 2));
    // The first digits are next to each other.
    if (high !== undefined && high.length > 1) return prefix + high.slice(0, 1);
    prefix += DIGITS.charAt(digitA);
    low = low.slice(1);
    high = undefined;
  }
}

/** The next integer part, or undefined after the largest. */
function increment(integer: string): string | undefined {
  const head = integer.charAt(0);
  const digits = integer.slice(1).split("");
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const next = DIGITS.indexOf(digits[i] ?? ZERO) + 1;
    if (next < DIGITS.length) {
      digits[i] = DIGITS.charAt(next);
      return head + digits.join("");
    }
    digits[i] = ZERO;
  }
  // Every digit carried: the integer grows by one character (or crosses from Z to a).
  if (head === "Z") return `a${ZERO}`;
  if (head === "z") return undefined;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > "a") digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join("");
}

/** The previous integer part, or undefined before the smallest. */
function decrement(integer: string): string | undefined {
  const head = integer.charAt(0);
  const digits = integer.slice(1).split("");
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const previous = DIGITS.indexOf(digits[i] ?? ZERO) - 1;
    if (previous >= 0) {
      digits[i] = DIGITS.charAt(previous);
      return head + digits.join("");
    }
    digits[i] = LAST;
  }
  if (head === "a") return `Z${LAST}`;
  if (head === "A") return undefined;
  const previousHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (previousHead < "Z") digits.push(LAST);
  else digits.pop();
  return previousHead + digits.join("");
}

/**
 * A position strictly between `before` and `after`: undefined `before` means the start of the
 * group, undefined `after` its end. Throws STORAGE_MISUSE for an invalid position or when
 * `before` does not sort below `after`. Positions TTasks reads from a space are checked by the
 * caller first, which reports a bad stored value as SPACE_INVALID.
 */
export function positionBetween(before: string | undefined, after: string | undefined): string {
  if (before !== undefined && !isPosition(before)) throw misuse("Not a position");
  if (after !== undefined && !isPosition(after)) throw misuse("Not a position");
  if (before !== undefined && after !== undefined && before >= after) {
    throw misuse("The first position must sort before the second");
  }
  if (before === undefined) {
    if (after === undefined) return FIRST_POSITION;
    const { integer, fraction } = split(after);
    if (integer === SMALLEST) return integer + midpoint("", fraction);
    if (integer < after) return integer;
    const previous = decrement(integer);
    if (previous === undefined) throw misuse("No position sorts before this one");
    // The smallest integer part is no position on its own, so it takes a fraction.
    return previous === SMALLEST ? previous + midpoint("", undefined) : previous;
  }
  const a = split(before);
  if (after === undefined) {
    const next = increment(a.integer);
    return next ?? a.integer + midpoint(a.fraction, undefined);
  }
  const b = split(after);
  if (a.integer === b.integer) return a.integer + midpoint(a.fraction, b.fraction);
  const next = increment(a.integer);
  if (next === undefined) throw misuse("No position sorts after this one");
  return next < after ? next : a.integer + midpoint(a.fraction, undefined);
}
