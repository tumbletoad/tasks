// pnpm smoke --dist <folder> --work <new folder> (A2 3.12.8 "smoke", A7 3.18.4; M1.14): the
// install script on a build that `pnpm build --sign test` made, on this machine:
//   1. this system's test install script, pinned to the build's throwaway key
//      (SHA256SUMS.test-key.pub; the key itself is gone with the build), written into <work>,
//   2. an install into <work>/home through each verifier path of A2 3.12.4 (the first is the root
//      the acceptance then takes; the others go beside it), each checked: current, the stable
//      command, install.json and its install ID, `ttasks version` through the stable command,
//   3. the tampered downloads of the Verify line through each verifier path: a look-alike archive
//      whose runnable files are canary stand-ins, SHA256SUMS rewritten, signed again by another
//      key, edited, or its signature missing. Each must stop before anything from it runs, with
//      the canary folder empty and nothing left,
//   4. the command that runs the installed acceptance next: pnpm accept m1 --installed <work>/home.
// <work> must not exist: it is made user-only (on Windows: this user, SYSTEM and Administrators
// alone, so the roots in it are trusted, A2 3.2.2 rule 5) and left in place for the acceptance.
// It must lie below folders that no other account can rename (the install script refuses a root
// otherwise): a folder in the home or profile folder, not one in a shared temporary folder.
// Nothing outside <work> is written: no PATH, profile, start-up entry or registry value.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkInstalled,
  downloadCases,
  fired,
  HOME_VAR,
  installerIn,
  listing,
  prepareCanary,
  releaseOfDist,
  restrictToMe,
  runInstaller,
  unpackRelease,
  VERIFIERS,
  type Ran,
} from "./test/kit.ts";

const USAGE = "usage: pnpm smoke --dist <folder of a pnpm build --sign test> --work <new folder>";

function check(ok: boolean, what: string, ran?: Ran): void {
  if (!ok) {
    throw new Error(
      `${what}${ran === undefined ? "" : `\n  exit ${String(ran.status)}\n${ran.stdout}\n${ran.stderr}`}`,
    );
  }
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: { dist: { type: "string" }, work: { type: "string" } },
    strict: true,
  });
  if (values.dist === undefined || values.work === undefined) {
    console.error(USAGE);
    return 2;
  }
  const work = resolve(values.work);
  if (existsSync(work)) {
    console.error(`${work} exists: the smoke makes its work folder itself.`);
    return 2;
  }
  mkdirSync(work, { recursive: true, mode: 0o700 });
  restrictToMe(work);
  const release = releaseOfDist(resolve(values.dist), work);
  console.log(`smoke: ${release.archive}, test key ${release.publicKey.slice(0, 40)}…`);
  mkdirSync(join(work, "homes"));

  for (const [index, verifier] of VERIFIERS.entries()) {
    const root = index === 0 ? join(work, "home") : join(work, "homes", verifier);
    const ran = runInstaller(release, { env: { [HOME_VAR]: root }, verifier, within: work });
    checkInstalled(root, release, ran);
    console.log(`smoke: installed through ${verifier} into ${root}`);
  }

  const versionFolder = unpackRelease(release, join(work, "unpacked", release.version));
  const canary = prepareCanary(join(work, "canary-kit"));
  for (const verifier of VERIFIERS) {
    for (const c of downloadCases(release, versionFolder, join(work, "tamper"), canary, verifier)) {
      const root = join(work, "homes", `tamper-${verifier}-${c.name}`);
      const before = listing(join(work, "homes"));
      const ran = runInstaller(release, {
        root,
        source: c.source,
        installer: installerIn(release, c.source),
        verifier,
        within: work,
      });
      check(
        fired(canary).length === 0,
        `${verifier}, ${c.name}: a file from the download ran`,
        ran,
      );
      check(ran.status !== 0, `${verifier}, ${c.name}: the download was accepted`, ran);
      check(
        /Cannot verify this download/.test(ran.stderr) && c.reason.test(ran.stderr),
        `${verifier}, ${c.name}: refused for another reason`,
        ran,
      );
      check(
        JSON.stringify(listing(join(work, "homes"))) === JSON.stringify(before),
        `${verifier}, ${c.name}: something was left`,
      );
      console.log(`smoke: ${verifier}, ${c.name}: refused before anything ran`);
    }
  }
  console.log(`\nsmoke passed. Next: pnpm accept m1 --installed ${join(work, "home")}`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`smoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
