// `ttasks shim` from a build (A4 3.6.3): with `pnpm accept m2 --part build --installed <folder>`
// the lab's home is a test install of the built version folder (testkit's layoutTestInstall), the
// terminal starts `<home>/bin/ttasks shim <ticket>` through the stable launcher, which runs the
// folder's lib/ttasks.mjs and its lib/shim.mjs on the folder's own Node, and the service is the
// folder's own bundled hub (lib/chunks/hub-<hash>.mjs, the chunk `ttasks serve` loads), started in
// this process because a launch is opened and dispatched in-process until M2.13 adds the verbs for
// it. Without --installed it is skipped: from source it would be launch-shim.test.ts again (the
// claim, the folder by identity, the exit through the attachment). Fixture data and temporary
// folders only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { FakeAgentReport } from "@ttasks/runs/fake-agents";
import type { startService } from "../src/hub/service.ts";
import { ShimLab } from "./shim-harness.ts";

/** The built version folder the acceptance runs against, from `pnpm accept --installed`. */
const INSTALLED = process.env["TTASKS_ACCEPT_INSTALLED"];

const labs: ShimLab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.cleanup();
}, 120_000);

/** The version folder's own service: `startService` of the hub chunk its CLI's `serve` loads. */
async function builtService(versionFolder: string): Promise<typeof startService> {
  const chunks = join(versionFolder, "lib", "chunks");
  const hubs = readdirSync(chunks).filter((name) => /^hub-[A-Z0-9]+\.mjs$/.test(name));
  const [hub] = hubs;
  if (hub === undefined || hubs.length !== 1) {
    throw new Error(`expected one hub chunk in lib/chunks, found ${String(hubs.length)}`);
  }
  const loaded = (await import(/* @vite-ignore */ pathToFileURL(join(chunks, hub)).href)) as {
    startService?: unknown;
  };
  if (typeof loaded.startService !== "function") throw new Error("the hub chunk has no service");
  return loaded.startService as typeof startService;
}

describe("[A4.5.shim.installed] ttasks shim through the build's launcher against the build's service", () => {
  test.runIf(INSTALLED !== undefined)(
    "a ticket is claimed, a fake agent runs as the shim's child in the checked folder, and its exit is reported",
    { timeout: 300_000 },
    async () => {
      if (INSTALLED === undefined) throw new Error("runs with pnpm accept --installed only");
      const lab = await ShimLab.create("installed", {
        installed: { versionFolder: INSTALLED, start: await builtService(INSTALLED) },
      });
      labs.push(lab);
      // The service and the shim are the build under test: both name its build label.
      const manifest = JSON.parse(readFileSync(join(INSTALLED, "manifest.json"), "utf8")) as {
        build: string;
      };
      expect(lab.running.status().build).toBe(manifest.build);
      expect(lab.install?.launcher).toBeDefined();
      const report = join(lab.work, "agent-report.json");
      const intent = await lab.launch(lab.plan({ report }));
      const shim = lab.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      // The claim, the agent's start as the shim's child, its settle: Confirmed.
      const confirmed = await lab.waitIntent(
        intent.id,
        (i) => i.state === "confirmed" && i.evidence.pid !== undefined,
        "the launch confirmed",
      );
      expect(confirmed.evidence.claim).toMatch(/^claim-/);
      expect(confirmed.evidence.folder_checked).toBe(true);
      // The agent ends: its exit is reported through the shim's attachment.
      shim.endInput();
      expect(await lab.shimExit(shim)).toEqual({ code: 0, signal: null });
      const ended = await lab.waitIntent(
        intent.id,
        (i) => i.evidence.exit_code !== undefined,
        "the exit report",
      );
      expect(ended).toMatchObject({ state: "confirmed", evidence: { exit_code: 0 } });
      // It ran in the folder the service resolved, which the shim checked: by identity.
      const ran = JSON.parse(readFileSync(report, "utf8")) as FakeAgentReport;
      const folder = statSync(lab.folder, { bigint: true });
      expect(ran.cwdId).toBe(`${folder.dev.toString()}:${folder.ino.toString()}`);
    },
  );
});
