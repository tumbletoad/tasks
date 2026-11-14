// Doctor's other-accounts check (A2 3.13 "Other user accounts", 3.8.6; A6 3.3; R18): v1 assumes
// one person per machine, because another account could serve a fake page at the UI's address
// while Tasks is stopped. Doctor warns when the machine has other interactive user accounts.
//
// - Linux: `getent passwd` entries in the regular UID range with a login shell other than nologin
//   or false.
// - macOS: `dscl . -list /Users UniqueID` from 501 up, without the `_` service accounts.
// - Windows: user SIDs (S-1-5-21-…) under ProfileList, which needs no admin rights.
//
// An agent app's own sandbox accounts are not people and are not counted (A2 3.13): the
// Codex CLI's Windows sandbox makes accounts in a group it manages, `CodexSandboxUsers`. Only the
// counts leave this module: no account name or SID is printed or logged. The OS's own tools run as
// helpers of the runner (@tasks/launch helpers.ts, A3 3.14), like every program doctor starts.
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { helperOutput } from "@tasks/launch/helpers";

/** Groups that agent apps manage for their own sandbox accounts (A2 3.13). */
export const SANDBOX_GROUPS = ["CodexSandboxUsers"] as const;

export interface AccountFacts {
  /** This user's ID (UID, SID). */
  readonly me: string;
  /** The interactive accounts the OS lists, this user's included. */
  readonly accounts: readonly string[];
  /** Accounts in an agent app's sandbox group. */
  readonly sandbox: readonly string[];
}

export interface AccountCount {
  /** Other accounts that may be people. */
  readonly others: number;
  /** Agent sandbox accounts left out. */
  readonly sandbox: number;
}

export function countAccounts(facts: AccountFacts): AccountCount {
  const sandbox = new Set(facts.sandbox);
  const others = new Set(facts.accounts.filter((id) => id !== facts.me));
  let left = 0;
  for (const id of others) if (sandbox.has(id)) left += 1;
  return { others: others.size - left, sandbox: left };
}

/** The UID range of regular accounts from /etc/login.defs, else 1000 to 60000. */
export function uidRange(loginDefs: string): { min: number; max: number } {
  const value = (name: string, fallback: number) => {
    const match = new RegExp(`^\\s*${name}\\s+(\\d+)`, "m").exec(loginDefs);
    return match?.[1] === undefined ? fallback : Number(match[1]);
  };
  return { min: value("UID_MIN", 1000), max: value("UID_MAX", 60000) };
}

/** Linux: interactive accounts of `getent passwd` output, as UIDs. */
export function linuxAccounts(passwd: string, range: { min: number; max: number }): string[] {
  const ids: string[] = [];
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 7) continue;
    const uid = Number(fields[2]);
    const shell = (fields[6] ?? "").trim();
    if (!Number.isInteger(uid) || uid < range.min || uid > range.max) continue;
    if (shell === "" || /(?:^|\/)(?:nologin|false)$/.test(shell)) continue;
    ids.push(String(uid));
  }
  return ids;
}

/** macOS: `dscl . -list /Users UniqueID` output, as UIDs from 501 up, without `_` accounts. */
export function macAccounts(dscl: string): string[] {
  const ids: string[] = [];
  for (const line of dscl.split("\n")) {
    const [name, id] = line.trim().split(/\s+/);
    const uid = Number(id);
    if (name === undefined || name.startsWith("_") || !Number.isInteger(uid) || uid < 501) continue;
    ids.push(String(uid));
  }
  return ids;
}

/** Windows: the JSON the PowerShell query below prints. */
export function windowsAccounts(json: string): AccountFacts | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter(
      (s): s is string => typeof s === "string" && /^S-1-5-21-[0-9-]+$/.test(s),
    );
  const me = record["me"];
  if (typeof me !== "string") return undefined;
  return { me, accounts: list(record["profiles"]), sandbox: list(record["sandbox"]) };
}

const WINDOWS_QUERY = [
  "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$p = @(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList' | ForEach-Object { $_.PSChildName } | Where-Object { $_ -like 'S-1-5-21-*' })",
  "$s = @()",
  ...SANDBOX_GROUPS.map(
    (g) =>
      `try { $s += @(Get-LocalGroupMember -Group '${g}' -ErrorAction Stop | ForEach-Object { $_.SID.Value }) } catch {}`,
  ),
  "@{ me = $me; profiles = $p; sandbox = $s } | ConvertTo-Json -Compress",
].join("; ");

/** This machine's facts, or undefined when the OS gave no answer. */
export async function readAccounts(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Promise<AccountFacts | undefined> {
  // The OS's own tools run in this process's environment, as they always have: only where the
  // system folder is comes from `env`.
  const run = (argv: readonly string[]) =>
    helperOutput(argv, {
      env: process.env,
      cwd,
      deadlineMs: 30_000,
      maxChars: 4 * 1024 * 1024,
    });
  if (platform === "win32") {
    const root = env["SystemRoot"] ?? "C:\\Windows";
    const ps = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const out = await run([ps, "-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY]);
    return out === undefined ? undefined : windowsAccounts(out.trim());
  }
  const me = String(process.getuid?.() ?? -1);
  if (platform === "darwin") {
    const out = await run(["/usr/bin/dscl", ".", "-list", "/Users", "UniqueID"]);
    return out === undefined ? undefined : { me, accounts: macAccounts(out), sandbox: [] };
  }
  const passwd = await run(["getent", "passwd"]);
  if (passwd === undefined) return undefined;
  let defs = "";
  try {
    defs = readFileSync("/etc/login.defs", "utf8");
  } catch {
    // The defaults apply.
  }
  return { me, accounts: linuxAccounts(passwd, uidRange(defs)), sandbox: [] };
}
