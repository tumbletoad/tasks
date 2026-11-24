// Spaces in synced folders and on network file systems (A1 3.2), as the service serves them: the
// read-only modes the service decides, with A1's words; and the person's confirmation, per
// machine and per path. Services run in this process on temporary homes, with a fixture host for
// the folder check: nothing outside the test's tree is looked at.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { createSpace, newId, type Id } from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { startService, type RunningService } from "../src/hub/service.ts";
import { readSpaceSettings } from "../src/hub/space-settings.ts";
import { canonicalFolder } from "../src/hub/spaces.ts";
import {
  readLog,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
} from "./harness.ts";
import { classSession, errorOf } from "./ops-helpers.ts";
import type { SyncHost } from "../src/hub/sync-folders.ts";
import { fixtureHost, type SyncFacts } from "./sync-fixtures.ts";

const LONG = 240_000;
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

const SYNCTHING =
  "This space is inside a Syncthing folder. A live database there can be corrupted. Move it, or confirm that this folder is excluded from sync.";
const NETWORK =
  "This space is on a network file system. A live database there can be corrupted. It is never written there. Move it to a local folder.";

/** NFS's statfs type (fixtures/sync/statfs-samples.json). */
const NFS = 0x6969;
const EXT4 = 0xef53;

interface World {
  readonly root: string;
  readonly home: string;
  readonly machine: Id<"m">;
}

/** A temporary root and a home whose machine.json names a fixed machine. */
function setUp(label: string): World {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  const home = join(root, "h");
  const machine = newId("m");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: machine,
      name: "fixture-machine",
      created_at: "2026-11-14T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  return { root, home, machine };
}

/** Facts for the check: `<root>/net` is on NFS (a Linux statfs sample), everything else on ext4. */
const netFacts = (root: string): SyncFacts => ({
  platform: "linux",
  statfs: (path) => (path.startsWith(join(root, "net")) ? NFS : EXT4),
});

async function start(
  world: World,
  facts: SyncFacts = {},
  host: SyncHost = fixtureHost(world.root, facts),
): Promise<RunningService> {
  const service = await startService({
    env: serviceEnv(world.home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
    spaceOptions: { syncHost: host },
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

async function user(world: World, service: RunningService): Promise<RpcSession> {
  const s = await classSession(world.home, service.endpoint.path, "cli-interactive");
  sessions.push(s);
  return s;
}

const call = (s: RpcSession, method: string, params: Record<string, unknown>) =>
  s.call(method, params, { timeoutMs: 120_000 }) as Promise<Record<string, unknown>>;

let n = 0;
const addTask = (s: RpcSession, space: string) =>
  call(s, "op/call", {
    op: "task.add",
    input: {
      tasks: [{ title: "Fixture task" }],
      request_id: `fixture-sync-request-${String((n += 1)).padStart(6, "0")}`,
    },
    space,
  });

async function rejected(
  promise: Promise<unknown>,
  what = "the call",
): Promise<ReturnType<typeof errorOf>> {
  let result: unknown;
  try {
    result = await promise;
  } catch (error) {
    return errorOf(error);
  }
  throw new Error(`expected ${what} to be refused, got ${JSON.stringify(result)}`);
}

/** A space made by storage, as a person's existing folder, with this machine as its authority. */
async function existingSpace(world: World, folder: string) {
  mkdirSync(dirname(folder), { recursive: true });
  return createSpace(await checkedDriver(), folder, {
    name: "Mira",
    ownerLabel: "Mira Okafor",
    machineId: world.machine,
  });
}

describe("[A1.5.sync.read-only] the service serves a synced or network space read-only, in A1's words", () => {
  test(
    "a synced folder is read-only until the person confirms it is excluded; per machine and per path",
    async () => {
      const world = setUp("syro");
      mkdirSync(join(world.root, "Sync", ".stfolder"), { recursive: true });
      const folder = join(world.root, "Sync", "spaces", "mira");
      let service = await start(world);
      let s = await user(world, service);

      // Checked at create too: the new space opens read-only, and says why.
      const created = await call(s, "space/create", { name: "Mira", path: folder });
      expect(created["space"]).toMatchObject({
        state: "read_only",
        reason: "synced_folder",
        message: SYNCTHING,
        folder_check: { verdict: "synced", provider: "syncthing" },
      });
      const id = (created["space"] as { id: Id<"sp"> }).id;
      // A write is refused with the same words.
      const refused = await rejected(addTask(s, id));
      expect(refused).toMatchObject({
        code: "read_only",
        message: SYNCTHING,
        data: { reason: "synced_folder" },
      });
      // Status names it the same way.
      expect(service.status().spaces[0]).toMatchObject({
        reason: "synced_folder",
        message: SYNCTHING,
      });

      // "It is excluded, open anyway": writable, the confirmation kept for this folder.
      const confirmed = await call(s, "space/open", { path: folder, excluded: true });
      expect(confirmed["space"]).toMatchObject({ state: "open" });
      expect((confirmed["space"] as { message?: string }).message).toBeUndefined();
      expect(readSpaceSettings(stateOf(world.home), id).syncedFolderConfirmed).toBe(
        canonicalFolder(folder),
      );
      expect(await addTask(s, id)).toMatchObject({ tasks: [{ result: "created" }] });

      // Kept across a restart.
      await stop(service);
      registerSpaces(world.home, [folder]);
      service = await start(world);
      expect(service.spaces()[0]).toMatchObject({ state: "open" });

      // Another folder asks again: the confirmation is per path.
      await stop(service);
      const elsewhere = join(world.root, "Sync", "spaces", "mira-two");
      renameSync(folder, elsewhere);
      registerSpaces(world.home, [elsewhere]);
      service = await start(world);
      expect(service.spaces()[0]).toMatchObject({ state: "read_only", reason: "synced_folder" });
      s = await user(world, service);
      const again = await call(s, "space/open", { path: elsewhere, excluded: true });
      expect(again["space"]).toMatchObject({ state: "open" });
      expect(readSpaceSettings(stateOf(world.home), id).syncedFolderConfirmed).toBe(
        canonicalFolder(elsewhere),
      );
      // The log names the reason only.
      const line = readLog(world.home).find(
        (e) => e["ev"] === "space.read_only" && e["reason"] === "synced_folder",
      );
      expect(line).toBeDefined();
      expect(JSON.stringify(readLog(world.home))).not.toContain("Syncthing");
      expect(JSON.stringify(readLog(world.home))).not.toContain(world.root.slice(3));
    },
    LONG,
  );

  test(
    "a network file system is never written: no create there, read-only when found, no confirmation",
    async () => {
      const world = setUp("synw");
      const service = await start(world, netFacts(world.root));
      const s = await user(world, service);
      const there = join(world.root, "net", "mira");
      mkdirSync(dirname(there), { recursive: true });
      expect(await rejected(call(s, "space/create", { name: "Mira", path: there }))).toMatchObject({
        code: "invalid_input",
        data: { folder_check: { verdict: "network", fs: "nfs" } },
      });
      expect(existsSync(there)).toBe(false);

      // A space someone put there by hand opens read-only.
      await existingSpace(world, there);
      const opened = await call(s, "space/open", { path: there });
      expect(opened["space"]).toMatchObject({
        state: "read_only",
        reason: "network_filesystem",
        message: NETWORK,
        folder_check: { verdict: "network", fs: "nfs" },
      });
      const id = (opened["space"] as { id: string }).id;
      expect(await rejected(addTask(s, id))).toMatchObject({ code: "read_only", message: NETWORK });
      expect(await rejected(call(s, "space/open", { path: there, excluded: true }))).toMatchObject({
        code: "invalid_input",
      });
      // It still reads.
      expect(await call(s, "op/call", { op: "space.status", input: {}, space: id })).toBeDefined();
    },
    LONG,
  );

  test(
    "a restore in place writes no database into a synced or network folder; a new folder or the person's word does",
    async () => {
      const world = setUp("syrs");
      mkdirSync(join(world.root, "Sync", ".stfolder"), { recursive: true });
      const synced = join(world.root, "Sync", "spaces", "mira");
      const onNet = join(world.root, "net", "work");
      const a = await existingSpace(world, synced);
      const b = await existingSpace(world, onNet);
      registerSpaces(world.home, [synced, onNet]);
      const service = await start(world, netFacts(world.root));
      const s = await user(world, service);
      const digest = (folder: string) => readFileSync(join(folder, "space.db")).toString("base64");
      // Each space is named by its folder: a restored copy has the same ID.
      expect(a.space.spaceId).not.toBe(b.space.spaceId);
      for (const [folder, words] of [
        [synced, SYNCTHING],
        [onNet, NETWORK],
      ] as const) {
        // A backup is a file of its own, which A1 3.2 lets go to a synced folder.
        const made = (await call(s, "space/backup", { space: folder }))["backup"] as {
          name: string;
          folder: string;
        };
        const { name } = made;
        const before = digest(folder);
        const body = await rejected(call(s, "space/restore", { backup: name, space: folder }));
        expect(body, folder).toMatchObject({ code: "read_only", message: words });
        expect(digest(folder), folder).toBe(before);
        expect(readdirSync(dirname(folder)), folder).toEqual([basename(folder)]);
        // Into a new local folder, the restore goes ahead.
        const file = join(made.folder, `${name}.db.gz`);
        const to = join(world.root, "Restored", basename(folder));
        mkdirSync(dirname(to), { recursive: true });
        expect(await call(s, "space/restore", { backup: file, to }), folder).toMatchObject({
          read_only_copy: true,
        });
      }
      // In the synced folder, once the person confirmed it is excluded, in place too.
      await call(s, "space/open", { path: synced, excluded: true });
      const again = (await call(s, "space/backup", { space: synced }))["backup"] as {
        name: string;
      };
      expect(await call(s, "space/restore", { backup: again.name, space: synced })).toMatchObject({
        space: { state: "open" },
      });
    },
    LONG,
  );

  test(
    "a folder the check never sees is served read-only, confirmable, never writable on its own",
    async () => {
      const world = setUp("syuc");
      const folder = join(world.root, "spaces", "mira");
      const created = await existingSpace(world, folder);
      registerSpaces(world.home, [folder]);
      // Every look of the check fails, as a fault in the check would.
      const blind: SyncHost = {
        ...fixtureHost(world.root),
        kind: () => Promise.reject(new Error("a stand-in fault")),
      };
      const service = await start(world, {}, blind);
      expect(service.spaces()[0]).toMatchObject({
        state: "read_only",
        reason: "synced_folder",
        message: expect.stringContaining("could not be checked") as unknown,
      });
      const s = await user(world, service);
      const id = created.space.spaceId;
      expect(await rejected(addTask(s, id))).toMatchObject({ code: "read_only" });
      // The person's word opens it, as for a synced folder.
      const confirmed = await call(s, "space/open", { path: folder, excluded: true });
      expect(confirmed["space"]).toMatchObject({ state: "open" });
    },
    LONG,
  );
});

/**
 * A host whose check fails its first `blind` rounds, as a slow start of the system would, then
 * sees. A round begins with a look at the space's folder itself.
 */
function seesAfter(world: World, folder: string, blind: number, facts: SyncFacts = {}): SyncHost {
  const host = fixtureHost(world.root, facts);
  let rounds = 0;
  return {
    ...host,
    kind: (path) => {
      if (path === folder) rounds += 1;
      return rounds <= blind ? Promise.reject(new Error("a stand-in fault")) : host.kind(path);
    },
  };
}

async function until(what: string, ok: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("[A1.5.sync.recheck] a folder the check could not see is checked again by itself", () => {
  test(
    "a check that fails twice and then sees a local folder opens the space for changes",
    async () => {
      const world = setUp("syrl");
      const folder = join(world.root, "spaces", "mira");
      const created = await existingSpace(world, folder);
      registerSpaces(world.home, [folder]);
      const service = await startService({
        env: serviceEnv(world.home),
        identity: () => ({ root: false, elevated: false, package: null }),
        maintenance: false,
        say: () => undefined,
        spaceOptions: { syncHost: seesAfter(world, folder, 2), recheckDelaysMs: [50, 50, 50] },
      });
      running.push(service);
      await service.spacesSettled;
      await until("the space to open", () => service.spaces()[0]?.state === "open");
      const s = await user(world, service);
      expect(await addTask(s, created.space.spaceId)).toMatchObject({
        tasks: [{ result: "created" }],
      });
      expect(service.spaces()[0]?.message).toBeUndefined();
      expect(readLog(world.home).filter((e) => e["ev"] === "space.folder_rechecked")).toMatchObject(
        [{ verdict: "local" }],
      );
      // Nothing was confirmed on the person's behalf.
      expect(
        readSpaceSettings(stateOf(world.home), created.space.spaceId).syncedFolderConfirmed,
      ).toBeUndefined();
    },
    LONG,
  );

  test(
    "a person's close that meets the recheck's reopen stands: the space stays closed",
    async () => {
      const world = setUp("syrx");
      const folder = join(world.root, "spaces", "mira");
      await existingSpace(world, folder);
      registerSpaces(world.home, [folder]);
      const service = await startService({
        env: serviceEnv(world.home),
        identity: () => ({ root: false, elevated: false, package: null }),
        maintenance: false,
        say: () => undefined,
        spaceOptions: { syncHost: seesAfter(world, folder, 1), recheckDelaysMs: [50] },
      });
      running.push(service);
      await service.spacesSettled;
      // The person closes the space just as the recheck has seen a local folder and closes the
      // read-only space to open it again.
      let closed: Promise<void> | undefined;
      const log = service.log.log.bind(service.log);
      service.log.log = (ev, fields) => {
        log(ev, fields);
        if (ev === "space.folder_rechecked") closed = service.spaceManager.close(0);
      };
      await until("the recheck", () => closed !== undefined);
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(service.spaces()[0]?.state).toBe("closed");
    },
    LONG,
  );

  test(
    "a check that sees a local folder and then fails again does not start its delays over",
    async () => {
      const world = setUp("syrb");
      const folder = join(world.root, "spaces", "mira");
      await existingSpace(world, folder);
      registerSpaces(world.home, [folder]);
      // Every open's look fails and every recheck's look sees a local folder.
      const host = fixtureHost(world.root, {});
      let rounds = 0;
      const flaky: SyncHost = {
        ...host,
        kind: (path) => {
          if (path === folder) rounds += 1;
          return rounds % 2 === 1 ? Promise.reject(new Error("a stand-in fault")) : host.kind(path);
        },
      };
      const service = await startService({
        env: serviceEnv(world.home),
        identity: () => ({ root: false, elevated: false, package: null }),
        maintenance: false,
        say: () => undefined,
        spaceOptions: { syncHost: flaky, recheckDelaysMs: [50, 50] },
      });
      running.push(service);
      await service.spacesSettled;
      // The open, two rechecks with the reopen each leads to, and no more.
      await until("the last reopen", () => rounds >= 5);
      await until("the space to settle", () => service.spaces()[0]?.state === "read_only");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(rounds).toBe(5);
      expect(service.spaces()[0]).toMatchObject({ state: "read_only", reason: "synced_folder" });
    },
    LONG,
  );

  test(
    "a check that fails and then sees a synced folder keeps the space read-only, in its words",
    async () => {
      const world = setUp("syrc");
      mkdirSync(join(world.root, "Sync", ".stfolder"), { recursive: true });
      const folder = join(world.root, "Sync", "spaces", "mira");
      const created = await existingSpace(world, folder);
      registerSpaces(world.home, [folder]);
      const service = await startService({
        env: serviceEnv(world.home),
        identity: () => ({ root: false, elevated: false, package: null }),
        maintenance: false,
        say: () => undefined,
        spaceOptions: { syncHost: seesAfter(world, folder, 1), recheckDelaysMs: [50, 50] },
      });
      running.push(service);
      await service.spacesSettled;
      await until("the recheck", () => service.spaces()[0]?.message === SYNCTHING);
      expect(service.spaces()[0]).toMatchObject({
        state: "read_only",
        reason: "synced_folder",
        folder_check: { verdict: "synced", provider: "syncthing" },
      });
      // No later look changes it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(service.spaces()[0]).toMatchObject({ state: "read_only", reason: "synced_folder" });
      const s = await user(world, service);
      expect(await rejected(addTask(s, created.space.spaceId))).toMatchObject({
        code: "read_only",
        message: SYNCTHING,
      });
    },
    LONG,
  );
});
