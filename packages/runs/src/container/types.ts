// A run's container: the agent and everything it starts, ended together and confirmed empty from
// the operating system's own count. It knows nothing of agents or run records: the run host
// names a container, records the name, and asks this module to start, stop and confirm it.
//
// Linux: a child cgroup of the service's own systemd user unit (linux.ts). Windows: a named job
// object held by ttasks-run.exe (windows.ts). Where neither can be made, the agent's process tree
// as TTasks can find it (ungrouped.ts), which can never be confirmed empty.
import type { Readable, Writable } from "node:stream";

/** What to start inside a new container. */
export interface ContainerSpec {
  /**
   * The container's name, recorded by the caller before the container exists. On Windows a job's
   * name is shared by every install in the person's session, so it must be unique per run on the
   * machine, not only within one install (a random run ID is). Its characters:
   * ASCII letters, digits, '-', '_' and '.', starting with a letter or digit, at most 100 long.
   */
  readonly name: string;
  /** The program's absolute path. No search path is consulted. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The program's whole environment. */
  readonly env: Readonly<Record<string, string>>;
}

/** How the agent itself ended: its exit code, or the signal that ended it (Linux). */
export interface AgentExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** An agent running in its container. */
export interface Contained {
  readonly name: string;
  /** The agent's process ID. */
  readonly pid: number;
  /**
   * The agent's stdin. Ending it is the agent's end of input and nothing else: the container and
   * what holds it stay as they are.
   */
  readonly stdin: Writable;
  /** The agent's stdout and stderr, shared with every process that inherited them. */
  readonly stdout: Readable;
  readonly stderr: Readable;
  /**
   * Settles once, when the agent itself exits. Processes it started may still run: only
   * confirmEmpty says the container is empty.
   */
  readonly exited: Promise<AgentExit>;
}

/**
 * Whether a container is empty, as the operating system counts it. `empty` also means the
 * container is gone or released: a cgroup removed, a job's holder let go. `occupied`: processes
 * remain; with no process group, the agent itself is still alive. `unknown`: the count could not
 * be read, so the run must not be called ended. `unconfirmable`: no process group holds the run
 * and its agent is gone, so nothing counts what else is left; TTasks ended what it could find.
 */
export type Confirmation =
  | { readonly state: "empty" }
  | { readonly state: "occupied"; readonly detail: string }
  | { readonly state: "unknown"; readonly detail: string }
  | { readonly state: "unconfirmable" };

/** Why runs cannot be contained on this machine. Each has a plain message for the person. */
export type UnavailableReason =
  | "unsupported_platform"
  | "no_systemd"
  | "no_cgroup_v2"
  | "no_user_manager"
  | "not_a_service"
  | "not_delegated"
  | "no_cgroup_kill"
  | "helper_missing"
  | "check_failed";

export type ProbeResult =
  | {
      readonly available: true;
      /** `tree`: no process group; the agent's process tree as TTasks can find it. */
      readonly kind: "cgroup" | "job" | "tree";
    }
  | {
      readonly available: false;
      readonly reason: UnavailableReason;
      /** One or two sentences for the person: what is missing and, where they can, what to do. */
      readonly message: string;
    };

export interface ConfirmOptions {
  /** How long to wait for the container to become empty before answering. Default 0. */
  readonly waitMs?: number;
}

export interface Containers {
  /**
   * Whether runs can be contained here, proven by creating a container, starting a process in it,
   * killing it and seeing it empty: settings alone prove nothing.
   */
  probe(): Promise<ProbeResult>;
  /**
   * Creates the container and starts the agent inside it. Throws a ContainerError when the name
   * is taken (`exists`), runs cannot be contained here (`unavailable`), or the agent could not be
   * started inside it (`start_failed`); nothing then runs and no container is left.
   */
  start(spec: ContainerSpec): Promise<Contained>;
  /**
   * Asks the agent to stop: SIGINT to its process group on Linux, Ctrl+C on its console on
   * Windows. False when it could not be delivered or the agent itself has exited: what it left
   * behind is ended with kill. It ends nothing by itself.
   */
  interrupt(name: string): Promise<boolean>;
  /** Ends every process in the container at once. Confirm with confirmEmpty. */
  kill(name: string): Promise<void>;
  /** Whether the container is empty. When it is, it is removed or released. */
  confirmEmpty(name: string, options?: ConfirmOptions): Promise<Confirmation>;
  /**
   * After a crash of the service, from the name alone: ends whatever is left in the container,
   * then confirms it empty (waiting up to `waitMs`, default 10 s).
   */
  recover(name: string, options?: ConfirmOptions): Promise<Confirmation>;
}

export type ContainerErrorCode = "bad_name" | "exists" | "unavailable" | "start_failed";

export class ContainerError extends Error {
  override readonly name = "ContainerError";
  readonly code: ContainerErrorCode;
  constructor(code: ContainerErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Throws `bad_name` unless `name` can name a container. */
export function checkName(name: string): void {
  if (!NAME.test(name)) throw new ContainerError("bad_name", "invalid container name");
}

export const DEFAULT_RECOVER_WAIT_MS = 10_000;
