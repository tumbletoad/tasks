// The phone's side of the link in Node, for the tests of @ttasks/client/link against the real
// service: a phone that does what the native link does (TLS 1.3 with its own key, the computer
// trusted by its pin alone, nothing written to a computer with another key), faults injected at the
// link's socket, the app's private storage in memory, and a world of the service with the calls
// these tests make as the page would. Fixture data only.
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { WebSocket } from "ws";
import {
  pairWith,
  type Connect,
  type Keep,
  type LinkSocket,
  type SocketEvents,
} from "@ttasks/client/link";
import { parsePairing, type Pairing } from "@ttasks/contracts/link";
import { SPACE_HEADER } from "../src/http/app.ts";
import { certPin } from "../src/link/cert.ts";
import { post } from "./http-client.ts";
import { LiveCore, messageOf, type TaskRow } from "@ttasks/client/store";
import { httpWorld, openFeed, signIn, type HttpWorld } from "./http-world.ts";
import { classSession } from "./ops-helpers.ts";
import { phoneKey, type PhoneKey } from "./phone-client.ts";

export interface Phone {
  readonly connect: Connect;
  /** Every `open` the phone sent, in order. */
  readonly opens: Record<string, unknown>[];
  /** Every address the phone connected to, in order. */
  readonly dialled: string[];
  /** Sockets open now, and the most there ever were at once. */
  readonly sockets: { live: number; most: number };
}

/**
 * A phone with its own key. The first `lose` connections that get an answer lose it: the socket
 * closes before the phone reads it, as when the network drops just then. Closing a socket ends it
 * at once, also in the middle of its handshake.
 */
export function phone(key: PhoneKey = phoneKey(), lose = 0): Phone {
  const opens: Record<string, unknown>[] = [];
  const dialled: string[] = [];
  const sockets = { live: 0, most: 0 };
  let losing = lose;
  const connect: Connect = (url, pin, events) => {
    const { hostname, port } = new URL(url);
    dialled.push(`${hostname}:${port}`);
    sockets.live += 1;
    sockets.most = Math.max(sockets.most, sockets.live);
    let ws: WebSocket | undefined;
    let closed = false;
    const tls = tlsConnect({
      host: hostname,
      port: Number(port),
      key: key.key,
      cert: key.cert,
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
    });
    const end = () => {
      if (closed) return false;
      closed = true;
      sockets.live -= 1;
      ws?.terminate();
      tls.destroy();
      return true;
    };
    const socket: LinkSocket = {
      events,
      send: (text) => {
        opens.push(JSON.parse(text) as Record<string, unknown>);
        ws?.send(text);
      },
      close: () => {
        end();
      },
    };
    const ended = (code: number) => {
      if (end()) socket.events.close(code);
    };
    const lost = losing > 0;
    if (lost) losing -= 1;
    tls.once("error", () => {
      if (closed) return;
      socket.events.error("network");
      ended(1006);
    });
    tls.once("secureConnect", () => {
      const peer = tls.getPeerX509Certificate();
      if (peer === undefined || certPin(peer.raw) !== pin) {
        socket.events.error("pin");
        ended(1006);
        return;
      }
      const opened = new WebSocket(url, {
        createConnection: () => tls,
        perMessageDeflate: false,
        rejectUnauthorized: false,
      });
      ws = opened;
      opened.on("open", () => {
        if (!closed) socket.events.open();
      });
      opened.on("message", (data: Buffer) => {
        if (closed) return;
        if (lost) {
          ended(1006);
          return;
        }
        socket.events.message(data.toString("utf8"));
      });
      opened.on("error", () => undefined);
      opened.on("close", (code: number) => {
        ended(code);
      });
    });
    return socket;
  };
  return { connect, opens, dialled, sockets };
}

/**
 * Faults on the link's socket, for the next calls: an answer the computer sent that never reaches
 * the phone, with the link dropped or kept; the feed or the answers held back and let go later; an
 * answer of the test's own in place of the computer's; and the link dropped now.
 */
export interface Faults {
  /** The next N answers are lost and the link drops: the computer acted, the phone never heard. */
  dropAnswer: number;
  /** The next N answers are lost; the link stays. */
  withholdAnswer: number;
  /** The feed's messages wait until `release`. */
  holdFeed: boolean;
  /** The answers wait until `release`. */
  holdAnswers: boolean;
  /** The next answer is this one instead of the computer's. */
  answer: { readonly status: number; readonly body: unknown } | undefined;
  /** Lets every held message go, in order. */
  release(): void;
  /** Drops the link now. */
  drop(): void;
}

/** `connect` with faults injected at each socket it makes. */
export function faulty(connect: Connect): { connect: Connect; faults: Faults } {
  let live: { drop(): void; release(): void } | undefined;
  const faults: Faults = {
    dropAnswer: 0,
    withholdAnswer: 0,
    holdFeed: false,
    holdAnswers: false,
    answer: undefined,
    release: () => {
      faults.holdFeed = false;
      faults.holdAnswers = false;
      live?.release();
    },
    drop: () => {
      live?.drop();
    },
  };
  const wrapped: Connect = (url, pin, events) => {
    let ended = false;
    // The feed and the answers are two streams: each is held back on its own, and keeps its order.
    const feed: string[] = [];
    const answers: string[] = [];
    const outer: LinkSocket = {
      events,
      send: (text) => {
        inner.send(text);
      },
      close: () => {
        ended = true;
        inner.close();
      },
    };
    const end = () => {
      if (ended) return;
      ended = true;
      inner.close();
      outer.events.close(1006);
    };
    const deliver = (text: string) => {
      if (!ended) outer.events.message(text);
    };
    const own: SocketEvents = {
      open: () => {
        if (!ended) outer.events.open();
      },
      error: (kind) => {
        if (!ended) outer.events.error(kind);
      },
      close: (code) => {
        if (ended) return;
        ended = true;
        outer.events.close(code);
      },
      message: (text) => {
        if (ended) return;
        const kind = (JSON.parse(text) as { type?: string }).type;
        if (kind === "reply") {
          if (faults.answer !== undefined) {
            const { status, body } = faults.answer;
            faults.answer = undefined;
            const id = (JSON.parse(text) as { id?: unknown }).id;
            deliver(JSON.stringify({ type: "reply", id, status, body }));
            return;
          }
          if (faults.dropAnswer > 0) {
            faults.dropAnswer -= 1;
            end();
            return;
          }
          if (faults.withholdAnswer > 0) {
            faults.withholdAnswer -= 1;
            return;
          }
          if (faults.holdAnswers || answers.length > 0) answers.push(text);
          else deliver(text);
          return;
        }
        const rows = kind === "snapshot" || kind === "batch";
        if ((faults.holdFeed && rows) || feed.length > 0) feed.push(text);
        else deliver(text);
      },
    };
    const inner = connect(url, pin, own);
    live = {
      drop: end,
      release: () => {
        for (const text of [...answers.splice(0), ...feed.splice(0)]) deliver(text);
      },
    };
    return outer;
  };
  return { connect: wrapped, faults };
}
/** Waits until `holds`, asking again every 20 ms. */
export async function until(holds: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await holds())) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** The app's private storage, in memory. */
export function memory(): Keep {
  const values = new Map<string, string>();
  return {
    read: (name) => values.get(name) ?? null,
    write: (name, text) => {
      values.set(name, text);
    },
  };
}

/** A port free now, so the service comes back on the same one after a restart. */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });

/** The real service with one space, Mira, its phone listener on a port that outlives a restart. */
export async function phoneWorld(label: string) {
  const link = {
    link: {
      host: "127.0.0.1",
      ports: [await freePort()],
      addresses: () => ["127.0.0.1"],
      peerAllowed: () => true,
      refuseMs: 10,
    },
  };
  const world: HttpWorld = await httpWorld(label, link);
  let token = (await signIn(world)).token;
  const folder = join(world.root, "s", "mira");

  const machine = async (action: string, body: unknown) => {
    const reply = await post(world.port(), `/api/v1/machine/${action}`, body, { token });
    if (reply.status !== 200) throw new Error(`${action}: ${String(reply.status)} ${reply.body}`);
    return (JSON.parse(reply.body) as { result: Record<string, unknown> }).result;
  };
  /** An operation as the page calls it, in the space Mira. */
  const op = async (name: string, body: unknown) => {
    const reply = await post(world.port(), `/api/v1/op/${name}`, body, {
      token,
      headers: { [SPACE_HEADER]: "Mira" },
    });
    const parsed = JSON.parse(reply.body) as { result?: Record<string, unknown> };
    return { status: reply.status, result: parsed.result };
  };
  const user = await world.user();

  const w = {
    world,
    machine,
    op,
    /** A new pairing code for Mira. */
    code: async (): Promise<Pairing> => {
      const pairing = parsePairing(
        (await machine("phone_pair", { space: "Mira" }))["code"] as string,
      );
      if (pairing === undefined) throw new Error("the service made no pairing code");
      return pairing;
    },
    phones: async () => (await machine("phones", {}))["phones"] as { id: string; name: string }[],
    /** A task added on the computer, in Focus so Today shows it: its ref and ID. */
    added: async (title: string) => {
      const made = await op("task.add", {
        tasks: [{ title, focus: true }],
        request_id: randomUUID(),
      });
      const task = (made.result?.["tasks"] as { ref: string; id: string }[] | undefined)?.[0];
      if (made.status !== 200 || task === undefined)
        throw new Error(`task.add: ${String(made.status)}`);
      return task;
    },
    /** The task's lifecycle on the computer; undefined when it has none to give (in the Trash). */
    lifecycle: async (ref: string) =>
      ((await op("task.get", { task: ref })).result?.["task"] as { lifecycle?: string } | undefined)
        ?.lifecycle,
    /** How many tasks the computer finds for these words. */
    found: async (words: string) =>
      (await op("task.search", { q: words, scope: "active" })).result?.["total"],
    /** An operation as an agent calls it in Mira, from its terminal (Claude Code's marker). */
    asAgent: async (op: string, input: Record<string, unknown>) => {
      const agent = await classSession(world.home, world.service.endpoint.path, "cli-agent", {
        CLAUDECODE: "1",
      });
      try {
        return (await agent.call(
          "op/call",
          { op, input: { ...input, request_id: randomUUID() }, space: "Mira" },
          { timeoutMs: 60_000 },
        )) as Record<string, unknown>;
      } finally {
        agent.close();
      }
    },
    /** The space's tasks as the computer holds them now: a snapshot of the page's own feed. */
    rows: async (): Promise<ReadonlyMap<string, TaskRow>> => {
      const feed = await openFeed(world.port(), token);
      try {
        await feed.next((m) => m["type"] === "hello");
        feed.send({ type: "subscribe", space: "Mira" });
        const snapshot = messageOf(await feed.next((m) => m["type"] === "snapshot"));
        if (snapshot?.type !== "snapshot") throw new Error("the page's feed sent no snapshot");
        const core = new LiveCore();
        core.receive(snapshot);
        const held = core.publish();
        if (held === undefined) throw new Error("the snapshot held no rows");
        return held.tasks;
      } finally {
        feed.ws.close();
      }
    },
    /** The space closed on the computer, and opened again. */
    close: async () => {
      await user.call("space/close", { space: folder }, { timeoutMs: 60_000 });
    },
    open: async () => {
      await user.call("space/open", { path: folder }, { timeoutMs: 120_000 });
      await until(async () => (await op("task.search", {})).status === 200);
    },
    /** The service stopped. */
    stop: () => world.stop(),
    /** The service started again on its home and port, its space open again. */
    restart: async () => {
      await world.restart(link);
      token = (await signIn(world)).token;
      await until(async () => (await op("task.search", {})).status === 200);
    },
    /** Stops the service and removes its home. */
    end: () => world.close(),
  };
  return w;
}

/** A phone paired with Mira, under `name`: its key and the pairing it keeps. */
export async function pairedPhone(w: Awaited<ReturnType<typeof phoneWorld>>, name: string) {
  const key = phoneKey();
  const paired = await pairWith(phone(key).connect, await w.code(), name);
  if (paired.kind !== "served") throw new Error(`not paired: ${paired.kind}`);
  paired.socket.close();
  return { key, saved: paired.saved };
}
