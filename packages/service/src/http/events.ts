// The HTTP listener's words: its routes, its refusals and its events (A2 3.8.3 "Logging: method,
// route, status, duration, connection class. Never bodies, tokens or task text").
//
// Every word is from a closed list here, and the hub's log catalogue (hub/log.ts `http.*`) takes
// these lists as the only values its fields accept, so a request's path, query, headers or body
// can never reach the log. This module imports nothing from the hub, so the catalogue can import
// it without a cycle (the local library's events work the same way).
import { registry } from "@tasks/contracts";

/** What a request asks for, as one word. The path itself is never logged. */
export const ROUTES = [
  /** `/`, `/index.html` and the page's own routes (`/s/…`): the app shell, with a fresh nonce. */
  "shell",
  /** `/assets/<file>`: the shell's hashed, immutable files. */
  "asset",
  /** A file of the UI's build at the root, such as `/manifest.webmanifest`. */
  "file",
  /** `/healthz`: `ok`, for doctor and for other local users (A2 3.8.5). */
  "healthz",
  /** `/.well-known/tasks`: `{"app":"tasks","protocol":1}`. */
  "well_known",
  /** `POST /api/v1/auth/probe`: `tasks open` checks the listener before it trusts the port. */
  "probe",
  /** `POST /api/v1/auth/redeem`: a fragment code for a bearer token. */
  "redeem",
  /** `POST /api/v1/ws-ticket`: a 30 s single-use WebSocket ticket. */
  "ws_ticket",
  /** `GET /api/v1/ws?ticket=…`: the change feed's WebSocket. */
  "ws",
  /** `POST /api/v1/op/<entry>`: one registry entry with a UI face (contracts' http-routes.ts). */
  "op",
  /** `POST /api/v1/launch/<action>`: a task's launch receipts, Run, its runs, Stop (launches.ts). */
  "launch",
  /** `POST /api/v1/space/list` and `/default`: the page's space switcher and Make default. */
  "space",
  /** `POST /api/v1/machine/pref` and `/terminal`: Settings for this machine. */
  "machine",
  /** Another path under `/api/`. */
  "api_other",
  /** Any other path. */
  "other",
] as const;
export type Route = (typeof ROUTES)[number];

/** HTTP methods as the log names them. Another method is `other`. */
export const METHODS = [
  "GET",
  "POST",
  "HEAD",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "other",
] as const;
export type Method = (typeof METHODS)[number];

export function methodWord(method: string | undefined): Method {
  return (METHODS as readonly string[]).includes(method ?? "") ? (method as Method) : "other";
}

/** Why a request was refused before its handler ran. */
export const REFUSALS = [
  "host",
  "options",
  "content_type",
  "fetch_site",
  "origin",
  "method",
  "token",
  "not_found",
  "upgrade",
  "ticket",
  "too_large",
  "bad_json",
  "rate",
  "build",
  "code",
  "peer",
  "capacity",
  "blocked",
  "timeout",
  /** Not HTTP/1.1 (A2 3.8.1). */
  "version",
  /** A header the checks read came twice. */
  "repeated",
  /** An `Expect` other than `100-continue`. */
  "expect",
  /** A WebSocket handshake that is not RFC 6455's (its key, version or subprotocol). */
  "handshake",
] as const;
export type Refusal = (typeof REFUSALS)[number];

/** The connection class of a request: `ui` once a token or ticket proved it, else `none`. */
export const HTTP_CLASSES = ["ui", "none"] as const;
export type HttpClass = (typeof HTTP_CLASSES)[number];

/** The registry entries, the only names an `op` route's `entry` field may carry. */
export const ENTRY_NAMES: readonly string[] = registry.map((entry) => entry.name);

/** How the listener's port was chosen (A2 3.8.2). */
export const PORT_OUTCOMES = ["persisted", "first", "moved", "blocked", "none"] as const;
export type PortOutcome = (typeof PORT_OUTCOMES)[number];

/** Why a WebSocket closed from the service's side. */
export const WS_CLOSES = [
  "client",
  "revoked",
  /** The token expired (7 days unused, or 30 days old) while the feed was open. */
  "expired",
  "slow_reader",
  "silent",
  "bad_message",
  "too_large",
  "shutdown",
  "blocked",
] as const;
export type WsClose = (typeof WS_CLOSES)[number];

/** The listener's events, as plain values: the hub turns each into a log line (hub/log.ts). */
export type HttpEvent =
  | {
      readonly ev: "http.request";
      readonly method: Method;
      readonly route: Route;
      readonly status: number;
      readonly ms: number;
      readonly class: HttpClass;
      readonly entry?: string;
    }
  | {
      readonly ev: "http.refused";
      readonly route: Route;
      readonly status: number;
      readonly reason: Refusal;
    }
  | { readonly ev: "http.listening"; readonly outcome: PortOutcome; readonly moved: boolean }
  | { readonly ev: "http.blocked"; readonly revoked: number }
  | { readonly ev: "http.port_retry"; readonly outcome: "kept" | "moved_back" | "blocked" }
  | { readonly ev: "http.peer_refused"; readonly reason: "other_user" | "unknown" }
  | { readonly ev: "http.capacity"; readonly kind: "unauthenticated" | "total" | "token" }
  | { readonly ev: "http.ws_closed"; readonly reason: WsClose; readonly ms: number }
  | { readonly ev: "http.feed_failed"; readonly stage: "snapshot" | "batch" | "poll" }
  | { readonly ev: "http.grants_failed"; readonly stage: "load" | "write" }
  | { readonly ev: "http.holder_check_failed"; readonly os: "linux" | "windows" | "macos" }
  /** A sighting (A2 3.8.2 step 3) or a first start's port could not be written. */
  | { readonly ev: "http.port_write_failed"; readonly stage: "sighting" | "persist" }
  /** A launch's dispatch ended with an error the machine did not record (launches.ts). */
  | { readonly ev: "http.launch_failed"; readonly stage: "dispatch" };

export type HttpLog = (event: HttpEvent) => void;
