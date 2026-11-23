// Test helpers for the UI listener with a real service in this process: one space, a page that
// signs in the way a browser does, and a feed client that sends what a browser's WebSocket sends.
// Ports are the OS's choice or ports the test holds; machine.toml is written only when a test
// persists a port itself. Tests only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { RpcSession } from "@ttasks/bridge/protocol";
import type { HttpStart } from "../src/http/index.ts";
import { startService, type RunningService, type StartOptions } from "../src/hub/service.ts";
import type { LaunchOptions } from "../src/launch/index.ts";
import { post } from "./http-client.ts";
import { configOf, removeRuntimeDir, serviceEnv, tempRoot } from "./harness.ts";
import { classSession } from "./ops-helpers.ts";

export interface HttpWorld {
  /** The running service (a new one after `restart`). */
  readonly service: RunningService;
  readonly home: string;
  readonly root: string;
  /** The listener's port now. */
  port(): number;
  /** A session of the person at a terminal (`cli-interactive`). */
  user(): Promise<RpcSession>;
  /** Stops the service and starts it again on the same home with `http`. */
  restart(http?: HttpStart): Promise<RunningService>;
  /** Stops the service, keeping the home. */
  stop(): Promise<void>;
  /** Stops it and removes the home. */
  close(): Promise<void>;
}

function start(
  home: string,
  http: HttpStart,
  launch?: LaunchOptions,
  monitor?: StartOptions["monitor"],
  runs?: StartOptions["runs"],
): Promise<RunningService> {
  return startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
    http: { ports: [0], persist: false, ...http },
    ...(launch === undefined ? {} : { launch }),
    ...(monitor === undefined ? {} : { monitor }),
    ...(runs === undefined ? {} : { runs }),
  });
}

/**
 * A service with its UI listener on an OS-chosen port and, unless `space` is false, one space.
 * `toml` is machine.toml's text before the first start (instances); `launch` the service's
 * launching seams (a test's terminal); `runs` its background runs' (a test's containers).
 */
export async function httpWorld(
  label: string,
  http: HttpStart = {},
  options: {
    space?: boolean;
    toml?: string;
    launch?: LaunchOptions;
    monitor?: StartOptions["monitor"];
    runs?: StartOptions["runs"];
  } = {},
): Promise<HttpWorld> {
  const temp = tempRoot(label);
  const home = join(temp.root, "h");
  if (options.toml !== undefined) {
    mkdirSync(configOf(home), { recursive: true, mode: 0o700 });
    writeFileSync(join(configOf(home), "machine.toml"), options.toml, { mode: 0o600 });
  }
  let service: RunningService | undefined = await start(
    home,
    http,
    options.launch,
    options.monitor,
    options.runs,
  );
  const sessions: RpcSession[] = [];
  const current = (): RunningService => {
    if (service === undefined) throw new Error("the service is stopped");
    return service;
  };
  const stop = async () => {
    for (const s of sessions.splice(0)) s.close();
    if (service !== undefined) {
      await service.stop();
      removeRuntimeDir(service);
      service = undefined;
    }
  };
  const world: HttpWorld = {
    get service() {
      return current();
    },
    home,
    root: temp.root,
    port: () => current().status().http?.port ?? 0,
    user: async () => {
      const session = await classSession(home, current().endpoint.path, "cli-interactive");
      sessions.push(session);
      return session;
    },
    restart: async (again = {}) => {
      await stop();
      service = await start(home, again, options.launch, options.monitor, options.runs);
      return service;
    },
    stop,
    close: async () => {
      await stop();
      temp.cleanup();
    },
  };
  if (options.space !== false) {
    const user = await world.user();
    await user.call(
      "space/create",
      { name: "Mira", path: join(temp.root, "s", "mira"), ref_prefix: "M" },
      { timeoutMs: 120_000 },
    );
  }
  return world;
}

/**
 * Persists `[http] port` in the home's machine.toml, as a first start would have: the folder 0700
 * and the file 0600, as the product makes them (A2 3.2.2 rule 5: a folder or file the group can
 * write, as a umask of 002 would leave them, is refused).
 */
export function persistPort(home: string, port: number): void {
  mkdirSync(configOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(join(configOf(home), "machine.toml"), `[http]\nport = ${String(port)}\n`, {
    mode: 0o600,
  });
}

/** Signs a page in: a code from `ui/mint_code` over the socket, redeemed over HTTP. */
export async function signIn(
  world: Pick<HttpWorld, "user">,
): Promise<{ token: string; session: string }> {
  const user = await world.user();
  const minted = (await user.call("ui/mint_code", {}, { timeoutMs: 20_000 })) as {
    code: string;
    port: number;
  };
  const reply = await post(minted.port, "/api/v1/auth/redeem", { code: minted.code });
  if (reply.status !== 200) throw new Error(`redeem answered ${String(reply.status)}`);
  const body = JSON.parse(reply.body) as { token: string; session_id: string };
  return { token: body.token, session: body.session_id };
}

/** A page's feed: messages in order, and a wait for the next that matches. */
export interface FeedClient {
  readonly ws: WebSocket;
  readonly messages: Record<string, unknown>[];
  next(
    match?: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ): Promise<Record<string, unknown>>;
  send(message: unknown): void;
  /** Resolves with the close code. */
  readonly closed: Promise<number>;
}

/** Opens the feed as the page does: a ticket over HTTP, then the WebSocket with its Origin. */
export async function openFeed(port: number, token: string): Promise<FeedClient> {
  const ticket = await post(port, "/api/v1/ws-ticket", {}, { token });
  if (ticket.status !== 200) throw new Error(`ws-ticket answered ${String(ticket.status)}`);
  const { ticket: t } = JSON.parse(ticket.body) as { ticket: string };
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/v1/ws?ticket=${t}`, {
    origin: `http://127.0.0.1:${String(port)}`,
    headers: { "sec-fetch-site": "same-origin" },
    perMessageDeflate: false,
  });
  const messages: Record<string, unknown>[] = [];
  let read = 0;
  let wake: (() => void) | undefined;
  ws.on("message", (data: Buffer) => {
    messages.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    wake?.();
  });
  const closed = new Promise<number>((resolve) => {
    ws.on("close", (code: number) => {
      resolve(code);
      wake?.();
    });
  });
  ws.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      resolve();
    });
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`upgrade answered ${String(res.statusCode)}`));
    });
    ws.once("error", reject);
  });
  return {
    ws,
    messages,
    closed,
    send: (message) => {
      ws.send(typeof message === "string" ? message : JSON.stringify(message));
    },
    next: async (match = () => true, ms = 30_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        while (read < messages.length) {
          const message = messages[read];
          read += 1;
          if (message !== undefined && match(message)) return message;
        }
        if (ws.readyState === WebSocket.CLOSED) throw new Error("the feed closed");
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
    },
  };
}
