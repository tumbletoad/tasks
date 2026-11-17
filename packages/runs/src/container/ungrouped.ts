// Runs where no process group can hold them (Linux without systemd or a delegated unit, Windows
// without tasks-run.exe): the agent is the service's own child, and its processes are what Tasks
// can find of its tree. Nothing confirms that none is left, so every confirmation is
// `unconfirmable`: the run settles, and its cleanup says that Tasks ended what it could find.
//
// What is found: on Linux the agent's process group (its own, from the start) and every process
// whose parents lead back to the agent, read from /proc at the kill; on Windows the agent's tree as
// `taskkill /T` walks it while the agent lives. A process that left the group and lost its parent
// (a daemon) is not found. On Windows a child of the service ends with the service (Node holds its
// children in a job of its own); on Linux the agent's stdin ends with the service, which ends an
// agent that reads its protocol from there.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  checkName,
  ContainerError,
  type AgentExit,
  type ConfirmOptions,
  type Confirmation,
  type Contained,
  type Containers,
  type ContainerSpec,
  type ProbeResult,
} from "./types.ts";

interface Live {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly exited: Promise<AgentExit>;
  done: boolean;
}

export interface UngroupedOptions {
  readonly platform?: NodeJS.Platform;
  /** Windows: taskkill.exe. Default: the one in the system folder. */
  readonly taskkill?: string;
  /** Linux: where the process table is read. */
  readonly proc?: string;
}

const UNCONFIRMABLE: Confirmation = { state: "unconfirmable" };

/** The processes below `root` in a table of PID to parent PID: children, theirs, and so on. */
export function descendants(parents: ReadonlyMap<number, number>, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of parents) {
    const list = children.get(parent) ?? [];
    list.push(pid);
    children.set(parent, list);
  }
  const found: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** Linux: each process's parent, from /proc/<pid>/stat. */
function parentTable(proc: string): Map<number, number> {
  const table = new Map<number, number>();
  let names: string[];
  try {
    names = readdirSync(proc);
  } catch {
    return table;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(join(proc, name, "stat"), "latin1");
      // The command name is in parentheses and may hold anything: the fields after its last `)`.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const parent = Number(rest[1]);
      if (Number.isInteger(parent)) table.set(Number(name), parent);
    } catch {
      // Gone meanwhile.
    }
  }
  return table;
}

export class UngroupedContainers implements Containers {
  private readonly platform: NodeJS.Platform;
  private readonly taskkill: string;
  private readonly proc: string;
  private readonly live = new Map<string, Live>();

  constructor(options: UngroupedOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.taskkill =
      options.taskkill ??
      join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");
    this.proc = options.proc ?? "/proc";
  }

  probe(): Promise<ProbeResult> {
    return Promise.resolve({ available: true, kind: "tree" });
  }

  async start(spec: ContainerSpec): Promise<Contained> {
    checkName(spec.name);
    if (this.live.has(spec.name)) {
      throw new ContainerError("exists", "a container with this name exists");
    }
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      // Linux and macOS: its own process group, so an interrupt and a kill reach its group.
      detached: this.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => undefined);
    const exited = new Promise<AgentExit>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
      child.once("error", () => {
        if (child.pid === undefined) resolve({ code: null, signal: null });
      });
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        reject(new ContainerError("start_failed", `the agent did not start: ${error.message}`));
      });
    });
    const pid = child.pid ?? -1;
    const live: Live = { child, pid, exited, done: false };
    void exited.then(() => {
      live.done = true;
    });
    this.live.set(spec.name, live);
    return {
      name: spec.name,
      pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
    };
  }

  interrupt(name: string): Promise<boolean> {
    const live = this.live.get(name);
    // Windows has no Ctrl+C for a process without a console of its own; once the agent is gone,
    // its group ID can belong to another program.
    if (live === undefined || live.done || this.platform === "win32") {
      return Promise.resolve(false);
    }
    try {
      process.kill(-live.pid, "SIGINT");
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  /** Ends what can be found of the run; the run is forgotten once the agent ended too. */
  async kill(name: string): Promise<void> {
    checkName(name);
    const live = this.live.get(name);
    if (live === undefined) return;
    void live.exited.then(() => {
      if (this.live.get(name) === live) this.live.delete(name);
    });
    if (this.platform === "win32") {
      if (!live.done) await this.taskkillTree(live.pid);
      return;
    }
    const found = descendants(parentTable(this.proc), live.pid);
    for (const pid of [-live.pid, ...(live.done ? [] : [live.pid]), ...found]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone already, or not ours to end.
      }
    }
  }

  /**
   * Waits up to `waitMs` for the agent to end; what else is left cannot be counted. The run stays
   * known for the kill that follows: what the agent left in its group is found from it.
   */
  async confirmEmpty(name: string, options: ConfirmOptions = {}): Promise<Confirmation> {
    checkName(name);
    const live = this.live.get(name);
    if (live !== undefined && !live.done && (options.waitMs ?? 0) > 0) {
      await Promise.race([live.exited, sleep(options.waitMs)]);
    }
    return UNCONFIRMABLE;
  }

  /** After a restart nothing of the run is known: what it left cannot be found by its name. */
  recover(name: string): Promise<Confirmation> {
    checkName(name);
    return Promise.resolve(UNCONFIRMABLE);
  }

  private taskkillTree(pid: number): Promise<void> {
    return new Promise((resolve) => {
      execFile(
        this.taskkill,
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 15_000 },
        () => {
          resolve();
        },
      );
    });
  }
}
