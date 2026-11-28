// Restore (A1 3.18): into a new folder, and in place with a restore claim (A6 3.5), the crash
// windows of the in-place swap, and the recovery of a space with a rollback journal (A1
// 3.18).
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { backupSpace, type BackupRecord } from "../src/backup/backup.ts";
import { listBackups } from "../src/backup/list.ts";
import { StorageError } from "../src/errors.ts";
import { newId, type Id } from "../src/ids.ts";
import { DATABASE_FILE, MANIFEST_FILE, MANIFEST_MAX_BYTES, readManifest } from "../src/manifest.ts";
import { migrateSpaceWith } from "../src/migrate/runner.ts";
import { finishInterruptedRestore, type SwapPoint } from "../src/restore/folders.ts";
import { recoverSpace, recoverSpaceWith } from "../src/restore/recover.ts";
import {
  restoreBackup,
  restoreBackupWith,
  restoreInPlace,
  restoreInPlaceWith,
  type RestorePoint,
} from "../src/restore/restore.ts";
import type { LineageEntry } from "../src/rows.ts";
import { openSpace, openSpaceWith } from "../src/space.ts";
import { StorageWorker } from "../src/worker/client.ts";
import { copyTree, rawWriter, readFacts, treeDigest, writeCommits } from "./backup-helpers.ts";
import { createRequest, FIXTURE_MACHINE, ownerCredential } from "./fixture-requests.ts";
import { checkedDriver, createFixtureSpace, TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import { STEPS_0_7 } from "./stand-in-steps.ts";
import { blocked, rejection, sent } from "./worker-helpers.ts";

const folders = tempFolders("restore");
const OTHER_MACHINE: Id<"m"> = "m_7q7k9d2xw8f4r6t1c5v0b2n8aa";
const workers: StorageWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
  folders.cleanup();
});

async function worker(): Promise<StorageWorker> {
  const started = await StorageWorker.start({ driver: "node:sqlite" });
  workers.push(started);
  return started;
}

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

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * A tree is as it was, except for what a read-only open of a closed WAL space leaves beside its
 * database: an empty -wal and the -shm (A1 3.1).
 */
function expectSameTree(after: Record<string, string>, before: Record<string, string>): void {
  const added = Object.keys(after).filter((f) => !(f in before));
  for (const file of added) {
    expect(file.endsWith("space.db-wal") || file.endsWith("space.db-shm"), file).toBe(true);
    if (file.endsWith("-wal")) expect(after[file]).toBe(EMPTY_SHA256);
  }
  for (const [file, hash] of Object.entries(before)) expect(after[file], file).toBe(hash);
}

/** A fixture space with `before` commits, a backup, then `after` more commits. */
async function spaceWithBackup(
  before: number,
  after: number,
): Promise<{ folder: string; backup: BackupRecord }> {
  const checked = await checkedDriver();
  const { folder } = await createFixtureSpace(folders.make());
  await writeCommits(folder, before, "a");
  const backup = await backupSpace(checked, folder, { kind: "manual" });
  await writeCommits(folder, after, "b");
  return { folder, backup };
}

describe("[A1.5.restore.new-folder] restore into a new folder", () => {
  test("the copy keeps the backup's identity and state, and the live space is not touched", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup(4, 2);
    const live = treeDigest(folder);
    const target = join(folders.make(), "mira-copy");
    const restored = await restoreBackup(checked, backup.file, target);
    expect(restored.folder).toBe(target);
    expect(restored.space.lastSeq).toBe(4);
    expect(restored.space.spaceId).toBe(backup.sidecar.space_id);
    expect(restored.space.authority.incarnation).toBe(backup.sidecar.incarnation);
    expect(readdirSync(target).sort()).toEqual([DATABASE_FILE, MANIFEST_FILE]);
    expect(treeDigest(folder)).toEqual(live);
    const manifest = readManifest(target);
    expect(manifest.state === "present" && manifest.manifest?.space_id).toBe(
      backup.sidecar.space_id,
    );
    // It is a read-only copy until it is claimed ([A1.5.restore.read-only-copy]).
    const opened = openSpace(checked, target, { role: "reader" });
    expect(opened.readOnlyReasons).toEqual(["read_only_copy"]);
    opened.conn.close();
  });

  test("refuses an existing target, a tampered or mismatched backup, and leaves nothing", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup(1, 0);
    const parent = folders.make();
    await expectCode(() => restoreBackup(checked, backup.file, folder), "SPACE_EXISTS");
    await expectCode(
      () => restoreBackup(checked, backup.file, join(parent, "x", "mira")),
      "SPACE_NOT_FOUND",
    );
    const target = join(parent, "mira");
    const original = readFileSync(backup.file);
    const sidecar = readFileSync(backup.sidecarFile, "utf8");
    // One flipped byte inside the compressed data.
    const flipped = Buffer.from(original);
    const middle = Math.floor(flipped.length / 2);
    flipped[middle] = (flipped[middle] ?? 0) ^ 0xff;
    writeFileSync(backup.file, flipped);
    await expectCode(() => restoreBackup(checked, backup.file, target), "BACKUP_INVALID");
    writeFileSync(backup.file, original);
    // A sidecar whose hash or counts differ from the content.
    const json = JSON.parse(sidecar) as Record<string, unknown>;
    for (const edit of [
      { sha256: "0".repeat(64) },
      { compressed_sha256: "0".repeat(64) },
      { counts: { ...(json["counts"] as object), commits: 99 } },
      { seq: 2 },
    ]) {
      writeFileSync(backup.sidecarFile, JSON.stringify({ ...json, ...edit }));
      await expectCode(() => restoreBackup(checked, backup.file, target), "BACKUP_INVALID");
    }
    // A missing sidecar, a file not named like a backup.
    rmSync(backup.sidecarFile);
    await expectCode(() => restoreBackup(checked, backup.file, target), "BACKUP_INVALID");
    writeFileSync(backup.sidecarFile, sidecar);
    const renamed = join(dirname(backup.file), "copy.db.gz");
    copyFileSync(backup.file, renamed);
    await expectCode(() => restoreBackup(checked, renamed, target), "BACKUP_INVALID");
    expect(readdirSync(parent)).toEqual([]);
    // After all that, the untouched backup restores.
    await restoreBackup(checked, backup.file, target);
  });

  test("a backup reached through a link is refused, never followed", async () => {
    const checked = await checkedDriver();
    const { backup } = await spaceWithBackup(1, 0);
    const links = folders.make();
    const link = join(links, basename(backup.file));
    try {
      symlinkSync(backup.file, link, "file");
    } catch {
      // Windows refuses symbolic links without the privilege: nothing to test there.
      return;
    }
    copyFileSync(backup.sidecarFile, join(links, basename(backup.sidecarFile)));
    await expectCode(
      () => restoreBackup(checked, link, join(folders.make(), "mira")),
      "BACKUP_INVALID",
    );
  });

  test("a backup of a newer revision than this build is refused; an older one restores", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const outcome = await migrateSpaceWith(checked, folder, {}, { steps: STEPS_0_7 });
    if (outcome.state !== "migrated") throw new Error("the stand-in migration failed");
    const newer = await backupSpace(checked, folder, { kind: "manual" });
    expect(newer.sidecar.user_version).toBe(7);
    const parent = folders.make();
    await expectCode(
      () => restoreBackup(checked, newer.file, join(parent, "mira")),
      "SPACE_TOO_NEW",
    );
    expect(readdirSync(parent)).toEqual([]);
    // The pre-migration backup is 0.6, which this build writes.
    const older = await restoreBackup(checked, outcome.backup.file, join(parent, "mira"));
    expect(older.revision).toEqual({ major: 0, minor: 6 });
  });
});

describe("[A1.5.restore.read-only-copy] a backup restored into a new folder is a read-only copy until claimed", () => {
  test("a writer is refused, a reader reads, a claim makes it writable with a new incarnation, and the original is untouched", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup(3, 1);
    const originalFacts = await readFacts(folder);
    const originalTree = treeDigest(folder);
    const target = join(folders.make(), "mira");
    const at = Date.UTC(2026, 10, 13, 12, 0, 0);
    const restored = await restoreBackup(checked, backup.file, target, { now: () => at });
    expect(restored.space.transfer).toEqual({
      state: "restored_copy",
      at,
      backup: basename(backup.file),
    });

    // Every writer is refused with the reason's own code: in the calling thread and in a worker.
    await expectCode(() => openSpace(checked, target, { role: "writer" }), "SPACE_READ_ONLY_COPY");
    const w = await worker();
    const refused = await rejection(w.openSpaceWriter(target, { machine: FIXTURE_MACHINE }));
    expect(refused.code).toBe("SPACE_READ_ONLY_COPY");
    expect(refused.message).toBe(
      "This space is a restored copy and opens read-only until it is claimed",
    );
    // A reader reads it, with the reason.
    const { conn, info } = await w.openSpaceReader(target);
    expect(info.readOnlyReasons).toEqual(["read_only_copy"]);
    expect(await conn.get("SELECT count(*) AS n FROM commits")).toEqual({ n: 3 });
    await conn.close();
    // space.json describes the mark; the database holds it.
    const described = readManifest(target);
    expect(described.state === "present" && described.manifest?.transfer).toEqual({
      state: "restored_copy",
      at,
      backup: basename(backup.file),
    });

    // The claim: a new epoch above every known one, a new incarnation, one commit that also ends
    // the copy state, in the one commits.ops format.
    const claim = await w.claimSpace(target, { machine: FIXTURE_MACHINE, knownEpochs: [4] });
    expect(claim.epoch).toBe(5);
    expect(claim.incarnation).not.toBe(backup.sidecar.incarnation);
    expect(claim.seq).toBe(4);
    expect(claim.parent).toEqual({ incarnation: backup.sidecar.incarnation, through_seq: 3 });
    expect(claim.space.transfer).toBeNull();
    const facts = await readFacts(target);
    expect(facts.space.authority).toEqual({
      machineId: TEST_MACHINE,
      epoch: 5,
      incarnation: claim.incarnation,
      sinceSeq: 4,
    });
    expect(facts.space.transfer).toBeNull();
    const reader = openSpace(checked, target, { role: "reader" });
    expect(reader.readOnlyReasons).toEqual([]);
    const commit = reader.conn.prepare("SELECT * FROM commits WHERE seq = 4").get() ?? {};
    expect(commit).toMatchObject({
      kind: "ops",
      origin: "system",
      actor_kind: "system",
      scope_id: "system",
      request_id: `claim-${claim.incarnation.slice(3)}`,
      epoch: 5,
      incarnation: claim.incarnation,
      machine_id: TEST_MACHINE,
    });
    expect(JSON.parse(String(commit["ops"]))).toEqual([
      {
        v: 1,
        op: "space.claim",
        target: backup.sidecar.space_id,
        input: { kind: "claim", epoch: 5, incarnation: claim.incarnation, parent: claim.parent },
      },
    ]);
    expect(facts.space.lineage.incarnations.at(-1)).toEqual({
      incarnation: claim.incarnation,
      epoch: 5,
      kind: "claim",
      parent: claim.parent,
      machine_id: TEST_MACHINE,
      at: commit["at"],
    });
    reader.conn.close();
    const manifest = readManifest(target);
    expect(manifest.state === "present" && manifest.manifest?.transfer).toBeNull();

    // Now it opens for writing, under its new incarnation.
    const writer = await w.openSpaceWriter(target, { machine: FIXTURE_MACHINE });
    const result = await writer.submit(
      createRequest(writer.spaceId, ownerCredential(await ownerOf(target)), "In the claimed copy"),
    );
    expect(result.status).toBe("applied");
    expect(result.incarnation).toBe(claim.incarnation);
    expect(result.seq).toBe(5);
    await writer.close();
    // A claim again is refused: it is no read-only copy any more.
    expect((await rejection(w.claimSpace(target, { machine: FIXTURE_MACHINE }))).code).toBe(
      "STORAGE_MISUSE",
    );

    // The original space is untouched.
    expectSameTree(treeDigest(folder), originalTree);
    const after = await readFacts(folder);
    expect(after.space.authority).toEqual(originalFacts.space.authority);
    expect(after.space.lastSeq).toBe(originalFacts.space.lastSeq);
    expect(after.counts).toEqual(originalFacts.counts);
  });

  test("the mark survives a copy of the folder or of the database alone, and a missing or damaged space.json", async () => {
    const checked = await checkedDriver();
    const { backup } = await spaceWithBackup(2, 0);
    const target = join(folders.make(), "mira");
    await restoreBackup(checked, backup.file, target);
    // A copy of the whole folder.
    const copied = join(folders.make(), "mira");
    copyTree(target, copied);
    // The database alone, with no space.json.
    const bare = join(folders.make(), "mira");
    copyTree(target, bare);
    rmSync(join(bare, MANIFEST_FILE));
    // A damaged space.json.
    const damaged = join(folders.make(), "mira");
    copyTree(target, damaged);
    writeFileSync(join(damaged, MANIFEST_FILE), "{ not a manifest");
    for (const [label, path, code, reasons] of [
      ["copy", copied, "SPACE_READ_ONLY_COPY", ["read_only_copy"]],
      ["bare", bare, "SPACE_READ_ONLY_COPY", ["read_only_copy"]],
      ["damaged", damaged, "SPACE_MANIFEST_DAMAGED", ["manifest_damaged", "read_only_copy"]],
    ] as const) {
      await expectCode(() => openSpace(checked, path, { role: "writer" }), code);
      const reader = openSpace(checked, path, { role: "reader" });
      expect(reader.readOnlyReasons, label).toEqual(reasons);
      reader.conn.close();
    }
    // The refused writer rebuilt no space.json: the bare copy still has none.
    expect(existsSync(join(bare, MANIFEST_FILE))).toBe(false);
    // Recovery of a read-only copy keeps the mark: it is in the database.
    writeFileSync(join(copied, `${DATABASE_FILE}-journal`), "");
    recoverSpace(checked, copied);
    await expectCode(() => openSpace(checked, copied, { role: "writer" }), "SPACE_READ_ONLY_COPY");
    // A restore in place claims what it restores, so a backup of a read-only copy comes back
    // writable there.
    const copyBackup = await backupSpace(checked, copied, { kind: "manual" });
    const inPlace = await restoreInPlace(checked, copyBackup.file, target, {
      machineId: TEST_MACHINE,
    });
    expect(inPlace.space.transfer).toBeNull();
    openSpace(checked, target, { role: "writer" }).conn.close();
  });

  test("a failure or a crash before the copy takes its name leaves no folder there", async () => {
    const checked = await checkedDriver();
    const { backup } = await spaceWithBackup(1, 0);
    const parent = folders.make();
    const target = join(parent, "mira");
    for (const point of ["unpacked", "marked"] as const) {
      await expect(
        restoreBackupWith(
          checked,
          backup.file,
          target,
          {},
          {
            at: (p) => {
              if (p === point) throw new Error("a stand-in fault");
            },
          },
        ),
      ).rejects.toThrow("a stand-in fault");
      expect(readdirSync(parent), point).toEqual([]);
    }
    // A crash at `marked` leaves the marked copy in its staging folder only: no space by the
    // target's name, and the staging folder is a leftover that names itself.
    let crashed = "";
    await restoreBackupWith(
      checked,
      backup.file,
      target,
      {},
      {
        at: (p) => {
          if (p !== "marked") return;
          crashed = join(folders.make(), "spaces");
          copyTree(parent, crashed);
        },
      },
    );
    const names = readdirSync(crashed);
    expect(names).toHaveLength(1);
    expect(names[0]?.startsWith(".mira.restoring-")).toBe(true);
  });
});

/** The fixture space's owner. */
async function ownerOf(folder: string): Promise<Id<"ac">> {
  const conn = openSpace(await checkedDriver(), folder, { role: "reader" }).conn;
  try {
    const id = conn.prepare("SELECT id FROM actors WHERE kind = 'human'").get()?.["id"];
    if (typeof id !== "string" || !id.startsWith("ac_")) throw new Error("no owner");
    return id as Id<"ac">;
  } finally {
    conn.close();
  }
}

describe("[A1.5.restore.one-writer] restore in place, recovery and a claim hold the space's claim", () => {
  test("each is refused while the space's writer is open in the process", async () => {
    const { folder, backup } = await spaceWithBackup(2, 1);
    const w = await worker();
    const writer = await w.openSpaceWriter(folder, { machine: FIXTURE_MACHINE });
    expect(
      (await rejection(w.restoreInPlace(backup.file, folder, { machineId: TEST_MACHINE }))).code,
    ).toBe("SPACE_WRITER_TAKEN");
    writeFileSync(join(folder, `${DATABASE_FILE}-journal`), "");
    expect((await rejection(w.recoverSpace(folder))).code).toBe("SPACE_WRITER_TAKEN");
    rmSync(join(folder, `${DATABASE_FILE}-journal`));
    // A read-only copy of the same space in another folder: its claim is a writer of the same
    // space ID, which one writer per space refuses while the original is open.
    const target = join(folders.make(), "mira");
    await restoreBackup(await checkedDriver(), backup.file, target);
    expect((await rejection(w.claimSpace(target, { machine: FIXTURE_MACHINE }))).code).toBe(
      "SPACE_WRITER_TAKEN",
    );
    expect((await readFacts(target)).space.transfer).not.toBeNull();
    // The writer still writes, and nothing moved.
    const result = await writer.submit(
      createRequest(writer.spaceId, ownerCredential(await ownerOf(folder)), "Still here"),
    );
    expect(result.status).toBe("applied");
    await writer.close();
    expect(readdirSync(dirname(folder))).toEqual(["mira"]);
  });

  test("a restore in place or a recovery through a link to the space folder is refused, and nothing moves", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup(2, 1);
    // A link to the space folder beside it: a junction on Windows, which needs no privilege.
    const alias = join(dirname(folder), "alias");
    symlinkSync(folder, alias, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(folder, `${DATABASE_FILE}-journal`), "");
    const before = treeDigest(folder);
    await expectCode(
      () => restoreInPlace(checked, backup.file, alias, { machineId: TEST_MACHINE }),
      "SPACE_PATH_INVALID",
    );
    await expectCode(() => recoverSpace(checked, alias), "SPACE_PATH_INVALID");
    const w = await worker();
    expect((await rejection(w.recoverSpace(alias))).code).toBe("SPACE_PATH_INVALID");
    // The link and the space are where they were: the swap would have renamed the link.
    expect(readdirSync(dirname(folder)).sort()).toEqual(["alias", "mira"]);
    expect(treeDigest(folder)).toEqual(before);
    // On the folder itself, both work.
    recoverSpace(checked, folder);
    openSpace(checked, folder, { role: "writer" }).conn.close();
  });

  test("no writer of the process opens the space while a restore in place runs, and it opens after", async () => {
    const { folder, backup } = await spaceWithBackup(2, 1);
    const w1 = await worker();
    const w2 = await worker();
    const hold = await blocked(w1, folders.make());
    // The restore claims the space, then waits in w1's queue.
    const queued = sent(w1, "restoreInPlace");
    const restoring = w1.restoreInPlace(backup.file, folder, { machineId: TEST_MACHINE });
    await queued;
    expect((await rejection(w2.openSpaceWriter(folder, { machine: FIXTURE_MACHINE }))).code).toBe(
      "SPACE_WRITER_TAKEN",
    );
    await hold.release();
    const restored = await restoring;
    expect(restored.space.lastSeq).toBe(3);
    const writer = await w2.openSpaceWriter(folder, { machine: FIXTURE_MACHINE });
    expect(writer.spaceId).toBe(restored.space.spaceId);
    await writer.close();
  });
});

describe("[A1.5.restore.claim] restore in place claims the copy", () => {
  test("a restore-claim gets a new epoch and a new incarnation, and the old folder is kept", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup(3, 2);
    const live = await readFacts(folder);
    const oldTree = treeDigest(folder);
    const at = Date.UTC(2026, 10, 13, 12, 0, 0, 5);
    const restored = await restoreInPlace(checked, backup.file, folder, {
      machineId: OTHER_MACHINE,
      now: () => at,
    });
    // The old folder moved aside, byte for byte, apart from its backups, which moved along.
    expect(restored.replaced).toBe(join(dirname(folder), "mira.replaced-20261113T120000.005Z"));
    expect(restored.backupsCarried).toBe(true);
    const keptTree = treeDigest(restored.replaced);
    for (const [file, hash] of Object.entries(oldTree)) {
      if (!file.startsWith("backups/")) expect(keptTree[file], file).toBe(hash);
    }
    expect(Object.keys(keptTree).some((f) => f.startsWith("backups/"))).toBe(false);
    expect(listBackups(join(folder, "backups")).backups.map((b) => b.name)).toEqual([backup.name]);

    // The claim: a new incarnation, an epoch above every known one, a lineage entry, a commit.
    const { claim } = restored;
    expect(claim.incarnation).not.toBe(backup.sidecar.incarnation);
    expect(claim.epoch).toBe(2);
    expect(claim.seq).toBe(4);
    expect(claim.parent).toEqual({ incarnation: backup.sidecar.incarnation, through_seq: 3 });
    const facts = await readFacts(folder);
    expect(facts.space.authority).toEqual({
      machineId: OTHER_MACHINE,
      epoch: 2,
      incarnation: claim.incarnation,
      sinceSeq: 4,
    });
    expect(facts.space.lastSeq).toBe(4);
    expect(facts.counts["commits"]).toBe(4);
    const opened = openSpace(checked, folder, { role: "writer" });
    expect(opened.manifestRebuilt).toBe(false);
    const commit = opened.conn.prepare("SELECT * FROM commits WHERE seq = 4").get() ?? {};
    // The writer's own system commit (write/writer.ts writeSystemCommit), in the one ops format.
    expect(commit).toMatchObject({
      kind: "ops",
      origin: "system",
      actor_kind: "system",
      scope_id: "system",
      request_id: `claim-${claim.incarnation.slice(3)}`,
      epoch: 2,
      incarnation: claim.incarnation,
      machine_id: OTHER_MACHINE,
    });
    expect(JSON.parse(String(commit["ops"]))).toEqual([
      {
        v: 1,
        op: "space.claim",
        target: backup.sidecar.space_id,
        input: {
          kind: "restore_claim",
          epoch: 2,
          incarnation: claim.incarnation,
          parent: claim.parent,
          // The live space had given references up to 4 since the backup: the counter goes on
          // from there, never back to the backup's 3.
          next_ref: 5,
        },
      },
    ]);
    expect(facts.space.nextRef).toBe(5);
    expect(live.space.nextRef).toBe(5);
    // The commit's time never goes below the previous commit's (A1 3.9), and the lineage says so.
    expect(commit["at"]).toBeGreaterThanOrEqual(at);
    expect(facts.space.lineage.incarnations.at(-1)).toEqual({
      incarnation: claim.incarnation,
      epoch: 2,
      kind: "restore_claim",
      parent: { incarnation: live.space.authority.incarnation, through_seq: 3 },
      machine_id: OTHER_MACHINE,
      at: commit["at"],
    });
    opened.conn.close();
    const manifest = readManifest(folder);
    expect(manifest.state === "present" && manifest.manifest?.authority.incarnation).toBe(
      claim.incarnation,
    );
  });

  test("two claims of one backup make two incarnations, each epoch above every known one", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup(2, 0);
    const first = await restoreInPlace(checked, backup.file, folder, {
      machineId: TEST_MACHINE,
      now: () => Date.UTC(2026, 10, 13, 12, 0, 0, 1),
    });
    // The backup sits in the carried backups folder: restore it again in place.
    const again = join(folder, "backups", basename(backup.file));
    const second = await restoreInPlace(checked, again, folder, {
      machineId: TEST_MACHINE,
      now: () => Date.UTC(2026, 10, 13, 12, 0, 0, 2),
      knownEpochs: [7],
    });
    expect(second.claim.incarnation).not.toBe(first.claim.incarnation);
    // Above the replaced space's epoch 2 and the known epoch 7.
    expect(second.claim.epoch).toBe(8);
    expect(second.claim.parent.incarnation).toBe(backup.sidecar.incarnation);
    expect(readdirSync(dirname(folder)).sort()).toEqual([
      "mira",
      "mira.replaced-20261113T120000.001Z",
      "mira.replaced-20261113T120000.002Z",
    ]);
  });

  test("a backup of another space is refused, and the live space stays as it was", async () => {
    const checked = await checkedDriver();
    const { folder } = await spaceWithBackup(1, 0);
    const other = await spaceWithBackup(1, 0);
    const before = treeDigest(dirname(folder));
    await expectCode(
      () => restoreInPlace(checked, other.backup.file, folder, { machineId: TEST_MACHINE }),
      "SPACE_ID_MISMATCH",
    );
    expectSameTree(treeDigest(dirname(folder)), before);
  });

  test("a live space that no longer opens is replaced too: that is what the restore is for", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup(2, 1);
    writeFileSync(join(folder, DATABASE_FILE), "not a database any more");
    const restored = await restoreInPlace(checked, backup.file, folder, {
      machineId: TEST_MACHINE,
    });
    // The broken space's epochs come from its space.json: the claim is above them.
    expect(restored.claim.epoch).toBe(2);
    openSpace(checked, folder, { role: "writer" }).conn.close();
    expect(readFileSync(join(restored.replaced, DATABASE_FILE), "utf8")).toBe(
      "not a database any more",
    );
  });
});

describe("[A1.5.restore.crash-windows] a crash at each point of a restore in place", () => {
  test("leaves the old space, the claimed new one, or a missing one that resume completes", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup(2, 3);
    const old = await readFacts(folder);
    const crashes = new Map<RestorePoint, string>();
    const restored = await restoreInPlaceWith(
      checked,
      backup.file,
      folder,
      { machineId: TEST_MACHINE },
      {
        at: (point) => {
          // What a crash now leaves: the whole parent folder as it is on disk.
          const copy = join(folders.make(), "spaces");
          copyTree(dirname(folder), copy);
          crashes.set(point, join(copy, "mira"));
        },
      },
    );
    const points: (RestorePoint | SwapPoint)[] = [
      "unpacked",
      "claimed",
      "moved-aside",
      "moved-into-place",
      "backups-carried",
    ];
    expect([...crashes.keys()]).toEqual(points);
    for (const [point, copy] of crashes) {
      const before = ["unpacked", "claimed"].includes(point);
      if (point === "moved-aside") {
        // No space under its name: clearly refused, never a wrong space.
        await expectCode(() => openSpace(checked, copy, { role: "reader" }), "SPACE_NOT_FOUND");
      }
      const report = finishInterruptedRestore(copy);
      expect(report.completed !== undefined, point).toBe(point === "moved-aside");
      const facts = await readFacts(copy);
      if (before) {
        // The old space, untouched; the staging folder is a leftover that names itself.
        expect(facts.space.authority.incarnation, point).toBe(old.space.authority.incarnation);
        expect(facts.space.lastSeq, point).toBe(5);
        expect(
          readdirSync(dirname(copy)).some((n) => n.startsWith(".mira.restoring-")),
          point,
        ).toBe(true);
      } else {
        // The claimed new space, never the unclaimed backup.
        expect(facts.space.authority.incarnation, point).toBe(restored.claim.incarnation);
        expect(facts.space.lastSeq, point).toBe(3);
        expect(listBackups(join(copy, "backups")).backups.length, point).toBe(1);
      }
      openSpace(checked, copy, { role: "writer" }).conn.close();
      // Resume is idempotent.
      expect(finishInterruptedRestore(copy)).toEqual({ completed: undefined, backupsCarried: [] });
    }
  });

  test("a failure before the swap removes the staging folder and leaves the live space", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup(1, 1);
    const before = treeDigest(dirname(folder));
    for (const point of ["unpacked", "claimed"] as const) {
      await expect(
        restoreInPlaceWith(
          checked,
          backup.file,
          folder,
          { machineId: TEST_MACHINE },
          {
            at: (p) => {
              if (p === point) throw new Error("a stand-in fault");
            },
          },
        ),
      ).rejects.toThrow("a stand-in fault");
      expectSameTree(treeDigest(dirname(folder)), before);
    }
  });
});

/** Leaves `db` as a crash in the middle of another tool's rollback-journal transaction does. */
async function crashWithHotJournal(db: string): Promise<void> {
  const checked = await checkedDriver();
  const source = join(folders.make(), "source.db");
  copyFileSync(db, source);
  const conn = checked.driver.open(source, { readOnly: false, busyTimeoutMs: 5000 });
  try {
    conn.pragma("journal_mode", "DELETE");
    conn.pragma("cache_size", 5);
    conn.exec("BEGIN IMMEDIATE");
    conn.exec(
      "CREATE TABLE crash_pad (v BLOB); WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL " +
        "SELECT i + 1 FROM n WHERE i < 200) INSERT INTO crash_pad SELECT zeroblob(8192) FROM n",
    );
    copyFileSync(source, db);
    copyFileSync(`${source}-journal`, `${db}-journal`);
  } finally {
    conn.close();
  }
  expect(readFileSync(`${db}-journal`)[0]).toBe(0xd9);
}

describe("[A1.5.restore.recovery] recovering a space with a rollback journal", () => {
  test("a hot journal is played back into a copy, which replaces the space; the original is kept", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3);
    const before = await readFacts(folder);
    const db = join(folder, DATABASE_FILE);
    await crashWithHotJournal(db);
    const crashed = treeDigest(folder);
    await expectCode(() => openSpace(checked, folder, { role: "writer" }), "SPACE_NEEDS_RECOVERY");

    const recovered = recoverSpace(checked, folder, { now: () => Date.UTC(2026, 10, 13, 1) });
    expect(recovered.space.lastSeq).toBe(3);
    // The original files, journal included, are kept as they were.
    expect(treeDigest(recovered.replaced)).toEqual(crashed);
    expect(readdirSync(folder).sort()).toEqual([DATABASE_FILE, MANIFEST_FILE]);
    const facts = await readFacts(folder);
    // The half-written transaction is gone: the space is at its last committed state.
    expect(facts.counts).toEqual(before.counts);
    expect(facts.space.authority).toEqual(before.space.authority);
    const opened = openSpace(checked, folder, { role: "writer" });
    expect(opened.conn.pragma("journal_mode")).toBe("wal");
    opened.conn.close();
  });

  test("an empty or stray journal: the space recovers unchanged", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const before = await readFacts(folder);
    writeFileSync(join(folder, `${DATABASE_FILE}-journal`), "");
    await expectCode(() => openSpace(checked, folder, { role: "reader" }), "SPACE_NEEDS_RECOVERY");
    recoverSpace(checked, folder);
    expect((await readFacts(folder)).counts).toEqual(before.counts);
    openSpace(checked, folder, { role: "writer" }).conn.close();
  });

  test("a copy that does not verify changes nothing; a restore from a backup still works", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup(2, 0);
    // Another application's database with a journal, in the space's place.
    const db = join(folder, DATABASE_FILE);
    rmSync(db);
    const foreign = checked.driver.open(db, { readOnly: false, busyTimeoutMs: 5000, create: true });
    foreign.exec("CREATE TABLE foreign_table (v INTEGER)");
    foreign.close();
    writeFileSync(`${db}-journal`, "");
    const before = treeDigest(dirname(folder));
    await expectCode(() => recoverSpace(checked, folder), "SPACE_INVALID");
    // Recovery reads the live files only to copy them: nothing changes, not even a -shm.
    expect(treeDigest(dirname(folder))).toEqual(before);
    // The way out: the newest backup, in place.
    const restored = await restoreInPlace(checked, backup.file, folder, {
      machineId: TEST_MACHINE,
    });
    expect(restored.space.lastSeq).toBe(3);
    openSpace(checked, folder, { role: "writer" }).conn.close();
    expect(existsSync(join(restored.replaced, `${DATABASE_FILE}-journal`))).toBe(true);
  });

  test("recovery refuses what open refuses this build's writer, and then nothing moves", async () => {
    const checked = await checkedDriver();
    // A space.json whose min_writer is above this build: open refuses the writer.
    const gated = (await createFixtureSpace(folders.make())).folder;
    const manifestFile = join(gated, MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, min_writer: "999.0.0" }));
    // A space row whose format does not match its schema revision.
    const misformatted = (await createFixtureSpace(folders.make())).folder;
    const conn = await rawWriter(misformatted);
    conn.exec("UPDATE space SET format_minor = 9");
    conn.close();
    // A damaged space.json: open refuses the writer, and repairing it is the person's call.
    const damaged = (await createFixtureSpace(folders.make())).folder;
    writeFileSync(join(damaged, MANIFEST_FILE), "{ not a manifest");
    for (const [folder, code] of [
      [gated, "SPACE_TOO_NEW"],
      [misformatted, "SPACE_INVALID"],
      [damaged, "SPACE_MANIFEST_DAMAGED"],
    ] as const) {
      writeFileSync(join(folder, `${DATABASE_FILE}-journal`), "");
      const before = treeDigest(dirname(folder));
      await expectCode(() => recoverSpace(checked, folder), code);
      // Nothing moved, nothing was left beside it, and the live files are as they were.
      expect(treeDigest(dirname(folder)), code).toEqual(before);
      expect(readdirSync(dirname(folder)), code).toEqual([basename(folder)]);
    }
    // The gate is still in force afterwards: the writer is still refused.
    rmSync(join(gated, `${DATABASE_FILE}-journal`));
    await expectCode(() => openSpace(checked, gated, { role: "writer" }), "SPACE_TOO_NEW");
  });

  test("an older revision recovers as it is; its migration waits for the writer's open", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    writeFileSync(join(folder, `${DATABASE_FILE}-journal`), "");
    const recovered = recoverSpaceWith(checked, folder, {}, { steps: STEPS_0_7 });
    expect(recovered.revision).toEqual({ major: 0, minor: 6 });
    expect((await readFacts(folder)).userVersion).toBe(6);
    const reader = openSpaceWith(checked, folder, { role: "reader" }, { steps: STEPS_0_7 });
    expect(reader.readOnlyReasons).toEqual(["older_revision"]);
    reader.conn.close();
  });

  test("recovery refuses a space without a journal, and a crash mid-swap resumes", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await expectCode(() => recoverSpace(checked, folder), "STORAGE_MISUSE");
    writeFileSync(join(folder, `${DATABASE_FILE}-journal`), "");
    let copy = "";
    recoverSpaceWith(
      checked,
      folder,
      {},
      {
        at: (point) => {
          if (point !== "moved-aside") return;
          const parent = join(folders.make(), "spaces");
          copyTree(dirname(folder), parent);
          copy = join(parent, "mira");
        },
      },
    );
    expect(existsSync(copy)).toBe(false);
    expect(finishInterruptedRestore(copy).completed).toBeDefined();
    openSpace(checked, copy, { role: "writer" }).conn.close();
  });
});

describe("[A1.5.space.lineage-bound] the lineage against space.json's 64 KiB", () => {
  test("space.json holds the newest entries that fit; the database keeps them all", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    // 1,000 claims' worth of lineage, written straight into the database.
    const entries: LineageEntry[] = [...space.lineage.incarnations];
    for (let epoch = 2; epoch <= 1000; epoch += 1) {
      const previous = entries.at(-1);
      if (previous === undefined) throw new Error("no lineage");
      entries.push({
        incarnation: newId("ai"),
        epoch,
        kind: "restore_claim",
        parent: { incarnation: previous.incarnation, through_seq: 0 },
        machine_id: TEST_MACHINE,
        at: 1_762_800_000_000 + epoch,
      });
    }
    const last = entries.at(-1);
    if (last === undefined) throw new Error("no lineage");
    const conn = await rawWriter(folder);
    conn
      .prepare(
        "UPDATE space SET lineage = $lineage, authority_epoch = 1000, authority_incarnation = $i",
      )
      .run({
        lineage: JSON.stringify({ forked_from: null, incarnations: entries }),
        i: last.incarnation,
      });
    conn.close();
    rmSync(join(folder, MANIFEST_FILE));

    const writer = openSpace(checked, folder, { role: "writer" });
    expect(writer.manifestRebuilt).toBe(true);
    writer.conn.close();
    const text = readFileSync(join(folder, MANIFEST_FILE));
    expect(text.length).toBeLessThanOrEqual(MANIFEST_MAX_BYTES);
    const read = readManifest(folder);
    if (read.state !== "present" || read.manifest === undefined) throw new Error("damaged");
    expect(read.damaged).toBe(false);
    const kept = read.manifest.lineage.incarnations;
    expect(kept.length).toBeGreaterThan(150);
    expect(kept.length).toBeLessThan(1000);
    expect(kept).toEqual(entries.slice(-kept.length));
    expect(read.manifest.authority.incarnation).toBe(last.incarnation);
    // The same database gives the same file: the next writer does not rewrite it.
    const again = openSpace(checked, folder, { role: "writer" });
    expect(again.manifestRebuilt).toBe(false);
    again.conn.close();
    expect((await readFacts(folder)).space.lineage.incarnations).toHaveLength(1000);

    // One more claim at the bound: restore in place still works, and the file stays bounded.
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    const restored = await restoreInPlace(checked, backup.file, folder, {
      machineId: TEST_MACHINE,
    });
    expect(restored.claim.epoch).toBe(1001);
    expect(readFileSync(join(folder, MANIFEST_FILE)).length).toBeLessThanOrEqual(
      MANIFEST_MAX_BYTES,
    );
    const after = readManifest(folder);
    expect(after.state === "present" && after.manifest?.lineage.incarnations.at(-1)?.epoch).toBe(
      1001,
    );
    expect((await readFacts(folder)).space.lineage.incarnations).toHaveLength(1001);
  });
});
