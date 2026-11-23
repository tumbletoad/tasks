// The service side of `ttasks-local/1` (A2 3.6). `serve` listens on the socket or pipe the hub
// chose, sends each new connection a challenge and nothing else, verifies the hello, and only
// then sends its proof. It verifies the bind frame's proof over the transcript before it reads the
// context, classifies the connection (A2 3.6.5), and answers the bind with a result whose proof
// covers the same transcript. Then it serves rpc mode from a handler table or hands mcp mode's
// lines to the hub.
//
// Every bound is explicit (ServerLimits): bytes read before the client's proof verifies, the bind
// frame's size, the line size after it, the time to authenticate, unauthenticated and total
// connections, requests in flight per connection, offered output that waits, and the time output
// may wait without the peer taking any of it. A peer that sends garbage, stalls or closes at any
// byte gets nothing but the challenge, never crashes the server and never keeps a socket open past
// its timer. Events are content-free: no nonce, proof, key, context or message.
import net from "node:net";
import { AppError } from "@ttasks/contracts";
import {
  BIND_MAX_BYTES,
  FRAME_TOO_LARGE,
  FrameSizeError,
  HANDSHAKE_TIMEOUT_MS,
  HELLO_MAX_BYTES,
  LineDecoder,
  MAX_IN_FLIGHT,
  MAX_LINE_BYTES,
  MAX_PROTOCOLS,
  MAX_SOCKET_PATH_BYTES,
  METHOD,
  OUTPUT_STALL_MS,
  PROTOCOL,
  REFUSAL_DELAY_MS,
  RPC_ERROR,
  RpcError,
  bindProof,
  bindResultMessage,
  boundProof,
  challengeMessage,
  checkKey,
  clientProof,
  encodeLine,
  isInstanceId,
  isObject,
  isProtocolNumber,
  parseBind,
  parseClientInfo,
  parseHello,
  proofMatches,
  proofMessage,
  proofToText,
  randomToken,
  serverProof,
  sessionKey,
  transcriptHash,
  type ClientInfo,
  type Frame,
  type HandshakeIds,
  type JsonObject,
  type Mode,
} from "@ttasks/bridge/protocol";
import {
  classify,
  isRpcMethod,
  mayCall,
  refusalOf,
  type ConnectionClass,
  type RpcMethod,
} from "./classes.ts";
import { isLive, type GrantStore } from "./grants.ts";

export interface ServerLimits {
  /** Longest line after the bind (A2 3.6.2: 8 MiB). */
  readonly maxLineBytes: number;
  /** Every byte read before the client's proof verifies. */
  readonly helloMaxBytes: number;
  /** Longest bind frame. */
  readonly bindMaxBytes: number;
  /** From accept to a verified bind frame. */
  readonly handshakeTimeoutMs: number;
  /** A refused handshake closes after this fixed delay (A2 3.6.3: 200 ms). */
  readonly refusalDelayMs: number;
  /** Connections not yet authenticated, refusals in their delay included. */
  readonly maxPending: number;
  /** All connections. */
  readonly maxConnections: number;
  /**
   * rpc requests in flight per connection. A request beyond it is refused at once and reading
   * goes on, so `$/cancel` always arrives.
   */
  readonly maxInFlight: number;
  /**
   * Lines the service offers (notifications, mcp lines) that wait for a peer that does not read.
   * Past it the connection closes (`slow_reader`). Producers that wait for `drained()` when a send
   * returns false never reach it. Replies do not count: the in-flight limit and the line limit
   * bound them, and `outputStallMs` bounds how long they can wait.
   */
  readonly maxQueuedBytes: number;
  /**
   * The output deadline. While output waits for the peer, the socket must take some of it within
   * this time, or the connection closes (`slow_reader`). The clock runs only while output waits
   * and starts again whenever the socket takes bytes, so a slow but steady reader is never closed.
   */
  readonly outputStallMs: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
  maxLineBytes: MAX_LINE_BYTES,
  helloMaxBytes: HELLO_MAX_BYTES,
  bindMaxBytes: BIND_MAX_BYTES,
  handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  refusalDelayMs: REFUSAL_DELAY_MS,
  maxPending: 64,
  maxConnections: 256,
  maxInFlight: MAX_IN_FLIGHT,
  maxQueuedBytes: 2 * MAX_LINE_BYTES,
  outputStallMs: OUTPUT_STALL_MS,
};

/** What the service knows about an authenticated connection. `context` may hold a ticket: never log it. */
export interface ConnectionInfo {
  /** Sequential per server, for logs. */
  readonly id: number;
  readonly class: ConnectionClass;
  readonly mode: Mode;
  readonly protocol: number;
  readonly client: ClientInfo;
  readonly context: JsonObject;
}

/** The hub's answer to a bind (A2 3.6.3, 3.6.4). */
export interface BindAnswer {
  /** The spaces and their states, for the bind result. */
  readonly spaces?: readonly unknown[];
  /** mcp mode: `{space, state}`, who the connection is (binding/). rpc mode: null. */
  readonly binding?: unknown;
  /**
   * The grants row this connection uses. Revoking the row closes the connection (A2 3.2.5). The
   * service checks the row in `grants` when the hook returns, in the same step that ties it to
   * the connection, so a row revoked while the hook ran, or one that is not live, binds nothing.
   */
  readonly grant?: string;
}

export type BindHook = (connection: ConnectionInfo) => BindAnswer | Promise<BindAnswer>;

export interface RpcContext {
  readonly connection: ConnectionInfo;
  /** Aborted by `$/cancel` for this request and when the connection closes. */
  readonly signal: AbortSignal;
  /**
   * Sends a notification on this connection, for example `feed/event` or the shim's `cancel`.
   * False when the output is backed up: wait for `drained()` before sending more.
   */
  notify(method: string, params?: JsonObject): boolean;
  /** Resolves once the connection's queued output has drained, or the connection closed. */
  drained(): Promise<void>;
}

/** One rpc method. Throw contracts' AppError for A3's errors, or RpcError for protocol errors. */
export type RpcHandler = (params: JsonObject, context: RpcContext) => unknown;
export type RpcHandlers = Partial<Record<RpcMethod, RpcHandler>>;

/** An mcp mode connection after its bind: whole lines both ways (A2 3.6.4). */
export interface McpChannel {
  readonly connection: ConnectionInfo;
  /** Set it before the mcp hook returns. Each line is one message from the bridge. */
  onLine: ((line: string) => void) | undefined;
  onClose: (() => void) | undefined;
  /**
   * Sends one message. The line must not hold a newline. False when the output is backed up:
   * wait for `drained()` before sending more. Every line, MCP responses included, counts toward
   * `maxQueuedBytes` while it waits, so the MCP transport sends one line at a time this way.
   */
  send(line: string): boolean;
  /** Resolves once the queued output has drained, or the connection closed. */
  drained(): Promise<void>;
  close(): void;
}

/** Where a handshake failed. */
export const HANDSHAKE_STAGES = ["accept", "hello", "bind"] as const;
/** Why a handshake failed: a closed list, so the hub's log takes only these words. */
export const HANDSHAKE_FAILURES = [
  "capacity",
  "timeout",
  "too_large",
  "invalid_utf8",
  "pipelined",
  "bad_hello",
  "bad_proof",
  "bad_bind",
  "bad_bind_mac",
  "bind_mismatch",
  "bind_failed",
  "grant_not_live",
  "closed",
] as const;
/** An authenticated refusal of a bind (A2 3.6.6). */
export const BIND_REFUSALS = [
  "client_too_old",
  "service_too_old",
  "invalid_bind",
  "mode_unsupported",
] as const;

/** Content-free events for the service log (A2 3.13). Every word is from a closed list. */
export type LocalEvent =
  | {
      readonly ev: "local.handshake_failed";
      readonly stage: Stage;
      readonly reason: HandshakeFailure;
    }
  | { readonly ev: "local.bind_refused"; readonly reason: RefusalReason }
  | {
      readonly ev: "local.bound";
      readonly conn: number;
      readonly class: ConnectionClass;
      readonly mode: Mode;
      readonly kind: string;
      readonly protocol: number;
      readonly ms: number;
    }
  | { readonly ev: "local.frame_too_large"; readonly conn: number }
  | { readonly ev: "local.slow_reader"; readonly conn: number }
  | { readonly ev: "local.handler_failed"; readonly conn: number; readonly method: RpcMethod }
  | { readonly ev: "local.revoked"; readonly conn: number }
  | { readonly ev: "local.listen_error"; readonly code: string };

type Stage = (typeof HANDSHAKE_STAGES)[number];
type HandshakeFailure = (typeof HANDSHAKE_FAILURES)[number];
type RefusalReason = (typeof BIND_REFUSALS)[number];

/**
 * What each of the server's timers is for: a connection's handshake deadline, the fixed delay
 * before a refused handshake closes, the grace an ending connection gets to send what it wrote,
 * the output deadline, and the server's own grace when it closes with `graceMs`.
 */
export const TIMER_KINDS = ["handshake", "refusal", "close", "output", "grace"] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

/** One timer the server holds. */
export interface ServerTimer {
  /** Starts the timer's time again from now. */
  refresh(): void;
  /** Stops it for good. */
  clear(): void;
}

/** A timer the server asks for: what it is for, whose it is (undefined: the server's) and how long. */
export interface TimerSpec {
  readonly kind: TimerKind;
  readonly conn: number | undefined;
  readonly ms: number;
}

/** Starts a timer that calls `fire` once, `spec.ms` after it starts or was last refreshed. */
export type StartTimer = (spec: TimerSpec, fire: () => void) => ServerTimer;

/** The server's timers: Node's own. */
export const nodeTimers: StartTimer = (spec, fire) => {
  const timer = setTimeout(fire, spec.ms);
  return {
    refresh: () => {
      timer.refresh();
    },
    clear: () => {
      clearTimeout(timer);
    },
  };
};

export interface ServeOptions {
  /** The socket path or pipe name the hub chose (A2 3.2.1, 3.4). The hub protects its folder. */
  readonly path: string;
  /** The 32 bytes of `ipc.key`. */
  readonly key: Uint8Array;
  /** The instance ID from `service.json`, new at every start. */
  readonly instance: string;
  readonly service: { readonly version: string; readonly build: string };
  /** Capability strings for the bind result (A2 3.6.6). */
  readonly capabilities?: readonly string[];
  /** rpc mode's methods. A method without a handler answers "method not found". */
  readonly handlers?: RpcHandlers;
  /** Called for every authenticated bind before its result is sent. */
  readonly bind?: BindHook;
  /** Takes each mcp mode connection. Without it, mcp binds are refused as `mode_unsupported`. */
  readonly mcp?: (channel: McpChannel) => void;
  /**
   * The grants table. A bind whose answer names a row is checked against it, and revoking a row
   * closes the connections that use it. Without it, an answer that names a row binds nothing.
   */
  readonly grants?: Pick<GrantStore, "get" | "onRevoke">;
  /** The protocols accepted, listed in the challenge. Default: [PROTOCOL]. */
  readonly protocols?: { readonly min: number; readonly max: number };
  readonly limits?: Partial<ServerLimits>;
  readonly log?: (event: LocalEvent) => void;
  /**
   * Tests only: starts every timer the server uses, so a test sees exactly which deadlines each
   * connection holds and can fire them itself. Default: `nodeTimers`.
   */
  readonly timers?: StartTimer;
}

export interface LocalServer {
  readonly path: string;
  /** Open connections, authenticated or not. */
  readonly connectionCount: number;
  /**
   * Stops listening and closes every connection. Resolves when all are closed. With `graceMs`
   * (the hub's drain, A2 3.3.1), connections first finish for up to that long: one that is not
   * authenticated ends at once, an rpc connection reads no new request and ends once its requests
   * in flight are answered and sent, an mcp connection ends once its output is sent. What is still
   * open after the grace is destroyed.
   */
  close(options?: { readonly graceMs?: number }): Promise<void>;
}

function checkListenPath(path: string): void {
  if (typeof path !== "string" || path === "") throw new TypeError("The endpoint path is empty");
  if (process.platform === "win32") {
    if (!/^\\\\[.?]\\pipe\\[^\\]+$/.test(path)) {
      throw new TypeError("On Windows the endpoint is a named pipe: \\\\.\\pipe\\<name>");
    }
  } else if (Buffer.byteLength(path, "utf8") > MAX_SOCKET_PATH_BYTES) {
    throw new TypeError(`A socket path holds at most ${String(MAX_SOCKET_PATH_BYTES)} bytes`);
  }
}

function protocolList(range: { min: number; max: number }): number[] {
  const { min, max } = range;
  if (!isProtocolNumber(min) || !isProtocolNumber(max) || min > max || max - min >= MAX_PROTOCOLS) {
    throw new TypeError("Invalid protocol range");
  }
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

const CLOSE_GRACE_MS = 1_000;

/**
 * Output goes to the socket in pieces of at most this size, so each piece the socket finishes is
 * progress the output deadline can see, however long the line.
 */
const PIECE_BYTES = 64 * 1024;

/** A line in the outbox. `sent` bytes of it are already with the socket. */
interface Waiting {
  readonly data: Buffer;
  sent: number;
  readonly offered: boolean;
}

/** State shared by every connection of one server. */
interface Shared {
  readonly options: ServeOptions;
  readonly key: Buffer;
  readonly limits: ServerLimits;
  readonly protocols: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly connections: Set<Connection>;
  pending: number;
  nextId: number;
  readonly timers: StartTimer;
  log(event: LocalEvent): void;
}

/**
 * Listens on `options.path` and serves `ttasks-local/1`. Rejects when the path is in use (a live
 * socket or pipe of that name): the hub then picks a new name (A2 3.4).
 */
export async function serve(options: ServeOptions): Promise<LocalServer> {
  checkListenPath(options.path);
  checkKey(options.key);
  if (!isInstanceId(options.instance)) throw new TypeError("Invalid instance ID");
  const range = options.protocols ?? { min: PROTOCOL, max: PROTOCOL };
  const shared: Shared = {
    options,
    key: Buffer.from(options.key),
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    protocols: protocolList(range),
    min: range.min,
    max: range.max,
    connections: new Set(),
    pending: 0,
    nextId: 1,
    timers: options.timers ?? nodeTimers,
    log: (event) => {
      try {
        options.log?.(event);
      } catch {
        // Logging never breaks a connection.
      }
    },
  };

  const server = net.createServer({ pauseOnConnect: false }, (socket) => {
    const { limits } = shared;
    if (shared.pending >= limits.maxPending || shared.connections.size >= limits.maxConnections) {
      shared.log({ ev: "local.handshake_failed", stage: "accept", reason: "capacity" });
      socket.on("error", () => undefined);
      socket.destroy();
      return;
    }
    const connection = new Connection(shared, socket);
    connection.start();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(options.path, () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    // A failed accept, such as a pipe instance Windows would not create, can leave the endpoint
    // with nothing to connect to while the service runs on: its code is what explains that.
    shared.log({ ev: "local.listen_error", code: error.code ?? "EIO" });
  });

  const unsubscribe = options.grants?.onRevoke((grantId) => {
    for (const connection of [...shared.connections]) connection.revoked(grantId);
  });

  let closing: Promise<void> | undefined;
  return {
    path: options.path,
    get connectionCount() {
      return shared.connections.size;
    },
    close(closeOptions = {}) {
      closing ??= (async () => {
        unsubscribe?.();
        const stopped = new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        const open = [...shared.connections];
        const grace = closeOptions.graceMs ?? 0;
        if (grace > 0) {
          for (const connection of open) connection.finish();
          let expire: () => void = () => undefined;
          const expired = new Promise<void>((resolve) => {
            expire = resolve;
          });
          const timer = shared.timers({ kind: "grace", conn: undefined, ms: grace }, () => {
            expire();
          });
          await Promise.race([Promise.all(open.map((connection) => connection.closed)), expired]);
          timer.clear();
        }
        for (const connection of open) connection.destroy();
        await Promise.all([stopped, ...open.map((connection) => connection.closed)]);
      })();
      return closing;
    },
  };
}

type Phase = "hello" | "bind" | "binding" | "rpc" | "mcp" | "closing" | "closed";
type PauseReason = "binding" | "drain";

/** One accepted connection and its handshake state. */
class Connection {
  readonly #shared: Shared;
  readonly #socket: net.Socket;
  readonly #decoder: LineDecoder;
  readonly #serverNonce = randomToken();
  readonly #id: number;
  readonly #started = performance.now();
  readonly #inflight = new Map<string, AbortController>();
  readonly #pauses = new Set<PauseReason>();
  /** Lines waiting for the peer to read, in order. See #write. */
  readonly #outbox: Waiting[] = [];
  /** Bytes in the outbox that the service offered rather than answered. */
  #offeredBytes = 0;
  /** The output deadline: runs while output waits, restarts when the socket takes bytes. */
  #stallTimer: ServerTimer | undefined;
  readonly #drainWaiters: (() => void)[] = [];
  #phase: Phase = "hello";
  #authenticated = false;
  #ids: HandshakeIds | undefined;
  #ks: Buffer | undefined;
  #transcript = "";
  #info: ConnectionInfo | undefined;
  #grant: string | undefined;
  #channel: McpChannelImpl | undefined;
  #handshakeTimer: ServerTimer | undefined;
  #closeTimer: ServerTimer | undefined;
  /** The server drains: no new request is read, and the connection ends when none is in flight. */
  #finishing = false;
  #resolveClosed: () => void = () => undefined;
  /** Resolves once the socket closed and the connection let go of everything it held. */
  readonly closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });

  constructor(shared: Shared, socket: net.Socket) {
    this.#shared = shared;
    this.#socket = socket;
    this.#decoder = new LineDecoder(shared.limits.helloMaxBytes);
    this.#id = shared.nextId++;
  }

  start(): void {
    const shared = this.#shared;
    shared.connections.add(this);
    shared.pending += 1;
    const socket = this.#socket;
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.#closed();
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        this.#data(chunk);
      } catch {
        this.destroy();
      }
    });
    socket.on("drain", () => {
      this.#pump(true);
    });
    this.#handshakeTimer = this.#timer("handshake", shared.limits.handshakeTimeoutMs, () => {
      this.#fail(this.#phase === "hello" ? "hello" : "bind", "timeout", true);
    });
    // The challenge is the only thing a peer gets before its proof verifies.
    this.#write(
      encodeLine(
        challengeMessage({
          nonce: this.#serverNonce,
          instance: shared.options.instance,
          protocols: shared.protocols,
        }),
      ),
    );
  }

  /**
   * The server drains (close with a grace). A connection that is not authenticated ends now. An
   * rpc connection keeps reading, so `$/cancel` for a request in flight still arrives, but answers
   * every new request with `service_unavailable`, and ends, its output sent, once no request is in
   * flight: so the reply to `service/shutdown` reaches its caller. An mcp connection ends once its
   * output is sent.
   */
  finish(): void {
    switch (this.#phase) {
      case "rpc":
        this.#finishing = true;
        if (this.#inflight.size === 0) this.#end();
        return;
      case "mcp":
        this.#end();
        return;
      case "closing":
      case "closed":
        return;
      default:
        this.destroy();
    }
  }

  /**
   * Ends the connection now. The connection is terminal at once, before the socket's close event:
   * nothing buffered is dispatched, handlers in flight are aborted, and a bind hook that resolves
   * later initialises nothing.
   */
  destroy(): void {
    if (this.#phase !== "closed") this.#phase = "closing";
    this.#stopStall();
    this.#decoder.clear();
    for (const controller of this.#inflight.values()) controller.abort();
    this.#socket.destroy();
  }

  revoked(grantId: string): void {
    if (this.#grant !== grantId) return;
    this.#shared.log({ ev: "local.revoked", conn: this.#id });
    this.destroy();
  }

  // --- reading

  #data(chunk: Buffer): void {
    if (this.#phase === "closing" || this.#phase === "closed") return;
    this.#decoder.push(chunk);
    this.#drain();
  }

  #drain(): void {
    while (this.#pauses.size === 0 && this.#reading()) {
      const frame = this.#decoder.next();
      if (frame === undefined) return;
      this.#frame(frame);
    }
  }

  #reading(): boolean {
    const phase = this.#phase;
    return phase === "hello" || phase === "bind" || phase === "rpc" || phase === "mcp";
  }

  #pause(reason: PauseReason): void {
    this.#pauses.add(reason);
    this.#socket.pause();
  }

  #resume(reason: PauseReason): void {
    if (!this.#pauses.delete(reason) || this.#pauses.size > 0) return;
    if (!this.#reading()) return;
    this.#socket.resume();
    try {
      this.#drain();
    } catch {
      this.destroy();
    }
  }

  #frame(frame: Frame): void {
    switch (this.#phase) {
      case "hello":
        this.#hello(frame);
        return;
      case "bind":
        this.#bind(frame);
        return;
      case "rpc":
        this.#rpcFrame(frame);
        return;
      case "mcp":
        this.#mcpFrame(frame);
        return;
      default:
        return;
    }
  }

  // --- the handshake

  #hello(frame: Frame): void {
    if ("error" in frame) {
      this.#fail("hello", frame.error === "frame_too_large" ? "too_large" : frame.error);
      return;
    }
    // A client sends nothing after its hello until it has verified the service's proof.
    if (this.#decoder.buffered > 0) {
      this.#fail("hello", "pipelined");
      return;
    }
    const hello = parseHello(frame.line);
    if (hello === undefined) {
      this.#fail("hello", "bad_hello");
      return;
    }
    const shared = this.#shared;
    const ids: HandshakeIds = {
      instance: shared.options.instance,
      protocol: hello.protocol,
      mode: hello.mode,
      serverNonce: this.#serverNonce,
      clientNonce: hello.nonce,
    };
    if (!proofMatches(hello.proof, clientProof(shared.key, ids))) {
      this.#fail("hello", "bad_proof");
      return;
    }
    this.#ids = ids;
    this.#phase = "bind";
    this.#decoder.max = shared.limits.bindMaxBytes;
    this.#write(encodeLine(proofMessage(proofToText(serverProof(shared.key, ids)))));
  }

  #bind(frame: Frame): void {
    const ids = this.#ids;
    if (ids === undefined) return;
    if ("error" in frame) {
      this.#fail("bind", frame.error === "frame_too_large" ? "too_large" : frame.error);
      return;
    }
    const bind = parseBind(frame.line);
    if (bind === undefined) {
      this.#fail("bind", "bad_bind");
      return;
    }
    const shared = this.#shared;
    const ks = sessionKey(shared.key, ids);
    let transcript: string;
    try {
      transcript = transcriptHash(ids, shared.protocols, bind.body);
    } catch {
      this.#fail("bind", "bad_bind");
      return;
    }
    // The mac first: a protocol, mode or context changed on the way fails here.
    if (!proofMatches(bind.mac, bindProof(ks, transcript))) {
      this.#fail("bind", "bad_bind_mac");
      return;
    }
    const { body } = bind;
    if (body.protocol !== ids.protocol || body.mode !== ids.mode) {
      this.#fail("bind", "bind_mismatch");
      return;
    }
    this.#authenticated = true;
    shared.pending -= 1;
    this.#handshakeTimer?.clear();
    this.#ks = ks;
    this.#transcript = transcript;
    this.#decoder.max = shared.limits.maxLineBytes;

    if (body.protocol < shared.min) {
      this.#refuseBind("client_too_old");
      return;
    }
    if (body.protocol > shared.max) {
      this.#refuseBind("service_too_old");
      return;
    }
    const client = parseClientInfo(body.client);
    const context = isObject(body.context) ? body.context : undefined;
    const cls = client === undefined ? undefined : classify(body.mode, client, context);
    if (client === undefined || context === undefined || cls === undefined) {
      this.#refuseBind("invalid_bind");
      return;
    }
    if (body.mode === "mcp" && shared.options.mcp === undefined) {
      this.#refuseBind("mode_unsupported");
      return;
    }
    const info: ConnectionInfo = {
      id: this.#id,
      class: cls,
      mode: body.mode,
      protocol: body.protocol,
      client,
      context,
    };
    this.#info = info;
    this.#phase = "binding";
    this.#pause("binding");
    this.#answerBind(info).catch(() => {
      this.destroy();
    });
  }

  async #answerBind(info: ConnectionInfo): Promise<void> {
    const shared = this.#shared;
    let answer: BindAnswer;
    try {
      answer = (await shared.options.bind?.(info)) ?? {};
    } catch {
      this.#fail("bind", "bind_failed", true);
      return;
    }
    if (this.#phase !== "binding") return; // closed while the hook ran
    // The row is checked and tied to the connection in one synchronous step: a revocation before
    // it shows in the row, and one after it finds the connection holding the row.
    const grant = answer.grant;
    if (grant !== undefined) {
      const row = shared.options.grants?.get(grant);
      if (row === undefined || !isLive(row)) {
        this.#fail("bind", "grant_not_live", true);
        return;
      }
      this.#grant = grant;
    }
    const result: JsonObject = {
      protocol: info.protocol,
      service: { ...shared.options.service, instance: shared.options.instance },
      capabilities: [...(shared.options.capabilities ?? [])],
      spaces: [...(answer.spaces ?? [])],
      binding: answer.binding ?? null,
    };
    if (!this.#sendBindResult(result)) {
      this.#fail("bind", "bind_failed", true);
      return;
    }
    shared.log({
      ev: "local.bound",
      conn: this.#id,
      class: info.class,
      mode: info.mode,
      kind: info.client.kind,
      protocol: info.protocol,
      ms: Math.round(performance.now() - this.#started),
    });
    if (info.mode === "mcp") {
      const channel = new McpChannelImpl(
        info,
        (line) => this.#mcpSend(line),
        () => this.#drained(),
        () => {
          this.#end();
        },
      );
      this.#channel = channel;
      this.#phase = "mcp";
      shared.options.mcp?.(channel);
    } else {
      this.#phase = "rpc";
    }
    this.#resume("binding");
  }

  /**
   * Sends the bind result with `Ms`. The proof covers the result as the client will parse it
   * (JSON drops undefined fields and writes holes as null), the same rule the client follows for
   * the bind body. False when it cannot be written as one line.
   */
  #sendBindResult(result: JsonObject): boolean {
    const ks = this.#ks;
    if (ks === undefined) return false;
    try {
      const wire = JSON.parse(JSON.stringify(result)) as JsonObject;
      const mac = proofToText(boundProof(ks, this.#transcript, wire));
      this.#write(encodeLine(bindResultMessage(wire, mac), this.#shared.limits.maxLineBytes));
      return true;
    } catch {
      return false;
    }
  }

  /** An authenticated refusal: the result carries the reason and its proof, then the service closes. */
  #refuseBind(reason: RefusalReason): void {
    const shared = this.#shared;
    shared.log({ ev: "local.bind_refused", reason });
    this.#sendBindResult({
      protocol: shared.max,
      service: { ...shared.options.service, instance: shared.options.instance },
      refused: { reason, min: shared.min, max: shared.max },
    });
    this.#end();
  }

  /**
   * Refuses a handshake: nothing more is read or written, and the socket closes after the fixed
   * delay, or at once for a timeout.
   */
  #fail(stage: Stage, reason: HandshakeFailure, now = false): void {
    if (this.#phase === "closing" || this.#phase === "closed") return;
    this.#shared.log({ ev: "local.handshake_failed", stage, reason });
    this.#phase = "closing";
    this.#handshakeTimer?.clear();
    this.#stopStall();
    this.#socket.pause();
    this.#decoder.clear();
    if (now) {
      this.destroy();
      return;
    }
    this.#closeTimer = this.#timer("refusal", this.#shared.limits.refusalDelayMs, () => {
      this.destroy();
    });
  }

  /** Ends an authenticated connection after what was written, waiting lines included, is sent. */
  #end(): void {
    if (this.#phase === "closing" || this.#phase === "closed") return;
    this.#phase = "closing";
    this.#stopStall();
    this.#socket.pause();
    this.#decoder.clear();
    // The close timer below bounds this, so the output deadline no longer runs.
    for (const waiting of this.#outbox.splice(0)) {
      this.#socket.write(waiting.data.subarray(waiting.sent));
    }
    this.#offeredBytes = 0;
    this.#socket.end();
    this.#closeTimer = this.#timer("close", CLOSE_GRACE_MS, () => {
      this.destroy();
    });
  }

  #closed(): void {
    if (this.#phase === "closed") return;
    const wasPhase = this.#phase;
    this.#phase = "closed";
    this.#handshakeTimer?.clear();
    this.#closeTimer?.clear();
    this.#stopStall();
    this.#decoder.clear();
    const shared = this.#shared;
    shared.connections.delete(this);
    if (!this.#authenticated) {
      shared.pending -= 1;
      if (wasPhase === "hello" || wasPhase === "bind") {
        shared.log({ ev: "local.handshake_failed", stage: wasPhase, reason: "closed" });
      }
    }
    for (const controller of this.#inflight.values()) controller.abort();
    this.#inflight.clear();
    this.#outbox.length = 0;
    this.#offeredBytes = 0;
    for (const resolve of this.#drainWaiters.splice(0)) resolve();
    const channel = this.#channel;
    this.#channel = undefined;
    try {
      channel?.closed();
    } catch {
      // The hub's close handler failed. The connection is gone either way.
    }
    this.#resolveClosed();
  }

  /**
   * Every write goes through here, in order. Lines go to the socket in pieces (PIECE_BYTES) while
   * it takes them. While it is backed up, the rest waits in the outbox and the service reads
   * nothing more from this peer. Two bounds hold what waits:
   * - in size: lines the service offers (`notify`, mcp lines) count toward `maxQueuedBytes`. A
   *   producer that waits for `drained()` when a send returns false keeps at most one line
   *   waiting. Past the bound the peer is treated as not reading (`slow_reader`). Answers (the
   *   handshake, replies, errors) do not count: the peer asked for them, the in-flight limit
   *   bounds how many can be due at once and the line limit how large each is;
   * - in time: the output deadline (#watchOutput). While anything waits, the socket must take
   *   some of it within `outputStallMs`, or the peer is not reading (`slow_reader`).
   * False when the line had to wait.
   */
  #write(text: string, offered = false): boolean {
    const socket = this.#socket;
    if (socket.destroyed || !socket.writable) return false;
    const data = Buffer.from(text, "utf8");
    this.#outbox.push({ data, sent: 0, offered });
    if (offered) this.#offeredBytes += data.length;
    this.#pump(false);
    if (offered && this.#offeredBytes > this.#shared.limits.maxQueuedBytes) {
      this.#slowReader();
      return false;
    }
    return this.#outbox.length === 0 && !socket.writableNeedDrain;
  }

  /**
   * Hands waiting lines to the socket, piece by piece, until it backs up or the outbox is empty.
   * Called for every write and on every drain; `drained` says the socket just took everything.
   */
  #pump(drained: boolean): void {
    const socket = this.#socket;
    if (socket.destroyed || !socket.writable) return;
    while (!socket.writableNeedDrain) {
      const head = this.#outbox[0];
      if (head === undefined) break;
      const end = Math.min(head.sent + PIECE_BYTES, head.data.length);
      const piece = head.data.subarray(head.sent, end);
      head.sent = end;
      if (head.offered) this.#offeredBytes -= piece.length;
      if (end === head.data.length) this.#outbox.shift();
      socket.write(piece, this.#tookPiece);
    }
    if (this.#outbox.length === 0 && !socket.writableNeedDrain) {
      for (const resolve of this.#drainWaiters.splice(0)) resolve();
      // Only a drain resumes reading: a write never runs the reader inside a reply.
      if (drained) this.#resume("drain");
    } else {
      this.#pause("drain");
    }
    this.#watchOutput(drained);
  }

  /** A piece's write callback: the socket took it, which is progress. */
  readonly #tookPiece = (error?: Error | null): void => {
    if (error == null) this.#watchOutput(true);
  };

  /**
   * Keeps the output deadline: it runs while output waits (in the outbox or the socket's own
   * buffer), starts again when the socket takes bytes (`progress`), and stops when nothing waits.
   * New output does not restart it, so a producer cannot keep a peer that reads nothing alive.
   */
  #watchOutput(progress: boolean): void {
    const socket = this.#socket;
    const phase = this.#phase;
    const waiting = this.#outbox.length > 0 || socket.writableLength > 0;
    if (!waiting || socket.destroyed || phase === "closing" || phase === "closed") {
      this.#stopStall();
      return;
    }
    if (this.#stallTimer === undefined) {
      this.#stallTimer = this.#timer("output", this.#shared.limits.outputStallMs, () => {
        this.#stallTimer = undefined;
        this.#slowReader();
      });
    } else if (progress) {
      this.#stallTimer.refresh();
    }
  }

  #stopStall(): void {
    this.#stallTimer?.clear();
    this.#stallTimer = undefined;
  }

  /** Starts one of this connection's timers. */
  #timer(kind: TimerKind, ms: number, fire: () => void): ServerTimer {
    return this.#shared.timers({ kind, conn: this.#id, ms }, fire);
  }

  /** The peer does not read what it is sent: the connection ends now. */
  #slowReader(): void {
    if (this.#phase === "closing" || this.#phase === "closed") return;
    this.#shared.log({ ev: "local.slow_reader", conn: this.#id });
    this.destroy();
  }

  /** Resolves once every waiting line has been handed to the socket, or the connection closed. */
  #drained(): Promise<void> {
    const socket = this.#socket;
    if (socket.destroyed || (this.#outbox.length === 0 && !socket.writableNeedDrain)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  #tooLarge(): void {
    this.#shared.log({ ev: "local.frame_too_large", conn: this.#id });
    this.#write(
      encodeLine({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_ERROR.invalidRequest, message: FRAME_TOO_LARGE },
      }),
    );
    this.#end();
  }

  // --- mcp mode

  #mcpFrame(frame: Frame): void {
    if ("line" in frame) {
      this.#channel?.deliver(frame.line);
    } else if (frame.error === "frame_too_large") {
      this.#tooLarge();
    }
    // A line that is not UTF-8 is not an MCP message: it is dropped.
  }

  #mcpSend(line: string): boolean {
    if (this.#phase !== "mcp") return false;
    if (line.includes("\n")) throw new TypeError("A message line must not hold a newline");
    if (Buffer.byteLength(line, "utf8") > this.#shared.limits.maxLineBytes) {
      throw new FrameSizeError();
    }
    return this.#write(`${line}\n`, true);
  }

  // --- rpc mode

  #rpcFrame(frame: Frame): void {
    if ("error" in frame) {
      if (frame.error === "frame_too_large") {
        this.#tooLarge();
      } else {
        this.#replyError(null, RPC_ERROR.parse, "Parse error");
      }
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(frame.line);
    } catch {
      this.#replyError(null, RPC_ERROR.parse, "Parse error");
      return;
    }
    if (!isObject(message)) {
      this.#replyError(null, RPC_ERROR.invalidRequest, "Invalid request");
      return;
    }
    const { method, id, params } = message;
    if (message["jsonrpc"] !== "2.0") {
      this.#replyError(isRequestId(id) ? id : null, RPC_ERROR.invalidRequest, "Invalid request");
      return;
    }
    if (method === undefined) {
      // A response, with exactly one of result and error, is not answered: the service sends rpc
      // clients no requests. Anything else without a method is not a request either.
      if (Object.hasOwn(message, "result") !== Object.hasOwn(message, "error")) return;
      this.#replyError(isRequestId(id) ? id : null, RPC_ERROR.invalidRequest, "Invalid request");
      return;
    }
    if (typeof method !== "string") {
      this.#replyError(isRequestId(id) ? id : null, RPC_ERROR.invalidRequest, "Invalid request");
      return;
    }
    if (id === undefined) {
      this.#notification(method, params);
      return;
    }
    if (!isRequestId(id)) {
      this.#replyError(null, RPC_ERROR.invalidRequest, "Invalid request");
      return;
    }
    if (params !== undefined && !isObject(params)) {
      this.#replyError(id, RPC_ERROR.invalidParams, "Params must be an object");
      return;
    }
    this.#dispatch(id, method, params ?? {});
  }

  #notification(method: string, params: unknown): void {
    if (method !== METHOD.cancel || !isObject(params)) return;
    const target = params["id"];
    if (isRequestId(target)) this.#inflight.get(requestKey(target))?.abort();
  }

  #dispatch(id: RequestId, method: string, params: JsonObject): void {
    const info = this.#info;
    if (info === undefined) return;
    if (this.#finishing) {
      // The server drains: no new work. The client may retry once the service runs again.
      const error = new AppError({
        code: "service_unavailable",
        message: "The service is stopping.",
        data: { reason: "not_running", retryable: true },
      });
      this.#replyError(id, RPC_ERROR.app, error.message, error.toBody());
      return;
    }
    const handler = isRpcMethod(method) ? this.#shared.options.handlers?.[method] : undefined;
    if (!isRpcMethod(method) || handler === undefined) {
      this.#replyError(id, RPC_ERROR.methodNotFound, "Method not found");
      return;
    }
    if (!mayCall(info.class, method)) {
      const error = new AppError({
        code: "forbidden",
        ...refusalOf(info.class, method),
        data: { reason: "connection_class", class: info.class },
      });
      this.#replyError(id, RPC_ERROR.app, error.message, error.toBody());
      return;
    }
    const key = requestKey(id);
    if (this.#inflight.has(key)) {
      this.#replyError(id, RPC_ERROR.invalidRequest, "A request with this id is in flight");
      return;
    }
    // Refused at once, not by pausing: reading goes on, so `$/cancel` for the requests in flight
    // always arrives. The client library never sends more than MAX_IN_FLIGHT at once.
    const max = this.#shared.limits.maxInFlight;
    if (this.#inflight.size >= max) {
      const error = new AppError({
        code: "too_large",
        message: "Too many requests are in flight on this connection.",
        data: { reason: "in_flight", max },
      });
      this.#replyError(id, RPC_ERROR.app, error.message, error.toBody());
      return;
    }
    const controller = new AbortController();
    this.#inflight.set(key, controller);
    const context: RpcContext = {
      connection: info,
      signal: controller.signal,
      notify: (name, payload = {}) => {
        if (this.#phase !== "rpc") return false;
        return this.#write(
          encodeLine(
            { jsonrpc: "2.0", method: name, params: payload },
            this.#shared.limits.maxLineBytes,
          ),
          true,
        );
      },
      drained: () => this.#drained(),
    };
    void (async () => {
      try {
        const value: unknown = await handler(params, context);
        this.#reply(id, value);
      } catch (error) {
        this.#handlerError(id, method, error, controller.signal);
      } finally {
        if (this.#inflight.get(key) === controller) this.#inflight.delete(key);
        // A draining server ends the connection once its last answer is written.
        if (this.#finishing && this.#inflight.size === 0) this.#end();
      }
    })();
  }

  #reply(id: RequestId, value: unknown): void {
    if (this.#phase !== "rpc") return;
    let line: string;
    try {
      line = encodeLine(
        { jsonrpc: "2.0", id, result: value ?? null },
        this.#shared.limits.maxLineBytes,
      );
    } catch (error) {
      const body =
        error instanceof FrameSizeError
          ? new AppError({ code: "too_large", message: "The result is over the line limit." })
          : new AppError({ code: "internal", message: "The result could not be sent." });
      this.#replyError(id, RPC_ERROR.app, body.message, body.toBody());
      return;
    }
    this.#write(line);
  }

  #handlerError(id: RequestId, method: RpcMethod, error: unknown, signal: AbortSignal): void {
    if (error instanceof AppError) {
      this.#replyError(id, RPC_ERROR.app, error.message, error.toBody());
    } else if (error instanceof RpcError) {
      this.#replyError(id, error.code, error.message, error.data);
    } else if (signal.aborted) {
      this.#replyError(id, RPC_ERROR.cancelled, "Request cancelled");
    } else {
      // Nothing from the error reaches the peer or the log: it may hold content.
      this.#shared.log({ ev: "local.handler_failed", conn: this.#id, method });
      this.#replyError(id, RPC_ERROR.internal, "Internal error");
    }
  }

  #replyError(id: RequestId | null, code: number, message: string, data?: unknown): void {
    if (this.#phase !== "rpc") return;
    const error = data === undefined ? { code, message } : { code, message, data };
    let line: string;
    try {
      line = encodeLine({ jsonrpc: "2.0", id, error }, this.#shared.limits.maxLineBytes);
    } catch {
      line = encodeLine({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERROR.internal, message: "Internal error" },
      });
    }
    this.#write(line);
  }
}

type RequestId = string | number;

const MAX_ID_LENGTH = 128;

function isRequestId(value: unknown): value is RequestId {
  return (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && value.length <= MAX_ID_LENGTH)
  );
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

class McpChannelImpl implements McpChannel {
  readonly connection: ConnectionInfo;
  onLine: ((line: string) => void) | undefined;
  onClose: (() => void) | undefined;
  readonly #send: (line: string) => boolean;
  readonly #drained: () => Promise<void>;
  readonly #close: () => void;

  constructor(
    connection: ConnectionInfo,
    send: (line: string) => boolean,
    drained: () => Promise<void>,
    close: () => void,
  ) {
    this.connection = connection;
    this.#send = send;
    this.#drained = drained;
    this.#close = close;
  }

  send(line: string): boolean {
    return this.#send(line);
  }

  drained(): Promise<void> {
    return this.#drained();
  }

  close(): void {
    this.#close();
  }

  deliver(line: string): void {
    this.onLine?.(line);
  }

  closed(): void {
    this.onClose?.();
  }
}
