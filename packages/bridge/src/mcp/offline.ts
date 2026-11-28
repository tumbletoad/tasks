// The offline responder. While the bridge cannot reach the service, it answers
// from `<cache>/mcp-offline.json` when that file parses and its `build` is the bridge's own, and
// otherwise from `lib/mcp-offline.json` in its own version folder.
// The bridge only fills in IDs, the legacy era's negotiated version, and the text of a tool
// call's error.
import { readFileSync, statSync } from "node:fs";
import type { JsonObject } from "../protocol/index.ts";
import { VERSION_META, eraOf, isObject, type Era, type RequestId } from "./message.ts";
import { PRODUCT_NAME } from "./names.ts";
import type { OfflineReason } from "./unavailable.ts";

/** The texts a tool call gets, one per reason. */
export const TEXT_KEYS = [
  "service_down",
  "starting",
  "unreachable",
  "untrusted_endpoint",
  "restart_session",
  "service_too_old",
  "connection_lost",
] as const;
export type TextKey = (typeof TEXT_KEYS)[number];

/** Which text a reason gets. `not_running` is `service_down`. */
export const TEXT_OF: Readonly<Record<OfflineReason, TextKey>> = {
  not_running: "service_down",
  starting: "starting",
  unreachable: "unreachable",
  untrusted_endpoint: "untrusted_endpoint",
  restart_session: "restart_session",
  service_too_old: "service_too_old",
  connection_lost: "connection_lost",
};

/** The file's format. */
export interface OfflineContent {
  readonly format: 1;
  readonly build: string;
  /** The legacy era's `initialize` result and the versions it negotiates, newest first or not. */
  readonly initialize: { readonly result: JsonObject; readonly supported_versions: string[] };
  /** The 2026-07-28 `server/discover` result and the versions every request may name. */
  readonly discover: { readonly result: JsonObject; readonly supported_versions: string[] };
  /** `tools/list` as each era's live connection returns it. */
  readonly tools_list: { readonly result: JsonObject; readonly modern_result: JsonObject };
  /** Fields every 2026-07-28 result the bridge builds itself carries (`resultType` and the rest). */
  readonly modern_result_fields: JsonObject;
  readonly texts: Readonly<Record<TextKey, string>>;
}

/** The file holds a tool list and two results: a few tens of KiB. */
export const MAX_OFFLINE_BYTES = 1024 * 1024;

const isVersions = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");

/** The content of an offline file, or undefined when it is not exactly format 1. */
export function parseOffline(text: string): OfflineContent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value["format"] !== 1 || typeof value["build"] !== "string") {
    return undefined;
  }
  const { initialize, discover, tools_list: tools, modern_result_fields: fields, texts } = value;
  if (!isObject(initialize) || !isObject(initialize["result"])) return undefined;
  if (!isVersions(initialize["supported_versions"])) return undefined;
  if (!isObject(discover) || !isObject(discover["result"])) return undefined;
  if (!isVersions(discover["supported_versions"])) return undefined;
  if (!isObject(tools) || !isObject(tools["result"]) || !isObject(tools["modern_result"])) {
    return undefined;
  }
  if (!isObject(fields) || !isObject(texts)) return undefined;
  if (!TEXT_KEYS.every((key) => typeof texts[key] === "string")) return undefined;
  return value as unknown as OfflineContent;
}

function readOffline(file: string): OfflineContent | undefined {
  try {
    if (statSync(file).size > MAX_OFFLINE_BYTES) return undefined;
    return parseOffline(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The cache when it parses and was written for this build, else the build's own file. */
export function loadOffline(
  files: { readonly cache: string | undefined; readonly lib: string },
  build: string,
): OfflineContent | undefined {
  const cached = files.cache === undefined ? undefined : readOffline(files.cache);
  if (cached !== undefined && cached.build === build) return cached;
  return readOffline(files.lib);
}

// --- replies

/** UnsupportedProtocolVersionError (2026-07-28). */
export const UNSUPPORTED_VERSION = -32022;
export const INVALID_PARAMS = -32602;
export const METHOD_NOT_FOUND = -32601;
/** A JSON-RPC server error: the code a lost request gets when it is not a tool call. */
export const SERVER_ERROR = -32000;

const result = (id: RequestId, value: JsonObject): JsonObject => ({
  jsonrpc: "2.0",
  id,
  result: value,
});
const failure = (id: RequestId, code: number, message: string, data?: JsonObject): JsonObject => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

/** A request the offline responder answers: what `inspect` gives for one. */
export interface OfflineRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params: JsonObject | undefined;
}

/** The newest version: MCP versions are dates, so the largest string. */
const newest = (versions: readonly string[]): string => versions.reduce((a, b) => (b > a ? b : a));

/** A tool call's error result for `key`'s text. */
function toolError(content: OfflineContent, era: Era, key: TextKey): JsonObject {
  const body = { content: [{ type: "text", text: content.texts[key] }], isError: true };
  return era === "modern" ? { ...body, ...content.modern_result_fields } : body;
}

/**
 * The offline reply to one request. `key` is the text a tool call gets. A
 * 2026-07-28 request is first checked for its protocol version, as that specification requires.
 * `session` is the era the session began in, when known: every request of a 2026-07-28 session
 * is checked, also one that carries no 2026-07-28 field at all.
 */
export function offlineReply(
  content: OfflineContent,
  request: OfflineRequest,
  key: TextKey,
  session?: Era,
): JsonObject {
  const { id, method, params } = request;
  const era = eraOf(method, params, session);
  if (era === "modern") {
    const meta = isObject(params?.["_meta"]) ? params["_meta"] : undefined;
    const requested = meta?.[VERSION_META];
    const supported = content.discover.supported_versions;
    if (typeof requested !== "string") {
      return failure(id, INVALID_PARAMS, "Every request needs its protocol version", {
        supported: [...supported],
      });
    }
    if (!supported.includes(requested)) {
      return failure(id, UNSUPPORTED_VERSION, "Unsupported protocol version", {
        supported: [...supported],
        requested,
      });
    }
  }
  switch (method) {
    case "initialize": {
      const versions = content.initialize.supported_versions;
      const asked = params?.["protocolVersion"];
      const protocolVersion =
        typeof asked === "string" && versions.includes(asked) ? asked : newest(versions);
      return result(id, { ...content.initialize.result, protocolVersion });
    }
    case "server/discover":
      return result(id, content.discover.result);
    case "tools/list":
      return result(
        id,
        era === "modern" ? content.tools_list.modern_result : content.tools_list.result,
      );
    case "tools/call":
      return result(id, toolError(content, era, key));
    case "ping":
      // 2026-07-28 removed ping: the live endpoint answers it as an unknown method.
      return era === "modern" ? failure(id, METHOD_NOT_FOUND, "Method not found") : result(id, {});
    default:
      return failure(id, METHOD_NOT_FOUND, "Method not found");
  }
}

/** The text a request that cannot be answered at all gets: no offline file could be read. */
export const NO_OFFLINE_TEXT =
  "This MCP server's offline answers are missing from its installation, and its service cannot be reached. Ask the user to repair the installation.";

/**
 * The reply to a request that was in flight when the connection was lost. A tool call
 * gets the `connection_lost` text, so the model retries it with the same request ID. A request
 * whose answer does not depend on the service (initialize, discover, tools/list, ping) gets the
 * offline answer, which is the answer a live connection gives. Anything else gets a JSON-RPC error
 * that carries the same text.
 */
export function lostReply(
  content: OfflineContent | undefined,
  request: OfflineRequest,
  session?: Era,
): JsonObject {
  const answered = ["initialize", "server/discover", "tools/list", "tools/call", "ping"];
  if (content !== undefined && answered.includes(request.method)) {
    return offlineReply(content, request, "connection_lost", session);
  }
  return failure(request.id, SERVER_ERROR, content?.texts.connection_lost ?? NO_OFFLINE_TEXT, {
    code: "service_unavailable",
    reason: "connection_lost",
    retryable: true,
  });
}

/** The reply to a request when no offline file could be read. */
export function missingReply(request: OfflineRequest): JsonObject {
  return failure(request.id, SERVER_ERROR, NO_OFFLINE_TEXT);
}

/** The text a request gets when the forwarder already has its most requests in flight. */
export const BUSY_TEXT = `Too many requests are waiting for ${PRODUCT_NAME}'s service. This one was not sent. Retry it when earlier ones are answered.`;

/**
 * The reply to a request past the forwarder's in-flight cap. It never reached the service, so a
 * retry is always safe.
 */
export function busyReply(request: { readonly id: RequestId }): JsonObject {
  return failure(request.id, SERVER_ERROR, BUSY_TEXT, { retryable: true });
}
