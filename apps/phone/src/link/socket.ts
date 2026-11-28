// The native link (modules/ttasks-link) as sockets: a WebSocket to the computer over TLS 1.3, which
// trusts the computer by the pin of its key and presents the phone's own key from the Keystore.
// Events of a socket that was closed here, or replaced, reach nobody.
import { requireNativeModule, type NativeModule } from "expo";

/** Why a socket ended before it opened: the computer's key is another, TLS failed, or no route. */
export type Failure = "pin" | "tls" | "network";

type Events = {
  open(event: { id: number }): void;
  message(event: { id: number; text: string }): void;
  error(event: { id: number; kind: Failure }): void;
  close(event: { id: number; code: number }): void;
};

declare class TTasksLink extends NativeModule<Events> {
  connect(url: string, pin: string): number;
  send(id: number, text: string): void;
  close(id: number, code: number, reason: string): void;
  /** The saved pairing's JSON, or null. */
  pairing(): string | null;
}

export const native = requireNativeModule<TTasksLink>("TTasksLink");

export interface SocketEvents {
  open(): void;
  message(text: string): void;
  /** Comes before `close` when the socket failed. */
  error(kind: Failure): void;
  close(code: number): void;
}

export interface LinkSocket {
  /** What its events do: replaced when the socket changes hands. */
  events: SocketEvents;
  send(text: string): void;
  close(): void;
}

const sockets = new Map<number, LinkSocket>();

native.addListener("open", ({ id }) => sockets.get(id)?.events.open());
native.addListener("message", ({ id, text }) => sockets.get(id)?.events.message(text));
native.addListener("error", ({ id, kind }) => sockets.get(id)?.events.error(kind));
native.addListener("close", ({ id, code }) => {
  const socket = sockets.get(id);
  sockets.delete(id);
  socket?.events.close(code);
});

export function connectSocket(url: string, pin: string, events: SocketEvents): LinkSocket {
  const id = native.connect(url, pin);
  const socket: LinkSocket = {
    events,
    send: (text) => {
      native.send(id, text);
    },
    close: () => {
      sockets.delete(id);
      native.close(id, 1000, "");
    },
  };
  sockets.set(id, socket);
  return socket;
}
