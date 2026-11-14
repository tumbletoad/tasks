// `tasks service start`, `status` and `stop` against the product's real service on Linux and macOS,
// on the route without a user manager (A2 3.3.3): start runs the launcher detached, then waits for a
// service that completes the tasks-local/1 handshake, and stop asks it over the socket. The
// launcher is a stand-in script that runs `tasks serve` from this checkout. systemctl and loginctl
// are played by the recorder, which answers that there is no user manager, so nothing reaches the
// real user session. Linux and macOS hosts only.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAgentMarker } from "@tasks/bridge/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { serviceStatus, startService, stopService } from "../src/install/commands.ts";
import { defaultServiceContext, type ServiceContext } from "../src/install/context.ts";
import { MAIN, readServiceJson, removeRuntimeDir } from "./harness.ts";
import { FakeService, FakeTools } from "./install-fakes.ts";

const posix = process.platform !== "win32";

let dir = "";
let root = "";

afterEach(() => {
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

function context(): ServiceContext {
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
  const tools = new FakeTools(new FakeService(), join(dir, "units"), { userManager: false });
  return {
    ...real,
    run: tools.run,
    roots: { ...real.roots, unitDir: join(dir, "units"), launchAgentsDir: join(dir, "agents") },
  };
}

describe.skipIf(!posix)(
  "[A2.3.3.5.service-install.commands] start, status and stop against the real service",
  () => {
    test("without a user manager start runs the service detached and waits for its handshake; stop asks it to end", async () => {
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

      expect(await stopService(ctx)).toEqual({ outcome: "stopped", via: "shutdown" });
      expect((await serviceStatus(ctx)).service).toEqual({ answers: false, reason: "not_running" });
      expect(await stopService(ctx)).toEqual({ outcome: "not_running", via: "none" });
    }, 120_000);
  },
);
