// When the readable files' passes run, on a clock the test moves: no wait of real time.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAN_HOLD_FILES, holdFile } from "@ttasks/testkit";
import { afterAll, describe, expect, test } from "vitest";
import type { FilesProjector, PassReport, Rebuilt } from "../src/index.ts";
import { MAX_WAIT_MS, QUIET_MS, SWEEP_MS, runFiles } from "../src/files/loop.ts";
import { tempFolders } from "../../storage/test/space-helpers.ts";
import { expectConverged, filesBelow, filesWorld, smallTree } from "./files-helpers.ts";

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

const temp = tempFolders("files-loop");
afterAll(temp.cleanup);

describe("[S3.files.loop] a rebuild is a request to the loop", () => {
  test.skipIf(!CAN_HOLD_FILES)(
    "a rebuild that meets a held file is retried once the file is let go, with no commit and no second rebuild",
    async () => {
      const w = await filesWorld(temp.make());
      const t = smallTree(w);
      const path = join(w.view, "client-work", "website", `${t.menu}-fix-the-menu.md`);
      let clock = 0;
      let asked = false;
      let held: { release(): void } | undefined;
      const rebuilt: Rebuilt[] = [];
      await runFiles(w.projector(), {
        stopped: () => clock >= 20_000,
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          // At 1 s, after the first pass: the person edits the file, another program holds it,
          // and a rebuild is asked for. At 3 s the program lets it go.
          if (clock >= 1000 && held === undefined && rebuilt.length === 0) {
            chmodSync(path, 0o600);
            writeFileSync(path, "my own words");
            held = holdFile(path);
            asked = true;
          }
          if (clock >= 3000 && held !== undefined) {
            held.release();
            held = undefined;
          }
          return Promise.resolve();
        },
        takeRebuild: () => {
          const taken = asked;
          asked = false;
          return taken;
        },
        onRebuilt: (r) => rebuilt.push(r),
      });
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]).toMatchObject({ suspect: 1, report: { failed: 1, stamped: false } });
      expect(readFileSync(path, "utf8")).toBe(
        w.fresh().get(`client-work/website/${t.menu}-fix-the-menu.md`),
      );
      expect([...filesBelow(join(w.space, "rescued")).values()]).toEqual(["my own words"]);
      expectConverged(w);
      w.fx.close();
    },
  );
});
