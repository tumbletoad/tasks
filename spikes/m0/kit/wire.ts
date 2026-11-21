// Shared wire code of the M0 spike kit: `ttasks-local/1` framing and the mutual HMAC handshake of
// A2 3.6, at spike level. Lab code: never shipped, never imported by a package (A7 3.7).
//
// Like the product bridge (A2 3.7.1), this file imports only Node built-ins, so the forwarder and
// the shim that use it start about as fast as the real ones would (rows B01 and B07).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { isatty } from "node:tty";
import type { Readable, Writable } from "node:stream";

export const PROTOCOL = 1;
export const MAX_LINE = 8 * 1024 * 1024;
export const SPIKE_VERSION = "0.0.0-m0";
export const SPIKE_BUILD = "spike";
/** The fixture space (Mira Okafor, reference prefix M). */
export const SPACE_ID = "sp_mira0000000000000000000000";

export type Mode = "rpc" | "mcp";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface JsonObject {
  [key: string]: Json;
}

export class KitError extends Error {
  readonly code: string;
  constructor(code: string, message: string = code) {
    super(message);
    this.name = "KitError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers

export const b64url = (bytes: Buffer): string => bytes.toString("base64url");
/** 32 random bytes, base64url (A2 3.6.3). */
export const nonce = (): string => b64url(randomBytes(32));
export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
const hmac = (key: Buffer, text: string): Buffer =>
  createHmac("sha256", key).update(text, "utf8").digest();

/** Compares two strings in constant time for equal lengths. */
export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** A JSON value as text: strings as they are, anything else as JSON. */
export function textOf(value: Json | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Parses one line into a JSON object, or undefined. */
export function parseObject(line: string | null): JsonObject | undefined {
  if (line === null) return undefined;
  try {
    return asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function writeLine(stream: Writable, message: unknown): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

/** RFC 8785 canonical JSON, enough for the kit's values (sorted keys, ES number output). */
export function jcs(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value) as string | undefined;
    if (text === undefined) throw new TypeError("value is not JSON");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(record[k])}`).join(",")}}`;
}

const LABEL = /^[A-Za-z0-9 ._@+/:()-]*$/;

/**
 * A value a peer chose (an MCP method, a client name or version, a tool name), made safe to log:
 * null when it is not a string, `[invalid]` when it is empty, longer than `max` or holds anything
 * outside a plain character class. Never truncated, so a long value cannot leak a prefix.
 */
export function safeLabel(value: unknown, max = 64): string | null {
  if (typeof value !== "string") return null;
  return value !== "" && value.length <= max && LABEL.test(value) ? value : "[invalid]";
}

/** The value of `--name <value>` in an argument list. */
export function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

// ---------------------------------------------------------------------------------------------
// Proofs (A2 3.6.3)

export interface HandshakeIds {
  instance: string;
  protocol: number;
  mode: Mode;
  ns: string;
  nc: string;
}

export const clientProof = (key: Buffer, h: HandshakeIds): string =>
  b64url(
    hmac(
      key,
      `ttasks-local/1 client\n${h.instance}\n${String(h.protocol)}\n${h.mode}\n${h.ns}\n${h.nc}`,
    ),
  );

export const serverProof = (key: Buffer, h: HandshakeIds): string =>
  b64url(
    hmac(
      key,
      `ttasks-local/1 server\n${h.instance}\n${String(h.protocol)}\n${h.mode}\n${h.nc}\n${h.ns}`,
    ),
  );

export const sessionKey = (key: Buffer, h: HandshakeIds): Buffer =>
  hmac(key, `ttasks-local/1 session\n${h.instance}\n${h.ns}\n${h.nc}`);

export const transcript = (h: HandshakeIds, protocols: unknown, body: unknown): string =>
  sha256Hex(
    `ttasks-local/1 transcript\n${h.instance}\n${h.ns}\n${h.nc}\n${jcs(protocols)}\n${jcs(body)}`,
  );

export const bindMac = (ks: Buffer, t: string): string =>
  b64url(hmac(ks, `ttasks-local/1 bind\n${t}`));

export const boundMac = (ks: Buffer, t: string, resultWithoutMac: unknown): string =>
  b64url(hmac(ks, `ttasks-local/1 bound\n${t}\n${sha256Hex(jcs(resultWithoutMac))}`));

/** The HTTP listener's answer to `POST /api/v1/auth/probe` (A2 3.8.4 step 2). */
export const httpProbeProof = (key: Buffer, instance: string, port: number, np: string): string =>
  b64url(hmac(key, `ttasks-http-probe\n${instance}\n${String(port)}\n${np}`));

// ---------------------------------------------------------------------------------------------
// Framing (A2 3.6.2): UTF-8, one JSON object per line, at most 8 MiB per line.

type LineHandler = (line: string) => void;

export class LineReader {
  #chunks: Buffer[] = [];
  #size = 0;
  #queue: string[] = [];
  #waiters: ((line: string | null) => void)[] = [];
  #handler: LineHandler | undefined;
  #onEnd: (() => void) | undefined;
  #ended = false;
  readonly #max: number;
  /** Called once when a line exceeds the limit. The reader then stops. */
  onTooLarge: (() => void) | undefined;

  constructor(stream: Readable, max: number = MAX_LINE) {
    this.#max = max;
    stream.on("data", (chunk: Buffer) => {
      this.#push(chunk);
    });
    stream.on("end", () => {
      this.#end();
    });
    stream.on("close", () => {
      this.#end();
    });
    stream.on("error", () => {
      this.#end();
    });
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** The next line, or null at the end of the stream. Only before `pipe`. */
  next(): Promise<string | null> {
    const line = this.#queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Hands every queued and later line to `handler`. Calling it again replaces the handler. */
  pipe(handler: LineHandler, onEnd?: () => void): void {
    this.#handler = handler;
    this.#onEnd = onEnd;
    for (let line = this.#queue.shift(); line !== undefined; line = this.#queue.shift()) {
      handler(line);
    }
    if (this.#ended) onEnd?.();
  }

  #push(chunk: Buffer): void {
    if (this.#ended) return;
    let start = 0;
    for (let nl = chunk.indexOf(10, start); nl !== -1; nl = chunk.indexOf(10, start)) {
      const part = chunk.subarray(start, nl);
      start = nl + 1;
      if (this.#size + part.length > this.#max) {
        this.#tooLarge();
        return;
      }
      const bytes = this.#size === 0 ? part : Buffer.concat([...this.#chunks, part]);
      this.#chunks = [];
      this.#size = 0;
      let line = bytes.toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line !== "") this.#emit(line);
      if (this.#isEnded()) return; // a handler may have ended the reader
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.#chunks.push(rest);
      this.#size += rest.length;
      if (this.#size > this.#max) this.#tooLarge();
    }
  }

  #isEnded(): boolean {
    return this.#ended;
  }

  #emit(line: string): void {
    if (this.#handler !== undefined) {
      this.#handler(line);
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(line);
    else this.#queue.push(line);
  }

  #tooLarge(): void {
    this.onTooLarge?.();
    this.#end();
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#chunks = [];
    for (const waiter of this.#waiters.splice(0)) waiter(null);
    this.#onEnd?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Discovery (A2 3.6.1)

export interface ServiceInfo {
  format: 1;
  instance: string;
  install: string;
  pid: number;
  state: "ready";
  endpoint: { kind: "unix" | "pipe"; path: string };
  /** Where the endpoint lives: a named pipe, the per-user runtime folder or `<state>/run/`. */
  runtime: "pipe" | "run-user" | "state";
  http: { port: number; moved: boolean };
  protocols: number[];
}

export function readServiceInfo(state: string): ServiceInfo {
  try {
    return JSON.parse(readFileSync(join(state, "service.json"), "utf8")) as ServiceInfo;
  } catch {
    throw new KitError("service_unavailable", "The stand-in service is not running.");
  }
}

export function readKey(state: string): Buffer {
  try {
    return readFileSync(join(state, "ipc.key"));
  } catch {
    throw new KitError("key_unreadable", "The stand-in service's ipc.key cannot be read.");
  }
}

// ---------------------------------------------------------------------------------------------
// Client side of the handshake

export interface ClientInfo {
  kind: "cli" | "bridge" | "shim" | "forwarder";
  version: string;
  build: string;
  pid: number;
  package: string | null;
  tty: { stdin: boolean; stdout: boolean };
}

export function clientInfo(kind: ClientInfo["kind"]): ClientInfo {
  return {
    kind,
    version: SPIKE_VERSION,
    build: SPIKE_BUILD,
    pid: process.pid,
    package: process.env["TTASKS_PACKAGE"] ?? null,
    tty: { stdin: isatty(0), stdout: isatty(1) },
  };
}

export interface BindOptions {
  mode: Mode;
  client: ClientInfo;
  context: JsonObject;
}

const untrusted = (where: string) =>
  new KitError("untrusted_endpoint", `Something other than TTasks is listening at ${where}.`);

/**
 * Runs the client side of A2 3.6.3 on a connected socket: verify the challenge, send only the
 * hello, verify the server proof, then send the authenticated bind and verify its result.
 * Returns the bind result without its mac.
 */
export async function handshake(
  socket: net.Socket,
  reader: LineReader,
  key: Buffer,
  options: BindOptions,
  where = "the endpoint",
): Promise<JsonObject> {
  const challenge = parseObject(await reader.next());
  const cp = asObject(challenge?.["params"]);
  const protocols = cp?.["protocols"];
  if (
    challenge?.["method"] !== "tasks/challenge" ||
    typeof cp?.["nonce"] !== "string" ||
    typeof cp["instance"] !== "string" ||
    !Array.isArray(protocols) ||
    !protocols.includes(PROTOCOL)
  ) {
    socket.destroy();
    throw untrusted(where);
  }
  const ids: HandshakeIds = {
    instance: cp["instance"],
    protocol: PROTOCOL,
    mode: options.mode,
    ns: cp["nonce"],
    nc: nonce(),
  };
  writeLine(socket, {
    jsonrpc: "2.0",
    id: 0,
    method: "tasks/hello",
    params: { protocol: ids.protocol, mode: ids.mode, nonce: ids.nc, proof: clientProof(key, ids) },
  });
  const reply = parseObject(await reader.next());
  const ps = asObject(reply?.["result"])?.["proof"];
  if (typeof ps !== "string" || !sameText(ps, serverProof(key, ids))) {
    socket.destroy();
    throw untrusted(where);
  }
  const body = {
    protocol: ids.protocol,
    mode: ids.mode,
    client: options.client,
    context: options.context,
  };
  const t = transcript(ids, protocols, body);
  const ks = sessionKey(key, ids);
  writeLine(socket, {
    jsonrpc: "2.0",
    id: 1,
    method: "tasks/bind",
    params: { ...body, mac: bindMac(ks, t) },
  });
  const bound = parseObject(await reader.next());
  const error = asObject(bound?.["error"]);
  if (error !== undefined) {
    socket.destroy();
    throw new KitError(textOf(error["message"]));
  }
  const result = asObject(bound?.["result"]);
  if (result === undefined) {
    socket.destroy();
    throw untrusted(where);
  }
  const { mac, ...rest } = result;
  if (typeof mac !== "string" || !sameText(mac, boundMac(ks, t, rest))) {
    socket.destroy();
    throw untrusted(where);
  }
  return rest;
}

export interface Connection {
  socket: net.Socket;
  reader: LineReader;
  bind: JsonObject;
  info: ServiceInfo;
}

export interface Deadlines {
  /** From the connect call to the connection. Default 5 s. */
  connectMs?: number;
  /** From the connection to a verified bind result. Default 5 s. */
  handshakeMs?: number;
  /** Aborting destroys the socket at once and fails with `aborted` (the run shim's finish). */
  signal?: AbortSignal;
}

export const CONNECT_MS = 5_000;
export const HANDSHAKE_MS = 5_000;

/**
 * Discovers the service in `state`, connects and completes the handshake, each within its
 * deadline. A peer that accepts the connection but stays silent at any handshake stage gets its
 * socket destroyed and fails with `handshake_timeout`, so no caller waits forever.
 */
export async function connect(
  state: string,
  options: BindOptions,
  deadlines: Deadlines = {},
): Promise<Connection> {
  const info = readServiceInfo(state);
  const key = readKey(state);
  const where = info.endpoint.path;
  const connectMs = deadlines.connectMs ?? CONNECT_MS;
  const handshakeMs = deadlines.handshakeMs ?? HANDSHAKE_MS;
  const { signal } = deadlines;
  // A function, so the checks after each await read the signal's current state.
  const abandoned = (): boolean => signal?.aborted === true;
  if (abandoned()) throw new KitError("aborted", "The connection was abandoned.");
  const socket = net.createConnection(where);
  const onAbort = () => socket.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = { passed: false };
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const connectTimer = setTimeout(() => {
        socket.destroy();
        reject(
          new KitError(
            "service_unavailable",
            `Cannot connect: no answer in ${String(connectMs)} ms`,
          ),
        );
      }, connectMs);
      socket.once("connect", () => {
        clearTimeout(connectTimer);
        resolve();
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(connectTimer);
        reject(new KitError("service_unavailable", `Cannot connect: ${error.code ?? "error"}`));
      });
      socket.once("close", () => {
        clearTimeout(connectTimer);
        reject(new KitError("service_unavailable", "Cannot connect: closed"));
      });
    });
    socket.on("error", () => {
      // The reader sees the close. Errors after connect are not thrown.
    });
    const reader = new LineReader(socket);
    timer = setTimeout(() => {
      deadline.passed = true;
      socket.destroy(); // the reader ends, so the pending read in handshake() resolves with null
    }, handshakeMs);
    const bind = await handshake(socket, reader, key, options, where);
    if (abandoned()) {
      socket.destroy();
      throw new KitError("aborted", "The connection was abandoned.");
    }
    return { socket, reader, bind, info };
  } catch (error) {
    if (abandoned()) throw new KitError("aborted", "The connection was abandoned.");
    if (!deadline.passed) throw error;
    throw new KitError(
      "handshake_timeout",
      `No complete handshake from ${where} within ${String(handshakeMs)} ms.`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Connects in rpc mode within `ms`, retrying while the service is down or silent (A4 3.6.3 step
 * 2). Every attempt has its own connect and handshake deadlines, so the whole window is bounded.
 * Undefined when the window passed.
 */
export async function connectWithRetry(
  state: string,
  kind: ClientInfo["kind"],
  ms: number,
  deadlines: Deadlines = {},
): Promise<Connection | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await connect(
        state,
        { mode: "rpc", client: clientInfo(kind), context: {} },
        deadlines,
      );
    } catch (error) {
      const retry =
        error instanceof KitError &&
        (error.code === "service_unavailable" || error.code === "handshake_timeout");
      if (!retry) throw error;
      if (Date.now() > end) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * `ttasks open`'s listener check (A2 3.8.4 step 2), bounded: true only when the listener on `port`
 * answers the HMAC probe correctly within `timeoutMs`. A silent or slow squatter gives false.
 */
export async function verifyListener(
  port: number,
  key: Buffer,
  instance: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const np = nonce();
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/v1/auth/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: np }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = asObject(await res.json());
    const proof = body?.["proof"];
    return typeof proof === "string" && sameText(proof, httpProbeProof(key, instance, port, np));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// rpc mode client (A2 3.6.4)

interface Pending {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
}

export class RpcClient {
  readonly bind: JsonObject;
  readonly #socket: net.Socket;
  readonly #pending = new Map<number, Pending>();
  #next = 2;
  #closed = false;
  onNotification: ((method: string, params: Json | undefined) => void) | undefined;
  /** Called once when the connection ends, for any reason. */
  onClose: (() => void) | undefined;

  constructor(connection: Connection) {
    this.bind = connection.bind;
    this.#socket = connection.socket;
    connection.reader.pipe(
      (line) => {
        const msg = parseObject(line);
        if (msg === undefined) return;
        if (typeof msg["method"] === "string") {
          this.onNotification?.(msg["method"], msg["params"]);
          return;
        }
        const id = msg["id"];
        const pending = typeof id === "number" ? this.#pending.get(id) : undefined;
        if (pending === undefined || typeof id !== "number") return;
        this.#pending.delete(id);
        const error = asObject(msg["error"]);
        if (error === undefined) {
          pending.resolve(msg["result"] ?? null);
          return;
        }
        const data = asObject(error["data"]);
        const text = typeof data?.["text"] === "string" ? data["text"] : textOf(error["message"]);
        pending.reject(new KitError(textOf(error["message"]), text));
      },
      () => {
        this.#closed = true;
        for (const p of this.#pending.values()) p.reject(new KitError("connection_lost"));
        this.#pending.clear();
        this.onClose?.();
      },
    );
  }

  /**
   * Sends one request. With `timeoutMs`, a reply that does not come in time fails the call with
   * `rpc_timeout` and closes the connection, so a late reply can never act on stale state.
   */
  call(method: string, params: JsonObject = {}, timeoutMs?: number): Promise<Json> {
    if (this.#closed) return Promise.reject(new KitError("connection_lost"));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (!this.#pending.delete(id)) return;
              reject(
                new KitError("rpc_timeout", `No reply to ${method} in ${String(timeoutMs)} ms.`),
              );
              this.close();
            }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      writeLine(this.#socket, { jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: JsonObject = {}): void {
    if (!this.#closed) writeLine(this.#socket, { jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.#closed = true;
    this.#socket.end();
    // end() waits for the peer; destroy shortly after, so a silent peer cannot keep us alive.
    setTimeout(() => this.#socket.destroy(), 1_000).unref();
  }
}
