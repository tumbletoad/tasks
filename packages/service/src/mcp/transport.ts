// The SDK transport over one mcp mode connection (A3 3.3 "Implementation": a custom stream
// transport over the bridge connection; A2 3.6.4's McpChannel). The SDK's stdio entry
// (`serveStdio`) owns the era decision and pins one server per connection; this transport gives it
// the connection's lines and writes its messages, and adds what the SDK does not:
//
// - Back-pressure (A2 3.6.2): one line at a time to the channel; when `send` says the output
//   is backed up, the next waits for `drained()`. While output waits, the local server reads
//   nothing more from the bridge. What waits here is bounded in bytes: past the bound the peer is
//   not reading, and the connection closes.
// - Requests in flight are bounded in number and bytes. One past either bound is refused at once
//   with a retryable error and reading goes on, so a cancellation still arrives (rpc mode's rule).
//   A request ID already in flight is refused: two answers to one ID would confuse the client.
//   A request keeps its place until it is answered, or cancelled, and until the work a handler
//   started for it (`working`) has ended: the SDK sends nothing for a cancelled request, but the
//   request path cannot stop a write halfway, so cancelling never lets more work run at once. A
//   request cancelled before its handler started keeps its place until the end of the turn: the
//   SDK starts a handler in the same turn it takes the request, so by then the handler holds the
//   place itself, or none will start.
// - A line the SDK does not take gets JSON-RPC's answer: -32700 with a null ID when it is not
//   JSON, -32600 otherwise, under the line's ID when it has a usable one, else a null ID (a batch
//   too: no era of MCP this endpoint serves has them). What looks like a notification or a
//   response gets none. Nothing of the line is echoed.
// - An error the SDK makes goes out with its code, and with a fixed message instead of its own
//   when that is long or spans lines (a schema report, which names what the client sent).
// - Every 2026-07-28 request's version is checked before the SDK sees it: an unsupported one and
//   a missing one are refused here (eras.ts).
// - `mcp_init` (A2 3.7.4): when the bridge answered the client's `initialize` or
//   `server/discover` itself while the service was away, the bind context carries that request.
//   It is handed to the SDK first, so the connection starts in the client's era, and its answer is
//   dropped: the client already has one. Lines that arrive meanwhile wait, in order and bounded.
//
// Nothing a message carries reaches a report: events name a fixed reason and nothing else.
import { MAX_IN_FLIGHT, MAX_LINE_BYTES } from "@tasks/bridge/protocol";
import {
  deserializeMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";
import { EraTracker, malformedClaim, missingVersion, unsupportedVersion } from "./eras.ts";

/** What the transport needs of a connection: A2 3.6.4's McpChannel. */
export interface LineChannel {
  onLine: ((line: string) => void) | undefined;
  onClose: (() => void) | undefined;
  send(line: string): boolean;
  drained(): Promise<void>;
  close(): void;
}

export interface TransportLimits {
  /** Requests in flight: answered or cancelled frees one. Default: rpc mode's 64. */
  readonly maxInFlight: number;
  /** Bytes of the requests in flight together. */
  readonly maxInFlightBytes: number;
  /** Bytes of lines waiting for the channel. Past it the peer is not reading: the connection ends. */
  readonly maxQueuedBytes: number;
  /** Bytes of the bridge's lines held while `mcp_init` is replayed. Past it the connection ends. */
  readonly maxHeldBytes: number;
  /** How long the replay of `mcp_init` may take before held lines go on anyway. */
  readonly initTimeoutMs: number;
}

export const TRANSPORT_LIMITS: TransportLimits = {
  maxInFlight: MAX_IN_FLIGHT,
  maxInFlightBytes: 2 * MAX_LINE_BYTES,
  maxQueuedBytes: 2 * MAX_LINE_BYTES,
  maxHeldBytes: 2 * MAX_LINE_BYTES,
  initTimeoutMs: 5_000,
};

/** Why a request was answered here instead of by the SDK, or a line was dropped. */
export const TRANSPORT_REASONS = [
  "in_flight",
  "duplicate_id",
  "unsupported_version",
  "missing_version",
  "not_a_message",
  "slow_reader",
  "held_too_much",
  "init_ignored",
  "init_replayed",
] as const;
export type TransportReason = (typeof TRANSPORT_REASONS)[number];

/** A JSON-RPC server error: what a refused request gets, as the bridge's own busy answer. */
export const BUSY_CODE = -32000;
export const INVALID_REQUEST = -32600;
export const PARSE_ERROR = -32700;

/** The message an SDK error goes out with when its own is long or spans lines. */
const ERROR_MESSAGES: Readonly<Record<number, string>> = {
  [-32700]: "Parse error",
  [-32600]: "Invalid request",
  [-32601]: "Method not found",
  [-32602]: "Invalid params",
  [-32603]: "Internal error",
};
const MAX_ERROR_MESSAGE = 200;

/** An SDK error message as it may go out: its own when short and on one line, else its code's. */
function plainError(error: Record<string, unknown>): Record<string, unknown> {
  const message = error["message"];
  if (typeof message === "string" && message.length <= MAX_ERROR_MESSAGE && !/[\r\n]/.test(message))
    return error;
  const code = typeof error["code"] === "number" ? error["code"] : -32603;
  return { code, message: ERROR_MESSAGES[code] ?? "Error" };
}

type Id = string | number;
const idKey = (id: Id): string => `${typeof id}:${String(id)}`;

/** A request whose place is taken (module comment). */
interface Held {
  readonly method: string;
  readonly bytes: number;
  /** Its answer is still due: neither answered nor cancelled. */
  open: boolean;
  /** Handlers working on it now. */
  working: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is Id =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

const utf8 = new TextEncoder();
const bytesOf = (text: string): number => utf8.encode(text).length;

/** The request `mcp_init` holds, when it is one the transport can replay. */
function initRequest(value: unknown): (JSONRPCMessage & { id: Id; method: string }) | undefined {
  if (!isObject(value) || value["jsonrpc"] !== "2.0" || !isId(value["id"])) return undefined;
  const method = value["method"];
  if (method !== "initialize" && method !== "server/discover") return undefined;
  if (value["params"] !== undefined && !isObject(value["params"])) return undefined;
  try {
    return deserializeMessage(JSON.stringify(value)) as JSONRPCMessage & { id: Id; method: string };
  } catch {
    return undefined;
  }
}

export class ChannelTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #channel: LineChannel;
  readonly #limits: TransportLimits;
  readonly #report: (reason: TransportReason) => void;
  readonly #init: unknown;
  /** The connection's era, request by request (eras.ts). */
  readonly #eras = new EraTracker();
  /** Requests handed to the SDK whose place is still taken, by ID key. */
  readonly #inFlight = new Map<string, Held>();
  #inFlightBytes = 0;
  /** Lines waiting for the channel, with what each waits on. */
  readonly #queue: { line: string; bytes: number; sent: () => void }[] = [];
  #queuedBytes = 0;
  #writing = false;
  /** The replayed `mcp_init`'s ID key, while its answer is due, and its method. */
  #replaying: string | undefined;
  #replayMethod: string | undefined;
  #replayTimer: NodeJS.Timeout | undefined;
  /** The bridge's lines that came during the replay. */
  readonly #held: string[] = [];
  #heldBytes = 0;
  #closed = false;
  readonly #ended: (() => void) | undefined;

  constructor(
    channel: LineChannel,
    options: {
      /** The bind context's `mcp_init`, as it came. */
      readonly init?: unknown;
      readonly limits?: Partial<TransportLimits>;
      readonly report?: (reason: TransportReason) => void;
      /** Called once when the connection ends, whatever ended it. */
      readonly ended?: () => void;
    } = {},
  ) {
    this.#channel = channel;
    this.#ended = options.ended;
    this.#limits = { ...TRANSPORT_LIMITS, ...options.limits };
    this.#report = (reason) => {
      try {
        options.report?.(reason);
      } catch {
        // A report never breaks the connection.
      }
    };
    this.#init = options.init;
  }

  /** Requests in flight now (tests). */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /**
   * A handler starts work for request `id`. The request keeps its place until the returned
   * function is called, even when it is cancelled meanwhile: the SDK then sends no answer, but the
   * work goes on, and the bound is on work as much as on answers. Call the function exactly when
   * the work has ended, whatever its outcome.
   */
  working(id: Id): () => void {
    if (this.#closed) return () => undefined;
    const key = idKey(id);
    let entry = this.#inFlight.get(key);
    if (entry === undefined) {
      // Not expected: a request's place is held until its handler starts (`#answered`). Work that
      // runs still counts.
      entry = { method: "tools/call", bytes: 0, open: false, working: 0 };
      this.#inFlight.set(key, entry);
    }
    entry.working += 1;
    const held = entry;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      held.working -= 1;
      this.#release(key, held);
    };
  }

  start(): Promise<void> {
    this.#channel.onLine = (line) => {
      this.#receive(line);
    };
    this.#channel.onClose = () => {
      this.#end();
    };
    if (this.#init !== undefined) this.#replay(this.#init);
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    let out: unknown = message;
    if ("id" in message && isId(message.id) && ("result" in message || "error" in message)) {
      const key = idKey(message.id);
      const served = "result" in message;
      if (key === this.#replaying) {
        // The client has the answer to its opening request already (the bridge gave it).
        if (served) this.#eras.served(this.#replayMethod ?? "");
        this.#endReplay();
        return Promise.resolve();
      }
      const method = this.#inFlight.get(key)?.method;
      if (served && method !== undefined) this.#eras.served(method);
      this.#answered(key, false);
      if ("error" in message && isObject(message.error)) {
        out = { ...message, error: plainError(message.error) };
      }
    }
    return this.#enqueue(JSON.stringify(out));
  }

  close(): Promise<void> {
    if (!this.#closed) this.#channel.close();
    this.#end();
    return Promise.resolve();
  }

  // --- the bridge's lines

  #receive(line: string): void {
    if (this.#closed) return;
    if (this.#replaying !== undefined) {
      this.#heldBytes += bytesOf(line);
      if (this.#heldBytes > this.#limits.maxHeldBytes) {
        this.#report("held_too_much");
        void this.close();
        return;
      }
      this.#held.push(line);
      return;
    }
    this.#accept(line);
  }

  #accept(line: string): void {
    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(line);
    } catch {
      this.#report("not_a_message");
      this.#malformed(line);
      return;
    }
    if ("method" in message && "id" in message && isId(message.id)) {
      const refusal = this.#refusal(message.id, message.method, message.params, line);
      if (refusal !== undefined) {
        void this.#enqueue(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: refusal }));
        return;
      }
    } else if ("method" in message && message.method === "notifications/cancelled") {
      const target = isObject(message.params) ? message.params["requestId"] : undefined;
      // MCP lets a cancelled request go unanswered: no answer is due, though its work may go on.
      if (isId(target)) this.#answered(idKey(target), true);
    }
    this.onmessage?.(message);
  }

  /**
   * JSON-RPC's answer to a line the SDK does not take (module comment). The message names no part
   * of the line.
   */
  #malformed(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#answerError(null, PARSE_ERROR, "Parse error");
      return;
    }
    if (Array.isArray(value)) {
      this.#answerError(null, INVALID_REQUEST, "Batches are not supported");
      return;
    }
    if (isObject(value)) {
      // A response (the endpoint asks nothing) or a notification gets no answer, even malformed.
      if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) return;
      if (typeof value["method"] === "string" && !Object.hasOwn(value, "id")) return;
    }
    const id = isObject(value) && isId(value["id"]) ? value["id"] : null;
    this.#answerError(id, INVALID_REQUEST, "Invalid request");
  }

  #answerError(id: Id | null, code: number, message: string): void {
    void this.#enqueue(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  /** Why a request is answered here instead of reaching the SDK, or undefined when it may go on. */
  #refusal(
    id: Id,
    method: string,
    params: unknown,
    line: string,
  ): Record<string, unknown> | undefined {
    if (malformedClaim(params)) {
      this.#report("missing_version");
      return missingVersion();
    }
    const version = unsupportedVersion(params);
    if (version !== undefined) {
      this.#report("unsupported_version");
      return version;
    }
    if (!this.#eras.accept(method, params)) {
      this.#report("missing_version");
      return missingVersion();
    }
    const key = idKey(id);
    if (this.#inFlight.has(key) || key === this.#replaying) {
      this.#report("duplicate_id");
      return { code: INVALID_REQUEST, message: "A request with this id is in flight" };
    }
    const bytes = bytesOf(line);
    if (
      this.#inFlight.size >= this.#limits.maxInFlight ||
      this.#inFlightBytes + bytes > this.#limits.maxInFlightBytes
    ) {
      this.#report("in_flight");
      return {
        code: BUSY_CODE,
        message:
          "Too many requests are in flight on this connection. Retry when earlier ones are answered.",
        data: { retryable: true },
      };
    }
    this.#inFlight.set(key, { method, bytes, open: true, working: 0 });
    this.#inFlightBytes += bytes;
    return undefined;
  }

  /**
   * The request's answer went, or none is due (`cancelled`). Its place frees once no work runs. A
   * request cancelled before any handler took it keeps its place to the end of the turn: the SDK
   * starts its handler in the turn it takes the request, so that handler, if any, holds the place by
   * then (`working`), and a burst of requests each cancelled at once cannot pass the bound.
   */
  #answered(key: string, cancelled: boolean): void {
    const entry = this.#inFlight.get(key);
    if (entry === undefined) return;
    entry.open = false;
    if (cancelled && entry.working === 0) {
      setImmediate(() => {
        this.#release(key, entry);
      });
      return;
    }
    this.#release(key, entry);
  }

  #release(key: string, entry: Held): void {
    if (entry.open || entry.working > 0 || this.#inFlight.get(key) !== entry) return;
    this.#inFlight.delete(key);
    this.#inFlightBytes -= entry.bytes;
  }

  // --- mcp_init

  #replay(value: unknown): void {
    const init = initRequest(value);
    if (init === undefined) {
      this.#report("init_ignored");
      return;
    }
    this.#eras.accept(init.method, (init as { params?: unknown }).params);
    this.#replaying = idKey(init.id);
    this.#replayMethod = init.method;
    this.#replayTimer = setTimeout(() => {
      this.#endReplay();
    }, this.#limits.initTimeoutMs);
    this.#replayTimer.unref();
    this.#report("init_replayed");
    this.onmessage?.(init);
  }

  /** The replay is over: the lines that waited go on, in order. */
  #endReplay(): void {
    if (this.#replaying === undefined) return;
    this.#replaying = undefined;
    this.#replayMethod = undefined;
    clearTimeout(this.#replayTimer);
    const held = this.#held.splice(0);
    this.#heldBytes = 0;
    for (const line of held) {
      if (this.#closed) return;
      this.#accept(line);
    }
  }

  // --- writing

  #enqueue(line: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const bytes = bytesOf(line);
    if (this.#queuedBytes + bytes > this.#limits.maxQueuedBytes) {
      this.#report("slow_reader");
      void this.close();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#queue.push({ line, bytes, sent: resolve });
      this.#queuedBytes += bytes;
      if (!this.#writing) void this.#write();
    });
  }

  /** One line at a time; after a send that backed up, the next waits for the drain. */
  async #write(): Promise<void> {
    this.#writing = true;
    try {
      for (let item = this.#queue.shift(); item !== undefined; item = this.#queue.shift()) {
        this.#queuedBytes -= item.bytes;
        let flowing = true;
        if (!this.#closed) {
          try {
            flowing = this.#channel.send(item.line);
          } catch {
            // A line the channel cannot carry (over the line limit): the connection cannot go on.
            void this.close();
          }
        }
        item.sent();
        if (!flowing && !this.#closed) await this.#channel.drained();
      }
    } finally {
      this.#writing = false;
    }
  }

  #end(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#replayTimer);
    this.#replaying = undefined;
    this.#held.length = 0;
    this.#heldBytes = 0;
    this.#inFlight.clear();
    this.#inFlightBytes = 0;
    for (const item of this.#queue.splice(0)) item.sent();
    this.#queuedBytes = 0;
    try {
      this.#ended?.();
    } catch {
      // Whoever listens never breaks the end of a connection.
    }
    this.onclose?.();
  }
}
