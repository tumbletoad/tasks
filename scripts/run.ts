// Runs the repository's tools with the current Node binary. Never through a shell and never through
// the .cmd shims in node_modules/.bin, so the same call works on Windows and Linux.
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PackageJson {
  bin?: string | Record<string, string>;
}

/** The JavaScript entry file of a dependency's command, for example `binPath("eslint", "eslint")`. */
export function binPath(pkg: string, bin: string = pkg, root: string = repoRoot): string {
  const pkgDir = join(root, "node_modules", pkg);
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as PackageJson;
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
  if (entry === undefined) throw new Error(`${pkg} has no command named ${bin}`);
  return join(pkgDir, entry);
}

export interface RunOptions {
  cwd?: string;
  /** Capture stdout instead of passing it through. */
  capture?: boolean;
}

/** Runs `node <script> <args>` with the running Node binary and waits for it. */
export function runNode(
  script: string,
  args: readonly string[],
  options: RunOptions = {},
): SpawnSyncReturns<string> {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? repoRoot,
    stdio: options.capture === true ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

/** What a command run with `runNodeCaptured` printed, stdout and stderr in the order they came. */
export interface Captured {
  status: number | null;
  output: string;
}

/** Runs `node <script> <args>` with the running Node binary, without waiting, output captured. */
export function runNodeCaptured(script: string, args: readonly string[]): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
