// What a release run reads from and does on GitHub, through the `gh` CLI with the job's own token:
// the repository settings a release depends on, the draft that holds a release until its files are
// complete, and publishing it once every file, downloaded back, checks out the way a person's
// machine checks it. version.ts and settings.ts decide; this module only reads what GitHub has and
// does what was decided. Nothing here makes or deletes a tag, or deletes a release.
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
  draftAction,
  draftStep,
  releaseTag,
  releaseVersionProblem,
  VersionRefusal,
  type ReleaseSummary,
  type RemoteRelease,
} from "./version.ts";

/** Runs `gh` without a shell and returns its stdout. Its stderr names no secret. */
function gh(args: readonly string[]): Buffer {
  const ran = spawnSync("gh", args, { windowsHide: true, maxBuffer: 1024 * 1024 * 1024 });
  if (ran.error !== undefined) throw ran.error;
  if (ran.status !== 0) {
    throw new GhError(`gh ${args.slice(0, 2).join(" ")} failed: ${ran.stderr.toString().trim()}`);
  }
  return ran.stdout;
}

class GhError extends Error {
  override readonly name = "GhError";
}

const notFound = (error: unknown): boolean =>
  error instanceof GhError && /\b404\b|Not Found/.test(error.message);

const api = (path: string): unknown => JSON.parse(gh(["api", path]).toString());

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** The commit a tag names on GitHub, or undefined when there is no such tag. */
function tagCommit(repo: string, tag: string): string | undefined {
  let ref: { object: { type: string; sha: string } };
  try {
    ref = api(`repos/${repo}/git/ref/tags/${tag}`) as typeof ref;
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
  if (ref.object.type !== "tag") return ref.object.sha;
  return (api(`repos/${repo}/git/tags/${ref.object.sha}`) as { object: { sha: string } }).object
    .sha;
}

interface ApiRelease {
  readonly id: number;
  readonly draft: boolean;
  readonly target_commitish: string;
  readonly assets: readonly {
    readonly id: number;
    readonly name: string;
    readonly digest?: string | null;
  }[];
}

/** The releases GitHub shows this token for a tag: drafts only to a token that may write. */
function releasesFor(repo: string, tag: string): ApiRelease[] {
  const lines = gh([
    "api",
    `repos/${repo}/releases`,
    "--paginate",
    "--jq",
    `.[] | select(.tag_name == "${tag}") | {id, draft, target_commitish, assets: [.assets[] | {id, name, digest}]}`,
  ])
    .toString()
    .split("\n")
    .filter((line) => line.trim() !== "");
  return lines.map((line) => JSON.parse(line) as ApiRelease);
}

const summary = (release: ApiRelease): ReleaseSummary => ({
  id: release.id,
  draft: release.draft,
  target: release.target_commitish,
  files: release.assets.map((asset) => asset.name),
});

const assetBytes = (repo: string, id: number): Buffer =>
  gh([
    "api",
    "-H",
    "Accept: application/octet-stream",
    `repos/${repo}/releases/assets/${String(id)}`,
  ]);

/** The one release for the tag, with each file's SHA-256, or undefined. Refuses two. */
function remoteRelease(repo: string, tag: string): RemoteRelease | undefined {
  const found = releasesFor(repo, tag);
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
    assets[asset.name] = digest ?? sha256(assetBytes(repo, asset.id));
  }
  return { id: release.id, draft: release.draft, target: release.target_commitish, assets };
}

/** The settings a release depends on, as the workflow's token reads them. */
function readSettings(repo: string): RepositorySettings {
  let environment: EnvironmentSettings | undefined;
  let policies: RefPolicy[] = [];
  try {
    environment = api(`repos/${repo}/environments/${RELEASE_ENVIRONMENT}`) as EnvironmentSettings;
  } catch (error) {
    if (!notFound(error)) throw error;
  }
  if (environment?.deployment_branch_policy?.custom_branch_policies === true) {
    policies = (
      api(
        `repos/${repo}/environments/${RELEASE_ENVIRONMENT}/deployment-branch-policies?per_page=100`,
      ) as { branch_policies: RefPolicy[] }
    ).branch_policies;
  }
  const listed = api(`repos/${repo}/rulesets?includes_parents=true&per_page=100`) as {
    id: number;
    target?: string;
  }[];
  const rulesets = listed
    .filter((r) => (r.target ?? "tag") === "tag")
    .map((r) => api(`repos/${repo}/rulesets/${String(r.id)}`) as RulesetSettings);
  return { environment, policies, rulesets };
}

/**
 * What stands in the way of releasing `version` on GitHub, read with the workflow's token before
 * anything is built: the settings, and a version that is released already. Empty when nothing does.
 * A setting that cannot be read counts: a release is not signed on settings nobody could check.
 */
export function releaseReadiness(repo: string, version: string, commit: string): string[] {
  let problems: string[];
  try {
    problems = settingsProblems(readSettings(repo));
  } catch (error) {
    problems = [
      `The release settings cannot be read (${error instanceof Error ? error.message : String(error)}).`,
    ];
  }
  try {
    draftAction(version, commit, releasesFor(repo, releaseTag(version)).map(summary));
  } catch (error) {
    if (!(error instanceof VersionRefusal)) throw error;
    problems.push(error.message);
  }
  return problems;
}

const notes = (version: string): string =>
  `${PRODUCT_NAME} ${version}. Install it with install-${version}.sh (Linux) or install-${version}.ps1 (Windows) from a folder that holds the files of this release: the script checks the signature of SHA256SUMS and the archive's hash before anything of it runs.`;

const prerelease = (version: string): string => String(version.includes("-"));

/** A new draft for the existing tag; `--verify-tag` keeps gh from ever making the tag. */
function createDraft(repo: string, version: string, commit: string): void {
  gh([
    "release",
    "create",
    releaseTag(version),
    "--repo",
    repo,
    "--draft",
    "--verify-tag",
    "--target",
    commit,
    "--title",
    `${PRODUCT_NAME} ${version}`,
    "--notes",
    notes(version),
    ...(version.includes("-") ? ["--prerelease"] : []),
  ]);
}

/**
 * `pnpm release draft`: the one draft that holds the release of `version` until its files are
 * complete, made before anything is signed. A release made in GitHub's page with the tag is turned
 * back into a draft, its title and notes kept, so nobody downloads it while it has no files or only
 * some. Never makes a tag: the draft is made only for the tag that exists.
 */
export function holdRelease(options: {
  readonly repo: string;
  readonly version: string;
  readonly commit: string;
  readonly log: (line: string) => void;
}): void {
  const { repo, version, commit, log } = options;
  const problem = releaseVersionProblem(version);
  if (problem !== undefined) throw new Refusal(problem);
  const tag = releaseTag(version);
  if (tagCommit(repo, tag) !== commit) {
    throw new VersionRefusal(`${tag} does not name ${commit} on GitHub, so nothing was signed.`);
  }
  const step = draftAction(version, commit, releasesFor(repo, tag).map(summary));
  if (step.action === "create") {
    createDraft(repo, version, commit);
    log(`made the draft of ${tag}: it is published when its files are complete`);
    return;
  }
  gh([
    "api",
    "--method",
    "PATCH",
    `repos/${repo}/releases/${String(step.id)}`,
    "-F",
    "draft=true",
    "-f",
    `target_commitish=${commit}`,
    "-F",
    `prerelease=${prerelease(version)}`,
  ]);
  log(
    step.action === "hide"
      ? `${tag} was published without its files: it is a draft again, with its title and notes, until they are complete`
      : `kept the draft of ${tag}: it is published when its files are complete`,
  );
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
 * published. A published release is never changed.
 */
export function publishRelease(options: {
  readonly repo: string;
  readonly dist: string;
  readonly version: string;
  readonly commit: string;
  readonly work: string;
  readonly log: (line: string) => void;
}): void {
  const { repo, dist, version, commit, work, log } = options;
  const problem = releaseVersionProblem(version);
  if (problem !== undefined) throw new Refusal(problem);
  const tag = releaseTag(version);
  const local = releaseFiles(dist);
  for (;;) {
    const step = draftStep(version, commit, local, tagCommit(repo, tag), remoteRelease(repo, tag));
    if (step.step === "done") {
      if (step.published) {
        log(`${tag} is published already with exactly these files. Nothing was changed.`);
        return;
      }
      break;
    }
    if (step.step === "create") {
      createDraft(repo, version, commit);
      log(`made the draft of ${tag} again: it was gone`);
      continue;
    }
    for (const name of step.names) {
      gh(["release", "upload", tag, "--repo", repo, join(dist, name)]);
      log(`uploaded ${name}`);
    }
  }

  const found = releasesFor(repo, tag);
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
    writeFileSync(join(work, asset.name), assetBytes(repo, asset.id));
  }
  checkReleaseFolder(work, version, RELEASE_PUBLIC_KEYS, keysAt(repoRoot, commit));
  log(`${tag}: every file, downloaded back, verifies with the pinned release keys`);
  checkPublishCommit(version, commit, tagCommit(repo, tag), (c) => isOnMain(repoRoot, c));
  gh([
    "api",
    "--method",
    "PATCH",
    `repos/${repo}/releases/${String(release.id)}`,
    "-F",
    "draft=false",
  ]);
  log(`published ${tag}`);
}
