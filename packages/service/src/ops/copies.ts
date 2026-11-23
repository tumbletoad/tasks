// Which space an ID, a name or a folder means (A2 3.10.5). A restored copy keeps its original's
// space ID and name, but one folder serves a space at a time (hub/spaces.ts, ONE COPY AT A TIME), so
// nothing chooses between copies: every lookup by ID or name (an unbound call's space and
// `--space`, the machine's default, a bridge's pin, the page's feed and routes, the space verbs)
// means the folder that serves the space, or, while none does, the first one listed, whose state
// says why it is not served.
//
// - A folder (an absolute path) names its own entry, in whatever state.
// - A name that two different spaces have is `ambiguous`: the ID names one of them.
import { isAbsolute, resolve } from "node:path";
import { PRODUCT_NAME } from "@ttasks/brand";
import { AppError } from "@ttasks/contracts";

/** What a lookup reads of a space. */
export interface Copy {
  /** The ID read from its folder, once served: what an ID names. */
  readonly id: string | undefined;
  /**
   * The ID its entry names, also before it is served: an unavailable copy is still a copy of that
   * space, so it never makes "the one space served" two.
   */
  readonly registered?: string | undefined;
  readonly name?: string | undefined;
  readonly state: string;
  readonly reason?: string | undefined;
  readonly folder?: string | undefined;
}

/** Several spaces with one name. */
export interface Ambiguity<S> {
  readonly ambiguous: "name";
  readonly candidates: readonly S[];
}

export type Found<S> = S | Ambiguity<S> | undefined;

export function isAmbiguity<S extends Copy>(found: Found<S>): found is Ambiguity<S> {
  return found !== undefined && "ambiguous" in found;
}

/** Whether the folder serves its space now, or is about to (opening) or just was (closing). */
const isServed = (copy: Copy): boolean =>
  copy.state === "open" ||
  copy.state === "read_only" ||
  copy.state === "opening" ||
  copy.state === "closing";

/** Among the entries of one space: the one that serves it, else the first listed. */
const servingOf = <S extends Copy>(copies: readonly S[]): S | undefined =>
  copies.find(isServed) ?? copies[0];

/** Whether two folders are one, as the OS compares names: case folded on Windows and macOS. */
export function sameFolder(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const fold = (path: string) =>
    platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;
  return fold(resolve(a)) === fold(resolve(b));
}

/**
 * The entries of each space among `spaces`, by ID, the entry's ID for a copy not served yet; a
 * space without either is a group of its own.
 */
function bySpace<S extends Copy>(spaces: readonly S[]): S[][] {
  const groups = new Map<unknown, S[]>();
  for (const space of spaces) {
    const key = space.id ?? space.registered ?? space;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [space]);
    else group.push(space);
  }
  return [...groups.values()];
}

/**
 * The space `wanted` names among `spaces`: an absolute path is a folder and only a folder (a space
 * whose name looks like a path never stands in for the space at that path); else an ID; else a
 * name, case folded.
 */
export function findSpace<S extends Copy>(spaces: readonly S[], wanted: string): Found<S> {
  if (isAbsolute(wanted)) {
    return spaces.find((space) => space.folder !== undefined && sameFolder(space.folder, wanted));
  }
  const byId = spaces.filter((space) => space.id === wanted);
  if (byId.length > 0) return servingOf(byId);
  const folded = wanted.toLowerCase();
  const groups = bySpace(spaces.filter((space) => space.name?.toLowerCase() === folded));
  if (groups.length > 1) return { ambiguous: "name", candidates: groups.flat() };
  return servingOf(groups[0] ?? []);
}

/** The entry of the space `id` among `spaces`: the one that serves it, else the first listed. */
export function copyOf<S extends Copy>(spaces: readonly S[], id: string): S | undefined {
  return servingOf(spaces.filter((space) => space.id === id));
}

/**
 * The one space among `spaces` (the entry that serves it), when all of them are entries of one
 * space; `several` when they hold more than one; undefined when there is none.
 */
export function onlySpace<S extends Copy>(spaces: readonly S[]): S | "several" | undefined {
  const groups = bySpace(spaces);
  if (groups.length > 1) return "several";
  return servingOf(groups[0] ?? []);
}

/**
 * A page's call for a copy of its space that is not the one served now: the space was closed,
 * restored in place, claimed, or another folder of it opened since the page loaded it. Nothing of
 * the call is done, and nothing the page sends is written into a copy it did not show.
 */
export function spaceChanged(): AppError {
  return new AppError({
    code: "space_unavailable",
    message: "This space was closed, restored or claimed since this page loaded it.",
    hint: "Load it again to see it as it is now. Nothing more is saved from this page.",
    data: { reason: "replaced", retryable: false },
  });
}

/**
 * An agent session's call once another copy serves its space than the one its launch or run was
 * made in (a claim or a restore in place): what the agent read and holds is of that copy, so nothing
 * of the call is done, and a retry would be refused the same way.
 */
export function sessionReplaced(): AppError {
  return new AppError({
    code: "space_unavailable",
    message: "This space was restored since this session began. Nothing of this call was done.",
    hint: `Do not retry. Tell the user; they start the agent again from the task in ${PRODUCT_NAME}.`,
    data: { reason: "replaced", retryable: false },
  });
}

/** `ambiguous` (A3 3.5) for several spaces with one name. */
export function ambiguousError(hint?: string): AppError {
  return new AppError({
    code: "ambiguous",
    message: "Several spaces have this name.",
    hint: hint ?? "Name the space by its ID: ttasks space list.",
  });
}
