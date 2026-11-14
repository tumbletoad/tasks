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
//   run is not kept. Any failure, a read inside the run included, gives no facts, which leaves a
//   folder unchecked (sync-folders.ts); the environment variables, the markers and UNC paths still
//   count.
// - Linux: `fs.statfs`'s type and /proc/self/mountinfo (bounded). macOS: /sbin/mount's output.
import { spawn } from "node:child_process";
import { lstat, open, readdir, realpath, stat, statfs } from "node:fs/promises";
import os from "node:os";
import { win32 } from "node:path";
import { base64Text, isBase64, REGISTRY_READS } from "@tasks/launch";
import { system32 } from "./identity.ts";
import type { SyncHost, WindowsSyncFacts } from "./sync-folders.ts";

const FACTS_TTL_MS = 60_000;
const RUN_TIMEOUT_MS = 10_000;
const OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/** The strings a section accepts for a path: REG_SZ, and REG_EXPAND_SZ expanded. */
const TEXT = "@('String','ExpandString')";

/**
 * The script's sections, one statement each, each reading one kind of fact through the reads of
 * @tasks/launch's windows-reads.ts: a key or a value that is not there is no fact, but a read that
 * fails throws, and so does a value of another kind than the section knows. Each .NET property is
 * read through its accessor method, since PowerShell 5.1 turns a getter's exception into $null.
 */
const SECTIONS = [
  // A network drive's label and format are not read: IsReady on a disconnected one waits for the
  // network's time-out, and the label that counts (Google Drive's) is a local drive's. Another
  // drive is listed only when it is ready, with its label: IsReady also says false when it fails,
  // so a folder on a drive left out is unlisted, and unchecked after a fresh run (sync-folders.ts).
  "foreach($x in [IO.DriveInfo]::GetDrives()){$t=$x.get_DriveType().ToString();$f='';$l='';if($t -ne 'Network'){if(-not $x.get_IsReady()){continue};$f=$x.get_DriveFormat();$l=$x.get_VolumeLabel()};[void]$o.Append('drive '+(b $x.get_Name())+' '+(b $t)+' '+(b $f)+' '+(b $l)+[char]10)}",
  `$k=key ([Microsoft.Win32.Registry]::CurrentUser) 'Software\\Microsoft\\OneDrive\\Accounts';if($k){foreach($n in $k.GetSubKeyNames()){$u=val (sk $k $n) 'UserFolder' ${TEXT};if($u){[void]$o.Append('onedrive '+(b $u)+[char]10)}}}`,
  `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().get_User().get_Value();if(-not $sid){throw 'sid'};$k=key ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager';if($k){foreach($n in $k.GetSubKeyNames()){$r=sk (sk $k $n) 'UserSyncRoots';if($r){$u=val $r $sid ${TEXT};if($u){[void]$o.Append('root '+(b $n)+' '+(b $u)+[char]10)}}}}`,
  "$k=key ([Microsoft.Win32.Registry]::CurrentUser) 'Software\\Google\\DriveFS\\Share';if($k){$v=val $k 'SyncTargets' @('Binary');if($null -ne $v -and $v.get_Length() -gt 0){[void]$o.Append('drivefs '+[Convert]::ToBase64String($v)+[char]10)}}",
];

/**
 * The script, one statement per line, read from stdin by `powershell -Command -`. It writes one
 * line per fact, each field in base64 of UTF-8, then a last line `end`:
 *   drive <root> <type> <format> <label>
 *   onedrive <UserFolder>
 *   root <SyncRootManager key> <path>
 *   drivefs <SyncTargets>            (its bytes, base64 once)
 * It calls .NET only, never a cmdlet: Windows PowerShell finds a cmdlet by searching the modules on
 * its module path, whose cost depends on the modules a machine has (A1 3.2's pitfalls).
 *
 * It reads every fact or gives none (A1 3.2): `end` is written only when every section finished.
 * A section that throws ends in its own catch, and the run still ends normally, without `end`, so
 * a read that failed is never taken for a key that is not there. Counting the finished sections,
 * rather than noting a failure, also covers a line PowerShell did not run at all: `-Command -`
 * runs stdin line by line and goes on after a line that fails.
 */
export const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$e=[Text.Encoding]::UTF8;$o=[Text.StringBuilder]::new();$done=0",
  "function b($s){[Convert]::ToBase64String($e.GetBytes([string]$s))}",
  REGISTRY_READS,
  ...SECTIONS.map((section) => `try{${section};$done+=1}catch{}`),
  `if($done -eq ${String(SECTIONS.length)}){[void]$o.Append('end')}`,
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
      if (!isBase64(value)) return undefined;
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

/** Runs `file` with `args`, `input` on stdin, within the bound; its stdout, or undefined. */
function run(
  file: string,
  args: readonly string[],
  input: string,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<string | undefined> {
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
    }, timeoutMs);
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
  readonly windowsFacts?: (fresh?: boolean) => Promise<WindowsSyncFacts | undefined>;
}

/**
 * One run of `script` on stdin by System32's Windows PowerShell 5.1, within `timeoutMs`: its
 * stdout when it exits 0, or undefined.
 */
export function runWindowsScript(
  script: string,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<string | undefined> {
  const folder = system32();
  if (folder === undefined) return Promise.resolve(undefined);
  return run(
    win32.join(folder, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
    `${script}\n`,
    timeoutMs,
  );
}

/** One run of the facts script: this machine's facts, or undefined. */
export function readWindowsFacts(
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<WindowsSyncFacts | undefined> {
  return runWindowsScript(WINDOWS_SCRIPT, timeoutMs).then((out) =>
    out === undefined ? undefined : parseWindowsFacts(out),
  );
}

/**
 * `read` (the PowerShell run), at most once a minute per host while it answers, unless a check asks
 * for a `fresh` run (a drive the kept answer does not list).
 */
export function windowsFactsOnce(
  read: () => Promise<WindowsSyncFacts | undefined> = readWindowsFacts,
  clock: () => number = Date.now,
): (fresh?: boolean) => Promise<WindowsSyncFacts | undefined> {
  let cached: { at: number; facts: Promise<WindowsSyncFacts | undefined> } | undefined;
  return (fresh = false) => {
    const now = clock();
    if (!fresh && cached !== undefined && now - cached.at < FACTS_TTL_MS) return cached.facts;
    const facts = read();
    const entry = { at: now, facts };
    cached = entry;
    // Checks that start while the run goes share it. A run that gave no facts, or rejected, is not
    // kept: the next check runs again, so one slow or failed run leaves only the folders it was for
    // unchecked. A rejection reaches the callers through `facts`; this watcher only forgets it.
    const forget = (): void => {
      if (cached === entry) cached = undefined;
    };
    void facts.then((answer) => {
      if (answer === undefined) forget();
    }, forget);
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
