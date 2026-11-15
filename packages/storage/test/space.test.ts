// Creating and opening a space folder (A1 3.1, 3.4, 3.5, 3.17): the folder and space.json, schema
// 0.1 with epoch 1 and a random authority incarnation, and every refusal open makes.
import { createHash } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Connection } from "../src/driver.ts";
import { StorageError } from "../src/errors.ts";
import { NODE_IO, type FileIo } from "../src/files.ts";
import { isId, type RandomSource } from "../src/ids.ts";
import { MANIFEST_FILE, readManifest } from "../src/manifest.ts";
import { openSpaceConnection, openWriter } from "../src/open.ts";
import {
  AUTO_VACUUM_INCREMENTAL,
  createSpaceWith,
  openSpace,
  openSpaceWith,
  type OpenedSpace,
  type SpaceSeams,
} from "../src/space.ts";
import { checkedDriver, createFixtureSpace, TEST_MACHINE, tempFolders } from "./space-helpers.ts";

const folders = tempFolders("space");
const open: Connection[] = [];

afterEach(() => {
  for (const conn of open.splice(0)) conn.close();
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

async function openAs(folder: string, role: "writer" | "reader"): Promise<OpenedSpace> {
  const opened = openSpace(await checkedDriver(), folder, { role });
  open.push(opened.conn);
  return opened;
}

/** A raw writer on the space's database, for tests that damage it. */
async function raw(folder: string): Promise<Connection> {
  const conn = openWriter(await checkedDriver(), join(folder, "space.db"));
  open.push(conn);
  return conn;
}

/** Closes a raw connection. The last one to close checkpoints and removes -wal and -shm. */
function closeRaw(conn: Connection): void {
  conn.close();
  open.splice(open.indexOf(conn), 1);
}

/** Every file in the folder with the SHA-256 of its bytes. */
function snapshot(folder: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(folder)
      .sort()
      .map((f) => [
        f,
        createHash("sha256")
          .update(readFileSync(join(folder, f)))
          .digest("hex"),
      ]),
  );
}

/** PRAGMA journal_mode of a database, read through a read-only connection. */
async function journalMode(path: string): Promise<unknown> {
  const conn = (await checkedDriver()).driver.open(path, { readOnly: true, busyTimeoutMs: 5000 });
  try {
    return conn.pragma("journal_mode");
  } finally {
    conn.close();
  }
}

/** A plain driver connection: none of a space connection's pragmas, journal_mode included. */
async function plain(path: string, readOnly = false): Promise<Connection> {
  return (await checkedDriver()).driver.open(path, { readOnly, busyTimeoutMs: 5000 });
}

/** Switches a closed space's database to rollback-journal (DELETE) mode. */
async function toDeleteMode(folder: string): Promise<void> {
  const conn = await plain(join(folder, "space.db"));
  conn.pragma("journal_mode", "DELETE");
  conn.close();
}

const JOURNAL = "space.db-journal";

/**
 * Leaves the closed database `db` as a crash in the middle of a rollback-journal transaction
 * leaves it: the pages the transaction spilled are in the file, and `<db>-journal` holds the
 * originals (a hot journal). Built on a copy in another folder, whose two files are copied back
 * while its transaction is open; the copy is then rolled back.
 */
async function crashWithHotJournal(db: string): Promise<void> {
  const source = join(folders.make(), "source.db");
  copyFileSync(db, source);
  const conn = await plain(source);
  try {
    conn.pragma("journal_mode", "DELETE");
    // A small cache makes the transaction spill pages into the file before it commits.
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
  // A journal is hot once it was synced: it then starts with its magic number, not a zero byte.
  expect(readFileSync(`${db}-journal`)[0]).toBe(0xd9);
}

/**
 * Leaves committed frames in `<db>-wal`, as a crash after a commit leaves them: the commit sets a
 * foreign application_id on a copy whose files are copied back before it closes (and checkpoints).
 */
async function crashWithFrames(db: string, withShm: boolean): Promise<void> {
  const source = join(folders.make(), "source.db");
  copyFileSync(db, source);
  const conn = await plain(source);
  try {
    conn.pragma("wal_autocheckpoint", 0);
    conn.pragma("application_id", 123);
    copyFileSync(source, db);
    copyFileSync(`${source}-wal`, `${db}-wal`);
    if (withShm) copyFileSync(`${source}-shm`, `${db}-shm`);
  } finally {
    conn.close();
  }
}

/**
 * Shows that SQLite would change the files: a copy of `files` in a fresh folder, opened by a plain
 * connection that reads once. Returns what changed there.
 */
async function sqliteWouldChange(
  folder: string,
  files: readonly string[],
  readOnly: boolean,
): Promise<string[]> {
  const copy = folders.make();
  for (const f of files) copyFileSync(join(folder, f), join(copy, f));
  const before = snapshot(copy);
  const conn = await plain(join(copy, "space.db"), readOnly);
  conn.pragma("application_id");
  conn.close();
  const after = snapshot(copy);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((f) => before[f] !== after[f])
    .sort();
}

/** Another application's SQLite file, in rollback-journal (DELETE) or WAL mode. */
async function foreignDatabase(path: string, mode: "delete" | "wal"): Promise<void> {
  const conn = (await checkedDriver()).driver.open(path, {
    create: true,
    readOnly: false,
    busyTimeoutMs: 5000,
  });
  if (mode === "wal") conn.pragma("journal_mode", "WAL");
  conn.exec("CREATE TABLE foreign_table (v INTEGER) STRICT; INSERT INTO foreign_table VALUES (1)");
  conn.close();
}

const SIDECARS = ["space.db-shm", "space.db-wal"];

/**
 * Checks that a refused open left the folder as it was: every file's bytes and the journal mode.
 * On a WAL database the read-only inspection creates the 0-byte -wal and the -shm and cannot
 * remove them (A1 3.1): nothing else may appear.
 */
async function expectUntouched(
  folder: string,
  before: Record<string, string>,
  mode: "delete" | "wal",
): Promise<void> {
  const after = snapshot(folder);
  const added = Object.keys(after).filter((f) => !(f in before));
  expect(added).toEqual(mode === "wal" ? SIDECARS : []);
  if (mode === "wal") expect(statSync(join(folder, "space.db-wal")).size).toBe(0);
  for (const [file, hash] of Object.entries(before)) expect(after[file], file).toBe(hash);
  expect(await journalMode(join(folder, "space.db"))).toBe(mode);
}

function rewriteManifest(folder: string, edit: (json: Record<string, unknown>) => void): void {
  const path = join(folder, MANIFEST_FILE);
  const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(json);
  writeFileSync(path, JSON.stringify(json));
}

/** A deterministic random source: a counter of bytes. */
function counterSource(): RandomSource {
  let next = 0;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = next++ & 255;
  };
}

describe("[A1.5.space.create-open] creating a space", () => {
  test("creates the folder with space.json and space.db, and nothing else", async () => {
    const parent = folders.make();
    const created = await createFixtureSpace(parent);
    expect(created.folder).toBe(join(parent, "mira"));
    expect(readdirSync(parent)).toEqual(["mira"]);
    expect(readdirSync(created.folder).sort()).toEqual(["space.db", "space.json"]);
  });

  test("the space row: schema 0.3, epoch 1, a random incarnation, an empty history", async () => {
    const { space, actors, manifest } = await createFixtureSpace(folders.make());
    expect(isId(space.spaceId, "sp")).toBe(true);
    expect(space.name).toBe("Mira");
    expect(space.refPrefix).toBe("M");
    expect(space.format).toEqual({ major: 0, minor: 3 });
    expect(space.lastSeq).toBe(0);
    expect(space.nextRef).toBe(1);
    expect(space.authority.machineId).toBe(TEST_MACHINE);
    expect(space.authority.epoch).toBe(1);
    expect(isId(space.authority.incarnation, "ai")).toBe(true);
    expect(space.authority.sinceSeq).toBe(0);
    expect(space.lineage).toEqual({
      forked_from: null,
      incarnations: [
        {
          incarnation: space.authority.incarnation,
          epoch: 1,
          kind: "create",
          parent: null,
          machine_id: TEST_MACHINE,
          at: space.createdAt,
        },
      ],
    });
    expect(space.transfer).toBeNull();
    expect(isId(actors.human, "ac") && isId(actors.system, "ac")).toBe(true);
    expect(manifest.space_id).toBe(space.spaceId);
  });

  test("space.json is A1 3.1's manifest, written from the database", async () => {
    const { folder, space } = await createFixtureSpace(folders.make());
    const text = readFileSync(join(folder, MANIFEST_FILE), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      tasks_space: 1,
      space_id: space.spaceId,
      name: "Mira",
      format: { major: 0, minor: 3 },
      min_reader: "0.0.0",
      min_writer: "0.0.0",
      authority: {
        machine_id: TEST_MACHINE,
        epoch: 1,
        incarnation: space.authority.incarnation,
        since_seq: 0,
      },
      lineage: space.lineage,
      transfer: null,
      written_by: "0.0.0",
    });
    expect(readManifest(folder)).toMatchObject({ state: "present", damaged: false });
  });

  test("the actors: the owner as a human and the system", async () => {
    const { folder, actors } = await createFixtureSpace(folders.make());
    const conn = (await openAs(folder, "reader")).conn;
    const rows = conn.prepare("SELECT id, kind, label FROM actors ORDER BY kind").all();
    expect(rows).toEqual([
      { id: actors.human, kind: "human", label: "Mira Okafor" },
      { id: actors.system, kind: "system", label: "System" },
    ]);
  });

  test("every space gets its own space ID and incarnation from the OS random source", async () => {
    const parent = folders.make();
    const a = await createFixtureSpace(parent, "a");
    const b = await createFixtureSpace(parent, "b");
    expect(a.space.spaceId).not.toBe(b.space.spaceId);
    expect(a.space.authority.incarnation).not.toBe(b.space.authority.incarnation);
  });

  test("an injected clock and random source give the same space twice", async () => {
    const make = () =>
      createFixtureSpace(folders.make(), "mira", { random: counterSource(), now: () => 1_000 });
    const [a, b] = [await make(), await make()];
    expect(a.space).toEqual(b.space);
    expect(a.actors).toEqual(b.actors);
    expect(a.space.createdAt).toBe(1_000);
  });

  test("the default reference prefix skips prefixes in use; an explicit one is kept", async () => {
    const parent = folders.make();
    expect((await createFixtureSpace(parent, "a", { takenPrefixes: ["M"] })).space.refPrefix).toBe(
      "MI",
    );
    expect((await createFixtureSpace(parent, "b", { refPrefix: "LUM" })).space.refPrefix).toBe(
      "LUM",
    );
  });

  test.skipIf(process.platform === "win32")(
    "owner-only modes: 0700 folder, 0600 files",
    async () => {
      const { folder } = await createFixtureSpace(folders.make());
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(join(folder, "space.db")).mode & 0o777).toBe(0o600);
      expect(statSync(join(folder, MANIFEST_FILE)).mode & 0o777).toBe(0o600);
    },
  );

  test("refuses an existing folder, a missing parent and bad options, leaving nothing", async () => {
    const parent = folders.make();
    await createFixtureSpace(parent);
    await expectCode(() => createFixtureSpace(parent), "SPACE_EXISTS");
    writeFileSync(join(parent, "file"), "");
    await expectCode(() => createFixtureSpace(parent, "file"), "SPACE_EXISTS");
    await expectCode(() => createFixtureSpace(join(parent, "missing")), "SPACE_NOT_FOUND");
    await expectCode(() => createFixtureSpace(parent, "Bad Slug"), "SPACE_PATH_INVALID");
    await expectCode(() => createFixtureSpace(parent, "x", { name: "" }), "STORAGE_MISUSE");
    await expectCode(() => createFixtureSpace(parent, "x", { name: "a\nb" }), "STORAGE_MISUSE");
    await expectCode(() => createFixtureSpace(parent, "x", { refPrefix: "M1" }), "STORAGE_MISUSE");
    await expectCode(
      () => createFixtureSpace(parent, "x", { machineId: "t_00000000000000000000000000" as never }),
      "STORAGE_MISUSE",
    );
    await expectCode(() => createFixtureSpace(parent, "x", { now: () => -1 }), "STORAGE_MISUSE");
    expect(readdirSync(parent).sort()).toEqual(["file", "mira"]);
  });

  test("a failure after the database is made removes the staging folder", async () => {
    const parent = folders.make();
    let calls = 0;
    // The third ID is drawn after the database file is open: fail there.
    const failing: RandomSource = (bytes) => {
      calls += 1;
      if (calls === 3) throw new Error("random source failed");
      bytes.fill(calls);
    };
    await expect(createFixtureSpace(parent, "mira", { random: failing })).rejects.toThrow(
      "random source failed",
    );
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe("[A1.5.space.create-open] opening a space", () => {
  test("the writer opens a fresh space without rewriting space.json", async () => {
    const { folder, space } = await createFixtureSpace(folders.make());
    const before = readFileSync(join(folder, MANIFEST_FILE), "utf8");
    const opened = await openAs(folder, "writer");
    expect(opened.space).toEqual(space);
    expect(opened.revision).toEqual({ major: 0, minor: 3 });
    expect(opened.readOnlyReasons).toEqual([]);
    expect(opened.manifestRebuilt).toBe(false);
    expect(readFileSync(join(folder, MANIFEST_FILE), "utf8")).toBe(before);
  });

  test("a reader opens a closed space and cannot write", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    const { conn } = await openAs(folder, "reader");
    expect(conn.pragma("query_only")).toBe(1);
    await expectCode(() => {
      conn.exec("UPDATE space SET name = 'x'");
    }, "STORAGE_READ_ONLY");
  });

  test("refuses a missing folder or database", async () => {
    const parent = folders.make();
    await expectCode(() => openAs(join(parent, "gone"), "writer"), "SPACE_NOT_FOUND");
    const { folder } = await createFixtureSpace(parent);
    rmSync(join(folder, "space.db"));
    await expectCode(() => openAs(folder, "writer"), "SPACE_NOT_FOUND");
    await expectCode(() => openAs(folder, "reader"), "SPACE_NOT_FOUND");
    // A missing database is never created again empty.
    expect(readdirSync(folder)).toEqual([MANIFEST_FILE]);
  });

  test("the writer rebuilds a missing or stale space.json from the database", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    const good = readFileSync(join(folder, MANIFEST_FILE), "utf8");
    const reopen = async () => {
      const opened = openSpace(await checkedDriver(), folder, { role: "writer" });
      opened.conn.close();
      return opened.manifestRebuilt;
    };
    rmSync(join(folder, MANIFEST_FILE));
    // A reader reads on without it and writes nothing.
    expect((await openAs(folder, "reader")).manifestRebuilt).toBe(false);
    expect(readdirSync(folder)).not.toContain(MANIFEST_FILE);
    expect(await reopen()).toBe(true);
    expect(readFileSync(join(folder, MANIFEST_FILE), "utf8")).toBe(good);
    // An invalid description with valid safety fields that allow the writer: rebuilt.
    rewriteManifest(folder, (json) => {
      json["lineage"] = {};
      json["name"] = "";
    });
    expect(await reopen()).toBe(true);
    expect(readFileSync(join(folder, MANIFEST_FILE), "utf8")).toBe(good);
    // A stale format, as a migration whose rewrite failed leaves it, is repaired (A1 3.1, 3.17).
    rewriteManifest(folder, (json) => {
      json["format"] = { major: 0, minor: 0 };
    });
    expect(await reopen()).toBe(true);
    expect(readFileSync(join(folder, MANIFEST_FILE), "utf8")).toBe(good);
    // The database wins: a changed name reaches space.json at the next writer open.
    const conn = await raw(folder);
    conn.exec("UPDATE space SET name = 'Mira O'");
    closeRaw(conn);
    expect(await reopen()).toBe(true);
    expect(readManifest(folder)).toMatchObject({ state: "present", manifest: { name: "Mira O" } });
    expect(await reopen()).toBe(false);
    expect(readdirSync(folder).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("a newer space.json is refused before SQLite opens the file", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    rewriteManifest(folder, (json) => {
      json["tasks_space"] = 2;
    });
    // Not a database at all: a refusal that read it would say STORAGE_CORRUPT.
    writeFileSync(join(folder, "space.db"), "not a database, and long enough to be read as one");
    await expectCode(() => openAs(folder, "writer"), "SPACE_TOO_NEW");
    await expectCode(() => openAs(folder, "reader"), "SPACE_TOO_NEW");
  });

  test("min_reader and min_writer newer than this build", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    rewriteManifest(folder, (json) => {
      json["min_writer"] = "99.0.0";
    });
    await expectCode(() => openAs(folder, "writer"), "SPACE_TOO_NEW");
    expect((await openAs(folder, "reader")).readOnlyReasons).toEqual(["newer_writer"]);
    rewriteManifest(folder, (json) => {
      json["min_reader"] = "99.0.0";
    });
    await expectCode(() => openAs(folder, "reader"), "SPACE_TOO_NEW");
    // A malformed app version is refused as an argument.
    await expectCode(
      async () => openSpace(await checkedDriver(), folder, { role: "reader", appVersion: "1" }),
      "STORAGE_MISUSE",
    );
  });

  test("a space.json that names another space: the writer refuses, a reader reads", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    rewriteManifest(folder, (json) => {
      json["space_id"] = "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf";
    });
    await expectCode(() => openAs(folder, "writer"), "SPACE_ID_MISMATCH");
    expect((await openAs(folder, "reader")).readOnlyReasons).toEqual(["space_id_mismatch"]);
  });

  test("a newer schema revision: the writer refuses, a reader with a manifest reads", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    const conn = await raw(folder);
    conn.pragma("user_version", 4);
    await expectCode(() => openAs(folder, "writer"), "SPACE_TOO_NEW");
    expect((await openAs(folder, "reader")).readOnlyReasons).toEqual(["newer_revision"]);
    rmSync(join(folder, MANIFEST_FILE));
    await expectCode(() => openAs(folder, "reader"), "SPACE_TOO_NEW");
  });

  test("an unknown schema revision is refused", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    const conn = await raw(folder);
    conn.pragma("user_version", 0);
    await expectCode(() => openAs(folder, "writer"), "SPACE_VERSION_UNKNOWN");
    conn.pragma("user_version", -5);
    await expectCode(() => openAs(folder, "reader"), "SPACE_VERSION_UNKNOWN");
  });

  test("another application's database, or a broken space row, is not a space", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    const conn = await raw(folder);
    conn.pragma("application_id", 1);
    await expectCode(() => openAs(folder, "writer"), "SPACE_INVALID");
    conn.pragma("application_id", 0x7a3c91e5);
    conn.exec("UPDATE space SET last_seq = 1152921504606846976");
    const error = await expectCode(() => openAs(folder, "reader"), "SPACE_INVALID");
    expect(error.message).toContain("space.last_seq");
    expect(error.message).not.toContain("1152921504606846976");
    conn.exec("UPDATE space SET last_seq = 0");
    conn.exec("DELETE FROM space");
    await expectCode(() => openAs(folder, "reader"), "SPACE_INVALID");
  });

  test("errors name no path", async () => {
    const parent = folders.make();
    const errors = [
      await expectCode(() => openAs(join(parent, "gone"), "writer"), "SPACE_NOT_FOUND"),
      await expectCode(() => createFixtureSpace(join(parent, "x", "y")), "SPACE_NOT_FOUND"),
      await expectCode(() => createFixtureSpace(parent, "Bad"), "SPACE_PATH_INVALID"),
    ];
    for (const error of errors) {
      expect(error.message).not.toContain(parent);
      expect(JSON.stringify(error)).not.toContain(parent);
    }
  });
});

describe("[A1.5.space.create-open] a refusal in phase 1 changes nothing in the database", () => {
  test("another application's DELETE-mode database keeps its bytes and its journal mode", async () => {
    // The reviewer's case: the writer used to set journal_mode=WAL before it read application_id.
    const { folder } = await createFixtureSpace(folders.make());
    const db = join(folder, "space.db");
    rmSync(db);
    await foreignDatabase(db, "delete");
    expect(await journalMode(db)).toBe("delete");
    const before = snapshot(folder);
    await expectCode(() => openAs(folder, "writer"), "SPACE_INVALID");
    await expectUntouched(folder, before, "delete");
    await expectCode(() => openAs(folder, "reader"), "SPACE_INVALID");
    await expectUntouched(folder, before, "delete");
  });

  // The Windows CI runner is slow: a space per case once took 8 s there against a 5 s limit.
  test("a foreign, unknown, newer or inconsistent database, in either journal mode", async () => {
    const damage: [string, string, (conn: Connection) => void][] = [
      ["foreign", "SPACE_INVALID", (c) => c.pragma("application_id", 0)],
      ["unknown revision", "SPACE_VERSION_UNKNOWN", (c) => c.pragma("user_version", 0)],
      ["newer revision", "SPACE_TOO_NEW", (c) => c.pragma("user_version", 4)],
      [
        "format 99 under revision 0.1",
        "SPACE_INVALID",
        (c) => {
          c.exec("UPDATE space SET format_major = 99, format_minor = 0");
        },
      ],
    ];
    for (const mode of ["delete", "wal"] as const) {
      for (const [label, code, edit] of damage) {
        const { folder } = await createFixtureSpace(folders.make());
        const conn = await raw(folder);
        edit(conn);
        if (mode === "delete") conn.pragma("journal_mode", "DELETE");
        closeRaw(conn);
        const before = snapshot(folder);
        expect(Object.keys(before), label).toEqual(["space.db", MANIFEST_FILE]);
        await expectCode(() => openAs(folder, "writer"), code);
        await expectUntouched(folder, before, mode);
        if (label !== "newer revision") {
          await expectCode(() => openAs(folder, "reader"), code);
        } else {
          // A reader with a manifest that vouches for the newer revision reads it.
          const reader = await openAs(folder, "reader");
          expect(reader.readOnlyReasons).toEqual(["newer_revision"]);
          closeRaw(reader.conn);
        }
        await expectUntouched(folder, before, mode);
      }
    }
  }, 30_000);

  test("a format the revision's step did not register is SPACE_INVALID and never copied", async () => {
    // The reviewer's case: user_version names this build's revision, the space row format 99.
    const { folder } = await createFixtureSpace(folders.make());
    const conn = await raw(folder);
    conn.exec("UPDATE space SET format_major = 99, format_minor = 0");
    closeRaw(conn);
    rmSync(join(folder, MANIFEST_FILE));
    const error = await expectCode(() => openAs(folder, "writer"), "SPACE_INVALID");
    expect(error.message).not.toContain("99");
    await expectCode(() => openAs(folder, "reader"), "SPACE_INVALID");
    expect(readdirSync(folder)).not.toContain(MANIFEST_FILE);
  });

  test("a read-only open of a closed WAL space leaves only an empty -wal and the -shm", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    const before = snapshot(folder);
    const reader = await openAs(folder, "reader");
    closeRaw(reader.conn);
    await expectUntouched(folder, before, "wal");
    // The next writer to close removes them again.
    closeRaw((await openAs(folder, "writer")).conn);
    expect(readdirSync(folder).sort()).toEqual(["space.db", MANIFEST_FILE]);
  });

  // The Windows CI runner is slow: a space per case once took 8 s there against a 5 s limit.
  test("a rollback journal, hot or not, makes reader and writer refuse before SQLite opens", async () => {
    const cases: [string, (folder: string) => void | Promise<void>][] = [
      [
        "an empty journal beside a WAL space",
        (folder) => {
          writeFileSync(join(folder, JOURNAL), "");
        },
      ],
      [
        "a stray journal beside a WAL space",
        (folder) => {
          writeFileSync(join(folder, JOURNAL), "not a journal");
        },
      ],
      [
        "a hot journal: a DELETE-mode space that crashed in a transaction",
        async (folder) => {
          await toDeleteMode(folder);
          await crashWithHotJournal(join(folder, "space.db"));
          // A writable connection would play it back at its first read.
          expect(await sqliteWouldChange(folder, ["space.db", JOURNAL], false)).toEqual([
            "space.db",
            JOURNAL,
          ]);
        },
      ],
    ];
    for (const [label, make] of cases) {
      const { folder } = await createFixtureSpace(folders.make());
      await make(folder);
      const before = snapshot(folder);
      for (const role of ["writer", "reader"] as const) {
        const error = await expectCode(() => openAs(folder, role), "SPACE_NEEDS_RECOVERY");
        expect(JSON.stringify(error), label).not.toContain(folder);
        // Refused before SQLite opened the file: not even the WAL sidecars appear.
        expect(snapshot(folder), `${label}, ${role}`).toEqual(before);
      }
    }
  }, 30_000);

  // The Windows CI runner is slow: a space per case once took 8 s there against a 5 s limit.
  test("a -wal with frames is read and kept: a refusal in phase 1 adds or rebuilds only the -shm", async () => {
    const cases: [string, (folder: string) => Promise<void>][] = [
      ["a crashed WAL space, -shm present", (f) => crashWithFrames(join(f, "space.db"), true)],
      ["a crashed WAL space, no -shm", (f) => crashWithFrames(join(f, "space.db"), false)],
      [
        "a DELETE-mode file with a stray -wal",
        async (f) => {
          const other = await createFixtureSpace(folders.make());
          await crashWithFrames(join(other.folder, "space.db"), false);
          await toDeleteMode(f);
          copyFileSync(join(other.folder, "space.db-wal"), join(f, "space.db-wal"));
        },
      ],
    ];
    for (const [label, make] of cases) {
      const { folder } = await createFixtureSpace(folders.make());
      await make(folder);
      const before = snapshot(folder);
      for (const role of ["writer", "reader"] as const) {
        // The foreign application_id is only in the -wal's frames: the refusal read them.
        await expectCode(() => openAs(folder, role), "SPACE_INVALID");
        const after = snapshot(folder);
        for (const file of ["space.db", "space.db-wal", MANIFEST_FILE]) {
          expect(after[file], `${label}, ${role}: ${file}`).toBe(before[file]);
        }
        const files = new Set([...Object.keys(before), "space.db-shm"]);
        expect(Object.keys(after).sort(), `${label}, ${role}`).toEqual([...files].sort());
      }
    }
  }, 30_000);

  test("an empty database file is refused before SQLite opens it, and a -wal beside it stays", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    writeFileSync(join(folder, "space.db"), "");
    writeFileSync(join(folder, "space.db-wal"), "frames of a database that is gone");
    // SQLite deletes a -wal beside an empty database at the first read, read-only or not.
    expect(await sqliteWouldChange(folder, ["space.db", "space.db-wal"], true)).toEqual([
      "space.db-wal",
    ]);
    const before = snapshot(folder);
    for (const role of ["writer", "reader"] as const) {
      await expectCode(() => openAs(folder, role), "SPACE_INVALID");
      expect(snapshot(folder), role).toEqual(before);
    }
  });
});

describe("[A1.5.space.create-open] the writer's second phase", () => {
  /** Opens the writer, running `swap` between the inspection and the writer's open. */
  async function openWithSwap(folder: string, swap: () => void): Promise<OpenedSpace> {
    const seams: SpaceSeams = { betweenPhases: swap };
    const opened = openSpaceWith(await checkedDriver(), folder, { role: "writer" }, seams);
    open.push(opened.conn);
    return opened;
  }

  test("another space's database swapped in after inspection: SPACE_CHANGED at the first read", async () => {
    const parent = folders.make();
    const { folder } = await createFixtureSpace(parent);
    const other = await createFixtureSpace(parent, "other");
    const db = join(folder, "space.db");
    const manifestBefore = readFileSync(join(folder, MANIFEST_FILE), "utf8");
    await expectCode(
      () =>
        openWithSwap(folder, () => {
          copyFileSync(join(other.folder, "space.db"), db);
        }),
      "SPACE_CHANGED",
    );
    expect(readFileSync(db)).toEqual(readFileSync(join(other.folder, "space.db")));
    expect(readFileSync(join(folder, MANIFEST_FILE), "utf8")).toBe(manifestBefore);
  });

  test("a DELETE-mode foreign file swapped in keeps its journal mode", async () => {
    const parent = folders.make();
    const { folder } = await createFixtureSpace(parent);
    const foreign = join(parent, "foreign.db");
    await foreignDatabase(foreign, "delete");
    const bytes = readFileSync(foreign);
    const db = join(folder, "space.db");
    await expectCode(
      () =>
        openWithSwap(folder, () => {
          copyFileSync(foreign, db);
        }),
      "SPACE_INVALID",
    );
    expect(readFileSync(db)).toEqual(bytes);
    expect(await journalMode(db)).toBe("delete");
    // The sidecars are phase 1's, from the WAL space it inspected before the swap: the -wal empty.
    expect(readdirSync(folder).sort()).toEqual(["space.db", ...SIDECARS, MANIFEST_FILE].sort());
    expect(statSync(join(folder, "space.db-wal")).size).toBe(0);
  });

  // The Windows CI runner is slow: a space per case once took 8 s there against a 5 s limit.
  test("a space.json changed after inspection is refused before any persistent pragma", async () => {
    // The reviewer's case: the manifest used to be compared after journal_mode=WAL, so a
    // DELETE-mode space came out of the refusal in WAL mode with other bytes.
    for (const mode of ["delete", "wal"] as const) {
      const { folder } = await createFixtureSpace(folders.make());
      if (mode === "delete") await toDeleteMode(folder);
      rewriteManifest(folder, (json) => {
        json["name"] = "";
      });
      const db = join(folder, "space.db");
      const bytes = readFileSync(db);
      let written = "";
      await expectCode(
        () =>
          openWithSwap(folder, () => {
            rewriteManifest(folder, (json) => {
              json["min_writer"] = "99.0.0";
            });
            written = readFileSync(join(folder, MANIFEST_FILE), "utf8");
          }),
        "SPACE_CHANGED",
      );
      expect(readFileSync(join(folder, MANIFEST_FILE), "utf8"), mode).toBe(written);
      expect(readFileSync(db), mode).toEqual(bytes);
      // Only phase 1's read-only sidecars, on the WAL space: the writer never read the file.
      const files =
        mode === "wal" ? ["space.db", ...SIDECARS, MANIFEST_FILE] : ["space.db", MANIFEST_FILE];
      expect(readdirSync(folder).sort(), mode).toEqual(files.sort());
      expect(await journalMode(db), mode).toBe(mode);
    }
  }, 30_000);

  // The Windows CI runner is slow: a space per case once took 8 s there against a 5 s limit.
  test("a database with a hot journal swapped in is refused before the first read, unchanged", async () => {
    // The reviewer's case: the writer's inspection read the replacement first, so SQLite played
    // its journal back (new bytes, no journal) before open refused it as SPACE_INVALID.
    for (const mode of ["delete", "wal"] as const) {
      const parent = folders.make();
      const { folder } = await createFixtureSpace(parent);
      if (mode === "delete") await toDeleteMode(folder);
      const foreign = await createFixtureSpace(parent, "foreign");
      const foreignDb = join(foreign.folder, "space.db");
      rmSync(foreignDb);
      await foreignDatabase(foreignDb, "delete");
      await crashWithHotJournal(foreignDb);
      expect(await sqliteWouldChange(foreign.folder, ["space.db", JOURNAL], false)).toEqual([
        "space.db",
        JOURNAL,
      ]);
      const bytes = readFileSync(foreignDb);
      const journal = readFileSync(join(foreign.folder, JOURNAL));
      const db = join(folder, "space.db");
      await expectCode(
        () =>
          openWithSwap(folder, () => {
            copyFileSync(foreignDb, db);
            copyFileSync(join(foreign.folder, JOURNAL), join(folder, JOURNAL));
          }),
        "SPACE_NEEDS_RECOVERY",
      );
      expect(readFileSync(db), mode).toEqual(bytes);
      expect(readFileSync(join(folder, JOURNAL)), mode).toEqual(journal);
    }
  }, 30_000);

  // The Windows CI runner is slow: a space per case once took 8 s there against a 5 s limit.
  test("a revision changed between the phases: SPACE_CHANGED before any persistent pragma", async () => {
    const checked = await checkedDriver();
    for (const mode of ["delete", "wal"] as const) {
      const { folder } = await createFixtureSpace(folders.make());
      if (mode === "delete") await toDeleteMode(folder);
      const db = join(folder, "space.db");
      let bytes = Buffer.alloc(0);
      await expectCode(
        () =>
          openWithSwap(folder, () => {
            const conn = checked.driver.open(db, { readOnly: false, busyTimeoutMs: 5000 });
            conn.pragma("user_version", 4);
            conn.close();
            bytes = readFileSync(db);
          }),
        "SPACE_CHANGED",
      );
      expect(readFileSync(db), mode).toEqual(bytes);
      expect(await journalMode(db), mode).toBe(mode);
    }
  }, 30_000);

  test("a database emptied between the phases is refused before the first read", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    const wal = join(folder, "space.db-wal");
    await expectCode(
      () =>
        openWithSwap(folder, () => {
          writeFileSync(join(folder, "space.db"), "");
          writeFileSync(wal, "frames of a database that is gone");
        }),
      "SPACE_INVALID",
    );
    // A first read would have deleted the -wal beside the empty file.
    expect(readFileSync(wal, "utf8")).toBe("frames of a database that is gone");
  });

  test("the inspection hook is refused for a reader, a new database or format pragmas", async () => {
    const checked = await checkedDriver();
    const dir = folders.make();
    const file = join(dir, "space.db");
    const inspect = (): void => undefined;
    const calls = [
      () => openWriter(checked, file, { inspect, create: true }),
      () => openWriter(checked, file, { inspect, formatPragmas: [AUTO_VACUUM_INCREMENTAL] }),
      () => openSpaceConnection(checked, file, "reader", { inspect }),
      () => openSpaceConnection(checked, file, "reader", { formatPragmas: [] }),
    ];
    for (const call of calls) await expectCode(call, "STORAGE_MISUSE");
    // Refused before the driver opened anything: no file was created.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("without a change in between, the writer opens with WAL and its pragmas", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    const opened = await openWithSwap(folder, () => undefined);
    expect(opened.conn.pragma("journal_mode")).toBe("wal");
    expect(opened.conn.pragma("foreign_keys")).toBe(1);
    expect(opened.conn.pragma("trusted_schema")).toBe(0);
  });
});

describe("[A1.5.space.manifest] open honours each safety field of space.json", () => {
  /** The bytes of space.json, to show a refused writer never rewrote it. */
  const manifestBytes = (folder: string): string =>
    readFileSync(join(folder, MANIFEST_FILE), "utf8");

  test("another space's database and a lineage of {}: still SPACE_ID_MISMATCH", async () => {
    // The reviewer's case: the invalid lineage used to discard the whole manifest, so the writer
    // adopted the replacement database and rewrote space_id.
    const parent = folders.make();
    const { folder, space } = await createFixtureSpace(parent);
    const other = await createFixtureSpace(parent, "other");
    copyFileSync(join(other.folder, "space.db"), join(folder, "space.db"));
    rewriteManifest(folder, (json) => {
      json["lineage"] = {};
    });
    const before = manifestBytes(folder);
    await expectCode(() => openAs(folder, "writer"), "SPACE_ID_MISMATCH");
    expect(manifestBytes(folder)).toBe(before);
    expect(JSON.parse(before)).toMatchObject({ space_id: space.spaceId });
    const reader = await openAs(folder, "reader");
    expect(reader.readOnlyReasons).toEqual(["space_id_mismatch"]);
    expect(reader.space.spaceId).toBe(other.space.spaceId);
  });

  test("an invalid name and min_writer 99.0.0: the writer still refuses", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    rewriteManifest(folder, (json) => {
      json["name"] = "";
      json["min_writer"] = "99.0.0";
    });
    const before = manifestBytes(folder);
    await expectCode(() => openAs(folder, "writer"), "SPACE_TOO_NEW");
    expect(manifestBytes(folder)).toBe(before);
    expect((await openAs(folder, "reader")).readOnlyReasons).toEqual(["newer_writer"]);
  });

  test("an invalid lineage and min_reader 99.0.0: the reader still refuses", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    rewriteManifest(folder, (json) => {
      json["lineage"] = { incarnations: "none" };
      json["min_reader"] = "99.0.0";
    });
    const before = snapshot(folder);
    await expectCode(() => openAs(folder, "reader"), "SPACE_TOO_NEW");
    await expectCode(() => openAs(folder, "writer"), "SPACE_TOO_NEW");
    // Refused before SQLite opened the file: not even the WAL sidecars appear.
    expect(snapshot(folder)).toEqual(before);
  });

  // The Windows CI runner is slow: a space per case once took 8 s there against a 5 s limit.
  test("a damaged space.json: the writer refuses and never rewrites it, a reader reads on", async () => {
    const cases: [string, (json: Record<string, unknown>) => unknown][] = [
      ["not JSON", () => "{ not json"],
      ["an array", (json) => [json]],
      ["no marker", (json) => ({ ...json, tasks_space: undefined })],
      ["an invalid space_id", (json) => ({ ...json, space_id: "sp_x" })],
      ["an invalid format", (json) => ({ ...json, format: { major: "0", minor: 1 } })],
      ["an invalid min_reader", (json) => ({ ...json, min_reader: "1.0" })],
      ["no min_writer", (json) => ({ ...json, min_writer: undefined })],
      ["over 64 KiB", (json) => ({ ...json, padding: "x".repeat(70_000) })],
    ];
    for (const [label, edit] of cases) {
      const { folder } = await createFixtureSpace(folders.make());
      const path = join(folder, MANIFEST_FILE);
      const edited = edit(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
      writeFileSync(path, typeof edited === "string" ? edited : JSON.stringify(edited));
      const before = manifestBytes(folder);
      const error = await expectCode(() => openAs(folder, "writer"), "SPACE_MANIFEST_DAMAGED");
      expect(error.message, label).not.toContain(folder);
      expect(manifestBytes(folder), label).toBe(before);
      const reader = await openAs(folder, "reader");
      expect(reader.readOnlyReasons, label).toEqual(["manifest_damaged"]);
      expect(reader.manifestRebuilt, label).toBe(false);
      expect(manifestBytes(folder), label).toBe(before);
      // The way out: remove it, and the writer rebuilds it from the database.
      rmSync(path);
      const writer = await openAs(folder, "writer");
      expect(writer.manifestRebuilt, label).toBe(true);
      expect(readManifest(folder), label).toMatchObject({ state: "present", damaged: false });
    }
  }, 30_000);

  test("a damaged field next to a valid min_writer 99.0.0: the reader names both", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    rewriteManifest(folder, (json) => {
      json["format"] = "0.1";
      json["min_writer"] = "99.0.0";
    });
    await expectCode(() => openAs(folder, "writer"), "SPACE_MANIFEST_DAMAGED");
    expect((await openAs(folder, "reader")).readOnlyReasons).toEqual([
      "manifest_damaged",
      "newer_writer",
    ]);
  });

  test("a newer revision is read only with a manifest that vouches for it", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    const conn = await raw(folder);
    conn.pragma("user_version", 4);
    closeRaw(conn);
    expect((await openAs(folder, "reader")).readOnlyReasons).toEqual(["newer_revision"]);
    // A stale manifest that names another format speaks for that format, not for this one.
    rewriteManifest(folder, (json) => {
      json["format"] = { major: 0, minor: 0 };
    });
    await expectCode(() => openAs(folder, "reader"), "SPACE_TOO_NEW");
    rewriteManifest(folder, (json) => {
      json["format"] = { major: 0, minor: 3 };
      json["min_writer"] = 5;
    });
    await expectCode(() => openAs(folder, "reader"), "SPACE_TOO_NEW");
  });

  test("an app version below a pre-release min_writer: rc.2 does not meet rc.10", async () => {
    // The reviewer's case: text order let 1.0.0-rc.2 open as the writer.
    const { folder } = await createFixtureSpace(folders.make());
    rewriteManifest(folder, (json) => {
      json["min_writer"] = "1.0.0-rc.10";
    });
    const as = async (appVersion: string) =>
      openSpace(await checkedDriver(), folder, { role: "writer", appVersion });
    await expectCode(() => as("1.0.0-rc.2"), "SPACE_TOO_NEW");
    expect(JSON.parse(readFileSync(join(folder, MANIFEST_FILE), "utf8"))).toMatchObject({
      min_writer: "1.0.0-rc.10",
    });
    const writer = await as("1.0.0-rc.10");
    open.push(writer.conn);
    expect(writer.readOnlyReasons).toEqual([]);
  });
});

describe("[A1.5.space.atomic-write] create's cleanup keeps the first error", () => {
  /** A remover that fails as Node does, with the path in its message. */
  const failingRemove: FileIo = {
    ...NODE_IO,
    rmSync: (path) => {
      throw Object.assign(new Error(`EACCES: permission denied, rm '${path}'`), { code: "EACCES" });
    },
  };

  test("a failing staging removal does not replace the error that stopped create", async () => {
    // The reviewer's case: rmSync's native error, with the path, replaced the real one.
    const parent = folders.make();
    let calls = 0;
    const random: RandomSource = (bytes) => {
      calls += 1;
      if (calls === 3) throw new Error("random source failed");
      bytes.fill(calls);
    };
    const options = { name: "Mira", ownerLabel: "Mira Okafor", machineId: TEST_MACHINE, random };
    const checked = await checkedDriver();
    expect(() =>
      createSpaceWith(checked, join(parent, "mira"), options, { io: failingRemove }),
    ).toThrow("random source failed");
    // The staging folder stays under the name M1.10's cleanup looks for.
    expect(readdirSync(parent)).toEqual([
      expect.stringMatching(/^\.mira\.creating-[0-9a-f]{16}$/) as unknown as string,
    ]);
  });

  test("a failed space.json write in staging throws a code-only error and names no path", async () => {
    const parent = folders.make();
    const io: FileIo = {
      ...failingRemove,
      writeSync: () => {
        throw Object.assign(new Error(`EIO: i/o error, write '${parent}'`), { code: "EIO" });
      },
    };
    const checked = await checkedDriver();
    let caught: unknown;
    try {
      createSpaceWith(
        checked,
        join(parent, "mira"),
        { name: "Mira", ownerLabel: "Mira Okafor", machineId: TEST_MACHINE },
        { io },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect((caught as StorageError).code).toBe("DURABILITY_FAILED");
    expect((caught as StorageError).message).toBe("File system error (EIO)");
    expect(JSON.stringify(caught)).not.toContain(parent);
    expect(readdirSync(parent)).not.toContain("mira");
  });
});
