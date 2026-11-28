// When a daily backup is due, and which backups to keep (A1 3.18). These are pure functions of a
// listing and the clock, so the scheduler that calls them (the service's maintenance worker, M1.08)
// stays a thin loop.
//
// - EACH HISTORY ON ITS OWN (list.ts backupHistories): a history is one incarnation's backups, one
//   copy's line of work. Every rule below runs within one history, and no backup is kept, removed
//   or found due because of another history's: two copies claimed apart reach the same epochs and
//   commits with different work.
// - Daily: at the first idle minute after 03:00 local time, or at start when the last daily backup
//   of the copy this machine serves is older than 24 hours.
// - NEWEST IS THE FURTHEST SAVED WORK within a history: the later commit, and the clock only between
//   backups of one commit. A clock set back gives later work an earlier date, so a date never decides
//   which of two backups holds more.
// - Kept, per history: the newest daily backup of each of the 7 most recent local days that have
//   one, the newest daily backup of each of the 4 most recent local weeks (Monday to Sunday) that
//   have one, and always the newest complete backup, whatever its date. So a history no copy writes
//   any more keeps what the rules kept when it ended. Only daily backups are ever removed: a manual
//   backup is the person's, and a pre-migration or pre-import backup may be the last one an older
//   build reads.
// - Only complete backups (state "ok") of THIS space take part. A backups folder can hold another
//   space's backups (a machine-local backup.dir set to one folder twice): those are neither kept,
//   removed nor counted. A backup the listing could not verify is never removed here: a person
//   looks at it first, and one whose sidecar does not read belongs to no history.
// - A1's "never the newest verified backup" means a backup that restores, in each history: before
//   applyRetention removes anything of a history, it verifies that history's newest complete
//   backups, one by one, by a trial restore (the restore's own steps, its first write included, on
//   a scratch copy: verifyBackup), until one passes, and keeps that one. Nothing else makes a backup
//   verified. A newer one that does not verify is kept too, for a person. When none verifies,
//   nothing of the history is removed. A trial that could not check its backup (restore/fault.ts:
//   no room for it, no memory, a failing disk) says nothing of it: the search stops there, so no
//   older backup becomes the newest that restores, and nothing of the history is removed.
// - Removal looks at each file again, since the listing may be stale: only the two regular files
//   of a listed backup are removed, one at a time, never a folder or a link put in their place,
//   and only while the sidecar still reads as listed and the data still has its size and SHA-256.
// - A backup dated after `now` (a clock that once ran ahead) is kept, and counts for nothing: it is
//   not the last daily backup (it would hold back every daily backup until the clock caught up),
//   nor one of the most recent days or weeks (it would take their places, and every backup made
//   since the clock came back would be removed), nor the newest verified one.
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
import {
  backupHistories,
  verifyBackup,
  type BackupHistory,
  type BackupListing,
  type ListedBackup,
  type VerifyOptions,
} from "./list.ts";
import { BUNDLE_POLICY, type BundlePolicy } from "./policy.ts";
import { DATA_SUFFIX, readSidecar, SIDECAR_SUFFIX } from "./sidecar.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface RetentionRules {
  daily: number;
  weekly: number;
  /** The local hour after which the daily backup is due. */
  dailyHour: number;
}

/** A1 3.18's rules. */
export const RETENTION: Readonly<RetentionRules> = Object.freeze({
  daily: 7,
  weekly: 4,
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

/** A history's complete backups, newest first by the work they hold. */
const complete = (history: BackupHistory): ListedBackup[] =>
  history.backups.filter((b) => b.state === "ok");

/** The space `spaceId`'s histories that hold a complete backup, the one written to last first. */
const histories = (listing: BackupListing, spaceId: Id<"sp">): BackupHistory[] =>
  backupHistories(listing, spaceId).filter((h) => complete(h).length > 0);

/**
 * Whether a daily backup of the copy this machine serves, the incarnation `incarnation`, is due:
 * only that copy's own history counts. `atStart` is the service's start: then a daily backup older
 * than 24 hours is due at once. Otherwise one is due once the local 03:00 has passed since the last.
 */
export function dailyBackupDue(
  listing: BackupListing,
  clock: LocalClock,
  options: {
    atStart: boolean;
    spaceId: Id<"sp">;
    incarnation: Id<"ai">;
    rules?: RetentionRules;
  },
): boolean {
  const rules = options.rules ?? RETENTION;
  const own = histories(listing, options.spaceId).find(
    (h) => h.incarnation === options.incarnation,
  );
  const dailies = (own === undefined ? [] : complete(own)).filter(
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

/**
 * Which complete backups of the space `spaceId` to keep and which to remove: the rules of the
 * header, run in each history on its own.
 */
export function planRetention(
  listing: BackupListing,
  clock: LocalClock,
  options: {
    spaceId: Id<"sp">;
    rules?: RetentionRules;
    /** Names of backups kept whatever the rules say. */
    always?: readonly string[];
  },
): RetentionPlan {
  const rules = options.rules ?? RETENTION;
  const keep = new Set<string>(options.always);
  const ahead: string[] = [];
  const all: ListedBackup[] = [];
  for (const history of histories(listing, options.spaceId)) {
    const own = complete(history);
    all.push(...own);
    // A backup dated after now is kept and counts for nothing: it would take the most recent days
    // and weeks, and every backup made since the clock came back would go.
    const future = own.filter((b) => createdAt(b) > clock.now).map((b) => b.name);
    ahead.push(...future);
    for (const name of future) keep.add(name);
    const backups = own.filter((b) => createdAt(b) <= clock.now);
    const newest = backups[0];
    if (newest !== undefined) keep.add(newest.name);
    const offset = clock.utcOffsetMinutes;
    const dailies = backups.filter((b) => b.sidecar?.kind === "daily");
    // The most recent `count` local days or weeks by date, and in each the newest by work.
    const keepNewestPer = (bucket: (ms: number) => number, count: number): void => {
      const recent = [...new Set(dailies.map((b) => bucket(createdAt(b))))]
        .sort((a, b) => b - a)
        .slice(0, count);
      for (const key of recent) {
        const first = dailies.find((b) => bucket(createdAt(b)) === key);
        if (first !== undefined) keep.add(first.name);
      }
    };
    keepNewestPer((ms) => localDay(ms, offset), rules.daily);
    keepNewestPer((ms) => localWeek(ms, offset), rules.weekly);
    for (const b of backups) if (b.sidecar?.kind !== "daily") keep.add(b.name);
  }
  return {
    spaceId: options.spaceId,
    keep: all.filter((b) => keep.has(b.name)).map((b) => b.name),
    remove: all.filter((b) => !keep.has(b.name)).map((b) => b.name),
    ahead,
  };
}

/** What the trial restores found in one history. */
export interface HistoryVerdict {
  /** The newest backup that verified in full, kept whatever the plan said. Undefined: none did. */
  verified: string | undefined;
  /** Newer complete backups that did not verify, kept for a person to look at, newest first. */
  unverified: string[];
  /**
   * The backup whose trial restore could not check it (restore/fault.ts), with the code (none for a
   * bug). Nothing older was tried and nothing of the history was removed.
   */
  unchecked?: { name: string; code?: string };
}

/**
 * Names of the backups removed, and what the trial restores found in the history of the copy this
 * machine serves (`history` in the options).
 */
export interface RetentionResult extends HistoryVerdict {
  removed: string[];
}

export interface RetentionOptions extends VerifyOptions {
  /**
   * The incarnation of the copy this machine serves: its history is always trial restored, and the
   * result reports it. Default: the history written to last.
   */
  history?: Id<"ai">;
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
 * The newest of a history's complete backups `backups` (newest first) that verifies in full, with
 * the newer ones that did not, or the one a trial could not check. Backups dated after now are
 * passed over: the newest verified backup is one dated at or before now.
 */
async function newestThatRestores(
  checked: CheckedDriver,
  backups: readonly ListedBackup[],
  ahead: ReadonlySet<string>,
  spaceId: Id<"sp">,
  options: VerifyOptions,
): Promise<HistoryVerdict> {
  const unverified: string[] = [];
  for (const b of backups) {
    if (ahead.has(b.name)) continue;
    const verdict = await verifyBackup(checked, b, options);
    if (verdict.state === "unchecked") {
      const code = verdict.code === undefined ? {} : { code: verdict.code };
      return { verified: undefined, unverified, unchecked: { name: b.name, ...code } };
    }
    // The sidecar is read again from disk by the verification, and must still name this history.
    if (
      verdict.state === "verified" &&
      verdict.sidecar.space_id === spaceId &&
      verdict.sidecar.incarnation === b.sidecar?.incarnation
    ) {
      return { verified: b.name, unverified };
    }
    unverified.push(b.name);
  }
  return { verified: undefined, unverified };
}

/**
 * Removes the backups a plan names, history by history, each once that history's newest backup
 * that verifies in full is known and kept (A1 3.18: never the newest verified backup). A history
 * with nothing to remove is trial restored only when it is the copy's own (`options.history`), for
 * the result. Each removal deletes the sidecar first: a backup without its sidecar is no longer
 * one, so a crash in between leaves a leftover `.db.gz`, never a sidecar without its data. When a
 * sidecar cannot be removed (a file held open on Windows), its data stays too. Only complete
 * backups of the plan's space are removed, never one the plan keeps, one that did not verify, or
 * the verified one, and only while both of their files are still regular files.
 */
export async function applyRetention(
  checked: CheckedDriver,
  listing: BackupListing,
  plan: RetentionPlan,
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  return applyRetentionWith(checked, listing, plan, options, {});
}

/** applyRetention with test seams. */
export async function applyRetentionWith(
  checked: CheckedDriver,
  listing: BackupListing,
  plan: RetentionPlan,
  options: RetentionOptions,
  seams: RetentionSeams,
): Promise<RetentionResult> {
  const all = histories(listing, plan.spaceId);
  const own = options.history ?? all[0]?.incarnation;
  const ahead = new Set(plan.ahead);
  const planned = new Set(plan.remove);
  let report: HistoryVerdict = { verified: undefined, unverified: [] };
  const removed: string[] = [];
  for (const history of all) {
    const backups = complete(history);
    const mine = history.incarnation === own;
    if (!mine && !backups.some((b) => planned.has(b.name))) continue;
    const verdict = await newestThatRestores(checked, backups, ahead, plan.spaceId, options);
    if (mine) report = verdict;
    if (verdict.verified === undefined) continue;
    const kept = [...plan.keep, ...plan.ahead, verdict.verified, ...verdict.unverified];
    const removable = new Set(backups.filter((b) => planned.has(b.name)).map((b) => b.name));
    for (const name of kept) removable.delete(name);
    removed.push(...(await removeBackups(listing, backups, removable, options, seams)));
  }
  return { removed, ...report };
}

/** Removes the `removable` ones of `backups`, each only while it is still as listed. */
async function removeBackups(
  listing: BackupListing,
  backups: readonly ListedBackup[],
  removable: ReadonlySet<string>,
  options: VerifyOptions,
  seams: RetentionSeams,
): Promise<string[]> {
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
      // Without its sidecar the data is listed as `missing_sidecar` now, for a person.
    }
    removed.push(b.name);
  }
  return removed;
}
