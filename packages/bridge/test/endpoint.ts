// Test helpers for `ttasks-local/1`: endpoint names in a temporary folder or a unique pipe name,
// raw connections that record every byte, and a listener whose behaviour each test scripts.
// Tests only: nothing outside tests imports this file.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientInfo, ClientKind } from "../src/protocol/index.ts";

/**
 * A place for endpoints: a short temporary folder on Unix (socket paths hold about 100 bytes),
 * nothing on Windows, where pipe names are unique instead. Call `remove` when done.
 */
export function endpointRoot(): { path(name: string): string; remove(): void } {
  const dir = process.platform === "win32" ? undefined : mkdtempSync(join(tmpdir(), "kl-"));
  const tag = `${String(process.pid)}-${randomBytes(4).toString("hex")}`;
  let count = 0;
  return {
    path(name: string): string {
      count += 1;
      const unique = `${name}${String(count)}`;
      return dir === undefined
        ? `\\\\.\\pipe\\ttasks-test-${tag}-${unique}`
        : join(dir, `${unique}.sock`);
    },
    remove(): void {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function testKey(): Buffer {
  return randomBytes(32);
}

export function clientInfo(kind: ClientKind = "cli", tty = false): ClientInfo {
  return {
    kind,
    version: "0.0.0-test",
    build: "test",
    pid: process.pid,
    package: null,
    tty: { stdin: tty, stdout: tty },
  };
}

/** A listener with a scripted behaviour per connection. */
export async function listen(
  path: string,
  onConnection: (socket: net.Socket) => void,
): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
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

/** Every byte a socket receives until it closes. */
export function collect(socket: net.Socket): Promise<Buffer> {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve) => {
    socket.once("close", () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

/** The first `count` lines a socket receives, as soon as they are complete. */
export function firstLines(socket: net.Socket, count: number): Promise<string[]> {
  let text = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const lines = text.split("\n");
      if (lines.length > count) {
        socket.off("data", onData);
        resolve(lines.slice(0, count));
      }
    };
    socket.on("data", onData);
    socket.once("close", () => {
      reject(new Error(`closed after ${String(text.split("\n").length - 1)} lines`));
    });
  });
}

/** A raw connection that records every byte it receives until it closes. */
export async function rawConnect(
  path: string,
): Promise<{ socket: net.Socket; received: Promise<Buffer>; closedAt: Promise<number> }> {
  const socket = net.createConnection(path);
  socket.on("error", () => undefined);
  const received = collect(socket);
  const closedAt = new Promise<number>((resolve) => {
    socket.once("close", () => {
      resolve(performance.now());
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return { socket, received, closedAt };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` holds, polling every 10 ms, or fails after `ms`. */
export async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}
