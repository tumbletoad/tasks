// What an environment's ticket and preset name (`ShimHost.named`), and the name of the session a
// launch or a run is (`sessionOf`): over machine state in memory, with records as the claim and the
// end leave them.
import { describe, expect, test } from "vitest";
import { sessionOf, ShimHost, type Named } from "../src/shim/host.ts";
import { ENDED_KEEP_MS, MemoryRecords, type LaunchFile } from "../src/shim/records.ts";
import { newTicket, secretHash } from "../src/shim/secrets.ts";

const SPACE = "sp_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const TASK = "t_0k3m5n7p9q1r3s5t7v9w1x3y5z";
const PRESET = "6f1c2a4e-9b3d-4c7e-8a5f-0d2e4b6c8a1f";
const NOW = 1_800_000_000_000;

const launchId = (n: number): string => `la_${String(n).padStart(26, "0")}`;

/** A world of records and a host that reads them at `now`. */
function world(now = NOW) {
  const records = new MemoryRecords();
  const host = new ShimHost({
    records,
    probe: { startTimes: () => Promise.resolve(new Map()) },
    platform: "linux",
    machine: () => undefined,
    environment: () => ({ kind: "service", env: {} }),
    now: () => now,
  });
  /** A launch as the claim leaves it, unless `claimed` is false; returns its ticket. */
  const live = (
    n: number,
    extra: Partial<LaunchFile> = {},
    claimed = true,
  ): { launch: string; ticket: string } => {
    const launch = launchId(n);
    const ticket = newTicket();
    records.put({
      format: 1,
      space: SPACE,
      launch,
      reference: "L7KQ2M",
      task: TASK,
      createdAt: NOW - 60_000 + n,
      plan: { argv: ["/opt/agent"], folder: null, env: {}, title: "Fixture", afterExit: "close" },
      ticket: {
        hash: secretHash("ticket", launch, ticket),
        issuedAt: NOW - 50_000,
        shimUsed: claimed,
        bridgeUsed: false,
      },
      ...(claimed ? { attachment: { hash: "a".repeat(64), pid: 4242, startTime: "linux:1" } } : {}),
      app: "claude-code",
      home: "/home/fixture/.claude",
      ...extra,
    });
    return { launch, ticket };
  };
  /** A launch as its end leaves it: its ended record only, unless `keepLive`. */
  const ended = (
    n: number,
    endedAt: number,
    extra: { preset?: string } = {},
    keepLive = false,
  ): { launch: string; ticket: string } => {
    const made = live(n, extra);
    records.putEnded({
      format: 1,
      launch: made.launch,
      endedAt,
      ticket: secretHash("ticket", made.launch, made.ticket),
      space: SPACE,
      task: TASK,
      session: sessionOf({ id: made.launch }),
      app: "claude-code",
      home: "/home/fixture/.claude",
      ...extra,
    });
    if (!keepLive) records.remove(made.launch);
    return made;
  };
  return { records, host, live, ended };
}

const launchOf = (named: Named) => (named.kind === "launch" ? named.launch : undefined);

describe("[A3.3.7.binding.named] the launch a ticket or a preset names, live or ended", () => {
  test("a claimed launch's ticket names it with its session, space, task, app and home", () => {
    const w = world();
    const { launch, ticket } = w.live(1);
    w.live(2);
    expect(w.host.named({ ticket })).toEqual({
      kind: "launch",
      launch: {
        state: "live",
        launch,
        space: SPACE,
        task: TASK,
        session: `se_${launch.slice(3)}`,
        app: "claude-code",
        home: "/home/fixture/.claude",
      },
    });
  });

  test("a ticket names nothing before its launch's claim, of no launch, or malformed", () => {
    const w = world();
    const early = w.live(1, {}, false);
    expect(w.host.named({ ticket: early.ticket })).toEqual({ kind: "none" });
    expect(w.host.named({ ticket: newTicket() })).toEqual({ kind: "none" });
    expect(w.host.named({ ticket: "not a ticket" })).toEqual({ kind: "none" });
    expect(w.host.named({})).toEqual({ kind: "none" });
  });

  test("a ticket is its hash with its own launch's ID: another launch's hash does not match it", () => {
    const w = world();
    const one = w.live(1);
    // Launch 2's record holds launch 1's ticket hashed for launch 1: not a hash of launch 2.
    w.live(2, {
      ticket: {
        hash: secretHash("ticket", one.launch, one.ticket),
        issuedAt: NOW,
        shimUsed: true,
        bridgeUsed: false,
      },
    });
    expect(launchOf(w.host.named({ ticket: one.ticket }))?.launch).toBe(one.launch);
  });

  test("an ended launch's ticket names it, with its end, for a day after the end", () => {
    const w = world();
    const at = NOW - ENDED_KEEP_MS + 1;
    const { launch, ticket } = w.ended(1, at);
    expect(launchOf(w.host.named({ ticket }))).toEqual({
      state: "ended",
      endedAt: at,
      launch,
      space: SPACE,
      task: TASK,
      session: `se_${launch.slice(3)}`,
      app: "claude-code",
      home: "/home/fixture/.claude",
    });
    const old = w.ended(2, NOW - ENDED_KEEP_MS);
    expect(w.host.named({ ticket: old.ticket })).toEqual({ kind: "none" });
  });

  test("an ended record written by a build that kept no app or session still names its launch", () => {
    const w = world();
    const { launch, ticket } = w.live(1);
    w.records.putEnded({
      format: 1,
      launch,
      endedAt: NOW - 1_000,
      ticket: secretHash("ticket", launch, ticket),
      space: SPACE,
      task: null,
    });
    w.records.remove(launch);
    expect(launchOf(w.host.named({ ticket }))).toEqual({
      state: "ended",
      endedAt: NOW - 1_000,
      launch,
      space: SPACE,
      task: null,
      session: `se_${launch.slice(3)}`,
    });
  });

  test("a launch found both live and ended is ended", () => {
    const w = world();
    const { ticket } = w.ended(1, NOW - 1_000, {}, true);
    expect(launchOf(w.host.named({ ticket }))?.state).toBe("ended");
  });

  test("a preset names its live launch before an ended one, and the newest of each", () => {
    const w = world();
    w.ended(1, NOW - 5_000, { preset: PRESET });
    const newer = w.ended(2, NOW - 1_000, { preset: PRESET });
    expect(launchOf(w.host.named({ preset: PRESET }))).toMatchObject({
      state: "ended",
      launch: newer.launch,
    });
    const running = w.live(3, { preset: PRESET });
    expect(launchOf(w.host.named({ preset: PRESET }))).toMatchObject({
      state: "live",
      launch: running.launch,
    });
    const newest = w.live(4, { preset: PRESET });
    expect(launchOf(w.host.named({ preset: PRESET }))?.launch).toBe(newest.launch);
  });

  test("a preset names nothing for an unclaimed launch, for no launch, or when it is no UUID", () => {
    const w = world();
    w.live(1, { preset: PRESET }, false);
    expect(w.host.named({ preset: PRESET })).toEqual({ kind: "none" });
    expect(w.host.named({ preset: "6f1c2a4e-9b3d-4c7e-8a5f-0d2e4b6c8a10" })).toEqual({
      kind: "none",
    });
    expect(w.host.named({ preset: "not-a-uuid" })).toEqual({ kind: "none" });
  });

  test("a ticket and a preset of one launch name it; of two launches, the answer gives both", () => {
    const w = world();
    const one = w.live(1, { preset: PRESET });
    expect(w.host.named({ ticket: one.ticket, preset: PRESET })).toMatchObject({
      kind: "launch",
      launch: { launch: one.launch },
    });
    const two = w.live(2);
    expect(w.host.named({ ticket: two.ticket, preset: PRESET })).toMatchObject({
      kind: "two",
      ticket: { launch: two.launch, state: "live" },
      preset: { launch: one.launch, state: "live" },
    });
    // One value that names nothing leaves the other's launch.
    expect(launchOf(w.host.named({ ticket: newTicket(), preset: PRESET }))?.launch).toBe(
      one.launch,
    );
  });

  test("a launch that continues a session names that session", () => {
    const w = world();
    const continued = "se_0k3m5n7p9q1r3s5t7v9w1x3y5z";
    const { ticket } = w.live(1, { session: continued });
    expect(launchOf(w.host.named({ ticket }))?.session).toBe(continued);
  });
});

describe("[A3.3.7.binding.session-name] the session a launch or a run is", () => {
  test("named after the launch or the run, unless it continues one", () => {
    const body = "0k3m5n7p9q1r3s5t7v9w1x3y5z";
    expect(sessionOf({ id: `la_${body}` })).toBe(`se_${body}`);
    expect(sessionOf({ id: `ru_${body}`, session: null })).toBe(`se_${body}`);
    expect(sessionOf({ id: `la_${body}`, session: "se_00000000000000000000000000" })).toBe(
      "se_00000000000000000000000000",
    );
  });

  test("nothing else is named as a session", () => {
    for (const id of [
      "ta_0k3m5n7p9q1r3s5t7v9w1x3y5z",
      "la_short",
      "la_0K3M5N7P9Q1R3S5T7V9W1X3Y5Z",
    ]) {
      expect(() => sessionOf({ id }), id).toThrow();
    }
  });
});
