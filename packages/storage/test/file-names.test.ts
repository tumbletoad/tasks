// How a file name reaches SQLite (A1 3.19, review round three). The
// rule: every file name this package hands SQLite is one literal file-system path, and a writer's
// claim is computed from that same path. A file: URI, a path that starts with file:, a relative
// path and a path with ? or # are all paths, so SQLite acts on exactly the file the claim names.
// The routes a file name takes into SQLite: a database's open (writer and reader, a space's
// included), a backup's destination, and SQL (ATTACH and VACUUM INTO, which no connection runs).
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import type { StorageErrorCode } from "../src/errors.ts";
import { openReader } from "../src/open.ts";
import { StorageWorker, type WorkerConnection } from "../src/worker/client.ts";
import type { WriteRequest } from "../src/write/request.ts";
import { checkedDriver, createFixtureSpace, tempFolders, TEST_MACHINE } from "./space-helpers.ts";
import { blocked, rejection, sent } from "./worker-helpers.ts";
import { MACHINE } from "./write-helpers.ts";

const WINDOWS = process.platform === "win32";

const temp = tempFolders("file-names");
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

/** The files under `dir`, relative to it and sorted, without SQLite's -wal and -shm files. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/-(?:wal|shm)$/.test(entry.name))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * Where a file: URI points when it is read as a path: a folder named `file:` in the working
 * folder. Nothing may ever appear there. (On Windows the colon makes the name a stream, and such a
 * path is refused before anything opens.)
 */
const expectNoUriFolder = (): void => {
  if (!WINDOWS) expect(existsSync(resolve("file:"))).toBe(false);
};

/** The live database's file: URI, with and without query parameters SQLite would read. */
const uris = (file: string): string[] => {
  const uri = pathToFileURL(file).href;
  return [uri, `${uri}?mode=rw`, `${uri}?mode=rwc&cache=shared`];
};

/**
 * What a file: URI read as a path meets: on Linux a folder named `file:` that is not there, on
 * Windows a colon in a part of the path, which Windows would read as a stream.
 */
const URI_REFUSAL: StorageErrorCode = WINDOWS ? "STORAGE_MISUSE" : "STORAGE_CANT_OPEN";

const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`;

interface Live {
  dir: string;
  live: string;
  linked: string;
  a: WorkerConnection;
  w1: StorageWorker;
  w2: StorageWorker;
  source: WorkerConnection;
}

/**
 * The reviewer's set-up: writer A on live.db has committed row 1 and checkpointed it, a hard link
 * names the same file, and another worker's source database holds row 99.
 */
async function liveAndSource(): Promise<Live> {
  const dir = temp.make();
  const [w1, w2] = [await startWorker(), await startWorker()];
  const live = join(dir, "live.db");
  const a = await w1.open(live, "writer", { create: true });
  await a.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1)");
  await a.pragma("wal_checkpoint", "TRUNCATE");
  const linked = join(dir, "linked.db");
  linkSync(live, linked);
  const source = await w2.open(join(temp.make(), "source.db"), "writer", { create: true });
  await source.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (99)");
  return { dir, live, linked, a, w1, w2, source };
}

/** A commits row 2, closes, and its file holds exactly the rows A committed. */
async function expectLiveIntact({ live, a, w1, dir }: Live): Promise<void> {
  await a.run("INSERT INTO t VALUES (2)");
  await a.close();
  const again = await w1.open(live, "writer");
  expect(await again.all("SELECT v FROM t ORDER BY v")).toEqual([{ v: 1 }, { v: 2 }]);
  await again.close();
  expect(files(dir)).toEqual(["linked.db", "live.db"]);
  expectNoUriFolder();
}

describe("[A1.5.writer.file-names] a file: URI is a path: no route reaches the live database through one", () => {
  test("the reviewer's case: a backup into the live database's URI, or its hard link's, is refused, and no committed row is lost", async () => {
    const setup = await liveAndSource();
    const { live, linked, source } = setup;
    const before = readFileSync(live);
    for (const dest of [...uris(live), ...uris(linked)]) {
      expect((await rejection(source.backup(dest, 100))).code, dest).toBe(URI_REFUSAL);
    }
    // By their native paths, both names are claimed by A.
    for (const dest of [live, linked]) {
      expect((await rejection(source.backup(dest, 100))).code, dest).toBe("SPACE_WRITER_TAKEN");
    }
    expect(readFileSync(live)).toEqual(before);
    await source.close();
    await expectLiveIntact(setup);
  });

  test("a writer or a reader opened by the live database's URI, or its hard link's, never opens it", async () => {
    const setup = await liveAndSource();
    const { live, linked, w2, source } = setup;
    for (const spelling of [...uris(live), ...uris(linked)]) {
      for (const opening of [
        () => w2.open(spelling, "writer"),
        () => w2.open(spelling, "writer", { create: true }),
        () => w2.open(spelling, "reader"),
      ]) {
        expect((await rejection(opening())).code, spelling).toBe(URI_REFUSAL);
      }
    }
    await source.close();
    await expectLiveIntact(setup);
  });

  test("a space folder given as a file: URI or a relative path is refused before anything opens", async () => {
    const created = await createFixtureSpace(temp.make());
    const [w1, w2] = [await startWorker(), await startWorker()];
    const writer = await w1.openSpaceWriter(created.folder, { machine: MACHINE });
    for (const spelling of [
      ...uris(created.folder),
      relative(process.cwd(), created.folder),
      `file:${relative(process.cwd(), created.folder)}`,
    ]) {
      const refused = await rejection(w2.openSpaceWriter(spelling, { machine: MACHINE }));
      expect(refused.code, spelling).toBe("SPACE_PATH_INVALID");
      expect((await rejection(w2.openSpaceReader(spelling))).code, spelling).toBe(
        "SPACE_PATH_INVALID",
      );
    }
    await writer.close();
    expectNoUriFolder();
  });

  test("SQL on a worker's connection cannot ATTACH a file or VACUUM INTO one, by any spelling, and VACUUM still runs", async () => {
    const setup = await liveAndSource();
    const { dir, live, linked, source } = setup;
    const reader = await (await startWorker()).open(live, "reader");
    const fresh = join(dir, "fresh.db");
    const targets = [live, linked, fresh, ...uris(live), `file:${live}?mode=rw`, ":memory:"];
    for (const conn of [source, reader]) {
      for (const target of targets) {
        const name = quote(target);
        for (const sql of [
          `ATTACH ${name} AS other`,
          `attach database ${name} as other`,
          `/* a comment */ AtTaCh /* another */ DATABASE ${name} AS other`,
          `SELECT 1; ATTACH ${name} AS other`,
          `ATTACH ${name} || '' AS other`,
          `VACUUM INTO ${name}`,
          `vacuum main into ${name}`,
          `VACUUM INTO (SELECT ${name})`,
        ]) {
          const error = await rejection(conn.exec(sql));
          expect([error.code, error.sqliteCode], sql).toEqual(["STORAGE_SQL", 23]);
        }
        const bound = await rejection(conn.run("ATTACH $file AS other", { file: target }));
        expect([bound.code, bound.sqliteCode], target).toEqual(["STORAGE_SQL", 23]);
        const into = await rejection(conn.run("VACUUM INTO $file", { file: target }));
        expect([into.code, into.sqliteCode], target).toEqual(["STORAGE_SQL", 23]);
      }
    }
    // VACUUM names no file: it still runs, on the source's own database.
    await source.exec("VACUUM");
    expect(await source.all("SELECT v FROM t")).toEqual([{ v: 99 }]);
    await reader.close();
    await source.close();
    expect(existsSync(fresh)).toBe(false);
    await expectLiveIntact(setup);
  });

  test("a backup writes only a new file: an existing file is refused by every name, and stays as it was", async () => {
    const setup = await liveAndSource();
    const { dir, live, linked, a, source } = setup;
    // Once A has closed, nothing claims the file: the backup refuses it because it exists.
    await a.run("INSERT INTO t VALUES (2)");
    await a.close();
    const before = readFileSync(live);
    for (const dest of [live, linked]) {
      const error = await rejection(source.backup(dest, 100));
      expect([error.code, error.message], dest).toEqual([
        "STORAGE_MISUSE",
        "A backup writes a new file: its destination exists",
      ]);
    }
    expect(readFileSync(live)).toEqual(before);
    await source.close();
    expect(files(dir)).toEqual(["linked.db", "live.db"]);
  });
});

/** One spelling of a file, and what SQLite must act on for it. */
interface Spelling {
  name: string;
  /** The folder under the test's folder the file lies in. Created unless the spelling is refused. */
  folder: string;
  /** The spelling of the absolute path `file`. */
  spell: (file: string) => string;
  /** The code that refuses the spelling on this OS, or undefined: SQLite acts on `file` itself. */
  refused?: StorageErrorCode | undefined;
}

const SPELLINGS: Spelling[] = [
  { name: "a native absolute path", folder: "native", spell: (file) => file },
  {
    name: "a relative path",
    folder: "relative",
    spell: (file) => relative(process.cwd(), file),
  },
  {
    // Read as a URI, `file:/../<path>` would be a path from the root, with %41 decoded to A.
    name: "a path that starts with file:",
    folder: "a%41b",
    spell: (file) => `file:${sep}..${sep}${relative(process.cwd(), file)}`,
  },
  {
    name: "a path with ? and # in a folder name",
    folder: "q?x#y",
    spell: (file) => file,
    refused: WINDOWS ? "STORAGE_MISUSE" : undefined,
  },
  { name: "a path with # and % in a folder name", folder: "h#x%3Fy", spell: (file) => file },
  {
    name: "a file: URI",
    folder: "uri",
    spell: (file) => pathToFileURL(file).href,
    refused: URI_REFUSAL,
  },
  {
    name: "a file: URI with mode=rwc",
    folder: "uri-mode",
    spell: (file) => `${pathToFileURL(file).href}?mode=rwc`,
    refused: URI_REFUSAL,
  },
  {
    name: "a file: URI with cache=shared",
    folder: "uri-cache",
    spell: (file) => `${pathToFileURL(file).href}?cache=shared`,
    refused: URI_REFUSAL,
  },
];

describe("[A1.5.writer.file-names] SQLite acts on exactly the file the claim names, for every spelling", () => {
  for (const spelling of SPELLINGS) {
    test(spelling.name, async () => {
      const dir = temp.make();
      const folder = join(dir, spelling.folder);
      const [writerFile, backupFile] = [join(folder, "writer.db"), join(folder, "backup.db")];
      const [w1, w2] = [await startWorker(), await startWorker()];
      const source = await w2.open(join(temp.make(), "source.db"), "writer", { create: true });
      await source.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('copied')");
      // The folder exists wherever the OS allows its name, so a route that read the spelling as a
      // URI could create its file there.
      if (!WINDOWS || !spelling.folder.includes("?")) mkdirSync(folder);
      const { refused } = spelling;
      if (refused !== undefined) {
        // Refused by every route, and nothing appears anywhere.
        for (const attempt of [
          () => w1.open(spelling.spell(writerFile), "writer", { create: true }),
          () => w1.open(spelling.spell(writerFile), "reader"),
          () => source.backup(spelling.spell(backupFile), 100),
        ]) {
          expect((await rejection(attempt())).code).toBe(refused);
        }
        expect(files(dir)).toEqual([]);
        expectNoUriFolder();
        return;
      }
      // The writer route. While the worker is held, the claim is made before the file exists, so
      // it holds the path alone: the native path of the same file is refused by that path.
      const block = await blocked(w1, temp.make());
      const posted = sent(w1, "open");
      const opening = w1.open(spelling.spell(writerFile), "writer", { create: true });
      await posted;
      expect(existsSync(writerFile)).toBe(false);
      const early = await rejection(w2.open(writerFile, "writer", { create: true }));
      expect(early.code).toBe("SPACE_WRITER_TAKEN");
      await block.release();
      const conn = await opening;
      // SQLite created and wrote that file, and the claim holds it by both spellings.
      await conn.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('written')");
      for (const other of [writerFile, spelling.spell(writerFile)]) {
        expect((await rejection(w2.open(other, "writer"))).code, other).toBe("SPACE_WRITER_TAKEN");
      }
      await conn.close();
      // The reader route reads the same file.
      const reader = await w2.open(spelling.spell(writerFile), "reader");
      expect(await reader.all("SELECT v FROM t")).toEqual([{ v: "written" }]);
      await reader.close();
      // The backup route writes that file, and only once: it writes only a new file.
      expect(await source.backup(spelling.spell(backupFile), 100)).toBeGreaterThan(0);
      const again = await rejection(source.backup(spelling.spell(backupFile), 100));
      expect(again.code).toBe("STORAGE_MISUSE");
      await source.close();
      const copy = openReader(await checkedDriver(), backupFile);
      expect(copy.prepare("SELECT v FROM t").all()).toEqual([{ v: "copied" }]);
      copy.close();
      // SQLite acted on these two files and on nothing else.
      expect(files(dir)).toEqual([relative(dir, backupFile), relative(dir, writerFile)].sort());
      expectNoUriFolder();
    });
  }

  test("a space under a folder with # and % (and ? off Windows) opens and is claimed by its literal path", async () => {
    const parent = join(temp.make(), WINDOWS ? "h#x%3Fy" : "q?x#y%41");
    mkdirSync(parent);
    const created = await createFixtureSpace(parent);
    const [w1, w2] = [await startWorker(), await startWorker()];
    const writer = await w1.openSpaceWriter(created.folder, { machine: MACHINE });
    const request: WriteRequest = {
      space_id: created.space.spaceId,
      request_id: "file-names-request-000001",
      actor: {
        scope_id: "cli:fixture",
        principal_id: created.actors.human,
        actor_kind: "human",
        machine_id: TEST_MACHINE,
        origin: "cli",
      },
      ops: [{ kind: "task.create", title: "Fix the export" }],
    };
    expect((await writer.submit(request)).status).toBe("applied");
    const db = join(created.folder, "space.db");
    expect((await rejection(w2.open(db, "writer"))).code).toBe("SPACE_WRITER_TAKEN");
    await writer.close();
    const { conn } = await w2.openSpaceReader(created.folder);
    expect(await conn.get("SELECT last_seq FROM space")).toEqual({ last_seq: 2 });
    await conn.close();
    expect(readdirSync(parent)).toEqual(["mira"]);
  });
});
