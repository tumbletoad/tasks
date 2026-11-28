// The client side of `ttasks-local/1`: connect to the socket or pipe, verify the
// challenge, send only the hello, verify the service's proof, and only then send the bind frame
// with the context and verify the bind result. The CLI, the shim and the bridge
// build on it. It imports only Node built-ins, so the bridge bundle stays small.
import net from "node:net";
import {
  BIND_MAX_BYTES,
  CONNECT_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  HELLO_MAX_BYTES,
  MAX_IN_FLIGHT,
  MAX_LINE_BYTES,
  MAX_SOCKET_PATH_BYTES,
  METHOD,
  PROTOCOL,
  RPC_ERROR,
  isContextEnvName,
  type Mode,
} from "./constants.ts";
import { LocalError, RpcError, type TransportReason } from "./errors.ts";
import { LineDecoder, encodeLine, type Frame } from "./framing.ts";
import { canonicalJson } from "./jcs.ts";
import {
  bindMessage,
  helloMessage,
  isMode,
  isObject,
  parseBindResult,
  parseChallenge,
  parseLine,
  parseProof,
  type ClientInfo,
  type JsonObject,
} from "./messages.ts";
import {
  bindProof,
  boundProof,
  checkKey,
  clientProof,
  proofMatches,
  proofToText,
  randomToken,
  serverProof,
  sessionKey,
  transcriptHash,
  type BindBody,
  type HandshakeIds,
} from "./proofs.ts";

export interface ConnectOptions {
  /** The socket path or pipe name: `endpoint.path` from `service.json`. */
  readonly path: string;
  /** The 32 bytes of `ipc.key`. Read it for every connection, so a key rotation needs nothing else. */
  readonly key: Uint8Array;
  readonly mode: Mode;
  readonly client: ClientInfo;
  /** The bind context. Sent only after the service's proof verified. */
  readonly context: JsonObject;
  /** From the connect call to the connection. */
  readonly connectTimeoutMs?: number;
  /** From the connection to a verified bind result. */
  readonly handshakeTimeoutMs?: number;
  /** Aborting destroys the socket at once and rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** The protocol this client names. Tests only: the default is PROTOCOL. */
  readonly protocol?: number;
}

/** The verified bind result, without its mac. */
export interface Bound {
  readonly protocol: number;
  readonly service: { readonly version: string; readonly build: string; readonly instance: string };
  readonly capabilities: readonly string[];
  readonly spaces: readonly unknown[];
  readonly binding: unknown;
}

/** Placeholder of a mac's length, to size the bind frame before connecting. */
const MAC_PLACEHOLDER = "A".repeat(43);

/** The environment values an rpc client sends in `context.env`: the agent markers and TTASKS_SPACE. */
export function rpcContextEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isContextEnvName(name)) picked[name] = value;
  }
  return picked;
}

// ---------------------------------------------------------------------------------------------
// Reading lines from the socket

type FrameHandler = (frame: Frame) => void;

/** Lines from a socket, read one at a time during the handshake and handed to a handler after. */
class SocketLines {
  readonly decoder: LineDecoder;
  #waiter: ((frame: Frame | null) => void) | undefined;
  #handler: FrameHandler | undefined;
  #onEnd: (() => void) | undefined;
  #ended = false;

  constructor(socket: net.Socket, max: number) {
    this.decoder = new LineDecoder(max);
    socket.on("data", (chunk: Buffer) => {
      this.decoder.push(chunk);
      this.#drain();
    });
    socket.on("close", () => {
      this.#ended = true;
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter?.(null);
      this.#onEnd?.();
    });
  }

  /** The next frame, or null once the socket closed and no complete line is left. */
  next(): Promise<Frame | null> {
    const frame = this.decoder.next();
    if (frame !== undefined) return Promise.resolve(frame);
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve) => (this.#waiter = resolve));
  }

  /** Hands every later frame to `handler`, starting with any already buffered. */
  handOver(handler: FrameHandler, onEnd: () => void): void {
    this.#handler = handler;
    this.#onEnd = onEnd;
    this.#drain();
    if (this.#ended) onEnd();
  }

  #drain(): void {
    for (;;) {
      if (this.#handler !== undefined) {
        const frame = this.decoder.next();
        if (frame === undefined) return;
        this.#handler(frame);
        if ("error" in frame && frame.error === "frame_too_large") return;
        continue;
      }
      const waiter = this.#waiter;
      if (waiter === undefined) return;
      const frame = this.decoder.next();
      if (frame === undefined) return;
      this.#waiter = undefined;
      waiter(frame);
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Connecting and the handshake

/** A connection whose handshake completed: hand it to RpcSession or LineSession. */
export interface Connected {
  readonly socket: net.Socket;
  readonly lines: SocketLines;
  readonly bound: Bound;
}

function connectFailure(error: NodeJS.ErrnoException): LocalError {
  const code = typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "";
  if (code === "ENOENT" || code === "ECONNREFUSED") return new LocalError("not_running", code);
  if (code === "EACCES" || code === "EPERM") return new LocalError("unreachable", code);
  return new LocalError("unreachable", code === "" ? "connect_failed" : code);
}

function checkPath(path: string): void {
  if (typeof path !== "string" || path === "") throw new TypeError("The endpoint path is empty");
  if (process.platform !== "win32" && Buffer.byteLength(path, "utf8") > MAX_SOCKET_PATH_BYTES) {
    throw new TypeError(`A socket path holds at most ${String(MAX_SOCKET_PATH_BYTES)} bytes`);
  }
}

function openSocket(path: string, timeoutMs: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    const done = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      if (error === undefined) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(error);
      }
    };
    const onConnect = () => {
      done();
    };
    const onError = (error: NodeJS.ErrnoException) => {
      done(connectFailure(error));
    };
    const onAbort = () => {
      done(abortReason(signal));
    };
    const timer = setTimeout(() => {
      done(new LocalError("unreachable", "connect_timeout"));
    }, timeoutMs);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The operation was aborted", "AbortError");
}

/** The bind body exactly as the service will parse it, so both sides hash the same values. */
function bindBody(options: ConnectOptions, protocol: number): BindBody {
  const raw = { protocol, mode: options.mode, client: options.client, context: options.context };
  const body = JSON.parse(JSON.stringify(raw)) as BindBody;
  canonicalJson(body); // throws for nesting the service would refuse
  encodeLine(bindMessage(body, MAC_PLACEHOLDER), BIND_MAX_BYTES); // throws over the bind limit
  return body;
}

/**
 * Connects and completes the handshake. Until the service's proof verifies, the only bytes sent
 * are the hello line: protocol, mode, nonce and proof. Rejects with LocalError:
 * - `not_running` or `unreachable` when the connection fails,
 * - `untrusted_endpoint` when an answer came and is wrong: a challenge, proof or bind result that
 *   does not verify, or bytes that are not the protocol,
 * - `connection_lost` when the connection ends or stalls, before an answer or after one: on a busy
 *   machine a service can take longer than the deadline. Before the proof only the hello was sent,
 *   so another try is safe either way. Limit: something else listening there that never answers
 *   reads as this, and is tried again rather than named,
 * - `restart_session` or `service_too_old` when the service refuses the protocol or mode.
 */
export async function connect(options: ConnectOptions): Promise<Connected> {
  checkPath(options.path);
  checkKey(options.key);
  if (!isMode(options.mode)) throw new TypeError("The mode is rpc or mcp");
  const protocol = options.protocol ?? PROTOCOL;
  const body = bindBody(options, protocol);
  const { signal } = options;
  if (signal?.aborted === true) throw abortReason(signal);

  const socket = await openSocket(
    options.path,
    options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    signal,
  );
  socket.on("error", () => {
    // The close that follows ends the handshake. Nothing is thrown from here.
  });
  const lines = new SocketLines(socket, HELLO_MAX_BYTES);
  let stage: "challenge" | "proof" | "bound" = "challenge";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    socket.destroy();
  }, options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  const onAbort = () => socket.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });

  const fail = (reason: TransportReason, detail: string): never => {
    socket.destroy();
    throw new LocalError(reason, detail);
  };
  /** The next line, or a failure for a close, a timeout or a broken frame. */
  const nextLine = async (): Promise<string> => {
    const frame = await lines.next();
    if (signal?.aborted === true) throw abortReason(signal);
    if (frame === null) return fail("connection_lost", timedOut ? "timeout" : "closed");
    if ("error" in frame)
      return fail(stage !== "bound" ? "untrusted_endpoint" : "connection_lost", frame.error);
    return frame.line;
  };

  try {
    // 1. The challenge. Nothing may follow it before the hello.
    const challenge = parseChallenge(await nextLine());
    if (challenge === undefined || lines.decoder.buffered > 0) {
      return fail("untrusted_endpoint", "bad_challenge");
    }
    // 2. The hello: protocol, mode, nonce and proof, nothing else.
    const ids: HandshakeIds = {
      instance: challenge.instance,
      protocol,
      mode: options.mode,
      serverNonce: challenge.nonce,
      clientNonce: randomToken(),
    };
    const proof = proofToText(clientProof(options.key, ids));
    socket.write(
      encodeLine(
        helloMessage({ protocol, mode: options.mode, nonce: ids.clientNonce, proof }),
        HELLO_MAX_BYTES,
      ),
    );
    stage = "proof";
    // 3. The service's proof, compared in constant time. Nothing may follow it before the bind.
    const received = parseProof(await nextLine());
    if (
      received === undefined ||
      lines.decoder.buffered > 0 ||
      !proofMatches(received, serverProof(options.key, ids))
    ) {
      return fail("untrusted_endpoint", "bad_proof");
    }
    // 4. Only now the bind frame with the context, authenticated with the session key.
    stage = "bound";
    lines.decoder.max = MAX_LINE_BYTES;
    const transcript = transcriptHash(ids, challenge.protocols, body);
    const ks = sessionKey(options.key, ids);
    socket.write(
      encodeLine(bindMessage(body, proofToText(bindProof(ks, transcript))), BIND_MAX_BYTES),
    );
    // 5. The bind result. Its mac is checked before any field is used.
    const reply = parseBindResult(await nextLine());
    if (reply === undefined) return fail("untrusted_endpoint", "bad_bind_result");
    let expected: Buffer;
    try {
      expected = boundProof(ks, transcript, reply.result);
    } catch {
      return fail("untrusted_endpoint", "bad_bind_result");
    }
    if (!proofMatches(reply.mac, expected)) return fail("untrusted_endpoint", "bad_bind_mac");
    const refused = reply.result["refused"];
    if (refused !== undefined) {
      const reason = isObject(refused) ? refused["reason"] : undefined;
      return fail(
        reason === "client_too_old" ? "restart_session" : "service_too_old",
        typeof reason === "string" && /^[a-z_]{1,40}$/.test(reason) ? reason : "refused",
      );
    }
    const bound = readBound(reply.result, protocol);
    if (bound === undefined) return fail("service_too_old", "bad_bind_result");
    return { socket, lines, bound };
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function readBound(result: JsonObject, protocol: number): Bound | undefined {
  const { service, capabilities, spaces, binding } = result;
  if (result["protocol"] !== protocol || !isObject(service)) return undefined;
  const { version, build, instance } = service;
  if (typeof version !== "string" || typeof build !== "string" || typeof instance !== "string") {
    return undefined;
  }
  if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === "string")) {
    return undefined;
  }
  if (!Array.isArray(spaces)) return undefined;
  return {
    protocol,
    service: { version, build, instance },
    capabilities: capabilities,
    spaces,
    binding: binding ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Closing

const CLOSE_GRACE_MS = 1_000;

function closeSocket(socket: net.Socket): void {
  if (socket.destroyed) return;
  socket.end();
  // end() waits for the peer. A silent peer must not keep the process alive.
  const timer = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
  timer.unref();
  socket.once("close", () => {
    clearTimeout(timer);
  });
}

/** Resolves once the socket's queued output has drained, or at once when nothing waits. */
function drained(socket: net.Socket): Promise<void> {
  if (socket.destroyed || !socket.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      socket.off("drain", done);
      socket.off("close", done);
      resolve();
    };
    socket.on("drain", done);
    socket.on("close", done);
  });
}

/**
 * The close handler of a session: called once, when the connection has ended and every message
 * before the end was delivered. A handler set after that is called at once.
 */
class CloseSignal {
  #handler: (() => void) | undefined;
  #due = false;
  #reported = false;

  get handler(): (() => void) | undefined {
    return this.#handler;
  }

  set handler(handler: (() => void) | undefined) {
    this.#handler = handler;
    this.#report();
  }

  /** The connection ended and nothing before the end is still waiting. */
  due(): void {
    this.#due = true;
    this.#report();
  }

  #report(): void {
    const handler = this.#handler;
    if (!this.#due || this.#reported || handler === undefined) return;
    this.#reported = true;
    handler();
  }
}

// ---------------------------------------------------------------------------------------------
// rpc mode

export interface CallOptions {
  /** A reply that does not come in time fails the call and closes the connection. */
  readonly timeoutMs?: number;
  /** Aborting sends `$/cancel` and rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * An rpc mode connection: requests with replies, notifications both ways. At most
 * MAX_IN_FLIGHT requests are on the wire at once. Later calls wait in order, and a call cancelled
 * while it waits never reaches the service.
 */
export class RpcSession {
  readonly bound: Bound;
  /**
   * Notifications from the service, for example `feed/event`. The service sends them only for a
   * request, so set this before the first call.
   */
  onNotification: ((method: string, params: unknown) => void) | undefined;
  readonly #socket: net.Socket;
  readonly #pending = new Map<number, Pending>();
  /** IDs sent and not yet answered by the service, cancelled ones included. */
  readonly #onWire = new Set<number>();
  /** Calls waiting for a free slot, in order. */
  readonly #waiting = new Map<number, string>();
  readonly #close = new CloseSignal();
  #nextId = 2;
  #closed = false;

  constructor(connected: Connected) {
    this.bound = connected.bound;
    this.#socket = connected.socket;
    connected.lines.handOver(
      (frame) => {
        this.#frame(frame);
      },
      () => {
        this.#end();
      },
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Called once when the connection ends, for any reason. Set after the end, it is called at once. */
  get onClose(): (() => void) | undefined {
    return this.#close.handler;
  }

  set onClose(handler: (() => void) | undefined) {
    this.#close.handler = handler;
  }

  call(method: string, params: JsonObject = {}, options: CallOptions = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(new LocalError("connection_lost", "closed"));
    const { signal, timeoutMs } = options;
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    const id = this.#nextId++;
    const line = encodeLine({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
        this.#waiting.delete(id);
      };
      const onAbort = () => {
        const sent = this.#onWire.has(id);
        settle();
        if (sent) this.notify(METHOD.cancel, { id });
        reject(abortReason(signal));
      };
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              settle();
              reject(new LocalError("connection_lost", "timeout"));
              this.close();
            }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      this.#waiting.set(id, line);
      this.#pump();
    });
  }

  /** Sends a notification. False when the output is backed up: wait for `drained()`. */
  notify(method: string, params: JsonObject = {}): boolean {
    if (this.#closed) return false;
    return this.#socket.write(encodeLine({ jsonrpc: "2.0", method, params }));
  }

  /** Resolves once the queued output has drained, or the connection closed. */
  drained(): Promise<void> {
    return drained(this.#socket);
  }

  close(): void {
    this.#closed = true;
    closeSocket(this.#socket);
  }

  /** Sends waiting calls while slots are free. */
  #pump(): void {
    for (const [id, line] of this.#waiting) {
      if (this.#closed || this.#onWire.size >= MAX_IN_FLIGHT) return;
      this.#waiting.delete(id);
      this.#onWire.add(id);
      this.#socket.write(line);
    }
  }

  #frame(frame: Frame): void {
    if ("error" in frame) {
      if (frame.error === "frame_too_large") this.#socket.destroy();
      return;
    }
    const message = parseLine(frame.line);
    if (message === undefined) return;
    const method = message["method"];
    if (typeof method === "string") {
      if (message["id"] === undefined) this.onNotification?.(method, message["params"]);
      return;
    }
    const id = message["id"];
    // Only a reply to a request on the wire counts. One for a call still waiting to be sent, or
    // for an ID never used, settles nothing and frees no slot.
    if (typeof id !== "number" || !this.#onWire.delete(id)) return;
    // The slot is free, whether or not the call still waits for its reply (a cancelled one does not).
    this.#pump();
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    const error = message["error"];
    if (error === undefined) {
      pending.resolve(message["result"] ?? null);
      return;
    }
    const code =
      isObject(error) && typeof error["code"] === "number" ? error["code"] : RPC_ERROR.internal;
    const text =
      isObject(error) && typeof error["message"] === "string" ? error["message"] : "Error";
    pending.reject(new RpcError(code, text, isObject(error) ? error["data"] : undefined));
  }

  #end(): void {
    this.#closed = true;
    for (const pending of [...this.#pending.values()]) {
      pending.reject(new LocalError("connection_lost", "closed"));
    }
    this.#pending.clear();
    this.#waiting.clear();
    this.#onWire.clear();
    this.#close.due();
  }
}

/** Connects in rpc mode and completes the handshake. */
export async function openRpc(options: Omit<ConnectOptions, "mode">): Promise<RpcSession> {
  return new RpcSession(await connect({ ...options, mode: "rpc" }));
}

// ---------------------------------------------------------------------------------------------
// mcp mode: after the bind result, every line is an unchanged MCP message

/**
 * An mcp mode connection: whole lines in both directions. The service may send lines right after
 * the bind result, in the same chunk. Lines that arrive before `onLine` is set wait for it, and
 * the close comes after the last line.
 */
export class LineSession {
  readonly bound: Bound;
  readonly #socket: net.Socket;
  readonly #close = new CloseSignal();
  #onLine: ((line: string) => void) | undefined;
  /** Lines received while no line handler was set, and their size in bytes. */
  #held: string[] = [];
  #heldBytes = 0;
  /** A flush is delivering held lines. Setting a handler then only swaps the one it calls. */
  #flushing = false;
  /** The consumer asked for no more lines until `resume()`. */
  #paused = false;
  #ended = false;
  #closed = false;

  constructor(connected: Connected) {
    this.bound = connected.bound;
    this.#socket = connected.socket;
    connected.lines.handOver(
      (frame) => {
        if ("line" in frame) this.#receive(frame.line);
        else if (frame.error === "frame_too_large") this.#socket.destroy();
      },
      () => {
        this.#ended = true;
        this.#closed = true;
        if (this.#held.length === 0) this.#close.due();
      },
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Each line from the service, in order. Lines that are not valid UTF-8 are dropped. Lines that
   * came before it was set are delivered when it is set.
   */
  get onLine(): ((line: string) => void) | undefined {
    return this.#onLine;
  }

  set onLine(handler: ((line: string) => void) | undefined) {
    this.#onLine = handler;
    if (!this.#flushing) this.#flush();
  }

  /**
   * Called once when the connection ends, for any reason, after the last line before the end.
   * Set after that, it is called at once.
   */
  get onClose(): (() => void) | undefined {
    return this.#close.handler;
  }

  set onClose(handler: (() => void) | undefined) {
    this.#close.handler = handler;
  }

  /**
   * Sends one message. The line must not hold a newline. False when the output is backed up:
   * wait for `drained()` before sending more.
   */
  send(line: string): boolean {
    if (line.includes("\n")) throw new TypeError("A message line must not hold a newline");
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      throw new TypeError("The message is longer than the line limit");
    }
    if (this.#closed) return false;
    return this.#socket.write(`${line}\n`);
  }

  /** Resolves once the queued output has drained, or the connection closed. */
  drained(): Promise<void> {
    return drained(this.#socket);
  }

  close(): void {
    this.#closed = true;
    closeSocket(this.#socket);
  }

  /**
   * Delivers no more lines until `resume()`, and stops reading from the service: for a consumer
   * whose own output is backed up, such as the bridge's stdout.
   * Lines already read wait in order, at most what one read brought, and the close still comes
   * after the last of them.
   */
  pause(): void {
    this.#paused = true;
    if (!this.#ended) this.#socket.pause();
  }

  /** Delivers the lines that waited, then reads from the service again. */
  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    if (!this.#flushing) this.#flush();
  }

  #receive(line: string): void {
    const handler = this.#onLine;
    if (handler !== undefined && this.#held.length === 0 && !this.#flushing && !this.#paused) {
      handler(line);
      return;
    }
    this.#held.push(line);
    this.#heldBytes += Buffer.byteLength(line, "utf8");
    // Nobody reads: stop reading from the service until a line handler takes the backlog.
    if (this.#paused || this.#heldBytes > MAX_LINE_BYTES) this.#socket.pause();
  }

  /** Delivers held lines in order. Never re-entered: a handler set meanwhile takes the next line. */
  #flush(): void {
    this.#flushing = true;
    try {
      for (;;) {
        const handler = this.#onLine;
        const line = this.#held[0];
        if (handler === undefined || line === undefined || this.#paused) break;
        this.#held.shift();
        this.#heldBytes -= Buffer.byteLength(line, "utf8");
        handler(line);
      }
    } finally {
      this.#flushing = false;
    }
    if (this.#held.length > 0) return;
    if (this.#ended) this.#close.due();
    else if (!this.#paused && this.#socket.isPaused()) this.#socket.resume();
  }
}

/** Connects in mcp mode and completes the handshake. */
export async function openLines(options: Omit<ConnectOptions, "mode">): Promise<LineSession> {
  return new LineSession(await connect({ ...options, mode: "mcp" }));
}
