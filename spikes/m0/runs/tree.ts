// Process trees for lab run N (M0.11): which processes an agent started, and which of them are
// still there after a cancel. Windows through the console-ctrl helper's `list` (Toolhelp32 plus
// each process's creation time), Linux through /proc. Executable names only, never command lines.
// A process is identified by PID, executable name AND start time, so a PID the OS reused for
// another program is never taken for a survivor and never swept.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { LabError } from "../agents/facts.ts";

export interface Proc {
  pid: number;
  ppid: number;
  exe: string;
  /** Start time: a Windows FILETIME or Linux clock ticks since boot, as text; "0" if unknown. */
  start: string;
}

/** Parses the helper's `list` output: `[[pid, ppid, "exe", "start"], ...]`. */
export function parseHelperList(text: string): Proc[] {
  const rows = JSON.parse(text) as [number, number, string, string?][];
  return rows.map(([pid, ppid, exe, start]) => ({ pid, ppid, exe, start: start ?? "0" }));
}

/** Parses one /proc/<pid>/stat line: the command is in parentheses and may hold spaces. */
export function parseProcStat(line: string): Proc | undefined {
  const open = line.indexOf("(");
  const close = line.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = Number(line.slice(0, open).trim());
  const rest = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0] is field 3 (state): ppid is field 4, starttime field 22.
  const ppid = Number(rest[1]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return undefined;
  const start = rest[19] !== undefined && /^\d+$/.test(rest[19]) ? rest[19] : "0";
  return { pid, ppid, exe: line.slice(open + 1, close), start };
}

/** Every process on the machine. On Windows `helper` is the console-ctrl executable. */
export function listProcesses(helper?: string): Proc[] {
  if (process.platform === "win32") {
    if (helper === undefined) throw new LabError("the console-ctrl helper is needed on Windows");
    const r = spawnSync(helper, ["list"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    if (r.status !== 0) throw new LabError("console-ctrl list failed");
    return parseHelperList(r.stdout);
  }
  const out: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const p = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
      if (p !== undefined) out.push(p);
    } catch {
      // gone in between
    }
  }
  return out;
}

/** `root` and every process below it, root first, parents before children. */
export function descendants(all: readonly Proc[], root: number): Proc[] {
  const byParent = new Map<number, Proc[]>();
  for (const p of all) {
    if (p.pid === p.ppid) continue;
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const self = all.find((p) => p.pid === root);
  const out: Proc[] = self === undefined ? [] : [self];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of byParent.get(pid) ?? []) {
      // A child must have started after its parent, or the PID was reused (Windows keeps the
      // parent PID of an orphan, which a new process may now own).
      if (
        seen.has(child.pid) ||
        !startedAfter(
          child,
          all.find((p) => p.pid === pid),
        )
      )
        continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

function startedAfter(child: Proc, parent: Proc | undefined): boolean {
  if (parent === undefined || child.start === "0" || parent.start === "0") return true;
  return BigInt(child.start) >= BigInt(parent.start);
}

const sameProcess = (a: Proc, b: Proc) =>
  a.pid === b.pid && a.exe === b.exe && (a.start === "0" || b.start === "0" || a.start === b.start);

/** The members of `before` that still exist: same PID, executable name and start time. */
export function survivors(before: readonly Proc[], now: readonly Proc[]): Proc[] {
  return before.filter((p) => now.some((q) => sameProcess(p, q)));
}

/**
 * Ends the processes of `procs` that are still the same processes: the list is taken again right
 * before each kill, so a PID reused in between is left alone. Forced (taskkill /F, SIGKILL): the
 * graceful step of the run already happened. Returns the processes it signalled.
 */
export function sweep(procs: readonly Proc[], helper: string | undefined): Proc[] {
  const done: Proc[] = [];
  for (const p of procs) {
    let now: Proc[];
    try {
      now = listProcesses(helper);
    } catch {
      return done;
    }
    if (!now.some((q) => sameProcess(p, q))) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { windowsHide: true, timeout: 15_000 });
    } else {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    done.push(p);
  }
  return done;
}
