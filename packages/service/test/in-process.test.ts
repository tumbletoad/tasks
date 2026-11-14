// The hub in this process: refusals with an injected identity, a requested restart, and the
// service lock's own rules. Each test has its own state folder, so no lock file is opened twice.
import { fork, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { StorageWorker } from "@tasks/storage";
import { EXIT, ServiceExit } from "../src/hub/exit.ts";
import type { Identity } from "../src/hub/identity.ts";
import { acquireLock, LockBusy, watchOwnership, type FileIdentity } from "../src/hub/lock.ts";
import { startService, type RunningService } from "../src/hub/service.ts";
import {
  openSession,
  readLog,
  readServiceJson,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
  within,
} from "./harness.ts";

const PLAIN: Identity = { root: false, elevated: false, package: null };
const RACER = fileURLToPath(new URL("./lock-racer.ts", import.meta.url));
const cleanups: (() => void)[] = [];
const running: RunningService[] = [];

function home(label: string): string {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  return join(root, "h");
}

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const quiet = { say: () => undefined };

async function refusal(promise: Promise<unknown>): Promise<ServiceExit> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ServiceExit) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("[A2.3.3.hub.refusals] refusals before anything is written", () => {
  test("root, an elevated Administrator and an elevation it cannot check: 64, nothing written", async () => {
    for (const [identity, reason] of [
      [{ ...PLAIN, root: true }, "root"],
      [{ ...PLAIN, elevated: true }, "elevated"],
      [{ ...PLAIN, elevated: undefined }, "elevation_unknown"],
    ] as const) {
      const h = home("root");
      const lines: string[] = [];
      const exit = await refusal(
        startService({ env: serviceEnv(h), identity: () => identity, say: (l) => lines.push(l) }),
      );
      expect(exit.code).toBe(EXIT.refused);
      expect(exit.refusal).toBe(reason);
      expect(lines).toHaveLength(1);
      // Not even the install folder: a root start must not leave root-owned files behind.
      expect(existsSync(h)).toBe(false);
    }
  });

  test("package identity: 64 after the log, before the lock", async () => {
    const h = home("pkg");
    const exit = await refusal(
      startService({
        env: serviceEnv(h),
        identity: () => ({ ...PLAIN, package: "Claude_1.0.0.0_x64__pzs8sxrjxfjjc" }),
        ...quiet,
      }),
    );
    expect(exit.code).toBe(EXIT.refused);
    expect(exit.refusal).toBe("packaged");
    expect(readLog(h).map((e) => e["ev"])).toEqual(["service.starting", "service.refused"]);
    expect(readdirSync(stateOf(h)).sort()).toEqual(["crash", "logs"]);
  });

  test.skipIf(process.platform === "win32")(
    "a state folder other users can write: 64, and nothing is written into it",
    async () => {
      const h = home("perm");
      mkdirSync(stateOf(h), { recursive: true, mode: 0o700 });
      chmodSync(stateOf(h), 0o777);
      const exit = await refusal(
        startService({ env: serviceEnv(h), identity: () => PLAIN, ...quiet }),
      );
      expect(exit.refusal).toBe("unsafe_permissions");
      expect(readdirSync(stateOf(h))).toEqual([]);
    },
  );

  test("a file where the state folder belongs is invalid configuration: 64 with a line, not a silent 70", async () => {
    const h = home("statefile");
    mkdirSync(h, { recursive: true });
    writeFileSync(stateOf(h), "not a folder");
    const lines: string[] = [];
    const exit = await refusal(
      startService({ env: serviceEnv(h), identity: () => PLAIN, say: (l) => lines.push(l) }),
    );
    expect(exit.code).toBe(EXIT.refused);
    expect(exit.refusal).toBe("invalid_config");
    expect(lines).toHaveLength(1);
    // The line names no path.
    expect(lines[0]).not.toContain(h);
  });

  test("a relative TASKS_HOME is invalid configuration: 64", async () => {
    const exit = await refusal(
      startService({ env: serviceEnv("relative/home"), identity: () => PLAIN, ...quiet }),
    );
    expect(exit.refusal).toBe("invalid_config");
  });
});

describe("[A2.3.3.hub.exit-codes] stop and restart in this process", () => {
  test("service/shutdown over tasks-local/1: the caller gets its reply, then the service drains and exits 75 with restart, 0 without", async () => {
    for (const restart of [true, false]) {
      const h = home("restart");
      const service = await startService({ env: serviceEnv(h), identity: () => PLAIN, ...quiet });
      const json = readServiceJson(h);
      expect(json?.state).toBe("ready");
      expect(service.status()).toMatchObject({ state: "ready", instance: json?.instance });
      const session = await openSession(h, json?.endpoint?.path ?? "");
      expect(session.bound.service.instance).toBe(json?.instance);
      const closed = new Promise<void>((resolve) => {
        session.onClose = resolve;
      });
      // A word as the reason is accepted and never logged; anything else is invalid params.
      await expect(
        session.call("service/shutdown", { restart: "yes" }, { timeoutMs: 10_000 }),
      ).rejects.toMatchObject({ code: -32602 });
      expect(
        await session.call("service/shutdown", { restart, reason: "test" }, { timeoutMs: 10_000 }),
      ).toEqual({ state: "draining", restart });
      expect(await service.exited).toBe(restart ? EXIT.restart : EXIT.ok);
      // The drain ended the connection after its reply.
      await within(closed, 10_000, "the connection ends");
      expect(readServiceJson(h)).toBeUndefined();
      removeRuntimeDir(json);
      const stopping = readLog(h).find((e) => e["ev"] === "service.stopping");
      expect(stopping).toMatchObject({ reason: "request", restart });
      // stop() after the end returns the same code.
      expect(await service.stop()).toBe(restart ? EXIT.restart : EXIT.ok);
    }
  });

  test("a failure while binding exits 70, leaves no service.json and frees the lock", async () => {
    const h = home("bindfail");
    const exit = await refusal(
      startService({
        env: serviceEnv(h),
        identity: () => PLAIN,
        listen: () => Promise.reject(Object.assign(new Error("no endpoint"), { code: "EACCES" })),
        ...quiet,
      }),
    );
    expect(exit.code).toBe(EXIT.crashed);
    // service.json said "starting" for a start that never ran: it must not stay behind.
    expect(readServiceJson(h)).toBeUndefined();
    expect(readLog(h).find((e) => e["ev"] === "service.start_failed")).toMatchObject({
      code: "EACCES",
    });
    const next = await startService({ env: serviceEnv(h), identity: () => PLAIN, ...quiet });
    running.push(next);
    expect(readServiceJson(h)?.state).toBe("ready");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a drain whose file steps fail still ends with its exit code",
    async () => {
      const h = home("drainfail");
      const service = await startService({ env: serviceEnv(h), identity: () => PLAIN, ...quiet });
      // The state folder becomes read-only: service.json can be neither rewritten nor removed.
      chmodSync(stateOf(h), 0o500);
      try {
        expect(await within(service.stop(), 30_000, "the drain")).toBe(EXIT.ok);
        expect(await service.exited).toBe(EXIT.ok);
      } finally {
        chmodSync(stateOf(h), 0o700);
      }
      removeRuntimeDir(service);
    },
  );

  test("a stop does not wait for a space that is still opening: the close is bounded", async () => {
    const h = home("hungopen");
    const folder = join(h, "space");
    mkdirSync(folder, { recursive: true });
    let arrive: (worker: StorageWorker) => void = () => undefined;
    const late = new Promise<StorageWorker>((resolve) => {
      arrive = resolve;
    });
    let lateClosed = 0;
    let asked = 0;
    registerSpaces(h, [folder]);
    const service = await startService({
      env: serviceEnv(h),
      identity: () => PLAIN,
      spaceOptions: {
        startWorker: () => {
          asked += 1;
          return late;
        },
        closeTimeoutMs: 300,
      },
      ...quiet,
    });
    await waitFor(() => (asked > 0 ? true : undefined), 10_000, "the open waits for its worker");
    const t0 = Date.now();
    expect(await within(service.stop(), 10_000, "the stop")).toBe(EXIT.ok);
    expect(Date.now() - t0).toBeLessThan(5_000);
    removeRuntimeDir(service);
    // The worker that arrives after the stop is closed: it never opens the space.
    arrive({
      close: () => {
        lateClosed += 1;
        return Promise.resolve();
      },
    } as unknown as StorageWorker);
    await waitFor(() => (lateClosed > 0 ? true : undefined), 10_000, "the late worker closes");
    expect(existsSync(join(folder, "writer.lock"))).toBe(false);
  }, 60_000);
});

describe("[A2.3.4.hub.single-instance] the lock under a race", () => {
  // Racers that try at the same moment can each see another's brief shared lock and all get
  // SQLITE_BUSY: measured on Linux, 47 of 300 rounds of 10 had no winner without a retry. Every
  // round here must have exactly one.
  test("10 processes that try at the same moment: exactly one wins, every round", async () => {
    const h = home("race");
    mkdirSync(h, { recursive: true });
    const racers: ChildProcess[] = [];
    const ask = (racer: ChildProcess, message: object) =>
      new Promise<{ won?: boolean; busy?: boolean }>((resolve) => {
        racer.once("message", resolve);
        racer.send(message);
      });
    try {
      for (let i = 0; i < 10; i += 1) racers.push(fork(RACER, [], { execArgv: [] }));
      for (let round = 0; round < 25; round += 1) {
        const path = join(h, `r${String(round)}.lock`);
        const go = Date.now() + 50;
        const results = await Promise.all(racers.map((r) => ask(r, { go, path })));
        expect(
          results.filter((r) => r.won === true),
          `round ${String(round)}`,
        ).toHaveLength(1);
        expect(results.filter((r) => r.won !== true).every((r) => r.busy === true)).toBe(true);
        await Promise.all(racers.map((r) => ask(r, { release: true })));
      }
    } finally {
      await Promise.all(
        racers.map(
          (r) =>
            new Promise<void>((resolve) => {
              if (r.exitCode !== null || r.signalCode !== null) {
                resolve();
                return;
              }
              r.once("exit", () => {
                resolve();
              });
              r.kill("SIGKILL");
            }),
        ),
      );
    }
  }, 120_000);
});

describe("[A2.3.4.hub.lock-deleted] the lock and its ownership watch", () => {
  test("a held lock refuses a second holder, even in the same process, and leaves no journal", async () => {
    const h = home("lock");
    mkdirSync(h, { recursive: true });
    const path = join(h, "x.lock");
    const first = await acquireLock(path);
    await expect(acquireLock(path)).rejects.toBeInstanceOf(LockBusy);
    expect(readdirSync(h)).toEqual(["x.lock"]);
    first.release();
    first.release();
    const again = await acquireLock(path);
    again.release();
  });

  test("the watch reports a missing or replaced file once, and stops", async () => {
    const h = home("watch");
    mkdirSync(h, { recursive: true });
    const path = join(h, "x.lock");
    writeFileSync(path, "");
    const identity: FileIdentity = { dev: 1n, ino: 2n };
    for (const [next, expected] of [
      [() => ({ dev: 1n, ino: 3n }), "replaced"],
      [
        () => {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
        "missing",
      ],
    ] as const) {
      let current: () => FileIdentity = () => identity;
      const lost: string[] = [];
      const watch = watchOwnership({ path, identity }, (what, via) => lost.push(`${what}/${via}`), {
        intervalMs: 20,
        stat: () => current(),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lost).toEqual([]);
      current = next;
      await waitFor(() => (lost.length > 0 ? true : undefined), 5_000, "the loss");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lost).toEqual([`${expected}/timer`]);
      watch.stop();
    }
    // A loss before the watch starts is seen at once, not at the first tick.
    const early: string[] = [];
    const late = watchOwnership({ path, identity }, (what, via) => early.push(`${what}/${via}`), {
      intervalMs: 600_000,
      stat: () => ({ dev: 1n, ino: 9n }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(early).toEqual(["replaced/start"]);
    late.stop();
    // An error other than a missing file is left for the next check.
    const lost: string[] = [];
    const watch = watchOwnership({ path, identity }, (what) => lost.push(what), {
      intervalMs: 20,
      stat: () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lost).toEqual([]);
    watch.stop();
    rmSync(path);
  });

  test("in a running service, the watch's loss drains it and it exits 70", async () => {
    const h = home("lost");
    const service = await startService({
      env: serviceEnv(h),
      identity: () => PLAIN,
      ownershipCheckMs: 20,
      ...quiet,
    });
    running.push(service);
    if (process.platform === "win32") {
      // Windows refuses to delete a held lock (lifecycle.test.ts); the drain path is the same.
      expect(() => {
        rmSync(join(stateOf(h), "service.lock"));
      }).toThrow();
      return;
    }
    rmSync(join(stateOf(h), "service.lock"));
    expect(await service.exited).toBe(EXIT.crashed);
    expect(readLog(h).find((e) => e["ev"] === "service.ownership_lost")).toMatchObject({
      what: "missing",
    });
  });
});
