// What a client sends before the service has proved itself (A2 3.6.3, A2 3.7.6, A2 5, A3 5 X2):
// against a fake endpoint that sends a challenge and then a bad, missing or late proof, the
// exact bytes it receives are one hello line whose params hold only protocol, mode, nonce and
// proof. No context, ticket, handle, cwd, environment, client details or mcp_init.
import type net from "node:net";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { clientInfo, endpointRoot, listen, testKey, until } from "../../test/endpoint.ts";
import { connect, openLines, openRpc, type ConnectOptions } from "./client.ts";
import { MAX_IN_FLIGHT, MODES, type Mode } from "./constants.ts";
import { LocalError } from "./errors.ts";
import {
  bindResultMessage,
  challengeMessage,
  parseBind,
  parseHello,
  proofMessage,
  type JsonObject,
} from "./messages.ts";
import {
  boundProof,
  proofToText,
  randomToken,
  serverProof,
  sessionKey,
  transcriptHash,
} from "./proofs.ts";

const SENTINELS = [
  "SENTINEL-TICKET",
  "SENTINEL-THREAD",
  "SENTINEL-CWD",
  "SENTINEL-HANDLE",
  "SENTINEL-INIT",
  "SENTINEL-SPACE",
  "SENTINEL-BUILD",
  "SENTINEL-PACKAGE",
];

/** A bind context with a sentinel in every field A3 3.7.2 lists. */
const sentinelContext: JsonObject = {
  space: "sp_SENTINEL-SPACE",
  instance: "codex-work",
  app: "codex",
  cwd: "/home/mira/SENTINEL-CWD",
  env: { TTASKS_TICKET: "SENTINEL-TICKET", CODEX_THREAD_ID: "SENTINEL-THREAD", CLAUDECODE: "1" },
  parent: { pid: 4802 },
  mcp_init: { jsonrpc: "2.0", id: 0, method: "initialize", params: { note: "SENTINEL-INIT" } },
  resume: { handle: "bh_SENTINEL-HANDLE" },
};

const client = { ...clientInfo("bridge"), build: "SENTINEL-BUILD", package: "SENTINEL-PACKAGE" };

/** What the fake endpoint does after it has read the client's first line. */
type Reply = { kind: "line"; text: string } | { kind: "close" } | { kind: "silent" };

const challengeLine = () =>
  `${JSON.stringify(
    challengeMessage({ nonce: randomToken(), instance: "fake0000instance", protocols: [1] }),
  )}\n`;

let root: ReturnType<typeof endpointRoot>;
beforeAll(() => {
  root = endpointRoot();
});
afterAll(() => {
  root.remove();
});

/**
 * Starts a fake endpoint with the given behaviour, connects one client to it and returns the
 * client's error and every byte the fake received.
 */
async function against(
  behave: (socket: net.Socket) => void,
  options: Partial<ConnectOptions> = {},
): Promise<{ error: unknown; bytes: Buffer }> {
  const path = root.path("fake");
  let bytes: Promise<Buffer> = Promise.resolve(Buffer.alloc(0));
  const fake = await listen(path, (socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    bytes = new Promise((resolve) => {
      socket.once("close", () => {
        resolve(Buffer.concat(chunks));
      });
    });
    behave(socket);
  });
  try {
    const error = await connect({
      path,
      key: testKey(),
      mode: "mcp",
      client,
      context: sentinelContext,
      // Far longer than any exchange with the fake takes, however loaded the machine: only the
      // tests of the client's deadline, which set their own, may reach it.
      handshakeTimeoutMs: 60_000,
      ...options,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    return { error, bytes: await bytes };
  } finally {
    await fake.close();
  }
}

/** A fake that sends a challenge, then `reply` after the client's first line. */
function challengeThen(reply: Reply) {
  return (socket: net.Socket) => {
    socket.write(challengeLine());
    socket.once("data", () => {
      if (reply.kind === "line") socket.end(`${reply.text}\n`);
      else if (reply.kind === "close") socket.end();
    });
  };
}

/** Checks that `bytes` are exactly one hello line with only protocol, mode, nonce and proof. */
function expectOnlyHello(bytes: Buffer, mode: Mode = "mcp"): void {
  const text = bytes.toString("utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(text.split("\n")).toHaveLength(2);
  const hello = JSON.parse(text) as JsonObject;
  expect(Object.keys(hello).sort()).toEqual(["id", "jsonrpc", "method", "params"]);
  expect(hello).toMatchObject({ jsonrpc: "2.0", id: 0, method: "tasks/hello" });
  const params = hello["params"] as JsonObject;
  expect(Object.keys(params).sort()).toEqual(["mode", "nonce", "proof", "protocol"]);
  expect(params["protocol"]).toBe(1);
  expect(params["mode"]).toBe(mode);
  expect(params["nonce"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params["proof"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
}

function expectUntrusted(error: unknown, detail?: string): void {
  expect(error).toBeInstanceOf(LocalError);
  const local = error as LocalError;
  expect(local.reason).toBe("untrusted_endpoint");
  expect(local.code).toBe("service_unavailable");
  expect(local.retryable).toBe(false);
  if (detail !== undefined) expect(local.detail).toBe(detail);
}

describe("[A2.3.6.local.pre-auth-bytes] a client against a fake endpoint", () => {
  test.each(MODES)("an invalid proof (%s mode): the fake receives only the hello", async (mode) => {
    const wrong = { jsonrpc: "2.0", id: 0, result: { proof: randomToken() } };
    const { error, bytes } = await against(
      challengeThen({ kind: "line", text: JSON.stringify(wrong) }),
      { mode },
    );
    expectUntrusted(error, "bad_proof");
    expectOnlyHello(bytes, mode);
  });

  test("a proof made with another key fails the same way", async () => {
    const otherKey = testKey();
    // The fake cannot compute the right proof, so it sends the one a wrong key gives.
    const { serverProof, proofToText } = await import("./proofs.ts");
    const { error, bytes } = await against((socket) => {
      const nonce = randomToken();
      socket.write(
        `${JSON.stringify(challengeMessage({ nonce, instance: "fake1", protocols: [1] }))}\n`,
      );
      socket.once("data", (chunk: Buffer) => {
        const hello = JSON.parse(chunk.toString("utf8")) as { params: { nonce: string } };
        const proof = serverProof(otherKey, {
          instance: "fake1",
          protocol: 1,
          mode: "mcp",
          serverNonce: nonce,
          clientNonce: hello.params.nonce,
        });
        socket.end(
          `${JSON.stringify({ jsonrpc: "2.0", id: 0, result: { proof: proofToText(proof) } })}\n`,
        );
      });
    });
    expectUntrusted(error, "bad_proof");
    expectOnlyHello(bytes);
  });

  test("no proof and a close: the fake receives only the hello", async () => {
    const { error, bytes } = await against(challengeThen({ kind: "close" }));
    expectUntrusted(error, "closed");
    expectOnlyHello(bytes);
  });

  test("no proof and silence: the client gives up at its deadline, after only the hello", async () => {
    const started = performance.now();
    const { error, bytes } = await against(challengeThen({ kind: "silent" }), {
      handshakeTimeoutMs: 300,
    });
    expectUntrusted(error, "timeout");
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    expectOnlyHello(bytes);
  });

  test("an error reply, a proof with extra fields or a proof with a wrong id are not proofs", async () => {
    for (const text of [
      JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32000, message: "nope" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 0, result: { proof: randomToken(), extra: 1 } }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { proof: randomToken() } }),
      "not json at all",
    ]) {
      const { error, bytes } = await against(challengeThen({ kind: "line", text }));
      expectUntrusted(error, "bad_proof");
      expectOnlyHello(bytes);
    }
  });

  test("a bad challenge gets no byte at all", async () => {
    const bad = [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/challenge",
        params: { instance: "x", protocols: [1] },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/challenge",
        params: { nonce: "short", instance: "x", protocols: [1] },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/challenge",
        params: { nonce: randomToken(), instance: "a b", protocols: [1] },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/challenge",
        params: { nonce: randomToken(), instance: "x", protocols: [] },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tasks/challenge",
        params: { nonce: randomToken(), instance: "x", protocols: [1] },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/hello",
        params: { nonce: randomToken(), instance: "x", protocols: [1] },
      }),
      "x".repeat(2_000),
    ];
    for (const line of bad) {
      const { error, bytes } = await against((socket) => {
        socket.write(`${line}\n`);
      });
      expectUntrusted(error);
      expect(bytes.length).toBe(0);
    }
  });

  test("a challenge followed by more bytes gets no byte at all", async () => {
    const { error, bytes } = await against((socket) => {
      socket.write(`${challengeLine()}{"jsonrpc":"2.0","id":0,"result":{}}\n`);
    });
    expectUntrusted(error, "bad_challenge");
    expect(bytes.length).toBe(0);
  });

  test("a silent endpoint gets no byte at all", async () => {
    const { error, bytes } = await against(() => undefined, { handshakeTimeoutMs: 300 });
    expectUntrusted(error, "timeout");
    expect(bytes.length).toBe(0);
  });

  test("no endpoint is not_running, and nothing is sent", async () => {
    const error = await connect({
      path: root.path("missing"),
      key: testKey(),
      mode: "rpc",
      client: clientInfo(),
      context: {},
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LocalError);
    expect((error as LocalError).reason).toBe("not_running");
  });

  test(
    "property: for random contexts, modes and fake replies, only the hello is ever sent",
    { timeout: 120_000 },
    async () => {
      const reply = fc.oneof(
        fc.constant<Reply>({ kind: "close" }),
        fc
          .string({ maxLength: 200 })
          .filter((s) => !s.includes("\n"))
          .map((text): Reply => ({ kind: "line", text })),
        fc.jsonValue({ maxDepth: 3 }).map((value): Reply => ({
          kind: "line",
          text: JSON.stringify({ jsonrpc: "2.0", id: 0, result: { proof: value } }),
        })),
        fc.constant(null).map((): Reply => ({
          kind: "line",
          text: JSON.stringify({ jsonrpc: "2.0", id: 0, result: { proof: randomToken() } }),
        })),
      );
      const context = fc.dictionary(
        fc.string({ maxLength: 12 }),
        fc.jsonValue({ maxDepth: 3 }).map((v) => JSON.stringify(v) + "SENTINEL-CWD"),
        { maxKeys: 6 },
      );
      await fc.assert(
        fc.asyncProperty(reply, context, fc.constantFrom(...MODES), async (r, ctx, mode) => {
          const { error, bytes } = await against(challengeThen(r), {
            mode,
            context: { ...ctx, env: { TTASKS_TICKET: "SENTINEL-TICKET" } },
          });
          expectUntrusted(error);
          expectOnlyHello(bytes, mode);
        }),
        { numRuns: 60 },
      );
    },
  );
});

/**
 * A fake endpoint that holds the key: it completes the handshake like a service and then writes
 * the bind result and `tail` in one write, so they reach the client in the same chunk. Without
 * `after` it then closes. With `after`, it stays open and hands each later line to it.
 */
function authenticatedFake(
  key: Buffer,
  tail: string,
  after?: (socket: net.Socket, line: string) => void,
) {
  return (socket: net.Socket) => {
    const nonce = randomToken();
    const instance = "fake2instance";
    socket.write(`${JSON.stringify(challengeMessage({ nonce, instance, protocols: [1] }))}\n`);
    let text = "";
    let ids: Parameters<typeof serverProof>[1] | undefined;
    let bound = false;
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n")) {
        const line = text.slice(0, at);
        text = text.slice(at + 1);
        if (bound) {
          after?.(socket, line);
          continue;
        }
        if (ids === undefined) {
          const hello = parseHello(line);
          if (hello === undefined) throw new Error("no hello");
          ids = { instance, ...hello, serverNonce: nonce, clientNonce: hello.nonce };
          socket.write(`${JSON.stringify(proofMessage(proofToText(serverProof(key, ids))))}\n`);
          continue;
        }
        const bind = parseBind(line);
        if (bind === undefined) throw new Error("no bind");
        const transcript = transcriptHash(ids, [1], bind.body);
        const result = {
          protocol: 1,
          service: { version: "0.0.0-fake", build: "fake", instance },
          capabilities: [],
          spaces: [],
          binding: null,
        };
        const mac = proofToText(boundProof(sessionKey(key, ids), transcript, result));
        const reply = `${JSON.stringify(bindResultMessage(result, mac))}\n${tail}`;
        bound = true;
        if (after === undefined) socket.end(reply);
        else socket.write(reply);
      }
    });
  };
}

describe("[A2.3.6.local.rpc] client sessions keep what came with the bind result", () => {
  test("mcp: a line in the bind result's chunk, and the close, reach handlers set after open", async () => {
    const key = testKey();
    const path = root.path("fake");
    const fake = await listen(path, authenticatedFake(key, '{"jsonrpc":"2.0","method":"hi"}\n'));
    try {
      const session = await openLines({ path, key, client, context: {} });
      const seen: string[] = [];
      session.onLine = (line) => seen.push(line);
      session.onClose = () => seen.push("<closed>");
      await until(() => seen.includes("<closed>"));
      expect(seen).toEqual(['{"jsonrpc":"2.0","method":"hi"}', "<closed>"]);
      expect(session.closed).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("mcp: the close waits for the lines before it, whichever handler is set first", async () => {
    const key = testKey();
    const path = root.path("fake");
    const fake = await listen(
      path,
      authenticatedFake(key, '{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","method":"b"}\n'),
    );
    try {
      const session = await openLines({ path, key, client, context: {} });
      const seen: string[] = [];
      session.onClose = () => seen.push("<closed>");
      // The close arrives while no line handler is set.
      await until(() => session.closed);
      expect(seen).toEqual([]);
      session.onLine = (line) => seen.push(line);
      await until(() => seen.includes("<closed>"));
      expect(seen).toEqual([
        '{"jsonrpc":"2.0","method":"a"}',
        '{"jsonrpc":"2.0","method":"b"}',
        "<closed>",
      ]);
    } finally {
      await fake.close();
    }
  });

  test("mcp: a handler that sets onLine again does not deliver recursively", async () => {
    const key = testKey();
    const path = root.path("fake");
    const COUNT = 15_000;
    const tail = Array.from({ length: COUNT }, (_, n) => `{"n":${String(n)}}\n`).join("");
    const fake = await listen(path, authenticatedFake(key, tail));
    try {
      const session = await openLines({ path, key, client, context: {} });
      let closed = false;
      session.onClose = () => (closed = true);
      // Every line arrives, and the close after them, while no line handler is set.
      await until(() => session.closed);
      expect(closed).toBe(false);
      const seen: string[] = [];
      const handler = (line: string): void => {
        seen.push(line);
        session.onLine = handler;
      };
      session.onLine = handler;
      await until(() => closed);
      expect(seen).toHaveLength(COUNT);
      expect(seen[COUNT - 1]).toBe(`{"n":${String(COUNT - 1)}}`);
    } finally {
      await fake.close();
    }
  });

  test("rpc: a reply for a call that was never sent settles nothing", async () => {
    const key = testKey();
    const path = root.path("fake");
    const requests: { id: number }[] = [];
    let answered = false;
    const fake = await listen(
      path,
      authenticatedFake(key, "", (socket, line) => {
        requests.push(JSON.parse(line) as { id: number });
        if (requests.length < MAX_IN_FLIGHT || answered) {
          // Answer each request after the window filled with its own ID.
          if (answered)
            socket.write(`{"jsonrpc":"2.0","id":${String(requests.at(-1)?.id)},"result":"own"}\n`);
          return;
        }
        answered = true;
        const first = requests[0]?.id ?? 0;
        const queued = first + MAX_IN_FLIGHT;
        // A reply naming the queued call's ID, then the real reply to the first call.
        socket.write(`{"jsonrpc":"2.0","id":${String(queued)},"result":"stolen"}\n`);
        socket.write(`{"jsonrpc":"2.0","id":${String(first)},"result":"own"}\n`);
      }),
    );
    try {
      const session = await openRpc({ path, key, client: clientInfo(), context: {} });
      const calls = Array.from({ length: MAX_IN_FLIGHT + 1 }, () => session.call("op/call"));
      // The calls left unanswered fail when the session closes.
      for (const call of calls) call.catch(() => undefined);
      expect(await calls[0]).toBe("own");
      // The queued call is sent only once a slot frees, and answered by its own reply.
      expect(await calls[MAX_IN_FLIGHT]).toBe("own");
      expect(requests).toHaveLength(MAX_IN_FLIGHT + 1);
      session.close();
    } finally {
      await fake.close();
    }
  });

  test("[A2.3.7.bridge.backpressure] mcp: pause holds every later line and stops reading; resume delivers them in order", async () => {
    const key = testKey();
    const path = root.path("fake");
    const COUNT = 2_000;
    const filler = "p".repeat(2_000);
    let written = 0;
    const fake = await listen(
      path,
      authenticatedFake(key, "", (socket) => {
        // On the client's go, write lines while the socket takes them.
        const pump = (): void => {
          while (written < COUNT) {
            const line = `{"n":${String(written)},"f":"${filler}"}\n`;
            written += 1;
            if (!socket.write(line)) {
              socket.once("drain", pump);
              return;
            }
          }
        };
        pump();
      }),
    );
    try {
      const session = await openLines({ path, key, client, context: {} });
      const seen: number[] = [];
      session.onLine = (line) => {
        seen.push((JSON.parse(line) as { n: number }).n);
        if (seen.length === 10) session.pause();
      };
      session.send('{"go":true}');
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Paused after the 10th line: nothing more is delivered, and the writer is held back by
      // the socket instead of the client reading everything into memory.
      expect(seen).toHaveLength(10);
      expect(written).toBeLessThan(COUNT);
      session.resume();
      await until(() => seen.length === COUNT);
      expect(seen).toEqual(Array.from({ length: COUNT }, (_, n) => n));
      session.close();
    } finally {
      await fake.close();
    }
  });

  test("rpc: a close handler set after the connection ended is still called", async () => {
    const key = testKey();
    const path = root.path("fake");
    const fake = await listen(path, authenticatedFake(key, ""));
    try {
      const session = await openRpc({ path, key, client: clientInfo(), context: {} });
      await until(() => session.closed);
      let called = 0;
      session.onClose = () => (called += 1);
      expect(called).toBe(1);
      await expect(session.call("service/status")).rejects.toMatchObject({
        reason: "connection_lost",
      });
    } finally {
      await fake.close();
    }
  });
});
