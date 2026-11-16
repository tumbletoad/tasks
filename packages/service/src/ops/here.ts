// `here`: the tasks that work in the caller's working folder on this machine, for `status`, the
// candidates of a call that names no task, search's `on:cwd` and the boost of a text search.
//
// A task works where it opens: its own folder here, else its project's folder here. Folders are
// compared as real paths, segment by segment, with the working folder's real path, never as stored
// text: a link or a short name spells one folder two ways. A folder relates to the working folder
// as the same folder (`exact`), one that contains it (`inside`) or one inside it (`below`).
//
// Nested project folders: the working folder belongs to the deepest project folder that contains
// it, so only that project's tasks are `exact` or `inside` through their project. Projects whose
// folders lie inside the working folder are `below`. A task's own folder relates on its own.
//
// `here` orients: it names tasks and opens nothing, and a launch decides its folder again. A folder
// that is not there or does not answer in time matches nothing.
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { absoluteFolder } from "@tasks/launch";
import type { Row } from "@tasks/storage";
import { bounded, openPath } from "./folders.ts";

export type Match = "exact" | "inside" | "below";

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

/** The real path of an absolute folder of this machine, or undefined when it is none now. */
async function realFolder(given: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const ready = absoluteFolder(given, platform);
  if (!ready.ok) return undefined;
  const found = await bounded(async () => {
    try {
      return await realpath(ready.path);
    } catch {
      return undefined;
    }
  });
  return found === "not_answering" ? undefined : found;
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

/** The live folders on this machine `here` reads, in stored form. */
export interface FoldersHere {
  /** Live projects' folders: `project` and `path`. */
  readonly projects: readonly Row[];
  /** Live tasks' own folders: `task` and `path`. */
  readonly tasks: readonly Row[];
}

/** The tasks and projects whose folder relates to a working folder, with how. */
export interface Here {
  /** Tasks by their own folder here. */
  readonly tasks: ReadonlyMap<string, Match>;
  /** Projects by their folder here: the deepest that contains the working folder, and those below. */
  readonly projects: ReadonlyMap<string, Match>;
}

export interface HereFacts {
  readonly home: string | undefined;
  readonly platform: NodeJS.Platform;
}

/** At most this many folders are looked at at once. */
const AT_ONCE = 16;

/**
 * What relates to `cwd` among `folders`: undefined when `cwd` is not a folder here. Each distinct
 * folder is looked at once, a stored `~` expanded with the home.
 */
export async function hereOf(
  cwd: string,
  folders: FoldersHere,
  facts: HereFacts,
): Promise<Here | undefined> {
  const { platform, home } = facts;
  const at = await realFolder(cwd, platform);
  if (at === undefined) return undefined;
  const paths = [...new Set([...folders.projects, ...folders.tasks].map((r) => String(r["path"])))];
  const reals = new Map<string, string | undefined>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const stored = paths[next] ?? "";
      next += 1;
      const open = openPath(stored, home, platform);
      reals.set(stored, open === undefined ? undefined : await realFolder(open, platform));
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, paths.length) }, worker));
  const matchOf = (row: Row): { match: Match; depth: number } | undefined => {
    const real = reals.get(String(row["path"]));
    if (real === undefined) return undefined;
    const match = relate(real, at, platform);
    return match === undefined
      ? undefined
      : { match, depth: segmentsOf(real, platform).parts.length };
  };
  const tasks = new Map<string, Match>();
  for (const row of folders.tasks) {
    const found = matchOf(row);
    if (found !== undefined) tasks.set(String(row["task"]), found.match);
  }
  const projects = new Map<string, Match>();
  const around: { project: string; match: Match; depth: number }[] = [];
  for (const row of folders.projects) {
    const found = matchOf(row);
    if (found === undefined) continue;
    if (found.match === "below") projects.set(String(row["project"]), "below");
    else around.push({ project: String(row["project"]), ...found });
  }
  const deepest = Math.max(...around.map((p) => p.depth));
  for (const p of around) if (p.depth === deepest) projects.set(p.project, p.match);
  return { tasks, projects };
}

/** How a task of `here` matches: by its own folder here, else by its project's. */
export function matchOf(row: Row, here: Here): Match | undefined {
  const id = String(row["id"]);
  const own = here.tasks.get(id);
  if (own !== undefined) return own;
  if (row["x_own_here"] !== null && row["x_own_here"] !== undefined) return undefined;
  const project = row["project_id"];
  return typeof project === "string" ? here.projects.get(project) : undefined;
}

/** At most this many tasks in `here`, as in each of status's sections (A3 3.4.2). */
export const HERE_ROWS = 8;

const RANK: Readonly<Record<Match, number>> = { exact: 0, inside: 1, below: 2 };

/**
 * The tasks of `rows` that match `here`, best first: exact, inside, below, then by priority, due
 * date and reference. Each row holds `x_own_here` when the task has a folder of its own here.
 */
export function hereRows(rows: readonly Row[], here: Here): { row: Row; match: Match }[] {
  const found: { row: Row; match: Match }[] = [];
  for (const row of rows) {
    const match = matchOf(row, here);
    if (match !== undefined) found.push({ row, match });
  }
  const due = (row: Row): string =>
    typeof row["due_date"] === "string"
      ? row["due_date"]
      : typeof row["due_at"] === "number"
        ? new Date(row["due_at"]).toISOString().slice(0, 10)
        : "9999-12-31";
  return found.sort(
    (a, b) =>
      RANK[a.match] - RANK[b.match] ||
      Number(a.row["priority"]) - Number(b.row["priority"]) ||
      (due(a.row) < due(b.row) ? -1 : due(a.row) > due(b.row) ? 1 : 0) ||
      Number(a.row["ref"]) - Number(b.row["ref"]),
  );
}
