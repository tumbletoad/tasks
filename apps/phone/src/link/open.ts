// Opening the link to the paired computer: each of its addresses in turn, each attempt bounded
// through the hello. A connection that closes or never comes leaves the pairing as it is: only the
// computer's explicit `removed` ends it.
import { LINK_PATH, LINK_PROTOCOL, type Pairing } from "@ttasks/contracts/link";
import { connectSocket, type LinkSocket } from "./socket.ts";

/** What the phone keeps of a pairing to open the link again. */
export type Saved = Pick<Pairing, "addrs" | "pin" | "space">;

/** What the computer's hello says of this phone's pairing. */
export interface Hello {
  readonly link: { readonly space: { readonly id: string; readonly name: string } };
}

export type Opened =
  | { readonly kind: "served"; readonly hello: Hello; readonly socket: LinkSocket }
  | { readonly kind: "removed" }
  /** `pin`: an address answered with another key. */
  | { readonly kind: "offline"; readonly pin: boolean };

/** One address, from the TCP connect through the hello. */
const ATTEMPT_MS = 10_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The saved pairing's JSON as the module keeps it, or undefined. */
export function readSaved(json: string | null): Saved | undefined {
  if (json === null) return undefined;
  try {
    const value = JSON.parse(json) as unknown;
    if (!isRecord(value) || !isRecord(value["space"])) return undefined;
    const { addrs, pin } = value;
    const { id, name } = value["space"];
    if (!Array.isArray(addrs) || !addrs.every((a) => typeof a === "string")) return undefined;
    if (typeof pin !== "string" || typeof id !== "string" || typeof name !== "string") {
      return undefined;
    }
    return { addrs, pin, space: { id, name } };
  } catch {
    return undefined;
  }
}

/** Whether `message` is the hello of this protocol for the space the phone was paired for. */
export function helloFor(message: unknown, space: string): message is Hello {
  if (!isRecord(message) || message["type"] !== "hello" || !isRecord(message["link"])) return false;
  const link = message["link"];
  return (
    link["protocol"] === LINK_PROTOCOL &&
    isRecord(link["space"]) &&
    link["space"]["id"] === space &&
    typeof link["space"]["name"] === "string"
  );
}

type Attempt = Opened | { readonly kind: "failed"; readonly pin: boolean };

function attempt(addr: string, saved: Saved): Promise<Attempt> {
  return new Promise((resolve) => {
    let pin = false;
    let done = false;
    const finish = (outcome: Attempt) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const socket = connectSocket(`wss://${addr}${LINK_PATH}`, saved.pin, {
      open: () => {
        socket.send(
          JSON.stringify({ type: "open", protocol: LINK_PROTOCOL, space: saved.space.id }),
        );
      },
      message: (text) => {
        // After the hello the socket is its new owner's.
        if (done) return;
        let message: unknown;
        try {
          message = JSON.parse(text) as unknown;
        } catch {
          message = undefined;
        }
        if (helloFor(message, saved.space.id)) {
          finish({ kind: "served", hello: message, socket });
          return;
        }
        socket.close();
        finish(
          isRecord(message) && message["type"] === "removed"
            ? { kind: "removed" }
            : { kind: "failed", pin },
        );
      },
      error: (kind) => {
        pin = kind === "pin";
      },
      close: () => {
        finish({ kind: "failed", pin });
      },
    });
    const timer = setTimeout(() => {
      socket.close();
      finish({ kind: "failed", pin });
    }, ATTEMPT_MS);
  });
}

/** The link to the paired computer, at the first of its addresses that serves the phone. */
export async function openLink(saved: Saved): Promise<Opened> {
  let pin = false;
  for (const addr of saved.addrs) {
    const outcome = await attempt(addr, saved);
    if (outcome.kind !== "failed") return outcome;
    pin ||= outcome.pin;
  }
  return { kind: "offline", pin };
}
