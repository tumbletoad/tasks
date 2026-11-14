// Smoke run of a built and signed release for this host's platform (A2 3.12.8 "smoke", spike
// level), with the real archive and the official Node inside it:
//   1. install with the real install script into <work>/home (TASKS_HOME),
//   2. the runtime gate through the stable and the version-local launcher (lab row R01),
//   3. hostile argv and exit codes through every launcher (R09),
//   4. a tampered archive, a tampered SHA256SUMS, a foreign signature and a missing signature,
//      each of which must stop before anything from the archive is unpacked or runs (R09),
//   5. a reinstall over an existing folder of the same version that is not exactly the signed
//      release, which must stop without running it.
// On Windows, steps 4 and 5 compile the canary stand-in with MSVC, as the build does.
//
//   pnpm exec node spikes/m0/packaging/scripts/smoke.ts --work <empty temporary folder> [--dist <folder>]
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  assertArgvVerbatim,
  assertExitCode,
  assertInstalled,
  assertRefused,
  assertReinstallChecksExistingVersion,
  formatGate,
  prepareCanary,
  prepareTamperCases,
  resignWithOtherKey,
  runGateVia,
  runInstaller,
  stableLauncher,
  versionLauncher,
} from "../src/checks.ts";
import { defaultDist } from "../src/paths.ts";
import { distArchives, installerName } from "../src/release.ts";
import { hostPlatform } from "../src/version-folder.ts";

const { values } = parseArgs({
  options: {
    work: { type: "string" },
    dist: { type: "string", default: defaultDist },
  },
  strict: true,
});
if (values.work === undefined) throw new Error("pass --work <empty temporary folder>");
const work = values.work;
mkdirSync(work, { recursive: true });
if (readdirSync(work).length > 0) throw new Error(`${work} is not empty`);

const platform = hostPlatform();
const archive = distArchives(values.dist).find((a) => a.platform === platform);
if (platform === undefined || archive === undefined) {
  throw new Error(`no archive for this host in ${values.dist}`);
}
const { version } = archive;
const installer = join(values.dist, installerName(platform, version));
const step = (text: string) => {
  console.log(`\n== ${text}`);
};

step(`install ${archive.file} into a temporary TASKS_HOME`);
const root = join(work, "home");
const run = runInstaller(platform, installer, values.dist, undefined, { TASKS_HOME: root });
console.log(run.stdout.trim());
assertInstalled(root, version, platform, run);

let gateOk = true;
for (const [label, launcher] of [
  ["stable", stableLauncher(root, platform)],
  ["version-local", versionLauncher(root, version, platform)],
] as const) {
  step(`runtime gate through the ${label} launcher`);
  const gate = runGateVia(launcher, join(work, "gate-scratch"));
  console.log(formatGate(gate));
  gateOk &&= gate.ok;
}
if (!gateOk) throw new Error("the runtime gate failed in the packaged runtime");

step("hostile argv and exit codes through every launcher");
const launchers: [string, "stable" | "version" | "posix"][] =
  platform === "win-x64"
    ? [
        [stableLauncher(root, platform), "stable"],
        [stableLauncher(root, platform, true), "stable"],
        [versionLauncher(root, version, platform), "version"],
        [versionLauncher(root, version, platform, true), "version"],
      ]
    : [
        [stableLauncher(root, platform), "posix"],
        [versionLauncher(root, version, platform), "posix"],
      ];
for (const [launcher, mode] of launchers) {
  assertArgvVerbatim(launcher, mode);
  assertExitCode(launcher);
  console.log(`ok  ${launcher}`);
}

step("tampered downloads stop before anything from them runs");
const canary = prepareCanary(join(work, "canary-kit"), platform);
const cases = prepareTamperCases(
  values.dist,
  version,
  platform,
  join(work, "tamper"),
  resignWithOtherKey(join(work, "tamper", "other-key")),
  canary,
);
console.log("ok  every stand-in of the look-alike archive fires when run");
for (const c of cases) {
  const caseRoot = join(work, `refused-${c.name}`);
  const refused = runInstaller(
    platform,
    join(c.source, installerName(platform, version)),
    c.source,
    caseRoot,
  );
  assertRefused(caseRoot, version, refused, canary, c.reason);
  console.log(`ok  ${c.name}: ${refused.stderr.trim().split(/\r?\n/).pop() ?? ""}`);
}

step("a reinstall runs an existing version folder only if it is exactly the signed release");
assertReinstallChecksExistingVersion(platform, installer, values.dist, version, work, canary);
console.log("ok  intact folder kept; changed, consistent and rebuilt folders refused");

console.log(`\nsmoke passed for ${archive.file}`);
