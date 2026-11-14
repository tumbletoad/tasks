// Forwarder conformance (A2 3.7.5, 3.7.6): a service restart in the middle of calls. 10 bridges
// through a service restart see at most one connection_lost each and keep their binding (A7
// M2.01's Verify line; A2 5's integration test). The service here is the scripted peer, killed
// hard and started again on a new endpoint; it restores a binding from `resume.handle` as A3's
// session record will.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  Procs,
  isOfflineText,
  makeHome,
  peerBinds,
  sleep,
  textOf,
  waitFor,
  type Bridge,
  type Home,
  type Json,
} from "./harness.ts";

const MiB = 1024 * 1024;
const procs = new Procs();
const homes: Home[] = [];
afterEach(async () => {
  await procs.stopAll();
  for (const home of homes.splice(0)) home.remove();
});

interface Who {
  readonly binding: string;
  readonly restored: boolean;
  readonly started: boolean;
  readonly init: boolean;
  readonly pid: number;
}

async function whoami(bridge: Bridge): Promise<Who> {
  const reply = await bridge.call("whoami");
  const text = textOf(reply);
  if (text === undefined || (reply["result"] as Json)["isError"] === true) {
    throw new Error(`whoami failed: ${JSON.stringify(reply)}`);
  }
  return JSON.parse(text) as Who;
}

const slowCalls = (home: Home): number => {
  try {
    return readFileSync(join(home.state, "peer-slow.jsonl"), "utf8").split("\n").length - 1;
  } catch {
    return 0;
  }
};

describe("[A2.3.7.bridge.restart] bridges through a service restart", () => {
  test(
    "10 bridges: one call in flight each gets connection_lost, calls during the outage wait and succeed, and every binding is kept",
    { timeout: 180_000 },
    async () => {
      const home = makeHome("restart");
      homes.push(home);
      const first = await procs.peer(home);
      const bridges = Array.from({ length: 10 }, () => procs.bridge(home));
      const before = await Promise.all(
        bridges.map(async (bridge) => {
          await bridge.initialize();
          return whoami(bridge);
        }),
      );
      expect(new Set(before.map((who) => who.binding)).size).toBe(10);

      // One call in flight per bridge, then the service dies.
      const inFlight = bridges.map((bridge, n) =>
        bridge.call("slow", { ms: 120_000 }, `slow-${String(n)}`),
      );
      await waitFor(() => (slowCalls(home) >= 10 ? true : undefined), 60_000, "slow calls arrive");
      await procs.kill(first);
      const lost = await Promise.all(inFlight);
      for (const reply of lost) expect(isOfflineText(reply, "connection_lost")).toBe(true);

      // Calls made during the outage wait for the new service instead of failing.
      const during = bridges.map((bridge, n) => bridge.call("echo", { n }, `during-${String(n)}`));
      await sleep(800);
      await procs.peer(home);
      const answered = await Promise.all(during);
      answered.forEach((reply, n) => {
        expect(textOf(reply)).toBe(JSON.stringify({ n }));
      });

      // Each bridge keeps its binding: the new service restored it from the handle, and the
      // session went on from mcp_init without a new initialize.
      const after = await Promise.all(bridges.map((bridge) => whoami(bridge)));
      after.forEach((who, n) => {
        expect(who.binding).toBe(before[n]?.binding);
        expect(who.restored).toBe(true);
        expect(who.init).toBe(true);
        expect(who.pid).not.toBe(first.pid);
      });
      const rebinds = peerBinds(home).filter((bind) => bind.pid !== first.pid);
      expect(rebinds).toHaveLength(10);
      for (const bind of rebinds) {
        expect((bind.context["resume"] as Json)["handle"]).toMatch(/^bh_/);
        expect(bind.context["mcp_init"]).toMatchObject({ method: "initialize" });
      }

      // At most one connection_lost per bridge over the whole run, and stdout held only frames.
      for (const bridge of bridges) {
        const lostCount = bridge.lines.filter((line) => line.includes("(connection_lost)")).length;
        expect(lostCount).toBeLessThanOrEqual(1);
        expect(bridge.stray).toEqual([]);
      }
    },
  );

  test(
    "a service that stays down: requests wait for the hold, then get the offline answer",
    { timeout: 120_000 },
    async () => {
      const home = makeHome("down");
      homes.push(home);
      const peer = await procs.peer(home);
      const bridge = procs.bridge(home);
      await bridge.initialize();
      await whoami(bridge);
      await procs.kill(peer);
      home.removeServiceFile();
      const started = Date.now();
      const reply = await bridge.call("echo", {});
      // The hold is 10 s; the answer names the service as down, not the lost connection.
      expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
      expect(isOfflineText(reply, "service_down")).toBe(true);
      // Later calls are answered offline at once.
      const t0 = Date.now();
      expect(isOfflineText(await bridge.call("echo", {}), "service_down")).toBe(true);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(bridge.stray).toEqual([]);
    },
  );

  test(
    "a burst past the hold limit while the service is down: the forwarder stays up and answers every request",
    { timeout: 120_000 },
    async () => {
      const home = makeHome("burst");
      homes.push(home);
      const peer = await procs.peer(home);
      const bridge = procs.bridge(home);
      await bridge.initialize();
      await whoami(bridge);
      await procs.kill(peer);
      home.removeServiceFile();
      await waitFor(
        () => (bridge.proc.stderr().includes("lost the connection") ? true : undefined),
        30_000,
        "the bridge notices the loss",
      );
      // Two 5 MiB calls take the held lines past their 8 MiB bound, so stdin is no longer read;
      // the calls after them fill stdin's own buffer. Nothing else keeps the process busy then.
      const big = "x".repeat(5 * MiB);
      const calls = Promise.all([
        bridge.call("echo", { big }, "big-1"),
        bridge.call("echo", { big }, "big-2"),
        ...Array.from({ length: 40 }, (_, n) =>
          bridge.call("echo", { pad: "y".repeat(20_000) }, `pad-${String(n)}`),
        ),
      ]);
      const replies = await Promise.race([
        calls,
        bridge.proc.exit.then((exit) => {
          throw new Error(`the forwarder ended early: ${JSON.stringify(exit)}`);
        }),
      ]);
      expect(replies).toHaveLength(42);
      for (const reply of replies) expect(isOfflineText(reply, "service_down")).toBe(true);
      bridge.end();
      expect(await bridge.proc.exit).toEqual({ code: 0, signal: null });
      expect(bridge.proc.stderr()).not.toContain("Warning");
      expect(bridge.stray).toEqual([]);
    },
  );
});
