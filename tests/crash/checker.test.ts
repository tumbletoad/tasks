// The crash harness's checker must be able to fail: each guarantee it checks is broken on purpose
// in a real space written through the write path, and the checker must name it. A checker that
// passes everything would make every clean crash run worthless. Fixture data only, in temporary
// folders.
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  backupSpace,
  makeDurableFolder,
  type BackupRecord,
} from "../../packages/storage/src/backup/backup.ts";
import { newId, osRandom, type Id } from "../../packages/storage/src/ids.ts";
import { claimSpace } from "../../packages/storage/src/restore/claim.ts";
import { swapIntoPlace, swapNames } from "../../packages/storage/src/restore/folders.ts";
import { restoreInPlace } from "../../packages/storage/src/restore/restore.ts";
import { unpackBackup } from "../../packages/storage/src/restore/unpack.ts";
import { DATABASE_FILE, manifestFor, writeManifest } from "../../packages/storage/src/manifest.ts";
import { openWriter } from "../../packages/storage/src/open.ts";
import { SCHEMA_0_2_STATEMENTS } from "../../packages/storage/migrations/0002-schema-0.2.ts";
import { SCHEMA_0_3_STATEMENTS } from "../../packages/storage/migrations/0003-schema-0.3.ts";
import { SCHEMA_0_4_STATEMENTS } from "../../packages/storage/migrations/0004-schema-0.4.ts";
import { SCHEMA_0_5_STATEMENTS } from "../../packages/storage/migrations/0005-schema-0.5.ts";
import { SCHEMA_0_6_STATEMENTS } from "../../packages/storage/migrations/0006-schema-0.6.ts";
import { SOURCE_APP_VERSION } from "../../packages/storage/src/space.ts";
import type { CheckedDriver } from "../../packages/storage/src/startup-check.ts";
import { formatAsOf, type WriteRequest } from "../../packages/storage/src/write/request.ts";
import { SpaceWriter } from "../../packages/storage/src/write/writer.ts";
import { FIXTURE_MACHINE } from "../../packages/storage/test/fixture-requests.ts";
import { createSpaceAt, openSpaceAt } from "../../packages/storage/test/revisions.ts";
import { checkedDriver } from "../../packages/storage/test/space-helpers.ts";
import { checkFolders, checkSpace } from "./checker.ts";
import { Ledger, type Violation } from "./ledger.ts";
import { backupsBeside, reduce, type Acked, type BackupFacts } from "./protocol.ts";
import {
  CREATE_STEPS,
  REVISION_0_1,
  REVISION_0_2,
  REVISION_0_3,
  REVISION_0_4,
  REVISION_0_5,
  REVISION_0_6,
} from "./steps.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Built {
  checked: CheckedDriver;
  ledger: Ledger;
  folder: string;
  /** The task the requests created first. */
  task: Id<"t">;
}

/**
 * A space at 0.1 with a history the ledger acknowledged: creates (one with a note and a source in
 * the same request), an agent actor's registration and its first request, patches, a request
 * decided twice-in-one, a note, a log entry, a conflict and a rejection.
 */
async function build(): Promise<Built> {
  const dir = mkdtempSync(join(tmpdir(), "ttasks-crash-checker-"));
  made.push(dir);
  mkdirSync(join(dir, "s1"));
  const checked = await checkedDriver();
  // At 0.1, as the harness creates its spaces (steps.ts).
  const created = createSpaceAt(
    checked,
    join(dir, "s1", "space"),
    { name: "Crash", ownerLabel: "Crash owner", machineId: FIXTURE_MACHINE.id, refPrefix: "CR" },
    CREATE_STEPS,
  );
  makeDurableFolder(backupsBeside(created.folder));
  const { authority } = created.space;
  const ledger = new Ledger(created.folder, created.space.spaceId, created.actors.human);
  ledger.incarnation = authority.incarnation;
  ledger.epoch = authority.epoch;
  ledger.epochs.add(authority.epoch);
  ledger.revision = REVISION_0_1;
  const writer = SpaceWriter.open(
    openSpaceAt(checked, created.folder, { role: "writer" }, CREATE_STEPS),
    { machine: FIXTURE_MACHINE },
  );
  const task = newId("t");
  const other = newId("t");
  let n = 0;
  const send = (
    ops: WriteRequest["ops"],
    base?: string,
    agent?: { label: string; id: Id<"ac"> },
  ): Acked => {
    n += 1;
    const request_id = `checker-request-${String(n).padStart(4, "0")}`;
    const scope_id = agent === undefined ? "cli:crash-1" : "cli:crash-9";
    // Planned as the harness plans: the checker compares each commit with its request.
    const key = `${scope_id} ${request_id}`;
    ledger.requests.set(key, {
      key,
      request_id,
      scope_id,
      base: base === undefined ? "none" : "fresh",
      ops,
      ...(agent === undefined ? {} : { agent: agent.label }),
    });
    const result = reduce(
      writer.submit({
        space_id: created.space.spaceId,
        request_id,
        actor: {
          scope_id,
          principal_id: agent?.id ?? created.actors.human,
          actor_kind: agent === undefined ? "human" : "agent",
          machine_id: FIXTURE_MACHINE.id,
          origin: "cli",
        },
        ops,
        ...(base === undefined ? {} : { base }),
      }),
    );
    ledger.take({ t: "ack", key, result });
    return result;
  };
  const first = send([
    { kind: "task.create", id: task, title: "Crash task 1" },
    { kind: "note.add", task, body: "Note 1" },
    { kind: "source.add", task, source: { kind: "ticket", title: "Source 1", key: "crash:k1" } },
  ]);
  send([{ kind: "task.create", id: other, title: "Crash task 2" }]);
  // An agent actor joins on its first act (actor.register, a system commit), then writes.
  const script = { label: "script", id: writer.actor("agent", "script") };
  send(
    [
      { kind: "task.create", id: newId("t"), title: "Crash task 3" },
      { kind: "log.add", task: other, body: "Log 0" },
    ],
    undefined,
    script,
  );
  const stale = first.as_of;
  const latest = send([{ kind: "task.patch", task, set: { summary: "Summary 1" } }], stale);
  send(
    [
      { kind: "task.patch", task: other, set: { summary: "First" } },
      { kind: "task.patch", task: other, set: { summary: "Second" } },
    ],
    latest.as_of,
  );
  send([{ kind: "log.add", task: other, body: "Log 1" }]);
  send([{ kind: "task.patch", task, set: { summary: "Late" } }], stale);
  send([{ kind: "task.complete", task: newId("t") }]);
  // A no-op: the task already holds this summary.
  send([{ kind: "task.patch", task, set: { summary: "Summary 1" } }], latest.as_of);
  send([{ kind: "task.complete", task: other }], formatAsOf(writer.asOf()));
  const space = writer.asOf();
  writer.close();
  ledger.base = formatAsOf(space);
  return { checked, ledger, folder: created.folder, task };
}

/** Runs SQL on the space's database with a raw writer, around the write path. */
function damage(built: Built, sql: string): void {
  const conn = openWriter(built.checked, join(built.folder, DATABASE_FILE));
  try {
    conn.exec(sql);
  } finally {
    conn.close();
  }
}

async function check(built: Built): Promise<Violation[]> {
  return [
    ...checkFolders(built.ledger),
    ...(await checkSpace(built.checked, built.ledger, new Set())).violations,
  ];
}

const names = (violations: readonly Violation[]): string[] => [
  ...new Set(violations.map((v) => v.invariant)),
];

/** What the child reports of a completed backup. */
const facts = (record: BackupRecord): BackupFacts => ({
  name: record.name,
  seq: record.sidecar.seq,
  incarnation: record.sidecar.incarnation,
  userVersion: record.sidecar.user_version,
});

const NEWEST = "(SELECT max(seq) FROM commits)";

// Each test builds one to three spaces and some take backups: room for a slow runner.
describe(
  "[A1.5.crash.checker] the crash harness's checker names each broken guarantee",
  { timeout: 60_000 },
  () => {
    test("a space written through the write path passes, and the statuses the history needs are there", async () => {
      const built = await build();
      const statuses = [...built.ledger.expected.values()].map((a) => a.status);
      expect(new Set(statuses)).toEqual(new Set(["applied", "unchanged", "conflict", "rejected"]));
      const result = await checkSpace(built.checked, built.ledger, new Set());
      expect(result.violations).toEqual([]);
      expect(result.observed?.space.lastSeq).toBeGreaterThan(4);
    });

    test("a lost commit: an acknowledged commit, its changes and its receipt gone", async () => {
      const built = await build();
      damage(
        built,
        `DELETE FROM changes WHERE seq = ${NEWEST}; DELETE FROM receipts WHERE seq = ${NEWEST};
       DELETE FROM commits WHERE seq = ${NEWEST}; UPDATE space SET last_seq = last_seq - 1`,
      );
      expect(names(await check(built))).toContain("acked-present");
    });

    test("a commit without its receipt, and a receipt without its commit", async () => {
      const built = await build();
      damage(built, `DELETE FROM receipts WHERE seq = ${NEWEST}`);
      expect(names(await check(built))).toContain("receipt-per-commit");
      const other = await build();
      damage(other, "UPDATE receipts SET seq = 999 WHERE status = 'applied' AND seq = 2");
      expect(names(await check(other))).toContain("receipt-per-commit");
      const third = await build();
      damage(third, "UPDATE receipts SET scope_id = 'system' WHERE status = 'conflict'");
      expect(names(await check(third))).toContain("receipt-per-commit");
    });

    test("half a request: one of the rows a request created is missing its create change", async () => {
      const built = await build();
      damage(built, "DELETE FROM changes WHERE entity = 'notes'");
      expect(names(await check(built))).toEqual(
        expect.arrayContaining(["request-whole", "history"]),
      );
      const ops = await build();
      damage(
        ops,
        "UPDATE commits SET ops = json_remove(ops, '$[2]') WHERE json_array_length(ops) = 3",
      );
      expect(names(await check(ops))).toContain("request-whole");
    });

    test("history: fv off its latest change, two rows for one field in one commit, a broken chain", async () => {
      const built = await build();
      damage(
        built,
        `UPDATE tasks SET fv = json_set(fv, '$.summary', 1) WHERE id = '${built.task}'`,
      );
      expect(names(await check(built))).toContain("history");
      const doubled = await build();
      damage(
        doubled,
        "INSERT INTO changes SELECT seq, n + 100, op, entity, entity_id, task_id, action, field, " +
          "before, after, before_ver, before_prov, after_prov FROM changes WHERE field = 'summary' LIMIT 1",
      );
      expect(names(await check(doubled))).toContain("history");
      const value = await build();
      damage(
        value,
        `UPDATE tasks SET summary = 'Changed around the write path' WHERE id = '${value.task}'`,
      );
      expect(names(await check(value))).toContain("history");
    });

    test("a migration half done: a revision between whole migrations, or a step's table without its revision", async () => {
      // What a migration that committed each step on its own would leave after a kill between them:
      // the real 0.2 whole and the rest not started, or the real steps whole and the stand-in 0.7
      // not started. The build knows every revision, so the space opens.
      const built = await build();
      damage(
        built,
        [
          ...SCHEMA_0_2_STATEMENTS,
          `UPDATE space SET format_minor = 2; PRAGMA user_version = ${String(REVISION_0_2)}`,
        ].join("; "),
      );
      expect(names(await check(built))).toEqual(["migration-atomic"]);
      const two = await build();
      damage(
        two,
        [
          ...SCHEMA_0_2_STATEMENTS,
          ...SCHEMA_0_3_STATEMENTS,
          `UPDATE space SET format_minor = 3; PRAGMA user_version = ${String(REVISION_0_3)}`,
        ].join("; "),
      );
      expect(names(await check(two))).toEqual(["migration-atomic"]);
      const three = await build();
      damage(
        three,
        [
          ...SCHEMA_0_2_STATEMENTS,
          ...SCHEMA_0_3_STATEMENTS,
          ...SCHEMA_0_4_STATEMENTS,
          `UPDATE space SET format_minor = 4; PRAGMA user_version = ${String(REVISION_0_4)}`,
        ].join("; "),
      );
      expect(names(await check(three))).toEqual(["migration-atomic"]);
      const four = await build();
      damage(
        four,
        [
          ...SCHEMA_0_2_STATEMENTS,
          ...SCHEMA_0_3_STATEMENTS,
          ...SCHEMA_0_4_STATEMENTS,
          ...SCHEMA_0_5_STATEMENTS,
          `UPDATE space SET format_minor = 5; PRAGMA user_version = ${String(REVISION_0_5)}`,
        ].join("; "),
      );
      expect(names(await check(four))).toEqual(["migration-atomic"]);
      const five = await build();
      damage(
        five,
        [
          ...SCHEMA_0_2_STATEMENTS,
          ...SCHEMA_0_3_STATEMENTS,
          ...SCHEMA_0_4_STATEMENTS,
          ...SCHEMA_0_5_STATEMENTS,
          ...SCHEMA_0_6_STATEMENTS,
          `UPDATE space SET format_minor = 6; PRAGMA user_version = ${String(REVISION_0_6)}`,
        ].join("; "),
      );
      expect(names(await check(five))).toEqual(["migration-atomic"]);
      // A step's table at a revision before that step: the stand-in 0.7's, the real 0.6's, 0.5's,
      // 0.3's and 0.2's.
      const table = await build();
      damage(table, "CREATE TABLE test_labels (id TEXT PRIMARY KEY) STRICT");
      expect(names(await check(table))).toContain("migration-atomic");
      const pages = await build();
      damage(pages, "CREATE TABLE pages (id TEXT PRIMARY KEY) STRICT");
      expect(names(await check(pages))).toContain("migration-atomic");
      const folders = await build();
      damage(folders, "CREATE TABLE folders (id TEXT PRIMARY KEY) STRICT");
      expect(names(await check(folders))).toContain("migration-atomic");
      const runs = await build();
      damage(runs, "CREATE TABLE runs (id TEXT PRIMARY KEY) STRICT");
      expect(names(await check(runs))).toContain("migration-atomic");
      const real = await build();
      damage(real, "CREATE TABLE learnings (id TEXT PRIMARY KEY) STRICT");
      expect(names(await check(real))).toContain("migration-atomic");
    });

    test("counters going back: last_seq below its high water, next_ref at a used reference, an ordinal gap", async () => {
      const built = await build();
      const { incarnation } = built.ledger;
      built.ledger.highWater.set(incarnation, { seq: 1_000, nextRef: 1 });
      expect(names(await check(built))).toContain("counters-monotonic");
      const ref = await build();
      damage(ref, "UPDATE space SET next_ref = 1");
      expect(names(await check(ref))).toContain("counters-monotonic");
      const ordinal = await build();
      damage(ordinal, "UPDATE notes SET ordinal = ordinal + 1");
      expect(names(await check(ordinal))).toContain("counters-monotonic");
    });

    test("an incarnation that changed without a restore, or in the history without a claim", async () => {
      // A claim the harness never asked for: a whole, valid new incarnation.
      const built = await build();
      const conn = openWriter(built.checked, join(built.folder, DATABASE_FILE));
      try {
        claimSpace(conn, {
          kind: "restore_claim",
          machineId: FIXTURE_MACHINE.id,
          now: Date.now(),
          random: osRandom,
        });
      } finally {
        conn.close();
      }
      expect(names(await check(built))).toEqual(["incarnation"]);
      const history = await build();
      damage(history, `UPDATE commits SET incarnation = '${newId("ai")}' WHERE seq = 3`);
      expect(names(await check(history))).toContain("incarnation");
    });

    test("a backup that is incomplete, does not verify, or went missing", async () => {
      for (const harm of ["data", "bytes", "both"] as const) {
        const built = await build();
        const record = await backupSpace(built.checked, built.folder, {
          kind: "manual",
          backupDir: backupsBeside(built.folder),
        });
        built.ledger.take({ t: "backup-start", n: 1 });
        built.ledger.take({
          t: "backup-done",
          n: 1,
          backup: {
            name: record.name,
            seq: record.sidecar.seq,
            incarnation: record.sidecar.incarnation,
            userVersion: record.sidecar.user_version,
          },
        });
        if (harm === "data") unlinkSync(record.file);
        if (harm === "bytes")
          writeFileSync(record.file, Buffer.alloc(record.sidecar.compressed_size, 7));
        if (harm === "both") {
          unlinkSync(record.file);
          unlinkSync(record.sidecarFile);
        }
        expect(names(await check(built)), harm).toContain("backup-complete-or-absent");
      }
    });

    test("a folder a restore in place replaced that is gone", async () => {
      const built = await build();
      built.ledger.replaced.push({ incarnation: newId("ai"), expected: new Map() });
      expect(names(await check(built))).toContain("old-folder-kept");
    });

    test("a space folder that is gone, with no swap in progress", async () => {
      const built = await build();
      renameSync(built.folder, `${built.folder}-moved`);
      expect(names(checkFolders(built.ledger))).toEqual(["space-present"]);
    });

    test("a retry decided again, and a replay that differs from the first answer", async () => {
      const built = await build();
      const [key, acked] = [...built.ledger.expected.entries()][0] ?? [];
      if (key === undefined || acked === undefined) throw new Error("the history is empty");
      expect(
        names(built.ledger.take({ t: "ack", key, result: { ...acked, replayed: false } })),
      ).toEqual(["retry-applies-once"]);
      expect(
        names(
          built.ledger.take({
            t: "ack",
            key,
            result: { ...acked, replayed: true, seq: acked.seq + 1 },
          }),
        ),
      ).toEqual(["retry-replays-identically"]);
      expect(built.ledger.take({ t: "ack", key, result: { ...acked, replayed: true } })).toEqual(
        [],
      );
      // A replay of a conflict that lost what the receipt keeps of it: its conflicting fields.
      const [conflictKey, conflict] =
        [...built.ledger.expected.entries()].find(([, a]) => a.status === "conflict") ?? [];
      if (conflictKey === undefined || conflict === undefined) throw new Error("no conflict");
      expect(conflict.conflicts.length).toBeGreaterThan(0);
      expect(
        names(
          built.ledger.take({
            t: "ack",
            key: conflictKey,
            result: { ...conflict, replayed: true, conflicts: [] },
          }),
        ),
      ).toEqual(["retry-replays-identically"]);
    });

    test("a commit that does not hold what its request asked: a patch lost, an entry's content", async () => {
      // The double patch's commit holds the first value instead of the last, consistently in the
      // history and the row, so only a comparison with the request finds it.
      const built = await build();
      damage(
        built,
        `UPDATE changes SET after = '"First"' WHERE field = 'summary' AND after = '"Second"';
         UPDATE tasks SET summary = 'First' WHERE summary = 'Second'`,
      );
      expect(names(await check(built))).toEqual(["request-whole"]);
      // A note's body that differs from its create change: only the row, after the history.
      const body = await build();
      damage(body, "UPDATE notes SET body = 'Changed around the write path'");
      expect(names(await check(body))).toEqual(["history"]);
      // A change the request's operations do not account for: here the request is recorded as
      // two patches that set nothing, as if the writer had written a field no operation named.
      const extra = await build();
      const [doubleKey, double] =
        [...extra.ledger.requests.entries()].find(
          ([, r]) => r.ops.length === 2 && r.ops.every((op) => op.kind === "task.patch"),
        ) ?? [];
      if (doubleKey === undefined || double === undefined) throw new Error("no double patch");
      extra.ledger.requests.set(doubleKey, {
        ...double,
        ops: double.ops.map((op) => (op.kind === "task.patch" ? { ...op, set: {} } : op)),
      });
      const unaccounted = await check(extra);
      expect(names(unaccounted)).toEqual(["request-whole"]);
      expect(unaccounted.map((v) => v.detail).join()).toContain(
        "has a change its request does not account for (tasks)",
      );
      // A task created with another value than the writer's default (priority 4), consistently in
      // its create change and its row.
      const defaults = await build();
      damage(
        defaults,
        `UPDATE changes SET after = json_set(after, '$.priority', 1)
          WHERE action = 'create' AND entity = 'tasks';
         UPDATE tasks SET priority = 1`,
      );
      expect(names(await check(defaults))).toEqual(["request-whole"]);
      // A no-op decided for a request that would have changed the task: the request is recorded
      // with another value than the one the no-op found.
      const noop = await build();
      const [noopKey, noopRequest] =
        [...noop.ledger.requests.entries()].find(
          ([key]) => noop.ledger.expected.get(key)?.status === "unchanged",
        ) ?? [];
      if (noopKey === undefined || noopRequest === undefined) throw new Error("no no-op");
      noop.ledger.requests.set(noopKey, {
        ...noopRequest,
        ops: [{ kind: "task.patch", task: noop.task, set: { summary: "Never written" } }],
      });
      const noops = await check(noop);
      expect(names(noops)).toEqual(["request-whole"]);
      expect(noops.map((v) => v.detail).join()).toContain("a no-op at seq");
    });

    test("a decision a kill cut off after COMMIT must stay, one cut off before COMMIT must not", async () => {
      // After COMMIT: the seam's decision is held like an acknowledged one, and retried. Here it
      // is a conflict whose receipt the space does not have, as if it had been written outside
      // the request's transaction and lost with the kill.
      const built = await build();
      const conflict = [...built.ledger.expected.values()].find((a) => a.status === "conflict");
      if (conflict === undefined) throw new Error("no conflict");
      const lost = "cli:crash-2 checker-lost-0001";
      built.ledger.requests.set(lost, {
        key: lost,
        request_id: "checker-lost-0001",
        scope_id: "cli:crash-2",
        base: "none",
        ops: [],
      });
      expect(
        built.ledger.take({
          t: "at",
          where: "write",
          point: "after-commit",
          nth: 1,
          decided: { key: lost, result: conflict },
        }),
      ).toEqual([]);
      expect(built.ledger.inflight.has(lost)).toBe(true);
      expect(names(await check(built))).toEqual(["acked-present"]);
      // Before COMMIT: the decision rolled back, so its receipt must be gone.
      const early = await build();
      const [earlyKey, earlyAcked] = [...early.ledger.expected.entries()][0] ?? [];
      if (earlyKey === undefined || earlyAcked === undefined)
        throw new Error("the history is empty");
      early.ledger.take({
        t: "at",
        where: "write",
        point: "before-commit",
        nth: 1,
        decided: { key: earlyKey, result: earlyAcked },
      });
      expect(names(await check(early))).toContain("rolled-back");
      // A replay at before-commit decided nothing new: nothing to roll back.
      const replay = await build();
      const [replayKey, replayAcked] = [...replay.ledger.expected.entries()][0] ?? [];
      if (replayKey === undefined || replayAcked === undefined) throw new Error("empty");
      replay.ledger.take({
        t: "at",
        where: "write",
        point: "before-commit",
        nth: 1,
        decided: { key: replayKey, result: { ...replayAcked, replayed: true } },
      });
      expect(await check(replay)).toEqual([]);
    });

    test("a restore that swapped in a copy it had not claimed", async () => {
      // A fresh backup of the live incarnation, swapped in without its claim, then the kill: no
      // acknowledged result is lost and no counter goes back, but the old incarnation now has
      // the space's name and the folder it replaced (A1 3.18).
      const built = await build();
      const record = await backupSpace(built.checked, built.folder, {
        kind: "manual",
        backupDir: backupsBeside(built.folder),
      });
      built.ledger.take({ t: "backup-start", n: 1 });
      built.ledger.take({ t: "backup-done", n: 1, backup: facts(record) });
      built.ledger.take({ t: "restore-start", backup: record.name });
      const swap = swapNames(built.folder, Date.now());
      mkdirSync(swap.staging);
      const unpacked = await unpackBackup(
        built.checked,
        record.file,
        join(swap.staging, DATABASE_FILE),
        {},
      );
      writeManifest(swap.staging, manifestFor(unpacked.space, unpacked.step, SOURCE_APP_VERSION));
      swapIntoPlace(swap);
      expect(names(await check(built))).toContain("incarnation");
    });

    test("a backup or a replaced folder harmed after it was checked is checked again", async () => {
      const built = await build();
      const record = await backupSpace(built.checked, built.folder, {
        kind: "manual",
        backupDir: backupsBeside(built.folder),
      });
      built.ledger.take({ t: "backup-start", n: 1 });
      built.ledger.take({ t: "backup-done", n: 1, backup: facts(record) });
      built.ledger.take({ t: "restore-start", backup: record.name });
      const restored = await restoreInPlace(built.checked, record.file, built.folder, {
        machineId: FIXTURE_MACHINE.id,
        knownEpochs: [...built.ledger.epochs],
      });
      built.ledger.take({
        t: "restore-done",
        backup: record.name,
        epoch: restored.claim.epoch,
        incarnation: restored.claim.incarnation,
        seq: restored.claim.seq,
      });
      const verified = new Set<string>();
      const again = async (): Promise<string[]> =>
        names([
          ...checkFolders(built.ledger),
          ...(await checkSpace(built.checked, built.ledger, verified)).violations,
        ]);
      expect(await again()).toEqual([]);
      // The backup, verified once, overwritten with bytes of the same size, and its modification
      // time put back: only its content tells.
      const backupFile = join(backupsBeside(built.folder), basename(record.file));
      const { atime, mtime } = statSync(backupFile);
      writeFileSync(backupFile, Buffer.alloc(record.sidecar.compressed_size, 7));
      utimesSync(backupFile, atime, mtime);
      expect(await again()).toEqual(["backup-complete-or-absent"]);
      unlinkSync(backupFile);
      unlinkSync(join(backupsBeside(built.folder), basename(record.sidecarFile)));
      built.ledger.backups.clear();
      expect(await again()).toEqual([]);
      // The replaced folder, checked once: a note's body changed there, then its receipts lost.
      const harm = (sql: string): void => {
        const conn = openWriter(built.checked, join(restored.replaced, DATABASE_FILE));
        try {
          conn.exec(sql);
        } finally {
          conn.close();
        }
      };
      harm("UPDATE notes SET body = 'Changed around the write path'");
      expect(await again()).toEqual(["old-folder-kept"]);
      harm("DELETE FROM receipts");
      expect(await again()).toEqual(["old-folder-kept"]);
    });

    test("a restore that reported its end but claimed another backup than it was asked for", async () => {
      // Both backups hold every acknowledged result, so only the claim tells them apart.
      const built = await build();
      const asked = await backupSpace(built.checked, built.folder, {
        kind: "manual",
        backupDir: backupsBeside(built.folder),
      });
      built.ledger.take({ t: "backup-start", n: 1 });
      built.ledger.take({ t: "backup-done", n: 1, backup: facts(asked) });
      const writer = SpaceWriter.open(
        openSpaceAt(built.checked, built.folder, { role: "writer" }, CREATE_STEPS),
        { machine: FIXTURE_MACHINE },
      );
      const request_id = "checker-request-0100";
      const key = `cli:crash-1 ${request_id}`;
      const ops: WriteRequest["ops"] = [{ kind: "log.add", task: built.task, body: "Log 2" }];
      built.ledger.requests.set(key, {
        key,
        request_id,
        scope_id: "cli:crash-1",
        base: "none",
        ops,
      });
      const result = writer.submit({
        space_id: writer.spaceId,
        request_id,
        actor: {
          scope_id: "cli:crash-1",
          principal_id: built.ledger.owner as Id<"ac">,
          actor_kind: "human",
          machine_id: FIXTURE_MACHINE.id,
          origin: "cli",
        },
        ops,
      });
      writer.close();
      built.ledger.take({ t: "ack", key, result: reduce(result) });
      const other = await backupSpace(built.checked, built.folder, {
        kind: "manual",
        backupDir: backupsBeside(built.folder),
      });
      built.ledger.take({ t: "backup-start", n: 2 });
      built.ledger.take({ t: "backup-done", n: 2, backup: facts(other) });
      built.ledger.take({ t: "restore-start", backup: asked.name });
      const restored = await restoreInPlace(built.checked, other.file, built.folder, {
        machineId: FIXTURE_MACHINE.id,
        knownEpochs: [...built.ledger.epochs],
      });
      built.ledger.take({
        t: "restore-done",
        backup: asked.name,
        epoch: restored.claim.epoch,
        incarnation: restored.claim.incarnation,
        seq: restored.claim.seq,
      });
      expect(names(await check(built))).toEqual(["incarnation"]);
    });

    test("a system commit no system writes, an actor.register that does not hold its actor, an actor that joined without one, an agent's commit under another actor", async () => {
      const REGISTER = "json_extract(ops, '$[0].op') = 'actor.register'";
      // A system commit whose operation the system never writes: here the machine's registration
      // renamed, its machine row and change left as they were.
      const unknown = await build();
      damage(
        unknown,
        "UPDATE commits SET ops = json_set(ops, '$[0].op', 'space.rename') " +
          "WHERE json_extract(ops, '$[0].op') = 'machine.register'",
      );
      expect(names(await check(unknown))).toEqual(["system-commit"]);
      // The registration names another label than the actor row holds.
      const label = await build();
      damage(
        label,
        `UPDATE commits SET ops = json_set(ops, '$[0].input.label', 'other') WHERE ${REGISTER}`,
      );
      expect(names(await check(label))).toEqual(["system-commit"]);
      // A change row in the registration's commit: actors carry no versions.
      const changed = await build();
      damage(
        changed,
        "INSERT INTO changes SELECT (SELECT seq FROM commits WHERE " +
          REGISTER +
          "), n, op, entity, entity_id, task_id, action, field, before, after, before_ver, " +
          "before_prov, after_prov FROM changes WHERE entity = 'machines'",
      );
      expect(names(await check(changed))).toContain("system-commit");
      // An agent actor that joined around the writer: no actor.register accounts for it.
      const stray = await build();
      damage(
        stray,
        "INSERT INTO actors (id, kind, label, instance_id, routine_id, created_at) " +
          `VALUES ('${newId("ac")}', 'agent', 'stray', NULL, NULL, 1)`,
      );
      expect(names(await check(stray))).toEqual(["system-commit"]);
      // The agent's request recorded as the human's: everything it created still names the
      // agent, so only the commit's principal tells.
      const principal = await build();
      damage(
        principal,
        `UPDATE commits SET principal_id = '${principal.ledger.owner}', ` +
          `author_id = '${principal.ledger.owner}', actor_kind = 'human' ` +
          "WHERE actor_kind = 'agent'",
      );
      const byHuman = await check(principal);
      expect(names(byHuman)).toEqual(["request-whole"]);
      expect(byHuman.map((v) => v.detail).join()).toContain("is not by its request's agent actor");
    });

    test("a stored result that differs from the answer, checked every round, not only on a retry", async () => {
      const built = await build();
      damage(
        built,
        "UPDATE receipts SET result = json_set(result, '$.results[0].version', 999999)",
      );
      expect(names(await check(built))).toContain("acked-present");
    });
  },
);
