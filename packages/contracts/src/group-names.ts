// When two names of an area or a project are one name, and when one is a typo of the other. The
// service resolves a name by these rules, and the page offers what the service would take: no
// dependencies, so the page can import it.
import { editDistance } from "./query-terms.ts";

/** An unknown name this close to an existing one is a typo, not a new group. */
export const TYPO_DISTANCE = 2;

/**
 * A name as it is compared: without accents, in lower case, with inner spaces collapsed. Accents
 * are the combining diacritical marks (U+0300 to U+036F), so marks that make another letter in
 * other scripts still count.
 */
export const fold = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();

/** Whether two names are one name: they differ at most in case, accents and spaces. */
export const sameName = (a: string, b: string): boolean => fold(a) === fold(b);

/**
 * Whether `wanted` is a typo of `name`, both folded: within TYPO_DISTANCE edits, and under half of
 * `name`'s length, so "Client wrok" is a typo of "Client work" and "UX" no typo of "QA".
 */
export function typoOf(name: string, wanted: string): boolean {
  const length = Array.from(name).length;
  if (Math.abs(length - Array.from(wanted).length) > TYPO_DISTANCE) return false;
  const distance = editDistance(name, wanted);
  return distance <= TYPO_DISTANCE && distance * 2 < length;
}

/** Whether `wanted` is not `name` but close to it: what a person most likely meant. */
export const closeName = (name: string, wanted: string): boolean =>
  !sameName(name, wanted) && typoOf(fold(name), fold(wanted));
