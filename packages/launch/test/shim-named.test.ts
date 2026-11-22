// The live launch an environment's ticket or preset names (`ShimHost.liveByTicket`,
// `liveByPreset`), and the name of the session a launch or a run is (`sessionOf`): over machine
// state in memory, with records as the click and the claim leave them.
import { describe, expect, test } from "vitest";
import { sessionOf, ShimHost } from "../src/shim/host.ts";
import { MemoryRecords, type LaunchFile } from "../src/shim/records.ts";
import { newTicket, secretHash } from "../src/shim/secrets.ts";

const SPACE = "sp_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const TASK = "t_0k3m5n7p9q1r3s5t7v9w1x3y5z";
const PRESET = "6f1c2a4e-9b3d-4c7e-8a5f-0d2e4b6c8a1f";

const launchId = (n: number): string => `la_${String(n).padStart(26, "0")}`;

/** Machine state in memory and a host that reads it. */
function world() {
  const records = new MemoryRecords();
  const host = new ShimHost({
    records,
    probe: { startTimes: () => Promise.resolve(new Map()) },
    platform: "linux",
    machine: () => undefined,
    environment: () => ({ kind: "service", env: {} }),
  });
  /**
   * A launch as its claim leaves it, or as its dispatch does when `claimed` is false; with the
   * click's app and home unless `given` is false.
   */
  const launch = (
    n: number,
    extra: Partial<LaunchFile> = {},
    claimed = true,
    given = true,
  ): { launch: string; ticket: string } => {
    const id = launchId(n);
    const ticket = newTicket();
    records.put({
      format: 1,
      space: SPACE,
      launch: id,
      reference: "L7KQ2M",
      task: TASK,
      createdAt: 1_800_000_000_000 + n,
      plan: { argv: ["/opt/agent"], folder: null, env: {}, title: "Fixture", afterExit: "close" },
      ticket: {
        hash: secretHash("ticket", id, ticket),
        issuedAt: 1_800_000_000_000,
        shimUsed: claimed,
        bridgeUsed: false,
      },
      ...(claimed ? { attachment: { hash: "a".repeat(64), pid: 4242, startTime: "linux:1" } } : {}),
      ...(given ? { app: "claude-code", home: "/home/fixture/.claude" } : {}),
      ...extra,
    });
    return { launch: id, ticket };
  };
  return { records, host, launch };
}

describe("[A3.3.7.binding.named] the live launch a ticket or a preset names", () => {
  test("a claimed launch's ticket names it with its session, space, task, app and home", () => {
    const w = world();
    const { launch, ticket } = w.launch(1);
    w.launch(2);
    expect(w.host.liveByTicket(ticket)).toEqual({
      launch,
      space: SPACE,
      task: TASK,
      session: `se_${launch.slice(3)}`,
      app: "claude-code",
      home: "/home/fixture/.claude",
    });
  });

  test("a ticket names nothing before its launch's claim, after its release, of no launch, or malformed", () => {
    const w = world();
    const early = w.launch(1, {}, false);
    expect(w.host.liveByTicket(early.ticket)).toBeUndefined();
    const done = w.launch(2);
    w.host.release(done.launch);
    expect(w.host.liveByTicket(done.ticket)).toBeUndefined();
    expect(w.host.liveByTicket(newTicket())).toBeUndefined();
    expect(w.host.liveByTicket("not a ticket")).toBeUndefined();
  });

  test("a ticket is its hash with its own launch's ID: a record holding another launch's hash is not named", () => {
    const w = world();
    const one = w.launch(1);
    w.records.remove(one.launch);
    // Launch 2's record holds launch 1's ticket, hashed for launch 1.
    w.launch(2, {
      ticket: {
        hash: secretHash("ticket", one.launch, one.ticket),
        issuedAt: 1_800_000_000_000,
        shimUsed: true,
        bridgeUsed: false,
      },
    });
    expect(w.host.liveByTicket(one.ticket)).toBeUndefined();
  });

  test("a record without the click's app or home names its launch without them", () => {
    const w = world();
    const { launch, ticket } = w.launch(1, {}, true, false);
    expect(w.host.liveByTicket(ticket)).toEqual({
      launch,
      space: SPACE,
      task: TASK,
      session: `se_${launch.slice(3)}`,
    });
  });

  test("a preset names its claimed launch, the newest when two are, and nothing once released", () => {
    const w = world();
    const older = w.launch(1, { preset: PRESET });
    expect(w.host.liveByPreset(PRESET)?.launch).toBe(older.launch);
    const newer = w.launch(2, { preset: PRESET });
    expect(w.host.liveByPreset(PRESET)?.launch).toBe(newer.launch);
    w.host.release(newer.launch);
    w.host.release(older.launch);
    expect(w.host.liveByPreset(PRESET)).toBeUndefined();
  });

  test("a preset names nothing for an unclaimed launch, for no launch, or when it is no UUID", () => {
    const w = world();
    w.launch(1, { preset: PRESET }, false);
    expect(w.host.liveByPreset(PRESET)).toBeUndefined();
    expect(w.host.liveByPreset("6f1c2a4e-9b3d-4c7e-8a5f-0d2e4b6c8a10")).toBeUndefined();
    expect(w.host.liveByPreset("not-a-uuid")).toBeUndefined();
  });

  test("a launch that continues a session names that session", () => {
    const w = world();
    const continued = "se_0k3m5n7p9q1r3s5t7v9w1x3y5z";
    const { ticket } = w.launch(1, { session: continued });
    expect(w.host.liveByTicket(ticket)?.session).toBe(continued);
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
