// The helper runner: the one way setup, detection and doctor start a program and wait
// for it, and the one owner of every such program's life. Nothing else in those modules starts a
// child: dependency-cruiser's `helpers-through-the-runner` refuses `node:child_process` there.
//
// - A helper runs without a shell or a window, with only the environment and folder it is given,
//   and with a deadline. A `.cmd`, `.bat` or `.ps1` file is never run. On Linux and macOS
//   it leads a process group of its own (spawned `detached`).
// - The runner keeps every helper it started until the helper exits. Ending a helper ends its
//   tree: on Linux and macOS SIGKILL to its group; on Windows the system's taskkill /T /F, by its
//   full path, then the helper itself.
// - While the helper is alive, its tree is ended synchronously at the deadline, on `stop`, and
//   when this process exits, so an exit cannot outrun it: the process exits through `process.exit`
//   (Ctrl+C in the CLI exits 130), at the end of its event loop, or on SIGTERM or SIGHUP (SIGHUP or
//   SIGBREAK on Windows). While a helper runs, the runner ends the helpers at such a signal and
//   turns it into an exit only when the host had no listener for it, neither when the runner began
//   to watch it nor at the signal: a host's own handler, a one-shot one too, keeps its shutdown.
// - When a helper exits by itself, on Linux and macOS what it left in its group is killed at once.
//   On Windows nothing follows it: what it started and left running stays. One kind of helper is
//   meant to leave a process behind (`serves`: a clipboard tool's selection holder): it
//   leads no group, and only the helper itself is ever ended.
//
// What remains: a program that leaves its group (setsid), and on Windows anything a helper started
// that outlives the helper (taskkill /T walks a tree only from a running process), cannot be found,
// because Node has no job objects of its own. A native helper for runs is where job-object
// ownership would come from. A process killed without its exit (SIGKILL, a crash of the runtime)
// ends nothing.
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

/** The helpers started with `serves`: they lead no group, so only they themselves are ended. */
const serving = new WeakSet<ChildProcess>();

/** Ends `child` and every process it started that can still be found, before it returns. */
function endTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (serving.has(child) && ownsGroup(process.platform)) {
    // Not a group leader: a kill of `-pid` could reach another group. The helper alone goes.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return;
  }
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
 * The signals the host had a listener for when the runner began to watch: those stay the host's.
 * Decided then, never from the listeners left at the signal: Node removes a `once` listener
 * before it calls it.
 */
const hostOwned = new Set<NodeJS.Signals>();

/**
 * A signal that would end this process without its exit handlers: the helpers end first. A signal
 * the host had no listener for when the runner began to watch, and has none for now, ends the
 * process as the signal's default action would.
 */
function onSignal(signal: NodeJS.Signals): void {
  endAll();
  unwatchSignals();
  if (!hostOwned.has(signal) && process.listenerCount(signal) === 0) {
    process.exit(128 + constants.signals[signal]);
  }
}

let watching = false;
function watchSignals(): void {
  if (watching) return;
  watching = true;
  hostOwned.clear();
  for (const signal of SIGNALS) {
    if (process.listenerCount(signal) > 0) hostOwned.add(signal);
    process.on(signal, onSignal);
  }
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
  /**
   * The program forks a process that goes on serving after it exits, as a clipboard tool on Linux
   * does to hold the selection. It then leads no process group of its own, and what it
   * leaves when it exits by itself stays: that process is the tool's, as when the person runs the
   * tool in a shell. At the deadline, on `stop` and at this process's exit only the program itself
   * is ended (on Windows its tree, as for every helper).
   */
  readonly serves?: boolean;
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
    detached: ownsGroup(process.platform) && options.serves !== true,
  });
  if (options.serves === true) serving.add(child);
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
    // What it left in its group goes with it, unless what it left serves on (`serves`).
    if (ownsGroup(process.platform) && options.serves !== true) endTree(child);
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
