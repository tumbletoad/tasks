// The slug a new area or project gets from its title. The writer gives it, and a caller that stages
// several new groups in one request names them by it before the writer has.

/** The longest slug made from a title, before its number. */
const SLUG_FROM_TITLE = 48;

/**
 * A slug for a new group from its title: lower-case ASCII letters and digits with `-` between,
 * `kind` when nothing is left, and `-2`, `-3`, … after it while `held` says another group has it.
 */
export function freeSlug(title: string, kind: string, held: (slug: string) => boolean): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, SLUG_FROM_TITLE)
      .replace(/-+$/, "") || kind;
  if (!held(base)) return base;
  for (let n = 2; ; n += 1) {
    const slug = `${base}-${String(n)}`;
    if (!held(slug)) return slug;
  }
}
