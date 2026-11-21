// The per-user runtime folder on Linux (A2 3.2.1: `/run/user/<uid>/ttasks-<install>/`, which holds
// the socket and A4's launch folders), with a runtime base of the test's own standing in for
// `/run/user`, so the run-user path is exercised in WSL and on CI too. What the product leaves
// there at a clean stop, and what a service test's cleanup leaves there. Fixture data and temporary
// folders only.
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { listenEndpoint } from "../src/hub/endpoint.ts";
import { EXIT } from "../src/hub/exit.ts";
import type { Identity } from "../src/hub/identity.ts";
import { removeIdleRuntime, startService, type RunningService } from "../src/hub/service.ts";
import {
  readLog,
  removeRuntimeDirOf,
  runtimeDirOf,
  serviceEnv,
  stateOf,
  tempRoot,
  testRuntimeBase,
  waitFor,
} from "./harness.ts";
import { LONG_MS, ShimLab } from "./shim-harness.ts";

const LINUX = process.platform === "linux";
const PLAIN: Identity = { root: false, elevated: false, package: null };

const labs: ShimLab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.cleanup();
}, 120_000);

async function lab(label: string): Promise<ShimLab> {
  const made = await ShimLab.create(label);
  labs.push(made);
  return made;
}

describe("[A2.3.2.1.hub.runtime-folder] the runtime folder: nothing left after a clean stop or a test's cleanup", () => {
  test.skipIf(!LINUX)(
    "a clean stop removes the idle runtime folder; one that holds a live shim's launch folder stays until its launch is settled",
    { timeout: 300_000 },
    async () => {
      const l = await lab("rt-stop");
      // The service took its per-user runtime folder under the lab's base, by its full name.
      const dir = runtimeDirOf(l.home, l.runtime.base);
      expect(l.running.runtime.runtimeDir).toBe(dir);
      if (dir === undefined) throw new Error("no runtime folder on Linux");

      const intent = await l.launch(l.plan());
      const shim = l.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      await l.waitIntent(intent.id, (i) => i.state === "confirmed", "the launch confirmed");

      // Stopped while the shim lives: its launch folder is the next start's, so the folder stays
      // whole; only the socket went with the server.
      await l.stopService();
      expect(existsSync(join(dir, "launch", intent.id, "launch.json"))).toBe(true);
      expect(existsSync(join(dir, "tasks.sock"))).toBe(false);

      // The next start reads it back; the shim reattaches, its agent ends, its exit is recorded
      // and its launch folder goes.
      const service = await l.start();
      shim.endInput();
      expect(await l.shimExit(shim)).toEqual({ code: 0, signal: null });
      await l.waitIntent(intent.id, (i) => i.evidence.exit_code !== undefined, "the exit report");
      await waitFor(
        () => (service.launches.host.record(intent.id) === undefined ? true : undefined),
        LONG_MS,
        "the launch folder removed",
      );

      // A clean stop with nothing left of a launch: nothing is left under the base, and the test
      // removed nothing itself.
      await l.stopService();
      expect(l.runtime.leftovers()).toEqual([]);
    },
  );

  test("only empty folders go: a launch folder, or anything else, keeps the runtime folder whole", () => {
    const temp = tempRoot("rt-idle");
    try {
      const dir = join(temp.root, "ttasks-fixture");
      const launch = join(dir, "launch");
      // A launch folder: everything stays.
      mkdirSync(join(launch, "la_fixture"), { recursive: true });
      removeIdleRuntime({ runtimeDir: dir, launch });
      expect(existsSync(join(launch, "la_fixture"))).toBe(true);
      // No launch folder, but something else (a socket that is not this start's): the empty
      // launch root goes, the runtime folder stays with what it holds.
      rmdirSync(join(launch, "la_fixture"));
      writeFileSync(join(dir, "tasks.sock"), "");
      removeIdleRuntime({ runtimeDir: dir, launch });
      expect(existsSync(launch)).toBe(false);
      expect(existsSync(join(dir, "tasks.sock"))).toBe(true);
      // Nothing left: it goes.
      rmSync(join(dir, "tasks.sock"));
      removeIdleRuntime({ runtimeDir: dir, launch });
      expect(existsSync(dir)).toBe(false);
      // Without a per-user runtime folder (Windows, or the fallback under <state>), nothing goes.
      mkdirSync(launch, { recursive: true });
      removeIdleRuntime({ runtimeDir: undefined, launch });
      expect(existsSync(launch)).toBe(true);
    } finally {
      temp.cleanup();
    }
  });

  test.skipIf(!LINUX)(
    "[A2.3.4.hub.drain-ownership] a second start while the first drains after its lock was replaced: the first leaves the new start's runtime folder alone",
    { timeout: 300_000 },
    async () => {
      const temp = tempRoot("rt-drain");
      const runtime = testRuntimeBase("rt-drain");
      const home = join(temp.root, "h");
      const started: RunningService[] = [];
      try {
        const options = {
          env: serviceEnv(home),
          identity: () => PLAIN,
          maintenance: false,
          say: () => undefined,
          runUserBase: runtime.base,
        };
        // The first start's endpoint closes for real (its socket file goes with it), then its
        // drain waits here until the second start is about to bind.
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const first = await startService({
          ...options,
          listen: async (o) => {
            const server = await listenEndpoint(o);
            return {
              close: async (graceMs?: number) => {
                await server.close(graceMs);
                await held;
              },
            };
          },
        });
        started.push(first);
        const dir = first.runtime.runtimeDir;
        if (dir === undefined) throw new Error("no runtime folder on Linux");
        const stopping = first.stop();
        await waitFor(
          () => (existsSync(first.endpoint.path) ? undefined : true),
          LONG_MS,
          "the first start's endpoint closed",
        );
        // service.lock is replaced while the first start drains: deleted, and the second start
        // makes and locks a new one. It takes the runtime folder (still there) and, just before it
        // binds, the first start's drain goes on to its end.
        rmSync(join(stateOf(home), "service.lock"));
        const second = await startService({
          ...options,
          listen: async (o) => {
            release();
            await stopping;
            return listenEndpoint(o);
          },
        });
        started.push(second);
        expect(second.runtime.runtimeDir).toBe(dir);
        expect(existsSync(second.endpoint.path)).toBe(true);
        expect(existsSync(second.runtime.launch)).toBe(true);
        // The first start noted the loss during its drain, and still ends with its own code.
        expect(await stopping).toBe(EXIT.ok);
        expect(readLog(home).some((e) => e["ev"] === "service.ownership_lost")).toBe(true);
        // The second start's own clean stop leaves nothing.
        await second.stop();
        expect(runtime.leftovers()).toEqual([]);
      } finally {
        for (const service of started) await service.stop().catch(() => undefined);
        removeRuntimeDirOf(home, runtime.base);
        runtime.remove();
        temp.cleanup();
      }
    },
  );

  test.skipIf(!LINUX)(
    "a test that stops halfway leaves nothing under its runtime base after its cleanup, and anything else left there fails the cleanup",
    { timeout: 300_000 },
    async () => {
      // A test that failed with its shim and agent running and its service up. Each lab is also
      // afterEach's, so it is removed if this test fails before it cleans up itself.
      const halfway = await lab("rt-halfway");
      const intent = await halfway.launch(halfway.plan());
      await halfway.waitIntent(intent.id, (i) => i.state === "confirmed", "the launch confirmed");
      const base = halfway.runtime;
      expect(base.leftovers()).not.toEqual([]);
      await halfway.cleanup();
      expect(existsSync(base.base)).toBe(false);

      // Something under the base that the lab did not cause fails its cleanup.
      const guarded = await lab("rt-guard");
      const uid = String(process.getuid?.() ?? 0);
      mkdirSync(join(guarded.runtime.base, uid, "ttasks-0000000000"));
      await expect(guarded.cleanup()).rejects.toThrow(
        "a service test left ttasks-0000000000 under its runtime base",
      );
      expect(existsSync(guarded.runtime.base)).toBe(false);
    },
  );
});
