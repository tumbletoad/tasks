// Test helpers for the MCP endpoint: a service in this process with one space, an mcp mode
// connection to it as a bridge opens one, a raw JSON-RPC driver that keeps each reply's exact
// bytes, and an SDK client transport over the connection. Tests only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openLines, type JsonObject, type LineSession } from "@tasks/bridge/protocol";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { startService, type RunningService } from "../src/hub/service.ts";
import { keyOf, removeRuntimeDir, serviceEnv, tempRoot, within } from "./harness.ts";
import { classSession } from "./ops-helpers.ts";

export type Json = Record<string, unknown>;

/** The build's offline file, as `pnpm gen` wrote it. */
export const LIB_OFFLINE = fileURLToPath(
  new URL("../../bridge/lib/mcp-offline.json", import.meta.url),
);

export const libOffline = (): {
  initialize: { result: Json; supported_versions: string[] };
  discover: { result: Json; supported_versions: string[] };
  tools_list: { result: Json; modern_result: Json };
  modern_result_fields: Json;
  texts: Record<string, string>;
} => JSON.parse(readFileSync(LIB_OFFLINE, "utf8")) as ReturnType<typeof libOffline>;

/** A service in this process with one space, Mira (prefix M), created by the user. */
export async function world(label: string): Promise<{
  service: RunningService;
  home: string;
  path: string;
  space: string;
  close(): Promise<void>;
}> {
  const temp = tempRoot(label);
  const home = join(temp.root, "h");
  const service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  const user = await classSession(home, service.endpoint.path, "cli-interactive");
  let space: string;
  try {
    const created = (await user.call(
      "space/create",
      { name: "Mira", path: join(temp.root, "s", "mira"), ref_prefix: "M" },
      { timeoutMs: 120_000 },
    )) as { space?: { id?: string }; id?: string };
    space = created.space?.id ?? created.id ?? "";
  } finally {
    user.close();
  }
  return {
    service,
    home,
    path: service.endpoint.path,
    space,
    close: async () => {
      await service.stop();
      removeRuntimeDir(service);
      temp.cleanup();
    },
  };
}

/** A bind context as the bridge sends it (A2 3.6.4), with `extra` over it. */
export const bridgeContext = (extra: JsonObject = {}): JsonObject => ({
  space: null,
  instance: "test-agent",
  app: "test",
  cwd: null,
  env: {},
  parent: { pid: process.pid },
  ...extra,
});

/** An mcp mode connection as the bridge opens one. */
export function openMcp(
  home: string,
  path: string,
  context: JsonObject = bridgeContext(),
  protocol?: number,
): Promise<LineSession> {
  return within(
    openLines({
      path,
      key: keyOf(home),
      client: {
        kind: "bridge",
        version: "0.0.0",
        build: "source",
        pid: process.pid,
        package: null,
        tty: { stdin: false, stdout: false },
      },
      context,
      ...(protocol === undefined ? {} : { protocol }),
    }),
    20_000,
    "the handshake",
  );
}

/** A reply as it came: the parsed message and its result's exact JSON. */
export interface Reply {
  readonly message: Json;
  readonly line: string;
  /** `JSON.stringify` of the result, which keeps the order of the bytes the service sent. */
  readonly result: string | undefined;
  readonly error: Json | undefined;
}

/** Drives one connection with raw JSON-RPC lines and keeps every reply. */
export class RawMcp {
  readonly session: LineSession;
  readonly #waiting = new Map<string, (reply: Reply) => void>();
  readonly unanswered: string[] = [];
  #next = 1;

  constructor(session: LineSession) {
    this.session = session;
    session.onLine = (line) => {
      const message = JSON.parse(line) as Json;
      const id = message["id"];
      const key = `${typeof id}:${String(id)}`;
      const reply: Reply = {
        message,
        line,
        result: message["result"] === undefined ? undefined : JSON.stringify(message["result"]),
        error: message["error"] as Json | undefined,
      };
      const waiter = this.#waiting.get(key);
      if (waiter === undefined) {
        this.unanswered.push(line);
        return;
      }
      this.#waiting.delete(key);
      waiter(reply);
    };
  }

  request(method: string, params?: Json, id: string | number = this.#next++): Promise<Reply> {
    const reply = new Promise<Reply>((resolve) => {
      this.#waiting.set(`${typeof id}:${String(id)}`, resolve);
    });
    this.session.send(
      JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
    );
    return within(reply, 60_000, `the reply to ${method}`);
  }

  notify(method: string, params: Json = {}): void {
    this.session.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** A legacy opening: initialize, then notifications/initialized. */
  async initialize(version = "2025-11-25"): Promise<Reply> {
    const reply = await this.request("initialize", {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: "raw", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return reply;
  }

  close(): void {
    this.session.close();
  }
}

export const VERSION_META = "io.modelcontextprotocol/protocolVersion";

/** A 2026-07-28 request's `_meta` envelope, with `version` as its claim; null: none. */
export const modern = (version: string | null = "2026-07-28", params: Json = {}): Json => ({
  ...params,
  _meta: {
    ...(version === null ? {} : { [VERSION_META]: version }),
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1.0.0" },
  },
});

/** An SDK client transport over an mcp mode connection, one line per message. */
export class SessionTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #session: LineSession;

  constructor(session: LineSession) {
    this.#session = session;
  }

  start(): Promise<void> {
    this.#session.onLine = (line) => {
      this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
    };
    this.#session.onClose = () => {
      this.onclose?.();
    };
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.#session.send(JSON.stringify(message))) await this.#session.drained();
  }

  close(): Promise<void> {
    this.#session.close();
    return Promise.resolve();
  }
}

/** The text of a tools/call result. */
export function textOf(result: unknown): string {
  const content = (result as { content?: { type?: string; text?: string }[] }).content;
  const text = content?.[0]?.text;
  if (typeof text !== "string") throw new Error("the result has no text");
  return text;
}

/** A framed text with its markers made fixed, so two renderings of one result compare equal. */
export const unmarked = (text: string): string =>
  text.replace(/(<<(?:end )?tasks-data )[0-9A-Z]{4,8}/g, "$1XXXX");
