// Restores and backups through a running service take only the space they are about: a space's
// backup list and a restore by name keep to its own backups in a folder spaces share, a restore in
// place takes only a backup of the space the entry names, a failed one leaves a closed space
// closed, and the daily backup goes to the folder this machine set for the space also when its
// space.json is gone. Services run in this process on temporary homes; fixture spaces only.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { backupsFolder, createSpace, listBackups, newId, type Id } from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { startService, type RunningService } from "../src/hub/service.ts";
import {
  readLog,
  READY_MS,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
} from "./harness.ts";
import { classSession, errorOf } from "./ops-helpers.ts";

const SLOW = 120_000;
const running: RunningService[] = [];
const sessions: RpcSession[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A temporary root, a home whose machine.json names `machine`, and a folder for spaces. */
function setUp(label: string, machine: Id<"m">): { root: string; home: string; spaces: string } {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  const home = join(root, "h");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: machine,
      name: "fixture-machine",
      created_at: "2026-11-23T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  const spaces = join(root, "spaces");
  mkdirSync(spaces);
  return { root, home, spaces };
}

async function fixtureSpace(folder: string, machine: Id<"m">, name = "Work") {
  return createSpace(await checkedDriver(), folder, {
    name,
    ownerLabel: "Mira Okafor",
    machineId: machine,
  });
}

/** This machine's settings for a space, as the step that owns them writes them. */
function writeSettings(home: string, spaceId: Id<"sp">, value: object): void {
  mkdirSync(join(stateOf(home), "spaces"), { recursive: true, mode: 0o700 });
  writeFileSync(join(stateOf(home), "spaces", `${spaceId}.json`), JSON.stringify(value), {
    mode: 0o600,
  });
}

async function start(
  home: string,
  spaces: Parameters<typeof registerSpaces>[1],
  maintenance = false,
): Promise<{ service: RunningService; user: RpcSession }> {
  registerSpaces(home, spaces);
  const service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    say: () => undefined,
    maintenance,
  });
  running.push(service);
  await service.spacesSettled;
  const user = await classSession(home, service.endpoint.path, "cli-interactive");
  sessions.push(user);
  return { service, user };
}

const call = (s: RpcSession, method: string, params: Record<string, unknown>) =>
  s.call(method, params, { timeoutMs: 120_000 }) as Promise<Record<string, unknown>>;

async function refused(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return errorOf(error) as unknown as Record<string, unknown>;
  }
  throw new Error("expected a refusal");
}

interface Row {
  folder: string;
  state: string;
  reason?: string;
}

const rowOf = async (user: RpcSession, folder: string): Promise<Row | undefined> =>
  ((await call(user, "space/list", {}))["spaces"] as Row[]).find((r) => r.folder === folder);

describe("[A1.5.restore.own-space] a restore takes only a backup of the space it is about", () => {
  test(
    "in a backups folder two spaces share, each lists only its own backups, and a restore by name refuses the other space's",
    async () => {
      const machine = newId("m");
      const { root, home, spaces } = setUp("shared-dir", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      const life = await fixtureSpace(join(spaces, "life"), machine, "Life");
      const shared = join(root, "shared-backups");
      for (const s of [work, life]) {
        writeSettings(home, s.space.spaceId, { format: 1, backup: { dir: shared } });
      }
      const { user } = await start(home, [work.folder, life.folder]);
      const made = (await call(user, "space/backup", { space: work.folder }))["backup"] as {
        name: string;
      };
      const listed = (await call(user, "space/backups", { space: life.folder }))["backups"] as {
        name: string;
      }[];
      expect(listed.map((b) => b.name)).not.toContain(made.name);
      const own = (await call(user, "space/backups", { space: work.folder }))["backups"] as {
        name: string;
      }[];
      expect(own.map((b) => b.name)).toContain(made.name);

      const copy = join(spaces, "life-copy");
      const body = await refused(
        call(user, "space/restore", { backup: made.name, to: copy, of: life.folder }),
      );
      expect(body["data"]).toMatchObject({ cause: "SPACE_ID_MISMATCH" });
      expect(existsSync(copy)).toBe(false);
    },
    SLOW,
  );

  test(
    "a restore in place over a space whose database and space.json are unreadable refuses another space's backup, and leaves the folder as it was",
    async () => {
      const machine = newId("m");
      const { home, spaces } = setUp("in-place-other", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      const life = await fixtureSpace(join(spaces, "life"), machine, "Life");
      // The work space's files are lost: its database is not one any more, its space.json gone.
      for (const name of ["space.db-wal", "space.db-shm", "space.json"]) {
        rmSync(join(work.folder, name), { force: true });
      }
      writeFileSync(join(work.folder, "space.db"), Buffer.alloc(8192, 7));
      const { user } = await start(home, [
        { path: work.folder, id: work.space.spaceId },
        life.folder,
      ]);
      const made = (await call(user, "space/backup", { space: life.folder }))["backup"] as {
        name: string;
      };
      const file = join(backupsFolder(life.folder), `${made.name}.db.gz`);
      expect((await rowOf(user, work.folder))?.state).toBe("unavailable");
      const before = readdirSync(spaces).sort();
      const body = await refused(call(user, "space/restore", { backup: file, space: work.folder }));
      expect(body["data"]).toMatchObject({ cause: "SPACE_ID_MISMATCH" });
      expect(readdirSync(spaces).sort()).toEqual(before);
      expect(existsSync(join(work.folder, "space.json"))).toBe(false);
    },
    SLOW,
  );
});

describe("[A1.5.backup.own-folder] the daily backup goes to the folder this machine set for the space", () => {
  test(
    "also when the space's space.json is gone and the open writes it again",
    async () => {
      const machine = newId("m");
      const { root, home, spaces } = setUp("manifest-gone", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      const elsewhere = join(root, "elsewhere");
      writeSettings(home, work.space.spaceId, { format: 1, backup: { dir: elsewhere } });
      rmSync(join(work.folder, "space.json"));
      await start(home, [{ path: work.folder, id: work.space.spaceId }], true);
      await waitFor(
        () => {
          const done = readLog(home).filter((e) => e["ev"] === "space.maintained");
          return done.length > 0 ? done : undefined;
        },
        READY_MS,
        "the upkeep",
      );
      expect(existsSync(join(work.folder, "space.json"))).toBe(true);
      const daily = listBackups(elsewhere).backups.filter((b) => b.sidecar?.kind === "daily");
      expect(daily.map((b) => b.sidecar?.space_id)).toEqual([work.space.spaceId]);
      expect(existsSync(backupsFolder(work.folder))).toBe(false);
    },
    SLOW,
  );
});
