// The phone's link as both ends speak it (`@ttasks/contracts/link`): the QR code's text, the one
// path and the protocol number. The service makes the code and listens; the phone reads the code
// and connects. Plain TypeScript, so the phone app's bundle loads it without Zod.

/** The link protocol's number, in the phone's `open` and in the hello's `link`. */
export const LINK_PROTOCOL = 1;
/** The one path the listener serves, as a WebSocket. */
export const LINK_PATH = "/v1/link";
/** What a pairing code starts with. Never a URL: nothing opens it but the app. */
export const PAIRING_PREFIX = "TTASKS1:";

/** What the QR code says: where the computer is, the pin of its key, the space, the code. */
export interface Pairing {
  readonly v: typeof LINK_PROTOCOL;
  /** `host:port`, each an address of the computer. */
  readonly addrs: readonly string[];
  /** SHA-256 of the computer's SubjectPublicKeyInfo, unpadded base64url. */
  readonly pin: string;
  readonly space: { readonly id: string; readonly name: string };
  /** Works once, for five minutes. */
  readonly code: string;
}

const PIN = /^[A-Za-z0-9_-]{43}$/u;
const ADDR = /^[^\s:]+:\d{1,5}$/u;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The pairing a QR code's text holds, or undefined when it is not one this version reads. */
export function parsePairing(text: string): Pairing | undefined {
  if (!text.startsWith(PAIRING_PREFIX)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(PAIRING_PREFIX.length)) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["v"] !== LINK_PROTOCOL) return undefined;
  const { addrs, pin, space, code } = value;
  if (
    !Array.isArray(addrs) ||
    addrs.length === 0 ||
    !addrs.every((a): a is string => typeof a === "string" && ADDR.test(a)) ||
    typeof pin !== "string" ||
    !PIN.test(pin) ||
    !isRecord(space) ||
    typeof space["id"] !== "string" ||
    space["id"] === "" ||
    typeof space["name"] !== "string" ||
    typeof code !== "string" ||
    code === ""
  ) {
    return undefined;
  }
  return { v: LINK_PROTOCOL, addrs, pin, space: { id: space["id"], name: space["name"] }, code };
}
