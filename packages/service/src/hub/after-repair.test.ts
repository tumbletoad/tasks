// Whether a service restarts itself after it finished an interrupted update (A2 3.12.6): at its
// start, when current names another version; while it runs, only when the person agreed to the
// restart in the update that was cut off, never for an install's journal or an unreadable one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { Journal } from "../version/journal.ts";
import type { RepairOutcome } from "../version/repair.ts";
import { Logger } from "./log.ts";
import { afterRepair } from "./service.ts";

const dir = mkdtempSync(join(tmpdir(), "after-repair-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const log = new Logger({ dir, stderr: false });
const BUILT = { version: "0.1.0", build: "fixture" };

const forward = (service: boolean): RepairOutcome => {
  const journal: Journal = {
    format: 1,
    kind: "update",
    from: "0.1.0",
    to: "0.2.0",
    phase: "switched",
    pid: 1,
    started_at: new Date(0).toISOString(),
    staging: null,
    service,
    tested: true,
    launchers: [],
  };
  return { kind: "rolled_forward", journal, current: "0.2.0" };
};

describe("[A2.3.12.6.update.restart-consent] a running service restarts itself after a repair only on the person's agreement", () => {
  test("at its start it restarts on the version current names; while it runs, only for an update whose person agreed", () => {
    const kept: RepairOutcome = { kind: "kept", current: "0.2.0", launchers: [] };
    expect(afterRepair(log, forward(false), "manual", false, BUILT)).toBe(true);
    expect(afterRepair(log, forward(true), "manual", true, BUILT)).toBe(true);
    // An install never restarts the service, nor does an update whose person was not asked: the
    // new version takes effect at the next start.
    expect(afterRepair(log, forward(false), "manual", true, BUILT)).toBe(false);
    expect(afterRepair(log, kept, "manual", true, BUILT)).toBe(false);
    // From source there is no version to restart on.
    expect(afterRepair(log, forward(true), "manual", true, { ...BUILT, build: "source" })).toBe(
      false,
    );
  });
});
