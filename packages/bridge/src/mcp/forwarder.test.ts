// The forwarder's state machine and backpressure, in process: a fake session in place of the
// socket, streams in place of stdio, and fake timers for the backoff. The conformance suite in
// tests/forwarder/ runs the same behaviour through real processes and sockets.
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LocalError, type Bound, type JsonObject, type LineSession } from "../protocol/index.ts";
import type { BaseContext } from "./context.ts";
import { Forwarder, MAX_HELD_BYTES, MAX_PENDING, type Dial } from "./forwarder.ts";
import { VERSION_META, lightParams } from "./message.ts";
import { parseOffline, type OfflineContent } from "./offline.ts";
import { SOURCE_LIB } from "./run.ts";
import { Unavailable } from "./unavailable.ts";
import { readFileSync } from "node:fs";

const CONTENT = parseOffline(readFileSync(SOURCE_LIB, "utf8")) as OfflineContent;

const BASE: BaseContext = {
  space: "sp_test",
  instance: "inst",
  app: "app",
  cwd: "/work",
  env: { TTASKS_TICKET: "T" },
  parent: { pid: 1 },
};

/** Stands in for the library's LineSession: what the forwarder uses of it, observable. */
class FakeSession {
  readonly bound: Bound;
  readonly sent: string[] = [];
  closed = false;
  paused = false;
  /** What send() returns: false makes the forwarder wait for drained(). */
  accept = true;
  onLine: ((line: string) => void) | undefined;
  onClose: (() => void) | undefined;
  readonly #waiting: (() => void)[] = [];

  constructor(binding: unknown = { handle: "bh_one", space: "sp_test", state: "bound" }) {
    this.bound = {
      protocol: 1,
      service: { version: "0", build: "fake", instance: "i" },
      capabilities: [],
      spaces: [],
      binding,
    };
  }

  send(line: string): boolean {
    if (this.closed) return false;
    this.sent.push(line);
    return this.accept;
  }

  drained(): Promise<void> {
    if (this.accept || this.closed) return Promise.resolve();
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  /** The socket takes lines again. */
  release(): void {
    this.accept = true;
    for (const resolve of this.#waiting.splice(0)) resolve();
  }

  close(): void {
    this.closed = true;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** A line from the service. */
  deliver(message: JsonObject): void {
    this.onLine?.(JSON.stringify(message));
  }

  /** The connection ends. */
  end(): void {
    this.closed = true;
    for (const resolve of this.#waiting.splice(0)) resolve();
    this.onClose?.();
  }
}

/** stdout: records every line; with `stall`, takes nothing until `release()`. */
class Output extends Writable {
  readonly lines: string[] = [];
  #partial = "";
  #held: (() => void)[] = [];
  stall = false;

  constructor() {
    super({ highWaterMark: 1024 });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.#partial += chunk.toString("utf8");
    const parts = this.#partial.split("\n");
    this.#partial = parts.pop() ?? "";
    this.lines.push(...parts);
    if (this.stall) this.#held.push(done);
    else done();
  }

  release(): void {
    this.stall = false;
    for (const done of this.#held.splice(0)) done();
  }

  json(): JsonObject[] {
    return this.lines.map((line) => JSON.parse(line) as JsonObject);
  }
}

interface Rig {
  readonly forwarder: Forwarder;
  readonly input: PassThrough;
  readonly output: Output;
  readonly warnings: string[];
  readonly contexts: JsonObject[];
  readonly dial: ReturnType<typeof vi.fn<Dial>>;
  readonly line: (message: JsonObject) => void;
}

const started: Forwarder[] = [];
afterEach(() => {
  for (const forwarder of started.splice(0)) forwarder.stop();
  vi.useRealTimers();
});

function rig(dial: Dial, timing: { holdMs?: number } = {}): Rig {
  const input = new PassThrough();
  const output = new Output();
  const warnings: string[] = [];
  const contexts: JsonObject[] = [];
  const spy = vi.fn<Dial>((context) => {
    contexts.push(context);
    return dial(context);
  });
  const forwarder = new Forwarder({
    input,
    output,
    warn: (text) => warnings.push(text),
    dial: spy,
    context: BASE,
    offline: () => CONTENT,
    timing: { backoffMs: [500, 1_000, 2_000, 5_000, 10_000], holdMs: timing.holdMs ?? 10_000 },
  });
  started.push(forwarder);
  forwarder.start();
  return {
    forwarder,
    input,
    output,
    warnings,
    contexts,
    dial: spy,
    line: (message) => {
      input.write(`${JSON.stringify(message)}\n`);
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const request = (id: number | string, method: string, params: JsonObject = {}): JsonObject => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const notDown = (): Promise<LineSession> =>
  Promise.reject(new Unavailable("not_running", "ENOENT"));
const asSession = (fake: FakeSession): LineSession => fake as unknown as LineSession;

describe("[A2.3.7.bridge.backpressure] the forwarder never buffers without bound", () => {
  test("stdin is read only while the socket takes lines", async () => {
    const session = new FakeSession();
    session.accept = false;
    const { input, line } = rig(() => Promise.resolve(asSession(session)));
    await flush();
    for (let n = 0; n < 200; n += 1) line({ jsonrpc: "2.0", method: "n", params: { n } });
    await flush();
    // One line went out and said "backed up"; the rest stay unread in stdin.
    expect(session.sent).toHaveLength(1);
    expect(input.isPaused()).toBe(true);
    session.release();
    await flush();
    await flush();
    expect(session.sent).toHaveLength(200);
    expect(session.sent.map((s) => (JSON.parse(s) as { params: { n: number } }).params.n)).toEqual(
      Array.from({ length: 200 }, (_, n) => n),
    );
  });

  test("service lines are read only while stdout takes them", async () => {
    const session = new FakeSession();
    const { output } = rig(() => Promise.resolve(asSession(session)));
    await flush();
    output.stall = true;
    const filler = "f".repeat(600);
    session.deliver({ jsonrpc: "2.0", method: "a", params: { filler } });
    expect(session.paused).toBe(false);
    session.deliver({ jsonrpc: "2.0", method: "b", params: { filler } });
    expect(session.paused).toBe(true);
    output.release();
    await flush();
    expect(session.paused).toBe(false);
    expect(output.json().map((m) => m["method"])).toEqual(["a", "b"]);
  });

  test("offline answers wait for stdout too", async () => {
    const { output, input, line } = rig(notDown);
    await flush();
    output.stall = true;
    for (let n = 0; n < 50; n += 1) line(request(n, "tools/list"));
    await flush();
    const answered = output.lines.length;
    expect(answered).toBeLessThan(5);
    expect(input.isPaused()).toBe(true);
    output.release();
    await vi.waitFor(() => {
      expect(output.lines).toHaveLength(50);
    });
  });

  test("at most MAX_PENDING requests are in flight: one more is refused at once, and cancellations and the end of stdin still arrive", async () => {
    const session = new FakeSession();
    const { forwarder, input, line, output } = rig(() => Promise.resolve(asSession(session)));
    await flush();
    for (let n = 0; n < MAX_PENDING; n += 1) line(request(n, "tools/call"));
    line(request("past-the-cap", "tools/call"));
    line({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 0 } });
    line(request("after-cancel", "tools/call"));
    await vi.waitFor(() => {
      expect(session.sent).toHaveLength(MAX_PENDING + 2);
    });
    // The request past the cap never reached the service: it got an error of its own.
    expect(session.sent.some((sent) => sent.includes('"past-the-cap"'))).toBe(false);
    expect(output.json()).toEqual([
      {
        jsonrpc: "2.0",
        id: "past-the-cap",
        error: expect.objectContaining({ code: -32000, data: { retryable: true } }) as unknown,
      },
    ]);
    // The cancellation reached the service and freed a slot for the next request.
    expect(session.sent.at(-2)).toContain("notifications/cancelled");
    expect(session.sent.at(-1)).toContain('"after-cancel"');
    // stdin is still read at the cap, so the agent app's close ends the session.
    expect(input.isPaused()).toBe(false);
    input.end();
    await forwarder.done;
    expect(forwarder.stopped).toBe(true);
    expect(session.closed).toBe(true);
  });

  test("an entry in flight keeps only short fields of its params, never what _meta carries", () => {
    const big = "m".repeat(1024 * 1024);
    const light = lightParams({
      name: "status",
      arguments: { big },
      protocolVersion: "2025-11-25",
      inputResponses: { big },
      _meta: {
        [VERSION_META]: "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { big },
        progressToken: big,
      },
    });
    expect(light).toEqual({
      protocolVersion: "2025-11-25",
      inputResponses: true,
      _meta: { [VERSION_META]: "2026-07-28", "io.modelcontextprotocol/clientInfo": true },
    });
    // A version far too long to be one keeps only its start, which is still not a supported one.
    const long = lightParams({ _meta: { [VERSION_META]: big }, protocolVersion: big });
    expect(JSON.stringify(long).length).toBeLessThan(200);
  });

  test("requests in flight also have a byte budget: long IDs past it are refused at once", async () => {
    const session = new FakeSession();
    const { line, output } = rig(() => Promise.resolve(asSession(session)));
    await flush();
    const id = (n: number): string => `${String(n)}:${"i".repeat(1.5 * 1024 * 1024)}`;
    for (let n = 0; n < 6; n += 1) line(request(id(n), "tools/call"));
    await vi.waitFor(() => {
      expect(session.sent.length + output.lines.length).toBe(6);
    });
    // Five IDs of 1.5 MiB fit in MAX_PENDING_BYTES (8 MiB); the sixth does not.
    expect(session.sent).toHaveLength(5);
    const replies = output.json();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: id(5), error: { code: -32000 } });
    // An answer frees its share of the budget.
    session.deliver({ jsonrpc: "2.0", id: id(0), result: {} });
    line(request(id(6), "tools/call"));
    await vi.waitFor(() => {
      expect(session.sent).toHaveLength(6);
    });
  });

  test("a dropped stdin line is reported at the 1st, 10th, 100th and 1,000th time, not every time", async () => {
    const session = new FakeSession();
    const { input, warnings } = rig(() => Promise.resolve(asSession(session)));
    await flush();
    const bad = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("\n")]);
    input.write(Buffer.concat(Array.from({ length: 1_500 }, () => bad)));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "after" })}\n`);
    await vi.waitFor(() => {
      expect(session.sent).toHaveLength(1);
    });
    expect(warnings.filter((w) => w.includes("not valid UTF-8"))).toEqual([
      "dropped a message that is not valid UTF-8",
      "dropped 10 messages that are not valid UTF-8",
      "dropped 100 messages that are not valid UTF-8",
      "dropped 1000 messages that are not valid UTF-8",
    ]);
  });

  test("replies the forwarder makes itself wait for stdout too: a loss with stdout backed up stops stdin", async () => {
    const first = new FakeSession();
    const { input, line, output } = rig(() =>
      first.closed ? new Promise<LineSession>(() => undefined) : Promise.resolve(asSession(first)),
    );
    await flush();
    for (let n = 0; n < 100; n += 1) line(request(n, "tools/call", { name: "status" }));
    await vi.waitFor(() => {
      expect(first.sent).toHaveLength(100);
    });
    output.stall = true;
    first.end();
    // 100 connection_lost replies queued at once, past stdout's mark: stdin waits for stdout.
    line(request("next", "tools/call", { name: "status" }));
    await flush();
    expect(output.writableLength).toBeGreaterThan(output.writableHighWaterMark);
    expect(input.isPaused()).toBe(true);
    output.release();
    await vi.waitFor(() => {
      expect(input.isPaused()).toBe(false);
    });
    expect(output.lines).toHaveLength(100);
  });

  test("lines held while there is no connection stop stdin at MAX_HELD_BYTES", async () => {
    let connect: (session: LineSession) => void = () => undefined;
    const session = new FakeSession();
    const { input } = rig(() => new Promise((resolve) => (connect = resolve)));
    const big = "h".repeat(256 * 1024);
    const count = Math.ceil(MAX_HELD_BYTES / big.length) + 8;
    for (let n = 0; n < count; n += 1) {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "h", params: { n, big } })}\n`);
    }
    await flush();
    await flush();
    expect(input.readableLength).toBeGreaterThan(0);
    connect(asSession(session));
    await vi.waitFor(() => {
      expect(session.sent).toHaveLength(count);
    });
  });
});

describe("[A2.3.7.bridge.restart] losing and finding the service", () => {
  test("the backoff is 0.5, 1, 2, 5, then every 10 s", async () => {
    vi.useFakeTimers();
    const { dial } = rig(notDown);
    const at: number[] = [];
    const start = Date.now();
    dial.mockImplementation(() => {
      at.push(Date.now() - start);
      return notDown();
    });
    // The first attempt ran at once (before the clock was watched).
    for (let n = 0; n < 6; n += 1) await vi.advanceTimersToNextTimerAsync();
    expect(at).toEqual([500, 1_500, 3_500, 8_500, 18_500, 28_500]);
  });

  test("a loss answers what was in flight, holds new requests, and binds again with the handle and mcp_init", async () => {
    const first = new FakeSession({ handle: "bh_first", space: "sp_test", state: "bound" });
    const second = new FakeSession({ handle: "bh_second", space: "sp_test", state: "bound" });
    const sessions = [first, second];
    const { line, output, contexts } = rig(() => {
      const next = sessions.shift();
      return next === undefined ? notDown() : Promise.resolve(asSession(next));
    });
    line(request(1, "initialize", { protocolVersion: "2025-06-18" }));
    await vi.waitFor(() => {
      expect(first.sent).toHaveLength(1);
    });
    first.deliver({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
    line(request(2, "tools/call", { name: "status" }));
    line(request(3, "tools/list"));
    line(request(4, "resources/list"));
    await vi.waitFor(() => {
      expect(first.sent).toHaveLength(4);
    });
    first.end();
    // In flight: a tool call gets connection_lost, tools/list the answer a live connection gives,
    // another method a JSON-RPC error with the same reason.
    const replies = output.json();
    expect(replies[1]).toMatchObject({ id: 2, result: { isError: true } });
    expect(JSON.stringify(replies[1])).toContain("(connection_lost)");
    expect(replies[2]).toEqual({ jsonrpc: "2.0", id: 3, result: CONTENT.tools_list.result });
    expect(replies[3]).toMatchObject({ id: 4, error: { data: { reason: "connection_lost" } } });
    // A request now waits for the next connection.
    line(request(5, "tools/call", { name: "status" }));
    await vi.waitFor(
      () => {
        expect(second.sent).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    expect(JSON.parse(second.sent[0] ?? "{}")).toMatchObject({ id: 5 });
    expect(output.lines).toHaveLength(4);
    expect(contexts[0]).toEqual({ ...BASE, env: { TTASKS_TICKET: "T" } });
    expect(contexts[1]).toMatchObject({
      resume: { handle: "bh_first" },
      mcp_init: request(1, "initialize", { protocolVersion: "2025-06-18" }),
    });
  });

  test("what the first bind answer named, a space or none, is sent back at every later bind and never replaced", async () => {
    const SPACE = "sp_00000000000000000000000001";
    for (const [answers, held] of [
      [[null, SPACE], null],
      [[SPACE, null], SPACE],
    ] as const) {
      const sessions = [...answers, SPACE].map(
        (space) => new FakeSession({ space, state: "unbound" }),
      );
      const all = [...sessions];
      const { line, contexts } = rig(() => {
        const next = sessions.shift();
        return next === undefined ? notDown() : Promise.resolve(asSession(next));
      });
      line(request(1, "initialize", { protocolVersion: "2025-06-18" }));
      for (const [i, session] of all.slice(0, 2).entries()) {
        await vi.waitFor(() => {
          expect(session.sent.length).toBeGreaterThan(0);
        });
        if (i === 0)
          session.deliver({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
        session.end();
        line(request(10 + i, "tools/call", { name: "status" }));
        await vi.waitFor(
          () => {
            expect(contexts.length).toBeGreaterThan(i + 1);
          },
          { timeout: 10_000 },
        );
      }
      expect(contexts[0]).not.toHaveProperty("held_space");
      expect(contexts[1]?.["held_space"], JSON.stringify(answers)).toBe(held);
      expect(contexts[2]?.["held_space"], JSON.stringify(answers)).toBe(held);
    }
  });

  test("a hold that runs out gives the offline answer with the last reason", async () => {
    const first = new FakeSession();
    // The first reconnect attempt (after 0.5 s) fails before the hold runs out.
    const { line, output } = rig(
      () => (first.closed ? notDown() : Promise.resolve(asSession(first))),
      { holdMs: 1_200 },
    );
    await flush();
    first.end();
    line(request(1, "tools/call", { name: "status" }));
    await flush();
    expect(output.lines).toHaveLength(0);
    await vi.waitFor(
      () => {
        expect(output.lines).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    expect(output.lines[0]).toContain("(not_running)");
  });

  test("an untrusted endpoint during a hold ends it at once", async () => {
    const first = new FakeSession();
    const { line, output } = rig(() =>
      first.closed
        ? Promise.reject(new LocalError("untrusted_endpoint", "bad_proof"))
        : Promise.resolve(asSession(first)),
    );
    await flush();
    first.end();
    line(request(1, "tools/call", { name: "status" }));
    await vi.waitFor(
      () => {
        expect(output.lines).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    expect(output.lines[0]).toContain("(untrusted_endpoint)");
  });

  test("restart_session is final: no more attempts", async () => {
    vi.useFakeTimers();
    const { dial, line, output } = rig(() =>
      Promise.reject(new LocalError("restart_session", "client_too_old")),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dial).toHaveBeenCalledTimes(1);
    line(request(1, "tools/call", { name: "status" }));
    await vi.advanceTimersByTimeAsync(10);
    expect(output.lines[0]).toContain("(restart_session)");
  });

  test("an initialize answered offline while a bind is on its way: the bind is redone with mcp_init", async () => {
    let connect: (session: LineSession) => void = () => undefined;
    const late = new FakeSession();
    const final = new FakeSession();
    let calls = 0;
    const { line, output, contexts } = rig(() => {
      calls += 1;
      if (calls === 1) return notDown();
      if (calls === 2) return new Promise((resolve) => (connect = resolve));
      return Promise.resolve(asSession(final));
    });
    await vi.waitFor(
      () => {
        expect(calls).toBe(2);
      },
      { timeout: 10_000 },
    );
    line(request(1, "initialize", { protocolVersion: "2025-11-25" }));
    await vi.waitFor(() => {
      expect(output.lines).toHaveLength(1);
    });
    connect(asSession(late));
    await vi.waitFor(() => {
      expect(calls).toBe(3);
    });
    expect(late.closed).toBe(true);
    expect(contexts[1]).not.toHaveProperty("mcp_init");
    // The closed bind was authenticated: its binding is resumed, not made a second time.
    expect(contexts[2]).toMatchObject({
      mcp_init: { method: "initialize" },
      resume: { handle: "bh_one" },
    });
  });

  test("offline, a session that began with server/discover stays in the 2026-07-28 era", async () => {
    const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
    const { line, output } = rig(notDown);
    line(request(1, "server/discover", meta));
    line(request(2, "tools/list", meta));
    // A later request without its version is a 2026-07-28 request that lacks one.
    line(request(3, "tools/list"));
    line(request(4, "ping"));
    await vi.waitFor(() => {
      expect(output.lines).toHaveLength(4);
    });
    const [discover, listed, bare, ping] = output.json();
    expect(discover).toEqual({ jsonrpc: "2.0", id: 1, result: CONTENT.discover.result });
    expect(listed).toEqual({ jsonrpc: "2.0", id: 2, result: CONTENT.tools_list.modern_result });
    expect(bare).toMatchObject({ id: 3, error: { code: -32602 } });
    expect(ping).toMatchObject({ id: 4, error: { code: -32602 } });
  });

  test("offline, a client that falls back from server/discover to initialize is in the legacy era, and binds with its initialize", async () => {
    let up = false;
    const session = new FakeSession();
    const { line, output, contexts } = rig(() =>
      up ? Promise.resolve(asSession(session)) : notDown(),
    );
    line(
      request(1, "server/discover", {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2027-01-01" },
      }),
    );
    line(request(2, "initialize", { protocolVersion: "2025-11-25" }));
    line(request(3, "tools/list"));
    await vi.waitFor(() => {
      expect(output.lines).toHaveLength(3);
    });
    const [refused, initialized, listed] = output.json();
    expect(refused).toMatchObject({ id: 1, error: { code: -32022 } });
    expect(initialized).toMatchObject({ id: 2, result: { protocolVersion: "2025-11-25" } });
    expect(listed).toEqual({ jsonrpc: "2.0", id: 3, result: CONTENT.tools_list.result });
    // The session went on from the initialize, not from the refused server/discover.
    up = true;
    await vi.waitFor(
      () => {
        expect(contexts.length).toBeGreaterThan(1);
      },
      { timeout: 5_000 },
    );
    expect(contexts.at(-1)).toMatchObject({
      mcp_init: request(2, "initialize", { protocolVersion: "2025-11-25" }),
    });
  });

  test("offline, a session that began with initialize answers a request without metadata in the legacy era", async () => {
    const { line, output } = rig(notDown);
    line(request(1, "initialize", { protocolVersion: "2025-11-25" }));
    line(request(2, "tools/list"));
    await vi.waitFor(() => {
      expect(output.lines).toHaveLength(2);
    });
    expect(output.json()[1]).toEqual({ jsonrpc: "2.0", id: 2, result: CONTENT.tools_list.result });
  });

  test("stdout closed without an error ends the session like a failed one", async () => {
    const { forwarder, output, line } = rig(notDown);
    await flush();
    output.destroy();
    line(request(1, "tools/list"));
    await forwarder.done;
    expect(forwarder.stopped).toBe(true);
  });

  test("stop closes the connection, and one that arrives after the stop is closed too", async () => {
    let connect: (session: LineSession) => void = () => undefined;
    const late = new FakeSession();
    const { forwarder } = rig(() => new Promise((resolve) => (connect = resolve)));
    await flush();
    forwarder.stop();
    await forwarder.done;
    connect(asSession(late));
    await flush();
    expect(late.closed).toBe(true);
  });
});
