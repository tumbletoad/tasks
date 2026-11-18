// The start-up sequence for spaces (A2 3.1, M1.08): an
// interrupted restore finished before the open, the writer's migration, the read-only states, the
// backup upkeep, and a restore in place and a claim through the space manager. Services run in
// this process on temporary homes; fixture spaces only.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  backupSpace,
  backupsFolder,
  createSpace,
  encodeRevision,
  listBackups,
  newId,
  restoreBackup,
  StorageWorker,
  type Id,
  type LockedFile,
} from "@tasks/storage";
import { createSpaceAt, STEPS_0_1 } from "@tasks/storage/revisions";
import { checkedDriver } from "@tasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { workerWithSteps } from "../../storage/test/worker-helpers.ts";
import { startService, type RunningService, type StartOptions } from "../src/hub/service.ts";
import { readSpaceSettings } from "../src/hub/space-settings.ts";
import {
  READY_MS,
  readLog,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
  within,
} from "./harness.ts";

const running: RunningService[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A temporary root, a home whose machine.json names `machine`, and a folder for spaces. */
function setUp(label: string, machine: Id<"m">): { root: string; home: string; spaces: string } {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  const home = join(root, "h");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: machine,
      name: "fixture-machine",
      created_at: "2026-11-13T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  const spaces = join(root, "spaces");
  mkdirSync(spaces);
  return { root, home, spaces };
}

async function fixtureSpace(folder: string, machine: Id<"m">) {
  return createSpace(await checkedDriver(), folder, {
    name: "Work",
    ownerLabel: "Mira Okafor",
    machineId: machine,
  });
}

/** A space as a released 0.1 build created it, which this build migrates when it opens it. */
async function fixtureSpaceAt01(folder: string, machine: Id<"m">) {
  return createSpaceAt(
    await checkedDriver(),
    folder,
    { name: "Work", ownerLabel: "Mira Okafor", machineId: machine },
    STEPS_0_1,
  );
}

async function start(
  home: string,
  folders: Parameters<typeof registerSpaces>[1],
  extra: Partial<StartOptions> = {},
): Promise<RunningService> {
  registerSpaces(home, folders);
  const service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    say: () => undefined,
    ...extra,
  });
  running.push(service);
  await service.spacesSettled;
  return service;
}

const events = (home: string, ev: string) => readLog(home).filter((e) => e["ev"] === ev);

/**
 * Writes this machine's settings for a space, as a later step would (space-settings.ts): its folder
 * 0700 and the file 0600, as the product makes them, whatever the umask (A2 3.2.2 rule 5).
 */
function writeSettings(home: string, spaceId: Id<"sp">, value: object): void {
  mkdirSync(join(stateOf(home), "spaces"), { recursive: true, mode: 0o700 });
  writeFileSync(join(stateOf(home), "spaces", `${spaceId}.json`), JSON.stringify(value), {
    mode: 0o600,
  });
}

describe("[A2.3.1.hub.startup] the start-up sequence for spaces (A2 3.1)", () => {
  test("an older revision is migrated by the writer's open behind its barrier backup; a failed migration is read_only(migration_failed) at its revision", async () => {
    const machine = newId("m");
    const { home, spaces } = setUp("mig", machine);
    const ok = await fixtureSpaceAt01(join(spaces, "ok"), machine);
    const bad = await fixtureSpaceAt01(join(spaces, "bad"), machine);

    // This build's real 0.2 to 0.5: the open migrates the 0.1 space.
    const migrating = await start(home, [ok.folder], { maintenance: false });
    expect(migrating.spaces()).toEqual([{ entry: 0, state: "open", id: ok.space.spaceId }]);
    expect(events(home, "space.migrated")).toEqual([
      expect.objectContaining({
        entry: 0,
        space: ok.space.spaceId,
        from: encodeRevision({ major: 0, minor: 1 }),
        to: encodeRevision({ major: 0, minor: 5 }),
        steps: 4,
      }),
    ]);
    expect(events(home, "space.open")).toEqual([expect.objectContaining({ migrated: true })]);
    const barrier = listBackups(backupsFolder(ok.folder)).backups;
    expect(barrier.map((b) => [b.sidecar?.kind, b.state])).toEqual([["pre-migrate", "ok"]]);
    await migrating.stop();

    // A build whose migration fails midway, after the real steps ran in the same transaction: the
    // space stays at its revision, read-only, with A1 3.17's message and how it is
    // tried again, which status shows and the log never holds.
    const failing = await start(home, [bad.folder], {
      spaceOptions: { startWorker: () => workerWithSteps("midway") },
      maintenance: false,
    });
    const [view] = failing.spaces();
    const backup = listBackups(backupsFolder(bad.folder)).backups[0];
    expect(backup?.sidecar).toMatchObject({ kind: "pre-migrate", user_version: 1 });
    expect(view).toEqual({
      entry: 0,
      state: "read_only",
      reason: "migration_failed",
      code: "MIGRATION_FAILED",
      message:
        "Migration to 0.6 failed (STORAGE_SQL). Your data is unchanged. The space stays at 0.1. " +
        `Backup: ${backup?.name ?? "?"}. It is tried again after an update, or now with: ` +
        "tasks space open <folder> --retry-migration",
      id: bad.space.spaceId,
    });
    expect(JSON.stringify(readLog(home))).not.toContain("Your data is unchanged");
    await failing.stop();
    // The service held no writer.lock for it, and the data is as it was: the 0.1 build opens it.
    const worker = await workerWithSteps("0.1");
    try {
      const writer = await worker.openSpaceWriter(bad.folder, {
        machine: { id: machine, name: "fixture-machine", os: "linux" },
      });
      expect(writer.revision).toEqual({ major: 0, minor: 1 });
      await writer.close();
    } finally {
      await worker.close();
    }
  }, 120_000);

  test("a backup restored into a new folder is read_only(read_only_copy) until claimed, and the claim goes above every epoch this machine has seen", async () => {
    const machine = newId("m");
    const { home, spaces } = setUp("copy", machine);
    const original = await fixtureSpace(join(spaces, "work"), machine);
    const checked = await checkedDriver();
    const backup = await backupSpace(checked, original.folder, { kind: "manual" });
    const copy = join(spaces, "copy");
    await restoreBackup(checked, backup.file, copy);
    // This machine has seen the space at epoch 7.
    writeSettings(home, original.space.spaceId, {
      format: 1,
      seen: { epoch: 7, incarnation: newId("ai") },
    });

    const service = await start(home, [copy], { maintenance: false });
    expect(service.spaces()).toMatchObject([
      {
        entry: 0,
        state: "read_only",
        reason: "read_only_copy",
        code: "SPACE_READ_ONLY_COPY",
        id: original.space.spaceId,
        message: expect.stringContaining("space claim <folder>") as unknown,
      },
    ]);
    const change = await service.spaceManager.claim(0);
    expect(change.epoch).toBe(8);
    expect(service.spaces()).toEqual([{ entry: 0, state: "open", id: original.space.spaceId }]);
    expect(readSpaceSettings(stateOf(home), original.space.spaceId).seen).toEqual(change);
    // Only a read-only copy is claimed.
    await expect(service.spaceManager.claim(0)).rejects.toMatchObject({ code: "STORAGE_MISUSE" });
  }, 120_000);

  test("a space whose authority is another machine is read_only(not_authority), never open", async () => {
    const { home, spaces } = setUp("auth", newId("m"));
    const other = await fixtureSpace(join(spaces, "theirs"), newId("m"));
    const service = await start(home, [other.folder], { maintenance: false });
    expect(service.spaces()).toMatchObject([
      {
        entry: 0,
        state: "read_only",
        reason: "not_authority",
        id: other.space.spaceId,
        message: expect.stringContaining("Another machine owns this space") as unknown,
      },
    ]);
    expect(events(home, "space.read_only")).toEqual([
      expect.objectContaining({ entry: 0, reason: "not_authority" }),
    ]);
    // No backups are taken of another machine's space, and no epoch is recorded for it.
    expect(existsSync(backupsFolder(other.folder))).toBe(false);
    expect(readSpaceSettings(stateOf(home), other.space.spaceId).seen).toBeUndefined();
  }, 120_000);

  test("a restore in place that a crash interrupted between its two renames is finished before the space opens", async () => {
    const machine = newId("m");
    const { home, spaces } = setUp("swap", machine);
    const space = await fixtureSpace(join(spaces, "work"), machine);
    const stamp = "20261113T080000.000Z";
    // What the crash left: the live folder moved aside, the complete new one not yet in place.
    cpSync(space.folder, join(spaces, `.work.restoring-${stamp}`), { recursive: true });
    renameSync(space.folder, join(spaces, `work.replaced-${stamp}`));
    expect(existsSync(space.folder)).toBe(false);

    // Registered by its ID: the folder is not there to read it from.
    const service = await start(home, [{ path: space.folder, id: space.space.spaceId }], {
      maintenance: false,
    });
    expect(service.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
    expect(events(home, "space.restore_finished")).toEqual([
      expect.objectContaining({ entry: 0, swapped: true }),
    ]);
    expect(readdirSync(spaces).sort()).toEqual(["work", `work.replaced-${stamp}`]);
  }, 120_000);

  test("an open space's upkeep: old leftovers in its own backups folder go, the daily backup is taken, retention runs; a machine-local backup.dir is used and never cleaned", async () => {
    const machine = newId("m");
    const { root, home, spaces } = setUp("keep", machine);
    const own = await fixtureSpace(join(spaces, "own"), machine);
    const elsewhere = await fixtureSpace(join(spaces, "elsewhere"), machine);
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    const leftover = (dir: string, tag: string, age: number): string => {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `.backup.tmp-${tag}.db`);
      writeFileSync(path, "partial");
      utimesSync(path, hoursAgo(age), hoursAgo(age));
      return path;
    };
    const oldOwn = leftover(backupsFolder(own.folder), "0123456789abcdef", 2);
    const freshOwn = leftover(backupsFolder(own.folder), "fedcba9876543210", 0);
    // The second space keeps its backups in a machine-local folder, shared or not: never cleaned.
    const shared = join(root, "shared-backups");
    const oldShared = leftover(shared, "00112233445566aa", 2);
    writeSettings(home, elsewhere.space.spaceId, { format: 1, backup: { dir: shared } });

    await start(home, [own.folder, elsewhere.folder]);
    const maintained = await waitFor(
      () => {
        const done = events(home, "space.maintained");
        return done.length === 2 ? done : undefined;
      },
      READY_MS,
      "both spaces' upkeep",
    );
    for (const entry of [0, 1]) {
      expect(maintained.find((e) => e["entry"] === entry)).toMatchObject({
        backup: "taken",
        removed: 0,
        unverified: 0,
      });
    }
    expect(maintained.find((e) => e["entry"] === 0)).toMatchObject({ leftovers: 1 });
    expect(maintained.find((e) => e["entry"] === 1)).toMatchObject({ leftovers: 0 });
    expect(existsSync(oldOwn)).toBe(false);
    expect(existsSync(freshOwn)).toBe(true);
    expect(existsSync(oldShared)).toBe(true);
    const daily = (dir: string) =>
      listBackups(dir).backups.filter((b) => b.sidecar?.kind === "daily" && b.state === "ok");
    expect(daily(backupsFolder(own.folder))).toHaveLength(1);
    expect(daily(shared).map((b) => b.sidecar?.space_id)).toEqual([elsewhere.space.spaceId]);
    expect(existsSync(backupsFolder(elsewhere.folder))).toBe(false);
  }, 120_000);

  test("a restore in place through the space manager closes the space, goes above the epochs this machine has seen, and opens it again", async () => {
    const machine = newId("m");
    const { home, spaces } = setUp("rip", machine);
    const space = await fixtureSpace(join(spaces, "work"), machine);
    const backup = await backupSpace(await checkedDriver(), space.folder, { kind: "manual" });
    const service = await start(home, [space.folder], { maintenance: false });
    expect(service.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
    const seen = readSpaceSettings(stateOf(home), space.space.spaceId).seen;
    expect(seen?.epoch).toBe(space.space.authority.epoch);

    const change = await service.spaceManager.restoreInPlace(0, backup.file);
    expect(change.epoch).toBeGreaterThan(seen?.epoch ?? Number.POSITIVE_INFINITY);
    expect(service.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
    expect(readSpaceSettings(stateOf(home), space.space.spaceId).seen).toEqual(change);
    expect(readdirSync(spaces).filter((n) => n.startsWith("work.replaced-"))).toHaveLength(1);
    expect(events(home, "space.closed")).toHaveLength(1);
    expect(events(home, "space.open")).toHaveLength(2);
  }, 120_000);

  test("an open that runs past its bound keeps watching its writer.lock: a loss then still ends the service with 70", async () => {
    const { home, spaces } = setUp("slowopen", newId("m"));
    const folder = join(spaces, "work");
    mkdirSync(folder);
    const lockPath = join(folder, "writer.lock");
    writeFileSync(lockPath, "");
    const identity = statSync(lockPath, { bigint: true });
    let locked = false;
    // A worker that takes the lock, then migrates for ever and never closes.
    const hung = {
      openSpaceWriter: (_folder: string, options: { onLock?: (lock: LockedFile) => void }) => {
        options.onLock?.({ path: lockPath, dev: identity.dev, ino: identity.ino });
        locked = true;
        return new Promise(() => undefined);
      },
      close: () => new Promise(() => undefined),
    } as unknown as StorageWorker;
    const service = await start(home, [folder], {
      maintenance: false,
      spaceOptions: {
        startWorker: () => Promise.resolve(hung),
        openTimeoutMs: 200,
        closeTimeoutMs: 200,
      },
    });
    expect(locked).toBe(true);
    expect(service.spaces()).toMatchObject([
      { entry: 0, state: "unavailable", reason: "open_failed", code: "ETIMEDOUT" },
    ]);
    // A later close of the space has no worker of its own to close: the hung one keeps its watch.
    await service.spaceManager.close(0);
    // The worker may still write under the lock: losing the file still ends the service.
    rmSync(lockPath);
    expect(await within(service.exited, 20_000, "the exit")).toBe(70);
    expect(events(home, "space.ownership_lost")).toEqual([
      expect.objectContaining({ entry: 0, what: "missing" }),
    ]);
  }, 120_000);

  test("a lock reported after the open's bound is watched until its worker closes, and not after", async () => {
    const { home, spaces } = setUp("latelock", newId("m"));
    const folder = join(spaces, "work");
    mkdirSync(folder);
    const lockPath = join(folder, "writer.lock");
    writeFileSync(lockPath, "");
    const identity = statSync(lockPath, { bigint: true });
    let reported = false;
    // A worker whose lock arrives after the open timed out, while its close is under way.
    const late = {
      openSpaceWriter: (_folder: string, options: { onLock?: (lock: LockedFile) => void }) => {
        setTimeout(() => {
          options.onLock?.({ path: lockPath, dev: identity.dev, ino: identity.ino });
          reported = true;
        }, 300);
        return new Promise(() => undefined);
      },
      close: () => new Promise<void>((resolve) => setTimeout(resolve, 600)),
    } as unknown as StorageWorker;
    const service = await start(home, [folder], {
      maintenance: false,
      spaceOptions: {
        startWorker: () => Promise.resolve(late),
        openTimeoutMs: 100,
        closeTimeoutMs: 5_000,
      },
    });
    await waitFor(
      () => (service.spaces()[0]?.state === "unavailable" && reported ? true : undefined),
      10_000,
      "the open's end and the late lock",
    );
    // The worker has closed, and its lock with it: the file is no longer the service's.
    await new Promise((resolve) => setTimeout(resolve, 600));
    rmSync(lockPath);
    let ended = false;
    void service.exited.then(() => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ended).toBe(false);
    expect(events(home, "space.ownership_lost")).toEqual([]);
  }, 120_000);

  test("the drain waits for a restore in place in progress, and does not open the space again", async () => {
    const machine = newId("m");
    const { home, spaces } = setUp("drainrip", machine);
    const space = await fixtureSpace(join(spaces, "work"), machine);
    let finish: () => void = () => undefined;
    const restoring = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let asked = 0;
    // The open gets a real worker; the restore one whose restore ends when the test says so.
    const restoreWorker = {
      restoreInPlace: async () => {
        asked += 1;
        await restoring;
        return {
          space: { spaceId: space.space.spaceId },
          claim: { epoch: 5, incarnation: newId("ai") },
        };
      },
      close: () => Promise.resolve(),
    } as unknown as StorageWorker;
    let started = 0;
    const service = await start(home, [space.folder], {
      maintenance: false,
      spaceOptions: {
        startWorker: () => {
          started += 1;
          return started === 1
            ? StorageWorker.start({ driver: "node:sqlite" })
            : Promise.resolve(restoreWorker);
        },
      },
    });
    const change = service.spaceManager.restoreInPlace(0, join(spaces, "backup.db.gz"));
    await waitFor(() => (asked > 0 ? true : undefined), 10_000, "the restore runs");
    let stopped = false;
    const stopping = service.stop().then((code) => {
      stopped = true;
      return code;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stopped).toBe(false);
    finish();
    expect(await change).toMatchObject({ epoch: 5 });
    expect(await stopping).toBe(0);
    expect(service.spaces()).toEqual([{ entry: 0, state: "closed", id: space.space.spaceId }]);
    expect(started).toBe(2);
  }, 120_000);

  test("a space whose open has not ended is not restored or claimed: its worker may still hold it", async () => {
    const machine = newId("m");
    const { home, spaces } = setUp("busy", machine);
    const space = await fixtureSpace(join(spaces, "work"), machine);
    const backup = await backupSpace(await checkedDriver(), space.folder, { kind: "manual" });
    // A worker that never starts: the open waits for it past the close's bound.
    registerSpaces(home, [space.folder]);
    const service = await startService({
      env: serviceEnv(home),
      identity: () => ({ root: false, elevated: false, package: null }),
      say: () => undefined,
      maintenance: false,
      spaceOptions: { startWorker: () => new Promise(() => undefined), closeTimeoutMs: 200 },
    });
    running.push(service);
    await expect(service.spaceManager.restoreInPlace(0, backup.file)).rejects.toMatchObject({
      code: "SPACE_WRITER_TAKEN",
    });
    expect(readdirSync(spaces)).toEqual(["work"]);
  }, 120_000);
});
