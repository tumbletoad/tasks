// The driver contract suite (A1 3.19, A1 5). Every SqliteDriver implementation must pass it on
// Linux and Windows: a test file calls driverContract() with a factory for the driver. The suite
// lives in packages/storage, not testkit, because A7 3.2 gives testkit fixtures, sample spaces
// and harnesses, and this suite needs nothing from them. It is exported as
// @ttasks/storage/driver-contract so a second driver (M3.13) can run it from wherever it lives.
//
// Every test works in its own temporary folder and removes it afterwards. A connection left open
// keeps its file locked on Windows, so a leak fails the test's clean-up there.
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  SINGLE_STEP,
  type Connection,
  type DriverName,
  type OpenOptions,
  type SqliteDriver,
} from "../src/driver.ts";
import { StorageError, type StorageErrorCode } from "../src/errors.ts";
import {
  BUSY_TIMEOUT_MS,
  READER_PRAGMAS,
  WRITER_PRAGMAS,
  openReader,
  openSpaceConnection,
  openWriter,
  type Role,
} from "../src/open.ts";
import { CheckedDriver, MIN_SQLITE_VERSION, versionAtLeast } from "../src/startup-check.ts";
import {
  StorageWorker,
  openSpaceConnections,
  type SpaceConnections,
} from "../src/worker/client.ts";
import { MISSING, OLD_VERSION, simulateBuild, type Missing } from "./simulated-builds.ts";

export interface DriverUnderTest {
  /** The driver's name. Storage workers load the driver by this name. */
  name: DriverName;
  create: () => SqliteDriver | Promise<SqliteDriver>;
}

// Fixture text only (the Mira sample space, reference prefix M).
const TITLE = "Draft the quarterly plan for Mira Okafor";
const SCHEMA =
  "CREATE TABLE tasks (id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL, " +
  "done INTEGER NOT NULL DEFAULT 0, blob BLOB) STRICT";
const INSERT = "INSERT INTO tasks (ref, title) VALUES ($ref, $title)";
const COUNT = "SELECT count(*) AS n FROM tasks";

/** A bound value that must never reach an error: a test fails when SECRET shows up anywhere. */
const SENTINEL = "fixture-secretmarker";
const SECRET = "secretmarker";
/** A bound value shaped like an identifier: nothing in its form tells it from a trigger's literal. */
const IDENTIFIER_SECRET = "SYNTHETIC_SECRET_42";
/** A trigger that raises with a bound value as its message (A1 3.19 typed errors). */
const RAISE_VALUE =
  "CREATE TRIGGER raise_value BEFORE INSERT ON tasks WHEN NEW.ref = 'M-raise' " +
  "BEGIN SELECT RAISE(ABORT, NEW.title); END";

/** 2^53 + 1, the first integer a JavaScript number cannot hold. */
const BEYOND = 9007199254740993n;

const NO_FTS5_WORKER = new URL("./no-fts5-worker.ts", import.meta.url);
const WINDOWS = process.platform === "win32";

/** Lets queued promise continuations and timers run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 20);
  });

/** Checks every way an error can be printed or sent for the sentinel's secret. */
function expectNoBoundValue(error: unknown): void {
  expect(error).toBeInstanceOf(StorageError);
  const e = error as StorageError;
  expect(e.cause).toBeUndefined();
  for (const view of [
    e.message,
    String(e),
    e.stack ?? "",
    JSON.stringify(e),
    JSON.stringify(e.toJSON()),
    inspect(e, { showHidden: true, depth: null }),
  ]) {
    expect(view).not.toContain(SECRET);
  }
}

/** Runs `fn` and returns the StorageError it threw. Fails when it threw anything else. */
function storageError(fn: () => unknown): StorageError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    return error as StorageError;
  }
  throw new Error("expected a StorageError, but nothing was thrown");
}

function expectCode(fn: () => unknown, code: StorageErrorCode): StorageError {
  const error = storageError(fn);
  expect(error.code).toBe(code);
  return error;
}

async function rejection(promise: Promise<unknown>): Promise<StorageError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    return error as StorageError;
  }
  throw new Error("expected a StorageError, but the promise resolved");
}

/** A driver that records each pragma a connection sets, in order, with the value read back. */
function recording(driver: SqliteDriver): { driver: SqliteDriver; log: string[] } {
  const log: string[] = [];
  const inner = new WeakMap<Connection, Connection>();
  const recorded: SqliteDriver = {
    name: driver.name,
    backup: (src, dest, opts) => driver.backup(inner.get(src) ?? src, dest, opts),
    open(path: string, opts: OpenOptions): Connection {
      const conn = driver.open(path, opts);
      // The first statement on the new connection reads the busy timeout the driver installed.
      log.push(`open busy_timeout=${String(conn.pragma("busy_timeout"))}`);
      const wrapped: Connection = {
        get inTransaction() {
          return conn.inTransaction;
        },
        exec: (sql) => {
          log.push(`exec ${sql}`);
          conn.exec(sql);
        },
        prepare: (sql) => {
          log.push(`prepare ${sql}`);
          return conn.prepare(sql);
        },
        pragma: (name, value) => {
          if (value !== undefined) log.push(`set ${name}`);
          return conn.pragma(name, value);
        },
        transaction: (mode, fn) => conn.transaction(mode, fn),
        close: () => {
          conn.close();
        },
      };
      inner.set(wrapped, conn);
      return wrapped;
    },
  };
  return { driver: recorded, log };
}

export function driverContract(subject: DriverUnderTest): void {
  let driver: SqliteDriver;
  let checked: CheckedDriver;
  let dir: string;
  const open: Connection[] = [];
  const workers: StorageWorker[] = [];

  /** Keeps the connection so the test's clean-up closes it, then returns it. */
  const keep = (conn: Connection): Connection => {
    open.push(conn);
    return conn;
  };
  const path = (name = "space.db"): string => join(dir, name);
  const writer = (name?: string, busyTimeoutMs?: number): Connection =>
    keep(
      openWriter(checked, path(name), {
        create: true,
        ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
      }),
    );
  /** A space database with the fixture table and `rows` tasks, closed again. */
  const seeded = (rows: number, name?: string): string => {
    const conn = openWriter(checked, path(name), { create: true });
    try {
      conn.exec(SCHEMA);
      const insert = conn.prepare(INSERT);
      conn.transaction("immediate", () => {
        for (let i = 1; i <= rows; i += 1) insert.run({ ref: `M-${String(i)}`, title: TITLE });
      });
    } finally {
      conn.close();
    }
    return path(name);
  };
  const startWorker = async (): Promise<StorageWorker> => {
    const worker = await StorageWorker.start({ driver: subject.name });
    workers.push(worker);
    return worker;
  };

  beforeAll(async () => {
    driver = await subject.create();
    checked = await CheckedDriver.check(driver);
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "storage-contract-"));
  });

  afterEach(async () => {
    for (const conn of open.splice(0)) conn.close();
    await Promise.all(workers.splice(0).map((w) => w.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  describe(`[A1.5.driver.contract] the ${subject.name} driver contract (A1 3.19)`, () => {
    test("names itself", () => {
      expect(driver.name).toBe(subject.name);
    });

    describe("open", () => {
      test("creates a database file only when asked to", () => {
        const opts = { readOnly: false, busyTimeoutMs: 0 };
        expectCode(() => driver.open(path(), opts), "STORAGE_CANT_OPEN");
        expect(existsSync(path())).toBe(false);
        const conn = keep(driver.open(path(), { ...opts, create: true }));
        conn.exec("CREATE TABLE t (x INTEGER) STRICT");
        expect(existsSync(path())).toBe(true);
      });

      test("installs the busy timeout before any statement runs", () => {
        const conn = keep(
          driver.open(path(), { readOnly: false, busyTimeoutMs: 1234, create: true }),
        );
        // The first statement on the connection reads it.
        expect(conn.pragma("busy_timeout")).toBe(1234);
      });

      test("keeps SQLite's defensive flag on", () => {
        const conn = writer();
        conn.exec(SCHEMA);
        conn.pragma("writable_schema", "ON");
        expect(() => {
          conn.exec("UPDATE sqlite_schema SET sql = sql");
        }).toThrow(StorageError);
      });

      test("opens the exact path, with spaces, #, %, ?, quotes, brackets and non-ASCII characters in it", () => {
        // A driver that opens through a file: URI must encode these, or SQLite opens another file.
        // Windows does not allow ? in a file name.
        const name = `Mira's space #1 100% é 名前 [x] {y} ;=&+,${WINDOWS ? "" : " ?"}`;
        const folder = join(dir, name);
        mkdirSync(folder);
        const file = join(folder, "space ü.db");
        const conn = openWriter(checked, file, { create: true });
        conn.exec(SCHEMA);
        conn.close();
        expect(readdirSync(dir)).toEqual([name]);
        expect(readdirSync(folder).sort()).toEqual(["space ü.db"]);
        const reader = keep(openReader(checked, file));
        expect(reader.prepare(COUNT).get()).toEqual({ n: 0 });
      });

      /** Creates, reopens and reads `file`, then checks it is the only file in its folder. */
      const createReopenRead = (file: string, folder: string, created: string): void => {
        const fresh = openWriter(checked, file, { create: true });
        fresh.exec(SCHEMA);
        fresh.prepare(INSERT).run({ ref: "M-1", title: TITLE });
        fresh.close();
        const again = openWriter(checked, file);
        again.prepare(INSERT).run({ ref: "M-2", title: TITLE });
        again.close();
        const reader = openReader(checked, file);
        expect(reader.prepare(COUNT).get()).toEqual({ n: 2 });
        reader.close();
        expect(readdirSync(folder)).toContain(created);
      };

      test.runIf(WINDOWS)(
        "opens a Windows path beyond MAX_PATH, plain and in its \\\\?\\ form: create, reopen, read-only",
        () => {
          let folder = dir;
          while (folder.length < 280) folder = join(folder, "a-folder-with-a-long-name");
          mkdirSync(folder, { recursive: true });
          createReopenRead(join(folder, "plain.db"), folder, "plain.db");
          createReopenRead(`\\\\?\\${join(folder, "extended.db")}`, folder, "extended.db");
          // A missing file in the extended form is still not created without `create`. (The
          // read-only connection closed last, so the -wal and -shm files stay next to each file.)
          expectCode(
            () => openWriter(checked, `\\\\?\\${join(folder, "gone.db")}`),
            "STORAGE_CANT_OPEN",
          );
          expect(
            readdirSync(folder)
              .filter((f) => !f.endsWith("-wal") && !f.endsWith("-shm"))
              .sort(),
          ).toEqual(["extended.db", "plain.db"]);
        },
      );

      test.runIf(WINDOWS)(
        "opens a Windows UNC path, through the loopback administrative share when it exists",
        (context) => {
          // \\127.0.0.1\C$\... reaches the same folder over SMB. Without the share (no admin
          // shares, or no SMB client) the case cannot be qualified on this machine.
          const share = `\\\\127.0.0.1\\${dir.slice(0, 1)}$${dir.slice(2)}`;
          if (!existsSync(share)) {
            context.skip("the loopback administrative share is not reachable");
            return;
          }
          createReopenRead(join(share, "unc.db"), dir, "unc.db");
          let deep = share;
          while (deep.length < 280) deep = join(deep, "a-folder-with-a-long-name");
          mkdirSync(deep, { recursive: true });
          createReopenRead(join(deep, "unc-long.db"), deep, "unc-long.db");
        },
      );

      test("refuses a negative busy timeout", () => {
        expectCode(
          () => driver.open(path(), { readOnly: false, busyTimeoutMs: -1, create: true }),
          "STORAGE_MISUSE",
        );
      });
    });

    describe("space connections (A1 3.9)", () => {
      test("the writer sets busy_timeout first, then A1's pragmas in order, each read back", async () => {
        const { driver: rec, log } = recording(driver);
        const checkedRec = await CheckedDriver.check(rec);
        log.length = 0; // the start-up check's own probe connection
        const conn = keep(openWriter(checkedRec, path(), { create: true }));
        expect(log).toEqual([
          `open busy_timeout=${String(BUSY_TIMEOUT_MS)}`,
          "set busy_timeout",
          ...WRITER_PRAGMAS.map((p) => `set ${p.name}`),
        ]);
        for (const p of WRITER_PRAGMAS) expect(conn.pragma(p.name)).toBe(p.expect);
        expect(conn.pragma("busy_timeout")).toBe(BUSY_TIMEOUT_MS);
      });

      test("a reader is read-only and query_only, with its pragmas in order", async () => {
        const file = seeded(1);
        const { driver: rec, log } = recording(driver);
        const checkedRec = await CheckedDriver.check(rec);
        log.length = 0;
        const conn = keep(openReader(checkedRec, file));
        expect(log).toEqual([
          `open busy_timeout=${String(BUSY_TIMEOUT_MS)}`,
          "set busy_timeout",
          ...READER_PRAGMAS.map((p) => `set ${p.name}`),
        ]);
        for (const p of READER_PRAGMAS) expect(conn.pragma(p.name)).toBe(p.expect);
        expect(conn.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 1 });
        expectCode(
          () => conn.prepare(INSERT).run({ ref: "M-2", title: TITLE }),
          "STORAGE_READ_ONLY",
        );
        expectCode(() => {
          conn.exec("CREATE TEMP TABLE scratch (x INTEGER)");
        }, "STORAGE_READ_ONLY");
      });

      test("a role other than writer or reader is refused before anything opens", () => {
        expectCode(
          () => openSpaceConnection(checked, path(), "maintenance" as Role, { create: true }),
          "STORAGE_MISUSE",
        );
        expect(readdirSync(dir)).toEqual([]);
      });

      test("a missing database fails with STORAGE_CANT_OPEN and creates nothing", () => {
        expectCode(() => openWriter(checked, path()), "STORAGE_CANT_OPEN");
        expectCode(() => openReader(checked, path()), "STORAGE_CANT_OPEN");
        expect(readdirSync(dir)).toEqual([]);
      });

      test("a missing folder fails with STORAGE_CANT_OPEN, even when creating", () => {
        expectCode(
          () => openWriter(checked, join(dir, "gone", "space.db"), { create: true }),
          "STORAGE_CANT_OPEN",
        );
        expect(readdirSync(dir)).toEqual([]);
      });

      test("a file that is not a database fails with STORAGE_CORRUPT and stays as it was", () => {
        const bytes = Buffer.from(TITLE.repeat(200));
        writeFileSync(path(), bytes);
        expectCode(() => openWriter(checked, path()), "STORAGE_CORRUPT");
        expectCode(() => openReader(checked, path()), "STORAGE_CORRUPT");
        expect(readFileSync(path()).equals(bytes)).toBe(true);
        // The failed opens left no handle: the file can be removed at once, also on Windows.
        rmSync(path());
        expect(readdirSync(dir)).toEqual([]);
      });

      test("a damaged page fails the read that reaches it with STORAGE_CORRUPT", () => {
        const file = seeded(500);
        const pageSize = 4096;
        const bytes = readFileSync(file);
        expect(bytes.readUInt16BE(16)).toBe(pageSize);
        // Page 2 is the root page of the first table. Overwrite it with garbage.
        bytes.fill(0xa5, pageSize, 2 * pageSize);
        writeFileSync(file, bytes);
        const conn = writer();
        expectCode(() => conn.prepare("SELECT * FROM tasks").all(), "STORAGE_CORRUPT");
      });
    });

    describe("statements", () => {
      test("run reports changes and the last rowid, and get, all and iterate read rows", () => {
        const conn = writer();
        conn.exec(SCHEMA);
        const insert = conn.prepare(INSERT);
        expect(insert.run({ ref: "M-1", title: TITLE })).toEqual({
          changes: 1,
          lastInsertRowid: 1n,
        });
        expect(insert.run({ ref: "M-2", title: TITLE })).toEqual({
          changes: 1,
          lastInsertRowid: 2n,
        });
        expect(conn.prepare("UPDATE tasks SET done = 1").run()).toEqual({
          changes: 2,
          lastInsertRowid: 2n,
        });
        const byRef = conn.prepare("SELECT ref, done FROM tasks WHERE ref = $ref");
        expect(byRef.get({ ref: "M-2" })).toEqual({ ref: "M-2", done: 1 });
        expect(byRef.get({ ref: "M-3" })).toBeUndefined();
        const all = conn.prepare("SELECT ref FROM tasks ORDER BY id");
        expect(all.all()).toEqual([{ ref: "M-1" }, { ref: "M-2" }]);
        expect([...all.iterate<{ ref: string }>()].map((r) => r.ref)).toEqual(["M-1", "M-2"]);
      });

      test("text, integers, reals, null and bytes round-trip", () => {
        const conn = writer();
        conn.exec("CREATE TABLE v (t TEXT, i INTEGER, r REAL, n TEXT, b BLOB) STRICT");
        const blob = new Uint8Array([0, 1, 2, 250, 255]);
        conn
          .prepare("INSERT INTO v VALUES ($t, $i, $r, $n, $b)")
          .run({ t: TITLE, i: 2 ** 52, r: 0.25, n: null, b: blob });
        const row = conn.prepare("SELECT * FROM v").get<Record<string, unknown>>();
        expect(row).toMatchObject({ t: TITLE, i: 2 ** 52, r: 0.25, n: null });
        expect(new Uint8Array(row?.["b"] as Uint8Array)).toEqual(blob);
      });

      test("integers read back exactly: numbers up to 2^53 - 1, bigints beyond, never rounded", () => {
        const conn = writer();
        conn.exec("CREATE TABLE n (id INTEGER PRIMARY KEY, v INTEGER) STRICT");
        const max = Number.MAX_SAFE_INTEGER;
        conn.exec(
          `INSERT INTO n VALUES (1, ${String(max)}), (2, ${String(BEYOND)}), ` +
            `(3, ${String(-BEYOND)}), (4, ${String(-max)})`,
        );
        const expected = [{ v: max }, { v: BEYOND }, { v: -BEYOND }, { v: -max }];
        const select = conn.prepare("SELECT v FROM n ORDER BY id");
        expect(select.all()).toEqual(expected);
        expect([...select.iterate()]).toEqual(expected);
        expect(conn.prepare("SELECT v FROM n WHERE id = 2").get()).toEqual({ v: BEYOND });
        expect(conn.pragma("user_version")).toBe(0);
        // A bigint binds as an exact integer, so a value read back can be written back.
        const echo = conn.prepare("SELECT $v AS v, typeof($v) AS t");
        expect(echo.get({ v: BEYOND })).toEqual({ v: BEYOND, t: "integer" });
        expect(echo.get({ v: 7n })).toEqual({ v: 7, t: "integer" });
        expect(conn.prepare("SELECT v FROM n WHERE v = $v").get({ v: -BEYOND })).toEqual({
          v: -BEYOND,
        });
      });

      test("run reports the last rowid as a bigint, and nothing fails after the write", () => {
        const conn = writer();
        conn.exec("CREATE TABLE n (id INTEGER PRIMARY KEY, v INTEGER) STRICT");
        // A rowid beyond 2^53: converting it to a number would fail after the implicit commit.
        expect(conn.prepare(`INSERT INTO n (id) VALUES (${String(BEYOND)})`).run()).toEqual({
          changes: 1,
          lastInsertRowid: BEYOND,
        });
        expect(conn.prepare("INSERT INTO n (v) VALUES (1)").run()).toEqual({
          changes: 1,
          lastInsertRowid: BEYOND + 1n,
        });
        // A write that returns rows reads them exactly too.
        expect(
          conn.prepare(`INSERT INTO n (id) VALUES (${String(-BEYOND)}) RETURNING id`).get(),
        ).toEqual({ id: -BEYOND });
        expect(conn.prepare("SELECT count(*) AS n FROM n").get()).toEqual({ n: 3 });
      });

      test("every parameter the statement names must be supplied, and nothing else, before anything runs", () => {
        const conn = writer();
        conn.exec("CREATE TABLE p (a TEXT, b TEXT) STRICT");
        const insert = conn.prepare("INSERT INTO p VALUES ($a, $b)");
        const refused: (() => unknown)[] = [
          () => insert.run({ a: TITLE }),
          () => insert.run({ a: TITLE, b: undefined as unknown as null }),
          () => insert.run(),
          () => insert.run({ a: TITLE, b: TITLE, c: TITLE }),
          // Keys are bare names: the placeholder's own spelling is not a key.
          () => insert.run({ $a: TITLE, b: TITLE }),
          // A value SQLite would turn into NULL, or that is not a SQL value at all.
          () => insert.run({ a: Number.NaN, b: TITLE }),
          () => insert.run({ a: true as unknown as null, b: TITLE }),
          () => insert.run({ a: {} as unknown as null, b: TITLE }),
          () => insert.run({ a: 2n ** 63n, b: TITLE }),
        ];
        for (const call of refused) expectCode(call, "STORAGE_MISUSE");
        expect(conn.prepare("SELECT count(*) AS n FROM p").get()).toEqual({ n: 0 });
        // An explicit null is a value.
        insert.run({ a: TITLE, b: null });
        const select = conn.prepare("SELECT a FROM p WHERE a = $a AND b IS $b");
        expectCode(() => select.get({ a: TITLE }), "STORAGE_MISUSE");
        expectCode(() => select.all({ a: TITLE }), "STORAGE_MISUSE");
        expectCode(() => select.iterate({ a: TITLE }), "STORAGE_MISUSE");
        expect(select.get({ a: TITLE, b: null })).toEqual({ a: TITLE });
        expect([...select.iterate({ a: TITLE, b: null })]).toEqual([{ a: TITLE }]);
        // A statement without parameters takes none.
        const plain = conn.prepare("SELECT 1 AS one");
        expectCode(() => plain.get({ x: 1 }), "STORAGE_MISUSE");
        expect(plain.get({})).toEqual({ one: 1 });
        expect(conn.prepare("SELECT count(*) AS n FROM p").get()).toEqual({ n: 1 });
      });

      test("named parameters use $, : or @ with bare keys, and positional ones are refused", () => {
        const conn = writer();
        const sql = "SELECT $a AS a, :b AS b, @c AS c, $a AS again";
        expect(conn.prepare(sql).get({ a: 1, b: 2, c: 3 })).toEqual({ a: 1, b: 2, c: 3, again: 1 });
        for (const refused of [
          "SELECT ? AS a",
          "SELECT ?1 AS a",
          "SELECT $a AS a, :a AS b",
          "SELECT $a::b AS a",
          "SELECT $a(b) AS a",
        ]) {
          expectCode(() => conn.prepare(refused), "STORAGE_MISUSE");
        }
        // Text that only looks like a placeholder: strings, quoted names, comments, identifiers.
        const lookalikes = conn.prepare(
          "SELECT '$a :b @c ? it''s' AS \"$d\", 1 AS [@e], 2 AS `:f`, 3 AS g$h -- $i ?\n" +
            "/* :j @k ? */",
        );
        expect(lookalikes.get()).toEqual({ $d: "$a :b @c ? it's", "@e": 1, ":f": 2, g$h: 3 });
      });

      test("exec refuses SQL with a placeholder before running any of it, and prepare takes one statement", () => {
        const conn = writer();
        conn.exec("CREATE TABLE p (a TEXT) STRICT");
        expectCode(() => {
          conn.exec("INSERT INTO p VALUES ('first'); INSERT INTO p VALUES ($a)");
        }, "STORAGE_MISUSE");
        expect(conn.prepare("SELECT count(*) AS n FROM p").get()).toEqual({ n: 0 });
        // A dollar sign in a string is text.
        conn.exec("INSERT INTO p VALUES ('$a costs :b')");
        expect(conn.prepare("SELECT a FROM p").all()).toEqual([{ a: "$a costs :b" }]);
        // SQLite would prepare the first statement and drop the rest without a word.
        expectCode(() => conn.prepare("SELECT 1 AS one; DELETE FROM p"), "STORAGE_MISUSE");
        expect(conn.prepare("SELECT 1 AS one; -- done\n").get()).toEqual({ one: 1 });
        expect(conn.prepare("SELECT count(*) AS n FROM p").get()).toEqual({ n: 1 });
      });

      test("an earlier iteration can neither advance nor reset a later use of its statement", () => {
        const conn = writer();
        conn.exec(SCHEMA);
        // Review round 2: an earlier iteration's cleanup reset the execution that had replaced
        // it, and that one then ran its INSERT a second time.
        const insert = conn.prepare(
          "INSERT INTO tasks (ref, title) VALUES ($ref, $title) RETURNING id",
        );
        const a = insert.iterate({ ref: "M-1", title: TITLE });
        expect(a.next().value).toEqual({ id: 1 });
        const b = insert.iterate({ ref: "M-2", title: TITLE });
        expect(b.next().value).toEqual({ id: 2 });
        a.return?.();
        expect(b.next().done).toBe(true);
        const select = conn.prepare("SELECT ref FROM tasks ORDER BY id");
        expect(select.all()).toEqual([{ ref: "M-1" }, { ref: "M-2" }]);
        // A read: once the statement is used again, the earlier iteration is refused, so it can
        // never hand out a row of the later one, and the later one is not disturbed.
        const first = select.iterate();
        expect(first.next().value).toEqual({ ref: "M-1" });
        const second = select.iterate();
        expect(second.next().value).toEqual({ ref: "M-1" });
        expectCode(() => first.next(), "STORAGE_MISUSE");
        expect(second.next().value).toEqual({ ref: "M-2" });
        expect(second.next().done).toBe(true);
        // run(), get() and all() end an earlier iteration too.
        for (const use of [() => select.all(), () => select.get(), () => select.run()]) {
          const earlier = select.iterate();
          expect(earlier.next().value).toEqual({ ref: "M-1" });
          use();
          expectCode(() => earlier.next(), "STORAGE_MISUSE");
        }
        expect(select.all()).toEqual([{ ref: "M-1" }, { ref: "M-2" }]);
      });

      test("ending an iteration early releases its read snapshot, so a checkpoint completes", () => {
        const file = seeded(20);
        const w = keep(openWriter(checked, file, { busyTimeoutMs: 100 }));
        const r = keep(openReader(checked, file));
        const select = r.prepare("SELECT ref FROM tasks ORDER BY id");
        let next = 100;
        const checkpoint = (): unknown => {
          next += 1;
          w.prepare(INSERT).run({ ref: `M-${String(next)}`, title: TITLE });
          return w.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        };
        expect(checkpoint()).toMatchObject({ busy: 0 });
        // break
        for (const row of select.iterate()) {
          expect(row).toEqual({ ref: "M-1" });
          break;
        }
        expect(checkpoint()).toMatchObject({ busy: 0 });
        // return from inside the loop
        const first = (): unknown => {
          for (const row of select.iterate()) return row;
          return undefined;
        };
        expect(first()).toEqual({ ref: "M-1" });
        expect(checkpoint()).toMatchObject({ busy: 0 });
        // an exception in the loop body
        expect(() => {
          for (const row of select.iterate()) throw new Error(`stop at ${JSON.stringify(row)}`);
        }).toThrow("stop at");
        expect(checkpoint()).toMatchObject({ busy: 0 });
        // return() by hand
        const rows = select.iterate();
        expect(rows.next().value).toEqual({ ref: "M-1" });
        rows.return?.();
        expect(checkpoint()).toMatchObject({ busy: 0 });
        // get() reads one row of many and lets go
        expect(select.get()).toEqual({ ref: "M-1" });
        expect(checkpoint()).toMatchObject({ busy: 0 });
        // An iterator left unfinished holds the snapshot until the statement's next use.
        const abandoned = select.iterate();
        expect(abandoned.next().value).toEqual({ ref: "M-1" });
        expect(checkpoint()).toMatchObject({ busy: 1 });
        expect(select.all()).toHaveLength(27);
        expect(checkpoint()).toMatchObject({ busy: 0 });
        // The reader stayed open and sees every commit.
        expect(r.prepare(COUNT).get()).toEqual({ n: 28 });
      });

      test("prepare caches statements by SQL text", () => {
        const conn = writer();
        const sql = "SELECT 1 AS one";
        expect(conn.prepare(sql)).toBe(conn.prepare(sql));
        expect(conn.prepare(sql)).not.toBe(conn.prepare("SELECT 2 AS two"));
      });

      test("pragma takes a plain name and value only", () => {
        const conn = writer();
        expect(conn.pragma("user_version")).toBe(0);
        conn.pragma("user_version", 7);
        expect(conn.pragma("user_version")).toBe(7);
        expectCode(() => conn.pragma("user_version; DROP TABLE x"), "STORAGE_MISUSE");
        expectCode(() => conn.pragma("user_version", "1; DROP TABLE x"), "STORAGE_MISUSE");
        expectCode(() => conn.pragma("user_version", 1.5), "STORAGE_MISUSE");
      });
    });

    describe("transactions", () => {
      test("commit what the function wrote and return its value", () => {
        const conn = writer();
        conn.exec(SCHEMA);
        const result = conn.transaction("immediate", () => {
          expect(conn.inTransaction).toBe(true);
          return conn.prepare(INSERT).run({ ref: "M-1", title: TITLE }).lastInsertRowid;
        });
        expect(result).toBe(1n);
        expect(conn.inTransaction).toBe(false);
        const other = writer();
        expect(other.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 1 });
      });

      test("roll back when the function throws, and rethrow the same error", () => {
        const conn = writer();
        conn.exec(SCHEMA);
        const failure = new Error("stop here");
        expect(() =>
          conn.transaction("deferred", () => {
            conn.prepare(INSERT).run({ ref: "M-1", title: TITLE });
            throw failure;
          }),
        ).toThrow(failure);
        expect(conn.inTransaction).toBe(false);
        expect(conn.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
      });

      test("roll back a statement error inside the transaction", () => {
        const conn = writer();
        conn.exec(SCHEMA);
        expectCode(() => {
          conn.transaction("immediate", () => {
            conn.prepare(INSERT).run({ ref: "M-1", title: TITLE });
            conn.prepare(INSERT).run({ ref: "M-1", title: TITLE });
          });
        }, "STORAGE_CONSTRAINT");
        expect(conn.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
      });

      test("do not nest", () => {
        const conn = writer();
        expectCode(
          () => conn.transaction("immediate", () => conn.transaction("immediate", () => 1)),
          "STORAGE_MISUSE",
        );
        expect(conn.inTransaction).toBe(false);
      });

      test("refuse an async or generator function before it runs, and stay usable", async () => {
        const conn = writer();
        conn.exec(SCHEMA);
        let ran = false;
        // The body after an await would run outside the transaction, so it never starts.
        const awaits = async (): Promise<void> => {
          ran = true;
          conn.prepare(INSERT).run({ ref: "M-1", title: TITLE });
          await Promise.resolve();
          conn.prepare(INSERT).run({ ref: "M-2", title: TITLE });
        };
        // A generator's body runs only when it is iterated, after the commit.
        const generates = function* (): Generator<number> {
          ran = true;
          yield conn.prepare(INSERT).run({ ref: "M-3", title: TITLE }).changes;
        };
        const generatesLater = async function* (): AsyncGenerator<number> {
          ran = true;
          await Promise.resolve();
          yield conn.prepare(INSERT).run({ ref: "M-4", title: TITLE }).changes;
        };
        // A bound async function is still one, also when its type no longer says so.
        const bound = awaits.bind(undefined) as unknown as () => void;
        const calls: (() => unknown)[] = [
          () => {
            // @ts-expect-error -- an async function is not a transaction function (A1 3.19)
            void conn.transaction("immediate", awaits);
          },
          () => {
            conn.transaction("immediate", bound);
          },
          () => conn.transaction("deferred", generates),
          () => conn.transaction("deferred", generatesLater),
        ];
        for (const call of calls) expectCode(call, "STORAGE_MISUSE");
        await settle();
        expect(ran).toBe(false);
        expect(conn.inTransaction).toBe(false);
        expect(conn.prepare(COUNT).get()).toEqual({ n: 0 });
        conn.transaction("immediate", () => conn.prepare(INSERT).run({ ref: "M-5", title: TITLE }));
        expect(conn.prepare(COUNT).get()).toEqual({ n: 1 });
      });

      test("a returned promise rolls back, and its connection refuses every call until it is closed", async () => {
        const conn = writer();
        conn.exec(SCHEMA);
        const count = conn.prepare(COUNT);
        let late: unknown;
        // Not an async function, so it runs. Its continuation must not write afterwards.
        const returnsPromise = (): Promise<void> => {
          conn.prepare(INSERT).run({ ref: "M-1", title: TITLE });
          return Promise.resolve().then(() => {
            try {
              conn.prepare(INSERT).run({ ref: "M-2", title: TITLE });
            } catch (error) {
              late = error;
            }
          });
        };
        const refused = (): unknown =>
          // @ts-expect-error -- a function that returns a promise is not a transaction function
          conn.transaction("immediate", returnsPromise);
        expectCode(refused, "STORAGE_MISUSE");
        await settle();
        expect(late).toBeInstanceOf(StorageError);
        expect((late as StorageError).code).toBe("STORAGE_MISUSE");
        expect(conn.inTransaction).toBe(false);
        const calls: (() => unknown)[] = [
          () => {
            conn.exec("SELECT 1");
          },
          () => conn.prepare("SELECT 2 AS two"),
          () => conn.prepare(COUNT),
          () => conn.pragma("user_version"),
          () => conn.transaction("deferred", () => 1),
          () => count.get(),
          () => count.all(),
          () => count.run(),
          () => count.iterate(),
        ];
        for (const call of calls) expectCode(call, "STORAGE_MISUSE");
        // Nothing was committed, as another connection sees.
        expect(writer().prepare(COUNT).get()).toEqual({ n: 0 });
        conn.close();
        conn.close();
      });

      test("a returned rejected promise or thenable leaves no unhandled rejection", async () => {
        const unhandled: unknown[] = [];
        const listener = (reason: unknown): void => {
          unhandled.push(reason);
        };
        process.on("unhandledRejection", listener);
        try {
          const rejects = (): Promise<never> =>
            Promise.reject(new StorageError("STORAGE_SQL", "fixture rejection"));
          const thenable = (): { then: (ok: unknown, fail: (e: unknown) => void) => void } => ({
            then: (_ok, fail) => {
              fail(new StorageError("STORAGE_SQL", "fixture rejection"));
            },
          });
          // @ts-expect-error -- a function that returns a promise is not a transaction function
          expectCode(() => writer().transaction("immediate", rejects), "STORAGE_MISUSE");
          expectCode(() => writer().transaction("immediate", thenable), "STORAGE_MISUSE");
          await settle();
        } finally {
          process.off("unhandledRejection", listener);
        }
        expect(unhandled).toEqual([]);
      });

      test("BEGIN IMMEDIATE takes the write lock at the start, a deferred one does not", () => {
        const a = writer();
        a.exec(SCHEMA);
        const b = writer(undefined, 50);
        const insertB = b.prepare(INSERT);
        a.transaction("immediate", () => {
          const error = expectCode(() => b.transaction("immediate", () => 0), "STORAGE_BUSY");
          expect(error.retryable).toBe(true);
          expect(b.inTransaction).toBe(false);
        });
        a.transaction("deferred", () => {
          b.transaction("immediate", () => insertB.run({ ref: "M-1", title: TITLE }));
        });
        expect(a.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 1 });
      });
    });

    describe("typed errors", () => {
      test("each failure arrives as a StorageError with its code and no bound value", () => {
        const conn = writer();
        conn.exec(SCHEMA);
        conn.prepare(INSERT).run({ ref: "M-1", title: TITLE });
        const cases: [() => unknown, StorageErrorCode][] = [
          [() => conn.prepare("SELEC 1"), "STORAGE_SQL"],
          [() => conn.prepare("SELECT * FROM missing_table"), "STORAGE_SQL"],
          [() => conn.prepare(INSERT).run({ ref: "M-1", title: TITLE }), "STORAGE_CONSTRAINT"],
          [() => conn.prepare(INSERT).run({ ref: "M-2", title: null }), "STORAGE_CONSTRAINT"],
          [
            () => conn.prepare("UPDATE tasks SET done = $done").run({ done: TITLE }),
            "STORAGE_CONSTRAINT",
          ],
          [
            () => conn.prepare(INSERT).run({ ref: "M-3", title: TITLE, extra: 1 }),
            "STORAGE_MISUSE",
          ],
          [() => conn.prepare(INSERT).run({ ref: "M-3" }), "STORAGE_MISUSE"],
        ];
        for (const [fn, code] of cases) {
          const error = expectCode(fn, code);
          expect(error.message).not.toContain(TITLE);
          expect(JSON.stringify(error.toJSON())).not.toContain(TITLE);
        }
        expect(conn.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 1 });
      });

      test("no bound value reaches an error's message, JSON, text, stack or inspection", () => {
        const conn = writer();
        conn.exec(SCHEMA);
        conn.exec(RAISE_VALUE);
        conn.exec("CREATE TABLE short (x TEXT CHECK (length(x) < 5)) STRICT");
        conn.exec("CREATE VIRTUAL TABLE temp.search USING fts5(body)");
        conn.prepare(INSERT).run({ ref: "M-1", title: SENTINEL });
        const match = conn.prepare("SELECT * FROM search WHERE search MATCH $q");
        const cases: [string, () => unknown, StorageErrorCode][] = [
          [
            "unique",
            () => conn.prepare(INSERT).run({ ref: "M-1", title: SENTINEL }),
            "STORAGE_CONSTRAINT",
          ],
          [
            "check",
            () => conn.prepare("INSERT INTO short VALUES ($x)").run({ x: SENTINEL }),
            "STORAGE_CONSTRAINT",
          ],
          [
            "raise",
            () => conn.prepare(INSERT).run({ ref: "M-raise", title: SENTINEL }),
            "STORAGE_CONSTRAINT",
          ],
          ["fts5 column", () => match.all({ q: SENTINEL }), "STORAGE_SQL"],
          ["fts5 string", () => match.all({ q: `"${SENTINEL}` }), "STORAGE_SQL"],
          [
            "strict type",
            () => conn.prepare("UPDATE tasks SET done = $d").run({ d: SENTINEL }),
            "STORAGE_CONSTRAINT",
          ],
          [
            "unbindable value",
            () => conn.prepare(INSERT).run({ ref: "M-2", title: [SENTINEL] as unknown as null }),
            "STORAGE_MISUSE",
          ],
          [
            "sql text",
            () => {
              conn.exec(`SELECT * FROM ${SENTINEL.replace("-", "_")}`);
            },
            "STORAGE_SQL",
          ],
          [
            "sql argument",
            () => {
              conn.exec({ toString: () => SENTINEL } as unknown as string);
            },
            "STORAGE_MISUSE",
          ],
        ];
        for (const [label, fn, code] of cases) {
          const error = storageError(fn);
          expect([label, error.code]).toEqual([label, code]);
          expect(error.sqliteCode === undefined || Number.isInteger(error.sqliteCode)).toBe(true);
          expectNoBoundValue(error);
          expectNoBoundValue(StorageError.fromJSON(error.toJSON()));
        }
        expect(conn.prepare(COUNT).get()).toEqual({ n: 1 });
      });

      test("no RAISE message comes through, not even one shaped like an identifier", () => {
        const conn = writer();
        conn.exec(SCHEMA);
        conn.exec(RAISE_VALUE);
        conn.exec(
          "CREATE TRIGGER locked BEFORE UPDATE ON tasks WHEN OLD.done = 1 " +
            "BEGIN SELECT RAISE(ABORT, 'TASK_LOCKED'); END",
        );
        conn.prepare(INSERT).run({ ref: "M-1", title: TITLE });
        conn.exec("UPDATE tasks SET done = 1");
        // Review round 2: a literal in a trigger and a bound value look the same to the driver,
        // so a rule on the message's form let SYNTHETIC_SECRET_42 through. Neither passes now.
        const raised = [
          expectCode(() => {
            conn.exec("UPDATE tasks SET done = 0");
          }, "STORAGE_CONSTRAINT"),
          expectCode(
            () => conn.prepare(INSERT).run({ ref: "M-raise", title: IDENTIFIER_SECRET }),
            "STORAGE_CONSTRAINT",
          ),
        ];
        for (const error of raised) {
          expect(error.sqliteCode).toBe(1811); // SQLITE_CONSTRAINT_TRIGGER
          const copy = StorageError.fromJSON(error.toJSON());
          for (const text of [
            error.message,
            String(error),
            error.stack ?? "",
            JSON.stringify(error.toJSON()),
            inspect(error, { showHidden: true, depth: null }),
            inspect(copy, { showHidden: true, depth: null }),
          ]) {
            expect(text).not.toContain("TASK_LOCKED");
            expect(text).not.toContain(IDENTIFIER_SECRET);
          }
          expect(Object.keys(error.toJSON()).sort()).toEqual(["code", "message", "sqliteCode"]);
        }
        expect(conn.prepare(COUNT).get()).toEqual({ n: 1 });
      });
    });

    describe("close", () => {
      test("rolls back an open transaction, is safe twice and releases the file", () => {
        const file = seeded(0);
        const conn = openWriter(checked, file);
        conn.exec("BEGIN IMMEDIATE");
        conn.prepare(INSERT).run({ ref: "M-1", title: TITLE });
        conn.close();
        conn.close();
        const again = openWriter(checked, file);
        expect(again.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
        again.close();
        // Windows refuses to remove a file that a connection still holds.
        rmSync(file);
        expect(existsSync(file)).toBe(false);
      });

      test("a closed connection refuses further use with STORAGE_MISUSE", () => {
        const conn = openWriter(checked, path(), { create: true });
        const statement = conn.prepare("SELECT 1 AS one");
        conn.close();
        expect(conn.inTransaction).toBe(false);
        expectCode(() => {
          conn.exec("SELECT 1");
        }, "STORAGE_MISUSE");
        expectCode(() => conn.prepare("SELECT 2"), "STORAGE_MISUSE");
        expectCode(() => statement.get(), "STORAGE_MISUSE");
        expectCode(() => conn.pragma("user_version"), "STORAGE_MISUSE");
      });
    });

    describe("backup", () => {
      test("a single-step backup copies every page into a database that passes integrity_check", async () => {
        const file = seeded(300);
        const source = keep(openReader(checked, file));
        const pageCount = source.pragma("page_count");
        const pages = await driver.backup(source, path("copy.db"), { pagesPerStep: SINGLE_STEP });
        expect(pages).toBe(pageCount);
        const copy = keep(openReader(checked, path("copy.db")));
        expect(copy.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
        expect(copy.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 300 });
      });

      test("refuses a step size below one page, -1 included", async () => {
        const source = writer();
        for (const pagesPerStep of [-1, 0, 1.5]) {
          const error = await rejection(driver.backup(source, path("copy.db"), { pagesPerStep }));
          expect(error.code).toBe("STORAGE_MISUSE");
        }
        expect(existsSync(path("copy.db"))).toBe(false);
      });

      test("writes only a new file: a database, a second name, a link or a file with content is refused and stays as it was", async () => {
        const file = seeded(3);
        const source = keep(openReader(checked, seeded(1, "source.db")));
        const before = readFileSync(file);
        linkSync(file, path("linked.db"));
        writeFileSync(path("text.db"), TITLE);
        // An empty file with a second name is not a new file either.
        writeFileSync(path("empty-a.db"), "");
        linkSync(path("empty-a.db"), path("empty-b.db"));
        const existing = [file, path("linked.db"), path("text.db"), path("empty-b.db")];
        if (!WINDOWS) {
          symlinkSync(path("missing.db"), path("dangling.db"));
          writeFileSync(path("target.db"), "");
          symlinkSync(path("target.db"), path("symlink.db"));
          existing.push(path("dangling.db"), path("symlink.db"));
        }
        for (const dest of existing) {
          const error = await rejection(driver.backup(source, dest, { pagesPerStep: SINGLE_STEP }));
          expect(error.code, dest).toBe("STORAGE_MISUSE");
        }
        expect(readFileSync(file).equals(before)).toBe(true);
        expect(readFileSync(path("text.db"), "utf8")).toBe(TITLE);
        expect(existsSync(path("missing.db"))).toBe(false);
        // An empty file with no other name is one a caller created for the backup, as a storage
        // worker's claim does.
        writeFileSync(path("claimed.db"), "", { flag: "wx" });
        expect(await driver.backup(source, path("claimed.db"), { pagesPerStep: SINGLE_STEP })).toBe(
          source.pragma("page_count"),
        );
        const copy = keep(openReader(checked, path("claimed.db")));
        expect(copy.prepare(COUNT).get()).toEqual({ n: 1 });
      });

      test("reads a file: URI, or a path that starts with file:, as a path and never writes the file it names", async () => {
        const file = seeded(3);
        const source = keep(openReader(checked, seeded(1, "source.db")));
        const before = readFileSync(file);
        const uri = pathToFileURL(file).href;
        for (const dest of [uri, `${uri}?mode=rw`, `file:${file}`, `file:${file}?mode=rwc`]) {
          await rejection(driver.backup(source, dest, { pagesPerStep: SINGLE_STEP }));
        }
        expect(readFileSync(file).equals(before)).toBe(true);
        expect(
          readdirSync(dir)
            .filter((f) => !/-(?:wal|shm)$/.test(f))
            .sort(),
        ).toEqual(["source.db", "space.db"]);
      });
    });

    describe("SQL that names a file", () => {
      test("ATTACH and VACUUM INTO of a named file are refused on every connection, by any spelling, and VACUUM still runs", () => {
        const file = seeded(1);
        const target = path("target.db");
        const other = writer("other.db");
        const names = [file, target, pathToFileURL(target).href, `file:${target}?mode=rwc`];
        for (const conn of [other, keep(openReader(checked, file))]) {
          for (const name of [...names, ":memory:"]) {
            const quoted = `'${name.replaceAll("'", "''")}'`;
            for (const sql of [
              `ATTACH ${quoted} AS other`,
              `/* a comment */ attach /* another */ database ${quoted} as other`,
              `SELECT 1; ATTACH ${quoted} AS other`,
              `ATTACH ${quoted} || '' AS other`,
              `VACUUM INTO ${quoted}`,
              `VACUUM main INTO (SELECT ${quoted})`,
            ]) {
              const error = expectCode(() => {
                conn.exec(sql);
              }, "STORAGE_SQL");
              expect(error.sqliteCode, sql).toBe(23);
            }
            for (const sql of ["ATTACH $name AS other", "VACUUM INTO $name"]) {
              const error = expectCode(() => conn.prepare(sql).run({ name }), "STORAGE_SQL");
              expect(error.sqliteCode, sql).toBe(23);
            }
          }
        }
        // Nor can SQL set a folder for SQLite's files, by any spelling of the pragma.
        for (const conn of [other, keep(openReader(checked, file))]) {
          for (const sql of [
            `PRAGMA temp_store_directory = '${dir}'`,
            "pragma TEMP_STORE_DIRECTORY",
            `PRAGMA "data_store_directory" = '${dir}'`,
          ]) {
            const error = expectCode(() => {
              conn.exec(sql);
            }, "STORAGE_SQL");
            expect(error.sqliteCode, sql).toBe(23);
          }
          const error = expectCode(() => conn.pragma("temp_store_directory", "x"), "STORAGE_SQL");
          expect(error.sqliteCode).toBe(23);
        }
        expect(existsSync(target)).toBe(false);
        // VACUUM attaches no named file, so it still runs.
        other.exec(SCHEMA);
        other.exec("VACUUM");
        expect(other.prepare(COUNT).get()).toEqual({ n: 0 });
      });
    });
  });

  describe(`[A1.5.driver.startup-check] the ${subject.name} start-up check (A1 3.19)`, () => {
    test("passes, and reports the SQLite the driver itself runs", () => {
      const conn = writer();
      const version = conn.prepare("SELECT sqlite_version() AS v").get<{ v: string }>()?.v;
      expect(checked.report.driver).toBe(subject.name);
      expect(checked.report.sqliteVersion).toBe(version);
      expect(versionAtLeast(checked.report.sqliteVersion, MIN_SQLITE_VERSION)).toBe(true);
      expect(checked.report.compileOptions).toContain("ENABLE_FTS5");
    });

    const reasons: Record<Missing, RegExp> = {
      fts5: /FTS5 is not compiled in.*FTS5 table cannot be created/,
      version: new RegExp(`SQLite ${OLD_VERSION.replaceAll(".", "\\.")} is older than 3\\.45\\.0`),
      json: /JSON functions are missing/,
      strict: /STRICT table does not reject/,
      backup: /backup API does not work/,
    };

    test.each(MISSING)(
      "a simulated build without %s refuses to open any space",
      async (missing) => {
        const error = await rejection(CheckedDriver.check(simulateBuild(driver, missing)));
        expect(error.code).toBe("STORAGE_UNSUPPORTED");
        expect(error.message).toMatch(reasons[missing]);
        expect(error.message).toContain(subject.name);
        // The check runs in memory: nothing touched the folder the space would be in.
        expect(readdirSync(dir)).toEqual([]);
      },
    );

    test("a storage worker whose build lacks FTS5 refuses to start", async () => {
      const error = await rejection(
        StorageWorker.start({ driver: subject.name, entry: NO_FTS5_WORKER }),
      );
      expect(error.code).toBe("STORAGE_UNSUPPORTED");
      expect(error.message).toMatch(reasons.fts5);
    });
  });

  describe(`[A1.5.driver.worker] ${subject.name} connections in worker threads (A1 3.9)`, () => {
    test("a worker reports its check, runs statements and transactions, and errors arrive typed", async () => {
      const worker = await startWorker();
      expect(worker.report).toEqual(checked.report);
      const conn = await worker.open(path(), "writer", { create: true });
      expect(await conn.pragma("journal_mode")).toBe("wal");
      await conn.exec(SCHEMA);
      expect(await conn.run(INSERT, { ref: "M-1", title: TITLE })).toEqual({
        changes: 1,
        lastInsertRowid: 1n,
      });
      expect(await conn.get("SELECT ref, title FROM tasks")).toEqual({ ref: "M-1", title: TITLE });
      expect(await conn.get("SELECT ref FROM tasks WHERE ref = 'M-9'")).toBeUndefined();
      const error = await rejection(conn.run(INSERT, { ref: "M-1", title: TITLE }));
      expect(error.code).toBe("STORAGE_CONSTRAINT");
      expect(error.message).not.toContain(TITLE);
      const results = await conn.transaction("immediate", [
        { sql: INSERT, params: { ref: "M-2", title: TITLE }, mode: "run" },
        { sql: "SELECT count(*) AS n FROM tasks", mode: "get" },
      ]);
      expect(results[1]).toEqual({ n: 2 });
      // One failing query rolls back the whole transaction.
      const failed = await rejection(
        conn.transaction("immediate", [
          { sql: INSERT, params: { ref: "M-3", title: TITLE }, mode: "run" },
          { sql: INSERT, params: { ref: "M-1", title: TITLE }, mode: "run" },
        ]),
      );
      expect(failed.code).toBe("STORAGE_CONSTRAINT");
      expect(await conn.all("SELECT ref FROM tasks ORDER BY id")).toEqual([
        { ref: "M-1" },
        { ref: "M-2" },
      ]);
      await conn.close();
      expect((await rejection(conn.exec("SELECT 1"))).code).toBe("STORAGE_MISUSE");
    });

    test("a missing space fails to open in the worker with STORAGE_CANT_OPEN", async () => {
      const worker = await startWorker();
      expect((await rejection(worker.open(path(), "writer"))).code).toBe("STORAGE_CANT_OPEN");
      expect((await rejection(worker.open(path(), "reader"))).code).toBe("STORAGE_CANT_OPEN");
      expect(readdirSync(dir)).toEqual([]);
    });

    test("a closed worker refuses further calls", async () => {
      const worker = await StorageWorker.start({ driver: subject.name });
      const conn = await worker.open(path(), "writer", { create: true });
      await worker.close();
      await worker.close();
      expect((await rejection(conn.exec("SELECT 1"))).code).toBe("STORAGE_WORKER_FAILED");
      // Closing the worker closed its connection, so the file is free.
      rmSync(path());
    });

    test("two close() calls at the same moment both resolve", async () => {
      const worker = await StorageWorker.start({ driver: subject.name });
      await worker.open(path(), "writer", { create: true });
      await Promise.all([worker.close(), worker.close()]);
      await worker.close();
      rmSync(path());
    });

    test("errors cross the worker boundary with codes only, and integers stay exact", async () => {
      const worker = await startWorker();
      const conn = await worker.open(path(), "writer", { create: true });
      await conn.exec(SCHEMA);
      await conn.exec(RAISE_VALUE);
      const raised = await rejection(conn.run(INSERT, { ref: "M-raise", title: SENTINEL }));
      expect(raised.code).toBe("STORAGE_CONSTRAINT");
      expect(raised.sqliteCode).toBe(1811);
      expectNoBoundValue(raised);
      const shaped = await rejection(
        conn.run(INSERT, { ref: "M-raise", title: IDENTIFIER_SECRET }),
      );
      expect(shaped.sqliteCode).toBe(1811);
      expect(
        JSON.stringify(shaped.toJSON()) + String(shaped.stack) + inspect(shaped, { depth: null }),
      ).not.toContain(IDENTIFIER_SECRET);
      const missing = await rejection(conn.run(INSERT, { ref: "M-1" }));
      expect(missing.code).toBe("STORAGE_MISUSE");
      expectNoBoundValue(missing);
      expect((await rejection(conn.exec("DELETE FROM tasks WHERE ref = $ref"))).code).toBe(
        "STORAGE_MISUSE",
      );
      const big = `INSERT INTO tasks (id, ref, title) VALUES (${String(BEYOND)}, 'M-2', $title)`;
      expect(await conn.run(big, { title: TITLE })).toEqual({
        changes: 1,
        lastInsertRowid: BEYOND,
      });
      expect(await conn.get("SELECT id FROM tasks WHERE ref = 'M-2'")).toEqual({ id: BEYOND });
      expect(await conn.get("SELECT ref FROM tasks WHERE id = $id", { id: BEYOND })).toEqual({
        ref: "M-2",
      });
    });

    /**
     * Writes one task through the writer while both readers read, then checks that both readers
     * see it and cannot write.
     */
    const exercise = async (space: SpaceConnections, ref: string, total: number): Promise<void> => {
      const reads = space.readers.map((reader) =>
        reader.get<{ n: number }>("SELECT count(*) AS n FROM tasks"),
      );
      await space.writer.run(INSERT, { ref, title: TITLE });
      for (const row of await Promise.all(reads)) expect(row?.n).toBeGreaterThanOrEqual(total - 1);
      for (const reader of space.readers) {
        expect(await reader.get("SELECT count(*) AS n FROM tasks")).toEqual({ n: total });
        const error = await rejection(reader.run(INSERT, { ref: "M-99", title: TITLE }));
        expect(error.code).toBe("STORAGE_READ_ONLY");
      }
    };
    const startThree = (): Promise<StorageWorker[]> =>
      Promise.all([startWorker(), startWorker(), startWorker()]);
    const closeWorkers = async (): Promise<void> => {
      await Promise.all(workers.splice(0).map((worker) => worker.close()));
    };

    // The M0 storage bench saw "database is locked" in 5 of 15 starts while journal_mode came
    // before busy_timeout. That order is pinned at every open by "installs the busy timeout before
    // any statement runs" and the writer's pragma-order test; these rounds keep the real race of
    // three fresh workers on a real file. Three rounds in each of the two tests would still catch
    // that old bug about 9 times in 10.
    const ROUNDS = 3;

    test(
      "the writer opens first and two readers follow, on a new and on an existing space, every round",
      { timeout: 120_000 },
      async () => {
        for (let round = 1; round <= ROUNDS; round += 1) {
          const file = path(`round-${String(round)}.db`);
          const [w, r1, r2] = await startThree();
          const created = await openSpaceConnections(
            file,
            { writer: w as StorageWorker, readers: [r1 as StorageWorker, r2 as StorageWorker] },
            { create: true },
          );
          await created.writer.exec(SCHEMA);
          await exercise(created, "M-1", 1);
          await closeWorkers();
          const [w2, r3, r4] = await startThree();
          const reopened = await openSpaceConnections(file, {
            writer: w2 as StorageWorker,
            readers: [r3 as StorageWorker, r4 as StorageWorker],
          });
          await exercise(reopened, "M-2", 2);
          await closeWorkers();
        }
      },
    );

    test(
      "a writer and two readers that all open at the same moment never meet a locked database",
      { timeout: 120_000 },
      async () => {
        // The worst case, without the writer-first order: only busy_timeout as the first
        // statement keeps these opens from failing.
        for (let round = 1; round <= ROUNDS; round += 1) {
          const file = seeded(1, `round-${String(round)}.db`);
          const [w, r1, r2] = (await startThree()) as [StorageWorker, StorageWorker, StorageWorker];
          const [writer, ...readers] = await Promise.all([
            w.open(file, "writer"),
            r1.open(file, "reader"),
            r2.open(file, "reader"),
          ]);
          await exercise({ writer, readers }, "M-2", 2);
          await closeWorkers();
        }
      },
    );
  });
}
