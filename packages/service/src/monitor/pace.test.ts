// The pace's rules that need answers the recorded conversations do not hold: several settling
// answers in a row, and launches that come while an answer is on its way. The monitor here
// answers when the test says, and the clock is virtual.
import type { MonitorSnapshot } from "@ttasks/contracts/monitor";
import { describe, expect, test } from "vitest";
import { testClock } from "../../test/clock.ts";
import type { MonitorAnswer, MonitorStatus } from "./monitor.ts";
import { MonitorPace, type PaceTimerKind } from "./pace.ts";

const STATUS: MonitorStatus = { state: "ready", slow: false, build: null, problem: null };

const snapshot = (settling: boolean): MonitorSnapshot => ({
  settling,
  usage: "live",
  generation: 1,
  collectionMs: 500,
  homes: [],
  agents: [],
  accounts: [],
});

function setup() {
  const clock = testClock<PaceTimerKind>({ virtual: "all" });
  const asks: ((answer: MonitorAnswer) => void)[] = [];
  const pace = new MonitorPace({
    monitor: {
      ask: () =>
        new Promise<MonitorAnswer>((resolve) => {
          asks.push(resolve);
        }),
      recheck: () => undefined,
      status: () => STATUS,
    },
    timers: clock.timers,
    now: () => clock.now,
  });
  const views: unknown[] = [];
  const watcher = { show: (v: unknown) => views.push(v) };
  pace.watch(watcher, { agents: true, visible: true, focused: true });
  /** Answers the newest request and lets its continuation run. */
  const reply = async (settling: boolean) => {
    asks.at(-1)?.({ ok: true, snapshot: snapshot(settling) });
    await Promise.resolve();
  };
  const due = () => {
    const [next] = clock.live({ kind: "monitor_ask" });
    return next === undefined ? undefined : next.due - clock.now;
  };
  return { clock, asks, pace, watcher, views, reply, due };
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
    s.pace.watch(s.watcher, { agents: false, visible: true, focused: true });
    s.pace.nudge();
    expect(s.asks).toHaveLength(1);
    expect(s.due()).toBeUndefined();
  });
});
