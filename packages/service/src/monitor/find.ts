// Where `ttam` comes from: the one on the person's PATH, found as Open finds an agent's command,
// unless TTASKS_MONITOR in the service's own environment names another program (a test's service
// names none that exists). On Windows only an executable: TTasks never runs a script, and a shim
// would stand between the service and the process that must see its input close.
import { posix, win32 } from "node:path";
import { envVar, MONITOR_COMMAND } from "@ttasks/brand";
import { onPath, type DetectHost } from "@ttasks/launch";
import type { MonitorCommand } from "./monitor.ts";

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
