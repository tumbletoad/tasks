// The real machine's facts for the synced-folder check (sync-folders.ts, A1 3.2).
//
// - Files: lstat, stat, realpath and readdir through node:fs/promises, so a slow network folder
//   never blocks the service's thread. A failed look is "not there".
// - Windows (A1 3.2): one Windows PowerShell 5.1 run (System32's, found the way identity.ts
//   finds whoami.exe: never through SystemRoot) reads the drives (type, label, format), OneDrive's
//   accounts, the Cloud Files sync roots registered for this user's SID, and Drive for desktop's
//   SyncTargets value through .NET alone, and writes them in base64 of UTF-8, so no console code
//   page alters a path. The script comes on stdin, not on the command line. About 0.3 s; an answer
//   is kept for a minute, so the spaces that open together at start share one run, and a failed
//   run is not kept. Any failure gives no facts, which leaves a folder unchecked
//   (sync-folders.ts); the environment variables, the markers and UNC paths still count.
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

/**
 * The script, one statement per line, read from stdin by `powershell -Command -`. It writes one
 * line per fact, each field in base64 of UTF-8, then a last line `end`:
 *   drive <root> <type> <format> <label>
 *   onedrive <UserFolder>
 *   root <SyncRootManager key> <path>
 *   drivefs <SyncTargets>            (its bytes, base64 once)
 * It calls .NET only, never a cmdlet: Windows PowerShell finds a cmdlet by searching the modules on
 * its module path, whose cost depends on the modules a machine has (A1 3.2's pitfalls). A key or a
 * value it cannot read is left out, as one that is not there (the old cmdlets' SilentlyContinue).
 */
export const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$e=[Text.Encoding]::UTF8;$o=[Text.StringBuilder]::new()",
  "function b($s){[Convert]::ToBase64String($e.GetBytes([string]$s))}",
  "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  // A network drive's label and format are not read: IsReady on a disconnected one waits for the
  // network's time-out, and the label that counts (Google Drive's) is a local drive's.
  "foreach($x in [IO.DriveInfo]::GetDrives()){$f='';$l='';if($x.DriveType -ne 'Network' -and $x.IsReady){$f=$x.DriveFormat;$l=$x.VolumeLabel};[void]$o.Append('drive '+(b $x.Name)+' '+(b $x.DriveType.ToString())+' '+(b $f)+' '+(b $l)+[char]10)}",
  "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\OneDrive\\Accounts');if($k){foreach($n in $k.GetSubKeyNames()){$s=$k.OpenSubKey($n);if($s){$u=[string]$s.GetValue('UserFolder');if($u){[void]$o.Append('onedrive '+(b $u)+[char]10)}}}}",
  "$k=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager');if($k){foreach($n in $k.GetSubKeyNames()){$s=$k.OpenSubKey($n+'\\UserSyncRoots');if($s){$u=[string]$s.GetValue($sid);if($u){[void]$o.Append('root '+(b $n)+' '+(b $u)+[char]10)}}}}",
  "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Google\\DriveFS\\Share');if($k){$v=$k.GetValue('SyncTargets');if($v -is [byte[]] -and $v.Length -gt 0){[void]$o.Append('drivefs '+[Convert]::ToBase64String($v)+[char]10)}}",
  "[void]$o.Append('end')",
  "[Console]::Out.Write($o.ToString())",
].join("\n");

/** The fields of each kind of line the script writes. */
const FIELDS = { drive: 4, onedrive: 1, root: 2, drivefs: 1 } as const;

/**
 * The facts the script wrote, each line checked; undefined when the output is not exactly that (a
 * line of another shape, a field that is not base64 of UTF-8, or no `end`: a cut-off run), which
 * leaves a folder unchecked (sync-folders.ts).
 */
export function parseWindowsFacts(output: string): WindowsSyncFacts | undefined {
  const lines = output.trimEnd().split("\n");
  if (lines.pop() !== "end") return undefined;
  const facts = {
    oneDriveAccounts: [] as string[],
    syncRoots: [] as { id: string; path: string }[],
    driveFsTargets: "",
    drives: [] as WindowsSyncFacts["drives"][number][],
  };
  for (const line of lines) {
    const [kind = "", ...fields] = line.split(" ");
    if (!Object.hasOwn(FIELDS, kind) || fields.length !== FIELDS[kind as keyof typeof FIELDS]) {
      return undefined;
    }
    if (kind === "drivefs") {
      // Kept as base64: readDriveFs decodes the bytes, which are no text.
      const [value = ""] = fields;
      if (!BASE64.test(value)) return undefined;
      facts.driveFsTargets = value;
      continue;
    }
    const texts = fields.map(base64Text);
    if (texts.some((t) => t === undefined)) return undefined;
    const [a = "", b = "", c = "", d = ""] = texts as string[];
    if (kind === "drive") facts.drives.push({ root: a, type: b, format: c, label: d });
    else if (kind === "onedrive") {
      if (a !== "") facts.oneDriveAccounts.push(a);
    } else if (a !== "" && b !== "") facts.syncRoots.push({ id: a, path: b });
  }
  return facts;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A base64 field's UTF-8 text, or undefined when it is not exactly that. */
function base64Text(field: string): string | undefined {
  if (!BASE64.test(field)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(field, "base64"));
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
  /** Windows' facts; default: windowsFactsOnce(). Tests and the test entry pass their own. */
  readonly windowsFacts?: () => Promise<WindowsSyncFacts | undefined>;
}

/** One PowerShell run of the script: this machine's facts, or undefined. */
export function readWindowsFacts(): Promise<WindowsSyncFacts | undefined> {
  const folder = system32();
  if (folder === undefined) return Promise.resolve(undefined);
  return run(
    win32.join(folder, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
    `${WINDOWS_SCRIPT}\n`,
  ).then((out) => (out === undefined ? undefined : parseWindowsFacts(out)));
}

/** `read` (the PowerShell run), at most once a minute per host while it answers. */
export function windowsFactsOnce(
  read: () => Promise<WindowsSyncFacts | undefined> = readWindowsFacts,
  clock: () => number = Date.now,
): () => Promise<WindowsSyncFacts | undefined> {
  let cached: { at: number; facts: Promise<WindowsSyncFacts | undefined> } | undefined;
  return () => {
    const now = clock();
    if (cached !== undefined && now - cached.at < FACTS_TTL_MS) return cached.facts;
    const facts = read();
    const entry = { at: now, facts };
    cached = entry;
    // Checks that start while the run goes share it. A run that gave no facts is not kept: the
    // next check runs again, so one slow or failed run leaves only the folders it was for unchecked.
    void facts.then((answer) => {
      if (answer === undefined && cached === entry) cached = undefined;
    });
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
