// Pairing with T3 Code (A4 3.4.1 "Pairing"): Tasks registers as an outside OAuth client of the
// local T3 server and the person approves it on T3's own page in the browser. The flow is the MCP
// authorization specification's: protected resource metadata (RFC 9728) names the authorization
// server, whose metadata (RFC 8414) names its endpoints; dynamic client registration (RFC 7591);
// the authorization code flow with PKCE (RFC 7636); a loopback redirect (RFC 8252).
//
// The rules this module holds:
// - PKCE with S256 only. A server that does not list S256 is refused, never asked for `plain`.
// - A fresh verifier and state for every attempt, 256 random bits each, never reused or stored.
// - The redirect is `http://127.0.0.1:<port>/callback` on a port the OS assigns for this attempt,
//   and every endpoint Tasks sends a secret to (registration, token) must be on loopback too.
// - The state is compared, in constant time, before the code is exchanged. A request with another
//   state, or none, is answered 400 and changes nothing: the attempt keeps waiting for its own.
// - Every wait has a deadline: each HTTP request (T3_REQUEST_MS) and the person's approval
//   (PAIR_DEADLINE_MS), after which the listener closes.
// - Secrets (the verifier, the code, the tokens) never reach a URL Tasks makes other than the
//   authorization URL's challenge and state, an argv, a log line or an error message.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { PRODUCT_NAME } from "@tasks/brand";
import {
  loopbackUrl,
  readObject,
  t3Request,
  T3Error,
  T3_REQUEST_MS,
  type Fetch,
} from "./t3-client.ts";

/** How long the person has to approve on T3's page. */
export const PAIR_DEADLINE_MS = 10 * 60_000;

/** A token as it may travel in a header: printable ASCII, bounded. */
const TOKEN = /^[\x21-\x7e]{1,4096}$/u;
const CLIENT_ID = /^[\x21-\x7e]{1,512}$/u;

/** Why a pairing attempt ended without a grant. */
export type PairingFailure =
  /** The person refused on T3's page. */
  | "denied"
  /** No approval came back before the deadline. */
  | "timed_out"
  /** A newer attempt replaced it, or the service stopped. */
  | "cancelled"
  /** T3's server does not offer what pairing needs: the endpoints on loopback, or PKCE S256. */
  | "unsupported";

export class PairingError extends Error {
  override readonly name = "PairingError";
  readonly reason: PairingFailure;
  constructor(reason: PairingFailure) {
    super(`Pairing with T3 Code did not finish: ${reason.replace("_", " ")}`);
    this.reason = reason;
  }
}

/** The endpoints pairing uses, all on loopback. */
export interface AuthServer {
  readonly authorization: string;
  readonly token: string;
  readonly registration: string;
  /** The MCP server's resource indicator (RFC 8707), sent with the authorization and tokens. */
  readonly resource: string;
}

/** What T3 issued: the client registration and its tokens. Secrets: machine state only. */
export interface Grant {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** When the access token expires (ms since 1970), when T3 said. */
  readonly expiresAt?: number;
}

/** PKCE (RFC 7636) with S256: a verifier of 256 random bits and its challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function getJson(fetchFn: Fetch, url: string, ms: number) {
  const response = await t3Request(fetchFn, url, { headers: { accept: "application/json" } }, ms);
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new T3Error(response.status === 404 ? "rejected" : "unreadable");
  }
  return readObject(response);
}

/** A loopback URL's text, or a refusal: Tasks sends nothing to another host. */
function loopback(value: unknown): string {
  const url = loopbackUrl(value);
  if (url === undefined) throw new PairingError("unsupported");
  return url.toString();
}

/**
 * The authorization server of T3's MCP endpoint at `origin`, by the MCP authorization
 * specification's discovery: the protected resource metadata, then the authorization server's.
 */
export async function discover(
  origin: string,
  fetchFn: Fetch = globalThis.fetch,
  ms: number = T3_REQUEST_MS,
): Promise<AuthServer> {
  let resourceMeta: Record<string, unknown> | undefined;
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    try {
      resourceMeta = await getJson(fetchFn, `${origin}${path}`, ms);
      break;
    } catch (error) {
      if (!(error instanceof T3Error) || error.failure !== "rejected") throw error;
    }
  }
  if (resourceMeta === undefined) throw new PairingError("unsupported");
  const servers = resourceMeta["authorization_servers"];
  const issuer = loopbackUrl(Array.isArray(servers) ? servers[0] : undefined);
  if (issuer === undefined) throw new PairingError("unsupported");
  const resource = loopback(resourceMeta["resource"] ?? `${origin}/mcp`);
  // RFC 8414: the well-known path goes between the host and the issuer's path.
  const suffix = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/u, "");
  let meta: Record<string, unknown> | undefined;
  for (const well of ["oauth-authorization-server", "openid-configuration"]) {
    try {
      meta = await getJson(fetchFn, `${issuer.origin}/.well-known/${well}${suffix}`, ms);
      break;
    } catch (error) {
      if (!(error instanceof T3Error) || error.failure !== "rejected") throw error;
    }
  }
  if (meta === undefined) throw new PairingError("unsupported");
  const methods = meta["code_challenge_methods_supported"];
  if (!Array.isArray(methods) || !methods.includes("S256")) throw new PairingError("unsupported");
  return {
    authorization: loopback(meta["authorization_endpoint"]),
    token: loopback(meta["token_endpoint"]),
    registration: loopback(meta["registration_endpoint"]),
    resource,
  };
}

/** The tokens of a token endpoint's answer, checked. */
function tokensOf(
  answer: Record<string, unknown>,
  now: number,
): Pick<Grant, "accessToken" | "refreshToken" | "expiresAt"> {
  const access = answer["access_token"];
  const type = answer["token_type"];
  const refresh = answer["refresh_token"];
  const expires = answer["expires_in"];
  if (typeof access !== "string" || !TOKEN.test(access)) throw new T3Error("unreadable");
  if (typeof type !== "string" || type.toLowerCase() !== "bearer") throw new T3Error("unreadable");
  if (refresh !== undefined && (typeof refresh !== "string" || !TOKEN.test(refresh))) {
    throw new T3Error("unreadable");
  }
  const seconds =
    typeof expires === "number" && Number.isSafeInteger(expires) && expires > 0 && expires < 3e8
      ? expires
      : undefined;
  return {
    accessToken: access,
    ...(typeof refresh === "string" ? { refreshToken: refresh } : {}),
    ...(seconds === undefined ? {} : { expiresAt: now + seconds * 1000 }),
  };
}

async function postToken(
  fetchFn: Fetch,
  url: string,
  form: Record<string, string>,
  ms: number,
): Promise<Record<string, unknown>> {
  const response = await t3Request(
    fetchFn,
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    },
    ms,
  );
  if (response.status === 400 || response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    // invalid_grant and its kin: the code or the refresh token is not accepted.
    throw new T3Error("unauthorized");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new T3Error(response.status >= 500 ? "lost" : "rejected");
  }
  return readObject(response);
}

/** One pairing attempt: the page to approve on, and the wait for its answer. */
export interface PairingAttempt {
  /** T3's authorization page for this attempt: for the browser, never for a log. */
  readonly url: string;
  /** When the attempt ends unanswered (ms since 1970). */
  readonly expiresAt: number;
  /** The grant once the person approved, or a PairingError or T3Error. */
  wait(): Promise<Grant>;
  /** Ends the attempt now: `wait()` rejects with `cancelled`, and the listener closes. */
  cancel(): void;
}

export interface PairingOptions {
  /** T3's origin, from its `server-runtime.json`. */
  readonly origin: string;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly deadlineMs?: number;
  readonly requestMs?: number;
}

/** Text the browser shows on the callback page. Never a value from the request. */
const PAGE = {
  ok: `${PRODUCT_NAME} is paired with T3 Code. You can close this tab.`,
  failed: `Pairing did not finish. Go back to the terminal.`,
  other: `This page is not part of a pairing in progress.`,
};

/**
 * Starts a pairing attempt: discovery, a loopback listener on a port the OS assigns, a client
 * registration for its redirect, and the authorization URL with a fresh S256 challenge and state.
 */
export async function beginPairing(options: PairingOptions): Promise<PairingAttempt> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const ms = options.requestMs ?? T3_REQUEST_MS;
  const server = await discover(options.origin, fetchFn, ms);
  const { verifier, challenge } = pkce();
  const state = randomBytes(32).toString("base64url");
  const expected = Buffer.from(state);

  let settle!: { ok: (grant: Grant) => void; fail: (error: Error) => void };
  const result = new Promise<Grant>((resolve, reject) => {
    settle = { ok: resolve, fail: reject };
  });
  // Whoever reads `wait()` sees the outcome; an attempt nobody waits for must not crash.
  result.catch(() => undefined);
  let finished = false;
  let used = false;
  let redirect = "";
  let client: { clientId: string; clientSecret?: string } | undefined;

  const listener: Server = createServer((req, res) => {
    const page = (status: number, text: string) => {
      res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end(text);
    };
    // Any local program can send this listener a request. A target `URL` cannot parse would throw
    // here, outside every promise: an uncaught exception that ends the process hosting the pairing.
    // It is answered 400 and changes nothing.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      page(400, PAGE.other);
      return;
    }
    if (req.method !== "GET" || url.pathname !== "/callback" || used || finished) {
      page(url.pathname === "/callback" ? 400 : 404, PAGE.other);
      return;
    }
    const given = url.searchParams.get("state");
    const match =
      given !== null &&
      Buffer.byteLength(given) === expected.length &&
      timingSafeEqual(Buffer.from(given), expected);
    // Another state, or none: not this attempt's answer. Nothing is exchanged; it keeps waiting.
    if (!match) {
      page(400, PAGE.other);
      return;
    }
    used = true;
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") !== null || code === null || client === undefined) {
      page(400, PAGE.failed);
      end(new PairingError("denied"));
      return;
    }
    const registered = client;
    postToken(
      fetchFn,
      server.token,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: registered.clientId,
        code_verifier: verifier,
        resource: server.resource,
        ...(registered.clientSecret === undefined
          ? {}
          : { client_secret: registered.clientSecret }),
      },
      ms,
    ).then(
      (answer) => {
        let tokens;
        try {
          tokens = tokensOf(answer, now());
        } catch (error) {
          page(502, PAGE.failed);
          end(error as Error);
          return;
        }
        page(200, PAGE.ok);
        end(undefined, { ...registered, ...tokens });
      },
      (error: unknown) => {
        page(502, PAGE.failed);
        end(error instanceof Error ? error : new T3Error("lost"));
      },
    );
  });
  const end = (error: Error | undefined, grant?: Grant) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    listener.close();
    // Connections the browser keeps open would hold the close.
    listener.closeAllConnections();
    if (grant !== undefined) settle.ok(grant);
    else settle.fail(error ?? new PairingError("cancelled"));
  };
  const deadline = options.deadlineMs ?? PAIR_DEADLINE_MS;
  const timer = setTimeout(() => {
    end(new PairingError("timed_out"));
  }, deadline);
  // An attempt never keeps the process alive by itself: the service, or the test, does.
  timer.unref();
  listener.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        listener.off("error", reject);
        // A later server error ends the attempt instead of the process.
        listener.on("error", () => {
          end(new T3Error("lost"));
        });
        resolve();
      });
    });
    const address = listener.address();
    if (address === null || typeof address === "string") throw new T3Error("lost");
    redirect = `http://127.0.0.1:${String(address.port)}/callback`;
    client = await register(fetchFn, server.registration, redirect, ms);
  } catch (error) {
    end(error instanceof Error ? error : new T3Error("lost"));
    throw error;
  }
  const url = new URL(server.authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", server.resource);
  return {
    url: url.toString(),
    expiresAt: now() + deadline,
    wait: () => result,
    cancel: () => {
      end(new PairingError("cancelled"));
    },
  };
}

/** Dynamic client registration (RFC 7591) for one redirect: a public client, no secret asked. */
async function register(
  fetchFn: Fetch,
  endpoint: string,
  redirect: string,
  ms: number,
): Promise<{ clientId: string; clientSecret?: string }> {
  const response = await t3Request(
    fetchFn,
    endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: PRODUCT_NAME,
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
    ms,
  );
  if (response.status !== 200 && response.status !== 201) {
    await response.body?.cancel().catch(() => undefined);
    throw new T3Error(response.status >= 500 ? "lost" : "rejected");
  }
  const answer = await readObject(response);
  const id = answer["client_id"];
  const secret = answer["client_secret"];
  if (typeof id !== "string" || !CLIENT_ID.test(id)) throw new T3Error("unreadable");
  if (secret !== undefined && (typeof secret !== "string" || !TOKEN.test(secret))) {
    throw new T3Error("unreadable");
  }
  return { clientId: id, ...(typeof secret === "string" ? { clientSecret: secret } : {}) };
}

/**
 * New tokens for a grant's refresh token, from the token endpoint discovered at `origin` now (T3
 * may have moved to another port). A refusal is `unauthorized`: the person pairs again.
 */
export async function refreshGrant(
  origin: string,
  grant: Grant,
  options: { fetch?: Fetch; now?: () => number; requestMs?: number } = {},
): Promise<Grant> {
  if (grant.refreshToken === undefined) throw new T3Error("unauthorized");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const ms = options.requestMs ?? T3_REQUEST_MS;
  const server = await discover(origin, fetchFn, ms);
  const answer = await postToken(
    fetchFn,
    server.token,
    {
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
      client_id: grant.clientId,
      resource: server.resource,
      ...(grant.clientSecret === undefined ? {} : { client_secret: grant.clientSecret }),
    },
    ms,
  );
  const tokens = tokensOf(answer, (options.now ?? Date.now)());
  return {
    clientId: grant.clientId,
    ...(grant.clientSecret === undefined ? {} : { clientSecret: grant.clientSecret }),
    // A server that does not rotate the refresh token keeps the one it had.
    ...(tokens.refreshToken === undefined ? { refreshToken: grant.refreshToken } : {}),
    ...tokens,
  };
}
