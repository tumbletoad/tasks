// A task's first path as a place: a root and a relative path (A7 3.15.3, A1 3.15). The mapping
// does no I/O, so the match is by the text of the paths: the root whose folder is the longest
// whole-segment prefix of the path wins, and the rest of the path is the place's relative path.
// The dry run (M7.04) checks on the machine which places resolve; a place bound by its root and
// path is not checked against the folder (A1 3.15).
//
// Paths are split at `/`, and a Windows path (`C:\…`, `\\server\…`) also at `\`, with its
// segments compared without case. Empty and `.` segments drop out. A `..` segment, a character a
// place's path never holds, or a relative path over 1,024 characters gives no place. Nor does a
// relative path SafeText would change (A3 3.10): the writer stores text normalised, and a
// decomposed `é` stored composed names another folder on Linux.

import { normaliseText } from "@tasks/contracts";

/** Root IDs as `machine.toml` names them (A1 3.15). */
export const ROOT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A root ID and its folder on this machine, as `--roots` or `machine.toml` give them. */
export type Roots = Readonly<Record<string, string>>;

export interface PlannedPlace {
  readonly root: string;
  /** `/`-separated and relative. `""` is the root itself. */
  readonly path: string;
}

/** A Windows drive path or a UNC path. */
const WINDOWS = /^(?:[A-Za-z]:[\\/]|\\\\)/;
/** A POSIX absolute path, a Windows drive path or a UNC path, as the parser reads `paths`. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** The relative path's limit and the characters it never holds (A1 3.15, the writer's rule). */
const PATH_MAX = 1_024;
const PATH_FORBIDDEN = new RegExp(
  "[" +
    "\\u0000-\\u001f\\u007f-\\u009f" + // C0 controls, DEL and the C1 controls
    "\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069" + // bidirectional controls
    "\\u200b-\\u200d\\u2060\\ufeff" + // zero-width characters
    "\\\\" + // the backslash
    "]",
  "u",
);
const DRIVE = /^[A-Za-z]:/;

export function isAbsolutePath(path: string): boolean {
  return ABSOLUTE.test(path);
}

export interface Split {
  readonly windows: boolean;
  readonly segments: readonly string[];
}

/** The segments of an absolute path, or undefined when it is not absolute or climbs with `..`. */
export function split(path: string): Split | undefined {
  if (!ABSOLUTE.test(path)) return undefined;
  const windows = WINDOWS.test(path);
  const segments = path.split(windows ? /[\\/]/ : "/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return undefined;
  return { windows, segments };
}

const same = (a: string, b: string, windows: boolean): boolean =>
  windows ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * The place of `path` under the longest matching root, or undefined. Two roots with one folder:
 * the first root ID in code-point order.
 */
export function placeFor(path: string, roots: Roots): PlannedPlace | undefined {
  const target = split(path);
  if (target === undefined) return undefined;
  let best: { root: string; depth: number } | undefined;
  for (const id of Object.keys(roots).sort()) {
    const folder = split(roots[id] ?? "");
    if (folder === undefined || folder.windows !== target.windows) continue;
    const depth = folder.segments.length;
    if (depth > target.segments.length) continue;
    if (!folder.segments.every((s, i) => same(s, target.segments[i] ?? "", target.windows))) {
      continue;
    }
    if (best === undefined || depth > best.depth) best = { root: id, depth };
  }
  if (best === undefined) return undefined;
  const rel = target.segments.slice(best.depth).join("/");
  if (
    Array.from(rel).length > PATH_MAX ||
    PATH_FORBIDDEN.test(rel) ||
    DRIVE.test(rel) ||
    normaliseText(rel) !== rel
  ) {
    return undefined;
  }
  return { root: best.root, path: rel };
}
