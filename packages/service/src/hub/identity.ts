// Who the service runs as, checked before it writes anything (A2 3.3.1, 3.5; A6 3.16.1 rule 7).
// It refuses to run as root or as an elevated Administrator, because the agents it launches would
// inherit those rights, and it refuses package identity, because a packaged parent may virtualise
// its writes and so create a second service.
//
// - Package identity: ttasks.exe and ttasksw.exe pass GetCurrentPackageFullName to Node as
//   TTASKS_PACKAGE (A2 3.5 rule 2). Any non-empty value is a package.
// - Root: UID or effective UID 0 on Linux and macOS.
// - Elevated: Windows has no Node API for the token, so the service reads its own token's
//   mandatory label with System32's whoami.exe, by SID, which no locale changes. High (12288) and
//   above is elevated. Only that answer refuses: a check with no answer (it could not run, or a busy
//   machine kept it past its 10 s) starts the service and is logged. Limit: an elevated token on
//   a machine too slow to say so runs elevated.
//   System32 is found through the kernel's \SystemRoot link, never SystemRoot or windir: a parent
//   sets those, and could point them at a whoami that answers "medium".
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { envVar } from "@ttasks/brand";

export const TTASKS_PACKAGE = envVar("PACKAGE");

export interface Identity {
  /** UID or effective UID 0 (Linux, macOS). */
  readonly root: boolean;
  /** Windows: elevated (true), not elevated (false), or the check gave no answer (undefined). */
  readonly elevated: boolean | undefined;
  /** The package's full name when the process has package identity, else null. */
  readonly package: string | null;
}

/** The package identity the launcher passed, or null. */
export function packageIdentity(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env[TTASKS_PACKAGE];
  return value === undefined || value.trim() === "" ? null : value;
}

/** The mandatory label SIDs of Windows integrity levels (S-1-16-<rid>). */
export const INTEGRITY = { medium: 8192, high: 12288, system: 16384 } as const;

/**
 * The integrity level in `whoami /groups /fo csv /nh` output: the RID of the one group whose SID
 * is a mandatory label (S-1-16-<rid>), or undefined when there is none or more than one. The SID is
 * the third quoted field, the same in every display language.
 */
export function integrityLevel(csv: string): number | undefined {
  const levels = new Set<number>();
  for (const line of csv.split(/\r?\n/)) {
    const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
    const sid = /^S-1-16-(\d{1,6})$/.exec(fields[2] ?? "");
    if (sid?.[1] !== undefined) levels.add(Number(sid[1]));
  }
  return levels.size === 1 ? [...levels][0] : undefined;
}

/**
 * System32 in the kernel's object namespace. The kernel makes `\SystemRoot` at boot, and neither
 * a parent's environment nor this session's drive letters change where it points.
 */
const SYSTEM32_LINK = "\\\\?\\GLOBALROOT\\SystemRoot\\System32";

let found: string | undefined;

/**
 * The System32 folder as a drive path, or undefined when it cannot be told (and on every other
 * OS). Every System32 tool TTasks runs (whoami.exe, reg.exe, tasklist.exe, powershell.exe) comes
 * from here. Not from Node's diagnostic report: one taken while a worker thread runs corrupts the
 * heap and ends the process without a word.
 */
export function system32(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (found !== undefined) return found;
  try {
    found = realpathSync.native(SYSTEM32_LINK);
  } catch {
    return undefined;
  }
  return found;
}

/** Whether the current Windows token is elevated, or undefined when that cannot be told. */
export function windowsElevated(): boolean | undefined {
  const folder = system32();
  if (folder === undefined) return undefined;
  const result = spawnSync(win32.join(folder, "whoami.exe"), ["/groups", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  const level = integrityLevel(result.stdout);
  return level === undefined ? undefined : level >= INTEGRITY.high;
}

/** The real identity of this process. Only the package identity comes from `env`. */
export function detectIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Identity {
  const root = platform !== "win32" && (process.getuid?.() === 0 || process.geteuid?.() === 0);
  return {
    root,
    elevated: platform === "win32" ? windowsElevated() : false,
    package: packageIdentity(env),
  };
}
