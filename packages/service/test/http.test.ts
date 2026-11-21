// The UI listener inside the real service (A2 3.3.1 "endpoint + HTTP bound" before ready, 3.8.2,
// 3.8.4; A7 3.9 M2.12): service.json and status report it, a foreign port holder leaves no UI,
// every UI token revoked and the socket working, a busy persisted port moves for the run and back,
// and the change feed over WebSocket with snapshot, batches, coverage and the cursor (A1 3.7).
// Foreign holders are injected identities: no account is ever made. Ports are the OS's choice or
// ports the test holds itself; the listener's own timers are virtual (clock.ts).
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { blockedMessage, ServiceDb, type HttpTimerKind } from "../src/http/index.ts";
import { readBatch, readHead } from "../src/http/feed.ts";
import { DEFAULT_HTTP_LIMITS } from "../src/http/limits.ts";
import { FeedHub } from "../src/http/ws.ts";
import { testClock } from "./clock.ts";
import { post, send } from "./http-client.ts";
import { httpWorld, openFeed, persistPort, signIn, type HttpWorld } from "./http-world.ts";
import { configOf, readLog, readServiceJson, stateOf } from "./harness.ts";
import { classSession, errorOf } from "./ops-helpers.ts";

const SLOW = { timeout: 180_000 };
const worlds: HttpWorld[] = [];
const held: Server[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const s of held.splice(0)) await new Promise((resolve) => s.close(resolve));
});

async function world(...args: Parameters<typeof httpWorld>): Promise<HttpWorld> {
  const w = await httpWorld(...args);
  worlds.push(w);
  return w;
}

/** Holds a port on 127.0.0.1 the way this user's own process would. */
async function holdPort(): Promise<{ port: number; release(): Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  held.push(server);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    release: () =>
      new Promise((resolve) => {
        held.splice(held.indexOf(server), 1);
        server.close(() => {
          resolve();
        });
      }),
  };
}

const taskAdd = (titles: string[], id: string) => ({
  tasks: titles.map((title) => ({ title })),
  request_id: id,
});

describe("[A2.3.8.http.hub] the listener in the service", () => {
  test(
    "bound before ready; service.json and service/status report it; the drain closes it; the grants are in service.sqlite",
    SLOW,
    async () => {
      const w = await world("hb");
      expect(readServiceJson(w.home)?.["http"]).toEqual({
        host: "127.0.0.1",
        port: w.port(),
        persisted: w.port(),
        moved: false,
        blocked: null,
      });
      expect((await send(w.port(), { path: "/healthz" })).body).toBe("ok");
      const user = await w.user();
      const status = (await user.call("service/status", {})) as { http: { port: number } };
      expect(status.http.port).toBe(w.port());
      const minted = (await user.call("ui/mint_code", {})) as { code: string; port: number };
      expect(minted.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(minted.port).toBe(w.port());
      const { token } = await signIn(w);
      const port = w.port();
      await w.stop();
      await expect(send(port, { path: "/healthz" })).rejects.toThrow();
      const db = await ServiceDb.open(stateOf(w.home));
      try {
        const rows = await db.grants();
        expect(rows.map((r) => r.kind)).toEqual(["ui"]);
        expect(JSON.stringify(rows)).not.toContain(token);
      } finally {
        await db.close();
      }
    },
  );

  test(
    "a listener that cannot be bound at all leaves the service running without a UI",
    SLOW,
    async () => {
      // A port no socket can take: the bind fails with an error that is not "taken".
      const w = await world("hn", { ports: [-1] }, { space: false });
      expect(w.service.status().http).toEqual({
        host: "127.0.0.1",
        port: null,
        persisted: null,
        moved: false,
        blocked: null,
      });
      const user = await w.user();
      const refused = await user.call("ui/mint_code", {}).then(
        () => undefined,
        (e: unknown) => errorOf(e),
      );
      expect(refused).toMatchObject({
        code: "service_unavailable",
        data: { reason: "ui_unavailable" },
      });
      expect(await user.call("service/status", {})).toHaveProperty("state", "ready");
    },
  );

  test(
    "an agent's CLI cannot mint a code or move the port; the script class mints but cannot move it",
    SLOW,
    async () => {
      const w = await world("hc", {}, { space: false });
      const agent = await classSession(w.home, w.service.endpoint.path, "cli-agent", {
        CLAUDECODE: "1",
      });
      const script = await classSession(w.home, w.service.endpoint.path, "cli-script");
      try {
        const refused = await agent.call("ui/mint_code", {}).then(
          () => undefined,
          (e: unknown) => errorOf(e),
        );
        expect(refused?.code).toBe("forbidden");
        expect(await script.call("ui/mint_code", {})).toHaveProperty("code");
        const moved = await script.call("service/port", { port: 7800 }).then(
          () => undefined,
          (e: unknown) => errorOf(e),
        );
        expect(moved?.code).toBe("forbidden");
      } finally {
        agent.close();
        script.close();
      }
    },
  );

  test(
    "another user holds the persisted port: no UI, every UI token revoked, the socket still working",
    SLOW,
    async () => {
      const w = await world("hf");
      const { token } = await signIn(w);
      const port = w.port();
      persistPort(w.home, port);
      // The next start finds another user on the port: an injected identity.
      const service = await w.restart({ holders: (p) => (p === port ? [{ owner: "1002" }] : []) });
      expect(readServiceJson(w.home)?.["http"]).toEqual({
        host: "127.0.0.1",
        port,
        persisted: port,
        moved: false,
        blocked: "foreign_port_holder",
      });
      // No UI anywhere: nothing of this service listens on the port, and no fallback was bound.
      await expect(send(port, { path: "/healthz" })).rejects.toThrow();
      expect(service.http?.app.options.grants.findByToken(token)).toBeUndefined();
      // The socket keeps serving the CLI and agents: a space opened through it takes operations.
      const user = await w.user();
      await user.call("space/open", { path: join(w.root, "s", "mira") }, { timeoutMs: 120_000 });
      expect(await user.call("op/call", { op: "space.status", input: {} })).toHaveProperty("as_of");
      // ttasks open is refused with A2's message.
      const refused = await user.call("ui/mint_code", {}).then(
        () => undefined,
        (e: unknown) => errorOf(e),
      );
      expect(refused).toMatchObject({
        code: "service_unavailable",
        data: { reason: "ui_blocked" },
      });
      expect(refused?.message).toBe(blockedMessage(port));
      expect(refused?.message).toContain(
        `holds or recently held TTasks's UI port ${String(port)}.`,
      );
      // Choosing the blocked port again needs --reuse.
      const again = await user.call("service/port", { port }).then(
        () => undefined,
        (e: unknown) => errorOf(e),
      );
      expect(again?.code).toBe("invalid_input");
      // The sighting is recorded with the other user's ID; the next start stays blocked though the
      // port is free now, and the revocation held across the restart.
      await w.stop();
      const db = await ServiceDb.open(stateOf(w.home));
      try {
        expect((await db.observations(port)).map((o) => o.owner)).toEqual(["1002"]);
        const rows = await db.grants();
        expect(rows.filter((r) => r.kind === "ui" && r.revoked_at === null)).toEqual([]);
      } finally {
        await db.close();
      }
      const later = await w.restart({ holders: () => [] });
      expect(later.status().http?.blocked).toBe("foreign_port_holder");
      // `ttasks service port <n>` resolves it: a new port, the sightings cleared, a restart (75).
      const free = await holdPort();
      await free.release();
      const resolver = await w.user();
      expect(await resolver.call("service/port", { port: free.port })).toMatchObject({
        port: free.port,
        restart: true,
      });
      expect(await later.exited).toBe(75);
      expect(readFileSync(join(configOf(w.home), "machine.toml"), "utf8")).toContain(
        `port = ${String(free.port)}`,
      );
      await w.stop();
      const after = await ServiceDb.open(stateOf(w.home));
      try {
        expect(await after.observations()).toEqual([]);
      } finally {
        await after.close();
      }
    },
  );

  test(
    "this user's own process holds the persisted port: a fallback for the run, then back once free",
    SLOW,
    async () => {
      const holder = await holdPort();
      const clock = testClock<HttpTimerKind>({ virtual: ["port_retry"] });
      const w = await world("hm", {}, { space: false });
      persistPort(w.home, holder.port);
      const service = await w.restart({ timers: clock.timers, holders: () => [] });
      const moved = service.status().http;
      expect(moved).toMatchObject({ persisted: holder.port, moved: true, blocked: null });
      const fallback = moved?.port ?? 0;
      expect(fallback).not.toBe(holder.port);
      expect((await send(fallback, { path: "/healthz" })).body).toBe("ok");
      // The persisted port is tried every 60 s: still busy, kept.
      const retry = () => clock.live({ kind: "port_retry" })[0];
      expect(retry()?.ms).toBe(60_000);
      const first = retry();
      if (first !== undefined) clock.fire(first);
      await expect.poll(() => retry() !== undefined, { timeout: 30_000 }).toBe(true);
      expect(service.status().http?.moved).toBe(true);
      // Freed: the next try binds the persisted port and leaves the fallback.
      await holder.release();
      const second = retry();
      if (second !== undefined) clock.fire(second);
      await expect.poll(() => service.status().http?.moved, { timeout: 30_000 }).toBe(false);
      expect(service.status().http?.port).toBe(holder.port);
      expect(readServiceJson(w.home)?.["http"]).toMatchObject({ port: holder.port, moved: false });
      expect((await send(holder.port, { path: "/healthz" })).body).toBe("ok");
      await expect(send(fallback, { path: "/healthz" })).rejects.toThrow();
    },
  );
});

describe("[A2.3.8.http.feed] the change feed over WebSocket", () => {
  test(
    "hello, a snapshot of the open set with its cursor, then batches with coverage and the cursor",
    SLOW,
    async () => {
      const clock = testClock<HttpTimerKind>({ virtual: ["feed_poll", "ws_ping"] });
      const w = await world("fa", { timers: clock.timers });
      const { token } = await signIn(w);
      const port = w.port();
      const added = await post(
        port,
        "/api/v1/op/task.add",
        taskAdd(["First", "Second"], "feed-request-0001"),
        { token },
      );
      expect(added.status).toBe(200);
      const feed = await openFeed(port, token);
      expect(await feed.next()).toEqual({
        type: "hello",
        protocol: 1,
        version: "0.0.0",
        build: "source",
      });
      feed.send({ type: "subscribe" });
      const snapshot = await feed.next((m) => m["type"] === "snapshot");
      const cursor = snapshot["cursor"] as { epoch: number; incarnation: string; seq: number };
      expect(cursor.epoch).toBe(1);
      expect(cursor.incarnation).toMatch(/^ai_/);
      expect((snapshot["space"] as { name: string }).name).toBe("Mira");
      const tasks = snapshot["tasks"] as Record<string, unknown>[];
      expect(tasks.map((t) => t["ref"])).toEqual(["M-1", "M-2"]);
      expect(tasks[0]).not.toHaveProperty("context");
      // A write through the page's own route: its batch arrives at once and covers exactly it.
      const third = await post(
        port,
        "/api/v1/op/task.add",
        taskAdd(["Third"], "feed-request-0002"),
        { token },
      );
      expect(third.status).toBe(200);
      const batch = await feed.next((m) => m["type"] === "batch");
      expect(batch).toMatchObject({
        space_id: (snapshot["space"] as { id: string }).id,
        epoch: 1,
        incarnation: cursor.incarnation,
        from: cursor.seq,
      });
      const through = batch["through"] as number;
      expect(through).toBeGreaterThan(cursor.seq);
      const events = batch["events"] as {
        seq: number;
        request_id: string;
        actor: { kind: string };
        entities: Record<string, unknown>[];
      }[];
      expect(events.map((e) => e.seq)).toEqual(
        Array.from({ length: through - cursor.seq }, (_, i) => cursor.seq + i + 1),
      );
      const event = events.at(-1);
      expect(event?.request_id).toBe("feed-request-0002");
      expect(event?.actor.kind).toBe("human");
      expect(event?.entities.find((e) => e["type"] === "task")).toMatchObject({
        created: true,
        row: { ref: "M-3", title: "Third" },
      });
      // A write through the socket (the CLI): the poll finds it.
      const user = await w.user();
      await user.call("op/call", {
        op: "task.add",
        input: taskAdd(["Fourth"], "feed-request-0003"),
      });
      for (const timer of clock.live({ kind: "feed_poll" })) clock.fire(timer);
      const next = await feed.next((m) => m["type"] === "batch");
      expect(next["from"]).toBe(through);
      expect((next["events"] as { request_id: string }[]).map((e) => e.request_id)).toEqual([
        "feed-request-0003",
      ]);
      // The ping is the heartbeat too: an empty batch that covers nothing new.
      const ping = clock.live({ kind: "ws_ping" })[0];
      expect(ping?.ms).toBe(DEFAULT_HTTP_LIMITS.wsPingMs);
      if (ping !== undefined) clock.fire(ping);
      expect(await feed.next((m) => m["type"] === "batch")).toEqual({
        type: "batch",
        space_id: (snapshot["space"] as { id: string }).id,
        epoch: 1,
        incarnation: cursor.incarnation,
        from: next["through"],
        through: next["through"],
        events: [],
      });
      feed.ws.close();
      // The service log holds the requests and the feed by route and class, never a token or a title.
      const log = JSON.stringify(readLog(w.home));
      expect(log).toContain("http.request");
      for (const secret of [token, "First", "Third", "Fourth", "feed-request-0002"]) {
        expect(log).not.toContain(secret);
      }
    },
  );

  test(
    "a subscriber resumes from its cursor; another incarnation or a cursor ahead gets a fresh snapshot",
    SLOW,
    async () => {
      const w = await world("fr");
      const { token } = await signIn(w);
      const port = w.port();
      const first = await openFeed(port, token);
      first.send({ type: "subscribe" });
      const snapshot = await first.next((m) => m["type"] === "snapshot");
      const cursor = snapshot["cursor"] as { epoch: number; incarnation: string; seq: number };
      const space = (snapshot["space"] as { id: string }).id;
      first.ws.close();
      await post(port, "/api/v1/op/task.add", taskAdd(["While away"], "feed-request-0101"), {
        token,
      });
      const again = await openFeed(port, token);
      again.send({ type: "subscribe", space, cursor });
      // The first message of the subscription, after the connection's hello and settings.
      const resumed = await again.next((m) => m["type"] !== "hello" && m["type"] !== "machine");
      expect(resumed).toMatchObject({ type: "batch", from: cursor.seq });
      expect((resumed["events"] as { request_id: string }[]).map((e) => e.request_id)).toContain(
        "feed-request-0101",
      );
      again.send({
        type: "subscribe",
        space: "Mira",
        cursor: { ...cursor, incarnation: "ai_other" },
      });
      expect(await again.next((m) => m["type"] === "snapshot")).toMatchObject({ reason: "epoch" });
      again.send({ type: "subscribe", space, cursor: { ...cursor, seq: cursor.seq + 1000 } });
      expect(await again.next((m) => m["type"] === "snapshot")).toMatchObject({
        reason: "cursor_ahead",
      });
      again.send({ type: "subscribe", space: "Nobody" });
      expect(await again.next((m) => m["type"] === "error")).toEqual({
        type: "error",
        code: "space_unavailable",
      });
      again.ws.close();
    },
  );

  test(
    "a filtered feed: hidden commits give empty batches that still advance coverage",
    SLOW,
    async () => {
      const clock = testClock<HttpTimerKind>({ virtual: ["feed_poll", "ws_ping"] });
      // A simulated later filter: commits made through the CLI are hidden from this subscriber.
      const w = await world("fv", { timers: clock.timers, visible: (c) => c.origin !== "cli" });
      const { token } = await signIn(w);
      const feed = await openFeed(w.port(), token);
      feed.send({ type: "subscribe" });
      const snapshot = await feed.next((m) => m["type"] === "snapshot");
      const from = (snapshot["cursor"] as { seq: number }).seq;
      const user = await w.user();
      await user.call("op/call", {
        op: "task.add",
        input: taskAdd(["Hidden"], "feed-request-0201"),
      });
      for (const timer of clock.live({ kind: "feed_poll" })) clock.fire(timer);
      const batch = await feed.next((m) => m["type"] === "batch");
      expect(batch).toMatchObject({ from, events: [] });
      expect(batch["through"]).toBeGreaterThan(from);
      feed.ws.close();
    },
  );

  test(
    "a batch carries no row state past its through, and no row a hidden commit in it touched",
    SLOW,
    async () => {
      const w = await world("fw", {}, {});
      const user = await w.user();
      const reader = w.service.ops.spaces().find((s) => s.reader !== undefined)?.reader;
      if (reader === undefined) throw new Error("no space is served");
      const start = (await readHead(reader)).cursor.seq;
      await user.call("op/call", {
        op: "task.add",
        input: taskAdd(["Early"], "feed-request-0301"),
      });
      const got = (await user.call("op/call", { op: "task.get", input: { task: "M-1" } })) as {
        as_of: unknown;
      };
      await user.call("op/call", {
        op: "task.update",
        input: {
          task: "M-1",
          set: { title: "Later" },
          base: got.as_of,
          request_id: "feed-request-0302",
        },
      });
      // A log entry: it changes the task's own row too (its `touched`), through the entry's task.
      await user.call("op/call", {
        op: "entry.add",
        input: { task: "M-1", kind: "evidence", text: "Seen.", request_id: "feed-request-0303" },
      });
      const head = (await readHead(reader)).cursor.seq;
      expect(head).toBe(start + 3);
      const taskRow = (batch: { events: readonly { entities: readonly unknown[] }[] }) =>
        batch.events
          .flatMap((e) => e.entities as { type: string; row: unknown }[])
          .filter((e) => e.type === "task")
          .map((e) => e.row);
      // A batch of the first commit only: the task's row is not the later one (it is withheld).
      const first = await readBatch(reader, start, { limit: 1 });
      expect(first.batch).toMatchObject({ from: start, through: start + 1 });
      const added = first.batch.events[0]?.entities.find((e) => e.type === "task");
      expect(added).toMatchObject({ created: true, row: null });
      expect(JSON.stringify(first.batch)).not.toContain("Later");
      // Up to the update: the entry after it changed the task's row, so the row is withheld.
      const two = await readBatch(reader, start, { limit: 2 });
      expect(two.batch).toMatchObject({ from: start, through: start + 2 });
      expect(taskRow(two.batch)).toEqual([null, null]);
      // The update hidden from this subscriber: covered, carried by no event and by no row.
      const hidden = await readBatch(reader, start, { visible: (c) => c.seq !== start + 2 });
      expect(hidden.batch).toMatchObject({ from: start, through: head });
      expect(hidden.batch.events.map((e) => e.seq)).toEqual([start + 1, start + 3]);
      expect(JSON.stringify(hidden.batch)).not.toContain("Later");
      // The entry hidden: the task row it changed is not carried by the visible events either.
      const quiet = await readBatch(reader, start, { visible: (c) => c.seq !== head });
      expect(quiet.batch.events.map((e) => e.seq)).toEqual([start + 1, start + 2]);
      expect(taskRow(quiet.batch)).toEqual([null, null]);
      // Unfiltered, up to the head: every row as of the head.
      const all = await readBatch(reader, start);
      expect(all.batch.through).toBe(head);
      for (const row of taskRow(all.batch)) {
        expect(row).toMatchObject({ ref: "M-1", title: "Later", touched: head });
      }
    },
  );

  test(
    "a revoked token closes its feed with 4401; a malformed or oversized message closes it",
    SLOW,
    async () => {
      const w = await world("fx", {}, { space: false });
      const { token, session } = await signIn(w);
      const feed = await openFeed(w.port(), token);
      await feed.next();
      w.service.http?.app.options.grants.revoke(session);
      expect(await feed.closed).toBe(4401);
      const { token: other } = await signIn(w);
      const bad = await openFeed(w.port(), other);
      bad.send("{ not json");
      expect(await bad.closed).toBe(1008);
      const big = await openFeed(w.port(), other);
      big.send({ type: "subscribe", pad: "x".repeat(DEFAULT_HTTP_LIMITS.maxWsMessageBytes) });
      expect(await big.closed).toBe(1009);
    },
  );
});

describe("[A2.3.8.http.feed] a peer that reads nothing or answers nothing", () => {
  /** A frame's header bytes for a payload of `n` bytes (RFC 6455, server to client). */
  const header = (n: number) => (n < 126 ? 2 : n < 65_536 ? 4 : 10);

  /**
   * A WebSocket that takes output but never reports it written, and never pongs: what it is sent
   * stays in its buffer (`bufferedAmount`, frame headers included, as `ws` counts it) until the
   * test drains some. Its handlers are kept, so a test can deliver a message or a close.
   */
  function stalledSocket() {
    const state = { terminated: false, pings: 0, sent: 0, closed: undefined as number | undefined };
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const ws = {
      bufferedAmount: 0,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      },
      send: (text: string) => {
        state.sent += 1;
        const n = Buffer.byteLength(text);
        ws.bufferedAmount += header(n) + n;
      },
      ping: () => {
        state.pings += 1;
        ws.bufferedAmount += header(0);
      },
      // Like `ws`, its own "close" event comes later, after the closing handshake.
      close: (code: number) => {
        state.closed = code;
      },
      terminate: () => {
        state.terminated = true;
      },
    };
    return {
      ws,
      state,
      /** The peer sends a text message. */
      message: (value: unknown) => {
        handlers.get("message")?.(Buffer.from(JSON.stringify(value)), false);
      },
      /** The peer answers a ping. */
      pong: () => {
        handlers.get("pong")?.();
      },
      /** The peer goes away. */
      drop: () => {
        handlers.get("close")?.();
      },
    };
  }

  const options = (
    limits = DEFAULT_HTTP_LIMITS,
    extra: { live?: (grant: string) => boolean; spaces?: () => never[] } = {},
  ) => {
    const clock = testClock<HttpTimerKind>({ virtual: "all" });
    const logged: unknown[] = [];
    return {
      clock,
      logged,
      hub: new FeedHub({
        host: { spaces: extra.spaces ?? (() => []) },
        limits,
        timers: clock.timers,
        log: (event) => logged.push(event),
        build: { version: "0.0.0", build: "source" },
        now: () => 0,
        live: extra.live ?? (() => true),
      }),
    };
  };

  test("many subscribes while one is read start one more read at most, for the last of them", async () => {
    const head = {
      space_id: "sp_00000000000000000000000000",
      name: "Mira",
      ref_prefix: "M",
      authority_epoch: 1,
      authority_incarnation: "ai_x",
      last_seq: 5,
    };
    const waiting: ((value: unknown[]) => void)[] = [];
    let reads = 0;
    const reader = {
      get: () => Promise.resolve(head),
      transaction: (_mode: string, statements: unknown[]) => {
        // The one-statement look at the space's schema (whether it has folders) answers at once.
        if (statements.length === 1) return Promise.resolve([{ n: 1 }]);
        reads += 1;
        return new Promise<unknown[]>((resolve) => {
          // A snapshot's reads, or a batch's: nothing in either.
          waiting.push(() => {
            resolve([head, ...statements.slice(1).map(() => [])]);
          });
        });
      },
    };
    const space = { id: head.space_id, name: "Mira", reader };
    const { hub } = options(DEFAULT_HTTP_LIMITS, { spaces: () => [space] as never[] });
    const sent: Record<string, unknown>[] = [];
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const ws = {
      bufferedAmount: 0,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      },
      send: (text: string, done: (error?: Error) => void) => {
        sent.push(JSON.parse(text) as Record<string, unknown>);
        queueMicrotask(() => {
          done();
        });
      },
      ping: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
    };
    hub.attach(ws as never, "gr_x", 1);
    const settle = async () => {
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    // A page in a loop: a thousand subscribes while the first snapshot is read.
    for (let i = 0; i < 1000; i += 1) {
      handlers.get("message")?.(Buffer.from(JSON.stringify({ type: "subscribe" })), false);
    }
    await settle();
    expect(reads).toBe(1);
    // The first read ends: its subscription was replaced, so it sends nothing; the last starts.
    waiting.shift()?.([]);
    await settle();
    expect(reads).toBe(2);
    expect(sent.filter((m) => m["type"] === "snapshot")).toHaveLength(0);
    waiting.shift()?.([]);
    await settle();
    expect(sent.filter((m) => m["type"] === "snapshot")).toHaveLength(1);
    for (const resolve of waiting.splice(0)) resolve([]);
    handlers.get("close")?.();
  });

  test("every snapshot names the instances, also the one an authority change sends mid-subscription", async () => {
    const head = {
      space_id: "sp_00000000000000000000000000",
      name: "Mira",
      ref_prefix: "M",
      authority_epoch: 1,
      authority_incarnation: "ai_x",
      last_seq: 5,
    };
    const reader = {
      get: () => Promise.resolve({ ...head }),
      transaction: (_mode: string, statements: unknown[]) =>
        Promise.resolve([{ ...head }, ...statements.slice(1).map(() => [])]),
    };
    const space = { id: head.space_id, name: "Mira", reader };
    const instance = { key: "fake", label: "Fake", glyph: "Fk", ring: 1, route: "terminal" };
    const hub = new FeedHub({
      host: { spaces: () => [space] as never[] },
      limits: DEFAULT_HTTP_LIMITS,
      timers: testClock<HttpTimerKind>({ virtual: "all" }).timers,
      log: () => undefined,
      build: { version: "0.0.0", build: "source" },
      now: () => 0,
      live: () => true,
      instances: () => [instance as never],
    });
    const sent: Record<string, unknown>[] = [];
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const ws = {
      bufferedAmount: 0,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      },
      send: (text: string, done: (error?: Error) => void) => {
        sent.push(JSON.parse(text) as Record<string, unknown>);
        queueMicrotask(() => {
          done();
        });
      },
      ping: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
    };
    hub.attach(ws as never, "gr_x", 1);
    const settle = async () => {
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    handlers.get("message")?.(Buffer.from(JSON.stringify({ type: "subscribe" })), false);
    await settle();
    // The service restarted the space's authority: the feed's next read sends a fresh snapshot.
    head.authority_epoch = 2;
    head.authority_incarnation = "ai_y";
    hub.poke(head.space_id);
    await settle();
    const snapshots = sent.filter((m) => m["type"] === "snapshot");
    expect(snapshots.map((m) => m["reason"])).toEqual([undefined, "epoch"]);
    for (const snapshot of snapshots) expect(snapshot["instances"]).toEqual([instance]);
    handlers.get("close")?.();
  });

  test("output that keeps moving is no stall; output that stops moving closes the peer", () => {
    const { clock, hub } = options();
    const peer = stalledSocket();
    hub.attach(peer.ws as never, "gr_x", 1);
    expect(peer.ws.bufferedAmount).toBeGreaterThan(5);
    // The message drains a little in every deadline, never all of it: the peer reads, slowly.
    for (let i = 0; i < 5; i += 1) {
      peer.ws.bufferedAmount -= 1;
      peer.pong();
      clock.advance(DEFAULT_HTTP_LIMITS.wsOutputStallMs);
      expect(peer.state.terminated).toBe(false);
    }
    peer.pong();
    // It stops reading: closed at the next deadline.
    clock.advance(DEFAULT_HTTP_LIMITS.wsOutputStallMs);
    expect(peer.state.terminated).toBe(true);
    expect(hub.size).toBe(0);
  });

  test("a feed whose token stopped being live is closed with 4401 at its next tick", () => {
    let live = true;
    const { clock, hub, logged } = options(DEFAULT_HTTP_LIMITS, { live: () => live });
    const peer = stalledSocket();
    peer.ws.send = () => undefined;
    hub.attach(peer.ws as never, "gr_x", 1);
    for (const t of clock.live({ kind: "ws_output" })) t.state = "cleared";
    clock.advance(DEFAULT_HTTP_LIMITS.wsPingMs);
    expect(peer.state.closed).toBeUndefined();
    peer.state.pings = 0;
    // The token expires (7 days unused, or 30 days old): the open feed ends with it.
    live = false;
    clock.advance(DEFAULT_HTTP_LIMITS.wsPingMs);
    expect(peer.state.closed).toBe(4401);
    expect(peer.state.pings).toBe(0);
    expect(hub.size).toBe(0);
    expect(logged).toContainEqual({ ev: "http.ws_closed", reason: "expired", ms: 0 });
  });

  test("a socket that closes while its subscription is read leaves no subscription or poll behind", async () => {
    let release: (() => void) | undefined;
    const head = {
      space_id: "sp_00000000000000000000000000",
      name: "Mira",
      ref_prefix: "M",
      authority_epoch: 1,
      authority_incarnation: "ai_x",
      last_seq: 5,
    };
    const reader = {
      // The space's head is read slowly: the peer goes away meanwhile.
      get: () =>
        new Promise((resolve) => {
          release = () => {
            resolve(head);
          };
        }),
      transaction: () => Promise.resolve([head, [], [], [], [], [], []]),
    };
    const space = { id: head.space_id, name: "Mira", reader };
    const { clock, hub } = options(DEFAULT_HTTP_LIMITS, {
      spaces: () => [space] as never[],
    });
    const peer = stalledSocket();
    peer.ws.send = () => undefined;
    hub.attach(peer.ws as never, "gr_x", 1);
    peer.message({
      type: "subscribe",
      space: head.space_id,
      cursor: { epoch: 1, incarnation: "ai_x", seq: 5 },
    });
    expect(release).toBeDefined();
    peer.drop();
    expect(hub.size).toBe(0);
    release?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(clock.live({ kind: "feed_poll" })).toEqual([]);
  });

  test("output that does not move within the deadline closes the peer instead of buffering for it", () => {
    const { clock, hub } = options();
    const { ws, state } = stalledSocket();
    hub.attach(ws as never, "gr_x", 1);
    expect(state.sent).toBe(1);
    const output = clock.live({ kind: "ws_output" });
    expect(output.map((t) => t.ms)).toEqual([30_000]);
    clock.advance(29_999);
    expect(state.terminated).toBe(false);
    clock.advance(1);
    expect(state.terminated).toBe(true);
    expect(hub.size).toBe(0);
  });

  test("past the queue bound the peer is closed at once; a peer that misses a ping is closed at the next", () => {
    const small = options({ ...DEFAULT_HTTP_LIMITS, maxWsQueuedBytes: 64 });
    const full = stalledSocket();
    full.ws.bufferedAmount = 60;
    small.hub.attach(full.ws as never, "gr_x", 1);
    expect(full.state.terminated).toBe(true);
    expect(full.state.sent).toBe(0);
    expect(small.hub.size).toBe(0);
    const { clock, hub } = options();
    const silent = stalledSocket();
    // The hello's output is taken at once here, so only the ping decides.
    silent.ws.send = () => undefined;
    hub.attach(silent.ws as never, "gr_y", 2);
    for (const t of clock.live({ kind: "ws_output" })) t.state = "cleared";
    clock.advance(DEFAULT_HTTP_LIMITS.wsPingMs);
    expect(silent.state.pings).toBe(1);
    expect(silent.state.terminated).toBe(false);
    clock.advance(DEFAULT_HTTP_LIMITS.wsPingMs);
    expect(silent.state.terminated).toBe(true);
  });
});
