// The phone's link against a real service in this process: Settings > Phones makes a code, a phone
// built from Node's TLS pairs with it, and everything it may and may not do is tried. The phone
// listens on loopback here; on a computer it listens on the private network. Fixture data only.
import { connect } from "node:tls";
import { registry } from "@ttasks/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { LINK_PATH, PAIRING_MS } from "../src/link/service.ts";
import { post } from "./http-client.ts";
import { httpWorld, signIn, type HttpWorld } from "./http-world.ts";
import {
  openLink,
  phoneKey,
  readPairing,
  tlsTo,
  type Pairing,
  type PhoneKey,
} from "./phone-client.ts";

const SLOW = { timeout: 300_000 };

const worlds: HttpWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

interface Page {
  readonly world: HttpWorld;
  readonly token: string;
  /** Moves the service's clock on. */
  advance(ms: number): void;
  machine(
    action: string,
    body: unknown,
  ): Promise<{ status: number; result: Record<string, unknown> }>;
  /** A new code for the space Mira. */
  code(): Promise<{ pairing: Pairing; ticket: string }>;
}

async function page(label: string): Promise<Page> {
  let offset = 0;
  const world = await httpWorld(label, {
    now: () => Date.now() + offset,
    link: {
      host: "127.0.0.1",
      ports: [0],
      addresses: () => ["127.0.0.1"],
      peerAllowed: () => true,
      refuseMs: 10,
    },
  });
  worlds.push(world);
  const { token } = await signIn(world);
  const machine = async (action: string, body: unknown) => {
    const reply = await post(world.port(), `/api/v1/machine/${action}`, body, { token });
    const parsed = JSON.parse(reply.body) as Record<string, unknown> & {
      result?: Record<string, unknown>;
    };
    return { status: reply.status, result: parsed.result ?? parsed };
  };
  return {
    world,
    token,
    advance: (ms) => {
      offset += ms;
    },
    machine,
    code: async () => {
      const made = await machine("phone_pair", { space: "Mira" });
      expect(made.status).toBe(200);
      return {
        pairing: readPairing(made.result["code"] as string),
        ticket: made.result["ticket"] as string,
      };
    },
  };
}

const addrOf = (pairing: Pairing): string => pairing.addrs[0] ?? "";

async function paired(p: Page, key: PhoneKey = phoneKey()) {
  const { pairing, ticket } = await p.code();
  const opened = await openLink(addrOf(pairing), pairing.pin, key, {
    space: pairing.space.id,
    pair: { code: pairing.code, name: "Test phone", platform: "android" },
  });
  if (opened.kind !== "served") throw new Error(`pairing was ${opened.kind}`);
  return { key, pairing, ticket, link: opened.link, hello: opened.hello };
}

const searchCount = async (
  link: { call: (p: string, b: unknown) => Promise<{ body: Record<string, unknown> }> },
  q: string,
) => {
  const found = await link.call("/api/v1/op/task.search", { q: `"${q}"` });
  const result = found.body["result"] as { tasks?: unknown[]; rows?: unknown[] } | undefined;
  return (result?.tasks ?? result?.rows ?? []).length;
};

describe("[S5.link.pairing] a phone pairs with a code from Settings > Phones, once", () => {
  test(
    "the code pairs one phone, is spent, and Settings lists the phone with Run off",
    SLOW,
    async () => {
      const p = await page("link-pair");
      const { pairing, ticket, hello, key } = await paired(p);
      expect(pairing.space.name).toBe("Mira");
      expect(hello["link"]).toMatchObject({
        space: { id: pairing.space.id, name: "Mira" },
        run: false,
      });
      const view = await p.machine("phones", { ticket });
      expect(view.result["pairing"]).toMatchObject({ state: "paired" });
      expect(view.result["phones"]).toEqual([
        expect.objectContaining({
          name: "Test phone",
          platform: "android",
          space_name: "Mira",
          run: false,
        }),
      ]);
      // The same code a second time, by another phone: refused, with no answer.
      const again = await openLink(addrOf(pairing), pairing.pin, phoneKey(), {
        space: pairing.space.id,
        pair: { code: pairing.code },
      });
      expect(again.kind).toBe("refused");
      // The paired phone comes back without a code.
      const back = await openLink(addrOf(pairing), pairing.pin, key, { space: pairing.space.id });
      expect(back.kind).toBe("served");
    },
  );

  test("a code ends when its dialog closes, and after five minutes", SLOW, async () => {
    const p = await page("link-code-end");
    const first = await p.code();
    await p.machine("phone_pair", { end: first.ticket });
    expect((await p.machine("phones", { ticket: first.ticket })).result["pairing"]).toEqual({
      state: "ended",
    });
    const closed = await openLink(addrOf(first.pairing), first.pairing.pin, phoneKey(), {
      space: first.pairing.space.id,
      pair: { code: first.pairing.code },
    }).catch(() => ({ kind: "refused" as const }));
    expect(closed.kind).toBe("refused");
    const second = await p.code();
    p.advance(PAIRING_MS + 1000);
    const late = await openLink(addrOf(second.pairing), second.pairing.pin, phoneKey(), {
      space: second.pairing.space.id,
      pair: { code: second.pairing.code },
    });
    expect(late.kind).toBe("refused");
  });
});

describe("[S5.link.pin] the phone checks the computer's key before it sends anything", () => {
  test(
    "the scanned pin is accepted; another key at the address is refused before a byte",
    SLOW,
    async () => {
      const p = await page("link-pin");
      const { pairing } = await p.code();
      const right = await tlsTo(addrOf(pairing), pairing.pin, phoneKey());
      expect(right.pinned).toBe(true);
      right.socket.destroy();
      // The phone holds a pin of another computer: it closes the connection and writes nothing.
      const other = phoneKey().pin;
      const opened = await openLink(addrOf(pairing), other, phoneKey(), {
        space: pairing.space.id,
        pair: { code: pairing.code },
      });
      expect(opened.kind).toBe("pin_rejected");
      // The code was never sent, so it still pairs the right phone.
      const later = await openLink(addrOf(pairing), pairing.pin, phoneKey(), {
        space: pairing.space.id,
        pair: { code: pairing.code },
      });
      expect(later.kind).toBe("served");
    },
  );
});

describe("[S5.link.unpaired] a peer that is not paired learns nothing", () => {
  test(
    "no client certificate, another path, plain HTTP, or no grant: closed with no answer",
    SLOW,
    async () => {
      const p = await page("link-unpaired");
      const { pairing } = await p.code();
      const [host = "", port = "0"] = addrOf(pairing).split(":");
      const exchange = (key: PhoneKey | undefined, request: string) =>
        new Promise<string>((resolve) => {
          const socket = connect({
            host,
            port: Number(port),
            rejectUnauthorized: false,
            minVersion: "TLSv1.3",
            ...(key === undefined ? {} : { key: key.key, cert: key.cert }),
          });
          let got = "";
          socket.on("data", (d: Buffer) => {
            got += d.toString("latin1");
          });
          socket.on("secureConnect", () => {
            socket.write(request);
          });
          socket.on("error", () => undefined);
          socket.on("close", () => {
            resolve(got);
          });
        });
      const upgrade = (path: string) =>
        `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
      expect(await exchange(undefined, upgrade(LINK_PATH))).toBe("");
      expect(await exchange(phoneKey(), upgrade("/api/v1/op/task.get"))).toBe("");
      expect(await exchange(phoneKey(), "GET / HTTP/1.1\r\nHost: x\r\n\r\n")).toBe("");
      // A certificate and the right path, but no grant and no code: the open gets no message.
      const stranger = await openLink(addrOf(pairing), pairing.pin, phoneKey(), {
        space: pairing.space.id,
      });
      expect(stranger.kind).toBe("refused");
    },
  );
});

describe("[S5.link.rights] what a paired phone may call, in its own space only", () => {
  test(
    "every registry entry by its remote class, runs watched, Run refused until switched on",
    SLOW,
    async () => {
      const p = await page("link-rights");
      const { link, hello } = await paired(p);
      for (const entry of registry) {
        const answer = await link.call(`/api/v1/op/${entry.name}`, {});
        const rule = (answer.body["error"] as { data?: { rule?: string } } | undefined)?.data?.rule;
        if (entry.remote === "never" || entry.remote === "execute") {
          expect({ entry: entry.name, rule }).toEqual({ entry: entry.name, rule: "phone_rights" });
        } else {
          expect({ entry: entry.name, rule }).not.toEqual({
            entry: entry.name,
            rule: "phone_rights",
          });
        }
      }
      for (const path of [
        "/api/v1/machine/apps",
        "/api/v1/space/list",
        "/api/v1/launch/folder",
        "/api/v1/auth/redeem",
      ]) {
        expect((await link.call(path, {})).status).toBe(404);
      }
      const runs = await link.call("/api/v1/launch/runs", { task: "nothing" });
      expect((runs.body["error"] as { data?: { rule?: string } } | undefined)?.data?.rule).not.toBe(
        "phone_rights",
      );
      const phone = (hello["link"] as { phone: string }).phone;
      for (const path of ["/api/v1/launch/run", "/api/v1/launch/stop"]) {
        const refused = await link.call(path, {});
        expect(refused.status).toBe(403);
        expect(refused.body["error"]).toMatchObject({ data: { rule: "phone_run" } });
      }
      expect((await p.machine("phone_rights", { phone, run: true })).result).toEqual({ run: true });
      const allowed = await link.call("/api/v1/launch/run", {});
      expect(
        (allowed.body["error"] as { data?: { rule?: string } } | undefined)?.data?.rule,
      ).not.toBe("phone_run");
      await p.machine("phone_rights", { phone, run: false });
      expect((await link.call("/api/v1/launch/stop", {})).body["error"]).toMatchObject({
        data: { rule: "phone_run" },
      });
    },
  );

  test("another space: no open, no subscription", SLOW, async () => {
    const p = await page("link-space");
    const { pairing, key, link } = await paired(p);
    const elsewhere = await openLink(addrOf(pairing), pairing.pin, key, {
      space: "sp_0000000000000000000000000",
    });
    expect(elsewhere.kind).toBe("refused");
    link.send({ type: "subscribe", space: "Other" });
    expect(await link.next((m) => m["type"] === "error")).toMatchObject({ code: "forbidden" });
  });
});

describe("[S5.link.snapshot] a phone's feed carries the space's data and nothing of the computer", () => {
  test("no folder, restore record, agent apps, places or last-used agents", SLOW, async () => {
    const p = await page("link-snapshot");
    const { link } = await paired(p);
    await link.call("/api/v1/op/task.add", {
      tasks: [{ title: "Fixture task for the phone" }],
      request_id: "fixture-request-snapshot-01",
    });
    link.send({ type: "subscribe" });
    const snapshot = await link.next((m) => m["type"] === "snapshot");
    expect(Object.keys(snapshot).sort()).toEqual([
      "agent_changes",
      "areas",
      "asking",
      "cursor",
      "preferences",
      "projects",
      "space",
      "tasks",
      "type",
    ]);
    expect(Object.keys(snapshot["space"] as object).sort()).toEqual(
      expect.arrayContaining(["id", "name", "ref_prefix"]),
    );
    for (const key of Object.keys(snapshot["space"] as object)) {
      expect(["id", "name", "ref_prefix", "copy", "read_only"]).toContain(key);
    }
    const tasks = snapshot["tasks"] as Record<string, unknown>[];
    expect(tasks.some((t) => t["title"] === "Fixture task for the phone")).toBe(true);
    for (const task of tasks) {
      expect(task).not.toHaveProperty("place");
      expect(task).not.toHaveProperty("last");
    }
    await link.call("/api/v1/op/task.add", {
      tasks: [{ title: "Fixture task after the snapshot" }],
      request_id: "fixture-request-snapshot-02",
    });
    const batch = await link.next(
      (m) => m["type"] === "batch" && (m["events"] as unknown[]).length > 0,
    );
    const text = JSON.stringify(batch);
    expect(text).toContain("Fixture task after the snapshot");
    expect(text).not.toContain('"place"');
    expect(text).not.toContain('"last"');
  });
});

describe("[S5.link.capture-once] a capture sent again after a lost answer makes one task", () => {
  test("answer lost, app restarted, phone removed and paired again: one task", SLOW, async () => {
    const p = await page("link-capture");
    const key = phoneKey();
    const first = await paired(p, key);
    const capture = {
      tasks: [{ title: "Fixture capture from the phone" }],
      request_id: "fixture-request-capture-01",
    };
    // The computer saves and answers; the phone loses the answer with its connection.
    first.link.send({ type: "call", id: "lost", path: "/api/v1/op/task.add", body: capture });
    await first.link.next((m) => m["type"] === "reply" && m["id"] === "lost");
    first.link.ws.terminate();
    // The app starts again and sends the capture with the same request ID.
    const restarted = await openLink(addrOf(first.pairing), first.pairing.pin, key, {
      space: first.pairing.space.id,
    });
    if (restarted.kind !== "served") throw new Error(restarted.kind);
    const again = await restarted.link.call("/api/v1/op/task.add", capture);
    expect(again.status).toBe(200);
    expect(again.body["result"]).toMatchObject({ replayed: true });
    // Removed and paired again with a new code: the same phone, the same receipt.
    const phone = (first.hello["link"] as { phone: string }).phone;
    await p.machine("phone_remove", { phone });
    const second = await paired(p, key);
    const third = await second.link.call("/api/v1/op/task.add", capture);
    expect(third.body["result"]).toMatchObject({ replayed: true });
    expect(await searchCount(second.link, "Fixture capture from the phone")).toBe(1);
  });
});

describe("[S5.link.remove] Remove ends a phone's access at once, and tells it so later", () => {
  test("the open connection closes; the next open is told removed", SLOW, async () => {
    const p = await page("link-remove");
    const { link, key, pairing, hello } = await paired(p);
    const phone = (hello["link"] as { phone: string }).phone;
    expect((await p.machine("phone_remove", { phone })).result).toEqual({ removed: true });
    expect(await link.closed).toBe(4401);
    expect((await p.machine("phones", {})).result["phones"]).toEqual([]);
    const next = await openLink(addrOf(pairing), pairing.pin, key, { space: pairing.space.id });
    expect(next.kind).toBe("removed");
  });
});
