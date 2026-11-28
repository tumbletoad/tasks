// A space's old backups, made into its own `backups/`, move to its backups folder in two starts,
// and every listing reads both folders as one. Fixture spaces in temporary folders only.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { backupSpace, type BackupRecord } from "../src/backup/backup.ts";
import { listBackups, listBackupsIn } from "../src/backup/list.ts";
import { moveOldBackups, SETTLED_MS, type MoveSeams } from "../src/backup/move.ts";
import { NODE_IO } from "../src/files.ts";
import { restoreLatest } from "../src/restore/rescue.ts";
import { restoreBackup } from "../src/restore/restore.ts";
import { treeDigest, writeCommits } from "./backup-helpers.ts";
import { checkedDriver, createFixtureSpace, tempFolders } from "./space-helpers.ts";

const folders = tempFolders("move");

afterEach(() => {
  folders.cleanup();
});

const HOUR = 3_600_000;
const LATER = SETTLED_MS + HOUR;

/** A space with three backups made into its own folder, each holding more work, and an empty backups folder. */
async function oldBackups() {
  const checked = await checkedDriver();
  const { folder, space } = await createFixtureSpace(folders.make());
  const made: BackupRecord[] = [];
  const at = Date.now() - 40 * 24 * HOUR;
  for (const [i, kind] of (["daily", "manual", "pre-migrate"] as const).entries()) {
    await writeCommits(folder, 1, `k${String(i)}`);
    made.push(await backupSpace(checked, folder, { kind, now: () => at + i * HOUR }));
  }
  const to = folders.make();
  return { checked, folder, space, made, to, own: join(folder, "backups") };
}

type Setup = Awaited<ReturnType<typeof oldBackups>>;

/** The listing of both folders: each backup's name, state and folder. */
const listed = ({ to, own }: Setup) =>
  listBackupsIn([to, own]).backups.map((b) => ({
    name: b.name,
    state: b.state,
    inOld: b.file.startsWith(own),
  }));

const names = (s: Setup): string[] => s.made.map((b) => b.name).sort();

/** Every backup listed once, complete, and restoring: what a person can count on at any point. */
async function eachOnceAndWhole(s: Setup): Promise<void> {
  const listing = listBackupsIn([s.to, s.own]).backups;
  expect(listing.map((b) => b.name).sort()).toEqual(names(s));
  expect(listing.every((b) => b.state === "ok")).toBe(true);
  for (const b of listing) {
    const restored = await restoreBackup(s.checked, b.file, join(folders.make(), "copy"));
    expect(restored.space.spaceId).toBe(s.space.spaceId);
  }
  const latest = await restoreLatest(
    s.checked,
    [s.to, s.own],
    s.space.spaceId,
    join(folders.make(), "latest"),
  );
  expect(latest.backup).toBe(s.made[2]?.name);
}

/** The move, with its lists of names in order. */
const move = async (s: Setup, now: number, seams: MoveSeams = {}) => {
  const result = await moveOldBackups(s.folder, s.to, s.space.spaceId, now, seams);
  return { ...result, copied: result.copied.sort(), finished: result.finished.sort() };
};

describe("[A1.5.backup.old-move] a space's old backups move to its backups folder in two starts", () => {
  test("the first start copies, a start once the copies have stood removes the originals; each backup is listed once and restores all along", async () => {
    const s = await oldBackups();
    const before = treeDigest(s.own);
    await eachOnceAndWhole(s);

    const now = Date.now();
    const first = await move(s, now);
    expect(first).toEqual({ copied: names(s), finished: [], stayed: [] });
    expect(treeDigest(s.own)).toEqual(before);
    // On one file system a copy is the same file: nothing is written twice.
    const [b] = s.made as [BackupRecord];
    expect(statSync(join(s.to, `${b.name}.db.gz`)).ino).toBe(statSync(b.file).ino);
    expect(listed(s).every((e) => e.inOld)).toBe(true);
    await eachOnceAndWhole(s);

    // A start right after: the copies have not stood long enough.
    expect(await move(s, now + 60_000)).toEqual({ copied: [], finished: [], stayed: [] });
    expect(treeDigest(s.own)).toEqual(before);

    const second = await move(s, now + LATER);
    expect(second).toEqual({ copied: [], finished: names(s), stayed: [] });
    expect(existsSync(s.own)).toBe(false);
    expect(listed(s).some((e) => e.inOld)).toBe(false);
    await eachOnceAndWhole(s);
  });

  test("on another file system each backup is copied, and its original goes once the copy reads back", async () => {
    const s = await oldBackups();
    const io = {
      ...NODE_IO,
      linkSync: () => {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      },
    };
    expect((await move(s, Date.now(), { io })).copied).toEqual(names(s));
    const [b] = s.made as [BackupRecord];
    expect(statSync(join(s.to, `${b.name}.db.gz`)).ino).not.toBe(statSync(b.file).ino);
    expect((await move(s, Date.now() + LATER, { io })).finished).toEqual(names(s));
    expect(existsSync(s.own)).toBe(false);
    await eachOnceAndWhole(s);
  });

  test("an interruption at any step leaves every backup whole, listed once, and later starts finish the move", async () => {
    const s = await oldBackups();
    // What a crash at each step leaves on disk: the space and the backups folder as they are then.
    const crashes: { point: string; space: string; to: string }[] = [];
    const snapshot = (point: string): void => {
      const root = folders.make();
      cpSync(s.folder, join(root, "mira"), { recursive: true });
      cpSync(s.to, join(root, "to"), { recursive: true });
      crashes.push({ point, space: join(root, "mira"), to: join(root, "to") });
    };
    const now = Date.now();
    await move(s, now, { at: snapshot });
    // The second start's copies have stood: their mtimes move back as a later clock would see them.
    for (const name of readdirSync(s.to)) {
      utimesSync(join(s.to, name), new Date(now - LATER), new Date(now - LATER));
    }
    await move(s, now, { at: snapshot });
    expect(new Set(crashes.map((c) => c.point))).toEqual(
      new Set(["data-copied", "data-published", "copied", "data-removed"]),
    );
    for (const crash of crashes) {
      const left = { ...s, folder: crash.space, to: crash.to, own: join(crash.space, "backups") };
      await eachOnceAndWhole(left);
      await move(left, now + LATER);
      await move(left, now + 2 * LATER);
      expect(existsSync(left.own)).toBe(false);
      await eachOnceAndWhole(left);
    }
  }, 120_000);

  test("a copy that does not read back at the later start stays beside its original, which restores", async () => {
    const s = await oldBackups();
    await move(s, Date.now());
    const [b] = s.made as [BackupRecord];
    // A copy written wrong, of the right size. Its own file: no longer a link to the original.
    const copy = join(s.to, `${b.name}.db.gz`);
    const bytes = readFileSync(copy);
    rmSync(copy);
    bytes[bytes.length - 9] = (bytes[bytes.length - 9] ?? 0) ^ 0xff;
    writeFileSync(copy, bytes);
    const before = readFileSync(b.file);
    const second = await move(s, Date.now() + LATER);
    expect(second.stayed).toEqual([{ name: b.name, why: "unverified" }]);
    expect(readFileSync(b.file)).toEqual(before);
    expect(existsSync(copy)).toBe(true);
    await eachOnceAndWhole(s);
  });

  test("restore latest takes the same backup from the other folder before older work when the copy it listed does not restore", async () => {
    const s = await oldBackups();
    await move(s, Date.now());
    const newest = s.made[2] as BackupRecord;
    // The listed original no longer restores (its own file now, of the right size): the newest
    // work is still in the copy beside it.
    const bytes = readFileSync(newest.file);
    rmSync(newest.file);
    bytes[bytes.length - 9] = (bytes[bytes.length - 9] ?? 0) ^ 0xff;
    writeFileSync(newest.file, bytes);
    const latest = await restoreLatest(
      s.checked,
      [s.to, s.own],
      s.space.spaceId,
      join(folders.make(), "latest"),
    );
    expect(latest.backup).toBe(newest.name);
  });

  test("another file at a backup's name in the backups folder keeps both; the same backup there already lets the original go", async () => {
    const s = await oldBackups();
    const [data, sidecar, same] = s.made as [BackupRecord, BackupRecord, BackupRecord];
    writeFileSync(join(s.to, `${data.name}.db.gz`), "another program's file");
    writeFileSync(join(s.to, `${sidecar.name}.json`), "{}");
    cpSync(same.file, join(s.to, `${same.name}.db.gz`));
    cpSync(same.sidecarFile, join(s.to, `${same.name}.json`));
    // A partial file at either name does not stand in for the complete original.
    await eachOnceAndWhole(s);
    expect(
      listed(s)
        .filter((e) => e.name !== same.name)
        .every((e) => e.inOld),
    ).toBe(true);

    const first = await move(s, Date.now() + LATER);
    expect(first.stayed).toEqual(
      expect.arrayContaining([
        { name: data.name, why: "taken" },
        { name: sidecar.name, why: "taken" },
      ]),
    );
    expect(first.finished).toEqual([same.name]);
    expect(readFileSync(join(s.to, `${data.name}.db.gz`), "utf8")).toBe("another program's file");
    expect(existsSync(data.file) && existsSync(sidecar.file) && !existsSync(same.file)).toBe(true);
    await eachOnceAndWhole(s);
  });

  test("with too little room on the backups folder's disk nothing is copied", async () => {
    const s = await oldBackups();
    const result = await move(s, Date.now(), { freeBytes: () => 0 });
    expect(result.copied).toEqual([]);
    expect(result.stayed.map((x) => x.why)).toEqual(["no_room", "no_room", "no_room"]);
    expect(listBackups(s.to)).toMatchObject({ backups: [], leftovers: [] });
  });

  test("a backups folder that is the old folder under another name, or inside the space, moves nothing", async () => {
    const s = await oldBackups();
    const before = treeDigest(s.own);
    const link = join(folders.make(), "link");
    symlinkSync(s.own, link, "junction");
    const inside = join(s.folder, "exchange", "backups");
    mkdirSync(inside, { recursive: true });
    const spellings = [link, inside, s.folder];
    if (process.platform === "win32") spellings.push(s.own.toUpperCase());
    for (const to of spellings) {
      expect(await move({ ...s, to }, Date.now() + LATER)).toEqual({
        copied: [],
        finished: [],
        stayed: [],
      });
    }
    expect(treeDigest(s.own)).toEqual(before);
    expect(readdirSync(inside)).toEqual([]);
  });

  test("an incomplete old backup stays, and another space's backup there is left alone", async () => {
    const s = await oldBackups();
    const [cut] = s.made as [BackupRecord];
    rmSync(cut.sidecarFile);
    const other = await createFixtureSpace(folders.make(), "life", { name: "Life" });
    const foreign = await backupSpace(s.checked, other.folder, { kind: "manual" });
    cpSync(foreign.file, join(s.own, `${foreign.name}.db.gz`));
    cpSync(foreign.sidecarFile, join(s.own, `${foreign.name}.json`));
    const result = await move(s, Date.now());
    expect(result.stayed).toEqual([{ name: cut.name, why: "incomplete" }]);
    expect(result.copied).toEqual(
      s.made
        .slice(1)
        .map((b) => b.name)
        .sort(),
    );
    expect(existsSync(join(s.to, `${foreign.name}.json`))).toBe(false);
    expect(existsSync(cut.file)).toBe(true);
  });
});
