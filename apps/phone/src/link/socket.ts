// The native link (modules/ttasks-link) as sockets: a WebSocket to the computer over TLS 1.3, which
// trusts the computer by the pin of its key and presents the phone's own key from the Keystore.
// Events of a socket that was closed here, or replaced, reach nobody.
import { requireNativeModule, type NativeModule } from "expo";
import type { Connect, Failure, LinkSocket } from "@ttasks/client/link";

type Events = {
  open(event: { id: number }): void;
  message(event: { id: number; text: string }): void;
  error(event: { id: number; kind: Failure }): void;
  close(event: { id: number; code: number }): void;
  /** The phone moved to another network. */
  network(): void;
  /** A code handed to the open scanner from inside the app (the installed-app test). */
  scan(event: { text: string }): void;
};

declare class TTasksLink extends NativeModule<Events> {
  connect(url: string, pin: string): number;
  send(id: number, text: string): void;
  close(id: number, code: number, reason: string): void;
  /** The saved pairing's JSON, or null. */
  pairing(): string | null;
  savePairing(json: string): void;
  /** Forgets the saved pairing. The phone's key stays: the computer knows it again by it. */
  clearPairing(): void;
  /** The name the person gave the phone in Android's settings, else its model. */
  deviceName(): string;
  /** A file the app keeps (`[a-z]+`), or null. */
  kept(name: string): string | null;
  keep(name: string, text: string): void;
  /** A new request ID. */
  newId(): string;
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

/** The app's private files: what the session keeps across a restart. */
export const keep = {
  read: (name: string) => native.kept(name),
  write: (name: string, text: string) => {
    native.keep(name, text);
  },
};
