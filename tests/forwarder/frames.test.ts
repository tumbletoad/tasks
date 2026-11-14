// Forwarder conformance (A2 3.6.2, 3.7.2, 3.7.6): lines pass unchanged and in order both ways
// under any chunking, up to the 8 MiB line limit; an oversized line from the agent app is dropped
// and the session goes on; an oversized line from the service ends that connection like a loss.
import { randomInt } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import {
  Procs,
  isOfflineText,
  makeHome,
  sleep,
  textOf,
  waitFor,
  type Home,
  type Json,
} from "./harness.ts";

const procs = new Procs();
const homes: Home[] = [];
afterEach(async () => {
  await procs.stopAll();
  for (const home of homes.splice(0)) home.remove();
});

function home(label: string): Home {
  const made = makeHome(label);
  homes.push(made);
  return made;
}

const MiB = 1024 * 1024;

/** A small seeded generator (mulberry32), so a failing run can be repeated from its seed. */
function generator(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % below) >>> 0;
  };
}

/** Text with ASCII, escapes, multi-byte and astral characters, quotes and newlines. */
const ALPHABET = [
  "a",
  "Z",
  "7",
  " ",
  '"',
  "\\",
  "\n",
  "\t",
  "é",
  "ß",
  "✓",
  "東",
  "𝄞",
  "😀",
  "{",
  "}",
];

describe("[A2.3.7.bridge.frames] lines through the forwarder", () => {
  test(
    "property: random messages in random chunks come back unchanged and in order",
    { timeout: 180_000 },
    async () => {
      const seed = randomInt(2 ** 31);
      const random = generator(seed);
      const where = home("chunks");
      await procs.peer(where, { mode: "echo" });
      const bridge = procs.bridge(where);
      // The echo peer sends every line back, so stdout must repeat stdin exactly. First make sure
      // the bridge is online: offline, notifications get no answer.
      bridge.notify("test/ready");
      await waitFor(() => (bridge.lines.length > 0 ? true : undefined), 30_000, "online");
      for (let round = 1; round <= 25; round += 1) {
        const lines = Array.from({ length: 1 + random(20) }, (_, n) => {
          const s = Array.from(
            { length: random(300) },
            () => ALPHABET[random(ALPHABET.length)],
          ).join("");
          return JSON.stringify({ jsonrpc: "2.0", method: "test/echo", params: { round, n, s } });
        });
        const data = Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8");
        const cuts = [...new Set(Array.from({ length: random(16) }, () => random(data.length)))]
          .filter((c) => c > 0)
          .sort((a, b) => a - b);
        const start = bridge.lines.length;
        let at = 0;
        for (const cut of cuts) {
          bridge.proc.child.stdin?.write(data.subarray(at, cut));
          at = cut;
          await sleep(1);
        }
        bridge.proc.child.stdin?.write(data.subarray(at));
        await waitFor(
          () => (bridge.lines.length >= start + lines.length ? true : undefined),
          30_000,
          `echoes of round ${String(round)} (seed ${String(seed)})`,
        );
        expect(bridge.lines.slice(start), `seed ${String(seed)}`).toEqual(lines);
      }
      expect(bridge.stray).toEqual([]);
    },
  );

  test("lines near the 8 MiB limit pass both ways unchanged", { timeout: 180_000 }, async () => {
    const where = home("large");
    await procs.peer(where);
    const bridge = procs.bridge(where);
    await bridge.initialize();
    const text = "z".repeat(7 * MiB);
    const echoed = await bridge.call("echo", { text });
    expect(textOf(echoed)).toBe(JSON.stringify({ text }));
    const big = await bridge.call("big", { bytes: 7.5 * MiB });
    expect(textOf(big)?.length).toBe(7.5 * MiB);
    expect(bridge.stray).toEqual([]);
  });

  test(
    "a stdin line over the limit is dropped with a warning, and the session goes on",
    { timeout: 180_000 },
    async () => {
      const where = home("overin");
      await procs.peer(where);
      const bridge = procs.bridge(where);
      await bridge.initialize();
      bridge.send({
        jsonrpc: "2.0",
        id: "too-big",
        method: "tools/call",
        params: { name: "echo", arguments: { text: "w".repeat(8 * MiB + 1024) } },
      });
      const after = await bridge.call("echo", { after: true });
      expect(textOf(after)).toBe('{"after":true}');
      expect(bridge.proc.stderr()).toContain("dropped a message over the 8 MiB line limit");
      expect(bridge.lines.some((line) => line.includes('"too-big"'))).toBe(false);
      expect(bridge.stray).toEqual([]);
    },
  );

  test(
    "a service line over the limit ends that connection: the call gets connection_lost and the binding comes back",
    { timeout: 180_000 },
    async () => {
      const where = home("overout");
      // This peer sends lines up to 16 MiB, past the bridge's 8 MiB.
      await procs.peer(where, { limits: { maxLineBytes: 16 * MiB } });
      const bridge = procs.bridge(where);
      await bridge.initialize();
      const who = async (): Promise<Json> =>
        JSON.parse(textOf(await bridge.call("whoami")) ?? "{}") as Json;
      const before = await who();
      const big = await bridge.call("big", { bytes: 9 * MiB });
      expect(isOfflineText(big, "connection_lost")).toBe(true);
      const after = await who();
      expect(after["binding"]).toBe(before["binding"]);
      expect(after["restored"]).toBe(true);
      expect(bridge.stray).toEqual([]);
    },
  );
});
