// `status`'s `here` (A3 3.4.2): the active tasks whose place, on this machine, resolves to the
// caller's working folder (`exact`), contains it (`inside`) or lies inside it (`below`), in that
// order, "place resolution by A1, exact per R11".
//
// One rule decides where a place is: `resolvePlace` (launch, A1 3.15), the same that gives
// the digest its folder. A place's stored path is text that a link inside its root can lead
// elsewhere, so it is never compared with the working folder as text: the folder it resolves to
// now is, as a real path, segment by segment, with the working folder's real path. A place that
// resolves to no folder here (its folder is missing, its root is gone, another repository is
// there) matches nothing, as the digest says it is unresolved.
//
// Only the places under a root that can hold a match are resolved: a root the working folder lies
// in, or one that lies inside the working folder. Every root is considered, not only the closest,
// so a task placed through an outer root is found from inside a nested one. `here` orients an
// agent: it names tasks and opens nothing; a launch resolves its place again, on its own.
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { absoluteFolder, resolvePlace, type Root } from "@tasks/launch";
import type { Row } from "@tasks/storage";

export type Match = "exact" | "inside" | "below";

/** A place's state on this machine now: its folder, or why it has none (R11, never a guess). */
export type PlaceState = { readonly folder: string } | { readonly unresolved: string };

const foldsCase = (platform: NodeJS.Platform): boolean =>
  platform === "win32" || platform === "darwin";

/** A real path's segments after its root (`C:\`, `\\server\share\`, `/`). */
function segmentsOf(real: string, platform: NodeJS.Platform): { root: string; parts: string[] } {
  const P = platform === "win32" ? win32 : posix;
  const root = P.parse(real).root;
  return {
    root,
    parts: real
      .slice(root.length)
      .split(P.sep)
      .filter((s) => s !== ""),
  };
}

async function realFolder(given: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const ready = absoluteFolder(given, platform);
  if (!ready.ok) return undefined;
  try {
    return await realpath(ready.path);
  } catch {
    return undefined;
  }
}

/**
 * How `folder` stands to `cwd`, both real paths: the same folder, a folder that contains it, or
 * one inside it. Real paths spell each folder as the file system does, so segments compare
 * exactly (another case is another folder, as in a case-sensitive folder); only the volume's
 * spelling (a drive letter, a server's name) is case-folded where the platform ignores case.
 */
function relate(folder: string, cwd: string, platform: NodeJS.Platform): Match | undefined {
  const a = segmentsOf(folder, platform);
  const b = segmentsOf(cwd, platform);
  const volume = (s: string) => (foldsCase(platform) ? s.toLowerCase() : s);
  if (volume(a.root) !== volume(b.root)) return undefined;
  const common = Math.min(a.parts.length, b.parts.length);
  for (let i = 0; i < common; i += 1) if (a.parts[i] !== b.parts[i]) return undefined;
  if (a.parts.length === b.parts.length) return "exact";
  return a.parts.length < b.parts.length ? "inside" : "below";
}

/** The caller's working folder as a real path, and the roots whose places can match it. */
export interface Here {
  readonly folder: string;
  readonly roots: readonly string[];
}

/**
 * The working folder `cwd` and the roots of this machine that can hold a place matching it: the
 * roots it lies in and those that lie inside it. Undefined when `cwd` is not a folder here.
 */
export async function hereOf(
  cwd: string,
  roots: readonly Root[],
  platform: NodeJS.Platform,
): Promise<Here | undefined> {
  const folder = await realFolder(cwd, platform);
  if (folder === undefined) return undefined;
  const fold = (s: string) => (foldsCase(platform) ? s.toLowerCase() : s);
  const at = segmentsOf(folder, platform);
  const related: string[] = [];
  for (const root of roots) {
    const real = await realFolder(root.path, platform);
    if (real === undefined) continue;
    // A pre-filter only, so it may say yes too often: case-folded where the platform folds.
    const base = segmentsOf(real, platform);
    if (fold(base.root) !== fold(at.root)) continue;
    const common = Math.min(base.parts.length, at.parts.length);
    let same = true;
    for (let i = 0; i < common && same; i += 1) {
      same = fold(base.parts[i] ?? "") === fold(at.parts[i] ?? "");
    }
    if (same) related.push(root.id);
  }
  return { folder, roots: related };
}

/** The Git remote a place recorded (its `identity`), for `resolvePlace`'s check. */
function remoteOf(identity: unknown): string | undefined {
  try {
    const parsed: unknown = typeof identity === "string" ? JSON.parse(identity) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const remote = (parsed as Record<string, unknown>)["git_remote"];
    return typeof remote === "string" ? remote : undefined;
  } catch {
    // An identity the reader cannot parse records no remote: the place resolves without one.
    return undefined;
  }
}

/**
 * A place (its row's `root_id`, `rel_path`, `kind` and `identity`) as it resolves on this machine
 * now: the digest's place and every `here` match read it the same way.
 */
export async function placeState(
  place: {
    readonly root: unknown;
    readonly path: unknown;
    readonly kind: unknown;
    readonly identity: unknown;
  },
  roots: readonly Root[],
  platform: NodeJS.Platform,
): Promise<PlaceState> {
  const gitRemote = remoteOf(place.identity);
  const found = await resolvePlace(
    {
      root: String(place.root),
      path: String(place.path),
      ...(place.kind === "file" ? { kind: "file" as const } : {}),
      ...(gitRemote === undefined ? {} : { gitRemote }),
    },
    roots,
    { platform },
  );
  return found.status === "ok" ? { folder: found.folder } : { unresolved: found.reason };
}

/** At most this many tasks in `here`, as in each of status's sections (A3 3.4.2). */
export const HERE_ROWS = 8;

/** At most this many places are resolved at once. */
const AT_ONCE = 16;

const RANK: Readonly<Record<Match, number>> = { exact: 0, inside: 1, below: 2 };

/**
 * The tasks of `placed` (task rows with `place_root`, `place_path`, `place_kind` and
 * `place_identity`) whose place resolves to a folder that matches `here`, best first: exact,
 * inside, below, then by priority, due date and reference.
 */
export async function hereRows(
  placed: readonly Row[],
  here: Here,
  roots: readonly Root[],
  platform: NodeJS.Platform,
): Promise<{ row: Row; match: Match }[]> {
  const matches = new Array<{ row: Row; match: Match } | undefined>(placed.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < placed.length) {
      const i = next;
      next += 1;
      const row = placed[i];
      if (row === undefined) continue;
      const state = await placeState(
        {
          root: row["place_root"],
          path: row["place_path"],
          kind: row["place_kind"],
          identity: row["place_identity"],
        },
        roots,
        platform,
      );
      const match = "folder" in state ? relate(state.folder, here.folder, platform) : undefined;
      if (match !== undefined) matches[i] = { row, match };
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, placed.length) }, worker));
  const best = new Map<unknown, { row: Row; match: Match }>();
  for (const found of matches) {
    if (found === undefined) continue;
    const known = best.get(found.row["id"]);
    if (known === undefined || RANK[found.match] < RANK[known.match]) {
      best.set(found.row["id"], found);
    }
  }
  const due = (row: Row): string =>
    typeof row["due_date"] === "string"
      ? row["due_date"]
      : typeof row["due_at"] === "number"
        ? new Date(row["due_at"]).toISOString().slice(0, 10)
        : "9999-12-31";
  return [...best.values()].sort(
    (a, b) =>
      RANK[a.match] - RANK[b.match] ||
      Number(a.row["priority"]) - Number(b.row["priority"]) ||
      (due(a.row) < due(b.row) ? -1 : due(a.row) > due(b.row) ? 1 : 0) ||
      Number(a.row["ref"]) - Number(b.row["ref"]),
  );
}
