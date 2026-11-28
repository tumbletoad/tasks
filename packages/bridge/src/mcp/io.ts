// The bridge's process: its streams, its signals and its last-resort error handler. This is the
// only file of the bridge that names stdout (a lint rule enforces it): stdout carries MCP frames
// and nothing else, and the forwarder is the one writer. Diagnostics go to stderr.
import process from "node:process";
import type { Readable, Writable } from "node:stream";

/** What the bridge needs from its process. Tests pass their own. */
export interface McpIo {
  readonly input: Readable;
  readonly output: Writable;
  /** stderr: content-free diagnostics only. */
  readonly error: Writable;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly cwd: () => string;
  readonly pid: number;
  readonly ppid: number;
  readonly tty: { readonly stdin: boolean; readonly stdout: boolean };
}

/** A stdio stream's isTTY is undefined, not false, on a pipe or file, whatever its type says. */
const isTty = (stream: unknown): boolean => (stream as { isTTY?: unknown }).isTTY === true;

export function processIo(): McpIo {
  return {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    env: process.env,
    platform: process.platform,
    cwd: () => process.cwd(),
    pid: process.pid,
    ppid: process.ppid,
    tty: { stdin: isTty(process.stdin), stdout: isTty(process.stdout) },
  };
}

/**
 * Signals end the session like a closed stdin (MCP's stdio shutdown sends SIGTERM after closing
 * stdin). An error nothing caught ends the process at once with exit 1 and one line naming only
 * the error's class: Node's own report would print the message, which can hold peer text.
 */
export function watchProcess(stop: () => void, say: (text: string) => void): void {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, stop);
  const fail = (error: unknown): void => {
    const name =
      error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
    say(`internal error (${name})`);
    process.exit(1);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
}
