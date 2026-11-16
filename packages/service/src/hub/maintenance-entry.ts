// The maintenance worker's entry (A1 3.18, A2 3.1): one space's backup upkeep, off the main thread,
// which holds no SQLite connection (A1 3.9). The job comes in workerData, and one content-free
// report or a code goes back. M1.06's functions in A1 3.18's order: leftovers, the daily backup
// when it is due, retention.
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
  // Only in a backups folder this service alone writes (A1 3.18): see maintenance.ts.
  const leftovers = job.cleanup ? removeBackupLeftovers(listing, { now: job.now }).length : 0;
  if (leftovers > 0) listing = listBackups(dir);
  const due = dailyBackupDue(listing, clock, { atStart: job.atStart, spaceId: job.spaceId });
  let searchIndexDamaged = false;
  if (due) {
    const taken = await backupSpace(checked, job.folder, {
      kind: "daily",
      ...(job.backupDir === undefined ? {} : { backupDir: job.backupDir }),
    });
    searchIndexDamaged = taken.searchIndexRemade === true;
    listing = listBackups(dir);
  }
  // Retention verifies the newest backups in full, so it runs at the start and after a backup only.
  const retention =
    due || job.atStart
      ? await applyRetention(
          checked,
          listing,
          planRetention(listing, clock, { spaceId: job.spaceId }),
        )
      : undefined;
  const verifiedAt =
    retention?.verified === undefined
      ? undefined
      : listing.backups.find((b) => b.name === retention.verified)?.sidecar?.created_at;
  reply({
    ok: true,
    report: {
      leftovers,
      backup: due ? "taken" : "not_due",
      removed: retention?.removed.length ?? 0,
      unverified: retention?.unverified.length ?? 0,
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
