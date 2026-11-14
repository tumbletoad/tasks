// The two MCP protocol eras (A3 3.3): 2025-11-25, negotiated at `initialize` and held for the
// connection, and 2026-07-28, where every request carries its version and is validated on its own.
//
// Everything this endpoint knows about the 2026-07-28 envelope is in this module, because that
// revision was not final when the plan was written (A3 3.3, checked 2026-11-12) and the SDK's
// support for it is new (the lab qualified SDK 2.4.0, M0 row A07). What is relied on, and verified
// only against SDK 2.4.0's own client, not against a published specification text:
// - a request is 2026-07-28 when it is `server/discover`, or when its `params._meta` carries
//   `io.modelcontextprotocol/protocolVersion` (the "envelope claim");
// - an unsupported version is refused with JSON-RPC -32022 and `data: {supported, requested}`;
// - 2026-07-28 results carry `resultType` and `_meta["io.modelcontextprotocol/serverInfo"]`, and
//   cacheable ones `ttlMs` and `cacheScope` (the SDK adds them; the offline file copies them).
// SDK 2.4.0 validates the version of the request that opens a connection, but answers a later
// request whose claim names another version as if it named the pinned one. The endpoint therefore
// checks every request's claim itself, before the SDK sees it (transport.ts).
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  UnsupportedProtocolVersionError,
} from "@modelcontextprotocol/server";

export type Era = "legacy" | "modern";

/** The `_meta` key of a 2026-07-28 request's protocol version. */
export const VERSION_META = "io.modelcontextprotocol/protocolVersion";

/** The first 2026-07-28 revision: MCP versions are dates, so a later one compares greater. */
const FIRST_MODERN = "2026-07-28";

/** The 2026-07-28 revisions this endpoint serves. */
export const MODERN_VERSIONS: readonly string[] = [FIRST_MODERN];

/** The 2025-era versions `initialize` negotiates: the SDK's, newest first. */
export const LEGACY_VERSIONS: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS.filter(
  (version) => version < FIRST_MODERN,
);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The version a request's envelope claims, or undefined when it makes no claim. */
export function claimedVersion(params: unknown): unknown {
  if (!isObject(params)) return undefined;
  const meta = params["_meta"];
  return isObject(meta) && Object.hasOwn(meta, VERSION_META) ? meta[VERSION_META] : undefined;
}

/** The era a request opens a connection in: `initialize` legacy, a discover or a claim modern. */
export function openingEra(method: string, params: unknown): Era {
  if (method === "initialize") return "legacy";
  return method === "server/discover" || claimedVersion(params) !== undefined ? "modern" : "legacy";
}

/**
 * The refusal of a 2026-07-28 request without its version: JSON-RPC -32602, as the bridge's
 * offline answer gives it (A2 3.7.4).
 */
export function missingVersion(): { code: number; message: string; data: unknown } {
  return {
    code: -32602,
    message: "Every request needs its protocol version",
    data: { supported: [...MODERN_VERSIONS] },
  };
}

/**
 * The era of one connection, request by request (A3 3.3). The first request opens it: `initialize`
 * or a request without a claim in 2025-11-25, `server/discover` or a claim in 2026-07-28. From
 * then on every 2026-07-28 request must carry its version; SDK 2.4.0 answers some that do not, so
 * this check comes first. The bridge's offline responder applies the same rule.
 *
 * A 2026-07-28 opening is not final: the SDK's stdio entry lets a client fall back to `initialize`
 * after a `server/discover`, and after an opening it refused (an invalid envelope leaves the
 * connection unopened). The SDK alone knows which, so the era turns to 2025-11-25 when the SDK
 * answers an `initialize` with a result (`served`): only a 2025-11-25 server does that. Until then
 * the connection stays as it was opened.
 */
export class EraTracker {
  #era: Era | undefined;

  get era(): Era | undefined {
    return this.#era;
  }

  /** Takes one request; false when it is a 2026-07-28 request without its version. */
  accept(method: string, params: unknown): boolean {
    const claimed = claimedVersion(params) !== undefined;
    if (method === "initialize") {
      this.#era ??= "legacy";
      return true;
    }
    if (method === "server/discover" && !claimed) return false;
    if (this.#era === undefined) {
      this.#era = claimed || method === "server/discover" ? "modern" : "legacy";
      return true;
    }
    return !(this.#era === "modern" && !claimed);
  }

  /** The SDK answered a request of `method` with a result. */
  served(method: string): void {
    if (method === "initialize") this.#era = "legacy";
  }
}

/**
 * Whether a request's claim is there but is not a version: the SDK refuses it as an invalid
 * envelope (-32602) and the bridge's offline answer as a missing version (-32602), so the endpoint
 * refuses it as a missing version too, before the SDK sees it.
 */
export function malformedClaim(params: unknown): boolean {
  const claim = claimedVersion(params);
  return claim !== undefined && typeof claim !== "string";
}

/**
 * A claimed version as the refusal echoes it to its sender: up to 64 printable ASCII characters,
 * as the bridge's offline answer keeps it (A2 3.7.4), else a fixed word.
 */
const quotable = (version: unknown): string =>
  typeof version === "string" && /^[\x20-\x7e]{1,64}$/.test(version) ? version : "unknown";

/**
 * The refusal of a request whose claim names a version this endpoint does not serve (2026-07-28:
 * UnsupportedProtocolVersionError), or undefined when it makes no claim or a served one. A request
 * without a claim on a 2026-07-28 connection is the SDK's to refuse (-32602).
 */
export function unsupportedVersion(
  params: unknown,
): { code: number; message: string; data: unknown } | undefined {
  const claim = claimedVersion(params);
  // A claim that is not a string is not a version at all (malformedClaim).
  if (typeof claim !== "string" || MODERN_VERSIONS.includes(claim)) return undefined;
  const error = new UnsupportedProtocolVersionError({
    supported: [...MODERN_VERSIONS],
    requested: quotable(claim),
  });
  return { code: error.code, message: error.message, data: error.data };
}
