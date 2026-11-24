// Doctor after the service refused to start on a service.sqlite a newer version wrote (exit 64, a
// rollback's leftover): the service row names the refusal and both formats instead of saying to
// start it again, which meets the same refusal. A start that was ready since clears it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Logger } from "@ttasks/service/hub";
import { hostFacts, resolveLayout } from "@ttasks/service/paths";
import { tempRoot } from "@ttasks/service/test/harness";
import { cliEnv, runMain } from "./cli-harness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

describe("[A2.3.2.3.service-db.newer] doctor names a refusal that another start would meet again", () => {
  test("after a refusal of a newer service.sqlite the service row names both formats; after a ready start it does not", async () => {
    const { root, cleanup } = tempRoot("doctor-refused");
    cleanups.push(cleanup);
    const home = join(root, "h");
    const layout = resolveLayout(hostFacts(cliEnv(home), process.platform));
    mkdirSync(layout.state, { recursive: true, mode: 0o700 });
    const serviceRow = async (): Promise<string | undefined> => {
      const ran = await runMain(["doctor", "--json"], { home });
      const report = JSON.parse(ran.stdout) as { checks: { id: string; detail: string }[] };
      return report.checks.find((check) => check.id === "service")?.detail;
    };
    // What the service logs as it refuses the file (hub/service.ts).
    const log = new Logger({ dir: layout.logs, stderr: false });
    log.log("service.refused", { reason: "newer_format", format: 2, knows: 1 });
    const refused = await serviceRow();
    expect(refused).toMatch(/^Not running: it refused to start\. /);
    expect(refused).toContain("format 2");
    expect(refused).toContain("knows format 1");
    expect(refused).not.toContain("Start it with");

    log.log("service.ready", { ms: 1, install: "fixture", instance: "fixture" });
    expect(await serviceRow()).toBe("Not running. Start it with: ttasks service start");
  });
});
