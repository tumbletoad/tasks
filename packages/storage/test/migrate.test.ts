// The migration runner (A1 3.17) behind its barrier backup (A1 3.18, MIL-02), on spaces built at
// 0.1 as a released 0.1 build built them (revisions.ts), with the real 0.2 (M3.01) and a stand-in
// 0.3 that lives in the test tree only (A7 M1.06's Verify line), in the calling thread and on open
// in the storage worker, where the space's writer migrates it under its own claim before the write
// path attaches.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BackupPoint } from "../src/backup/backup.ts";
import { listBackups } from "../src/backup/list.ts";
import { StorageError } from "../src/errors.ts";
import { DATABASE_FILE, MANIFEST_FILE, readManifest } from "../src/manifest.ts";
import {
  migrateSpaceWith,
  type MigrationOutcome,
  type MigrationPoint,
} from "../src/migrate/runner.ts";
import { openWriter } from "../src/open.ts";
import { restoreBackup } from "../src/restore/restore.ts";
import { openSpace, openSpaceWith } from "../src/space.ts";
import { StorageWorker } from "../src/worker/client.ts";
import { readFacts, writeCommits } from "./backup-helpers.ts";
import { createRequest, FIXTURE_MACHINE, ownerCredential } from "./fixture-requests.ts";
import { openSpaceAt, STEPS_0_1 } from "./revisions.ts";
import { checkedDriver, createFixtureSpace, tempFolders } from "./space-helpers.ts";
import { STEP_SETS, STEPS_0_3 } from "./stand-in-steps.ts";
import { rejection, workerWithSteps } from "./worker-helpers.ts";

const folders = tempFolders("migrate");
const workers: StorageWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
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

/** A fixture space at 0.1, as a 0.1 build made it, with `commits` commits from the write path. */
async function spaceAt01(commits = 3): Promise<string> {
  const { folder } = await createFixtureSpace(folders.make(), "mira", {}, STEPS_0_1);
  await writeCommits(folder, commits, "s", STEPS_0_1);
  return folder;
}

/** A storage worker of this build, or of a build with stand-in steps. */
async function worker(set?: keyof typeof STEP_SETS): Promise<StorageWorker> {
  const started =
    set === undefined
      ? await StorageWorker.start({ driver: "node:sqlite" })
      : await workerWithSteps(set);
  workers.push(started);
  return started;
}

/** What a migration must leave untouched when it does not happen. */
async function state(folder: string) {
  const facts = await readFacts(folder);
  return {
    userVersion: facts.userVersion,
    lastSeq: facts.space.lastSeq,
    format: facts.space.format,
    counts: facts.counts,
    undoFloor: facts.space.undoFloorSeq,
  };
}

function failed(
  outcome: MigrationOutcome | undefined,
): Extract<MigrationOutcome, { state: "failed" }> {
  if (outcome?.state !== "failed") throw new Error("expected a failed migration");
  return outcome;
}

function migrated(
  outcome: MigrationOutcome | undefined,
): Extract<MigrationOutcome, { state: "migrated" }> {
  if (outcome?.state !== "migrated") throw new Error("expected a migrated space");
  return outcome;
}

describe("[A1.5.migration.barrier] a migration whose backup fails never starts", () => {
  const POINTS: BackupPoint[] = [
    "copied",
    "checked",
    "compressed",
    "data-published",
    "sidecar-published",
  ];

  test("a backup failure at any point: nothing migrates, and the space opens read-only", async () => {
    const checked = await checkedDriver();
    const folder = await spaceAt01();
    const before = await state(folder);
    for (const point of POINTS) {
      const outcome = failed(
        await migrateSpaceWith(
          checked,
          folder,
          {},
          {
            backup: {
              at: (p) => {
                if (p === point) throw new Error("a stand-in fault");
              },
            },
          },
        ),
      );
      expect(outcome.stage, point).toBe("backup");
      expect(outcome.error.code, point).toBe("BACKUP_FAILED");
      expect(outcome.backup, point).toBeUndefined();
      expect(await state(folder), point).toEqual(before);
      // A failure after the sidecar was published leaves the pair to the reader's checks (A1
      // 3.18): a backup of the state before, though no migration stands behind it.
      expect(
        listBackups(join(folder, "backups")).backups.map((b) => [b.state, b.sidecar?.kind]),
        point,
      ).toEqual(point === "sidecar-published" ? [["ok", "pre-migrate"]] : []);
    }
    // The space still opens: as the writer of the 0.1 build, and read-only, with the reason, for
    // this build, which would migrate it. Only the migration runner's writer accepts the older
    // revision.
    openSpaceAt(checked, folder, { role: "writer" }, STEPS_0_1).conn.close();
    await expectCode(() => openSpace(checked, folder, { role: "writer" }), "SPACE_NEEDS_MIGRATION");
    const reader = openSpace(checked, folder, { role: "reader" });
    expect(reader.readOnlyReasons).toEqual(["older_revision"]);
    reader.conn.close();
  });

  test("a backup that cannot be written: the writer's open fails, and a reader reads with the reason", async () => {
    const folder = await spaceAt01();
    const before = await state(folder);
    writeFileSync(join(folder, "backups"), "a file where the backups folder should be");
    const w = await worker();
    const error = await rejection(w.openSpaceWriter(folder, { machine: FIXTURE_MACHINE }));
    expect(error.code).toBe("BACKUP_FAILED");
    expect(error.message).toMatch(
      /^The barrier backup before the migration to 0\.2 failed, so nothing was migrated\. The space stays at 0\.1\. The backup failed \([A-Z_]+\)$/,
    );
    expect(error.message).not.toContain(folder);
    expect(await state(folder)).toEqual(before);
    // The failed open ended its claim: the space opens read-only, with the reason.
    const { conn, info } = await w.openSpaceReader(folder);
    expect(info.readOnlyReasons).toEqual(["older_revision"]);
    expect(info.revision).toEqual({ major: 0, minor: 1 });
    await conn.close();
    // No barrier backup was taken, so the state it was tried on names none (A1 3.17).
    expect(error.attempt).toEqual({
      from: 1,
      to: 2,
      epoch: info.authority.epoch,
      incarnation: info.authority.incarnation,
      lastSeq: before.lastSeq,
    });
  });

  test("a write between the backup and the migration stops it before any step", async () => {
    const checked = await checkedDriver();
    const folder = await spaceAt01();
    const outcome = failed(
      await migrateSpaceWith(
        checked,
        folder,
        {},
        {
          backup: {
            at: (p) => {
              if (p !== "sidecar-published") return;
              // Another connection commits after the snapshot: the backup is no longer the state.
              const other = openWriter(checked, join(folder, DATABASE_FILE));
              try {
                other.exec("UPDATE space SET name = 'Mira two' WHERE one = 1");
              } finally {
                other.close();
              }
            },
          },
        },
      ),
    );
    expect(outcome.stage).toBe("migration");
    expect(outcome.error.code).toBe("SPACE_CHANGED");
    // The verified backup stays: it is a good backup of the state before that write.
    expect(outcome.backup?.sidecar.kind).toBe("pre-migrate");
    expect(outcome.error.message).toContain(`Backup: ${outcome.backup?.name ?? "?"}`);
    expect((await state(folder)).userVersion).toBe(1);
  });

  test("a space whose writer is open is never migrated beside it: the migration runs under the writer's claim", async () => {
    const folder = await spaceAt01(2);
    const current = await worker("0.1");
    const newer = await worker();
    // The 0.1 build's writer has the space: this build, which would migrate it, cannot open it.
    const writer = await current.openSpaceWriter(folder, { machine: FIXTURE_MACHINE });
    expect(
      (await rejection(newer.openSpaceWriter(folder, { machine: FIXTURE_MACHINE }))).code,
    ).toBe("SPACE_WRITER_TAKEN");
    expect(await state(folder)).toMatchObject({ userVersion: 1, lastSeq: 2 });
    expect(listBackups(join(folder, "backups")).backups).toEqual([]);
    await writer.close();

    // Now the newer build's writer opens it: migrated first, then the write path attaches.
    const migratedWriter = await newer.openSpaceWriter(folder, { machine: FIXTURE_MACHINE });
    expect(migratedWriter.revision).toEqual({ major: 0, minor: 2 });
    expect(migratedWriter.readOnlyReasons).toEqual([]);
    expect(migratedWriter.migration).toMatchObject({
      from: { major: 0, minor: 1 },
      to: { major: 0, minor: 2 },
      seqs: [3],
      manifestWritten: true,
    });
    expect(migratedWriter.migration?.backup.sidecar).toMatchObject({
      kind: "pre-migrate",
      user_version: 1,
      seq: 2,
    });
    // While it is open, no other writer of the process opens the space.
    expect(
      (await rejection(current.openSpaceWriter(folder, { machine: FIXTURE_MACHINE }))).code,
    ).toBe("SPACE_WRITER_TAKEN");
    // The write path works on the migrated schema.
    const facts = await readFacts(folder);
    const owner = await readOwner(folder);
    const result = await migratedWriter.submit(
      createRequest(facts.space.spaceId, ownerCredential(owner), "After the migration"),
    );
    expect(result.status).toBe("applied");
    expect(result.seq).toBe(4);
    await migratedWriter.close();
    expect(await state(folder)).toMatchObject({ userVersion: 2, lastSeq: 4 });
  });
});

describe("[A1.5.migration.barrier] only the authority migrates", () => {
  test("a space whose authority is another machine is not migrated by this machine's writer", async () => {
    const { folder } = await createFixtureSpace(
      folders.make(),
      "mira",
      { machineId: "m_7q7k9d2xw8f4r6t1c5v0b2n8aa" },
      STEPS_0_1,
    );
    const before = await state(folder);
    const w = await worker();
    const error = await rejection(w.openSpaceWriter(folder, { machine: FIXTURE_MACHINE }));
    expect(error.code).toBe("SPACE_NEEDS_MIGRATION");
    expect(await state(folder)).toEqual(before);
    expect(listBackups(join(folder, "backups")).backups).toEqual([]);
    // It reads, with the reason; and the claim ended, so it can be opened again.
    const { conn, info } = await w.openSpaceReader(folder);
    expect(info.readOnlyReasons).toEqual(["older_revision"]);
    await conn.close();
    expect((await rejection(w.openSpaceWriter(folder, { machine: FIXTURE_MACHINE }))).code).toBe(
      "SPACE_NEEDS_MIGRATION",
    );
  });
});

/** The fixture space's owner. */
async function readOwner(folder: string) {
  const conn = openSpace(await checkedDriver(), folder, { role: "reader" }).conn;
  try {
    const id = conn.prepare("SELECT id FROM actors WHERE kind = 'human'").get()?.["id"];
    if (typeof id !== "string" || !id.startsWith("ac_")) throw new Error("no owner");
    return id as `ac_${string}`;
  } finally {
    conn.close();
  }
}

describe("[A1.5.migration.stand-in-steps] the runner from 0.1 through the real 0.2 and a stand-in 0.3", () => {
  test("0.1 to 0.3: one system commit per step, user_version, format, undo floor, space.json", async () => {
    const checked = await checkedDriver();
    const folder = await spaceAt01(3);
    const at = Date.UTC(2026, 10, 13, 9, 0, 0);
    const outcome = migrated(
      await migrateSpaceWith(checked, folder, { now: () => at }, { steps: STEPS_0_3 }),
    );
    expect(outcome.from).toEqual({ major: 0, minor: 1 });
    expect(outcome.to).toEqual({ major: 0, minor: 3 });
    expect(outcome.seqs).toEqual([4, 5]);
    expect(outcome.manifestWritten).toBe(true);
    // The barrier backup is of the revision the runner started from.
    expect(outcome.backup.sidecar).toMatchObject({ kind: "pre-migrate", user_version: 1, seq: 3 });
    expect(outcome.backup.name.startsWith("pre-migrate-")).toBe(true);

    const facts = await readFacts(folder);
    expect(facts.userVersion).toBe(3);
    expect(facts.space.format).toEqual({ major: 0, minor: 3 });
    expect(facts.space.lastSeq).toBe(5);
    expect(facts.space.undoFloorSeq).toBe(5);
    expect(facts.counts["test_labels"]).toBe(0);
    const conn = openSpaceWith(checked, folder, { role: "reader" }, { steps: STEPS_0_3 }).conn;
    try {
      const commits = conn
        .prepare(
          "SELECT seq, kind, origin, actor_kind, scope_id, request_id, epoch, incarnation, ops, " +
            "at, affected FROM commits WHERE seq > 3 ORDER BY seq",
        )
        .all();
      expect(commits).toHaveLength(2);
      const { spaceId, authority } = facts.space;
      for (const [i, commit] of commits.entries()) {
        // The writer's own system commit (write/writer.ts writeSystemCommit), as machine.register.
        expect(commit).toMatchObject({
          kind: "migration",
          origin: "migration",
          actor_kind: "system",
          scope_id: "system",
          request_id: `migrate-${String(i + 2)}-${authority.incarnation.slice(3)}`,
          epoch: 1,
          incarnation: authority.incarnation,
          affected: 0,
        });
        expect(commit["at"]).toBeGreaterThanOrEqual(at);
      }
      // One commits.ops format: {v, op, target, input}, as every commit the writer writes.
      expect(JSON.parse(String(commits[0]?.["ops"]))).toEqual([
        {
          v: 1,
          op: "schema.migrate",
          target: spaceId,
          input: { step: 2, from: "0.1", to: "0.2" },
        },
      ]);
      expect(JSON.parse(String(commits[1]?.["ops"]))).toEqual([
        {
          v: 1,
          op: "schema.migrate",
          target: spaceId,
          input: { step: 9003, from: "0.2", to: "0.3" },
        },
      ]);
      // A migration changes no replicated row: no change rows, no outbox rows.
      expect(conn.prepare("SELECT count(*) AS n FROM changes WHERE seq > 3").get()?.["n"]).toBe(0);
      expect(conn.prepare("SELECT count(*) AS n FROM outbox WHERE seq > 3").get()?.["n"]).toBe(0);
      // The new column has its default on the old rows: the two tasks of seq 2 and 3.
      expect(conn.prepare("SELECT count(*) AS n FROM tasks WHERE test_flag = 0").get()?.["n"]).toBe(
        2,
      );
    } finally {
      conn.close();
    }
    // space.json speaks for 0.3, and the space opens as the writer of a build with these steps.
    const manifest = readManifest(folder);
    expect(manifest.state === "present" && manifest.manifest?.format).toEqual({
      major: 0,
      minor: 3,
    });
    const writer = openSpaceWith(checked, folder, { role: "writer" }, { steps: STEPS_0_3 });
    expect(writer.manifestRebuilt).toBe(false);
    writer.conn.close();
    // This build's real steps end at 0.2: a writer refuses the newer space, a reader reads it.
    await expectCode(() => openSpace(checked, folder, { role: "writer" }), "SPACE_TOO_NEW");
    const reader = openSpace(checked, folder, { role: "reader" });
    expect(reader.readOnlyReasons).toEqual(["newer_revision"]);
    reader.conn.close();
    // The downgrade is a restore of the pre-migration backup (A1 3.17).
    const restored = await restoreBackup(
      checked,
      outcome.backup.file,
      join(folders.make(), "mira"),
    );
    expect(restored.revision).toEqual({ major: 0, minor: 1 });
    expect(restored.space.lastSeq).toBe(3);
  });

  test("one step at a time: 0.1 to 0.2, then 0.2 to 0.3; a current space is left alone", async () => {
    const checked = await checkedDriver();
    const folder = await spaceAt01(1);
    expect(migrated(await migrateSpaceWith(checked, folder, {}, {})).seqs).toEqual([2]);
    expect(
      migrated(await migrateSpaceWith(checked, folder, {}, { steps: STEPS_0_3 })).seqs,
    ).toEqual([3]);
    expect(await migrateSpaceWith(checked, folder, {}, { steps: STEPS_0_3 })).toEqual({
      state: "current",
      revision: { major: 0, minor: 3 },
    });
    expect(
      listBackups(join(folder, "backups")).backups.map((b) => b.sidecar?.user_version),
    ).toEqual([2, 1]);
  });

  const FAILING = [
    ["fails midway through its up", "midway", "STORAGE_SQL"],
    ["fails its own verify", "verify", "SPACE_INVALID"],
    ["leaves a broken foreign key", "foreign-key", "STORAGE_CONSTRAINT"],
  ] as const;

  test.each(FAILING)(
    "a step that %s: the writer's open fails, the space stays at 0.1 and opens read-only",
    async (_, set, cause) => {
      const checked = await checkedDriver();
      const folder = await spaceAt01(3);
      const before = await state(folder);
      const w = await worker(set);
      const error = await rejection(w.openSpaceWriter(folder, { machine: FIXTURE_MACHINE }));
      expect(error.code).toBe("MIGRATION_FAILED");
      const backup = listBackups(join(folder, "backups")).backups[0];
      expect(backup?.state).toBe("ok");
      expect(backup?.sidecar).toMatchObject({ kind: "pre-migrate", user_version: 1, seq: 3 });
      // A1 3.17's message: the revision, the cause, the data unchanged and the barrier backup.
      expect(error.message).toBe(
        `Migration to 0.3 failed (${cause}). Your data is unchanged. The space stays at 0.1. ` +
          `Backup: ${backup?.name ?? "?"}`,
      );
      // Every step rolled back, the real 0.2 too: one transaction holds them all.
      expect(await state(folder)).toEqual(before);
      const counts = (await readFacts(folder)).counts;
      expect(counts["test_labels"]).toBeUndefined();
      expect(counts["labels"]).toBeUndefined();
      // Read-only, with the reason: the space is at 0.1.
      const { conn, info } = await w.openSpaceReader(folder);
      expect(info.readOnlyReasons).toEqual(["older_revision"]);
      expect(info.revision).toEqual({ major: 0, minor: 1 });
      expect(info.lastSeq).toBe(3);
      await conn.close();
      // The error names the state it was tried on, across the worker's boundary, so the service
      // can tell a later open on the same state (A1 3.17): the state the reader reads now.
      expect(error.attempt).toEqual({
        from: 1,
        to: 3,
        epoch: info.authority.epoch,
        incarnation: info.authority.incarnation,
        lastSeq: 3,
        backup: backup?.name,
      });
      // The writer of the 0.1 build opens it.
      openSpaceAt(checked, folder, { role: "writer" }, STEPS_0_1).conn.close();
    },
  );

  test("a crash inside the transaction leaves 0.1; after COMMIT, 0.3 with space.json repaired", async () => {
    const checked = await checkedDriver();
    const folder = await spaceAt01(2);
    const crashes = new Map<string, string>();
    const crash = (label: string): void => {
      // A crash now leaves the database and its -wal as they are on disk, and space.json.
      const copy = join(folders.make(), "mira");
      mkdirSync(copy);
      for (const f of [DATABASE_FILE, `${DATABASE_FILE}-wal`, MANIFEST_FILE]) {
        if (existsSync(join(folder, f))) copyFileSync(join(folder, f), join(copy, f));
      }
      crashes.set(label, copy);
    };
    const points: MigrationPoint[] = [];
    migrated(
      await migrateSpaceWith(
        checked,
        folder,
        {},
        {
          steps: STEPS_0_3,
          at: (point, step) => {
            points.push(point);
            crash(step === undefined ? point : `${point}:${String(step.id)}`);
          },
        },
      ),
    );
    expect(points).toEqual(["backed-up", "step-applied", "step-applied", "checked", "committed"]);
    for (const [label, copy] of crashes) {
      const facts = await readFacts(copy);
      expect(facts.integrity, label).toBe("ok");
      if (label === "committed") {
        expect(facts.userVersion, label).toBe(3);
        // space.json is still 0.1's: the next writer rebuilds it from the database.
        const writer = openSpaceWith(checked, copy, { role: "writer" }, { steps: STEPS_0_3 });
        expect(writer.manifestRebuilt).toBe(true);
        writer.conn.close();
      } else {
        expect(facts.userVersion, label).toBe(1);
        expect(facts.space.lastSeq, label).toBe(2);
        openSpaceAt(checked, copy, { role: "writer" }, STEPS_0_1).conn.close();
      }
    }
  });

  test("openSpaceWriter opens a current space without a migration, and an older one after it", async () => {
    const folder = await spaceAt01(1);
    const current = await worker("0.1");
    const writer = await current.openSpaceWriter(folder, { machine: FIXTURE_MACHINE });
    expect(writer.migration).toBeUndefined();
    expect(writer.revision).toEqual({ major: 0, minor: 1 });
    await writer.close();
    // A build with 0.2 and 0.3 migrates both steps on open, its barrier backup where it is told.
    const backupDir = join(folders.make(), "elsewhere", "backups");
    const newer = await worker("0.3");
    const next = await newer.openSpaceWriter(folder, { machine: FIXTURE_MACHINE, backupDir });
    expect(next.migration?.to).toEqual({ major: 0, minor: 3 });
    expect(next.migration?.seqs).toEqual([2, 3]);
    expect(listBackups(backupDir).backups.map((b) => b.name)).toEqual([
      next.migration?.backup.name,
    ]);
    await next.close();
    expect((await readFacts(folder)).space.format).toEqual({ major: 0, minor: 3 });
    // A refusal other than an older revision is thrown as open throws it.
    expect(
      (
        await rejection(
          newer.openSpaceWriter(join(folders.make(), "gone"), { machine: FIXTURE_MACHINE }),
        )
      ).code,
    ).toBe("SPACE_NOT_FOUND");
  });
});
