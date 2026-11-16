// Where a release's version comes from, and what may happen to a version that GitHub already has.
//
// A release's version is the `version` in package.json at the commit it is built from: changing it
// is a reviewed commit on main, like any other. Its tag is `v<version>`. The `-dev.` and
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
  if (tagCommit !== undefined && tagCommit !== commit) {
    throw new VersionRefusal(
      `${tag} already names commit ${tagCommit}, not ${commit}. A version is released from one commit only: raise the version in package.json.`,
    );
  }
  if (remote === undefined) return { step: "create" };
  if (remote.draft && remote.target !== commit) {
    throw new VersionRefusal(
      `The draft of ${tag} is for ${remote.target}, not ${commit}. Delete that draft by hand if it is wrong, or release its commit.`,
    );
  }
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
