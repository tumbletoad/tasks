// Checks shared by the offline tests and the CI smoke run (scripts/smoke.ts): install with the
// real install script, the tamper cases, the runtime gate through a launcher and hostile argv.
// Each check throws an AssertionError with a clear message when it fails.
import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type FileEntry, readTarGz, readZip } from "./archive.ts";
import { compileExe } from "./msvc.ts";
import { canarySource } from "./paths.ts";
import { deleteKey, generateThrowawayKey, installerName, signFile } from "./release.ts";
import {
  archiveName,
  folderEntries,
  listFiles,
  packEntries,
  type Platform,
  remanifest,
  sha256File,
} from "./version-folder.ts";

/**
 * Arguments that break naive quoting: spaces, quotes, backslashes before quotes and at the end,
 * empty strings, percent signs and cmd.exe metacharacters, Unicode outside the BMP, combining
 * marks, right-to-left text, tabs and newlines. Each must reach Node unchanged.
 */
export const HOSTILE_ARGS: readonly string[] = [
  "plain",
  "",
  " ",
  "two words",
  '"',
  '""',
  'say "hi"',
  "\\",
  "\\\\",
  "C:\\Program Files\\Tasks\\",
  "trailing\\",
  'back\\"slash',
  'a\\\\"b c',
  '\\"\\\\"',
  "%PATH%",
  "%%",
  "100%",
  "!x!",
  "^&|<>()",
  "'single'",
  "tab\there",
  "new\nline",
  "--flag=value",
  "-",
  "--",
  "naïve café",
  "日本語のタスク",
  "Mira 🐸 Okafor",
  "e\u0301",
  "עברית",
  "${HOME} $(id) `id`",
  "*?[a]",
  "",
];

export function powershellExe(): string {
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The current environment with `extra` applied. Names match case-insensitively on Windows. */
function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const key = (name: string) => (process.platform === "win32" ? name.toLowerCase() : name);
  const replaced = new Set(Object.keys(extra).map(key));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!replaced.has(key(k))) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

function spawn(
  exe: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const result = spawnSync(exe, args, {
    encoding: "utf8",
    env: childEnv(env),
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  return result;
}

export interface InstallRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the rendered install script for `platform` from `source` into `root`. Without `root`, the
 * script falls back to TTASKS_HOME from `env`. Windows PowerShell 5.1 runs the Windows script,
 * with a process-only execution policy, so no machine or user setting changes.
 */
export function runInstaller(
  platform: Platform,
  installer: string,
  source: string,
  root: string | undefined,
  env: Record<string, string | undefined> = {},
): InstallRun {
  const rootArgs = (flag: string) => (root === undefined ? [] : [flag, root]);
  const result =
    platform === "win-x64"
      ? spawn(
          powershellExe(),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            installer,
            "-Source",
            source,
            ...rootArgs("-Root"),
          ],
          // Without PSModulePath 5.1 uses its own default, as in a fresh window. A path inherited
          // from PowerShell 7 is covered by runFromPowerShell7 (lab row R09, A2 3.12.4).
          { PSModulePath: undefined, ...env },
        )
      : spawn("/bin/sh", [installer, "--source", source, ...rootArgs("--root")], env);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The two ways a user's PowerShell 7 window broke install.ps1 in lab row R09 (A2 3.12.4):
 *   utf8-console      the console code page is 65001 (UTF-8), PSModulePath is 5.1's own
 *   pwsh-module-path  the console code page is 437, PSModulePath is inherited from PowerShell 7
 */
export type Ps7Condition = "utf8-console" | "pwsh-module-path";

/** PowerShell 7: its usual install folder, else pwsh.exe on PATH. */
export function pwshExe(): string {
  const installed = join(process.env["ProgramFiles"] ?? "C:\\Program Files", "PowerShell", "7");
  const exe = join(installed, "pwsh.exe");
  return existsSync(exe) ? exe : "pwsh.exe";
}

/**
 * Run by PowerShell 7 with the code page to use, and the script and its arguments in environment
 * variables (one argument per line), so nothing becomes script text. chcp.com changes the code page
 * of the console the wrapper owns: Node starts it with a hidden console of its own (windowsHide and
 * piped output), so the caller's console never changes. The code page is read back first.
 * Windows PowerShell 5.1 starts through Process.Start with an argument list, not as a native
 * command: PowerShell 7 rewrites PSModulePath for a powershell.exe it runs as a native command,
 * but not for other children (Node, pnpm, an installer's caller), and those pass its own
 * PSModulePath on. That inherited path is what broke Get-FileHash in lab row R09.
 */
const PS7_WRAPPER = [
  "$ErrorActionPreference = 'Stop'",
  "$chcp = [IO.Path]::Combine($env:SystemRoot, 'System32', 'chcp.com')",
  "$null = & $chcp $env:TTASKS_TEST_CODE_PAGE",
  'if ((& $chcp) -notmatch "\\b$($env:TTASKS_TEST_CODE_PAGE)\\b") {',
  "  [Console]::Error.WriteLine('the console code page did not change'); exit 97",
  "}",
  "$psi = [Diagnostics.ProcessStartInfo]::new($env:TTASKS_TEST_POWERSHELL)",
  "$psi.UseShellExecute = $false",
  "$fixed = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File')",
  "foreach ($a in $fixed + @($env:TTASKS_TEST_SCRIPT) + $env:TTASKS_TEST_ARGS.Split([char]10)) {",
  "  $psi.ArgumentList.Add($a)",
  "}",
  "if ($env:TTASKS_TEST_KEEP_MODULE_PATH -ne '1') { [void]$psi.Environment.Remove('PSModulePath') }",
  "$child = [Diagnostics.Process]::Start($psi)",
  "$child.WaitForExit()",
  "exit $child.ExitCode",
].join("\n");

/**
 * Windows: runs `script` with Windows PowerShell 5.1 the way a user starts it from a PowerShell 7
 * window, under one of the conditions of lab row R09. PowerShell 7 sets PSModulePath for its
 * own process, so the inherited path is the real one. The arguments must not be empty or hold a
 * line feed.
 */
export function runFromPowerShell7(
  condition: Ps7Condition,
  script: string,
  args: readonly string[],
): InstallRun {
  if (args.some((a) => a === "" || a.includes("\n"))) throw new Error("unsupported argument");
  const result = spawn(
    pwshExe(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(PS7_WRAPPER, "utf16le").toString("base64"),
    ],
    {
      PSModulePath: undefined,
      TTASKS_TEST_CODE_PAGE: condition === "utf8-console" ? "65001" : "437",
      TTASKS_TEST_KEEP_MODULE_PATH: condition === "pwsh-module-path" ? "1" : "0",
      TTASKS_TEST_POWERSHELL: powershellExe(),
      TTASKS_TEST_SCRIPT: script,
      TTASKS_TEST_ARGS: args.join("\n"),
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** runInstaller for Windows, started from PowerShell 7 under `condition`. */
export function runInstallerFromPowerShell7(
  condition: Ps7Condition,
  installer: string,
  source: string,
  root: string,
): InstallRun {
  return runFromPowerShell7(condition, installer, ["-Source", source, "-Root", root]);
}

export function stableLauncher(root: string, platform: Platform, gui = false): string {
  if (platform === "win-x64") return join(root, "bin", gui ? "ttasksw.exe" : "ttasks.exe");
  return join(root, "bin", "ttasks");
}

export function versionLauncher(
  root: string,
  version: string,
  platform: Platform,
  gui = false,
): string {
  return stableLauncher(join(root, "versions", version), platform, gui);
}

/** Asserts a good install: the version folder, current, the stable command and install.json. */
export function assertInstalled(
  root: string,
  version: string,
  platform: Platform,
  run: InstallRun,
) {
  assert.equal(run.status, 0, `install failed:\n${run.stdout}\n${run.stderr}`);
  assert.ok(existsSync(join(root, "versions", version, "manifest.json")), "no version folder");
  assert.ok(existsSync(join(root, "home.marker")), "no home.marker");
  assert.ok(existsSync(stableLauncher(root, platform)), "no stable command");
  if (platform === "win-x64") {
    assert.equal(readFileSync(join(root, "current"), "utf8"), version);
    assert.ok(existsSync(stableLauncher(root, platform, true)), "no stable ttasksw.exe");
  }
  const info = JSON.parse(readFileSync(join(root, "install.json"), "utf8")) as { version: string };
  assert.equal(info.version, version);
  const leftovers = readdirSync(join(root, "versions")).filter((n) => n.startsWith("."));
  assert.deepEqual(leftovers, [], "download or staging folders were left behind");
}

/**
 * The canary kit of the tamper tests. Every stand-in writes a file into `dir` when it runs, in any
 * way: with any arguments, through any shell, as any entry point. The path is written into each
 * stand-in, so a cleaned environment does not silence it. `dir` exists and must stay empty.
 */
export interface Canary {
  dir: string;
  /** Windows: the compiled stand-in executable (launcher/canary-stand-in.c). */
  exe: string | undefined;
}

/** Creates the canary folder in `work` and, on Windows, compiles the stand-in executable. */
export function prepareCanary(work: string, platform: Platform): Canary {
  const dir = join(work, "canary");
  mkdirSync(dir, { recursive: true });
  if (platform !== "win-x64") return { dir, exe: undefined };
  const build = join(work, "canary-build");
  mkdirSync(build, { recursive: true });
  const literal = dir.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const wrapper = join(build, "canary.c");
  writeFileSync(
    wrapper,
    `#define TTASKS_CANARY_DIR L"${literal}"\n#include "${canarySource.replaceAll("\\", "/")}"\n`,
  );
  return { dir, exe: compileExe(wrapper, build, "canary") };
}

/** Asserts that no stand-in ran: the canary folder still exists and is empty. */
export function assertCanaryQuiet(canary: Canary, context: string) {
  assert.ok(existsSync(canary.dir), `${context}: the canary folder is gone`);
  const fired = readdirSync(canary.dir);
  assert.deepEqual(fired, [], `${context}: code from the candidate ran (${fired.join(", ")})`);
}

/** Files of a version folder that can run: the launchers, the runtime and the lib/ modules. */
function isRunnable(path: string): boolean {
  return path.startsWith("bin/") || path.startsWith("runtime/") || path.startsWith("lib/");
}

function shQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The stand-in for one runnable file. It writes `<canary dir>/<its name>` when it runs. */
function standIn(path: string, platform: Platform, canary: Canary): Buffer {
  const target = join(canary.dir, path.replaceAll("/", "-"));
  if (path.endsWith(".mjs")) {
    return Buffer.from(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(target)}, "ran");\n`,
    );
  }
  if (platform === "win-x64") {
    if (canary.exe === undefined) throw new Error("the Windows canary needs its stand-in exe");
    return readFileSync(canary.exe);
  }
  // In place of the POSIX launcher and the runtime: run directly or by any shell, it fires.
  return Buffer.from(`#!/bin/sh\nprintf '%s\\n' "$0 $*" > ${shQuote(target)}\nexit 0\n`);
}

/** Entries with every runnable file swapped for its stand-in and manifest.json updated to match. */
function withStandIns(entries: FileEntry[], platform: Platform, canary: Canary): FileEntry[] {
  return remanifest(
    entries.map((e) =>
      isRunnable(e.path) ? { ...e, data: standIn(e.path, platform, canary) } : e,
    ),
  );
}

/**
 * The look-alike archive: the good archive with every runnable file (launchers, runtime, lib/)
 * swapped for a canary stand-in and a consistent manifest.json.
 */
export function lookAlikeArchive(archive: string, platform: Platform, canary: Canary): Buffer {
  const data = readFileSync(archive);
  const read = platform === "win-x64" ? readZip(data) : readTarGz(data);
  const entries: FileEntry[] = read
    .filter((e) => e.type === "file")
    .map((e) => ({ path: e.path, data: e.data, mode: e.mode }));
  return packEntries(withStandIns(entries, platform, canary), platform, 0);
}

/**
 * Positive control: unpacks the runnable files of `archive` into `scratch`, runs each one, and
 * asserts that each left its canary. Then empties the canary folder. Without this, a broken
 * stand-in would let every refusal test pass for the wrong reason.
 */
export function assertStandInsFire(
  archive: Buffer,
  platform: Platform,
  canary: Canary,
  scratch: string,
) {
  const read = platform === "win-x64" ? readZip(archive) : readTarGz(archive);
  const runnable = read.filter((e) => e.type === "file" && isRunnable(e.path));
  assert.ok(runnable.length >= (platform === "win-x64" ? 6 : 5), "too few runnable files");
  for (const e of runnable) {
    const file = join(scratch, ...e.path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, e.data, { mode: 0o755 });
    if (e.path.endsWith(".mjs")) spawn(process.execPath, [file]);
    else spawn(file, ["--package-info"]);
  }
  const fired = readdirSync(canary.dir);
  assert.equal(
    fired.length,
    runnable.length,
    `every stand-in must leave a canary when run: ${runnable.map((e) => e.path).join(", ")} ` +
      `left ${fired.join(", ")}`,
  );
  for (const f of fired) rmSync(join(canary.dir, f));
  rmSync(scratch, { recursive: true, force: true });
}

/** Asserts that a refused install left nothing that could have run, and ran nothing. */
export function assertRefused(
  root: string,
  version: string,
  run: InstallRun,
  canary: Canary,
  reason: RegExp,
) {
  assertCanaryQuiet(canary, "a refused download");
  assert.notEqual(run.status, 0, "the install script accepted a tampered download");
  assert.match(run.stderr, /Cannot verify this download/);
  assert.match(run.stderr, reason);
  assert.ok(!existsSync(join(root, "versions", version)), "a version folder was created");
  assert.ok(!existsSync(join(root, "current")), "current was written");
  assert.ok(!existsSync(join(root, "bin")), "a stable command was installed");
  const versions = join(root, "versions");
  const left = existsSync(versions) ? readdirSync(versions) : [];
  assert.deepEqual(left, [], "the download or staging folder was left behind");
}

/** Path to SHA-256 of every file under `dir`. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(listFiles(dir).map((f) => [f, sha256File(join(dir, ...f.split("/")))]));
}

/**
 * A reinstall of the same signed release over an existing folder of its version. The existing
 * folder runs only if it is exactly that release: manifest.json byte for byte, and every file
 * against the signed manifest. Each case starts from a copy of a good install:
 *   intact      the folder as installed: kept, the reinstall succeeds
 *   changed     one file changed, manifest.json unchanged
 *   consistent  every runnable file swapped for a canary stand-in, manifest.json updated to match
 *   rebuilt     the files unchanged, manifest.json from another build of the same version
 * The last three must stop before anything runs and leave the folder, current and install.json
 * as they were.
 */
export function assertReinstallChecksExistingVersion(
  platform: Platform,
  installer: string,
  dist: string,
  version: string,
  work: string,
  canary: Canary,
) {
  const base = join(work, "reinstall-base");
  assertInstalled(base, version, platform, runInstaller(platform, installer, dist, base));
  assertInstalled(base, version, platform, runInstaller(platform, installer, dist, base));
  assertCanaryQuiet(canary, "an intact reinstall");

  const cases: [name: string, tamper: (folder: string) => void, reason: RegExp][] = [
    [
      "changed",
      (folder) => {
        appendFileSync(join(folder, "lib", "ttasks.mjs"), "// changed\n");
      },
      /its files do not match the signed manifest/,
    ],
    [
      "consistent",
      (folder) => {
        for (const e of withStandIns(folderEntries(folder), platform, canary)) {
          writeFileSync(join(folder, ...e.path.split("/")), e.data);
        }
      },
      /its manifest\.json is not the signed one/,
    ],
    [
      "rebuilt",
      (folder) => {
        const manifest = join(folder, "manifest.json");
        const text = readFileSync(manifest, "utf8");
        const rebuilt = text.replace(/"build": "[^"]*"/, '"build": "another-build"');
        assert.notEqual(rebuilt, text, "manifest.json has no build field");
        writeFileSync(manifest, rebuilt);
      },
      /its manifest\.json is not the signed one/,
    ],
  ];
  // Every case runs, and the failures are reported together.
  const failures: string[] = [];
  for (const [name, tamper, reason] of cases) {
    const root = join(work, `reinstall-${name}`);
    cpSync(base, root, { recursive: true, verbatimSymlinks: true });
    const folder = join(root, "versions", version);
    tamper(folder);
    const before = snapshot(folder);
    const current = platform === "win-x64" ? readFileSync(join(root, "current"), "utf8") : null;
    const installJson = readFileSync(join(root, "install.json"), "utf8");

    const run = runInstaller(platform, installer, dist, root);
    try {
      assertCanaryQuiet(canary, "the existing folder ran");
      assert.notEqual(run.status, 0, "the reinstall accepted a folder that is not the release");
      assert.match(run.stderr, /already exists but is not this signed release/);
      assert.match(run.stderr, reason);
      assert.deepEqual(snapshot(folder), before, "the existing folder was changed");
      if (current !== null) assert.equal(readFileSync(join(root, "current"), "utf8"), current);
      assert.equal(readFileSync(join(root, "install.json"), "utf8"), installJson);
      assert.deepEqual(readdirSync(join(root, "versions")), [version], "leftover folders");
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      failures.push(`${name}: ${message ?? ""} (exit ${String(run.status)}: ${run.stderr.trim()})`);
      for (const f of readdirSync(canary.dir)) rmSync(join(canary.dir, f));
    }
  }
  assert.deepEqual(
    failures,
    [],
    `reinstall over an existing version folder:\n${failures.join("\n")}`,
  );
}

/**
 * Signs a SHA256SUMS file with a fresh, unrelated throwaway key, as an attacker with their own
 * key would. Only the signature changes: the install script still pins the release key.
 */
export function resignWithOtherKey(keyFolder: string): (sumsFile: string) => void {
  return (sumsFile) => {
    mkdirSync(keyFolder, { recursive: true });
    const key = generateThrowawayKey(keyFolder);
    try {
      signFile(sumsFile, key.privateKey);
    } finally {
      deleteKey(key);
    }
  };
}

export interface TamperCase {
  name: string;
  /** Folder that holds the archive, SHA256SUMS, SHA256SUMS.sshsig and the install script. */
  source: string;
  reason: RegExp;
}

/**
 * Builds the tamper cases from a signed `dist` folder, after proving that the look-alike
 * archive's stand-ins fire when run (assertStandInsFire):
 *   archive   the look-alike archive under the real name, SHA256SUMS and its signature intact
 *   sums      the look-alike archive and SHA256SUMS rewritten to its digest, old signature
 *   resigned  the look-alike archive with SHA256SUMS signed by another throwaway key
 *   unsigned  the good archive with SHA256SUMS.sshsig missing
 */
export function prepareTamperCases(
  dist: string,
  version: string,
  platform: Platform,
  work: string,
  resign: (sumsFile: string) => void,
  canary: Canary,
): TamperCase[] {
  const name = archiveName(version, platform);
  const installer = installerName(platform, version);
  const evil = lookAlikeArchive(join(dist, name), platform, canary);
  assertStandInsFire(evil, platform, canary, join(work, "stand-in-proof"));
  const make = (
    caseName: string,
    files = [name, "SHA256SUMS", "SHA256SUMS.sshsig", installer],
  ): string => {
    const dir = join(work, `tamper-${caseName}`);
    mkdirSync(dir, { recursive: true });
    for (const f of files) copyFileSync(join(dist, f), join(dir, f));
    return dir;
  };
  const evilSums = (dir: string): void => {
    writeFileSync(join(dir, name), evil);
    writeFileSync(join(dir, "SHA256SUMS"), `${sha256File(join(dir, name))}  ${name}\n`);
  };

  const archive = make("archive");
  writeFileSync(join(archive, name), evil);

  const sums = make("sums");
  evilSums(sums);

  const resigned = make("resigned");
  evilSums(resigned);
  resign(join(resigned, "SHA256SUMS"));

  const unsigned = make("unsigned", [name, "SHA256SUMS", installer]);

  return [
    { name: "archive", source: archive, reason: /does not match SHA256SUMS/ },
    { name: "sums", source: sums, reason: /signature of SHA256SUMS does not verify/ },
    { name: "resigned", source: resigned, reason: /signature of SHA256SUMS does not verify/ },
    { name: "unsigned", source: unsigned, reason: /SHA256SUMS\.sshsig is missing/ },
  ];
}

export interface ArgvReport {
  args: string[];
  execArgv: string[];
  env: Record<string, string | boolean | null>;
}

/** Runs `<launcher> argv <args…>` and returns what reached Node. */
export function launchArgv(
  launcher: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): ArgvReport {
  const result = spawn(launcher, ["argv", ...args], env);
  assert.equal(result.status, 0, `${launcher} argv failed:\n${result.stderr}`);
  return JSON.parse(result.stdout) as ArgvReport;
}

/**
 * Hostile argv through one launcher: every argument byte for byte, each one alone and all at
 * once, with NODE_OPTIONS and NODE_PATH set in the caller's environment and removed for Node.
 */
export function assertArgvVerbatim(launcher: string, mode: "stable" | "version" | "posix") {
  const poisoned = { NODE_OPTIONS: "--require ./does-not-exist.cjs", NODE_PATH: "./nowhere" };
  const all = launchArgv(launcher, HOSTILE_ARGS, poisoned);
  assert.deepEqual(all.args, [...HOSTILE_ARGS], `${launcher}: arguments changed on the way`);
  assert.deepEqual(all.execArgv, ["--report-exclude-env"]);
  assert.equal(all.env["NODE_OPTIONS"], false, "NODE_OPTIONS reached Node");
  assert.equal(all.env["NODE_PATH"], false, "NODE_PATH reached Node");
  if (mode !== "posix") assert.equal(all.env["TTASKS_LAUNCH_MODE"], mode);
  for (const arg of HOSTILE_ARGS) {
    assert.deepEqual(
      launchArgv(launcher, [arg]).args,
      [arg],
      `${launcher}: ${JSON.stringify(arg)}`,
    );
  }
  const none = launchArgv(launcher, []);
  assert.deepEqual(none.args, []);
}

/** The exit code of Node reaches the caller unchanged. */
export function assertExitCode(launcher: string) {
  for (const code of [0, 1, 7, 64, 255]) {
    const result = spawn(launcher, ["exit", String(code)]);
    assert.equal(result.status, code, `${launcher}: exit ${String(code)}`);
  }
}

export interface GateRun {
  ok: boolean;
  results: { check: string; ok: boolean; detail: string }[];
}

/** Runs the runtime gate through a launcher, inside the packaged runtime. */
export function runGateVia(launcher: string, scratch: string): GateRun {
  mkdirSync(scratch, { recursive: true });
  const result = spawn(launcher, ["gate", "--scratch", scratch, "--json"]);
  const report = JSON.parse(result.stdout) as GateRun;
  assert.equal(result.status, report.ok ? 0 : 1, "the gate's exit code disagrees with its report");
  return report;
}

export function formatGate(run: GateRun): string {
  return run.results
    .map((r) => `${r.ok ? "pass" : "FAIL"}  ${r.check.padEnd(20)} ${r.detail}`)
    .join("\n");
}
