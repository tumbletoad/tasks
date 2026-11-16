// The handshake's messages (A2 3.6.3): builders for the side that sends each one and strict
// parsers for the side that receives it. A parser returns undefined for anything that is not
// exactly the expected message, so the caller refuses it without looking further.
import {
  BIND_ID,
  CLIENT_KINDS,
  HELLO_ID,
  MAX_INSTANCE_LENGTH,
  MAX_PROTOCOLS,
  METHOD,
  MODES,
  type ClientKind,
  type Mode,
} from "./constants.ts";
import { decode32, isNonce, type BindBody } from "./proofs.ts";

export type JsonObject = Record<string, unknown>;

/** The client details of the bind frame (A2 3.6.3). */
export interface ClientInfo {
  readonly kind: ClientKind;
  readonly version: string;
  readonly build: string;
  readonly pid: number;
  /** The package identity of a packaged parent (Windows), else null (A2 3.5 rule 7). */
  readonly package: string | null;
  /**
   * Which of the client's standard streams are terminals. `stderr` is absent from a client that
   * does not send it, which reads as no terminal there.
   */
  readonly tty: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr?: boolean };
}

export interface Challenge {
  readonly nonce: string;
  readonly instance: string;
  readonly protocols: readonly number[];
}

export interface Hello {
  readonly protocol: number;
  readonly mode: Mode;
  readonly nonce: string;
  readonly proof: string;
}

export interface BindFrame {
  readonly body: BindBody;
  readonly mac: string;
}

/** The highest protocol number either side accepts in a message. */
const MAX_PROTOCOL_NUMBER = 1_000_000;
const INSTANCE = /^[A-Za-z0-9_.:-]+$/;
const MAX_LABEL = 64;
const MAX_PACKAGE = 256;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` has exactly these keys, no more and no fewer. */
function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** A line as a JSON object, or undefined when it does not parse to one. */
export function parseLine(line: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isProtocolNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_PROTOCOL_NUMBER
  );
}

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export function isInstanceId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_INSTANCE_LENGTH && INSTANCE.test(value);
}

// --- challenge: service to client, first line on every connection

export function challengeMessage(challenge: Challenge): JsonObject {
  return {
    jsonrpc: "2.0",
    method: METHOD.challenge,
    params: {
      nonce: challenge.nonce,
      instance: challenge.instance,
      protocols: [...challenge.protocols],
    },
  };
}

/** The challenge. Unknown extra params are ignored: the client sends none of them anywhere. */
export function parseChallenge(line: string): Challenge | undefined {
  const message = parseLine(line);
  if (message === undefined || !hasExactKeys(message, ["jsonrpc", "method", "params"])) {
    return undefined;
  }
  const params = message["params"];
  if (message["jsonrpc"] !== "2.0" || message["method"] !== METHOD.challenge) return undefined;
  if (!isObject(params)) return undefined;
  const { nonce, instance, protocols } = params;
  if (!isNonce(nonce) || !isInstanceId(instance) || !Array.isArray(protocols)) return undefined;
  if (protocols.length === 0 || protocols.length > MAX_PROTOCOLS) return undefined;
  if (!protocols.every(isProtocolNumber) || new Set(protocols).size !== protocols.length) {
    return undefined;
  }
  return { nonce, instance, protocols };
}

// --- hello: client to service. Only the protocol, the mode, the nonce and the proof.

export function helloMessage(hello: Hello): JsonObject {
  return {
    jsonrpc: "2.0",
    id: HELLO_ID,
    method: METHOD.hello,
    params: {
      protocol: hello.protocol,
      mode: hello.mode,
      nonce: hello.nonce,
      proof: hello.proof,
    },
  };
}

/** The hello, read strictly: exactly these fields, a 32-byte nonce and a 32-byte proof. */
export function parseHello(line: string): Hello | undefined {
  const message = parseLine(line);
  if (message === undefined || !hasExactKeys(message, ["jsonrpc", "id", "method", "params"])) {
    return undefined;
  }
  if (
    message["jsonrpc"] !== "2.0" ||
    message["id"] !== HELLO_ID ||
    message["method"] !== METHOD.hello
  ) {
    return undefined;
  }
  const params = message["params"];
  if (!isObject(params) || !hasExactKeys(params, ["protocol", "mode", "nonce", "proof"])) {
    return undefined;
  }
  const { protocol, mode, nonce, proof } = params;
  if (!isProtocolNumber(protocol) || !isMode(mode) || !isNonce(nonce)) return undefined;
  if (typeof proof !== "string" || decode32(proof) === undefined) return undefined;
  return { protocol, mode, nonce, proof };
}

// --- server proof: service to client, only after the client proof verified

export function proofMessage(proof: string): JsonObject {
  return { jsonrpc: "2.0", id: HELLO_ID, result: { proof } };
}

/** The server proof's text, or undefined when the line is anything else. */
export function parseProof(line: string): string | undefined {
  const message = parseLine(line);
  if (message === undefined || !hasExactKeys(message, ["jsonrpc", "id", "result"])) {
    return undefined;
  }
  const result = message["result"];
  if (message["jsonrpc"] !== "2.0" || message["id"] !== HELLO_ID || !isObject(result)) {
    return undefined;
  }
  if (!hasExactKeys(result, ["proof"])) return undefined;
  const proof = result["proof"];
  return typeof proof === "string" ? proof : undefined;
}

// --- bind: client to service, only after the server proof verified

export function bindMessage(body: BindBody, mac: string): JsonObject {
  return {
    jsonrpc: "2.0",
    id: BIND_ID,
    method: METHOD.bind,
    params: {
      protocol: body.protocol,
      mode: body.mode,
      client: body.client,
      context: body.context,
      mac,
    },
  };
}

/**
 * The bind frame, read strictly. `client` and `context` stay as received: the transcript covers
 * them as they are, and they are checked only after the bind proof verified.
 */
export function parseBind(line: string): BindFrame | undefined {
  const message = parseLine(line);
  if (message === undefined || !hasExactKeys(message, ["jsonrpc", "id", "method", "params"])) {
    return undefined;
  }
  if (
    message["jsonrpc"] !== "2.0" ||
    message["id"] !== BIND_ID ||
    message["method"] !== METHOD.bind
  ) {
    return undefined;
  }
  const params = message["params"];
  if (
    !isObject(params) ||
    !hasExactKeys(params, ["protocol", "mode", "client", "context", "mac"])
  ) {
    return undefined;
  }
  const { protocol, mode, client, context, mac } = params;
  if (!isProtocolNumber(protocol) || !isMode(mode) || typeof mac !== "string") return undefined;
  return { body: { protocol, mode, client, context }, mac };
}

/** The client details, checked field by field. Unknown fields make it invalid. */
export function parseClientInfo(value: unknown): ClientInfo | undefined {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["kind", "version", "build", "pid", "package", "tty"])
  ) {
    return undefined;
  }
  const { kind, version, build, pid, tty } = value;
  const pkg = value["package"];
  if (typeof kind !== "string" || !(CLIENT_KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }
  if (!isLabel(version) || !isLabel(build)) return undefined;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 0) return undefined;
  if (pkg !== null && (typeof pkg !== "string" || pkg.length > MAX_PACKAGE)) return undefined;
  if (
    !isObject(tty) ||
    !(hasExactKeys(tty, ["stdin", "stdout"]) || hasExactKeys(tty, ["stdin", "stdout", "stderr"]))
  ) {
    return undefined;
  }
  const { stdin, stdout, stderr } = tty;
  if (typeof stdin !== "boolean" || typeof stdout !== "boolean") return undefined;
  if (stderr !== undefined && typeof stderr !== "boolean") return undefined;
  return {
    kind: kind as ClientKind,
    version,
    build,
    pid,
    package: pkg,
    tty: stderr === undefined ? { stdin, stdout } : { stdin, stdout, stderr },
  };
}

function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LABEL;
}

// --- bind result: service to client

export function bindResultMessage(result: JsonObject, mac: string): JsonObject {
  return { jsonrpc: "2.0", id: BIND_ID, result: { ...result, mac } };
}

/** The bind result without its mac, and the mac. Undefined for anything else. */
export function parseBindResult(line: string): { result: JsonObject; mac: string } | undefined {
  const message = parseLine(line);
  if (message === undefined || !hasExactKeys(message, ["jsonrpc", "id", "result"])) {
    return undefined;
  }
  const result = message["result"];
  if (message["jsonrpc"] !== "2.0" || message["id"] !== BIND_ID || !isObject(result)) {
    return undefined;
  }
  const { mac, ...rest } = result;
  return typeof mac === "string" ? { result: rest, mac } : undefined;
}
