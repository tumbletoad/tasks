// JSON-RPC over lines, with requests in both directions: one JSON object per line on a pair of
// pipes, as Codex's app server and the Agent Client Protocol speak it. Each side may ask the other
// and must answer what it is asked; a request the other side asks is answered while this side
// keeps reading, so an answer that takes its time never holds up a reply or a notification.
//
// Lines are read in bounded memory (streams/lines.ts): one longer than the cap is skipped whole,
// and so is anything that is not a JSON object. A request with a method no handler takes gets the
// protocol's "method not found" error, never silence.
import type { Readable, Writable } from "node:stream";
import { LINE_CAP_BYTES } from "@ttasks/contracts/runs";
import { LineSplitter } from "../streams/lines.ts";

/** JSON-RPC's own error codes. */
export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** An error the other side answered a request with, or one to answer a request with. */
export class RpcError extends Error {
  override readonly name = "RpcError";
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** The connection ended before the request was answered. */
export class RpcClosed extends Error {
  override readonly name = "RpcClosed";
  constructor() {
    super("The connection ended before an answer came");
  }
}

/** What a request handler returns to leave the request unanswered for now. */
export const NO_ANSWER: unique symbol = Symbol("no answer");

/**
 * Answers one request of the other side: its result, a promise of it, NO_ANSWER, or a thrown
 * RpcError. Anything else thrown is answered as an internal error, without its message.
 */
export type RequestHandler = (method: string, params: unknown, id: number | string) => unknown;

export type NotificationHandler = (method: string, params: unknown) => void;

export interface LineRpcOptions {
  /** Writes `"jsonrpc": "2.0"` on every message. Codex's app server goes without it. */
  readonly version?: boolean;
  /** The longest line read, in UTF-8 bytes. Default: LINE_CAP_BYTES. */
  readonly lineCap?: number;
}

type Id = number | string;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is Id =>
  (typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "string";

export class LineRpc {
  readonly #output: Writable;
  readonly #version: boolean;
  readonly #splitter: LineSplitter;
  readonly #pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #onRequest: RequestHandler = (method) => {
    throw new RpcError(RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
  };
  #onNotification: NotificationHandler = () => undefined;
  #next = 1;
  #ended = false;
  /** Lines that were skipped: too long, not JSON, or not a message. */
  skipped = 0;
  /** Resolves once the input ended or failed. */
  readonly ended: Promise<void>;

  constructor(input: Readable, output: Writable, options: LineRpcOptions = {}) {
    this.#output = output;
    this.#version = options.version ?? false;
    this.#splitter = new LineSplitter(options.lineCap ?? LINE_CAP_BYTES);
    output.on("error", () => undefined);
    input.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (const line of this.#splitter.push(bytes)) {
        if (line.kind === "oversized") this.skipped += 1;
        else this.#line(line.line.text);
      }
    });
    this.ended = new Promise((resolve) => {
      const end = (): void => {
        if (this.#ended) return;
        for (const line of this.#splitter.end()) {
          if (line.kind === "line") this.#line(line.line.text);
        }
        this.#end();
        resolve();
      };
      input.once("end", end);
      input.once("close", end);
      input.once("error", end);
    });
  }

  /** Who answers the other side's requests. */
  onRequest(handler: RequestHandler): void {
    this.#onRequest = handler;
  }

  /** Who hears the other side's notifications. */
  onNotification(handler: NotificationHandler): void {
    this.#onNotification = handler;
  }

  /** Asks the other side. Rejects with RpcError for its error, RpcClosed when it ended first. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#ended) return Promise.reject(new RpcClosed());
    const id = this.#next;
    this.#next += 1;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({ id, method, ...(params === undefined ? {} : { params }) });
    return answer;
  }

  notify(method: string, params?: unknown): void {
    if (this.#ended) return;
    this.#send({ method, ...(params === undefined ? {} : { params }) });
  }

  /** Answers a request left open with NO_ANSWER. */
  answer(id: Id, result: unknown): void {
    this.#send({ id, result: result ?? null });
  }

  /** Answers a request left open with NO_ANSWER with an error. */
  fail(id: Id, error: RpcError): void {
    this.#send({ id, error: errorBody(error) });
  }

  /** Stops waiting for answers: every pending request rejects with RpcClosed. */
  close(): void {
    this.#end();
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const { reject } of pending) reject(new RpcClosed());
  }

  #send(message: Record<string, unknown>): void {
    const line = JSON.stringify(this.#version ? { jsonrpc: "2.0", ...message } : message);
    try {
      this.#output.write(`${line}\n`);
    } catch {
      // A pipe the other side closed: its end says how it went.
    }
  }

  #line(text: string): void {
    if (text.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.skipped += 1;
      return;
    }
    if (!isObject(message)) {
      this.skipped += 1;
      return;
    }
    const method = message["method"];
    const id = message["id"];
    if (typeof method === "string") {
      if (isId(id)) this.#request(id, method, message["params"]);
      else this.#notification(method, message["params"]);
      return;
    }
    if (isId(id) && ("result" in message || "error" in message)) {
      this.#response(id, message);
      return;
    }
    this.skipped += 1;
  }

  #response(id: Id, message: Record<string, unknown>): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    const error = message["error"];
    if (error === undefined || error === null) {
      pending.resolve(message["result"]);
      return;
    }
    const body = isObject(error) ? error : {};
    const code = typeof body["code"] === "number" ? body["code"] : RPC_ERRORS.internal;
    const text = typeof body["message"] === "string" ? body["message"] : "";
    pending.reject(new RpcError(code, text, body["data"]));
  }

  #notification(method: string, params: unknown): void {
    try {
      this.#onNotification(method, params);
    } catch {
      // A defect in a handler never stops the reading.
    }
  }

  #request(id: Id, method: string, params: unknown): void {
    let answered: unknown;
    try {
      answered = this.#onRequest(method, params, id);
    } catch (error) {
      this.fail(id, asRpcError(error));
      return;
    }
    if (answered === NO_ANSWER) return;
    if (answered instanceof Promise) {
      answered.then(
        (result: unknown) => {
          if (result !== NO_ANSWER) this.answer(id, result);
        },
        (error: unknown) => {
          this.fail(id, asRpcError(error));
        },
      );
      return;
    }
    this.answer(id, answered);
  }
}

function asRpcError(error: unknown): RpcError {
  return error instanceof RpcError ? error : new RpcError(RPC_ERRORS.internal, "Internal error");
}

function errorBody(error: RpcError): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    ...(error.data === undefined ? {} : { data: error.data }),
  };
}
