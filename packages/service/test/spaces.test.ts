// One writer per space across processes and state folders (A2 3.4): writer.lock and writer.json.
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createSpace,
  DATABASE_FILE,
  DEFAULT_DRIVER,
  newId,
  SpaceLockedElsewhere,
  StorageWorker,
  type Id,
} from "@tasks/storage";
import { checkedDriver } from "@tasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { EXIT } from "../src/hub/exit.ts";
import { canonicalStatePath } from "../src/hub/paths.ts";
import { startService } from "../src/hub/service.ts";
import { readHolder, WRITER_FILE, WRITER_LOCK } from "../src/hub/spaces.ts";
import {
  EXIT_MS,
  READY_MS,
  readLog,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  Services,
  stateOf,
  tempRoot,
  waitFor,
  waitReady,
  within,
  type ServiceJson,
} from "./harness.ts";

const LONG = 180_000;
const services = new Services();
const cleanups: (() => void)[] = [];
const runtimeDirs: (ServiceJson | undefined)[] = [];

afterEach(async () => {
  await services.stopAll();
  for (const json of runtimeDirs.splice(0)) removeRuntimeDir(json);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A home whose machine.json names `machine`, so that machine is the space's authority. */
function homeFor(root: string, label: string, machine: Id<"m">): string {
  const home = join(root, label);
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: machine,
      name: "fixture-machine",
      created_at: "2026-11-13T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  return home;
}

const event = (home: string, ev: string) => () => readLog(home).find((e) => e["ev"] === ev);

describe("[A2.3.4.hub.writer-lock] one writer per space across services", () => {
  test(
    "two services of two state folders: one opens the space, the other reports locked_elsewhere with the holder",
    async () => {
      const { root, cleanup } = tempRoot("wl");
      cleanups.push(cleanup);
      const machine = newId("m");
      mkdirSync(join(root, "spaces"));
      const space = createSpace(await checkedDriver(), join(root, "spaces", "work"), {
        name: "Work",
        ownerLabel: "Mira Okafor",
        machineId: machine,
      });

      // Service A, as a process, opens the space.
      const a = homeFor(root, "a", machine);
      const pa = services.start(a, { spaces: [space.folder] });
      const ja = await waitReady(a, pa.pid);
      runtimeDirs.push(ja);
      const opened = await waitFor(event(a, "space.open"), READY_MS, "A opens the space");
      expect(opened).toMatchObject({ entry: 0, space: space.space.spaceId, migrated: false });
      expect(readHolder(space.folder)).toEqual({
        machine: "fixture-machine",
        pid: pa.pid,
        instance: ja.instance,
        state_dir: canonicalStatePath(realpathSync.native(stateOf(a)), process.platform),
        since: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as unknown,
      });

      // Service B, another process and state folder: the space is unavailable, B runs on.
      const b = homeFor(root, "b", machine);
      const pb = services.start(b, { spaces: [space.folder] });
      runtimeDirs.push(await waitReady(b, pb.pid));
      const refused = await waitFor(event(b, "space.unavailable"), READY_MS, "B refuses it");
      expect(refused).toMatchObject({ entry: 0, reason: "locked_elsewhere" });
      expect(pb.child.exitCode).toBeNull();
      // A's holder record is untouched by B.
      expect(readHolder(space.folder)?.pid).toBe(pa.pid);

      // Service C in this process names the holder in its status.
      const c = homeFor(root, "c", machine);
      registerSpaces(c, [space.folder]);
      const sc = await startService({
        env: serviceEnv(c),
        identity: () => ({ root: false, elevated: false, package: null }),
        say: () => undefined,
      });
      await sc.spacesSettled;
      expect(sc.spaces()).toEqual([
        {
          entry: 0,
          state: "unavailable",
          reason: "locked_elsewhere",
          code: "SPACE_LOCKED_ELSEWHERE",
          holder: expect.objectContaining({ pid: pa.pid, instance: ja.instance }) as unknown,
        },
      ]);
      expect(await sc.stop()).toBe(EXIT.ok);
      removeRuntimeDir(sc);

      // A stops: it closes the space and gives it up. writer.lock stays, writer.json goes.
      pa.send("stop");
      expect((await within(pa.exit, EXIT_MS, "A stops")).code).toBe(EXIT.ok);
      expect(readLog(a).some((e) => e["ev"] === "space.closed")).toBe(true);
      expect(existsSync(join(space.folder, WRITER_FILE))).toBe(false);
      expect(existsSync(join(space.folder, WRITER_LOCK))).toBe(true);

      // Now D, in this process, opens it as its writer.
      const d = homeFor(root, "d", machine);
      registerSpaces(d, [space.folder]);
      const sd = await startService({
        env: serviceEnv(d),
        identity: () => ({ root: false, elevated: false, package: null }),
        say: () => undefined,
      });
      await sd.spacesSettled;
      expect(sd.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
      expect(readHolder(space.folder)).toMatchObject({ pid: process.pid, instance: sd.instance });
      expect(await sd.stop()).toBe(EXIT.ok);
      removeRuntimeDir(sd);
      expect(sd.spaces()).toEqual([{ entry: 0, state: "closed", id: space.space.spaceId }]);
      expect(existsSync(join(space.folder, WRITER_FILE))).toBe(false);
    },
    LONG,
  );

  test(
    "a process that opens the space for writing without the service is refused while the service holds it, and told who holds it",
    async () => {
      const { root, cleanup } = tempRoot("wx");
      cleanups.push(cleanup);
      const machine = newId("m");
      mkdirSync(join(root, "spaces"));
      const space = createSpace(await checkedDriver(), join(root, "spaces", "work"), {
        name: "Work",
        ownerLabel: "Mira Okafor",
        machineId: machine,
      });
      const a = homeFor(root, "a", machine);
      const pa = services.start(a, { spaces: [space.folder] });
      const ja = await waitReady(a, pa.pid);
      runtimeDirs.push(ja);
      await waitFor(event(a, "space.open"), READY_MS, "A opens the space");
      // Storage's own writable open, as a tool or an offline CLI would use it: writer.lock is
      // storage's now, so it refuses (review round one, finding 1).
      const worker = await StorageWorker.start({ driver: DEFAULT_DRIVER });
      try {
        const info = { id: machine, name: "fixture-machine", os: "linux" } as const;
        for (const open of [
          () => worker.openSpaceWriter(space.folder, { machine: info }),
          () => worker.recoverSpace(space.folder),
        ]) {
          const refused = await open().then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(refused).toBeInstanceOf(SpaceLockedElsewhere);
          expect((refused as SpaceLockedElsewhere).holder).toMatchObject({
            pid: pa.pid,
            instance: ja.instance,
          });
        }
        // A stops and gives the space up; the direct opener then has it.
        pa.send("stop");
        expect((await within(pa.exit, EXIT_MS, "A stops")).code).toBe(EXIT.ok);
        const writer = await worker.openSpaceWriter(space.folder, { machine: info });
        expect(writer.spaceId).toBe(space.space.spaceId);
        await writer.close();
      } finally {
        await worker.close();
      }
    },
    LONG,
  );

  test(
    "a writer.lock deleted under an open space: the service exits 70 at once, and another can take the space",
    async () => {
      const { root, cleanup } = tempRoot("wd");
      cleanups.push(cleanup);
      const machine = newId("m");
      mkdirSync(join(root, "spaces"));
      const space = createSpace(await checkedDriver(), join(root, "spaces", "work"), {
        name: "Work",
        ownerLabel: "Mira Okafor",
        machineId: machine,
      });
      const lockPath = join(space.folder, WRITER_LOCK);
      if (process.platform === "win32") {
        // Windows refuses to delete or rename a file SQLite holds open, so the space stays its.
        const w = homeFor(root, "w", machine);
        registerSpaces(w, [space.folder]);
        const sw = await startService({
          env: serviceEnv(w),
          identity: () => ({ root: false, elevated: false, package: null }),
          say: () => undefined,
        });
        await sw.spacesSettled;
        expect(() => {
          rmSync(lockPath);
        }).toThrow();
        expect(sw.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
        expect(await sw.stop()).toBe(EXIT.ok);
        removeRuntimeDir(sw);
        return;
      }
      // A, a real service, opens the space.
      const a = homeFor(root, "a", machine);
      const pa = services.start(a, { spaces: [space.folder] });
      runtimeDirs.push(await waitReady(a, pa.pid));
      await waitFor(event(a, "space.open"), READY_MS, "A opens the space");
      // The lock file goes: another service could now lock a new one, so A stops writing at once.
      const t0 = Date.now();
      rmSync(lockPath);
      expect((await within(pa.exit, EXIT_MS, "A exits")).code).toBe(EXIT.crashed);
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(readLog(a).find((e) => e["ev"] === "space.ownership_lost")).toMatchObject({
        entry: 0,
        what: "missing",
      });

      // B takes the new writer.lock and opens the space as its only writer.
      const b = homeFor(root, "b", machine);
      registerSpaces(b, [space.folder]);
      const sb = await startService({
        env: serviceEnv(b),
        identity: () => ({ root: false, elevated: false, package: null }),
        say: () => undefined,
      });
      await sb.spacesSettled;
      expect(sb.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
      expect(readHolder(space.folder)).toMatchObject({ pid: process.pid, instance: sb.instance });
      expect(await sb.stop()).toBe(EXIT.ok);
      removeRuntimeDir(sb);
    },
    LONG,
  );

  test(
    "a database with a second name (a hard link, or a symbolic link) is never opened for writing",
    async () => {
      const { root, cleanup } = tempRoot("wl2");
      cleanups.push(cleanup);
      const machine = newId("m");
      mkdirSync(join(root, "spaces"));
      const space = createSpace(await checkedDriver(), join(root, "spaces", "work"), {
        name: "Work",
        ownerLabel: "Mira Okafor",
        machineId: machine,
      });
      // A second folder whose database is the same file: two writer.lock files would guard it,
      // and each folder would get its own -wal beside one database.
      const alias = join(root, "spaces", "alias");
      mkdirSync(alias);
      copyFileSync(join(space.folder, "space.json"), join(alias, "space.json"));
      linkSync(join(space.folder, DATABASE_FILE), join(alias, DATABASE_FILE));
      const entries = [{ path: space.folder }, { path: alias }];
      if (process.platform !== "win32") {
        const symlinked = join(root, "spaces", "symlinked");
        mkdirSync(symlinked);
        copyFileSync(join(space.folder, "space.json"), join(symlinked, "space.json"));
        symlinkSync(join(alias, DATABASE_FILE), join(symlinked, DATABASE_FILE));
        entries.push({ path: symlinked });
      }
      const h = homeFor(root, "h", machine);
      registerSpaces(
        h,
        entries.map((entry) => entry.path),
      );
      const service = await startService({
        env: serviceEnv(h),
        identity: () => ({ root: false, elevated: false, package: null }),
        say: () => undefined,
      });
      await service.spacesSettled;
      expect(service.spaces()).toEqual(
        entries.map((_, entry) => ({
          entry,
          state: "unavailable",
          reason: "linked_database",
          code: "SPACE_DATABASE_LINKED",
        })),
      );
      expect(await service.stop()).toBe(EXIT.ok);
      removeRuntimeDir(service);
      // The refused spaces were never written: storage refused them before anything opened them,
      // not even writer.lock.
      for (const entry of entries) {
        expect(existsSync(join(entry.path, WRITER_FILE))).toBe(false);
        expect(existsSync(join(entry.path, WRITER_LOCK))).toBe(false);
      }
    },
    LONG,
  );

  test(
    "a missing space folder is unavailable(missing) and the service runs on",
    async () => {
      const { root, cleanup } = tempRoot("wm");
      cleanups.push(cleanup);
      const h = join(root, "h");
      registerSpaces(h, [join(root, "spaces", "gone")]);
      const service = await startService({
        env: serviceEnv(h),
        identity: () => ({ root: false, elevated: false, package: null }),
        say: () => undefined,
      });
      await service.spacesSettled;
      expect(service.spaces()).toEqual([
        { entry: 0, state: "unavailable", reason: "missing", code: "SPACE_NOT_FOUND" },
      ]);
      expect(service.status().state).toBe("ready");
      expect(await service.stop()).toBe(EXIT.ok);
      removeRuntimeDir(service);
    },
    LONG,
  );
});
