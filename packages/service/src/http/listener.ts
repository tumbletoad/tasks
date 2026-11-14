// One HTTP listener on 127.0.0.1 (A2 3.8.1): Node's `http` over a `net` server that pauses each
// connection until it is admitted, so nothing is read from a connection the service refuses.
//
// Admission, before any byte is read: the peer check (Linux: the client's socket must belong to
// this user, A2 3.8.4), then the caps (A2 3.8.1: 64 connections that have not authenticated, all
// connections). Then the bounds while it lives: its headers within 10 s of acceptance (the `idle`
// timer, then Node's headers deadline), a whole request within 30 s, 5 s of keep-alive, 16 KiB of
// headers. `::1` is never bound: `tasks open` uses the 127.0.0.1 origin only.
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { HttpApp } from "./app.ts";
import { securityHeaders } from "./csp.ts";
import type { PeerCheck } from "./holders.ts";

export const HTTP_HOST = "127.0.0.1";

export interface HttpListener {
  readonly port: number;
  /** Stops listening and closes this listener's connections. */
  close(): Promise<void>;
  /** The deadlines Node's parser applies, as configured (for tests and doctor). */
  readonly deadlines: { headersMs: number; requestMs: number; keepAliveMs: number };
}

/** Whether a listen error means "someone has this port" (A2 3.8.2 step 7: EACCES counts). */
export function isTaken(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EADDRINUSE" || code === "EACCES";
}

const PARSER_STATUS: Readonly<Record<string, number>> = {
  HPE_HEADER_OVERFLOW: 431,
  ERR_HTTP_REQUEST_TIMEOUT: 408,
};

/**
 * Listens on 127.0.0.1:`port` (0: a port the OS chooses) for `app`. Rejects with the listen error
 * when the port is taken.
 */
export async function listenHttp(
  app: HttpApp,
  port: number,
  peerCheck: PeerCheck,
): Promise<HttpListener> {
  const limits = app.options.limits;
  // Node answers nothing by itself: a missing Host is the checks' 421 (not Node's bare 400), and an
  // `Expect` header goes to the app (no `100 Continue` before the checks, no bare 417). Parser
  // errors go through `clientError` below, and ws's handshake errors through the app. So every
  // response the listener sends carries the security headers.
  const http = createHttpServer({
    maxHeaderSize: limits.maxHeaderBytes,
    requestTimeout: limits.requestMs,
    headersTimeout: limits.headersMs,
    keepAliveTimeout: limits.keepAliveMs,
    connectionsCheckingInterval: Math.min(1_000, limits.headersMs),
    requireHostHeader: false,
    joinDuplicateHeaders: false,
  });
  // The port is known once bound; every handler reads it from here.
  let bound = 0;
  const sockets = new Set<Socket>();
  const idle = new Map<Socket, { clear(): void }>();
  const settle = (socket: Socket) => {
    idle.get(socket)?.clear();
    idle.delete(socket);
  };
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    settle(req.socket);
    void app.handle(req, res, bound);
  };
  http.on("request", onRequest);
  http.on("checkContinue", onRequest);
  http.on("checkExpectation", onRequest);
  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    settle(socket as Socket);
    app.upgrade(req, socket, head, bound);
  });
  http.on("clientError", (error: NodeJS.ErrnoException, socket: Duplex) => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const status = PARSER_STATUS[error.code ?? ""] ?? 400;
    const lines = [
      `HTTP/1.1 ${String(status)} Refused`,
      ...Object.entries(securityHeaders(bound)).map(([k, v]) => `${k}: ${v}`),
      "Content-Length: 0",
      "Connection: close",
      "",
      "",
    ];
    // Ended once the answer is written; a peer that never reads it is cut off by the drain or
    // the listener's close.
    socket.end(lines.join("\r\n"), () => {
      socket.destroy();
    });
  });

  const net = createNetServer({ pauseOnConnect: true }, (socket) => {
    // The peer's own socket must be this user's (Linux) before anything is read from it.
    if (!peerCheck(socket.remotePort ?? 0, bound)) {
      app.options.log({ ev: "http.peer_refused", reason: "other_user" });
      socket.destroy();
      return;
    }
    if (!app.accept(socket)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      settle(socket);
    });
    socket.on("error", () => undefined);
    const timer = app.options.timers(
      { kind: "idle", conn: app.connOf(socket), ms: limits.headersMs },
      () => {
        if (!app.authenticated(socket)) socket.destroy();
      },
    );
    idle.set(socket, timer);
    http.emit("connection", socket);
    socket.resume();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      net.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      net.off("error", onError);
      resolve();
    };
    net.once("error", onError);
    net.once("listening", onListening);
    net.listen({ host: HTTP_HOST, port, exclusive: true });
  });
  const address = net.address();
  bound = typeof address === "object" && address !== null ? address.port : port;
  net.on("error", () => undefined);
  // Node enforces its headers and request deadlines only for a server that has emitted
  // `listening`; this one takes its connections from the net server above, so it is told here.
  http.emit("listening");

  let closing: Promise<void> | undefined;
  return {
    port: bound,
    deadlines: {
      headersMs: http.headersTimeout,
      requestMs: http.requestTimeout,
      keepAliveMs: http.keepAliveTimeout,
    },
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        net.close(() => {
          resolve();
        });
        http.close();
        for (const socket of sockets) socket.destroy();
        for (const timer of idle.values()) timer.clear();
        idle.clear();
      })),
  };
}
