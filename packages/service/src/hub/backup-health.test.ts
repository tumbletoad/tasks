import { describe, expect, test } from "vitest";
import {
  afterFailure,
  afterProvenBackup,
  afterRun,
  BackupWatch,
  troubleView,
  type BackupHealth,
} from "./backup-health.ts";
import type { MaintenanceReport } from "./maintenance.ts";

const run = (extra: Partial<MaintenanceReport> = {}): MaintenanceReport => ({
  leftovers: 0,
  backup: "not_due",
  removed: 0,
  unverified: 0,
  ...extra,
});

const AT = Date.UTC(2026, 10, 14, 3, 15);

describe("[A1.5.backup.failure-shown] what a space's backups report, run by run", () => {
  test("a refusal for want of disk space says so; another failure names its code; both say what to run", () => {
    const full = troubleView(afterFailure({}, "BUNDLE_LIMIT_EXCEEDED"));
    expect(full).toMatchObject({ why: "disk_full", code: "BUNDLE_LIMIT_EXCEEDED" });
    expect(full?.message).toMatch(/^The daily backup failed: the disk has too little free space/);
    // A write that failed may be a full disk or a failing one: the report does not guess.
    expect(troubleView(afterFailure({}, "DURABILITY_FAILED"))?.why).toBe("failed");
    const other = troubleView(afterFailure({}, "BACKUP_FAILED"));
    expect(other?.why).toBe("failed");
    for (const view of [full, other]) expect(view?.message).toContain("space backup <folder>");
  });

  test("the newest backup known to restore is kept across runs and named", () => {
    const good = afterRun({}, run({ backup: "taken", checked: true, verifiedAt: AT }));
    expect(good).toEqual({ lastGood: AT });
    expect(troubleView(good)).toBeUndefined();
    const view = troubleView(afterFailure(good, "BACKUP_FAILED"));
    expect(view?.last_good).toBe(new Date(AT).toISOString());
    expect(view?.message).toMatch(
      /The newest backup that restores is from \d{4}-\d\d-\d\d \d\d:\d\d\.$/,
    );
  });

  test("a failure goes with the next run that succeeds; a backup that does not restore waits for a verdict", () => {
    const failed: BackupHealth = afterFailure({ lastGood: AT }, "BACKUP_FAILED");
    expect(afterRun(failed, run())).toEqual({ lastGood: AT });

    const unverified = afterRun({}, run({ backup: "taken", checked: true, unverified: 1 }));
    expect(troubleView(unverified)?.why).toBe("unverified");
    // An hourly run that took no backup and verified nothing changes nothing about it.
    expect(afterRun(unverified, run())).toEqual(unverified);
    expect(afterRun(unverified, run({ checked: true, verifiedAt: AT }))).toEqual({ lastGood: AT });
  });

  test("a backup the person made that passed its trial restore clears every report", () => {
    expect(afterProvenBackup(AT)).toEqual({ lastGood: AT });
    expect(troubleView(afterProvenBackup(AT))).toBeUndefined();
  });

  test("a run that began before a person's proven backup does not bring back its report", () => {
    const watch = new BackupWatch();
    const failing = watch.begin();
    watch.failed(failing, "BUNDLE_LIMIT_EXCEEDED");
    expect(watch.view()?.why).toBe("disk_full");

    // An hourly run is under way, still seeing yesterday's backups, when the person makes one now.
    const slow = watch.begin();
    watch.proven(AT);
    watch.ran(slow, run({ checked: true, unverified: 1, verifiedAt: AT - 86_400_000 }));
    expect(watch.view()).toBeUndefined();
    watch.failed(slow, "BACKUP_FAILED");
    expect(watch.view()).toBeUndefined();

    // A run begun after it reports as usual.
    const next = watch.begin();
    watch.ran(next, run({ checked: true, unverified: 1 }));
    expect(watch.view()).toMatchObject({
      why: "unverified",
      last_good: new Date(AT).toISOString(),
    });
  });

  test("a closed space forgets its report, and a run begun before the close adds nothing", () => {
    const watch = new BackupWatch();
    const before = watch.begin();
    watch.failed(watch.begin(), "BACKUP_FAILED");
    watch.reset();
    watch.failed(before, "BACKUP_FAILED");
    expect(watch.view()).toBeUndefined();
  });
});
