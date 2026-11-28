// Forwarder conformance (A2 3.7.5, 3.7.6): a service restart in the middle of calls. 10 bridges
// through a service restart see at most one connection_lost each and go on in the space they
// opened (A7 M2.01's Verify line; A2 5's integration test). The service here is the scripted peer,
// killed hard and started again on a new endpoint with a new default space.
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
  readonly space: string | null;
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
    "10 bridges: one call in flight each gets connection_lost, calls during the outage wait and succeed, and every session goes on in its space",
    { timeout: 180_000 },
    async () => {
      const home = makeHome("restart");
      homes.push(home);
      const first = await procs.peer(home);
      // Entries that name no space: each bridge takes the first service's default.
      const args = ["--instance", "test-agent", "--app", "test"];
      const bridges = Array.from({ length: 10 }, () => procs.bridge(home, { args }));
      const before = await Promise.all(
        bridges.map(async (bridge) => {
          await bridge.initialize();
          return whoami(bridge);
        }),
      );
      const space = before[0]?.space;
      expect(space).toMatch(/^sp_/);
      for (const who of before) expect(who.space).toBe(space);

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

      // Each bridge goes on in the space it opened, not the new service's default, and its
      // session went on from mcp_init without a new initialize.
      const after = await Promise.all(bridges.map((bridge) => whoami(bridge)));
      for (const who of after) {
        expect(who.space).toBe(space);
        expect(who.init).toBe(true);
        expect(who.started).toBe(true);
        expect(who.pid).not.toBe(first.pid);
      }
      const rebinds = peerBinds(home).filter((bind) => bind.pid !== first.pid);
      expect(rebinds).toHaveLength(10);
      for (const bind of rebinds) {
        expect(bind.context["held_space"]).toBe(space);
        expect(bind.context).not.toHaveProperty("resume");
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
    "a service that stays down: requests wait for the hold, a burst past the hold limit leaves the forwarder up, every request gets the offline answer, stderr names no content, and a service that comes back answers again",
    { timeout: 120_000 },
    async () => {
      const home = makeHome("down");
      homes.push(home);
      const peer = await procs.peer(home);
      // Content the offline path must never write to stderr, its warnings included.
      const env = {
        TTASKS_TICKET: "CONTENTTICKET",
        CLAUDE_CODE_SESSION_ID: "CONTENTSESSION",
        TTASKS_TASK: "CONTENTTASK",
        CONTENT_SECRET: "CONTENTSECRET",
      };
      const bridge = procs.bridge(home, { env });
      await bridge.initialize();
      await whoami(bridge);
      await procs.kill(peer);
      home.removeServiceFile();
      // The peer's exit can reach this test before the bridge has handled its end of the
      // connection. A call sent then is in flight when the connection ends, and gets
      // connection_lost at once (A2 3.7.5). So the calls wait until the bridge has noticed the loss.
      await waitFor(
        () => (bridge.proc.stderr().includes("lost the connection") ? true : undefined),
        30_000,
        "the bridge notices the loss",
      );
      // Junk lines, held and then handled offline.
      bridge.write("not json at all CONTENTRAW\n");
      bridge.write(`${"v".repeat(64)}\u0000CONTENTNUL\n`);
      const started = Date.now();
      let held = 0;
      const timed = bridge.call("echo", { secret: "CONTENTARG" }, "timed").then((reply) => {
        held = Date.now() - started;
        return reply;
      });
      // Two 5 MiB calls take the held lines past their 8 MiB bound, so stdin is no longer read;
      // the calls after them fill stdin's own buffer. Nothing else keeps the process busy then.
      const big = "x".repeat(5 * MiB);
      const calls = Promise.all([
        timed,
        bridge.call("echo", { big }, "big-1"),
        bridge.call("echo", { big }, "big-2"),
        ...Array.from({ length: 40 }, (_, n) =>
          bridge.call("echo", { pad: "y".repeat(20_000) }, `pad-${String(n)}`),
        ),
      ]);
      const [reply, ...burst] = await Promise.race([
        calls,
        bridge.proc.exit.then((exit) => {
          throw new Error(`the forwarder ended early: ${JSON.stringify(exit)}`);
        }),
      ]);
      // The hold is 10 s; the answer names the service as down, not the lost connection.
      expect(held).toBeGreaterThanOrEqual(5_000);
      expect(isOfflineText(reply, "service_down")).toBe(true);
      expect(burst).toHaveLength(42);
      for (const answer of burst) expect(isOfflineText(answer, "service_down")).toBe(true);
      // Later calls are answered offline at once.
      const t0 = Date.now();
      expect(isOfflineText(await bridge.call("echo", {}), "service_down")).toBe(true);
      expect(Date.now() - t0).toBeLessThan(5_000);
      // Past the hold the forwarder still reconnects: a service that comes back answers the same
      // bridge. Until its bind is answered a call gets the offline answer, so it is sent again.
      await procs.peer(home);
      let echoed = await bridge.call("echo", { n: "back" });
      for (const end = Date.now() + 60_000; Date.now() < end;) {
        if (!isOfflineText(echoed, "service_down")) break;
        await sleep(100);
        echoed = await bridge.call("echo", { n: "back" });
      }
      expect(textOf(echoed)).toBe(JSON.stringify({ n: "back" }));
      bridge.end();
      expect(await bridge.proc.exit).toEqual({ code: 0, signal: null });
      const stderr = bridge.proc.stderr();
      expect(stderr).not.toContain("Warning");
      for (const word of ["CONTENT", "bh_", home.root, "sp_test"]) {
        expect(stderr).not.toContain(word);
      }
      expect(bridge.stray).toEqual([]);
    },
  );
});
