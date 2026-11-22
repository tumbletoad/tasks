// Whether `pnpm verify` runs the M0 lab self-tests (the "lab" Vitest project, spikes/).
//
// The product tests always run. The lab tests run when
//   1. `--lab` is given or TTASKS_VERIFY_LAB=1 is set,
//   2. the base cannot be determined (fail safe), or
//   3. lab code or a file it imports changed since the base, or, in CI, also a shared file the
//      lab tests depend on (the configuration, the verify scripts, the dependencies, the pin).
// Otherwise verify skips them and says so in one line.
//
// The base:
//   - TTASKS_VERIFY_BASE, when set: any git revision. Meant for tests and for checking the rule.
//   - GitHub Actions, pull_request: the merge commit's first parent, which is the tip of the base
//     branch the pull request was merged onto for this run (or the event's base SHA when HEAD is
//     not a merge commit and that commit is present).
//   - GitHub Actions, push: the commit the ref pointed at before, from the event.
//   - Locally: the merge base of HEAD and origin/main, so a branch behind main is judged on its
//     own changes only.
// Uncommitted and untracked files count as changes.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./run.ts";

/** Folders the lab tests load: lab code, and the stand-ins the shared setup puts on PATH. */
const LAB_FOLDERS = ["spikes/", "packages/testkit/stand-ins/"];

/** Files outside spikes/ that lab code imports. */
const LAB_IMPORTS = ["tests/stream-content.ts", "tests/stream-schema.ts"];

/**
 * Files outside spikes/ that the lab tests depend on, which CI runs them for: the test
 * configuration and the setup file it runs in every worker, the verify scripts, the TypeScript
 * settings, the dependencies and Node pin, the files the packaging spike copies into a version
 * folder, and the workflows that run the lab. The lockfile is on the list because an update that
 * moves only it can change what the lab bundles, and the UI spike tests its bundle's size.
 */
const LAB_SHARED_FILES = [
  "vitest.config.ts",
  "packages/testkit/src/setup.ts",
  "scripts/verify.ts",
  "scripts/lab-tests.ts",
  "scripts/run.ts",
  "scripts/manifest.ts",
  "scripts/generated.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".node-version",
  "LICENSE",
  "NOTICE",
  ".github/workflows/check.yml",
  ".github/workflows/m0-packaging.yml",
];
const LAB_SHARED_PATTERNS = [/^tsconfig[^/]*\.json$/];

/**
 * Whether a changed path (relative to the repository root, any slash) can affect the lab tests:
 * lab code and what it imports, or with `shared` also a file the lab shares with the product.
 */
export function isLabPath(path: string, shared = true): boolean {
  const p = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return (
    LAB_FOLDERS.some((folder) => p.startsWith(folder)) ||
    LAB_IMPORTS.includes(p) ||
    (shared &&
      (LAB_SHARED_FILES.includes(p) || LAB_SHARED_PATTERNS.some((pattern) => pattern.test(p))))
  );
}

/**
 * The folders whose change gets the projection model its random runs: the projection package, and
 * the workspace packages its package.json names, the code it writes through and its tests' kit.
 */
export function projectionFolders(root: string = repoRoot): string[] {
  const manifest = (dir: string) =>
    JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
  const own = manifest("packages/projection");
  const names = Object.entries({ ...own.dependencies, ...own.devDependencies })
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([name]) => name);
  const folders = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")),
    )
    .filter((entry) => names.includes(manifest(`packages/${entry.name}`).name ?? ""))
    .map((entry) => `packages/${entry.name}/`);
  return ["packages/projection/", ...folders.sort()];
}

/** Whether a changed path lies in one of `folders` (projectionFolders). */
export function isProjectionPath(path: string, folders: readonly string[]): boolean {
  const p = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return folders.some((folder) => p.startsWith(folder));
}

/** The base verify compares with, or why there is none. */
export type Base =
  { found: true; label: string; changed: readonly string[] } | { found: false; why: string };

export interface LabDecision {
  run: boolean;
  /** One line that names the rule that applied. */
  reason: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * A slice of verify, so CI can spread it over several machines: the static checks, the product
 * tests or the lab tests. Together the parts are every step.
 */
export const VERIFY_PARTS = ["checks", "product", "lab"] as const;
export type VerifyPart = (typeof VERIFY_PARTS)[number];

export interface VerifyOptions {
  lab: boolean;
  /** Null runs every part. */
  part: VerifyPart | null;
  /** Vitest's `index/count`, for the product or lab part. */
  shard: string | null;
}

/** The verify options. Throws on an argument it does not know, so a typo never skips anything. */
export function parseVerifyArgs(args: readonly string[]): VerifyOptions {
  const options: VerifyOptions = { lab: false, part: null, shard: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--lab") {
      options.lab = true;
    } else if (arg === "--part") {
      const value = args[++i] ?? "";
      const part = VERIFY_PARTS.find((p) => p === value);
      if (part === undefined) {
        throw new Error(
          `--part takes one of ${VERIFY_PARTS.join(", ")}, not ${JSON.stringify(value)}`,
        );
      }
      if (options.part !== null && options.part !== part) {
        throw new Error(`--part is given twice: ${options.part} and ${part}`);
      }
      options.part = part;
    } else if (arg === "--shard") {
      const value = args[++i] ?? "";
      const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
      if (m === null || Number(m[1]) > Number(m[2])) {
        throw new Error(`--shard takes index/count, such as 1/4, not ${JSON.stringify(value)}`);
      }
      if (options.shard !== null && options.shard !== value) {
        throw new Error(`--shard is given twice: ${options.shard} and ${value}`);
      }
      options.shard = value;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}. Use --lab, --part or --shard.`);
    }
  }
  if (options.shard !== null && options.part !== "product" && options.part !== "lab") {
    throw new Error("--shard needs --part product or --part lab");
  }
  return options;
}

const MAX_LISTED = 5;

/** The selection rule itself: no I/O, every input passed in. */
export function decideLab(options: { lab: boolean }, env: Env, base: () => Base): LabDecision {
  if (options.lab) return { run: true, reason: "lab tests run: --lab was given" };
  if (env["TTASKS_VERIFY_LAB"] === "1") {
    return { run: true, reason: "lab tests run: TTASKS_VERIFY_LAB=1 is set" };
  }
  const b = base();
  if (!b.found) {
    return { run: true, reason: `lab tests run: the base could not be determined (${b.why})` };
  }
  // Locally a shared file alone leaves them to CI, which runs them for it.
  const ci = inCi(env);
  const changed = [...new Set(b.changed.map((p) => p.replaceAll("\\", "/")))];
  const lab = changed.filter((p) => isLabPath(p, ci)).sort();
  if (lab.length === 0) {
    const shared = ci ? 0 : changed.filter((p) => isLabPath(p)).length;
    return {
      run: false,
      reason:
        shared === 0
          ? `lab tests skipped: no lab files changed since ${b.label}`
          : `lab tests skipped: no lab code changed since ${b.label}; CI runs them for the ${String(shared)} shared file(s) that did`,
    };
  }
  const listed = lab.slice(0, MAX_LISTED).join(", ");
  const more = lab.length > MAX_LISTED ? ` and ${String(lab.length - MAX_LISTED)} more` : "";
  return {
    run: true,
    reason: `lab tests run: ${String(lab.length)} lab file(s) changed since ${b.label}: ${listed}${more}`,
  };
}

/** Runs git and returns its stdout, or null when it fails. */
export type Git = (args: readonly string[]) => string | null;

export const git: Git = (args) => {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.status === 0 ? result.stdout : null;
};

const short = (sha: string) => sha.slice(0, 12);

/** The commit a revision names, or null when it does not name one present here. */
function commit(run: Git, rev: string): string | null {
  const out = run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return out === null ? null : out.trim();
}

/** The parents of a commit, first parent first. */
function parents(run: Git, rev: string): string[] {
  const out = run(["rev-list", "--parents", "-n", "1", rev]);
  return out === null ? [] : out.trim().split(/\s+/).slice(1);
}

interface GitHubEvent {
  /** On a push: the commit the ref pointed at before, all zeros for a new ref. */
  before?: unknown;
  pull_request?: { base?: { sha?: unknown } };
}

/** A SHA from the GitHub event file, if the file holds one there. */
function eventSha(
  env: Env,
  read: (path: string) => string,
  pick: (event: GitHubEvent) => unknown,
): string | null {
  const path = env["GITHUB_EVENT_PATH"];
  if (path === undefined || path === "") return null;
  try {
    const sha = pick(JSON.parse(read(path)) as GitHubEvent);
    return typeof sha === "string" && /^[0-9a-f]{40,64}$/.test(sha) && !/^0+$/.test(sha)
      ? sha
      : null;
  } catch {
    return null;
  }
}

/** True in any CI environment, not only GitHub's. */
const inCi = (env: Env) => env["GITHUB_ACTIONS"] === "true" || (env["CI"] ?? "") !== "";

/** The base commit and how to name it, or why there is none. */
export function findBaseCommit(
  env: Env,
  run: Git,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): { sha: string; label: string } | { why: string } {
  const override = env["TTASKS_VERIFY_BASE"];
  if (override !== undefined && override !== "") {
    // The override is for tests and for checking the rule by hand. In CI it could make a run
    // skip the lab tests silently, so it is refused there and the lab tests run.
    if (inCi(env)) return { why: "TTASKS_VERIFY_BASE is set, and CI does not honour it" };
    const sha = commit(run, override);
    return sha === null
      ? { why: `TTASKS_VERIFY_BASE=${override} names no commit here` }
      : { sha, label: `${override} (${short(sha)}, from TTASKS_VERIFY_BASE)` };
  }
  if (env["GITHUB_ACTIONS"] === "true") {
    const event = env["GITHUB_EVENT_NAME"] ?? "";
    const head = parents(run, "HEAD");
    if (event === "pull_request") {
      // actions/checkout checks out the merge commit refs/pull/N/merge. Its first parent is the
      // base branch tip it was merged onto, so the diff is exactly what this pull request adds.
      if (head.length === 2 && head[0] !== undefined) {
        return { sha: head[0], label: `the pull request's base ${short(head[0])}` };
      }
      const sha = eventSha(env, read, (e) => e.pull_request?.base?.sha);
      const present = sha === null ? null : commit(run, sha);
      if (present !== null) {
        return { sha: present, label: `the pull request's base ${short(present)}` };
      }
      return { why: "HEAD is not a merge commit and the event's base commit is not fetched" };
    }
    if (event === "push") {
      // A push can carry several commits (a rebase merge, a direct push). The base is the commit
      // the ref pointed at before, from the event, never just HEAD's parent: with A, B (a lab
      // change) and C (a product change) pushed together, the parent of C would hide B.
      const before = eventSha(env, read, (e) => e.before);
      if (before === null) return { why: "the push event names no previous commit" };
      const present = commit(run, before);
      return present === null
        ? { why: `the push's previous commit ${short(before)} is not in this checkout` }
        : { sha: present, label: `the push's previous commit ${short(present)}` };
    }
    return { why: `GitHub event "${event}" has no rule` };
  }
  if (commit(run, "origin/main") === null) return { why: "there is no origin/main" };
  const mergeBase = run(["merge-base", "origin/main", "HEAD"]);
  if (mergeBase === null) return { why: "HEAD and origin/main have no merge base here" };
  return { sha: mergeBase.trim(), label: `origin/main (merge base ${short(mergeBase.trim())})` };
}

/** Every path changed since a commit: committed, staged, unstaged and untracked. */
export function changedSince(run: Git, sha: string): string[] | null {
  const tracked = run(["diff", "--name-only", "--no-renames", "-z", sha, "--"]);
  const untracked = run(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (tracked === null || untracked === null) return null;
  return [...tracked.split("\0"), ...untracked.split("\0")].filter((p) => p !== "");
}

/** The base for the selection rule, from git. */
export function findBase(env: Env, run: Git = git): Base {
  const base = findBaseCommit(env, run);
  if ("why" in base) return { found: false, why: base.why };
  const changed = changedSince(run, base.sha);
  if (changed === null) return { found: false, why: `git diff against ${base.label} failed` };
  return { found: true, label: base.label, changed };
}
