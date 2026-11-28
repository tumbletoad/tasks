// The phone's pairing and reopening (@ttasks/client/link, which the phone app runs) against the
// real service, over a Node socket that does what the native link does: TLS 1.3 with the phone's
// own key, the computer trusted by its pin alone, and nothing written to a computer with another
// key. The native link itself is tried on an emulator (tests/phone/emulator.ts). Fixture data only.
import { parsePairing, type Pairing } from "@ttasks/contracts/link";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  linkOwner,
  openLink,
  pairWith,
  type Connect,
  type LinkSocket,
  type LinkState,
  type Saved,
} from "@ttasks/client/link";
import { post } from "./http-client.ts";
import { httpWorld, signIn, type HttpWorld } from "./http-world.ts";
import { certPin } from "../src/link/cert.ts";
import { phoneKey, type PhoneKey } from "./phone-client.ts";

const SLOW = { timeout: 120_000 };

interface Phone {
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
function phone(key: PhoneKey = phoneKey(), lose = 0): Phone {
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

/** An address that takes connections and never answers: an attempt there waits. */
async function silent() {
  const counts = { accepted: 0, dropped: 0 };
  const waits: (() => void)[] = [];
  const changed = () => {
    for (const wake of waits.splice(0)) wake();
  };
  const held: Socket[] = [];
  const server = createServer((socket) => {
    held.push(socket);
    counts.accepted += 1;
    socket.on("close", () => {
      counts.dropped += 1;
      changed();
    });
    changed();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  /** Resolves once `count` says so. */
  const until = async (holds: () => boolean) => {
    while (!holds()) {
      await new Promise<void>((resolve) => waits.push(resolve));
    }
  };
  return {
    addr: `127.0.0.1:${String(port)}`,
    counts,
    until,
    close: () => {
      for (const socket of held) socket.destroy();
      server.close();
    },
  };
}

/** Lets every callback already due run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

let world: HttpWorld;
let token = "";

const machine = async (action: string, body: unknown) => {
  const reply = await post(world.port(), `/api/v1/machine/${action}`, body, { token });
  if (reply.status !== 200) throw new Error(`${action}: ${String(reply.status)} ${reply.body}`);
  return (JSON.parse(reply.body) as { result: Record<string, unknown> }).result;
};
const phones = async () =>
  (await machine("phones", {}))["phones"] as { id: string; name: string }[];
const code = async (): Promise<Pairing> => {
  const pairing = parsePairing((await machine("phone_pair", { space: "Mira" }))["code"] as string);
  if (pairing === undefined) throw new Error("the service made no pairing code");
  return pairing;
};

/** A port free now, so the service comes back on the same one after a restart. */
const freePort = () =>
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

let link: NonNullable<Parameters<typeof httpWorld>[1]>;

beforeAll(async () => {
  link = {
    link: {
      host: "127.0.0.1",
      ports: [await freePort()],
      addresses: () => ["127.0.0.1"],
      peerAllowed: () => true,
      refuseMs: 10,
    },
  };
  world = await httpWorld("phone-pairing", link);
  ({ token } = await signIn(world));
}, 300_000);

/** An owner whose states are kept, and a wait for the next of a kind. */
function owned(connect: Connect, saved: Saved) {
  const states: LinkState[] = [];
  let wake: (() => void) | undefined;
  const owner = linkOwner(
    connect,
    saved,
    (state) => {
      states.push(state);
      wake?.();
    },
    50,
  );
  let read = 0;
  const next = async (kind: LinkState["kind"]): Promise<LinkState> => {
    for (;;) {
      while (read < states.length) {
        const state = states[read];
        read += 1;
        if (state?.kind === kind) return state;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  return { owner, states, next };
}

afterAll(async () => {
  await world.close();
});

describe(
  "[S5.phone.pairing] the app pairs with a code once, reopens without it, and only `removed` ends it",
  SLOW,
  () => {
    test("a code pairs the phone, by its name, and the pairing reopens without the code", async () => {
      const p = phone();
      const qr = await code();
      const paired = await pairWith(p.connect, qr, "Pixel");
      expect(paired.kind).toBe("served");
      if (paired.kind !== "served") return;
      paired.socket.close();
      expect(paired.saved).toEqual({ addrs: qr.addrs, pin: qr.pin, space: qr.space });
      expect(p.opens).toEqual([
        {
          type: "open",
          protocol: 1,
          space: qr.space.id,
          pair: { code: qr.code, name: "Pixel", platform: "android" },
        },
      ]);
      expect((await phones()).filter((x) => x.name === "Pixel")).toHaveLength(1);

      const again = await openLink(p.connect, paired.saved).done;
      expect(again.kind).toBe("served");
      if (again.kind === "served") again.socket.close();
      expect(p.opens.at(-1)).toEqual({ type: "open", protocol: 1, space: qr.space.id });
    });

    test("an answer lost after the computer saved the phone: one more open, without the code, and one phone", async () => {
      const p = phone(phoneKey(), 1);
      const qr = await code();
      const paired = await pairWith(p.connect, qr, "Lost");
      expect(paired.kind).toBe("served");
      if (paired.kind === "served") paired.socket.close();
      expect(p.opens.map((o) => "pair" in o)).toEqual([true, false]);
      expect((await phones()).filter((x) => x.name === "Lost")).toHaveLength(1);
    });

    test("another key at the computer's address: the phone sends nothing, and the code still pairs", async () => {
      const p = phone();
      const qr = await code();
      const other = { ...qr, pin: `${qr.pin.startsWith("A") ? "B" : "A"}${qr.pin.slice(1)}` };
      expect(await pairWith(p.connect, other, "Wrong")).toEqual({ kind: "offline", pin: true });
      expect(p.opens).toEqual([]);
      const paired = await pairWith(p.connect, qr, "Wrong");
      expect(paired.kind).toBe("served");
      if (paired.kind === "served") paired.socket.close();
    });

    test("a phone removed on the computer is told so when it opens the link again", async () => {
      const p = phone();
      const paired = await pairWith(p.connect, await code(), "Removed");
      if (paired.kind !== "served") throw new Error(`not paired: ${paired.kind}`);
      paired.socket.close();
      const id = (await phones()).find((x) => x.name === "Removed")?.id;
      await machine("phone_remove", { phone: id });
      const saved: Saved = paired.saved;
      expect(await openLink(p.connect, saved).done).toEqual({ kind: "removed" });
    });

    test("the owner stops for good when the computer says the phone was removed", async () => {
      const p = phone();
      const paired = await pairWith(p.connect, await code(), "Gone");
      if (paired.kind !== "served") throw new Error(`not paired: ${paired.kind}`);
      paired.socket.close();
      const { owner, next, states } = owned(p.connect, paired.saved);
      owner.start();
      await next("connected");
      const id = (await phones()).find((x) => x.name === "Gone")?.id;
      await machine("phone_remove", { phone: id });
      await next("removed");
      owner.now();
      expect(states.at(-1)?.kind).toBe("removed");
    });
    test("a stop while an attempt waits ends it and tries no other address", async () => {
      const key = phoneKey();
      const paired = await pairWith(phone(key).connect, await code(), "Stopped");
      if (paired.kind !== "served") throw new Error(`not paired: ${paired.kind}`);
      paired.socket.close();
      const quiet = await silent();
      const p = phone(key);
      const { owner } = owned(p.connect, {
        ...paired.saved,
        addrs: [quiet.addr, ...paired.saved.addrs],
      });
      owner.start();
      await quiet.until(() => quiet.counts.accepted === 1);
      owner.stop();
      await quiet.until(() => quiet.counts.dropped === 1);
      await settle();
      await settle();
      expect(p.dialled).toEqual([quiet.addr]);
      expect(p.sockets.live).toBe(0);
      quiet.close();
    });

    test("a new attempt calls off the one under way: never two sockets at once", async () => {
      const key = phoneKey();
      const paired = await pairWith(phone(key).connect, await code(), "Replaced");
      if (paired.kind !== "served") throw new Error(`not paired: ${paired.kind}`);
      paired.socket.close();
      const quiet = await silent();
      const p = phone(key);
      const { owner } = owned(p.connect, {
        ...paired.saved,
        addrs: [quiet.addr, ...paired.saved.addrs],
      });
      owner.start();
      await quiet.until(() => quiet.counts.accepted === 1);
      // Another network while it still waits.
      owner.now();
      await quiet.until(() => quiet.counts.accepted === 2);
      owner.stop();
      await quiet.until(() => quiet.counts.dropped === 2);
      await settle();
      await settle();
      expect(p.dialled).toEqual([quiet.addr, quiet.addr]);
      expect(p.sockets.most).toBe(1);
      expect(p.sockets.live).toBe(0);
      quiet.close();
    });

    // Last: it restarts the service, after which the space opens again in its own time.
    test("the owner keeps the pairing while the computer is away and connects again when it is back", async () => {
      const p = phone();
      const paired = await pairWith(p.connect, await code(), "Owned");
      if (paired.kind !== "served") throw new Error(`not paired: ${paired.kind}`);
      paired.socket.close();
      const { owner, next } = owned(p.connect, paired.saved);
      owner.start();
      await next("connected");
      await world.restart(link.link === undefined ? {} : { link: link.link });
      ({ token } = await signIn(world));
      await next("offline");
      await next("connected");
      owner.stop();
      expect(p.opens.every((o) => !("pair" in o) || o === p.opens[0])).toBe(true);
    });
  },
);
