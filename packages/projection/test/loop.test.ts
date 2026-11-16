// When the projection runs (A1 3.13 step 2, A1 3.20, A7 3.10 M3.10's Verify line): one task shows
// within 1 s of its commit; a batch waits 500 ms after the last change, at most 5 s while changes
// keep coming; a backlog runs at once; failures pause. Fixture text only.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runProjection, type Projector, type StepReport } from "../src/index.ts";
import { catalogOf, checkWatermark, settle, world } from "./helpers.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "projection-loop-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const REPORT: StepReport = {
  seq: 1,
  watermark: 1,
  backlog: false,
  written: 0,
  removed: 0,
  failed: 0,
  blocked: 0,
  rescued: 0,
  published: true,
};

/**
 * A stand-in projector on a fake clock: `changes` lists the instants of commits, a batch takes
 * every change so far, and `batches` records when each ran.
 */
function scripted(
  changes: number[],
  options: { backlogBatches?: number; failing?: number; blocked?: number; broken?: number } = {},
) {
  let clock = 0;
  let seen = 0;
  let backlogs = options.backlogBatches ?? 0;
  let failing = options.failing ?? 0;
  /** Batches that report a task that could not be placed, while other tasks wait. */
  let blocked = options.blocked ?? 0;
  /** Batches that report a failure that is no task's (a root file, a retired file). */
  let broken = options.broken ?? 0;
  /** The last batch left a backlog: rows wait at or below its snapshot. */
  let owed = false;
  const batches: number[] = [];
  const projector = {
    start: () =>
      Promise.resolve({
        rebuild: false,
        temps: 0,
        recovered: false,
        rescued: 0,
        reconciled: { full: false, checked: 0, queued: 0, forgotten: 0 },
      }),
    pending: () => {
      const arrived = changes.filter((at) => at <= clock).length;
      return { dirty: arrived > seen || owed, mark: String(arrived) };
    },
    step: () => {
      batches.push(clock);
      if (failing > 0) {
        failing -= 1;
        return Promise.reject(new Error("EBUSY"));
      }
      seen = changes.filter((at) => at <= clock).length;
      if (blocked > 0 || broken > 0) {
        const task = blocked > 0;
        if (task) blocked -= 1;
        else broken -= 1;
        owed = blocked > 0 || broken > 0;
        return Promise.resolve({
          ...REPORT,
          backlog: owed,
          failed: 1,
          blocked: task ? 1 : 0,
        });
      }
      owed = backlogs > 0;
      if (owed) backlogs -= 1;
      return Promise.resolve({ ...REPORT, backlog: owed });
    },
  } as unknown as Projector;
  const end = Math.max(...changes, 0) + 70_000;
  const run = runProjection(projector, {
    stopped: () => clock > end,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  return { run, batches };
}

describe("[A1.5.projection.latency] one task shows within 1 s of its commit, and batches follow A1's schedule", () => {
  test("a real space: a new task's file is in the folder within 1 s", async () => {
    const folder = join(root, "space");
    mkdirSync(folder);
    const w = await world(folder);
    let stop = false;
    const steps: StepReport[] = [];
    const errors: unknown[] = [];
    const running = runProjection(w.projector(), {
      stopped: () => stop,
      onStep: (report) => steps.push(report),
      onError: (error) => errors.push(error),
    });
    try {
      // The first start renders the whole space.
      const deadline = Date.now() + 20_000;
      while (!existsSync(join(w.dir, ".projection.json")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(errors).toEqual([]);
      const created = w.submit([{ kind: "task.create", title: "Shows within a second" }]);
      const t0 = performance.now();
      const ref = Number(
        w.reader.prepare("SELECT ref FROM tasks WHERE id = $id").get({
          id: created.results[0]?.id ?? "",
        })?.["ref"],
      );
      const name = `M-${String(ref)}-shows-within-a-second.md`;
      let shown = Number.POSITIVE_INFINITY;
      while (performance.now() - t0 < 3_000) {
        if (readdirSync(join(w.dir, "open")).includes(name)) {
          shown = performance.now() - t0;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(shown).toBeLessThan(1_000);
      // And the catalogue follows in the same batch.
      const settled = Date.now() + 5_000;
      while (checkWatermark(w.dir, w.reader) !== w.writer.asOf().seq && Date.now() < settled) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(checkWatermark(w.dir, w.reader)).toBe(w.writer.asOf().seq);
      expect(errors).toEqual([]);
    } finally {
      stop = true;
      await running;
      w.close();
    }
  });

  test("a real space: tasks that cannot be placed and fill a batch never stop the task after them", async () => {
    const folder = join(root, "blocked");
    mkdirSync(folder);
    const w = await world(folder, 12);
    try {
      const first = w.projector({ batch: 2 });
      await first.start();
      await settle(first);
      const [a, b, c] = catalogOf(w.dir);
      for (const line of [a, b]) {
        const abs = join(w.dir, ...(line?.path ?? "").split("/"));
        chmodSync(abs, 0o600);
        writeFileSync(abs, "Blocking edit.\n");
        w.submit([{ kind: "task.patch", task: line?.id ?? "", set: { summary: "Blocked" } }]);
      }
      // Nothing can be moved aside: the two blocked tasks are the oldest and fill a batch of two.
      writeFileSync(join(w.folder, "exchange"), "Not a folder.\n");
      w.submit([{ kind: "task.patch", task: c?.id ?? "", set: { summary: "Free" } }]);
      let stop = false;
      const running = runProjection(w.projector({ batch: 2 }), { stopped: () => stop });
      try {
        const file = join(w.dir, ...(c?.path ?? "").split("/"));
        // A bound on waiting, not on speed: the old schedule never got there at all.
        const deadline = Date.now() + 30_000;
        while (!readFileSync(file, "utf8").includes("Free") && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(readFileSync(file, "utf8")).toContain("Free");
      } finally {
        stop = true;
        await running;
      }
    } finally {
      w.close();
    }
  });

  test("one change: the batch runs 500 ms after it", async () => {
    const { run, batches } = scripted([1_000]);
    await run;
    expect(batches).toHaveLength(1);
    expect(batches[0]).toBeGreaterThanOrEqual(1_500);
    expect(batches[0]).toBeLessThanOrEqual(1_600);
  });

  test("changes every 200 ms: the batch runs 5 s after the first, not later", async () => {
    const changes = Array.from({ length: 60 }, (_, i) => 1_000 + i * 200);
    const { run, batches } = scripted(changes);
    await run;
    expect(batches[0]).toBeGreaterThanOrEqual(6_000);
    expect(batches[0]).toBeLessThanOrEqual(6_100);
  });

  test("a backlog runs at once; a failing batch pauses, longer each time", async () => {
    const backlog = scripted([1_000], { backlogBatches: 1 });
    await backlog.run;
    // The first batch waits for quiet; the one its backlog asks for runs at the same instant.
    expect(backlog.batches).toEqual([1_500, 1_500]);
    const failing = scripted([1_000], { failing: 3 });
    await failing.run;
    const gaps = failing.batches.slice(1, 4).map((at, i) => at - (failing.batches[i] ?? 0));
    expect(gaps[0]).toBeGreaterThanOrEqual(500);
    expect(gaps[1]).toBeGreaterThanOrEqual(1_000);
    expect(gaps[2]).toBeGreaterThanOrEqual(2_000);
  });

  test("a task that cannot be placed never pauses the worker: it waits its own pause, and the next batch runs at once; any other failure pauses", async () => {
    const blocked = scripted([1_000], { blocked: 3 });
    await blocked.run;
    expect(blocked.batches).toEqual([1_500, 1_500, 1_500]);
    const broken = scripted([1_000], { broken: 2 });
    await broken.run;
    expect((broken.batches[1] ?? 0) - (broken.batches[0] ?? 0)).toBeGreaterThanOrEqual(500);
  });
});
