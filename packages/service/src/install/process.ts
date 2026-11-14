// Running the OS's tools (systemctl, loginctl, launchctl, reg.exe, tasklist.exe, explorer.exe) and
// starting a detached service. Never through a shell: the program and an argument array.
import { execFile, spawn } from "node:child_process";

export interface RunResult {
  /** The exit code, or null when the program did not start or was stopped. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Why the program did not run (`ENOENT`, `ETIMEDOUT`), else undefined. */
  readonly failure?: string | undefined;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  /**
   * Windows: pass the arguments as written, without Node's quoting, which quotes only an argument
   * with a space or a quote in it. explorer.exe splits an unquoted argument at its commas.
   */
  readonly verbatim?: boolean;
}

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

/** How long a tool may run unless its caller gives less. */
export const TOOL_TIMEOUT_MS = 30_000;

/** A tool's run: 30 s at most, output capped at 4 MiB, no window. */
export const runProcess: Runner = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        windowsVerbatimArguments: options.verbatim === true,
        timeout: options.timeoutMs ?? TOOL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof error.code === "number" ? error.code : null;
        const failure = typeof error.code === "string" ? error.code : undefined;
        resolve({ code, stdout, stderr, failure: error.killed ? "ETIMEDOUT" : failure });
      },
    );
  });

/**
 * Starts a program detached from this process: its own session on Linux and macOS (setsid), no
 * console and a new process group on Windows, no standard handles. The caller does not wait.
 */
export function startDetached(file: string, args: readonly string[]): void {
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}
