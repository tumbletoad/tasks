// Shared helpers for the M0.05 lab checks (A7 3.7, rows R07, R08, R10, R11, R12). Lab code: it is
// thrown away after M0 and nothing outside spikes/ imports it. Node built-ins only, so the scripts
// run as plain .ts files on the packaged Node 26.13.1 of the spike archive, with nothing installed.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";

/** Facts every result file carries. No host name, user name, path or machine identifier. */
export function machineFacts(): Record<string, string | number> {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    node: process.version,
    sqlite: process.versions.sqlite ?? "none",
    napi: process.versions.napi ?? "none",
    modules: process.versions.modules,
  };
}

/** Writes `<out>/<file>` as pretty JSON, creating `out` if needed, and returns the path. */
export function writeResult(out: string, file: string, data: unknown): string {
  mkdirSync(out, { recursive: true });
  const path = join(out, file);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

/** Windows PowerShell 5.1, by absolute path, so PATH and PowerShell 7 play no part. */
export function windowsPowerShell(): string {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Runs a fixed PowerShell script that ends by writing one JSON value, and returns it parsed.
 * The script's output is sent as base64 of UTF-8, so the console code page cannot change it.
 * Inputs go through `TTASKS_LAB_*` environment variables, never into the script text.
 */
export function powershellJson(script: string, inputs: Record<string, string> = {}): unknown {
  const wrapped = `$ErrorActionPreference = 'Stop'
$__result = & { ${script} }
$__json = ConvertTo-Json -InputObject $__result -Depth 8 -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__json)))`;
  // PowerShell 7's module path makes 5.1 load the wrong Microsoft.PowerShell.* modules. The name's
  // case varies between environment blocks (a test runner's fork may upper-case it).
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...inputs }).filter(
      ([k]) => k.toLowerCase() !== "psmodulepath",
    ),
  );
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  const result = spawnSync(
    windowsPowerShell(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"].concat([
      "-EncodedCommand",
      encoded,
    ]),
    { env, encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`powershell exited ${String(result.status)}: ${result.stderr.trim()}`);
  }
  const text = Buffer.from(result.stdout.trim(), "base64").toString("utf8");
  return JSON.parse(text) as unknown;
}

/** Whether this process runs with admin rights (an elevated token) or as root. */
export function isElevated(): boolean {
  if (process.platform !== "win32") return process.getuid?.() === 0;
  const script =
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
    ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
  return powershellJson(script) === true;
}

/** Reads `--name value` options. Unknown options are an error, so a typo never runs a check. */
export function options(
  argv: readonly string[],
  names: readonly string[],
  flags: readonly string[] = [],
): Record<string, string | true> {
  const found: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const name = arg.replace(/^--/, "");
    if (flags.includes(name)) found[name] = true;
    else if (names.includes(name) && i + 1 < argv.length) found[name] = argv[++i] ?? "";
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return found;
}

/** A Windows SID as a lab file may show it: well-known SIDs whole, account SIDs without the domain part. */
export function redactSid(sid: string): string {
  const m = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/.exec(sid);
  return m === null ? sid : `S-1-5-21-…-${m[1] ?? ""}`;
}
