// A test service for the forwarder conformance suite, run as a real child process:
// `node tests/forwarder/peer.ts <config JSON>`. It is ttasks-local/1's own `serve` with an mcp hook
// that plays a scripted MCP server, standing in for the service's MCP endpoint. Like
// the hub, it writes `<state>/service.json` with its endpoint and reads `<state>/ipc.key`. As the
// service does, it decides every connection from its bind alone: the space the bridge holds
// (`held_space`) wins, else the entry's, else this process's default, a new one at every start. It
// records every bind context for the tests to read.
//
// Tools: `echo` (its arguments as text), `whoami` (the connection, its space and how the session
// started),
// `slow` (echo after `ms`), `big` (a text of `bytes` characters), `flood` (`count` notifications
// of `bytes` each before its result). Mode `echo` sends every line back unchanged instead.
// stdin: `stop` closes the server, removes service.json and exits 0. Tests only.
// First, as in the product's entries: this script ends through process.exit.
import "../../packages/bridge/src/safe-exit.ts";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseKey } from "../../packages/bridge/src/protocol/index.ts";
import {
  serve,
  type McpChannel,
  type ServerLimits,
} from "../../packages/service/src/local/index.ts";

export interface PeerConfig {
  readonly state: string;
  readonly path: string;
  /** The offline file whose results the peer serves, so online and offline lists match. */
  readonly offline: string;
  readonly mode?: "mcp" | "echo";
  readonly protocols?: { readonly min: number; readonly max: number };
  readonly limits?: Partial<ServerLimits>;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const config = JSON.parse(process.argv[2] ?? "{}") as PeerConfig;
const offline = JSON.parse(readFileSync(config.offline, "utf8")) as {
  initialize: { result: Json; supported_versions: string[] };
  discover: { result: Json };
  tools_list: { result: Json; modern_result: Json };
};
const key = parseKey(readFileSync(join(config.state, "ipc.key"), "utf8"));
const bindsLog = join(config.state, "peer-binds.jsonl");
const eventsLog = join(config.state, "peer-events.jsonl");
const slowLog = join(config.state, "peer-slow.jsonl");
const instance = randomBytes(16).toString("hex");
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const defaultSpace = `sp_${Array.from(randomBytes(26), (b) => ALPHABET[b % 36]).join("")}`;

interface Conn {
  /** This connection, new at every bind. */
  readonly binding: string;
  readonly space: string | null;
  /** The bind carried mcp_init: the session started before this connection. */
  readonly init: boolean;
  initialized: boolean;
}
const conns = new Map<number, Conn>();

/** Sends lines one at a time, waiting for drained() whenever a send says the output is backed up. */
function sender(channel: McpChannel): (message: Json | string) => void {
  const queue: string[] = [];
  let running = false;
  const run = async (): Promise<void> => {
    running = true;
    for (let line = queue.shift(); line !== undefined; line = queue.shift()) {
      if (!channel.send(line)) await channel.drained();
    }
    running = false;
  };
  return (message) => {
    queue.push(typeof message === "string" ? message : JSON.stringify(message));
    if (!running) void run();
  };
}

const text = (value: string): Json => ({ content: [{ type: "text", text: value }] });

function answer(conn: Conn, message: Json, send: (m: Json) => void): void {
  const { id, method } = message;
  const params = isObject(message["params"]) ? message["params"] : {};
  const meta = isObject(params["_meta"]) ? params["_meta"] : {};
  const modern = typeof meta["io.modelcontextprotocol/protocolVersion"] === "string";
  const ok = (result: Json) => {
    send({ jsonrpc: "2.0", id, result });
  };
  switch (method) {
    case "initialize": {
      conn.initialized = true;
      const versions = offline.initialize.supported_versions;
      const asked = params["protocolVersion"];
      const protocolVersion =
        typeof asked === "string" && versions.includes(asked) ? asked : versions[0];
      ok({ ...offline.initialize.result, protocolVersion });
      return;
    }
    case "server/discover":
      conn.initialized = true;
      ok(offline.discover.result);
      return;
    case "tools/list":
      ok(modern ? offline.tools_list.modern_result : offline.tools_list.result);
      return;
    case "ping":
      ok({});
      return;
    case "tools/call": {
      const name = params["name"];
      const args = isObject(params["arguments"]) ? params["arguments"] : {};
      if (name === "echo") ok(text(JSON.stringify(args)));
      else if (name === "whoami") {
        ok(
          text(
            JSON.stringify({
              binding: conn.binding,
              space: conn.space,
              started: conn.init || conn.initialized,
              init: conn.init,
              pid: process.pid,
            }),
          ),
        );
      } else if (name === "slow") {
        appendFileSync(slowLog, `${JSON.stringify({ pid: process.pid, binding: conn.binding })}\n`);
        setTimeout(
          () => {
            ok(text(JSON.stringify(args)));
          },
          Number(args["ms"] ?? 0),
        );
      } else if (name === "big") ok(text("x".repeat(Number(args["bytes"] ?? 0))));
      else if (name === "flood") {
        const filler = "y".repeat(Number(args["bytes"] ?? 0));
        for (let n = 0; n < Number(args["count"] ?? 0); n += 1) {
          send({ jsonrpc: "2.0", method: "test/flood", params: { n, filler } });
        }
        ok(text("flooded"));
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
      }
      return;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}

const server = await serve({
  path: config.path,
  key,
  instance,
  service: { version: "0.0.0-peer", build: "peer" },
  ...(config.protocols === undefined ? {} : { protocols: config.protocols }),
  ...(config.limits === undefined ? {} : { limits: config.limits }),
  log: (event) => {
    appendFileSync(eventsLog, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
  },
  bind: (info) => {
    const context = info.context;
    appendFileSync(
      bindsLog,
      `${JSON.stringify({ pid: process.pid, conn: info.id, kind: info.client.kind, client: info.client, context })}\n`,
    );
    const held = context["held_space"];
    const named = context["space"];
    const space =
      held === null || typeof held === "string"
        ? held
        : typeof named === "string"
          ? named
          : defaultSpace;
    conns.set(info.id, {
      binding: `b_${randomBytes(6).toString("hex")}`,
      space,
      init: isObject(context["mcp_init"]),
      initialized: false,
    });
    return { binding: { space, state: "bound" } };
  },
  mcp: (channel) => {
    const conn = conns.get(channel.connection.id);
    const send = sender(channel);
    channel.onLine = (line) => {
      if (config.mode === "echo") {
        send(line);
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (conn === undefined || !isObject(message) || message["id"] === undefined) return;
      if (typeof message["method"] === "string") answer(conn, message, send);
    };
  },
});

const serviceFile = join(config.state, "service.json");
writeFileSync(
  serviceFile,
  JSON.stringify({
    format: 1,
    instance,
    pid: process.pid,
    state: "ready",
    endpoint: { kind: process.platform === "win32" ? "pipe" : "unix", path: config.path },
    protocol: config.protocols ?? { min: 1, max: 1 },
  }),
);
process.stdout.write("ready\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line !== "stop") return;
  void server.close().then(() => {
    rmSync(serviceFile, { force: true });
    process.exit(0);
  });
});
