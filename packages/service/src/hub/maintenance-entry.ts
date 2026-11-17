// The maintenance worker's entry: one space's backup upkeep, off the main thread, which holds no
// SQLite connection. The job comes in workerData, and one content-free report or a code goes back:
// leftovers, the daily backup when it is due, retention.
import { parentPort, workerData } from "node:worker_threads";
import {
  applyRetention,
  backupSpace,
  backupsFolder,
  CheckedDriver,
  dailyBackupDue,
  DEFAULT_DRIVER,
  listBackups,
  loadDriver,
  planRetention,
  removeBackupLeftovers,
} from "@tasks/storage";
import type { MaintenanceJob, MaintenanceReply } from "./maintenance.ts";

const reply = (message: MaintenanceReply): void => {
  parentPort?.postMessage(message);
};

const job = workerData as MaintenanceJob;
try {
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  const dir = job.backupDir ?? backupsFolder(job.folder);
  const clock = { now: job.now, utcOffsetMinutes: job.utcOffsetMinutes };
  let listing = listBackups(dir);
  // Only in a backups folder this service alone writes: see maintenance.ts.
  const leftovers = job.cleanup ? removeBackupLeftovers(listing, { now: job.now }).length : 0;
  if (leftovers > 0) listing = listBackups(dir);
  const due = dailyBackupDue(listing, clock, { atStart: job.atStart, spaceId: job.spaceId });
  let searchIndexDamaged = false;
  let after = clock;
  if (due) {
    const taken = await backupSpace(checked, job.folder, {
      kind: "daily",
      ...(job.backupDir === undefined ? {} : { backupDir: job.backupDir }),
    });
    searchIndexDamaged = taken.searchIndexRemade === true;
    listing = listBackups(dir);
    // The backup is dated after the job's `now`, and retention leaves out a backup from its
    // future: the clock moves up to it, so the backup just made is trial restored too.
    if (taken.sidecar.created_at > after.now) after = { ...after, now: taken.sidecar.created_at };
  }
  // Retention verifies the newest backups in full, so it runs at the start and after a backup only.
  const retention =
    due || job.atStart
      ? await applyRetention(
          checked,
          listing,
          planRetention(listing, after, { spaceId: job.spaceId }),
        )
      : undefined;
  const verifiedAt =
    retention?.verified === undefined
      ? undefined
      : listing.backups.find((b) => b.name === retention.verified)?.sidecar?.created_at;
  // Backups of the space newer than the one that restores whose files are no longer whole (data
  // missing or of another size): retention passes them over, and they do not restore either.
  const broken =
    retention === undefined
      ? 0
      : listing.backups.filter((b) => {
          const at = b.sidecar?.created_at;
          return (
            b.state !== "ok" &&
            b.sidecar?.space_id === job.spaceId &&
            at !== undefined &&
            at > (verifiedAt ?? 0) &&
            at <= after.now
          );
        }).length;
  reply({
    ok: true,
    report: {
      leftovers,
      backup: due ? "taken" : "not_due",
      removed: retention?.removed.length ?? 0,
      unverified: (retention?.unverified.length ?? 0) + broken,
      ...(searchIndexDamaged ? { searchIndexDamaged: true as const } : {}),
      ...(retention === undefined ? {} : { checked: true as const }),
      ...(verifiedAt === undefined ? {} : { verifiedAt }),
    },
  });
} catch (error) {
  // Only the code crosses: the message can name a path.
  const code = (error as { code?: unknown } | null)?.code;
  reply({ ok: false, ...(typeof code === "string" ? { code } : {}) });
}
