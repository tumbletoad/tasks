// When a daily backup is due, and which backups to keep (A1 3.18). These are pure functions of a
// listing and the clock, so the scheduler that calls them (the service's maintenance worker, M1.08)
// stays a thin loop.
//
// - Daily: at the first idle minute after 03:00 local time, or at start when the last daily backup
//   is older than 24 hours.
// - Kept: the newest daily backup of each of the 7 most recent local days that have one, the newest
//   daily backup of each of the 4 most recent local weeks (Monday to Sunday) that have one,
//   pre-migration backups for 30 days, manual backups always (the person asked for them), and never
//   the newest complete backup of any kind.
// - Only complete backups (state "ok") of THIS space take part. A backups folder can hold another
//   space's backups (a machine-local backup.dir set to one folder twice): those are neither kept,
//   removed nor counted. A backup the listing could not verify is never removed here: a person
//   looks at it first.
// - A1's "never the newest verified backup" means a backup that would restore: before
//   applyRetention removes anything, it verifies the newest complete backups, one by one, with
//   exactly the checks a restore makes (verifyBackup, verify.ts), until one passes, and keeps that
//   one. A newer one that does not verify is kept too, for a person. When none verifies, nothing
//   is removed.
// - Removal looks at each file again, since the listing may be stale: only the two regular files
//   of a listed backup are removed, one at a time, never a folder or a link put in their place,
//   and only while the sidecar still reads as listed and the data still has its size and SHA-256.
// - A backup dated after `now` (a clock that once ran ahead) is kept, and counts for nothing: it is
//   not the last daily backup (it would hold back every daily backup until the clock caught up),
//   nor the newest backup, nor the newest of its day or week, nor the newest verified one (it would
//   take those places, and every backup made since the clock came back would be removed).
//
// Local time is the UTC offset the caller passes for `now`, so the result is the same on every
// machine for the same inputs. Across a daylight-saving change a day boundary moves by the change.
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, rmSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fsyncFolder } from "../files.ts";
import type { Id } from "../ids.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { verifyBackup, type BackupListing, type ListedBackup } from "./list.ts";
import { BUNDLE_POLICY, type BundlePolicy } from "./policy.ts";
import { DATA_SUFFIX, readSidecar, SIDECAR_SUFFIX } from "./sidecar.ts";
import type { VerifyOptions } from "./verify.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface RetentionRules {
  daily: number;
  weekly: number;
  preMigrateDays: number;
  /** The local hour after which the daily backup is due. */
  dailyHour: number;
}

/** A1 3.18's rules. */
export const RETENTION: Readonly<RetentionRules> = Object.freeze({
  daily: 7,
  weekly: 4,
  preMigrateDays: 30,
  dailyHour: 3,
});

export interface LocalClock {
  now: number;
  /** Minutes east of UTC at `now`: `-new Date(now).getTimezoneOffset()`. */
  utcOffsetMinutes: number;
}

const localDay = (ms: number, offsetMinutes: number): number =>
  Math.floor((ms + offsetMinutes * 60_000) / DAY);

/** Monday-based week number. Day 0 (1970-01-01) was a Thursday, so Monday 1969-12-29 is -3. */
const localWeek = (ms: number, offsetMinutes: number): number =>
  Math.floor((localDay(ms, offsetMinutes) + 3) / 7);

/** The most recent local `hour`:00 at or before `now`, in UTC milliseconds. */
export function lastLocalHour(clock: LocalClock, hour: number): number {
  const offset = clock.utcOffsetMinutes * 60_000;
  const local = clock.now + offset;
  let at = Math.floor(local / DAY) * DAY + hour * HOUR;
  if (at > local) at -= DAY;
  return at - offset;
}

const createdAt = (b: ListedBackup): number => b.sidecar?.created_at ?? 0;

/** The complete backups of the space `spaceId`, newest first. */
const complete = (listing: BackupListing, spaceId: Id<"sp">): ListedBackup[] =>
  listing.backups
    .filter((b) => b.state === "ok" && b.sidecar?.space_id === spaceId)
    .sort((a, b) => createdAt(b) - createdAt(a));

/**
 * Whether a daily backup is due. `atStart` is the service's start: then a daily backup older than
 * 24 hours is due at once. Otherwise one is due once the local 03:00 has passed since the last.
 */
export function dailyBackupDue(
  listing: BackupListing,
  clock: LocalClock,
  options: { atStart: boolean; spaceId: Id<"sp">; rules?: RetentionRules },
): boolean {
  const rules = options.rules ?? RETENTION;
  const dailies = complete(listing, options.spaceId).filter(
    (b) => b.sidecar?.kind === "daily" && createdAt(b) <= clock.now,
  );
  const last = Math.max(...dailies.map(createdAt), Number.NEGATIVE_INFINITY);
  if (last === Number.NEGATIVE_INFINITY) return true;
  if (options.atStart && clock.now - last > DAY) return true;
  return last < lastLocalHour(clock, rules.dailyHour);
}

export interface RetentionPlan {
  /** The space whose backups the plan is about. */
  spaceId: Id<"sp">;
  /** Names of the backups to keep. */
  keep: string[];
  /** Names of the complete backups to remove. */
  remove: string[];
  /** Names of the kept backups dated after `now`: they take no part in the rules or the checks. */
  ahead: string[];
}

/** Which complete backups of the space `spaceId` to keep and which to remove. */
export function planRetention(
  listing: BackupListing,
  clock: LocalClock,
  options: { spaceId: Id<"sp">; rules?: RetentionRules },
): RetentionPlan {
  const rules = options.rules ?? RETENTION;
  const all = complete(listing, options.spaceId);
  // A backup dated after now is kept and counts for nothing: it would take the newest place and
  // the newest days and weeks, and every backup made since the clock came back would go.
  const ahead = all.filter((b) => createdAt(b) > clock.now).map((b) => b.name);
  const backups = all.filter((b) => createdAt(b) <= clock.now);
  const keep = new Set<string>(ahead);
  const newest = backups[0];
  if (newest !== undefined) keep.add(newest.name);
  const offset = clock.utcOffsetMinutes;
  const pickNewestPer = (bucket: (ms: number) => number, count: number): void => {
    const seen = new Set<number>();
    for (const b of backups) {
      if (b.sidecar?.kind !== "daily") continue;
      const key = bucket(createdAt(b));
      if (seen.has(key)) continue;
      if (seen.size >= count) break;
      seen.add(key);
      keep.add(b.name);
    }
  };
  pickNewestPer((ms) => localDay(ms, offset), rules.daily);
  pickNewestPer((ms) => localWeek(ms, offset), rules.weekly);
  for (const b of backups) {
    if (b.sidecar?.kind === "manual") keep.add(b.name);
    if (
      b.sidecar?.kind === "pre-migrate" &&
      clock.now - createdAt(b) < rules.preMigrateDays * DAY
    ) {
      keep.add(b.name);
    }
  }
  return {
    spaceId: options.spaceId,
    keep: all.filter((b) => keep.has(b.name)).map((b) => b.name),
    remove: all.filter((b) => !keep.has(b.name)).map((b) => b.name),
    ahead,
  };
}

export interface RetentionResult {
  /** Names of the backups removed. */
  removed: string[];
  /** The newest backup that verified in full, kept whatever the plan said. Undefined: none did. */
  verified: string | undefined;
  /** Newer complete backups that did not verify, kept for a person to look at, newest first. */
  unverified: string[];
}

/** What tests inject. Not part of the package's interface. */
export interface RetentionSeams {
  /** Runs after a removal candidate's data was read and hashed, before it is checked again. */
  hashed?: (name: string) => void;
}

/** A regular file's identity and state, or undefined when there is none at `path`. */
function fileState(path: string): BigIntStats | undefined {
  try {
    const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return stats?.isFile() === true ? stats : undefined;
  } catch {
    return undefined;
  }
}

const unchanged = (before: BigIntStats, path: string): boolean => {
  const now = fileState(path);
  return (
    now !== undefined &&
    now.dev === before.dev &&
    now.ino === before.ino &&
    now.size === before.size &&
    now.mtimeNs === before.mtimeNs
  );
};

/**
 * Whether a listed backup's files on disk are still that backup: both are regular files, its
 * sidecar reads the same as the listing's, and its data has the sidecar's compressed size and
 * SHA-256. The data is read through a stream, which keeps reading the file it opened even when
 * another file takes its name meanwhile, so afterwards both names must still be the files that
 * were checked (identity, size and modification time) and the sidecar must still read the same.
 * Removal then follows at once, by name: no file system offers "remove this file if it is still
 * that one", so a replacement in that last moment is not seen.
 */
async function stillListed(
  listed: ListedBackup,
  sidecarFile: string,
  dataFile: string,
  policy: BundlePolicy,
  seams: RetentionSeams,
): Promise<boolean> {
  const expected = listed.sidecar;
  if (expected === undefined) return false;
  const sidecarBefore = fileState(sidecarFile);
  const dataBefore = fileState(dataFile);
  if (sidecarBefore === undefined || dataBefore === undefined) return false;
  const reads = (): boolean => {
    const read = readSidecar(sidecarFile, policy.maxOtherFileBytes);
    return read.state === "ok" && isDeepStrictEqual(read.sidecar, expected);
  };
  if (!reads()) return false;
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(dataFile)) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > expected.compressed_size) return false;
      hash.update(bytes);
    }
    if (size !== expected.compressed_size || hash.digest("hex") !== expected.compressed_sha256) {
      return false;
    }
  } catch {
    return false;
  }
  seams.hashed?.(listed.name);
  return unchanged(sidecarBefore, sidecarFile) && unchanged(dataBefore, dataFile) && reads();
}

/**
 * Removes the backups a plan names, once the newest backup that verifies in full is known and
 * kept (A1 3.18: never the newest verified backup). Each removal deletes the sidecar first: a
 * backup without its sidecar is no longer one, so a crash in between leaves a leftover `.db.gz`,
 * never a sidecar without its data. When a sidecar cannot be removed (a file held open on
 * Windows), its data stays too. Only complete backups of the plan's space are removed, never one
 * the plan keeps, one that did not verify, or the verified one, and only while both of their
 * files are still regular files.
 */
export async function applyRetention(
  checked: CheckedDriver,
  listing: BackupListing,
  plan: RetentionPlan,
  options: VerifyOptions = {},
): Promise<RetentionResult> {
  return applyRetentionWith(checked, listing, plan, options, {});
}

/** applyRetention with test seams. */
export async function applyRetentionWith(
  checked: CheckedDriver,
  listing: BackupListing,
  plan: RetentionPlan,
  options: VerifyOptions,
  seams: RetentionSeams,
): Promise<RetentionResult> {
  const backups = complete(listing, plan.spaceId);
  const ahead = new Set(plan.ahead);
  const unverified: string[] = [];
  let verified: string | undefined;
  for (const b of backups) {
    // Kept whatever happens: the newest verified backup is one dated at or before now.
    if (ahead.has(b.name)) continue;
    // The sidecar is read again from disk by the verification, and must still name this space.
    if ((await verifyBackup(checked, b, options))?.space_id === plan.spaceId) {
      verified = b.name;
      break;
    }
    unverified.push(b.name);
  }
  if (verified === undefined) return { removed: [], verified, unverified };
  const removable = new Set(plan.remove);
  for (const name of [...plan.keep, ...plan.ahead, verified, ...unverified]) {
    removable.delete(name);
  }
  const removed: string[] = [];
  for (const b of backups) {
    if (!removable.has(b.name)) continue;
    const sidecarFile = join(listing.folder, `${b.name}${SIDECAR_SUFFIX}`);
    const dataFile = join(listing.folder, `${b.name}${DATA_SUFFIX}`);
    // The listing may be stale (a verification takes time, and a synced folder changes under
    // it): a backup goes only while its two files are still the ones the plan was made from.
    const policy = options.policy ?? BUNDLE_POLICY;
    if (!(await stillListed(b, sidecarFile, dataFile, policy, seams))) continue;
    try {
      // Not recursive: each is one file.
      rmSync(sidecarFile, { force: true });
      // The sidecar's removal is durable before the data goes, so a power loss cannot bring back
      // a sidecar whose data is gone.
      fsyncFolder(listing.folder);
    } catch {
      continue;
    }
    try {
      rmSync(dataFile, { force: true });
    } catch {
      // Without its sidecar the data is a leftover now, which the next cleanup removes.
    }
    removed.push(b.name);
  }
  return { removed, verified, unverified };
}
