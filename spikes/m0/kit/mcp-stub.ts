// A hand-written stub MCP server for the M0 spike kit, for both protocol eras (A2 3.6.4), checked
// against the official schemas (modelcontextprotocol/modelcontextprotocol, schema/2025-11-25 and
// schema/2026-07-28, fetched 2026-11-12):
// - Legacy (2025-11-25 and earlier): the version is negotiated once at `initialize`. An unknown
//   version gets the server's latest legacy version back (2025-11-25 lifecycle). A missing one is
//   invalid params.
// - 2026-07-28: every request carries its version in `_meta`. An unsupported version gets
//   UnsupportedProtocolVersionError (-32022, data.supported and data.requested). A request without
//   one is invalid params: `server/discover`, and any request with a 2026-only `_meta` key or
//   params field (see `eraOf`). A supported version without `clientCapabilities` is invalid too. Every result carries `resultType`, and the
//   cacheable ones (`server/discover`, `tools/list`) carry `ttlMs` and `cacheScope`. `ping` is not
//   part of that revision.
// The stand-in service, the forwarder's offline answers and the probe server all use it. It answers
// the few messages the lab rows need and nothing more. Row A07 checks the official SDK clients and
// server separately (M0.09).
import { SPIKE_VERSION, asObject, safeLabel, type Json, type JsonObject } from "./wire.ts";

export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MODERN_VERSIONS = ["2026-07-28"] as const;
/** The `_meta` key that carries a 2026-07-28 request's protocol version. */
export const VERSION_META = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
export const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
export const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
/** UnsupportedProtocolVersionError (2026-07-28 schema). */
export const UNSUPPORTED_VERSION = -32022;
export const INVALID_PARAMS = -32602;
export const METHOD_NOT_FOUND = -32601;
/** The caching hints of the cacheable results: the stub's lists may change with the service. */
const CACHE_HINTS = { ttlMs: 0, cacheScope: "private" } as const;

export type Era = "legacy" | "2026-07-28";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface ToolResult {
  [key: string]: Json;
  content: { type: "text"; text: string }[];
}

/** One request's metadata, constrained by `safeLabel` so it is safe to log. */
export interface RequestInfo {
  method: string;
  era: Era;
  /** The version the request names, or null when it names none. */
  version: string | null;
  /** The client's self-reported name and version, when the request carries them. */
  client: string | null;
  clientVersion: string | null;
}

export interface StubConfig {
  name: string;
  instructions: string;
  tools: ToolDef[];
  call: (name: string, args: JsonObject) => ToolResult;
  onRequest?: (info: RequestInfo) => void;
}

const CAPABILITIES = { tools: { listChanged: false } };

const ok = (id: Json, result: JsonObject): JsonObject => ({ jsonrpc: "2.0", id, result });
const fail = (id: Json, code: number, message: string, data?: JsonObject): JsonObject => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

export const textResult = (text: string, isError = false): ToolResult =>
  isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] };

/**
 * The `_meta` keys and params fields that exist only in 2026-07-28 requests (schema/2026-07-28
 * schema.ts: RequestMetaObject and InputResponseRequestParams, absent from 2025-11-25). Legacy
 * requests may carry `_meta` too (progressToken, io.modelcontextprotocol/related-task), so a
 * `_meta` alone marks nothing.
 */
export const MODERN_META_KEYS = [
  VERSION_META,
  CLIENT_INFO_META,
  CLIENT_CAPABILITIES_META,
  "io.modelcontextprotocol/logLevel",
] as const;
export const MODERN_PARAMS = ["inputResponses", "requestState"] as const;
/** Methods that exist only in 2026-07-28. */
export const MODERN_METHODS = ["server/discover", "subscriptions/listen"] as const;

/**
 * The era a request belongs to. `initialize` is legacy. A 2026-07-28 method, or any 2026-only
 * `_meta` key or params field, makes it 2026-07-28, with or without its version: a request that
 * carries 2026 metadata but no version is answered -32602, never as legacy (review round 2,
 * finding C). Anything else is legacy.
 */
export function eraOf(message: JsonObject): Era {
  const method = message["method"];
  if (method === "initialize") return "legacy";
  if (typeof method === "string" && (MODERN_METHODS as readonly string[]).includes(method)) {
    return "2026-07-28";
  }
  const params = asObject(message["params"]) ?? {};
  const meta = asObject(params["_meta"]) ?? {};
  if (MODERN_META_KEYS.some((key) => key in meta)) return "2026-07-28";
  if (MODERN_PARAMS.some((field) => field in params)) return "2026-07-28";
  return "legacy";
}

/** A tool result for a request of `era`: 2026-07-28 results carry `resultType`. */
export function toolResultFor(era: Era, result: ToolResult): JsonObject {
  return era === "legacy" ? result : { ...result, resultType: "complete" };
}

const includes = (list: readonly string[], value: Json | undefined): value is string =>
  typeof value === "string" && list.includes(value);

/** Returns a function that answers one incoming MCP message, or returns null for none. */
export function createMcpResponder(config: StubConfig): (message: JsonObject) => JsonObject | null {
  const serverInfo = { name: config.name, version: SPIKE_VERSION };

  function legacy(id: Json, method: string, params: JsonObject): JsonObject {
    switch (method) {
      case "initialize": {
        const requested = params["protocolVersion"];
        if (typeof requested !== "string") {
          return fail(id, INVALID_PARAMS, "initialize needs a protocolVersion", {
            supported: [...LEGACY_VERSIONS],
          });
        }
        return ok(id, {
          protocolVersion: includes(LEGACY_VERSIONS, requested) ? requested : LEGACY_VERSIONS[0],
          capabilities: CAPABILITIES,
          serverInfo,
          instructions: config.instructions,
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: config.tools as unknown as Json[] });
      case "tools/call":
        return callTool(id, params);
      default:
        return fail(id, METHOD_NOT_FOUND, "Method not found");
    }
  }

  function modern(id: Json, method: string, params: JsonObject): JsonObject {
    const meta = asObject(params["_meta"]);
    const requested = meta?.[VERSION_META];
    if (typeof requested !== "string") {
      return fail(id, INVALID_PARAMS, `Every request needs _meta["${VERSION_META}"]`, {
        supported: [...MODERN_VERSIONS],
      });
    }
    if (!includes(MODERN_VERSIONS, requested)) {
      return fail(id, UNSUPPORTED_VERSION, "Unsupported protocol version", {
        supported: [...MODERN_VERSIONS],
        requested,
      });
    }
    // RequestMetaObject requires the client's capabilities on every request too.
    if (asObject(meta?.[CLIENT_CAPABILITIES_META]) === undefined) {
      return fail(id, INVALID_PARAMS, `Every request needs _meta["${CLIENT_CAPABILITIES_META}"]`);
    }
    const complete = (result: JsonObject): JsonObject =>
      ok(id, { ...result, resultType: "complete", _meta: { [SERVER_INFO_META]: serverInfo } });
    switch (method) {
      case "server/discover":
        return complete({
          supportedVersions: [...MODERN_VERSIONS],
          capabilities: CAPABILITIES,
          instructions: config.instructions,
          ...CACHE_HINTS,
        });
      case "tools/list":
        return complete({ tools: config.tools as unknown as Json[], ...CACHE_HINTS });
      case "tools/call": {
        const reply = callTool(id, params);
        const result = asObject(reply["result"]);
        return result === undefined ? reply : complete(result);
      }
      default:
        return fail(id, METHOD_NOT_FOUND, "Method not found");
    }
  }

  function callTool(id: Json, params: JsonObject): JsonObject {
    const name = params["name"];
    if (typeof name !== "string" || !config.tools.some((t) => t.name === name)) {
      return fail(id, INVALID_PARAMS, "Unknown tool");
    }
    return ok(id, config.call(name, asObject(params["arguments"]) ?? {}));
  }

  return (message) => {
    const method = message["method"];
    if (typeof method !== "string") return null;
    const id = message["id"];
    const isRequest = typeof id === "string" || typeof id === "number";
    const params = asObject(message["params"]) ?? {};
    const meta = asObject(params["_meta"]);
    const era = eraOf(message);
    const version = era === "legacy" ? params["protocolVersion"] : meta?.[VERSION_META];
    const info = asObject(params["clientInfo"]) ?? asObject(meta?.[CLIENT_INFO_META]);
    config.onRequest?.({
      method: safeLabel(method) ?? "[invalid]",
      era,
      version: method === "initialize" || era !== "legacy" ? safeLabel(version, 32) : null,
      client: safeLabel(info?.["name"]),
      clientVersion: safeLabel(info?.["version"], 32),
    });
    if (!isRequest) return null;
    return era === "legacy" ? legacy(id, method, params) : modern(id, method, params);
  };
}

/** The stand-in service's two stub tools: one read call and one echo. */
export const STUB_TOOLS: ToolDef[] = [
  {
    name: "status",
    description: "Returns the stand-in service's status. A read call for the bridge benchmarks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "echo",
    description: "Returns the text it is given.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
];

export const STUB_INSTRUCTIONS =
  "Tasks stand-in service for the M0 lab. It holds no tasks. Use the status tool to check it.";

export const OFFLINE_TEXTS = {
  service_unavailable:
    "Tasks's service is not running on this machine. Nothing was saved. Ask the user to run `tasks service start`, then retry.",
  untrusted_endpoint:
    "Something other than Tasks is listening at Tasks's address. Nothing was sent to it. Ask the user to run `tasks doctor`.",
  connection_lost:
    "Tasks restarted during this call. It may or may not have been applied. Retry with the same request ID.",
} as const;
