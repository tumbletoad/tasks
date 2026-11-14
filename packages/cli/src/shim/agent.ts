// How the shim starts its agent (A4 3.6.3 step 6): a direct child, with the claim's argv and
// environment, the terminal as its stdio, never through a shell. Nothing runs between the shim's
// folder check and the agent: `via_login_shell` is the service's fresh snapshot of the person's
// login shell, taken in the task's folder before the launch (A4 3.8),
// not a shell around the agent whose profile could change the folder or the environment after
// the check and the scrub. The same seam starts the shell of `after_exit = "shell"`.
//
// No working-directory option: the agent inherits the shim's own working directory, the folder
// the shim's check just found to be the resolved one (A4 3.3). A `cwd` here would resolve
// the folder's path again, and the path may name another directory by then.
//
// The agent is a normal child of the shim: on Windows it sits in the shim's kill-on-close job, so
// closing the shim's window ends both (A4 3.7); on Linux and macOS it stays in the terminal's
// foreground process group and gets the terminal's signals itself.
import { spawn } from "node:child_process";

export interface AgentSpec {
  /** The absolute executable first. */
  readonly argv: readonly string[];
  /** The whole environment: nothing of the shim's own is added here. */
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface AgentChild {
  readonly pid: number;
  readonly exited: Promise<AgentExit>;
  kill(signal: NodeJS.Signals): void;
}

/** Starts the agent. Rejects when the OS refused to start it (ENOENT, EACCES and the like). */
export type StartAgent = (spec: AgentSpec) => Promise<AgentChild>;

export const startAgent: StartAgent = (spec) =>
  new Promise<AgentChild>((resolve, reject) => {
    const [file, ...args] = spec.argv;
    if (file === undefined) {
      reject(new Error("No executable"));
      return;
    }
    const child = spawn(file, args, {
      env: { ...spec.env },
      stdio: "inherit",
      shell: false,
    });
    let started = false;
    const exited = new Promise<AgentExit>((done) => {
      child.once("exit", (code, signal) => {
        done({ code, signal });
      });
    });
    child.on("error", (error) => {
      if (!started) reject(error);
    });
    child.once("spawn", () => {
      started = true;
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error("The agent has no PID"));
        return;
      }
      resolve({
        pid,
        exited,
        kill: (signal) => {
          if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        },
      });
    });
  });
