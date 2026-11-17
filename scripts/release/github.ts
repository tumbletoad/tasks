// What a release run reads from and does on GitHub, through the `gh` CLI with the job's own token:
// the repository settings a release depends on, the draft that holds a release until its files are
// complete, and publishing it once every file, downloaded back, checks out the way a person's
// machine checks it. version.ts and settings.ts decide; this module only reads what GitHub has and
// does what was decided. Nothing here makes or deletes a tag, or deletes a release.
//
// A release's tag always exists before the run touches its release, so GitHub ignores the release's
// target. The run still names the default branch as the target: GitHub refuses the job's token any
// change to a release whose target holds workflow files that differ from the default branch's,
// which a tagged commit does as soon as main changes a workflow after it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { RELEASE_PUBLIC_KEYS } from "../../packages/service/src/version/release-keys.ts";
import { ReleaseError, verifyRelease } from "../../packages/service/src/version/release.ts";
import { ARCHIVE_NAME, archiveName, type Platform } from "../build/platforms.ts";
import {
  parseOpensshPublicKey,
  RAW_SIGNATURE,
  SSH_SIGNATURE,
  SUMS_FILE,
  TEST_KEY_FILE,
  verifyRawSignature,
  verifySshSignature,
} from "../build/signing.ts";
import { INSTALLER_KINDS, installerName } from "../install/render.ts";
import { repoRoot } from "../run.ts";
import { RELEASE_PLATFORMS } from "./gather.ts";
import { isOnMain, keysAt } from "./plan.ts";
import { keyLinesIn, Refusal } from "./release.ts";
import {
  RELEASE_ENVIRONMENT,
  settingsProblems,
  type EnvironmentSettings,
  type RefPolicy,
  type RepositorySettings,
  type RulesetSettings,
} from "./settings.ts";
import {
  checkPublishCommit,
  draftStep,
  isLatest,
  releasedProblem,
  releaseTag,
  releaseVersionProblem,
  VersionRefusal,
  type ReleaseSummary,
  type RemoteRelease,
} from "./version.ts";

/** Runs `gh` with these arguments and returns its stdout; throws a GhError when gh fails. */
export type Gh = (args: readonly string[]) => Buffer;

/** `gh` itself, without a shell. Its stderr names no secret. */
const runGh: Gh = (args) => {
  const ran = spawnSync("gh", args, { windowsHide: true, maxBuffer: 1024 * 1024 * 1024 });
  if (ran.error !== undefined) throw ran.error;
  if (ran.status !== 0) {
    throw new GhError(`gh ${args.slice(0, 2).join(" ")} failed: ${ran.stderr.toString().trim()}`);
  }
  return ran.stdout;
};

export class GhError extends Error {
  override readonly name = "GhError";
}

/** The branch a release names as its target. */
const MAIN = "main";

const notFound = (error: unknown): boolean =>
  error instanceof GhError && /\b404\b|Not Found/.test(error.message);

const api = (gh: Gh, path: string): unknown => JSON.parse(gh(["api", path]).toString());

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** The commit a tag names on GitHub, or undefined when there is no such tag. */
function tagCommit(gh: Gh, repo: string, tag: string): string | undefined {
  let ref: { object: { type: string; sha: string } };
  try {
    ref = api(gh, `repos/${repo}/git/ref/tags/${tag}`) as typeof ref;
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
  if (ref.object.type !== "tag") return ref.object.sha;
  return (api(gh, `repos/${repo}/git/tags/${ref.object.sha}`) as { object: { sha: string } }).object
    .sha;
}

interface ApiRelease {
  readonly id: number;
  readonly draft: boolean;
  readonly assets: readonly {
    readonly id: number;
    readonly name: string;
    readonly digest?: string | null;
  }[];
}

/** The releases GitHub shows this token for a tag: drafts only to a token that may write. */
function releasesFor(gh: Gh, repo: string, tag: string): ApiRelease[] {
  const lines = gh([
    "api",
    `repos/${repo}/releases`,
    "--paginate",
    "--jq",
    `.[] | select(.tag_name == "${tag}") | {id, draft, assets: [.assets[] | {id, name, digest}]}`,
  ])
    .toString()
    .split("\n")
    .filter((line) => line.trim() !== "");
  return lines.map((line) => JSON.parse(line) as ApiRelease);
}

const summary = (release: ApiRelease): ReleaseSummary => ({
  draft: release.draft,
  files: release.assets.map((asset) => asset.name),
});

const assetBytes = (gh: Gh, repo: string, id: number): Buffer =>
  gh([
    "api",
    "-H",
    "Accept: application/octet-stream",
    `repos/${repo}/releases/assets/${String(id)}`,
  ]);

/**
 * Changes a release of `tag`: the tag is sent again so GitHub keeps the release on it, and whether
 * it is a pre-release follows the version, whatever the page or gh made it.
 */
const editRelease = (
  gh: Gh,
  repo: string,
  tag: string,
  id: number,
  fields: { readonly draft: boolean; readonly latest?: boolean },
): Buffer =>
  gh([
    "api",
    "--method",
    "PATCH",
    `repos/${repo}/releases/${String(id)}`,
    "-f",
    `tag_name=${tag}`,
    "-f",
    `target_commitish=${MAIN}`,
    "-F",
    `draft=${String(fields.draft)}`,
    "-F",
    `prerelease=${String(tag.includes("-"))}`,
    ...(fields.latest === undefined ? [] : ["-f", `make_latest=${String(fields.latest)}`]),
  ]);

/** The versions of the releases GitHub has published, from their tags. */
const publishedVersions = (gh: Gh, repo: string): string[] =>
  gh([
    "api",
    `repos/${repo}/releases`,
    "--paginate",
    "--jq",
    `.[] | select(.draft == false) | .tag_name`,
  ])
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("v"))
    .map((line) => line.slice(1));

/** The one release for the tag, with each file's SHA-256, or undefined. Refuses two. */
function remoteRelease(gh: Gh, repo: string, tag: string): RemoteRelease | undefined {
  const found = releasesFor(gh, repo, tag);
  if (found.length > 1) {
    throw new VersionRefusal(
      `GitHub has ${String(found.length)} releases for ${tag}: delete all but one by hand, then re-run the failed jobs.`,
    );
  }
  const release = found[0];
  if (release === undefined) return undefined;
  const assets: Record<string, string> = {};
  for (const asset of release.assets) {
    const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "")?.[1];
    assets[asset.name] = digest ?? sha256(assetBytes(gh, repo, asset.id));
  }
  return { id: release.id, draft: release.draft, assets };
}

/** The settings a release depends on, as the workflow's token reads them. */
function readSettings(gh: Gh, repo: string): RepositorySettings {
  let environment: EnvironmentSettings | undefined;
  let policies: RefPolicy[] = [];
  try {
    environment = api(
      gh,
      `repos/${repo}/environments/${RELEASE_ENVIRONMENT}`,
    ) as EnvironmentSettings;
  } catch (error) {
    if (!notFound(error)) throw error;
  }
  if (environment?.deployment_branch_policy?.custom_branch_policies === true) {
    policies = (
      api(
        gh,
        `repos/${repo}/environments/${RELEASE_ENVIRONMENT}/deployment-branch-policies?per_page=100`,
      ) as { branch_policies: RefPolicy[] }
    ).branch_policies;
  }
  const listed = api(gh, `repos/${repo}/rulesets?includes_parents=true&per_page=100`) as {
    id: number;
    target?: string;
  }[];
  const rulesets = listed
    .filter((r) => (r.target ?? "tag") === "tag")
    .map((r) => api(gh, `repos/${repo}/rulesets/${String(r.id)}`) as RulesetSettings);
  return { environment, policies, rulesets };
}

/**
 * What stands in the way of releasing `version` on GitHub, read with the workflow's token before
 * anything is built: the settings, and a version that is released already. Empty when nothing does.
 * A setting that cannot be read counts: a release is not signed on settings nobody could check.
 */
export function releaseReadiness(repo: string, version: string, gh: Gh = runGh): string[] {
  let problems: string[];
  try {
    problems = settingsProblems(readSettings(gh, repo));
  } catch (error) {
    problems = [
      `The release settings cannot be read (${error instanceof Error ? error.message : String(error)}).`,
    ];
  }
  const released = releasedProblem(
    version,
    releasesFor(gh, repo, releaseTag(version)).map(summary),
  );
  if (released !== undefined) problems.push(released);
  return problems;
}

const notes = (version: string): string =>
  `${PRODUCT_NAME} ${version}. Install it with install-${version}.sh (Linux) or install-${version}.ps1 (Windows) from a folder that holds the files of this release: the script checks the signature of SHA256SUMS and the archive's hash before anything of it runs.`;

/** A new draft for the existing tag; `--verify-tag` keeps gh from ever making the tag. */
function createDraft(gh: Gh, repo: string, version: string): void {
  gh([
    "release",
    "create",
    releaseTag(version),
    "--repo",
    repo,
    "--draft",
    "--verify-tag",
    "--target",
    MAIN,
    "--title",
    `${PRODUCT_NAME} ${version}`,
    "--notes",
    notes(version),
    ...(version.includes("-") ? ["--prerelease"] : []),
  ]);
}

/**
 * `pnpm release hold`: the first thing a tag's run does, before its tag is even checked. A release
 * made in GitHub's page (or by `gh release create`) with the tag is public at once and has no files
 * yet: it becomes a draft again, its title and notes kept, so nobody downloads it before its files
 * are complete, and so it is not left public when the run refuses the tag. Any other release for
 * the tag is left as it is. Two releases for the tag are refused here, before anything is signed:
 * only this job's token sees drafts.
 */
export function holdRelease(options: {
  readonly repo: string;
  readonly tag: string;
  readonly log: (line: string) => void;
  readonly gh?: Gh;
}): void {
  const { repo, tag, log, gh = runGh } = options;
  if (!/^v[0-9A-Za-z.+-]+$/.test(tag)) throw new Refusal(`${tag} is not a version tag.`);
  const releases = releasesFor(gh, repo, tag);
  let held = 0;
  for (const release of releases) {
    if (release.draft || release.assets.length > 0) continue;
    editRelease(gh, repo, tag, release.id, { draft: true });
    held += 1;
  }
  log(
    held > 0
      ? `${tag} was published without its files: it is a draft again, with its title and notes, until they are complete`
      : `${tag} has no published release without files: nothing to hold`,
  );
  if (releases.length > 1) {
    throw new VersionRefusal(
      `GitHub has ${String(releases.length)} releases for ${tag}: delete all but one by hand, then re-run the failed jobs.`,
    );
  }
}

/**
 * The checks on a release's files before it is published, as a person's machine makes them:
 * SHA256SUMS signed in both formats by a pinned release key, each platform's archive verified by
 * the product's own updater check, and the release's install scripts beside them.
 */
export function checkReleaseFolder(
  dist: string,
  version: string,
  pinned: readonly string[] = RELEASE_PUBLIC_KEYS,
  /** The keys the install scripts pin: the release keys of the commit the release was built from. */
  installerKeys: readonly string[] = pinned,
): void {
  if (existsSync(join(dist, TEST_KEY_FILE))) {
    throw new Refusal("A test key or a rehearsal signed these files: they are never published.");
  }
  const sums = readFileSync(join(dist, SUMS_FILE));
  const raw = readFileSync(join(dist, RAW_SIGNATURE));
  const armored = readFileSync(join(dist, SSH_SIGNATURE), "utf8");
  const signer = pinned.find((line) => {
    try {
      const key = parseOpensshPublicKey(line);
      return verifyRawSignature(sums, raw, key) && verifySshSignature(sums, armored, key);
    } catch {
      return false;
    }
  });
  if (signer === undefined) {
    throw new Refusal(`${SUMS_FILE} is not signed in both formats by a pinned release key.`);
  }
  for (const platform of RELEASE_PLATFORMS) {
    const archive = join(dist, archiveName(version, platform));
    try {
      verifyRelease(archive, pinned, platform);
    } catch (error) {
      if (error instanceof ReleaseError) throw new Refusal(`${platform}: ${error.message}`);
      throw error;
    }
  }
  const extra = readdirSync(dist).filter((name) => {
    const archive = ARCHIVE_NAME.exec(name);
    if (archive !== null)
      return !(archive[1] === version && RELEASE_PLATFORMS.includes(archive[2] as Platform));
    return (
      ![SUMS_FILE, RAW_SIGNATURE, SSH_SIGNATURE].includes(name) &&
      !INSTALLER_KINDS.some((kind) => name === installerName(kind, version, "release"))
    );
  });
  if (extra.length > 0)
    throw new Refusal(`The release holds files it should not: ${extra.join(", ")}.`);
  // The install scripts are what a person runs first and are not covered by the signature: each
  // must name this version and pin exactly the release keys of the commit it was built from (a
  // key added on main since is not in them).
  const keys = [
    ...new Set(installerKeys.map((line) => line.trim().split(/\s+/).slice(0, 2).join(" "))),
  ];
  for (const kind of INSTALLER_KINDS) {
    const name = installerName(kind, version, "release");
    if (!existsSync(join(dist, name))) throw new Refusal(`The release has no ${name}.`);
    const text = readFileSync(join(dist, name), "utf8");
    const pins = [...new Set(keyLinesIn(text))];
    if (
      !text.includes(`'${version}'`) ||
      pins.length !== keys.length ||
      !keys.every((key) => pins.includes(key))
    ) {
      throw new Refusal(
        `${name} is not this release's install script: it must be the one for ${version} that pins exactly the release keys.`,
      );
    }
  }
}

/** The signed release folder's files, name to SHA-256. Refuses a rehearsal's. */
export function releaseFiles(dist: string): Record<string, string> {
  if (existsSync(join(dist, TEST_KEY_FILE))) {
    throw new Refusal("A test key or a rehearsal signed this folder: it is never released.");
  }
  const files: Record<string, string> = {};
  for (const name of readdirSync(dist).sort()) files[name] = sha256(readFileSync(join(dist, name)));
  return files;
}

/**
 * `pnpm release publish`: the signed folder `dist` into the draft of `version` (a rerun uploads
 * only what an earlier one did not, and a file GitHub has already must be these bytes), every file
 * downloaded back and checked, the tag checked to still name `commit` on main, then the draft
 * published. It becomes GitHub's latest release unless it is a pre-release or a higher version
 * is published already (a fix tagged during an earlier version's run may publish first). A
 * published release is never changed.
 */
export function publishRelease(options: {
  readonly repo: string;
  readonly dist: string;
  readonly version: string;
  readonly commit: string;
  readonly work: string;
  readonly log: (line: string) => void;
  readonly gh?: Gh;
  /** What publishing checks against: main's release keys, and the commit's, and main itself. */
  readonly trust?: {
    readonly pinned: readonly string[];
    readonly installerKeys: readonly string[];
    readonly onMain: (commit: string) => boolean;
  };
}): void {
  const { repo, dist, version, commit, work, log, gh = runGh } = options;
  const problem = releaseVersionProblem(version);
  if (problem !== undefined) throw new Refusal(problem);
  const tag = releaseTag(version);
  const local = releaseFiles(dist);
  for (;;) {
    const step = draftStep(
      version,
      commit,
      local,
      tagCommit(gh, repo, tag),
      remoteRelease(gh, repo, tag),
    );
    if (step.step === "done") {
      if (step.published) {
        log(`${tag} is published already with exactly these files. Nothing was changed.`);
        return;
      }
      break;
    }
    if (step.step === "create") {
      createDraft(gh, repo, version);
      log(`made the draft of ${tag}: it is published when its files are complete`);
      continue;
    }
    for (const name of step.names) {
      gh(["release", "upload", tag, "--repo", repo, join(dist, name)]);
      log(`uploaded ${name}`);
    }
  }

  const found = releasesFor(gh, repo, tag);
  const release = found[0];
  if (found.length !== 1 || release === undefined || !release.draft) {
    throw new VersionRefusal(
      `The draft of ${tag} changed while it was filled: re-run the failed jobs.`,
    );
  }
  if (existsSync(work)) throw new Refusal(`${work} exists: publish makes it itself.`);
  mkdirSync(work, { recursive: true });
  for (const asset of release.assets) {
    if (!/^[0-9A-Za-z.+-]+$/.test(asset.name))
      throw new Refusal(`An asset has an odd name: ${asset.name}.`);
    writeFileSync(join(work, asset.name), assetBytes(gh, repo, asset.id));
  }
  const trust = options.trust ?? {
    pinned: RELEASE_PUBLIC_KEYS,
    installerKeys: keysAt(repoRoot, commit),
    onMain: (c: string) => isOnMain(repoRoot, c),
  };
  checkReleaseFolder(work, version, trust.pinned, trust.installerKeys);
  log(`${tag}: every file, downloaded back, verifies with the pinned release keys`);
  checkPublishCommit(version, commit, tagCommit(gh, repo, tag), trust.onMain);
  const latest = isLatest(version, publishedVersions(gh, repo));
  editRelease(gh, repo, tag, release.id, { draft: false, latest });
  log(latest ? `published ${tag}, the latest release` : `published ${tag}`);
}
