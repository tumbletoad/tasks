// A peer that sends garbage, stalls or closes at any byte must not crash or hang the service,
// leak a socket, or learn anything beyond the challenge before its proof verifies (A2 3.6.2,
// 3.6.3, M1.09). The caps on unauthenticated and total connections hold, and a name in use is
// refused so the hub can pick another (A2 3.4).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { openLines, openRpc } from "@tasks/bridge/protocol";
import {
  clientInfo,
  endpointRoot,
  firstLines,
  rawConnect,
  sleep,
  until,
} from "@tasks/bridge/test/endpoint";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testClock, type TestClock } from "../../test/clock.ts";
import { startServer, type Started } from "../../test/local.ts";
import { makeBind, makeHello, rawChallenge, type RawSession } from "../../test/raw.ts";
import { serve, type ServeOptions, type ServerLimits } from "./index.ts";

const SLOW = { timeout: 120_000 };
/** How long a test waits for a close that a deadline causes: far past any deadline used here. */
const DEADLINE_WAIT = 20_000;

let root: ReturnType<typeof endpointRoot>;
beforeAll(() => {
  root = endpointRoot();
});
afterAll(() => {
  root.remove();
});

/** A good client still binds and calls: the service survived whatever came before. */
async function stillServes(started: Started): Promise<void> {
  const session = await openRpc({
    path: started.path,
    key: started.key,
    client: clientInfo(),
    context: {},
  });
  expect(await session.call("service/status")).toEqual({ ok: true });
  session.close();
}

/**
 * Serve options whose handshake deadline is virtual: it fires only when the test fires it, so a
 * handshake a test completes (stillServes) or a hostile line it sends is never overtaken by the
 * deadline on a loaded machine. The one test of the deadline in real time sets its own.
 */
function hostile(limits: Partial<ServerLimits> = {}): {
  clock: TestClock;
  options: Partial<ServeOptions>;
} {
  const clock = testClock({ virtual: ["handshake"] });
  return {
    clock,
    options: { handlers: { "service/status": () => ({ ok: true }) }, limits, timers: clock.timers },
  };
}

/**
 * Sends `bytes` after the challenge, then ends the stream, and returns everything received until
 * the service closes. The end makes the service read every byte and then close, whether or not
 * the bytes hold a whole line, with no deadline involved.
 */
async function afterChallenge(started: Started, bytes: Buffer | string): Promise<string> {
  const raw = await rawChallenge(started.path);
  raw.socket.end(bytes);
  return (await raw.received).toString("utf8").replace(`${raw.challengeLine}\n`, "<challenge>");
}

describe("[A2.3.6.local.bounds] hostile and broken peers", () => {
  test(
    "garbage, oversize, pipelined and invalid UTF-8 hellos get nothing but the challenge",
    SLOW,
    async () => {
      const started = await startServer(root, hostile().options);
      try {
        const hello = (raw: RawSession) => makeHello(raw, started.key).line;
        const cases: [string, (raw: RawSession) => Buffer | string][] = [
          ["bad_hello", () => "hello world\n"],
          ["bad_hello", () => "\n"],
          ["bad_hello", () => '{"jsonrpc":"2.0","id":0,"method":"tasks/hello","params":{}}\n'],
          ["too_large", () => randomBytes(4_000).toString("base64")],
          ["too_large", () => Buffer.alloc(2_000, 0x7b)],
          ["invalid_utf8", () => Buffer.from([0xc3, 0x28, 0x0a])],
          ["pipelined", (raw) => `${hello(raw)}{"jsonrpc":"2.0"`],
          ["pipelined", (raw) => `${hello(raw)}${hello(raw)}`],
          [
            "bad_hello",
            (raw) => hello(raw).replace('"params":{', '"params":{"context":{"cwd":"/x"},'),
          ],
        ];
        for (const [reason, make] of cases) {
          const raw = await rawChallenge(started.path);
          raw.socket.write(make(raw));
          const text = (await raw.received).toString("utf8");
          expect(text, reason).toBe(`${raw.challengeLine}\n`);
          expect(started.events.at(-1), reason).toEqual({
            ev: "local.handshake_failed",
            stage: "hello",
            reason,
          });
        }
        await stillServes(started);
      } finally {
        await started.server.close();
      }
    },
  );

  test("random bytes never crash the service", SLOW, async () => {
    const started = await startServer(root, hostile().options);
    try {
      for (let i = 0; i < 40; i += 1) {
        const text = await afterChallenge(started, randomBytes(1 + ((i * 37) % 3_000)));
        expect(text).toBe("<challenge>");
      }
      await stillServes(started);
      await until(() => started.server.connectionCount === 0, DEADLINE_WAIT);
    } finally {
      await started.server.close();
    }
  });

  test("an oversize or broken bind gets nothing after the proof", SLOW, async () => {
    const started = await startServer(root, hostile({ bindMaxBytes: 4_096 }).options);
    try {
      for (const [reason, bind] of [
        ["too_large", "x".repeat(5_000)],
        ["bad_bind", "{}\n"],
        ["bad_bind", "not json\n"],
        ["invalid_utf8", Buffer.from([0xff, 0x0a])],
      ] as const) {
        const raw = await rawChallenge(started.path);
        raw.socket.write(makeHello(raw, started.key).line);
        const [proof = ""] = await firstLines(raw.socket, 1);
        raw.socket.write(bind);
        const text = (await raw.received).toString("utf8");
        expect(text, reason).toBe(`${raw.challengeLine}\n${proof}\n`);
        expect(started.events.at(-1), reason).toEqual({
          ev: "local.handshake_failed",
          stage: "bind",
          reason,
        });
      }
      await stillServes(started);
    } finally {
      await started.server.close();
    }
  });

  test(
    "a peer that stalls at any stage is closed by its handshake deadline, and only by it",
    SLOW,
    async () => {
      const { clock, options } = hostile();
      const started = await startServer(root, options);
      try {
        // Silent after connecting.
        const silent = await rawConnect(started.path);
        // Half a hello.
        const half = await rawChallenge(started.path);
        half.socket.write(makeHello(half, started.key).line.slice(0, 40));
        // A good hello and its proof, then no bind.
        const noBind = await rawChallenge(started.path);
        const proof = firstLines(noBind.socket, 1);
        noBind.socket.write(makeHello(noBind, started.key).line);
        await proof;
        // Each connection holds its own deadline, and nothing else closes it.
        await until(() => clock.live({ kind: "handshake" }).length === 3, DEADLINE_WAIT);
        expect(clock.live({ kind: "handshake" }).map((t) => t.conn)).toEqual([1, 2, 3]);
        expect(started.server.connectionCount).toBe(3);
        for (const deadline of clock.live({ kind: "handshake" })) clock.fire(deadline);
        await Promise.all([silent.received, half.received, noBind.received]);
        expect((await half.received).toString("utf8")).toBe(`${half.challengeLine}\n`);
        await until(() => started.server.connectionCount === 0, DEADLINE_WAIT);
        const timeouts = started.events.filter((e) => "reason" in e && e.reason === "timeout");
        expect(timeouts).toEqual([
          { ev: "local.handshake_failed", stage: "hello", reason: "timeout" },
          { ev: "local.handshake_failed", stage: "hello", reason: "timeout" },
          { ev: "local.handshake_failed", stage: "bind", reason: "timeout" },
        ]);
        await stillServes(started);
      } finally {
        await started.server.close();
      }
    },
  );

  test(
    "a peer that stalls at any stage is closed at the handshake deadline in real time",
    SLOW,
    async () => {
      const DEADLINE = 400;
      const clock = testClock();
      const started = await startServer(root, {
        limits: { handshakeTimeoutMs: DEADLINE },
        timers: clock.timers,
      });
      try {
        // Each connection's time is measured from before it was made, so the server's deadline
        // for it can only start later: the bound below holds however loaded the machine is.
        const before: number[] = [];
        before.push(performance.now());
        const silent = await rawConnect(started.path);
        before.push(performance.now());
        const half = await rawChallenge(started.path);
        half.socket.write(makeHello(half, started.key).line.slice(0, 40));
        before.push(performance.now());
        const noBind = await rawChallenge(started.path);
        noBind.socket.write(makeHello(noBind, started.key).line);
        const closed = await Promise.all([silent.closedAt, half.closedAt, noBind.closedAt]);
        for (const [index, at] of closed.entries()) {
          // Node's timers count whole milliseconds: one may fire up to 1 ms early.
          expect(at - (before[index] ?? 0)).toBeGreaterThanOrEqual(DEADLINE - 2);
        }
        expect((await half.received).toString("utf8")).toBe(`${half.challengeLine}\n`);
        await until(() => started.server.connectionCount === 0, DEADLINE_WAIT);
        expect(clock.find({ kind: "handshake" }).map((t) => t.state)).toEqual([
          "fired",
          "fired",
          "fired",
        ]);
        const reasons = started.events.map((e) => ("reason" in e ? e.reason : e.ev));
        expect(reasons.filter((r) => r === "timeout")).toHaveLength(3);
      } finally {
        await started.server.close();
      }
    },
  );

  test("a close at every byte of the hello and of the bind leaves no socket", SLOW, async () => {
    const started = await startServer(root, hostile().options);
    /** Sends `text`, closes once it is flushed, and waits until the service has few sockets. */
    const sendAndClose = async (raw: RawSession, text: string) => {
      if (text === "") raw.socket.destroy();
      else raw.socket.write(text, () => raw.socket.destroy());
      await raw.received;
      await until(() => started.server.connectionCount < 8, DEADLINE_WAIT);
    };
    try {
      const probe = await rawChallenge(started.path);
      const helloLength = Buffer.byteLength(makeHello(probe, started.key).line);
      probe.socket.destroy();
      for (let cut = 0; cut <= helloLength; cut += 1) {
        const raw = await rawChallenge(started.path);
        await sendAndClose(raw, makeHello(raw, started.key).line.slice(0, cut));
      }
      const body = { protocol: 1, mode: "rpc" as const, client: clientInfo(), context: { a: 1 } };
      let bindLength = Infinity;
      for (let cut = 0; cut <= bindLength; cut += 1) {
        const raw = await rawChallenge(started.path);
        const hello = makeHello(raw, started.key);
        raw.socket.write(hello.line);
        await firstLines(raw.socket, 1);
        const bind = makeBind(raw, started.key, hello.ids, body);
        bindLength = Buffer.byteLength(bind);
        await sendAndClose(raw, bind.slice(0, cut));
      }
      await until(() => started.server.connectionCount === 0, DEADLINE_WAIT);
      await stillServes(started);
      await until(() => started.server.connectionCount === 0, DEADLINE_WAIT);
    } finally {
      await started.server.close();
    }
  });

  test(
    "the cap on unauthenticated connections holds, and freed places are reused",
    SLOW,
    async () => {
      const started = await startServer(root, hostile({ maxPending: 3 }).options);
      try {
        const holders = [
          await rawChallenge(started.path),
          await rawChallenge(started.path),
          await rawChallenge(started.path),
        ];
        const extra = await rawConnect(started.path);
        expect((await extra.received).length).toBe(0);
        expect(started.events.at(-1)).toEqual({
          ev: "local.handshake_failed",
          stage: "accept",
          reason: "capacity",
        });
        for (const holder of holders) holder.socket.destroy();
        await until(() => started.server.connectionCount === 0, DEADLINE_WAIT);
        await stillServes(started);
      } finally {
        await started.server.close();
      }
    },
  );

  test("the cap on all connections holds", SLOW, async () => {
    const started = await startServer(root, hostile({ maxConnections: 2 }).options);
    try {
      const sessions = [
        await openRpc({ path: started.path, key: started.key, client: clientInfo(), context: {} }),
        await openRpc({ path: started.path, key: started.key, client: clientInfo(), context: {} }),
      ];
      const extra = await rawConnect(started.path);
      expect((await extra.received).length).toBe(0);
      for (const session of sessions) session.close();
      await until(() => started.server.connectionCount === 0, DEADLINE_WAIT);
      await stillServes(started);
    } finally {
      await started.server.close();
    }
  });

  test("closing the server closes every connection, authenticated or not", SLOW, async () => {
    const started = await startServer(root, hostile().options);
    const pending = await rawChallenge(started.path);
    const session = await openRpc({
      path: started.path,
      key: started.key,
      client: clientInfo(),
      context: {},
    });
    const closed = new Promise<void>((resolve) => {
      session.onClose = resolve;
    });
    await started.server.close();
    await pending.received;
    await closed;
    expect(started.server.connectionCount).toBe(0);
    if (process.platform !== "win32") expect(existsSync(started.path)).toBe(false);
  });

  test("a bind whose hook resolves after the server closed initialises nothing", SLOW, async () => {
    let release: () => void = () => undefined;
    let hookCalled: () => void = () => undefined;
    const inHook = new Promise<void>((resolve) => {
      hookCalled = resolve;
    });
    let mcpCalls = 0;
    const started = await startServer(root, {
      ...hostile().options,
      bind: async () => {
        hookCalled();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {};
      },
      mcp: () => {
        mcpCalls += 1;
      },
    });
    const opening = openLines({
      path: started.path,
      key: started.key,
      client: clientInfo("bridge"),
      context: {},
    }).catch((e: unknown) => e);
    await inHook;
    const closing = started.server.close();
    release();
    await closing;
    expect(await opening).toMatchObject({ reason: "connection_lost" });
    expect(mcpCalls).toBe(0);
    expect(started.events.some((e) => e.ev === "local.bound")).toBe(false);
  });

  test("a name in use is refused, and a closed name can be served again", SLOW, async () => {
    const started = await startServer(root, hostile().options);
    try {
      const second = await serve({
        path: started.path,
        key: started.key,
        instance: "second",
        service: { version: "0", build: "0" },
      }).catch((e: unknown) => e);
      expect(second).toBeInstanceOf(Error);
      expect((second as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
      await stillServes(started);
    } finally {
      await started.server.close();
    }
    await sleep(50);
    const again = await serve({
      path: started.path,
      key: started.key,
      instance: "third",
      service: { version: "0", build: "0" },
    });
    await again.close();
  });

  test("an endpoint path the OS cannot hold is refused before listening", async () => {
    const long = process.platform === "win32" ? "C:\\not-a-pipe" : `/tmp/${"x".repeat(120)}.sock`;
    await expect(
      serve({
        path: long,
        key: randomBytes(32),
        instance: "i",
        service: { version: "0", build: "0" },
      }),
    ).rejects.toThrow(TypeError);
  });
});
