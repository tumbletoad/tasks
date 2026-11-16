// `pnpm build` (A7 3.3, A2 3.12.8 "build"): one platform's version folder and archive in dist/,
// with SHA256SUMS. Steps, each of which stops the build when it fails:
//   1. the official Node for the platform, downloaded and verified (node-runtime.ts),
//   2. the page (packages/web's buildWeb), the bundles (bundle.ts) and the launchers
//      (launchers.ts),
//   3. the version folder with manifest.json (version-folder.ts), checked against its manifest,
//   4. no path of the build machine in any file the build made,
//   5. the archive, read back and compared with the folder, and SHA256SUMS,
//   6. on request, SHA256SUMS signed with a throwaway test key (signing.ts), with the test build's
//      install scripts pinned to it (scripts/install/render.ts, M1.14),
//   7. when the platform is this machine's, the runtime gate inside the folder (gate.ts),
//   8. on request, everything from step 2 again in another work folder, and the two version
//      folders and archives compared byte for byte (A7 3.8 M1.13: reproducible builds).
// The release signature is never made here: scripts/release/ makes it, from release.yml or by hand.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { isAppVersion } from "../../packages/storage/src/manifest.ts";
import {
  checkVersionFolder,
  isVersionName,
  listFolder,
  type VersionManifest,
} from "../../packages/service/src/version/folder.ts";
import { buildWeb } from "../../packages/web/build.ts";
import {
  INSTALLER_KINDS,
  installerName,
  renderTestInstaller,
  type InstallerKind,
} from "../install/render.ts";
import { readTarGz, readZip, writeTarGz, writeZip } from "./archive.ts";
import { bundle, type BuildIdentity } from "./bundle.ts";
import { runBuiltGate, type GateRun } from "./gate.ts";
import {
  assertReleaseBinary,
  LAUNCHD_WRAPPER,
  POSIX_LAUNCHER,
  windowsLaunchers,
} from "./launchers.ts";
import { fetchNodeRuntime, sha256, type FetchedRuntime } from "./node-runtime.ts";
import { ARCHIVE_NAME, archiveName, hostPlatform, type Platform } from "./platforms.ts";
import {
  distArchives,
  RAW_SIGNATURE,
  SSH_SIGNATURE,
  TEST_KEY_FILE,
  testSignSums,
  writeSums,
  type Signed,
} from "./signing.ts";
import {
  assembleVersionFolder,
  buildMachinePaths,
  folderEntries,
  machinePathNeedles,
  scanForMachinePaths,
} from "./version-folder.ts";

/** The service log's patterns for a version and a build label (packages/service/src/hub/log.ts). */
const LOG_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const LOG_BUILD = /^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/;

/**
 * Problems with a version and build label. A version names the version folder and `current`
 * (A2 3.12.3), is the app version spaces record (A1, SemVer without build metadata) and appears in
 * the service log; a build label appears in the log and the handshake. "source" is what a run from
 * source calls itself.
 */
export function identityProblems(id: BuildIdentity): string[] {
  const problems: string[] = [];
  if (!isAppVersion(id.version) || !isVersionName(id.version) || !LOG_VERSION.test(id.version)) {
    problems.push(
      `version ${JSON.stringify(id.version)} is not a release version (major.minor.patch, an optional -pre.release, up to 40 characters after the dash)`,
    );
  }
  if (!LOG_BUILD.test(id.build) || id.build === "source") {
    problems.push(
      `build ${JSON.stringify(id.build)} is not a build label ([0-9A-Za-z.-], up to 40, not "source")`,
    );
  }
  return problems;
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * The identity of a build of this checkout, from its inputs only, so the same commit always gets
 * the same one. What `given` holds is taken as it is (a release passes its own version); the rest
 * defaults: the version to `<package.json version>-dev.<commits on HEAD>`, the build label to the
 * commit's first 12 hex digits, with `-dirty` when the work tree differs from it. Only the default
 * version needs the commit's whole history, so only it is refused in a shallow clone.
 */
export function resolveIdentity(
  root: string,
  given: { readonly version?: string | undefined; readonly build?: string | undefined } = {},
): BuildIdentity {
  const version = given.version ?? defaultVersion(root);
  if (given.build !== undefined) return { version, build: given.build };
  const sha = git(root, ["rev-parse", "HEAD"]).slice(0, 12);
  const dirty = git(root, ["status", "--porcelain"]) !== "";
  return { version, build: `${sha}${dirty ? "-dirty" : ""}` };
}

function defaultVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  if (pkg.version === undefined) throw new Error("package.json has no version");
  // A shallow clone counts only the commits it holds: the same commit would get a smaller version.
  if (git(root, ["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new Error(
      "this is a shallow clone, whose commit count is not the version's: fetch the whole history (git fetch --unshallow) or pass --version",
    );
  }
  return `${pkg.version}-dev.${git(root, ["rev-list", "--count", "HEAD"])}`;
}

export interface BuildOptions {
  readonly root: string;
  readonly platform: Platform;
  readonly identity: BuildIdentity;
  readonly dist: string;
  readonly work: string;
  /** Sign SHA256SUMS with a throwaway test key (CI and tests). */
  readonly testSign?: boolean;
  /** Run the runtime gate when the platform is this machine's. Default true. */
  readonly gate?: boolean;
  /** Build a second time elsewhere and compare (A7 3.8 M1.13). */
  readonly checkReproducible?: boolean;
  /** zlib level of the archive: 9 for a release, 0 keeps tests quick. */
  readonly level?: number;
  readonly log?: (line: string) => void;
}

export interface BuildResult {
  readonly versionFolder: string;
  readonly archive: string;
  readonly archiveSha256: string;
  readonly manifest: VersionManifest;
  readonly runtime: FetchedRuntime;
  readonly signed?: Signed;
  readonly gate?: GateRun;
  readonly reproducible?: boolean;
}

/** Steps 2 to 4: the version folder at `out` from the verified runtime, built in `work`. */
async function makeVersionFolder(
  options: BuildOptions,
  runtime: FetchedRuntime,
  work: string,
  out: string,
): Promise<VersionManifest> {
  const { root, platform, identity } = options;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const web = await buildWeb(join(work, "ui"), root);
  const bundled = await bundle({
    root,
    out: join(work, "bundle"),
    identity,
    extraInputs: web.npmInputs,
  });
  const launchers =
    platform === "win-x64"
      ? windowsLaunchers(join(work, "launchers"))
      : { posix: POSIX_LAUNCHER, launchd: LAUNCHD_WRAPPER };
  const manifest = assembleVersionFolder(out, {
    platform,
    version: identity.version,
    build: identity.build,
    node: runtime,
    launchers,
    bundle: { out: join(work, "bundle"), files: bundled.files },
    ui: { out: web.out, files: web.files },
    thirdParty: bundled.thirdParty,
    repoRoot: root,
  });
  const problems = checkVersionFolder(out);
  if (problems.length > 0)
    throw new Error(`the version folder fails its manifest: ${problems.join("; ")}`);
  // The binaries the build ships carry no test hook (A2 3.12.8).
  if (platform === "win-x64") {
    for (const exe of [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`, `${PRODUCT_ID}-run.exe`]) {
      assertReleaseBinary(join(out, "bin", exe));
    }
  }
  const leaks = scanForMachinePaths(out, machinePathNeedles(buildMachinePaths(root, work)));
  if (leaks.length > 0) {
    throw new Error(`a path of this machine is in the version folder: ${leaks.join(", ")}`);
  }
  return manifest;
}

/** Step 5's archive of a version folder, as bytes. */
function packFolder(dir: string, platform: Platform, level: number): Buffer {
  const entries = folderEntries(dir, platform);
  return platform === "win-x64" ? writeZip(entries, { level }) : writeTarGz(entries, { level });
}

/**
 * The archives in dist/ (`names`) that a build of `version` for `platform` removes before it writes
 * its own: this platform's of any version, which it makes again, and every other version's, which
 * its SHA256SUMS would not list. Archives of this version for other platforms stay: a cross-build
 * of one commit lists them all.
 */
export function staleArchives(
  names: readonly string[],
  version: string,
  platform: Platform,
): string[] {
  return names.filter((name) => {
    const match = ARCHIVE_NAME.exec(name);
    return match !== null && (match[2] === platform || match[1] !== version);
  });
}

/** The install scripts in dist/ (install-<v>.sh, install-<v>-test.ps1 …), release or test. */
export function installScripts(dist: string): string[] {
  return readdirSync(dist).filter((name) => /^install-[0-9A-Za-z.+-]+\.(?:sh|ps1)$/.test(name));
}

/** The kinds of install script the archives need: sh for Linux and macOS, ps1 for Windows. */
export function installerKinds(archives: readonly string[]): InstallerKind[] {
  const platforms = archives.map((name) => ARCHIVE_NAME.exec(name)?.[2]);
  return INSTALLER_KINDS.filter((kind) =>
    platforms.some((p) => p !== undefined && (kind === "ps1") === (p === "win-x64")),
  );
}

/** Every file of two folders, compared byte for byte. Returns one message per difference. */
export function compareFolders(a: string, b: string): string[] {
  const left = listFolder(a);
  const right = listFolder(b);
  const problems = [...left.problems, ...right.problems];
  const names = new Set([...left.files, ...right.files]);
  for (const name of [...names].sort()) {
    const inLeft = left.files.includes(name);
    const inRight = right.files.includes(name);
    if (!inLeft || !inRight) problems.push(`only in one build: ${name}`);
    else if (
      !readFileSync(join(a, ...name.split("/"))).equals(readFileSync(join(b, ...name.split("/"))))
    ) {
      problems.push(`differs: ${name}`);
    }
  }
  return problems;
}

export async function buildVersion(options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? (() => undefined);
  const { platform, identity, dist, work } = options;
  const problems = identityProblems(identity);
  if (problems.length > 0) throw new Error(problems.join("; "));
  if (platform === "win-x64" && process.platform !== "win32") {
    throw new Error("win-x64 builds on Windows only: its launchers are compiled with MSVC");
  }
  mkdirSync(work, { recursive: true });
  mkdirSync(dist, { recursive: true });
  log(`build ${identity.version} (${identity.build}) for ${platform}`);

  const runtime = await fetchNodeRuntime({ platform, cacheDir: join(work, "cache"), log });

  // dist/<platform>/ holds this build's version folder only, and dist/ archives of this build's
  // version only: an earlier build's folder or archive is removed, never left unlisted beside
  // SHA256SUMS, listed or shipped.
  rmSync(join(dist, platform), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  for (const name of staleArchives(distArchives(dist), identity.version, platform)) {
    rmSync(join(dist, name), { force: true });
  }
  const versionFolder = join(dist, platform, identity.version);
  const manifest = await makeVersionFolder(options, runtime, join(work, "first"), versionFolder);
  log(`version folder: ${versionFolder} (${String(Object.keys(manifest.files).length + 1)} files)`);

  const level = options.level ?? 9;
  const data = packFolder(versionFolder, platform, level);
  const back = platform === "win-x64" ? readZip(data) : readTarGz(data);
  for (const entry of folderEntries(versionFolder, platform)) {
    const found = back.find((b) => b.path === entry.path && b.type === "file");
    if (found === undefined || !found.data.equals(entry.data)) {
      throw new Error(`the archive does not hold ${entry.path} as the folder does`);
    }
    if (platform !== "win-x64" && found.mode !== entry.mode) {
      throw new Error(`the archive holds ${entry.path} with mode ${found.mode.toString(8)}`);
    }
  }
  if (
    back.filter((b) => b.type === "file").length !== folderEntries(versionFolder, platform).length
  ) {
    throw new Error("the archive holds files the folder does not");
  }
  const archive = join(dist, archiveName(identity.version, platform));
  const partial = `${archive}.part`;
  writeFileSync(partial, data);
  renameSync(partial, archive);
  const archiveSha256 = sha256(data);
  log(`archive: ${archive} (${String(data.length)} bytes, sha256 ${archiveSha256})`);

  // A new SHA256SUMS: signatures of the old one would no longer match it, nor install scripts that
  // pinned the key that made them.
  for (const stale of [RAW_SIGNATURE, SSH_SIGNATURE, TEST_KEY_FILE, ...installScripts(dist)]) {
    rmSync(join(dist, stale), { force: true });
  }
  const listed = distArchives(dist, identity.version);
  writeSums(dist, listed);
  log(`SHA256SUMS: ${join(dist, "SHA256SUMS")}`);

  let signed: Signed | undefined;
  if (options.testSign === true) {
    signed = testSignSums(dist, join(work, "signing"));
    log(
      `SHA256SUMS signed with a throwaway test key, ${signed.fingerprint}: SHA256SUMS.sig, SHA256SUMS.sshsig`,
    );
    // M1.14: the install scripts of a test build, pinned to its throwaway key, one per kind of
    // archive in dist/, so the folder installs as it is (test installs on real machines).
    for (const kind of installerKinds(listed)) {
      const name = installerName(kind, identity.version, "test");
      writeFileSync(
        join(dist, name),
        renderTestInstaller(kind, identity.version, signed.publicKey),
      );
      log(`test install script: ${join(dist, name)}`);
    }
  }

  let gate: GateRun | undefined;
  if (options.gate !== false) {
    if (hostPlatform() === platform) {
      gate = runBuiltGate(versionFolder, work, identity);
      for (const row of gate.rows) log(`gate: ${row.status} ${row.id}: ${row.detail}`);
      if (!gate.ok)
        throw new Error(
          `the runtime gate failed in ${versionFolder}:\n  ${gate.problems.join("\n  ")}`,
        );
      log("gate: passed");
    } else {
      log(`gate: not run, ${platform} is not this machine's platform`);
    }
  }

  let reproducible: boolean | undefined;
  if (options.checkReproducible === true) {
    const again = join(work, "second-output", identity.version);
    rmSync(join(work, "second-output"), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    await makeVersionFolder(options, runtime, join(work, "second"), again);
    const differences = compareFolders(versionFolder, again);
    if (!packFolder(again, platform, level).equals(data))
      differences.push(`differs: ${archiveName(identity.version, platform)}`);
    if (differences.length > 0) {
      throw new Error(`the build is not reproducible:\n  ${differences.join("\n  ")}`);
    }
    rmSync(join(work, "second-output"), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    reproducible = true;
    log("reproducible: a second build in another work folder is byte for byte the same");
  }

  return {
    versionFolder,
    archive,
    archiveSha256,
    manifest,
    runtime,
    ...(signed === undefined ? {} : { signed }),
    ...(gate === undefined ? {} : { gate }),
    ...(reproducible === undefined ? {} : { reproducible }),
  };
}
