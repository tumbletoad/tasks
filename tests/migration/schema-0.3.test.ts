// Schema 0.3 (A7 3.13 M6.01) on a real 0.2 space with data in every table: the Mira sample built by
// the 0.2 chain through the write path (testkit's seedMira with STEPS_0_2), plus one row in each
// 0.2 table that no operation writes yet, not a checked-in database. The migration test from it, a
// fault at every statement boundary of the migration, and a 0.2 build that refuses the migrated
// space as its writer. Fixture data only, in temporary folders removed by their full names.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { step0002 } from "../../packages/storage/migrations/0002-schema-0.2.ts";
import {
  SCHEMA_0_3_STATEMENTS,
  TABLES_0_3_NEW,
} from "../../packages/storage/migrations/0003-schema-0.3.ts";
import { backupSpace } from "../../packages/storage/src/backup/backup.ts";
import { listBackups } from "../../packages/storage/src/backup/list.ts";
import type { Connection } from "../../packages/storage/src/driver.ts";
import { StorageError } from "../../packages/storage/src/errors.ts";
import { readManifest } from "../../packages/storage/src/manifest.ts";
import { migrateSpaceWith } from "../../packages/storage/src/migrate/runner.ts";
import { nodeSqliteDriver } from "../../packages/storage/src/node-sqlite.ts";
import { restoreBackup, restoreBackupWith } from "../../packages/storage/src/restore/restore.ts";
import { openSpace } from "../../packages/storage/src/space.ts";
import { CheckedDriver } from "../../packages/storage/src/startup-check.ts";
import type { Id } from "../../packages/storage/src/ids.ts";
import type { Credential, Operation } from "../../packages/storage/src/write/request.ts";
import { SpaceWriter, type MachineInfo } from "../../packages/storage/src/write/writer.ts";
import {
  createSpaceAt,
  openSpaceAt,
  STEPS_0_2,
  STEPS_0_3,
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
  const dir = mkdtempSync(join(tmpdir(), "ttasks-schema-03-"));
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
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
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

/**
 * One row in each 0.2 table that no operation writes yet (labels, learnings, attachments,
 * proposals, exchanges), pointing at the sample's own task, owner and seq, as rows a 0.2 space may
 * hold. Fixture rows without history, written with the 0.2 chain's writer connection.
 */
function fill02(conn: Connection): void {
  const one = (sql: string): unknown => Object.values(conn.prepare(sql).get() ?? {})[0];
  const task = String(one("SELECT id FROM tasks ORDER BY ref LIMIT 1"));
  const owner = String(one("SELECT id FROM actors WHERE kind = 'human'"));
  const seq = Number(one("SELECT last_seq FROM space"));
  const at = Number(one("SELECT max(at) FROM commits"));
  const space = conn.prepare("SELECT authority_epoch, authority_incarnation FROM space").get();
  conn.transaction("immediate", () => {
    const run = (sql: string, params: Record<string, string | number>): void => {
      conn.prepare(sql).run(params);
    };
    run(
      `INSERT INTO labels (id, slug, title, created_seq, version)
       VALUES ('lb_fixture', 'urgent', 'Urgent', $seq, $seq)`,
      { seq },
    );
    run(
      `INSERT INTO task_labels (task_id, label_id, added_by, created_seq, version)
       VALUES ($task, 'lb_fixture', $owner, $seq, $seq)`,
      { task, owner, seq },
    );
    run(
      `INSERT INTO learnings (id, task_id, position, body, created_by, created_at, created_seq,
         version)
       VALUES ('lr_fixture', $task, 'a0', 'Check the zone first.', $owner, $at, $seq, $seq)`,
      { task, owner, seq, at },
    );
    run(
      `INSERT INTO attachments (id, task_id, sha256, size, media_type, filename, created_by,
         created_at, created_seq, version)
       VALUES ('at_fixture', $task, $sha, 12, 'text/plain', 'notes.txt', $owner, $at, $seq, $seq)`,
      { task, owner, seq, at, sha: "0".repeat(64) },
    );
    run(
      `INSERT INTO proposals (id, task_id, author_id, origin, ops, base_epoch, base_incarnation,
         base_seq, created_at, created_seq, version)
       VALUES ('pr_fixture', $task, $owner, 'import_conflict', '[]', $epoch, $incarnation, $seq,
         $at, $seq, $seq)`,
      {
        task,
        owner,
        seq,
        at,
        epoch: Number(space?.["authority_epoch"]),
        incarnation: String(space?.["authority_incarnation"]),
      },
    );
    run(
      `INSERT INTO exchanges (id, dir, base_seq, created_by, created_at, created_seq, version)
       VALUES ('ex_fixture', 'exchange/ex_fixture', $seq, $owner, $at, $seq, $seq)`,
      { owner, seq, at },
    );
    run(
      `INSERT INTO exchange_items (exchange_id, task_id, file, base)
       VALUES ('ex_fixture', $task, 'm-1.md', '{}')`,
      { task },
    );
  });
}

let fixture: { folder: string; machine: MachineInfo; facts: Facts };

beforeAll(async () => {
  const seeded = await seedMira(temp(), { seed: "migration-0.2", tasks: 40, steps: STEPS_0_2 });
  const checked = await checkedDriver();
  const writer = openSpaceAt(checked, seeded.folder, { role: "writer" }, STEPS_0_2);
  try {
    fill02(writer.conn);
  } finally {
    writer.conn.close();
  }
  fixture = {
    folder: seeded.folder,
    machine: { id: seeded.machine, name: MIRA.machine.name, os: MIRA.machine.os },
    facts: await factsOf(seeded.folder),
  };
  // A populated 0.2 space: user_version 2, every 0.2 table with rows, no 0.3 table, and the 0.2
  // release's schema to the last index and CHECK.
  expect(Object.keys(fixture.facts.counts).sort()).toEqual([...step0002.tables].sort());
  expect(fixture.facts.schemaDigest).toBe(RELEASED_SCHEMAS["0.2"]);
  for (const [table, n] of Object.entries(fixture.facts.counts)) {
    expect(n, table).toBeGreaterThan(0);
  }
}, 180_000);

/** A copy of the 0.2 fixture in a folder of its own, as `mira`. */
function copyOfFixture(): string {
  const folder = join(temp(), "mira");
  cpSync(fixture.folder, folder, { recursive: true });
  return folder;
}

describe("[A1.5.migration.from-0.2] the 0.2 fixture migrates to 0.3 behind its verified barrier backup", () => {
  test("every 0.2 row stays, the sessions and runs tables are empty, the schema is a new 0.3 space's, and the backup restores the fixture", async () => {
    const before = fixture.facts;
    const folder = copyOfFixture();
    // The 0.3 builds' chain: this test is the 0.3 step's (schema-0.4.test.ts migrates to 0.4).
    const worker = await workerWithSteps("0.3");
    try {
      // The storage worker's writer migrates on open, under the space's claim (A1 3.17).
      const writer = await worker.openSpaceWriter(folder, {
        backupDir: backupsBeside(folder),
        machine: fixture.machine,
      });
      expect(writer.revision).toEqual({ major: 0, minor: 3 });
      expect(writer.migration).toMatchObject({
        from: { major: 0, minor: 2 },
        to: { major: 0, minor: 3 },
        seqs: [before.lastSeq + 1],
        manifestWritten: true,
      });
      expect(writer.migration?.backup.sidecar).toMatchObject({
        kind: "pre-migrate",
        user_version: 2,
        seq: before.lastSeq,
        counts: before.counts,
      });
      await writer.close();
    } finally {
      await worker.close();
    }

    const checked = await checkedDriver();
    const opened = openSpaceAt(checked, folder, { role: "reader" }, STEPS_0_3);
    let migratedSchema: unknown[];
    try {
      const { conn } = opened;
      expect(opened.revision).toEqual({ major: 0, minor: 3 });
      expect(opened.readOnlyReasons).toEqual([]);
      expect(conn.pragma("user_version")).toBe(3);
      expect(conn.pragma("integrity_check")).toBe("ok");
      expect(conn.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // Every row of every 0.2 table is as it was, but the space row and the new commit.
      for (const table of step0002.tables) {
        if (table === "space" || table === "commits") continue;
        expect(rowsOf(conn, table), table).toEqual(before.rows[table]);
      }
      expect(rowsOf(conn, "space")).toEqual([
        {
          ...(before.rows["space"]?.[0] as object),
          format_minor: 3,
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
        { v: 1, op: "schema.migrate", target: spaceId, input: { step: 3, from: "0.2", to: "0.3" } },
      ]);
      for (const table of TABLES_0_3_NEW) expect(rowsOf(conn, table), table).toEqual([]);
      migratedSchema = schemaOf(conn);
      expect(digestSchema(conn)).toBe(RELEASED_SCHEMAS["0.3"]);
    } finally {
      opened.conn.close();
    }
    // A new 0.3 space has the same schema, byte for byte: create runs the same three steps.
    const fresh = createSpaceAt(
      checked,
      join(temp(), "fresh"),
      { name: "Fresh", ownerLabel: "Mira Okafor", machineId: fixture.machine.id },
      STEPS_0_3,
    );
    const freshConn = openSpace(checked, fresh.folder, { role: "reader" }).conn;
    try {
      expect(migratedSchema).toEqual(schemaOf(freshConn));
    } finally {
      freshConn.close();
    }
    const manifest = readManifest(folder);
    expect(manifest.state === "present" ? manifest.safety : undefined).toMatchObject({
      format: { major: 0, minor: 3 },
      min_reader: "0.0.0",
      min_writer: "0.0.0",
    });

    // The downgrade is a restore of the pre-migration backup (A1 3.17): the fixture's counts,
    // last_seq and rows.
    const barrier = listBackups(backupsBeside(folder)).backups.find(
      (b) => b.sidecar?.kind === "pre-migrate",
    );
    if (barrier === undefined) throw new Error("no barrier backup");
    const restoredFolder = join(temp(), "mira");
    const restored = await restoreBackup(checked, barrier.file, restoredFolder);
    expect(restored.revision).toEqual({ major: 0, minor: 2 });
    expect(restored.space.lastSeq).toBe(before.lastSeq);
    const after = await factsOf(restoredFolder);
    expect(after.counts).toEqual(before.counts);
    for (const table of step0002.tables) {
      if (table !== "space") expect(after.rows[table], table).toEqual(before.rows[table]);
    }
  }, 180_000);
});

describe("[A1.5.migration.statement-faults-0003] a fault at every statement boundary of the 0.2 to 0.3 migration leaves the space at 0.2", () => {
  test("each boundary fails in turn: the data is unchanged, the space opens read-only with A1's message, and the 0.2 build still writes it", async () => {
    const fault = new StatementFault();
    const faulting = await CheckedDriver.check(faultingDriver(nodeSqliteDriver, fault));
    const migrate = (folder: string) =>
      migrateSpaceWith(
        faulting,
        folder,
        { backupDir: backupsBeside(folder) },
        {
          steps: STEPS_0_3,
          at: (point) => {
            if (point === "backed-up") fault.armed = true;
          },
        },
      );

    // A clean run counts the boundaries: every statement of the step, and the runner's own.
    fault.reset(undefined);
    const clean = await migrate(copyOfFixture());
    expect(clean.state).toBe("migrated");
    expect(fault.began).toBe(true);
    const boundaries = fault.count;
    const trace = [...fault.trace];
    const at = SCHEMA_0_3_STATEMENTS.map((sql) => trace.indexOf(sql));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(trace.at(-1)).toBe("COMMIT");
    expect(boundaries).toBeGreaterThan(SCHEMA_0_3_STATEMENTS.length + 5);

    const checked = await checkedDriver();
    const expectFixture = (where: string, folder: string): void => {
      expect(digestSpace(checked, folder), where).toBe(fixture.facts.digest);
      const reader = openSpace(checked, folder, { role: "reader" });
      try {
        expect(reader.readOnlyReasons, where).toEqual(["older_revision"]);
        expect(reader.revision, where).toEqual({ major: 0, minor: 2 });
        expect(schemaOf(reader.conn), where).toEqual(fixture.facts.schema);
      } finally {
        reader.conn.close();
      }
      openSpaceAt(checked, folder, { role: "writer" }, STEPS_0_2).conn.close();
    };
    for (let n = 0; n < boundaries; n += 1) {
      const folder = copyOfFixture();
      fault.reset(n);
      const outcome = await migrate(folder);
      const where = `boundary ${String(n)} (${trace[n] ?? "?"})`;
      expect(fault.hit, where).toBe(true);
      if (outcome.state !== "failed") throw new Error(`${where}: the migration did not fail`);
      expect(outcome.stage, where).toBe("migration");
      expect(outcome.error.code, where).toBe("MIGRATION_FAILED");
      expect(outcome.error.message, where).toBe(
        "Migration to 0.3 failed (DURABILITY_FAILED). Your data is unchanged. " +
          `The space stays at 0.2. Backup: ${outcome.backup?.name ?? "?"}`,
      );
      expect(outcome.error.message, where).not.toContain(folder);
      expectFixture(where, folder);
    }

    // SQLite itself refuses the COMMIT, after every statement and boundary ran.
    {
      const folder = copyOfFixture();
      fault.reset(undefined, true);
      const outcome = await migrate(folder);
      expect(fault.hit).toBe(true);
      if (outcome.state !== "failed") throw new Error("a refused COMMIT did not fail");
      expect(outcome.error.message).toMatch(
        /^Migration to 0\.3 failed \([A-Z_]+\)\. Your data is unchanged\. The space stays at 0\.2\. Backup: pre-migrate-/,
      );
      expectFixture("a refused COMMIT", folder);
    }

    // And with no fault the same copy migrates: a failure leaves nothing that blocks the next try.
    const folder = copyOfFixture();
    fault.reset(boundaries);
    expect((await migrate(folder)).state).toBe("migrated");
    expect(fault.hit).toBe(false);
  }, 600_000);
});

describe("[A1.5.migration.run-parents-0003] a run outlives the redaction of its task on a migrated space", () => {
  test("on the migrated 0.2 fixture a task's run is detached from its task, still reads and settles, and no run holds both parents", async () => {
    const checked = await checkedDriver();
    const folder = copyOfFixture();
    expect(
      (
        await migrateSpaceWith(
          checked,
          folder,
          { backupDir: backupsBeside(folder) },
          { steps: STEPS_0_3 },
        )
      ).state,
    ).toBe("migrated");
    let time = Date.UTC(2026, 10, 14, 9, 0, 0);
    const openWriter = (): SpaceWriter =>
      SpaceWriter.open(openSpaceAt(checked, folder, { role: "writer" }, STEPS_0_3), {
        machine: fixture.machine,
        now: () => (time += 1),
      });
    const first = (conn: Connection, sql: string): string =>
      String(Object.values(conn.prepare(sql).get() ?? {})[0]);

    let task: string;
    let human: string;
    {
      const reader = openSpace(checked, folder, { role: "reader" });
      try {
        task = first(
          reader.conn,
          "SELECT id FROM tasks WHERE deleted_at IS NULL AND lifecycle = 'active' " +
            "ORDER BY ref LIMIT 1",
        );
        human = first(reader.conn, "SELECT id FROM actors WHERE kind = 'human'");
      } finally {
        reader.conn.close();
      }
    }
    const actor: Credential = {
      scope_id: "ui:fixture",
      principal_id: human as Credential["principal_id"],
      actor_kind: "human",
      machine_id: fixture.machine.id,
      origin: "ui",
    };
    let requests = 0;
    let writer = openWriter();
    const submit = (op: Operation) =>
      writer.submit({
        space_id: (fixture.facts.rows["space"]?.[0] as { space_id: string }).space_id,
        request_id: `run-parents-${String((requests += 1)).padStart(8, "0")}`,
        actor,
        ops: [op],
      });
    // A task's run in the task's own place, written as the execution store writes it: through the
    // write path.
    let run: string;
    let place: string;
    try {
      const placed = submit({
        kind: "place.set",
        task,
        root: "work",
        path: "lumen/portal-redaction",
      });
      expect(placed.status).toBe("applied");
      place = String(placed.results[0]?.id);
      const created = submit({
        kind: "run.create",
        task: task as Id<"t">,
        instance: "codex-work",
        adapter: "codex",
        place: place as Id<"pl">,
        request: "Check the export and fix the time zone.",
        brief_hash: "7c2e9a41".repeat(8),
        permission: "full-access",
        limits: { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 },
      });
      expect(created.status).toBe("applied");
      run = String(created.results[0]?.id);
      expect(writer.run(run)).toMatchObject({
        task_id: task,
        place_id: place,
        state: "queued",
      });
    } finally {
      writer.close();
    }

    // Entity redaction (A1 3.11.4, M3.14) keeps the task's runs and sessions with no task, and a
    // run without the task's place, whose row it deletes, and scrubs the run's task text. This is
    // the part of it these tables must allow (fixture rows without history: M3.14 writes it with
    // its history and scrubs the change rows too).
    const session = "se_0000000000000000000000000s";
    {
      const { conn } = openSpaceAt(checked, folder, { role: "writer" }, STEPS_0_3);
      try {
        conn.transaction("immediate", () => {
          conn
            .prepare(
              "INSERT INTO sessions (id, task_id, kind, instance_id, machine_id, state, " +
                "created_at, created_seq, version) VALUES ($session, $task, 'run', 'codex-work', " +
                "$machine, 'ended', $at, 1, 1)",
            )
            .run({ session, task, machine: fixture.machine.id, at: time });
          conn
            .prepare(
              "UPDATE runs SET task_id = NULL, place_id = NULL, request = NULL, result = " +
                "CASE result WHEN '{}' THEN result " +
                "ELSE json_set(result, '$.text', NULL, '$.error', NULL) END WHERE id = $run",
            )
            .run({ run });
          conn.prepare("UPDATE sessions SET task_id = NULL WHERE id = $session").run({ session });
        });
        expect(conn.pragma("integrity_check")).toBe("ok");
        expect(conn.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        for (const table of ["runs", "sessions"]) {
          expect(
            conn.prepare(`SELECT count(*) AS n FROM ${table} WHERE task_id = $task`).get({ task }),
            table,
          ).toEqual({ n: 0 });
        }
        // A run never holds both parents: the table refuses it, whatever writes it.
        expect(() =>
          conn
            .prepare("UPDATE runs SET task_id = $task, routine_id = $routine WHERE id = $run")
            .run({ task, routine: "ro_0000000000000000000000000r", run }),
        ).toThrow(/SQLITE_CONSTRAINT_CHECK/);
      } finally {
        conn.close();
      }
    }

    // The detached run still reads, and still settles: its state machine never looks at its task.
    writer = openWriter();
    try {
      const detached = writer.run(run);
      expect(detached).toMatchObject({ task_id: null, request: null });
      const settled = submit({
        kind: "run.transition",
        run: run as Id<"ru">,
        expect: "queued",
        expect_version: detached?.version ?? 0,
        next: "cancelled",
      });
      expect(settled.status).toBe("applied");
      expect(writer.run(run)).toMatchObject({
        task_id: null,
        state: "cancelled",
      });
    } finally {
      writer.close();
    }
  }, 180_000);
});

describe("[A1.5.migration.older-build-0003] a 0.2 build refuses to open a 0.3 space writable", () => {
  test("the 0.2 chain's writer is refused and changes nothing, its reader reads, and it restores no 0.3 backup", async () => {
    const checked = await checkedDriver();
    const folder = copyOfFixture();
    expect(
      (
        await migrateSpaceWith(
          checked,
          folder,
          { backupDir: backupsBeside(folder) },
          { steps: STEPS_0_3 },
        )
      ).state,
    ).toBe("migrated");
    const before = digestSpace(checked, folder);

    let refused: unknown;
    try {
      openSpaceAt(checked, folder, { role: "writer" }, STEPS_0_2).conn.close();
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(StorageError);
    expect((refused as StorageError).code).toBe("SPACE_TOO_NEW");
    expect(digestSpace(checked, folder)).toBe(before);
    const reader = openSpaceAt(checked, folder, { role: "reader" }, STEPS_0_2);
    try {
      expect(reader.readOnlyReasons).toEqual(["newer_revision"]);
      expect(reader.revision).toEqual({ major: 0, minor: 3 });
    } finally {
      reader.conn.close();
    }

    // The 0.2 build's storage worker, as its service opens a space: refused as the writer.
    const old = await workerWithSteps("0.2");
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
      await restoreBackupWith(checked, backup.file, join(temp(), "mira"), {}, { steps: STEPS_0_2 });
    } catch (error) {
      restoreError = error;
    }
    expect((restoreError as StorageError).code).toBe("SPACE_TOO_NEW");
  }, 180_000);
});
