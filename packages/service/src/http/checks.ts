// The request checks of A2 3.8.3, as one pure function over a request's facts, so the whole check
// matrix (A2 5: "every combination of Host, Origin, Sec-Fetch-Site, method, content type and token
// presence, with the expected status") is a table test, and the server cannot skip a step.
//
// They run before anything else, in this order, and the first that fails decides the status:
//
//   0. The request's form: HTTP/1.1 only (A2 3.8.1), else 505; and each header the checks read
//      (Host, Origin, Sec-Fetch-Site, Content-Type, Authorization and the like) at most once,
//      else 400. Node keeps the first of a repeated Host or Authorization and drops the rest, so a
//      repeat is refused rather than read one way here and another way by anything else.
//   1. Host: exactly `127.0.0.1:<port>` or `localhost:<port>`. Anything else: 421. This stops DNS
//      rebinding: a page of another site that resolves its own name to 127.0.0.1 still sends its
//      own name.
//   2. OPTIONS: 403. No CORS headers are ever sent, so a cross-origin page can never send the
//      Authorization header or a JSON body.
//   3. POST without `Content-Type: application/json`: 415. A form post is refused before anything
//      reads it.
//   4. `/api/*` (the WebSocket's path too) with a `Sec-Fetch-Site` other than `same-origin` or
//      `none`: 403.
//   5. Origin, on every request that is not a GET and on every WebSocket upgrade: exactly
//      `http://127.0.0.1:<port>` or `http://localhost:<port>`. Missing or different: 403. One
//      exception: `auth/probe` may come without one (`tasks open` calls it from Node). A present
//      Origin that is wrong is refused everywhere, GET included.
//   6. The method the route takes: GET for the shell (also at the page's own routes, `/s/…`),
//      its files, `/healthz`, `/.well-known/tasks` and the WebSocket; POST for the API. Else 405.
//   7. Authentication: every `/api/*` route but `auth/redeem` and `auth/probe` needs
//      `Authorization: Bearer <token>`, and the WebSocket a ticket; 401 otherwise. Whether the
//      token is live is the server's next step, with the same 401.
//   8. A route that does not exist: 404 (an API path only after authentication, so an
//      unauthenticated caller learns nothing about routes).
import { httpHeader } from "@tasks/brand";
import type { Refusal, Route } from "./events.ts";

/** The API's own prefix. Every path under it is checked as an API path. */
export const API_PREFIX = "/api/";
export const PROBE_PATH = "/api/v1/auth/probe";
export const REDEEM_PATH = "/api/v1/auth/redeem";
export const WS_TICKET_PATH = "/api/v1/ws-ticket";
export const WS_PATH = "/api/v1/ws";
export const OP_PREFIX = "/api/v1/op/";
/** The page's launch receipts (launches.ts): `list`. Open is the registry's `launch.open`. */
export const LAUNCH_PREFIX = "/api/v1/launch/";
export const LAUNCH_ACTIONS: readonly string[] = ["list"];
/**
 * The page's space switcher: this machine's spaces, Make default, and New space (a name's
 * proposal, then the space) and Open folder.
 */
export const SPACE_PREFIX = "/api/v1/space/";
export const SPACE_ACTIONS: readonly string[] = ["list", "default", "propose", "create", "open"];
/**
 * This computer: the preferences the page sets, Open's terminal, the agent apps, and the folder
 * chooser (the folders in a folder, a new folder, a project's folders).
 */
export const MACHINE_PREFIX = "/api/v1/machine/";
export const MACHINE_ACTIONS: readonly string[] = [
  "pref",
  "terminal",
  "apps",
  "apps_apply",
  "folders",
  "folder_make",
  "project_folder",
];
export const HEALTHZ_PATH = "/healthz";
export const WELL_KNOWN_PATH = "/.well-known/tasks";
export const ASSET_PREFIX = "/assets/";
/**
 * The page's own routes (A5 3.3: `/s/:space/…`), which a reload or a link asks for: the shell. At
 * most four plain segments after the space (`area/<id>/project/<id>`), so the shape alone decides
 * and no other path becomes the shell.
 */
export const APP_ROUTE = /^\/s\/[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,64}){0,4}\/?$/;

/** What a request presents, before any byte of its body is read. */
export interface RequestFacts {
  readonly method: string;
  /** The path without its query. Never logged. */
  readonly path: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly fetchSite: string | undefined;
  readonly contentType: string | undefined;
  /** Whether an `Authorization: Bearer …` header is present. Its value is checked later. */
  readonly bearer: boolean;
  /** Whether this is a WebSocket upgrade (`Upgrade: websocket`). */
  readonly upgrade: boolean;
  /** The HTTP version (`1.1`). The listener always tells; the matrix leaves it out. */
  readonly version?: string;
  /** Whether a header of SINGLE_HEADERS came more than once. */
  readonly repeated?: boolean;
}

/** The headers a request may carry once at most: the ones the checks and the routes read. */
export const SINGLE_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "origin",
  "sec-fetch-site",
  "content-type",
  "content-length",
  "authorization",
  "expect",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  httpHeader("build"),
  httpHeader("space"),
]);

/** Whether a header of SINGLE_HEADERS occurs more than once in Node's `rawHeaders`. */
export function repeatedHeader(rawHeaders: readonly string[]): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] ?? "").toLowerCase();
    if (!SINGLE_HEADERS.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

/** What the server may serve: the routes that exist in this listener. */
export interface RouteTable {
  /** Whether `POST /api/v1/op/<name>` exists (contracts' http-routes.ts). */
  hasOp(name: string): boolean;
  /** Whether a GET of this path is a file of the UI (the shell, an asset, a root file). */
  hasFile(path: string): boolean;
}

export type Verdict =
  | { readonly ok: true; readonly route: Route }
  | {
      readonly ok: false;
      readonly route: Route;
      readonly status: number;
      readonly reason: Refusal;
    };

/** The route a path names, by its shape alone. */
export function routeOf(path: string, files: Pick<RouteTable, "hasFile">): Route {
  if (path === PROBE_PATH) return "probe";
  if (path === REDEEM_PATH) return "redeem";
  if (path === WS_TICKET_PATH) return "ws_ticket";
  if (path === WS_PATH) return "ws";
  if (path.startsWith(OP_PREFIX)) return "op";
  if (path.startsWith(LAUNCH_PREFIX)) return "launch";
  if (path.startsWith(SPACE_PREFIX)) return "space";
  if (path.startsWith(MACHINE_PREFIX)) return "machine";
  if (path.startsWith(API_PREFIX) || path === "/api") return "api_other";
  if (path === HEALTHZ_PATH) return "healthz";
  if (path === WELL_KNOWN_PATH) return "well_known";
  if (path === "/" || path === "/index.html" || APP_ROUTE.test(path)) return "shell";
  if (path.startsWith(ASSET_PREFIX) && files.hasFile(path)) return "asset";
  if (files.hasFile(path)) return "file";
  return "other";
}

const isApi = (route: Route): boolean =>
  route === "probe" ||
  route === "redeem" ||
  route === "ws_ticket" ||
  route === "ws" ||
  route === "op" ||
  route === "launch" ||
  route === "space" ||
  route === "machine" ||
  route === "api_other";

/** The origins this listener belongs to. `tasks open` always uses the first. */
export function originsOf(port: number): readonly string[] {
  return [`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`];
}

/** The Host values this listener answers. */
export function hostsOf(port: number): readonly string[] {
  return [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
}

/** Whether a Content-Type names JSON: `application/json`, with parameters such as a charset. */
export function isJson(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const [type] = contentType.split(";");
  return type?.trim().toLowerCase() === "application/json";
}

const refuse = (route: Route, status: number, reason: Refusal): Verdict => ({
  ok: false,
  route,
  status,
  reason,
});

/** A2 3.8.3's checks, in order. The first that fails decides. */
export function checkRequest(port: number, facts: RequestFacts, table: RouteTable): Verdict {
  const route = routeOf(facts.path, table);
  // 0. The form: HTTP/1.1, and no header the checks read sent twice.
  if (facts.version !== undefined && facts.version !== "1.1") return refuse(route, 505, "version");
  if (facts.repeated === true) return refuse(route, 400, "repeated");
  // 1. Host: DNS rebinding sends the attacker's own name.
  const host = facts.host?.toLowerCase();
  if (host === undefined || !hostsOf(port).includes(host)) return refuse(route, 421, "host");
  // 2. No CORS: a preflight is refused, and no CORS header is ever sent.
  if (facts.method === "OPTIONS") return refuse(route, 403, "options");
  // 3. Only JSON is posted: form posts are refused before anything reads them.
  if (facts.method === "POST" && !isJson(facts.contentType)) {
    return refuse(route, 415, "content_type");
  }
  // 4. Sec-Fetch-Site on the API, when the browser sends it.
  const api = isApi(route);
  if (
    api &&
    facts.fetchSite !== undefined &&
    facts.fetchSite !== "same-origin" &&
    facts.fetchSite !== "none"
  ) {
    return refuse(route, 403, "fetch_site");
  }
  // 5. Origin: required on every non-GET and every upgrade (the probe may come without one);
  //    a present one must be ours everywhere.
  const origins = originsOf(port);
  if (facts.origin !== undefined && !origins.includes(facts.origin)) {
    return refuse(route, 403, "origin");
  }
  const needsOrigin = facts.method !== "GET" || facts.upgrade;
  if (needsOrigin && facts.origin === undefined && route !== "probe") {
    return refuse(route, 403, "origin");
  }
  // 6. The method the route takes.
  const post =
    route === "probe" ||
    route === "redeem" ||
    route === "ws_ticket" ||
    route === "op" ||
    route === "launch" ||
    route === "space" ||
    route === "machine";
  if (route === "api_other") {
    if (facts.method !== "GET" && facts.method !== "POST") return refuse(route, 405, "method");
  } else if (post ? facts.method !== "POST" : facts.method !== "GET") {
    return refuse(route, 405, "method");
  }
  // 7. Authentication: a bearer token, or the WebSocket's ticket (checked by the server).
  const bearer =
    route === "ws_ticket" ||
    route === "op" ||
    route === "launch" ||
    route === "space" ||
    route === "machine" ||
    route === "api_other";
  if (bearer && !facts.bearer) return refuse(route, 401, "token");
  if (route === "ws" && !facts.upgrade) return refuse(route, 426, "upgrade");
  if (route !== "ws" && facts.upgrade) return refuse(route, 404, "not_found");
  // 8. What exists.
  if (route === "api_other" || route === "other") return refuse(route, 404, "not_found");
  if (route === "op" && !table.hasOp(facts.path.slice(OP_PREFIX.length))) {
    return refuse(route, 404, "not_found");
  }
  if (route === "launch" && !LAUNCH_ACTIONS.includes(facts.path.slice(LAUNCH_PREFIX.length))) {
    return refuse(route, 404, "not_found");
  }
  if (route === "space" && !SPACE_ACTIONS.includes(facts.path.slice(SPACE_PREFIX.length))) {
    return refuse(route, 404, "not_found");
  }
  if (route === "machine" && !MACHINE_ACTIONS.includes(facts.path.slice(MACHINE_PREFIX.length))) {
    return refuse(route, 404, "not_found");
  }
  return { ok: true, route };
}

/** The bearer token of an `Authorization` header, or undefined. Its value is never logged. */
export function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header);
  return match?.[1];
}
