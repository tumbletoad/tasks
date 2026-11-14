// tasks-local/1 end to end over a real socket (Linux, macOS) or named pipe (Windows): the
// handshake of A2 3.6.3 and the version negotiation of A2 3.6.6, with A2 5's handshake tests and
// M1.09's Verify line: a client with a wrong key receives no byte after its hello, and a tampered
// bind fails its proof.
import { timingSafeEqual } from "node:crypto";
import { LocalError, connect, openLines, openRpc, type JsonObject } from "@tasks/bridge/protocol";
import { clientInfo, endpointRoot, firstLines, testKey, until } from "@tasks/bridge/test/endpoint";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testClock } from "../../test/clock.ts";
import { editJson, relay, startServer, type Started } from "../../test/local.ts";
import { makeBind, makeHello, rawChallenge } from "../../test/raw.ts";
import type { ConnectionInfo, McpChannel, ServeOptions } from "./index.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

// Generous limits: these tests start servers and sockets, and a slow runner must not fail them.
const SLOW = { timeout: 60_000 };

let root: ReturnType<typeof endpointRoot>;
beforeAll(() => {
  root = endpointRoot();
});
afterAll(() => {
  root.remove();
});

const SENTINEL_CONTEXT: JsonObject = {
  space: "sp_SENTINEL-SPACE",
  cwd: "/home/mira/SENTINEL-CWD",
  env: { TASKS_TICKET: "SENTINEL-TICKET" },
  resume: { handle: "bh_SENTINEL-HANDLE" },
};

/** A server whose bind hook records each connection and whose mcp hook echoes lines. */
async function hubServer(
  extra: Partial<ServeOptions> = {},
): Promise<Started & { bound: ConnectionInfo[]; channels: McpChannel[] }> {
  const bound: ConnectionInfo[] = [];
  const channels: McpChannel[] = [];
  const started = await startServer(root, {
    ...extra,
    bind: (connection) => {
      bound.push(connection);
      return connection.mode === "mcp"
        ? {
            spaces: [{ id: "sp_one", state: "open" }],
            binding: { handle: "bh_x", space: "sp_one", state: "bound" },
          }
        : { spaces: [{ id: "sp_one", state: "open" }] };
    },
    mcp: (channel) => {
      channels.push(channel);
      channel.onLine = (line) => {
        channel.send(line);
      };
    },
    handlers: { "service/status": () => ({ state: "ready" }) },
  });
  return { ...started, bound, channels };
}

describe("[A2.3.6.local.handshake] handshake over a socket or pipe", () => {
  beforeEach(() => {
    vi.mocked(timingSafeEqual).mockClear();
  });

  test("rpc mode binds and answers a call", SLOW, async () => {
    const hub = await hubServer();
    try {
      const session = await openRpc({
        path: hub.path,
        key: hub.key,
        client: clientInfo(),
        context: {},
      });
      expect(session.bound).toEqual({
        protocol: 1,
        service: { version: "0.0.0-test", build: "test", instance: hub.instance },
        capabilities: ["op.call"],
        spaces: [{ id: "sp_one", state: "open" }],
        binding: null,
      });
      expect(await session.call("service/status")).toEqual({ state: "ready" });
      expect(hub.bound[0]).toMatchObject({ class: "cli-script", mode: "rpc", protocol: 1 });
      session.close();
    } finally {
      await hub.server.close();
    }
  });

  test("mcp mode binds, carries the context intact and then passes lines", SLOW, async () => {
    const hub = await hubServer();
    try {
      const session = await openLines({
        path: hub.path,
        key: hub.key,
        client: clientInfo("bridge"),
        context: SENTINEL_CONTEXT,
      });
      expect(session.bound.binding).toEqual({ handle: "bh_x", space: "sp_one", state: "bound" });
      expect(hub.bound[0]?.context).toEqual(SENTINEL_CONTEXT);
      expect(hub.bound[0]?.class).toBe("bridge");
      const echoed = new Promise<string>((resolve) => {
        session.onLine = resolve;
      });
      session.send('{"jsonrpc":"2.0","id":7,"method":"ping"}');
      expect(await echoed).toBe('{"jsonrpc":"2.0","id":7,"method":"ping"}');
      session.close();
    } finally {
      await hub.server.close();
    }
  });

  test("every proof is compared with timingSafeEqual on both sides", SLOW, async () => {
    const hub = await hubServer();
    try {
      const session = await openRpc({
        path: hub.path,
        key: hub.key,
        client: clientInfo(),
        context: {},
      });
      // Pc at the service, Ps at the client, Mb at the service, Ms at the client.
      const calls = vi.mocked(timingSafeEqual).mock.calls;
      expect(calls).toHaveLength(4);
      for (const [a, b] of calls) {
        expect((a as Uint8Array).length).toBe(32);
        expect((b as Uint8Array).length).toBe(32);
      }
      session.close();
    } finally {
      await hub.server.close();
    }
  });

  test("a client with a wrong key receives no byte after its hello", SLOW, async () => {
    const clock = testClock();
    const hub = await hubServer({ timers: clock.timers });
    try {
      const raw = await rawChallenge(hub.path);
      const hello = makeHello(raw, testKey());
      const sentAt = performance.now();
      raw.socket.write(hello.line);
      const received = await raw.received;
      expect(received.toString("utf8")).toBe(`${raw.challengeLine}\n`);
      // The service closes after a fixed delay (A2 3.6.3: 200 ms), not at its 5 s deadline: the
      // refusal's own timer closed the connection, and the deadline was stopped, not fired.
      const delay = (await raw.closedAt) - sentAt;
      expect(delay).toBeGreaterThanOrEqual(150);
      expect(clock.find({ conn: 1, kind: "handshake" })).toMatchObject([
        { ms: 5_000, state: "cleared" },
      ]);
      expect(clock.find({ conn: 1, kind: "refusal" })).toMatchObject([{ ms: 200, state: "fired" }]);
      expect(hub.events).toContainEqual({
        ev: "local.handshake_failed",
        stage: "hello",
        reason: "bad_proof",
      });

      // The client library reports the same case as an untrusted endpoint.
      const error = await connect({
        path: hub.path,
        key: testKey(),
        mode: "mcp",
        client: clientInfo("bridge"),
        context: SENTINEL_CONTEXT,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LocalError);
      expect((error as LocalError).reason).toBe("untrusted_endpoint");
      expect(hub.bound).toHaveLength(0);
      await until(() => hub.server.connectionCount === 0, 20_000);
    } finally {
      await hub.server.close();
    }
  });

  test("a hello replayed on a new connection is refused", SLOW, async () => {
    const hub = await hubServer();
    try {
      const first = await rawChallenge(hub.path);
      const hello = makeHello(first, hub.key);
      first.socket.write(hello.line);
      const [proof = ""] = await firstLines(first.socket, 1);
      expect(JSON.parse(proof)).toMatchObject({ id: 0, result: {} });

      const second = await rawChallenge(hub.path);
      second.socket.write(hello.line);
      expect((await second.received).toString("utf8")).toBe(`${second.challengeLine}\n`);
      first.socket.destroy();
    } finally {
      await hub.server.close();
    }
  });

  test("a hello with a proof for another instance is refused", SLOW, async () => {
    const hub = await hubServer();
    try {
      const raw = await rawChallenge(hub.path);
      const other = { ...raw, challenge: { ...raw.challenge, instance: "another0instance" } };
      raw.socket.write(makeHello(other, hub.key).line);
      expect((await raw.received).toString("utf8")).toBe(`${raw.challengeLine}\n`);
    } finally {
      await hub.server.close();
    }
  });

  test.each([
    ["protocol", (p: Record<string, unknown>) => (p["protocol"] = 2)],
    ["mode", (p: Record<string, unknown>) => (p["mode"] = "mcp")],
    [
      "context",
      (p: Record<string, unknown>) =>
        ((p["context"] as JsonObject)["env"] = { TASKS_TICKET: "other" }),
    ],
    ["client", (p: Record<string, unknown>) => ((p["client"] as JsonObject)["kind"] = "shim")],
  ])("a bind with a tampered %s fails its proof", SLOW, async (_name, change) => {
    const hub = await hubServer();
    const path = root.path("relay");
    const tamper = await relay(path, hub.path, (line, n) =>
      n === 1
        ? editJson(line, (frame) => change(frame["params"] as Record<string, unknown>))
        : line,
    );
    try {
      const error = await connect({
        path,
        key: hub.key,
        mode: "rpc",
        client: clientInfo(),
        context: { env: { TASKS_TICKET: "SENTINEL-TICKET" } },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LocalError);
      // The service's proof verified, so the bind went to the real service, which refused it.
      expect((error as LocalError).reason).toBe("connection_lost");
      expect(hub.events).toContainEqual({
        ev: "local.handshake_failed",
        stage: "bind",
        reason: "bad_bind_mac",
      });
      expect(hub.bound).toHaveLength(0);
    } finally {
      await tamper.close();
      await hub.server.close();
    }
  });

  test("a bind whose own protocol differs from its hello is refused", SLOW, async () => {
    const hub = await hubServer();
    try {
      const raw = await rawChallenge(hub.path);
      const hello = makeHello(raw, hub.key);
      raw.socket.write(hello.line);
      await firstLines(raw.socket, 1);
      // Authenticated, but the bind names protocol 2 after a hello that named 1.
      raw.socket.write(
        makeBind(
          raw,
          hub.key,
          { ...hello.ids, protocol: 2 },
          {
            protocol: 2,
            mode: "rpc",
            client: clientInfo(),
            context: {},
          },
        ),
      );
      await raw.received;
      expect(hub.events).toContainEqual({
        ev: "local.handshake_failed",
        stage: "bind",
        reason: "bind_mismatch",
      });
      expect(hub.bound).toHaveLength(0);
    } finally {
      await hub.server.close();
    }
  });

  test("a tampered bind result fails at the client", SLOW, async () => {
    const hub = await hubServer();
    const path = root.path("relay");
    const tamper = await relay(path, hub.path, undefined, (line, n) =>
      n === 2 ? editJson(line, (reply) => ((reply["result"] as JsonObject)["spaces"] = [])) : line,
    );
    try {
      const error = await connect({
        path,
        key: hub.key,
        mode: "mcp",
        client: clientInfo("bridge"),
        context: {},
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LocalError);
      expect((error as LocalError).reason).toBe("untrusted_endpoint");
      expect((error as LocalError).detail).toBe("bad_bind_mac");
    } finally {
      await tamper.close();
      await hub.server.close();
    }
  });

  test(
    "the bind result's proof covers the value on the wire, whatever the hook returned",
    SLOW,
    async () => {
      // JSON drops an undefined field and writes a hole as null. The proof must cover what is sent.
      const started = await startServer(root, {
        bind: () => ({
          spaces: [{ id: "sp_one", state: "open", note: undefined }],
          binding: { handle: "bh_x", extra: undefined, list: Array<unknown>(2) },
        }),
      });
      try {
        const session = await openRpc({
          path: started.path,
          key: started.key,
          client: clientInfo(),
          context: {},
        });
        expect(session.bound.spaces).toEqual([{ id: "sp_one", state: "open" }]);
        expect(session.bound.binding).toEqual({ handle: "bh_x", list: [null, null] });
        session.close();
      } finally {
        await started.server.close();
      }
    },
  );

  test("the service's events hold no nonce, proof, key or context", SLOW, async () => {
    const hub = await hubServer();
    try {
      const raw = await rawChallenge(hub.path);
      raw.socket.write(makeHello(raw, testKey()).line);
      await raw.received;
      const session = await openLines({
        path: hub.path,
        key: hub.key,
        client: clientInfo("bridge"),
        context: SENTINEL_CONTEXT,
      });
      session.close();
      await until(() => hub.server.connectionCount === 0, 20_000);
      const text = JSON.stringify(hub.events);
      expect(hub.events.length).toBeGreaterThanOrEqual(2);
      for (const secret of [raw.challenge.nonce, hub.key.toString("base64url"), "SENTINEL"]) {
        expect(text).not.toContain(secret);
      }
      for (const event of hub.events) {
        expect(
          Object.keys(event).every((k) =>
            ["ev", "stage", "reason", "conn", "class", "mode", "kind", "protocol", "ms"].includes(
              k,
            ),
          ),
        ).toBe(true);
      }
    } finally {
      await hub.server.close();
    }
  });
});

describe("[A2.3.6.local.versions] version negotiation", () => {
  // Protocol numbers in [current - 2, current + 1] around a current of 5, for both sides. A
  // service accepts [its current - 1, its current] (A2 3.6.6). A client names its current.
  const CURRENT = 5;
  const RANGE = [CURRENT - 2, CURRENT - 1, CURRENT, CURRENT + 1];

  test("every combination of client and service protocol", { timeout: 120_000 }, async () => {
    for (const service of RANGE) {
      const started = await startServer(root, { protocols: { min: service - 1, max: service } });
      try {
        for (const client of RANGE) {
          const outcome = await openRpc({
            path: started.path,
            key: started.key,
            client: clientInfo(),
            context: {},
            protocol: client,
          }).then(
            (session) => {
              session.close();
              return `bound ${String(session.bound.protocol)}`;
            },
            (error: unknown) =>
              error instanceof LocalError ? `${error.reason} ${error.detail}` : String(error),
          );
          const expected =
            client < service - 1
              ? "restart_session client_too_old"
              : client > service
                ? "service_too_old service_too_old"
                : `bound ${String(client)}`;
          expect(`${String(client)} on ${String(service)}: ${outcome}`).toBe(
            `${String(client)} on ${String(service)}: ${expected}`,
          );
        }
      } finally {
        await started.server.close();
      }
    }
  });

  test("the challenge lists the accepted protocols", SLOW, async () => {
    const started = await startServer(root, { protocols: { min: 4, max: 5 } });
    try {
      const raw = await rawChallenge(started.path);
      expect(raw.challenge.protocols).toEqual([4, 5]);
      raw.socket.destroy();
    } finally {
      await started.server.close();
    }
  });
});
