// Backups (A1 3.18, the minimal backup set of MIL-02, A7 M1.06): a verified single-step backup
// taken while writers work, its sidecar, the listing, the leftovers a crash leaves at each point,
// and the shared bundle limits on `.db.gz` files.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, test } from "vitest";
import {
  backupSpace,
  backupSpaceWith,
  BACKUP_TEMP_PREFIX,
  type BackupPoint,
  type BackupRecord,
} from "../src/backup/backup.ts";
import { listBackups, removeBackupLeftovers } from "../src/backup/list.ts";
import { BUNDLE_POLICY, type BundlePolicy } from "../src/backup/policy.ts";
import { backupName, parseBackupName, parseUtcStamp, utcStamp } from "../src/backup/sidecar.ts";
import { StorageError } from "../src/errors.ts";
import { NODE_IO, type FileIo } from "../src/files.ts";
import { restoreBackup, restoreBackupWith } from "../src/restore/restore.ts";
import { openSpace } from "../src/space.ts";
import { copyTree, rawWriter, readFacts, treeDigest, writeCommits } from "./backup-helpers.ts";
import type { ConcurrentWriterData } from "./concurrent-writer.ts";
import { checkedDriver, createFixtureSpace, tempFolders } from "./space-helpers.ts";

const folders = tempFolders("backup");
const SIDECARS = ["space.db-shm", "space.db-wal"];
const HOUR = 3_600_000;
/** The service's next start, long enough after a crash that its leftovers are no backup's in progress. */
const AFTER_RESTART = { now: Date.now() + 2 * HOUR };

afterEach(() => {
  folders.cleanup();
});

async function expectCode(fn: () => unknown, code: string): Promise<StorageError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe(code);
    return error as StorageError;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

/**
 * Pads the space with fixture rows, so a backup takes long enough for writers to overlap it. Bulk
 * rows of size only, not history: they are written straight into the database, in a position the
 * write path's appends come after, with the reference counter moved past them.
 */
async function pad(folder: string, tasks: number): Promise<void> {
  const conn = await rawWriter(folder);
  try {
    const system = conn.prepare("SELECT id FROM actors WHERE kind = 'system'").get()?.["id"];
    conn.transaction("immediate", () => {
      conn
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $count)
           INSERT INTO tasks (id, ref, title, context, position, created_at, created_by,
             created_seq, version, touched)
           SELECT 't_pad' || i, i, 'Padding task', hex(randomblob(512)), 'a0', 0, $actor, 0, 0, 0
           FROM n`,
        )
        .run({ count: tasks, actor: String(system) });
      conn.prepare("UPDATE space SET next_ref = $next WHERE one = 1").run({ next: tasks + 1 });
    });
  } finally {
    conn.close();
  }
}

/** Starts writers in worker threads, each with its own connection and the real write path. */
function startWriters(folder: string, count: number) {
  const control = new SharedArrayBuffer(4 * (count + 1));
  const slots = new Int32Array(control);
  const workers = Array.from({ length: count }, (_, writer) => {
    const data: ConcurrentWriterData = { folder, writer, control };
    return new Worker(new URL("./concurrent-writer.ts", import.meta.url), { workerData: data });
  });
  const exits = workers.map(
    (worker) =>
      new Promise<number>((resolve, reject) => {
        worker.once("message", (m: { commits: number }) => {
          resolve(m.commits);
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`a writer exited with ${String(code)}`));
        });
      }),
  );
  const committed = (): number => {
    let total = 0;
    for (let i = 1; i <= count; i += 1) total += Atomics.load(slots, i);
    return total;
  };
  return {
    committed,
    /** Waits until every writer committed at least once. */
    async running(): Promise<void> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        let all = true;
        for (let w = 1; w <= count; w += 1) if (Atomics.load(slots, w) === 0) all = false;
        if (all) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("the writers did not start");
    },
    async stop(): Promise<number[]> {
      Atomics.store(slots, 0, 1);
      Atomics.notify(slots, 0);
      return Promise.all(exits);
    },
  };
}

describe("[A1.5.backup.under-writers] a backup taken under 10 writers", () => {
  test("restores into a new folder with a passing integrity_check, last_seq and counts as in the sidecar", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await pad(folder, 6000);
    const writers = startWriters(folder, 10);
    let backup: BackupRecord;
    let before: number;
    let after: number;
    try {
      await writers.running();
      before = writers.committed();
      backup = await backupSpace(checked, folder, { kind: "manual" });
      after = writers.committed();
    } finally {
      await writers.stop();
    }
    // The writers kept committing while the backup ran: the snapshot is from the middle.
    expect(after).toBeGreaterThan(before);
    const live = await readFacts(folder);
    expect(live.space.lastSeq).toBeGreaterThan(backup.sidecar.seq);
    expect(backup.sidecar.seq).toBeGreaterThanOrEqual(before);

    const restored = await restoreBackup(checked, backup.file, join(folders.make(), "mira"));
    // The restored folder holds the database and its space.json, nothing else.
    expect(readdirSync(restored.folder).sort()).toEqual(["space.db", "space.json"]);
    const facts = await readFacts(restored.folder);
    expect(facts.integrity).toBe("ok");
    expect(facts.space.lastSeq).toBe(backup.sidecar.seq);
    expect(facts.counts).toEqual(backup.sidecar.counts);
    expect(facts.userVersion).toBe(backup.sidecar.user_version);
    expect(facts.space.spaceId).toBe(backup.sidecar.space_id);
    // A consistent snapshot: one commit per seq, and each commit's one change row with it. Every
    // commit is a writer's task.create (one task, its create change) or the machine's register
    // (one machine row, its create change).
    expect(facts.counts["commits"]).toBe(backup.sidecar.seq);
    expect(facts.counts["changes"]).toBe(backup.sidecar.seq);
    expect(facts.counts["machines"]).toBe(1);
    expect(facts.counts["tasks"]).toBe(6000 + backup.sidecar.seq - 1);
    // The restored copy is read-only until it is claimed (A1 3.18).
    const opened = openSpace(checked, restored.folder, { role: "reader" });
    expect(opened.readOnlyReasons).toEqual(["read_only_copy"]);
    const one = (sql: string): unknown => Object.values(opened.conn.prepare(sql).get() ?? {})[0];
    expect(one("SELECT count(*) FROM changes WHERE seq NOT IN (SELECT seq FROM commits)")).toBe(0);
    expect(one("SELECT count(*) FROM tasks WHERE created_seq > 0")).toBe(
      one("SELECT count(*) FROM changes WHERE entity = 'tasks' AND action = 'create'"),
    );
    opened.conn.close();
    await expectCode(
      () => openSpace(checked, restored.folder, { role: "writer" }),
      "SPACE_READ_ONLY_COPY",
    );
  }, 120_000);
});

describe("[A1.5.backup.verified] the backup and its sidecar", () => {
  test("names, sidecar fields, owner-only files and nothing else in the folder", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3);
    const at = Date.UTC(2026, 10, 13, 3, 15, 0, 123);
    const backup = await backupSpace(checked, folder, { kind: "daily", now: () => at });
    expect(backup.name).toBe("daily-20261113T031500.123Z-e1-s3");
    expect(parseBackupName(backup.name)).toEqual({
      kind: "daily",
      createdAt: at,
      epoch: 1,
      seq: 3,
    });
    expect(readdirSync(join(folder, "backups")).sort()).toEqual([
      `${backup.name}.db.gz`,
      `${backup.name}.json`,
    ]);
    const { sidecar } = backup;
    expect(sidecar).toMatchObject({
      tasks_backup: 1,
      kind: "daily",
      created_at: at,
      space_id: space.spaceId,
      epoch: 1,
      incarnation: space.authority.incarnation,
      seq: 3,
      user_version: 2,
      written_by: "0.0.0",
    });
    expect(sidecar.counts["commits"]).toBe(3);
    expect(sidecar.counts["actors"]).toBe(2);
    expect(JSON.parse(readFileSync(backup.sidecarFile, "utf8"))).toEqual(sidecar);
    expect(readFileSync(backup.file).length).toBe(sidecar.compressed_size);
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      for (const f of [backup.file, backup.sidecarFile])
        expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(statSync(join(folder, "backups")).mode & 0o777).toBe(0o700);
    }
    // The listing shows it complete.
    const listing = listBackups(join(folder, "backups"));
    expect(listing.backups.map((b) => [b.name, b.state])).toEqual([[backup.name, "ok"]]);
    expect(listing.leftovers).toEqual([]);
  });

  test("names round-trip and refuse what is not a backup's name", () => {
    const at = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
    const name = backupName({ kind: "pre-migrate", createdAt: at, epoch: 12, seq: 0 });
    expect(name).toBe(`pre-migrate-${utcStamp(at)}-e12-s0`);
    expect(parseBackupName(name)).toEqual({
      kind: "pre-migrate",
      createdAt: at,
      epoch: 12,
      seq: 0,
    });
    for (const bad of [
      "weekly-20260102T030405.006Z-e1-s0",
      "daily-20260230T030405.006Z-e1-s0",
      "daily-20260102T030405.006Z-e0-s0",
      "daily-20260102T030405.006Z-e1-s01",
      "daily-20260102T030405Z-e1-s0",
      "../daily-20260102T030405.006Z-e1-s0",
    ]) {
      expect(parseBackupName(bad), bad).toBeUndefined();
    }
  });

  test("two backups with the same name at once: one is stored, the other fails and replaces nothing", async () => {
    const checked = await checkedDriver();
    const a = await createFixtureSpace(folders.make());
    const b = await createFixtureSpace(folders.make());
    // One folder for both (a machine-local backup.dir set twice), the same kind, time, epoch and
    // seq: the two backups want one name.
    const backupDir = folders.make();
    const now = (): number => Date.UTC(2026, 10, 13);
    const results = await Promise.allSettled([
      backupSpace(checked, a.folder, { kind: "manual", backupDir, now }),
      backupSpace(checked, b.folder, { kind: "manual", backupDir, now }),
      backupSpace(checked, a.folder, { kind: "manual", backupDir, now }),
    ]);
    const stored = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const refused = results.filter((r) => r.status === "rejected").map((r) => r.reason as unknown);
    expect(stored).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const error of refused) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe("BACKUP_FAILED");
    }
    const record = stored[0];
    if (record === undefined) throw new Error("no backup was stored");
    // What is on disk is the backup that was reported, and it restores.
    expect(JSON.parse(readFileSync(record.sidecarFile, "utf8"))).toEqual(record.sidecar);
    const listing = listBackups(backupDir);
    expect(listing.backups.map((x) => [x.name, x.state])).toEqual([[record.name, "ok"]]);
    expect(listing.leftovers).toEqual([]);
    await restoreBackup(checked, record.file, join(folders.make(), "mira"));
  });

  test.skipIf(process.platform === "win32")(
    "new folders on the way to the backups folder are synced into their parents",
    async () => {
      const checked = await checkedDriver();
      const { folder } = await createFixtureSpace(folders.make());
      const parent = folders.make();
      // A machine-local backup.dir that does not exist yet, two levels below an existing folder.
      const backupDir = join(parent, "tasks", "mira", "backups");
      const synced: string[] = [];
      await backupSpaceWith(
        checked,
        folder,
        { kind: "manual", backupDir },
        {
          io: {
            ...NODE_IO,
            openSync: (path, flags, mode) => {
              if (flags === "r") synced.push(path);
              return NODE_IO.openSync(path, flags, mode);
            },
          },
        },
      );
      // Each new folder's entry lives in its parent: the parent of the first new folder and every
      // new folder above the backups folder are synced, and the backups folder itself.
      for (const dir of [parent, join(parent, "tasks"), join(parent, "tasks", "mira"), backupDir]) {
        expect(synced, dir).toContain(dir);
      }
      const at = (dir: string): number => synced.indexOf(dir);
      expect(at(join(parent, "tasks", "mira"))).toBeLessThan(at(backupDir));
    },
  );

  test("errors name no path, and a backup of a missing space is SPACE_NOT_FOUND", async () => {
    const checked = await checkedDriver();
    const parent = folders.make();
    const error = await expectCode(
      () => backupSpace(checked, join(parent, "gone"), { kind: "manual" }),
      "SPACE_NOT_FOUND",
    );
    expect(JSON.stringify(error)).not.toContain(parent);
    const { folder } = await createFixtureSpace(parent);
    // A file where the backups folder should be.
    writeFileSync(join(folder, "backups"), "not a folder");
    const failed = await expectCode(
      () => backupSpace(checked, folder, { kind: "manual" }),
      "BACKUP_FAILED",
    );
    expect(failed.message).not.toContain(parent);
  });
});

describe("[A1.5.backup.crash-windows] a crash or a failure at each point of a backup", () => {
  const POINTS: BackupPoint[] = [
    "copied",
    "checked",
    "compressed",
    "data-published",
    "sidecar-published",
  ];

  test("a crash leaves either a complete backup or leftovers that are never listed as one", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const crashes = new Map<BackupPoint, string>();
    await backupSpaceWith(
      checked,
      folder,
      { kind: "manual" },
      {
        at: (point) => {
          // What a crash at this point leaves on disk: a copy of the space folder as it is now.
          const copy = join(folders.make(), "mira");
          copyTree(folder, copy);
          crashes.set(point, copy);
        },
      },
    );
    expect([...crashes.keys()]).toEqual(POINTS);
    for (const [point, copy] of crashes) {
      const listing = listBackups(join(copy, "backups"));
      const complete = listing.backups.filter((b) => b.state === "ok");
      if (point === "sidecar-published") {
        expect(complete, point).toHaveLength(1);
        expect(
          listing.leftovers.filter((l) => !l.startsWith(BACKUP_TEMP_PREFIX)),
          point,
        ).toEqual([]);
        const restored = await restoreBackup(
          checked,
          complete[0]?.file ?? "",
          join(folders.make(), "mira"),
        );
        expect(restored.space.lastSeq).toBe(2);
      } else {
        expect(complete, point).toEqual([]);
        expect(listing.backups, point).toEqual([]);
        expect(listing.leftovers.length, point).toBeGreaterThan(0);
      }
      // The space itself is untouched at every point and opens as its writer.
      const opened = openSpace(checked, copy, { role: "writer" });
      expect(opened.space.lastSeq).toBe(2);
      opened.conn.close();
      // The leftovers go, and with them every file that is not a complete backup.
      removeBackupLeftovers(listing, AFTER_RESTART);
      const left = readdirSync(join(copy, "backups"));
      expect(left.length, point).toBe(point === "sidecar-published" ? 2 : 0);
    }
  });

  test("a failure before the sidecar is published removes what the backup wrote; after it, the pair stays for the reader", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const before = treeDigest(folder);
    const dir = join(folder, "backups");
    for (const point of POINTS) {
      await expectCode(
        () =>
          backupSpaceWith(
            checked,
            folder,
            { kind: "manual" },
            {
              at: (p) => {
                if (p === point) throw new Error("a stand-in fault");
              },
            },
          ),
        "BACKUP_FAILED",
      );
      if (point !== "sidecar-published") {
        expect(readdirSync(dir), point).toEqual([]);
        continue;
      }
      // The last step failed once the pair was published: nothing is removed, and the reader's
      // checks judge it. This pair is whole, so it lists and restores as a backup.
      const listing = listBackups(dir);
      expect(listing.backups.map((b) => b.state)).toEqual(["ok"]);
      expect(listing.leftovers).toEqual([]);
      await restoreBackup(checked, listing.backups[0]?.file ?? "", join(folders.make(), "mira"));
    }
    rmSync(dir, { recursive: true });
    // The backup's read-only connection leaves what one leaves on a closed WAL space, an empty
    // -wal and the -shm (A1 3.1), and changes nothing else.
    const after = treeDigest(folder);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), ...SIDECARS].sort());
    for (const [file, hash] of Object.entries(before)) expect(after[file], file).toBe(hash);
  });

  test("a slow stage does not expose a running backup's files to another cleanup", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const dir = join(folder, "backups");
    const longAgo = new Date(Date.now() - 2 * HOUR);
    let removed: string[] = [];
    const record = await backupSpaceWith(
      checked,
      folder,
      { kind: "manual" },
      {
        at: (point) => {
          // Every stage before the rename took over an hour: the backup's files all look old.
          if (point === "copied" || point === "checked" || point === "compressed") {
            for (const name of readdirSync(dir)) utimesSync(join(dir, name), longAgo, longAgo);
            return;
          }
          if (point !== "data-published") return;
          // Cleanup in another process, just before the sidecar lands: the `.db.gz` has no
          // sidecar yet, but the backup refreshed it before it took its name.
          removed = removeBackupLeftovers(listBackups(dir));
        },
      },
    );
    expect(removed).toEqual([]);
    const listed = listBackups(dir);
    expect(listed.backups.map((b) => [b.name, b.state])).toEqual([[record.name, "ok"]]);
    await restoreBackup(checked, record.file, join(folders.make(), "mira"));
  });

  test("a backup whose data went away before its sidecar landed fails, and leaves no sidecar", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const error = await expectCode(
      () =>
        backupSpaceWith(
          checked,
          folder,
          { kind: "manual" },
          {
            at: (point) => {
              // Another process's cleanup removed it (a backup stopped for over an hour).
              if (point === "data-published") {
                for (const name of readdirSync(dir)) {
                  if (name.endsWith(".db.gz")) rmSync(join(dir, name));
                }
              }
            },
          },
        ),
      "BACKUP_FAILED",
    );
    expect(error.message).not.toContain(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a backup that lost its files to a replacement fails, and removes none of the replacement's", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const theirs = new Map<string, string>();
    await expectCode(
      () =>
        backupSpaceWith(
          checked,
          folder,
          { kind: "manual" },
          {
            at: (point) => {
              if (point !== "sidecar-published") return;
              // A sync puts another pair under the backup's two names, right after its sidecar.
              for (const name of readdirSync(dir)) {
                if (name.startsWith(BACKUP_TEMP_PREFIX)) continue;
                rmSync(join(dir, name));
                writeFileSync(join(dir, name), `another ${name}`);
                theirs.set(name, `another ${name}`);
              }
            },
          },
        ),
      "BACKUP_FAILED",
    );
    expect(theirs.size).toBe(2);
    for (const [name, text] of theirs) {
      expect(readFileSync(join(dir, name), "utf8"), name).toBe(text);
    }
  });
});

describe("[A1.5.backup.no-replace] a backup publishes its pair without replacing anything", () => {
  const noLinks: FileIo = {
    ...NODE_IO,
    linkSync: () => {
      throw Object.assign(new Error("no hard links on this file system"), { code: "EPERM" });
    },
  };
  const WAYS: [string, FileIo][] = [
    ["links", NODE_IO],
    ["exclusive copies", noLinks],
  ];

  test("a pair planted under the backup's names while it runs is never replaced", async () => {
    const checked = await checkedDriver();
    const at = Date.UTC(2026, 10, 14, 1, 2, 3, 4);
    // Before the names are checked, after the check and before the data is published, and a
    // sidecar alone after the data is published.
    const plants: [BackupPoint, ("data" | "sidecar")[]][] = [
      ["checked", ["data", "sidecar"]],
      ["compressed", ["data", "sidecar"]],
      ["compressed", ["data"]],
      ["data-published", ["sidecar"]],
    ];
    for (const [way, io] of WAYS) {
      for (const [point, which] of plants) {
        const label = `${way}, ${point}, ${which.join("+")}`;
        const { folder } = await createFixtureSpace(folders.make());
        await writeCommits(folder, 2);
        const dir = join(folder, "backups");
        const name = backupName({ kind: "manual", createdAt: at, epoch: 1, seq: 2 });
        const planted = new Map<string, string>();
        for (const part of which) {
          const file = `${name}${part === "data" ? ".db.gz" : ".json"}`;
          planted.set(file, `another program's ${part}`);
        }
        await expectCode(
          () =>
            backupSpaceWith(
              checked,
              folder,
              { kind: "manual", now: () => at },
              {
                io,
                at: (p) => {
                  if (p !== point) return;
                  for (const [file, text] of planted) writeFileSync(join(dir, file), text);
                },
              },
            ),
          "BACKUP_FAILED",
        );
        for (const [file, text] of planted) {
          expect(readFileSync(join(dir, file), "utf8"), label).toBe(text);
        }
        // Nothing of the backup's own is left beside them.
        expect(readdirSync(dir).sort(), label).toEqual([...planted.keys()].sort());
      }
    }
  });

  test("a failure after the sidecar took its name (the folder's sync) removes nothing of the pair", async () => {
    const checked = await checkedDriver();
    for (const [way, base] of WAYS) {
      const { folder } = await createFixtureSpace(folders.make());
      await writeCommits(folder, 2);
      const dir = join(folder, "backups");
      // The folder sync is POSIX's (files.ts fsyncFolder): run it on every OS from the data's
      // publication on, and fail it once the sidecar has its name.
      const FOLDER_FD = -4242;
      let failed = false;
      const io: FileIo = {
        ...base,
        openSync: (path, flags, mode) =>
          path === dir ? FOLDER_FD : base.openSync(path, flags, mode),
        closeSync: (fd) => {
          if (fd !== FOLDER_FD) base.closeSync(fd);
        },
        fsyncSync: (fd) => {
          if (fd !== FOLDER_FD) {
            base.fsyncSync(fd);
            return;
          }
          if (readdirSync(dir).some((n) => n.endsWith(".json") && !n.startsWith("."))) {
            failed = true;
            throw Object.assign(new Error("injected"), { code: "EIO" });
          }
        },
      };
      const platform = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        await expectCode(
          () =>
            backupSpaceWith(
              checked,
              folder,
              { kind: "manual" },
              {
                io,
                at: (p) => {
                  if (p === "data-published") {
                    Object.defineProperty(process, "platform", { value: "linux" });
                  }
                },
              },
            ),
          "BACKUP_FAILED",
        );
      } finally {
        if (platform !== undefined) Object.defineProperty(process, "platform", platform);
      }
      expect(failed, way).toBe(true);
      // The pair stays for the reader's checks, and it is a complete backup that restores.
      const listing = listBackups(dir);
      expect(
        listing.backups.map((b) => b.state),
        way,
      ).toEqual(["ok"]);
      const restored = await restoreBackup(
        checked,
        listing.backups[0]?.file ?? "",
        join(folders.make(), "mira"),
      );
      expect(restored.space.lastSeq, way).toBe(2);
    }
  });

  test("a sidecar copy that fails after its last byte, and cannot be removed again, keeps the data with it", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const dir = join(folder, "backups");
    // The sidecar under its own name (not the temporary file), its descriptor, and the faults: its
    // flush fails, and so does its removal.
    const isSidecar = (path: string): boolean =>
      path.startsWith(dir) && path.endsWith(".json") && !basename(path).startsWith(".");
    let sidecarFd: number | undefined;
    let faults = 0;
    const io: FileIo = {
      ...noLinks,
      openSync: (path, flags, mode) => {
        const fd = NODE_IO.openSync(path, flags, mode);
        if (isSidecar(path)) sidecarFd = fd;
        return fd;
      },
      fsyncSync: (fd) => {
        if (fd === sidecarFd) {
          faults += 1;
          throw Object.assign(new Error("injected"), { code: "EIO" });
        }
        NODE_IO.fsyncSync(fd);
      },
      rmSync: (path, options) => {
        if (isSidecar(path)) {
          faults += 1;
          throw Object.assign(new Error("injected"), { code: "EPERM" });
        }
        NODE_IO.rmSync(path, options);
      },
    };
    await expectCode(
      () => backupSpaceWith(checked, folder, { kind: "manual" }, { io }),
      "BACKUP_FAILED",
    );
    expect(faults).toBe(2);
    // The complete sidecar stayed, so its data stayed too: a pair for the reader's checks.
    expect(listBackups(dir).backups.map((b) => b.state)).toEqual(["ok"]);
  });

  test("without hard links the pair is published by exclusive copies, and restores", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3);
    const record = await backupSpaceWith(checked, folder, { kind: "manual" }, { io: noLinks });
    const listing = listBackups(join(folder, "backups"));
    expect(listing.backups.map((b) => [b.name, b.state])).toEqual([[record.name, "ok"]]);
    expect(listing.leftovers).toEqual([]);
    const restored = await restoreBackup(checked, record.file, join(folders.make(), "mira"));
    expect(restored.space.lastSeq).toBe(3);
  });
});

describe("[A1.5.backup.list] listing a space's backups", () => {
  test("complete backups newest first, damaged ones by state, leftovers, unknown files untouched", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const a = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => Date.UTC(2026, 10, 1),
    });
    const b = await backupSpace(checked, folder, {
      kind: "manual",
      now: () => Date.UTC(2026, 10, 2),
    });
    const c = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => Date.UTC(2026, 10, 3),
    });
    const d = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => Date.UTC(2026, 10, 4),
    });
    const e = await backupSpace(checked, folder, {
      kind: "daily",
      now: () => Date.UTC(2026, 10, 5),
    });
    rmSync(b.file);
    writeFileSync(c.file, Buffer.concat([readFileSync(c.file), Buffer.from([0])]));
    writeFileSync(d.sidecarFile, "{}");
    // A sidecar copied under another backup's name does not match that name.
    writeFileSync(join(dir, "daily-20261106T000000.000Z-e1-s0.json"), readFileSync(e.sidecarFile));
    writeFileSync(join(dir, "daily-20261106T000000.000Z-e1-s0.db.gz"), readFileSync(e.file));
    writeFileSync(join(dir, `${BACKUP_TEMP_PREFIX}0123456789abcdef.db`), "partial");
    writeFileSync(join(dir, "daily-20261107T000000.000Z-e1-s0.db.gz"), "orphan");
    writeFileSync(join(dir, "notes.txt"), "someone's own file");
    const listing = listBackups(dir);
    expect(listing.backups.map((x) => [x.name, x.state])).toEqual([
      ["daily-20261106T000000.000Z-e1-s0", "invalid_sidecar"],
      [e.name, "ok"],
      [d.name, "invalid_sidecar"],
      [c.name, "size_mismatch"],
      [b.name, "missing_data"],
      [a.name, "ok"],
    ]);
    expect(listing.leftovers).toEqual([
      `${BACKUP_TEMP_PREFIX}0123456789abcdef.db`,
      "daily-20261107T000000.000Z-e1-s0.db.gz",
    ]);
    expect(removeBackupLeftovers(listing, AFTER_RESTART)).toEqual(listing.leftovers);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(listBackups(join(folder, "missing")).backups).toEqual([]);
  });

  test("only files a backup writes are leftovers: another program's files and folders stay", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const kept = await backupSpace(checked, folder, { kind: "manual" });
    const tag = "0123456789abcdef";
    const ours = [
      `${BACKUP_TEMP_PREFIX}${tag}.db`,
      `${BACKUP_TEMP_PREFIX}${tag}.db-journal`,
      `${BACKUP_TEMP_PREFIX}${tag}.db-wal`,
      `${BACKUP_TEMP_PREFIX}${tag}.db-shm`,
      `${BACKUP_TEMP_PREFIX}${tag}.db.gz`,
      `.${kept.name}.json.tmp-${tag}`,
    ];
    for (const name of ours) writeFileSync(join(dir, name), "left by a crash");
    const theirs = [
      ".notes.tmp-1.txt",
      `${BACKUP_TEMP_PREFIX}draft.db`,
      `${BACKUP_TEMP_PREFIX}${tag}.txt`,
      `.notes.json.tmp-${tag}`,
    ];
    for (const name of theirs) writeFileSync(join(dir, name), "another program's file");
    // A folder with a temporary-looking name, and one named like a backup's own temporary file.
    mkdirSync(join(dir, ".user.tmp-notes"));
    writeFileSync(join(dir, ".user.tmp-notes", "important.txt"), "not made by Tasks");
    mkdirSync(join(dir, `${BACKUP_TEMP_PREFIX}fedcba9876543210.db`));
    const listing = listBackups(dir);
    expect(listing.leftovers).toEqual([...ours].sort());
    expect(removeBackupLeftovers(listing, AFTER_RESTART).sort()).toEqual([...ours].sort());
    for (const name of theirs) expect(existsSync(join(dir, name)), name).toBe(true);
    expect(existsSync(join(dir, ".user.tmp-notes", "important.txt"))).toBe(true);
    expect(existsSync(join(dir, `${BACKUP_TEMP_PREFIX}fedcba9876543210.db`))).toBe(true);
    expect(listBackups(dir).backups.map((x) => [x.name, x.state])).toEqual([[kept.name, "ok"]]);
  });

  test("a data file is a leftover only when no sidecar is there under any case the disk matches", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    const upper = `${backup.sidecarFile.slice(0, -".json".length)}.JSON`;
    renameSync(backup.sidecarFile, upper);
    // On a file system that ignores case (Windows, macOS), the sidecar is still found by its name,
    // so the backup still restores, and the listing must agree.
    const ignoresCase = existsSync(backup.sidecarFile);
    const listing = listBackups(dir);
    removeBackupLeftovers(listing, AFTER_RESTART);
    if (ignoresCase) {
      expect(listing.leftovers).toEqual([]);
      expect(listing.backups.map((x) => [x.name, x.state])).toEqual([[backup.name, "ok"]]);
      expect(existsSync(backup.file)).toBe(true);
      await restoreBackup(checked, backup.file, join(folders.make(), "mira"));
    } else {
      // The restore would not find it either: the data is a leftover, the stranger stays.
      expect(listing.leftovers).toEqual([`${backup.name}.db.gz`]);
      expect(existsSync(upper)).toBe(true);
    }
  });

  test("a leftover younger than an hour stays: it may be a backup's in progress", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const dir = join(folder, "backups");
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    // What another process's backup into this folder has written so far: its copy, and its data
    // renamed into place a moment before its sidecar.
    const copy = `${BACKUP_TEMP_PREFIX}0123456789abcdef.db`;
    writeFileSync(join(dir, copy), "being written");
    const data = "daily-20261113T031500.000Z-e1-s0.db.gz";
    writeFileSync(join(dir, data), readFileSync(backup.file));
    const listing = listBackups(dir);
    expect(listing.leftovers).toEqual([copy, data]);
    expect(removeBackupLeftovers(listing)).toEqual([]);
    expect(existsSync(join(dir, copy)) && existsSync(join(dir, data))).toBe(true);
    expect(removeBackupLeftovers(listing, { now: Date.now() + 30 * 60_000 })).toEqual([]);
    expect(removeBackupLeftovers(listing, AFTER_RESTART)).toEqual([copy, data]);
  });

  test("a name from disk with a time out of range is ignored, never a crash", () => {
    const dir = folders.make();
    for (const name of [
      "daily-19691231T235959.999Z-e1-s0.db.gz",
      "daily-19691231T235959.999Z-e1-s0.json",
    ]) {
      writeFileSync(join(dir, name), "not a backup");
    }
    expect(parseUtcStamp("19691231T235959.999Z")).toBeUndefined();
    const listing = listBackups(dir);
    expect(listing.backups).toEqual([]);
    expect(listing.leftovers).toEqual([]);
  });
});

describe("[A1.5.backup.bundle-limits] the shared BundlePolicy on .db.gz files", () => {
  const tiny = (overrides: Partial<BundlePolicy>): BundlePolicy => ({
    ...BUNDLE_POLICY,
    ...overrides,
  });

  test("a highly compressible space (100 contexts of 64 KiB) backs up and restores", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const conn = await rawWriter(folder);
    const system = String(
      conn.prepare("SELECT id FROM actors WHERE kind = 'system'").get()?.["id"],
    );
    conn.transaction("immediate", () => {
      conn
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
           INSERT INTO tasks (id, ref, title, context, position, created_at, created_by,
             created_seq, version, touched)
           SELECT 't_ctx' || i, i, 'Context task', replace(hex(zeroblob(32768)), '00', 'ab'),
             'a0', 0, $actor, 0, 0, 0 FROM n`,
        )
        .run({ actor: system });
    });
    conn.close();
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    const ratio = backup.sidecar.size / backup.sidecar.compressed_size;
    // A text-heavy database compresses far beyond a "bomb" ratio, and that is normal: the ratio
    // is no rule (A1 3.18). This corpus measured about 180:1 with zlib's default level.
    expect(ratio).toBeGreaterThan(100);
    const restored = await restoreBackup(checked, backup.file, join(folders.make(), "mira"));
    expect((await readFacts(restored.folder)).counts["tasks"]).toBe(100);
  });

  test("a database over the limit is refused before a backup writes or a restore extracts", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const small = tiny({ maxDatabaseBytes: 64 * 1024 });
    await pad(folder, 200);
    const refused = await expectCode(
      () => backupSpaceWith(checked, folder, { kind: "manual" }, { policy: small }),
      "BUNDLE_LIMIT_EXCEEDED",
    );
    expect(refused.message).toContain("space.db");
    expect(readdirSync(join(folder, "backups"))).toEqual([]);

    const backup = await backupSpace(checked, folder, { kind: "manual" });
    const parent = folders.make();
    await expectCode(
      () => restoreBackupWith(checked, backup.file, join(parent, "mira"), {}, { policy: small }),
      "BUNDLE_LIMIT_EXCEEDED",
    );
    // Extraction stopped and removed its partial folder.
    expect(readdirSync(parent)).toEqual([]);
    // Not enough free disk space for the expansion and the reserve.
    await expectCode(
      () =>
        restoreBackupWith(
          checked,
          backup.file,
          join(parent, "mira"),
          {},
          {
            freeBytes: () => BUNDLE_POLICY.freeSpaceReserveBytes + backup.sidecar.size - 1,
          },
        ),
      "BUNDLE_LIMIT_EXCEEDED",
    );
    expect(readdirSync(parent)).toEqual([]);
  });

  test("a backup that expands beyond its sidecar, or does not decompress, is invalid", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    const sidecar = JSON.parse(readFileSync(backup.sidecarFile, "utf8")) as Record<string, unknown>;
    const parent = folders.make();
    // The sidecar promises less than the archive holds.
    writeFileSync(backup.sidecarFile, JSON.stringify({ ...sidecar, size: 4096 }));
    await expectCode(
      () => restoreBackup(checked, backup.file, join(parent, "mira")),
      "BACKUP_INVALID",
    );
    writeFileSync(backup.sidecarFile, JSON.stringify(sidecar));
    // A truncated archive.
    const bytes = readFileSync(backup.file);
    writeFileSync(backup.file, bytes.subarray(0, bytes.length - 20));
    writeFileSync(
      backup.sidecarFile,
      JSON.stringify({ ...sidecar, compressed_size: bytes.length - 20 }),
    );
    await expectCode(
      () => restoreBackup(checked, backup.file, join(parent, "mira")),
      "BACKUP_INVALID",
    );
    expect(readdirSync(parent)).toEqual([]);
  });
});
