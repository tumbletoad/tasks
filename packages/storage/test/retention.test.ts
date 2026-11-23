// When a daily backup is due and which backups retention keeps (A1 3.18). Pure functions of a
// listing and a clock, tested on built listings, then applied to real files once.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { backupSpace, backupSpaceWith } from "../src/backup/backup.ts";
import { BUNDLE_POLICY } from "../src/backup/policy.ts";
import {
  listBackups,
  newestFirst,
  verifyBackup,
  type BackupListing,
  type ListedBackup,
} from "../src/backup/list.ts";
import {
  applyRetention,
  applyRetentionWith,
  dailyBackupDue,
  lastLocalHour,
  planRetention,
  type RetentionRules,
} from "../src/backup/retention.ts";
import {
  backupName,
  SIDECAR_MARKER,
  type BackupKind,
  type BackupSidecar,
} from "../src/backup/sidecar.ts";
import { StorageError } from "../src/errors.ts";
import type { Id } from "../src/ids.ts";
import { restoreLatest } from "../src/restore/rescue.ts";
import { restoreBackup, restoreBackupWith, restoreInPlace } from "../src/restore/restore.ts";
import { unpackBackup } from "../src/restore/unpack.ts";
import { rawWriter, readFacts, writeCommits } from "./backup-helpers.ts";
import { checkedDriver, createFixtureSpace, tempFolders, TEST_MACHINE } from "./space-helpers.ts";
import { STEPS_MARK_GUARD } from "./stand-in-steps.ts";

const folders = tempFolders("retention");

afterEach(() => {
  folders.cleanup();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wednesday 2026-11-11 00:00 UTC. */
const WED = Date.UTC(2026, 10, 11);

/** Rules under which every daily backup but the newest goes: what the applied tests remove. */
const NEWEST_ONLY: RetentionRules = { daily: 1, weekly: 1, dailyHour: 3 };

const SPACE: Id<"sp"> = "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf";
const OTHER_SPACE: Id<"sp"> = "sp_2b8n4c6x0v1m3q5w7e9r0t2y4u";

/** Where a backup stands in its space's history: its incarnation's epoch and its last commit. */
interface Work {
  epoch?: number;
  seq?: number;
}

function listed(
  kind: BackupKind,
  createdAt: number,
  state: ListedBackup["state"] = "ok",
  spaceId: Id<"sp"> = SPACE,
  work: Work = {},
): ListedBackup {
  // Two spaces' backups can share a folder: the seq tells their names apart in these listings.
  const epoch = work.epoch ?? 1;
  const seq = work.seq ?? (spaceId === SPACE ? 0 : 1);
  const name = backupName({ kind, createdAt, epoch, seq });
  const sidecar: BackupSidecar = {
    [SIDECAR_MARKER]: 1,
    kind,
    created_at: createdAt,
    space_id: spaceId,
    epoch,
    incarnation: epoch === 1 ? "ai_5n0w8k3q7d1m9x4r2t6v0b8c3h" : "ai_5d2m5q9w1x7k3r0t4v6b8c2n5h",
    seq,
    user_version: 1,
    size: 4096,
    sha256: "0".repeat(64),
    compressed_size: 100,
    compressed_sha256: "0".repeat(64),
    counts: {},
    written_by: "0.0.0",
  };
  return {
    name,
    createdAt,
    epoch,
    seq,
    file: `${name}.db.gz`,
    sidecarFile: `${name}.json`,
    state,
    sidecar,
  };
}

const listing = (backups: ListedBackup[]): BackupListing => ({
  folder: "unused",
  present: true,
  backups: [...backups].sort((a, b) => (b.sidecar?.created_at ?? 0) - (a.sidecar?.created_at ?? 0)),
  leftovers: [],
});

describe("[A1.5.backup.retention] daily backups and their retention", () => {
  test("the most recent local 03:00, in UTC, for offsets east and west", () => {
    expect(lastLocalHour({ now: WED + 4 * HOUR, utcOffsetMinutes: 0 }, 3)).toBe(WED + 3 * HOUR);
    expect(lastLocalHour({ now: WED + 2 * HOUR, utcOffsetMinutes: 0 }, 3)).toBe(
      WED - DAY + 3 * HOUR,
    );
    // UTC+1: local 03:00 is 02:00 UTC.
    expect(lastLocalHour({ now: WED + 2 * HOUR + 1, utcOffsetMinutes: 60 }, 3)).toBe(
      WED + 2 * HOUR,
    );
    // UTC-5: local 03:00 is 08:00 UTC.
    expect(lastLocalHour({ now: WED + 7 * HOUR, utcOffsetMinutes: -300 }, 3)).toBe(
      WED - DAY + 8 * HOUR,
    );
  });

  test("a daily backup is due after 03:00 local, or at start when the last is a day old", () => {
    const clock = (now: number) => ({ now, utcOffsetMinutes: 60 });
    expect(dailyBackupDue(listing([]), clock(WED), { atStart: false, spaceId: SPACE })).toBe(true);
    // Yesterday's daily at 03:30 local: due once today's 03:00 local has passed.
    const yesterday = listing([listed("daily", WED - DAY + 2 * HOUR + 30 * 60_000)]);
    expect(
      dailyBackupDue(yesterday, clock(WED + HOUR + 59 * 60_000), {
        atStart: false,
        spaceId: SPACE,
      }),
    ).toBe(false);
    expect(
      dailyBackupDue(yesterday, clock(WED + 2 * HOUR), { atStart: false, spaceId: SPACE }),
    ).toBe(true);
    // At start, a daily backup older than 24 hours is due at once, before 03:00 too.
    const late = listing([listed("daily", WED - DAY + 4 * HOUR)]);
    expect(dailyBackupDue(late, clock(WED + HOUR), { atStart: false, spaceId: SPACE })).toBe(false);
    expect(dailyBackupDue(late, clock(WED + 4 * HOUR + 1), { atStart: true, spaceId: SPACE })).toBe(
      true,
    );
    expect(dailyBackupDue(late, clock(WED + HOUR), { atStart: true, spaceId: SPACE })).toBe(false);
    // Other kinds and incomplete backups do not count as the day's daily.
    const others = listing([
      listed("manual", WED + 3 * HOUR),
      listed("pre-migrate", WED + 3 * HOUR),
      listed("daily", WED + 3 * HOUR, "missing_data"),
    ]);
    expect(dailyBackupDue(others, clock(WED + 5 * HOUR), { atStart: false, spaceId: SPACE })).toBe(
      true,
    );
  });

  test("keeps 7 daily, 4 weekly, every backup that is not a daily one, and the newest", () => {
    const now = WED + 12 * HOUR;
    const dailies = Array.from({ length: 40 }, (_, i) => listed("daily", now - i * DAY - HOUR));
    // A second daily on the newest day: only the newer one of a day counts as that day's.
    const extra = listed("daily", now - 2 * HOUR);
    const preNew = listed("pre-migrate", now - 29 * DAY);
    const preOld = listed("pre-migrate", now - 31 * DAY);
    const manual = listed("manual", now - 300 * DAY);
    const damaged = listed("daily", now - 100 * DAY, "invalid_sidecar");
    const all = [...dailies, extra, preNew, preOld, manual, damaged];
    const plan = planRetention(listing(all), { now, utcOffsetMinutes: 0 }, { spaceId: SPACE });
    const keep = new Set(plan.keep);
    // The 7 most recent days: today's newest daily, and one each for the 6 days before.
    const days = dailies.slice(0, 7).map((b) => b.name);
    for (const name of days) expect(keep.has(name), name).toBe(true);
    expect(keep.has(extra.name) ? "extra" : "first").toBe("first");
    // 4 weekly: the newest daily of each of the 4 most recent weeks (Monday to Sunday).
    // now is Wednesday: this week's newest is today's, then the Sundays before.
    for (const sunday of [3, 10, 17]) {
      const name = dailies.find((b) => b.sidecar?.created_at === now - sunday * DAY - HOUR)?.name;
      expect(name !== undefined && keep.has(name), `${String(sunday)} days ago`).toBe(true);
    }
    // A backup from before an upgrade may be the last one an older build reads: it stays.
    expect(keep.has(preNew.name)).toBe(true);
    expect(keep.has(preOld.name)).toBe(true);
    expect(keep.has(manual.name)).toBe(true);
    // Damaged backups take no part: neither kept nor removed.
    expect([...plan.keep, ...plan.remove]).not.toContain(damaged.name);
    // 7 days, 2 more weeks (this week's and last Sunday's are among the 7 days), 3 others.
    expect(plan.keep.length).toBe(7 + 2 + 3);
    expect(plan.remove.every((name) => name.startsWith("daily-"))).toBe(true);
    expect(plan.keep.length + plan.remove.length).toBe(all.length - 1);
  });

  test("the newest complete backup is always kept, whatever its kind or age", () => {
    const now = WED;
    const old = listed("pre-migrate", now - 365 * DAY);
    const plan = planRetention(
      listing([old, listed("daily", now - 2 * HOUR, "size_mismatch")]),
      { now, utcOffsetMinutes: 0 },
      { spaceId: SPACE },
    );
    expect(plan).toEqual({ spaceId: SPACE, keep: [old.name], remove: [], ahead: [] });
  });

  test("applying a plan removes each removed backup's two files and nothing else", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    for (let i = 0; i < 10; i += 1) {
      await backupSpace(checked, folder, { kind: "daily", now: () => now - i * DAY });
    }
    const before = listBackups(dir);
    const plan = planRetention(before, { now, utcOffsetMinutes: 0 }, { spaceId: space.spaceId });
    expect(plan.remove.length).toBeGreaterThan(0);
    const applied = await applyRetention(checked, before, plan);
    expect(applied.removed.sort()).toEqual([...plan.remove].sort());
    // The newest backup verified in full before anything went.
    expect(applied.verified).toBe(before.backups[0]?.name);
    expect(applied.unverified).toEqual([]);
    const after = listBackups(dir);
    expect(after.backups.map((b) => b.name).sort()).toEqual([...plan.keep].sort());
    expect(after.leftovers).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(2 * plan.keep.length);
  });

  test("the newest backup that verifies in full is never removed; a damaged newer one stays for a person", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    // Two daily backups, under rules that keep only the newest.
    const older = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 90 * DAY,
    });
    const newer = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 80 * DAY,
    });
    // Damage the newer one without changing its size: the listing still calls it complete.
    const bytes = readFileSync(newer.file);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 1;
    writeFileSync(newer.file, bytes);
    const listing = listBackups(dir);
    expect(listing.backups.map((b) => b.state)).toEqual(["ok", "ok"]);
    const plan = planRetention(
      listing,
      { now, utcOffsetMinutes: 0 },
      { spaceId: space.spaceId, rules: NEWEST_ONLY },
    );
    expect(plan).toEqual({
      spaceId: space.spaceId,
      keep: [newer.name],
      remove: [older.name],
      ahead: [],
    });
    const applied = await applyRetention(checked, listing, plan);
    expect(applied).toEqual({ removed: [], verified: older.name, unverified: [newer.name] });
    expect(existsSync(older.file) && existsSync(older.sidecarFile)).toBe(true);
    expect(existsSync(newer.file) && existsSync(newer.sidecarFile)).toBe(true);
    await restoreBackup(checked, older.file, join(folders.make(), "mira"));
    // With no backup that verifies, nothing is removed at all.
    writeFileSync(older.file, Buffer.alloc(older.sidecar.compressed_size));
    const none = await applyRetention(checked, listBackups(dir), plan);
    expect(none).toEqual({
      removed: [],
      verified: undefined,
      unverified: [newer.name, older.name],
    });
    expect(existsSync(older.sidecarFile)).toBe(true);
  });

  test("verified means a restore would pass: a sidecar that no longer matches its database does not count", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    const older = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 90 * DAY,
    });
    const newer = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 80 * DAY,
    });
    // One count changed in the sidecar, same size: both files' hashes still match it.
    const sidecar = JSON.parse(readFileSync(newer.sidecarFile, "utf8")) as BackupSidecar;
    const counts = { ...sidecar.counts, tasks: (sidecar.counts["tasks"] ?? 0) + 1 };
    writeFileSync(newer.sidecarFile, `${JSON.stringify({ ...sidecar, counts }, null, 2)}\n`);
    const listing = listBackups(dir);
    expect(listing.backups.map((b) => b.state)).toEqual(["ok", "ok"]);
    const [first, second] = listing.backups;
    if (first === undefined || second === undefined) throw new Error("two backups expected");
    expect(await verifyBackup(checked, first)).toEqual({ state: "failed" });
    expect(await verifyBackup(checked, second)).toEqual({
      state: "verified",
      sidecar: second.sidecar,
    });
    const plan = planRetention(
      listing,
      { now, utcOffsetMinutes: 0 },
      { spaceId: space.spaceId, rules: NEWEST_ONLY },
    );
    const applied = await applyRetention(checked, listing, plan);
    expect(applied).toEqual({ removed: [], verified: older.name, unverified: [newer.name] });
    expect(existsSync(older.file) && existsSync(older.sidecarFile)).toBe(true);
    // Verifying wrote its copy beside the backups and removed it again.
    expect(readdirSync(dir).sort()).toEqual(
      [older.file, older.sidecarFile, newer.file, newer.sidecarFile].map((f) => basename(f)).sort(),
    );
  });

  test("retention removes only the regular files it listed, never a folder in their place", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    const older = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 90 * DAY,
    });
    const newer = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 80 * DAY,
    });
    const listing = listBackups(dir);
    const plan = planRetention(
      listing,
      { now, utcOffsetMinutes: 0 },
      { spaceId: space.spaceId, rules: NEWEST_ONLY },
    );
    expect(plan.remove).toEqual([older.name]);
    // After the listing, a folder took the data file's name.
    rmSync(older.file);
    mkdirSync(older.file);
    writeFileSync(join(older.file, "unrelated.txt"), "not a backup");
    const applied = await applyRetention(checked, listing, plan);
    expect(applied.verified).toBe(newer.name);
    expect(existsSync(join(older.file, "unrelated.txt"))).toBe(true);
  });

  test("retention removes a backup only while it is still the one it listed", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    const oldest = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 100 * DAY,
    });
    const older = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 90 * DAY,
    });
    const newer = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 80 * DAY,
    });
    const listing = listBackups(dir);
    const plan = planRetention(
      listing,
      { now, utcOffsetMinutes: 0 },
      { spaceId: space.spaceId, rules: NEWEST_ONLY },
    );
    expect(plan.remove.sort()).toEqual([oldest.name, older.name].sort());
    // After the listing, a sync puts another space's sidecar under one name, and another data
    // file of the same size under the other.
    const sidecar = JSON.parse(readFileSync(older.sidecarFile, "utf8")) as BackupSidecar;
    writeFileSync(older.sidecarFile, `${JSON.stringify({ ...sidecar, space_id: OTHER_SPACE })}\n`);
    const replaced = Buffer.alloc(oldest.sidecar.compressed_size, 7);
    rmSync(oldest.file);
    writeFileSync(oldest.file, replaced);
    const applied = await applyRetention(checked, listing, plan);
    expect(applied.verified).toBe(newer.name);
    expect(applied.removed).toEqual([]);
    expect(existsSync(older.file) && existsSync(older.sidecarFile)).toBe(true);
    expect(readFileSync(oldest.file)).toEqual(replaced);
  });

  test("a pair replaced while retention reads it stays: removal acts on the files it checked", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    const older = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 90 * DAY,
    });
    await backupSpace(checked, folder, { kind: "daily", now: () => now - 80 * DAY });
    const listing = listBackups(dir);
    const plan = planRetention(
      listing,
      { now, utcOffsetMinutes: 0 },
      { spaceId: space.spaceId, rules: NEWEST_ONLY },
    );
    expect(plan.remove).toEqual([older.name]);
    // While the old pair's data is read, a sync replaces both of its files with another pair.
    const sidecar = readFileSync(older.sidecarFile, "utf8").replace(space.spaceId, OTHER_SPACE);
    const data = Buffer.alloc(older.sidecar.compressed_size, 9);
    const applied = await applyRetentionWith(
      checked,
      listing,
      plan,
      {},
      {
        hashed: (name) => {
          if (name !== older.name) return;
          rmSync(older.sidecarFile);
          writeFileSync(older.sidecarFile, sidecar);
          rmSync(older.file);
          writeFileSync(older.file, data);
        },
      },
    );
    expect(applied.removed).toEqual([]);
    expect(readFileSync(older.sidecarFile, "utf8")).toBe(sidecar);
    expect(readFileSync(older.file)).toEqual(data);
  });

  test("another space's backups in the same folder are neither kept, removed nor counted", () => {
    const now = WED + 12 * HOUR;
    const clock = { now, utcOffsetMinutes: 0 };
    const ours = Array.from({ length: 10 }, (_, i) => listed("daily", now - i * DAY - HOUR));
    const theirs = Array.from({ length: 10 }, (_, i) =>
      listed("daily", now - i * DAY - 2 * HOUR, "ok", OTHER_SPACE),
    );
    const both = listing([...ours, ...theirs]);
    const plan = planRetention(both, clock, { spaceId: SPACE });
    const names = new Set(theirs.map((b) => b.name));
    expect([...plan.keep, ...plan.remove].filter((n) => names.has(n))).toEqual([]);
    expect(plan.keep).toEqual(ours.slice(0, 7).map((b) => b.name));
    // Today's daily of the other space does not count as this space's.
    const otherToday = listing([listed("daily", now - HOUR, "ok", OTHER_SPACE)]);
    expect(dailyBackupDue(otherToday, clock, { atStart: false, spaceId: SPACE })).toBe(true);
    expect(dailyBackupDue(otherToday, clock, { atStart: false, spaceId: OTHER_SPACE })).toBe(false);
  });

  test("a daily backup dated in the future does not hold back the next one", () => {
    const now = WED + 12 * HOUR;
    // A clock that once ran a year ahead left a daily backup from the future.
    const ahead = listing([listed("daily", now + 365 * DAY)]);
    const clock = { now, utcOffsetMinutes: 0 };
    expect(dailyBackupDue(ahead, clock, { atStart: false, spaceId: SPACE })).toBe(true);
    expect(dailyBackupDue(ahead, clock, { atStart: true, spaceId: SPACE })).toBe(true);
  });
});

describe("[A1.5.backup.newest-work] the newest backup is the one that holds the furthest saved work", () => {
  test("after the clock was set back an hour, the later commit is the newest, and its day keeps it", () => {
    // A daily at noon, three commits, the clock set back an hour, another daily.
    const noon = listed("daily", WED + 12 * HOUR, "ok", SPACE, { seq: 0 });
    const later = listed("daily", WED + 11 * HOUR, "ok", SPACE, { seq: 3 });
    const clock = { now: WED + 13 * HOUR, utcOffsetMinutes: 0 };
    for (const rules of [NEWEST_ONLY, undefined]) {
      const plan = planRetention(listing([noon, later]), clock, {
        spaceId: SPACE,
        ...(rules === undefined ? {} : { rules }),
      });
      expect(plan.keep).toEqual([later.name]);
      expect(plan.remove).toEqual([noon.name]);
    }
  });

  test("the backup that holds the furthest commit stays whatever its date, and each day and week keeps its furthest work", () => {
    const now = WED + 12 * HOUR;
    // Ten days of dailies, then the clock set back by weeks for the last one.
    const days = Array.from({ length: 10 }, (_, i) =>
      listed("daily", now - (i + 1) * DAY, "ok", SPACE, { seq: 20 - i }),
    );
    const furthest = listed("daily", now - 40 * DAY, "ok", SPACE, { seq: 30 });
    // Yesterday again, earlier on the clock and later in the work.
    const yesterday = listed("daily", now - DAY - HOUR, "ok", SPACE, { seq: 21 });
    const plan = planRetention(
      listing([...days, furthest, yesterday]),
      { now, utcOffsetMinutes: 0 },
      { spaceId: SPACE },
    );
    expect(plan.keep).toContain(furthest.name);
    expect(plan.keep).toContain(yesterday.name);
    expect(plan.remove).toContain(days[0]?.name);
  });

  test("two incarnations are two histories: each keeps its own newest, whatever their epochs, commits and dates", () => {
    const now = WED + 12 * HOUR;
    // Restored in place from an older backup (a new epoch), with the clock set back meanwhile.
    const before = listed("daily", now - 2 * HOUR, "ok", SPACE, { epoch: 1, seq: 50 });
    const restored = listed("daily", now - 3 * HOUR, "ok", SPACE, { epoch: 2, seq: 12 });
    const plan = planRetention(
      listing([before, restored]),
      { now, utcOffsetMinutes: 0 },
      { spaceId: SPACE, rules: NEWEST_ONLY },
    );
    expect([...plan.keep].sort()).toEqual([before.name, restored.name].sort());
    expect(plan.remove).toEqual([]);
  });

  test("on real files, the backup with the later commit is the newest that restores, and retention keeps it", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const noon = WED + 12 * HOUR;
    const first = await backupSpace(checked, folder, { kind: "daily", now: () => noon });
    await writeCommits(folder, 3);
    const later = await backupSpace(checked, folder, { kind: "daily", now: () => noon - HOUR });
    expect(later.sidecar.seq).toBeGreaterThan(first.sidecar.seq);
    const listed = listBackups(dir);
    expect(listed.backups.map((b) => b.name)).toEqual([later.name, first.name]);
    const { backup } = await restoreLatest(
      checked,
      dir,
      space.spaceId,
      join(folders.make(), "copy"),
    );
    expect(backup).toBe(later.name);
    const clock = { now: noon + HOUR, utcOffsetMinutes: 0 };
    const applied = await applyRetention(
      checked,
      listed,
      planRetention(listed, clock, { spaceId: space.spaceId }),
    );
    expect(applied).toMatchObject({ verified: later.name, removed: [first.name] });
    expect(existsSync(later.file) && existsSync(later.sidecarFile)).toBe(true);
  });
});

describe("[A1.5.backup.histories] no history's backups are judged by another's", () => {
  /**
   * Two copies of one space claimed apart into one backups folder, as two machines that restored
   * the same backup would: each claim takes epoch 2 and a new incarnation. The desktop goes further
   * (more commits); the laptop's work is its own (tasks the desktop never had) and it was backed up
   * last. Each made a daily before today's 03:00 (the desktop) or after it (the laptop).
   */
  async function twoCopies() {
    const checked = await checkedDriver();
    const root = folders.make();
    const { folder, space } = await createFixtureSpace(root);
    const shared = join(root, "shared-backups");
    mkdirSync(shared);
    const first = await backupSpace(checked, folder, { kind: "manual", backupDir: shared });
    const copy = async (slug: string) => {
      const at = join(root, slug);
      await restoreBackup(checked, first.file, at);
      const restored = await restoreInPlace(checked, first.file, at, { machineId: TEST_MACHINE });
      expect(restored.claim.epoch).toBe(2);
      return { folder: at, incarnation: restored.claim.incarnation };
    };
    const desktop = await copy("desktop");
    const laptop = await copy("laptop");
    const daily = (from: string, at: number) =>
      backupSpace(checked, from, { kind: "daily", backupDir: shared, now: () => at });
    await writeCommits(desktop.folder, 3, "d");
    const d1 = await daily(desktop.folder, WED - 2 * DAY);
    await writeCommits(laptop.folder, 2, "l");
    const l1 = await daily(laptop.folder, WED - DAY);
    await writeCommits(desktop.folder, 6, "d");
    const d2 = await daily(desktop.folder, WED + 2 * HOUR);
    await writeCommits(laptop.folder, 2, "m");
    const l2 = await daily(laptop.folder, WED + 11 * HOUR);
    expect(d2.sidecar.epoch).toBe(l2.sidecar.epoch);
    expect(d2.sidecar.seq).toBeGreaterThan(l2.sidecar.seq);
    return { checked, space, shared, root, first, desktop, laptop, d1, d2, l1, l2 };
  }

  const clock = { now: WED + 12 * HOUR, utcOffsetMinutes: 0 };

  test("restore latest takes the newest backup of the served copy's own history; served nowhere, the history written to last, naming the other", async () => {
    const { checked, space, shared, root, first, desktop, laptop, d2, l2 } = await twoCopies();
    const target = (name: string) => join(root, name);
    const ofLaptop = await restoreLatest(checked, shared, space.spaceId, target("a"), {
      incarnation: laptop.incarnation,
    });
    expect(ofLaptop).toMatchObject({ backup: l2.name, own: true });
    const ofDesktop = await restoreLatest(checked, shared, space.spaceId, target("b"), {
      incarnation: desktop.incarnation,
    });
    expect(ofDesktop).toMatchObject({ backup: d2.name, own: true });
    const unknown = await restoreLatest(checked, shared, space.spaceId, target("c"));
    expect(unknown).toMatchObject({ backup: l2.name, own: false });
    expect(unknown.history.incarnation).toBe(laptop.incarnation);
    // The others, written to last first: the desktop's, then the original's first backup.
    expect(unknown.others.map((h) => h.incarnation)).toEqual([
      desktop.incarnation,
      first.sidecar.incarnation,
    ]);
    expect(unknown.others[0]?.backups[0]?.name).toBe(d2.name);
  });

  test("a daily of one copy does not make the other's look done, and retention keeps each history's newest", async () => {
    const { checked, space, shared, desktop, laptop, d1, d2, l1, l2 } = await twoCopies();
    const listing = listBackups(shared);
    const due = (incarnation: Id<"ai">) =>
      dailyBackupDue(listing, clock, { atStart: false, spaceId: space.spaceId, incarnation });
    expect(due(desktop.incarnation)).toBe(true);
    expect(due(laptop.incarnation)).toBe(false);

    const plan = planRetention(listing, clock, { spaceId: space.spaceId, rules: NEWEST_ONLY });
    expect([...plan.remove].sort()).toEqual([d1.name, l1.name].sort());
    // The desktop's upkeep runs it: each history's newest is trial restored before anything of it
    // goes, and the laptop's work stays.
    const applied = await applyRetention(checked, listing, plan, {
      history: desktop.incarnation,
    });
    expect({ ...applied, removed: [...applied.removed].sort() }).toEqual({
      removed: [d1.name, l1.name].sort(),
      verified: d2.name,
      unverified: [],
    });
    for (const kept of [d2, l2]) {
      expect(existsSync(kept.file) && existsSync(kept.sidecarFile), kept.name).toBe(true);
    }
    const left = await restoreLatest(checked, shared, space.spaceId, join(folders.make(), "l"), {
      incarnation: laptop.incarnation,
    });
    expect(left.backup).toBe(l2.name);
  });
});

describe("[A1.5.backup.rotation] rotation removes only what A1's retention allows", () => {
  const KINDS: BackupKind[] = ["daily", "manual", "pre-migrate"];
  const STATES: ListedBackup["state"][] = ["ok", "ok", "ok", "missing_data", "invalid_sidecar"];

  test("property: a plan removes only daily backups, never the one with the furthest saved work, another space's or a damaged one", () => {
    const backup = fc.record({
      kind: fc.constantFrom(...KINDS),
      // From two days ahead (a clock that ran ahead) to over a year back, in minutes.
      age: fc.integer({ min: -2 * 24 * 60, max: 400 * 24 * 60 }),
      state: fc.constantFrom(...STATES),
      other: fc.boolean(),
      // The last commit each holds: a clock set back makes it run against the dates.
      seq: fc.integer({ min: 0, max: 3 }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(backup, {
          maxLength: 60,
          selector: (b) => `${b.kind}${String(b.age)}s${String(b.seq)}`,
        }),
        fc.integer({ min: -720, max: 840 }),
        fc.integer({ min: 0, max: 7 * 24 * 60 }),
        (drawn, offset, shift) => {
          const now = WED + shift * 60_000;
          const all = drawn.map((b) =>
            listed(b.kind, now - b.age * 60_000, b.state, b.other ? OTHER_SPACE : SPACE, {
              seq: b.seq,
            }),
          );
          const plan = planRetention(
            listing(all),
            { now, utcOffsetMinutes: offset },
            {
              spaceId: SPACE,
            },
          );
          const complete = all.filter((b) => b.state === "ok" && b.sidecar?.space_id === SPACE);
          const removed = new Set(plan.remove);
          // Only complete backups of this space take part, each kept or removed, never both.
          expect([...plan.keep, ...plan.remove].sort()).toEqual(complete.map((b) => b.name).sort());
          for (const name of plan.keep) expect(removed.has(name)).toBe(false);
          for (const b of complete) {
            if (removed.has(b.name)) expect(b.sidecar?.kind).toBe("daily");
          }
          // The newest is the furthest saved work: the later commit, then the later time.
          const furthest = (backups: ListedBackup[]) =>
            [...backups].sort((a, b) => b.seq - a.seq || b.createdAt - a.createdAt)[0];
          const newest = furthest(complete);
          if (newest !== undefined) expect(removed.has(newest.name)).toBe(false);
          // A backup dated after now (a clock that ran ahead) is kept, and so is the newest one
          // dated at or before now: the future one counts for nothing.
          const past = complete.filter((b) => (b.sidecar?.created_at ?? 0) <= now);
          for (const b of complete) {
            if ((b.sidecar?.created_at ?? 0) > now) expect(removed.has(b.name)).toBe(false);
          }
          const newestPast = furthest(past);
          if (newestPast !== undefined) expect(removed.has(newestPast.name)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("a clock that once ran ahead: its backups are kept and count for nothing, so the backups made since keep their days", () => {
    const now = WED + 4 * HOUR;
    const ahead = now + 365 * DAY;
    // What retention left while the clock ran a year ahead: seven dailies and four weeklies.
    const future = [0, 1, 2, 3, 4, 5, 6, 7, 14, 21, 28].map((d) =>
      listed("daily", ahead - d * DAY),
    );
    // The daily backups made since the clock came back.
    const since = [0, 1, 2].map((d) => listed("daily", now - d * DAY));
    const plan = planRetention(
      listing([...future, ...since]),
      { now, utcOffsetMinutes: 0 },
      { spaceId: SPACE },
    );
    expect(plan.remove).toEqual([]);
    expect([...plan.ahead].sort()).toEqual(future.map((b) => b.name).sort());
  });

  test("applied: the newest verified backup is looked for among those dated at or before now", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    const older = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 60 * DAY,
    });
    const newer = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 40 * DAY,
    });
    const future = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now + 365 * DAY,
    });
    // The newest backup dated before now no longer verifies; the older one is the newest that does.
    const bytes = readFileSync(newer.file);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 1;
    writeFileSync(newer.file, bytes);
    const listing = listBackups(dir);
    const plan = planRetention(
      listing,
      { now, utcOffsetMinutes: 0 },
      { spaceId: space.spaceId, rules: NEWEST_ONLY },
    );
    expect(plan.remove).toEqual([older.name]);
    const applied = await applyRetention(checked, listing, plan);
    expect(applied).toEqual({ removed: [], verified: older.name, unverified: [newer.name] });
    for (const b of [older, newer, future]) expect(existsSync(b.file)).toBe(true);
  });

  test("applied to real files: manual backups and the newest verified one stay, a damaged newer one too", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    const manual = [];
    for (const days of [400, 200, 60]) {
      manual.push(
        await backupSpace(checked, folder, { kind: "manual", now: () => now - days * DAY }),
      );
    }
    const dailies = [];
    for (let i = 0; i < 12; i += 1) {
      dailies.push(
        await backupSpace(checked, folder, { kind: "daily", now: () => now - i * DAY - HOUR }),
      );
    }
    // The newest backup no longer verifies, though its size is right.
    const newest = dailies[0];
    if (newest === undefined) throw new Error("no daily backup");
    const bytes = readFileSync(newest.file);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 1;
    writeFileSync(newest.file, bytes);
    const before = listBackups(dir);
    const plan = planRetention(before, { now, utcOffsetMinutes: 0 }, { spaceId: space.spaceId });
    const applied = await applyRetention(checked, before, plan);
    expect(applied.verified).toBe(dailies[1]?.name);
    expect(applied.unverified).toEqual([newest.name]);
    expect(applied.removed.length).toBeGreaterThan(0);
    const left = new Set(listBackups(dir).backups.map((b) => b.name));
    for (const b of [...manual, newest, dailies[1]]) {
      expect(b !== undefined && left.has(b.name), b?.name).toBe(true);
    }
    // Only dailies the plan named went.
    for (const name of applied.removed) {
      expect(dailies.some((d) => d.name === name) && plan.remove.includes(name), name).toBe(true);
    }
  });
});

async function expectCode(fn: () => unknown, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code, (error as Error).message).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

describe("[A1.5.restore.not-the-backup] a trial restore the surroundings stop is no verdict on the backup", () => {
  test("with no room to trial restore the newest backup, retention names it unchecked, calls no older one the newest, and removes nothing", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    const oldest = await backupSpace(checked, folder, { kind: "daily", now: () => now - 3 * DAY });
    const older = await backupSpace(checked, folder, { kind: "daily", now: () => now - 2 * DAY });
    await writeCommits(folder, 60);
    const newer = await backupSpace(checked, folder, { kind: "daily", now: () => now - DAY });
    expect(newer.sidecar.size).toBeGreaterThan(older.sidecar.size);
    const listing = listBackups(dir);
    const plan = planRetention(
      listing,
      { now, utcOffsetMinutes: 0 },
      { spaceId: space.spaceId, rules: NEWEST_ONLY },
    );
    expect([...plan.remove].sort()).toEqual([oldest.name, older.name].sort());
    // Room on the backups' disk to trial restore the older databases, not the newest.
    const room = BUNDLE_POLICY.freeSpaceReserveBytes + older.sidecar.size;
    const applied = await applyRetention(checked, listing, plan, { freeBytes: () => room });
    expect(applied).toEqual({
      removed: [],
      verified: undefined,
      unverified: [],
      unchecked: { name: newer.name, code: "BUNDLE_LIMIT_EXCEEDED" },
    });
    for (const b of [oldest, older, newer]) {
      expect(existsSync(b.file) && existsSync(b.sidecarFile), b.name).toBe(true);
    }
    // With room, the newest restores and the plan is applied.
    const roomy = await applyRetention(checked, listing, plan);
    expect(roomy).toMatchObject({ verified: newer.name, unverified: [] });
  });
});

describe("[A1.5.backup.trial-restore] verified means the restore's own steps ran to their first write on a scratch copy", () => {
  test("a backup whose restore fails at its first write for a reason SQLite does not call damage is never verified, never the reason another backup is removed, and never passed over for older work", async () => {
    const checked = await checkedDriver();
    // A schema whose restore refuses its read-only mark once the space has three commits: the
    // exact-schema rule passes it, since its own steps made it (stand-in-steps.ts).
    const steps = STEPS_MARK_GUARD;
    const { folder, space } = await createFixtureSpace(folders.make(), "mira", {}, steps);
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    await writeCommits(folder, 1, "s", steps);
    const older = await backupSpaceWith(
      checked,
      folder,
      { kind: "daily", now: () => now - 90 * DAY },
      { steps },
    );
    await writeCommits(folder, 2, "t", steps);
    const newer = await backupSpaceWith(
      checked,
      folder,
      { kind: "daily", now: () => now - 80 * DAY },
      { steps },
    );
    expect(newer.sidecar.seq).toBeGreaterThanOrEqual(3);
    // Every check before the first write passes for the newer one: its files, its digests,
    // integrity_check, its facts, its revision and its exact schema.
    const parent = folders.make();
    await unpackBackup(checked, newer.file, join(parent, "unpacked.db"), {}, { steps });

    // Verification, marking and retention together: the plan would remove the older backup. The
    // newer one's first write fails with SQLITE_ERROR (an integer overflow), which names no damage:
    // it could not be checked, so nothing is removed and the older one is not taken in its place.
    const listing = listBackups(dir);
    const plan = planRetention(
      listing,
      { now, utcOffsetMinutes: 0 },
      { spaceId: space.spaceId, rules: NEWEST_ONLY },
    );
    expect(plan.remove).toEqual([older.name]);
    const [first, second] = listing.backups;
    if (first === undefined || second === undefined) throw new Error("two backups expected");
    expect(await verifyBackup(checked, first, { steps })).toEqual({
      state: "unchecked",
      code: "STORAGE_SQL",
    });
    expect(await verifyBackup(checked, second, { steps })).toEqual({
      state: "verified",
      sidecar: older.sidecar,
    });
    const applied = await applyRetention(checked, listing, plan, { steps });
    expect(applied).toEqual({
      removed: [],
      verified: undefined,
      unverified: [],
      unchecked: { name: newer.name, code: "STORAGE_SQL" },
    });
    expect(existsSync(older.file) && existsSync(older.sidecarFile)).toBe(true);
    // The trials left nothing beside the backups.
    expect(readdirSync(dir).sort()).toEqual(
      [older.file, older.sidecarFile, newer.file, newer.sidecarFile].map((f) => basename(f)).sort(),
    );

    // A restore of the newer one stops with SQLite's code and leaves no folder, and so does
    // `restore latest`, rather than bring back the older work as the newest. The older one
    // restores when it is named.
    await expectCode(
      () => restoreBackupWith(checked, newer.file, join(parent, "a"), {}, { steps }),
      "STORAGE_SQL",
    );
    await expectCode(
      () => restoreLatest(checked, dir, space.spaceId, join(parent, "c"), {}, { steps }),
      "STORAGE_SQL",
    );
    expect(existsSync(join(parent, "a")) || existsSync(join(parent, "c"))).toBe(false);
    await restoreBackupWith(checked, older.file, join(parent, "b"), {}, { steps });
  });

  test("a backup whose copy refuses a claim is never verified: the mark's transaction runs the claim and takes it back", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    await writeCommits(folder, 2);
    const older = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 90 * DAY,
    });
    // The space's own schema, with rows a claim cannot use: no system actor to write its commit.
    const conn = await rawWriter(folder);
    try {
      conn.exec("UPDATE actors SET kind = 'agent' WHERE kind = 'system'");
    } finally {
      conn.close();
    }
    const newer = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 80 * DAY,
    });
    const listing = listBackups(dir);
    const plan = planRetention(
      listing,
      { now, utcOffsetMinutes: 0 },
      { spaceId: space.spaceId, rules: NEWEST_ONLY },
    );
    expect(plan.remove).toEqual([older.name]);
    const applied = await applyRetention(checked, listing, plan);
    expect(applied).toEqual({ removed: [], verified: older.name, unverified: [newer.name] });

    // Neither restore takes it: into a new folder (its copy could never be claimed) nor in place.
    const parent = folders.make();
    await expectCode(() => restoreBackup(checked, newer.file, join(parent, "a")), "BACKUP_INVALID");
    await expectCode(
      () => restoreInPlace(checked, newer.file, folder, { machineId: TEST_MACHINE }),
      "BACKUP_INVALID",
    );
    expect(readdirSync(parent)).toEqual([]);
    // The older one restores, and the claim its restore ran was taken back: the copy keeps the
    // backup's identity, last commit and rows.
    const restored = await restoreBackup(checked, older.file, join(parent, "b"));
    expect(restored.space.authority.epoch).toBe(older.sidecar.epoch);
    expect(restored.space.authority.incarnation).toBe(older.sidecar.incarnation);
    expect(restored.space.lastSeq).toBe(older.sidecar.seq);
    expect(restored.space.lineage.incarnations).toHaveLength(1);
    expect((await readFacts(restored.folder)).counts).toEqual(older.sidecar.counts);
  });
});

describe("[A1.5.backup.held-files] a reader opens both files of a backup before it reads either, and holds them", () => {
  test("retention removing a backup after a verification opened both of its files does not fail the verification", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const now = WED + 12 * HOUR;
    await writeCommits(folder, 1);
    const old = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 90 * DAY,
    });
    await writeCommits(folder, 1, "t");
    const kept = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => now - 80 * DAY,
    });
    const listing = listBackups(dir);
    const plan = planRetention(
      listing,
      { now, utcOffsetMinutes: 0 },
      { spaceId: space.spaceId, rules: NEWEST_ONLY },
    );
    expect(plan.remove).toEqual([old.name]);
    const oldListed = listing.backups.find((b) => b.name === old.name);
    if (oldListed === undefined) throw new Error("the old backup is listed");
    // The old backup's verification holds both files when retention runs and removes them.
    let removed: string[] = [];
    const verified = await verifyBackup(checked, oldListed, {
      held: async (file) => {
        if (file === old.file) removed = (await applyRetention(checked, listing, plan)).removed;
      },
    });
    expect(removed).toEqual([old.name]);
    expect(existsSync(old.file) || existsSync(old.sidecarFile)).toBe(false);
    expect(verified).toEqual({ state: "verified", sidecar: old.sidecar });
    expect(existsSync(kept.file) && existsSync(kept.sidecarFile)).toBe(true);
  });

  test("a restore whose backup goes away after both files are open restores it whole", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3);
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    const restored = await restoreBackupWith(
      checked,
      backup.file,
      join(folders.make(), "mira"),
      {},
      {
        held: () => {
          // As retention removes a backup: the sidecar first, then the data.
          rmSync(backup.sidecarFile);
          rmSync(backup.file);
        },
      },
    );
    expect(existsSync(backup.file) || existsSync(backup.sidecarFile)).toBe(false);
    expect(restored.space.lastSeq).toBe(backup.sidecar.seq);
    expect((await readFacts(restored.folder)).integrity).toBe("ok");
  });
});
