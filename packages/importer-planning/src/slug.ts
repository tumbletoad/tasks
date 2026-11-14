// Areas and projects an import creates or reuses (A7 3.15.3): which titles are one group, and the
// slug each group gets.
//
// Identity (`groupKey`): the title's letters and digits in any script, in lower case, accents
// removed, every other run of characters as one `-`. So "Work", " work " and "Wörk" are one area,
// while "Работа" and "Дом" are two. A project's identity ignores a trailing `(…)`, so "Clinic sync
// (Q4)" and "Clinic sync" are one project. A title with no letter or digit ("🏠") is its own
// identity, compared without case and outer spaces.
//
// Slug (`groupSlug`): the same rule with ASCII letters and digits only, at most 48 characters; a
// project's slug ignores a trailing `(…)`, and its title keeps the full text (a project that is
// only `(…)` keeps it in its slug). A text with no ASCII letter or digit gives the kind's name
// (`area`, `project`). Distinct groups whose slugs meet take the next free number
// (`numberedSlug`), still within 48 characters.

export const SLUG_MAX = 48;

/**
 * The text without a trailing `(…)` that holds no parenthesis of its own. Index loops, not
 * `/\s*\([^()]*\)\s*$/`, which retries from every position of a long run of spaces.
 */
function withoutTrailingParen(text: string): string {
  const end = text.trimEnd();
  if (!end.endsWith(")")) return text;
  const open = end.lastIndexOf("(");
  if (open < 0 || end.indexOf(")", open) !== end.length - 1) return text;
  return end.slice(0, open);
}

/** Letters and digits of every script, lower case, accents removed, other runs as one `-`. */
function letters(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function slugOf(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

export function groupSlug(text: string, kind: "area" | "project"): string {
  const trimmed = kind === "project" ? slugOf(withoutTrailingParen(text)) : "";
  const slug = trimmed === "" ? slugOf(text) : trimmed;
  return slug === "" ? kind : slug;
}

/** A group's identity: two titles with one key are one group, titled as first written. */
export function groupKey(text: string, kind: "area" | "project"): string {
  const trimmed = kind === "project" ? letters(withoutTrailingParen(text)) : "";
  const key = trimmed === "" ? letters(text) : trimmed;
  // A title without a letter or digit: its own text. The NUL keeps it apart from every letter key.
  return key === "" ? `\u0000${text.normalize("NFC").trim().toLowerCase()}` : key;
}

/** `base`, or `base-2`, `base-3`… cut so the whole stays within 48 characters: the first not taken. */
export function numberedSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    const slug = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(slug)) return slug;
  }
}
