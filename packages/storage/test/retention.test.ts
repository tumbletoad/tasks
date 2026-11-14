// When a daily backup is due and which backups retention keeps (A1 3.18). Pure functions of a
// listing and a clock, tested on built listings, then applied to real files once.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { backupSpace } from "../src/backup/backup.ts";
import {
  listBackups,
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
} from "../src/backup/retention.ts";
import {
  backupName,
  SIDECAR_MARKER,
  type BackupKind,
  type BackupSidecar,
} from "../src/backup/sidecar.ts";
import type { Id } from "../src/ids.ts";
import { restoreBackup } from "../src/restore/restore.ts";
import { checkedDriver, createFixtureSpace, tempFolders } from "./space-helpers.ts";

const folders = tempFolders("retention");

afterEach(() => {
  folders.cleanup();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wednesday 2026-11-11 00:00 UTC. */
const WED = Date.UTC(2026, 10, 11);

const SPACE: Id<"sp"> = "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf";
const OTHER_SPACE: Id<"sp"> = "sp_2b8n4c6x0v1m3q5w7e9r0t2y4u";

function listed(
  kind: BackupKind,
  createdAt: number,
  state: ListedBackup["state"] = "ok",
  spaceId: Id<"sp"> = SPACE,
): ListedBackup {
  // Two spaces' backups can share a folder: the seq tells their names apart in these listings.
  const name = backupName({ kind, createdAt, epoch: 1, seq: spaceId === SPACE ? 0 : 1 });
  const sidecar: BackupSidecar = {
    [SIDECAR_MARKER]: 1,
    kind,
    created_at: createdAt,
    space_id: spaceId,
    epoch: 1,
    incarnation: "ai_5n0w8k3q7d1m9x4r2t6v0b8c3h",
    seq: 0,
    user_version: 1,
    size: 4096,
    sha256: "0".repeat(64),
    compressed_size: 100,
    compressed_sha256: "0".repeat(64),
    counts: {},
    written_by: "0.0.0",
  };
  return { name, file: `${name}.db.gz`, sidecarFile: `${name}.json`, state, sidecar };
}

const listing = (backups: ListedBackup[]): BackupListing => ({
  folder: "unused",
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

  test("keeps 7 daily, 4 weekly, pre-migration for 30 days, manual ones and the newest", () => {
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
    expect(keep.has(preNew.name)).toBe(true);
    expect(keep.has(preOld.name)).toBe(false);
    expect(keep.has(manual.name)).toBe(true);
    // Damaged backups take no part: neither kept nor removed.
    expect([...plan.keep, ...plan.remove]).not.toContain(damaged.name);
    // 7 days, 2 more weeks (this week's and last Sunday's are among the 7 days), 2 others.
    expect(plan.keep.length).toBe(7 + 2 + 2);
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
    expect(plan).toEqual({ spaceId: SPACE, keep: [old.name], remove: [] });
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
    // Two pre-migration backups past their 30 days: the plan keeps only the newest.
    const older = await backupSpace(checked, folder, {
      kind: "pre-migrate",
      now: () => now - 90 * DAY,
    });
    const newer = await backupSpace(checked, folder, {
      kind: "pre-migrate",
      now: () => now - 80 * DAY,
    });
    // Damage the newer one without changing its size: the listing still calls it complete.
    const bytes = readFileSync(newer.file);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 1;
    writeFileSync(newer.file, bytes);
    const listing = listBackups(dir);
    expect(listing.backups.map((b) => b.state)).toEqual(["ok", "ok"]);
    const plan = planRetention(listing, { now, utcOffsetMinutes: 0 }, { spaceId: space.spaceId });
    expect(plan).toEqual({ spaceId: space.spaceId, keep: [newer.name], remove: [older.name] });
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
      kind: "pre-migrate",
      now: () => now - 90 * DAY,
    });
    const newer = await backupSpace(checked, folder, {
      kind: "pre-migrate",
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
    expect(await verifyBackup(checked, first)).toBeUndefined();
    expect(await verifyBackup(checked, second)).toEqual(second.sidecar);
    const plan = planRetention(listing, { now, utcOffsetMinutes: 0 }, { spaceId: space.spaceId });
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
      kind: "pre-migrate",
      now: () => now - 90 * DAY,
    });
    const newer = await backupSpace(checked, folder, {
      kind: "pre-migrate",
      now: () => now - 80 * DAY,
    });
    const listing = listBackups(dir);
    const plan = planRetention(listing, { now, utcOffsetMinutes: 0 }, { spaceId: space.spaceId });
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
      kind: "pre-migrate",
      now: () => now - 100 * DAY,
    });
    const older = await backupSpace(checked, folder, {
      kind: "pre-migrate",
      now: () => now - 90 * DAY,
    });
    const newer = await backupSpace(checked, folder, {
      kind: "pre-migrate",
      now: () => now - 80 * DAY,
    });
    const listing = listBackups(dir);
    const plan = planRetention(listing, { now, utcOffsetMinutes: 0 }, { spaceId: space.spaceId });
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
      kind: "pre-migrate",
      now: () => now - 90 * DAY,
    });
    await backupSpace(checked, folder, { kind: "pre-migrate", now: () => now - 80 * DAY });
    const listing = listBackups(dir);
    const plan = planRetention(listing, { now, utcOffsetMinutes: 0 }, { spaceId: space.spaceId });
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
