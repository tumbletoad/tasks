// The search index is derived from the tasks, so a backup is never judged by it: a restore, the
// trial restore that verifies a backup, and the exact-schema rule leave it out, and every restore
// makes it again from the copy's tasks. Backups made before schema 0.4 (no index), after it, with
// the index missing, and with an index that differs from this build's. Fixture text only.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { backupSpace, backupSpaceWith, type BackupRecord } from "../src/backup/backup.ts";
import { listBackups, verifyBackup } from "../src/backup/list.ts";
import type { Connection } from "../src/driver.ts";
import { DATABASE_FILE } from "../src/manifest.ts";
import { migrateSpace } from "../src/migrate/runner.ts";
import { restoreBackup, restoreInPlace } from "../src/restore/restore.ts";
import {
  expectedDocuments,
  storedDocuments,
  type SearchDocument,
} from "../src/search/documents.ts";
import { repairSearchIndex, searchIndexSound } from "../src/search/remake.ts";
import { hasSearchTables } from "../src/search/tables.ts";
import { isId, newId } from "../src/ids.ts";
import { openSpace } from "../src/space.ts";
import { StorageWorker } from "../src/worker/client.ts";
import { SpaceWriter } from "../src/write/writer.ts";
import { SCHEMA_STEPS } from "../migrations/index.ts";
import { rawWriter, writeCommits } from "./backup-helpers.ts";
import { createRequest, ownerCredential } from "./fixture-requests.ts";
import { STEPS_0_3 } from "./revisions.ts";
import { checkedDriver, createFixtureSpace, TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import { rejection } from "./worker-helpers.ts";
import { MACHINE } from "./write-helpers.ts";

const folders = tempFolders("search-restore");

afterEach(() => {
  folders.cleanup();
});

/** The entity IDs whose documents hold `word`. */
function matching(conn: Connection, word: string): string[] {
  return conn
    .prepare(
      "SELECT d.entity_id FROM search_fts f JOIN search_docs d ON d.doc = f.rowid " +
        "WHERE search_fts MATCH $word ORDER BY d.entity_id",
    )
    .all<{ entity_id: string }>({ word: `"${word}"` })
    .map((row) => row.entity_id);
}

/** The IDs of the live tasks whose title holds `word`. */
function titled(conn: Connection, word: string): string[] {
  return conn
    .prepare("SELECT id FROM tasks WHERE deleted_at IS NULL AND title LIKE $like ORDER BY id")
    .all<{ id: string }>({ like: `%${word}%` })
    .map((row) => row.id);
}

/** The index equals a fresh rebuild of the space's tasks, document numbers and seqs aside. */
function expectIndexOfTasks(conn: Connection): void {
  const strip = (docs: Iterable<SearchDocument>): SearchDocument[] =>
    [...docs]
      .map(({ kind, entityId, taskId, lifecycle, audience, title, body, extra }) => ({
        kind,
        entityId,
        taskId,
        lifecycle,
        audience,
        title,
        body,
        extra,
      }))
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
  const stored = storedDocuments(conn);
  expect(stored.stray).toBe(0);
  expect(strip(stored.docs.values())).toEqual(strip(expectedDocuments(conn).values()));
}

/** The schema as SQLite keeps it: every table, index and view with its SQL. */
const schemaOf = (conn: Connection): unknown[] =>
  conn.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();

/** The schema of a new space of this build. */
async function freshSchema(): Promise<unknown[]> {
  const { folder } = await createFixtureSpace(folders.make());
  const { conn } = openSpace(await checkedDriver(), folder, { role: "reader" });
  try {
    return schemaOf(conn);
  } finally {
    conn.close();
  }
}

/** Runs `sql` on the closed space's database with its schema writable, as a planted file would. */
function plant(folder: string, sql: string): void {
  const conn = new DatabaseSync(join(folder, DATABASE_FILE), { defensive: false });
  try {
    conn.exec("PRAGMA writable_schema = ON");
    conn.exec(sql);
    conn.exec("PRAGMA writable_schema = OFF");
  } finally {
    conn.close();
  }
}

/** Reads the space at `folder` through a reader. */
async function read<T>(folder: string, fn: (conn: Connection) => T): Promise<T> {
  const { conn } = openSpace(await checkedDriver(), folder, { role: "reader" });
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

/** A space of this build with three tasks titled `Task <tag>0` to `Task <tag>2`. */
async function indexedSpace(tag: string): Promise<string> {
  const { folder } = await createFixtureSpace(folders.make());
  await writeCommits(folder, 4, tag);
  return folder;
}

/**
 * The backup verifies by its trial restore, restores into a new folder and in place, and each
 * restored space holds this build's index of its own tasks, found by `word`, and a new space's
 * schema.
 */
async function expectRestoresWithIndex(
  folder: string,
  backup: BackupRecord,
  word: string,
): Promise<void> {
  const checked = await checkedDriver();
  const listed = listBackups(join(folder, "backups")).backups.find((b) => b.name === backup.name);
  if (listed === undefined) throw new Error("the backup is listed");
  expect(await verifyBackup(checked, listed)).toEqual({
    state: "verified",
    sidecar: backup.sidecar,
  });
  const fresh = await freshSchema();
  const copy = await restoreBackup(checked, backup.file, join(folders.make(), "mira"));
  const inPlace = await restoreInPlace(checked, backup.file, folder, { machineId: TEST_MACHINE });
  for (const restored of [copy.folder, inPlace.folder]) {
    await read(restored, (conn) => {
      expect(schemaOf(conn), restored).toEqual(fresh);
      expectIndexOfTasks(conn);
      expect(matching(conn, word), restored).toEqual(titled(conn, word));
      expect(matching(conn, word).length, restored).toBe(1);
    });
  }
}

describe("[A1.5.restore.search-derived] a restore makes the search index again from the copy's tasks", () => {
  test("a backup made before schema 0.4 verifies and restores at 0.3, and the restored space's migration fills the index", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make(), "mira", {}, STEPS_0_3);
    await writeCommits(folder, 4, "early", STEPS_0_3);
    const backup = await backupSpaceWith(checked, folder, { kind: "manual" }, { steps: STEPS_0_3 });
    expect(backup.sidecar.user_version).toBe(3);
    // The live space moves on to this build's schema; the backup stays at 0.3.
    expect((await migrateSpace(checked, folder)).state).toBe("migrated");
    const listed = listBackups(join(folder, "backups")).backups.find((b) => b.name === backup.name);
    if (listed === undefined) throw new Error("the backup is listed");
    expect(await verifyBackup(checked, listed)).toEqual({
      state: "verified",
      sidecar: backup.sidecar,
    });

    const copy = await restoreBackup(checked, backup.file, join(folders.make(), "mira"));
    expect(copy.revision).toEqual({ major: 0, minor: 3 });
    await read(copy.folder, (conn) => {
      expect(hasSearchTables(conn)).toBe(false);
    });

    const restored = await restoreInPlace(checked, backup.file, folder, {
      machineId: TEST_MACHINE,
    });
    expect(restored.revision).toEqual({ major: 0, minor: 3 });
    expect((await migrateSpace(checked, folder)).state).toBe("migrated");
    const fresh = await freshSchema();
    await read(folder, (conn) => {
      expect(schemaOf(conn)).toEqual(fresh);
      expectIndexOfTasks(conn);
      expect(matching(conn, "early1")).toEqual(titled(conn, "early1"));
      expect(matching(conn, "early1")).toHaveLength(1);
    });
  });

  test("a backup made after schema 0.4 verifies and restores with the index of its own tasks", async () => {
    const checked = await checkedDriver();
    const folder = await indexedSpace("after");
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    // Tasks written after the backup are not in what it restores.
    await writeCommits(folder, 2, "later");
    await expectRestoresWithIndex(folder, backup, "after2");
    await read(folder, (conn) => {
      expect(matching(conn, "later1")).toEqual([]);
    });
  });

  test("a backup whose search tables are missing verifies and restores with the index made again", async () => {
    const checked = await checkedDriver();
    const folder = await indexedSpace("missing");
    const conn = await rawWriter(folder);
    try {
      conn.exec("DROP TABLE search_fts");
      conn.exec("DROP TABLE search_docs");
    } finally {
      conn.close();
    }
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    await expectRestoresWithIndex(folder, backup, "missing1");
  });

  test("a backup whose search tables differ from this build's verifies and restores with this build's index, and nothing planted under their names stays", async () => {
    const checked = await checkedDriver();
    const folder = await indexedSpace("differs");
    plant(
      folder,
      // Another tokenizer, and the shadow table's text no longer what FTS5 writes for it.
      "UPDATE sqlite_schema SET sql = replace(sql, 'remove_diacritics 2', 'remove_diacritics 0') " +
        "WHERE name = 'search_fts'; " +
        "UPDATE sqlite_schema SET sql = replace(sql, 'c2)', 'c2, CHECK (c0 IS NULL))') " +
        "WHERE name = 'search_fts_content'",
    );
    const conn = await rawWriter(folder);
    try {
      // An index of its own, and a document that names no task, holding a word no task has.
      conn.exec("CREATE INDEX search_docs_extra ON search_docs(seq)");
      conn.exec(
        "INSERT INTO search_docs (doc, kind, entity_id, task_id, lifecycle, audience, seq) " +
          "VALUES (900001, 'task', 't_stray', 't_stray', 'active', 'all', 1)",
      );
    } finally {
      conn.close();
    }
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    await expectRestoresWithIndex(folder, backup, "differs3");
    await read(folder, (conn) => {
      expect(
        conn.prepare("SELECT count(*) AS n FROM search_docs WHERE entity_id = 't_stray'").get(),
      ).toEqual({ n: 0 });
    });
  });
});

/** Damages the closed space's search index as a failing disk or another program could. */
function damageIndex(folder: string): void {
  const conn = new DatabaseSync(join(folder, DATABASE_FILE), { defensive: false });
  try {
    conn.exec("DELETE FROM search_fts_content WHERE id = (SELECT min(id) FROM search_fts_content)");
  } finally {
    conn.close();
  }
}

describe("[A1.5.search.repair] a damaged search index is made again and never costs a backup", () => {
  test("a space whose index alone is damaged still backs up, and the backup restores whole", async () => {
    const checked = await checkedDriver();
    const folder = await indexedSpace("broken");
    damageIndex(folder);
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    expect(backup.searchIndexRemade).toBe(true);
    await expectRestoresWithIndex(folder, backup, "broken2");
  });

  test("a writer's open repairs the index, and a sound one is left as it is", async () => {
    const folder = await indexedSpace("heal");
    damageIndex(folder);
    const worker = await StorageWorker.start({ driver: "node:sqlite" });
    try {
      const writer = await worker.openSpaceWriter(folder, { machine: MACHINE });
      expect(writer.searchIndex).toBe("remade");
      expect(await writer.repairSearchIndex()).toBe("sound");
      await writer.close();
      const again = await worker.openSpaceWriter(folder, { machine: MACHINE });
      expect(again.searchIndex).toBeUndefined();
      await again.close();
    } finally {
      await worker.close();
    }
    await read(folder, (conn) => {
      expectIndexOfTasks(conn);
      expect(matching(conn, "heal1")).toEqual(titled(conn, "heal1"));
    });
  });

  test("a writer's open gives a sound index filled by another definition this build's documents", async () => {
    const folder = await indexedSpace("old");
    // As an earlier build could have left it: one task's text without its title, one task with
    // no document, and a document of no row.
    const conn = new DatabaseSync(join(folder, DATABASE_FILE));
    try {
      const docOf = (title: string): number =>
        Number(
          conn
            .prepare(
              "SELECT d.doc FROM search_docs d JOIN tasks t ON t.id = d.entity_id WHERE t.title = ?",
            )
            .get(title)?.["doc"],
        );
      const stale = docOf("Task old1");
      conn.prepare("DELETE FROM search_fts WHERE rowid = ?").run(stale);
      conn
        .prepare("INSERT INTO search_fts (rowid, title, body, extra) VALUES (?, '', 'x', '')")
        .run(stale);
      const gone = docOf("Task old2");
      conn.prepare("DELETE FROM search_fts WHERE rowid = ?").run(gone);
      conn.prepare("DELETE FROM search_docs WHERE doc = ?").run(gone);
      const extra = conn
        .prepare(
          "INSERT INTO search_docs (kind, entity_id, task_id, lifecycle, audience, seq) " +
            "VALUES ('area', 'a_gone', NULL, NULL, 'all', 1) RETURNING doc",
        )
        .get()?.["doc"];
      conn
        .prepare("INSERT INTO search_fts (rowid, title, body, extra) VALUES (?, 'Gone', '', '')")
        .run(Number(extra));
    } finally {
      conn.close();
    }
    const before = await rawWriter(folder);
    try {
      expect(searchIndexSound(before)).toBe(true);
      expect(matching(before, "old1")).toEqual([]);
    } finally {
      before.close();
    }
    const worker = await StorageWorker.start({ driver: "node:sqlite" });
    try {
      const writer = await worker.openSpaceWriter(folder, { machine: MACHINE });
      expect(writer.searchIndex).toBe("remade");
      await writer.close();
      const again = await worker.openSpaceWriter(folder, { machine: MACHINE });
      expect(again.searchIndex).toBeUndefined();
      await again.close();
    } finally {
      await worker.close();
    }
    const after = await rawWriter(folder);
    try {
      expectIndexOfTasks(after);
      expect(searchIndexSound(after)).toBe(true);
      expect(matching(after, "old1")).toEqual(titled(after, "old1"));
      expect(matching(after, "old2")).toEqual(titled(after, "old2"));
    } finally {
      after.close();
    }
  });

  test("a text that no document names counts as damage, and the repair removes it", async () => {
    const checked = await checkedDriver();
    const folder = await indexedSpace("live");
    const conn = await rawWriter(folder);
    try {
      expect(repairSearchIndex(checked, conn, SCHEMA_STEPS)).toBe("sound");
      conn.exec(
        "INSERT INTO search_fts (rowid, title, body, extra) VALUES (900002, 'x', 'y', 'z')",
      );
      expect(searchIndexSound(conn)).toBe(false);
      expect(repairSearchIndex(checked, conn, SCHEMA_STEPS)).toBe("remade");
      expectIndexOfTasks(conn);
    } finally {
      conn.close();
    }
  });

  test("a writer's open on a machine that does not own the space leaves its index as it is", async () => {
    const folder = await linkedSpace();
    forgetSourceWords(folder);
    const worker = await StorageWorker.start({ driver: "node:sqlite" });
    try {
      const elsewhere = await worker.openSpaceWriter(folder, { machine: OTHER_MACHINE });
      expect(elsewhere.authority.machineId).not.toBe(OTHER_MACHINE.id);
      expect(elsewhere.searchIndex).toBeUndefined();
      await elsewhere.close();
      await read(folder, (conn) => {
        expect(matching(conn, "copyword")).toEqual([]);
      });
      // Its owner's next open brings it up to date.
      const owner = await worker.openSpaceWriter(folder, { machine: MACHINE });
      expect(owner.searchIndex).toBe("remade");
      await owner.close();
    } finally {
      await worker.close();
    }
    await read(folder, (conn) => {
      expect(matching(conn, "copyword")).toEqual(titled(conn, "Linked"));
    });
  });

  test("a restored copy's index waits for its claim, and the claimed copy's search finds a source's key", async () => {
    const checked = await checkedDriver();
    const original = await linkedSpace();
    const backup = await backupSpace(checked, original, { kind: "manual" });
    const { folder } = await restoreBackup(checked, backup.file, join(folders.make(), "mira"));
    // As a restore by a build before source words left it.
    forgetSourceWords(folder);
    const worker = await StorageWorker.start({ driver: "node:sqlite" });
    try {
      const refused = await rejection(worker.openSpaceWriter(folder, { machine: MACHINE }));
      expect(refused.code).toBe("SPACE_READ_ONLY_COPY");
      await read(folder, (conn) => {
        expect(matching(conn, "copyword")).toEqual([]);
      });
      await worker.claimSpace(folder, { machine: MACHINE });
      // The claim writes only its commit; the copy's first open as a writer, which follows every
      // claim, brings its index up to date.
      const claimed = await worker.openSpaceWriter(folder, { machine: MACHINE });
      expect(claimed.searchIndex).toBe("remade");
      await claimed.close();
    } finally {
      await worker.close();
    }
    await read(folder, (conn) => {
      expect(matching(conn, "tracker:copyword-7")).toEqual(titled(conn, "Linked"));
      expectIndexOfTasks(conn);
    });
  });
});

/** Another machine than the fixtures' authority. */
const OTHER_MACHINE = { id: newId("m"), name: "mira-laptop", os: "linux" } as const;

/** A space of this build with one task, `Linked task`, whose ticket's key holds `copyword`. */
async function linkedSpace(): Promise<string> {
  const { folder } = await createFixtureSpace(folders.make());
  const opened = openSpace(await checkedDriver(), folder, { role: "writer" });
  const owner = opened.conn.prepare("SELECT id FROM actors WHERE kind = 'human'").get()?.["id"];
  if (!isId(owner, "ac")) throw new Error("the fixture space has no owner");
  const writer = SpaceWriter.attach(opened, { machine: MACHINE });
  try {
    writer.registerMachine();
    const credential = ownerCredential(owner);
    const made = writer.submit(createRequest(writer.spaceId, credential, "Linked task"));
    const task = made.status === "applied" ? made.results[0]?.id : undefined;
    if (task === undefined) throw new Error(JSON.stringify(made.error));
    const linked = writer.submit({
      ...createRequest(writer.spaceId, credential, ""),
      ops: [
        {
          kind: "source.add",
          task,
          source: { kind: "ticket", title: "Ticket", key: "tracker:copyword-7" },
        },
      ],
    });
    expect(linked.status, JSON.stringify(linked.error)).toBe("applied");
  } finally {
    writer.close();
  }
  return folder;
}

/** Leaves the closed space's task documents without their source words, as a build before them. */
function forgetSourceWords(folder: string): void {
  const conn = new DatabaseSync(join(folder, DATABASE_FILE));
  try {
    conn.exec(
      "UPDATE search_fts SET extra = '' WHERE rowid IN (SELECT doc FROM search_docs WHERE kind = 'task')",
    );
  } finally {
    conn.close();
  }
}
