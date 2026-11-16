// The Mira sample space: deterministic from its seed, consistent with A1's invariants as far as
// they exist before the write path, and a fixture on which the schema's CHECKs refuse bad values.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOSED_ENUMS,
  JSON_COLUMNS,
  openSpace,
  readReceipt,
  StorageError,
  type Connection,
} from "@tasks/storage";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
// The registry's receipt.get shape. testkit does not depend on contracts; its tests may reach it.
import { STEPS_0_1 } from "@tasks/storage/revisions";
import { ReceiptGetResult, receiptResult } from "../../contracts/src/index.ts";
import { digestDatabase, digestSchema, digestSpace } from "./digest.ts";
import { FIXED_SAMPLE, FIXED_SAMPLE_0_1, RELEASED_SCHEMAS } from "./known.ts";
import { checkedDriver, MAX_TASKS, seedMira } from "./mira.ts";
import { Rng } from "./rng.ts";

/**
 * The tables of schema 0.2 that no operation writes yet, so the sample leaves them empty: labels
 * (the label operations), proposals (M4.02), exchanges (M7.05 and M7.06), attachments (after v1).
 * The step that brings an operation moves its table's rows into the sample, as the StandIn comment
 * in mira.ts says: learnings came with M3.04's wrap-up.
 */
const EMPTY_0_2 = [
  "labels",
  "task_labels",
  "attachments",
  "proposals",
  "exchanges",
  "exchange_items",
] as const;

/**
 * The table of schema 0.3 that no operation writes yet: sessions, whose records still live in
 * machine state until binding writes them (A4 3.10). The sample writes runs (M6.01).
 */
const EMPTY_0_3 = ["sessions"] as const;

const made: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "mira-"));
  made.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The history of the sample: every change names its row and the operation it belongs to, and
 * every operation has the writer's `commits.ops` shape.
 */
function checkHistory(conn: Connection): void {
  const one = (sql: string): unknown => Object.values(conn.prepare(sql).get() ?? {})[0];
  // A change's op indexes its commit's ops, and that operation targets the row, the source of a
  // source link, or the task of a learning its wrap-up adds. (The reviewer's query counted op 0
  // for every change of a multi-operation commit.)
  expect(
    one(
      `SELECT count(*) FROM changes c JOIN commits k ON c.seq = k.seq
       WHERE c.op < 0 OR c.op >= json_array_length(k.ops)
          OR (json_extract(k.ops, '$[' || c.op || '].target') <> c.entity_id
              AND c.entity_id NOT LIKE '%|' || json_extract(k.ops, '$[' || c.op || '].target')
              AND NOT (c.entity = 'learnings'
                AND json_extract(k.ops, '$[' || c.op || '].op') = 'task.wrap_up'
                AND c.task_id = json_extract(k.ops, '$[' || c.op || '].target')))`,
    ),
  ).toBe(0);
  // The learnings came through the writer's wrap-up.
  expect(one("SELECT count(*) FROM learnings")).toBe(
    one("SELECT count(*) FROM changes WHERE entity = 'learnings' AND action = 'create'"),
  );
  // Every operation is {v: 1, op, target, input}.
  expect(
    one(
      `SELECT count(*) FROM commits k, json_each(k.ops) o
       WHERE json_extract(o.value, '$.v') IS NOT 1 OR json_type(o.value, '$.op') IS NOT 'text'
          OR json_type(o.value, '$.target') IS NOT 'text' OR json_type(o.value, '$.input') IS NOT 'object'`,
    ),
  ).toBe(0);
  // The machine was registered by the writer, and the tasks were written by it.
  expect(one("SELECT json_extract(ops, '$[0].op') FROM commits WHERE seq = 1")).toBe(
    "machine.register",
  );
  expect(
    one("SELECT count(*) FROM commits WHERE json_extract(ops, '$[0].op') = 'task.create'"),
  ).toBe(one("SELECT count(*) FROM tasks"));
  // The multi-operation commits use their later operations too.
  expect(one("SELECT count(*) FROM changes WHERE op > 0")).not.toBe(0);
  // A preference has a key, not an ID: its changes name the key, never "undefined".
  const preferences = conn
    .prepare(
      "SELECT entity_id, json_extract(after, '$.key') AS key FROM changes WHERE entity = 'preferences'",
    )
    .all<{ entity_id: string; key: string }>();
  expect(preferences.length).toBeGreaterThan(0);
  for (const { entity_id, key } of preferences) expect(entity_id).toBe(key);
  expect(one("SELECT count(*) FROM changes WHERE entity_id LIKE '%undefined%'")).toBe(0);
  // Every source key is unique, and every live source has one.
  expect(one("SELECT count(DISTINCT source_key) FROM sources")).toBe(
    one("SELECT count(*) FROM sources"),
  );
  // Every request's commit has its receipt, and every applied receipt names its request's commit
  // (A1 3.8). The machine's own system commit has none.
  expect(
    one(
      `SELECT count(*) FROM commits k LEFT JOIN receipts r
         ON r.scope_id = k.scope_id AND r.request_id = k.request_id AND r.seq = k.seq
       WHERE k.scope_id <> 'system' AND r.seq IS NULL`,
    ),
  ).toBe(0);
  expect(
    one(
      `SELECT count(*) FROM receipts r LEFT JOIN commits k ON k.seq = r.seq
       WHERE (r.status = 'applied') <> (r.seq IS NOT NULL)
          OR (r.seq IS NOT NULL AND (k.request_id IS NOT r.request_id OR k.scope_id IS NOT r.scope_id))`,
    ),
  ).toBe(0);
  // The notes, log entries, sources and the place came through the writer: one per operation.
  expect(one("SELECT count(*) FROM notes")).toBe(
    one("SELECT count(*) FROM commits k, json_each(k.ops) o WHERE o.value ->> 'op' = 'note.add'"),
  );
  expect(one("SELECT count(*) FROM places")).toBe(1);
}

/**
 * One valid row in each table of EMPTY_0_2, pointing at the sample's own task, owner and seq. For
 * the CHECK tests only: no operation, no history.
 */
function fillEmpty02(conn: Connection): void {
  const one = (sql: string): unknown => Object.values(conn.prepare(sql).get() ?? {})[0];
  const task = String(one("SELECT id FROM tasks ORDER BY ref LIMIT 1"));
  const owner = String(one("SELECT id FROM actors WHERE kind = 'human'"));
  const seq = Number(one("SELECT last_seq FROM space"));
  const at = Number(one("SELECT max(at) FROM commits"));
  const space = conn.prepare("SELECT authority_epoch, authority_incarnation FROM space").get();
  const row = { task, owner, seq, at };
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
      `INSERT INTO attachments (id, task_id, sha256, size, media_type, filename, created_by,
         created_at, created_seq, version)
       VALUES ('at_fixture', $task, $sha, 12, 'text/plain', 'notes.txt', $owner, $at, $seq, $seq)`,
      { ...row, sha: "0".repeat(64) },
    );
    run(
      `INSERT INTO proposals (id, task_id, author_id, origin, ops, base_epoch, base_incarnation,
         base_seq, created_at, created_seq, version)
       VALUES ('pr_fixture', $task, $owner, 'autonomy', '[]', $epoch, $incarnation, $seq, $at,
         $seq, $seq)`,
      {
        ...row,
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

/**
 * One valid row in each table of EMPTY_0_3, as fillEmpty02 does: no operation, no history. The
 * sample's machine is the authority's.
 */
function fillEmpty03(conn: Connection): void {
  const one = (sql: string): unknown => Object.values(conn.prepare(sql).get() ?? {})[0];
  const params = {
    task: String(one("SELECT id FROM tasks ORDER BY ref LIMIT 1")),
    machine: String(one("SELECT authority_machine FROM space")),
    seq: Number(one("SELECT last_seq FROM space")),
    at: Number(one("SELECT max(at) FROM commits")),
  };
  conn.transaction("immediate", () => {
    const run = (sql: string): void => {
      conn.prepare(sql).run(params);
    };
    if ((EMPTY_0_3 as readonly string[]).includes("sessions")) {
      run(
        `INSERT INTO sessions (id, task_id, kind, instance_id, machine_id, state, created_at,
           created_seq, version)
         VALUES ('se_fixture', $task, 'interactive', 'codex-work', $machine, 'live', $at,
           $seq, $seq)`,
      );
    }
    if ((EMPTY_0_3 as readonly string[]).includes("runs")) {
      run(
        `INSERT INTO runs (id, task_id, instance_id, machine_id, adapter, state, queued_at,
           created_seq, version)
         VALUES ('ru_fixture', $task, 'codex-work', $machine, 'codex-exec', 'queued', $at,
           $seq, $seq)`,
      );
    }
  });
}

describe("[A7.3.3.seed.deterministic] the Mira generator is deterministic", () => {
  test("the same seed and size give the same space twice, with the fixed digest", async () => {
    const checked = await checkedDriver();
    const { seed, tasks, digest } = FIXED_SAMPLE;
    const a = await seedMira(temp(), { seed, tasks });
    const b = await seedMira(temp(), { seed, tasks });
    expect(a.counts).toEqual(b.counts);
    expect(digestSpace(checked, a.folder)).toBe(digestSpace(checked, b.folder));
    expect(digestSpace(checked, a.folder)).toBe(digest);
  });

  test("built with the 0.1 chain, the known sample is the one the 0.1 builds made", async () => {
    // The 0.1 fixture builder (M3.01): a 0.1 space, through the same write path, with the digest
    // the released 0.1 builds gave the known sample.
    const checked = await checkedDriver();
    const { seed, tasks, digest } = FIXED_SAMPLE_0_1;
    const a = await seedMira(temp(), { seed, tasks, steps: STEPS_0_1 });
    expect(digestSpace(checked, a.folder)).toBe(digest);
    const { conn, revision } = openSpace(checked, a.folder, { role: "reader" });
    try {
      expect(revision).toEqual({ major: 0, minor: 1 });
      expect(conn.pragma("user_version")).toBe(1);
      // The rows' digest does not see an index or a CHECK: the 0.1 schema is pinned on its own.
      expect(digestSchema(conn)).toBe(RELEASED_SCHEMAS["0.1"]);
    } finally {
      conn.close();
    }
    // The sample at this build's revision holds the same rows in every 0.1 table: 0.2 to 0.5 add
    // only tables and the space's hold, and the sample's requests that need them. Its eight run
    // requests (0.3) each add a commit, a receipt and a change row. Mira's wrap-up with two
    // learnings (0.2) adds one commit with its receipt, the task's wrap change and the two
    // learnings. Her folders (0.5), the last request, add one commit with its receipt and two
    // folder rows with their create changes.
    const b = await seedMira(temp(), { seed, tasks });
    const more = (table: string, n: number): [string, number] => [
      table,
      (a.counts[table] ?? 0) + n,
    ];
    expect(b.counts).toEqual({
      ...a.counts,
      ...Object.fromEntries([...EMPTY_0_2, ...EMPTY_0_3].map((t) => [t, 0])),
      ...Object.fromEntries([more("commits", 10), more("receipts", 10), more("changes", 13)]),
      learnings: 2,
      runs: 2,
      folders: 2,
    });
    expect(b.machine).toBe(a.machine);
  });

  test("another seed or size gives another space", async () => {
    const checked = await checkedDriver();
    const base = digestSpace(checked, (await seedMira(temp(), { seed: "fixed", tasks: 3 })).folder);
    const seed = digestSpace(checked, (await seedMira(temp(), { seed: "other", tasks: 3 })).folder);
    const size = digestSpace(checked, (await seedMira(temp(), { seed: "fixed", tasks: 4 })).folder);
    expect(new Set([base, seed, size]).size).toBe(3);
  });

  test("the seeded random source gives one sequence per seed", () => {
    const draw = (seed: string) => {
      const rng = new Rng(seed);
      const bytes = new Uint8Array(7);
      rng.fill(bytes);
      return [rng.u32(), rng.range(1, 6), [...bytes]];
    };
    expect(draw("fixed")).toEqual(draw("fixed"));
    expect(draw("fixed")).not.toEqual(draw("other"));
  });

  test("the size is checked", async () => {
    await expect(seedMira(temp(), { tasks: 0 })).rejects.toThrow(RangeError);
    await expect(seedMira(temp(), { tasks: 1.5 })).rejects.toThrow(RangeError);
    await expect(seedMira(temp(), { tasks: MAX_TASKS + 1 })).rejects.toThrow(RangeError);
  });

  // Seed "fixed" at the largest size must not collide on a UNIQUE source key. About 2 s on
  // Windows 11. The sample flushes once, at its close (mira.ts), so the time is the generator's
  // work and not the disk's; the timeout allows a slow CI runner.
  test("the largest size the script accepts builds, with a valid history", async () => {
    const space = await seedMira(temp(), { seed: "fixed", tasks: MAX_TASKS });
    expect(space.counts["tasks"]).toBe(MAX_TASKS);
    const { conn } = openSpace(await checkedDriver(), space.folder, { role: "reader" });
    try {
      checkHistory(conn);
      expect(Object.values(conn.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
    } finally {
      conn.close();
    }
  });
});

describe("[A1.5.write.receipts] the sample's receipts are receipt.get's results", () => {
  test("every receipt of the known sample fits receipt.get's schema", async () => {
    const { seed, tasks } = FIXED_SAMPLE;
    const space = await seedMira(temp(), { seed, tasks });
    const { conn } = openSpace(await checkedDriver(), space.folder, { role: "reader" });
    try {
      const keys = conn.prepare("SELECT scope_id, request_id FROM receipts ORDER BY at").all();
      expect(keys.length).toBeGreaterThan(5);
      for (const key of keys) {
        const lookup = { scope_id: String(key["scope_id"]), request_id: String(key["request_id"]) };
        const output = receiptResult(readReceipt(conn, lookup));
        expect(output.found).toBe(true);
        expect(ReceiptGetResult.safeParse(output).error, lookup.request_id).toBeUndefined();
      }
    } finally {
      conn.close();
    }
  });
});

describe("[A1.5.schema.lint] on the sample space, the CHECKs refuse what the schema forbids", () => {
  let conn: Connection;
  let counts: Record<string, number>;

  beforeAll(async () => {
    const space = await seedMira(temp(), { seed: "lint", tasks: 12 });
    conn = openSpace(await checkedDriver(), space.folder, { role: "writer" }).conn;
    // One valid row in each 0.2 table the sample leaves empty, so every CHECK below is tried on a
    // real row. Fixture rows without history, in this throwaway copy only.
    expect(EMPTY_0_2.map((t) => space.counts[t])).toEqual(EMPTY_0_2.map(() => 0));
    expect(EMPTY_0_3.map((t) => space.counts[t])).toEqual(EMPTY_0_3.map(() => 0));
    fillEmpty02(conn);
    fillEmpty03(conn);
    counts = Object.fromEntries(
      Object.keys(space.counts).map((t) => [
        t,
        Number(conn.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.["n"]),
      ]),
    );
  });

  afterAll(() => {
    conn.close();
  });

  afterEach(() => {
    expect(conn.inTransaction).toBe(false);
  });

  /** One statement in its own transaction, which must fail with a constraint error. */
  function refused(sql: string): void {
    try {
      conn.transaction("immediate", () => conn.prepare(sql).run());
    } catch (error) {
      expect(error, sql).toBeInstanceOf(StorageError);
      expect((error as StorageError).code, sql).toBe("STORAGE_CONSTRAINT");
      return;
    }
    throw new Error(`not refused: ${sql}`);
  }

  test("every table of this build's schema has rows: the sample's, and one each where no operation writes yet", () => {
    for (const [table, n] of Object.entries(counts)) expect(n, table).toBeGreaterThan(0);
    expect(Object.keys(counts)).toEqual(expect.arrayContaining([...EMPTY_0_2, ...EMPTY_0_3]));
  });

  test("a value outside a closed enumeration is refused in every enum column", () => {
    for (const [table, columns] of Object.entries(CLOSED_ENUMS)) {
      for (const [column, values] of Object.entries(columns)) {
        const bad = typeof values[0] === "number" ? "7" : "'not_a_value'";
        refused(`UPDATE ${table} SET ${column} = ${bad}`);
      }
    }
  });

  test("invalid JSON is refused in every JSON column", () => {
    for (const [table, columns] of Object.entries(JSON_COLUMNS)) {
      for (const column of columns) refused(`UPDATE ${table} SET ${column} = '{'`);
    }
  });

  test("STRICT refuses a value of the wrong type, and the task rules hold", () => {
    refused("UPDATE tasks SET priority = 'high'");
    refused("UPDATE tasks SET priority = 5");
    refused("UPDATE tasks SET title = ''");
    refused("UPDATE tasks SET title = 'two' || char(10) || 'lines'");
    refused("UPDATE tasks SET wrap_state = 'pending' WHERE lifecycle = 'active'");
    refused("UPDATE tasks SET due_at = 1, due_tz = NULL");
    refused("UPDATE places SET root_id = 'Work'");
    refused("UPDATE outbox SET first_seq = seq + 1");
    refused("UPDATE notes SET author_id = 'ac_missing'");
  });

  test("the sample keeps A1's invariants: history, versions, references, foreign keys", () => {
    const one = (sql: string): unknown => Object.values(conn.prepare(sql).get() ?? {})[0];
    expect(one("PRAGMA integrity_check")).toBe("ok");
    expect(conn.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const lastSeq = one("SELECT last_seq FROM space");
    expect(lastSeq).toBe(one("SELECT max(seq) FROM commits"));
    expect(one("SELECT count(*) FROM commits")).toBe(lastSeq);
    expect(one("SELECT next_ref FROM space")).toBe(one("SELECT max(ref) + 1 FROM tasks"));
    // Every change belongs to a commit, and every field version is a commit of a change to it.
    expect(one("SELECT count(*) FROM changes WHERE seq NOT IN (SELECT seq FROM commits)")).toBe(0);
    const fields = conn
      .prepare("SELECT id, fv, fp, version, created_seq FROM tasks")
      .all<{ id: string; fv: string; fp: string; version: number; created_seq: number }>();
    for (const task of fields) {
      const fv = JSON.parse(task.fv) as Record<string, number>;
      expect(JSON.parse(task.fp)).toEqual(fv);
      for (const [field, seq] of Object.entries(fv)) {
        const latest = conn
          .prepare(
            "SELECT max(seq) AS seq FROM changes WHERE entity = 'tasks' AND entity_id = $id AND field = $f",
          )
          .get<{ seq: number }>({ id: task.id, f: field });
        expect(latest?.seq).toBe(seq);
      }
      expect(task.version).toBe(Math.max(task.created_seq, ...Object.values(fv)));
    }
    // Every task the history touched waits in the outbox for the projection.
    expect(one("SELECT count(*) FROM tasks WHERE id NOT IN (SELECT key FROM outbox)")).toBe(0);
    checkHistory(conn);
  });

  test("the database digest ignores file layout: a VACUUM changes no digest", () => {
    const before = digestDatabase(conn);
    conn.exec("VACUUM");
    expect(digestDatabase(conn)).toBe(before);
  });
});
