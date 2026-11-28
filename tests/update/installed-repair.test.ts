// A repair of an update cut off after its switch, with real builds, a real install and real
// processes (installed.ts): a repair killed at each of its own steps
// is finished by the next start, and a running service finishes an update whose updater died
// within its 10 s check.
//
// Nothing here touches a real install, autostart place, PATH or shell profile, and every process
// it stops is one it started: the services this install's service.json names, the children.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe as suite, expect, test } from "vitest";
import { readServiceRecord } from "../../packages/service/src/install/context.ts";
import { currentVersion } from "../../packages/service/src/version/switch.ts";
import { runsElevated } from "../../scripts/install/test/kit.ts";
import { installedForFile, SLOW } from "./installed.ts";

// The installed service refuses an elevated token (exit 64): skipped in an elevated process.
const elevated = runsElevated();
const install = installedForFile("repair", { distinctLaunchers: true, skip: elevated });

suite.skipIf(elevated)(
  "[A2.3.12.6.update.kill] a kill at each journal step, of the updater or of the service, ends on the complete old or new version after the next start",
  () => {
    test(
      "a repair killed at each of its steps is finished by the next start; a running service finishes an update whose updater died",
      async () => {
        const w = install();
        await w.ensureService();
        for (const point of [
          "repair:decided",
          "repair:current",
          "repair:launchers",
          "repair:record",
        ]) {
          const from = await w.expectComplete(`before ${point}`);
          // An update cut off after its switch, with no service to repair it...
          await w.stopService();
          await w.runChild("update", {
            archive: w.archiveOf(w.other(from)),
            arm: "switched",
            mode: "updater",
          });
          // ...a repair killed at `point`...
          const run = await w.runChild("repair", { arm: point, mode: "updater" });
          expect(run.armed, `${point}: reached`).toBe(true);
          // ...and the next start.
          await w.startService();
          expect(await w.expectComplete(`repair killed at ${point}`)).toBe(w.other(from));
        }
        // The updater dies after the switch while the old service runs: within its 10 s check the
        // service finishes the update, then exits 75 for its manager to start the new version.
        const from = await w.expectComplete("before the running service's repair");
        const before = readServiceRecord(w.state)?.pid ?? 0;
        await w.runChild("update", {
          archive: w.archiveOf(w.other(from)),
          arm: "switched",
          mode: "updater",
        });
        await w.waitGone(before, 30_000);
        expect(existsSync(join(w.state, "update.json"))).toBe(false);
        expect(currentVersion(w.root, process.platform)).toBe(w.other(from));
        const log = readFileSync(join(w.state, "logs", "service.log"), "utf8");
        expect(log).toMatch(/"update\.repaired"/);
        await w.startService();
        expect(await w.expectComplete("after the running service's repair")).toBe(w.other(from));
      },
      SLOW,
    );
  },
);
