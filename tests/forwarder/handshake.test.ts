// Forwarder conformance (A2 3.7.6, X2): what the forwarder sends before the service has proved
// itself, and what it does with an endpoint that fails the handshake. The bytes before server
// authentication are one hello line with only protocol, mode, nonce and proof: no context,
// ticket, handle, cwd, environment, client details or mcp_init (A7 M2.01's Verify line).
import { mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  bindResultMessage,
  challengeMessage,
  parseBind,
  parseHello,
  proofMessage,
  proofToText,
  randomToken,
  serverProof,
  type HandshakeIds,
} from "../../packages/bridge/src/protocol/index.ts";
import {
  Procs,
  fakeEndpoint,
  isOfflineText,
  makeHome,
  peerBinds,
  sleep,
  waitFor,
  type Home,
  type Json,
} from "./harness.ts";

const procs = new Procs();
const homes: Home[] = [];
afterEach(async () => {
  await procs.stopAll();
  for (const home of homes.splice(0)) home.remove();
});

function home(label: string): Home {
  const made = makeHome(label);
  homes.push(made);
  return made;
}

/** Every value the bind context would carry, each a sentinel the pre-auth bytes must not hold. */
const SENTINELS = {
  TTASKS_TICKET: "SENTINELTICKET",
  TTASKS_TASK: "SENTINELTASK",
  TTASKS_SPACE: "SENTINELENVSPACE",
  CLAUDE_CODE_SESSION_ID: "SENTINELSESSION",
  CODEX_THREAD_ID: "SENTINELTHREAD",
  T3CODE_THREAD_ID: "SENTINELT3",
};
const SENTINEL_ARGS = [
  "--space",
  "sp_sentinelspace",
  "--instance",
  "sentinelinst",
  "--app",
  "sentinelapp",
];
const SENTINEL_WORDS = [
  ...Object.values(SENTINELS),
  "sentinelspace",
  "sentinelinst",
  "sentinelapp",
  "sentinelcwd",
  "SENTINELINIT",
  "bridge",
];

function sentinelBridge(where: Home) {
  const cwd = join(where.root, "sentinelcwd");
  mkdirSync(cwd, { recursive: true });
  return procs.bridge(where, { args: SENTINEL_ARGS, env: SENTINELS, cwd });
}

/** `bytes` are exactly one hello line whose params hold only protocol, mode, nonce and proof. */
function expectOnlyHello(bytes: Buffer): void {
  const text = bytes.toString("utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(text.split("\n")).toHaveLength(2);
  const hello = JSON.parse(text) as Json;
  expect(Object.keys(hello).sort()).toEqual(["id", "jsonrpc", "method", "params"]);
  expect(hello).toMatchObject({ jsonrpc: "2.0", id: 0, method: "ttasks/hello" });
  const params = hello["params"] as Json;
  expect(Object.keys(params).sort()).toEqual(["mode", "nonce", "proof", "protocol"]);
  expect(params).toMatchObject({ protocol: 1, mode: "mcp" });
  expect(params["nonce"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params["proof"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  for (const word of SENTINEL_WORDS) expect(text.toLowerCase()).not.toContain(word.toLowerCase());
}

const challenge = (nonce = randomToken()) =>
  `${JSON.stringify(challengeMessage({ nonce, instance: "fake0instance", protocols: [1] }))}\n`;

describe("[A2.3.7.bridge.pre-auth-bytes] the forwarder against a fake endpoint", () => {
  test(
    "a wrong proof: each connection gets one hello line and nothing else, and tools answer untrusted_endpoint",
    { timeout: 120_000 },
    async () => {
      const where = home("badproof");
      const path = where.endpoint();
      const fake = await fakeEndpoint(path, (socket) => {
        socket.write(challenge());
        socket.once("data", () => {
          socket.end(
            `${JSON.stringify({ jsonrpc: "2.0", id: 0, result: { proof: randomToken() } })}\n`,
          );
        });
      });
      try {
        where.writeServiceFile(path);
        const bridge = sentinelBridge(where);
        const init = await bridge.request("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "SENTINELINIT", version: "1" },
        });
        expect(init["result"]).toMatchObject({ protocolVersion: "2025-11-25" });
        const call = await bridge.call("echo", { text: "SENTINELINIT" });
        expect(isOfflineText(call, "untrusted_endpoint")).toBe(true);
        // The retries (0.5 s, then 1 s) send the same single hello, never the context.
        await waitFor(() => (fake.received.length >= 3 ? true : undefined), 30_000, "retries");
        await sleep(100);
        for (const bytes of fake.received.slice(0, 3)) expectOnlyHello(bytes);
        expect(bridge.stray).toEqual([]);
      } finally {
        await fake.close();
      }
    },
  );

  test(
    "no proof, then a close or silence: still only the hello, and the agent gets offline answers",
    { timeout: 120_000 },
    async () => {
      for (const behaviour of ["close", "silent"] as const) {
        const where = home(behaviour);
        const path = where.endpoint();
        const fake = await fakeEndpoint(path, (socket) => {
          socket.write(challenge());
          socket.once("data", () => {
            if (behaviour === "close") socket.end();
          });
        });
        try {
          where.writeServiceFile(path);
          const bridge = sentinelBridge(where);
          await bridge.initialize();
          const list = await bridge.request("tools/list");
          expect(Array.isArray((list["result"] as Json)["tools"])).toBe(true);
          await waitFor(() => (fake.received.length >= 1 ? true : undefined), 30_000, "hello");
          await sleep(200);
          for (const bytes of fake.received) if (bytes.length > 0) expectOnlyHello(bytes);
          expect(bridge.stray).toEqual([]);
        } finally {
          await fake.close();
        }
      }
    },
  );
});

/**
 * A fake that holds the key: it completes both proofs like a service, then answers the bind with
 * a result whose mac is wrong. It records the bind frame it received.
 */
function tamperingFake(key: Buffer, binds: Json[]) {
  return (socket: net.Socket) => {
    const nonce = randomToken();
    const instance = "fake0instance";
    socket.write(challenge(nonce));
    let text = "";
    let ids: HandshakeIds | undefined;
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n")) {
        const line = text.slice(0, at);
        text = text.slice(at + 1);
        if (ids === undefined) {
          const hello = parseHello(line);
          if (hello === undefined) return;
          ids = { instance, ...hello, serverNonce: nonce, clientNonce: hello.nonce };
          socket.write(`${JSON.stringify(proofMessage(proofToText(serverProof(key, ids))))}\n`);
          continue;
        }
        const bind = parseBind(line);
        if (bind === undefined) return;
        binds.push(bind.body.context as Json);
        const result = {
          protocol: 1,
          service: { version: "0", build: "fake", instance },
          capabilities: [],
          spaces: [],
          binding: { handle: "bh_tampered", space: null, state: "bound" },
        };
        socket.end(`${JSON.stringify(bindResultMessage(result, randomToken()))}\n`);
      }
    });
  };
}

describe("[A2.3.7.bridge.handshake] the forwarder's handshake with good and bad keys", () => {
  test(
    "the right key binds and pipes; the bind context is the allow-listed one",
    { timeout: 120_000 },
    async () => {
      const where = home("good");
      await procs.peer(where);
      const bridge = sentinelBridge(where);
      await bridge.initialize();
      const call = await bridge.call("echo", { n: 1 });
      expect(call["result"]).toEqual({ content: [{ type: "text", text: '{"n":1}' }] });
      const [bind] = peerBinds(where);
      expect(bind?.kind).toBe("bridge");
      expect(bind?.client).toMatchObject({ kind: "bridge", pid: bridge.pid, package: null });
      expect(bind?.context).toEqual({
        space: "sp_sentinelspace",
        instance: "sentinelinst",
        app: "sentinelapp",
        cwd: join(where.root, "sentinelcwd"),
        env: SENTINELS,
        parent: { pid: process.pid },
      });
      expect(bridge.stray).toEqual([]);
    },
  );

  test(
    "a wrong key: the service never proves itself, and tools answer untrusted_endpoint",
    { timeout: 120_000 },
    async () => {
      const where = home("wrongkey");
      await procs.peer(where);
      where.writeKey(randomBytes(32)); // the bridge reads the key per connection
      const bridge = procs.bridge(where);
      await bridge.initialize();
      const call = await bridge.call("echo", {});
      expect(isOfflineText(call, "untrusted_endpoint")).toBe(true);
      expect(peerBinds(where)).toEqual([]);
      expect(bridge.stray).toEqual([]);
    },
  );

  test(
    "a tampered bind result fails its mac: untrusted_endpoint, and the context went only to the key holder",
    { timeout: 120_000 },
    async () => {
      const where = home("tamper");
      const path = where.endpoint();
      const binds: Json[] = [];
      const fake = await fakeEndpoint(path, tamperingFake(where.key, binds));
      try {
        where.writeServiceFile(path);
        const bridge = procs.bridge(where);
        await bridge.initialize();
        const call = await bridge.call("echo", {});
        expect(isOfflineText(call, "untrusted_endpoint")).toBe(true);
        // The handle in the tampered result was never trusted: later binds carry no resume.
        await waitFor(() => (binds.length >= 2 ? true : undefined), 30_000, "a second bind");
        for (const context of binds) expect(context).not.toHaveProperty("resume");
        expect(bridge.stray).toEqual([]);
      } finally {
        await fake.close();
      }
    },
  );

  test(
    "protocol too old: restart_session, and no more attempts",
    { timeout: 120_000 },
    async () => {
      const where = home("tooold");
      await procs.peer(where, { protocols: { min: 2, max: 2 } });
      const bridge = procs.bridge(where);
      await bridge.initialize();
      const call = await bridge.call("echo", {});
      expect(isOfflineText(call, "restart_session")).toBe(true);
      // The backoff would have tried again after 0.5 and 1.5 s.
      await sleep(2_500);
      const refused = readFileSync(join(where.state, "peer-events.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.includes("local.bind_refused"));
      expect(refused).toHaveLength(1);
      expect(bridge.stray).toEqual([]);
    },
  );
});
