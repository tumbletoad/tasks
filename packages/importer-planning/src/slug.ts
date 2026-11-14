// Areas and projects an import creates or reuses (A7 3.15.3): which titles are one group, and the
// slug each group gets.
//
// Identity (`groupKey`): the title's letters and digits in any script, in lower case, accents
// removed, every other run of characters as one `-`. So "Work", " work " and "Wörk" are one area,
// while "Работа" and "Дом" are two. A title with no letter or digit ("🏠") is its own identity,
// compared without case and outer spaces.
//
// Slug (`groupSlug`): the same rule with ASCII letters and digits only, at most 48 characters. A
// text with no ASCII letter or digit gives the kind's name (`area`, `project`). Distinct groups
// whose slugs meet take the next free number (`numberedSlug`), still within 48 characters.
//
// A project's identity and slug both ignore a trailing `(…)`, so "Clinic sync (Q4)" and "Clinic
// sync" are one project, `clinic-sync`, and so are "🏠 (Q1)" and "🏠 (Q2)". Only a project that is
// nothing but `(…)` keeps it. Its title keeps the full text.

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

/**
 * The text a group's identity and slug come from: a project's title without a trailing `(…)`,
 * unless nothing but spaces is left of it; an area's whole title.
 */
function baseOf(text: string, kind: "area" | "project"): string {
  if (kind === "area") return text;
  const base = withoutTrailingParen(text);
  return base.trim() === "" ? text : base;
}

export function groupSlug(text: string, kind: "area" | "project"): string {
  const slug = slugOf(baseOf(text, kind));
  return slug === "" ? kind : slug;
}

/** A group's identity: two titles with one key are one group, titled as first written. */
export function groupKey(text: string, kind: "area" | "project"): string {
  const base = baseOf(text, kind);
  const key = letters(base);
  // A title without a letter or digit: its own text. The NUL keeps it apart from every letter key.
  return key === "" ? `\u0000${base.normalize("NFC").trim().toLowerCase()}` : key;
}

/**
 * `base`, or `base-2`, `base-3`… cut so the whole stays within 48 characters: the first not taken.
 * `next` keeps the number to try next per base, so many groups with one slug cost linear time.
 */
export function numberedSlug(
  base: string,
  taken: ReadonlySet<string>,
  next: Map<string, number>,
): string {
  if (!taken.has(base)) return base;
  for (let n = next.get(base) ?? 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    const slug = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(slug)) {
      next.set(base, n + 1);
      return slug;
    }
  }
}
