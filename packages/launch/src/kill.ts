// Ends a child process and what it started (detect.ts's bounded output, doctor's probes and
// headless runs, M4.05). One rule, so every runner with a deadline ends the same way:
//
// - Linux and macOS: the child leads a process group of its own (spawned `detached`, see
//   `ownsGroup`), and the whole group is killed. After the child exits, killing the group again
//   ends what it left behind.
// - Windows: no such group. While the child still runs, the system's own taskkill, by its full
//   path, ends it with every descendant; the child is killed directly as well, whatever taskkill
//   does. A descendant of a child that has already exited cannot be found from it.
//
// This module imports Node built-ins only.
import { spawn, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";

/** Whether a child spawned on `platform` should lead its own process group (`detached`). */
export const ownsGroup = (platform: NodeJS.Platform): boolean => platform !== "win32";

/** Kills `child` and every process it started, as far as the OS lets them be found. */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (ownsGroup(platform)) {
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
  let killer: ChildProcess;
  try {
    killer = spawn(
      win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/T", "/F", "/PID", String(pid)],
      { stdio: "ignore", shell: false, windowsHide: true },
    );
  } catch {
    child.kill("SIGKILL");
    return;
  }
  killer.once("error", () => {
    child.kill("SIGKILL");
  });
  killer.once("exit", () => {
    child.kill("SIGKILL");
  });
}
