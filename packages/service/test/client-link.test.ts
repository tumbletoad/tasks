// The phone's pairing and reopening (@ttasks/client/link, which the phone app runs) against the
// real service, over a Node socket that does what the native link does: TLS 1.3 with the phone's
// own key, the computer trusted by its pin alone, and nothing written to a computer with another
// key. The native link itself is tried on an emulator (tests/phone/emulator.ts). Fixture data only.
import { parsePairing, type Pairing } from "@ttasks/contracts/link";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import {
  linkOwner,
  spaceSession,
  type Keep,
  type SpaceView,
  openLink,
  pairWith,
  type Connect,
  type LinkState,
  type Saved,
} from "@ttasks/client/link";
import { post } from "./http-client.ts";
import { httpWorld, signIn, type HttpWorld } from "./http-world.ts";
import { SPACE_HEADER } from "../src/http/app.ts";
import { phoneKey } from "./phone-client.ts";
import { freePort, memory, phone, until } from "./phone-link.ts";

const SLOW = { timeout: 120_000 };

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
/** An operation as the page calls it, in the space Mira. */
const op = async (name: string, body: unknown) => {
  const reply = await post(world.port(), `/api/v1/op/${name}`, body, {
    token,
    headers: { [SPACE_HEADER]: "Mira" },
  });
  const parsed = JSON.parse(reply.body) as { result?: Record<string, unknown> };
  return { status: reply.status, result: parsed.result };
};
/** A task added on the computer, in Focus so Today shows it. */
const added = async (title: string): Promise<string> => {
  const made = await op("task.add", { tasks: [{ title, focus: true }], request_id: randomUUID() });
  const ref = (made.result?.["tasks"] as { ref: string }[] | undefined)?.[0]?.ref;
  if (made.status !== 200 || ref === undefined) throw new Error(`task.add: ${String(made.status)}`);
  return ref;
};
const lifecycle = async (ref: string) =>
  ((await op("task.get", { task: ref })).result?.["task"] as { lifecycle?: string } | undefined)
    ?.lifecycle;
/** After a restart: the computer has its space open again. */
const reopened = async () => {
  ({ token } = await signIn(world));
  await until(async () => (await op("task.search", {})).status === 200);
};
/** A session whose last view is kept. */
function session(connect: Connect, saved: Saved, keep: Keep) {
  const seen: { view?: SpaceView } = {};
  const live = spaceSession({
    connect,
    saved,
    keep,
    newId: randomUUID,
    report: (view) => {
      seen.view = view;
    },
    retryMs: 50,
    resendMs: 50,
  });
  const titles = () => [...(seen.view?.tasks.values() ?? [])].map((task) => task.title);
  const titled = (title: string) => {
    const task = [...(seen.view?.tasks.values() ?? [])].find((t) => t.title === title);
    if (task === undefined) throw new Error(`no task ${title}`);
    return task;
  };
  return { live, seen, titles, titled };
}

/** A phone paired under `name`, with its key. */
async function pairedPhone(name: string) {
  const key = phoneKey();
  const paired = await pairWith(phone(key).connect, await code(), name);
  if (paired.kind !== "served") throw new Error(`not paired: ${paired.kind}`);
  paired.socket.close();
  return { key, saved: paired.saved };
}

const code = async (): Promise<Pairing> => {
  const pairing = parsePairing((await machine("phone_pair", { space: "Mira" }))["code"] as string);
  if (pairing === undefined) throw new Error("the service made no pairing code");
  return pairing;
};

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
    { retryMs: 50 },
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

    test("the session holds the space's tasks and shows a new one as the computer adds it", async () => {
      const { key, saved } = await pairedPhone("Live");
      await added("Water the plants");
      const { live, seen, titles } = session(phone(key).connect, saved, memory());
      live.start();
      await until(() => titles().includes("Water the plants"));
      expect(seen.view?.live).toBe(true);
      await added("Call the vet");
      await until(() => titles().includes("Call the vet"));
      live.stop();
    });

    test("a check-off leaves at once and reaches the computer; a capture lands once", async () => {
      const { key, saved } = await pairedPhone("Writes");
      const ref = await added("Post the letter");
      const { live, seen, titles, titled } = session(phone(key).connect, saved, memory());
      live.start();
      await until(() => titles().includes("Post the letter"));
      live.finish(titled("Post the letter"));
      expect(titles()).not.toContain("Post the letter");
      await until(async () => (await lifecycle(ref)) !== "active");
      const request = live.add({ title: "Buy milk", inbox: true }, "Buy milk");
      await until(() => seen.view?.added?.request === request);
      const found = await op("task.search", { q: '"Buy milk"' });
      expect(found.result?.["total"]).toBe(1);
      expect(seen.view?.waiting).toEqual([]);
      live.stop();
    });

    test("Undo after the check-off reached the computer reopens the task there", async () => {
      const { key, saved } = await pairedPhone("Undo");
      const ref = await added("Fold the laundry");
      const { live, titles, titled } = session(phone(key).connect, saved, memory());
      live.start();
      await until(() => titles().includes("Fold the laundry"));
      const request = live.finish(titled("Fold the laundry"));
      await until(async () => (await lifecycle(ref)) !== "active");
      live.undo(request);
      await until(async () => (await lifecycle(ref)) === "active");
      await until(() => titles().includes("Fold the laundry"));
      live.stop();
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
      await reopened();
      await next("offline");
      await next("connected");
      owner.stop();
      expect(p.opens.every((o) => !("pair" in o) || o === p.opens[0])).toBe(true);
    });

    test("a check-off made while the computer is away outlasts a restart of the app and arrives", async () => {
      const { key, saved } = await pairedPhone("Away");
      const ref = await added("Return the books");
      const keep = memory();
      const first = session(phone(key).connect, saved, keep);
      first.live.start();
      await until(() => first.titles().includes("Return the books"));
      await world.stop();
      await until(() => first.seen.view?.link.kind === "offline");
      const request = first.live.finish(first.titled("Return the books"));
      first.live.stop();

      // The app starts again, still without the computer: the last rows, how old, the check-off.
      const again = session(phone(key).connect, saved, keep);
      again.live.start();
      expect(again.seen.view?.loaded).toBe(true);
      expect(again.seen.view?.live).toBe(false);
      expect(again.seen.view?.asOf).toBeTypeOf("number");
      expect(again.seen.view?.waiting.map((w) => w.request)).toEqual([request]);
      expect(again.titles()).not.toContain("Return the books");

      await world.restart(link.link === undefined ? {} : { link: link.link });
      await reopened();
      await until(() => again.seen.view?.waiting.length === 0);
      expect(again.seen.view?.refused).toEqual([]);
      await until(async () => (await op("task.get", { task: ref })).status === 200);
      expect(await lifecycle(ref)).not.toBe("active");
      again.live.stop();
    });
  },
);
