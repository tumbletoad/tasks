// Managed targets (A3 3.12): a file another tool generates or keeps, which setup must not edit,
// because the next reinstall or checkout would overwrite the change, or the change would land in
// that tool's source. Rules 1 (a link) and 2 (a "generated" mark near the top) are judged where the
// file is read (agents.ts). This file holds the other two:
//
//   3. A git repository other than the home tracks the file.
//   4. machine.toml lists it, or a folder above it, under `[setup.managed] paths`.
//
// Rule 3 asks git and never reads git's files: how git finds a repository (gitfiles, `core.worktree`,
// folders it skips) and what its index holds are git's to know, and a second reader gets them wrong.
// 1. The walk: from the file's folder as the OS resolves it (links, junctions, short names) up to
//    the root of its file system, with no level limit, setup notes whether any folder holds an
//    entry named `.git`, of any kind. It reads nothing inside one, and an error while looking
//    counts as one being there. With none, the file is in no repository git can find from it.
// 2. The question: git, run in that folder as a helper of the runner (@ttasks/launch helpers.ts,
//    GIT_MS each, its output bounded), lists the file if it tracks it (`ls-files -z`, the name as a
//    literal pathspec, without case on Windows and macOS). Exit 0 with nothing listed is git's "a
//    repository, and not tracked": the file is not managed. Something listed is tracked, and then
//    git names the work tree (`rev-parse --show-toplevel`): one that is the home or inside it is the
//    person's own record of that home, not another tool's. Everything else is managed, the safe side
//    for a write: no git, a failure, the deadline, an answer of another form, a folder that is no
//    repository after all. The answer is read from the exit status and the output's bytes, never
//    from git's words.
// 3. Looking changes and starts nothing: the calling environment's GIT_ variables are left out (they
//    name a repository for the caller, not for the file), optional locks are off, git looks across
//    file systems as the walk does, never prompts, runs with no pager and in the C locale, and the
//    file-system monitor (`core.fsmonitor`; older Git for Windows `core.useBuiltinFSMonitor`), the
//    one configured program these two commands start, is switched off on the command line, which
//    wins over every configuration file. No shell: the name is passed after `--`.
//
// A repository found only through GIT_DIR or `--git-dir` (a bare dotfiles repository) leaves no
// `.git` above the file, so setup cannot see it: rule 4 lists such files.
import { lstatSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { helperOutput, nodeDetectHost, onPath, type Env } from "@ttasks/launch";

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** Paths compare without case on Windows and macOS, as their file systems do by default. */
const caseless = (platform: NodeJS.Platform): boolean =>
  platform === "win32" || platform === "darwin";

const fold = (platform: NodeJS.Platform, path: string): string =>
  caseless(platform) ? path.toLowerCase() : path;

/** Whether `inner` is `outer` or lies inside it. */
export function within(platform: NodeJS.Platform, outer: string, inner: string): boolean {
  const p = pathOf(platform);
  const rel = p.relative(fold(platform, p.resolve(outer)), fold(platform, p.resolve(inner)));
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/** Rule 4: the file, or a folder above it, is listed under `[setup.managed] paths`. */
export function listedAsManaged(
  platform: NodeJS.Platform,
  file: string,
  paths: readonly string[],
): boolean {
  return paths.some((listed) => within(platform, listed, file));
}

/** How long one git run may take. */
export const GIT_MS = 10_000;
/** At most this much of git's output is read: more is no answer. */
const GIT_OUTPUT_CHARS = 64 * 1024;

/** How setup asks git (rule 3). */
export interface GitAsk {
  /** The person's environment: git runs in it, without its GIT_ variables. */
  readonly env: Env;
  /** git's command as an argv prefix. Default: `git` on `env`'s PATH (gitOnPath). */
  readonly git?: readonly string[];
  /** How long one git run may take. Default: GIT_MS. */
  readonly deadlineMs?: number;
}

/**
 * `git` on the PATH as the OS finds it (launch's `onPath`), or undefined. A `.cmd` shim found
 * there is never run (the runner refuses it), so it is no git either.
 */
export function gitOnPath(platform: NodeJS.Platform, env: Env): readonly string[] | undefined {
  const found = onPath(nodeDetectHost({ platform, env, home: "" }), "git");
  return found === undefined ? undefined : [found];
}

/** Whether an entry named `.git` is at `path`. Only "nothing there" is no; an error is yes. */
function gitEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** Whether `folder` or a folder above it, up to the root, holds an entry named `.git`. */
function underGitEntry(platform: NodeJS.Platform, folder: string): boolean {
  const p = pathOf(platform);
  for (let dir = folder; ;) {
    if (gitEntry(p.join(dir, ".git"))) return true;
    const up = p.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/** A folder as the OS resolves it (links, junctions, case, short names), or as given. */
function resolved(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** The environment git runs in: the person's, without the GIT_ variables, with setup's own. */
export function gitEnv(platform: NodeJS.Platform, env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = platform === "win32" ? name.toUpperCase() : name;
    if (key.startsWith("GIT_") || key === "LC_ALL") continue;
    out[name] = value;
  }
  return {
    ...out,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
    LC_ALL: "C",
  };
}

/** git's options before every question: nothing configured is started, no pager. */
const GIT_OPTIONS = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.useBuiltinFSMonitor=false",
] as const;

/** The file's name as a pathspec that matches only that name: literal, caseless where paths are. */
const pathspec = (platform: NodeJS.Platform, name: string): string =>
  `:(${caseless(platform) ? "literal,icase" : "literal"})${name}`;

/**
 * Rule 3: a git repository other than the home tracks `file`, by git's own answer (the header).
 * True on the safe side whenever git gives no clear answer.
 */
export async function trackedByAnotherRepository(
  platform: NodeJS.Platform,
  file: string,
  home: string,
  ask: GitAsk,
): Promise<boolean> {
  const p = pathOf(platform);
  const absolute = p.resolve(file);
  const folder = resolved(p.dirname(absolute));
  if (!underGitEntry(platform, folder)) return false;
  const git = ask.git ?? gitOnPath(platform, ask.env);
  if (git === undefined || git.length === 0) return true;
  const run = (args: readonly string[]) =>
    helperOutput([...git, ...GIT_OPTIONS, ...args], {
      env: gitEnv(platform, ask.env),
      cwd: folder,
      deadlineMs: ask.deadlineMs ?? GIT_MS,
      maxChars: GIT_OUTPUT_CHARS,
    });
  const listed = await run(["ls-files", "-z", "--", pathspec(platform, p.basename(absolute))]);
  if (listed === undefined) return true;
  if (listed === "") return false;
  // Tracked: by the home's own repository, or by another one.
  const top = await run(["rev-parse", "--show-toplevel"]);
  const line = top?.endsWith("\n") === true ? top.slice(0, -1) : undefined;
  if (line === undefined || line === "" || line.includes("\n") || !p.isAbsolute(line)) return true;
  return !within(platform, resolved(p.resolve(home)), resolved(p.resolve(line)));
}
