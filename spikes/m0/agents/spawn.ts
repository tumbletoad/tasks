// The clean spawner of lab run A (M0.09). This lab runs inside an agent session itself, so its own
// environment carries CLAUDECODE, CLAUDE_CODE_*, ANTHROPIC_*, CODEX_*, T3CODE_* and MCP_*
// variables. A CLI that inherited them would hand them on to the probe, and A01 and A02 would
// prove nothing. Every CLI the lab starts therefore gets an environment built from scratch: the
// allow-list below, taken from the lab's own environment, plus only the variables the sub-check
// sets (EXTRA_NAMES). Nothing else passes, and no shell is involved.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/**
 * Taken from the parent when present. The OS basics, the home and profile folders, and what the
 * CLIs proved to need on Windows 11 and Ubuntu 24.04 (2026-11-12): Claude Code and Codex on
 * Windows read HOMEDRIVE and HOMEPATH, ProgramFiles to find Git Bash, and ComSpec and PATHEXT to
 * run commands.
 */
export const BASE_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "ProgramW6432",
  "CommonProgramFiles",
  "SystemRoot",
  "windir",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

/** The only variables a sub-check may add. Anything else is refused. */
export const EXTRA_NAMES = [
  "TASKS_TICKET",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CLAUDE_CODE_MCP_ALLOWLIST_ENV",
  "ENABLE_TOOL_SEARCH",
  "TASKS_HOME",
] as const;

/** Prefixes that must never reach a child unless the sub-check set them itself. */
export const FORBIDDEN_PREFIXES = [
  "CLAUDECODE",
  "CLAUDE_CODE_",
  "CLAUDE_AGENT_",
  "ANTHROPIC_",
  "CODEX_",
  "T3CODE_",
  "MCP_",
  "OPENAI_",
] as const;

export type ExtraName = (typeof EXTRA_NAMES)[number];

const fold = (name: string, win: boolean) => (win ? name.toUpperCase() : name);

/**
 * The environment for one child: the allow-listed names from `parent` (matched without case on
 * Windows, where `Path` and `PATH` are one variable) and the given extras. `PATH` may be replaced,
 * for example by a login shell's PATH on Linux.
 */
export function cleanEnv(
  parent: NodeJS.ProcessEnv,
  extra: Partial<Record<ExtraName, string>> = {},
  options: { win?: boolean; path?: string } = {},
): Record<string, string> {
  const win = options.win ?? process.platform === "win32";
  const wanted = new Set(BASE_NAMES.map((n) => fold(n, win)));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || !wanted.has(fold(name, win))) continue;
    env[name] = value;
  }
  let result = env;
  if (options.path !== undefined) {
    result = Object.fromEntries(Object.entries(env).filter(([name]) => fold(name, win) !== "PATH"));
    result["PATH"] = options.path;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!(EXTRA_NAMES as readonly string[]).includes(name)) {
      throw new Error(`not an allowed extra variable: ${name}`);
    }
    result[name] = value;
  }
  return result;
}

/** Names in `env` that carry a forbidden prefix and were not set by the sub-check. */
export function forbiddenNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter(
    (name) =>
      !(EXTRA_NAMES as readonly string[]).includes(name) &&
      FORBIDDEN_PREFIXES.some((p) => name.toUpperCase().startsWith(p)),
  );
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  pid: number | undefined;
}

export interface RunOptions {
  env: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
  stdin?: string;
  /** Called once with the child's PID, so the lab can record what it started. */
  onPid?: (pid: number) => void;
  /** How long the child gets after the graceful signal before it is forced (default 3 s). */
  graceMs?: number;
  /** How long to wait for the pipes to close after the child exited (default 2 s). */
  closeWaitMs?: number;
}

// ---------------------------------------------------------------------------------------------
// One cleanup path for every child the lab starts (CLIs through `run`, stand-in services through
// `track`): a graceful signal, a bounded wait, then a forced end. On POSIX each child is started
// in its own process group (`detached`), and the whole group is signalled, so an MCP server or a
// sandbox helper the CLI started ends with it. On Windows there is no graceful signal for a
// console-less child: the end is `taskkill /T /F` on the recorded PID (that process and the
// processes it started), and only while that PID still belongs to the child.

const POSIX = process.platform !== "win32";
const GRACE_MS = 3_000;
const live = new Set<ChildProcess>();
const grouped = new WeakSet<ChildProcess>();

const hasExited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

/** Adds a child to the cleanup path. `group`: it was started with `detached` on POSIX. */
export function track(child: ChildProcess, group = POSIX): void {
  if (group && POSIX) grouped.add(child);
  live.add(child);
  child.once("exit", () => live.delete(child));
}

/** Children started and not yet ended. */
export function liveChildren(): number {
  return [...live].filter((c) => !hasExited(c)).length;
}

function signal(child: ChildProcess, sig: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (POSIX && grouped.has(child)) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // the group is gone: fall through to the child itself
    }
  }
  if (!POSIX && !hasExited(child)) {
    const taskkill = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");
    const r = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 10_000,
    });
    if (r.status === 0) return;
  }
  try {
    child.kill(sig);
  } catch {
    // already gone
  }
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      done(hasExited(child));
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      done(true);
    };
    child.once("exit", onExit);
  });
}

/** Ends one child: graceful signal, a bounded wait, then forced; on POSIX its group too. */
export async function endChild(child: ChildProcess, graceMs = GRACE_MS): Promise<void> {
  if (!hasExited(child)) {
    signal(child, "SIGTERM");
    if (!(await waitExit(child, graceMs))) {
      signal(child, "SIGKILL");
      await waitExit(child, graceMs);
    }
  }
  // Members left in the child's group (a grandchild holding a pipe) end with it.
  if (POSIX && grouped.has(child) && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // no group left
    }
  }
  live.delete(child);
}

/** Ends every child still running: the one cleanup path for a normal end, an error and signals. */
export async function endAll(graceMs = GRACE_MS): Promise<void> {
  await Promise.all([...live].map((c) => endChild(c, graceMs)));
}

let installed = false;
/**
 * On SIGINT and SIGTERM: run `before` (for example a stand-in service's own shutdown call), end
 * every child, and exit with 130 or 143. Installed once per process.
 */
export function installCleanup(before?: () => Promise<void>): void {
  if (installed) return;
  installed = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      void (async () => {
        try {
          await before?.();
        } catch {
          // the forced end below still runs
        }
        await endAll();
        process.exit(sig === "SIGINT" ? 130 : 143);
      })();
    });
  }
}

/** Runs `file` with `args`, no shell, the given environment only. Ends the child at timeout. */
export function run(
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const leaked = forbiddenNames(options.env);
  if (leaked.length > 0) return Promise.reject(new Error(`refusing to pass ${leaked.join(", ")}`));
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: POSIX,
    });
    track(child);
    if (child.pid !== undefined) options.onPid?.(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let closeTimer: NodeJS.Timeout | undefined;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      void endChild(child, options.graceMs ?? GRACE_MS);
    }, options.timeoutMs ?? 180_000);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      live.delete(child);
      resolve({
        code: child.exitCode,
        signal: child.signalCode,
        stdout,
        stderr,
        ms: Math.round(performance.now() - t0),
        timedOut,
        pid: child.pid,
      });
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      reject(error);
    });
    // A grandchild can hold the pipes open after the child exited: wait a bounded time, then end
    // the child's group (POSIX), drop the pipes and return.
    child.on("exit", () => {
      closeTimer = setTimeout(() => {
        if (POSIX && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // no group left
          }
        }
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        finish();
      }, options.closeWaitMs ?? 2_000);
    });
    child.on("close", finish);
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}
