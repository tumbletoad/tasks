// The bridge's diagnostics on stderr are best effort: they never end the session and never grow
// its memory, whatever the agent app does with its end of stderr. The conformance suite checks a
// closed stderr through a real process (tests/forwarder/hygiene.test.ts).
import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { MAX_DIAGNOSTIC_QUEUE, diagnostics } from "./run.ts";

/** A stderr nobody reads: it takes the first chunk and never finishes writing it. */
class Stalled extends Writable {
  override _write(): void {
    // Never calls its callback: every later write waits in the stream's queue.
  }
}

describe("[A2.3.7.bridge.hygiene] the bridge's diagnostics", () => {
  test("a stderr nobody reads holds at most MAX_DIAGNOSTIC_QUEUE: later diagnostics are dropped", () => {
    const stderr = new Stalled();
    const say = diagnostics(stderr);
    for (let n = 0; n < 100_000; n += 1) say("dropped a message that is not valid UTF-8");
    expect(stderr.writableLength).toBeGreaterThan(0);
    expect(stderr.writableLength).toBeLessThan(MAX_DIAGNOSTIC_QUEUE + 100);
  });

  test("a stderr that fails or was destroyed drops diagnostics without an error", async () => {
    const failing = new Writable({
      write(_chunk, _encoding, done) {
        done(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    const say = diagnostics(failing);
    say("one");
    await new Promise((resolve) => setImmediate(resolve));
    expect(failing.destroyed).toBe(true);
    expect(() => {
      say("two");
    }).not.toThrow();
  });
});
