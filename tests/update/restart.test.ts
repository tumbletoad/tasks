// The upgrade a person makes with the install script while the service runs, with
// real builds, a real install and real processes (installed.ts): the older version installed and
// its service running, the newer one installed over it by its own install script. The script's
// last lines name the pending restart, `ttasks service status` says it, and `ttasks service restart`
// brings up the new version and says so. The script runs without a terminal here, so it asks
// nothing; packages/cli/test/install-restart.test.ts covers the question.
//
// Nothing here touches a real install, autostart place, PATH or shell profile, and every process
// it stops is one it started or one this install's service.json names.
import { afterAll, beforeAll, describe as suite, expect, test } from "vitest";
import { PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { currentVersion } from "../../packages/service/src/version/switch.ts";
import { runProgram, runsElevated } from "../../scripts/install/test/kit.ts";
import { openInstalled, type Installed } from "./installed.ts";

/** The installed service refuses an elevated token (exit 64): skipped where the test is elevated. */
const describe = suite.skipIf(runsElevated());
/** Builds, two install script runs and service starts: a slow runner gets room. */
const SLOW = 900_000;

let w: Installed | undefined;

beforeAll(async () => {
  if (!runsElevated()) w = await openInstalled("restart");
}, SLOW);

afterAll(async () => {
  await w?.close();
}, SLOW);

describe("[A2.3.12.4.install.restart] an install over a running service names the restart, and the restart brings up the new version", () => {
  test(
    "the script's last lines, status and restart, through the installed stable command",
    async () => {
      if (w === undefined) throw new Error("no install");
      const [first, second] = w.versions;
      // Started as a person starts it. Started as this test's own child, the old service would stay
      // a zombie on Linux while the test waits for the restart synchronously, and the stop would
      // wait for it in vain.
      const started = runProgram(w.stable, ["service", "start"]);
      expect(started.status, `${started.stdout}\n${started.stderr}`).toBe(0);
      expect(await w.serviceVersion()).toBe(first);

      const ran = w.install(second);
      expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0);
      expect(currentVersion(w.root, process.platform)).toBe(second);
      const last = ran.stdout.trimEnd().split(/\r?\n/).slice(-2);
      expect(last[0]).toBe(
        `${PRODUCT_NAME}'s service still runs ${first}. To run ${second}, restart it:`,
      );
      expect(last[1]).toContain(w.stable);
      expect(last[1]).toMatch(/ service restart$/);
      // The install changed nothing of the running service.
      expect(await w.serviceVersion()).toBe(first);

      const status = runProgram(w.stable, ["service", "status"]);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain(
        `  Installed: ${second}, not yet running. To run it: ttasks service restart\n`,
      );
      // An agent's shell may not restart it.
      const agent = runProgram(w.stable, ["service", "restart"], { CODEX_THREAD_ID: "fixture" });
      expect(agent.status).toBe(5);
      expect(await w.serviceVersion()).toBe(first);

      const restarted = runProgram(w.stable, ["service", "restart"]);
      expect(restarted.status, `${restarted.stdout}\n${restarted.stderr}`).toBe(0);
      expect(restarted.stdout).toContain(
        `${PRODUCT_NAME}'s service restarted on version ${second} (it ran ${first} before): ready, PID `,
      );
      expect(await w.serviceVersion()).toBe(second);
      const after = runProgram(w.stable, ["service", "status"]);
      expect(after.status, after.stderr).toBe(0);
      expect(after.stdout).not.toContain("Installed:");

      // The same version again over its own running service: nothing to restart, so no notice.
      const again = w.install(second);
      expect(again.status, `${again.stdout}\n${again.stderr}`).toBe(0);
      expect(again.stdout).not.toContain("restart it:");
    },
    SLOW,
  );
});
