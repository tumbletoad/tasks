// The handshake's cryptography, with Node's built-in crypto only: HMAC-SHA256 for the
// proofs and the session key, SHA-256 for the transcript hash, the OS random source for nonces
// and timingSafeEqual for every comparison of a proof.
//
//   Pc = b64url(HMAC(key, "ttasks-local/1 client\n" + I + "\n" + P + "\n" + M + "\n" + Ns + "\n" + Nc))
//   Ps = b64url(HMAC(key, "ttasks-local/1 server\n" + I + "\n" + P + "\n" + M + "\n" + Nc + "\n" + Ns))
//   Ks = HMAC(key, "ttasks-local/1 session\n" + I + "\n" + Ns + "\n" + Nc)
//   T  = hex(SHA-256("ttasks-local/1 transcript\n" + I + "\n" + Ns + "\n" + Nc + "\n"
//                    + JCS(challenge protocols) + "\n" + JCS({protocol, mode, client, context})))
//   Mb = b64url(HMAC(Ks, "ttasks-local/1 bind\n" + T))
//   Ms = b64url(HMAC(Ks, "ttasks-local/1 bound\n" + T + "\n" + hex(SHA-256(JCS(result without mac)))))
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { KEY_BYTES, NONCE_BYTES, type Mode } from "./constants.ts";
import { canonicalJson } from "./jcs.ts";

/** The values both proofs cover. Nonces are the base64url text exactly as sent. */
export interface HandshakeIds {
  /** The instance ID the challenge named. */
  readonly instance: string;
  /** The protocol the hello named. */
  readonly protocol: number;
  /** The mode the hello named. */
  readonly mode: Mode;
  /** `Ns`, from the challenge. */
  readonly serverNonce: string;
  /** `Nc`, from the hello. */
  readonly clientNonce: string;
}

/** The fields of the bind frame that the transcript covers, in the transcript's order. */
export interface BindBody {
  readonly protocol: number;
  readonly mode: Mode;
  readonly client: unknown;
  readonly context: unknown;
}

const DIGEST_BYTES = 32;
/** base64url of 32 bytes without padding. */
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

const hmac = (key: Uint8Array, text: string): Buffer =>
  createHmac("sha256", key).update(text, "utf8").digest();
const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** 32 random bytes as base64url: a nonce or a new `ipc.key`. */
export function randomToken(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

/** The 32 bytes a canonical base64url text of 43 characters encodes, or undefined. */
export function decode32(text: unknown): Buffer | undefined {
  if (typeof text !== "string" || !B64URL_32.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64url");
  // The last character carries 2 unused bits. Only one spelling of each value is accepted.
  return bytes.length === DIGEST_BYTES && bytes.toString("base64url") === text ? bytes : undefined;
}

/** Whether `text` is a well-formed nonce: 32 bytes, canonical base64url. */
export function isNonce(text: unknown): text is string {
  return decode32(text) !== undefined;
}

/**
 * The key bytes of an `ipc.key` file: 32 bytes as base64url, optionally followed by one line
 * ending. Throws on anything else, without echoing the content.
 */
export function parseKey(text: string): Buffer {
  const key = decode32(text.replace(/\r?\n$/, ""));
  if (key === undefined) throw new Error("ipc.key does not hold 32 bytes as base64url");
  return key;
}

/** Throws unless `key` is exactly KEY_BYTES long. */
export function checkKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new TypeError(`The key must be ${String(KEY_BYTES)} bytes`);
  }
}

function proofText(label: "client" | "server", ids: HandshakeIds): string {
  const [first, second] =
    label === "client" ? [ids.serverNonce, ids.clientNonce] : [ids.clientNonce, ids.serverNonce];
  return `ttasks-local/1 ${label}\n${ids.instance}\n${String(ids.protocol)}\n${ids.mode}\n${first}\n${second}`;
}

/** `Pc` as raw bytes. */
export function clientProof(key: Uint8Array, ids: HandshakeIds): Buffer {
  return hmac(key, proofText("client", ids));
}

/** `Ps` as raw bytes. */
export function serverProof(key: Uint8Array, ids: HandshakeIds): Buffer {
  return hmac(key, proofText("server", ids));
}

/** `Ks`, new for every connection. Only a holder of the key can derive it. */
export function sessionKey(key: Uint8Array, ids: HandshakeIds): Buffer {
  return hmac(
    key,
    `ttasks-local/1 session\n${ids.instance}\n${ids.serverNonce}\n${ids.clientNonce}`,
  );
}

/**
 * `T`: covers the instance, both nonces, the protocols the challenge offered, and the protocol,
 * mode, client details and context of the bind frame in canonical form.
 */
export function transcriptHash(
  ids: HandshakeIds,
  protocols: readonly number[],
  body: BindBody,
): string {
  const covered = {
    protocol: body.protocol,
    mode: body.mode,
    client: body.client,
    context: body.context,
  };
  return sha256Hex(
    `ttasks-local/1 transcript\n${ids.instance}\n${ids.serverNonce}\n${ids.clientNonce}\n` +
      `${canonicalJson(protocols)}\n${canonicalJson(covered)}`,
  );
}

/** `Mb` as raw bytes. */
export function bindProof(ks: Uint8Array, transcript: string): Buffer {
  return hmac(ks, `ttasks-local/1 bind\n${transcript}`);
}

/** `Ms` as raw bytes, over the bind result without its `mac`. */
export function boundProof(ks: Uint8Array, transcript: string, result: unknown): Buffer {
  return hmac(ks, `ttasks-local/1 bound\n${transcript}\n${sha256Hex(canonicalJson(result))}`);
}

/** A proof as it travels: base64url without padding. */
export function proofToText(proof: Buffer): string {
  return proof.toString("base64url");
}

/**
 * Whether a received proof equals the expected one. The comparison of the 32 bytes runs in
 * constant time (timingSafeEqual). The format check before it only looks at the received text,
 * so it reveals nothing about the expected value.
 */
export function proofMatches(received: unknown, expected: Buffer): boolean {
  const bytes = decode32(received);
  if (bytes === undefined || expected.length !== DIGEST_BYTES) return false;
  return timingSafeEqual(bytes, expected);
}
