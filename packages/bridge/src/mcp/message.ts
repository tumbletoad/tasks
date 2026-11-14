// What the bridge needs to know about an MCP line: its kind, its ID and its method, from one
// parse (A2 3.7.2 step 3). The line itself is forwarded unchanged. And which MCP era a request
// belongs to, which only the offline responder needs (A2 3.7.4).
import type { JsonObject } from "../protocol/index.ts";

export type RequestId = string | number;

export type Message =
  | {
      readonly kind: "request";
      readonly id: RequestId;
      readonly method: string;
      readonly params: JsonObject | undefined;
      readonly message: JsonObject;
    }
  | {
      readonly kind: "notification";
      readonly method: string;
      readonly params: JsonObject | undefined;
    }
  | { readonly kind: "response"; readonly id: RequestId }
  | { readonly kind: "other" };

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isRequestId = (value: unknown): value is RequestId =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

/** A map key for an ID: the number 1 and the string "1" are different requests. */
export const idKey = (id: RequestId): string => `${typeof id}:${String(id)}`;

const OTHER: Message = { kind: "other" };

/** One line as a JSON-RPC message. Anything else, a batch included, is `other`. */
export function inspect(line: string): Message {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return OTHER;
  }
  if (!isObject(value)) return OTHER;
  const { method, id } = value;
  const params = isObject(value["params"]) ? value["params"] : undefined;
  if (typeof method === "string") {
    if (id === undefined) return { kind: "notification", method, params };
    return isRequestId(id) ? { kind: "request", id, method, params, message: value } : OTHER;
  }
  return isRequestId(id) ? { kind: "response", id } : OTHER;
}

// --- MCP eras (A2 3.6.4, A3 3.3; the 2025-11-25 and 2026-07-28 schemas, as the M0 lab's stub
// read them, spikes/m0/kit/mcp-stub.ts)

export type Era = "legacy" | "modern";

/** The `_meta` key that carries a 2026-07-28 request's protocol version. */
export const VERSION_META = "io.modelcontextprotocol/protocolVersion";

/** `_meta` keys and params fields that exist only in 2026-07-28 requests. */
const MODERN_META_KEYS = [
  VERSION_META,
  "io.modelcontextprotocol/clientInfo",
  "io.modelcontextprotocol/clientCapabilities",
  "io.modelcontextprotocol/logLevel",
];
const MODERN_PARAMS = ["inputResponses", "requestState"];
/** Methods that exist only in 2026-07-28. */
const MODERN_METHODS = ["server/discover", "subscriptions/listen"];

/**
 * A request's era. `initialize` is legacy. A request of a session that began with
 * `server/discover` (`session` is "modern"), or with a 2026-07-28 method, `_meta` key or params
 * field, is 2026-07-28, with or without its version. Anything else is legacy.
 */
export function eraOf(method: string, params: JsonObject | undefined, session?: Era): Era {
  if (method === "initialize") return "legacy";
  if (session === "modern" || MODERN_METHODS.includes(method)) return "modern";
  const meta = isObject(params?.["_meta"]) ? params["_meta"] : undefined;
  if (meta !== undefined && MODERN_META_KEYS.some((key) => Object.hasOwn(meta, key))) {
    return "modern";
  }
  if (params !== undefined && MODERN_PARAMS.some((field) => Object.hasOwn(params, field))) {
    return "modern";
  }
  return "legacy";
}

/** A protocol version is a date; a longer string is kept only this far. */
const MAX_VERSION_CHARS = 64;

/**
 * What a request in flight keeps of its params: enough to give the same era, version and
 * negotiated version to its reply if the connection is lost, and nothing the client can make
 * large: not a tool call's arguments and not what `_meta` carries, only which 2026-07-28 keys it
 * has and the start of its version.
 */
export function lightParams(params: JsonObject | undefined): JsonObject | undefined {
  if (params === undefined) return undefined;
  const light: JsonObject = {};
  const meta = params["_meta"];
  if (isObject(meta)) {
    const kept: JsonObject = {};
    for (const key of MODERN_META_KEYS) if (Object.hasOwn(meta, key)) kept[key] = true;
    const version = meta[VERSION_META];
    if (typeof version === "string") kept[VERSION_META] = version.slice(0, MAX_VERSION_CHARS);
    light["_meta"] = kept;
  }
  const version = params["protocolVersion"];
  if (typeof version === "string" && version.length <= MAX_VERSION_CHARS) {
    light["protocolVersion"] = version;
  }
  for (const field of MODERN_PARAMS) if (Object.hasOwn(params, field)) light[field] = true;
  return light;
}

/** A request that starts a session, which the bridge keeps as `mcp_init` (A2 3.7.4). */
export const isInitRequest = (method: string): boolean =>
  method === "initialize" || method === "server/discover";
