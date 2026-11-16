// Linux containers: each run is a child cgroup `run-<name>` of the service's own systemd user
// unit, which must have Delegate=yes. The service moves itself into the unit's child `main`, so
// the unit's cgroup holds no process of its own. A run's first process is a shell that writes its
// own PID into the run's cgroup.procs before it runs anything else (`echo` is a shell builtin: no
// process exists that could escape), then execs the agent. Every process the agent starts, with
// setsid, daemonised or ignoring signals, stays in the cgroup unless it is handed to another
// process manager (systemd-run, for one). cgroup.kill ends the whole cgroup at once, and
// cgroup.events' `populated 0` is the kernel's word that it is empty.
//
// When the service dies, systemd ends every process in the unit and removes its cgroups, the
// runs' included. So after a crash a run's cgroup is gone, which confirms it empty.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { makeDir } from "@tasks/files";
import { MAIN_CGROUP, placement, unavailableMessage } from "./placement.ts";
import {
  checkName,
  ContainerError,
  DEFAULT_RECOVER_WAIT_MS,
  type AgentExit,
  type ConfirmOptions,
  type Confirmation,
  type Contained,
  type Containers,
  type ContainerSpec,
  type ProbeResult,
  type UnavailableReason,
} from "./types.ts";

/** The wrapper's exit code when it could not join the run's cgroup. Nothing else ran. */
export const JOIN_FAILED_EXIT = 97;

// $0 is the run's cgroup.procs. fd 3 tells the service the shell joined, and is closed for the
// agent. A failed write ends the shell before the agent exists. The shell may have taken tracing
// or an `echo` function from the environment (bash as /bin/sh reads both): `set` and `unset` are
// special builtins, which no function can replace, so they turn those off first.
const WRAPPER =
  'set +x +v; unset -f echo; echo $$ > "$0" || exit 97; echo ok >&3 || exit 97; exec "$@" 3>&-';

const POLL_MS = 10;

export interface LinuxOptions {
  /** Where cgroup2 is mounted. */
  readonly cgroupRoot?: string;
  /** This process's cgroup file. */
  readonly selfCgroup?: string;
  /** The directory that exists while systemd runs as the init system. */
  readonly systemdRunDir?: string;
  /** `yes`, `no`, or undefined when systemd could not be asked: the unit's Delegate= setting. */
  readonly unitDelegate?: (unit: string) => Promise<string | undefined>;
  readonly uid?: number;
  /** The POSIX shell that joins a run's cgroup and starts the agent. */
  readonly sh?: string;
}

interface Live {
  readonly child: ChildProcess;
  readonly dir: string;
  readonly pid: number;
}

type Layout = { readonly ok: true; readonly root: string } | Unavailable;
interface Unavailable {
  readonly ok: false;
  readonly reason: UnavailableReason;
  readonly detail?: string;
}

/** Asks the user manager for a unit's Delegate= setting. */
function askDelegate(unit: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "systemctl",
      ["--user", "show", "--property=Delegate", "--value", "--", unit],
      { timeout: 5_000, encoding: "utf8" },
      (error, stdout) => {
        resolve(error === null ? stdout.trim() : undefined);
      },
    );
  });
}

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export class LinuxContainers implements Containers {
  private readonly cgroupRoot: string;
  private readonly selfCgroup: string;
  private readonly systemdRunDir: string;
  private readonly unitDelegate: (unit: string) => Promise<string | undefined>;
  private readonly uid: number;
  private readonly sh: string;
  private readonly live = new Map<string, Live>();
  private layout: Promise<Layout> | undefined;

  constructor(options: LinuxOptions = {}) {
    this.cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
    this.selfCgroup = options.selfCgroup ?? "/proc/self/cgroup";
    this.systemdRunDir = options.systemdRunDir ?? "/run/systemd/system";
    this.unitDelegate = options.unitDelegate ?? askDelegate;
    this.uid = options.uid ?? process.getuid?.() ?? -1;
    this.sh = options.sh ?? "/bin/sh";
  }

  async probe(): Promise<ProbeResult> {
    const layout = await this.ready();
    if (!layout.ok) {
      return {
        available: false,
        reason: layout.reason,
        message: unavailableMessage(layout.reason, layout.detail),
      };
    }
    const failed = await this.check();
    if (failed !== undefined) {
      return {
        available: false,
        reason: "check_failed",
        message: unavailableMessage("check_failed", failed),
      };
    }
    return { available: true, kind: "cgroup" };
  }

  /** Starts a shell that loops on `sleep` in a container, kills it and confirms the cgroup gone. */
  private async check(): Promise<string | undefined> {
    const name = `probe-${randomBytes(6).toString("hex")}`;
    try {
      await this.start({
        name,
        command: this.sh,
        args: ["-c", "while :; do sleep 1; done"],
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
      });
    } catch (error) {
      return error instanceof Error ? error.message : "the test process did not start";
    }
    await this.kill(name);
    const confirmed = await this.confirmEmpty(name, { waitMs: 5_000 });
    if (confirmed.state !== "empty") return `the test container was not empty: ${confirmed.detail}`;
    return undefined;
  }

  /** The unit's cgroup, once the service sits in its `main` child. Decided once per process. */
  private ready(): Promise<Layout> {
    this.layout ??= this.prepare();
    return this.layout;
  }

  private async prepare(): Promise<Layout> {
    if (!existsSync(this.systemdRunDir)) return { ok: false, reason: "no_systemd" };
    if (!existsSync(join(this.cgroupRoot, "cgroup.controllers"))) {
      return { ok: false, reason: "no_cgroup_v2" };
    }
    let text: string;
    try {
      text = readFileSync(this.selfCgroup, "utf8");
    } catch {
      return { ok: false, reason: "no_cgroup_v2" };
    }
    const placed = placement(text, this.uid);
    if (!placed.ok) return placed;
    const delegate = await this.unitDelegate(placed.unit);
    if (delegate === undefined) return { ok: false, reason: "no_user_manager" };
    if (delegate !== "yes") return { ok: false, reason: "not_delegated" };
    const root = join(this.cgroupRoot, placed.root);
    if (!existsSync(join(root, "cgroup.kill"))) return { ok: false, reason: "no_cgroup_kill" };
    if (!placed.inMain) {
      try {
        makeDir(join(root, MAIN_CGROUP), 0o755);
        writeExisting(join(root, MAIN_CGROUP, "cgroup.procs"), String(process.pid));
      } catch (error) {
        return {
          ok: false,
          reason: "check_failed",
          detail: `the service could not move into its own cgroup: ${errorCode(error) ?? "error"}`,
        };
      }
    }
    return { ok: true, root };
  }

  private async rootOrThrow(): Promise<string> {
    const layout = await this.ready();
    if (!layout.ok) {
      throw new ContainerError("unavailable", unavailableMessage(layout.reason, layout.detail));
    }
    return layout.root;
  }

  private async dirOf(name: string): Promise<string> {
    checkName(name);
    return join(await this.rootOrThrow(), `run-${name}`);
  }

  async start(spec: ContainerSpec): Promise<Contained> {
    const dir = await this.dirOf(spec.name);
    try {
      makeDir(dir, 0o755, { recursive: false });
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new ContainerError("exists", "a container with this name exists");
      }
      throw new ContainerError("start_failed", `cannot create the run's cgroup: ${String(error)}`);
    }
    const child = spawn(
      this.sh,
      ["-c", WRAPPER, join(dir, "cgroup.procs"), spec.command, ...spec.args],
      {
        cwd: spec.cwd,
        env: spec.env,
        // Its own session and process group, so an interrupt reaches the agent's group only.
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise<AgentExit>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
      child.once("error", () => {
        if (child.pid === undefined) resolve({ code: null, signal: null });
      });
    });
    try {
      await joined(child, exited);
    } catch (error) {
      await exited;
      removeTree(dir);
      throw new ContainerError(
        "start_failed",
        error instanceof Error ? error.message : "the agent did not start",
      );
    }
    const pid = child.pid ?? -1;
    this.live.set(spec.name, { child, dir, pid });
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) throw new Error("spawn gave no pipes");
    return { name: spec.name, pid, stdout, stderr, exited };
  }

  interrupt(name: string): Promise<boolean> {
    const live = this.live.get(name);
    if (live === undefined) return Promise.resolve(false);
    try {
      process.kill(-live.pid, "SIGINT");
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  async kill(name: string): Promise<void> {
    const dir = this.live.get(name)?.dir ?? (await this.dirOf(name));
    try {
      writeExisting(join(dir, "cgroup.kill"), "1");
    } catch (error) {
      // A cgroup that is gone holds nothing to kill.
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  async confirmEmpty(name: string, options: ConfirmOptions = {}): Promise<Confirmation> {
    const dir = this.live.get(name)?.dir ?? (await this.dirOf(name));
    const deadline = performance.now() + (options.waitMs ?? 0);
    for (;;) {
      const populated = readPopulated(dir);
      if (populated === "gone") {
        this.live.delete(name);
        return { state: "empty" };
      }
      if (typeof populated === "object") {
        return { state: "unknown", detail: `cgroup.events: ${populated.error}` };
      }
      if (!populated) {
        const left = removeTree(dir);
        if (left === undefined) {
          this.live.delete(name);
          return { state: "empty" };
        }
        // A process joined a cgroup of the run between the read and the removal.
        if (performance.now() >= deadline) return { state: "occupied", detail: left };
      } else if (performance.now() >= deadline) {
        return { state: "occupied", detail: "cgroup.events: populated 1" };
      }
      await sleep(POLL_MS);
    }
  }

  async recover(name: string, options: ConfirmOptions = {}): Promise<Confirmation> {
    await this.kill(name);
    return this.confirmEmpty(name, { waitMs: options.waitMs ?? DEFAULT_RECOVER_WAIT_MS });
  }
}

/**
 * Resolves when the wrapper says it joined its cgroup. Rejects when its signal pipe closes without
 * that: the agent never ran. The agent itself may exit before this settles: the pipe decides.
 */
function joined(child: ChildProcess, exited: Promise<AgentExit>): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = child.stdio[3];
    if (signal === null || signal === undefined) {
      reject(new Error("no join signal"));
      return;
    }
    let said = "";
    child.once("error", (error) => {
      reject(new Error(`the agent's shell did not start: ${errorCode(error) ?? error.message}`));
    });
    signal.on("data", (chunk: Buffer) => {
      said += chunk.toString("latin1");
      if (said.includes("ok\n")) resolve();
    });
    signal.on("error", () => undefined);
    signal.once("close", () => {
      if (said.includes("ok\n")) return;
      void exited.then(({ code }) => {
        reject(
          new Error(
            code === JOIN_FAILED_EXIT
              ? "the agent's shell could not join the run's cgroup"
              : "the agent's shell ended before it joined the run's cgroup",
          ),
        );
      });
    });
  });
}

/**
 * Writes to a cgroup's interface file, opened write-only: cgroup.kill cannot be read, so a
 * read-write open is refused, and nothing may be created.
 */
function writeExisting(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Whether a cgroup has a live process in it or below it, from its cgroup.events. */
function readPopulated(dir: string): boolean | "gone" | { error: string } {
  let text: string;
  try {
    text = readFileSync(join(dir, "cgroup.events"), "utf8");
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" ? "gone" : { error: code ?? "unreadable" };
  }
  const line = text.split("\n").find((l) => l.startsWith("populated "));
  if (line === "populated 0") return false;
  if (line === "populated 1") return true;
  return { error: "no populated line" };
}

/**
 * Removes a cgroup and the cgroups below it, deepest first. Only cgroups go: rmdir removes nothing
 * but an empty cgroup's kernel files. Returns undefined when it is gone, or what stopped it.
 */
function removeTree(dir: string): string | undefined {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return errorCode(error) === "ENOENT" ? undefined : `cannot list ${errorCode(error) ?? ""}`;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const left = removeTree(join(dir, entry.name));
    if (left !== undefined) return left;
  }
  try {
    rmdirSync(dir);
    return undefined;
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" ? undefined : `cannot remove the cgroup: ${code ?? "error"}`;
  }
}
