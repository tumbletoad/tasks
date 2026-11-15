// Possible duplicates by title (A3 3.4.5): a new task whose title is close to an active task's in
// the group it lands in comes back with a `possible duplicate` warning. It never blocks: a source
// key decides what is the same item (A1 3.6), and a title only hints at it.
//
// Close means a Dice coefficient of at least 0.7 over the character trigrams of the two titles,
// folded (NFKC, lower case, letters and digits only, one space between words): word order and a
// plural barely move it, and "time zones" and "timezones" stay close. Titles with different numbers
// are never close: "Invoice 12" and "Invoice 13" are a series, not a duplicate.
import type { Destination, Sibling } from "./read.ts";

/** A3 3.4.5: the Dice coefficient at which two titles are a possible duplicate. */
export const SIMILAR_DICE = 0.7;

/** At most this many tasks named in one draft's warning. */
const NAMED = 3;

/** A title as it is compared: letters and digits, one space between words, lower case. */
const folded = (title: string): string =>
  title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The numbers in a folded title, sorted: two titles with other numbers name other items. */
const numbers = (title: string): string => (title.match(/\p{N}+/gu) ?? []).sort().join(" ");

function trigrams(title: string): Set<string> {
  const chars = Array.from(` ${folded(title)} `);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i += 1) grams.add(chars.slice(i, i + 3).join(""));
  return grams;
}

/** Whether two titles are close enough to name one as a possible duplicate of the other. */
export function similarTitles(a: string, b: string): boolean {
  const x = folded(a);
  const y = folded(b);
  if (x === "" || y === "") return false;
  if (x === y) return true;
  if (numbers(x) !== numbers(y)) return false;
  const ga = trigrams(a);
  const gb = trigrams(b);
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return (2 * shared) / (ga.size + gb.size) >= SIMILAR_DICE;
}

const same = (a: Destination, b: Destination): boolean =>
  a.project !== null
    ? a.project === b.project
    : b.project === null && a.area === b.area && (a.area !== null || a.inbox === b.inbox);

/** How a warning names the group the two share. */
const where = (d: Destination): string =>
  d.project !== null
    ? "same project"
    : d.area !== null
      ? "same area"
      : d.inbox
        ? "both in the Inbox"
        : "both without an area";

/**
 * The warning for a draft at input path `path` landing at `destination`, or undefined: the active
 * tasks of that group whose titles are close to `title`, newest first, by reference only (a title
 * is data, and a warning stands outside the data block).
 */
export function duplicateWarning(
  path: string,
  title: string,
  destination: Destination,
  siblings: readonly Sibling[],
): string | undefined {
  const refs = siblings
    .filter((s) => same(destination, s.destination) && similarTitles(title, s.title))
    .map((s) => s.ref);
  if (refs.length === 0) return undefined;
  const named = refs.slice(0, NAMED).join(", ");
  const more = refs.length > NAMED ? ` and ${String(refs.length - NAMED)} more` : "";
  return `${path}: possible duplicate of ${named}${more} (${where(destination)}, similar title)`;
}
