// The launch service's own schedule for the sweep and the PID check, with its default options: one
// round at its start and one every 30 s after, on a fake clock. A temporary folder only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Logger } from "../src/hub/log.ts";
import { LaunchService } from "../src/launch/service.ts";

const log = { log: () => undefined } as unknown as Logger;

afterEach(() => {
  vi.useRealTimers();
});

describe("[A5.3.9.shim.session-end] the service checks its shims on its own", () => {
  test("a round at the start, then one every 30 s, and none after stop", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const base = mkdtempSync(join(tmpdir(), "ttasks-launch-check-"));
    const service = new LaunchService({
      machine: "m_7c0hq2m4w9d8k1r6t3v5x0b2nf",
      root: join(base, "launch"),
      stateDir: join(base, "state"),
      platform: process.platform,
      env: {},
      spaces: () => [],
      log,
    });
    const rounds = vi.spyOn(service, "tick");
    try {
      service.start();
      expect(rounds).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(rounds).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(rounds).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(rounds).toHaveBeenCalledTimes(3);
      service.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rounds).toHaveBeenCalledTimes(3);
    } finally {
      service.stop();
      await Promise.all(rounds.mock.results.map((r) => r.value as Promise<void>));
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
