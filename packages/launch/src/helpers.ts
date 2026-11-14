// The helper runner (A3 3.14): the one way setup, detection and doctor start a program and wait
// for it, and the one owner of every such program's life. Nothing else in those modules starts a
// child: dependency-cruiser's `helpers-through-the-runner` refuses `node:child_process` there.
//
// - A helper runs without a shell or a window, with only the environment and folder it is given,
//   and with a deadline. A `.cmd`, `.bat` or `.ps1` file is never run (A4 3.2). On Linux and macOS
//   it leads a process group of its own (spawned `detached`).
// - The runner keeps every helper it started until the helper exits. Ending a helper ends its
//   tree: on Linux and macOS SIGKILL to its group; on Windows the system's taskkill /T /F, by its
//   full path, then the helper itself.
// - The tree is ended synchronously at the deadline, on `stop`, and when this process exits, so
//   an exit cannot outrun it: the process exits through `process.exit` (Ctrl+C in the CLI exits
//   130), at the end of its event loop, or on SIGTERM or SIGHUP (SIGHUP or SIGBREAK on Windows),
//   which the runner turns into an exit while a helper runs, unless another listener owns them.
// - When a helper exits by itself, on Linux and macOS what it left in its group is killed at once.
//   On Windows the system ends nothing of it: only the deadline, `stop` and the exit do.
//
// What remains: a program that leaves its group (setsid), and on Windows a process whose parent
// already exited (taskkill /T walks a tree only from a running process), cannot be found from the
// helper, because Node has no job objects of its own. A process killed without its exit (SIGKILL,
// a crash of the runtime) ends nothing.
//
// This module imports Node built-ins only.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { win32 } from "node:path";

/** Whether a child spawned on `platform` leads its own process group (`detached`). */
export const ownsGroup = (platform: NodeJS.Platform): boolean => platform !== "win32";

/** How long taskkill may take to end a tree. */
const TASKKILL_MS = 10_000;
/** After a kill, how long `ended` waits for the exit before it settles anyway. */
const KILL_GRACE_MS = 5_000;
/** After an exit, how long a descendant may hold this process's end of a pipe open. */
const PIPE_GRACE_MS = 1_000;

/** The helpers still running, which the runner ends when this process exits. */
const running = new Set<ChildProcess>();

/** Ends `child` and every process it started that can still be found, before it returns. */
function endTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (ownsGroup(process.platform)) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The group is gone: only the child itself may be left.
    }
    child.kill("SIGKILL");
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  spawnSync(
    win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"),
    ["/T", "/F", "/PID", String(pid)],
    { stdio: "ignore", shell: false, windowsHide: true, timeout: TASKKILL_MS },
  );
  // Whatever taskkill did, the helper itself goes.
  child.kill("SIGKILL");
}

function endAll(): void {
  for (const child of [...running]) endTree(child);
}

const SIGNALS: readonly NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGHUP", "SIGBREAK"] : ["SIGTERM", "SIGHUP"];

/**
 * A signal that would end this process without its exit handlers: the helpers end first. When no
 * other listener takes the signal, the process exits as the signal's default action would.
 */
function onSignal(signal: NodeJS.Signals): void {
  endAll();
  unwatchSignals();
  if (process.listenerCount(signal) === 0) process.exit(128 + constants.signals[signal]);
}

let watching = false;
function watchSignals(): void {
  if (watching) return;
  watching = true;
  for (const signal of SIGNALS) process.on(signal, onSignal);
}
function unwatchSignals(): void {
  if (!watching) return;
  watching = false;
  for (const signal of SIGNALS) process.removeListener(signal, onSignal);
}

let hooked = false;
function track(child: ChildProcess): void {
  if (!hooked) {
    hooked = true;
    process.on("exit", endAll);
  }
  running.add(child);
  watchSignals();
}
function untrack(child: ChildProcess): void {
  running.delete(child);
  if (running.size === 0) unwatchSignals();
}

export interface HelperOptions {
  /** The whole environment the program gets. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** How long it may run: at the deadline it is ended with what it started. */
  readonly deadlineMs: number;
  /** The standard streams that are pipes to this process; the others are ignored. */
  readonly stdin?: boolean;
  readonly stdout?: boolean;
  readonly stderr?: boolean;
}

export interface Helper {
  readonly child: ChildProcess;
  /**
   * Its exit code once it exits; null when it could not start, or the deadline or `stop` ended
   * it. After a kill it settles at the latest a grace later, exit or not.
   */
  readonly ended: Promise<number | null>;
  /** Whether the deadline ended it. */
  timedOut(): boolean;
  /** Ends it now with what it started, and closes this process's ends of its pipes. */
  stop(): void;
}

const isShim = (file: string): boolean => /\.(cmd|bat|ps1)$/iu.test(file);

/** Starts a helper. Throws when it cannot be started at all (no program, a shim). */
export function startHelper(argv: readonly string[], options: HelperOptions): Helper {
  const [file, ...args] = argv;
  if (file === undefined || file === "") throw new Error("no program to run");
  if (isShim(file)) throw new Error("a shim is never run");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.env)) if (v !== undefined) env[k] = v;
  const child = spawn(file, args, {
    env,
    cwd: options.cwd,
    stdio: [
      options.stdin === true ? "pipe" : "ignore",
      options.stdout === true ? "pipe" : "ignore",
      options.stderr === true ? "pipe" : "ignore",
    ],
    shell: false,
    windowsHide: true,
    detached: ownsGroup(process.platform),
  });
  track(child);
  child.stdin?.on("error", () => undefined);
  const closePipes = () => {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  let late = false;
  let ended = false;
  let settle: (code: number | null) => void = () => undefined;
  const done = new Promise<number | null>((resolve) => {
    settle = (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      resolve(code);
    };
  });
  let killed = false;
  const stop = () => {
    if (ended && !running.has(child)) return;
    killed = true;
    endTree(child);
    closePipes();
    // The exit settles it; a program the kill could not reach yet does not keep the caller.
    setTimeout(() => {
      settle(null);
    }, KILL_GRACE_MS).unref();
  };
  const deadline = setTimeout(() => {
    late = true;
    stop();
  }, options.deadlineMs);
  child.once("exit", (code) => {
    untrack(child);
    // What it left in its group goes with it.
    if (ownsGroup(process.platform)) endTree(child);
    // Output still in a pipe is read first; a process it left may hold a pipe open.
    setTimeout(closePipes, PIPE_GRACE_MS).unref();
    settle(killed ? null : code);
  });
  child.once("error", () => {
    untrack(child);
    closePipes();
    settle(null);
  });
  return { child, ended: done, timedOut: () => late, stop };
}

export interface OutputOptions extends Pick<HelperOptions, "env" | "cwd" | "deadlineMs"> {
  /** At most this many characters of its output are read: more is no answer. */
  readonly maxChars: number;
}

/**
 * A helper's stdout when it exits 0 within its deadline and its output's bound; undefined
 * otherwise, also when it cannot be started.
 */
export async function helperOutput(
  argv: readonly string[],
  options: OutputOptions,
): Promise<string | undefined> {
  let helper: Helper;
  try {
    helper = startHelper(argv, { ...options, stdout: true });
  } catch {
    return undefined;
  }
  const stdout = helper.child.stdout;
  const read = { text: "", over: false };
  const closed = new Promise<void>((resolve) => {
    if (stdout === null) {
      resolve();
      return;
    }
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      if (read.over) return;
      read.text += chunk;
      if (read.text.length > options.maxChars) {
        read.over = true;
        helper.stop();
      }
    });
    stdout.once("close", resolve);
  });
  const code = await helper.ended;
  await closed;
  return code === 0 && !read.over ? read.text : undefined;
}
