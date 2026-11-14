// The listener's requests (A2 3.8.3, 3.8.4): every request passes checks.ts first, then its route.
// No route, file or error is served without those checks, and every response carries the security
// headers (csp.ts). Tokens, codes, tickets, bodies and paths never reach the log or an error body.
//
// Routes:
//   GET  /, /index.html, /s/…  the shell, with a fresh style nonce in its CSP and meta tag
//   GET  /assets/<file>         the shell's hashed files (immutable)
//   GET  /healthz               `ok`
//   GET  /.well-known/tasks     `{"app":"tasks","protocol":1}`
//   POST /api/v1/auth/probe     the listener's HMAC proof for `tasks open` (60 per minute)
//   POST /api/v1/auth/redeem    a fragment code for a token (10 per minute)
//   POST /api/v1/ws-ticket      a 30 s single-use ticket for the feed
//   GET  /api/v1/ws?ticket=…    the change feed (ws.ts)
//   POST /api/v1/op/<entry>     one registry entry with a UI face, on the request path of the CLI
//                               (Open and Copy are `launch.open`, A4 3.4, 3.15)
//   POST /api/v1/launch/list    a task's launch receipts (launches.ts)
//   POST /api/v1/space/list     this machine's spaces and its default space (the space switcher)
//   POST /api/v1/space/default  Make default: machine.toml's `[service] default_space`
//
// A connection counts as unauthenticated until a request on it presents a live token (or its
// upgrade a live ticket); then it counts against that token, and a revocation of the token closes
// it at once.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { httpHeader, PRODUCT_ID, PRODUCT_NAME } from "@tasks/brand";
import { httpRoutes } from "@tasks/contracts/generated/http-routes.ts";
import { ERROR_CODES, AppError, findEntry, type ErrorBody, type ErrorCode } from "@tasks/contracts";
import { hasControl } from "@tasks/launch";
import { WebSocketServer } from "ws";
import { opCall, type OpsHost } from "../ops/index.ts";
import { isLive, type Grant, type GrantStore } from "../local/index.ts";
import {
  CODE_MS,
  OneTimeSecrets,
  PROBE_NONCE,
  PROBE_PER_MINUTE,
  probeProof,
  RateLimit,
  REDEEM_PER_MINUTE,
  TICKET_MS,
} from "./auth.ts";
import {
  bearerOf,
  checkRequest,
  LAUNCH_PREFIX,
  OP_PREFIX,
  SPACE_PREFIX,
  repeatedHeader,
  type RouteTable,
} from "./checks.ts";
import { newNonce, securityHeaders, type CachePolicy } from "./csp.ts";
import { methodWord, type HttpClass, type HttpLog, type Refusal, type Route } from "./events.ts";
import type { Visibility } from "./feed.ts";
import type { RedeemCheck } from "./holders.ts";
import { UiLaunches, type UiLaunchPort } from "./launches.ts";
import type { HttpLimits } from "./limits.ts";
import { NONCE_PLACEHOLDER, type UiBundle } from "./page.ts";
import type { StartHttpTimer } from "./timers.ts";
import { FeedHub, WS_CLOSE } from "./ws.ts";

/** The protocol `/.well-known/tasks` names (A2 3.8.5). */
export const WELL_KNOWN = { app: PRODUCT_ID, protocol: 1 } as const;

/** The header that names the tab's space on an API call (A5: every call names its space). */
export const SPACE_HEADER = httpHeader("space");
/** The header that names the UI's build (A2 3.8.3 "Build check"). */
export const BUILD_HEADER = httpHeader("build");

/** A grant store whose writes can be awaited (grants.ts). The in-memory store needs none. */
export type AppGrants = GrantStore & { flush?(): Promise<void> };

export interface AppOptions {
  readonly key: Uint8Array;
  readonly instance: string;
  readonly build: { readonly version: string; readonly build: string };
  readonly grants: AppGrants;
  readonly ops: OpsHost;
  readonly ui: UiBundle;
  readonly log: HttpLog;
  readonly limits: HttpLimits;
  readonly now: () => number;
  readonly timers: StartHttpTimer;
  readonly redeemCheck: RedeemCheck;
  readonly visible?: Visibility;
  /** The hub's launch service, for the page's tiles (launches.ts). None: no tile, Copy only. */
  readonly launch?: UiLaunchPort;
  /** The machine's default space (hub/default-space.ts). None: the page cannot change it. */
  readonly defaults?: UiDefaultSpace;
}

/** The machine's default space, as Make default reads and changes it (A2 3.1). */
export interface UiDefaultSpace {
  get(): string | undefined;
  make(wanted: unknown, source: "ui"): Promise<{ default: string }>;
}

/** A fixed refusal: its status, A3 code and sentence. No value of the request is in it. */
const REFUSAL_BODY: Readonly<Record<Refusal, { code: ErrorCode; message: string; hint?: string }>> =
  {
    host: { code: "forbidden", message: `This address is not ${PRODUCT_NAME}'s.` },
    options: { code: "forbidden", message: `${PRODUCT_NAME} does not answer other sites.` },
    content_type: { code: "invalid_input", message: `${PRODUCT_NAME}'s API takes JSON only.` },
    fetch_site: { code: "forbidden", message: `${PRODUCT_NAME} does not answer other sites.` },
    origin: { code: "forbidden", message: `${PRODUCT_NAME} does not answer other sites.` },
    method: { code: "invalid_input", message: "This address does not take that method." },
    token: {
      code: "forbidden",
      message: `Run ${PRODUCT_ID} open to sign in this browser.`,
      hint: `${PRODUCT_ID} open`,
    },
    not_found: { code: "not_found", message: "Nothing is here." },
    upgrade: { code: "invalid_input", message: "This address is a WebSocket." },
    ticket: { code: "forbidden", message: "The feed's ticket was used or expired." },
    too_large: { code: "too_large", message: "The request is larger than 1 MiB." },
    bad_json: { code: "invalid_input", message: "The body is not a JSON object." },
    rate: { code: "service_unavailable", message: "Too many requests. Try again in a minute." },
    build: {
      code: "service_unavailable",
      message: `${PRODUCT_NAME} was updated. Reload the page.`,
      hint: "Reload the page.",
    },
    code: {
      code: "forbidden",
      message: `This sign-in link was used or expired. Run ${PRODUCT_ID} open again.`,
      hint: `${PRODUCT_ID} open`,
    },
    peer: { code: "forbidden", message: "Another user account cannot sign in here." },
    capacity: { code: "service_unavailable", message: `${PRODUCT_NAME} has too many connections.` },
    blocked: { code: "service_unavailable", message: `${PRODUCT_NAME} serves no UI here now.` },
    timeout: { code: "service_unavailable", message: "The request took too long." },
    version: { code: "invalid_input", message: `${PRODUCT_NAME} speaks HTTP/1.1 only.` },
    repeated: { code: "invalid_input", message: "A header that may come once came twice." },
    expect: { code: "invalid_input", message: "This address meets no such expectation." },
    handshake: { code: "invalid_input", message: "This is not a WebSocket handshake it takes." },
  };

/** RFC 6455's handshake key: 16 random bytes, base64. */
const WS_KEY = /^[+/0-9A-Za-z]{22}==$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A short label for a session's browser (A2 3.2.5 attrs: a user-agent label, never the header). */
export function agentLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/Edg\//.test(ua)) return "Edge";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Browser";
}

class BodyError extends Error {
  readonly reason: "too_large" | "bad_json" | "timeout";
  constructor(reason: "too_large" | "bad_json" | "timeout") {
    super(reason);
    this.reason = reason;
  }
}

/** What the app keeps per accepted socket. */
interface SocketState {
  readonly conn: number;
  grant: string | undefined;
  /** Upgraded to the feed: the feed closes it, with its close frame. */
  ws: boolean;
}

/** The request side of the listener. One app serves the port it is attached to (listener.ts). */
export class HttpApp {
  readonly options: AppOptions;
  readonly feed: FeedHub;
  readonly launches: UiLaunches;
  readonly #codes: OneTimeSecrets<true>;
  readonly #tickets: OneTimeSecrets<string>;
  readonly #redeemRate = new RateLimit(REDEEM_PER_MINUTE);
  readonly #probeRate = new RateLimit(PROBE_PER_MINUTE);
  readonly #wss: WebSocketServer;
  readonly #sockets = new Map<Socket, SocketState>();
  readonly #routes: RouteTable;
  readonly #unrevoke: () => void;
  #conn = 0;
  #blocked = false;

  constructor(options: AppOptions) {
    this.options = options;
    this.#codes = new OneTimeSecrets(CODE_MS, options.limits.maxCodes);
    this.#tickets = new OneTimeSecrets(TICKET_MS, options.limits.maxTickets);
    this.#wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: options.limits.maxWsMessageBytes,
    });
    // ws's own answers carry the security headers too: the 101, and (with a listener for it) a
    // handshake it refuses, which upgrade() has already checked for, comes back here.
    this.#wss.on("headers", (headers: string[], req: IncomingMessage) => {
      for (const [name, value] of Object.entries(securityHeaders(req.socket.localPort ?? 0))) {
        headers.push(`${name}: ${value}`);
      }
    });
    this.#wss.on("wsClientError", (_error: Error, socket: Duplex, req: IncomingMessage) => {
      this.#refuseUpgrade(socket, req.socket.localPort ?? 0, "ws", 400, "handshake");
    });
    this.launches = new UiLaunches({
      host: options.ops,
      port: options.launch,
      log: options.log,
      changed: (space) => {
        this.feed.poke(space);
      },
    });
    this.feed = new FeedHub({
      host: options.ops,
      limits: options.limits,
      timers: options.timers,
      log: options.log,
      build: options.build,
      now: options.now,
      live: (grant) => this.#live(options.grants.get(grant)) !== undefined,
      instances: () => this.launches.instances(),
      ...(options.visible === undefined ? {} : { visible: options.visible }),
    });
    const ops = new Set<string>(httpRoutes.map((r) => r.entry));
    this.#routes = {
      hasOp: (name) => ops.has(name),
      hasFile: (path) => options.ui.files.has(path),
    };
    this.#unrevoke = options.grants.onRevoke((grantId) => {
      this.#closeGrant(grantId);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Connections

  /** A new socket: counted as unauthenticated. Refused (false) past the caps. */
  accept(socket: Socket): boolean {
    if (this.#blocked) return false;
    const limits = this.options.limits;
    const unauthenticated = [...this.#sockets.values()].filter((s) => s.grant === undefined).length;
    if (this.#sockets.size >= limits.maxConnections) {
      this.options.log({ ev: "http.capacity", kind: "total" });
      return false;
    }
    if (unauthenticated >= limits.maxUnauthenticated) {
      this.options.log({ ev: "http.capacity", kind: "unauthenticated" });
      return false;
    }
    this.#conn += 1;
    this.#sockets.set(socket, { conn: this.#conn, grant: undefined, ws: false });
    socket.once("close", () => {
      this.#sockets.delete(socket);
    });
    return true;
  }

  connOf(socket: Socket): number {
    return this.#sockets.get(socket)?.conn ?? 0;
  }

  /** Whether the socket has proved a token (the idle timer stops for it). */
  authenticated(socket: Socket): boolean {
    return this.#sockets.get(socket)?.grant !== undefined;
  }

  /** Ties a socket to a grant. False when the grant holds its maximum of connections already. */
  #authenticate(socket: Socket, grant: string): boolean {
    const state = this.#sockets.get(socket);
    if (state === undefined) return false;
    if (state.grant === grant) return true;
    let held = 0;
    for (const s of this.#sockets.values()) if (s.grant === grant) held += 1;
    if (held >= this.options.limits.maxPerToken) {
      this.options.log({ ev: "http.capacity", kind: "token" });
      return false;
    }
    state.grant = grant;
    return true;
  }

  /**
   * A revoked grant: its tickets are forgotten, its feeds closed with 4401 (the close frame is
   * sent, and `ws` ends the socket), and its other connections destroyed at once.
   */
  #closeGrant(grant: string): void {
    this.#tickets.drop((g) => g === grant);
    this.feed.closeGrant(grant);
    for (const [socket, state] of this.#sockets) {
      if (state.grant === grant && !state.ws) socket.destroy();
    }
  }

  get connectionCount(): number {
    return this.#sockets.size;
  }

  /** `tasks open` (A2 3.8.4 step 1): a new single-use code. */
  mintCode(): string {
    if (this.#blocked) throw new Error("The UI is blocked");
    return this.#codes.mint(true, this.options.now());
  }

  /**
   * Another user holds or held the port (A2 3.8.2 step 4): no UI from now on. Every `ui` row is
   * revoked (which closes its connections), every code and ticket forgotten, every other
   * connection closed. Returns how many rows were revoked.
   */
  block(): number {
    this.#blocked = true;
    this.#codes.clear();
    this.#tickets.clear();
    let revoked = 0;
    for (const grant of this.options.grants.list("ui")) {
      if (grant.revoked_at === null && this.options.grants.revoke(grant.grant_id, this.#date()))
        revoked += 1;
    }
    this.feed.closeAll(WS_CLOSE.revoked, "blocked");
    for (const [socket, state] of this.#sockets) if (!state.ws) socket.destroy();
    return revoked;
  }

  get blocked(): boolean {
    return this.#blocked;
  }

  /** The drain: every feed is told the service stops, every socket closed. */
  closeAll(): void {
    this.feed.closeAll(WS_CLOSE.shutdown, "shutdown");
    for (const socket of this.#sockets.keys()) socket.destroy();
    this.#unrevoke();
  }

  #date(): Date {
    return new Date(this.options.now());
  }

  /** A `ui` row that is neither revoked nor expired now, or undefined. */
  #live(grant: Grant | undefined): Grant | undefined {
    return grant?.kind === "ui" && isLive(grant, this.#date()) ? grant : undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Responses

  #send(
    res: ServerResponse,
    port: number,
    status: number,
    body: string | Buffer,
    type: string,
    options: { nonce?: string; cache?: CachePolicy; close?: boolean } = {},
  ): void {
    if (res.headersSent) return;
    const headers: Record<string, string | number> = {
      ...securityHeaders(port, options),
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
    };
    if (options.close === true) headers["Connection"] = "close";
    res.writeHead(status, headers);
    res.end(body);
  }

  #json(res: ServerResponse, port: number, status: number, value: unknown, close = false): void {
    this.#send(res, port, status, JSON.stringify(value), "application/json; charset=utf-8", {
      close,
    });
  }

  #error(res: ServerResponse, port: number, status: number, body: ErrorBody, close = false): void {
    this.#json(res, port, status, { error: body }, close);
  }

  #refuse(res: ServerResponse, port: number, route: Route, status: number, reason: Refusal): void {
    const text = REFUSAL_BODY[reason];
    this.options.log({ ev: "http.refused", route, status, reason });
    this.#error(
      res,
      port,
      status,
      {
        code: text.code,
        message: text.message,
        ...(text.hint === undefined ? {} : { hint: text.hint }),
        data: { reason },
      },
      reason === "too_large" || reason === "capacity",
    );
  }

  /**
   * Reads a JSON object body of at most `maxBodyBytes`. A client that waits for `100 Continue`
   * gets it here, after the checks passed and only when the body is wanted.
   */
  #readBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown>> {
    const max = this.options.limits.maxBodyBytes;
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > max)
      return Promise.reject(new BodyError("too_large"));
    if (headerText(req.headers.expect)?.toLowerCase() === "100-continue") res.writeContinue();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const fail = (reason: "too_large" | "bad_json" | "timeout") => {
        if (done) return;
        done = true;
        reject(new BodyError(reason));
      };
      req.on("data", (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > max) {
          fail("too_large");
          return;
        }
        chunks.push(chunk);
      });
      req.on("error", () => {
        fail("timeout");
      });
      req.on("aborted", () => {
        fail("timeout");
      });
      req.on("end", () => {
        if (done) return;
        done = true;
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch {
          reject(new BodyError("bad_json"));
          return;
        }
        if (isRecord(value)) resolve(value);
        else reject(new BodyError("bad_json"));
      });
    });
  }

  /** The live `ui` row of a request's bearer token, touched, or undefined. */
  #grantOf(req: IncomingMessage): Grant | undefined {
    const token = bearerOf(req.headers.authorization);
    if (token === undefined) return undefined;
    const now = this.#date();
    const grant = this.options.grants.findByToken(token, now);
    if (grant?.kind !== "ui") return undefined;
    return this.options.grants.touch(grant.grant_id, now);
  }

  #staleBuild(req: IncomingMessage): boolean {
    const header = req.headers[BUILD_HEADER];
    return typeof header === "string" && header !== this.options.build.build;
  }

  // -------------------------------------------------------------------------------------------
  // Requests

  /** One request on `port`. */
  async handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    const t0 = this.options.now();
    const url = req.url ?? "";
    const path = url.startsWith("/") ? (url.split("?")[0] ?? "") : url;
    let route: Route = "other";
    let cls: HttpClass = "none";
    let entry: string | undefined;
    res.once("finish", () => {
      this.options.log({
        ev: "http.request",
        method: methodWord(req.method),
        route,
        status: res.statusCode,
        ms: Math.max(0, Math.round(this.options.now() - t0)),
        class: cls,
        ...(entry === undefined ? {} : { entry }),
      });
    });
    const verdict = checkRequest(
      port,
      {
        method: req.method ?? "",
        path,
        host: req.headers.host,
        origin: req.headers.origin,
        fetchSite: headerText(req.headers["sec-fetch-site"]),
        contentType: req.headers["content-type"],
        bearer: bearerOf(req.headers.authorization) !== undefined,
        upgrade: false,
        version: req.httpVersion,
        repeated: repeatedHeader(req.rawHeaders),
      },
      this.#routes,
    );
    route = verdict.route;
    if (!verdict.ok) {
      this.#refuse(res, port, route, verdict.status, verdict.reason);
      return;
    }
    if (this.#blocked) {
      this.#refuse(res, port, route, 503, "blocked");
      return;
    }
    // `Expect: 100-continue` is met when the body is read; no other expectation is.
    const expectation = headerText(req.headers.expect)?.toLowerCase();
    if (expectation !== undefined && expectation !== "100-continue") {
      this.#refuse(res, port, route, 417, "expect");
      return;
    }
    try {
      switch (route) {
        case "shell": {
          const nonce = newNonce();
          this.#send(
            res,
            port,
            200,
            this.options.ui.index.replaceAll(NONCE_PLACEHOLDER, nonce),
            "text/html; charset=utf-8",
            { nonce },
          );
          return;
        }
        case "asset":
        case "file": {
          const file = this.options.ui.files.get(path);
          if (file === undefined) {
            this.#refuse(res, port, route, 404, "not_found");
            return;
          }
          this.#send(res, port, 200, file.body, file.type, {
            cache: route === "asset" ? "immutable" : "no-store",
          });
          return;
        }
        case "healthz":
          this.#send(res, port, 200, "ok", "text/plain; charset=utf-8");
          return;
        case "well_known":
          this.#json(res, port, 200, WELL_KNOWN);
          return;
        case "probe": {
          if (!this.#probeRate.take(this.options.now())) {
            this.#refuse(res, port, route, 429, "rate");
            return;
          }
          const body = await this.#readBody(req, res);
          const nonce = body["nonce"];
          if (typeof nonce !== "string" || !PROBE_NONCE.test(nonce)) {
            this.#refuse(res, port, route, 400, "bad_json");
            return;
          }
          this.#json(res, port, 200, {
            proof: probeProof(this.options.key, this.options.instance, port, nonce),
          });
          return;
        }
        case "redeem": {
          if (!this.#redeemRate.take(this.options.now())) {
            this.#refuse(res, port, route, 429, "rate");
            return;
          }
          const body = await this.#readBody(req, res);
          const socket = req.socket;
          if (!this.options.redeemCheck(socket.remotePort ?? 0, port)) {
            this.#refuse(res, port, route, 403, "peer");
            return;
          }
          if (this.#codes.take(body["code"], this.options.now()) === undefined) {
            this.#refuse(res, port, route, 401, "code");
            return;
          }
          const { grant, token } = this.options.grants.create(
            {
              kind: "ui",
              principal: "user",
              attrs: { agent: agentLabel(req.headers["user-agent"]) },
            },
            this.#date(),
          );
          try {
            await this.options.grants.flush?.();
          } catch {
            this.options.grants.revoke(grant.grant_id, this.#date());
            this.options.log({ ev: "http.grants_failed", stage: "write" });
            this.#refuse(res, port, route, 503, "capacity");
            return;
          }
          cls = "ui";
          this.#authenticate(req.socket, grant.grant_id);
          this.#json(res, port, 200, { token, session_id: grant.grant_id });
          return;
        }
        case "ws_ticket":
        case "launch":
        case "space":
        case "op": {
          const grant = this.#grantOf(req);
          if (grant === undefined) {
            this.#refuse(res, port, route, 401, "token");
            return;
          }
          cls = "ui";
          if (!this.#authenticate(req.socket, grant.grant_id)) {
            this.#refuse(res, port, route, 503, "capacity");
            return;
          }
          if (this.#staleBuild(req)) {
            this.#refuse(res, port, route, 409, "build");
            return;
          }
          if (route === "ws_ticket") {
            await this.#readBody(req, res);
            this.#json(res, port, 200, {
              ticket: this.#tickets.mint(grant.grant_id, this.options.now()),
            });
            return;
          }
          if (route === "launch") {
            const input = await this.#readBody(req, res);
            const space = headerText(req.headers[SPACE_HEADER]);
            await this.#launch(res, port, path.slice(LAUNCH_PREFIX.length), input, space);
            return;
          }
          if (route === "space") {
            const input = await this.#readBody(req, res);
            await this.#space(res, port, path.slice(SPACE_PREFIX.length), input);
            return;
          }
          const name = path.slice(OP_PREFIX.length);
          entry = findEntry(name)?.name;
          const input = await this.#readBody(req, res);
          const space = headerText(req.headers[SPACE_HEADER]);
          await this.#op(res, port, grant, name, input, space);
          return;
        }
        default:
          this.#refuse(res, port, route, 404, "not_found");
      }
    } catch (error) {
      if (error instanceof BodyError) {
        this.#refuse(res, port, route, error.reason === "too_large" ? 413 : 400, error.reason);
        return;
      }
      this.#error(res, port, 500, {
        code: "internal",
        message: "The service failed. The details are in its log.",
      });
    }
  }

  /** `POST /api/v1/op/<entry>`: the request path of the CLI, with the UI grant's scope. */
  async #op(
    res: ServerResponse,
    port: number,
    grant: Grant,
    name: string,
    input: Record<string, unknown>,
    space: string | undefined,
  ): Promise<void> {
    if (space !== undefined && (space.length > 200 || hasControl(space))) {
      this.#refuse(res, port, "op", 400, "bad_json");
      return;
    }
    try {
      const result = await opCall(
        this.options.ops,
        { class: "ui", env: {}, grant: grant.grant_id },
        { op: name, input, ...(space === undefined ? {} : { space }) },
      );
      this.#json(res, port, 200, { result });
    } catch (error) {
      const body: ErrorBody =
        error instanceof AppError
          ? error.toBody()
          : { code: "internal", message: "The service failed. The details are in its log." };
      this.#error(res, port, ERROR_CODES[body.code].http, body);
    } finally {
      this.feed.poke();
    }
  }

  /** `POST /api/v1/launch/list`: a task's receipts (checks.ts admits no other action). */
  async #launch(
    res: ServerResponse,
    port: number,
    _action: string,
    input: Record<string, unknown>,
    space: string | undefined,
  ): Promise<void> {
    if (space !== undefined && (space.length > 200 || hasControl(space))) {
      this.#refuse(res, port, "launch", 400, "bad_json");
      return;
    }
    try {
      const result = { receipts: await this.launches.list(space, input) };
      this.#json(res, port, 200, { result });
    } catch (error) {
      const body: ErrorBody =
        error instanceof AppError
          ? error.toBody()
          : { code: "internal", message: "The service failed. The details are in its log." };
      this.#error(res, port, ERROR_CODES[body.code].http, body);
    }
  }

  /**
   * `POST /api/v1/space/<action>`: the space switcher's list (every space this service has, by ID,
   * name and state, and the machine's default), or Make default. The UI's grant is the person, so
   * Make default is the person's explicit act (A2 3.1). Neither names a tab's space: a tab's space is
   * its route, and the default decides only what a new tab and an unbound CLI call use.
   */
  async #space(
    res: ServerResponse,
    port: number,
    action: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    try {
      const defaults = this.options.defaults;
      if (action === "list") {
        const spaces = this.options.ops
          .spaces()
          .filter((s) => s.id !== undefined && s.state !== "closed")
          .map((s) => ({ id: s.id, name: s.name ?? "", state: s.state }));
        this.#json(res, port, 200, { result: { spaces, default: defaults?.get() ?? null } });
        return;
      }
      if (defaults === undefined) {
        throw new AppError({
          code: "service_unavailable",
          message: "This service cannot change the default space.",
          data: { reason: "ui_unavailable", retryable: false },
        });
      }
      this.#json(res, port, 200, { result: await defaults.make(input["space"], "ui") });
    } catch (error) {
      const body: ErrorBody =
        error instanceof AppError
          ? error.toBody()
          : { code: "internal", message: "The service failed. The details are in its log." };
      this.#error(res, port, ERROR_CODES[body.code].http, body);
    }
  }

  // -------------------------------------------------------------------------------------------
  // The WebSocket

  /** A refused upgrade: a plain response with the security headers, then the socket closes. */
  #refuseUpgrade(
    socket: Duplex,
    port: number,
    route: Route,
    status: number,
    reason: Refusal,
  ): void {
    this.options.log({ ev: "http.refused", route, status, reason });
    const head = [
      `HTTP/1.1 ${String(status)} Refused`,
      ...Object.entries(securityHeaders(port)).map(([k, v]) => `${k}: ${v}`),
      "Content-Length: 0",
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    socket.end(head, () => {
      socket.destroy();
    });
  }

  /** An upgrade on `port`: the checks, then the ticket, then the feed. Else a plain refusal. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
    const url = req.url ?? "";
    const [path = "", query = ""] = url.startsWith("/") ? url.split("?", 2) : [url, ""];
    const websocket = headerText(req.headers.upgrade)?.toLowerCase() === "websocket";
    const verdict = checkRequest(
      port,
      {
        method: req.method ?? "",
        path,
        host: req.headers.host,
        origin: req.headers.origin,
        fetchSite: headerText(req.headers["sec-fetch-site"]),
        contentType: req.headers["content-type"],
        bearer: bearerOf(req.headers.authorization) !== undefined,
        upgrade: websocket,
        version: req.httpVersion,
        repeated: repeatedHeader(req.rawHeaders),
      },
      this.#routes,
    );
    const refuse = (status: number, reason: Refusal) => {
      this.#refuseUpgrade(socket, port, verdict.route, status, reason);
    };
    if (!verdict.ok) {
      refuse(verdict.status, verdict.reason);
      return;
    }
    if (!websocket) {
      refuse(400, "upgrade");
      return;
    }
    if (this.#blocked) {
      refuse(503, "blocked");
      return;
    }
    // The handshake ws would refuse, refused here first: before the ticket is spent, and with the
    // security headers. A browser's WebSocket sends version 13, a key, and no subprotocol here.
    if (
      !WS_KEY.test(headerText(req.headers["sec-websocket-key"]) ?? "") ||
      headerText(req.headers["sec-websocket-version"]) !== "13" ||
      req.headers["sec-websocket-protocol"] !== undefined
    ) {
      refuse(400, "handshake");
      return;
    }
    const ticket = new URLSearchParams(query).get("ticket");
    const grantId = this.#tickets.take(ticket, this.options.now());
    const grant = this.#live(grantId === undefined ? undefined : this.options.grants.get(grantId));
    const now = this.#date();
    if (grant === undefined) {
      refuse(401, "ticket");
      return;
    }
    if (!this.#authenticate(socket as Socket, grant.grant_id)) {
      refuse(503, "capacity");
      return;
    }
    this.options.grants.touch(grant.grant_id, now);
    const conn = this.connOf(socket as Socket);
    const state = this.#sockets.get(socket as Socket);
    if (state !== undefined) state.ws = true;
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      this.options.log({
        ev: "http.request",
        method: "GET",
        route: "ws",
        status: 101,
        ms: 0,
        class: "ui",
      });
      this.feed.attach(ws, grant.grant_id, conn);
    });
  }
}

function headerText(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
