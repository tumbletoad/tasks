// Immutable IDs (A1 3.3): `<prefix>_<26 characters>`. The characters are Crockford base32 in lower
// case and encode 128 bits from the OS random source (crypto.getRandomValues). 26 characters hold
// 130 bits and the top two are zero, so the first character is 0 to 7 and every ID has exactly one
// spelling. There is no timestamp, counter or machine code, and an ID is never derived from a
// title, path or host name.
import { misuse } from "./errors.ts";

/** Crockford base32 in lower case: the digits and the letters without i, l, o and u. */
export const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** The random bytes behind every ID: 128 bits. */
export const ID_BYTES = 16;

/** Characters in an ID body. */
export const ID_BODY_LENGTH = 26;

/** A1 3.3's prefixes, by entity. */
export const ID_PREFIXES = {
  space: "sp",
  actor: "ac",
  machine: "m",
  session: "se",
  task: "t",
  launch: "la",
  area: "a",
  run: "ru",
  project: "p",
  routine: "ro",
  note: "n",
  proposal: "pr",
  log: "l",
  commit: "op",
  learning: "lr",
  exchange: "ex",
  source: "s",
  attachment: "at",
  label: "lb",
  place: "pl",
  folder: "fo",
  device: "dv",
  remoteCommand: "rc",
  incarnation: "ai",
  transfer: "tr",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

/** An ID with its prefix in the type, such as `Id<"t">` for a task. */
export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

/** Fills the given bytes with random bits. The default is the OS source. */
export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => void;

/** crypto.getRandomValues, the OS random source A1 3.3 names. */
export const osRandom: RandomSource = (bytes) => {
  globalThis.crypto.getRandomValues(bytes);
};

const PREFIXES: ReadonlySet<string> = new Set(Object.values(ID_PREFIXES));
const BODY = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const VALUE = new Map(
  Array.from({ length: 32 }, (_, index) => [ID_ALPHABET.charAt(index), BigInt(index)] as const),
);

/** The 26-character body that encodes 16 bytes, most significant bit first. */
export function encodeIdBody(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== ID_BYTES) {
    throw misuse("An ID body encodes exactly 16 bytes");
  }
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let body = "";
  for (let i = ID_BODY_LENGTH - 1; i >= 0; i -= 1) {
    body += ID_ALPHABET.charAt(Number((value >> BigInt(5 * i)) & 31n));
  }
  return body;
}

/** The 16 bytes a valid body encodes, or undefined when it is not a valid body. */
export function decodeIdBody(body: string): Uint8Array | undefined {
  if (typeof body !== "string" || !BODY.test(body)) return undefined;
  let value = 0n;
  for (const char of body) value = (value << 5n) | (VALUE.get(char) ?? 0n);
  const bytes = new Uint8Array(ID_BYTES);
  for (let i = ID_BYTES - 1; i >= 0; i -= 1) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return bytes;
}

/** A new ID: the prefix and 128 bits from `random`, by default the OS source. */
export function newId<P extends IdPrefix>(prefix: P, random: RandomSource = osRandom): Id<P> {
  if (!PREFIXES.has(prefix)) throw misuse("Unknown ID prefix");
  const bytes = new Uint8Array(ID_BYTES);
  random(bytes);
  return `${prefix}_${encodeIdBody(bytes)}`;
}

/** The prefix and body of a valid ID, or undefined. Checks prefix, length and alphabet. */
export function parseId(value: unknown): { prefix: IdPrefix; body: string } | undefined {
  if (typeof value !== "string") return undefined;
  const cut = value.indexOf("_");
  if (cut < 1) return undefined;
  const prefix = value.slice(0, cut);
  const body = value.slice(cut + 1);
  if (!PREFIXES.has(prefix) || !BODY.test(body)) return undefined;
  return { prefix: prefix as IdPrefix, body };
}

/** Whether `value` is a valid ID, with the given prefix when one is named. */
export function isId<P extends IdPrefix>(value: unknown, prefix?: P): value is Id<P> {
  const parsed = parseId(value);
  return parsed !== undefined && (prefix === undefined || parsed.prefix === prefix);
}
