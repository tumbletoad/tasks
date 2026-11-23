// The pace's rules that need answers the recorded conversations do not hold: several settling
// answers in a row, launches that come while an answer is on its way, answers that come after
// the last tab left, a steady clock that moves on while timers wait (a machine that slept), and a
// monitor that is slow, and an agent TTasks holds that TTAM stops seeing. The monitor here answers
// when the test says, and the clock is virtual.
import type { AgentsView, MonitorSnapshot } from "@ttasks/contracts/monitor";
import { describe, expect, test } from "vitest";
import { testClock } from "../../test/clock.ts";
import { homeDigest } from "../setup/agents.ts";
import type { HeldSession } from "./links.ts";
import type { MonitorAnswer, MonitorStatus } from "./monitor.ts";
import { MonitorPace, PACE, type PaceTimerKind } from "./pace.ts";

const LOOKED = { agents: true, visible: true, focused: true };
const VISIBLE = { agents: true, visible: true, focused: false };
const GONE = { agents: false, visible: true, focused: true };

const HOME = process.platform === "win32" ? "C:\\fixture\\claude" : "/fixture/claude";
const SESSION = "aaaaaaaa-1111-4111-8111-000000000001";
const TASK = {
  space: "sp_fixture",
  copy: "sp_fixture-copy-0123456789ab",
  address: "sp_fixture",
  spaceName: "Fixture",
  id: "t_fixture",
  ref: "F-1",
  started: "terminal" as const,
  of: "la_fixture",
};

const snapshot = (settling: boolean, generation = 1, present = true): MonitorSnapshot => ({
  settling,
  usage: "live",
  generation,
  collectionMs: 500,
  homes: [
    {
      id: "claude-test",
      provider: "claude",
      providerName: "claude",
      label: "claude",
      path: HOME,
      present,
    },
  ],
  agents: [],
  accounts: [],
});

function setup(held: () => readonly HeldSession[] = () => [], present = true) {
  const clock = testClock<PaceTimerKind>({ virtual: "all" });
  /** How far the steady clock moved on without any timer firing. */
  let slept = 0;
  const status: { -readonly [K in keyof MonitorStatus]: MonitorStatus[K] } = {
    state: "ready",
    slow: false,
    build: null,
    problem: null,
  };
  const asks: { usage: string; resolve: (answer: MonitorAnswer) => void }[] = [];
  const pace = new MonitorPace({
    monitor: {
      ask: (usage) =>
        new Promise<MonitorAnswer>((resolve) => {
          asks.push({ usage: usage ?? "", resolve });
        }),
      recheck: () => undefined,
      status: () => status,
    },
    timers: clock.timers,
    now: () => clock.now + slept,
    held: () => Promise.resolve(held()),
    platform: process.platform,
  });
  /** A tab: the views it was sent. */
  const tab = () => {
    const views: AgentsView[] = [];
    return { views, show: (v: AgentsView) => views.push(v) };
  };
  const watcher = tab();
  pace.watch(watcher, LOOKED);
  /** Answers the newest request and lets its continuation run. */
  const reply = async (
    settling: boolean,
    generation = 1,
    agents: MonitorSnapshot["agents"] = [],
  ) => {
    asks
      .at(-1)
      ?.resolve({ ok: true, snapshot: { ...snapshot(settling, generation, present), agents } });
    await new Promise((resolve) => setImmediate(resolve));
  };
  const due = () => {
    const [next] = clock.live({ kind: "monitor_ask" });
    return next === undefined ? undefined : next.due - clock.now;
  };
  return {
    clock,
    status,
    asks,
    pace,
    tab,
    watcher,
    views: watcher.views,
    reply,
    due,
    /** The steady clock moves on, and no timer fires: they fire late, when the test says. */
    sleep: (ms: number) => {
      slept += ms;
    },
  };
}

describe("[A5.agents.pace] the pace's follow-ups", () => {
  test("a settling answer is followed after 1 s at most three times in a row", async () => {
    const s = setup();
    for (let i = 0; i < 3; i += 1) {
      await s.reply(true);
      expect(s.due()).toBe(1_000);
      s.clock.advance(1_000);
    }
    await s.reply(true);
    expect(s.due()).toBe(2_000);
    s.clock.advance(2_000);
    await s.reply(false);
    s.clock.advance(2_000);
    await s.reply(true);
    expect(s.due()).toBe(1_000);
  });

  test("launches while an answer is on its way make one request right after it", async () => {
    const s = setup();
    expect(s.asks).toHaveLength(1);
    s.pace.nudge();
    s.pace.nudge();
    s.pace.nudge();
    expect(s.asks).toHaveLength(1);
    await s.reply(false);
    expect(s.asks).toHaveLength(2);
    expect(s.due()).toBeUndefined();
    await s.reply(false);
    expect(s.asks).toHaveLength(2);
    expect(s.due()).toBe(2_000);
    // While it rests, a launch asks at once.
    s.pace.nudge();
    expect(s.asks).toHaveLength(3);
  });

  test("a launch while nobody watches asks nothing", async () => {
    const s = setup();
    await s.reply(false);
    s.pace.watch(s.watcher, GONE);
    s.pace.nudge();
    expect(s.asks).toHaveLength(1);
    expect(s.due()).toBeUndefined();
  });
});

describe("[A5.agents.pace] live plan usage only while the page is looked at", () => {
  test("a request that falls due after the five minutes asks for cached usage", async () => {
    const s = setup();
    await s.reply(false);
    expect(s.asks.map((a) => a.usage)).toEqual(["live"]);
    s.pace.watch(s.watcher, VISIBLE);
    // The machine sleeps for six minutes: the request due in 2 s fires only after it.
    s.sleep(6 * 60_000);
    const [late] = s.clock.live({ kind: "monitor_ask" });
    if (late === undefined) throw new Error("no request was due");
    s.clock.fire(late);
    expect(s.asks.map((a) => a.usage)).toEqual(["live", "cached"]);
  });
});

describe("[A5.agents.pace] a picture nobody asked to keep is dropped", () => {
  test("an answer that comes after the 30 s is not kept for a tab that comes later", async () => {
    const s = setup();
    s.pace.watch(s.watcher, GONE);
    s.clock.advance(45_000);
    await s.reply(false);
    const later = s.tab();
    s.clock.advance(5_000);
    s.pace.watch(later, LOOKED);
    expect(later.views[0]).toEqual({ picture: null, trouble: null });
    // It is asked at once, as for a tab that starts fresh.
    expect(s.asks).toHaveLength(2);
  });

  test("an answer within the 30 s is kept until they end", async () => {
    const s = setup();
    s.pace.watch(s.watcher, GONE);
    s.clock.advance(10_000);
    await s.reply(false);
    const soon = s.tab();
    s.pace.watch(soon, LOOKED);
    expect(soon.views[0]?.picture).toMatchObject({ ageMs: 0 });
    s.pace.watch(soon, GONE);
    s.clock.advance(PACE.keepMs);
    const later = s.tab();
    s.pace.watch(later, LOOKED);
    expect(later.views[0]).toEqual({ picture: null, trouble: null });
  });

  test("a sign-in that ends with the last tab takes the answer on its way with it", async () => {
    const s = setup();
    await s.reply(false);
    s.clock.advance(2_000);
    expect(s.asks).toHaveLength(2);
    s.pace.leave(s.watcher, true);
    await s.reply(false, 2);
    const next = s.tab();
    s.pace.watch(next, LOOKED);
    expect(next.views[0]).toEqual({ picture: null, trouble: null });
  });

  test("a sign-in that ends while another tab watches leaves its picture", async () => {
    const s = setup();
    const other = s.tab();
    s.pace.watch(other, VISIBLE);
    await s.reply(false);
    s.pace.leave(s.watcher, true);
    const next = s.tab();
    s.pace.watch(next, LOOKED);
    expect(next.views[0]?.picture).not.toBeNull();
  });
});

describe("[A5.agents.pace] the slow flag goes with the next answer, never before", () => {
  test("an old picture is never sent as current between slow and the answer", async () => {
    const s = setup();
    await s.reply(false);
    s.clock.advance(2_000);
    s.status.slow = true;
    s.pace.changed();
    expect(s.views.at(-1)?.trouble).toEqual({ kind: "slow" });
    const sent = s.views.length;
    // The monitor clears its flag as the answer arrives, before the pace has the answer.
    s.status.slow = false;
    s.pace.changed();
    expect(s.views).toHaveLength(sent);
    await s.reply(false, 2);
    expect(s.views).toHaveLength(sent + 1);
    expect(s.views.at(-1)?.trouble).toBeNull();
  });

  test("a failure that follows slow clears it with the failure", async () => {
    const s = setup();
    await s.reply(false);
    s.clock.advance(2_000);
    s.status.slow = true;
    s.pace.changed();
    s.status.slow = false;
    s.pace.changed();
    s.asks.at(-1)?.resolve({ ok: false, problem: { kind: "failed", reason: "exited" } });
    await Promise.resolve();
    expect(s.views.map((v) => v.trouble?.kind ?? null)).toEqual([null, null, "slow", "failed"]);
    expect(s.views.at(-1)?.picture).not.toBeNull();
  });
});

describe("[A5.agents.unseen] an agent TTasks holds as running that the monitor does not see", () => {
  const held = (running = true): HeldSession[] => [
    {
      task: TASK,
      provider: "claude",
      home: homeDigest(process.platform, HOME),
      sessionId: SESSION,
      running,
    },
  ];
  const seen: MonitorSnapshot["agents"] = [
    {
      rowId: "row-1",
      parentRowId: null,
      kind: "session",
      provider: "claude",
      providerName: "claude",
      homeId: "claude-test",
      profile: "claude",
      sessionId: SESSION,
      childId: null,
      liveness: "confirmed",
      name: "Fixture agent",
      folder: null,
      activity: "idle",
      ageMs: null,
      quietMs: null,
    },
  ];
  const unseen = (s: ReturnType<typeof setup>) => s.views.at(-1)?.picture?.unseen ?? [];

  test("is not seen after two complete answers that miss it over 10 s; a settling one counts neither way", async () => {
    let running = true;
    const s = setup(() => held(running));
    await s.reply(false);
    expect(unseen(s)).toEqual([]);
    // Two answers a second apart: an agent that just started may not have written its session.
    s.clock.advance(s.due() ?? 0);
    await s.reply(false);
    expect(unseen(s)).toEqual([]);
    s.clock.advance(8_000);
    await s.reply(true);
    expect(unseen(s)).toEqual([]);
    s.clock.advance(s.due() ?? 0);
    await s.reply(false);
    expect(unseen(s)).toEqual([TASK]);
    // Seen again, it is linked and no longer unseen; it counts from the start the next time.
    s.clock.advance(s.due() ?? 0);
    await s.reply(false, 1, seen);
    expect(unseen(s)).toEqual([]);
    expect(s.views.at(-1)?.picture?.sessions[0]?.task).toEqual(TASK);
    s.clock.advance(20_000);
    await s.reply(false);
    expect(unseen(s)).toEqual([]);
    // An agent TTasks no longer holds as running is never unseen.
    running = false;
    s.clock.advance(20_000);
    await s.reply(false);
    s.clock.advance(20_000);
    await s.reply(false);
    expect(unseen(s)).toEqual([]);
  });

  test("an agent in a home the monitor does not list, or a background run, is never unseen", async () => {
    const s = setup(() => [
      {
        task: TASK,
        provider: "claude",
        home: homeDigest(process.platform, `${HOME}-elsewhere`),
        sessionId: SESSION,
        running: true,
      },
      {
        task: { ...TASK, id: "t_run", started: "run", of: "ru_fixture" },
        provider: "claude",
        home: homeDigest(process.platform, HOME),
        sessionId: SESSION,
        running: true,
      },
    ]);
    for (let i = 0; i < 4; i += 1) {
      await s.reply(false);
      s.clock.advance(20_000);
    }
    expect(unseen(s)).toEqual([]);
  });

  test("an agent in a home the monitor reports as not present is never unseen", async () => {
    const s = setup(() => held(), false);
    for (let i = 0; i < 4; i += 1) {
      await s.reply(false);
      s.clock.advance(20_000);
    }
    expect(unseen(s)).toEqual([]);
  });
});
