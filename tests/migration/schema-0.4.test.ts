// Schema 0.4, the search index, on a real 0.3 space: the Mira sample built by the 0.3 chain through
// the write path (testkit's seedMira with STEPS_0_3), with a session row, which no operation
// writes yet: every table a search document reads holds rows. Not a checked-in database. The
// migration test from it, a fault at every statement boundary of the migration, and a 0.3 build
// that refuses the migrated space as its writer. The step adds tables and changes no row of the 0.3 tables:
// these tests hold it to that. Fixture data only, in temporary folders removed by their full names.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { step0003 } from "../../packages/storage/migrations/0003-schema-0.3.ts";
import { SCHEMA_0_4_STATEMENTS } from "../../packages/storage/migrations/0004-schema-0.4.ts";
import { backupSpace } from "../../packages/storage/src/backup/backup.ts";
import { listBackups } from "../../packages/storage/src/backup/list.ts";
import type { Connection } from "../../packages/storage/src/driver.ts";
import { StorageError } from "../../packages/storage/src/errors.ts";
import { readManifest } from "../../packages/storage/src/manifest.ts";
import { migrateSpaceWith } from "../../packages/storage/src/migrate/runner.ts";
import { nodeSqliteDriver } from "../../packages/storage/src/node-sqlite.ts";
import { restoreBackup, restoreBackupWith } from "../../packages/storage/src/restore/restore.ts";
import {
  expectedDocuments,
  storedDocuments,
  type SearchDocument,
} from "../../packages/storage/src/search/documents.ts";
import { openSpace } from "../../packages/storage/src/space.ts";
import { CheckedDriver } from "../../packages/storage/src/startup-check.ts";
import type { MachineInfo } from "../../packages/storage/src/write/writer.ts";
import {
  createSpaceAt,
  openSpaceAt,
  STEPS_0_3,
  STEPS_0_4,
} from "../../packages/storage/test/revisions.ts";
import { rejection, workerWithSteps } from "../../packages/storage/test/worker-helpers.ts";
import { digestSchema, digestSpace } from "../../packages/testkit/src/digest.ts";
import { RELEASED_SCHEMAS } from "../../packages/testkit/src/known.ts";
import { checkedDriver, MIRA, seedMira } from "../../packages/testkit/src/mira.ts";
import { faultingDriver, StatementFault } from "./faults.ts";
import { backupsBeside } from "../../packages/storage/test/backup-helpers.ts";

// Tests that open spaces, start workers and take backups get generous time limits: a slow runner
// only waits.

const made: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ttasks-schema-04-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A table's rows as JSON, in primary key order (rowid for a table without one). */
function rowsOf(conn: Connection, table: string): unknown[] {
  if (!/^[a-z_]+$/.test(table)) throw new Error("not a table name");
  const key = conn
    .prepare("SELECT name FROM pragma_table_info($t) WHERE pk > 0 ORDER BY pk")
    .all<{ name: string }>({ t: table })
    .map((c) => c.name);
  const order = key.length > 0 ? key.join(", ") : "rowid";
  return conn.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
}

/** The schema as SQLite stores it: every table and index with its SQL. */
const schemaOf = (conn: Connection): unknown[] =>
  conn
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' " +
        "ORDER BY type, name",
    )
    .all();

interface Facts {
  digest: string;
  schema: unknown[];
  schemaDigest: string;
  lastSeq: number;
  counts: Record<string, number>;
  rows: Record<string, unknown[]>;
}

async function factsOf(folder: string): Promise<Facts> {
  const checked = await checkedDriver();
  const { conn, space } = openSpace(checked, folder, { role: "reader" });
  try {
    const tables = conn
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
          "AND name NOT LIKE 'search_%' ORDER BY name",
      )
      .all<{ name: string }>()
      .map((t) => t.name);
    const rows = Object.fromEntries(tables.map((t) => [t, rowsOf(conn, t)]));
    return {
      digest: digestSpace(checked, folder),
      schema: schemaOf(conn),
      schemaDigest: digestSchema(conn),
      lastSeq: space.lastSeq,
      counts: Object.fromEntries(tables.map((t) => [t, rows[t]?.length ?? 0])),
      rows,
    };
  } finally {
    conn.close();
  }
}

/** One ended session of the sample's first task, as A4's session store will write it. */
function fillSession(conn: Connection, machine: string): void {
  const one = (sql: string): unknown => Object.values(conn.prepare(sql).get() ?? {})[0];
  const task = String(one("SELECT id FROM tasks ORDER BY ref LIMIT 1"));
  const seq = Number(one("SELECT last_seq FROM space"));
  const at = Number(one("SELECT max(at) FROM commits"));
  conn
    .prepare(
      "INSERT INTO sessions (id, task_id, kind, instance_id, machine_id, state, created_at, " +
        "created_seq, version) VALUES ('se_fixture', $task, 'interactive', 'codex-work', " +
        "$machine, 'ended', $at, $seq, $seq)",
    )
    .run({ task, machine, at, seq });
}

/** A Mira sample at 0.3 with `tasks` tasks and a session, as a 0.3 build holds it. */
async function sampleAt03(
  seed: string,
  tasks: number,
): Promise<{ folder: string; machine: MachineInfo; facts: Facts }> {
  const seeded = await seedMira(temp(), { seed, tasks, steps: STEPS_0_3 });
  const writer = openSpaceAt(await checkedDriver(), seeded.folder, { role: "writer" }, STEPS_0_3);
  try {
    writer.conn.transaction("immediate", () => {
      fillSession(writer.conn, seeded.machine);
    });
  } finally {
    writer.conn.close();
  }
  return {
    folder: seeded.folder,
    machine: { id: seeded.machine, name: MIRA.machine.name, os: MIRA.machine.os },
    facts: await factsOf(seeded.folder),
  };
}

let fixture: Awaited<ReturnType<typeof sampleAt03>>;
/** A smaller sample for the fault sweep, whose boundaries grow with the documents it indexes. */
let small: Awaited<ReturnType<typeof sampleAt03>>;

beforeAll(async () => {
  fixture = await sampleAt03("migration-0.3", 40);
  small = await sampleAt03("migration-0.3-small", 3);
  // A populated 0.3 space: user_version 3, every 0.3 table with rows, no search table, and the 0.3
  // release's schema to the last index and CHECK.
  for (const sample of [fixture, small]) {
    expect(Object.keys(sample.facts.counts).sort()).toEqual([...step0003.tables].sort());
    expect(sample.facts.schemaDigest).toBe(RELEASED_SCHEMAS["0.3"]);
  }
  // Rows in every table a search document is made from, and in 0.3's own.
  for (const table of [
    "tasks",
    "notes",
    "log_entries",
    "learnings",
    "sources",
    "task_sources",
    "areas",
    "projects",
    "sessions",
    "runs",
  ]) {
    expect(fixture.facts.counts[table], table).toBeGreaterThan(0);
  }
}, 180_000);

/** A copy of a sample in a folder of its own, as `mira`. */
function copyOf(sample: { folder: string } = fixture): string {
  const folder = join(temp(), "mira");
  cpSync(sample.folder, folder, { recursive: true });
  return folder;
}

/** The documents as the index holds them and as a rebuild would make them, numbers aside. */
function indexAndRebuild(conn: Connection): {
  stored: SearchDocument[];
  expected: SearchDocument[];
} {
  const plain = (docs: Iterable<SearchDocument>): SearchDocument[] =>
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
  return { stored: plain(stored.docs.values()), expected: plain(expectedDocuments(conn).values()) };
}

describe("[A1.5.migration.from-0.3] the 0.3 fixture migrates to 0.4 behind its verified barrier backup", () => {
  test("every 0.3 row stays, the search index holds every document and finds a task by a word of its title, the schema is a new 0.4 space's, and the backup restores the fixture", async () => {
    const before = fixture.facts;
    const folder = copyOf();
    // The 0.4 builds' chain: this test is the 0.4 step's (schema-0.5.test.ts migrates to 0.5).
    const worker = await workerWithSteps("0.4");
    try {
      const writer = await worker.openSpaceWriter(folder, {
        backupDir: backupsBeside(folder),
        machine: fixture.machine,
      });
      expect(writer.revision).toEqual({ major: 0, minor: 4 });
      expect(writer.migration).toMatchObject({
        from: { major: 0, minor: 3 },
        to: { major: 0, minor: 4 },
        seqs: [before.lastSeq + 1],
        manifestWritten: true,
      });
      expect(writer.migration?.backup.sidecar).toMatchObject({
        kind: "pre-migrate",
        user_version: 3,
        seq: before.lastSeq,
        counts: before.counts,
      });
      await writer.close();
    } finally {
      await worker.close();
    }

    const checked = await checkedDriver();
    // Read as a 0.4 build reads it: this build would read a 0.4 space as older than its own.
    const opened = openSpaceAt(checked, folder, { role: "reader" }, STEPS_0_4);
    let migratedSchema: unknown[];
    try {
      const { conn } = opened;
      expect(opened.revision).toEqual({ major: 0, minor: 4 });
      expect(opened.readOnlyReasons).toEqual([]);
      expect(conn.pragma("user_version")).toBe(4);
      expect(conn.pragma("integrity_check")).toBe("ok");
      expect(conn.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // What the step writes: the search tables, and nothing else but the migration's own commit
      // and the space row's format and last seq. Every row of every 0.3 table is as it was.
      for (const table of step0003.tables) {
        if (table === "space" || table === "commits") continue;
        expect(rowsOf(conn, table), table).toEqual(before.rows[table]);
      }
      expect(rowsOf(conn, "space")).toEqual([
        {
          ...(before.rows["space"]?.[0] as object),
          format_minor: 4,
          last_seq: before.lastSeq + 1,
        },
      ]);
      const commits = rowsOf(conn, "commits");
      expect(commits.slice(0, -1)).toEqual(before.rows["commits"]);
      expect(commits.at(-1)).toMatchObject({
        seq: before.lastSeq + 1,
        kind: "migration",
        origin: "migration",
        actor_kind: "system",
        scope_id: "system",
        affected: 0,
      });
      const spaceId = (before.rows["space"]?.[0] as { space_id: string }).space_id;
      expect(JSON.parse((commits.at(-1) as { ops: string }).ops)).toEqual([
        { v: 1, op: "schema.migrate", target: spaceId, input: { step: 4, from: "0.3", to: "0.4" } },
      ]);
      // The index is a rebuild of the space: every task, note, log entry, learning, area and
      // project, and a word of a task's title finds that task.
      const { stored, expected } = indexAndRebuild(conn);
      expect(stored).toEqual(expected);
      const kinds = new Set(stored.map((doc) => doc.kind));
      expect([...kinds].sort()).toEqual(["area", "learning", "log", "note", "project", "task"]);
      const task = conn
        .prepare("SELECT id, title FROM tasks WHERE deleted_at IS NULL ORDER BY ref LIMIT 1")
        .get<{ id: string; title: string }>();
      const word = (task?.title ?? "").split(/\s+/u).find((w) => /^\p{L}{4,}$/u.test(w)) ?? "";
      expect(word).not.toBe("");
      const found = conn
        .prepare(
          "SELECT d.task_id FROM search_fts f JOIN search_docs d ON d.doc = f.rowid " +
            "WHERE search_fts MATCH $word",
        )
        .all<{ task_id: string }>({ word: `"${word}"` })
        .map((row) => row.task_id);
      expect(found).toContain(task?.id);
      migratedSchema = schemaOf(conn);
      expect(digestSchema(conn)).toBe(RELEASED_SCHEMAS["0.4"]);
    } finally {
      opened.conn.close();
    }
    // A new 0.4 space has the same schema, byte for byte: create runs the same steps.
    const fresh = createSpaceAt(
      checked,
      join(temp(), "fresh"),
      { name: "Fresh", ownerLabel: "Mira Okafor", machineId: fixture.machine.id },
      STEPS_0_4,
    );
    const freshConn = openSpace(checked, fresh.folder, { role: "reader" }).conn;
    try {
      expect(migratedSchema).toEqual(schemaOf(freshConn));
      expect(digestSchema(freshConn)).toBe(RELEASED_SCHEMAS["0.4"]);
    } finally {
      freshConn.close();
    }
    const manifest = readManifest(folder);
    expect(manifest.state === "present" ? manifest.safety : undefined).toMatchObject({
      format: { major: 0, minor: 4 },
      min_reader: "0.0.0",
      min_writer: "0.0.0",
    });

    // The downgrade is a restore of the pre-migration backup: the fixture's counts, last_seq and
    // rows, without a search table.
    const barrier = listBackups(backupsBeside(folder)).backups.find(
      (b) => b.sidecar?.kind === "pre-migrate",
    );
    if (barrier === undefined) throw new Error("no barrier backup");
    const restoredFolder = join(temp(), "mira");
    const restored = await restoreBackup(checked, barrier.file, restoredFolder);
    expect(restored.revision).toEqual({ major: 0, minor: 3 });
    expect(restored.space.lastSeq).toBe(before.lastSeq);
    const after = await factsOf(restoredFolder);
    expect(after.counts).toEqual(before.counts);
    expect(after.schema).toEqual(before.schema);
    for (const table of step0003.tables) {
      if (table !== "space") expect(after.rows[table], table).toEqual(before.rows[table]);
    }
  }, 180_000);
});

describe("[A1.5.migration.statement-faults-0004] a fault at every statement boundary of the 0.3 to 0.4 migration leaves the space at 0.3", () => {
  test("each boundary fails in turn, the search index's fill included: the data is unchanged, the space opens read-only with the failure's message, and the 0.3 build still writes it", async () => {
    const fault = new StatementFault();
    const faulting = await CheckedDriver.check(faultingDriver(nodeSqliteDriver, fault));
    const migrate = (folder: string) =>
      migrateSpaceWith(
        faulting,
        folder,
        { backupDir: backupsBeside(folder) },
        {
          steps: STEPS_0_4,
          at: (point) => {
            if (point === "backed-up") fault.armed = true;
          },
        },
      );

    // A clean run counts the boundaries: every statement of the step, the index's fill, and the
    // runner's own.
    fault.reset(undefined);
    const clean = await migrate(copyOf(small));
    expect(clean.state).toBe("migrated");
    expect(fault.began).toBe(true);
    const boundaries = fault.count;
    const trace = [...fault.trace];
    const at = SCHEMA_0_4_STATEMENTS.map((sql) => trace.indexOf(sql));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The fill runs after the step's statements, and writes both search tables.
    const fills = ["INSERT INTO search_docs", "INSERT INTO search_fts"].map((start) =>
      trace.findIndex((sql) => sql.startsWith(start)),
    );
    for (const i of fills) expect(i).toBeGreaterThan(Math.max(...at));
    expect(trace.at(-1)).toBe("COMMIT");

    const checked = await checkedDriver();
    const expectSample = (where: string, folder: string): void => {
      expect(digestSpace(checked, folder), where).toBe(small.facts.digest);
      const reader = openSpace(checked, folder, { role: "reader" });
      try {
        expect(reader.readOnlyReasons, where).toEqual(["older_revision"]);
        expect(reader.revision, where).toEqual({ major: 0, minor: 3 });
        expect(schemaOf(reader.conn), where).toEqual(small.facts.schema);
      } finally {
        reader.conn.close();
      }
      openSpaceAt(checked, folder, { role: "writer" }, STEPS_0_3).conn.close();
    };
    for (let n = 0; n < boundaries; n += 1) {
      const folder = copyOf(small);
      fault.reset(n);
      const outcome = await migrate(folder);
      const where = `boundary ${String(n)} (${trace[n] ?? "?"})`;
      expect(fault.hit, where).toBe(true);
      if (outcome.state !== "failed") throw new Error(`${where}: the migration did not fail`);
      expect(outcome.stage, where).toBe("migration");
      expect(outcome.error.code, where).toBe("MIGRATION_FAILED");
      expect(outcome.error.message, where).toBe(
        "Migration to 0.4 failed (DURABILITY_FAILED). Your data is unchanged. " +
          `The space stays at 0.3. Backup: ${outcome.backup?.name ?? "?"}`,
      );
      expect(outcome.error.message, where).not.toContain(folder);
      expectSample(where, folder);
    }

    // SQLite itself refuses the COMMIT, after every statement and boundary ran.
    {
      const folder = copyOf(small);
      fault.reset(undefined, true);
      const outcome = await migrate(folder);
      expect(fault.hit).toBe(true);
      if (outcome.state !== "failed") throw new Error("a refused COMMIT did not fail");
      expect(outcome.error.message).toMatch(
        /^Migration to 0\.4 failed \([A-Z_]+\)\. Your data is unchanged\. The space stays at 0\.3\. Backup: pre-migrate-/,
      );
      expectSample("a refused COMMIT", folder);
    }

    // And with no fault the same copy migrates: a failure leaves nothing that blocks the next try.
    const folder = copyOf(small);
    fault.reset(boundaries);
    expect((await migrate(folder)).state).toBe("migrated");
    expect(fault.hit).toBe(false);
  }, 600_000);
});

describe("[A1.5.migration.older-build-0004] a 0.3 build refuses to open a 0.4 space writable", () => {
  test("the 0.3 chain's writer is refused and changes nothing, its reader reads, and it restores no 0.4 backup", async () => {
    const checked = await checkedDriver();
    const folder = copyOf();
    expect(
      (
        await migrateSpaceWith(
          checked,
          folder,
          { backupDir: backupsBeside(folder) },
          { steps: STEPS_0_4 },
        )
      ).state,
    ).toBe("migrated");
    const before = digestSpace(checked, folder);

    let refused: unknown;
    try {
      openSpaceAt(checked, folder, { role: "writer" }, STEPS_0_3).conn.close();
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(StorageError);
    expect((refused as StorageError).code).toBe("SPACE_TOO_NEW");
    expect(digestSpace(checked, folder)).toBe(before);
    const reader = openSpaceAt(checked, folder, { role: "reader" }, STEPS_0_3);
    try {
      expect(reader.readOnlyReasons).toEqual(["newer_revision"]);
      expect(reader.revision).toEqual({ major: 0, minor: 4 });
    } finally {
      reader.conn.close();
    }

    const old = await workerWithSteps("0.3");
    try {
      const error = await rejection(
        old.openSpaceWriter(folder, { backupDir: backupsBeside(folder), machine: fixture.machine }),
      );
      expect(error.code).toBe("SPACE_TOO_NEW");
      const { conn, info } = await old.openSpaceReader(folder);
      expect(info.readOnlyReasons).toEqual(["newer_revision"]);
      await conn.close();
    } finally {
      await old.close();
    }
    expect(digestSpace(checked, folder)).toBe(before);

    const backup = await backupSpace(checked, folder, {
      backupDir: backupsBeside(folder),
      kind: "manual",
    });
    let restoreError: unknown;
    try {
      await restoreBackupWith(checked, backup.file, join(temp(), "mira"), {}, { steps: STEPS_0_3 });
    } catch (error) {
      restoreError = error;
    }
    expect((restoreError as StorageError).code).toBe("SPACE_TOO_NEW");
  }, 180_000);
});
