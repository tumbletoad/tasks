import { existsSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  backupSpace,
  backupsFolder,
  createSpace,
  listBackups,
  listBackupsIn,
  newId,
  restoreBackup,
} from "@ttasks/storage";
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
    // The service makes the write folder before a run (space-settings.ts readyBackupsFolder).
    mkdirSync(backupsFolder(space.folder));
    const runner = new Maintenance();
    runners.push(runner);
    // A job is made a moment before its worker takes the backup.
    const start = Date.now() - 1000;
    const utcOffsetMinutes = noonAt(start);
    const job = {
      folder: space.folder,
      spaceId: space.space.spaceId,
      incarnation: space.space.authority.incarnation,
      backupDir: backupsFolder(space.folder),
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

  test("a newer backup whose sidecar is missing or does not read names no copy: it stays listed and counts for none", async () => {
    const { root, cleanup } = tempRoot("upkeep-sidecar");
    cleanups.push(cleanup);
    const checked = await checkedDriver();
    const space = createSpace(checked, join(root, "mira"), {
      name: "Mira",
      ownerLabel: "Mira Okafor",
      machineId: newId("m"),
    });
    mkdirSync(backupsFolder(space.folder));
    const runner = new Maintenance();
    runners.push(runner);
    const start = Date.now() - 1000;
    const job = {
      folder: space.folder,
      spaceId: space.space.spaceId,
      incarnation: space.space.authority.incarnation,
      backupDir: backupsFolder(space.folder),
      cleanup: true,
      atStart: true,
      utcOffsetMinutes: noonAt(start),
    };
    const first = await runner.run({ ...job, now: start });
    const dailyAt = first.verifiedAt ?? 0;
    expect(first).toMatchObject({ backup: "taken", checked: true, unverified: 0 });

    const cut = await backupSpace(checked, space.folder, {
      kind: "manual",
      now: () => dailyAt + 2000,
    });
    const state = () =>
      listBackups(backupsFolder(space.folder)).backups.find((b) => b.name === cut.name)?.state;
    writeFileSync(cut.sidecarFile, "{");
    const second = await runner.run({ ...job, now: dailyAt + 5000 });
    expect(second).toMatchObject({ checked: true, unverified: 0, verifiedAt: dailyAt });
    expect(state()).toBe("invalid_sidecar");

    rmSync(cut.sidecarFile);
    const third = await runner.run({ ...job, now: dailyAt + 6000 });
    expect(third).toMatchObject({ checked: true, unverified: 0, verifiedAt: dailyAt });
    expect(state()).toBe("missing_sidecar");
  }, 60_000);
});

describe("[A1.5.backup.kept-unknown] the upkeep removes only files it knows to be its own leftovers", () => {
  test("a manual backup whose sidecar went missing keeps its data, and restores once its sidecar is back", async () => {
    const { root, cleanup } = tempRoot("upkeep-orphan");
    cleanups.push(cleanup);
    const checked = await checkedDriver();
    const space = createSpace(checked, join(root, "mira"), {
      name: "Mira",
      ownerLabel: "Mira Okafor",
      machineId: newId("m"),
    });
    const manual = await backupSpace(checked, space.folder, {
      kind: "manual",
      now: () => Date.now() - 3 * HOUR,
    });
    // Copied elsewhere on its own, say: the data stays, older than any backup in progress.
    const aside = join(root, "sidecar.json");
    renameSync(manual.sidecarFile, aside);
    utimesSync(manual.file, new Date(Date.now() - 3 * HOUR), new Date(Date.now() - 3 * HOUR));

    const runner = new Maintenance();
    runners.push(runner);
    const now = Date.now();
    const report = await runner.run({
      folder: space.folder,
      spaceId: space.space.spaceId,
      incarnation: space.space.authority.incarnation,
      backupDir: backupsFolder(space.folder),
      cleanup: true,
      atStart: true,
      now,
      utcOffsetMinutes: noonAt(now),
    });
    expect(report.leftovers).toBe(0);
    expect(existsSync(manual.file)).toBe(true);
    const listed = listBackups(backupsFolder(space.folder));
    expect(listed.backups.find((b) => b.name === manual.name)?.state).toBe("missing_sidecar");

    renameSync(aside, manual.sidecarFile);
    const restored = await restoreBackup(checked, manual.file, join(root, "copy"));
    expect(restored.space.spaceId).toBe(space.space.spaceId);
  }, 60_000);

  test("a backup taken before an upgrade stays after 30 days, beside newer daily backups", async () => {
    const { root, cleanup } = tempRoot("upkeep-barrier");
    cleanups.push(cleanup);
    const checked = await checkedDriver();
    const space = createSpace(checked, join(root, "mira"), {
      name: "Mira",
      ownerLabel: "Mira Okafor",
      machineId: newId("m"),
    });
    const now = Date.now();
    const barrier = await backupSpace(checked, space.folder, {
      kind: "pre-migrate",
      now: () => now - 31 * DAY,
    });
    const runner = new Maintenance();
    runners.push(runner);
    const report = await runner.run({
      folder: space.folder,
      spaceId: space.space.spaceId,
      incarnation: space.space.authority.incarnation,
      backupDir: backupsFolder(space.folder),
      cleanup: true,
      atStart: true,
      now,
      utcOffsetMinutes: noonAt(now),
    });
    expect(report).toMatchObject({ backup: "taken", checked: true, unverified: 0, removed: 0 });
    expect(existsSync(barrier.file) && existsSync(barrier.sidecarFile)).toBe(true);
  }, 60_000);
});

describe("[A1.5.backup.old-move] the upkeep moves a space's old backups and keeps its old daily ones", () => {
  /** A space with three daily backups in its own folder, 40 days and more old, and newer ones in its backups folder. */
  async function old(label: string) {
    const { root, cleanup } = tempRoot(label);
    cleanups.push(cleanup);
    const checked = await checkedDriver();
    const space = createSpace(checked, join(root, "mira"), {
      name: "Mira",
      ownerLabel: "Mira Okafor",
      machineId: newId("m"),
    });
    const start = Date.now();
    const dailies = [];
    for (let i = 0; i < 3; i += 1) {
      dailies.push(
        await backupSpace(checked, space.folder, {
          kind: "daily",
          now: () => start - (40 + i) * DAY,
        }),
      );
    }
    // Daily backups since in the backups folder, so the rules keep none of the old ones: one on
    // each of the last 7 days and one in each of the 3 weeks before.
    const outside = join(root, "outside");
    mkdirSync(outside);
    for (const days of [1, 2, 3, 4, 5, 6, 7, 14, 21, 28]) {
      await backupSpace(checked, space.folder, {
        kind: "daily",
        backupDir: outside,
        now: () => start - days * DAY,
      });
    }
    const runner = new Maintenance();
    runners.push(runner);
    const job = {
      folder: space.folder,
      spaceId: space.space.spaceId,
      incarnation: space.space.authority.incarnation,
      backupDir: outside,
      cleanup: true,
      atStart: true,
      utcOffsetMinutes: noonAt(start),
    };
    return { space, dailies, outside, runner, job, start };
  }

  /** The old backups of `names` listed complete in either folder. */
  const kept = (space: { folder: string }, outside: string, names: readonly string[]): string[] =>
    listBackupsIn([outside, backupsFolder(space.folder)])
      .backups.filter((b) => b.state === "ok" && names.includes(b.name))
      .map((b) => b.name)
      .sort();

  test("old daily backups are never removed: while they move, and after, wherever they stand", async () => {
    const { space, dailies, outside, runner, job, start } = await old("old-kept");
    const names = dailies.map((b) => b.name).sort();
    const first = await runner.run({ ...job, now: start });
    expect(first.moved).toEqual({ copied: 3, finished: 0, stayed: {} });
    expect(first.oldDailies?.slice().sort()).toEqual(names);
    expect(kept(space, outside, names)).toEqual(names);
    const recorded = { oldDailies: first.oldDailies ?? [] };
    const second = await runner.run({ ...job, ...recorded, now: start + 2 * HOUR });
    expect(second.moved).toMatchObject({ copied: 0, finished: 3 });
    expect(existsSync(backupsFolder(space.folder))).toBe(false);
    await runner.run({ ...job, ...recorded, now: start + 3 * HOUR });
    expect(kept(space, outside, names)).toEqual(names);
  }, 120_000);

  test("with pruning on, old daily backups fall under the rules from the run after the one that finished their move", async () => {
    const { space, dailies, outside, runner, job, start } = await old("old-pruned");
    const names = dailies.map((b) => b.name).sort();
    const prune = { ...job, pruneOldDailies: true };
    await runner.run({ ...prune, now: start });
    expect(kept(space, outside, names)).toEqual(names);
    const finishing = await runner.run({ ...prune, now: start + 2 * HOUR });
    expect(finishing.moved).toMatchObject({ finished: 3 });
    expect(kept(space, outside, names)).toEqual(names);
    await runner.run({ ...prune, now: start + 3 * HOUR });
    expect(kept(space, outside, names)).toEqual([]);
  }, 120_000);

  test("a run stopped in the middle ends as stopped, and every old backup is still listed once and whole", async () => {
    const { space, dailies, outside, runner, job, start } = await old("old-stopped");
    const names = dailies.map((b) => b.name).sort();
    const stop = new AbortController();
    const run = runner.run({ ...job, now: start }, stop.signal);
    stop.abort();
    await expect(run).rejects.toMatchObject({ stopped: true });
    const listed = listBackupsIn([outside, backupsFolder(space.folder)]).backups;
    expect(
      listed
        .filter((b) => names.includes(b.name))
        .map((b) => b.name)
        .sort(),
    ).toEqual(names);
    expect(kept(space, outside, names)).toEqual(names);
  }, 120_000);
});
