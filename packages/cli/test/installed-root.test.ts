// `pnpm accept m1 --installed <root>` against an install that an install script made (A7 3.8
// M1.14's Verify line; the CI smoke job runs it on the root it installed). The other installed
// entries lay out test installs of the root's current version folder in homes of their own; this
// one checks the install itself, as it was installed: its stable command, doctor's rows in it, its
// install.json and install ID, and its service started and stopped through its stable command by
// a manual manager. From source there is no install to check, so it is skipped.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PRODUCT_ID, PRODUCT_NAME } from "@tasks/brand";
import { canonicalStatePath, installId } from "@tasks/service/paths";
import {
  openSession,
  readServiceJson,
  removeRuntimeDir,
  Services,
  waitFor,
  within,
  READY_MS,
} from "@tasks/service/test/harness";
import { cliEnv, INSTALLED } from "./cli-harness.ts";

/** The install root `pnpm accept --installed <root>` names (scripts/accept.ts). */
const ROOT = process.env["TASKS_ACCEPT_INSTALL_ROOT"];

const command = (root: string): string =>
  join(root, "bin", process.platform === "win32" ? `${PRODUCT_ID}.exe` : PRODUCT_ID);

function run(root: string, args: readonly string[]) {
  const ran = spawnSync(command(root), args, {
    env: cliEnv(root),
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
  });
  if (ran.error !== undefined) throw ran.error;
  return ran;
}

describe("[A2.3.12.4.install.installed-root] the install an install script made, as installed", () => {
  test.runIf(ROOT !== undefined && INSTALLED !== undefined)(
    "its stable command runs current, doctor passes in it, install.json names its own install ID, and its service starts and stops",
    async () => {
      if (ROOT === undefined || INSTALLED === undefined) return;
      const manifest = JSON.parse(readFileSync(join(INSTALLED, "manifest.json"), "utf8")) as {
        version: string;
        build: string;
      };
      const version = run(ROOT, ["version"]);
      expect(version.stdout.trim()).toBe(`${PRODUCT_NAME} ${manifest.version} (${manifest.build})`);

      const doctor = run(ROOT, ["doctor", "--self-test", "--json"]);
      const rows = (JSON.parse(doctor.stdout) as { checks: { id: string; status: string }[] })
        .checks;
      for (const id of [
        "integrity",
        "runtime",
        "install",
        "candidate-space",
        "candidate-endpoint",
        "candidate-bridge",
      ]) {
        expect(rows.find((row) => row.id === id)?.status, `${id}: ${doctor.stdout}`).toBe("ok");
      }

      const state = realpathSync.native(join(ROOT, "state"));
      const id = installId(canonicalStatePath(state, process.platform));
      const record = JSON.parse(readFileSync(join(state, "install.json"), "utf8")) as {
        install_id: string;
        versions: string[];
        created: string[];
        method: string;
      };
      expect(record).toMatchObject({ install_id: id, method: "script" });
      expect(record.versions).toContain(manifest.version);
      expect(record.created).toEqual(expect.arrayContaining(["current", "home.marker", "bin"]));

      // A manual manager: the stable command's `tasks serve`, stopped by service/shutdown.
      const services = new Services();
      try {
        const proc = services.start(ROOT, { command: [command(ROOT), "serve"] });
        const json = await waitFor(
          () => {
            const service = readServiceJson(ROOT);
            return service?.state === "ready" ? service : undefined;
          },
          READY_MS,
          "the installed service ready",
        );
        expect(json.install_id).toBe(id);
        expect(json["build"]).toBe(manifest.build);
        const session = await openSession(ROOT, json.endpoint?.path ?? "");
        try {
          const status = (await session.call("service/status", {}, { timeoutMs: 10_000 })) as {
            version?: string;
          };
          expect(status.version).toBe(manifest.version);
          await session.call("service/shutdown", {}, { timeoutMs: 10_000 }).catch(() => undefined);
        } finally {
          session.close();
        }
        const exit = await within(proc.exit, 60_000, "the installed service's stop");
        expect(exit.code).toBe(0);
        removeRuntimeDir(json);
      } finally {
        await services.stopAll();
      }
    },
    300_000,
  );
});
