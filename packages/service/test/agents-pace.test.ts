// The Agent Monitor's pace through the service: tabs say on their feed whether an Agents page is
// mounted, visible and focused, and the service asks the test kit's fake `ttam` at the pace of the
// most attentive one. The pace's timers and the steady clock are virtual (clock.ts): the test
// moves the time, and a request's answer is the fake's real one. Fixture data only.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTtam, readJsonLines } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import type { HttpTimerKind } from "../src/http/index.ts";
import { DEFAULT_HTTP_LIMITS } from "../src/http/limits.ts";
import { FeedHub } from "../src/http/ws.ts";
import type { MonitorCommand, Watcher } from "../src/monitor/index.ts";
import { testClock, type TestClock } from "./clock.ts";
import { instanceToml } from "./harness.ts";
import { post } from "./http-client.ts";
import { httpWorld, openFeed, signIn, type FeedClient, type HttpWorld } from "./http-world.ts";

const SLOW = { timeout: 180_000 };
const LOOKED = { agents: true, visible: true, focused: true };
const VISIBLE = { agents: true, visible: true, focused: false };
/** The recorded passes, in ms: the fake answers the n-th request with the n-th, then the last. */
const PASSES = [512, 486, 474, 491];
/** Looked at: the rest after the answer to the n-th request. */
const rest = (n: number): number => 4 * (PASSES[Math.min(n, PASSES.length) - 1] ?? 0);

const worlds: HttpWorld[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

type View = Record<string, unknown> & {
  picture: { ageMs: number; settling: boolean; sessions: unknown[] } | null;
  trouble: { kind: string } | null;
};

interface Paced {
  readonly w: HttpWorld;
  readonly clock: TestClock<HttpTimerKind>;
  readonly token: string;
  /** A new tab's feed, which has sent `facts`. */
  tab(facts?: typeof LOOKED): Promise<FeedClient>;
  /** Each `get` the fake read, in order. */
  gets(): { get: number; usage: string }[];
  /** How many times the service looked for `ttam`. */
  looked(): number;
  /** Until the next request is due, or undefined when none is. */
  due(): number | undefined;
}

async function paced(
  label: string,
  options: { command?: () => MonitorCommand; toml?: string } = {},
): Promise<Paced> {
  const clock = testClock<HttpTimerKind>({
    virtual: ["monitor_ask", "monitor_keep"],
  });
  const dir = mkdtempSync(join(tmpdir(), "ttasks-pace-"));
  dirs.push(dir);
  const log = join(dir, "fake.log");
  const fake = fakeTtam({ log });
  let looked = 0;
  const w = await httpWorld(
    label,
    { timers: clock.timers, steady: () => clock.now },
    {
      ...(options.toml === undefined ? {} : { toml: options.toml }),
      ...(options.toml === undefined
        ? {}
        : { launch: { terminal: () => Promise.resolve({ kind: "accepted" as const }) } }),
      monitor: {
        command: () => {
          looked += 1;
          return Promise.resolve(
            options.command?.() ?? {
              ok: true,
              file: fake.file,
              args: fake.args,
              env: process.env,
              cwd: dir,
            },
          );
        },
      },
    },
  );
  worlds.push(w);
  const { token } = await signIn(w);
  return {
    w,
    clock,
    token,
    tab: async (facts) => {
      const feed = await openFeed(w.port(), token);
      await feed.next((m) => m["type"] === "hello");
      if (facts !== undefined) feed.send({ type: "watch", ...facts });
      return feed;
    },
    gets: () =>
      (readJsonLines(log) as { get?: number; usage?: string }[]).flatMap((line) =>
        line.get === undefined ? [] : [{ get: line.get, usage: line.usage ?? "" }],
      ),
    looked: () => looked,
    due: () => {
      const [next] = clock.live({ kind: "monitor_ask" });
      return next === undefined ? undefined : next.due - clock.now;
    },
  };
}

const view = (feed: FeedClient): Promise<View> =>
  feed.next((m) => m["type"] === "agents") as Promise<View>;

/** The next view that holds a picture: the answer to a request. */
async function answer(feed: FeedClient): Promise<NonNullable<View["picture"]>> {
  for (;;) {
    const next = await view(feed);
    if (next.picture !== null && next.trouble === null) return next.picture;
  }
}

describe("[A5.agents.pace] the service asks the monitor at the pace of the most attentive tab", () => {
  test(
    "looked at: asked at once with live usage, after a settling answer in 1 s, then four passes",
    SLOW,
    async () => {
      const p = await paced("pace-looked");
      const feed = await p.tab(LOOKED);
      // At once: nothing yet, and no trouble.
      expect(await view(feed)).toMatchObject({ picture: null, trouble: null });
      expect(await answer(feed)).toMatchObject({ settling: true });
      expect(p.gets()).toEqual([{ get: 1, usage: "live" }]);
      expect(p.due()).toBe(1_000);
      p.clock.advance(1_000);
      expect(await answer(feed)).toMatchObject({ settling: false });
      expect(p.gets().at(-1)).toEqual({ get: 2, usage: "live" });
      // The recorded pass took 486 ms: four of them.
      expect(p.due()).toBe(rest(2));
      p.clock.advance(rest(2));
      await answer(feed);
      expect(p.gets()).toHaveLength(3);
      expect(p.gets().at(-1)?.usage).toBe("live");
    },
  );

  test("visible only: every 30 s, with plan usage from TTAM's cache", SLOW, async () => {
    const p = await paced("pace-visible");
    const feed = await p.tab(VISIBLE);
    expect(await answer(feed)).toMatchObject({ settling: true });
    p.clock.advance(1_000);
    expect(await answer(feed)).toMatchObject({ settling: false });
    expect(p.due()).toBe(30_000);
    p.clock.advance(30_000);
    await answer(feed);
    expect(p.gets().map((g) => g.usage)).toEqual(["cached", "cached", "cached"]);
  });

  test(
    "none: a hidden tab, or one without an Agents page, asks nothing and gets nothing",
    SLOW,
    async () => {
      const p = await paced("pace-none");
      const feed = await p.tab({ agents: true, visible: false, focused: false });
      feed.send({ type: "watch", agents: false, visible: true, focused: true });
      p.clock.advance(120_000);
      // The same tab opens its Agents page: its first view is the first that comes.
      feed.send({ type: "watch", ...LOOKED });
      expect(await view(feed)).toMatchObject({ picture: null });
      await answer(feed);
      expect(p.gets()).toHaveLength(1);
      expect(p.looked()).toBe(1);
      // It closes it again: no request is due, and the child is asked nothing more.
      feed.send({ type: "watch", agents: false, visible: true, focused: true });
      await expect.poll(() => p.due(), { timeout: 30_000 }).toBeUndefined();
      p.clock.advance(120_000);
      expect(p.due()).toBeUndefined();
      expect(p.gets()).toHaveLength(1);
    },
  );

  test("five minutes after the focus went, a visible tab is asked every 30 s", SLOW, async () => {
    const p = await paced("pace-focus");
    const feed = await p.tab(LOOKED);
    await answer(feed);
    // The service has the blur when it plans the next request again.
    const planned = p.clock.find({ kind: "monitor_ask" }).length;
    feed.send({ type: "watch", ...VISIBLE });
    await expect
      .poll(() => p.clock.find({ kind: "monitor_ask" }).length, { timeout: 30_000 })
      .toBe(planned + 1);
    // Within the five minutes it is still looked at: the settling answer's follow-up is live.
    p.clock.advance(299_999);
    await answer(feed);
    expect(p.gets().at(-1)).toEqual({ get: 2, usage: "live" });
    expect(p.due()).toBe(rest(2));
    // The five minutes end before that request falls due: it waits for the 30 s of a tab that is
    // only visible, counted from the answer.
    p.clock.advance(1 + rest(2));
    expect(p.gets()).toHaveLength(2);
    expect(p.due()).toBe(30_000 - 1 - rest(2));
    p.clock.advance(30_000 - 1 - rest(2));
    await answer(feed);
    expect(p.gets().at(-1)).toEqual({ get: 3, usage: "cached" });
    // The focus back: looked at again, and asked after four passes from the last answer.
    feed.send({ type: "watch", ...LOOKED });
    await expect.poll(() => p.due(), { timeout: 30_000 }).toBe(rest(3));
  });

  test(
    "a reconnect: the closed tab is forgotten, the new one gets the newest at once with its age",
    SLOW,
    async () => {
      const p = await paced("pace-reconnect");
      const first = await p.tab(LOOKED);
      await answer(first);
      first.ws.close();
      await first.closed;
      await expect.poll(() => p.due(), { timeout: 30_000 }).toBeUndefined();
      p.clock.advance(10_000);
      expect(p.gets()).toHaveLength(1);
      // Its age counts on the service's steady clock from the answer, not from a time in it.
      const again = await p.tab(LOOKED);
      expect(await view(again)).toMatchObject({ picture: { ageMs: 10_000, settling: true } });
      // It was due long ago: asked at once.
      expect(await answer(again)).toMatchObject({ ageMs: 0, settling: false });
      expect(p.gets()).toHaveLength(2);
      // 30 s after the last tab left, the newest is dropped: a new tab waits for an answer.
      again.ws.close();
      await again.closed;
      await expect.poll(() => p.due(), { timeout: 30_000 }).toBeUndefined();
      p.clock.advance(30_000);
      const third = await p.tab(LOOKED);
      expect(await view(third)).toMatchObject({ picture: null, trouble: null });
    },
  );

  test(
    "two tabs: the pace of the more attentive one; a tab without the page gets nothing",
    SLOW,
    async () => {
      const p = await paced("pace-two");
      const looked = await p.tab(LOOKED);
      await answer(looked);
      const visible = await p.tab(VISIBLE);
      // It joins after the first answer: that is its first view.
      expect(await view(visible)).toMatchObject({ picture: { settling: true } });
      const elsewhere = await p.tab({ agents: false, visible: true, focused: true });
      p.clock.advance(1_000);
      await answer(looked);
      await answer(visible);
      expect(p.due()).toBe(rest(2));
      looked.ws.close();
      await looked.closed;
      await expect.poll(() => p.due(), { timeout: 30_000 }).toBe(30_000);
      p.clock.advance(30_000);
      await answer(visible);
      expect(p.gets().map((g) => g.usage)).toEqual(["live", "live", "cached"]);
      expect(elsewhere.messages.filter((m) => m["type"] === "agents")).toEqual([]);
    },
  );

  test(
    "a launch while someone watches asks once more right after the answer, without the rest",
    SLOW,
    async () => {
      const p = await paced("pace-launch", {
        toml: instanceToml({
          id: "fake-agent",
          target: "claude-cli",
          label: "Fake agent · test",
          exec: process.execPath,
        }),
      });
      const feed = await p.tab(LOOKED);
      await answer(feed);
      p.clock.advance(1_000);
      await answer(feed);
      expect(p.due()).toBe(rest(2));
      const user = await p.w.user();
      const added = (await user.call(
        "op/call",
        {
          op: "task.add",
          input: { tasks: [{ title: "Launch" }], request_id: "pace-task-0000000001" },
        },
        { timeoutMs: 60_000 },
      )) as { tasks: { id: string }[] };
      const opened = await post(
        p.w.port(),
        "/api/v1/op/launch.open",
        { task: added.tasks[0]?.id, instance: "fake-agent", request_id: "pace-click-000001" },
        { token: p.token, headers: { "ttasks-space": "Mira", "ttasks-build": "source" } },
      );
      expect(opened.status).toBe(200);
      // Asked without the clock moving, then the rest again.
      await answer(feed);
      await expect.poll(() => p.due() === rest(p.gets().length), { timeout: 30_000 }).toBe(true);
      expect(p.gets().length).toBeGreaterThanOrEqual(3);
    },
  );

  test(
    "a monitor that is missing is looked for again only when a page opens or gets the focus back",
    SLOW,
    async () => {
      const p = await paced("pace-missing", {
        command: () => ({ ok: false, reason: "not_found" }),
      });
      const feed = await p.tab(LOOKED);
      expect(await view(feed)).toMatchObject({ picture: null, trouble: null });
      expect(await view(feed)).toMatchObject({
        picture: null,
        trouble: { kind: "not_installed", reason: "not_found" },
      });
      expect(p.due()).toBeUndefined();
      p.clock.advance(600_000);
      expect(p.looked()).toBe(1);
      feed.send({ type: "watch", ...VISIBLE });
      feed.send({ type: "watch", ...LOOKED });
      expect(await view(feed)).toMatchObject({ trouble: { kind: "not_installed" } });
      expect(p.looked()).toBe(2);
    },
  );
});

describe("[A5.agents.pace] a tab that stops watching gets nothing more", () => {
  test("a view queued behind a slow write is dropped when the tab stops watching; an ended sign-in says so", async () => {
    const watchers: Watcher[] = [];
    const left: (boolean | undefined)[] = [];
    const hub = new FeedHub({
      host: { spaces: () => [] },
      limits: DEFAULT_HTTP_LIMITS,
      timers: testClock<HttpTimerKind>({ virtual: "all" }).timers,
      log: () => undefined,
      build: { version: "0.0.0", build: "source" },
      now: () => 0,
      live: () => true,
      agents: {
        watch: (watcher) => {
          if (!watchers.includes(watcher)) watchers.push(watcher);
        },
        leave: (_watcher, signedOut) => {
          left.push(signedOut);
        },
      },
    });
    const sent: Record<string, unknown>[] = [];
    const writes: (() => void)[] = [];
    const handlers = new Map<string, (...args: unknown[]) => void>();
    // A peer that reads slowly: each write is done only when the test says.
    const ws = {
      bufferedAmount: 0,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      },
      send: (text: string, done: () => void) => {
        sent.push(JSON.parse(text) as Record<string, unknown>);
        writes.push(done);
      },
      ping: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
    };
    hub.attach(ws as never, "gr_x", 1);
    const message = (value: unknown) => {
      handlers.get("message")?.(Buffer.from(JSON.stringify(value)), false);
    };
    const views = () => sent.filter((m) => m["type"] === "agents");
    const view = (n: number) => ({
      picture: { ageMs: n, settling: false, sessions: [], accounts: [] },
      trouble: null,
    });
    message({ type: "watch", ...LOOKED });
    const [tab] = watchers;
    if (tab === undefined) throw new Error("the tab never watched");
    tab.show(view(1));
    tab.show(view(2));
    tab.show(view(3));
    expect(views()).toHaveLength(1);
    message({ type: "watch", agents: true, visible: false, focused: false });
    for (const done of writes.splice(0)) done();
    await new Promise((resolve) => setImmediate(resolve));
    expect(views()).toHaveLength(1);
    // A view that comes while it does not watch is not sent either.
    tab.show(view(4));
    expect(views()).toHaveLength(1);
    message({ type: "watch", ...LOOKED });
    tab.show(view(5));
    expect(views().map((m) => (m["picture"] as { ageMs: number }).ageMs)).toEqual([1, 5]);
    // Its sign-in ends: the pace hears that it left with it.
    hub.closeGrant("gr_x");
    expect(left).toEqual([true]);
  });
});

describe("[A5.agents.privacy] nothing the monitor reports leaves the page and the service", () => {
  test(
    "the service's log gets none of it, and the page none of its IDs or paths",
    SLOW,
    async () => {
      const p = await paced("pace-private");
      const feed = await p.tab(LOOKED);
      await answer(feed);
      p.clock.advance(1_000);
      await answer(feed);
      const sent = JSON.stringify(feed.messages.filter((m) => m["type"] === "agents"));
      expect(sent).toContain("Release checklist");
      const log = readFileSync(p.w.service.log.path, "utf8");
      expect(log).toContain("monitor.started");
      for (const text of [
        "synthetic-project",
        "Release checklist",
        "Survey the fixtures",
        "/home/mira",
        "Claude Max",
        "11111111-2222-4333-8444-555555555555",
        "4242",
      ]) {
        expect(log).not.toContain(text);
      }
      for (const text of ["11111111-2222-4333-8444-555555555555", "/home/mira/.claude", "4242"]) {
        expect(sent).not.toContain(text);
      }
    },
  );
});
