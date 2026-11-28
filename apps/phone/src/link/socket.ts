// The native link (modules/ttasks-link) as sockets: a WebSocket to the computer over TLS 1.3, which
// trusts the computer by the pin of its key and presents the phone's own key from the Keystore.
// Events of a socket that was closed here, or replaced, reach nobody.
import { requireNativeModule, type NativeModule } from "expo";
import type { Connect, Failure, LinkSocket } from "./open.ts";

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
  /** Forgets the saved pairing. The phone's key stays: the computer knows it again by it. */
  clearPairing(): void;
}

export const native = requireNativeModule<TTasksLink>("TTasksLink");

const sockets = new Map<number, LinkSocket>();

native.addListener("open", ({ id }) => sockets.get(id)?.events.open());
native.addListener("message", ({ id, text }) => sockets.get(id)?.events.message(text));
native.addListener("error", ({ id, kind }) => sockets.get(id)?.events.error(kind));
native.addListener("close", ({ id, code }) => {
  const socket = sockets.get(id);
  sockets.delete(id);
  socket?.events.close(code);
});

export const connectSocket: Connect = (url, pin, events) => {
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
};
