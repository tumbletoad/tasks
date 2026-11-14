// Slugs of the areas and projects an import creates or reuses (A7 3.15.3). A slug comes from the
// text: its letters and digits in lower case, accents removed, every other run of characters as one
// `-`, at most 48 characters. A project's slug ignores a trailing `(…)`, so "Clinic sync (Q4)" is
// `clinic-sync`; its title keeps the full text (a project that is only `(…)` keeps it in its slug).
// A text with no letter or digit gives the kind's name (`area`, `project`).

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
