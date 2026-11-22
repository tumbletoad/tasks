// Install layouts for the launcher tests (A2 3.12.2), in fresh temporary folders. A version folder
// gets the launchers under test, the Node that runs the tests as its runtime (hard-linked from one
// copy per test file), the stub entry test/stub/ttasks.mjs and a manifest. Nothing is downloaded
// and nothing outside the temporary folders is touched.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtOnce } from "../../../tests/run-builds.ts";
import { buildLaunchers, type Launchers } from "../src/build.ts";

export const windows = process.platform === "win32";

/**
 * The release build of the launchers, or the build with the test hooks, made once per test run
 * (tests/run-builds.ts). Read-only: a test copies them where it runs them.
 */
export const runLaunchers = (kind: "release" | "hooks"): Promise<Launchers> =>
  builtOnce(`launchers-${kind}`, (dir) => buildLaunchers(dir, { testHooks: kind === "hooks" }));

const stubEntry = join(dirname(fileURLToPath(import.meta.url)), "stub", "ttasks.mjs");

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

/**
 * A fresh temporary folder, in its long form: the launchers report long paths, and a runner's
 * temporary folder is often given with 8.3 names (C:\Users\RUNNER~1\…).
 */
export function tempDir(label: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `ttasks-${label}-`)));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** A hard link where the volume allows it (fast, and a hard link is no reparse point), else a copy. */
export function linkOrCopy(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

let runtime: string | undefined;

/**
 * Puts the test runner's Node into `work` once (about 100 MB), so every version folder made
 * there can hard-link it, even when the repository and the temporary folder are on different
 * volumes, as on the CI runner.
 */
export function prepareRuntime(work: string): void {
  runtime = join(work, "node.exe");
  linkOrCopy(realpathSync.native(process.execPath), runtime);
}

/** Adds versions\<version>\ to an install root and returns the version folder. */
export function addVersion(root: string, version: string, launchers: Launchers): string {
  if (runtime === undefined) throw new Error("call prepareRuntime(work) first");
  const dir = join(root, "versions", version);
  for (const sub of ["bin", "runtime", "lib"]) mkdirSync(join(dir, sub), { recursive: true });
  copyFileSync(launchers.ttasks, join(dir, "bin", "ttasks.exe"));
  copyFileSync(launchers.ttasksw, join(dir, "bin", "ttasksw.exe"));
  linkOrCopy(runtime, join(dir, "runtime", "node.exe"));
  copyFileSync(stubEntry, join(dir, "lib", "ttasks.mjs"));
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ version })}\n`);
  return dir;
}

/**
 * The folder of the stable launchers for the install root `root`, as the launchers find the root
 * from it: `<root>\bin` when the root holds home.marker (a TTASKS_HOME install), else the daily
 * install's command folder beside share, `<base>\bin` for the root `<base>\share\ttasks`.
 */
export function commandFolder(root: string): string {
  if (existsSync(join(root, "home.marker"))) return join(root, "bin");
  if (!/\\share\\ttasks$/i.test(root)) throw new Error(`not a daily install root: ${root}`);
  return join(root, "..", "..", "bin");
}

/** Writes current and puts the stable launchers into the root's command folder. */
export function makeStable(root: string, version: string, launchers: Launchers): void {
  writeFileSync(join(root, "current"), version);
  const bin = commandFolder(root);
  mkdirSync(bin, { recursive: true });
  copyFileSync(launchers.ttasks, join(bin, "ttasks.exe"));
  copyFileSync(launchers.ttasksw, join(bin, "ttasksw.exe"));
}

export function stable(root: string, gui = false): string {
  return join(commandFolder(root), gui ? "ttasksw.exe" : "ttasks.exe");
}

export function versionLocal(root: string, version: string, gui = false): string {
  return join(root, "versions", version, "bin", gui ? "ttasksw.exe" : "ttasks.exe");
}

export type Env = Record<string, string | undefined>;

/** The test's environment with `extra` applied. Names match case-insensitively, as on Windows. */
export function childEnv(extra: Env = {}): NodeJS.ProcessEnv {
  const replaced = new Set(Object.keys(extra).map((k) => k.toLowerCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!replaced.has(k.toLowerCase())) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

export interface RunOptions {
  env?: Env;
  cwd?: string;
  timeout?: number;
}

export function run(
  exe: string,
  args: readonly string[],
  options: RunOptions = {},
): SpawnSyncReturns<string> {
  const result = spawnSync(exe, args, {
    env: childEnv(options.env),
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 60_000,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

export interface ArgvReport {
  args: string[];
  execArgv: string[];
  execPath: string;
  env: Record<string, string | boolean | null>;
}

/** Runs `<launcher> argv <args…>` and returns what reached Node. */
export function launchArgv(launcher: string, args: readonly string[], env: Env = {}): ArgvReport {
  const result = run(launcher, ["argv", ...args], { env });
  if (result.status !== 0) {
    throw new Error(`${launcher} argv exited ${String(result.status)}:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout) as ArgvReport;
}

export interface VersionReport {
  version: string;
  execPath: string;
}

/** Runs `<launcher> version`: the version folder whose bundle and runtime ran. */
export function launchVersion(launcher: string, options: RunOptions = {}): VersionReport {
  const result = run(launcher, ["version"], options);
  if (result.status !== 0) {
    throw new Error(`${launcher} version exited ${String(result.status)}:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout) as VersionReport;
}

/** Windows paths compare without case. */
export function samePath(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

export function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}

/** The lines of a JSON-lines file, or none if it does not exist. */
export function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}
