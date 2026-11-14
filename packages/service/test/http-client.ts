// Node clients that send exactly what a browser sends to the UI listener, and requests a browser
// would never send (A7 3.9 M2.12: a real browser belongs to the lab and to M2.13's e2e). Tests only.
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";

export interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Sent {
  readonly method?: string;
  readonly path: string;
  /** Header names in lower case. `host: null` sends none. */
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly body?: string | Buffer;
}

/** One request on a new connection. The Host defaults to `127.0.0.1:<port>`. */
export function send(port: number, sent: Sent): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${String(port)}` };
    for (const [name, value] of Object.entries(sent.headers ?? {})) {
      if (value === null) Reflect.deleteProperty(headers, name);
      else headers[name] = value;
    }
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: sent.method ?? "GET",
        path: sent.path,
        headers,
        setHost: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (sent.body !== undefined) req.write(sent.body);
    req.end();
  });
}

/** The headers Firefox and Chromium send on the page's own `fetch` POST. */
export function pageHeaders(port: number, token?: string): Record<string, string> {
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "content-type": "application/json",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

/** A page's POST of `body` as JSON to `path`. */
export function post(
  port: number,
  path: string,
  body: unknown,
  options: { token?: string; headers?: Record<string, string | null> } = {},
): Promise<Reply> {
  return send(port, {
    method: "POST",
    path,
    headers: { ...pageHeaders(port, options.token), ...options.headers },
    body: JSON.stringify(body),
  });
}

/** The raw bytes a server answers to `text` on a new connection, until it closes or `ms` pass. */
export function raw(port: number, text: string | Buffer, ms = 30_000): Promise<string> {
  return new Promise((resolve) => {
    const socket: Socket = connect(port, "127.0.0.1", () => {
      socket.write(text);
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => socket.destroy(), ms);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("latin1"));
    });
  });
}

/** Opens a socket and resolves when it closes, with the bytes it got; for connections that send nothing. */
export function idle(port: number, ms = 30_000): { socket: Socket; closed: Promise<string> } {
  const socket = connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("error", () => undefined);
  const closed = new Promise<string>((resolve) => {
    const timer = setTimeout(() => socket.destroy(), ms);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("latin1"));
    });
  });
  return { socket, closed };
}

/** A WebSocket upgrade as a browser sends it: the status line the server answers with. */
export async function upgrade(
  port: number,
  path: string,
  headers: Readonly<Record<string, string | null>> = {},
): Promise<string> {
  return (await upgradeHead(port, path, headers)).split("\r\n")[0] ?? "";
}

/** A WebSocket upgrade as a browser sends it: the whole head the server answers with. */
export function upgradeHead(
  port: number,
  path: string,
  headers: Readonly<Record<string, string | null>> = {},
): Promise<string> {
  const all: Record<string, string | null> = {
    host: `127.0.0.1:${String(port)}`,
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    origin: `http://127.0.0.1:${String(port)}`,
    ...headers,
  };
  const lines = [`GET ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(all))
    if (value !== null) lines.push(`${name}: ${value}`);
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let text = "";
    const timer = setTimeout(() => socket.destroy(), 30_000);
    const head = () => text.split("\r\n\r\n")[0] ?? "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (text.includes("\r\n\r\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(head());
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(head());
    });
  });
}
