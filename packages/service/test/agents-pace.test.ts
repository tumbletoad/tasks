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
import type { MonitorCommand } from "../src/monitor/index.ts";
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
    virtual: ["monitor_ask", "monitor_focus", "monitor_keep"],
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
    feed.send({ type: "watch", ...VISIBLE });
    await expect
      .poll(() => p.clock.live({ kind: "monitor_focus" }).length, { timeout: 30_000 })
      .toBe(1);
    // Within the five minutes it is still looked at: the settling answer's follow-up is live.
    p.clock.advance(299_999);
    await answer(feed);
    expect(p.gets().at(-1)).toEqual({ get: 2, usage: "live" });
    expect(p.due()).toBe(rest(2));
    p.clock.advance(1);
    expect(p.due()).toBe(29_999);
    p.clock.advance(29_999);
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
