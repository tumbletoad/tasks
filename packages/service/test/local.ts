// Test helpers for the service side of tasks-local/1: a server on a temporary endpoint with
// content-free event capture, and a line relay that can change one line on the way, to play a
// tampering peer between a client and the service. Tests only.
import net from "node:net";
import { testKey, type endpointRoot } from "@tasks/bridge/test/endpoint";
import { serve, type LocalEvent, type LocalServer, type ServeOptions } from "../src/local/index.ts";

export interface Started {
  readonly server: LocalServer;
  readonly key: Buffer;
  readonly path: string;
  readonly events: LocalEvent[];
  readonly instance: string;
}

export const INSTANCE = "9c4e1f07a2d35b8e6f10c2a94d7b3e51";

/** Starts a server on a new endpoint. Close it with `server.close()`. */
export async function startServer(
  root: ReturnType<typeof endpointRoot>,
  options: Partial<ServeOptions> = {},
): Promise<Started> {
  const key = testKey();
  const path = root.path("svc");
  const events: LocalEvent[] = [];
  const server = await serve({
    path,
    key,
    instance: INSTANCE,
    service: { version: "0.0.0-test", build: "test" },
    capabilities: ["op.call"],
    log: (event) => events.push(event),
    ...options,
  });
  return {
    server,
    key: Buffer.from(options.key ?? key),
    path: server.path,
    events,
    instance: options.instance ?? INSTANCE,
  };
}

/** Changes the line with index `n` (0-based) in one direction, or passes it unchanged. */
export type LineTransform = (line: string, n: number) => string;

/**
 * A relay on `path` that forwards each connection to `target`, line by line, passing the lines
 * from the client through `up` and those from the service through `down`.
 */
export async function relay(
  path: string,
  target: string,
  up: LineTransform = (line) => line,
  down: LineTransform = (line) => line,
): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const pump = (from: net.Socket, to: net.Socket, transform: LineTransform) => {
    let buffered = "";
    let n = 0;
    from.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let at = buffered.indexOf("\n");
      while (at !== -1) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        to.write(`${transform(line, n)}\n`);
        n += 1;
        at = buffered.indexOf("\n");
      }
    });
    from.on("close", () => to.destroy());
  };
  const server = net.createServer((client) => {
    const service = net.createConnection(target);
    for (const socket of [client, service]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    }
    pump(client, service, up);
    pump(service, client, down);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        for (const socket of sockets) socket.destroy();
      }),
  };
}

/** Changes one JSON line with `edit` and writes it back. */
export function editJson(line: string, edit: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(line) as Record<string, unknown>;
  edit(value);
  return JSON.stringify(value);
}
