// The install scripts' test kit, shared by their tests (pnpm verify) and the smoke run
// (scripts/install/smoke.ts, the CI smoke job): a signed release made offline or taken from a test-signed
// dist/, the install scripts run the way a person runs them, the canary stand-ins that prove that
// nothing from a refused download ran, and the tampered downloads. Tooling and tests only.
//
// Safety (M1.14): every install goes into a root below a temporary folder of the caller's own
// (runInstaller refuses any other), the scripts have no default root, and nothing here writes the
// real install root, PATH, a shell profile, a start-up entry or the registry.
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { ENV_PREFIX, PRODUCT_ID } from "../../../packages/brand/src/index.ts";
import { isAgentMarker } from "../../../packages/bridge/src/protocol/index.ts";
import { findMsvc } from "../../../packages/launcher-win/src/build.ts";
import { buildWeb } from "../../../packages/web/build.ts";
import {
  listFolder,
  sha256File,
  writeVersionManifest,
} from "../../../packages/service/src/version/folder.ts";
import { readTarGz, readZip, writeTarGz, writeZip, type FileEntry } from "../../build/archive.ts";
import { bundle } from "../../build/bundle.ts";
import { LAUNCHD_WRAPPER, POSIX_LAUNCHER, windowsLaunchers } from "../../build/launchers.ts";
import { loadPin } from "../../build/node-runtime.ts";
import { archiveName, hostPlatform, type Platform } from "../../build/platforms.ts";
import {
  opensshPublicKey,
  parseOpensshPublicKey,
  RAW_SIGNATURE,
  signSums,
  SSH_SIGNATURE,
  SUMS_FILE,
  TEST_KEY_FILE,
  writeSums,
} from "../../build/signing.ts";
import { assembleVersionFolder, folderEntries } from "../../build/version-folder.ts";
import { repoRoot } from "../../run.ts";
import { installerName, renderTestInstaller, type InstallerKind } from "../render.ts";

export const windows = process.platform === "win32";
export const KIND: InstallerKind = windows ? "ps1" : "sh";
export const HOME_VAR = `${ENV_PREFIX}HOME`;

/** The verifier paths of A2 3.12.4 on this system: the OS's ssh-keygen, then the fallback. */
export const VERIFIERS: readonly string[] = windows
  ? ["ssh-keygen", "node"]
  : ["ssh-keygen", "openssl"];

export function hostPlatformOrThrow(): Platform {
  const platform = hostPlatform();
  if (platform === undefined) throw new Error("Tasks builds no version for this machine");
  return platform;
}

/** A signed release in a folder: the archive, SHA256SUMS, both signatures and the test installer. */
export interface Release {
  readonly dist: string;
  readonly version: string;
  readonly build: string;
  readonly platform: Platform;
  /** The archive's file name. */
  readonly archive: string;
  /** This system's test install script, in `dist`. */
  readonly installer: string;
  /** The public key the installer pins, an OpenSSH line. */
  readonly publicKey: string;
  /** The test key itself, when the release was made here (never for a dist the build signed). */
  readonly key: KeyObject | undefined;
}

/** A throwaway Ed25519 key, in memory only. */
export const throwawayKey = (): KeyObject => generateKeyPairSync("ed25519").privateKey;

/**
 * A version folder for this machine, built offline as the build's own offline test builds one:
 * the real bundles and launchers, and as its runtime the Node that runs this (pnpm's download of
 * the same official build, checked against pnpm-lock.yaml).
 */
export async function offlineVersionFolder(
  work: string,
  identity: { readonly version: string; readonly build: string },
  options: {
    /** The keys its updater trusts instead of the release keys (bundle.ts trustEdit). */
    readonly trustKeys?: readonly string[];
    /** A page build to use instead of building one (two versions can share it). */
    readonly web?: Awaited<ReturnType<typeof buildWeb>>;
  } = {},
): Promise<string> {
  const platform = hostPlatformOrThrow();
  const pin = loadPin();
  if (process.version !== `v${pin.version}`) throw new Error("run this on the pinned Node");
  const bundleOut = join(work, "bundle");
  const web = options.web ?? (await buildWeb(join(work, "ui"), repoRoot));
  const bundled = await bundle({
    root: repoRoot,
    out: bundleOut,
    identity,
    extraInputs: web.npmInputs,
    ...(options.trustKeys === undefined ? {} : { trustKeys: options.trustKeys }),
  });
  const license = join(work, "node-license.txt");
  writeFileSync(license, "Stand-in for Node's licence in an offline build.\n");
  const folder = join(work, "out", identity.version);
  assembleVersionFolder(folder, {
    platform,
    ...identity,
    node: { version: pin.version, sqlite: pin.sqlite, binary: process.execPath, license },
    launchers:
      platform === "win-x64"
        ? windowsLaunchers(join(work, "launchers"))
        : { posix: POSIX_LAUNCHER, launchd: LAUNCHD_WRAPPER },
    bundle: { out: bundleOut, files: bundled.files },
    ui: { out: web.out, files: web.files },
    thirdParty: bundled.thirdParty,
    repoRoot,
  });
  return folder;
}

/** The manifest's fields of a version folder, as JSON. */
function manifestOf(folder: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as Record<string, unknown>;
}

/**
 * A copy of a version folder at `out` with other manifest fields, its manifest written again so it
 * lists the folder exactly: another version, or a runtime pin its runtime does not meet.
 */
export function variantFolder(
  base: string,
  out: string,
  change: { readonly version?: string; readonly node?: string },
): string {
  cpSync(base, out, { recursive: true });
  const manifest = manifestOf(base);
  rmSync(join(out, "manifest.json"));
  writeVersionManifest(out, {
    version: change.version ?? String(manifest["version"]),
    build: String(manifest["build"]),
    platform: String(manifest["platform"]),
    node: change.node ?? String(manifest["node"]),
    sqlite: String(manifest["sqlite"]),
    protocol: manifest["protocol"] as { min: number; max: number },
  });
  return out;
}

/** The archive of a version folder, as its build writes it (stored, so tests stay quick). */
export function packFolder(folder: string, platform: Platform): Buffer {
  const entries = folderEntries(folder, platform);
  return platform === "win-x64"
    ? writeZip(entries, { level: 0 })
    : writeTarGz(entries, { level: 0 });
}

/** Writes this system's test installer for `version` pinned to `publicKey` into `dir`. */
export function writeTestInstaller(dir: string, version: string, publicKey: string): string {
  const file = join(dir, installerName(KIND, version, "test"));
  writeFileSync(file, renderTestInstaller(KIND, version, publicKey));
  return file;
}

/**
 * A release of `folder` in the new folder `dist`: the archive, SHA256SUMS, both signatures by
 * `key`, and the test installer pinned to it.
 */
export function releaseOf(folder: string, dist: string, key: KeyObject, work: string): Release {
  const manifest = manifestOf(folder);
  const platform = String(manifest["platform"]) as Platform;
  const version = String(manifest["version"]);
  mkdirSync(dist, { recursive: true });
  const archive = archiveName(version, platform);
  writeFileSync(join(dist, archive), packFolder(folder, platform));
  writeSums(dist, [archive]);
  signSums(dist, key, join(work, "signing-check"));
  const publicKey = opensshPublicKey(createPublicKey(key));
  return {
    dist,
    version,
    build: String(manifest["build"]),
    platform,
    archive,
    installer: writeTestInstaller(dist, version, publicKey),
    publicKey,
    key,
  };
}

/**
 * A release from a dist folder that `pnpm build --sign test` wrote (the smoke): its throwaway key's
 * public half is in SHA256SUMS.test-key.pub, and its private half is gone with the build. Its
 * install script is the one the build wrote beside the archives (else one is rendered into
 * `work`); `dist` stays as the build left it.
 */
export function releaseOfDist(dist: string, work: string): Release {
  const platform = hostPlatformOrThrow();
  const keyFile = join(dist, TEST_KEY_FILE);
  if (!existsSync(keyFile)) {
    throw new Error(`${dist} was not test-signed: the smoke installs only a test-signed build`);
  }
  const publicKey = opensshPublicKey(parseOpensshPublicKey(readFileSync(keyFile, "utf8")));
  const pattern = new RegExp(`^${PRODUCT_ID}-(.+)-${platform}\\.(?:tar\\.gz|zip)$`);
  const archives = readdirSync(dist).filter((name) => pattern.test(name));
  const archive = archives[0];
  if (archive === undefined || archives.length !== 1) {
    throw new Error(`${dist} holds no single ${platform} archive`);
  }
  const version = pattern.exec(archive)?.[1] ?? "";
  mkdirSync(work, { recursive: true });
  const manifest = (platform === "win-x64" ? readZip : readTarGz)(
    readFileSync(join(dist, archive)),
  ).find((entry) => entry.path === "manifest.json");
  const build = String(
    (JSON.parse(manifest?.data.toString() ?? "{}") as { build?: unknown }).build,
  );
  return {
    dist,
    version,
    build,
    platform,
    archive,
    installer:
      builtInstaller(dist, version, publicKey) ?? writeTestInstaller(work, version, publicKey),
    publicKey,
    key: undefined,
  };
}

/** The test install script `pnpm build --sign test` wrote beside its archives, if it pins `key`. */
function builtInstaller(dist: string, version: string, key: string): string | undefined {
  const file = join(dist, installerName(KIND, version, "test"));
  return existsSync(file) && readFileSync(file, "utf8").includes(key) ? file : undefined;
}

// ---------------------------------------------------------------------------------------------
// Folders for test installs

/** This user's SID (Windows), from whoami in System32. */
function mySid(): string {
  const whoami = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "whoami.exe");
  const ran = spawnSync(whoami, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const sid = /"(S-1-5-[0-9-]+)"/.exec(ran.stdout)?.[1];
  if (sid === undefined) throw new Error("cannot read this user's SID");
  return sid;
}

/**
 * Sets a folder of the caller's own to this user, SYSTEM and Administrators alone (Windows): no
 * inherited rule. An install root inside it then inherits a trusted ACL (A2 3.2.2 rule 5). The
 * OS temporary folder need not be one: on Windows, Codex's sandbox accounts may change it.
 */
export function restrictToMe(dir: string): void {
  if (!windows) return;
  const icacls = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
  const ran = spawnSync(
    icacls,
    [
      dir,
      "/inheritance:r",
      "/grant:r",
      `*${mySid()}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (ran.status !== 0) throw new Error(`icacls failed: ${ran.stdout}${ran.stderr}`);
}

/** Lets the Users group change a folder of the caller's own (Windows): an untrusted ACL. */
export function letUsersChange(dir: string): void {
  grantUsers(dir, "(OI)(CI)M");
}

/** Grants the Users group `rights` (icacls notation) on a file or folder of the caller's own. */
export function grantUsers(path: string, rights: string): void {
  const icacls = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
  const ran = spawnSync(icacls, [path, "/grant", `*S-1-5-32-545:${rights}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (ran.status !== 0) throw new Error(`icacls failed: ${ran.stdout}${ran.stderr}`);
}

/**
 * Where test installs go on Windows: `%USERPROFILE%\.tasks-test`, made when needed and removed
 * when its last test folder goes. The install script refuses a root below a folder that another
 * account may rename (A2 3.2.2 rule 5), and the OS temporary folder can be one: on Windows,
 * Codex's sandbox accounts may change `%TEMP%` and everything in `%LOCALAPPDATA%`. The profile
 * folder itself lets no other account rename what is in it. Linux uses the OS temporary folder,
 * which is sticky.
 */
export const testInstallsBase = (): string =>
  windows ? join(homedir(), `.${PRODUCT_ID}-test`) : tmpdir();

/**
 * A new temporary folder of this test's own for test installs, below testInstallsBase(): real
 * path, user-only (0700, or this user, SYSTEM and Administrators on Windows), removed by its full
 * name with `remove`.
 */
export function installsFolder(label: string): { root: string; remove: () => void } {
  const base = testInstallsBase();
  let made: string | undefined;
  for (let attempt = 1; made === undefined; attempt += 1) {
    mkdirSync(base, { recursive: true });
    try {
      made = mkdtempSync(join(base, `ki-${label}-`));
    } catch (error) {
      // Another test removed the empty base folder in between: make it again.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 5) throw error;
    }
  }
  const root = realpathSync.native(made);
  restrictToMe(root);
  return {
    root,
    remove: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      if (windows) {
        try {
          rmdirSync(base);
        } catch {
          // Another test's folder is still in it, or it is gone already.
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Running the install scripts

export interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Windows PowerShell 5.1, by its absolute path. */
export function powershell51(): string {
  return join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/** PowerShell 7: its usual folder, else pwsh.exe on PATH. */
export function pwsh7(): string {
  const exe = join(
    process.env["ProgramFiles"] ?? "C:\\Program Files",
    "PowerShell",
    "7",
    "pwsh.exe",
  );
  return existsSync(exe) ? exe : "pwsh.exe";
}

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return (
    rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !/^[A-Za-z]:/.test(rel)
  );
};

/**
 * The environment of an install script and of the programs it installed: this process's without
 * any Tasks variable or agent marker (a test run inside an agent app must not make every call an
 * agent's), then `extra` (an undefined value removes a name; names compare without case on
 * Windows).
 */
export function installEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const key = (name: string) => (windows ? name.toUpperCase() : name);
  const replaced = new Set(Object.keys(extra).map(key));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      name.toUpperCase().startsWith(ENV_PREFIX) ||
      isAgentMarker(name) ||
      replaced.has(key(name))
    ) {
      continue;
    }
    env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) if (value !== undefined) env[name] = value;
  return env;
}

export interface RunOptions {
  /** The root, passed as --root/-Root. */
  readonly root?: string;
  /** Extra environment, for example TASKS_HOME. */
  readonly env?: Record<string, string | undefined>;
  readonly verifier?: string;
  /** The folder of release files. Default: the release's dist. */
  readonly source?: string;
  /** Another install script, for example one copied into a tampered folder. */
  readonly installer?: string;
  /** Windows: the PowerShell that runs it. Default: Windows PowerShell 5.1. */
  readonly powershell?: "5.1" | "7";
  /**
   * Windows PowerShell 5.1 started from PowerShell 7 inherits PowerShell 7's module path (lab row
   * R09, A2 3.12.4): `inherit` keeps this process's PSModulePath for it. Default: none, so 5.1
   * uses its own, as in a new window.
   */
  readonly modulePath?: "inherit";
  /**
   * Every root must lie in this folder (a temporary folder of the caller's own): the run is
   * refused before it starts otherwise, so no test can install anywhere else.
   */
  readonly within: string;
}

/** The environment without PSModulePath, in whatever case it is spelled. */
function withoutModulePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"),
  );
}

/** Runs this system's install script the way a person runs it, and waits for it. */
export function runInstaller(release: Release, options: RunOptions): Ran {
  const root = options.root ?? options.env?.[HOME_VAR];
  // A relative root would be taken against the script's working folder, which is `within`.
  if (root !== undefined && !isInside(resolve(options.within, root), options.within)) {
    throw new Error(`refusing to install outside ${options.within}: ${root}`);
  }
  const installer = options.installer ?? release.installer;
  const source = options.source ?? release.dist;
  const env = installEnv(options.env);
  let result: SpawnSyncReturns<string>;
  if (windows) {
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installer,
      "-Source",
      source,
      ...(options.root === undefined ? [] : ["-Root", options.root]),
      ...(options.verifier === undefined ? [] : ["-Verifier", options.verifier]),
    ];
    result = spawnSync(options.powershell === "7" ? pwsh7() : powershell51(), args, {
      cwd: options.within,
      env:
        options.powershell === "7" || options.modulePath === "inherit"
          ? env
          : withoutModulePath(env),
      encoding: "utf8",
      windowsHide: true,
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } else {
    result = spawnSync(
      "/bin/sh",
      [
        installer,
        "--source",
        source,
        ...(options.root === undefined ? [] : ["--root", options.root]),
        ...(options.verifier === undefined ? [] : ["--verifier", options.verifier]),
      ],
      { cwd: options.within, env, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
    );
  }
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Holds an install root's install lock from another process, as a second install script does
 * while it runs: flock on the root folder (Linux), or `.install.lock` in it open without sharing
 * (Windows). Resolves once the lock is held; `release` lets it go and waits for the process.
 */
export async function holdInstallLock(root: string): Promise<{ release: () => Promise<void> }> {
  const child = windows
    ? spawn(
        pwsh7(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // Typed arguments: with strings PowerShell picks the overload whose last one is a bool.
          "$s = New-Object System.IO.FileStream($env:LOCK_PATH, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None, 1, [System.IO.FileOptions]::DeleteOnClose); [Console]::Out.WriteLine('held'); [void][Console]::In.ReadToEnd(); $s.Dispose()",
        ],
        { env: { ...process.env, LOCK_PATH: join(root, ".install.lock") }, windowsHide: true },
      )
    : spawn("flock", ["-n", root, "sh", "-c", "echo held; exec cat > /dev/null"]);
  const exited = new Promise<void>((done) => {
    child.once("exit", () => {
      done();
    });
  });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("held")) resolve();
    });
    child.once("exit", (code) => {
      reject(new Error(`the lock holder exited (${String(code)})`));
    });
  });
  return {
    release: async () => {
      child.stdin.end();
      await exited;
    },
  };
}

/** The stable command of an install root. */
export const stableCommand = (root: string): string =>
  join(root, "bin", windows ? `${PRODUCT_ID}.exe` : PRODUCT_ID);

/** Runs a program of an install with a clean environment (no Tasks variable). */
export function runProgram(
  file: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Ran {
  const result = spawnSync(file, args, {
    env: installEnv(env),
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** What an MCP exchange with `tasks mcp` gave: its exit code and the reply to each request. */
export interface McpRun {
  readonly code: number | null;
  readonly initialize: Record<string, unknown> | undefined;
  readonly tools: Record<string, unknown> | undefined;
  /** stdout lines that were not JSON-RPC 2.0 messages. */
  readonly stray: readonly string[];
  readonly stderr: string;
}

/**
 * Runs `file args` as an agent app runs its MCP server: initialize, initialized and tools/list on
 * stdin, each request answered before the next, then stdin closed. Fixture names only.
 */
export async function mcpExchange(
  file: string,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<McpRun> {
  const child = spawn(file, [...args], {
    env: installEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const replies = new Map<unknown, Record<string, unknown>>();
  const waiting = new Map<unknown, () => void>();
  const stray: string[] = [];
  let stderr = "";
  let pending = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      let message: Record<string, unknown> | undefined;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        message = undefined;
      }
      if (message?.["jsonrpc"] !== "2.0") {
        stray.push(line);
        continue;
      }
      if ("id" in message && !("method" in message)) {
        replies.set(message["id"], message);
        waiting.get(message["id"])?.();
      }
    }
  });
  child.stdin.on("error", () => undefined);
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const send = async (message: Record<string, unknown>) => {
      const replied =
        message["id"] === undefined
          ? Promise.resolve()
          : new Promise<void>((resolve) => waiting.set(message["id"], resolve));
      child.stdin.write(`${JSON.stringify(message)}\n`);
      await Promise.race([replied, exit]);
    };
    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fixture-client", version: "1.0.0" },
      },
    });
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    child.stdin.end();
    const code = await exit;
    return { code, initialize: replies.get(1), tools: replies.get(2), stray, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------------------------
// What a folder holds, to compare before and after

/** Every entry below `dir`, links not followed, with each file's SHA-256 and each link's target. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (rel: string): void => {
    for (const entry of readdirSync(rel === "" ? dir : join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const full = join(dir, path);
      if (entry.isSymbolicLink()) out[path] = `link ${readlinkSync(full)}`;
      else if (entry.isDirectory()) {
        out[`${path}/`] = "folder";
        walk(path);
      } else out[path] = sha256File(full);
    }
  };
  walk("");
  return out;
}

/** Every entry below `dir` by name, links not followed and nothing read: cheap to compare. */
export function listing(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (rel: string): void => {
    for (const entry of readdirSync(rel === "" ? dir : join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      out.push(entry.isDirectory() && !entry.isSymbolicLink() ? `${path}/` : path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path);
    }
  };
  walk("");
  return out.sort();
}

/** What a link points to, or undefined when `path` is no link. */
export function linkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// The canary kit: stand-ins that leave a file when they run, in any way

export interface Canary {
  /** Must stay empty: a stand-in that runs writes a file into it. */
  readonly dir: string;
  /** Windows: the compiled stand-in program. */
  readonly exe: string | undefined;
}

const CANARY_C = String.raw`#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
/* Run in any way, it writes a file named after itself into the canary folder and exits 0. */
int wmain(void) {
    static wchar_t self[32768];
    static wchar_t path[32768];
    const wchar_t *name;
    HANDLE h;
    DWORD length = GetModuleFileNameW(NULL, self, 32768);
    if (length == 0 || length >= 32768) return 0;
    name = wcsrchr(self, L'\\');
    name = name == NULL ? self : name + 1;
    if (_snwprintf_s(path, 32768, _TRUNCATE, L"%s\\%s-%lu", CANARY_DIR, name, GetCurrentProcessId()) < 0) return 0;
    h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    return 0;
}
`;

/** The canary folder in `work`, and on Windows the stand-in program, compiled with MSVC. */
export function prepareCanary(work: string): Canary {
  const dir = join(work, "canary");
  mkdirSync(dir, { recursive: true });
  if (!windows) return { dir, exe: undefined };
  const build = join(work, "canary-build");
  mkdirSync(build, { recursive: true });
  const literal = dir.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const source = join(build, "canary.c");
  writeFileSync(source, `#define CANARY_DIR L"${literal}"\n${CANARY_C}`);
  const msvc = findMsvc();
  const exe = join(build, "canary.exe");
  const ran = spawnSync(
    msvc.cl,
    [
      "/nologo",
      "/W4",
      "/MT",
      "/utf-8",
      "/DUNICODE",
      "/D_UNICODE",
      `/Fo${build}\\`,
      `/Fe${exe}`,
      source,
    ],
    { cwd: build, env: msvc.env, encoding: "utf8", windowsHide: true },
  );
  if (ran.status !== 0) throw new Error(`cl.exe failed for the canary:\n${ran.stdout}`);
  return { dir, exe };
}

/** What fired: the canary folder's files. Empty means nothing ran. */
export const fired = (canary: Canary): string[] => readdirSync(canary.dir);

/** Empties the canary folder (after a positive control). */
export function resetCanary(canary: Canary): void {
  for (const name of readdirSync(canary.dir)) rmSync(join(canary.dir, name));
}

/** Files of a version folder that can run: the launchers, the runtime and the lib/ modules. */
export const isRunnable = (path: string): boolean =>
  path.startsWith("bin/") ||
  path.startsWith("runtime/") ||
  (path.startsWith("lib/") && path.endsWith(".mjs"));

const shQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** The stand-in for one runnable file. It writes `<canary>/<its name>` when it runs. */
export function standIn(path: string, canary: Canary): Buffer {
  const target = join(canary.dir, path.replaceAll("/", "-"));
  if (path.endsWith(".mjs")) {
    return Buffer.from(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(target)}, "ran");\n`,
    );
  }
  if (windows) {
    if (canary.exe === undefined) throw new Error("the Windows canary needs its program");
    return readFileSync(canary.exe);
  }
  return Buffer.from(`#!/bin/sh\nprintf '%s\\n' "$0 $*" > ${shQuote(target)}\nexit 0\n`);
}

/** Windows' runtime, which the node verifier runs once Authenticode has vouched for it. */
export const NODE_EXE = "runtime/node.exe";

/**
 * A look-alike of a version folder at `out`: every runnable file swapped for its stand-in, but
 * those `keep` names. With `consistent`, its manifest.json is written again to match, so only the
 * signature or the hash can tell it from the real one; without, the real manifest stays (a file
 * changed after hashing).
 */
export function lookAlikeFolder(
  base: string,
  out: string,
  canary: Canary,
  consistent: boolean,
  keep: readonly string[] = [],
): string {
  cpSync(base, out, { recursive: true });
  for (const file of listFolder(out).files) {
    if (isRunnable(file) && !keep.includes(file)) {
      writeFileSync(join(out, ...file.split("/")), standIn(file, canary));
    }
  }
  if (consistent) {
    const manifest = manifestOf(base);
    rmSync(join(out, "manifest.json"));
    writeVersionManifest(out, {
      version: String(manifest["version"]),
      build: String(manifest["build"]),
      platform: String(manifest["platform"]),
      node: String(manifest["node"]),
      sqlite: String(manifest["sqlite"]),
      protocol: manifest["protocol"] as { min: number; max: number },
    });
  }
  return out;
}

/**
 * Positive control: runs every runnable file of a look-alike folder once, directly, and requires
 * each to leave its canary. Without it a broken stand-in would let a refusal pass for the wrong
 * reason. Empties the canary folder afterwards.
 */
export function proveStandInsFire(
  folder: string,
  canary: Canary,
  keep: readonly string[] = [],
): void {
  const runnable = listFolder(folder).files.filter(
    (file) => isRunnable(file) && !keep.includes(file),
  );
  for (const file of runnable) {
    const full = join(folder, ...file.split("/"));
    const ran = file.endsWith(".mjs")
      ? spawnSync(process.execPath, [full], { windowsHide: true })
      : spawnSync(windows ? full : "/bin/sh", windows ? ["--package-info"] : [full, "x"], {
          windowsHide: true,
        });
    if (ran.error !== undefined) throw ran.error;
  }
  const left = fired(canary);
  if (left.length !== runnable.length) {
    throw new Error(
      `every stand-in must leave a canary: ${runnable.join(", ")} left ${left.join(", ")}`,
    );
  }
  resetCanary(canary);
}

// ---------------------------------------------------------------------------------------------
// Archives no build writes: a name that leaves the folder, a link

export interface CraftedEntry {
  readonly path: string;
  readonly data?: Buffer;
  /** A symbolic link to this target. */
  readonly link?: string;
}

function tarHeader(name: string, type: "0" | "2" | "5", size: number, link = ""): Buffer {
  const h = Buffer.alloc(512);
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
  h.write(name, 0, 100, "utf8");
  h.write(octal(type === "5" ? 0o755 : 0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(1_767_225_600, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write(link, 157, 100, "utf8");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

/** A tar.gz with exactly these entries, in this order, unchecked. */
export function craftTarGz(entries: readonly CraftedEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    if (e.link !== undefined) {
      chunks.push(tarHeader(e.path, "2", 0, e.link));
      continue;
    }
    const data = e.data ?? Buffer.alloc(0);
    chunks.push(tarHeader(e.path, "0", data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 1 });
}

/**
 * A zip of `entries` (the build's writer, so a valid one) in which the entry named `rename.from`
 * gets the name `rename.to` (same length) and, with `link`, a POSIX symbolic link's mode in its
 * external attributes.
 */
export function craftZip(
  entries: readonly FileEntry[],
  rename?: { readonly from: string; readonly to: string },
  link?: string,
): Buffer {
  const zip = writeZip(entries, { level: 0 });
  if (rename !== undefined) {
    if (rename.from.length !== rename.to.length) throw new Error("a rename keeps the length");
    const from = Buffer.from(rename.from);
    const to = Buffer.from(rename.to);
    for (let at = zip.indexOf(from); at !== -1; at = zip.indexOf(from, at + 1)) to.copy(zip, at);
  }
  if (link !== undefined) {
    // Central directory headers (PK\1\2): version made by at 4 (high byte 3 = Unix), external
    // attributes at 38, the name at 46.
    for (let at = zip.indexOf("PK\x01\x02"); at !== -1; at = zip.indexOf("PK\x01\x02", at + 4)) {
      const nameLength = zip.readUInt16LE(at + 28);
      const name = zip.subarray(at + 46, at + 46 + nameLength).toString();
      if (name === link) {
        zip.writeUInt8(3, at + 5);
        zip.writeUInt32LE((0o120777 << 16) >>> 0, at + 38);
      }
    }
  }
  return zip;
}

/** The folder's entries as archive entries, plus `extra`. */
export function entriesOf(
  folder: string,
  platform: Platform,
  extra: readonly FileEntry[] = [],
): FileEntry[] {
  return [...folderEntries(folder, platform), ...extra];
}

// ---------------------------------------------------------------------------------------------
// Downloads that must be refused before anything from them runs

export interface TamperCase {
  readonly name: string;
  /** A folder of release files with the installer copied in. */
  readonly source: string;
  /** What the refusal must say. */
  readonly reason: RegExp;
}

/** Copies the release's files into a new folder `dir`, leaving out `omit`. */
function copyRelease(release: Release, dir: string, omit: readonly string[] = []): string {
  mkdirSync(dir, { recursive: true });
  for (const name of [release.archive, SUMS_FILE, RAW_SIGNATURE, SSH_SIGNATURE]) {
    if (!omit.includes(name)) copyFileSync(join(release.dist, name), join(dir, name));
  }
  copyFileSync(release.installer, join(dir, installerName(KIND, release.version, "test")));
  return dir;
}

/**
 * The downloads of the Verify line that the signature or the hash must stop, for one verifier,
 * built from a look-alike archive whose every runnable file is a canary stand-in (with a
 * consistent manifest), after proving that the stand-ins fire:
 *   archive   the look-alike under the real name, SHA256SUMS and its signatures as they were
 *   sums      the look-alike, and SHA256SUMS rewritten to its digest under the old signatures
 *   resigned  the look-alike, SHA256SUMS rewritten and signed again by another key
 *   edited    the real archive, and SHA256SUMS with one line more under the old signatures
 *   unsigned  the real archive, without the signature this verifier reads
 * Windows' node verifier first requires Authenticode's word that the archive's node.exe is the
 * OpenJS Foundation's: a look-alike's stand-in fails that before it can run, and `edited` keeps
 * the real node.exe, so its own signature check is what refuses there. For that verifier,
 * `archive-node`, `sums-node` and `resigned-node` repeat the first three with the genuine
 * node.exe in the look-alike, so the signature check and the hash are what refuse them. None of
 * the cases needs the release's key, so the smoke runs them on a build that CI signed.
 */
export function downloadCases(
  release: Release,
  versionFolder: string,
  work: string,
  canary: Canary,
  verifier: string,
): TamperCase[] {
  const look = lookAlikeFolder(
    versionFolder,
    join(work, "look-alike", release.version),
    canary,
    true,
  );
  proveStandInsFire(look, canary);
  const evil = packFolder(look, release.platform);
  const sumsOf = (data: Buffer) =>
    `${createHash("sha256").update(data).digest("hex")}  ${release.archive}\n`;
  const at = (name: string) => join(work, `${verifier}-${name}`);

  const archive = copyRelease(release, at("archive"));
  writeFileSync(join(archive, release.archive), evil);

  const sums = copyRelease(release, at("sums"));
  writeFileSync(join(sums, release.archive), evil);
  writeFileSync(join(sums, SUMS_FILE), sumsOf(evil));

  const resigned = copyRelease(release, at("resigned"));
  writeFileSync(join(resigned, release.archive), evil);
  writeFileSync(join(resigned, SUMS_FILE), sumsOf(evil));
  signSums(resigned, throwawayKey(), join(work, "signing-check"));

  const edited = copyRelease(release, at("edited"));
  writeFileSync(
    join(edited, SUMS_FILE),
    `${readFileSync(join(release.dist, SUMS_FILE), "utf8")}${"0".repeat(64)}  ${PRODUCT_ID}-extra.zip\n`,
  );

  const signature = verifier === "ssh-keygen" ? SSH_SIGNATURE : RAW_SIGNATURE;
  const unsigned = copyRelease(release, at("unsigned"), [signature]);
  const notNode = /runtime\\node\.exe is not the OpenJS Foundation's signed binary/;
  const node = verifier === "node";

  // The node verifier: the look-alikes above stop at Authenticode, before node.exe runs. These keep
  // the genuine runtime\node.exe, so its signature check of SHA256SUMS and the hash are what stop
  // them, with every other runnable file still a stand-in.
  const genuine: TamperCase[] = [];
  if (node) {
    const real = lookAlikeFolder(
      versionFolder,
      join(work, "look-alike-node", release.version),
      canary,
      true,
      [NODE_EXE],
    );
    proveStandInsFire(real, canary, [NODE_EXE]);
    const evilNode = packFolder(real, release.platform);
    const archiveNode = copyRelease(release, at("archive-node"));
    writeFileSync(join(archiveNode, release.archive), evilNode);
    const sumsNode = copyRelease(release, at("sums-node"));
    writeFileSync(join(sumsNode, release.archive), evilNode);
    writeFileSync(join(sumsNode, SUMS_FILE), sumsOf(evilNode));
    const resignedNode = copyRelease(release, at("resigned-node"));
    writeFileSync(join(resignedNode, release.archive), evilNode);
    writeFileSync(join(resignedNode, SUMS_FILE), sumsOf(evilNode));
    signSums(resignedNode, throwawayKey(), join(work, "signing-check"));
    genuine.push(
      { name: "archive-node", source: archiveNode, reason: /does not match SHA256SUMS/ },
      {
        name: "sums-node",
        source: sumsNode,
        reason: /signature of SHA256SUMS does not verify \(node\)/,
      },
      {
        name: "resigned-node",
        source: resignedNode,
        reason: /signature of SHA256SUMS does not verify \(node\)/,
      },
    );
  }
  return [
    ...genuine,
    { name: "archive", source: archive, reason: node ? notNode : /does not match SHA256SUMS/ },
    {
      name: "sums",
      source: sums,
      reason: node ? notNode : /signature of SHA256SUMS does not verify/,
    },
    {
      name: "resigned",
      source: resigned,
      reason: node ? notNode : /signature of SHA256SUMS does not verify/,
    },
    { name: "edited", source: edited, reason: /signature of SHA256SUMS does not verify/ },
    {
      name: "unsigned",
      source: unsigned,
      reason: new RegExp(`${signature.replaceAll(".", "\\.")} is missing`),
    },
  ];
}

/**
 * A folder of release files around `archive` (bytes, under the release's archive name):
 * SHA256SUMS listing it, signed in both formats by `key`, and the release's test installer. For
 * archives that pass the signature and the hash and must be refused after: only a release made
 * here has its key.
 */
export function signedSource(release: Release, dir: string, archive: Buffer, work: string): string {
  if (release.key === undefined) throw new Error("only a release made here has its key");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, release.archive), archive);
  writeSums(dir, [release.archive]);
  signSums(dir, release.key, join(work, "signing-check"));
  copyFileSync(release.installer, join(dir, installerName(KIND, release.version, "test")));
  return dir;
}

/** The test installer inside a folder made by downloadCases or signedSource. */
export const installerIn = (release: Release, dir: string): string =>
  join(dir, installerName(KIND, release.version, "test"));

/** The version folder inside a release's archive, unpacked by the build's reader into `out`. */
export function unpackRelease(release: Release, out: string): string {
  const data = readFileSync(join(release.dist, release.archive));
  for (const entry of (release.platform === "win-x64" ? readZip : readTarGz)(data)) {
    if (entry.type !== "file") continue;
    const file = join(out, ...entry.path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entry.data, { mode: entry.mode });
  }
  return out;
}

/** Whether a path exists, links included. */
export const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
