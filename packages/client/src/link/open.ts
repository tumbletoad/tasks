// The phone's link to the computer as plain TypeScript (`@ttasks/client/link`): the `open` frame,
// pairing with a code the first time and without one after, the hello read for the space, and
// `removed` told apart from a lost connection. Each of the computer's addresses in turn, each
// attempt bounded through the hello. A connection that closes or never comes leaves the pairing as
// it is: only the computer's explicit `removed` ends it.
//
// It runs over a socket it is handed (`Connect`): the phone app hands it its native link, the tests
// a Node one against the real service.
import { LINK_PATH, LINK_PROTOCOL, type Pairing } from "@ttasks/contracts/link";

/** Why a socket ended before it opened: the computer's key is another, TLS failed, or no route. */
export type Failure = "pin" | "tls" | "network";

export interface SocketEvents {
  open(): void;
  message(text: string): void;
  /** Comes before `close` when the socket failed. */
  error(kind: Failure): void;
  close(code: number): void;
}

/** A WebSocket to the computer. After `close`, none of its events reach anyone. */
export interface LinkSocket {
  /** What its events do: replaced when the socket changes hands. */
  events: SocketEvents;
  send(text: string): void;
  close(): void;
}

/** A socket to `url` that trusts the computer by `pin` alone and presents the phone's key. */
export type Connect = (url: string, pin: string, events: SocketEvents) => LinkSocket;

/** What the phone keeps of a pairing to open the link again. */
export type Saved = Pick<Pairing, "addrs" | "pin" | "space">;

/** What the computer's hello says of this phone's pairing. */
export interface Hello {
  readonly link: { readonly space: { readonly id: string; readonly name: string } };
}

export type Opened =
  | {
      readonly kind: "served";
      readonly hello: Hello;
      readonly socket: LinkSocket;
      /** The pairing to keep: the address that served first, and the space as the hello names it. */
      readonly saved: Saved;
    }
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

/** What the phone sends with its first `open` to the computer. */
interface Pair {
  readonly code: string;
  readonly name: string;
  readonly platform: "android";
}

/** `sent`: the `open` went out, so the computer may have acted on it. */
type Attempt =
  | { readonly kind: "served"; readonly hello: Hello; readonly socket: LinkSocket }
  | { readonly kind: "removed" }
  | { readonly kind: "failed"; readonly pin: boolean; readonly sent: boolean };

/**
 * One walk over the computer's addresses. Cancelling it ends its attempt now, closes that socket
 * and tries no further address.
 */
interface Walk {
  cancelled: boolean;
  /** Ends the attempt in progress, if there is one. */
  end?: (() => void) | undefined;
}

function attempt(
  connect: Connect,
  addr: string,
  saved: Saved,
  walk: Walk,
  pair?: Pair,
): Promise<Attempt> {
  return new Promise((resolve) => {
    let pin = false;
    let sent = false;
    let done = false;
    const finish = (outcome: Attempt) => {
      if (done) return;
      done = true;
      walk.end = undefined;
      clearTimeout(timer);
      if (outcome.kind !== "served") socket.close();
      resolve(outcome);
    };
    const socket = connect(`wss://${addr}${LINK_PATH}`, saved.pin, {
      open: () => {
        sent = true;
        const open = { type: "open", protocol: LINK_PROTOCOL, space: saved.space.id };
        socket.send(JSON.stringify(pair === undefined ? open : { ...open, pair }));
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
        if (helloFor(message, saved.space.id)) finish({ kind: "served", hello: message, socket });
        else if (isRecord(message) && message["type"] === "removed") finish({ kind: "removed" });
        else finish({ kind: "failed", pin, sent });
      },
      error: (kind) => {
        pin = kind === "pin";
      },
      close: () => {
        finish({ kind: "failed", pin, sent });
      },
    });
    walk.end = () => {
      finish({ kind: "failed", pin, sent });
    };
    const timer = setTimeout(() => {
      finish({ kind: "failed", pin, sent });
    }, ATTEMPT_MS);
  });
}

function served(outcome: Attempt & { kind: "served" }, addr: string, saved: Saved): Opened {
  const { hello, socket } = outcome;
  const addrs = [addr, ...saved.addrs.filter((a) => a !== addr)];
  return {
    kind: "served",
    hello,
    socket,
    saved: { addrs, pin: saved.pin, space: hello.link.space },
  };
}

/** Opening the link, which can be called off. */
export interface Opening {
  /** What came of it. Once cancelled: `offline`, with no socket left open. */
  readonly done: Promise<Opened>;
  cancel(): void;
}

/** The link to the paired computer, at the first of its addresses that serves the phone. */
export function openLink(connect: Connect, saved: Saved): Opening {
  const walk: Walk = { cancelled: false };
  const run = async (): Promise<Opened> => {
    let pin = false;
    for (const addr of saved.addrs) {
      // A cancel comes while an attempt waits: it ends that attempt, and this stops the walk.
      const outcome = await attempt(connect, addr, saved, walk);
      if (walk.cancelled) {
        if (outcome.kind === "served") outcome.socket.close();
        break;
      }
      if (outcome.kind === "served") return served(outcome, addr, saved);
      if (outcome.kind === "removed") return outcome;
      pin ||= outcome.pin;
    }
    return { kind: "offline", pin };
  };
  return {
    done: run(),
    cancel: () => {
      walk.cancelled = true;
      walk.end?.();
    },
  };
}

/**
 * Pairs with the computer a QR code names, as the phone called `name`. An address that never got
 * the `open` leaves the code unspent for the next. Once it went out, the computer may have used the
 * code and saved the phone before its answer was lost: the phone asks once more, without the code,
 * with the same key and space, and stops there.
 */
export async function pairWith(connect: Connect, qr: Pairing, name: string): Promise<Opened> {
  const pair: Pair = { code: qr.code, name, platform: "android" };
  const walk: Walk = { cancelled: false };
  let pin = false;
  for (const addr of qr.addrs) {
    const first = await attempt(connect, addr, qr, walk, pair);
    if (first.kind === "served") return served(first, addr, qr);
    if (first.kind === "removed") return first;
    if (first.sent) {
      const again = await attempt(connect, addr, qr, walk);
      if (again.kind === "served") return served(again, addr, qr);
      return again.kind === "removed" ? again : { kind: "offline", pin: false };
    }
    pin ||= first.pin;
  }
  return { kind: "offline", pin };
}
