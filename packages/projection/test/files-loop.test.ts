// When the readable files' passes run, on a clock the test moves: no wait of real time.
import { describe, expect, test } from "vitest";
import type { FilesProjector, PassReport } from "../src/index.ts";
import { MAX_WAIT_MS, QUIET_MS, SWEEP_MS, runFiles } from "../src/files/loop.ts";

interface Script {
  /** The space's last commit at a time. */
  seqAt: (t: number) => number;
  /** How many files a pass at this time could not place. */
  failsAt?: (t: number) => number;
  /** Files found missing at a sweep at this time. */
  missingAt?: (t: number) => number;
  until: number;
}

async function passTimes(script: Script): Promise<number[]> {
  let t = 0;
  const times: number[] = [];
  const projector = {
    start: () => ({ recovered: 0, temps: 0, suspect: 0 }),
    seq: () => script.seqAt(t),
    missing: () => script.missingAt?.(t) ?? 0,
    pass: (): PassReport => {
      times.push(t);
      const failed = script.failsAt?.(t) ?? 0;
      return {
        seq: script.seqAt(t),
        written: 0,
        removed: 0,
        rescued: 0,
        failed,
        stamped: failed === 0,
      };
    },
  } as unknown as FilesProjector;
  await runFiles(projector, {
    stopped: () => t >= script.until,
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  });
  return times;
}

describe("[S3.files.loop] when a pass runs", () => {
  test("once commits have stood still for 500 ms, and not before", async () => {
    // The first pass at the start; then commits at 1,000 and 1,300.
    const times = await passTimes({ seqAt: (t) => (t < 1000 ? 1 : t < 1300 ? 2 : 3), until: 4000 });
    expect(times[0]).toBe(0);
    expect(times.slice(1)).toEqual([1300 + QUIET_MS]);
  });

  test("at most 5 s after the first commit it has not shown, while commits keep coming", async () => {
    // A commit every 200 ms from 1,000 on.
    const times = await passTimes({
      seqAt: (t) => (t < 1000 ? 1 : 2 + Math.floor((t - 1000) / 200)),
      until: 12_000,
    });
    expect(times[1]).toBeLessThanOrEqual(1000 + MAX_WAIT_MS + 100);
    expect(times[1]).toBeGreaterThanOrEqual(1000 + MAX_WAIT_MS - 100);
  });

  test("a pass that could not place everything runs again without a commit, after a pause that doubles", async () => {
    const times = await passTimes({
      seqAt: () => 1,
      failsAt: (t) => (t < 1600 ? 1 : 0),
      until: 6000,
    });
    // Fails at 0, 500 and 1,500 (pauses of 500 and 1,000 ms), then placed after a pause of 2,000.
    expect(times).toEqual([0, 500, 1500, 3500]);
  });

  test("while nothing changes, a sweep that finds a missing file brings a pass", async () => {
    const times = await passTimes({
      seqAt: () => 1,
      missingAt: (t) => (t >= 15_000 && t < 25_000 ? 1 : 0),
      until: 26_000,
    });
    expect(times[0]).toBe(0);
    expect(times.length).toBeGreaterThan(1);
    expect(times[1]).toBeGreaterThanOrEqual(15_000);
    expect(times[1]).toBeLessThanOrEqual(15_000 + SWEEP_MS + 200);
  });
});
