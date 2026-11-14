// Getting a token into the browser (A2 3.8.4), and the short-lived secrets around it.
//
//   1. `tasks open` calls `ui/mint_code` over the socket: a code of 32 random bytes, single use,
//      valid 60 s, kept only as its SHA-256.
//   2. It proves the listener first: `POST /api/v1/auth/probe {"nonce"}` must answer
//      HMAC-SHA256(ipc.key, "tasks-http-probe\n" + instance + "\n" + port + "\n" + nonce). A
//      process squatting on the port cannot, so it never sees a code.
//   3. The page redeems the code (`POST /api/v1/auth/redeem {"code"}`) for a bearer token, a `ui`
//      row of the grants table (grants.ts).
//   4. `POST /api/v1/ws-ticket` gives a 30 s single-use ticket for the WebSocket, bound to the row.
//
// Codes and tickets are taken on the first lookup, found or not, live or expired, so each can be
// presented once. No secret is ever logged, put in an error body or kept in clear.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** A2 3.8.4: a code is valid 60 s. */
export const CODE_MS = 60_000;
/** A2 3.8.4: a WebSocket ticket is valid 30 s. */
export const TICKET_MS = 30_000;
/** A2 3.8.3: `auth/redeem` 10 per minute per service, `auth/probe` 60 per minute. */
export const REDEEM_PER_MINUTE = 10;
export const PROBE_PER_MINUTE = 60;

/** A secret's text: 32 random bytes as base64url. */
export const SECRET = /^[A-Za-z0-9_-]{43}$/;

const hashOf = (secret: string): string =>
  createHash("sha256").update(secret, "utf8").digest("hex");

/**
 * Single-use secrets of one kind, each with a value and an expiry, kept as hashes. At most `max`
 * wait at once: a new one past that pushes out the oldest.
 */
export class OneTimeSecrets<T> {
  readonly #entries = new Map<string, { value: T; expires: number }>();
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(ttlMs: number, max: number) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  get size(): number {
    return this.#entries.size;
  }

  #prune(now: number): void {
    for (const [hash, entry] of this.#entries) if (entry.expires <= now) this.#entries.delete(hash);
  }

  /** A new secret for `value`, returned once. */
  mint(value: T, now: number): string {
    this.#prune(now);
    while (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const secret = randomBytes(32).toString("base64url");
    this.#entries.set(hashOf(secret), { value, expires: now + this.#ttlMs });
    return secret;
  }

  /** The value of a live secret, which is spent by this call. Any lookup spends it. */
  take(secret: unknown, now: number): T | undefined {
    if (typeof secret !== "string" || !SECRET.test(secret)) return undefined;
    const hash = hashOf(secret);
    const entry = this.#entries.get(hash);
    this.#entries.delete(hash);
    return entry !== undefined && now < entry.expires ? entry.value : undefined;
  }

  /** Forgets every secret whose value matches (a revoked grant's tickets). */
  drop(match: (value: T) => boolean): void {
    for (const [hash, entry] of this.#entries) if (match(entry.value)) this.#entries.delete(hash);
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** A fixed one-minute window: at most `limit` events in each. */
export class RateLimit {
  readonly #limit: number;
  #start = Number.NEGATIVE_INFINITY;
  #count = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Counts one event at `now`; false when the window is full. */
  take(now: number): boolean {
    if (now - this.#start >= 60_000) {
      this.#start = now;
      this.#count = 0;
    }
    if (this.#count >= this.#limit) return false;
    this.#count += 1;
    return true;
  }
}

/** The nonce a probe may carry: base64url, 16 to 128 characters. */
export const PROBE_NONCE = /^[A-Za-z0-9_-]{16,128}$/;

/** The listener's proof for `tasks open` (A2 3.8.4 step 2), base64url. */
export function probeProof(key: Uint8Array, instance: string, port: number, nonce: string): string {
  return createHmac("sha256", key)
    .update(`tasks-http-probe\n${instance}\n${String(port)}\n${nonce}`, "utf8")
    .digest("base64url");
}

/** Whether `proof` is the listener's answer to `nonce`, compared in constant time. */
export function verifyProbe(
  key: Uint8Array,
  instance: string,
  port: number,
  nonce: string,
  proof: unknown,
): boolean {
  if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
  const expected = Buffer.from(probeProof(key, instance, port, nonce), "base64url");
  const given = Buffer.from(proof, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
