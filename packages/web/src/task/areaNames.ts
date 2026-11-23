// The area picker's guess at the area a typed name means. It only orders the picker's choices: the
// service decides by its own rules what a name names when the area is made.
import { editDistance } from "@ttasks/contracts/query-terms";

/** A name as the service compares it: case and repeated spaces aside. */
const key = (name: string): string =>
  name.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

/** A name without its accents too, for a guess. */
const loose = (name: string): string =>
  key(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .normalize("NFC");

/** Whether an area of name `name` is the area named `typed`: making it gives that area back. */
export const sameName = (name: string, typed: string): boolean => key(name) === key(typed);

/**
 * Whether `typed` is likely a slip for `name`: other accents, or at most two edits (a swap of two
 * letters is one) and under half of the name.
 */
export function closeName(name: string, typed: string): boolean {
  if (sameName(name, typed)) return false;
  const a = loose(name);
  const b = loose(typed);
  const length = Array.from(a).length;
  if (Math.abs(length - Array.from(b).length) > 2) return false;
  const distance = editDistance(a, b);
  return distance <= 2 && distance * 2 < length;
}
