// A migration that fails, and an open that runs past its bound, as the service serves them (M3.01,
// A1 3.17). Every migration attempt takes its own new barrier backup and verifies it, so the
// copies are bounded by acts: a failure is recorded in the space's machine-local settings, and the
// same build does not try the same state of the database again until something changed that could
// change the outcome (another build, another state, the person's retry). Services run in this
// process on temporary homes; fixture spaces only.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RpcSession } from "@tasks/bridge/protocol";
import { backupsFolder, listBackups, StorageWorker, type Id } from "@tasks/storage";
import { createSpaceAt, STEPS_0_1, STEPS_0_3, STEPS_0_4 } from "@tasks/storage/revisions";
import { checkedDriver, digestSpace } from "@tasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { writeCommits } from "../../storage/test/backup-helpers.ts";
import { FIXTURE_MACHINE } from "../../storage/test/fixture-requests.ts";
import { SLOW_BARRIER_MS, type StepSet } from "../../storage/test/stand-in-steps.ts";
import { workerWithSteps } from "../../storage/test/worker-helpers.ts";
import { BUILD } from "../src/hub/build.ts";
import { startService, type RunningService, type StartOptions } from "../src/hub/service.ts";
import { readSpaceSettings, SPACES_FOLDER } from "../src/hub/space-settings.ts";
import { RETRY_MIGRATION } from "../src/hub/spaces.ts";
import {
  readLog,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
} from "./harness.ts";
import { classSession, errorOf, type CliClass } from "./ops-helpers.ts";

const LONG = 240_000;

/**
 * The open's bound in the tests whose barrier backup is slow and whose space is then opened again
 * in a new worker: shorter than the slow barrier, so the first open always passes it, and long
 * enough for that ordinary second open on a loaded runner, which 1 s was not.
 */
const SLOW_OPEN_BOUND_MS = SLOW_BARRIER_MS - 500;
const running: RunningService[] = [];
const sessions: RpcSession[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The machine of every service here: the fixture writer's (writeCommits), so it may write. */
const MACHINE = FIXTURE_MACHINE.id;

/** What a failed migration's message ends with: how it is tried again (A1 3.17). */
const TRIED_AGAIN = `It is tried again after an update, or now with: ${RETRY_MIGRATION}`;

/** A temporary root, a home whose machine.json names MACHINE, and a folder for spaces. */
function setUp(label: string): { home: string; spaces: string } {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  const home = join(root, "h");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: MACHINE,
      name: "fixture-machine",
      created_at: "2026-11-14T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  const spaces = join(root, "spaces");
  mkdirSync(spaces);
  return { home, spaces };
}

/** A space as a released 0.1 build made it, with this machine as its authority. */
async function spaceAt01(folder: string) {
  return createSpaceAt(
    await checkedDriver(),
    folder,
    { name: "Work", ownerLabel: "Mira Okafor", machineId: MACHINE },
    STEPS_0_1,
  );
}

/** The storage workers of a build with the named steps, or of this build. */
const workers = (set: () => StepSet | undefined) => () => {
  const named = set();
  return named === undefined
    ? StorageWorker.start({ driver: "node:sqlite" })
    : workerWithSteps(named);
};

async function start(
  home: string,
  folder: string,
  spaceOptions: StartOptions["spaceOptions"] = {},
): Promise<RunningService> {
  registerSpaces(home, [folder]);
  const service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    say: () => undefined,
    maintenance: false,
    spaceOptions,
  });
  running.push(service);
  await service.spacesSettled;
  return service;
}

async function stop(service: RunningService): Promise<void> {
  running.splice(running.indexOf(service), 1);
  await service.stop();
  removeRuntimeDir(service);
}

async function session(home: string, service: RunningService, cls: CliClass): Promise<RpcSession> {
  const s = await classSession(
    home,
    service.endpoint.path,
    cls,
    cls === "cli-agent" ? { CLAUDECODE: "1" } : {},
  );
  sessions.push(s);
  return s;
}

const call = (s: RpcSession, method: string, params: Record<string, unknown>) =>
  s.call(method, params, { timeoutMs: 120_000 }) as Promise<Record<string, unknown>>;

async function refused(promise: Promise<unknown>): Promise<ReturnType<typeof errorOf>> {
  let result: unknown;
  try {
    result = await promise;
  } catch (error) {
    return errorOf(error);
  }
  throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
}

const settingsFile = (home: string, id: Id<"sp">): string =>
  join(stateOf(home), SPACES_FOLDER, `${id}.json`);

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Everything an open could write for the space, by name with its bytes' SHA-256: the space
 * folder's files (the database, space.json, writer.json, writer.lock), the backups folder's, and
 * the space's settings file.
 */
function written(home: string, folder: string, id: Id<"sp">): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [prefix, dir] of [
    ["", folder],
    ["backups/", backupsFolder(folder)],
  ] as const) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      files[`${prefix}${name}`] = statSync(path).isFile() ? sha(path) : "folder";
    }
  }
  const settings = settingsFile(home, id);
  files["settings"] = existsSync(settings) ? sha(settings) : "none";
  return files;
}

/** The state of the space's database, read with this build's reader: what a record names. */
async function dbState(
  folder: string,
): Promise<{ revision: unknown; epoch: number; incarnation: string; lastSeq: number }> {
  const worker = await StorageWorker.start({ driver: "node:sqlite" });
  try {
    const { conn, info } = await worker.openSpaceReader(folder);
    await conn.close();
    return {
      revision: info.revision,
      epoch: info.authority.epoch,
      incarnation: info.authority.incarnation,
      lastSeq: info.lastSeq,
    };
  } finally {
    await worker.close();
  }
}

/** The space's barrier backups that are complete, oldest first. */
const barrierBackups = (folder: string): string[] =>
  listBackups(backupsFolder(folder))
    .backups.filter((b) => b.state === "ok" && b.sidecar?.kind === "pre-migrate")
    .map((b) => b.name)
    .sort();

const events = (home: string, ev: string) => readLog(home).filter((e) => e["ev"] === ev);

/** The view of a space whose migration this open tried, and which failed (0.2's stand-in). */
const failedNow = (id: Id<"sp">, backup: string) => ({
  entry: 0,
  state: "read_only",
  reason: "migration_failed",
  code: "MIGRATION_FAILED",
  message:
    "Migration to 0.2 failed (STORAGE_SQL). Your data is unchanged. The space stays at 0.1. " +
    `Backup: ${backup}. ${TRIED_AGAIN}`,
  id,
});

/** The view of a space whose migration failed before with this build on this state. */
const notTried = (id: Id<"sp">, backup: string) => ({
  entry: 0,
  state: "read_only",
  reason: "migration_failed",
  code: "MIGRATION_FAILED",
  message:
    "Migration to 0.2 failed with this version (MIGRATION_FAILED) and was not tried again. " +
    `Your data is unchanged. The space stays at 0.1. Backup: ${backup}. ${TRIED_AGAIN}`,
  id,
});

/** The settings' record of a failure of `build` on the space's state. */
const failure = (
  state: { epoch: number; incarnation: string; lastSeq: number },
  backup: string,
  build: { version: string; build: string } = BUILD,
) => ({
  build: { version: build.version, build: build.build },
  from: 1,
  to: 2,
  epoch: state.epoch,
  incarnation: state.incarnation,
  lastSeq: state.lastSeq,
  code: "MIGRATION_FAILED",
  backup,
});

describe("[A2.3.1.hub.failed-migration] a failed migration is not tried again by itself (A1 3.17)", () => {
  test(
    "ten opens of a space whose migration fails leave one barrier backup and one record, and the nine later opens write nothing",
    async () => {
      const { home, spaces } = setUp("ten");
      const space = await spaceAt01(join(spaces, "work"));
      const id = space.space.spaceId;
      const failing = { startWorker: workers(() => "failing-0.2") };
      const fixture = digestSpace(await checkedDriver(), space.folder);

      // Open 1: the migration is tried behind its own barrier backup, fails, and is recorded.
      let service = await start(home, space.folder, failing);
      const [backup = "?"] = barrierBackups(space.folder);
      expect(barrierBackups(space.folder)).toEqual([backup]);
      expect(service.spaces()).toEqual([failedNow(id, backup)]);
      expect(readSpaceSettings(stateOf(home), id).failedMigrations).toEqual([
        failure(await dbState(space.folder), backup),
      ]);
      // The record names the build, the revisions, the state and the backup: no path, no text.
      const record = readFileSync(settingsFile(home, id), "utf8");
      for (const text of [space.folder, spaces, "Work", "Mira"]) expect(record).not.toContain(text);
      await stop(service);
      const after = written(home, space.folder, id);

      // Opens 2 to 10, each a start of the service: served read-only with what happened, nothing
      // opened for writing, backed up or written; the record survives each restart.
      for (let open = 2; open <= 10; open += 1) {
        service = await start(home, space.folder, failing);
        expect(service.spaces(), `open ${String(open)}`).toEqual([notTried(id, backup)]);
        await stop(service);
        expect(written(home, space.folder, id), `open ${String(open)}`).toEqual(after);
      }
      expect(barrierBackups(space.folder)).toEqual([backup]);
      expect(digestSpace(await checkedDriver(), space.folder)).toBe(fixture);
      // One attempt, nine opens it held back, and the message never in the log.
      expect(events(home, "space.read_only").map((e) => [e["code"], e["tried"]])).toEqual([
        ["MIGRATION_FAILED", true],
        ...Array.from({ length: 9 }, () => ["MIGRATION_FAILED", false]),
      ]);
      expect(events(home, "space.open")).toEqual([]);
      expect(JSON.stringify(readLog(home))).not.toContain("Your data is unchanged");
    },
    LONG,
  );

  test(
    "another build tries again behind a new barrier backup, and its record replaces the first build's",
    async () => {
      const { home, spaces } = setUp("build");
      const space = await spaceAt01(join(spaces, "work"));
      const id = space.space.spaceId;
      const state = await dbState(space.folder);
      const startWorker = workers(() => "failing-0.2");

      let service = await start(home, space.folder, { startWorker });
      const [first = "?"] = barrierBackups(space.folder);
      await stop(service);

      // An update: another build tries the same state again, behind its own barrier backup.
      const update = { version: "0.0.0", build: "fixture-update" };
      service = await start(home, space.folder, { startWorker, build: update });
      const made = barrierBackups(space.folder);
      expect(made).toHaveLength(2);
      const second = made.find((name) => name !== first) ?? "?";
      expect(service.spaces()).toEqual([failedNow(id, second)]);
      expect(readSpaceSettings(stateOf(home), id).failedMigrations).toEqual([
        failure(state, second, update),
      ]);
      await stop(service);

      // That build does not try it again either.
      const after = written(home, space.folder, id);
      service = await start(home, space.folder, { startWorker, build: update });
      expect(service.spaces()).toEqual([notTried(id, second)]);
      await stop(service);
      expect(written(home, space.folder, id)).toEqual(after);
    },
    LONG,
  );

  test(
    "another state of the database tries again: a restore in place, then another writer's commit",
    async () => {
      const { home, spaces } = setUp("state");
      const space = await spaceAt01(join(spaces, "work"));
      const id = space.space.spaceId;
      const startWorker = workers(() => "failing-0.2");

      let service = await start(home, space.folder, { startWorker });
      const [first = "?"] = barrierBackups(space.folder);

      // A restore in place of the barrier backup: a new epoch and incarnation, the record forgotten,
      // and the open after it tries, behind its own barrier backup.
      const change = await service.spaceManager.restoreInPlace(
        0,
        join(backupsFolder(space.folder), `${first}.db.gz`),
      );
      const afterRestore = barrierBackups(space.folder);
      expect(afterRestore).toHaveLength(2);
      const second = afterRestore.find((name) => name !== first) ?? "?";
      expect(service.spaces()).toEqual([failedNow(id, second)]);
      const restored = await dbState(space.folder);
      expect(restored).toMatchObject({ epoch: change.epoch, incarnation: change.incarnation });
      expect(readSpaceSettings(stateOf(home), id).failedMigrations).toEqual([
        failure(restored, second),
      ]);
      await stop(service);

      // Another writer (the 0.1 build's) commits while the service is stopped: a new last_seq.
      const lastSeq = await writeCommits(space.folder, 1, "x", STEPS_0_1);
      expect(lastSeq).toBeGreaterThan(restored.lastSeq);
      service = await start(home, space.folder, { startWorker });
      const afterWrite = barrierBackups(space.folder);
      expect(afterWrite).toHaveLength(3);
      const third = afterWrite.find((name) => name !== first && name !== second) ?? "?";
      expect(service.spaces()).toEqual([failedNow(id, third)]);
      // Each state that failed is remembered: two folders can hold one space.
      expect(readSpaceSettings(stateOf(home), id).failedMigrations).toEqual([
        failure(restored, second),
        failure({ ...restored, lastSeq }, third),
      ]);
    },
    LONG,
  );

  test(
    "the person's retry tries again behind a new barrier backup, any other caller is refused, and a successful retry migrates and forgets the record",
    async () => {
      const { home, spaces } = setUp("retry");
      const space = await spaceAt01(join(spaces, "work"));
      const id = space.space.spaceId;
      const state = await dbState(space.folder);
      let set: StepSet | undefined = "failing-0.2";
      const service = await start(home, space.folder, { startWorker: workers(() => set) });
      const [first = "?"] = barrierBackups(space.folder);
      expect(service.spaces()).toEqual([failedNow(id, first)]);
      const user = await session(home, service, "cli-interactive");

      // Only the user asks for a retry: a script and an agent are refused, and nothing is written.
      const before = written(home, space.folder, id);
      for (const cls of ["cli-script", "cli-agent"] as const) {
        const other = await session(home, service, cls);
        const error = await refused(
          call(other, "space/open", { path: space.folder, retry_migration: true }),
        );
        expect(error.code, cls).toBe("forbidden");
      }
      expect(written(home, space.folder, id)).toEqual(before);
      expect(service.spaces()).toEqual([failedNow(id, first)]);

      // Opened again without the retry: not tried.
      await call(user, "space/close", { space: space.folder });
      const reopened = await call(user, "space/open", { path: space.folder });
      expect(reopened["space"]).toMatchObject({ state: "read_only", code: "MIGRATION_FAILED" });
      expect(service.spaces()).toEqual([notTried(id, first)]);
      expect(barrierBackups(space.folder)).toEqual([first]);

      // The retry: tried, behind a new barrier backup, and it fails again on the same state.
      await call(user, "space/open", { path: space.folder, retry_migration: true });
      const made = barrierBackups(space.folder);
      expect(made).toHaveLength(2);
      const second = made.find((name) => name !== first) ?? "?";
      expect(service.spaces()).toEqual([failedNow(id, second)]);
      expect(readSpaceSettings(stateOf(home), id).failedMigrations).toEqual([
        failure(state, second),
      ]);

      // A fixed build of the same identity is not tried by itself; the retry migrates the space.
      set = undefined;
      await call(user, "space/close", { space: space.folder });
      await call(user, "space/open", { path: space.folder });
      expect(service.spaces()).toEqual([notTried(id, second)]);
      expect(barrierBackups(space.folder)).toHaveLength(2);
      const migrated = await call(user, "space/open", {
        path: space.folder,
        retry_migration: true,
      });
      expect(migrated["space"]).toMatchObject({ state: "open", id });
      expect(service.spaces()).toEqual([{ entry: 0, state: "open", id }]);
      expect(barrierBackups(space.folder)).toHaveLength(3);
      expect(readSpaceSettings(stateOf(home), id).failedMigrations).toBeUndefined();
      expect(readFileSync(settingsFile(home, id), "utf8")).not.toContain("failed_migrations");
      const added = await call(user, "op/call", {
        op: "task.add",
        input: { tasks: [{ title: "Fixture task" }], request_id: "fixture-retry-request-000001" },
        space: id,
      });
      expect(added).toHaveProperty("tasks");
      expect(events(home, "space.migrated")).toHaveLength(1);
    },
    LONG,
  );

  test(
    "a damaged or unreadable record is no record: the open tries, behind a new barrier backup",
    async () => {
      const { home, spaces } = setUp("damaged");
      const space = await spaceAt01(join(spaces, "work"));
      const id = space.space.spaceId;
      const startWorker = workers(() => "failing-0.2");
      const file = settingsFile(home, id);
      let service = await start(home, space.folder, { startWorker });
      await stop(service);
      const good = JSON.parse(readFileSync(file, "utf8")) as { failed_migrations: object[] };
      const entry = good.failed_migrations[0] ?? {};

      const damages: [string, () => void][] = [
        [
          "not JSON",
          () => {
            writeFileSync(file, "{ not json");
          },
        ],
        [
          "an entry with a field that does not read back",
          () => {
            writeFileSync(
              file,
              JSON.stringify({ ...good, failed_migrations: [{ ...entry, last_seq: "1" }] }),
            );
          },
        ],
        [
          "an entry without its build",
          () => {
            writeFileSync(
              file,
              JSON.stringify({ ...good, failed_migrations: [{ ...entry, build: undefined }] }),
            );
          },
        ],
        [
          "an unreadable file (a folder in its place), which the failure cannot be written to",
          () => {
            rmSync(file);
            mkdirSync(file);
          },
        ],
      ];
      let count = 1;
      for (const [what, damage] of damages) {
        damage();
        service = await start(home, space.folder, { startWorker });
        count += 1;
        expect(barrierBackups(space.folder), what).toHaveLength(count);
        expect(service.spaces()[0], what).toMatchObject({
          state: "read_only",
          reason: "migration_failed",
          code: "MIGRATION_FAILED",
        });
        await stop(service);
      }
      // A failure that could not be recorded is tried again at the next open, and its message does
      // not promise otherwise.
      service = await start(home, space.folder, { startWorker });
      expect(barrierBackups(space.folder)).toHaveLength(count + 1);
      expect(service.spaces()[0]?.message).not.toContain(RETRY_MIGRATION);
    },
    LONG,
  );
});

/** A storage worker, started before the service, whose close the test can wait for. */
async function watched(
  set: StepSet,
): Promise<{ worker: StorageWorker; closed: () => Promise<void> | undefined }> {
  const worker = await workerWithSteps(set);
  let closing: Promise<void> | undefined;
  const close = worker.close.bind(worker);
  worker.close = () => (closing ??= close());
  cleanups.push(() => worker.close().catch(() => undefined));
  return { worker, closed: () => closing };
}

/**
 * The workers in order, then plain ones started when asked for. A plain worker is never started
 * ahead of the service: on Windows, a storage worker that a test started before `startService`
 * beside the slow one made the test process crash (STATUS_HEAP_CORRUPTION or a fast fail) in about
 * one run in five, whether or not the hub used it, while the same flows with every other worker
 * started by the hub did not. The cause is not known yet.
 */
const inOrder = (ready: StorageWorker[]) => () =>
  Promise.resolve(ready.shift() ?? StorageWorker.start({ driver: "node:sqlite" }));

describe("[A2.3.1.hub.migration-timeout] an open whose migration runs past the open's bound", () => {
  test(
    "a migration that fails after the bound passed leaves the space unchanged and read-only, with no failure record: the next open tries again",
    async () => {
      const { home, spaces } = setUp("slowfail");
      const space = await spaceAt01(join(spaces, "work"));
      const id = space.space.spaceId;
      const fixture = digestSpace(await checkedDriver(), space.folder);
      // Started before the service, so the open's bound covers only the open itself: a build whose
      // barrier backup takes longer than that bound (as a large space's does). The reader after the
      // timeout gets a plain worker, started then.
      const slow = await watched("slow-failing");
      const service = await start(home, space.folder, {
        startWorker: inOrder([slow.worker]),
        openTimeoutMs: SLOW_OPEN_BOUND_MS,
        closeTimeoutMs: 30_000,
      });
      // The worker was stopped before the space was read again, and the space, still at 0.1, is
      // served read-only.
      expect(slow.closed()).toBeDefined();
      expect(service.spaces()).toEqual([
        {
          entry: 0,
          state: "read_only",
          reason: "migration_failed",
          code: "ETIMEDOUT",
          message:
            // The service names its own build's latest revision: the stopped worker's cannot tell.
            "Migration to 0.4 did not finish in time (ETIMEDOUT). Your data is unchanged. " +
            "The space stays at 0.1. It is tried again when the space next opens.",
          id,
        },
      ]);
      expect(events(home, "space.read_only")).toEqual([
        expect.objectContaining({ entry: 0, reason: "migration_failed", code: "ETIMEDOUT" }),
      ]);
      expect(JSON.stringify(readLog(home))).not.toContain("Your data is unchanged");
      // A timeout is no failed migration: nothing is recorded.
      expect(readSpaceSettings(stateOf(home), id).failedMigrations).toBeUndefined();
      await stop(service);
      expect(digestSpace(await checkedDriver(), space.folder)).toBe(fixture);

      // The next open tries again, with this build's real steps, and migrates.
      const next = await start(home, space.folder);
      expect(next.spaces()).toEqual([{ entry: 0, state: "open", id }]);
      expect(await dbState(space.folder)).toMatchObject({ revision: { major: 0, minor: 4 } });
    },
    LONG,
  );

  test(
    "a migration that succeeds within the close's bound after the open's bound passed leaves the space at this build's 0.3, served for writing, never reported unchanged",
    async () => {
      const { home, spaces } = setUp("slowok");
      const space = await spaceAt01(join(spaces, "work"));
      const id = space.space.spaceId;
      const before = await dbState(space.folder);
      const slow = await watched("slow-real");
      const service = await start(home, space.folder, {
        startWorker: inOrder([slow.worker]),
        openTimeoutMs: SLOW_OPEN_BOUND_MS,
        closeTimeoutMs: 30_000,
      });
      expect(slow.closed()).toBeDefined();
      // The stopped open's migration committed before its worker ended: the space is at 0.3, and
      // the writer opened again in the new worker. Never read-only, never "unchanged".
      expect(service.spaces()).toEqual([{ entry: 0, state: "open", id }]);
      expect(events(home, "space.read_only")).toEqual([]);
      expect(events(home, "space.open")).toEqual([
        expect.objectContaining({ entry: 0, space: id, migrated: false }),
      ]);
      expect(barrierBackups(space.folder)).toHaveLength(1);
      const user = await session(home, service, "cli-interactive");
      const added = await call(user, "op/call", {
        op: "task.add",
        input: { tasks: [{ title: "Fixture task" }], request_id: "fixture-slow-request-0000001" },
        space: id,
      });
      expect(added).toHaveProperty("tasks");
      await stop(service);
      const after = await dbState(space.folder);
      expect(after.revision).toEqual({ major: 0, minor: 4 });
      // The fixture's commits, then the migration's three, this machine's registration and the
      // task's.
      expect(after.lastSeq).toBe(before.lastSeq + 5);
    },
    LONG,
  );

  test.each([
    ["succeeds", "slow-real", { major: 0, minor: 4 }],
    ["fails", "slow-failing", { major: 0, minor: 1 }],
  ] as const)(
    "a migration still running when the close's bound passes, which then %s: no reader is served, the space is unavailable, and the next start finds the state it left intact",
    async (_, set, revision) => {
      const { home, spaces } = setUp("stuck");
      const space = await spaceAt01(join(spaces, "work"));
      const id = space.space.spaceId;
      const fixture = digestSpace(await checkedDriver(), space.folder);
      const slow = await watched(set);
      const service = await start(home, space.folder, {
        startWorker: inOrder([slow.worker]),
        openTimeoutMs: 1_000,
        closeTimeoutMs: 500,
      });
      // The worker did not stop within the close's bound: no reader, and the space unavailable.
      expect(service.spaces()).toEqual([
        { entry: 0, state: "unavailable", reason: "open_failed", code: "ETIMEDOUT" },
      ]);
      expect(events(home, "space.read_only")).toEqual([]);
      // The stopped worker's migration ends meanwhile, and so does its worker.
      await slow.closed();
      await stop(service);
      expect(readSpaceSettings(stateOf(home), id).failedMigrations).toBeUndefined();
      const left = await dbState(space.folder);
      expect(left.revision).toEqual(revision);
      if (set === "slow-failing") {
        expect(digestSpace(await checkedDriver(), space.folder)).toBe(fixture);
      }

      // The next start finds that state: a migrated space opens; an unchanged one is tried again,
      // with this build's real steps (a timeout recorded no failure).
      const next = await start(home, space.folder);
      expect(next.spaces()).toEqual([{ entry: 0, state: "open", id }]);
      expect(await dbState(space.folder)).toMatchObject({ revision: { major: 0, minor: 4 } });
      expect(barrierBackups(space.folder)).toHaveLength(set === "slow-real" ? 1 : 2);
    },
    LONG,
  );
});

/** The titles a search through the request path finds, best first. */
async function titlesFound(
  s: RpcSession,
  space: Id<"sp">,
  q: string,
  scope: "active" | "all" = "active",
): Promise<string[]> {
  const result = await call(s, "op/call", {
    op: "task.search",
    input: { q, scope, limit: 50 },
    space,
  });
  return (result["rows"] as { title: string }[]).map((row) => row.title);
}

/** A space as a 0.3 build made it, with two tasks titled `Task early1` and `Task early2`. */
async function spaceAt03(folder: string) {
  const created = createSpaceAt(
    await checkedDriver(),
    folder,
    { name: "Work", ownerLabel: "Mira Okafor", machineId: MACHINE },
    STEPS_0_3,
  );
  await writeCommits(created.folder, 3, "early", STEPS_0_3);
  return created;
}

describe("[A2.3.1.hub.search-after-migration] word search on a migrated space, a new one, and one whose update failed", () => {
  test(
    "a 0.3 space migrates on open and answers words, and the index follows adds, edits, notes and completion through the request path",
    async () => {
      const { home, spaces } = setUp("search-migrated");
      const space = await spaceAt03(join(spaces, "work"));
      const id = space.space.spaceId;
      const service = await start(home, space.folder);
      expect(service.spaces()).toEqual([{ entry: 0, state: "open", id }]);
      expect(await dbState(space.folder)).toMatchObject({ revision: { major: 0, minor: 4 } });
      const user = await session(home, service, "cli-interactive");

      // What the space held before its migration is found by its words.
      expect(await titlesFound(user, id, "early2")).toEqual(["Task early2"]);

      let requests = 0;
      const write = async (op: string, input: Record<string, unknown>) =>
        call(user, "op/call", {
          op,
          input: { ...input, request_id: `fixture-search-request-${String((requests += 1))}` },
          space: id,
        });
      const asOf = async () =>
        (await call(user, "op/call", { op: "space.status", input: {}, space: id }))["as_of"];

      const added = await write("task.add", { tasks: [{ title: "Quokka fence repair" }] });
      const ref = (added["tasks"] as { ref: string }[])[0]?.ref ?? "";
      expect(await titlesFound(user, id, "quokka")).toEqual(["Quokka fence repair"]);
      expect(await titlesFound(user, id, "fence")).toEqual(["Quokka fence repair"]);

      // A new title replaces the old words.
      await write("task.update", {
        task: ref,
        set: { title: "Wombat fence repair" },
        base: await asOf(),
      });
      expect(await titlesFound(user, id, "quokka")).toEqual([]);
      expect(await titlesFound(user, id, "wombat")).toEqual(["Wombat fence repair"]);

      // A note's words find its task.
      await write("entry.add", { task: ref, kind: "note", text: "Ask about the zebrafish pond." });
      expect(await titlesFound(user, id, "zebrafish")).toEqual(["Wombat fence repair"]);

      // A finished task leaves the active scope and stays in all.
      await write("task.finish", { task: ref, status: "done", base: await asOf() });
      expect(await titlesFound(user, id, "wombat")).toEqual([]);
      expect(await titlesFound(user, id, "wombat", "all")).toEqual(["Wombat fence repair"]);
    },
    LONG,
  );

  test(
    "a space this build creates answers words from its first task",
    async () => {
      const { home, spaces } = setUp("search-new");
      const created = createSpaceAt(
        await checkedDriver(),
        join(spaces, "work"),
        { name: "Work", ownerLabel: "Mira Okafor", machineId: MACHINE },
        STEPS_0_4,
      );
      const id = created.space.spaceId;
      const service = await start(home, created.folder);
      const user = await session(home, service, "cli-interactive");
      await call(user, "op/call", {
        op: "task.add",
        input: {
          tasks: [{ title: "Order the platypus feed" }],
          request_id: "fixture-search-new-request-1",
        },
        space: id,
      });
      expect(await titlesFound(user, id, "platypus")).toEqual(["Order the platypus feed"]);
    },
    LONG,
  );

  test(
    "a space whose update failed answers filters, and refuses words with a line that says why",
    async () => {
      const { home, spaces } = setUp("search-failed");
      const space = await spaceAt03(join(spaces, "work"));
      const id = space.space.spaceId;
      const service = await start(home, space.folder, {
        startWorker: workers(() => "failing-0.4"),
      });
      expect(service.spaces()[0]).toMatchObject({
        state: "read_only",
        reason: "migration_failed",
        code: "MIGRATION_FAILED",
      });
      const user = await session(home, service, "cli-interactive");
      expect((await titlesFound(user, id, "status:open")).sort()).toEqual([
        "Task early1",
        "Task early2",
      ]);
      const error = await refused(
        call(user, "op/call", { op: "task.search", input: { q: "early1" }, space: id }),
      );
      expect(error).toMatchObject({
        code: "space_unavailable",
        message:
          "This space could not be updated from schema 0.3, so it has no word index yet and " +
          "words cannot be searched.",
        hint:
          "Filters such as status:open work now. tasks space list shows why the update failed " +
          "and how to try it again.",
        data: { reason: "not_indexed", retryable: false },
      });
    },
    LONG,
  );
});
