// Exact-folder binding for T3: a resolved folder P maps
// to a T3 project whose root is exactly P, or to an existing git worktree of a registered project,
// or to nothing, never to a containing project. T3's own path resolution (the deepest containing
// project) is never used.
//
// Everything is compared by directory identity (volume and file number), as places
// are: a project root names P when a stat of it gives P's identity, whatever its spelling, case,
// links or short names. A root T3 lists that has no identity here (missing, unreachable, a volume
// without file numbers) names nothing. Identity is stricter than comparing real paths.
//
// Git is read from its files, never by starting git: `.git` as a folder
// (the main worktree) or a file `gitdir: <path>` whose git folder has a `commondir` (a linked
// worktree). A linked worktree is in its repository's `git worktree list` when its git folder lies
// in `<common>/worktrees/` and that folder's `gitdir` file names this worktree's `.git` back; the
// main worktree is always listed. A `.git` file without a `commondir` (a main checkout made with
// `--separate-git-dir`, or a submodule's) is its repository's main checkout but not listed: git
// lists the git folder itself as the main worktree. Such a checkout can be a project root that its
// repository's linked worktrees bind to, but is never bound as an existing worktree itself. A bare
// repository as a project root is not recognised: its worktrees ask instead.
import type { BigIntStats } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { identityOf, type FolderIdentity } from "./places.ts";
import type { T3Strategy } from "./t3-state.ts";

/** A project as T3 lists it, active only. */
export interface T3Project {
  readonly id: string;
  /** Its `workspaceRoot` as T3 stores it (T3 does not normalise it). */
  readonly root: string;
}

/** What binding found: a project and strategy for P, or nothing. */
export type T3Binding =
  | { readonly kind: "bound"; readonly projectId: string; readonly strategy: T3Strategy }
  | { readonly kind: "none" };

/** The folder to bind: its real path (as `resolvePlace` returned it) and its identity. */
export interface BindFolder {
  readonly path: string;
  readonly identity: FolderIdentity;
}

const MAX_GIT_FILE = 4096;

const same = (a: FolderIdentity | undefined, b: FolderIdentity | undefined): boolean =>
  a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;

/** A path's identity (links followed), or undefined when it has none or cannot be read. */
export async function identityAt(path: string): Promise<FolderIdentity | undefined> {
  try {
    const found: BigIntStats = await stat(path, { bigint: true });
    return identityOf(found);
  } catch {
    return undefined;
  }
}

/** A small git file's first line, or undefined. */
async function gitLine(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_GIT_FILE) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
    const line = text.replace(/[\r\n]+$/u, "");
    return line === "" || /[\r\n]/u.test(line) || line.includes("\u0000") ? undefined : line;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** A git folder's worktree facts: its repository's common git folder, and whether it is listed. */
interface Worktree {
  /** The identity of the repository's common git folder. */
  readonly common: FolderIdentity;
  /** The main worktree (`.git` is a folder). */
  readonly main: boolean;
  /** In its repository's `git worktree list`. */
  readonly listed: boolean;
}

/** The worktree whose top level is `dir`, or undefined when `dir` is no worktree's top level. */
export async function worktreeAt(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Worktree | undefined> {
  const P = platform === "win32" ? win32 : posix;
  const dotGit = P.join(dir, ".git");
  let info;
  try {
    info = await lstat(dotGit);
  } catch {
    return undefined;
  }
  if (info.isDirectory()) {
    // A main worktree: its git folder is the common one. One with a `commondir` is not plain.
    if ((await gitLine(P.join(dotGit, "commondir"))) !== undefined) return undefined;
    const common = await identityAt(dotGit);
    return common === undefined ? undefined : { common, main: true, listed: true };
  }
  if (!info.isFile()) return undefined;
  const line = await gitLine(dotGit);
  if (line?.startsWith("gitdir: ") !== true) return undefined;
  const named = line.slice("gitdir: ".length);
  const gitDir = P.isAbsolute(named) ? named : P.join(dir, named);
  const commonText = await gitLine(P.join(gitDir, "commondir"));
  if (commonText === undefined) {
    // No commondir: the git folder is the repository's own, as for a main checkout made with
    // `--separate-git-dir` or a submodule's. Git then lists that git folder, not this checkout, as
    // the main worktree, so the checkout is not listed; it still names its repository, whose
    // linked worktrees bind to a project here (T3's `git worktree list` of this root has them).
    const own = await identityAt(gitDir);
    return own === undefined ? undefined : { common: own, main: true, listed: false };
  }
  const commonPath = P.isAbsolute(commonText) ? commonText : P.join(gitDir, commonText);
  const common = await identityAt(commonPath);
  if (common === undefined) return undefined;
  // Listed: the git folder is `<common>/worktrees/<name>` and its `gitdir` names this `.git`.
  const worktrees = P.dirname(gitDir);
  const back = await gitLine(P.join(gitDir, "gitdir"));
  const backPath =
    back === undefined ? undefined : P.isAbsolute(back) ? back : P.join(gitDir, back);
  const listed =
    P.basename(worktrees) === "worktrees" &&
    same(await identityAt(P.dirname(worktrees)), common) &&
    backPath !== undefined &&
    same(await identityAt(backPath), await identityAt(dotGit));
  return { common, main: false, listed };
}

/**
 * Binds `folder` to a T3 project, or finds none. First a
 * project whose root is the folder, then the folder is the top level of a git worktree listed in
 * its repository's worktree list, and a project's root is a worktree of the same repository; the
 * one whose root is the main worktree is preferred. A project whose root merely contains the folder
 * is never a binding.
 */
export async function bindFolder(
  projects: readonly T3Project[],
  folder: BindFolder,
  platform: NodeJS.Platform = process.platform,
): Promise<T3Binding> {
  const P = platform === "win32" ? win32 : posix;
  const roots = await Promise.all(
    projects.map(async (project) => ({
      project,
      identity: P.isAbsolute(project.root) ? await identityAt(project.root) : undefined,
    })),
  );
  const exact = roots.find((r) => same(r.identity, folder.identity));
  if (exact !== undefined) {
    return { kind: "bound", projectId: exact.project.id, strategy: { type: "root" } };
  }
  const mine = await worktreeAt(folder.path, platform);
  if (mine?.listed !== true) return { kind: "none" };
  let found: { id: string; main: boolean } | undefined;
  for (const r of roots) {
    if (r.identity === undefined) continue;
    const theirs = await worktreeAt(r.project.root, platform);
    if (theirs === undefined || !same(theirs.common, mine.common)) continue;
    if (found === undefined || (theirs.main && !found.main)) {
      found = { id: r.project.id, main: theirs.main };
    }
  }
  return found === undefined
    ? { kind: "none" }
    : {
        kind: "bound",
        projectId: found.id,
        strategy: { type: "existing_worktree", worktreePath: folder.path },
      };
}
