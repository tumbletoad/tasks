// The maintenance worker's entry: one space's backup upkeep, off the main thread, which holds no
// SQLite connection. The job comes in workerData, and one content-free report or a code goes back:
// at a start the move of the space's old backups, then leftovers, the daily backup when it is due,
// and retention over the backups folder and the space's own folder as one list.
import { parentPort, workerData } from "node:worker_threads";
import {
  applyRetention,
  backupHistories,
  backupSpace,
  backupsFolder,
  CheckedDriver,
  compareInHistory,
  dailyBackupDue,
  DEFAULT_DRIVER,
  listBackups,
  listBackupsIn,
  loadDriver,
  moveOldBackups,
  oldDailies,
  recordedOldDailies,
  planRetention,
  removeBackupLeftovers,
  type BackupListing,
  type Id,
  type StayReason,
} from "@ttasks/storage";
import {
  PRUNE_OLD_DAILIES,
  type MaintenanceJob,
  type MaintenanceReply,
  type MaintenanceReport,
} from "./maintenance.ts";

const reply = (message: MaintenanceReply): void => {
  parentPort?.postMessage(message);
};

/**
 * The old daily backups retention keeps: those still in the space's own folder and those the
 * backups folder's record names (storage's moveOldBackups). A record that does not read keeps
 * every backup, since any daily one may be old.
 */
function keptOld(listing: BackupListing, spaceId: Id<"sp">, old: readonly string[]): string[] {
  const recorded = recordedOldDailies(listing.folder, spaceId);
  return recorded === undefined ? listing.backups.map((b) => b.name) : [...old, ...recorded];
}

async function upkeep(job: MaintenanceJob): Promise<MaintenanceReport> {
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  const dir = job.backupDir;
  const clock = { now: job.now, utcOffsetMinutes: job.utcOffsetMinutes };
  let listing = listBackups(dir);
  // A backups folder that is not there may be on a drive that is not connected: no backup goes to
  // a new folder in its place, where nobody looks for it.
  if (!listing.present) {
    return { leftovers: 0, backup: "away", removed: 0, unverified: 0 };
  }
  // Found before the move, so a backup whose move ends in this run is kept in it either way.
  const old = oldDailies(job.folder, dir, job.spaceId);
  const moved = job.atStart
    ? await moveOldBackups(job.folder, dir, job.spaceId, job.now)
    : undefined;
  // Only in a backups folder this service alone writes: see maintenance.ts.
  const leftovers = job.cleanup ? removeBackupLeftovers(listing, { now: job.now }).length : 0;
  const both = (): typeof listing => listBackupsIn([dir, backupsFolder(job.folder)]);
  listing = both();
  // Only this copy's history counts: another copy's daily in a shared folder is not this one's.
  const due = dailyBackupDue(listing, clock, {
    atStart: job.atStart,
    spaceId: job.spaceId,
    incarnation: job.incarnation,
  });
  let searchIndexDamaged = false;
  let after = clock;
  if (due) {
    const taken = await backupSpace(checked, job.folder, { kind: "daily", backupDir: dir });
    searchIndexDamaged = taken.searchIndexRemade === true;
    listing = both();
    // The backup is dated after the job's `now`, and retention leaves out a backup from its
    // future: the clock moves up to it, so the backup just made is trial restored too.
    if (taken.sidecar.created_at > after.now) after = { ...after, now: taken.sidecar.created_at };
  }
  // Retention verifies the newest backups in full, so it runs at the start and after a backup only.
  // Each history is kept on its own; the report is of this copy's.
  const retention =
    due || job.atStart
      ? await applyRetention(
          checked,
          listing,
          planRetention(listing, after, {
            spaceId: job.spaceId,
            always:
              (job.pruneOldDailies ?? PRUNE_OLD_DAILIES) ? old : keptOld(listing, job.spaceId, old),
          }),
          { history: job.incarnation },
        )
      : undefined;
  const own = backupHistories(listing, job.spaceId).find((h) => h.incarnation === job.incarnation);
  const named = (name: string | undefined) =>
    name === undefined ? undefined : own?.backups.find((b) => b.name === name);
  const verified = named(retention?.verified);
  const verifiedAt = verified?.sidecar?.created_at;
  // Backups of this copy's history newer than the one that restores, or than the one whose trial
  // could not run, whose files are no longer whole (data missing or of another size): retention
  // passes them over, and they do not restore either. A `.db.gz` whose sidecar is missing or does
  // not read names no history, so it counts for no copy: `space backups` lists it as it is.
  const newestKnown = verified ?? named(retention?.unchecked?.name);
  const broken =
    retention === undefined
      ? 0
      : (own?.backups ?? []).filter(
          (b) =>
            b.state !== "ok" &&
            (newestKnown === undefined || compareInHistory(b, newestKnown) < 0) &&
            b.createdAt <= after.now,
        ).length;
  const unchecked = retention?.unchecked;
  const stayed: Partial<Record<StayReason, number>> = {};
  for (const { why } of moved?.stayed ?? []) stayed[why] = (stayed[why] ?? 0) + 1;
  return {
    leftovers,
    ...(moved === undefined
      ? {}
      : {
          moved: { copied: moved.copied.length, finished: moved.finished.length, stayed },
        }),
    backup: due ? "taken" : "not_due",
    removed: retention?.removed.length ?? 0,
    unverified: (retention?.unverified.length ?? 0) + broken,
    ...(searchIndexDamaged ? { searchIndexDamaged: true as const } : {}),
    ...(retention === undefined ? {} : { checked: true as const }),
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
    ...(unchecked === undefined
      ? {}
      : { unchecked: unchecked.code === undefined ? {} : { code: unchecked.code } }),
  };
}

try {
  reply({ ok: true, report: await upkeep(workerData as MaintenanceJob) });
} catch (error) {
  // Only the code crosses: the message can name a path.
  const code = (error as { code?: unknown } | null)?.code;
  reply({ ok: false, ...(typeof code === "string" ? { code } : {}) });
}
