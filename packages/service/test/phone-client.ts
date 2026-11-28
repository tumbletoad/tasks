// A phone for the tests: what the app does on the link (link/service.ts), in Node. It makes a key
// and a certificate of its own, checks the computer's pin before it sends a byte, then opens the
// WebSocket on that same TLS connection and speaks `ttasks-link/1`. Tests only.
import { connect, type TLSSocket } from "node:tls";
import { WebSocket } from "ws";
import { certPin, makeIdentity } from "../src/link/cert.ts";
import { LINK_PATH, LINK_PROTOCOL, parsePairing, type Pairing } from "@ttasks/contracts/link";

export interface PhoneKey {
  readonly key: string;
  readonly cert: string;
  readonly pin: string;
}

/** A phone's own key pair, as the app makes it once. */
export function phoneKey(): PhoneKey {
  const identity = makeIdentity();
  const pin = certPin(identity.cert);
  if (pin === undefined) throw new Error("no pin");
  return { ...identity, pin };
}

export type { Pairing };

export function readPairing(text: string): Pairing {
  const pairing = parsePairing(text);
  if (pairing === undefined) throw new Error("not a pairing code");
  return pairing;
}

export interface PhoneLink {
  readonly ws: WebSocket;
  readonly messages: Record<string, unknown>[];
  next(
    match?: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ): Promise<Record<string, unknown>>;
  /** One call: its reply's status and body. */
  call(
    path: string,
    body: unknown,
    copy?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  send(message: unknown): void;
  readonly closed: Promise<number>;
}

export type Opened =
  | { readonly kind: "pin_rejected" }
  | { readonly kind: "served"; readonly link: PhoneLink; readonly hello: Record<string, unknown> }
  | { readonly kind: "removed" }
  | { readonly kind: "refused" };

/** TLS to `addr`, with the pin checked before anything is written. */
export function tlsTo(
  addr: string,
  pin: string,
  key?: PhoneKey,
): Promise<{ socket: TLSSocket; pinned: boolean }> {
  const [host = "", port = "0"] = addr.split(/:(?=\d+$)/u);
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port: Number(port),
      ...(key === undefined ? {} : { key: key.key, cert: key.cert }),
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
    });
    socket.once("secureConnect", () => {
      const peer = socket.getPeerX509Certificate();
      const pinned = peer !== undefined && certPin(peer.raw) === pin;
      resolve({ socket, pinned });
    });
    socket.once("error", reject);
  });
}

/** Opens the link as the app does: pin, then the WebSocket, then `open`. */
export async function openLink(
  addr: string,
  pin: string,
  key: PhoneKey,
  open: { space: string; pair?: { code: string; name?: string; platform?: string } },
): Promise<Opened> {
  const { socket, pinned } = await tlsTo(addr, pin, key);
  if (!pinned) {
    socket.destroy();
    return { kind: "pin_rejected" };
  }
  const ws = new WebSocket(`wss://${addr}${LINK_PATH}`, {
    createConnection: () => socket,
    perMessageDeflate: false,
    rejectUnauthorized: false,
  });
  const messages: Record<string, unknown>[] = [];
  let read = 0;
  let wake: (() => void) | undefined;
  ws.on("message", (data: Buffer) => {
    messages.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    wake?.();
  });
  ws.on("error", () => undefined);
  const closed = new Promise<number>((resolve) => {
    ws.on("close", (code: number) => {
      resolve(code);
      wake?.();
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      resolve();
    });
    ws.once("error", reject);
  });
  const next = async (match: (m: Record<string, unknown>) => boolean = () => true, ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      while (read < messages.length) {
        const message = messages[read];
        read += 1;
        if (message !== undefined && match(message)) return message;
      }
      if (ws.readyState === WebSocket.CLOSED) throw new Error("the link closed");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("no such message in time");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };
  let calls = 0;
  const link: PhoneLink = {
    ws,
    messages,
    closed,
    next,
    send: (message) => {
      ws.send(typeof message === "string" ? message : JSON.stringify(message));
    },
    call: async (path, body, copy) => {
      calls += 1;
      const id = `c${String(calls)}`;
      ws.send(
        JSON.stringify({ type: "call", id, path, body, ...(copy === undefined ? {} : { copy }) }),
      );
      const reply = await next((m) => m["type"] === "reply" && m["id"] === id);
      return { status: reply["status"] as number, body: reply["body"] as Record<string, unknown> };
    },
  };
  ws.send(JSON.stringify({ type: "open", protocol: LINK_PROTOCOL, ...open }));
  const first = await next(() => true, 10_000).catch(() => undefined);
  if (first?.["type"] === "hello") return { kind: "served", link, hello: first };
  if (first?.["type"] === "removed") return { kind: "removed" };
  return { kind: "refused" };
}
