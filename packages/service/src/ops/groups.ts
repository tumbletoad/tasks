// Areas and projects by name (A3 3.4.5, 3.4.10): a caller names a group as people do, and the
// writer takes IDs and slugs only (A1 3.6). A name matches an area's or a project's name or slug,
// ignoring case, else an old slug; a project named beside an area is looked for in that area
// first. A name that matches nothing but lies within edit distance 2 of a group's name or slug is
// `invalid_input` with the close names in `data.suggestions` (stored names never reach a message,
// A3 3.5), which stops "Client Work" from appearing beside "Client work". Any other new name is
// created under autonomy once A1's `area.create` and `project.create` exist (M4.01b); until then it
// is refused naming that step.
import { AppError } from "@tasks/contracts";
import { unsupported } from "./errors.ts";
import type { GroupName, GroupNames } from "./read.ts";

/** A3 3.4.5: an unknown name this close to an existing one is a typo, not a new group. */
export const TYPO_DISTANCE = 2;

/** At most this many close names in a refusal. */
const SUGGESTIONS = 5;

/** A name as it is compared: NFKC, lower case, inner spaces collapsed. */
export const fold = (name: string): string =>
  name.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

/**
 * The edit distance of two strings by code point, or `limit + 1` once it is certainly above
 * `limit`: insertions, deletions and substitutions each cost one.
 */
export function editDistance(a: string, b: string, limit: number): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > limit) return limit + 1;
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return Math.min(previous[y.length] ?? limit + 1, limit + 1);
}

type Kind = "area" | "project";

const exact = (group: GroupName, wanted: string): boolean =>
  group.id === wanted || group.slug === fold(wanted) || fold(group.title) === fold(wanted);

/**
 * The ID of the area or project `name` names, at input path `path`. `area` is the area the caller
 * named beside a project: a project there wins over one of the same name elsewhere.
 */
export function resolveGroup(
  names: GroupNames,
  kind: Kind,
  name: string,
  path: string,
  area?: string,
): string {
  const groups = kind === "area" ? names.areas : names.projects;
  let found = groups.filter((group) => exact(group, name));
  if (found.length > 1 && area !== undefined) {
    const inArea = found.filter((group) => group.area === area);
    if (inArea.length > 0) found = inArea;
  }
  if (found.length === 0) {
    const old = names.aliases.filter((a) => a.kind === kind && a.alias === fold(name));
    found = groups.filter((group) => old.some((a) => a.id === group.id));
  }
  const [one, ...more] = found;
  if (one !== undefined && more.length === 0) return one.id;
  if (one !== undefined) {
    throw new AppError({
      code: "ambiguous",
      message: `Several ${kind === "area" ? "areas" : "projects"} have this name.`,
      hint: "Name it by its slug: organize with action list shows each one's.",
      data: {
        issues: [{ path, message: "Several have this name" }],
        suggestions: found.slice(0, SUGGESTIONS).map((group) => group.slug),
      },
    });
  }
  const wanted = fold(name);
  const close = groups.filter(
    (group) =>
      editDistance(fold(group.title), wanted, TYPO_DISTANCE) <= TYPO_DISTANCE ||
      editDistance(group.slug, wanted, TYPO_DISTANCE) <= TYPO_DISTANCE,
  );
  if (close.length > 0) {
    throw new AppError({
      code: "invalid_input",
      message: `No ${kind} has this name, and one is close to it.`,
      hint: "Use the existing name if it is the same group: see the suggestions.",
      data: {
        issues: [{ path, message: "Close to an existing name" }],
        suggestions: close.slice(0, SUGGESTIONS).map((group) => group.title),
      },
    });
  }
  throw unsupported(path, "M4.01b (creating an area or project by name)");
}
