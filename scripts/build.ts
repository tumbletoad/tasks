// pnpm build [--platform <p>] [--version <v>] [--build <label>] [--dist <folder>] [--work <folder>]
//            [--sign test] [--check-reproducible] [--no-gate] [--level 0-9]
//
// The version folder and archive of one platform in dist/ (A7 3.3, A2 3.12.8): dist/<platform>/
// <version>/, dist/tasks-<version>-<platform>.tar.gz or .zip, and dist/SHA256SUMS. scripts/build/
// build.ts lists the steps. The platform defaults to this machine's; win-x64 builds on Windows only.
// The version defaults to `<package.json version>-dev.<commits>`, the build label to the commit.
// `--sign test` signs SHA256SUMS with a throwaway key made for this run (CI); a release is signed
// by the release workflow or by the owner (scripts/release/). This needs the network: pnpm
// verify never runs it. Its fast parts are tested there (scripts/build/*.test.ts).
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildVersion, resolveIdentity } from "./build/build.ts";
import { hostPlatform, isPlatform, PLATFORMS } from "./build/platforms.ts";
import { repoRoot } from "./run.ts";

const USAGE =
  "usage: pnpm build [--platform <p>] [--version <v>] [--build <label>] [--dist <folder>] " +
  "[--work <folder>] [--sign test] [--check-reproducible] [--no-gate] [--level 0-9]";

async function main(argv: readonly string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        platform: { type: "string" },
        version: { type: "string" },
        build: { type: "string" },
        dist: { type: "string" },
        work: { type: "string" },
        sign: { type: "string" },
        "check-reproducible": { type: "boolean", default: false },
        "no-gate": { type: "boolean", default: false },
        level: { type: "string", default: "9" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const platform = values.platform ?? hostPlatform();
  if (platform === undefined || !isPlatform(platform)) {
    console.error(`pass --platform, one of ${PLATFORMS.join(", ")}\n${USAGE}`);
    return 2;
  }
  if (values.sign !== undefined && values.sign !== "test") {
    console.error(
      "--sign takes only `test`. A release is signed by the release workflow, or by the owner with pnpm release sign.",
    );
    return 2;
  }
  const level = Number(values.level);
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    console.error(`--level is 0 to 9\n${USAGE}`);
    return 2;
  }
  const dist = resolve(values.dist ?? join(repoRoot, "dist"));
  const result = await buildVersion({
    root: repoRoot,
    platform,
    identity: resolveIdentity(repoRoot, { version: values.version, build: values.build }),
    dist,
    work: resolve(values.work ?? join(dist, ".work")),
    testSign: values.sign === "test",
    gate: !values["no-gate"],
    checkReproducible: values["check-reproducible"],
    level,
    log: (line) => {
      console.log(line);
    },
  });
  console.log(`\nbuilt ${result.manifest.version} (${result.manifest.build}) for ${platform}`);
  console.log(`  version folder  ${result.versionFolder}`);
  console.log(`  archive         ${result.archive}`);
  console.log(`  sha256          ${result.archiveSha256}`);
  console.log(
    `  runtime         Node ${result.runtime.version}, SQLite ${result.runtime.sqlite}, signed by ${result.runtime.signer}`,
  );
  console.log(
    `  test-signed     ${result.signed === undefined ? "no" : result.signed.fingerprint}`,
  );
  console.log(
    `  runtime gate    ${result.gate === undefined ? "not run" : result.gate.ok ? "passed" : "FAILED"}`,
  );
  console.log(`  reproducible    ${result.reproducible === undefined ? "not checked" : "yes"}`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`build FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
