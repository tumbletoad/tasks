// The shim's two secrets and the claim's evidence ID.
//
// - The ticket: 120 random bits, the only per-launch value in terminal argv. Redeemable once per
//   role over the user-only socket.
// - The attachment credential: 128 random bits, returned in the claim's reply and kept in the
//   shim's memory only.
// The service stores neither, only a SHA-256 of each, bound to its launch and its kind by a domain
// line: `<product>-<kind>/1\n<launch ID>\n<secret>`. A ticket's hash cannot pass for a credential's,
// and the hash of one launch's ticket cannot pass for another launch's. Every comparison is
// constant time over the 32 bytes of the hash.
//
// The claim's evidence is a fresh random ID, never derived from either secret.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PRODUCT_ID } from "@ttasks/brand";
import { TICKET_ALPHABET } from "./wire.ts";

const LOWER = TICKET_ALPHABET.toLowerCase();

/** `bits` random bits in base32 symbols of `alphabet`, most significant first. */
function base32(bytes: Buffer, symbols: number, alphabet: string): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  for (let i = symbols - 1; i >= 0; i -= 1) {
    out += alphabet.charAt(Number((value >> BigInt(5 * i)) & 31n));
  }
  return out;
}

/** A new ticket: 120 random bits, 24 symbols of the ID alphabet in upper case. */
export const newTicket = (): string => base32(randomBytes(15), 24, TICKET_ALPHABET);

/** A new attachment credential: 128 random bits, unpadded base64url. */
export const newCredential = (): string => randomBytes(16).toString("base64url");

/** A new claim ID for the record's evidence: 130 random bits, never a secret's derivative. */
export const newClaimId = (): string => `claim-${base32(randomBytes(17), 26, LOWER)}`;

export type SecretKind = "ticket" | "attachment";

/** The stored form of a secret: lower-case hex SHA-256 over its kind, its launch and itself. */
export function secretHash(kind: SecretKind, launch: string, secret: string): string {
  return createHash("sha256")
    .update(`${PRODUCT_ID}-${kind}/1\n${launch}\n${secret}`, "utf8")
    .digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

export const isHash = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

/** Whether two stored hashes are equal, in constant time over their 32 bytes. */
export function sameHash(a: string, b: string): boolean {
  if (!isHash(a) || !isHash(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
