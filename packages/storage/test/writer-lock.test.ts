// One writer per space across processes (A2 3.4): writer.lock and writer.json, taken by every
// StorageWorker route that opens a space for writing and held for the writer's life. The second
// process is a real child (lock-holder.ts); each test records the PIDs it starts and stops them.
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { backupSpace, type BackupRecord } from "../src/backup/backup.ts";
import type { Connection } from "../src/driver.ts";
import { StorageError } from "../src/errors.ts";
import { DATABASE_FILE, MANIFEST_FILE } from "../src/manifest.ts";
import { finishInterruptedRestore, REJECTED_MARK } from "../src/restore/folders.ts";
import { restoreBackup, restoreInPlaceWith } from "../src/restore/restore.ts";
import { openSpace } from "../src/space.ts";
import type { CheckedDriver } from "../src/startup-check.ts";
import { StorageWorker } from "../src/worker/client.ts";
import { SpaceWriter } from "../src/write/writer.ts";
import {
  fileIdentity,
  readWriterHolder,
  SpaceLockedElsewhere,
  swapGuard,
  takeWriterLock,
  WRITER_HOLDER_FILE,
  WRITER_LOCK_FILE,
} from "../src/writer-lock.ts";
import { backupsBeside, readFacts, writeCommits } from "./backup-helpers.ts";
import { createRequest, FIXTURE_MACHINE, ownerCredential } from "./fixture-requests.ts";
import { checkedDriver, createFixtureSpace, TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import { rejection } from "./worker-helpers.ts";

const HOLDER_SCRIPT = fileURLToPath(new URL("./lock-holder.ts", import.meta.url));
const folders = tempFolders("wlock");
const workers: StorageWorker[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
  await Promise.all(children.splice(0).map((child) => stopChild(child)));
  folders.cleanup();
});

async function worker(): Promise<StorageWorker> {
  const started = await StorageWorker.start({ driver: "node:sqlite" });
  workers.push(started);
  return started;
}

interface Holder {
  readonly child: ChildProcess;
  readonly pid: number;
  /** The child's first line: whether it holds what it was asked to. */
  readonly ready: { ready: boolean; code?: string };
  /** Asks it to close what it holds, and waits for its exit. */
  close(): Promise<void>;
}

/** A hard kill of a child this file started, and the wait for its exit. */
function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGKILL");
  });
}

/** Starts lock-holder.ts in a child process and waits for its first line. */
async function holder(mode: "writer" | "lock", target: string): Promise<Holder> {
  const child = spawn(
    process.execPath,
    [HOLDER_SCRIPT, mode, target, JSON.stringify(FIXTURE_MACHINE)],
    { stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
  );
  children.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("the child did not start");
  const lines: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  let text = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    text += chunk;
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n")) {
      const line = text.slice(0, at);
      text = text.slice(at + 1);
      if (waiting === undefined) lines.push(line);
      else waiting(line);
    }
  });
  const next = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const queued = lines.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error("the child did not answer"));
      }, 30_000);
      waiting = (line) => {
        clearTimeout(timer);
        waiting = undefined;
        resolve(line);
      };
    });
  const ready = JSON.parse(await next()) as { ready: boolean; code?: string };
  return {
    child,
    pid,
    ready,
    close: async () => {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
      child.stdin.write("close\n");
      expect(JSON.parse(await next())).toEqual({ closed: true });
      await exited;
    },
  };
}

/** A fixture space with two commits and a backup of it. */
async function spaceWithBackup(): Promise<{ folder: string; backup: BackupRecord }> {
  const { folder } = await createFixtureSpace(folders.make());
  await writeCommits(folder, 2, "a");
  // Outside the space: a restore in place moves the space's folder aside.
  const backup = await backupSpace(await checkedDriver(), folder, {
    kind: "manual",
    backupDir: folders.make(),
  });
  return { folder, backup };
}

const owner = async (folder: string) => {
  const { conn } = await (await worker()).openSpaceReader(folder);
  try {
    const row = await conn.get<{ id: string }>("SELECT id FROM actors WHERE kind = 'human'");
    return row?.id as `ac_${string}`;
  } finally {
    await conn.close();
  }
};

describe("[A1.5.writer.cross-process] a restore's swap and its writer.lock", () => {
  /** One commit through the write path, in this thread: another process's writer would do this. */
  function oneCommit(checked: CheckedDriver, folder: string, title: string): void {
    const opened = openSpace(checked, folder, { role: "writer" });
    const human = opened.conn.prepare("SELECT id FROM actors WHERE kind = 'human'").get()?.["id"];
    const writer = SpaceWriter.attach(opened, { machine: FIXTURE_MACHINE });
    try {
      writer.registerMachine();
      const result = writer.submit(
        createRequest(writer.spaceId, ownerCredential(human as `ac_${string}`), title),
      );
      expect(result.status).toBe("applied");
    } finally {
      writer.close();
    }
  }

  test("a restore whose writer.lock was lost before the swap renames nothing", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup();
    const lock = await takeWriterLock(checked.driver, folder, {});
    const before = (await readFacts(folder)).space.lastSeq;
    try {
      const lost = await rejection(
        restoreInPlaceWith(
          checked,
          backup.file,
          folder,
          { machineId: TEST_MACHINE, swap: swapGuard(lock, folder) },
          {
            at: (point) => {
              if (point !== "claimed") return;
              if (process.platform === "win32") {
                // Windows refuses to delete a held lock; another file in its place is the loss.
                lock.release();
              }
              rmSync(lock.path, { force: true });
              writeFileSync(lock.path, "");
            },
          },
        ),
      );
      expect(lost.code).toBe("SPACE_CHANGED");
    } finally {
      lock.release();
    }
    expect(readdirSync(dirname(folder))).toEqual(["mira"]);
    expect((await readFacts(folder)).space.lastSeq).toBe(before);
  }, 120_000);

  test("where the lock ends before the swap (Windows), a write in between undoes the swap and fails the restore", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup();
    const lock = await takeWriterLock(checked.driver, folder, {});
    const guard = swapGuard(lock, folder, { releaseBeforeSwap: true });
    const before = (await readFacts(folder)).space.lastSeq;
    const failed = await restoreInPlaceWith(
      checked,
      backup.file,
      folder,
      {
        machineId: TEST_MACHINE,
        swap: {
          beforeSwap: () => {
            guard.beforeSwap();
            // Another process takes the free lock, writes and closes, before the first rename.
            oneCommit(checked, folder, "Written in between");
          },
          afterMoveAside: (replaced) => {
            guard.afterMoveAside(replaced);
          },
        },
      },
      {},
    ).catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: "SPACE_CHANGED" });
    // The live folder is back under its name with the write, and nothing else is left.
    expect(readdirSync(dirname(folder))).toEqual(["mira"]);
    expect((await readFacts(folder)).space.lastSeq).toBe(before + 1);
    lock.release();
  }, 120_000);

  test.skipIf(process.getuid?.() === 0)(
    "a rejected swap whose move back fails is marked, and the next start moves the live folder back instead of completing it",
    async () => {
      const checked = await checkedDriver();
      const { folder, backup } = await spaceWithBackup();
      const parent = dirname(folder);
      const before = (await readFacts(folder)).space.lastSeq;
      let blocker: Connection | undefined;
      const failed = await restoreInPlaceWith(
        checked,
        backup.file,
        folder,
        {
          machineId: TEST_MACHINE,
          swap: {
            afterMoveAside: (replaced) => {
              // Something keeps the live folder from moving back: an open file on Windows, a
              // folder that cannot be written elsewhere.
              if (process.platform === "win32") {
                const conn = checked.driver.open(join(replaced, DATABASE_FILE), {
                  readOnly: true,
                  busyTimeoutMs: 0,
                });
                conn.prepare("SELECT 1").get();
                blocker = conn;
              } else {
                chmodSync(parent, 0o500);
              }
              throw new StorageError("SPACE_CHANGED", "rejected by the test");
            },
          },
        },
        {},
      ).catch((error: unknown) => error);
      if (process.platform === "win32") blocker?.close();
      else chmodSync(parent, 0o700);
      expect(failed).toMatchObject({ code: "SPACE_CHANGED" });
      // Mid-swap: no live folder, the live one under its replaced name, the new one marked.
      const staging = readdirSync(parent).find((n) => n.startsWith(".mira.restoring-")) ?? "";
      expect(readdirSync(parent).includes("mira")).toBe(false);
      expect(readdirSync(join(parent, staging)).sort()).toEqual(
        expect.arrayContaining([DATABASE_FILE, REJECTED_MARK]),
      );
      expect(existsSync(join(parent, staging, MANIFEST_FILE))).toBe(false);

      const report = finishInterruptedRestore(folder);
      expect(report.undone).toBe(staging.slice(".mira.restoring-".length));
      expect(report.completed).toBeUndefined();
      expect(readdirSync(parent)).toEqual(["mira"]);
      expect((await readFacts(folder)).space.lastSeq).toBe(before);
    },
    120_000,
  );

  test("without a write in between the guard lets the swap through; on Windows only with the lock ended first", async () => {
    const checked = await checkedDriver();
    const { folder, backup } = await spaceWithBackup();
    for (const releaseBeforeSwap of [true, false]) {
      const listed = readdirSync(dirname(folder)).sort();
      const lock = await takeWriterLock(checked.driver, folder, {});
      try {
        const restoring = restoreInPlaceWith(
          checked,
          backup.file,
          folder,
          {
            machineId: TEST_MACHINE,
            // Two restores in one millisecond would share a stamp.
            now: () => Date.now() + (releaseBeforeSwap ? 0 : 1_000),
            swap: swapGuard(lock, folder, { releaseBeforeSwap }),
          },
          {},
        );
        if (process.platform === "win32" && !releaseBeforeSwap) {
          // Windows refuses to rename a folder with an open file, writer.lock included: the
          // reason the lock ends before the swap there. The rename is refused, and nothing moves.
          expect((await rejection(restoring)).code).toBe("STORAGE_CANT_OPEN");
          expect(readdirSync(dirname(folder)).sort()).toEqual(listed);
          continue;
        }
        const restored = await restoring;
        expect(existsSync(join(restored.replaced, WRITER_HOLDER_FILE))).toBe(false);
      } finally {
        lock.release();
      }
    }
  }, 120_000);
});

describe("[A1.5.writer.cross-process] one writer per space across processes: writer.lock", () => {
  test("a writer in another process holds writer.lock and writer.json: every route here is refused with SPACE_LOCKED_ELSEWHERE naming it, and nothing changes", async () => {
    const { folder, backup } = await spaceWithBackup();
    const other = await holder("writer", folder);
    expect(other.ready).toEqual({ ready: true });
    // writer.json names the holder (A2 3.4).
    expect(readWriterHolder(folder)).toEqual({
      machine: FIXTURE_MACHINE.name,
      pid: other.pid,
      instance: "child-instance",
      state_dir: "/child/state",
      since: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as unknown,
    });
    const holderText = readFileSync(join(folder, WRITER_HOLDER_FILE), "utf8");
    const before = readdirSync(dirname(folder));

    const w = await worker();
    const refused = await rejection(w.openSpaceWriter(folder, { machine: FIXTURE_MACHINE }));
    expect(refused).toBeInstanceOf(SpaceLockedElsewhere);
    expect(refused.code).toBe("SPACE_LOCKED_ELSEWHERE");
    expect((refused as SpaceLockedElsewhere).holder).toMatchObject({
      pid: other.pid,
      instance: "child-instance",
    });
    expect(
      (await rejection(w.restoreInPlace(backup.file, folder, { machineId: TEST_MACHINE }))).code,
    ).toBe("SPACE_LOCKED_ELSEWHERE");
    writeFileSync(join(folder, `${DATABASE_FILE}-journal`), "");
    expect((await rejection(w.recoverSpace(folder))).code).toBe("SPACE_LOCKED_ELSEWHERE");
    rmSync(join(folder, `${DATABASE_FILE}-journal`));
    // Nothing moved, nothing was left beside the space, and the holder record is the child's.
    expect(readdirSync(dirname(folder))).toEqual(before);
    expect(readFileSync(join(folder, WRITER_HOLDER_FILE), "utf8")).toBe(holderText);

    // A read-only copy whose lock another process holds is not claimed.
    const copy = join(folders.make(), "copy");
    await restoreBackup(await checkedDriver(), backup.file, copy);
    const copyLock = await holder("lock", join(copy, WRITER_LOCK_FILE));
    expect(copyLock.ready).toEqual({ ready: true });
    expect((await rejection(w.claimSpace(copy, { machine: FIXTURE_MACHINE }))).code).toBe(
      "SPACE_LOCKED_ELSEWHERE",
    );
    expect((await readFacts(copy)).space.transfer).not.toBeNull();
    await copyLock.close();

    // The holder closes its writer: its writer.json goes, and this process opens the space.
    await other.close();
    expect(existsSync(join(folder, WRITER_HOLDER_FILE))).toBe(false);
    expect(existsSync(join(folder, WRITER_LOCK_FILE))).toBe(true);
    const writer = await w.openSpaceWriter(folder, {
      machine: FIXTURE_MACHINE,
      holder: { instance: "this-instance" },
    });
    expect(readWriterHolder(folder)).toMatchObject({ pid: process.pid, instance: "this-instance" });
    const result = await writer.submit(
      createRequest(writer.spaceId, ownerCredential(await owner(folder)), "After the holder"),
    );
    expect(result.status).toBe("applied");
    await writer.close();
    expect(existsSync(join(folder, WRITER_HOLDER_FILE))).toBe(false);
  }, 120_000);

  test("this process's writer holds the lock for its life: another process gets it only once the writer closes or its worker stops", async () => {
    const { folder } = await spaceWithBackup();
    const lockPath = join(folder, WRITER_LOCK_FILE);
    const w = await worker();
    const seen: unknown[] = [];
    const writer = await w.openSpaceWriter(folder, {
      machine: FIXTURE_MACHINE,
      onLock: (lock) => seen.push(lock),
    });
    // The lock is reported as soon as it is held, with the identity of the file it holds.
    const identity = fileIdentity(lockPath);
    expect(writer.lock).toEqual({ path: lockPath, ...identity });
    expect(seen).toEqual([writer.lock]);
    expect((await holder("lock", lockPath)).ready).toEqual({ ready: false, code: "busy" });
    // A second writer of the other process is refused, its holder named.
    const refused = await holder("writer", folder);
    expect(refused.ready).toMatchObject({ ready: false, code: "SPACE_LOCKED_ELSEWHERE" });
    await writer.close();
    const free = await holder("lock", lockPath);
    expect(free.ready).toEqual({ ready: true });
    await free.close();

    // A worker that stops ends its writers, and their locks with them.
    await w.openSpaceWriter(folder, { machine: FIXTURE_MACHINE });
    expect((await holder("lock", lockPath)).ready).toEqual({ ready: false, code: "busy" });
    await w.close();
    expect((await holder("lock", lockPath)).ready).toEqual({ ready: true });
  }, 120_000);

  test("a holder that dies frees the lock at once: after a hard kill the next writer takes it and replaces the stale writer.json", async () => {
    const { folder } = await spaceWithBackup();
    const other = await holder("writer", folder);
    expect(other.ready).toEqual({ ready: true });
    await stopChild(other.child);
    // What the dead holder left: its writer.json, which names a lock nobody holds.
    expect(readWriterHolder(folder)?.pid).toBe(other.pid);
    const w = await worker();
    const writer = await w.openSpaceWriter(folder, {
      machine: FIXTURE_MACHINE,
      holder: { instance: "next" },
    });
    expect(readWriterHolder(folder)).toMatchObject({ pid: process.pid, instance: "next" });
    await writer.close();
  }, 120_000);

  test("a database file with a second name (hard link, symbolic link) is never opened for writing, and nothing is written beside it", async () => {
    const { folder } = await spaceWithBackup();
    const parent = folders.make();
    const aliases: string[] = [];
    const hard = join(parent, "hard");
    mkdirSync(hard);
    copyFileSync(join(folder, MANIFEST_FILE), join(hard, MANIFEST_FILE));
    linkSync(join(folder, DATABASE_FILE), join(hard, DATABASE_FILE));
    aliases.push(hard);
    if (process.platform !== "win32") {
      const soft = join(parent, "soft");
      mkdirSync(soft);
      copyFileSync(join(folder, MANIFEST_FILE), join(soft, MANIFEST_FILE));
      symlinkSync(join(folder, DATABASE_FILE), join(soft, DATABASE_FILE));
      aliases.push(soft);
    }
    const w = await worker();
    const listing = readdirSync(folder);
    for (const alias of [folder, ...aliases]) {
      expect((await rejection(w.openSpaceWriter(alias, { machine: FIXTURE_MACHINE }))).code).toBe(
        "SPACE_DATABASE_LINKED",
      );
      // Not even writer.lock: the refusal comes before anything opens the space.
      expect(readdirSync(alias).sort()).toEqual(
        alias === folder ? listing.sort() : [DATABASE_FILE, MANIFEST_FILE].sort(),
      );
    }
    // A claim of a read-only copy whose database has a second name is refused the same way.
    const copy = join(folders.make(), "copy");
    const again = await backupSpace(await checkedDriver(), folder, {
      backupDir: backupsBeside(folder),
      kind: "manual",
    });
    await restoreBackup(await checkedDriver(), again.file, copy);
    linkSync(join(copy, DATABASE_FILE), join(parent, "copy.db"));
    expect((await rejection(w.claimSpace(copy, { machine: FIXTURE_MACHINE }))).code).toBe(
      "SPACE_DATABASE_LINKED",
    );
    expect(existsSync(join(copy, WRITER_LOCK_FILE))).toBe(false);
  }, 120_000);

  test("restore in place and recovery hold the lock and swap the folder on every OS; afterwards it is free and no holder record is left", async () => {
    const { folder, backup } = await spaceWithBackup();
    const w = await worker();
    const restored = await w.restoreInPlace(backup.file, folder, {
      machineId: TEST_MACHINE,
      holder: { instance: "restorer" },
    });
    expect(existsSync(join(restored.replaced, WRITER_HOLDER_FILE))).toBe(false);
    expect(existsSync(join(folder, WRITER_HOLDER_FILE))).toBe(false);
    const free = await holder("lock", join(folder, WRITER_LOCK_FILE));
    expect(free.ready).toEqual({ ready: true });
    await free.close();

    writeFileSync(join(folder, `${DATABASE_FILE}-journal`), "");
    const recovered = await w.recoverSpace(folder, { holder: { instance: "recoverer" } });
    expect(existsSync(join(recovered.replaced, WRITER_HOLDER_FILE))).toBe(false);
    expect(existsSync(join(folder, WRITER_HOLDER_FILE))).toBe(false);
    const writer = await w.openSpaceWriter(folder, { machine: FIXTURE_MACHINE });
    expect(writer.spaceId).toBe(restored.space.spaceId);
    await writer.close();

    // A folder that is not there is not found, as an open reports it, and gets no lock file.
    const gone = join(dirname(folder), "gone");
    expect(
      (await rejection(w.restoreInPlace(backup.file, gone, { machineId: TEST_MACHINE }))).code,
    ).toBe("SPACE_NOT_FOUND");
    expect((await rejection(w.recoverSpace(gone))).code).toBe("SPACE_NOT_FOUND");
    expect(existsSync(gone)).toBe(false);
  }, 120_000);
});
