import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { backupSpace, backupsFolder, createSpace, listBackups, newId } from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
import { tempRoot } from "../../test/harness.ts";
import { Maintenance } from "./maintenance.ts";

const cleanups: (() => void)[] = [];
const runners: Maintenance[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const DAY_MINUTES = 24 * 60;

/** Minutes east of UTC that make `now` local noon, so no daily hour falls inside a test. */
const noonAt = (now: number): number => {
  const minutes = Math.floor(now / 60_000) % DAY_MINUTES;
  return 12 * 60 - minutes;
};

describe("[A1.5.backup.failure-shown] the upkeep's verdict on a space's newest backups", () => {
  test("the daily backup a run makes is trial restored in that run, and a newer backup whose files are not whole counts as one that does not restore", async () => {
    const { root, cleanup } = tempRoot("upkeep");
    cleanups.push(cleanup);
    const checked = await checkedDriver();
    const space = createSpace(checked, join(root, "mira"), {
      name: "Mira",
      ownerLabel: "Mira Okafor",
      machineId: newId("m"),
    });
    const runner = new Maintenance();
    runners.push(runner);
    // A job is made a moment before its worker takes the backup.
    const start = Date.now() - 1000;
    const utcOffsetMinutes = noonAt(start);
    const job = {
      folder: space.folder,
      spaceId: space.space.spaceId,
      cleanup: true,
      atStart: true,
      utcOffsetMinutes,
    };

    const first = await runner.run({ ...job, now: start });
    expect(first.backup).toBe("taken");
    const daily = listBackups(backupsFolder(space.folder)).backups.find(
      (b) => b.sidecar?.kind === "daily",
    );
    expect(daily?.sidecar?.created_at).toBeGreaterThan(start);
    expect(first).toMatchObject({ checked: true, unverified: 0 });
    expect(first.verifiedAt).toBe(daily?.sidecar?.created_at);

    // A backup made after it loses part of its data.
    const dailyAt = daily?.sidecar?.created_at ?? 0;
    const later = await backupSpace(checked, space.folder, {
      kind: "manual",
      now: () => dailyAt + 2000,
    });
    writeFileSync(later.file, "cut short");
    const second = await runner.run({ ...job, now: dailyAt + 5000 });
    expect(second).toMatchObject({ backup: "not_due", checked: true, unverified: 1 });
    expect(second.verifiedAt).toBe(dailyAt);
  }, 60_000);
});
