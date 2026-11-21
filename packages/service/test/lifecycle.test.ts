// The hub as a process (A2 3.3, 3.4; A7 3.8 M1.08's Verify line). Every service here is a real
// child process on a temporary TTASKS_HOME. Each test records the PIDs it starts and stops exactly
// those, and removes its folders by their full names.
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { openRpc } from "@ttasks/bridge/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { EXIT } from "../src/hub/exit.ts";
import {
  diagnostics,
  endpointInstance,
  EXIT_MS,
  keyOf,
  MAIN,
  openSession,
  READY_MS,
  readLog,
  readServiceJson,
  removeRuntimeDir,
  Services,
  stateOf,
  tempRoot,
  waitFor,
  waitReady,
  within,
  type ServiceJson,
} from "./harness.ts";

const WIN = process.platform === "win32";
/** A whole test: up to 10 processes start, each loading Node and the hub. */
const LONG = 180_000;

const services = new Services();
const cleanups: (() => void)[] = [];
const runtimeDirs: (ServiceJson | undefined)[] = [];

function home(label: string): string {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  return join(root, "h");
}

afterEach(async () => {
  await services.stopAll();
  for (const json of runtimeDirs.splice(0)) removeRuntimeDir(json);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("[A2.3.4.hub.single-instance] one service per state folder", () => {
  test(
    "10 simultaneous starts: one is ready, nine exit 73, and the running one is undisturbed",
    async () => {
      const h = home("ten");
      // An existing state folder (made by a first start and a stop), then the same race on a
      // folder that does not exist yet.
      for (const fresh of [false, true]) {
        const target = fresh ? home("ten-fresh") : h;
        if (!fresh) {
          const first = services.start(target);
          await waitReady(target, first.pid);
          first.send("stop");
          expect((await within(first.exit, EXIT_MS, "first stop")).code).toBe(EXIT.ok);
        }
        const procs = Array.from({ length: 10 }, () => services.start(target));
        const ready = await waitFor(
          () => {
            const json = readServiceJson(target);
            return json?.state === "ready" ? procs.find((p) => p.pid === json.pid) : undefined;
          },
          READY_MS,
          "one of the ten ready",
        );
        const winner = ready;
        const losers = procs.filter((p) => p !== winner);
        const exits = await within(
          Promise.all(losers.map((p) => p.exit)),
          EXIT_MS,
          "the nine other starts",
        );
        expect(exits.map((e) => e.code)).toEqual(Array.from({ length: 9 }, () => EXIT.locked));
        for (const loser of losers) expect(loser.stderr()).toMatch(/already runs/);

        // The running service is untouched: still alive, still named by service.json, still
        // answering on its endpoint with its own instance.
        const json = await waitReady(target, winner.pid);
        runtimeDirs.push(json);
        expect(winner.child.exitCode).toBeNull();
        expect(json.endpoint).not.toBeNull();
        const endpoint = json.endpoint?.path ?? "";
        expect(await endpointInstance(target, endpoint)).toBe(json.instance);
        const events = readLog(target);
        expect(
          events.filter((e) => e["ev"] === "service.ready" && e["pid"] === winner.pid),
        ).toHaveLength(1);
        expect(events.filter((e) => e["ev"] === "service.locked")).toHaveLength(9);
        // A start that lost before the winner wrote service.json cannot name it yet.
        for (const e of events.filter((e) => e["ev"] === "service.locked")) {
          expect([undefined, winner.pid]).toContain(e["holder"]);
        }
        winner.send("stop");
        expect((await within(winner.exit, EXIT_MS, "winner stop")).code).toBe(EXIT.ok);
      }
    },
    LONG,
  );
});

describe("[A2.3.4.hub.lock-deleted] the service watches service.lock", () => {
  test.skipIf(WIN)(
    "Linux and macOS: deleting service.lock makes the service exit 70 within 10 s",
    async () => {
      const h = home("del");
      const proc = services.start(h);
      const json = await waitReady(h, proc.pid);
      runtimeDirs.push(json);
      const t0 = performance.now();
      rmSync(join(stateOf(h), "service.lock"));
      const exit = await within(proc.exit, 20_000, "exit after the lock was deleted");
      const ms = performance.now() - t0;
      expect(exit.code).toBe(EXIT.crashed);
      expect(ms).toBeLessThan(10_000);
      const lost = readLog(h).find((e) => e["ev"] === "service.ownership_lost");
      expect(lost?.["what"]).toBe("missing");
      // Its own service.json goes; a new service then starts on the new lock file.
      expect(readServiceJson(h)).toBeUndefined();
      const next = services.start(h);
      runtimeDirs.push(await waitReady(h, next.pid));
    },
    LONG,
  );

  test.runIf(WIN)(
    "Windows: a held service.lock cannot be deleted or renamed, so the service keeps its lock",
    async () => {
      const h = home("del");
      const proc = services.start(h);
      const json = await waitReady(h, proc.pid);
      const lock = join(stateOf(h), "service.lock");
      expect(() => {
        rmSync(lock);
      }).toThrow(/EPERM|EBUSY/);
      expect(() => {
        renameSync(lock, `${lock}.moved`);
      }).toThrow(/EPERM|EBUSY/);
      // Still the running service, still answering.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(proc.child.exitCode).toBeNull();
      expect(await endpointInstance(h, json.endpoint?.path ?? "")).toBe(json.instance);
      expect(readLog(h).some((e) => e["ev"] === "service.ownership_lost")).toBe(false);
    },
    LONG,
  );
});

describe("[A2.3.4.hub.two-installs] two state paths, two installs", () => {
  test(
    "two TTASKS_HOME folders with the same name give two install IDs and two endpoints, side by side",
    async () => {
      const a = home("two");
      const b = home("two");
      expect(basename(a)).toBe(basename(b));
      const pa = services.start(a);
      const ja = await waitReady(a, pa.pid);
      runtimeDirs.push(ja);
      const before = ja.endpoint?.kind === "unix" ? lstatSync(ja.endpoint.path) : undefined;

      const pb = services.start(b);
      const jb = await waitReady(b, pb.pid);
      runtimeDirs.push(jb);
      expect(ja.install_id).not.toBe(jb.install_id);
      expect(ja.endpoint?.path).not.toBe(jb.endpoint?.path);
      // A pipe or a per-user runtime folder carries the install ID. The fallback socket folder,
      // `<state>/run/`, is inside the install's own state folder.
      for (const [h, json] of [
        [a, ja],
        [b, jb],
      ] as const) {
        const path = json.endpoint?.path ?? "";
        if (path.startsWith(join(stateOf(h), "run")))
          expect(path).toBe(join(stateOf(h), "run", "tasks.sock"));
        else expect(path).toContain(json.install_id);
      }
      // Each endpoint is served by its own service.
      expect(await endpointInstance(a, ja.endpoint?.path ?? "")).toBe(ja.instance);
      expect(await endpointInstance(b, jb.endpoint?.path ?? "")).toBe(jb.instance);

      // The second install starts and stops without touching the first.
      pb.send("stop");
      expect((await within(pb.exit, EXIT_MS, "second stop")).code).toBe(EXIT.ok);
      expect(pa.child.exitCode).toBeNull();
      expect(readServiceJson(a)?.instance).toBe(ja.instance);
      expect(await endpointInstance(a, ja.endpoint?.path ?? "")).toBe(ja.instance);
      if (before !== undefined && ja.endpoint?.kind === "unix") {
        const after = lstatSync(ja.endpoint.path);
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      }
    },
    LONG,
  );
});

describe("[A2.3.4.hub.stale-recovery] a crash leaves what the next start recovers from", () => {
  test(
    "after a hard kill the next start takes the lock, replaces service.json and the socket, and is ready",
    async () => {
      const h = home("stale");
      let proc = services.start(h);
      let json = await waitReady(h, proc.pid);
      runtimeDirs.push(json);
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await services.kill(proc);
        // What the crash left.
        expect(readServiceJson(h)?.pid).toBe(proc.pid);
        expect(existsSync(join(stateOf(h), "service.lock"))).toBe(true);
        if (json.endpoint?.kind === "unix") expect(existsSync(json.endpoint.path)).toBe(true);

        const next = services.start(h);
        const nextJson = await waitReady(h, next.pid);
        expect(nextJson.instance).not.toBe(json.instance);
        expect(nextJson.install_id).toBe(json.install_id);
        expect(await endpointInstance(h, nextJson.endpoint?.path ?? "")).toBe(nextJson.instance);
        const removed = readLog(h).filter(
          (e) => e["ev"] === "service.stale_removed" && e["pid"] === next.pid,
        );
        expect(removed.map((e) => e["what"])).toEqual(
          json.endpoint?.kind === "unix" ? ["socket"] : [],
        );
        proc = next;
        json = nextJson;
      }
      expect(readdirSync(stateOf(h)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      expect(readdirSync(stateOf(h)).some((n) => n.startsWith("service.lock-"))).toBe(false);
    },
    LONG,
  );
});

describe("[A2.3.3.hub.exit-codes] exit codes and refusals as a process", () => {
  test(
    "a graceful stop drains and exits 0, removing service.json and the socket file",
    async () => {
      const h = home("stop");
      const proc = services.start(h);
      const json = await waitReady(h, proc.pid);
      runtimeDirs.push(json);
      proc.send("stop");
      expect((await within(proc.exit, EXIT_MS, "stop")).code).toBe(EXIT.ok);
      expect(readServiceJson(h)).toBeUndefined();
      if (json.endpoint?.kind === "unix") expect(existsSync(json.endpoint.path)).toBe(false);
      const events = readLog(h).map((e) => e["ev"]);
      expect(events).toContain("service.stopping");
      expect(events).toContain("service.stopped");
    },
    LONG,
  );

  test(
    "a stop from outside over ttasks-local/1, on every OS: service/shutdown exits 0, with restart 75, and an agent's connection may not ask",
    async () => {
      for (const restart of [false, true]) {
        const h = home("rpcstop");
        const proc = services.start(h);
        const json = await waitReady(h, proc.pid);
        runtimeDirs.push(json);
        const path = json.endpoint?.path ?? "";
        // An agent's CLI (an agent marker in its context) is the cli-agent class: no shutdown.
        const agent = await openRpc({
          path,
          key: keyOf(h),
          client: {
            kind: "cli",
            version: "0.0.0-test",
            build: "test",
            pid: process.pid,
            package: null,
            tty: { stdin: true, stdout: true },
          },
          context: { env: { CODEX_THREAD_ID: "fixture-thread" } },
        });
        await expect(
          agent.call("service/shutdown", { restart }, { timeoutMs: 10_000 }),
        ).rejects.toMatchObject({ code: -32000, data: { code: "forbidden" } });
        agent.close();
        expect(proc.child.exitCode).toBeNull();
        // The person's own CLI may.
        const session = await openSession(h, path);
        expect(await session.call("service/status", {}, { timeoutMs: 10_000 })).toMatchObject({
          state: "ready",
          pid: proc.pid,
          instance: json.instance,
        });
        expect(await session.call("service/shutdown", { restart }, { timeoutMs: 10_000 })).toEqual({
          state: "draining",
          restart,
        });
        session.close();
        expect((await within(proc.exit, EXIT_MS, "the stop")).code).toBe(
          restart ? EXIT.restart : EXIT.ok,
        );
        expect(readServiceJson(h)).toBeUndefined();
        if (json.endpoint?.kind === "unix") expect(existsSync(path)).toBe(false);
        expect(readLog(h).find((e) => e["ev"] === "service.stopping")).toMatchObject({
          reason: "request",
          restart,
        });
      }
    },
    LONG,
  );

  test(
    "package identity is refused with 64 before the lock, and the reason is in the log and the crash folder",
    async () => {
      const h = home("pkg");
      const proc = services.start(h, { env: { TTASKS_PACKAGE: "Fixture.App_1.0.0.0_x64__abc" } });
      const exit = await within(proc.exit, EXIT_MS, "refusal");
      expect(exit.code).toBe(EXIT.refused);
      expect(proc.stderr()).toMatch(/package/);
      expect(readLog(h).find((e) => e["ev"] === "service.refused")?.["reason"]).toBe("packaged");
      const records = diagnostics(h).filter((f) => f.file.startsWith("crash/"));
      expect(records).toHaveLength(1);
      const record = JSON.parse(records[0]?.text ?? "{}") as Record<string, unknown>;
      expect(record["event"]).toBe("service.refused");
      expect(record["reason"]).toBe("packaged");
      // Refused before the lock: no lock file, no key, no service.json.
      expect(existsSync(join(stateOf(h), "service.lock"))).toBe(false);
      expect(existsSync(join(stateOf(h), "ipc.key"))).toBe(false);
      expect(readServiceJson(h)).toBeUndefined();
    },
    LONG,
  );

  test(
    "an uncaught exception and an unhandled rejection write a crash file and exit 70",
    async () => {
      for (const command of ["crash", "reject"]) {
        const h = home(command);
        const proc = services.start(h);
        runtimeDirs.push(await waitReady(h, proc.pid));
        proc.send(`${command} fixture failure`);
        expect((await within(proc.exit, EXIT_MS, command)).code).toBe(EXIT.crashed);
        const records = diagnostics(h).filter((f) => f.file.startsWith("crash/"));
        expect(records).toHaveLength(1);
        const record = JSON.parse(records[0]?.text ?? "{}") as Record<string, unknown>;
        expect(record["event"]).toBe("service.crash");
        expect(record["error"]).toEqual({ type: "Error" });
        expect(Array.isArray(record["stack"])).toBe(true);
        expect((record["log"] as unknown[]).length).toBeGreaterThan(0);
        expect(readLog(h).some((e) => e["ev"] === "service.crashed")).toBe(true);
        // The next start recovers.
        const next = services.start(h);
        runtimeDirs.push(await waitReady(h, next.pid));
      }
    },
    LONG,
  );

  test(
    "main.ts runs the real identity check: refused with 64 when elevated or root, ready otherwise",
    async () => {
      const h = home("main");
      const proc = services.start(h, { script: MAIN });
      let exited: number | null | undefined;
      void proc.exit.then((exit) => {
        exited = exit.code;
      });
      const outcome = await waitFor(
        () => {
          if (exited !== undefined) return { exit: exited };
          const json = readServiceJson(h);
          return json?.state === "ready" && json.pid === proc.pid ? { json } : undefined;
        },
        READY_MS,
        "main.ts ready or refused",
      );
      if ("exit" in outcome) {
        // An elevated runner (CI's Windows runners) or root.
        expect(outcome.exit).toBe(EXIT.refused);
        expect(proc.stderr()).toMatch(/root or as an elevated administrator/);
        expect(existsSync(stateOf(h))).toBe(false);
      } else {
        // main.ts takes no stdin commands: the hard kill after the test stops it.
        runtimeDirs.push(outcome.json);
        expect(readFileSync(join(stateOf(h), "ipc.key"), "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(await endpointInstance(h, outcome.json.endpoint?.path ?? "")).toBe(
          outcome.json.instance,
        );
      }
    },
    LONG,
  );
});
