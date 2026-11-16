// The check of a signed release on a fresh machine, before it is published: the release's own
// install script for this system installs it into a new root, and, with a previous signed release,
// installs that one first and upgrades it to this one. Then the installed product verifies the
// archive itself with `tasks update --from`, its signature and hashes against the keys the
// product carries. A release must pass (and is current already). A rehearsal must be refused:
// no product trusts its key, so nothing a rehearsal made can pass for a release.
//
// Every install goes into <work>, which must not exist. Nothing outside it is written: no PATH,
// profile, start-up entry or registry value, and no service is started.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { RELEASE_PUBLIC_KEYS } from "../../packages/service/src/version/release-keys.ts";
import { TEST_KEY_FILE } from "../build/signing.ts";
import {
  checkInstalled,
  HOME_VAR,
  releaseOfDist,
  restrictToMe,
  runInstaller,
  runProgram,
  stableCommand,
  type Ran,
  type Release,
} from "../install/test/kit.ts";

export interface InstallCheck {
  /** The signed release folder: a rehearsal's or the release's. */
  readonly dist: string;
  /** A previous signed release folder to install first and upgrade from. */
  readonly from?: string;
  /** A new folder for the installs. */
  readonly work: string;
  readonly log?: (line: string) => void;
}

const shown = (ran: Ran): string => `\n  exit ${String(ran.status)}\n${ran.stdout}\n${ran.stderr}`;

/** A signed folder as the kit reads it: a rehearsal's by its marker, else the release's. */
function signedRelease(dist: string, work: string): { release: Release; rehearsal: boolean } {
  const rehearsal = existsSync(join(dist, TEST_KEY_FILE));
  return {
    release: releaseOfDist(dist, work, rehearsal ? undefined : RELEASE_PUBLIC_KEYS),
    rehearsal,
  };
}

/** The installed product's own check of the archive: `tasks update --from <archive> --yes`. */
function productVerifies(root: string, release: Release, rehearsal: boolean): string {
  const ran = runProgram(stableCommand(root), [
    "update",
    "--from",
    join(release.dist, release.archive),
    "--yes",
  ]);
  if (rehearsal) {
    if (
      ran.status !== 5 ||
      !/trusts no release key yet|does not verify with this install's release keys/.test(ran.stderr)
    ) {
      throw new Error(`the installed rehearsal accepted its own archive as a release${shown(ran)}`);
    }
    return "the installed product refuses the rehearsal's archive: no product trusts its key";
  }
  if (ran.status !== 0 || !/is installed and current already/.test(ran.stdout)) {
    throw new Error(`the installed release does not verify its own archive${shown(ran)}`);
  }
  return "the installed product verifies the archive's signature and hashes with its own keys";
}

export function installCheck(options: InstallCheck): void {
  const log = options.log ?? (() => undefined);
  const work = resolve(options.work);
  if (existsSync(work)) throw new Error(`${work} exists: the check makes its work folder itself.`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  restrictToMe(work);
  const { release, rehearsal } = signedRelease(resolve(options.dist), join(work, "scripts"));
  log(
    `${rehearsal ? "rehearsal" : "release"} ${release.version} (${release.build}): ${release.archive}`,
  );

  const fresh = join(work, "fresh");
  checkInstalled(
    fresh,
    release,
    runInstaller(release, { env: { [HOME_VAR]: fresh }, within: work }),
  );
  log(`installed fresh into ${fresh}`);
  log(productVerifies(fresh, release, rehearsal));

  if (options.from === undefined) return;
  const previous = signedRelease(resolve(options.from), join(work, "previous-scripts")).release;
  if (previous.version === release.version) {
    throw new Error(`the previous release is ${previous.version} too: nothing to upgrade`);
  }
  const upgraded = join(work, "upgraded");
  const env = { [HOME_VAR]: upgraded };
  checkInstalled(upgraded, previous, runInstaller(previous, { env, within: work }));
  log(`installed the previous ${previous.version} into ${upgraded}`);
  checkInstalled(upgraded, release, runInstaller(release, { env, within: work }));
  if (!existsSync(join(upgraded, "versions", previous.version, "manifest.json"))) {
    throw new Error("the upgrade removed the previous version's folder");
  }
  log(`upgraded ${previous.version} to ${release.version} with the release's install script`);
  log(productVerifies(upgraded, release, rehearsal));
}
