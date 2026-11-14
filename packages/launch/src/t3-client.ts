// T3 Code's server as an outside MCP client reaches it (A4 3.4.1): its origin, read from T3's own
// `server-runtime.json`; HTTP with a deadline on every request; and MCP over Streamable HTTP at
// `<origin>/mcp` with the pairing's bearer token (the 2025-11-25 era: `initialize`, then calls in
// the session it opens). Nothing here writes; the route decides what a failure means.
//
// Two rules keep the token where it belongs. It is sent only in the Authorization header, and only
// to a loopback origin (`127.0.0.1`, `localhost`, `[::1]`): T3 is a local server, and a token must
// not leave the machine because a file named another host. And no error, URL or log line carries
// it: every failure is a T3Error with a fixed message and a kind.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { PRODUCT_ID } from "@tasks/brand";

/** How long one HTTP request to T3 may take, answer included. */
export const T3_REQUEST_MS = 10_000;
/** The largest answer read from T3. */
export const T3_MAX_ANSWER = 4 * 1024 * 1024;
/** The largest `server-runtime.json` read. */
const MAX_RUNTIME_FILE = 64 * 1024;

/** The MCP versions this client speaks, newest first (the 2025-11-25 era, A3 3.3). */
export const T3_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/**
 * What went wrong with a request to T3. The first three say for certain that T3 did nothing; the
 * others leave open whether it did.
 */
export type T3Failure =
  /** Nothing listens at the origin: the request never reached T3. */
  | "unreachable"
  /** 401: T3 did not accept the token, and did nothing. */
  | "unauthorized"
  /**
   * T3 refused the request before any tool ran: an HTTP 4xx (the transport's refusal, before any
   * method runs), or a JSON-RPC error to a message that runs no tool (`initialize`).
   */
  | "rejected"
  /** The tool ran and answered with an error. Whether it changed anything is not said. */
  | "tool_error"
  /**
   * No answer: a cut connection, a timeout, a server error (a 5xx, or any JSON-RPC error to a tool
   * call, which may come after the tool did its work). It may have been done.
   */
  | "lost"
  /** An answer this client cannot read, or a redirect. It may have been done. */
  | "unreadable";

const MESSAGES: Record<T3Failure, string> = {
  unreachable: "T3 Code's server does not answer",
  unauthorized: "T3 Code did not accept the pairing",
  rejected: "T3 Code refused the request",
  tool_error: "T3 Code answered with an error",
  lost: "T3 Code's answer was lost",
  unreadable: "T3 Code's answer cannot be read",
};

/** A request to T3 that did not give a usable answer. Its message is fixed: never a value. */
export class T3Error extends Error {
  override readonly name = "T3Error";
  readonly failure: T3Failure;
  constructor(failure: T3Failure) {
    super(MESSAGES[failure]);
    this.failure = failure;
  }
}

/** Whether a failure says for certain that T3 did nothing. */
export const certainNothingDone = (failure: T3Failure): boolean =>
  failure === "unreachable" || failure === "unauthorized" || failure === "rejected";

export type Fetch = typeof globalThis.fetch;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `text` as an http(s) URL on a loopback host, without credentials or fragment, or undefined. */
export function loopbackUrl(text: unknown): URL | undefined {
  if (typeof text !== "string" || text.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
  return LOOPBACK_HOSTS.has(url.hostname) ? url : undefined;
}

/** Where T3's server is, as read from its home folder. */
export type T3Origin =
  | { readonly status: "ok"; readonly origin: string }
  /** No file, no origin in it, or an origin that is not a loopback http(s) URL. */
  | { readonly status: "not_running" }
  /** The file or its folder can be changed by another user (Linux, macOS): not trusted. */
  | { readonly status: "unsafe" };

/** Opens a file for reading without following a link at its path (POSIX). */
const READ_NO_LINK = constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);

/** Whether facts of T3's folder or file fail the rule: a link, another owner, write for others. */
const unsafe = (info: { isSymbolicLink(): boolean; uid: number; mode: number }): boolean => {
  const uid = process.getuid?.();
  return (
    info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o022) !== 0
  );
};

/**
 * The origin of T3's server: `<home>/userdata/server-runtime.json`'s `origin` (A4 3.4.1), read
 * fresh each time, because T3 may start on another port. On Linux and macOS the file and its
 * folder must belong to this user and not be writable by others: the token goes where it says. The
 * file is opened without following a link (O_NOFOLLOW) and judged by its open descriptor, so what is
 * read is what was judged, as Tasks reads its own configuration (A2 3.2.2 rule 5).
 */
export async function readT3Origin(
  home: string,
  platform: NodeJS.Platform = process.platform,
): Promise<T3Origin> {
  const folder = join(home, "userdata");
  const file = join(folder, "server-runtime.json");
  const posix = platform !== "win32";
  let handle;
  try {
    if (posix && unsafe(await lstat(folder))) return { status: "unsafe" };
    try {
      handle = await open(file, posix ? READ_NO_LINK : "r");
    } catch (error) {
      // A link at the file's path (ELOOP): not followed, and not trusted.
      if (posix && (error as NodeJS.ErrnoException).code === "ELOOP") return { status: "unsafe" };
      throw error;
    }
    const info = await handle.stat();
    if (posix && unsafe(info)) return { status: "unsafe" };
    if (!info.isFile() || info.size > MAX_RUNTIME_FILE) return { status: "not_running" };
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    const origin =
      typeof value === "object" && value !== null
        ? loopbackUrl((value as Record<string, unknown>)["origin"])
        : undefined;
    return origin === undefined
      ? { status: "not_running" }
      : { status: "ok", origin: origin.origin };
  } catch {
    return { status: "not_running" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Whether an error, or one of its causes, is a refused connection. */
function refused(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && typeof cause === "object" && cause !== null; depth += 1) {
    if ((cause as { code?: unknown }).code === "ECONNREFUSED") return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * One HTTP request with a deadline that covers the answer's body too. A refused connection is
 * `unreachable`; every other failure to get an answer is `lost`. Redirects are not followed.
 */
export async function t3Request(
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
  ms: number = T3_REQUEST_MS,
): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(ms) });
  } catch (error) {
    throw new T3Error(refused(error) ? "unreachable" : "lost");
  }
}

/** An answer's body as text, at most T3_MAX_ANSWER bytes of UTF-8. */
export async function readText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const read: unknown = await reader.read();
      const { done, value } = read as { done: boolean; value: unknown };
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new T3Error("unreadable");
      total += value.byteLength;
      if (total > T3_MAX_ANSWER) {
        await reader.cancel().catch(() => undefined);
        throw new T3Error("unreadable");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof T3Error) throw error;
    throw new T3Error("lost");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new T3Error("unreadable");
  }
}

/** An answer's body as a JSON object. */
export async function readObject(response: Response): Promise<Record<string, unknown>> {
  const text = await readText(response);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new T3Error("unreadable");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new T3Error("unreadable");
  }
  return value as Record<string, unknown>;
}

/** Where to send MCP requests and with which token. */
export interface T3Target {
  readonly origin: string;
  readonly token: string;
}

interface Session {
  /** The origin and a hash of the token it was opened with. */
  readonly key: string;
  readonly id: string | undefined;
  readonly version: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * MCP over Streamable HTTP to T3 (2025-11-25 era). One session per origin and token: opened with
 * `initialize` on first use, opened again when T3 forgets it (404, after a restart), and dropped
 * for another origin or token. A tool's answer is its `structuredContent`, or its first text
 * content read as JSON.
 */
export class T3Mcp {
  readonly #fetch: Fetch;
  readonly #ms: number;
  readonly #client: { readonly name: string; readonly version: string };
  #session: Session | undefined;
  #next = 1;

  constructor(
    options: { fetch?: Fetch; requestMs?: number; client?: { name: string; version: string } } = {},
  ) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#ms = options.requestMs ?? T3_REQUEST_MS;
    this.#client = options.client ?? { name: PRODUCT_ID, version: "0.0.0" };
  }

  /** Calls one tool and returns its structured answer. Throws T3Error. */
  async call(
    target: T3Target,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    loopbackOnly(target.origin);
    // A session T3 no longer knows (404) did nothing: it is opened again once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.#open(target);
      const answer = await this.#post(target, session, {
        method: "tools/call",
        params: { name: tool, arguments: args },
      });
      if (answer === "session_gone") {
        this.#session = undefined;
        continue;
      }
      const result = answer.result;
      if (!isObject(result)) throw new T3Error("unreadable");
      if (result["isError"] === true) throw new T3Error("tool_error");
      const structured = result["structuredContent"];
      if (isObject(structured)) return structured;
      const content = result["content"];
      const first: unknown = Array.isArray(content) ? content[0] : undefined;
      if (isObject(first) && first["type"] === "text" && typeof first["text"] === "string") {
        try {
          const parsed = JSON.parse(first["text"]) as unknown;
          if (isObject(parsed)) return parsed;
        } catch {
          // Not JSON: unreadable below.
        }
      }
      throw new T3Error("unreadable");
    }
    throw new T3Error("lost");
  }

  /** Forgets the open session: the next call opens a new one. */
  reset(): void {
    this.#session = undefined;
  }

  async #open(target: T3Target): Promise<Session> {
    const key = `${target.origin}\n${createHash("sha256").update(target.token).digest("hex")}`;
    if (this.#session?.key === key) return this.#session;
    this.#session = undefined;
    const opened = await this.#post(
      target,
      { key, id: undefined, version: "" },
      {
        method: "initialize",
        params: {
          protocolVersion: T3_PROTOCOLS[0],
          capabilities: {},
          clientInfo: this.#client,
        },
      },
    );
    if (opened === "session_gone") throw new T3Error("rejected");
    const version = isObject(opened.result) ? opened.result["protocolVersion"] : undefined;
    if (typeof version !== "string" || !(T3_PROTOCOLS as readonly string[]).includes(version)) {
      throw new T3Error("unreadable");
    }
    const session: Session = { key, id: opened.sessionId, version };
    await this.#post(target, session, { method: "notifications/initialized" });
    this.#session = session;
    return session;
  }

  /**
   * One JSON-RPC message. Returns the result (undefined for a notification) and the session ID T3
   * gave, or `session_gone` when T3 no longer knows the session. Throws T3Error.
   */
  async #post(
    target: T3Target,
    session: Session,
    message: { method: string; params?: Record<string, unknown> },
  ): Promise<{ result: unknown; sessionId: string | undefined } | "session_gone"> {
    const notification = message.method.startsWith("notifications/");
    const id = notification ? undefined : this.#next++;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${target.token}`,
    };
    if (session.id !== undefined) headers["mcp-session-id"] = session.id;
    if (session.version !== "") headers["mcp-protocol-version"] = session.version;
    const response = await t3Request(
      this.#fetch,
      `${target.origin}/mcp`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), ...message }),
      },
      this.#ms,
    );
    const drop = () => response.body?.cancel().catch(() => undefined);
    if (response.status === 401) {
      await drop();
      throw new T3Error("unauthorized");
    }
    if (response.status === 404 && session.id !== undefined) {
      await drop();
      return "session_gone";
    }
    if (response.status >= 500) {
      await drop();
      throw new T3Error("lost");
    }
    if (response.status >= 300) {
      await drop();
      // A 4xx refuses the request. A redirect (not followed) does not say it was not done.
      throw new T3Error(response.status >= 400 ? "rejected" : "unreadable");
    }
    const given = response.headers.get("mcp-session-id");
    const sessionId = given !== null && /^[\x21-\x7e]{1,256}$/u.test(given) ? given : undefined;
    if (notification) {
      await drop();
      return { result: undefined, sessionId };
    }
    const type = response.headers.get("content-type") ?? "";
    const reply = type.startsWith("text/event-stream")
      ? await readEvent(response, id)
      : await readObject(response);
    if (reply === undefined || reply["id"] !== id) throw new T3Error("unreadable");
    if (reply["error"] !== undefined) {
      // A JSON-RPC error to a tool call never says the tool did not run, whatever its code: a
      // server may fail after the tool did its work, and the MCP SDK's server checks a tool's
      // result after the tool ran and answers -32602 (invalid params) when it does not fit. It is
      // open, like a 5xx. An error to `initialize` comes before any tool could run.
      throw new T3Error(message.method === "tools/call" ? "lost" : "rejected");
    }
    return { result: reply["result"], sessionId };
  }
}

/** Throws unless `origin` is a loopback origin: the token never goes anywhere else. */
function loopbackOnly(origin: string): void {
  const url = loopbackUrl(origin);
  if (url?.origin !== origin) throw new T3Error("rejected");
}

/** The JSON-RPC reply with `id` in one SSE event's data, or undefined. */
function replyIn(data: string, id: number | undefined): Record<string, unknown> | undefined {
  if (data === "") return undefined;
  try {
    const value = JSON.parse(data) as unknown;
    // A reply has a result or an error; a request from the server may carry the same ID.
    return isObject(value) && value["id"] === id && !("method" in value) ? value : undefined;
  } catch {
    // Another event: skipped.
    return undefined;
  }
}

/** A line ending of the SSE grammar: CRLF, LF or CR. */
const EOL = /\r\n|\r|\n/gu;

/**
 * Server-sent events, line by line as the SSE grammar has them (CRLF, LF and CR in any mix, a line
 * split across chunks, a CR at a chunk's end whose LF comes in the next one), dispatched at each
 * blank line. Only the `data` field matters here; comments and other fields are skipped.
 */
class EventLines {
  #buffer = "";
  #data: string[] = [];
  /** The last chunk ended with a CR: an LF at the start of the next one belongs to it. */
  #afterCr = false;

  /** Takes `text`; returns the data of each event it completes, in order. */
  push(text: string): string[] {
    let start = 0;
    if (this.#afterCr && text !== "") {
      if (text.startsWith("\n")) start = 1;
      this.#afterCr = false;
    }
    this.#buffer += start === 0 ? text : text.slice(start);
    const events: string[] = [];
    let pos = 0;
    EOL.lastIndex = 0;
    for (let m = EOL.exec(this.#buffer); m !== null; m = EOL.exec(this.#buffer)) {
      const line = this.#buffer.slice(pos, m.index);
      pos = m.index + m[0].length;
      if (m[0] === "\r" && pos === this.#buffer.length) this.#afterCr = true;
      const done = this.#line(line);
      if (done !== undefined) events.push(done);
    }
    this.#buffer = this.#buffer.slice(pos);
    return events;
  }

  /** The end of the stream: a last line and an event without their blank line count too. */
  end(): string[] {
    const events: string[] = [];
    if (this.#buffer !== "") {
      const done = this.#line(this.#buffer);
      if (done !== undefined) events.push(done);
      this.#buffer = "";
    }
    const last = this.#line("");
    if (last !== undefined) events.push(last);
    return events;
  }

  #line(line: string): string | undefined {
    if (line === "") {
      if (this.#data.length === 0) return undefined;
      const data = this.#data.join("\n");
      this.#data = [];
      return data;
    }
    if (line === "data") this.#data.push("");
    else if (line.startsWith("data:")) this.#data.push(line.slice(5).replace(/^ /u, ""));
    return undefined;
  }
}

/**
 * The JSON-RPC reply with `id` from an SSE stream, read event by event: it is returned as soon as
 * its event is complete, and the rest of the stream is cancelled. A server may keep the stream
 * open after the reply (the specification only says it SHOULD close it), so waiting for the end
 * would turn every answer into a lost one at the deadline. At most T3_MAX_ANSWER bytes are read.
 */
async function readEvent(
  response: Response,
  id: number | undefined,
): Promise<Record<string, unknown> | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (bytes?: Uint8Array): string => {
    try {
      return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
    } catch {
      throw new T3Error("unreadable");
    }
  };
  const lines = new EventLines();
  let total = 0;
  const stop = () => reader.cancel().catch(() => undefined);
  try {
    for (;;) {
      const read: unknown = await reader.read();
      const { done, value } = read as { done: boolean; value: unknown };
      if (!done && !(value instanceof Uint8Array)) throw new T3Error("unreadable");
      if (!done) {
        total += (value as Uint8Array).byteLength;
        if (total > T3_MAX_ANSWER) throw new T3Error("unreadable");
      }
      const events = done
        ? [...lines.push(decode()), ...lines.end()]
        : lines.push(decode(value as Uint8Array));
      for (const data of events) {
        const reply = replyIn(data, id);
        if (reply !== undefined) {
          if (!done) await stop();
          return reply;
        }
      }
      if (done) return undefined;
    }
  } catch (error) {
    await stop();
    if (error instanceof T3Error) throw error;
    // A stream cut or past its deadline.
    throw new T3Error("lost");
  }
}
