// rpc mode (A2 3.6.4) and the line limit after the handshake (A2 3.6.2), plus mcp mode's line
// passing. A3's errors travel in a JSON-RPC error's `data`. Protocol failures are JSON-RPC errors.
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
  MAX_IN_FLIGHT,
  OUTPUT_STALL_MS,
  RPC_ERROR,
  RpcError,
  connect,
  openLines,
  openRpc,
  type Connected,
  type JsonObject,
} from "@ttasks/bridge/protocol";
import { clientInfo, endpointRoot, firstLines, sleep, until } from "@ttasks/bridge/test/endpoint";
import { AppError } from "@ttasks/contracts";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { testClock } from "../../test/clock.ts";
import { startServer } from "../../test/local.ts";
import type { McpChannel, RpcContext, RpcHandlers } from "./index.ts";

const SLOW = { timeout: 60_000 };

let root: ReturnType<typeof endpointRoot>;
beforeAll(() => {
  root = endpointRoot();
});
afterAll(() => {
  root.remove();
});

async function rawRpc(path: string, key: Buffer): Promise<Connected> {
  return connect({ path, key, mode: "rpc", client: clientInfo(), context: {} });
}

/**
 * Reads a socket slowly but steadily: after each `step` bytes it stops reading for `gapMs`.
 * `stop()` ends the throttle and leaves the socket flowing.
 */
function readThrottled(
  socket: net.Socket,
  step: number,
  gapMs: number,
): { lines(): number; text(): string; stop(): void } {
  const chunks: Buffer[] = [];
  let newlines = 0;
  let window = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) newlines += 1;
    window += chunk.length;
    if (window < step || stopped) return;
    window = 0;
    socket.pause();
    timer = setTimeout(() => {
      if (!stopped) socket.resume();
    }, gapMs);
  };
  socket.on("data", onData);
  socket.resume();
  return {
    lines: () => newlines,
    text: () => Buffer.concat(chunks).toString("utf8"),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.resume();
    },
  };
}

/**
 * Reads a paused socket only when asked: `take(n)` lets `n` more bytes in, or the rest once
 * `lines` lines have come, and pauses again.
 */
function stepReader(
  socket: net.Socket,
  lines: number,
): { take(bytes: number): Promise<void>; lines(): number; text(): string } {
  const chunks: Buffer[] = [];
  let newlines = 0;
  let wanted = 0;
  let done: (() => void) | undefined;
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) newlines += 1;
    wanted -= chunk.length;
    if (wanted > 0 && newlines < lines) return;
    socket.pause();
    done?.();
    done = undefined;
  });
  return {
    take: (bytes) =>
      new Promise((resolve) => {
        if (newlines >= lines) {
          resolve();
          return;
        }
        wanted = bytes;
        done = resolve;
        socket.resume();
      }),
    lines: () => newlines,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

const STALL_EXIT_ENTRY = fileURLToPath(new URL("../../test/stall-exit-entry.ts", import.meta.url));

/** Runs a test script in a child Node process and waits for it to exit, or kills it after `ms`. */
async function runChild(
  script: string,
  args: readonly string[],
  ms: number,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, ms);
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);
  return { code, signal, timedOut, stdout, stderr };
}

/** Sends raw lines on an authenticated connection and reads `count` replies. */
async function exchange(connected: Connected, text: string, count: number): Promise<unknown[]> {
  const replies = firstLines(connected.socket, count);
  connected.socket.write(text);
  return (await replies).map((line) => JSON.parse(line) as unknown);
}

describe("[A2.3.6.local.rpc] rpc mode", () => {
  test(
    "a close with a grace answers the requests in flight, then ends each connection; past the grace it destroys",
    SLOW,
    async () => {
      let release: () => void = () => undefined;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Requests that reached their handler: a close starts only once the request is in flight.
      const entered: string[] = [];
      const handlers: RpcHandlers = {
        "op/call": async () => {
          entered.push("op/call");
          await slow;
          return { done: true };
        },
        "op/list": () => {
          entered.push("op/list");
          return new Promise(() => undefined);
        },
      };
      // Real timers, recorded: each grace either ends early (cleared) or runs out (fired).
      const clock = testClock();
      const started = await startServer(root, { handlers, timers: clock.timers });
      const open = () =>
        openRpc({ path: started.path, key: started.key, client: clientInfo(), context: {} });
      const answered = await open();
      const idle = await open();
      const ends = (session: Awaited<ReturnType<typeof open>>) =>
        new Promise<void>((resolve) => {
          session.onClose = resolve;
        });
      const answeredEnds = ends(answered);
      const idleEnds = ends(idle);
      const reply = answered.call("op/call", {});
      await until(() => entered.includes("op/call"));
      // A grace far longer than this test may take: ending early is what ends it.
      const closing = started.server.close({ graceMs: 60_000 });
      // An idle connection ends at once; the busy one waits for its answer.
      await idleEnds;
      await sleep(100);
      expect(answered.closed).toBe(false);
      // No new connection is taken while the server drains. (On Windows a connect to a pipe name
      // whose instances are all busy waits for one, so there it would only time out.)
      if (process.platform !== "win32") {
        await expect(open()).rejects.toMatchObject({ reason: "not_running" });
      }
      release();
      expect(await reply).toEqual({ done: true });
      await answeredEnds;
      await closing;
      expect(clock.find({ kind: "grace" }).map((t) => t.state)).toEqual(["cleared"]);

      // While a connection finishes, a new request is refused, and `$/cancel` for one in flight
      // still arrives: the handler is aborted, and the connection ends before the grace.
      let aborted = false;
      let inFlight = false;
      const cancellable: RpcHandlers = {
        "op/call": (_params, context) =>
          new Promise((_resolve, reject) => {
            inFlight = true;
            context.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      };
      const drainClock = testClock();
      const draining = await startServer(root, {
        handlers: cancellable,
        timers: drainClock.timers,
      });
      const busy = await openRpc({
        path: draining.path,
        key: draining.key,
        client: clientInfo(),
        context: {},
      });
      const busyEnds = ends(busy);
      const stop = new AbortController();
      const cancelled = busy.call("op/call", {}, { signal: stop.signal }).catch((e: unknown) => e);
      await until(() => inFlight);
      // close() tells every connection to finish before it returns.
      const closingDraining = draining.server.close({ graceMs: 60_000 });
      expect(await busy.call("op/call", {}).catch((e: unknown) => e)).toMatchObject({
        code: RPC_ERROR.app,
        data: { code: "service_unavailable" },
      });
      stop.abort();
      await cancelled;
      await busyEnds;
      await closingDraining;
      expect(aborted).toBe(true);
      expect(drainClock.find({ kind: "grace" }).map((t) => t.state)).toEqual(["cleared"]);

      // A request that never ends is cut off at the grace.
      entered.length = 0;
      const againClock = testClock();
      const again = await startServer(root, { handlers, timers: againClock.timers });
      const stuck = await openRpc({
        path: again.path,
        key: again.key,
        client: clientInfo(),
        context: {},
      });
      const never = stuck.call("op/list", {}).catch((error: unknown) => error);
      await until(() => entered.includes("op/list"));
      await again.server.close({ graceMs: 300 });
      // The grace ran out: its real timer of 300 ms fired, and only then was the request cut off.
      // (Its own timer is the evidence. A wall-clock bound measured here could be off by however
      // long the event loop's current turn had run when the timer started.)
      expect(againClock.find({ kind: "grace" })).toMatchObject([{ ms: 300, state: "fired" }]);
      expect(await never).toMatchObject({ reason: "connection_lost" });
    },
  );

  test("results, A3 errors and internal errors", SLOW, async () => {
    const handlers: RpcHandlers = {
      "op/list": (params) => ({ ops: ["task.add"], echo: params }),
      "op/call": () => {
        throw new AppError({
          code: "not_found",
          message: "No such task.",
          hint: "Check the reference.",
        });
      },
      "service/status": () => {
        throw new Error("SENTINEL-SECRET in a stack");
      },
      "feed/subscribe": async () => {
        await Promise.resolve();
        throw new RpcError(RPC_ERROR.invalidParams, "cursor is required");
      },
    };
    const started = await startServer(root, { handlers });
    try {
      const session = await openRpc({
        path: started.path,
        key: started.key,
        client: clientInfo(),
        context: {},
      });
      expect(await session.call("op/list", { a: 1 })).toEqual({
        ops: ["task.add"],
        echo: { a: 1 },
      });

      const notFound = await session.call("op/call", {}).catch((e: unknown) => e);
      expect(notFound).toBeInstanceOf(RpcError);
      expect(notFound).toMatchObject({
        code: RPC_ERROR.app,
        message: "No such task.",
        data: {
          code: "not_found",
          message: "No such task.",
          hint: "Check the reference.",
          data: {},
        },
      });

      const internal = await session.call("service/status").catch((e: unknown) => e);
      expect(internal).toMatchObject({ code: RPC_ERROR.internal, message: "Internal error" });
      expect(JSON.stringify(internal)).not.toContain("SENTINEL");
      expect(JSON.stringify(started.events)).not.toContain("SENTINEL");
      expect(started.events).toContainEqual({
        ev: "local.handler_failed",
        conn: 1,
        method: "service/status",
      });

      const invalid = await session.call("feed/subscribe", {}).catch((e: unknown) => e);
      expect(invalid).toMatchObject({
        code: RPC_ERROR.invalidParams,
        message: "cursor is required",
      });

      const unknown = await session.call("no/such").catch((e: unknown) => e);
      expect(unknown).toMatchObject({ code: RPC_ERROR.methodNotFound });
      // A method of A2's table without a handler in this service is not found either.
      const missing = await session.call("ui/mint_code").catch((e: unknown) => e);
      expect(missing).toMatchObject({ code: RPC_ERROR.methodNotFound });
      session.close();
    } finally {
      await started.server.close();
    }
  });

  test("JSON-RPC protocol errors keep the connection open", SLOW, async () => {
    const started = await startServer(root, { handlers: { "op/list": () => "ok" } });
    try {
      const connected = await rawRpc(started.path, started.key);
      const replies = await exchange(
        connected,
        [
          "not json",
          "[1,2]",
          '{"jsonrpc":"1.0","id":3,"method":"op/list"}',
          '{"jsonrpc":"2.0","id":{"x":1},"method":"op/list"}',
          '{"jsonrpc":"2.0","id":4,"method":"op/list","params":[1]}',
          '{"jsonrpc":"2.0","id":5,"method":"op/list"}',
        ].join("\n") + "\n",
        6,
      );
      expect(replies).toEqual([
        { jsonrpc: "2.0", id: null, error: { code: RPC_ERROR.parse, message: "Parse error" } },
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_ERROR.invalidRequest, message: "Invalid request" },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          error: { code: RPC_ERROR.invalidRequest, message: "Invalid request" },
        },
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_ERROR.invalidRequest, message: "Invalid request" },
        },
        {
          jsonrpc: "2.0",
          id: 4,
          error: { code: RPC_ERROR.invalidParams, message: "Params must be an object" },
        },
        { jsonrpc: "2.0", id: 5, result: "ok" },
      ]);
      const invalidUtf8 = firstLines(connected.socket, 1);
      connected.socket.write(Buffer.from([0xc3, 0x28, 0x0a]));
      expect(JSON.parse((await invalidUtf8)[0] ?? "")).toMatchObject({
        error: { code: RPC_ERROR.parse },
      });
      connected.socket.destroy();
    } finally {
      await started.server.close();
    }
  });

  test(
    "a request whose method is not a string, or whose id is null, is invalid",
    SLOW,
    async () => {
      const started = await startServer(root, { handlers: { "op/list": () => "ok" } });
      try {
        const connected = await rawRpc(started.path, started.key);
        const replies = await exchange(
          connected,
          [
            '{"jsonrpc":"2.0","id":7,"method":123}',
            '{"jsonrpc":"2.0","id":8,"method":null}',
            '{"jsonrpc":"2.0","id":null,"method":"op/list"}',
            // A response from the client is not answered: the service sends rpc clients no requests.
            '{"jsonrpc":"2.0","id":9,"result":{}}',
            '{"jsonrpc":"2.0","id":9,"error":{"code":1,"message":"x"}}',
            // Neither a request nor a response.
            '{"jsonrpc":"2.0","id":11,"params":{}}',
            '{"jsonrpc":"2.0","id":12,"result":1,"error":{"code":1,"message":"x"}}',
            '{"jsonrpc":"2.0","id":10,"method":"op/list"}',
          ].join("\n") + "\n",
          6,
        );
        const invalid = { code: RPC_ERROR.invalidRequest, message: "Invalid request" };
        expect(replies).toEqual([
          { jsonrpc: "2.0", id: 7, error: invalid },
          { jsonrpc: "2.0", id: 8, error: invalid },
          { jsonrpc: "2.0", id: null, error: invalid },
          { jsonrpc: "2.0", id: 11, error: invalid },
          { jsonrpc: "2.0", id: 12, error: invalid },
          { jsonrpc: "2.0", id: 10, result: "ok" },
        ]);
        connected.socket.destroy();
      } finally {
        await started.server.close();
      }
    },
  );

  test("notifications from the service and $/cancel from the client", SLOW, async () => {
    let sawAbort = false;
    const started = await startServer(root, {
      handlers: {
        "feed/subscribe": (_params, ctx) => {
          ctx.notify("feed/event", { n: 1 });
          ctx.notify("feed/event", { n: 2 });
          return { subscribed: true };
        },
        "op/call": (_params, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => {
              sawAbort = true;
              reject(new Error("aborted"));
            });
          }),
      },
    });
    try {
      const session = await openRpc({
        path: started.path,
        key: started.key,
        client: clientInfo(),
        context: {},
      });
      const seen: unknown[] = [];
      session.onNotification = (method, params) => seen.push({ method, params });
      expect(await session.call("feed/subscribe", { space: "sp_x", cursor: null })).toEqual({
        subscribed: true,
      });
      expect(seen).toEqual([
        { method: "feed/event", params: { n: 1 } },
        { method: "feed/event", params: { n: 2 } },
      ]);
      const controller = new AbortController();
      const call = session.call("op/call", {}, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await expect(call).rejects.toThrow(/abort/i);
      await until(() => sawAbort);
      // The connection keeps working after a cancel.
      expect(await session.call("feed/subscribe", {})).toEqual({ subscribed: true });
      session.close();
    } finally {
      await started.server.close();
    }
  });

  test("a cancelled handler's reply is a cancellation error", SLOW, async () => {
    const started = await startServer(root, {
      handlers: {
        "op/call": (_params, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => {
              reject(new Error("stopped"));
            });
          }),
      },
    });
    try {
      const connected = await rawRpc(started.path, started.key);
      const reply = firstLines(connected.socket, 1);
      connected.socket.write('{"jsonrpc":"2.0","id":"a","method":"op/call","params":{}}\n');
      connected.socket.write('{"jsonrpc":"2.0","method":"$/cancel","params":{"id":"a"}}\n');
      expect(JSON.parse((await reply)[0] ?? "")).toEqual({
        jsonrpc: "2.0",
        id: "a",
        error: { code: RPC_ERROR.cancelled, message: "Request cancelled" },
      });
      connected.socket.destroy();
    } finally {
      await started.server.close();
    }
  });

  test(
    "at the in-flight limit a request is refused at once and $/cancel still arrives",
    SLOW,
    async () => {
      const aborted: string[] = [];
      const started = await startServer(root, {
        limits: { maxInFlight: 2 },
        handlers: {
          // Each call runs until it is cancelled, like a long-lived subscription.
          "op/call": (params, ctx) =>
            new Promise((_resolve, reject) => {
              ctx.signal.addEventListener("abort", () => {
                aborted.push(String(params["n"]));
                reject(new Error("stopped"));
              });
            }),
        },
      });
      try {
        const connected = await rawRpc(started.path, started.key);
        const replies = firstLines(connected.socket, 3);
        connected.socket.write(
          [
            '{"jsonrpc":"2.0","id":1,"method":"op/call","params":{"n":1}}',
            '{"jsonrpc":"2.0","id":2,"method":"op/call","params":{"n":2}}',
            '{"jsonrpc":"2.0","id":3,"method":"op/call","params":{"n":3}}',
            '{"jsonrpc":"2.0","method":"$/cancel","params":{"id":1}}',
            '{"jsonrpc":"2.0","method":"$/cancel","params":{"id":2}}',
          ].join("\n") + "\n",
        );
        const parsed = (await replies).map((line) => JSON.parse(line) as JsonObject);
        expect(parsed[0]).toMatchObject({
          id: 3,
          error: {
            code: RPC_ERROR.app,
            data: { code: "too_large", data: { reason: "in_flight", max: 2 } },
          },
        });
        expect(
          parsed
            .slice(1)
            .map((reply) => reply["id"])
            .sort(),
        ).toEqual([1, 2]);
        for (const reply of parsed.slice(1)) {
          expect(reply["error"]).toEqual({
            code: RPC_ERROR.cancelled,
            message: "Request cancelled",
          });
        }
        expect(aborted.sort()).toEqual(["1", "2"]);
        connected.socket.destroy();
      } finally {
        await started.server.close();
      }
    },
  );

  test(
    "the client keeps at most the in-flight limit on the wire and queues the rest",
    SLOW,
    async () => {
      let running = 0;
      let peak = 0;
      const gates: (() => void)[] = [];
      const started = await startServer(root, {
        handlers: {
          "op/call": async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise<void>((resolve) => gates.push(resolve));
            running -= 1;
            return "done";
          },
        },
      });
      try {
        const session = await openRpc({
          path: started.path,
          key: started.key,
          client: clientInfo(),
          context: {},
        });
        const calls = Array.from({ length: MAX_IN_FLIGHT + 36 }, () => session.call("op/call"));
        // A queued call that is cancelled never reaches the service.
        const controller = new AbortController();
        const cancelled = session.call("op/call", {}, { signal: controller.signal });
        await until(() => gates.length === MAX_IN_FLIGHT);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(gates.length).toBe(MAX_IN_FLIGHT);
        controller.abort();
        await expect(cancelled).rejects.toThrow(/abort/i);
        for (let released = 0; released < calls.length; released += 1) {
          await until(() => gates.length > 0);
          gates.shift()?.();
        }
        expect(await Promise.all(calls)).toEqual(calls.map(() => "done"));
        expect(peak).toBe(MAX_IN_FLIGHT);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(gates.length).toBe(0);
        expect(started.events.some((e) => e.ev === "local.handler_failed")).toBe(false);
        session.close();
      } finally {
        await started.server.close();
      }
    },
  );

  test(
    "under backpressure every line reaches the wire once, in the order the service produced it",
    SLOW,
    async () => {
      // Eight replies of 900 KiB are four times the bound on offered output: replies are not
      // offered lines, so none of this makes the client a slow reader. Each handler sends two
      // notifications before its reply, and the handlers finish in an order unlike the requests'.
      // The client reads nothing until all 7 MiB are produced, far more than the OS buffers
      // (well under 1 MiB), so the later notifications certainly find the output backed up.
      const ORDER = [5, 2, 7, 0, 3, 6, 1, 4];
      const reply = (n: number) => `${String(n)}:${String.fromCharCode(97 + n).repeat(900 * 1024)}`;
      const note = (n: number, k: number) => ({
        n,
        k,
        pad: `${String(n)}.${String(k)}`.repeat(64),
      });
      const gates = new Map<number, () => void>();
      const offered: boolean[] = [];
      const started = await startServer(root, {
        limits: { maxLineBytes: 1024 * 1024, maxQueuedBytes: 2 * 1024 * 1024 },
        handlers: {
          "op/call": async (params, ctx) => {
            const n = Number(params["n"]);
            await new Promise<void>((resolve) => gates.set(n, resolve));
            offered.push(ctx.notify("feed/event", note(n, 0)));
            offered.push(ctx.notify("feed/event", note(n, 1)));
            return reply(n);
          },
        },
      });
      try {
        const connected = await rawRpc(started.path, started.key);
        const socket = connected.socket;
        // The client reads nothing until every line is produced, then reads in small steps.
        socket.pause();
        socket.write(
          ORDER.map((_, n) =>
            JSON.stringify({ jsonrpc: "2.0", id: n, method: "op/call", params: { n } }),
          ).join("\n") + "\n",
        );
        await until(() => gates.size === ORDER.length);
        for (const n of ORDER) {
          gates.get(n)?.();
          // The handler's lines and its reply are written before the next handler runs.
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(offered).toHaveLength(2 * ORDER.length);
        expect(offered).toContain(false); // the output was backed up while it was produced

        const expected: unknown[] = ORDER.flatMap((n) => [
          { jsonrpc: "2.0", method: "feed/event", params: note(n, 0) },
          { jsonrpc: "2.0", method: "feed/event", params: note(n, 1) },
          { jsonrpc: "2.0", id: n, result: reply(n) },
        ]);
        const wire = readThrottled(socket, 256 * 1024, 20);
        await until(() => wire.lines() >= expected.length, 30_000);
        // Nothing more arrives: no line is sent twice.
        await sleep(200);
        wire.stop();
        const lines = wire.text().split("\n");
        expect(lines.pop()).toBe("");
        expect(lines).toHaveLength(expected.length);
        const parsed = lines.map((line) => JSON.parse(line) as unknown);
        for (const [index, value] of parsed.entries()) expect(value).toEqual(expected[index]);
        expect(started.events.some((e) => e.ev === "local.slow_reader")).toBe(false);

        // The connection still serves requests.
        const next = firstLines(socket, 1);
        socket.write('{"jsonrpc":"2.0","id":"after","method":"op/call","params":{"n":9}}\n');
        await until(() => gates.has(9));
        gates.get(9)?.();
        const last = (await next).map((line) => JSON.parse(line) as JsonObject);
        expect(last[0]).toMatchObject({ method: "feed/event", params: { n: 9, k: 0 } });
        socket.destroy();
      } finally {
        await started.server.close();
      }
    },
  );

  test("a duplicate id in flight is refused", SLOW, async () => {
    let release: () => void = () => undefined;
    const started = await startServer(root, {
      handlers: {
        "op/call": () =>
          new Promise<string>((resolve) => {
            release = () => {
              resolve("first");
            };
          }),
      },
    });
    try {
      const connected = await rawRpc(started.path, started.key);
      const replies = firstLines(connected.socket, 2);
      connected.socket.write('{"jsonrpc":"2.0","id":9,"method":"op/call"}\n');
      connected.socket.write('{"jsonrpc":"2.0","id":9,"method":"op/call"}\n');
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const parsed = (await replies).map((line) => JSON.parse(line) as unknown);
      expect(parsed).toEqual([
        {
          jsonrpc: "2.0",
          id: 9,
          error: { code: RPC_ERROR.invalidRequest, message: "A request with this id is in flight" },
        },
        { jsonrpc: "2.0", id: 9, result: "first" },
      ]);
      connected.socket.destroy();
    } finally {
      await started.server.close();
    }
  });

  test("a line over the limit gets frame_too_large and the connection closes", SLOW, async () => {
    const started = await startServer(root, {
      limits: { maxLineBytes: 4_096 },
      handlers: { "op/list": () => "x".repeat(10_000) },
    });
    try {
      const session = await openRpc({
        path: started.path,
        key: started.key,
        client: clientInfo(),
        context: {},
      });
      // A result over the limit is an error, not a broken frame.
      expect(await session.call("op/list").catch((e: unknown) => e)).toMatchObject({
        code: RPC_ERROR.app,
        data: { code: "too_large" },
      });
      session.close();

      const connected = await rawRpc(started.path, started.key);
      const reply = firstLines(connected.socket, 1);
      const closed = new Promise((resolve) => connected.socket.once("close", resolve));
      connected.socket.write(`${"y".repeat(5_000)}\n`);
      expect(JSON.parse((await reply)[0] ?? "")).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_ERROR.invalidRequest, message: "frame_too_large" },
      });
      await closed;
      expect(started.events).toContainEqual({ ev: "local.frame_too_large", conn: 2 });
    } finally {
      await started.server.close();
    }
  });
});

describe("[A2.3.6.local.rpc] the output deadline", () => {
  const MiB = 1024 * 1024;
  const big = (n: number, size = 3 * MiB) =>
    `${String(n)}:${String.fromCharCode(97 + n).repeat(size)}`;
  const call = (id: number | string, method: string, params: JsonObject = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id, method, params });
  /**
   * A reply that cannot fit in what the OS buffers for a peer that reads nothing, so it must wait:
   * a named pipe on Windows and a Unix socket on Linux both take well under 1 MiB (measured), and
   * a paused client's stream holds 64 KiB more. Whether a smaller reply waits depends on the OS,
   * and a test must not assume it.
   */
  const STUCK = 16 * MiB;
  const stuckLimits = { maxLineBytes: 2 * STUCK };

  test(
    "a reader that stops with replies waiting is closed as slow_reader when its deadline fires, not before, and its handlers are aborted",
    SLOW,
    async () => {
      const clock = testClock({ virtual: ["output"] });
      const aborted: string[] = [];
      let hold: RpcContext | undefined;
      let produced = false;
      const started = await startServer(root, {
        timers: clock.timers,
        limits: stuckLimits,
        handlers: {
          "op/call": () => {
            produced = true;
            return big(1, STUCK);
          },
          // Runs until the connection ends.
          "op/list": (_params, ctx) =>
            new Promise((_resolve, reject) => {
              hold = ctx;
              ctx.signal.addEventListener("abort", () => {
                aborted.push("op/list");
                reject(new Error("stopped"));
              });
            }),
        },
      });
      try {
        const connected = await rawRpc(started.path, started.key);
        connected.socket.pause();
        connected.socket.write([call("hold", "op/list"), call(1, "op/call")].join("\n") + "\n");
        // The reply waits for a reader that reads nothing: the connection's output deadline runs.
        // (The reply is written in the same turn as its handler returns, and it cannot all fit,
        // so once it is produced a live deadline is the one that guards it.)
        await until(
          () => produced && !!hold && clock.live({ kind: "output", conn: 1 }).length === 1,
          20_000,
        );
        const [deadline] = clock.live({ kind: "output", conn: 1 });
        if (deadline === undefined || hold === undefined) throw new Error("no deadline");
        expect(deadline.ms).toBe(OUTPUT_STALL_MS);

        // New output does not start the deadline again: only the socket taking bytes does.
        const refreshes = deadline.refreshes;
        expect(hold.notify("feed/event", { n: 1 })).toBe(false);
        expect(deadline.refreshes).toBe(refreshes);

        // Up to the deadline nothing happens; at it the connection closes as a slow reader.
        clock.advance(deadline.due - clock.now - 1);
        expect(deadline.state).toBe("live");
        expect(started.events.some((e) => e.ev === "local.slow_reader")).toBe(false);
        clock.advance(1);
        expect(deadline.state).toBe("fired");
        expect(started.events).toContainEqual({ ev: "local.slow_reader", conn: 1 });
        await until(() => started.server.connectionCount === 0, 20_000);
        await until(() => aborted.length > 0, 20_000);
        expect(aborted).toEqual(["op/list"]);
        expect(clock.live({ conn: 1 })).toEqual([]);
        connected.socket.destroy();
      } finally {
        await started.server.close();
      }
    },
  );

  test(
    "a reader that stops with replies waiting is closed as slow_reader at the deadline in real time, and its handlers are aborted",
    SLOW,
    async () => {
      const STALL = 500;
      const clock = testClock();
      const aborted: string[] = [];
      const started = await startServer(root, {
        timers: clock.timers,
        limits: { ...stuckLimits, outputStallMs: STALL },
        handlers: {
          // Three replies far larger than the OS buffers, none of it offered.
          "op/call": (params) => big(Number(params["n"]), STUCK),
          // Runs until the connection ends.
          "op/list": (_params, ctx) =>
            new Promise((_resolve, reject) => {
              ctx.signal.addEventListener("abort", () => {
                aborted.push("op/list");
                reject(new Error("stopped"));
              });
            }),
        },
      });
      try {
        const connected = await rawRpc(started.path, started.key);
        connected.socket.pause();
        const sent = performance.now();
        connected.socket.write(
          [
            call("hold", "op/list"),
            call(1, "op/call", { n: 1 }),
            call(2, "op/call", { n: 2 }),
            call(3, "op/call", { n: 3 }),
          ].join("\n") + "\n",
        );
        await until(() => started.events.some((e) => e.ev === "local.slow_reader"), 20_000);
        // The deadline closed it, not some other bound: its timer fired, after at least the deadline.
        expect(performance.now() - sent).toBeGreaterThanOrEqual(STALL - 5);
        expect(clock.find({ kind: "output", conn: 1 }).map((t) => t.state)).toContain("fired");
        expect(started.events).toContainEqual({ ev: "local.slow_reader", conn: 1 });
        await until(() => started.server.connectionCount === 0, 20_000);
        await until(() => aborted.length > 0, 20_000);
        expect(aborted).toEqual(["op/list"]);
        expect(clock.live({ conn: 1 })).toEqual([]);
        connected.socket.destroy();
      } finally {
        await started.server.close();
      }
    },
  );

  test(
    "the deadline starts again each time the socket takes bytes, so a reader that takes a little at a time through a burst over 16 MiB is never closed",
    SLOW,
    async () => {
      // Four replies of 5 MiB (20 MiB, more than the 16 MiB bound on offered lines). The reader
      // takes 1 MiB, then nothing while the virtual time moves on by 60 % of the deadline, again
      // and again: the burst takes many deadlines in all, no pause reaches one.
      const STALL = 1_000;
      const clock = testClock({ virtual: ["output"] });
      const gates: (() => void)[] = [];
      const started = await startServer(root, {
        timers: clock.timers,
        limits: { outputStallMs: STALL },
        handlers: {
          "op/call": async (params) => {
            await new Promise<void>((resolve) => gates.push(resolve));
            return big(Number(params["n"]), 5 * MiB);
          },
        },
      });
      try {
        const connected = await rawRpc(started.path, started.key);
        const socket = connected.socket;
        socket.pause();
        socket.write([0, 1, 2, 3].map((n) => call(n, "op/call", { n })).join("\n") + "\n");
        await until(() => gates.length === 4, 20_000);
        for (const gate of gates) gate();
        const reader = stepReader(socket, 4);
        const output = () => clock.find({ kind: "output", conn: 1 });
        /** Changes whenever the socket takes bytes while output waits: a refresh or a new deadline. */
        const progress = () => output().reduce((sum, t) => sum + 1 + t.refreshes, 0);
        await until(() => output().length > 0, 20_000);
        let steps = 0;
        while (reader.lines() < 4) {
          clock.advance((STALL * 6) / 10);
          expect(started.events.some((e) => e.ev === "local.slow_reader")).toBe(false);
          const before = progress();
          await reader.take(MiB);
          steps += 1;
          // Taking 1 MiB, more than the OS buffers, makes room the server fills: the deadline
          // starts again (or ends, once nothing waits) before the time moves on.
          await until(
            () => progress() !== before || clock.live({ kind: "output", conn: 1 }).length === 0,
            20_000,
          );
        }
        const lines = reader.text().split("\n");
        expect(lines.pop()).toBe("");
        expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual(
          [0, 1, 2, 3].map((n) => ({ jsonrpc: "2.0", id: n, result: big(n, 5 * MiB) })),
        );
        expect(clock.now).toBeGreaterThan(5 * STALL);
        expect(steps).toBeGreaterThan(10);
        // Once the socket reports the last piece taken, nothing waits and the deadline stops.
        await until(() => clock.live({ kind: "output", conn: 1 }).length === 0, 20_000);
        expect(output().some((t) => t.state === "fired")).toBe(false);
        expect(started.events.some((e) => e.ev === "local.slow_reader")).toBe(false);
        expect(started.server.connectionCount).toBe(1);
        socket.destroy();
      } finally {
        await started.server.close();
      }
    },
  );

  test(
    "a reader that reads slowly but steadily in real time through a burst over 16 MiB gets every reply",
    SLOW,
    async () => {
      // Four replies of 5 MiB (20 MiB, more than the 16 MiB bound on offered lines), read 512 KiB
      // at a time with a 100 ms pause after each: at least 39 pauses, so the burst takes longer
      // than the deadline, and no pause comes near it.
      const STALL = 3_000;
      const clock = testClock();
      const gates: (() => void)[] = [];
      const started = await startServer(root, {
        timers: clock.timers,
        limits: { outputStallMs: STALL },
        handlers: {
          "op/call": async (params) => {
            await new Promise<void>((resolve) => gates.push(resolve));
            return big(Number(params["n"]), 5 * MiB);
          },
        },
      });
      try {
        const connected = await rawRpc(started.path, started.key);
        const socket = connected.socket;
        socket.pause();
        socket.write([0, 1, 2, 3].map((n) => call(n, "op/call", { n })).join("\n") + "\n");
        await until(() => gates.length === 4, 20_000);
        const began = performance.now();
        for (const gate of gates) gate();
        const wire = readThrottled(socket, 512 * 1024, 100);
        await until(() => wire.lines() >= 4, 60_000);
        const took = performance.now() - began;
        wire.stop();
        const lines = wire.text().split("\n");
        expect(lines.pop()).toBe("");
        expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual(
          [0, 1, 2, 3].map((n) => ({ jsonrpc: "2.0", id: n, result: big(n, 5 * MiB) })),
        );
        expect(took).toBeGreaterThan(STALL);
        const output = clock.find({ kind: "output", conn: 1 });
        expect(output.length).toBeGreaterThan(0);
        expect(output.some((t) => t.state === "fired")).toBe(false);
        expect(started.events.some((e) => e.ev === "local.slow_reader")).toBe(false);
        expect(started.server.connectionCount).toBe(1);
        socket.destroy();
      } finally {
        await started.server.close();
      }
    },
  );

  test(
    "the deadline's timer ends with the connection, when the peer closes and on destroy",
    SLOW,
    async () => {
      for (const ending of ["peer closes", "server destroys"] as const) {
        // Every timer is virtual: none can fire on its own, so each one the connection started
        // must be cleared by the end.
        const clock = testClock({ virtual: "all" });
        let produced = false;
        const started = await startServer(root, {
          timers: clock.timers,
          limits: stuckLimits,
          handlers: {
            "op/call": () => {
              produced = true;
              return big(1, STUCK);
            },
          },
        });
        try {
          const connected = await rawRpc(started.path, started.key);
          connected.socket.pause();
          connected.socket.write(`${call(1, "op/call")}\n`);
          // The reply waits for a reader that reads nothing: this connection's deadline runs.
          await until(
            () => produced && clock.live({ kind: "output", conn: 1 }).length === 1,
            20_000,
          );
          if (ending === "peer closes") connected.socket.destroy();
          else await started.server.close();
          await until(() => started.server.connectionCount === 0, 20_000);
          const output = clock.find({ kind: "output", conn: 1 });
          expect(
            output.map((t) => t.state),
            ending,
          ).toEqual(output.map(() => "cleared"));
          expect(clock.live({ conn: 1 }), ending).toEqual([]);
          expect(
            clock.find({ conn: 1 }).some((t) => t.state === "fired"),
            ending,
          ).toBe(false);
          expect(started.events.some((e) => e.ev === "local.slow_reader")).toBe(false);
          connected.socket.destroy();
        } finally {
          await started.server.close();
        }
        expect(clock.live(), ending).toEqual([]);
      }
    },
  );

  test(
    "no timer keeps the process alive once the connection ended, when the peer closes and on destroy",
    SLOW,
    async () => {
      // A child process serves one connection whose reply waits, sees its real output deadline
      // run, ends the connection and closes the server. It must then exit by itself: a timer left
      // behind (the deadline is 60 s) would keep it alive past the 30 s this test waits.
      for (const ending of ["peer", "server"] as const) {
        const result = await runChild(STALL_EXIT_ENTRY, [root.path("exit"), ending], 30_000);
        expect(result, ending).toMatchObject({ code: 0, signal: null, timedOut: false });
        expect(JSON.parse(result.stdout.trim()), ending).toEqual({
          output: "cleared",
          live: 0,
          slowReader: false,
        });
      }
    },
  );

  test("nothing is written after the connection is destroyed", SLOW, async () => {
    // Every write on a socket the server accepted, with whether that socket was already destroyed.
    const writes: boolean[] = [];
    const original = Reflect.get(net.Socket.prototype, "write") as (
      this: net.Socket,
      ...args: unknown[]
    ) => boolean;
    const spy = vi.spyOn(net.Socket.prototype, "write").mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ): boolean {
      if ((this as { server?: unknown }).server !== undefined) writes.push(this.destroyed);
      return original.apply(this, args);
    });
    const late: boolean[] = [];
    let replied = false;
    let produced = 0;
    const clock = testClock({ virtual: ["output"] });
    const started = await startServer(root, {
      timers: clock.timers,
      limits: stuckLimits,
      handlers: {
        "op/call": () => {
          produced += 1;
          return big(1, STUCK);
        },
        // When the connection ends it still tries to notify and to reply.
        "op/list": (_params, ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              late.push(ctx.notify("feed/event", { late: true }));
              replied = true;
              resolve("late reply");
            });
          }),
      },
    });
    try {
      const connected = await rawRpc(started.path, started.key);
      connected.socket.pause();
      connected.socket.write(
        [call("hold", "op/list"), call(1, "op/call"), call(2, "op/call")].join("\n") + "\n",
      );
      // The replies wait; the deadline fires and destroys the connection.
      await until(
        () => produced > 0 && clock.live({ kind: "output", conn: 1 }).length === 1,
        20_000,
      );
      for (const deadline of clock.live({ kind: "output", conn: 1 })) clock.fire(deadline);
      expect(started.events).toContainEqual({ ev: "local.slow_reader", conn: 1 });
      await until(() => started.server.connectionCount === 0 && replied, 20_000);
      await sleep(100);
      expect(late).toEqual([false]);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.filter((destroyed) => destroyed)).toEqual([]);
      connected.socket.destroy();
    } finally {
      spy.mockRestore();
      await started.server.close();
    }
  });
});

describe("[A2.3.6.local.rpc] mcp mode", () => {
  test("whole lines pass both ways, and either side can close", SLOW, async () => {
    const channels: McpChannel[] = [];
    const received: string[] = [];
    const started = await startServer(root, {
      mcp: (channel) => {
        channels.push(channel);
        channel.onLine = (line) => {
          received.push(line);
          channel.send(line.toUpperCase());
        };
      },
    });
    try {
      const session = await openLines({
        path: started.path,
        key: started.key,
        client: clientInfo("bridge"),
        context: {},
      });
      const lines: string[] = [];
      session.onLine = (line) => lines.push(line);
      for (const line of ['{"a":"x\\ny"}', '{"b":"ü"}', "not even json"]) session.send(line);
      await until(() => lines.length === 3);
      expect(received).toEqual(['{"a":"x\\ny"}', '{"b":"ü"}', "not even json"]);
      expect(lines).toEqual(['{"A":"X\\NY"}', '{"B":"Ü"}', "NOT EVEN JSON"]);
      expect(() => {
        session.send("two\nlines");
      }).toThrow(TypeError);

      const closed = new Promise<void>((resolve) => {
        session.onClose = resolve;
      });
      const channelClosed = new Promise<void>((resolve) => {
        const channel = channels[0];
        if (channel !== undefined) channel.onClose = resolve;
      });
      channels[0]?.close();
      await closed;
      await channelClosed;
    } finally {
      await started.server.close();
    }
  });

  test(
    "send reports backpressure on both sides and drained() waits for the reader",
    SLOW,
    async () => {
      const LINES = 2_048;
      const line = JSON.stringify({ pad: "x".repeat(1_000) });
      let fromClient = 0;
      let serverWaits = 0;
      const started = await startServer(root, {
        limits: { maxQueuedBytes: 256 * 1024 },
        mcp: (channel) => {
          channel.onLine = (text) => {
            if (text !== "go") {
              fromClient += 1;
              return;
            }
            void (async () => {
              for (let i = 0; i < LINES; i += 1) {
                if (!channel.send(line)) {
                  serverWaits += 1;
                  await channel.drained();
                }
              }
            })();
          };
        },
      });
      try {
        const session = await openLines({
          path: started.path,
          key: started.key,
          client: clientInfo("bridge"),
          context: {},
        });
        let toClient = 0;
        session.onLine = () => (toClient += 1);
        session.send("go");
        let clientWaits = 0;
        for (let i = 0; i < LINES; i += 1) {
          if (!session.send(line)) {
            clientWaits += 1;
            await session.drained();
          }
        }
        await until(() => toClient === LINES && fromClient === LINES);
        expect(serverWaits).toBeGreaterThan(0);
        expect(clientWaits).toBeGreaterThan(0);
        expect(started.events.some((e) => e.ev === "local.slow_reader")).toBe(false);
        session.close();
      } finally {
        await started.server.close();
      }
    },
  );

  test(
    "a peer that stops reading is closed once its unsent output passes the bound",
    SLOW,
    async () => {
      const results: boolean[] = [];
      const started = await startServer(root, {
        limits: { maxQueuedBytes: 256 * 1024 },
        mcp: (channel) => {
          channel.onLine = () => {
            // A producer that ignores backpressure: 4 MiB for a reader that reads nothing.
            const line = JSON.stringify({ pad: "x".repeat(1_000) });
            for (let i = 0; i < 4_096; i += 1) results.push(channel.send(line));
          };
        },
      });
      try {
        const connected = await connect({
          path: started.path,
          key: started.key,
          mode: "mcp",
          client: clientInfo("bridge"),
          context: {},
        });
        connected.socket.pause();
        connected.socket.write("flood\n");
        await until(() => started.events.some((e) => e.ev === "local.slow_reader"), 20_000);
        await until(() => started.server.connectionCount === 0, 20_000);
        expect(results).toHaveLength(4_096);
        expect(results).toContain(false);
        expect(started.events).toContainEqual({ ev: "local.slow_reader", conn: 1 });
        connected.socket.destroy();
      } finally {
        await started.server.close();
      }
    },
  );

  test(
    "without an mcp hook, an mcp bind is refused as the service being too old",
    SLOW,
    async () => {
      const started = await startServer(root);
      try {
        const error = await openLines({
          path: started.path,
          key: started.key,
          client: clientInfo("bridge"),
          context: {},
        }).catch((e: unknown) => e);
        expect(error).toMatchObject({ reason: "service_too_old", detail: "mode_unsupported" });
        expect(started.events).toContainEqual({
          ev: "local.bind_refused",
          reason: "mode_unsupported",
        });
      } finally {
        await started.server.close();
      }
    },
  );
});
