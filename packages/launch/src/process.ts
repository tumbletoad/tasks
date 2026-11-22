// A process's identity: its PID and its start time exactly as the OS records it (A4 3.1, 3.6.3).
// A PID alone is reused once its process has ended; a PID with the start time names one process
// for as long as the OS runs. The attachment credential is bound to both, so a reused PID is
// never taken for the shim, and the credential ends with the process.
//
// - Linux: field 22 of /proc/<pid>/stat, the start time in clock ticks since boot, with the boot's
//   ID from /proc/sys/kernel/random/boot_id, because ticks since boot repeat across boots. A
//   zombie (state Z) has ended. Reading /proc costs a file read.
// - Windows: the creation time the kernel records (GetProcessTimes), as a FILETIME: 100 ns since
//   1601, absolute, so unique per PID. Node exposes no Win32 call, so Windows PowerShell 5.1, which
//   every Windows has, reads `Process.StartTime.ToFileTimeUtc()` (GetProcessTimes underneath) for
//   a batch of PIDs at once: about 170 ms per call on Windows 11. A PID that `process.kill(pid,
//   0)` finds gone skips it. PowerShell is started by its full path under SystemRoot, without a
//   shell, and its script holds only integers checked here.
// - macOS (no Mac yet, not built and not tested): the exact start time is `proc_pidinfo` with
//   PROC_PIDTBSDINFO (`pbi_start_tvsec`, `pbi_start_tvusec`) or sysctl KERN_PROC_PID
//   (`kp_proc.p_starttime`), both native calls; `ps -o lstart=` gives whole seconds only, which is
//   not exact. Until a native helper exists the check throws ProcessCheckFailed on macOS.
//
// This module imports Node built-ins only: the shim loads it to read its own start time.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";

/** The OS could not tell, or this OS has no exact check: never read as "the process is gone". */
export class ProcessCheckFailed extends Error {
  override readonly name = "ProcessCheckFailed";
}

/** Reads start times. The service and the shim use the OS's; tests pass a fake. */
export interface ProcessProbe {
  /** The start time of each PID that names a live process; an ended one is left out. */
  startTimes(pids: readonly number[]): Promise<ReadonlyMap<number, string>>;
  /**
   * Whether the process may still run, answered at once for a page that is waiting: false only
   * when it has certainly ended. Without it, a process counts as running until the PID check.
   */
  mayRun?(pid: number, startTime: string): boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const validPids = (pids: readonly number[]): number[] =>
  [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647);

/** Linux: `linux:<boot id>:<start ticks>`, or undefined for a process that is gone or a zombie. */
export function linuxStartTime(pid: number, proc = "/proc"): string | undefined {
  let stat: string;
  try {
    stat = readFileSync(`${proc}/${String(pid)}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw new ProcessCheckFailed("The process table could not be read");
  }
  // The command name (field 2) may hold spaces and parentheses: the fields after it follow the
  // last closing parenthesis.
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = after[0];
  const ticks = after[19]; // field 22
  if (state === undefined || ticks === undefined || !/^\d{1,20}$/.test(ticks)) {
    throw new ProcessCheckFailed("The process table has an unexpected form");
  }
  if (state === "Z" || state === "X") return undefined;
  let boot: string;
  try {
    boot = readFileSync(`${proc}/sys/kernel/random/boot_id`, "utf8").trim();
  } catch {
    throw new ProcessCheckFailed("The boot ID could not be read");
  }
  if (!BOOT_ID.test(boot)) throw new ProcessCheckFailed("The boot ID has an unexpected form");
  return `linux:${boot}:${ticks}`;
}

/** Whether a PID may name a live process of this user: `kill(pid, 0)` without a signal. */
function mayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: a process of another user, which is not a shim of ours.
    // Anything else cannot tell, and PowerShell decides.
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EPERM";
  }
}

/** Windows PowerShell 5.1 by its full path: present on every Windows. */
export function powershellPath(env: Env): string {
  const root = Object.entries(env).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1];
  const base = root !== undefined && win32.isAbsolute(root) ? root : "C:\\Windows";
  return win32.join(base, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** How long one PowerShell read may take before it is killed and the check fails. */
export const WINDOWS_READ_MS = 15_000;

/** Windows: `windows:<FILETIME>` per live PID, read by one PowerShell call. */
export async function windowsStartTimes(
  pids: readonly number[],
  env: Env = process.env,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const live = validPids(pids).filter(mayBeAlive);
  if (live.length === 0) return out;
  // Integers only: nothing else reaches the script.
  const script =
    `foreach ($p in @(${live.map(String).join(",")})) { try { ` +
    `$x = [System.Diagnostics.Process]::GetProcessById($p); ` +
    `[Console]::Out.WriteLine(([string]$p) + ' ' + $x.StartTime.ToFileTimeUtc()) } catch { } }`;
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      powershellPath(env),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 1_000_000) output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new ProcessCheckFailed("Reading process start times took too long"));
    }, WINDOWS_READ_MS);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new ProcessCheckFailed("PowerShell could not be started"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new ProcessCheckFailed("PowerShell could not read the start times"));
    });
  });
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d{1,10}) (\d{1,20})$/.exec(line.trim());
    if (match === null) continue;
    const pid = Number(match[1]);
    if (live.includes(pid)) out.set(pid, `windows:${match[2] ?? ""}`);
  }
  return out;
}

/** The start times of `pids` as this OS records them. Throws ProcessCheckFailed when it cannot tell. */
export async function startTimes(
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
): Promise<Map<number, string>> {
  if (platform === "linux") {
    const out = new Map<number, string>();
    for (const pid of validPids(pids)) {
      const time = linuxStartTime(pid);
      if (time !== undefined) out.set(pid, time);
    }
    return out;
  }
  if (platform === "win32") return windowsStartTimes(pids, env);
  throw new ProcessCheckFailed("This OS has no exact process start time check yet");
}

/**
 * Whether the process may still run, without waiting: exact on Linux, where the start time costs
 * a file read; elsewhere by its PID alone, so a reused PID reads as running until the PID check,
 * which asks the exact start time.
 */
export function mayRun(
  pid: number,
  startTime: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "linux") {
    try {
      return linuxStartTime(pid) === startTime;
    } catch {
      return true;
    }
  }
  return mayBeAlive(pid);
}

/** The probe of this OS. */
export const osProbe: ProcessProbe = {
  startTimes: (pids) => startTimes(pids),
  mayRun: (pid, startTime) => mayRun(pid, startTime),
};

/** This process's own start time. */
export async function ownStartTime(): Promise<string> {
  const time = (await startTimes([process.pid])).get(process.pid);
  if (time === undefined) throw new ProcessCheckFailed("This process's start time was not found");
  return time;
}
