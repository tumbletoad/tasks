// Restores and backups through a running service take only the space they are about: a space's
// backup list and a restore by name keep to its own backups in a folder spaces share, a restore in
// place takes only a backup of the space the entry names, a failed one leaves a closed space
// closed, and the daily backup goes to the folder this machine set for the space also when its
// space.json is gone. Services run in this process on temporary homes; fixture spaces only.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RpcSession } from "@ttasks/bridge/protocol";
import {
  backupSpace,
  createSpace,
  listBackups,
  newId,
  restoreBackup,
  type Id,
} from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { writeCommits } from "../../storage/test/backup-helpers.ts";
import { restoreInPlace } from "../../storage/src/restore/restore.ts";
import { FIXTURE_MACHINE } from "../../storage/test/fixture-requests.ts";
import { Maintenance } from "../src/hub/maintenance.ts";
import { startService, type RunningService } from "../src/hub/service.ts";
import {
  backupsOf,
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
      mkdirSync(shared);
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
        folder: string;
      };
      const file = join(made.folder, `${made.name}.db.gz`);
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

describe("[A1.5.restore.failed-keeps-state] a restore in place that fails leaves the space as the person left it", () => {
  test(
    "a closed space stays closed after a restore in place from a backup that is not there",
    async () => {
      const machine = newId("m");
      const { home, spaces } = setUp("closed-restore", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      const { user } = await start(home, [work.folder]);
      await call(user, "space/close", { space: work.folder });
      expect((await rowOf(user, work.folder))?.state).toBe("closed");
      await refused(
        call(user, "space/restore", {
          backup: "manual-20261101T000000.000Z-e1-s0",
          space: work.folder,
        }),
      );
      expect((await rowOf(user, work.folder))?.state).toBe("closed");
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
      mkdirSync(elsewhere);
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
      expect(existsSync(join(work.folder, "backups"))).toBe(false);
    },
    SLOW,
  );
});

const HOUR = 3_600_000;

/** Minutes east of UTC that make `now` local noon, so no daily hour falls inside a test. */
const noonAt = (now: number): number => {
  const utcMinutes = Math.floor((now % 86_400_000) / 60_000);
  return ((((12 * 60 - utcMinutes) % 1440) + 1440 + 720) % 1440) - 720;
};

describe("[A1.5.backup.newest-work] the newest backup is the one that holds the furthest saved work", () => {
  test(
    "after the clock was set back, restore latest takes the backup with the later commits, and the upkeep keeps it",
    async () => {
      // The machine the fixture commits are written as.
      const machine = FIXTURE_MACHINE.id;
      const { home, spaces } = setUp("clock-back", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      const checked = await checkedDriver();
      const now = Date.now();
      const outside = backupsOf(home, work.space.spaceId);
      mkdirSync(outside, { recursive: true });
      // A daily backup, three commits, the clock set back an hour, another daily backup.
      const first = await backupSpace(checked, work.folder, {
        kind: "daily",
        backupDir: outside,
        now: () => now - 2 * HOUR,
      });
      await writeCommits(work.folder, 3);
      const later = await backupSpace(checked, work.folder, {
        kind: "daily",
        backupDir: outside,
        now: () => now - 3 * HOUR,
      });
      expect(later.sidecar.seq).toBeGreaterThan(first.sidecar.seq);

      const { user } = await start(home, [work.folder]);
      const restored = await call(user, "space/restore", {
        backup: "latest",
        of: work.folder,
        to: join(spaces, "copy"),
      });
      expect(restored["backup"]).toBe(later.name);

      const runner = new Maintenance();
      try {
        const report = await runner.run({
          folder: work.folder,
          spaceId: work.space.spaceId,
          incarnation: work.space.authority.incarnation,
          backupDir: outside,
          cleanup: true,
          atStart: true,
          now,
          utcOffsetMinutes: noonAt(now),
        });
        expect(report).toMatchObject({
          checked: true,
          unverified: 0,
          verifiedAt: later.sidecar.created_at,
        });
      } finally {
        await runner.stop();
      }
      expect(existsSync(later.file) && existsSync(later.sidecarFile)).toBe(true);
    },
    SLOW,
  );
});

describe("[A1.5.backup.histories] no history's backups are judged by another's", () => {
  test(
    "two copies claimed apart share a backups folder: restore latest of the served copy takes its own newest and names the other copy's, space backups tells them apart, and its upkeep makes its own daily",
    async () => {
      const machine = FIXTURE_MACHINE.id;
      const { root, home, spaces } = setUp("histories", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      const checked = await checkedDriver();
      const shared = join(root, "shared");
      mkdirSync(shared);
      const now = Date.now();
      const first = await backupSpace(checked, work.folder, {
        kind: "manual",
        backupDir: shared,
        now: () => now - 3 * 24 * HOUR,
      });
      // Each copy claimed from the same backup: the same epoch, each its own incarnation.
      const copy = async (slug: string) => {
        const at = join(spaces, slug);
        await restoreBackup(checked, first.file, at);
        const { claim } = await restoreInPlace(checked, first.file, at, { machineId: machine });
        return { folder: at, incarnation: claim.incarnation };
      };
      const laptop = await copy("laptop");
      const desktop = await copy("desktop");
      await writeCommits(laptop.folder, 2, "l");
      const ours = await backupSpace(checked, laptop.folder, {
        kind: "daily",
        backupDir: shared,
        now: () => now - 2 * 24 * HOUR,
      });
      // The other copy went further, and made its daily today.
      await writeCommits(desktop.folder, 6, "d");
      const theirs = await backupSpace(checked, desktop.folder, {
        kind: "daily",
        backupDir: shared,
        now: () => now - HOUR,
      });
      expect(theirs.sidecar.seq).toBeGreaterThan(ours.sidecar.seq);
      writeSettings(home, work.space.spaceId, { format: 1, backup: { dir: shared } });
      const { user } = await start(home, [laptop.folder]);

      const listed = await call(user, "space/backups", { space: laptop.folder });
      expect(listed["histories"]).toMatchObject([
        { incarnation: laptop.incarnation, this_copy: true, newest: ours.name },
        { incarnation: desktop.incarnation, this_copy: false, newest: theirs.name },
        { incarnation: first.sidecar.incarnation, this_copy: false, newest: first.name },
      ]);
      const restored = await call(user, "space/restore", {
        backup: "latest",
        of: laptop.folder,
        to: join(spaces, "copy"),
      });
      expect(restored).toMatchObject({ backup: ours.name, history: { this_copy: true } });
      expect((restored["other_histories"] as { newest: string }[]).map((h) => h.newest)).toEqual([
        theirs.name,
        first.name,
      ]);

      // The other copy's daily today does not stand for this copy's, and nothing of it goes.
      const runner = new Maintenance();
      try {
        const report = await runner.run({
          folder: laptop.folder,
          spaceId: work.space.spaceId,
          incarnation: laptop.incarnation,
          backupDir: shared,
          cleanup: false,
          atStart: false,
          now,
          utcOffsetMinutes: noonAt(now),
        });
        expect(report).toMatchObject({ backup: "taken", checked: true, unverified: 0 });
      } finally {
        await runner.stop();
      }
      for (const kept of [first, ours, theirs]) {
        expect(existsSync(kept.file) && existsSync(kept.sidecarFile), kept.name).toBe(true);
      }

      // This copy's own backups cut short (a sync that stopped halfway): latest restores nothing,
      // never the other copy's work in their place, and says how to choose a backup by name.
      const others = [first, theirs].map((b) => basename(b.file));
      for (const name of readdirSync(shared)) {
        if (name.endsWith(".db.gz") && !others.includes(name)) {
          writeFileSync(join(shared, name), "cut");
        }
      }
      const body = await refused(
        call(user, "space/restore", {
          backup: "latest",
          of: laptop.folder,
          to: join(spaces, "again"),
        }),
      );
      expect(body).toMatchObject({ data: { cause: "BACKUP_INVALID" } });
      expect(String(body["hint"])).toContain("space backups");
      expect(String(body["hint"])).toContain("space restore <name>");
      expect(existsSync(join(spaces, "again"))).toBe(false);
    },
    SLOW,
  );
});

describe("[A1.5.backup.folder-away] a backups folder set for the space that is not there is said as such", () => {
  test(
    "the list, restore latest, a backup now and the upkeep say so with its path, and nothing makes a folder in its place",
    async () => {
      const machine = newId("m");
      const { root, home, spaces } = setUp("folder-away", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      const drive = join(root, "drive");
      const set = join(drive, "backups");
      mkdirSync(set, { recursive: true });
      writeSettings(home, work.space.spaceId, { format: 1, backup: { dir: set } });
      const made = await backupSpace(await checkedDriver(), work.folder, {
        kind: "manual",
        backupDir: set,
      });
      // The drive is not connected when the service starts.
      renameSync(drive, join(root, "drive-away"));
      const { user } = await start(home, [work.folder], true);
      const row = await waitFor(
        async () => {
          const found = (await call(user, "space/list", {}))["spaces"] as {
            backup?: { why: string; message: string };
          }[];
          return found[0]?.backup === undefined ? undefined : found[0];
        },
        READY_MS,
        "the upkeep's report",
      );
      expect(row.backup?.why).toBe("away");
      expect(row.backup?.message).toContain("space backups <folder>");
      const asked: [string, Record<string, unknown>][] = [
        ["space/backups", { space: work.folder }],
        ["space/restore", { backup: "latest", of: work.folder, to: join(spaces, "copy") }],
        ["space/backup", { space: work.folder }],
      ];
      for (const [method, params] of asked) {
        const body = await refused(call(user, method, params));
        expect(body, method).toMatchObject({
          code: "not_found",
          data: { reason: "backups_folder_missing", folder: set },
        });
        expect(String(body["message"]), method).toContain(set);
      }
      expect(existsSync(drive)).toBe(false);
      expect(existsSync(join(spaces, "copy"))).toBe(false);

      // Connected again, the list and restore latest find the backup.
      renameSync(join(root, "drive-away"), drive);
      const listed = (await call(user, "space/backups", { space: work.folder }))["backups"] as {
        name: string;
      }[];
      expect(listed.map((b) => b.name)).toEqual([made.name]);
      const restored = await call(user, "space/restore", {
        backup: "latest",
        of: work.folder,
        to: join(spaces, "copy"),
      });
      expect(restored["backup"]).toBe(made.name);
    },
    SLOW,
  );

  test(
    "restore latest with no backup of the space says there is none, and names the backups folder",
    async () => {
      const machine = newId("m");
      const { home, spaces } = setUp("no-backup", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      const { user } = await start(home, [work.folder]);
      const body = await refused(
        call(user, "space/restore", {
          backup: "latest",
          of: work.folder,
          to: join(spaces, "copy"),
        }),
      );
      expect(body).toMatchObject({ code: "not_found", data: { reason: "no_backup" } });
      expect(String(body["message"])).toContain(backupsOf(home, work.space.spaceId));
    },
    SLOW,
  );
});

describe("[A1.5.backup.outside-home] a space's backups are beside the TTasks home, and only there", () => {
  test(
    "a backup there is listed and restores by name and as latest; files in the space's own backups folder are neither read nor removed",
    async () => {
      const machine = newId("m");
      const { home, spaces } = setUp("outside-only", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      const id = work.space.spaceId;
      // A backup an older build made into the space's own folder.
      const own = join(work.folder, "backups");
      mkdirSync(own);
      const old = await backupSpace(await checkedDriver(), work.folder, {
        kind: "daily",
        backupDir: own,
        now: () => Date.now() - 48 * HOUR,
      });
      const files = readdirSync(own).sort();
      const { user } = await start(home, [work.folder], true);
      await waitFor(
        () => (readLog(home).some((e) => e["ev"] === "space.maintained") ? true : undefined),
        READY_MS,
        "the upkeep",
      );
      const outside = backupsOf(home, id);
      const made = (await call(user, "space/backup", { space: work.folder }))["backup"] as {
        name: string;
        folder: string;
      };
      expect(made.folder).toBe(outside);
      const listed = await call(user, "space/backups", { space: work.folder });
      expect(listed["folder"]).toBe(outside);
      const names = (listed["backups"] as { name: string; folder: string }[]).map((b) => b.name);
      expect(names).toContain(made.name);
      expect(names).not.toContain(old.name);
      expect(await rowOf(user, work.folder)).toMatchObject({ backups_folder: outside });

      const named = await call(user, "space/restore", {
        backup: made.name,
        of: work.folder,
        to: join(spaces, "named"),
      });
      expect(named).toMatchObject({ read_only_copy: true });
      const latest = await call(user, "space/restore", {
        backup: "latest",
        of: work.folder,
        to: join(spaces, "latest"),
      });
      expect(names).toContain(latest["backup"]);
      await refused(
        call(user, "space/restore", { backup: old.name, of: work.folder, to: join(spaces, "old") }),
      );
      expect(readdirSync(own).sort()).toEqual(files);
      // A backup whose sidecar is gone does not restore by name, and its data file stays.
      rmSync(join(outside, `${made.name}.json`));
      await refused(
        call(user, "space/restore", {
          backup: made.name,
          of: work.folder,
          to: join(spaces, "lone"),
        }),
      );
      expect(existsSync(join(outside, `${made.name}.db.gz`))).toBe(true);
      expect(existsSync(join(spaces, "lone"))).toBe(false);
    },
    SLOW,
  );

  test(
    "a backups folder beside the home that cannot be made: no backup goes elsewhere, the space's own folder included",
    async () => {
      const machine = newId("m");
      const { home, spaces } = setUp("outside-blocked", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      // A file where the space's folder beside the home goes.
      const blocked = backupsOf(home, work.space.spaceId);
      mkdirSync(dirname(blocked));
      writeFileSync(blocked, "not a folder");

      const { user } = await start(home, [work.folder], true);
      const upkeep = await waitFor(
        () => readLog(home).find((e) => e["ev"] === "space.maintained"),
        READY_MS,
        "the upkeep",
      );
      expect(upkeep).toMatchObject({ backup: "away", removed: 0, leftovers: 0 });
      const now = await refused(call(user, "space/backup", { space: work.folder }));
      expect(now).toMatchObject({ data: { reason: "backups_folder_missing", folder: blocked } });
      expect(existsSync(join(work.folder, "backups"))).toBe(false);
    },
    SLOW,
  );
});

describe("[A1.5.rescue.registered] a rescue takes only the rows of the space it is for", () => {
  test(
    "a rescue of a space the service has open reads it beside its writer and confirms which space it is",
    async () => {
      const machine = FIXTURE_MACHINE.id;
      const { home, spaces } = setUp("rescue-open", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      await writeCommits(work.folder, 3);
      const { user } = await start(home, [work.folder]);
      const done = (await call(user, "space/rescue", { space: work.folder }))["rescue"] as {
        file: string;
        failed: string[];
        identity: string;
      };
      expect(done).toMatchObject({ failed: [], identity: "confirmed" });
      const rescued = join(work.folder, "exchange", "rescued");
      expect(readdirSync(rescued)).toEqual([basename(done.file)]);
    },
    SLOW,
  );

  test(
    "a rescue of a space whose folder now holds another space's files is refused, and writes no rows",
    async () => {
      const machine = newId("m");
      const { root, home, spaces } = setUp("rescue-other", machine);
      const work = await fixtureSpace(join(spaces, "work"), machine);
      const life = await fixtureSpace(join(spaces, "life"), machine, "Life");
      const { user } = await start(home, [work.folder, life.folder]);
      for (const s of [work, life]) await call(user, "space/close", { space: s.folder });
      // Life's folder is moved into the place of Work's.
      renameSync(work.folder, join(root, "work-aside"));
      renameSync(life.folder, work.folder);
      const body = await refused(call(user, "space/rescue", { space: work.space.spaceId }));
      expect(body["data"]).toMatchObject({ cause: "SPACE_ID_MISMATCH" });
      const rescued = join(work.folder, "exchange", "rescued");
      expect(existsSync(rescued) ? readdirSync(rescued) : []).toEqual([]);
    },
    SLOW,
  );
});
