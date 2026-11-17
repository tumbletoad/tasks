// The repository settings a release depends on, as far as the workflow's own token can read them.
// A workflow cannot decide who makes a tag: a tag ruleset does. And only the `release` environment's
// rule on refs keeps the release key from a branch with a changed workflow. A release run reads both
// before anything is built and refuses when they are not as they must be; a rehearsal reports the
// same findings as warnings, so they show on a pull request before the first tag.
//
// The token cannot see a ruleset's bypass list (GitHub shows it only to admins), so "only the owner
// bypasses" is not checked here.

/** The environment whose secrets sign a release, and the tags it gives them to. */
export const RELEASE_ENVIRONMENT = "release";
export const TAG_PATTERN = "v*";

export interface EnvironmentSettings {
  readonly deployment_branch_policy: {
    readonly protected_branches: boolean;
    readonly custom_branch_policies: boolean;
  } | null;
}

export interface RefPolicy {
  readonly name: string;
  /** `branch` or `tag`; GitHub leaves it out on old policies, which are branch policies. */
  readonly type?: string;
}

export interface RulesetSettings {
  readonly name: string;
  readonly target?: string;
  readonly enforcement: string;
  readonly conditions?: {
    readonly ref_name?: {
      readonly include?: readonly string[];
      readonly exclude?: readonly string[];
    };
  } | null;
  readonly rules?: readonly { readonly type: string }[];
  /** Whether the token reading it (the workflow's) may bypass it. */
  readonly current_user_can_bypass?: string;
}

export interface RepositorySettings {
  /** Undefined when the environment does not exist. */
  readonly environment: EnvironmentSettings | undefined;
  readonly policies: readonly RefPolicy[];
  readonly rulesets: readonly RulesetSettings[];
}

const TAG_RULES = ["creation", "update", "deletion"] as const;

const coversReleaseTags = (ruleset: RulesetSettings): boolean => {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  return (
    exclude.length === 0 &&
    (include.includes("~ALL") || include.includes(`refs/tags/${TAG_PATTERN}`))
  );
};

/** What is wrong with the settings for a release, one sentence each; empty when nothing is. */
export function settingsProblems(settings: RepositorySettings): string[] {
  const problems: string[] = [];
  const env = settings.environment;
  if (env === undefined) {
    problems.push(
      `The ${RELEASE_ENVIRONMENT} environment does not exist, so there is no release key to sign with.`,
    );
  } else {
    const policy = env.deployment_branch_policy;
    if (policy === null || !policy.custom_branch_policies || policy.protected_branches) {
      problems.push(
        `The ${RELEASE_ENVIRONMENT} environment does not limit its secrets to tags ${TAG_PATTERN}: set its deployment rule to selected branches and tags, with only the tag rule ${TAG_PATTERN}.`,
      );
    } else {
      const others = settings.policies.filter((p) => p.type !== "tag" || p.name !== TAG_PATTERN);
      if (others.length > 0) {
        problems.push(
          `The ${RELEASE_ENVIRONMENT} environment also gives its secrets to ${others.map((p) => `${p.type ?? "branch"} ${p.name}`).join(", ")}: keep only the tag rule ${TAG_PATTERN}.`,
        );
      }
      if (!settings.policies.some((p) => p.type === "tag" && p.name === TAG_PATTERN)) {
        problems.push(
          `The ${RELEASE_ENVIRONMENT} environment gives its secrets to no tag: add the tag rule ${TAG_PATTERN}.`,
        );
      }
    }
  }
  const active = settings.rulesets.filter(
    (r) => r.enforcement === "active" && (r.target ?? "tag") === "tag" && coversReleaseTags(r),
  );
  const missing = TAG_RULES.filter(
    (rule) => !active.some((r) => (r.rules ?? []).some((x) => x.type === rule)),
  );
  if (missing.length > 0) {
    problems.push(
      `No active tag ruleset for ${TAG_PATTERN} restricts ${missing.join(", ")}: without it, more than the owner can make or move a release tag.`,
    );
  }
  const bypassed = active.filter((r) => r.current_user_can_bypass === "always");
  if (bypassed.length > 0) {
    problems.push(
      `The workflow's own token may bypass the tag ruleset ${bypassed.map((r) => r.name).join(", ")}: remove GitHub Actions from its bypass list.`,
    );
  }
  return problems;
}
