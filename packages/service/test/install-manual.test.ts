// `tasks service start`, `status` and `stop` against the product's real service on Linux and macOS,
// on the routes that start it by hand (A2 3.3.3): without a user manager, and on Linux with one but
// no unit of this install. Start runs the launcher detached, then waits for a service that
// completes the tasks-local/1 handshake, and stop asks it over the socket. The launcher is a
// stand-in script that runs `tasks serve` from this checkout. systemctl and loginctl are played by
// the recorder, so nothing reaches the real user session and no unit is made. Linux and macOS
// hosts only.
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAgentMarker } from "@tasks/bridge/protocol";
import { afterEach, describe, expect, test } from "vitest";
import {
  restartService,
  serviceStatus,
  startService,
  stopService,
} from "../src/install/commands.ts";
import { defaultServiceContext, type ServiceContext } from "../src/install/context.ts";
import {
  EXIT_MS,
  MAIN,
  READY_MS,
  readServiceJson,
  removeRuntimeDir,
  waitFor,
  within,
} from "./harness.ts";
import { FakeService, FakeTools } from "./install-fakes.ts";

const posix = process.platform !== "win32";
/** A terminal that runs `tasks service start` and then waits, as a shell does. */
const START_ENTRY = fileURLToPath(new URL("./start-entry.ts", import.meta.url));

let dir = "";
let root = "";
/** The stand-in terminal's PID, which leads its own process group, while it may still run. */
let terminalPid: number | undefined;

afterEach(() => {
  if (terminalPid !== undefined) {
    try {
      process.kill(-terminalPid, "SIGKILL");
    } catch {
      // Already gone.
    }
    terminalPid = undefined;
  }
  if (dir === "") return;
  const service = readServiceJson(root);
  if (service !== undefined) {
    // A service this test started and a failure left running: it is the PID service.json names.
    try {
      process.kill(service.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  removeRuntimeDir(service);
  rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** A context over a temporary install; `userManager`: whether the recorder plays one. */
function context(userManager = false): ServiceContext {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ks-man-")));
  root = join(dir, "kh");
  const program = join(root, "current", "bin", "tasks");
  mkdirSync(join(program, ".."), { recursive: true });
  // The stand-in launcher: the real one finds TASKS_HOME from home.marker (A2 3.12.3).
  writeFileSync(
    program,
    `#!/bin/sh\nexport TASKS_HOME='${root}'\nexec '${process.execPath}' '${MAIN}' "$@"\n`,
  );
  chmodSync(program, 0o755);
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!isAgentMarker(name) && !name.toUpperCase().startsWith("TASKS_")) env[name] = value;
  }
  const real = defaultServiceContext({ env: { ...env, TASKS_HOME: root }, program });
  const tools = new FakeTools(new FakeService(), join(dir, "units"), { userManager });
  // A home folder of the test's own: a service started by hand runs in it.
  const home = join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  return {
    ...real,
    home,
    run: tools.run,
    roots: { ...real.roots, unitDir: join(dir, "units"), launchAgentsDir: join(dir, "agents") },
  };
}

/** The fields of /proc/<pid>/stat after the command name: [state, ppid, pgrp, session, tty_nr]. */
function procStat(pid: number): string[] {
  const text = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ");
}

describe.skipIf(!posix)(
  "[A2.3.3.5.service-install.commands] start, status and stop against the real service",
  () => {
    test("without a user manager start runs the service detached and waits for its handshake; stop asks it to end; restart stops and starts it, or starts it", async () => {
      const ctx = context();
      if (ctx.platform === "darwin") return; // launchd's route; this one is Linux's fallback
      const before = await serviceStatus(ctx);
      expect(before.service).toEqual({ answers: false, reason: "not_running" });

      const start = await startService(ctx);
      expect(start).toMatchObject({ outcome: "started", via: "manual" });
      expect(start.status).toMatchObject({
        state: "ready",
        install_id: ctx.installId,
        manager: "manual",
      });
      const again = await startService(ctx);
      expect(again.outcome).toBe("already_running");

      const status = await serviceStatus(ctx);
      expect(status).toMatchObject({
        install_id: ctx.installId,
        tasks_home: root,
        entry: { kind: "systemd-unit", state: "absent" },
        autostart: { kind: "systemd", user_manager: false, enabled: null, active: null },
        service: { answers: true, state: "ready", pid: start.status.pid, endpoint: "unix" },
      });

      // restart: stop, then start, on a service of its own that names the version that ran.
      const restarted = await restartService(ctx);
      expect(restarted).toMatchObject({
        outcome: "restarted",
        was: start.status.version,
        stop: { outcome: "stopped", via: "shutdown" },
        start: { outcome: "started", via: "manual", status: { state: "ready" } },
      });
      expect(restarted.start.status.pid).not.toBe(start.status.pid);

      expect(await stopService(ctx)).toEqual({ outcome: "stopped", via: "shutdown" });
      expect((await serviceStatus(ctx)).service).toEqual({ answers: false, reason: "not_running" });
      expect(await stopService(ctx)).toEqual({ outcome: "not_running", via: "none" });
      // restart with no service running starts one.
      expect(await restartService(ctx)).toMatchObject({
        outcome: "started",
        was: null,
        stop: { outcome: "not_running" },
        start: { outcome: "started" },
      });
      expect(await stopService(ctx)).toMatchObject({ outcome: "stopped" });
    }, 180_000);

    test("[A2.3.3.3.service-install.start-by-hand] with a user manager and no unit, start runs the service by hand in a session of its own: the hang-up of the terminal that started it does not end it, and stop does", async () => {
      const ctx = context(true);
      if (ctx.platform !== "linux") return; // macOS starts through launchd only
      // A terminal: its own process group and session, as a terminal's shell has.
      const terminal = spawn(
        process.execPath,
        [START_ENTRY, root, ctx.program, join(dir, "units"), ctx.home],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: dir,
        },
      );
      terminalPid = terminal.pid;
      let out = "";
      let err = "";
      terminal.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
      terminal.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
      let gone = false;
      const ended = new Promise<void>((resolve) =>
        terminal.once("exit", () => {
          gone = true;
          resolve();
        }),
      );
      // Its one line, or its end when the start failed (then stderr says why).
      await waitFor(() => (out.includes("\n") || gone ? true : undefined), READY_MS, "the start");
      expect(out, err).toMatch(/^\{.*\}\n$/);
      const started = JSON.parse(out) as { via: string; unit: string | null; pid: number };
      expect(started).toMatchObject({ via: "manual", unit: "not_installed" });
      // Neither the terminal's process group nor its session holds the service, which has no
      // terminal of its own: a hang-up of either never reaches it.
      const [, , group, session, tty] = procStat(started.pid);
      const terminalSession = procStat(terminal.pid ?? 0)[3];
      expect(group).not.toBe(String(terminal.pid));
      expect(session).not.toBe(terminalSession);
      expect(tty).toBe("0");
      // It runs in the home folder (here a folder of the test's own), as the unit runs it, never in
      // the terminal's folder, which it would keep busy.
      expect(readlinkSync(`/proc/${String(started.pid)}/cwd`)).toBe(realpathSync.native(ctx.home));
      // The terminal closes: a hang-up to its whole process group, and it is gone.
      process.kill(-(terminal.pid ?? 0), "SIGHUP");
      await within(ended, EXIT_MS, "the terminal's end");
      terminalPid = undefined;
      // The service answers still; status, stop and status again reach it.
      const status = await serviceStatus(ctx);
      expect(status.service).toMatchObject({ answers: true, pid: started.pid, manager: "manual" });
      expect(status.entry).toMatchObject({ state: "absent" });
      expect(status.autostart).toMatchObject({ kind: "systemd", user_manager: true });
      expect(await stopService(ctx)).toEqual({ outcome: "stopped", via: "shutdown" });
      expect((await serviceStatus(ctx)).service).toEqual({ answers: false, reason: "not_running" });
    }, 120_000);
  },
);
