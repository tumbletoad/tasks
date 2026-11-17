// What a run of the release workflow builds: the commit and its version, and for a rehearsal the
// build it upgrades from. The workflow's later jobs take everything from here, so the tag and
// version rules are applied once, before anything is built.
import { spawnSync } from "node:child_process";
import { RELEASE_PLATFORMS } from "./gather.ts";
import { keyLinesIn, Refusal } from "./release.ts";
import { rehearsalVersion, releaseTag, releaseVersionProblem } from "./version.ts";

/** The runner each released platform builds on: its own, so the runtime gate runs there. */
const RUNNERS: Readonly<Record<string, string>> = {
  "linux-x64": "ubuntu-24.04",
  "linux-arm64": "ubuntu-24.04-arm",
  "win-x64": "windows-2025",
};

export type Mode = "rehearsal" | "release";

export interface Build {
  /** `current` is the release (or the rehearsal's own build), `previous` what it upgrades from. */
  readonly which: "current" | "previous";
  readonly commit: string;
  readonly version: string;
  readonly platform: string;
  readonly os: string;
}

export interface Plan {
  readonly mode: Mode;
  readonly commit: string;
  readonly version: string;
  readonly tag: string;
  readonly previous?: { readonly commit: string; readonly version: string };
  readonly builds: readonly Build[];
}

function git(root: string, args: readonly string[]): { ok: boolean; out: string } {
  const ran = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return { ok: ran.status === 0, out: ran.stdout.trim() };
}

function mustGit(root: string, args: readonly string[], what: string): string {
  const ran = git(root, args);
  if (!ran.ok) throw new Refusal(what);
  return ran.out;
}

/** Whether `commit` is `main` or an ancestor of it, in the clone at `root`. */
export const isOnMain = (root: string, commit: string, main = "origin/main"): boolean =>
  !commit.startsWith("-") && git(root, ["merge-base", "--is-ancestor", commit, main]).ok;

/** The release keys committed at `commit`: the key lines of its release-keys.ts. */
export function keysAt(root: string, commit: string): string[] {
  if (commit.startsWith("-")) throw new Refusal(`${commit} is not a commit.`);
  const text = mustGit(
    root,
    ["show", `${commit}:packages/service/src/version/release-keys.ts`],
    `The release keys at ${commit} cannot be read.`,
  );
  return keyLinesIn(text);
}

export function packageVersion(root: string, commit: string): string {
  const text = mustGit(root, ["show", `${commit}:package.json`], `${commit} has no package.json`);
  const version = (JSON.parse(text) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Refusal(`package.json at ${commit} has no version`);
  return version;
}

/**
 * The build a rehearsal upgrades from: `base` when given (a pull request's base), else the newest
 * release tag before the commit, else the commit's first parent.
 */
function previousCommit(
  root: string,
  commit: string,
  base: string | undefined,
): string | undefined {
  if (base !== undefined && base !== "") {
    return mustGit(
      root,
      ["rev-parse", "--verify", `${base}^{commit}`],
      `${base} is not a commit here`,
    );
  }
  const tag = git(root, ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${commit}^`]);
  const from = tag.ok && tag.out !== "" ? `${tag.out}^{commit}` : `${commit}^`;
  const resolved = git(root, ["rev-parse", "--verify", from]);
  return resolved.ok ? resolved.out : undefined;
}

/**
 * A release is planned from its tag (`ref` is the tag's name): the commit it names must be on main,
 * and its package.json's version must be a release version whose tag this is. Whether GitHub has
 * released the version already is the draft step's to tell (draftAction). A rehearsal is planned
 * from a commit.
 */
export function planRun(options: {
  readonly root: string;
  readonly mode: Mode;
  readonly ref: string;
  readonly base?: string;
  readonly run: number;
  /** The branch a release must come from. */
  readonly main?: string;
}): Plan {
  const { root, mode } = options;
  for (const ref of [options.ref, options.base ?? ""]) {
    if (ref.startsWith("-")) throw new Refusal(`${ref} is not a commit or tag`);
  }
  const builds = (which: Build["which"], at: string, version: string): Build[] =>
    RELEASE_PLATFORMS.map((platform) => ({
      which,
      commit: at,
      version,
      platform,
      os: RUNNERS[platform] ?? "",
    }));
  if (mode === "release") {
    const tag = options.ref;
    const commit = mustGit(
      root,
      ["rev-parse", "--verify", "-q", `refs/tags/${tag}^{commit}`],
      `There is no tag ${tag} here, so there is nothing to release.`,
    );
    const main = options.main ?? "origin/main";
    if (!isOnMain(root, commit, main)) {
      throw new Refusal(
        `${tag} names ${commit}, which is not on main, so nothing was built or signed.`,
      );
    }
    const version = packageVersion(root, commit);
    if (tag !== releaseTag(version)) {
      throw new Refusal(
        `${tag} is not the version of its commit (package.json says ${version}), so nothing was built or signed.`,
      );
    }
    const problem = releaseVersionProblem(version);
    if (problem !== undefined) throw new Refusal(`${problem} Nothing was built or signed.`);
    return { mode, commit, version, tag, builds: builds("current", commit, version) };
  }
  const commit = mustGit(
    root,
    ["rev-parse", "--verify", `${options.ref}^{commit}`],
    `${options.ref} is not a commit or tag here`,
  );
  const version = rehearsalVersion(packageVersion(root, commit), options.run, 1);
  const from = previousCommit(root, commit, options.base);
  const previous =
    from === undefined
      ? undefined
      : { commit: from, version: rehearsalVersion(packageVersion(root, from), options.run, 0) };
  return {
    mode,
    commit,
    version,
    tag: releaseTag(version),
    ...(previous === undefined ? {} : { previous }),
    builds: [
      ...builds("current", commit, version),
      ...(previous === undefined ? [] : builds("previous", previous.commit, previous.version)),
    ],
  };
}

/** The plan as the workflow's step outputs, one `name=value` line each. */
export function planOutputs(plan: Plan): string {
  return [
    `commit=${plan.commit}`,
    `version=${plan.version}`,
    `tag=${plan.tag}`,
    `previous_commit=${plan.previous?.commit ?? ""}`,
    `previous_version=${plan.previous?.version ?? ""}`,
    `builds=${JSON.stringify({ include: plan.builds })}`,
  ]
    .map((line) => `${line}\n`)
    .join("");
}
