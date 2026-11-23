// Which copy of a space an ID or a name means (A2 3.10.5). A restored copy keeps its original's
// space ID and name, and so does a claimed copy, so one service can serve several copies of one
// space. Every lookup by ID or name goes through here (an unbound call's space and `--space`, the
// machine's default, a bridge's pin, the page's feed and routes, the space verbs), so each of them
// means the same copy:
//
// - A folder (an absolute path) names its own copy, in whatever state: the way to reach a copy that
//   the rule below does not pick. So does a copy's key (`copyKey`), which the page puts in its
//   addresses so that a folder never goes into a URL.
// - Among the copies that have the ID, or the copies of the one space that has the name, the copy
//   that serves it best: the writable one (`open`); else one opening or closing, for a moment
//   (whose answer is "retry"); else the space read-only for a reason of its own (its folder, a
//   failed migration, another machine's authority); else a restored copy not claimed yet
//   (`read_only_copy`); else an unavailable one; else a closed one.
// - Two copies at the best rank are `ambiguous`, never the first one listed, and the error names
//   their folders. One service never has two writable copies (storage keeps one writer per space
//   ID in a process), so that is two read-only copies, or two that are unavailable or closed. Two
//   copies opening at once are not: either one answers that the space is still opening.
// - A name that two different spaces have is `ambiguous` too: the ID names one of them.
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { AppError } from "@ttasks/contracts";

/** What the rule reads of a space. */
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

/** Several candidates: copies of one space at the same rank, or several spaces with one name. */
export interface Ambiguity<S> {
  readonly ambiguous: "copies" | "name";
  readonly candidates: readonly S[];
}

export type Found<S> = S | Ambiguity<S> | undefined;

export function isAmbiguity<S extends Copy>(found: Found<S>): found is Ambiguity<S> {
  return found !== undefined && "ambiguous" in found;
}

/** How well a copy serves its ID: lower is better. */
function rankOf(copy: Copy): number {
  switch (copy.state) {
    case "open":
      return 0;
    case "opening":
    case "closing":
      return 1;
    case "read_only":
      return copy.reason === "read_only_copy" ? 3 : 2;
    case "unavailable":
      return 4;
    default:
      return 5;
  }
}

/** The copy an ID means among `copies`, all of one space. */
export function chooseCopy<S extends Copy>(copies: readonly S[]): Found<S> {
  if (copies.length <= 1) return copies[0];
  const best = Math.min(...copies.map(rankOf));
  const top = copies.filter((copy) => rankOf(copy) === best);
  // Copies opening or closing at once: either one's answer is "retry in a moment".
  if (top.length === 1 || best === 1) return top[0];
  return { ambiguous: "copies", candidates: top };
}

/** A folder as the OS compares names: resolved, case folded on Windows and macOS. */
const folded = (path: string, platform: NodeJS.Platform): string =>
  platform === "win32" || platform === "darwin" ? resolve(path).toLowerCase() : resolve(path);

/** Whether two folders are one, as the OS compares names. */
export function sameFolder(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return folded(a, platform) === folded(b, platform);
}

/** A copy's key: its space's ID, `-copy-` and the start of its folder's digest. */
const COPY_KEY = /^sp_[0-9a-z]{26}-copy-[0-9a-f]{12}$/u;

/** The key that names the copy of space `id` in `folder`, and no other copy. */
export function copyKey(
  id: string,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const digest = createHash("sha256").update(folded(folder, platform)).digest("hex");
  return `${id}-copy-${digest.slice(0, 12)}`;
}

/** Whether `wanted` names one copy (a folder or a copy's key), not whichever copy an ID means. */
export const namesCopy = (wanted: string): boolean => isAbsolute(wanted) || COPY_KEY.test(wanted);

/**
 * The copies of each space among `spaces`, by ID, the entry's ID for a copy not served yet; a space
 * without either is a group of its own.
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
  if (COPY_KEY.test(wanted)) {
    // A copy that is opening again has only its entry's ID: it answers that it is opening.
    return spaces.find((space) => {
      const id = space.id ?? space.registered;
      return id !== undefined && space.folder !== undefined && copyKey(id, space.folder) === wanted;
    });
  }
  const byId = spaces.filter((space) => space.id === wanted);
  if (byId.length > 0) return chooseCopy(byId);
  const folded = wanted.toLowerCase();
  const groups = bySpace(spaces.filter((space) => space.name?.toLowerCase() === folded));
  if (groups.length > 1) return { ambiguous: "name", candidates: groups.flat() };
  return chooseCopy(groups[0] ?? []);
}

/** The copy the space `id` means among `spaces`. */
export function copyOf<S extends Copy>(spaces: readonly S[], id: string): Found<S> {
  return chooseCopy(spaces.filter((space) => space.id === id));
}

/**
 * How the page names `copy`, one of `spaces`, in its addresses: by its space's ID while that ID
 * means this copy and it is no restored copy waiting to be claimed; else by its key. A restored
 * copy has its key from the start, so a tab that shows it stays on it when its original opens.
 * Undefined for a copy not served yet, which has no ID.
 */
export function addressOf<S extends Copy>(spaces: readonly S[], copy: S): string | undefined {
  const { id, folder } = copy;
  if (id === undefined || folder === undefined) return id;
  if (copy.reason !== "read_only_copy" && copyOf(spaces, id) === copy) return id;
  return copyKey(id, folder);
}

/**
 * The one space among `spaces` (its copy that the rule picks), when all of them are copies of one
 * space; `several` when they hold more than one; undefined when there is none.
 */
export function onlySpace<S extends Copy>(spaces: readonly S[]): Found<S> | "several" {
  const groups = bySpace(spaces);
  if (groups.length > 1) return "several";
  return chooseCopy(groups[0] ?? []);
}

/** `ambiguous` (A3 3.5) for an ambiguity, naming the copies' folders. */
export function ambiguousError<S extends Copy>(found: Ambiguity<S>, hint?: string): AppError {
  if (found.ambiguous === "name") {
    return new AppError({
      code: "ambiguous",
      message: "Several spaces have this name.",
      hint: hint ?? "Name the space by its ID: ttasks space list.",
    });
  }
  const folders = found.candidates.flatMap((copy) =>
    copy.folder === undefined ? [] : [copy.folder],
  );
  return new AppError({
    code: "ambiguous",
    message:
      folders.length === 0
        ? "Several copies of this space are listed, and none of them takes writes."
        : `Several copies of this space are listed, and none of them takes writes: ${folders.join(", ")}.`,
    hint: hint ?? "Name the copy by its folder: --space <folder>.",
    ...(folders.length === 0 ? {} : { data: { folders } }),
  });
}
