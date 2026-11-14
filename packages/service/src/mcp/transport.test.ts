// The endpoint's transport over one mcp mode connection (A2 3.6.4's McpChannel, A2 3.7.4's
// mcp_init): back-pressure, bounded waiting, in-flight bounds, version checks and the
// replay of the bridge's opening request. A fake channel stands in for the local server.
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { describe, expect, test, vi } from "vitest";
import type { McpChannel } from "../local/index.ts";
import type { OpsHost } from "../ops/index.ts";
import { mcpEndpoint } from "./endpoint.ts";
import { ChannelTransport, type LineChannel, type TransportReason } from "./transport.ts";

type Json = Record<string, unknown>;

/** A channel whose output can back up, and whose drain the test releases. */
class FakeChannel implements LineChannel {
  onLine: ((line: string) => void) | undefined;
  onClose: (() => void) | undefined;
  readonly sent: Json[] = [];
  backedUp = false;
  closed = 0;
  #release: (() => void) | undefined;

  send(line: string): boolean {
    expect(line).not.toContain("\n");
    this.sent.push(JSON.parse(line) as Json);
    return !this.backedUp;
  }

  drained(): Promise<void> {
    return new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  drain(): void {
    this.backedUp = false;
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }

  close(): void {
    this.closed += 1;
    this.onClose?.();
  }

  line(message: Json): void {
    this.onLine?.(JSON.stringify(message));
  }
}

function open(options: ConstructorParameters<typeof ChannelTransport>[1] = {}): {
  channel: FakeChannel;
  transport: ChannelTransport;
  got: Json[];
  reasons: TransportReason[];
  closed: () => number;
} {
  const channel = new FakeChannel();
  const reasons: TransportReason[] = [];
  const transport = new ChannelTransport(channel, {
    ...options,
    report: (reason) => reasons.push(reason),
  });
  const got: Json[] = [];
  let closes = 0;
  transport.onmessage = (message) => {
    got.push(message);
  };
  transport.onclose = () => (closes += 1);
  void transport.start();
  return { channel, transport, got, reasons, closed: () => closes };
}

const request = (id: number | string, method = "tools/list", params: Json = {}): Json => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const reply = (id: number | string, result: Json = {}): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  result,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("[A3.3.3.mcp.transport] the endpoint's transport", () => {
  test("one line at a time: after a send that backs up, the next waits for drained()", async () => {
    const { channel, transport } = open();
    channel.backedUp = true;
    const first = transport.send(reply(1));
    const second = transport.send(reply(2));
    await tick();
    expect(channel.sent.map((m) => m["id"])).toEqual([1]);
    channel.drain();
    await Promise.all([first, second]);
    expect(channel.sent.map((m) => m["id"])).toEqual([1, 2]);
  });

  test("lines waiting for a peer that does not read are bounded: past the bound the connection ends", async () => {
    const { channel, transport, reasons, closed } = open({ limits: { maxQueuedBytes: 200 } });
    channel.backedUp = true;
    void transport.send(reply(1, { text: "x".repeat(100) }));
    for (let n = 2; n < 6; n += 1) void transport.send(reply(n, { text: "x".repeat(100) }));
    await tick();
    expect(channel.closed).toBe(1);
    expect(closed()).toBe(1);
    expect(reasons).toContain("slow_reader");
    // After the end nothing is written, and a send still settles.
    await transport.send(reply(99));
    expect(channel.sent.map((m) => m["id"])).toEqual([1]);
  });

  test("requests in flight are bounded in number: one more is refused at once, retryable, and reading goes on", async () => {
    const { channel, transport, got, reasons } = open({ limits: { maxInFlight: 2 } });
    channel.line(request(1));
    channel.line(request(2));
    channel.line(request(3));
    await tick();
    expect(got.map((m) => m["id"])).toEqual([1, 2]);
    expect(channel.sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 3,
        error: {
          code: -32000,
          message: expect.stringMatching(/^Too many requests are in flight/) as unknown,
          data: { retryable: true },
        },
      },
    ]);
    expect(reasons).toEqual(["in_flight"]);
    expect(transport.inFlight).toBe(2);
    // An answer frees a place; a cancellation does too (MCP lets it go unanswered), at the end of
    // the turn when no handler took the request.
    await transport.send(reply(1));
    channel.line({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    expect(transport.inFlight).toBe(1);
    await tick();
    expect(transport.inFlight).toBe(0);
    channel.line(request(4));
    channel.line(request(5));
    expect(got.map((m) => m["id"] ?? m["method"])).toEqual([1, 2, "notifications/cancelled", 4, 5]);
  });

  test("requests in flight are bounded in bytes too", async () => {
    const { channel, got } = open({ limits: { maxInFlightBytes: 300 } });
    channel.line(
      request(1, "tools/call", { name: "add_entry", arguments: { text: "x".repeat(150) } }),
    );
    channel.line(
      request(2, "tools/call", { name: "add_entry", arguments: { text: "x".repeat(150) } }),
    );
    await tick();
    expect(got.map((m) => m["id"])).toEqual([1]);
    expect(channel.sent[0]).toMatchObject({
      id: 2,
      error: { code: -32000, data: { retryable: true } },
    });
  });

  test("a request ID already in flight is refused; once answered it may be used again", async () => {
    const { channel, transport, got, reasons } = open();
    channel.line(request("a"));
    channel.line(request("a"));
    await tick();
    expect(got).toHaveLength(1);
    expect(channel.sent).toEqual([
      {
        jsonrpc: "2.0",
        id: "a",
        error: { code: -32600, message: "A request with this id is in flight" },
      },
    ]);
    expect(reasons).toEqual(["duplicate_id"]);
    await transport.send(reply("a"));
    channel.line(request("a"));
    expect(got).toHaveLength(2);
    // 1 and "1" are different requests.
    channel.line(request(1));
    channel.line(request("1"));
    expect(got).toHaveLength(4);
  });

  test("every 2026-07-28 request's version is checked before the SDK sees it", async () => {
    const { channel, got, reasons } = open();
    const meta = (version: unknown): Json => ({
      _meta: { "io.modelcontextprotocol/protocolVersion": version },
    });
    channel.line(request(1, "tools/list", meta("2026-07-28")));
    channel.line(request(2, "tools/list", meta("2027-01-01")));
    channel.line(request(3, "tools/list", meta(42)));
    channel.line(request(4, "tools/list"));
    await tick();
    expect(got.map((m) => m["id"])).toEqual([1]);
    expect(channel.sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: -32022,
          message: expect.any(String) as unknown,
          data: { supported: ["2026-07-28"], requested: "2027-01-01" },
        },
      },
      // A claim that is not a version: refused as a missing version, as the SDK and offline do.
      {
        jsonrpc: "2.0",
        id: 3,
        error: {
          code: -32602,
          message: "Every request needs its protocol version",
          data: { supported: ["2026-07-28"] },
        },
      },
      // The connection is 2026-07-28: a request without its version is refused, as offline.
      {
        jsonrpc: "2.0",
        id: 4,
        error: {
          code: -32602,
          message: "Every request needs its protocol version",
          data: { supported: ["2026-07-28"] },
        },
      },
    ]);
    expect(reasons).toEqual(["unsupported_version", "missing_version", "missing_version"]);
  });

  test("the era of a connection: initialize holds 2025-11-25; server/discover is a trial a client may fall back from", async () => {
    const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
    // 2025-11-25: requests without a version are what that era sends.
    const legacy = open();
    legacy.channel.line(request(1, "initialize", { protocolVersion: "2025-11-25" }));
    legacy.channel.line(request(2, "tools/list"));
    // A discover without its version is refused in any era.
    legacy.channel.line(request(3, "server/discover"));
    await tick();
    expect(legacy.got.map((m) => m["id"])).toEqual([1, 2]);
    expect(legacy.channel.sent.map((m) => m["id"])).toEqual([3]);

    // An `auto` client: discover first, then the fallback to initialize, then 2025-11-25 requests
    // once the SDK has served the initialize (only a 2025-11-25 server does).
    const fallback = open();
    fallback.channel.line(request(1, "server/discover", meta));
    fallback.channel.line(request(2, "initialize", { protocolVersion: "2025-11-25" }));
    await fallback.transport.send(reply(2, { protocolVersion: "2025-11-25" }));
    fallback.channel.line(request(3, "tools/list"));
    await tick();
    expect(fallback.got.map((m) => m["id"])).toEqual([1, 2, 3]);
    expect(fallback.channel.sent.map((m) => m["id"])).toEqual([2]);

    // A 2026-07-28 opening the SDK refused (an invalid envelope leaves the connection unopened),
    // then initialize: an error answer to it changes nothing, a result makes the era 2025-11-25.
    const reopened = open();
    reopened.channel.line(request(1, "tools/list", meta));
    await reopened.transport.send({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Invalid _meta envelope" },
    });
    reopened.channel.line(request(2, "initialize", { protocolVersion: "2025-11-25" }));
    await reopened.transport.send({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32022, message: "Unsupported protocol version" },
    });
    reopened.channel.line(request(3, "tools/list"));
    reopened.channel.line(request(4, "initialize", { protocolVersion: "2025-11-25" }));
    await reopened.transport.send(reply(4, { protocolVersion: "2025-11-25" }));
    reopened.channel.line(request(5, "tools/list"));
    await tick();
    expect(reopened.got.map((m) => m["id"])).toEqual([1, 2, 4, 5]);
    expect(
      reopened.channel.sent.map((m) => [m["id"], (m["error"] as Json | undefined)?.["code"]]),
    ).toEqual([
      [1, -32602],
      [2, -32022],
      [3, -32602],
      [4, undefined],
    ]);

    // Discover, then a 2026-07-28 request: settled; an initialize then goes to the SDK, which
    // refuses it in that era, and a request without its version is refused here.
    const pinned = open();
    pinned.channel.line(request(1, "server/discover", meta));
    pinned.channel.line(request(2, "tools/list", meta));
    pinned.channel.line(request(3, "initialize", { protocolVersion: "2025-11-25" }));
    pinned.channel.line(request(4, "tools/list"));
    await tick();
    expect(pinned.got.map((m) => m["id"])).toEqual([1, 2, 3]);
    expect(pinned.channel.sent.map((m) => m["id"])).toEqual([4]);

    // mcp_init sets the era of the connection it opens.
    const replayed = open({ init: request(0, "server/discover", meta) });
    replayed.channel.line(request(1, "tools/list"));
    await replayed.transport.send(reply(0));
    expect(replayed.got.map((m) => m["id"])).toEqual([0]);
    expect(replayed.channel.sent.map((m) => m["id"])).toEqual([1]);
  });

  test("a line the SDK does not take gets JSON-RPC's answer when it can be addressed, echoing nothing of it", async () => {
    const { channel, got, reasons } = open();
    channel.onLine?.("not json TASK_TEXT");
    channel.onLine?.(JSON.stringify({ hello: "TASK_TEXT" }));
    channel.onLine?.(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: ["TASK_TEXT"] }),
    );
    channel.onLine?.(JSON.stringify([request(3), request(4)]));
    channel.onLine?.(JSON.stringify({ jsonrpc: "1.0", method: "notifications/x" }));
    channel.onLine?.(JSON.stringify({ jsonrpc: "2.0", id: 5, result: "TASK_TEXT", error: {} }));
    channel.onLine?.("42");
    channel.onLine?.(JSON.stringify({ jsonrpc: "2.0", id: 6 }));
    // JSON-RPC 2.0's own example of an invalid request object.
    channel.onLine?.(JSON.stringify({ jsonrpc: "2.0", method: 1, params: "bar" }));
    channel.onLine?.(JSON.stringify({ jsonrpc: "2.0", id: null, method: "tools/list" }));
    channel.line(request(1));
    await tick();
    expect(got.map((m) => m["id"])).toEqual([1]);
    // -32700 for a line that is not JSON, -32600 for the rest, under the line's ID when it has a
    // usable one; a notification or a response gets nothing.
    const invalid = (id: number | null) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid request" },
    });
    expect(channel.sent).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      invalid(null),
      invalid(2),
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches are not supported" } },
      invalid(null),
      invalid(6),
      invalid(null),
      invalid(null),
    ]);
    expect(JSON.stringify(channel.sent)).not.toContain("TASK_TEXT");
    expect(reasons).toEqual(Array<TransportReason>(10).fill("not_a_message"));
  });

  test("a cancelled request whose work goes on keeps its place until the work ends", async () => {
    const cancel = (id: number): Json => ({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id },
    });
    const { channel, transport, got } = open({ limits: { maxInFlight: 1 } });
    channel.line(request(1, "tools/call", { name: "status" }));
    const ended = transport.working(1);
    channel.line(cancel(1));
    // The SDK sends nothing for it now, but its work runs: the place stays taken.
    expect(transport.inFlight).toBe(1);
    channel.line(request(1));
    channel.line(request(2));
    await tick();
    expect(channel.sent.map((m) => [m["id"], (m["error"] as Json)["code"]])).toEqual([
      [1, -32600],
      [2, -32000],
    ]);
    ended();
    ended();
    expect(transport.inFlight).toBe(0);
    channel.line(request(3, "tools/call", { name: "status" }));
    expect(got.map((m) => m["id"] ?? m["method"])).toEqual([1, "notifications/cancelled", 3]);
    // Work that ends before its answer goes: the answer frees the place.
    transport.working(3)();
    expect(transport.inFlight).toBe(1);
    await transport.send(reply(3));
    expect(transport.inFlight).toBe(0);
    // Cancelled in the turn it came, before its handler started: the place is held to the end of
    // the turn, so the handler that then starts holds it until its work ends...
    channel.line(request(4, "tools/call", { name: "status" }));
    channel.line(cancel(4));
    channel.line(request(5));
    expect(transport.inFlight).toBe(1);
    const late = transport.working(4);
    await tick();
    expect(transport.inFlight).toBe(1);
    late();
    expect(transport.inFlight).toBe(0);
    // ...and a request no handler takes frees its place at the end of the turn.
    channel.line(request(6, "tools/call", { name: "status" }));
    channel.line(cancel(6));
    expect(transport.inFlight).toBe(1);
    await tick();
    expect(transport.inFlight).toBe(0);
    expect(channel.sent.at(-1)).toMatchObject({ id: 5, error: { code: -32000 } });
  });

  test("through the endpoint, requests each cancelled in the turn they came never run more at once than the bound", async () => {
    let active = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const reader = {
      transaction: () => {
        active += 1;
        most = Math.max(most, active);
        return new Promise((_resolve, reject) => {
          releases.push(() => {
            active -= 1;
            reject(new Error("released"));
          });
        });
      },
    };
    const ops = {
      machine: { id: "m_test" },
      spaces: () => [{ id: `sp_${"0".repeat(26)}`, name: "Probe", state: "open", reader }],
    } as unknown as OpsHost;
    const channel = new FakeChannel() as FakeChannel & McpChannel;
    Object.assign(channel, { connection: { id: 1, context: {} } });
    mcpEndpoint({ ops, limits: { maxInFlight: 2 } })(channel);
    const meta = {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
    channel.line(request(0, "tools/list", meta));
    await tick();
    // One burst, as the bridge's lines can come: every call cancelled before any handler ran.
    for (let id = 1; id <= 20; id += 1) {
      channel.line(request(id, "tools/call", { name: "status", arguments: {}, ...meta }));
      channel.line({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, ...meta },
      });
    }
    await tick();
    expect(most).toBe(2);
    const busy = channel.sent.filter((m) => (m["error"] as Json | undefined)?.["code"] === -32000);
    expect(busy).toHaveLength(18);
    for (const release of releases.splice(0)) release();
    channel.close();
  });

  test("through the endpoint: after an opening the SDK refused, initialize opens 2025-11-25 and its requests are served", async () => {
    const channel = new FakeChannel() as FakeChannel & McpChannel;
    Object.assign(channel, { connection: { id: 1, context: {} } });
    mcpEndpoint({ ops: { machine: { id: "m_test" }, spaces: () => [] } })(channel);
    // A 2026-07-28 claim with an envelope the SDK refuses (no client capabilities).
    channel.line(
      request(1, "tools/list", {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      }),
    );
    await tick();
    channel.line(
      request(2, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "c", version: "1" },
      }),
    );
    await tick();
    channel.line(request(3, "tools/list"));
    await tick();
    expect(channel.sent.map((m) => m["id"])).toEqual([1, 2, 3]);
    expect(channel.sent[0]).toMatchObject({ error: { code: -32602 } });
    expect(channel.sent[1]).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    expect(channel.sent[2]).toMatchObject({ result: { tools: expect.any(Array) as unknown } });
    channel.close();
  });

  test("through the endpoint: an error the SDK makes names nothing the client sent", async () => {
    const channel = new FakeChannel() as FakeChannel & McpChannel;
    Object.assign(channel, { connection: { id: 1, context: {} } });
    mcpEndpoint({ ops: { machine: { id: "m_test" }, spaces: () => [] } })(channel);
    channel.line(
      request(1, "initialize", {
        protocolVersion: "2025-11-25",
        clientInfo: { name: "c", version: "1" },
        capabilities: { extensions: { TASK_TEXT_SENTINEL: 12 } },
      }),
    );
    await tick();
    expect(channel.sent).toHaveLength(1);
    const error = channel.sent[0]?.["error"] as Json;
    expect(typeof error["code"]).toBe("number");
    expect(error["message"]).toMatch(/^[A-Z][a-z ]+$/);
    expect(JSON.stringify(channel.sent)).not.toContain("TASK_TEXT_SENTINEL");
    channel.close();
  });

  test("through the endpoint, cancelling calls never runs more of them at once than the bound", async () => {
    let active = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    // A space whose reads wait until the test releases them: each status call is work in progress.
    const reader = {
      transaction: () => {
        active += 1;
        most = Math.max(most, active);
        return new Promise((_resolve, reject) => {
          releases.push(() => {
            active -= 1;
            reject(new Error("released"));
          });
        });
      },
    };
    const ops = {
      machine: { id: "m_test" },
      spaces: () => [{ id: `sp_${"0".repeat(26)}`, name: "Probe", state: "open", reader }],
    } as unknown as OpsHost;
    const channel = new FakeChannel() as FakeChannel & McpChannel;
    Object.assign(channel, { connection: { id: 1, context: {} } });
    mcpEndpoint({ ops, limits: { maxInFlight: 2 } })(channel);
    const meta = {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
    for (let id = 1; id <= 10; id += 1) {
      channel.line(request(id, "tools/call", { name: "status", arguments: {}, ...meta }));
      await tick();
      channel.line({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, ...meta },
      });
      await tick();
    }
    expect(most).toBe(2);
    const busy = channel.sent.filter((m) => (m["error"] as Json | undefined)?.["code"] === -32000);
    expect(busy).toHaveLength(8);
    for (const release of releases.splice(0)) release();
    await tick();
    // The work ended: the places are free again.
    channel.line(request(11, "tools/call", { name: "status", arguments: {}, ...meta }));
    await tick();
    expect(most).toBe(2);
    expect(active).toBe(1);
    for (const release of releases.splice(0)) release();
    channel.close();
  });

  test("mcp_init: the bridge's opening request goes first, its answer is dropped, and lines that came meanwhile follow in order", async () => {
    const init = request(0, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "c", version: "1" },
    });
    const { channel, transport, got, reasons } = open({ init });
    expect(got).toEqual([init]);
    expect(reasons).toEqual(["init_replayed"]);
    channel.line(request(1));
    channel.line(request(0));
    expect(got).toHaveLength(1);
    // The SDK answers the replayed request: the client has that answer already.
    await transport.send(reply(0, { protocolVersion: "2025-06-18" }));
    expect(channel.sent).toEqual([]);
    expect(got.map((m) => m["id"])).toEqual([0, 1, 0]);
    // Answers to later requests go out, the one with the same ID as the replay too.
    await transport.send(reply(1));
    await transport.send(reply(0));
    expect(channel.sent.map((m) => m["id"])).toEqual([1, 0]);
  });

  test("mcp_init whose answer does not come: the held lines go on after the bound", () => {
    vi.useFakeTimers();
    try {
      const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
      const init = request(7, "server/discover", meta);
      const { channel, got } = open({ init, limits: { initTimeoutMs: 1_000 } });
      channel.line(request(1, "tools/list", meta));
      expect(got).toHaveLength(1);
      vi.advanceTimersByTime(1_000);
      expect(got.map((m) => m["id"])).toEqual([7, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("mcp_init that is not an opening request is ignored, and held lines are bounded", async () => {
    const ignored = open({ init: request(1, "tools/call", { name: "status" }) });
    expect(ignored.got).toEqual([]);
    expect(ignored.reasons).toEqual(["init_ignored"]);
    ignored.channel.line(request(2));
    expect(ignored.got.map((m) => m["id"])).toEqual([2]);

    const flooded = open({
      init: request(0, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "c", version: "1" },
      }),
      limits: { maxHeldBytes: 100 },
    });
    flooded.channel.line(request(1, "tools/list", { pad: "x".repeat(200) }));
    await tick();
    expect(flooded.channel.closed).toBe(1);
    expect(flooded.reasons).toContain("held_too_much");
  });

  test("a closed connection: onclose once, nothing in flight, nothing more written", async () => {
    const { channel, transport, closed } = open();
    channel.line(request(1));
    channel.onClose?.();
    channel.onClose?.();
    expect(closed()).toBe(1);
    expect(transport.inFlight).toBe(0);
    await transport.send(reply(1));
    expect(channel.sent).toEqual([]);
  });
});
