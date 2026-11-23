// The pace's rules that need answers the recorded conversations do not hold: several settling
// answers in a row, launches that come while an answer is on its way, answers that come after
// the last tab left, a steady clock that moves on while timers wait (a machine that slept), and a
// monitor that is slow. The monitor here answers when the test says, and the clock is virtual.
import type { AgentsView, MonitorSnapshot } from "@ttasks/contracts/monitor";
import { describe, expect, test } from "vitest";
import { testClock } from "../../test/clock.ts";
import type { MonitorAnswer, MonitorStatus } from "./monitor.ts";
import { MonitorPace, PACE, type PaceTimerKind } from "./pace.ts";

const LOOKED = { agents: true, visible: true, focused: true };
const VISIBLE = { agents: true, visible: true, focused: false };
const GONE = { agents: false, visible: true, focused: true };

const snapshot = (settling: boolean, generation = 1): MonitorSnapshot => ({
  settling,
  usage: "live",
  generation,
  collectionMs: 500,
  homes: [],
  agents: [],
  accounts: [],
});

function setup() {
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
  });
  /** A tab: the views it was sent. */
  const tab = () => {
    const views: AgentsView[] = [];
    return { views, show: (v: AgentsView) => views.push(v) };
  };
  const watcher = tab();
  pace.watch(watcher, LOOKED);
  /** Answers the newest request and lets its continuation run. */
  const reply = async (settling: boolean, generation = 1) => {
    asks.at(-1)?.resolve({ ok: true, snapshot: snapshot(settling, generation) });
    await Promise.resolve();
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
