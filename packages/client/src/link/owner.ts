// The one owner of the phone's link: it opens the link, keeps it, and opens it again. While the app
// is in front it tries again every `retryMs` after a failure or a lost connection, and at once when
// asked (Try now, the app coming back to the front, another network). In the background it holds
// no connection. Only the computer's `removed` stops it for good; the pairing stays otherwise.
import { openLink, type Connect, type Hello, type LinkSocket, type Saved } from "./open.ts";

export type LinkState =
  | { readonly kind: "connecting" }
  | { readonly kind: "connected"; readonly hello: Hello }
  /** `pin`: an address answered with another key. */
  | { readonly kind: "offline"; readonly pin: boolean }
  | { readonly kind: "removed" };

export interface LinkOwner {
  /** The app is in front: open the link now. */
  start(): void;
  /** The app went to the background: close the link and stop trying. */
  stop(): void;
  /** Open the link again now, replacing the one there is. Nothing while stopped. */
  now(): void;
}

/**
 * `report` hears every change of state; with `connected` it also gets the pairing to keep, which
 * names the address that served first and the space as the computer names it now.
 */
export function linkOwner(
  connect: Connect,
  saved: Saved,
  report: (state: LinkState, saved: Saved) => void,
  retryMs = 10_000,
): LinkOwner {
  let pairing = saved;
  let running = false;
  let generation = 0;
  let socket: LinkSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const drop = () => {
    clearTimeout(timer);
    timer = undefined;
    socket?.close();
    socket = undefined;
  };
  const later = (run: number) => {
    timer = setTimeout(() => {
      if (run === generation) void open();
    }, retryMs);
  };
  const open = async () => {
    generation += 1;
    const run = generation;
    drop();
    report({ kind: "connecting" }, pairing);
    const opened = await openLink(connect, pairing);
    if (run !== generation || !running) {
      if (opened.kind === "served") opened.socket.close();
      return;
    }
    if (opened.kind === "removed") {
      running = false;
      report(opened, pairing);
      return;
    }
    if (opened.kind === "offline") {
      report(opened, pairing);
      later(run);
      return;
    }
    pairing = opened.saved;
    socket = opened.socket;
    socket.events = {
      open: () => undefined,
      message: () => undefined,
      error: () => undefined,
      close: () => {
        if (run !== generation) return;
        socket = undefined;
        report({ kind: "offline", pin: false }, pairing);
        later(run);
      },
    };
    report({ kind: "connected", hello: opened.hello }, pairing);
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      void open();
    },
    stop: () => {
      running = false;
      generation += 1;
      drop();
    },
    now: () => {
      if (running) void open();
    },
  };
}
