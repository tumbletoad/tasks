// The phone's link against a real service in this process: Settings > Phones makes a code, a phone
// built from Node's TLS pairs with it, and everything it may and may not do is tried. The phone
// listens on loopback here; on a computer it listens on the private network. Fixture data only.
import { mkdirSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { connect } from "node:tls";
import { registry } from "@ttasks/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { SPACE_HEADER } from "../src/http/app.ts";
import { PHONE_CALLS } from "../src/link/allowed.ts";
import { LINK_PATH, PAIRING_MS } from "../src/link/service.ts";
import { post } from "./http-client.ts";
import { httpWorld, signIn, type HttpWorld } from "./http-world.ts";
import {
  openLink,
  phoneKey,
  readPairing,
  tlsTo,
  type Pairing,
  type PhoneLink,
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

/** How many open tasks of this title the phone's own snapshot holds. */
const countInFeed = async (link: PhoneLink, title: string) => {
  link.send({ type: "subscribe" });
  const snapshot = await link.next((m) => m["type"] === "snapshot");
  return (snapshot["tasks"] as Record<string, unknown>[]).filter((t) => t["title"] === title)
    .length;
};

const ruleOf = (body: Record<string, unknown>) =>
  (body["error"] as { data?: { rule?: string; field?: string } } | undefined)?.data;

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

describe("[S5.link.unpaired] a peer that is not paired sees the port and the certificate, and nothing of a space", () => {
  test(
    "plain HTTP, no client certificate, another path or HTTP inside TLS is closed; an unknown key or a wrong code gets no reply",
    SLOW,
    async () => {
      const p = await page("link-unpaired");
      const { pairing } = await p.code();
      const [host = "", port = "0"] = addrOf(pairing).split(":");
      // Plain HTTP, no TLS at all: the listener answers nothing.
      const plain = await new Promise<string>((resolve) => {
        const socket = netConnect({ host, port: Number(port) }, () => {
          socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
        });
        let got = "";
        socket.on("data", (d: Buffer) => {
          got += d.toString("latin1");
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
          resolve(got);
        });
      });
      expect(plain).toBe("");
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
      // HTTP inside TLS, with a certificate, that is no upgrade: closed with no answer.
      expect(await exchange(phoneKey(), "GET / HTTP/1.1\r\nHost: x\r\n\r\n")).toBe("");
      // A certificate and the right path, but an unknown key and no code: the open gets no reply.
      const stranger = await openLink(addrOf(pairing), pairing.pin, phoneKey(), {
        space: pairing.space.id,
      });
      expect(stranger.kind).toBe("refused");
      // A wrong code: no reply either, and the right code still pairs.
      const wrong = await openLink(addrOf(pairing), pairing.pin, phoneKey(), {
        space: pairing.space.id,
        pair: { code: "A".repeat(43) },
      });
      expect(wrong.kind).toBe("refused");
      const right = await openLink(addrOf(pairing), pairing.pin, phoneKey(), {
        space: pairing.space.id,
        pair: { code: pairing.code },
      });
      expect(right.kind).toBe("served");
    },
  );
});

describe("[S5.link.rights] a paired phone calls only what its screens use, in its own space only", () => {
  test(
    "only the listed entries pass, whatever their remote class; runs watched; Run refused until switched on",
    SLOW,
    async () => {
      const p = await page("link-rights");
      const { link, hello } = await paired(p);
      for (const entry of registry) {
        const path = `/api/v1/op/${entry.name}`;
        const rule = ruleOf((await link.call(path, {})).body)?.rule;
        const listed = PHONE_CALLS[path] !== undefined;
        expect({ entry: entry.name, refused: rule === "phone_rights" }).toEqual({
          entry: entry.name,
          refused: !listed,
        });
      }
      expect(Object.keys(PHONE_CALLS).sort()).toEqual([
        "/api/v1/launch/run",
        "/api/v1/launch/runs",
        "/api/v1/launch/stop",
        "/api/v1/op/page.read",
        "/api/v1/op/task.add",
        "/api/v1/op/task.finish",
        "/api/v1/op/task.get",
        "/api/v1/op/task.reopen",
      ]);
      for (const path of [
        "/api/v1/machine/apps",
        "/api/v1/space/list",
        "/api/v1/launch/folder",
        "/api/v1/auth/redeem",
      ]) {
        expect(ruleOf((await link.call(path, {})).body)?.rule).toBe("phone_rights");
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

describe("[S5.link.fields] a phone's calls send and show only a task's own fields", () => {
  test(
    "a task with a folder shows no path; a folder, an update and the space's status are refused",
    SLOW,
    async () => {
      const p = await page("link-fields");
      const { link } = await paired(p);
      const added = await link.call("/api/v1/op/task.add", {
        tasks: [{ title: "Fixture task with a folder" }],
        request_id: "fixture-request-fields-01",
      });
      const ref = (added.body["result"] as { tasks: { ref: string }[] }).tasks[0]?.ref ?? "";
      const folder = join(p.world.root, "fixture-folder");
      mkdirSync(folder, { recursive: true });
      const user = await p.world.user();
      await user.call(
        "op/call",
        {
          op: "folder.manage",
          input: { action: "set", task: ref, folder, request_id: "fixture-request-fields-02" },
        },
        { timeoutMs: 60_000 },
      );
      // The page on this computer sees the folder: the phone's answer leaves it out.
      const desktop = await post(
        p.world.port(),
        "/api/v1/op/task.get",
        { task: ref },
        { token: p.token, headers: { [SPACE_HEADER]: "Mira" } },
      );
      expect(desktop.body).toContain("fixture-folder");
      const read = await link.call("/api/v1/op/task.get", { task: ref });
      expect(read.status).toBe(200);
      const text = JSON.stringify(read.body);
      expect(text).toContain("Fixture task with a folder");
      expect(text).not.toContain("fixture-folder");
      expect(text).not.toContain('"folder"');
      expect(text).not.toContain("skills");
      // What a phone may not send: a folder on a capture, a launch's reference on a read.
      expect(
        ruleOf(
          (
            await link.call("/api/v1/op/task.add", {
              tasks: [{ title: "Fixture", folder }],
              request_id: "fixture-request-fields-03",
            })
          ).body,
        ),
      ).toEqual({ rule: "phone_field", field: "tasks[].folder" });
      expect(
        ruleOf((await link.call("/api/v1/op/task.get", { task: ref, launch: "LABCDE" })).body),
      ).toEqual({ rule: "phone_field", field: "launch" });
      for (const path of [
        "/api/v1/op/task.update",
        "/api/v1/op/folder.manage",
        "/api/v1/op/space.status",
      ]) {
        expect(ruleOf((await link.call(path, { task: ref })).body)?.rule).toBe("phone_rights");
      }
    },
  );
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

describe("[S5.link.capture-once] a capture sent again with its request ID replays its reply and makes one task", () => {
  test(
    "reply dropped and sent again on a new connection, then after removal and a new pairing of the same key: replayed, one task",
    SLOW,
    async () => {
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
      // A new connection of the same phone sends the capture with the same request ID.
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
      expect(await countInFeed(second.link, "Fixture capture from the phone")).toBe(1);
    },
  );
});

describe("[S5.link.remove] Remove ends a phone's access at once; the listener closes with the last phone", () => {
  test(
    "the open connection closes, the listener with it; once a pairing opens it, the removed phone is told",
    SLOW,
    async () => {
      const p = await page("link-remove");
      const { link, key, hello } = await paired(p);
      const linkService = () => p.world.service.http?.link;
      expect(linkService()?.port).toBeDefined();
      const phone = (hello["link"] as { phone: string }).phone;
      expect((await p.machine("phone_remove", { phone })).result).toEqual({ removed: true });
      expect(await link.closed).toBe(4401);
      expect((await p.machine("phones", {})).result["phones"]).toEqual([]);
      await expect.poll(() => linkService()?.port).toBeUndefined();
      // A new code opens the listener again, and the removed phone that comes back is told.
      const { pairing } = await p.code();
      const next = await openLink(addrOf(pairing), pairing.pin, key, { space: pairing.space.id });
      expect(next.kind).toBe("removed");
    },
  );
});
