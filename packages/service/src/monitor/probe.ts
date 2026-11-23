// Where `ttam` comes from, and whether it fits, for doctor and for a page that looks again.
//
// The `ttam` on the person's PATH, found as Open finds an agent's command, unless TTASKS_MONITOR in
// the service's own environment names another program (a test's service names none that exists).
// On Windows only an executable: TTasks never runs a script, and a shim would stand between the
// service and the process that must see its input close.
//
// The probe starts `ttam query` with its input already closed: TTAM writes its hello, runs no pass
// and exits, so it reads no session.
import { spawn } from "node:child_process";
import { posix, win32 } from "node:path";
import { envVar, MONITOR_COMMAND } from "@ttasks/brand";
import type { MonitorBuild, MonitorProblem } from "@ttasks/contracts/monitor";
import { onPath, type DetectHost } from "@ttasks/launch";
import { readLine } from "./lines.ts";
import { MONITOR_TIMES, verdictOf, type MonitorCommand } from "./monitor.ts";

export const MONITOR_VARIABLE = envVar("MONITOR");

/** The `ttam` the service would start: `named`, else the one on `host`'s PATH. */
export function findMonitor(host: DetectHost, cwd: string, named?: string): MonitorCommand {
  const file = named ?? onPath(host, MONITOR_COMMAND);
  if (file === undefined) return { ok: false, reason: "not_found" };
  if (named !== undefined) {
    const facts = host.stat(named);
    const absolute = (host.platform === "win32" ? win32 : posix).isAbsolute(named);
    if (!absolute || facts?.kind !== "file" || !facts.executable) {
      return { ok: false, reason: "not_found" };
    }
  }
  if (host.platform === "win32" && !/\.exe$/iu.test(file)) return { ok: false, reason: "script" };
  return { ok: true, file, env: host.env, cwd };
}

export type MonitorProbe =
  | { readonly fits: true; readonly build: MonitorBuild }
  | { readonly fits: false; readonly problem: MonitorProblem };

/** Starts `command` with a closed input and reads its hello. */
export function probeMonitor(
  command: MonitorCommand,
  times: { readonly helloMs: number; readonly killMs: number } = MONITOR_TIMES,
): Promise<MonitorProbe> {
  if (!command.ok) {
    return Promise.resolve({
      fits: false,
      problem: { kind: "not_installed", reason: command.reason },
    });
  }
  const failed = (reason: "start_failed" | "no_hello" | "exited"): MonitorProbe => ({
    fits: false,
    problem: { kind: "failed", reason },
  });
  return new Promise((resolve) => {
    let first: string | undefined;
    let text = "";
    const proc = spawn(command.file, [...(command.args ?? []), "query"], {
      cwd: command.cwd,
      env: command.env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const kill = (): void => {
      proc.kill("SIGKILL");
    };
    const deadline = setTimeout(kill, times.helloMs + times.killMs);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      if (first !== undefined) return;
      text += chunk;
      const end = text.indexOf("\n");
      if (end !== -1) first = text.slice(0, end);
      else if (text.length > 64 * 1024) kill();
    });
    proc.once("error", () => {
      clearTimeout(deadline);
      if (proc.pid === undefined) resolve(failed("start_failed"));
    });
    proc.once("close", (code) => {
      clearTimeout(deadline);
      if (first === undefined) {
        resolve(
          code === 2
            ? { fits: false, problem: { kind: "not_installed", reason: "no_query" } }
            : failed(code === null ? "no_hello" : "exited"),
        );
        return;
      }
      const line = readLine(first);
      if (line?.type !== "hello") {
        resolve(failed("no_hello"));
        return;
      }
      const verdict = verdictOf(line.schemaVersion, line.queryVersion, line.build);
      if (verdict !== undefined) resolve({ fits: false, problem: verdict });
      else if (line.build === null) resolve(failed("no_hello"));
      else resolve({ fits: true, build: line.build });
    });
  });
}
