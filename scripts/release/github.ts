// The GitHub release of a signed folder, through the `gh` CLI with the job's own token: a draft
// with every file, resumed by a rerun, and publishing that draft as a separate, explicit step after
// checking every file it holds the way the product does. draftStep (version.ts) decides; this
// module only reads what GitHub has and does what was decided.
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
  checkPublishCommit,
  draftStep,
  releaseTag,
  releaseVersionProblem,
  VersionRefusal,
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

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** The commit a tag names on GitHub, or undefined when there is no such tag. */
function tagCommit(repo: string, tag: string): string | undefined {
  let ref: { object: { type: string; sha: string } };
  try {
    ref = JSON.parse(gh(["api", `repos/${repo}/git/ref/tags/${tag}`]).toString()) as typeof ref;
  } catch (error) {
    if (error instanceof GhError && /\b404\b|Not Found/.test(error.message)) return undefined;
    throw error;
  }
  if (ref.object.type !== "tag") return ref.object.sha;
  const tagObject = JSON.parse(
    gh(["api", `repos/${repo}/git/tags/${ref.object.sha}`]).toString(),
  ) as {
    object: { sha: string };
  };
  return tagObject.object.sha;
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

/** The releases GitHub has for a tag, drafts included (a draft has no tag yet). */
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

const assetBytes = (repo: string, id: number): Buffer =>
  gh([
    "api",
    "-H",
    "Accept: application/octet-stream",
    `repos/${repo}/releases/assets/${String(id)}`,
  ]);

/** The one release for the tag, with each file's SHA-256, or undefined. Refuses two. */
function remoteRelease(
  repo: string,
  tag: string,
): (RemoteRelease & { raw: ApiRelease }) | undefined {
  const found = releasesFor(repo, tag);
  if (found.length > 1) {
    throw new VersionRefusal(
      `GitHub has ${String(found.length)} releases for ${tag}. Delete the extra drafts by hand.`,
    );
  }
  const release = found[0];
  if (release === undefined) return undefined;
  const assets: Record<string, string> = {};
  for (const asset of release.assets) {
    const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "")?.[1];
    assets[asset.name] = digest ?? sha256(assetBytes(repo, asset.id));
  }
  return {
    id: release.id,
    draft: release.draft,
    target: release.target_commitish,
    assets,
    raw: release,
  };
}

/** The files of a signed release folder, name to SHA-256. Refuses a rehearsal's. */
export function releaseFiles(dist: string): Record<string, string> {
  if (existsSync(join(dist, TEST_KEY_FILE))) {
    throw new Refusal("A test key or a rehearsal signed this folder: it is never released.");
  }
  const files: Record<string, string> = {};
  for (const name of readdirSync(dist).sort()) files[name] = sha256(readFileSync(join(dist, name)));
  return files;
}

/**
 * `pnpm release draft`: the draft release of the signed folder `dist`, for `commit`. A rerun
 * uploads what an earlier run did not; files GitHub has already must be these bytes.
 */
export function draftRelease(options: {
  readonly repo: string;
  readonly dist: string;
  readonly version: string;
  readonly commit: string;
  readonly log: (line: string) => void;
}): void {
  const { repo, dist, version, commit, log } = options;
  const problem = releaseVersionProblem(version);
  if (problem !== undefined) throw new Refusal(problem);
  const tag = releaseTag(version);
  const local = releaseFiles(dist);
  for (;;) {
    const step = draftStep(version, commit, local, tagCommit(repo, tag), remoteRelease(repo, tag));
    if (step.step === "done") {
      log(
        step.published
          ? `${tag} is published already with exactly these files. Nothing was changed.`
          : `The draft of ${tag} holds exactly these files. Publish it with the release workflow's publish mode.`,
      );
      return;
    }
    if (step.step === "create") {
      gh([
        "release",
        "create",
        tag,
        "--repo",
        repo,
        "--draft",
        "--target",
        commit,
        "--title",
        `${PRODUCT_NAME} ${version}`,
        "--notes",
        `${PRODUCT_NAME} ${version}. Install it with install-${version}.sh (Linux) or install-${version}.ps1 (Windows) from a folder that holds the files of this release: the script checks the signature of SHA256SUMS and the archive's hash before anything of it runs.`,
        ...(version.includes("-") ? ["--prerelease"] : []),
      ]);
      log(`created the draft of ${tag} for ${commit}`);
      continue;
    }
    for (const name of step.names) {
      gh(["release", "upload", tag, "--repo", repo, join(dist, name)]);
      log(`uploaded ${name}`);
    }
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

/**
 * `pnpm release publish`: the draft of `version`, checked file by file as downloaded from GitHub,
 * then published. A published release is checked and left as it is.
 */
export function publishRelease(options: {
  readonly repo: string;
  readonly version: string;
  readonly work: string;
  readonly log: (line: string) => void;
}): void {
  const { repo, version, work, log } = options;
  const problem = releaseVersionProblem(version);
  if (problem !== undefined) throw new Refusal(problem);
  const tag = releaseTag(version);
  const release = releasesFor(repo, tag);
  if (release.length !== 1 || release[0] === undefined) {
    throw new Refusal(`GitHub has ${String(release.length)} releases for ${tag}, not one.`);
  }
  const found = release[0];
  checkPublishCommit(version, found.target_commitish, tagCommit(repo, tag), (commit) =>
    isOnMain(repoRoot, commit),
  );
  if (existsSync(work)) throw new Refusal(`${work} exists: publish makes it itself.`);
  mkdirSync(work, { recursive: true });
  for (const asset of found.assets) {
    if (!/^[0-9A-Za-z.+-]+$/.test(asset.name))
      throw new Refusal(`An asset has an odd name: ${asset.name}.`);
    writeFileSync(join(work, asset.name), assetBytes(repo, asset.id));
  }
  checkReleaseFolder(work, version, RELEASE_PUBLIC_KEYS, keysAt(repoRoot, found.target_commitish));
  log(`${tag}: every file verifies with the pinned release keys`);
  if (!found.draft) {
    log(`${tag} is published already. Nothing was changed.`);
    return;
  }
  gh([
    "api",
    "--method",
    "PATCH",
    `repos/${repo}/releases/${String(found.id)}`,
    "-F",
    "draft=false",
  ]);
  log(`published ${tag}`);
}
