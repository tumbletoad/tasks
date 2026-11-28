// The certificates of the phone's link: a P-256 key and a self-signed X.509 certificate around it.
// Node has no API that makes a certificate, so this module writes the few DER structures one needs
// and signs them with Node's own ECDSA; Node's TLS and X509Certificate then read the result. Each
// end pins the other's key, never a chain, so the certificate carries no extensions and a name
// that says nothing of the product, the machine or a space.
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import type { KeyObject } from "node:crypto";

/** The subject and issuer every link certificate has. */
export const LINK_CERT_NAME = "link";

/** How long a certificate is valid. Nothing checks it: the key is pinned. */
const VALID_YEARS = 20;

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups: number[] = [];
    for (let v = arc; ; v = Math.floor(v / 128)) {
      groups.unshift(v % 128);
      if (v < 128) break;
    }
    bytes.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A DER INTEGER of unsigned big-endian bytes. */
function integer(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.subarray(start);
  return tlv(0x02, (trimmed[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii"))
    : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));
const NAME = sequence(
  tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(LINK_CERT_NAME, "utf8")))),
);

export interface LinkIdentity {
  /** The private key, PKCS #8 PEM. */
  readonly key: string;
  /** The self-signed certificate, PEM. */
  readonly cert: string;
}

/** A new P-256 key and a self-signed certificate for it. */
export function makeIdentity(now: Date = new Date()): LinkIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const until = new Date(now);
  until.setUTCFullYear(until.getUTCFullYear() + VALID_YEARS);
  const from = new Date(now.getTime() - 86_400_000);
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    ECDSA_SHA256,
    NAME,
    sequence(time(from), time(until)),
    NAME,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = sequence(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
  const body = der.toString("base64").replace(/.{1,64}/gu, "$&\n");
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----\n`,
  };
}

/**
 * The pin of a key: SHA-256 of its SubjectPublicKeyInfo, base64url (43 characters). The QR code
 * carries the computer's, and a phone is known by its own.
 */
export function pinOf(key: KeyObject): string {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("base64url");
}

/** The pin of a certificate's key, or undefined when the text is no certificate. */
export function certPin(cert: string | Buffer): string | undefined {
  try {
    return pinOf(new X509Certificate(cert).publicKey);
  } catch {
    return undefined;
  }
}

/** The shape of a pin. */
export const PIN = /^[A-Za-z0-9_-]{43}$/u;
