// Areas and projects by name (A3 3.4.5, 3.4.10): a caller names a group as people do, and the
// writer takes IDs and slugs only (A1 3.6). A name matches an area's or a project's ID, name or
// slug, ignoring case, else an old slug; of several, the one named exactly wins, then a live one
// over archived ones. A project named beside an area must be one of that area's. A
// name that matches nothing but lies within edit distance 2 of a group's name or slug, and
// less than half that name's length from it, is `invalid_input` with the close names in
// `data.suggestions` (stored names never reach a message, A3 3.5): "Client wrok" is a typo of
// "Client work", while "UX" is no typo of "QA". Any other name is a new group, which the caller
// creates (`area.create`, `project.create`) in the same request. Where a name only looks a group
// up (organize's list), an unknown one is `not_found`. Where the caller asks to create the group by
// that name, a close one is new too: "Release 2" beside "Release 1" is meant.
import { AppError } from "@ttasks/contracts";
import { way, type Face } from "./errors.ts";
import type { GroupName, GroupNames } from "./read.ts";

/** A3 3.4.5: an unknown name this close to an existing one is a typo, not a new group. */
export const TYPO_DISTANCE = 2;

/** Whether `wanted` is a typo of `name`: within TYPO_DISTANCE, and under half of `name`'s length. */
function typoOf(name: string, wanted: string): boolean {
  const distance = editDistance(name, wanted, TYPO_DISTANCE);
  return distance <= TYPO_DISTANCE && distance * 2 < Array.from(name).length;
}

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

/**
 * A project named beside an area that holds no project of that name (A3 3.4.5): the areas of the
 * projects it matched go in `data.suggestions`, never in the message.
 */
function elsewhere(names: GroupNames, found: readonly GroupName[], path: string): AppError {
  const areas = names.areas.filter((a) => found.some((p) => p.area === a.id)).map((a) => a.title);
  return new AppError({
    code: "invalid_input",
    message: "The area named holds no project of this name.",
    hint: "Leave out area to use the project where it is, or name its own area: see the suggestions.",
    data: {
      issues: [{ path, message: "A project of another area" }],
      ...(areas.length === 0 ? {} : { suggestions: areas.slice(0, SUGGESTIONS) }),
    },
  });
}

/** A group matches by its ID, its slug or its title. */
const exact = (group: GroupName, wanted: string): boolean =>
  group.id === wanted ||
  (group.slug !== "" && group.slug === fold(wanted)) ||
  fold(group.title) === fold(wanted);

/**
 * Of several groups a name matches, the one it names: the one whose title is exactly the name, of
 * those or of all the live one, when only one is.
 */
function narrowed(found: readonly GroupName[], wanted: string): readonly GroupName[] {
  let out = found;
  for (const keep of [
    (group: GroupName) => group.title === wanted.trim(),
    (group: GroupName) => group.archived !== true,
  ]) {
    const kept = out.filter(keep);
    if (kept.length > 0) out = kept;
  }
  return out;
}

/**
 * The ID of the area or project `name` names, at input path `path`, or undefined for a new name:
 * one no group has and none is close to. `area` is the area the caller named beside a project: a
 * project there wins over one of the same name elsewhere. `lookup`: the name only looks a group up,
 * so an unknown one is `not_found` rather than a group to create. `create`: the caller creates the
 * group by this name, so one close to another's is new rather than a typo.
 */
export function resolveGroup(
  names: GroupNames,
  kind: Kind,
  name: string,
  path: string,
  options: {
    readonly area?: string | undefined;
    readonly lookup?: boolean;
    readonly create?: boolean;
    /** Where the caller reads the hint: how to create a group there. */
    readonly face?: Face;
  } = {},
): string | undefined {
  const { area } = options;
  const groups = kind === "area" ? names.areas : names.projects;
  let found = groups.filter((group) => exact(group, name));
  if (found.length === 0) {
    const old = names.aliases.filter((a) => a.kind === kind && a.alias === fold(name));
    found = groups.filter((group) => old.some((a) => a.id === group.id));
  }
  if (found.length > 0 && area !== undefined) {
    // The writer files a task under its project's own area, whatever area the call named (A1
    // 3.6), so a project only elsewhere would move the task out of the area asked for.
    const inArea = found.filter((group) => group.area === area);
    // A project created in an area is new there, whatever other areas hold.
    if (inArea.length === 0 && options.create === true) return undefined;
    if (inArea.length === 0) throw elsewhere(names, found, path);
    found = inArea;
  }
  const [one, ...more] = narrowed(found, name);
  if (one !== undefined && more.length === 0) return one.id;
  if (one !== undefined) {
    throw new AppError({
      code: "ambiguous",
      message: `Several ${kind === "area" ? "areas" : "projects"} have this name.`,
      hint: "Name it by its ID: organize with action list shows it beside the name.",
      data: {
        issues: [{ path, message: "Several have this name" }],
        suggestions: found.map((group) => group.id).slice(0, SUGGESTIONS),
      },
    });
  }
  const wanted = fold(name);
  const close = groups.filter(
    (group) => typoOf(fold(group.title), wanted) || typoOf(group.slug, wanted),
  );
  const suggestions = close.slice(0, SUGGESTIONS).map((group) => group.title);
  if (options.lookup === true) {
    throw new AppError({
      code: "not_found",
      message: `No ${kind} has this name.`,
      hint: "Call organize with action list for the names.",
      data: {
        issues: [{ path, message: "No such group" }],
        ...(suggestions.length === 0 ? {} : { suggestions }),
      },
    });
  }
  if (close.length > 0 && options.create !== true) {
    const face = options.face ?? "mcp";
    const tool = way(
      face,
      "group.manage",
      `create "${kind === "area" ? "<area>" : "<area>/<project>"}"`,
    );
    const how =
      tool === undefined ? "" : face === "mcp" ? ` with ${tool} action create` : `: ${tool}`;
    throw new AppError({
      code: "invalid_input",
      message: `No ${kind} has this name, and one is close to it.`,
      hint: `Use the existing name if it is the same group: see the suggestions. If it is another one, create it first${how}, then use its name.`,
      data: { issues: [{ path, message: "Close to an existing name" }], suggestions },
    });
  }
  return undefined;
}
