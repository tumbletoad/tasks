// The forwarder (A2 3.7): the agent app's stdio on one side, the service's mcp mode connection on
// the other. It holds no task logic and no MCP server. It
// - pipes whole lines both ways without changing them (A2 3.7.2), and tracks the requests in
//   flight from one parse of each line;
// - answers from the offline file while there is no connection (A2 3.7.4), and keeps the client's
//   first `initialize` or `server/discover` to hand to the service as `mcp_init`;
// - reconnects with the backoff 0.5, 1, 2, 5, then every 10 s, binding again with the handle of
//   its last bind (A2 3.7.5) and what its first bind answer named, a space or none, which it keeps
//   for its life.
//   Requests in flight at a loss get `connection_lost`. Requests that arrive while it reconnects
//   wait for the new connection, up to `holdMs`, so a restart costs the agent at most the call
//   that was in flight;
// - respects backpressure both ways (A2 3.6.2): a stdin line goes to the socket only while
//   the socket takes them, a service line to stdout only while stdout takes them, and every
//   buffer it holds has a bound;
// - keeps its process alive until stop(): stdin may be paused with no connection open, so its
//   timers are never unref'd, and stop() clears them.
// stdout carries MCP frames only. Diagnostics go to `warn` (stderr), content-free.
import type { Readable, Writable } from "node:stream";
import {
  LineDecoder,
  MAX_LINE_BYTES,
  canonicalJson,
  type JsonObject,
  type LineSession,
} from "../protocol/index.ts";
import { bindContext, type BaseContext } from "./context.ts";
import {
  idKey,
  inspect,
  isInitRequest,
  isObject,
  isRequestId,
  lightParams,
  type Era,
  type Message,
  type RequestId,
} from "./message.ts";
import {
  TEXT_OF,
  busyReply,
  lostReply,
  missingReply,
  offlineReply,
  type OfflineContent,
} from "./offline.ts";
import { unavailableOf, type OfflineReason, type Unavailable } from "./unavailable.ts";

export interface Timing {
  /** The delay before each reconnect attempt; the last one repeats (A2 3.7.4). */
  readonly backoffMs: readonly number[];
  /**
   * After a lost connection, requests wait this long for a new one before the offline answer.
   * It covers a service restart: a drain of up to 5 s (A2 3.3.1) and a new start.
   */
  readonly holdMs: number;
}

export const TIMING: Timing = { backoffMs: [500, 1_000, 2_000, 5_000, 10_000], holdMs: 10_000 };

/**
 * Requests in flight, at most (a cancelled one is settled). One more gets an error at once
 * instead of waiting: stdin keeps being read, so cancellations and the end of the session still
 * arrive while the service works through the others.
 */
export const MAX_PENDING = 1024;
/**
 * What the requests in flight may hold, in bytes: each costs its ID and method and a fixed share
 * for the few short params it keeps. Past it, a request is refused like one past MAX_PENDING.
 */
export const MAX_PENDING_BYTES = MAX_LINE_BYTES;
/** The fixed share of one request in flight: its kept params are short (lightParams). */
const ENTRY_BYTES = 512;
/** Lines waiting for a connection, in bytes. Past it, stdin waits. */
export const MAX_HELD_BYTES = MAX_LINE_BYTES;
/** The longest request kept as `mcp_init`: it travels in the bind frame (1 MiB at most). */
export const MAX_INIT_BYTES = 64 * 1024;
/** At the end, stdout gets this long to take what is still queued. */
export const FLUSH_MS = 2_000;

/** Reasons a reconnect keeps holding requests for: the service may be restarting. */
const HOLDABLE: ReadonlySet<OfflineReason> = new Set([
  "not_running",
  "starting",
  "unreachable",
  "connection_lost",
]);

/** Opens one bound mcp mode connection with this context, or throws why it could not. */
export type Dial = (context: JsonObject) => Promise<LineSession>;

export interface ForwarderOptions {
  /** The agent app's messages: stdin. */
  readonly input: Readable;
  /** Messages to the agent app: stdout. Nothing else is ever written to it. */
  readonly output: Writable;
  /** One content-free diagnostic line, for stderr. */
  readonly warn: (text: string) => void;
  readonly dial: Dial;
  readonly context: BaseContext;
  /** The offline answers, read when first needed. */
  readonly offline: () => OfflineContent | undefined;
  readonly timing?: Partial<Timing>;
}

/**
 * - `hold`: no connection, and lines wait for one: at the start until the first attempt ends,
 *   and after a loss until a new bind or `holdMs`.
 * - `online`: lines go to the service.
 * - `offline`: the offline responder answers, while attempts go on in the background.
 */
type Mode = "hold" | "online" | "offline";

/**
 * Why stdin is not read now. It is read again when none is left. Each lasts only while a peer is
 * stalled (the service, or the agent app reading stdout) or for a bounded time (the hold, a close).
 */
type Block =
  | "socket" // the service connection's output is backed up
  | "stdout" // stdout is backed up by a reply the forwarder made itself
  | "held" // the lines waiting for a connection reached MAX_HELD_BYTES
  | "closing"; // the connection ended and its close is still on its way

interface Pending {
  readonly id: RequestId;
  readonly method: string;
  readonly params: JsonObject | undefined;
  /** Its share of MAX_PENDING_BYTES. */
  readonly bytes: number;
}

const BLANK = /^\s*$/;

/** Diagnostics that repeat are reported at the 1st, 10th, 100th, … time. */
const isPowerOfTen = (n: number): boolean => /^10*$/.test(String(n));

/**
 * What a bind answer says of this process's space: a space, or null for none. One bridge process
 * works in one space for its life, so the first answer is kept and sent back at every bind.
 * Undefined: the answer says nothing of it.
 */
function spaceIn(binding: unknown): string | null | undefined {
  if (!isObject(binding) || !Object.hasOwn(binding, "space")) return undefined;
  const space = binding["space"];
  if (space === null) return null;
  return typeof space === "string" && /^sp_[0-9a-z]{26}$/.test(space) ? space : undefined;
}

/** A handle the bridge keeps for the next bind: A2's `bh_…`, shaped as an ID, never logged. */
function handleOf(binding: unknown): string | undefined {
  const handle = isObject(binding) ? binding["handle"] : undefined;
  return typeof handle === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(handle) ? handle : undefined;
}

export class Forwarder {
  readonly #o: ForwarderOptions;
  readonly #timing: Timing;
  readonly #decoder = new LineDecoder(MAX_LINE_BYTES, { resync: true });
  #mode: Mode = "hold";
  #session: LineSession | undefined;
  #attempting = false;
  #retry: NodeJS.Timeout | undefined;
  #hold: NodeJS.Timeout | undefined;
  #backoff = 0;
  #failure: Unavailable | undefined;
  /** The offline state last reported on stderr, so a retry that fails the same way says nothing. */
  #reported: string | undefined;
  /** `restart_session`: this bridge's protocol is too old for good. No more attempts. */
  #final = false;
  readonly #held: string[] = [];
  #heldBytes = 0;
  readonly #inflight = new Map<string, Pending>();
  /** What the requests in flight hold, against MAX_PENDING_BYTES. */
  #inflightBytes = 0;
  readonly #blocks = new Set<Block>();
  #pumping = false;
  /** Dropped stdin lines, by kind, for their diagnostics. */
  #droppedLarge = 0;
  #droppedBad = 0;
  /**
   * The session's era from its latest `initialize` or `server/discover`: a 2026-07-28 session's
   * later requests all carry their version, so one without it is not a legacy request.
   */
  #era: Era | undefined;
  /** The latest `initialize` or `server/discover` the bridge dispatched, for later binds. */
  #mcpInit: JsonObject | undefined;
  #handle: string | undefined;
  #space: string | null | undefined;
  #content: OfflineContent | undefined;
  #missingReported = false;
  #stopping = false;
  #finish: () => void = () => undefined;
  /** Resolves once the forwarder stopped and stdout took what it could. */
  readonly done: Promise<void>;

  constructor(options: ForwarderOptions) {
    this.#o = options;
    this.#timing = { ...TIMING, ...options.timing };
    this.done = new Promise((resolve) => {
      this.#finish = resolve;
    });
  }

  /** Starts reading stdin and connecting. */
  start(): void {
    const { input, output } = this.#o;
    input.on("data", (chunk: Buffer | string) => {
      this.#decoder.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      this.#pump();
    });
    // The agent app closes stdin to end the session (MCP's stdio shutdown).
    input.once("end", () => {
      this.stop();
    });
    input.once("close", () => {
      this.stop();
    });
    input.on("error", () => {
      this.stop();
    });
    output.on("error", () => {
      this.stop();
    });
    // A stdout closed without an error (a stream destroyed by its owner) ends the session too:
    // it will never drain again.
    output.once("close", () => {
      this.stop();
    });
    output.on("drain", () => {
      this.#blocks.delete("stdout");
      this.#session?.resume();
      this.#pump();
    });
    void this.#connect();
  }

  /** Whether stop() ran. */
  get stopped(): boolean {
    return this.#stopping;
  }

  /** Ends the session: no more lines either way, no more attempts, the connection closed. */
  stop(): void {
    if (this.#stopping) return;
    this.#stopping = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#hold);
    this.#o.input.pause();
    const session = this.#session;
    this.#session = undefined;
    session?.close();
    void this.#flushed().then(() => {
      this.#finish();
    });
  }

  // --- stdin to the service, the hold queue or the offline responder

  /** Moves stdin lines on while nothing blocks them, then reads stdin or not. */
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#blocks.size === 0 && !this.#stopping) {
        if (this.#mode === "hold") {
          const line = this.#nextInput();
          if (line === undefined) break;
          if (line !== null) this.#keep(line);
          continue;
        }
        let line = this.#held.shift();
        if (line !== undefined) {
          this.#heldBytes -= Buffer.byteLength(line, "utf8");
        } else {
          const next = this.#nextInput();
          if (next === undefined) break;
          if (next === null) continue;
          line = next;
        }
        if (this.#mode === "online") this.#forward(line);
        else this.#answer(line);
      }
    } finally {
      this.#pumping = false;
    }
    if (this.#blocks.size > 0 || this.#stopping) this.#o.input.pause();
    else this.#o.input.resume();
  }

  /** The next stdin line, null for a line that was dropped, undefined when none is complete. */
  #nextInput(): string | null | undefined {
    const frame = this.#decoder.next();
    if (frame === undefined) return undefined;
    if ("error" in frame) {
      // Each kind is counted and reported at the 1st, 10th, 100th, … time, so a stream of bad
      // lines cannot turn into a stream of diagnostics.
      const large = frame.error === "frame_too_large";
      const count = large ? ++this.#droppedLarge : ++this.#droppedBad;
      if (isPowerOfTen(count)) {
        const what = large ? "over the 8 MiB line limit" : "not valid UTF-8";
        this.#o.warn(
          count === 1
            ? `dropped a message ${large ? what : `that is ${what}`}`
            : `dropped ${String(count)} messages ${large ? what : `that are ${what}`}`,
        );
      }
      return null;
    }
    return BLANK.test(frame.line) ? null : frame.line;
  }

  /** Holds a line until there is a connection or the offline responder takes over. */
  #keep(line: string): void {
    this.#held.push(line);
    this.#heldBytes += Buffer.byteLength(line, "utf8");
    if (this.#heldBytes >= MAX_HELD_BYTES) this.#blocks.add("held");
  }

  /** Online: one line to the service, unchanged. */
  #forward(line: string): void {
    const session = this.#session;
    if (session === undefined || session.closed) {
      // The connection ended. Its close comes after the service's last lines; the line waits.
      this.#held.unshift(line);
      this.#heldBytes += Buffer.byteLength(line, "utf8");
      this.#blocks.add("closing");
      return;
    }
    const message = inspect(line);
    if (message.kind === "request") {
      const key = idKey(message.id);
      const before = this.#inflight.get(key)?.bytes ?? 0;
      const bytes =
        Buffer.byteLength(key, "utf8") + Buffer.byteLength(message.method, "utf8") + ENTRY_BYTES;
      const full =
        (before === 0 && this.#inflight.size >= MAX_PENDING) ||
        this.#inflightBytes - before + bytes > MAX_PENDING_BYTES;
      if (full) {
        this.#reply(busyReply(message));
        return;
      }
      this.#inflight.set(key, {
        id: message.id,
        method: message.method,
        params: lightParams(message.params),
        bytes,
      });
      this.#inflightBytes += bytes - before;
      this.#noteInit(message, line);
    } else if (message.kind === "notification" && message.method === "notifications/cancelled") {
      // A cancelled request may never be answered (MCP): it no longer counts as in flight.
      const cancelled = message.params?.["requestId"];
      if (isRequestId(cancelled)) this.#settle(cancelled);
    }
    if (!session.send(line)) {
      this.#blocks.add("socket");
      void session.drained().then(() => {
        this.#blocks.delete("socket");
        this.#pump();
      });
    }
  }

  /** Offline: the offline responder's answer. Notifications and responses get none. */
  #answer(line: string): void {
    const message = inspect(line);
    if (message.kind !== "request") return;
    this.#noteInit(message, line);
    const content = this.#offlineContent();
    const key = TEXT_OF[this.#failure?.reason ?? "starting"];
    this.#reply(
      content === undefined
        ? missingReply(message)
        : offlineReply(content, message, key, this.#era),
    );
  }

  /**
   * One reply the forwarder makes itself (offline, at a loss, past the cap). Every such reply
   * goes through here: when stdout is backed up, stdin waits for it, so nothing the forwarder
   * writes on its own can pile up while it keeps reading.
   */
  #reply(message: JsonObject): void {
    if (!this.#write(JSON.stringify(message))) this.#blocks.add("stdout");
  }

  /**
   * Keeps the client's `initialize` or `server/discover` for later binds (A2 3.7.4), and its era.
   * The latest one counts: a client whose `server/discover` was refused falls back to
   * `initialize` and the legacy era, and its session goes on from that request.
   */
  #noteInit(message: Extract<Message, { kind: "request" }>, line: string): void {
    if (!isInitRequest(message.method)) return;
    this.#era = message.method === "server/discover" ? "modern" : "legacy";
    try {
      if (Buffer.byteLength(line, "utf8") > MAX_INIT_BYTES) throw new RangeError("too large");
      canonicalJson(message.message); // what the bind frame's proof covers must be canonical
      this.#mcpInit = message.message;
    } catch {
      // An older request must not stand in for this one.
      this.#mcpInit = undefined;
      this.#o.warn(
        "an initialize or server/discover is too large or unusual to keep for reconnects",
      );
    }
  }

  /** A request is answered or cancelled. */
  #settle(id: RequestId): void {
    const key = idKey(id);
    this.#inflightBytes -= this.#inflight.get(key)?.bytes ?? 0;
    this.#inflight.delete(key);
  }

  // --- the service to stdout

  #fromService(session: LineSession): (line: string) => void {
    return (line) => {
      if (this.#inflight.size > 0) {
        const message = inspect(line);
        if (message.kind === "response") this.#settle(message.id);
      }
      if (!this.#write(line)) session.pause();
    };
  }

  /** One message to stdout. False when stdout is backed up. */
  #write(text: string): boolean {
    if (this.#stopping) return true;
    return this.#o.output.write(`${text}\n`);
  }

  // --- connecting, losing, reconnecting

  async #connect(): Promise<void> {
    if (this.#attempting || this.#stopping) return;
    this.#attempting = true;
    const init = this.#mcpInit;
    let session: LineSession | undefined;
    let failure: Unavailable | undefined;
    try {
      session = await this.#o.dial(bindContext(this.#o.context, init, this.#handle, this.#space));
    } catch (error) {
      failure = unavailableOf(error);
    }
    this.#attempting = false;
    // stop() may have run while the attempt was on its way.
    if (this.stopped) {
      session?.close();
      return;
    }
    if (session === undefined) {
      this.#failed(failure ?? unavailableOf(undefined));
    } else if (this.#mcpInit !== init) {
      // The client's initialize or server/discover was answered offline while this bind was on
      // its way without it. Bind again, so the service starts the session from it, and resume the
      // binding this bind made (its result was authenticated) rather than make a second one.
      this.#handle = handleOf(session.bound.binding) ?? this.#handle;
      if (this.#space === undefined) this.#space = spaceIn(session.bound.binding);
      session.close();
      this.#schedule(0);
    } else {
      this.#online(session);
    }
  }

  #online(session: LineSession): void {
    this.#session = session;
    this.#backoff = 0;
    this.#failure = undefined;
    this.#reported = undefined;
    this.#handle = handleOf(session.bound.binding);
    if (this.#space === undefined) this.#space = spaceIn(session.bound.binding);
    clearTimeout(this.#hold);
    this.#hold = undefined;
    this.#mode = "online";
    this.#blocks.delete("held");
    session.onLine = this.#fromService(session);
    session.onClose = () => {
      this.#lost(session);
    };
    this.#pump();
  }

  /** The connection ended: after the service's last line, which the library guarantees. */
  #lost(session: LineSession): void {
    if (session !== this.#session) return;
    this.#session = undefined;
    this.#blocks.delete("socket");
    this.#blocks.delete("closing");
    const lost = [...this.#inflight.values()];
    this.#inflight.clear();
    this.#inflightBytes = 0;
    if (this.#stopping) return;
    // Every request still in flight gets its answer now (A2 3.7.5): a tool call `connection_lost`.
    const content = lost.length === 0 ? undefined : this.#offlineContent();
    for (const pending of lost) this.#reply(lostReply(content, pending, this.#era));
    this.#o.warn("lost the connection to the service; reconnecting");
    this.#mode = "hold";
    // Not unref'd, like every timer here: stdin may be paused (held lines at their bound), and
    // then nothing else keeps the process alive. stop() clears it.
    this.#hold = setTimeout(() => {
      this.#hold = undefined;
      this.#goOffline();
    }, this.#timing.holdMs);
    this.#schedule();
    this.#pump();
  }

  #failed(failure: Unavailable): void {
    this.#failure = failure;
    if (failure.reason === "restart_session") this.#final = true;
    const holding =
      this.#mode === "hold" && this.#hold !== undefined && HOLDABLE.has(failure.reason);
    if (this.#mode === "hold" && !holding) this.#goOffline();
    else if (this.#mode === "offline") this.#reportOffline();
    if (!this.#final) this.#schedule();
  }

  #goOffline(): void {
    clearTimeout(this.#hold);
    this.#hold = undefined;
    this.#mode = "offline";
    this.#blocks.delete("held");
    this.#reportOffline();
    this.#pump();
  }

  #reportOffline(): void {
    const reason = this.#failure?.reason ?? "starting";
    const detail = this.#failure?.detail ?? "waiting";
    const state = `${reason} (${detail})`;
    if (this.#reported === state) return;
    this.#reported = state;
    this.#o.warn(`no service connection: ${state}; tools answer offline`);
  }

  #schedule(delay?: number): void {
    if (this.#retry !== undefined || this.#stopping || this.#final) return;
    const list = this.#timing.backoffMs;
    const ms = delay ?? list[Math.min(this.#backoff, list.length - 1)] ?? 10_000;
    if (delay === undefined) this.#backoff += 1;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#connect();
    }, ms);
  }

  #offlineContent(): OfflineContent | undefined {
    if (this.#content !== undefined) return this.#content;
    this.#content = this.#o.offline();
    if (this.#content === undefined && !this.#missingReported) {
      this.#missingReported = true;
      this.#o.warn("the offline answers are missing or invalid");
    }
    return this.#content;
  }

  /** Resolves once stdout took everything queued, or after FLUSH_MS. */
  #flushed(): Promise<void> {
    const { output } = this.#o;
    if (output.destroyed || output.writableLength === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        output.off("drain", done);
        output.off("close", done);
        output.off("error", done);
        resolve();
      };
      const timer = setTimeout(done, FLUSH_MS);
      output.on("drain", done);
      output.on("close", done);
      output.on("error", done);
    });
  }
}
