// JSON-RPC over lines, with requests in both directions: one JSON object per line on a pair of
// pipes, as Codex's app server and the Agent Client Protocol speak it. Each side may ask the other
// and must answer what it is asked; a request the other side asks is answered while this side
// keeps reading, so an answer that takes its time never holds up a reply or a notification.
//
// Lines are read as every agent's output is (streams/json-lines.ts). A line that could not be read
// reaches onLost: nothing of it is known, not even whom it was for. A line that is not a JSON
// message is skipped. A request with a method no handler takes gets the protocol's "method not
// found" error, never silence.
import type { Readable, Writable } from "node:stream";
import { JsonLines, type JsonLine } from "../streams/json-lines.ts";

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
  /** The longest line read as it is, in UTF-8 bytes. Default: LINE_CAP_BYTES. */
  readonly lineCap?: number;
  /** The longest line read at all. Default: LONG_LINE_CAP_BYTES. */
  readonly longLineCap?: number;
}

type Id = number | string;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is Id =>
  (typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "string";

export class LineRpc {
  readonly #output: Writable;
  readonly #version: boolean;
  readonly #lines: JsonLines;
  readonly #pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #onRequest: RequestHandler = (method) => {
    throw new RpcError(RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
  };
  #onNotification: NotificationHandler = () => undefined;
  #onLost: () => void = () => undefined;
  #next = 1;
  #ended = false;
  /** Lines that were skipped: lost, not JSON, or not a message. */
  skipped = 0;
  /** Resolves once the input ended or failed. */
  readonly ended: Promise<void>;

  constructor(input: Readable, output: Writable, options: LineRpcOptions = {}) {
    this.#output = output;
    this.#version = options.version ?? false;
    this.#lines = new JsonLines(options.lineCap, options.longLineCap);
    output.on("error", () => undefined);
    input.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (const line of this.#lines.push(bytes)) this.#take(line);
    });
    this.ended = new Promise((resolve) => {
      const end = (): void => {
        if (this.#ended) return;
        for (const line of this.#lines.end()) this.#take(line);
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

  /** Who hears that a line could not be read (streams/json-lines.ts). */
  onLost(handler: () => void): void {
    this.#onLost = handler;
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

  #take(line: JsonLine): void {
    switch (line.kind) {
      case "json":
        this.#message(line.value);
        return;
      case "text":
        if (!line.blank) this.skipped += 1;
        return;
      case "lost":
        this.skipped += 1;
        try {
          this.#onLost();
        } catch {
          // A defect in a handler never stops the reading.
        }
    }
  }

  #message(message: unknown): void {
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
