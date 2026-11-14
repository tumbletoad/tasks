// The real machine's facts for the synced-folder check (sync-folders.ts, A1 3.2).
//
// - Files: lstat, stat, realpath and readdir through node:fs/promises, so a slow network folder
//   never blocks the service's thread. A failed look is "not there".
// - Windows (A1 3.2): one Windows PowerShell 5.1 run (System32's, found the way identity.ts
//   finds whoami.exe: never through SystemRoot) reads the drives (type, label, format), OneDrive's
//   accounts, the Cloud Files sync roots registered for this user's SID, and Drive for desktop's
//   SyncTargets value, and writes them as base64 of UTF-8 JSON, so no console code page alters a
//   path. The script comes on stdin, not on the command line. About 0.3 s; the answer is kept for a
//   minute, so the spaces that open together at start share one run. Any failure gives no facts,
//   which leaves a folder unchecked (sync-folders.ts); the environment variables, the markers and
//   UNC paths still count.
// - Linux: `fs.statfs`'s type and /proc/self/mountinfo (bounded). macOS: /sbin/mount's output.
import { spawn } from "node:child_process";
import { lstat, open, readdir, realpath, stat, statfs } from "node:fs/promises";
import os from "node:os";
import { win32 } from "node:path";
import { system32 } from "./identity.ts";
import type { SyncHost, WindowsSyncFacts } from "./sync-folders.ts";

const FACTS_TTL_MS = 60_000;
const RUN_TIMEOUT_MS = 10_000;
const OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/** The script, one statement per line, read from stdin by `powershell -Command -`. */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  // A network drive's label and format are not read: IsReady on a disconnected one waits for the
  // network's time-out, and the label that counts (Google Drive's) is a local drive's.
  "$d=@(foreach($x in [IO.DriveInfo]::GetDrives()){$f='';$l='';if($x.DriveType -ne 'Network' -and $x.IsReady){$f=$x.DriveFormat;$l=$x.VolumeLabel};@{root=$x.Name;type=$x.DriveType.ToString();format=$f;label=$l}})",
  "$a=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\OneDrive\\Accounts' | ForEach-Object { (Get-ItemProperty -LiteralPath $_.PSPath).UserFolder } | Where-Object { $_ })",
  "$r=@(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager' | ForEach-Object { $u=Get-ItemProperty -LiteralPath (Join-Path $_.PSPath 'UserSyncRoots'); if($u -and $u.PSObject.Properties[$sid]){@{id=$_.PSChildName;path=[string]$u.$sid}} })",
  "$t='';$s=Get-ItemProperty 'HKCU:\\Software\\Google\\DriveFS\\Share';if($s -and $s.PSObject.Properties['SyncTargets']){$t=[Convert]::ToBase64String([byte[]]$s.SyncTargets)}",
  "$j=ConvertTo-Json -Compress -Depth 4 @{drives=$d;onedrive=$a;roots=$r;drivefs=$t}",
  "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)))",
].join("\n");

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).filter(
    (v): v is string => typeof v === "string" && v !== "",
  );

const objects = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).filter(
    (v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v),
  );

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The facts the script wrote (base64 of UTF-8 JSON), each field checked; undefined if unreadable. */
export function parseWindowsFacts(output: string): WindowsSyncFacts | undefined {
  try {
    const value = JSON.parse(Buffer.from(output.trim(), "base64").toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const json = value as Record<string, unknown>;
    return {
      oneDriveAccounts: strings(json["onedrive"]),
      syncRoots: objects(json["roots"])
        .map((r) => ({ id: text(r["id"]), path: text(r["path"]) }))
        .filter((r) => r.id !== "" && r.path !== ""),
      driveFsTargets: text(json["drivefs"]),
      drives: objects(json["drives"]).map((d) => ({
        root: text(d["root"]),
        type: text(d["type"]),
        label: text(d["label"]),
        format: text(d["format"]),
      })),
    };
  } catch {
    return undefined;
  }
}

/** Runs `file` with `args`, `input` on stdin, within the bound; its stdout, or undefined. */
function run(file: string, args: readonly string[], input: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: string | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
      });
    } catch {
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, RUN_TIMEOUT_MS);
    timer.unref();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > OUTPUT_MAX_BYTES) {
        child.kill();
        finish(undefined);
      }
    });
    child.once("error", () => {
      finish(undefined);
    });
    child.once("close", (code) => {
      finish(code === 0 ? out : undefined);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

/** Reads at most `maxBytes` of a file as UTF-8, or undefined. */
async function readSmall(path: string, maxBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead <= 0) break;
      length += bytesRead;
    }
    return length > maxBytes ? undefined : buffer.subarray(0, length).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface RealSyncHostOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The account's home; default: the OS account's (A2 3.2.2 rule 1). */
  readonly home?: string;
  /** Windows' facts; default: the PowerShell run above. Tests and the test entry pass their own. */
  readonly windowsFacts?: () => Promise<WindowsSyncFacts | undefined>;
}

/** The PowerShell run, at most once a minute per host. */
function windowsFactsOnce(): () => Promise<WindowsSyncFacts | undefined> {
  let cached: { at: number; facts: Promise<WindowsSyncFacts | undefined> } | undefined;
  return () => {
    const now = Date.now();
    if (cached !== undefined && now - cached.at < FACTS_TTL_MS) return cached.facts;
    const folder = system32();
    const facts =
      folder === undefined
        ? Promise.resolve(undefined)
        : run(
            win32.join(folder, "WindowsPowerShell", "v1.0", "powershell.exe"),
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
            `${WINDOWS_SCRIPT}\n`,
          ).then((out) => (out === undefined ? undefined : parseWindowsFacts(out)));
    cached = { at: now, facts };
    return facts;
  };
}

/** This machine's facts for the check. */
export function realSyncHost(options: RealSyncHostOptions = {}): SyncHost {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home =
    options.home ??
    (platform === "win32" ? (env["USERPROFILE"] ?? os.homedir()) : os.userInfo().homedir);
  const windows =
    platform === "win32"
      ? (options.windowsFacts ?? windowsFactsOnce())
      : () => Promise.resolve(undefined);
  return {
    platform,
    home,
    env,
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    exists: async (path) => {
      try {
        await lstat(path);
        return true;
      } catch {
        return false;
      }
    },
    realpath: async (path) => {
      try {
        return await realpath(path);
      } catch {
        return undefined;
      }
    },
    list: async (dir) => {
      try {
        return await readdir(dir);
      } catch {
        return undefined;
      }
    },
    readText: readSmall,
    windowsFacts: windows,
    statfsType: async (path) => {
      if (platform !== "linux") return undefined;
      try {
        return (await statfs(path)).type;
      } catch {
        return undefined;
      }
    },
    mountTable: async () => {
      if (platform === "linux") return readSmall("/proc/self/mountinfo", OUTPUT_MAX_BYTES);
      if (platform === "darwin") return run("/sbin/mount", [], "");
      return undefined;
    },
  };
}
