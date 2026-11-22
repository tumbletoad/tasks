// `ttasks space open` of a space that is unavailable tries it again in one step, and a space whose
// worker did not end in time opens again once that worker has ended, never while it still runs.
// Services run in this process on temporary homes; fixture spaces and stand-in workers only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSpace, newId, StorageWorker, type Id } from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { startService, type RunningService, type StartOptions } from "../src/hub/service.ts";
import { storageFailureBody } from "../src/hub/space-errors.ts";
import { Timeout } from "../src/hub/wait.ts";
import {
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
} from "./harness.ts";

const running: RunningService[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A home whose machine.json names a new machine, and a folder for spaces. */
function setUp(label: string): { home: string; spaces: string; machine: Id<"m"> } {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  const machine = newId("m");
  const home = join(root, "h");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: machine,
      name: "fixture-machine",
      created_at: "2026-11-16T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  const spaces = join(root, "spaces");
  mkdirSync(spaces);
  return { home, spaces, machine };
}

async function fixtureSpace(folder: string, machine: Id<"m">) {
  return createSpace(await checkedDriver(), folder, {
    name: "Work",
    ownerLabel: "Mira Okafor",
    machineId: machine,
  });
}

async function start(
  home: string,
  folder: string,
  spaceOptions: NonNullable<StartOptions["spaceOptions"]>,
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

/** Hands out the stand-ins in order, then real workers, and counts every start. */
function workers(...ready: (() => Promise<StorageWorker>)[]) {
  let started = 0;
  const real: StorageWorker[] = [];
  cleanups.push(async () => {
    for (const worker of real) await worker.close().catch(() => undefined);
  });
  return {
    started: () => started,
    start: async (): Promise<StorageWorker> => {
      started += 1;
      const next = ready.shift();
      if (next !== undefined) return next();
      const worker = await StorageWorker.start({ driver: "node:sqlite" });
      real.push(worker);
      return worker;
    },
  };
}

/**
 * A stand-in worker whose writer's open ran past its bound and whose close ends only when the
 * test says so. It reports the passed bound itself, so the real worker opened after it keeps the
 * default bound, whatever the machine's speed.
 */
function hungWorker() {
  let end: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  let closes = 0;
  const worker = {
    openSpaceWriter: () => Promise.reject(new Timeout()),
    close: () => {
      closes += 1;
      return ended;
    },
  } as unknown as StorageWorker;
  return { worker, end, closes: () => closes };
}

describe("[A2.3.1.hub.space-retry] space open tries an unavailable space again, and a stuck one once its worker has ended", () => {
  test("a space missing at the start opens with one space open once its folder is there", async () => {
    const { home, spaces, machine } = setUp("retrymissing");
    const folder = join(spaces, "work");
    const service = await start(home, folder, {});
    expect(service.spaces()).toEqual([
      expect.objectContaining({ entry: 0, state: "unavailable", reason: "missing" }),
    ]);
    // The hint names the one command that gets the person out.
    expect(service.spaces()[0]?.message).toContain("space open <folder>");
    expect(service.spaces()[0]?.message).not.toContain("space close");
    const space = await fixtureSpace(folder, machine);
    // The entry was registered without the space's ID, so it opens as the space it finds there.
    await service.spaceManager.open(folder, space.space.spaceId);
    expect(service.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
  }, 120_000);

  test("an open that failed is tried again by space open, after its worker was closed", async () => {
    const { home, spaces, machine } = setUp("retryfailed");
    const space = await fixtureSpace(join(spaces, "work"), machine);
    let failedClosed = 0;
    const failing = {
      openSpaceWriter: () => Promise.reject(new Error("a passing failure")),
      close: () => {
        failedClosed += 1;
        return Promise.resolve();
      },
    } as unknown as StorageWorker;
    const pool = workers(() => Promise.resolve(failing));
    const service = await start(home, space.folder, { startWorker: pool.start });
    expect(service.spaces()).toEqual([
      expect.objectContaining({ entry: 0, state: "unavailable", reason: "open_failed" }),
    ]);
    expect(failedClosed).toBe(1);
    await service.spaceManager.open(space.folder);
    expect(service.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
    expect(pool.started()).toBe(2);
    expect(failedClosed).toBe(1);
  }, 120_000);

  test("a worker that did not close in time keeps the space from opening until it has ended, then space open opens it", async () => {
    const { home, spaces, machine } = setUp("retrystuck");
    const space = await fixtureSpace(join(spaces, "work"), machine);
    const hung = hungWorker();
    const pool = workers(() => Promise.resolve(hung.worker));
    // The close's bound is short: the hung close passes it whatever the machine's speed.
    const service = await start(home, space.folder, {
      closeTimeoutMs: 200,
      startWorker: pool.start,
    });
    expect(service.spaces()).toEqual([
      expect.objectContaining({ entry: 0, state: "unavailable", reason: "open_failed" }),
    ]);
    expect(hung.closes()).toBe(1);
    // Its worker still runs: no second worker opens the space beside it, and the person is told
    // what is the case and what to do.
    const refused = await service.spaceManager.open(space.folder).then(
      () => undefined,
      (error: unknown) => error as { code?: string },
    );
    expect(refused).toMatchObject({ code: "SPACE_WRITER_TAKEN" });
    expect(storageFailureBody(refused?.code).message).toMatch(/has not ended yet\. Try again/);
    expect(pool.started()).toBe(1);
    expect(service.spaces()[0]?.state).toBe("unavailable");
    // A second try while it still runs is refused the same way.
    await expect(service.spaceManager.open(space.folder)).rejects.toMatchObject({
      code: "SPACE_WRITER_TAKEN",
    });
    expect(pool.started()).toBe(1);
    // The worker ends once the next open waits for it: that open goes on and opens the space.
    const opening = service.spaceManager.open(space.folder);
    hung.end();
    await opening;
    expect(service.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
    expect(pool.started()).toBe(2);
  }, 120_000);

  test("a close that passed its bound while the open still ran: the space stays closed until that open has ended, then opens once", async () => {
    const { home, spaces, machine } = setUp("retrybusy");
    const space = await fixtureSpace(join(spaces, "work"), machine);
    let arrive: (worker: StorageWorker) => void = () => undefined;
    const late = new Promise<StorageWorker>((resolve) => {
      arrive = resolve;
    });
    let lateClosed = 0;
    let lateWriters = 0;
    const lateWorker = {
      openSpaceWriter: () => {
        lateWriters += 1;
        return new Promise(() => undefined);
      },
      close: () => {
        lateClosed += 1;
        return Promise.resolve();
      },
    } as unknown as StorageWorker;
    const pool = workers(() => late);
    registerSpaces(home, [space.folder]);
    const service = await startService({
      env: serviceEnv(home),
      identity: () => ({ root: false, elevated: false, package: null }),
      say: () => undefined,
      maintenance: false,
      spaceOptions: { startWorker: pool.start, openTimeoutMs: 60_000, closeTimeoutMs: 200 },
    });
    running.push(service);
    await waitFor(() => (pool.started() > 0 ? true : undefined), 10_000, "the open asks a worker");
    await service.spaceManager.close(0);
    expect(service.spaces()[0]?.state).toBe("closed");
    await expect(service.spaceManager.open(space.folder)).rejects.toMatchObject({
      code: "SPACE_WRITER_TAKEN",
    });
    expect(pool.started()).toBe(1);
    // The worker arrives after the close: the open that asked for it sees the close, opens
    // nothing and closes it.
    arrive(lateWorker);
    await waitFor(() => (lateClosed > 0 ? true : undefined), 10_000, "the late worker closes");
    expect(lateWriters).toBe(0);
    expect(service.spaces()[0]?.state).toBe("closed");
    await service.spaceManager.open(space.folder);
    expect(service.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
    expect(pool.started()).toBe(2);
    expect(lateClosed).toBe(1);
  }, 120_000);

  test("an open that ends after its close passed the bound never serves the space: its writer closes while the space reads closed", async () => {
    const { home, spaces, machine } = setUp("retrylatename");
    const space = await fixtureSpace(join(spaces, "work"), machine);
    let stateNow: () => string | undefined = () => undefined;
    let free: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      free = resolve;
    });
    let asked = false;
    const statesAtClose: (string | undefined)[] = [];
    /** Calls on the real object, with one method put in place. */
    const wrap = <T extends object>(target: T, key: string, put: unknown): T =>
      new Proxy(target, {
        get: (t, k) => {
          if (k === key) return put;
          const value: unknown = Reflect.get(t, k, t);
          return typeof value === "function" ? (value as () => unknown).bind(t) : value;
        },
      });
    const pool = workers(async () => {
      const real = await StorageWorker.start({ driver: "node:sqlite" });
      cleanups.push(() => real.close().catch(() => undefined));
      const withWriter = wrap(
        real,
        "openSpaceWriter",
        async (...args: Parameters<StorageWorker["openSpaceWriter"]>) => {
          const writer = await real.openSpaceWriter(...args);
          return wrap(writer, "close", async () => {
            statesAtClose.push(stateNow());
            await writer.close();
          });
        },
      );
      return wrap(
        withWriter,
        "openSpaceReader",
        async (...args: Parameters<StorageWorker["openSpaceReader"]>) => {
          const opened = await real.openSpaceReader(...args);
          // The space's name is read last: it waits until the close has passed its bound.
          const conn = wrap(opened.conn, "get", async (...rest: unknown[]) => {
            asked = true;
            await gate;
            return (opened.conn.get as (...a: unknown[]) => Promise<unknown>)(...rest);
          });
          return { ...opened, conn };
        },
      );
    });
    registerSpaces(home, [space.folder]);
    const service = await startService({
      env: serviceEnv(home),
      identity: () => ({ root: false, elevated: false, package: null }),
      say: () => undefined,
      maintenance: false,
      spaceOptions: { startWorker: pool.start, openTimeoutMs: 60_000, closeTimeoutMs: 200 },
    });
    running.push(service);
    stateNow = () => service.spaces()[0]?.state;
    await waitFor(() => (asked ? true : undefined), 30_000, "the open reads the space's name");
    await service.spaceManager.close(0);
    expect(service.spaces()[0]?.state).toBe("closed");
    free();
    await waitFor(
      () => (statesAtClose.length > 0 ? true : undefined),
      30_000,
      "the late open's writer closes",
    );
    expect(statesAtClose).toEqual(["closed"]);
    await service.spaceManager.open(space.folder);
    expect(service.spaces()).toEqual([{ entry: 0, state: "open", id: space.space.spaceId }]);
    expect(pool.started()).toBe(2);
  }, 120_000);
});
