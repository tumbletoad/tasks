// The writer worker (A1 3.9; A7 3.8 M1.04): openSpace runs inside the
// storage worker, one writer per space in the process, a space's writer takes operations only,
// and each request has a time limit and the queue a size limit.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { UnexpectedSpace } from "../src/errors.ts";
import { newId } from "../src/ids.ts";
import { MANIFEST_FILE } from "../src/manifest.ts";
import { openSpace } from "../src/space.ts";
import { StorageWorker } from "../src/worker/client.ts";
import type { Credential, WriteRequest } from "../src/write/request.ts";
import { WRITER_LOCK_FILE } from "../src/writer-lock.ts";
import { checkedDriver, createFixtureSpace, tempFolders, TEST_MACHINE } from "./space-helpers.ts";
import { blocked, rejection, sent, workerWithSteps } from "./worker-helpers.ts";
import { MACHINE } from "./write-helpers.ts";

const temp = tempFolders("writer-worker");
const workers: StorageWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
});
afterAll(temp.cleanup);

async function startWorker(): Promise<StorageWorker> {
  const worker = await StorageWorker.start({ driver: "node:sqlite" });
  workers.push(worker);
  return worker;
}

let counter = 0;
function createRequest(
  spaceId: WriteRequest["space_id"],
  human: Credential["principal_id"],
): WriteRequest {
  counter += 1;
  return {
    space_id: spaceId,
    request_id: `worker-request-${String(counter).padStart(6, "0")}`,
    actor: {
      scope_id: "cli:fixture",
      principal_id: human,
      actor_kind: "human",
      machine_id: TEST_MACHINE,
      origin: "cli",
    },
    ops: [{ kind: "task.create", title: "Fix the export" }],
  };
}

const lastSeq = async (folder: string): Promise<unknown> => {
  const { conn } = openSpace(await checkedDriver(), folder, { role: "reader" });
  try {
    return conn.prepare("SELECT last_seq FROM space").get()?.["last_seq"];
  } finally {
    conn.close();
  }
};

describe("[A1.5.writer.worker] one writer per file: the claim holds the file SQLite opened", () => {
  test("a database the writer's open creates is claimed by its identity: a hard link to it is refused", async () => {
    // The reviewer's case: the claim of a file that did not exist yet held only its path.
    const dir = temp.make();
    const [w1, w2] = [await startWorker(), await startWorker()];
    const [a, b] = [join(dir, "a.db"), join(dir, "b.db")];
    const first = await w1.open(a, "writer", { create: true });
    await first.exec("CREATE TABLE t (v INTEGER)");
    await first.pragma("wal_checkpoint", "TRUNCATE");
    linkSync(a, b);
    expect((await rejection(w2.open(b, "writer"))).code).toBe("SPACE_WRITER_TAKEN");
    await first.run("INSERT INTO t VALUES (1)");
    await first.close();
    // Closing ends the claim: the other name opens now, and finds what the first writer wrote.
    const second = await w2.open(b, "writer");
    await second.run("INSERT INTO t VALUES (2)");
    await second.close();
    const again = await w1.open(a, "writer");
    expect(await again.all("SELECT v FROM t ORDER BY v")).toEqual([{ v: 1 }, { v: 2 }]);
    await again.close();
  });

  test("a file that appears after the claim looked is claimed when SQLite opens it, before anything runs on it", async () => {
    const dir = temp.make();
    const [w1, w2] = [await startWorker(), await startWorker()];
    const [a, b] = [join(dir, "a.db"), join(dir, "b.db")];
    const block = await blocked(w1, temp.make());
    const posted = sent(w1, "open");
    // The claim finds no a.db, so it holds the path only. The worker waits before it opens.
    const opening = rejection(w1.open(a, "writer", { create: true }));
    await posted;
    // Another program creates the file under two names, and a writer takes the other name.
    writeFileSync(a, "");
    linkSync(a, b);
    const other = await w2.open(b, "writer");
    await block.release();
    // SQLite opened the file the other writer holds: refused, and its claim is gone.
    expect((await opening).code).toBe("SPACE_WRITER_TAKEN");
    await other.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1)");
    await other.close();
    const again = await w1.open(a, "writer");
    expect(await again.all("SELECT v FROM t")).toEqual([{ v: 1 }]);
    await again.close();
  });

  test("a space's database replaced after the claim looked is claimed when SQLite opens it", async () => {
    const created = await createFixtureSpace(temp.make());
    const db = join(created.folder, "space.db");
    // A copy of the database: the same space ID, another file.
    const copy = join(temp.make(), "copy.db");
    cpSync(db, copy);
    const [w1, w2] = [await startWorker(), await startWorker()];
    const block = await blocked(w1, temp.make());
    const posted = sent(w1, "openSpace");
    const opening = rejection(w1.openSpaceWriter(created.folder, { machine: MACHINE }));
    await posted;
    // Another program puts the copy in place under the space's name, and a writer opens the copy.
    rmSync(db);
    linkSync(copy, db);
    const other = await w2.open(copy, "writer");
    await block.release();
    expect((await opening).code).toBe("SPACE_WRITER_TAKEN");
    expect(existsSync(join(created.folder, MANIFEST_FILE))).toBe(true);
    await other.close();
    // While the database has a second name, its space's writer is refused for that alone (M1.08).
    expect((await rejection(w1.openSpaceWriter(created.folder, { machine: MACHINE }))).code).toBe(
      "SPACE_DATABASE_LINKED",
    );
    rmSync(copy);
    const writer = await w1.openSpaceWriter(created.folder, { machine: MACHINE });
    await writer.close();
  });

  test("a backup claims its destination as a writer does", async () => {
    const parent = temp.make();
    const created = await createFixtureSpace(parent);
    const source = await createFixtureSpace(parent, "other");
    const [w1, w2] = [await startWorker(), await startWorker()];
    const writer = await w1.openSpaceWriter(created.folder, { machine: MACHINE });
    const db = join(created.folder, "space.db");
    const before = readFileSync(db);
    const linked = join(temp.make(), "linked.db");
    linkSync(db, linked);
    const { conn } = await w2.openSpaceReader(source.folder);
    for (const dest of [db, linked]) {
      expect((await rejection(conn.backup(dest, 1))).code).toBe("SPACE_WRITER_TAKEN");
    }
    expect(readFileSync(db)).toEqual(before);
    await writer.close();
    // The claim ends with the backup: a writer opens the copy afterwards.
    const copy = join(temp.make(), "copy.db");
    expect(await conn.backup(copy, 100)).toBeGreaterThan(0);
    const plain = await w1.open(copy, "writer");
    await plain.close();
    await conn.close();
  });
});

describe("[A1.5.writer.worker] the writer worker", () => {
  test("opens a space with openSpace in the worker, registers the machine once and takes requests", async () => {
    const created = await createFixtureSpace(temp.make());
    const worker = await startWorker();
    const writer = await worker.openSpaceWriter(created.folder, { machine: MACHINE });
    expect(writer.spaceId).toBe(created.space.spaceId);
    expect(writer.machineRegistered).toBe(true);
    expect(writer.readOnlyReasons).toEqual([]);
    const result = await writer.submit(createRequest(created.space.spaceId, created.actors.human));
    expect(result).toMatchObject({
      status: "applied",
      seq: 2,
      results: [{ ref: "M-1", status: "created" }],
    });
    // A refused request is a result, and a shape the worker cannot read is one too.
    expect((await writer.submit({ nonsense: true })).status).toBe("rejected");
    await writer.close();
    const again = await worker.openSpaceWriter(created.folder, { machine: MACHINE });
    expect(again.machineRegistered).toBe(false);
    await again.close();
    expect(await lastSeq(created.folder)).toBe(2);
  });

  test("a space's writer refuses SQL, and needs its machine", async () => {
    const created = await createFixtureSpace(temp.make());
    const worker = await startWorker();
    const writer = await worker.openSpaceWriter(created.folder, { machine: MACHINE });
    const handle = writer.handle;
    const refused = [
      worker.call("exec", { handle, sql: "DELETE FROM tasks" }),
      worker.call("query", { handle, query: { sql: "DELETE FROM tasks", mode: "run" } }),
      worker.call("transaction", { handle, mode: "immediate", queries: [] }),
      worker.call("pragma", { handle, name: "foreign_keys", value: 0 }),
      worker.call("backup", { handle, destPath: join(temp.make(), "copy.db"), pagesPerStep: 1 }),
    ];
    for (const call of refused) {
      const error = await rejection(call);
      expect(error.code).toBe("STORAGE_MISUSE");
      expect(error.message).toMatch(/operations, not SQL/);
    }
    // A writer without this machine's record is refused before anything opens.
    await writer.close();
    const noMachine = { folder: created.folder } as { folder: string; machine: never };
    expect((await rejection(worker.call("openSpaceWriter", noMachine))).code).toBe(
      "STORAGE_MISUSE",
    );
    // A writable connection the worker holds for its claim takes nothing but proceed or close.
    const scratch = join(temp.make(), "held.db");
    const held = await worker.call("open", { path: scratch, role: "writer", create: true });
    const waiting = await rejection(worker.call("exec", { handle: held.handle, sql: "SELECT 1" }));
    expect(waiting.message).toMatch(/waits for its claim/);
    await worker.call("close", { handle: held.handle });
    expect((await rejection(worker.call("proceed", { handle: held.handle }))).code).toBe(
      "STORAGE_MISUSE",
    );
    // A reader opened with openSpace takes SQL, and reports read-only reasons.
    const { conn, info } = await worker.openSpaceReader(created.folder);
    expect(info).toMatchObject({
      role: "reader",
      spaceId: created.space.spaceId,
      readOnlyReasons: [],
    });
    expect(await conn.get("SELECT last_seq FROM space")).toEqual({ last_seq: 1 });
    expect((await rejection(conn.run("DELETE FROM tasks"))).code).toBe("STORAGE_READ_ONLY");
    await conn.close();
  });

  test("one writer per space in the process, by path, by another spelling and by space ID", async () => {
    const parent = temp.make();
    const created = await createFixtureSpace(parent);
    // A copy of the space before any writer opened it: the same space ID in another folder.
    const copyParent = temp.make();
    cpSync(created.folder, join(copyParent, "mira"), { recursive: true });
    const [w1, w2] = [await startWorker(), await startWorker()];
    const writer = await w1.openSpaceWriter(created.folder, { machine: MACHINE });
    const takenBy = async (promise: Promise<unknown>): Promise<void> => {
      expect((await rejection(promise)).code).toBe("SPACE_WRITER_TAKEN");
    };
    await takenBy(w1.openSpaceWriter(created.folder, { machine: MACHINE }));
    await takenBy(w2.openSpaceWriter(created.folder, { machine: MACHINE }));
    await takenBy(w2.open(join(created.folder, "space.db"), "writer"));
    // The same folder through a link: a junction on Windows, a symbolic link elsewhere.
    const link = join(temp.make(), "link");
    symlinkSync(parent, link, process.platform === "win32" ? "junction" : "dir");
    await takenBy(w2.openSpaceWriter(join(link, "mira"), { machine: MACHINE }));
    if (process.platform === "win32") {
      await takenBy(
        w2.openSpaceWriter(created.folder.toUpperCase().replace(/MIRA$/, "mira"), {
          machine: MACHINE,
        }),
      );
    }
    // The copy has the same space ID: refused before any writable connection opens it, so its
    // missing space.json is not rebuilt and its database keeps its bytes. The read-only open that
    // read the space ID leaves what A1 3.1 allows such an open on a WAL database to leave:
    // a 0-byte -wal and a 32 KiB -shm, and nothing else.
    const copy = join(copyParent, "mira");
    rmSync(join(copy, MANIFEST_FILE));
    expect(readdirSync(copy)).toEqual(["space.db"]);
    const bytes = readFileSync(join(copy, "space.db"));
    await takenBy(w2.openSpaceWriter(copy, { machine: MACHINE }));
    expect(readdirSync(copy).sort()).toEqual(["space.db", "space.db-shm", "space.db-wal"]);
    expect(readFileSync(join(copy, "space.db"))).toEqual(bytes);
    expect(statSync(join(copy, "space.db-wal")).size).toBe(0);
    expect(statSync(join(copy, "space.db-shm")).size).toBe(32 * 1024);
    expect(await lastSeq(copy)).toBe(0);
    // A hard link to the database is the same file under another name, in another folder too.
    // A plain writer's claim refuses it; a space's writer is refused before its claim, for the
    // second name alone (M1.08: writer.lock guards a folder), and the space is left untouched.
    const linked = join(temp.make(), "linked");
    mkdirSync(linked);
    linkSync(join(created.folder, "space.db"), join(linked, "space.db"));
    await takenBy(w2.open(join(linked, "space.db"), "writer"));
    expect((await rejection(w2.openSpaceWriter(linked, { machine: MACHINE }))).code).toBe(
      "SPACE_DATABASE_LINKED",
    );
    expect(readdirSync(linked)).toEqual(["space.db"]);
    // The second name goes again: the space's own writer is refused while it exists.
    rmSync(join(linked, "space.db"));
    if (process.platform === "win32") {
      // Windows drops a trailing dot or space from a path's parts, so these name the database
      // too. No claim could see that, so a writer path like this is refused.
      for (const alias of ["space.db.", "space.db ", "space.db. ."]) {
        const error = await rejection(w2.open(join(created.folder, alias), "writer"));
        expect(error.code, alias).toBe("STORAGE_MISUSE");
      }
      // A space folder meets the space path rules first, before anything opens.
      const error = await rejection(w2.openSpaceWriter(`${created.folder}.`, { machine: MACHINE }));
      expect(error.code).toBe("SPACE_PATH_INVALID");
    }
    // Readers are not writers.
    const { conn } = await w2.openSpaceReader(created.folder);
    await conn.close();
    // Closing the writer ends its claim, and so does stopping its worker.
    await writer.close();
    const second = await w2.openSpaceWriter(join(link, "mira"), { machine: MACHINE });
    await w2.close();
    const third = await w1.openSpaceWriter(created.folder, { machine: MACHINE });
    await third.close();
    expect(second.spaceId).toBe(created.space.spaceId);
  });

  test("a refused open ends its claim: openSpace's refusals cross the worker boundary", async () => {
    const created = await createFixtureSpace(temp.make());
    const worker = await startWorker();
    writeFileSync(join(created.folder, MANIFEST_FILE), "not json");
    const error = await rejection(worker.openSpaceWriter(created.folder, { machine: MACHINE }));
    expect(error.code).toBe("SPACE_MANIFEST_DAMAGED");
    const { info, conn } = await worker.openSpaceReader(created.folder);
    expect(info.readOnlyReasons).toEqual(["manifest_damaged"]);
    await conn.close();
    // Without the damaged manifest the writer opens, so the refused open left no claim behind.
    rmSync(join(created.folder, MANIFEST_FILE));
    const writer = await worker.openSpaceWriter(created.folder, { machine: MACHINE });
    expect(writer.manifestRebuilt).toBe(true);
    await writer.close();
    const missing = join(temp.make(), "mira");
    mkdirSync(missing);
    expect((await rejection(worker.openSpaceWriter(missing, { machine: MACHINE }))).code).toBe(
      "SPACE_NOT_FOUND",
    );
  });

  // The worker is held still on purpose in these tests (blocked): an answer cannot come before the
  // time limit, however fast or loaded the machine, and every request after the hold waits for
  // its release. No step races a short timer against the worker.

  test("a request that gets no answer in time is STORAGE_TIMEOUT, and its late answer is dropped", async () => {
    const created = await createFixtureSpace(temp.make());
    const worker = await startWorker();
    const writer = await worker.openSpaceWriter(created.folder, {
      machine: MACHINE,
      timeoutMs: 50,
    });
    const hold = await blocked(worker, temp.make());
    const request = createRequest(created.space.spaceId, created.actors.human);
    const error = await rejection(writer.submit(request));
    expect(error.code).toBe("STORAGE_TIMEOUT");
    expect(error.retryable).toBe(true);
    // Released, the worker still decides the request, and its answer, late, is dropped: the
    // caller's promise stays rejected. The release's COMMIT is answered after it, in order.
    await hold.release();
    // Closing the writer waits behind the request in the worker, so it was decided by then.
    await writer.close();
    expect(await lastSeq(created.folder)).toBe(2);
    // A retry with the same request ID never applies twice: it replays the receipt the worker
    // stored (A1 3.8), here through a new writer with the default time limit, as a retry from
    // another process would.
    const again = await worker.openSpaceWriter(created.folder, { machine: MACHINE });
    const retry = await again.submit(request);
    expect(retry).toMatchObject({ status: "applied", seq: 2, replayed: true });
    await again.close();
    expect(await lastSeq(created.folder)).toBe(2);
  });

  test("a full queue is STORAGE_OVERLOADED at once, and the waiting requests still apply", async () => {
    const created = await createFixtureSpace(temp.make());
    const worker = await startWorker();
    const writer = await worker.openSpaceWriter(created.folder, {
      machine: MACHINE,
      queueLimit: 2,
    });
    const hold = await blocked(worker, temp.make());
    const first = writer.submit(createRequest(created.space.spaceId, created.actors.human));
    const second = writer.submit(createRequest(created.space.spaceId, created.actors.human));
    const error = await rejection(
      writer.submit(createRequest(created.space.spaceId, created.actors.human)),
    );
    expect(error.code).toBe("STORAGE_OVERLOADED");
    expect(error.retryable).toBe(true);
    await hold.release();
    expect((await first).status).toBe("applied");
    expect((await second).status).toBe("applied");
    expect(await lastSeq(created.folder)).toBe(3);
  });

  test("a request that timed out keeps its place in the queue until the worker answers it", async () => {
    const created = await createFixtureSpace(temp.make());
    const worker = await startWorker();
    const writer = await worker.openSpaceWriter(created.folder, {
      machine: MACHINE,
      timeoutMs: 50,
      queueLimit: 1,
    });
    const hold = await blocked(worker, temp.make());
    const late = await rejection(
      writer.submit(createRequest(created.space.spaceId, created.actors.human)),
    );
    expect(late.code).toBe("STORAGE_TIMEOUT");
    // The request still waits in the worker, so the queue is still full.
    for (let i = 0; i < 3; i += 1) {
      const error = await rejection(
        writer.submit(createRequest(created.space.spaceId, created.actors.human)),
      );
      expect(error.code).toBe("STORAGE_OVERLOADED");
    }
    // Released, the worker answers the late request before the release's COMMIT: its place is
    // free again. Held once more, the next request is taken into the queue and waits there until
    // its own time limit, which shows the place was free: a full queue refuses at once.
    await hold.release();
    const again = await blocked(worker, temp.make());
    const next = await rejection(
      writer.submit(createRequest(created.space.spaceId, created.actors.human)),
    );
    expect(next.code).toBe("STORAGE_TIMEOUT");
    await again.release();
    await writer.close();
    expect(await lastSeq(created.folder)).toBe(3);
  });

  test("a writer on another machine than the authority writes nothing", async () => {
    const created = await createFixtureSpace(temp.make());
    const worker = await startWorker();
    const other = { id: newId("m"), name: "mira-laptop", os: "linux" as const };
    const writer = await worker.openSpaceWriter(created.folder, { machine: other });
    expect(writer.machineRegistered).toBe(false);
    const result = await writer.submit(createRequest(created.space.spaceId, created.actors.human));
    expect(result.error?.code).toBe("SPACE_READ_ONLY");
    expect(await lastSeq(created.folder)).toBe(0);
  });
});

/** Every file under `dir` by its path relative to `dir`, with a hash of its bytes. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(dir, path).split("\\").join("/");
    files[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return files;
}

/**
 * `after` is `before` byte for byte, with nothing new but the files named in `extra` (A1
 * 3.1: a read-only open of a closed WAL space leaves an empty -wal and the -shm).
 */
function expectUnchanged(
  before: Record<string, string>,
  after: Record<string, string>,
  extra: readonly string[] = ["space.db-wal", "space.db-shm"],
): void {
  const kept = Object.fromEntries(
    Object.entries(after).filter(([name]) => !(extra.includes(name) && !(name in before))),
  );
  expect(kept).toEqual(before);
}

describe("[A1.5.writer.named-space] a writer named for one space never opens another", () => {
  test("a folder that holds another space is refused before anything is claimed, locked or written", async () => {
    const created = await createFixtureSpace(temp.make());
    const before = snapshot(created.folder);
    const worker = await startWorker();
    const error = await rejection(
      worker.openSpaceWriter(created.folder, { machine: MACHINE, spaceId: newId("sp") }),
    );
    expect(error).toBeInstanceOf(UnexpectedSpace);
    expect(error.code).toBe("SPACE_ID_MISMATCH");
    expectUnchanged(before, snapshot(created.folder));
    expect(existsSync(join(created.folder, WRITER_LOCK_FILE))).toBe(false);
    // Nothing is held: the same worker opens it as the space it is.
    const writer = await worker.openSpaceWriter(created.folder, {
      machine: MACHINE,
      spaceId: created.space.spaceId,
    });
    expect(writer.spaceId).toBe(created.space.spaceId);
    await writer.close();
  });

  test("a space swapped in after the first look, before the claim's probe, is refused unclaimed and unwritten", async () => {
    const parent = temp.make();
    const a = await createFixtureSpace(parent, "a");
    const b = await createFixtureSpace(parent, "b");
    const beforeB = snapshot(b.folder);
    const worker = await startWorker();
    // The second read-only open is the claim's probe: right before it, b takes a's place.
    let opens = 0;
    const call = worker.call.bind(worker);
    worker.call = (kind, args) => {
      if (kind === "openSpace" && (opens += 1) === 2) {
        worker.call = call;
        renameSync(a.folder, join(parent, "a-moved"));
        renameSync(b.folder, a.folder);
      }
      return call(kind, args);
    };
    const error = await rejection(
      worker.openSpaceWriter(a.folder, { machine: MACHINE, spaceId: a.space.spaceId }),
    );
    expect(error).toBeInstanceOf(UnexpectedSpace);
    expectUnchanged(beforeB, snapshot(a.folder));
    expect(existsSync(join(a.folder, WRITER_LOCK_FILE))).toBe(false);
  });

  test("a space swapped in after the probe, before the writer's lock, is refused before its migration", async () => {
    const parent = temp.make();
    const a = await createFixtureSpace(parent, "a");
    const b = await createFixtureSpace(parent, "b");
    const beforeB = snapshot(b.folder);
    // A build one revision further: a writer that opened b would migrate it first.
    const worker = await workerWithSteps("0.7");
    workers.push(worker);
    const call = worker.call.bind(worker);
    worker.call = (kind, args) => {
      if (kind === "openSpaceWriter") {
        worker.call = call;
        renameSync(a.folder, join(parent, "a-moved"));
        renameSync(b.folder, a.folder);
      }
      return call(kind, args);
    };
    // No space named: the writer's lock still holds it to the space its probe read.
    const error = await rejection(worker.openSpaceWriter(a.folder, { machine: MACHINE }));
    expect(error.code).toBe("SPACE_CHANGED");
    // b was not migrated, backed up or registered: only the lock file is new, and it is free.
    expectUnchanged(beforeB, snapshot(a.folder), [
      "space.db-wal",
      "space.db-shm",
      WRITER_LOCK_FILE,
    ]);
    const other = await startWorker();
    const writer = await other.openSpaceWriter(a.folder, {
      machine: MACHINE,
      spaceId: b.space.spaceId,
    });
    expect(writer.revision).toEqual({ major: 0, minor: 6 });
    await writer.close();
  });
});
