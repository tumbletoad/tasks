// The phone's link (`ttasks-link/1`): one listener for paired phones beside the page's loopback
// listener, in the same process, with the same operations, feed and runs behind it.
//
// - TLS 1.3 with the computer's key (home.ts). Each phone presents a certificate of its own key,
//   and the pin of that key (cert.ts) is the phone: its grant names the pin, and its writes are
//   kept under the writer scope `device:<pin>`, so a capture sent again after a lost answer, a
//   restart of the app or a new pairing of the same phone finds its receipt.
// - One path, `GET /v1/link`, as a WebSocket. Any other request, a peer from a public address and
//   a connection without a client certificate are closed with nothing written. On the socket the
//   phone's first message is `{type: "open", protocol, space, pair?}`. A phone whose grant for
//   that space is live, or that brings a live code for it, gets the feed's `hello` with its
//   pairing; a phone that was removed is told so; anyone else is closed after a fixed delay with
//   no answer at all.
// - After the hello the socket is the feed (http/ws.ts, with a phone's own rows) and the phone's
//   calls: `{type: "call", id, path, body, copy?}`, answered `{type: "reply", id, status, body}`.
//   A call reaches only the registry's entries that a linked device may call and a task's runs,
//   always in the grant's space, and Run and Stop only with the Run right. The grant is read
//   again for every call, so a change of rights or a removal applies to the next one.
//
// The listener runs only while a phone is paired or a pairing code waits. A code is 32 random
// bytes, kept only as its hash, valid once for 5 minutes, and ended when the page's dialog
// closes.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:https";
import { hostname, networkInterfaces } from "node:os";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { AppError, ERROR_CODES, findEntry, type ErrorBody } from "@ttasks/contracts";
import { WebSocketServer, type WebSocket } from "ws";
import { OneTimeSecrets } from "../http/auth.ts";
import type { HttpLog } from "../http/events.ts";
import type { FeedHub } from "../http/ws.ts";
import type { UiLaunches } from "../http/launches.ts";
import { isLive, type Grant, type GrantStore } from "../local/index.ts";
import { findSpace, isAmbiguity } from "../ops/copies.ts";
import { opCall, type OpsHost } from "../ops/index.ts";
import { certPin, PIN } from "./cert.ts";
import { keepPort, loadOrCreateHome, type LinkHome } from "./home.ts";

/** The link protocol's number, in the phone's `open` and the hello. */
export const LINK_PROTOCOL = 1;
export const LINK_PATH = "/v1/link";
/** What a pairing code is prefixed with in the QR code. Never a URL: nothing opens it but the app. */
export const PAIRING_PREFIX = "TTASKS1:";
/** A pairing code is valid this long. */
export const PAIRING_MS = 5 * 60_000;
/** At most this many codes wait at once. */
export const PAIRING_MAX = 4;
/** The port tried first; when it is taken, the system chooses one, and that one is kept. */
export const LINK_PORT = 7740;
/** A removed phone is told so when it comes back within this long; later it finds nothing. */
export const REMOVED_TOLD_MS = 30 * 86_400_000;

/** The scopes of a phone's grant: reading and editing are one right, Run is a second. */
export const EDIT_SCOPES = ["space:read", "space:write"] as const;
export const RUN_SCOPE = "launch:run";

/** The grants store the link needs: the durable one, with the Run switch. */
export type LinkGrants = GrantStore & {
  setScopes(grantId: string, scopes: readonly string[]): boolean;
  flush(): Promise<void>;
};

export interface LinkOptions {
  readonly stateDir: string;
  readonly grants: LinkGrants;
  readonly ops: OpsHost;
  readonly feed: FeedHub;
  readonly launches: Pick<UiLaunches, "run" | "runs" | "stop">;
  readonly log: HttpLog;
  readonly now: () => number;
  /** Where the listener binds. Default: every IPv4 interface. Tests: 127.0.0.1. */
  readonly host?: string;
  /** The ports tried in order, `0` for the system's choice. Default: the kept one, 7740, 0. */
  readonly ports?: readonly number[];
  /** The addresses a code names. Default: this computer's private IPv4 addresses. */
  readonly addresses?: () => readonly string[];
  /** Whether a peer's address may connect. Default: private, link-local and loopback ones. */
  readonly peerAllowed?: (address: string) => boolean;
  /** How long a refused phone waits for the close, in ms. Default 200. */
  readonly refuseMs?: number;
}

/** A paired phone as Settings lists it. */
export interface PhoneView {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly space: string;
  readonly space_name: string | null;
  readonly paired_at: string;
  readonly last_used_at: string | null;
  readonly run: boolean;
}

/** What became of a pairing code the page shows. */
export type PairingState =
  | { readonly state: "waiting"; readonly expires_at: string }
  | { readonly state: "paired"; readonly phone: string }
  | { readonly state: "ended" };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether an address is on a private network, a link-local one, or this computer. */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  const parts = v4.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    const [a = 0, b = 0] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    );
  }
  const lower = address.toLowerCase();
  return lower === "::1" || /^f[cd]/u.test(lower) || /^fe[89ab]/u.test(lower);
}

/** This computer's private IPv4 addresses, the ones a phone on its network or VPN can reach. */
function privateAddresses(): string[] {
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isPrivateAddress(entry.address)) {
        found.push(entry.address);
      }
    }
  }
  return found;
}

const shortText = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() !== "" && v.length <= max && !/\p{Cc}/u.test(v)
    ? v.trim()
    : undefined;

const forbidden = (message: string, rule: string) =>
  new AppError({ code: "forbidden", message, data: { rule } });

interface Ticket {
  readonly space: string;
  readonly expires: number;
  phone?: string;
  ended?: true;
}

export class LinkService {
  readonly #options: LinkOptions;
  #home: LinkHome | undefined;
  #server: Server | undefined;
  #port: number | undefined;
  #starting: Promise<void> | undefined;
  readonly #codes = new OneTimeSecrets<string>(PAIRING_MS, PAIRING_MAX);
  readonly #tickets = new Map<string, Ticket>();
  readonly #sockets = new Map<WebSocket, string>();
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  readonly #unrevoke: () => void;
  #conn = 0;
  #closed = false;

  constructor(options: LinkOptions) {
    this.#options = options;
    this.#unrevoke = options.grants.onRevoke(() => {
      void this.#settle();
    });
  }

  /** Listens when a phone is paired, as at a start of the service. */
  async start(): Promise<void> {
    if (this.#wanted()) await this.#listen();
  }

  /**
   * Whether phones need the listener: one is paired, or one was removed lately and may still
   * come back to be told so.
   */
  #wanted(): boolean {
    const since = this.#options.now() - REMOVED_TOLD_MS;
    return this.#options.grants
      .list("device")
      .some((g) => isLive(g, this.#date()) || (g.revoked_at !== null && Date.parse(g.revoked_at) > since));
  }

  get port(): number | undefined {
    return this.#port;
  }

  #date(): Date {
    return new Date(this.#options.now());
  }

  #phones(): Grant[] {
    const now = this.#date();
    return this.#options.grants.list("device").filter((g) => isLive(g, now));
  }

  #spaceOf(ref: unknown): { id: string; name: string | undefined } {
    if (typeof ref !== "string" || ref === "" || ref.length > 200) {
      throw new AppError({ code: "invalid_input", message: "Expected a space." });
    }
    const found = findSpace(
      this.#options.ops.spaces().filter((s) => s.id !== undefined && s.reader !== undefined),
      ref,
    );
    if (found === undefined || isAmbiguity(found)) {
      throw new AppError({ code: "space_unavailable", message: "This space is not open here." });
    }
    return { id: found.id ?? "", name: found.name };
  }

  // -------------------------------------------------------------------------------------------
  // The page's Settings > Phones

  /** The paired phones, and what became of the code `ticket` when one is named. */
  view(input: Record<string, unknown>): { phones: PhoneView[]; pairing?: PairingState } {
    const names = new Map(this.#options.ops.spaces().map((s) => [s.id, s.name]));
    const phones = this.#phones().map(
      (g): PhoneView => ({
        id: g.grant_id,
        name: typeof g.attrs["name"] === "string" ? g.attrs["name"] : "",
        platform: typeof g.attrs["platform"] === "string" ? g.attrs["platform"] : "",
        space: g.spaces[0] ?? "",
        space_name: names.get(g.spaces[0]) ?? null,
        paired_at: g.created_at,
        last_used_at: g.last_used_at,
        run: g.scopes.includes(RUN_SCOPE),
      }),
    );
    const ticket = input["ticket"];
    if (typeof ticket !== "string") return { phones };
    return { phones, pairing: this.#pairingState(ticket) };
  }

  #pairingState(ticket: string): PairingState {
    const found = this.#tickets.get(ticket);
    if (found?.phone !== undefined) return { state: "paired", phone: found.phone };
    if (found === undefined || found.ended === true || found.expires <= this.#options.now()) {
      return { state: "ended" };
    }
    return { state: "waiting", expires_at: new Date(found.expires).toISOString() };
  }

  /**
   * A new code for the space `space`, as the QR code's text, with the ticket the page follows it
   * by; or, with `{end: ticket}`, the end of that code, when its dialog closes.
   */
  async pair(input: Record<string, unknown>): Promise<unknown> {
    const end = input["end"];
    if (typeof end === "string") {
      const ticket = this.#tickets.get(end);
      if (ticket !== undefined) ticket.ended = true;
      this.#codes.drop((t) => t === end);
      await this.#settle();
      return { ended: true };
    }
    const space = this.#spaceOf(input["space"]);
    await this.#listen();
    const home = this.#home;
    if (home === undefined || this.#port === undefined) {
      throw new AppError({
        code: "service_unavailable",
        message: "This computer cannot listen for phones now.",
        data: { reason: "link_unavailable", retryable: true },
      });
    }
    const now = this.#options.now();
    for (const [id, t] of this.#tickets) {
      if (t.expires <= now || t.ended === true) this.#tickets.delete(id);
    }
    const ticket = randomBytes(16).toString("base64url");
    const code = this.#codes.mint(ticket, now);
    this.#tickets.set(ticket, { space: space.id, expires: now + PAIRING_MS });
    const port = this.#port;
    const addresses = (this.#options.addresses ?? privateAddresses)().map((a) => `${a}:${port}`);
    const payload = {
      v: LINK_PROTOCOL,
      addrs: addresses,
      pin: home.pin,
      space: { id: space.id, name: space.name ?? "" },
      computer: hostname(),
      code,
    };
    const timer = setTimeout(() => {
      void this.#settle();
    }, PAIRING_MS + 1000);
    timer.unref();
    return {
      code: `${PAIRING_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`,
      ticket,
      expires_at: new Date(now + PAIRING_MS).toISOString(),
      addresses: addresses.length,
    };
  }

  /** Run switched on or off for one phone. */
  rights(input: Record<string, unknown>): { run: boolean } {
    const grant = this.#phone(input["phone"]);
    const run = input["run"];
    if (typeof run !== "boolean") {
      throw new AppError({ code: "invalid_input", message: "Expected run: true or false." });
    }
    this.#options.grants.setScopes(grant.grant_id, run ? [...EDIT_SCOPES, RUN_SCOPE] : [...EDIT_SCOPES]);
    return { run };
  }

  /** Remove: the phone's access ends now, and its open connection closes. */
  async remove(input: Record<string, unknown>): Promise<{ removed: true }> {
    const grant = this.#phone(input["phone"]);
    this.#options.grants.revoke(grant.grant_id, this.#date());
    await this.#options.grants.flush().catch(() => undefined);
    return { removed: true };
  }

  #phone(id: unknown): Grant {
    const grant = typeof id === "string" ? this.#options.grants.get(id) : undefined;
    if (grant === undefined || grant.kind !== "device" || !isLive(grant, this.#date())) {
      throw new AppError({ code: "not_found", message: "No paired phone has this ID." });
    }
    return grant;
  }

  // -------------------------------------------------------------------------------------------
  // The listener

  /** Stops listening once no phone is paired and no code waits. Closes a removed phone's socket. */
  async #settle(): Promise<void> {
    for (const [ws, grant] of this.#sockets) {
      const row = this.#options.grants.get(grant);
      if (row === undefined || !isLive(row, this.#date())) ws.terminate();
    }
    const now = this.#options.now();
    const waiting = [...this.#tickets.values()].some(
      (t) => t.phone === undefined && t.ended !== true && t.expires > now,
    );
    if (!waiting && !this.#wanted()) await this.#stop();
  }

  async #listen(): Promise<void> {
    if (this.#closed) return;
    if (this.#server !== undefined) return;
    this.#starting ??= this.#bind().finally(() => {
      this.#starting = undefined;
    });
    await this.#starting;
  }

  async #bind(): Promise<void> {
    const home = (this.#home ??= loadOrCreateHome(this.#options.stateDir));
    const server = createServer({
      key: home.key,
      cert: home.cert,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
    });
    const allowed = this.#options.peerAllowed ?? isPrivateAddress;
    server.on("connection", (socket: Socket) => {
      if (!allowed(socket.remoteAddress ?? "")) {
        this.#options.log({ ev: "http.link_refused", reason: "peer" });
        socket.destroy();
      }
    });
    server.on("tlsClientError", (_error, socket) => {
      socket.destroy();
    });
    server.on("request", (req) => {
      this.#options.log({ ev: "http.link_refused", reason: "request" });
      req.socket.destroy();
    });
    server.on("upgrade", (req, socket: TLSSocket, head: Buffer) => {
      const pin = this.#peerPin(socket);
      if (req.method !== "GET" || req.url !== LINK_PATH || pin === undefined) {
        this.#options.log({
          ev: "http.link_refused",
          reason: pin === undefined ? "certificate" : "request",
        });
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.#session(ws, pin);
      });
    });
    const ports = this.#options.ports ?? [...(home.port === undefined ? [] : [home.port]), LINK_PORT, 0];
    for (const port of ports) {
      const bound = await new Promise<boolean>((resolve, reject) => {
        const failed = (error: NodeJS.ErrnoException) => {
          server.off("listening", done);
          if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
          else reject(error);
        };
        const done = () => {
          server.off("error", failed);
          resolve(true);
        };
        server.once("error", failed);
        server.once("listening", done);
        server.listen({ host: this.#options.host ?? "0.0.0.0", port, exclusive: true });
      }).catch(() => false);
      if (!bound) continue;
      const address = server.address();
      this.#port = typeof address === "object" && address !== null ? address.port : port;
      this.#server = server;
      if (this.#options.ports === undefined) {
        try {
          this.#home = keepPort(this.#options.stateDir, home, this.#port);
        } catch {
          // The port is kept from the next start that can write it.
        }
      }
      this.#options.log({ ev: "http.link_listen", outcome: "listening" });
      return;
    }
    this.#options.log({ ev: "http.link_listen", outcome: "failed" });
  }

  #peerPin(socket: TLSSocket): string | undefined {
    try {
      const cert = socket.getPeerX509Certificate();
      return cert === undefined ? undefined : certPin(cert.raw);
    } catch {
      return undefined;
    }
  }

  async #stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    this.#port = undefined;
    for (const ws of this.#sockets.keys()) ws.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    this.#options.log({ ev: "http.link_listen", outcome: "stopped" });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unrevoke();
    await this.#starting?.catch(() => undefined);
    await this.#stop();
  }

  // -------------------------------------------------------------------------------------------
  // A phone's connection

  /** Waits for the phone's `open`, then serves it or closes it. */
  #session(ws: WebSocket, pin: string): void {
    this.#conn += 1;
    const conn = this.#conn;
    const silent = () => {
      const timer = setTimeout(() => {
        ws.terminate();
      }, this.#options.refuseMs ?? 200);
      timer.unref();
    };
    const timer = setTimeout(() => {
      ws.terminate();
    }, 10_000);
    timer.unref();
    ws.on("error", () => undefined);
    ws.once("message", (data, binary) => {
      clearTimeout(timer);
      void this.#open(ws, pin, conn, data, binary).then((outcome) => {
        if (outcome === "refused") silent();
      });
    });
  }

  async #open(
    ws: WebSocket,
    pin: string,
    conn: number,
    data: unknown,
    binary: boolean,
  ): Promise<"served" | "refused" | "removed"> {
    let message: unknown;
    try {
      if (binary) throw new Error("binary");
      message = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as unknown;
    } catch {
      this.#options.log({ ev: "http.link_refused", reason: "request" });
      return "refused";
    }
    if (!isRecord(message) || message["type"] !== "open" || message["protocol"] !== LINK_PROTOCOL) {
      this.#options.log({ ev: "http.link_refused", reason: "request" });
      return "refused";
    }
    const space = message["space"];
    if (typeof space !== "string" || space.length > 200) return "refused";
    const now = this.#date();
    const rows = this.#options.grants
      .list("device")
      .filter((g) => g.attrs["key"] === pin && g.spaces[0] === space);
    let grant = rows.find((g) => isLive(g, now));
    const pair = message["pair"];
    if (isRecord(pair)) {
      const ticketId = this.#codes.take(pair["code"], this.#options.now());
      const ticket = ticketId === undefined ? undefined : this.#tickets.get(ticketId);
      if (ticketId === undefined || ticket === undefined || ticket.space !== space) {
        this.#options.log({ ev: "http.link_refused", reason: "code" });
        return "refused";
      }
      if (grant === undefined) {
        grant = this.#options.grants.create(
          {
            kind: "device",
            principal: "user",
            spaces: [space],
            scopes: [...EDIT_SCOPES],
            attrs: {
              key: pin,
              name: shortText(pair["name"], 80) ?? "Phone",
              platform: shortText(pair["platform"], 20) ?? "",
            },
          },
          now,
        ).grant;
        try {
          await this.#options.grants.flush();
        } catch {
          this.#options.grants.revoke(grant.grant_id, now);
          this.#options.log({ ev: "http.grants_failed", stage: "write" });
          return "refused";
        }
      }
      ticket.phone = grant.grant_id;
      this.#options.log({ ev: "http.link_paired" });
    }
    if (grant === undefined) {
      if (rows.length > 0 && ws.readyState === ws.OPEN) {
        // A phone that proved the key of a removed grant is told, so it clears what it read.
        this.#options.log({ ev: "http.link_refused", reason: "removed" });
        ws.send(JSON.stringify({ type: "removed" }), () => {
          ws.close(4403, "removed");
        });
        return "removed";
      }
      this.#options.log({ ev: "http.link_refused", reason: "not_paired" });
      return "refused";
    }
    if (ws.readyState !== ws.OPEN) return "refused";
    this.#options.grants.touch(grant.grant_id, now);
    const grantId = grant.grant_id;
    this.#sockets.set(ws, grantId);
    ws.once("close", () => {
      this.#sockets.delete(ws);
    });
    const name = this.#options.ops.spaces().find((s) => s.id === space)?.name ?? "";
    this.#options.feed.attach(ws, grantId, conn, {
      space,
      link: {
        protocol: LINK_PROTOCOL,
        space: { id: space, name },
        phone: grantId,
        run: grant.scopes.includes(RUN_SCOPE),
      },
      call: (call, reply) => {
        void this.#call(grantId, pin, call).then((answer) => reply(answer).catch(() => undefined));
      },
    });
    return "served";
  }

  /** One call of a phone, answered with its status and body as the page's API gives them. */
  async #call(
    grantId: string,
    pin: string,
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = message["id"];
    const validId =
      (typeof id === "string" && id.length > 0 && id.length <= 128) ||
      (typeof id === "number" && Number.isSafeInteger(id));
    const reply = (status: number, body: unknown) => ({
      type: "reply",
      id: validId ? id : null,
      status,
      body,
    });
    const failed = (error: unknown) => {
      const body: ErrorBody =
        error instanceof AppError
          ? error.toBody()
          : { code: "internal", message: "The service failed. The details are in its log." };
      return reply(ERROR_CODES[body.code].http, { error: body });
    };
    try {
      const path = message["path"];
      const body = message["body"] ?? {};
      const copy = message["copy"];
      if (!validId || typeof path !== "string" || !isRecord(body)) {
        throw new AppError({ code: "invalid_input", message: "A call needs an ID, a path and a body." });
      }
      if (copy !== undefined && (typeof copy !== "string" || !/^[0-9a-f]{24}$/u.test(copy))) {
        throw new AppError({ code: "invalid_input", message: "A copy is 24 hex characters." });
      }
      const grant = this.#options.grants.get(grantId);
      if (grant === undefined || !isLive(grant, this.#date())) {
        throw forbidden("This phone is no longer paired.", "phone_removed");
      }
      this.#options.grants.touch(grantId, this.#date());
      const space = grant.spaces[0] ?? "";
      const scopes = grant.scopes;
      const result = await this.#route(path, body, space, scopes, grantId, pin, copy);
      return reply(200, { result });
    } catch (error) {
      return failed(error);
    } finally {
      this.#options.feed.poke();
    }
  }

  #route(
    path: string,
    body: Record<string, unknown>,
    space: string,
    scopes: readonly string[],
    grantId: string,
    pin: string,
    copy: string | undefined,
  ): Promise<unknown> {
    const { launches } = this.#options;
    if (path.startsWith("/api/v1/op/")) {
      const name = path.slice("/api/v1/op/".length);
      const entry = findEntry(name);
      if (entry === undefined || entry.name !== name) {
        throw new AppError({ code: "not_found", message: "Nothing is here." });
      }
      const needs =
        entry.remote === "read" ? "space:read" : entry.remote === "write" ? "space:write" : undefined;
      if (needs === undefined || !scopes.includes(needs)) {
        throw forbidden("A phone cannot do this. Use TTasks on the computer.", "phone_rights");
      }
      return opCall(
        this.#options.ops,
        {
          class: "ui",
          env: {},
          grant: grantId,
          ...(copy === undefined ? {} : { copy }),
          principal: {
            audience: "user",
            actorKind: "human",
            label: "user",
            scope: `device:${pin}`,
            origin: "ui",
          },
        },
        { op: name, input: body, space },
      );
    }
    if (path === "/api/v1/launch/runs") {
      if (!scopes.includes("space:read")) {
        throw forbidden("A phone cannot do this. Use TTasks on the computer.", "phone_rights");
      }
      return launches.runs(space, body, copy).then((runs) => ({ runs }));
    }
    if (path === "/api/v1/launch/run" || path === "/api/v1/launch/stop") {
      if (!scopes.includes(RUN_SCOPE)) {
        throw forbidden(
          "Run is off for this phone. It can be switched on in Settings > Phones on the computer.",
          "phone_run",
        );
      }
      return path === "/api/v1/launch/run"
        ? launches.run(space, body, copy).then((run) => ({ run }))
        : launches.stop(space, body, copy).then((run) => ({ run }));
    }
    throw new AppError({ code: "not_found", message: "Nothing is here." });
  }
}

/** Whether a text has the shape of a pin. */
export const isPin = (text: unknown): text is string => typeof text === "string" && PIN.test(text);
