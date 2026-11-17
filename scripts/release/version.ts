// Where a release's version comes from, and what may happen to a version that GitHub already has.
//
// A release's version is the `version` in package.json at the commit it is built from: changing it
// is a reviewed commit on main, like any other. Its tag is `v<version>`, and making that tag is
// what starts the release. The `-dev.` and
// `-rehearsal.` pre-releases are reserved: `pnpm build` names every ordinary build `-dev.<n>`, and a
// rehearsal names its builds `-rehearsal.<run>.<n>`. The same version is never released with other
// bytes: a release that GitHub already has must hold exactly these files, byte for byte, and one
// that is published is never changed.
import { isVersionName } from "../../packages/service/src/version/folder.ts";
import { isAppVersion } from "../../packages/storage/src/manifest.ts";

/** The pattern the service's log accepts for a version (packages/service/src/hub/log.ts). */
const LOG_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const REHEARSAL = /^\d{1,6}\.\d{1,6}\.\d{1,6}-rehearsal\.\d{1,9}\.\d{1,3}$/;

const isBuildVersion = (version: string): boolean =>
  isAppVersion(version) && isVersionName(version) && LOG_VERSION.test(version);

/** Why `version` cannot be a release's, or undefined when it can. */
export function releaseVersionProblem(version: string): string | undefined {
  if (!isBuildVersion(version)) {
    return `${version} is not a release version: major.minor.patch, with an optional -pre.release.`;
  }
  if (/-(?:dev|rehearsal)(?:\.|$)/i.test(version)) {
    return `${version} is a development or rehearsal version, never a release's.`;
  }
  return undefined;
}

export const isRehearsalVersion = (version: string): boolean =>
  REHEARSAL.test(version) && isBuildVersion(version);

/**
 * A rehearsal's version for package.json's `packageVersion`: its major.minor.patch, then
 * `-rehearsal.<run>.<step>`. Step 0 is the build a rehearsal upgrades from, step 1 its own.
 */
export function rehearsalVersion(packageVersion: string, run: number, step: number): string {
  const core = /^(\d{1,6}\.\d{1,6}\.\d{1,6})/.exec(packageVersion)?.[1];
  if (core === undefined) throw new Error(`package.json's version ${packageVersion} has no x.y.z`);
  const version = `${core}-rehearsal.${String(run)}.${String(step)}`;
  if (!isRehearsalVersion(version)) throw new Error(`${version} is not a rehearsal version`);
  return version;
}

export const releaseTag = (version: string): string => `v${version}`;

/** A release GitHub has for the tag: draft or published, its target and its files' SHA-256. */
export interface RemoteRelease {
  readonly id: number;
  readonly draft: boolean;
  readonly target: string;
  readonly assets: Readonly<Record<string, string>>;
}

export type DraftStep =
  | { readonly step: "create" }
  | { readonly step: "upload"; readonly names: readonly string[] }
  | { readonly step: "done"; readonly published: boolean };

/** Thrown when the version rule refuses: nothing is created, uploaded or changed. */
export class VersionRefusal extends Error {
  override readonly name = "VersionRefusal";
}

/** What retrying a refused tag takes. The run itself never deletes a tag or a release. */
export const TRY_AGAIN =
  "To try again, delete the tag (and the release, if one was made for it), then make the tag again on the right commit.";

/**
 * Refuses to publish files built from `built` unless it is a full commit on main and the tag still
 * names it: GitHub publishes a release at its tag.
 */
export function checkPublishCommit(
  version: string,
  built: string,
  tagCommit: string | undefined,
  onMain: (commit: string) => boolean,
): void {
  const tag = releaseTag(version);
  if (!/^[0-9a-f]{40}$/.test(built) || !onMain(built)) {
    throw new VersionRefusal(`${built} is not a commit on main, so ${tag} is not published.`);
  }
  if (tagCommit !== built) {
    throw new VersionRefusal(
      tagCommit === undefined
        ? `${tag} no longer exists, so its release is not published. ${TRY_AGAIN}`
        : `${tag} now names commit ${tagCommit}, but the release's files were built from ${built}, so it is not published. ${TRY_AGAIN}`,
    );
  }
}

/** A release GitHub has for a tag, as the draft step needs it: whether it holds files. */
export interface ReleaseSummary {
  readonly id: number;
  readonly draft: boolean;
  readonly target: string;
  readonly files: readonly string[];
}

export type DraftAction =
  | { readonly action: "create" }
  | { readonly action: "keep"; readonly id: number }
  /** A release published without files (made in GitHub's page with the tag): hidden until complete. */
  | { readonly action: "hide"; readonly id: number };

/**
 * What a release run does about the releases GitHub has for the tag of `version`, before anything
 * is signed, so the run ends with one draft that becomes the release when its files are complete.
 * Refuses a version that is released already (a published release with files) and anything it
 * cannot resolve without deleting, which it leaves to the owner.
 */
export function draftAction(
  version: string,
  commit: string,
  releases: readonly ReleaseSummary[],
): DraftAction {
  const tag = releaseTag(version);
  if (releases.length > 1) {
    throw new VersionRefusal(
      `GitHub has ${String(releases.length)} releases for ${tag}: delete all but one by hand, then re-run the failed jobs.`,
    );
  }
  const release = releases[0];
  if (release === undefined) return { action: "create" };
  if (!release.draft) {
    if (release.files.length > 0) {
      throw new VersionRefusal(
        `${tag} is released already, and a version is released once: raise the version in package.json and make a new tag.`,
      );
    }
    return { action: "hide", id: release.id };
  }
  // Only a release run sets a commit as the target; a release made in GitHub's page names a branch.
  if (
    release.files.length > 0 &&
    /^[0-9a-f]{40}$/.test(release.target) &&
    release.target !== commit
  ) {
    throw new VersionRefusal(
      `The draft of ${tag} holds files built from ${release.target}, not from ${commit} that the tag names: delete that draft by hand, then re-run the failed jobs.`,
    );
  }
  return { action: "keep", id: release.id };
}

/**
 * What the draft step does for a release of `version` from `commit` with the files `local` (name
 * to SHA-256), given what GitHub has: the commit the tag names, if the tag exists, and the release
 * for the tag, if there is one. Creates a draft, uploads only the files a draft lacks (a rerun
 * resumes), or does nothing when GitHub has exactly these files. Refuses everything else.
 */
export function draftStep(
  version: string,
  commit: string,
  local: Readonly<Record<string, string>>,
  tagCommit: string | undefined,
  remote: RemoteRelease | undefined,
): DraftStep {
  const tag = releaseTag(version);
  if (tagCommit !== commit) {
    throw new VersionRefusal(
      tagCommit === undefined
        ? `${tag} no longer exists, so its release is not completed. ${TRY_AGAIN}`
        : `${tag} now names commit ${tagCommit}, not ${commit} that was built, so its release is not completed. ${TRY_AGAIN}`,
    );
  }
  if (remote === undefined) return { step: "create" };
  const differs: string[] = [];
  for (const [name, digest] of Object.entries(remote.assets)) {
    if (local[name] !== digest) differs.push(name);
  }
  if (differs.length > 0) {
    throw new VersionRefusal(
      `${tag} already holds ${differs.sort().join(", ")} with other bytes or not in this release. The same version is never released with other bytes: raise the version in package.json.`,
    );
  }
  const missing = Object.keys(local)
    .filter((name) => !(name in remote.assets))
    .sort();
  if (missing.length === 0) return { step: "done", published: !remote.draft };
  if (!remote.draft) {
    throw new VersionRefusal(
      `${tag} is published without ${missing.join(", ")}. A published release is never changed.`,
    );
  }
  return { step: "upload", names: missing };
}
