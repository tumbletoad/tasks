// A kill during a batch (A7 3.10 M3.10's Verify line, A1 5 "Crash points": the projection rename):
// at every point of a batch, renames included, the run stops for good, as a killed process does (a
// seam whose promise never settles, so no cleanup runs). A new projector then starts on the same
// folder. The tree must be valid at once: complete files only, no temporary file, and a watermark
// that covers no unrendered task. Nothing may be rescued, since nobody edited anything, and once it
// settles the tree equals a fresh render. Fixture text only.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ProjectionPoint } from "../src/index.ts";
import {
  checkWatermark,
  expectClean,
  expectSameTree,
  filesOf,
  settle,
  treeOf,
  world,
  type World,
} from "./helpers.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "projection-kill-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Every task file is whole: one the projection wrote, never a part of one. */
function expectWholeFiles(dir: string): void {
  for (const [path, text] of filesOf(dir)) {
    if (!path.endsWith(".md") || !/^(open|completed|archived)\//.test(path)) continue;
    expect(text.startsWith("---\ngenerated: true\n"), path).toBe(true);
    expect(text.endsWith("\n"), path).toBe(true);
  }
}

/** Changes that place, move and remove files: renames, a completion, a reopening, new tasks. */
function change(w: World, round: number): void {
  const active = w.reader
    .prepare("SELECT id FROM tasks WHERE lifecycle = 'active' ORDER BY ref")
    .all<{ id: string }>()
    .map((row) => row.id);
  const pick = (k: number): string => active[(round * 7 + k) % active.length] ?? "";
  w.submit([
    { kind: "task.patch", task: pick(1), set: { title: `Renamed in round ${String(round)}` } },
  ]);
  w.submit([{ kind: "task.patch", task: pick(2), set: { summary: `Round ${String(round)}` } }]);
  w.submit([{ kind: "task.complete", task: pick(3) }]);
  const done = w.reader
    .prepare("SELECT id FROM tasks WHERE lifecycle = 'completed' ORDER BY ref LIMIT 1")
    .get()?.["id"];
  if (typeof done === "string") w.submit([{ kind: "task.reopen", task: done }]);
  w.submit([{ kind: "task.create", title: `Created in round ${String(round)}` }]);
}

describe("[A1.5.projection.kill] a kill at any point of a batch, renames included, leaves a valid tree, and the watermark never covers an unrendered task", () => {
  test("every point of a batch, one kill each", async () => {
    const folder = join(root, "space");
    mkdirSync(folder);
    const w = await world(folder);
    try {
      const first = w.projector();
      await first.start();
      await settle(first);
      let fresh = 0;
      const seen = new Set<ProjectionPoint>();
      for (let kill = 1; ; kill += 1) {
        change(w, kill);
        let count = 0;
        let hit: () => void = () => undefined;
        const killed = new Promise<"killed">((resolve) => {
          hit = () => {
            resolve("killed");
          };
        });
        const doomed = w.projector({
          at: (point) => {
            count += 1;
            if (count !== kill) return;
            seen.add(point);
            hit();
            // The run stops here for good: no finally, no cleanup.
            return new Promise<void>(() => undefined);
          },
        });
        await doomed.start();
        const outcome = await Promise.race([doomed.step().then(() => "done" as const), killed]);
        // A batch with fewer points than `kill` ran to its end: every point was a kill once.
        if (outcome === "done") break;

        const after = w.projector();
        const start = await after.start();
        expectClean(w.dir);
        expectWholeFiles(w.dir);
        checkWatermark(w.dir, w.reader);
        expect(start.rescued, `nothing rescued after a kill at point ${String(kill)}`).toBe(0);
        const reports = await settle(after);
        expect(reports.reduce((sum, r) => sum + r.rescued + r.failed, 0)).toBe(0);
        expectClean(w.dir);
        checkWatermark(w.dir, w.reader);
        fresh += 1;
        const dir = join(root, `fresh-${String(fresh)}`);
        const render = w.projector({ dir });
        await render.start();
        await settle(render);
        expectSameTree(treeOf(w.dir), treeOf(dir));
        if (kill > 200) throw new Error("the batch has no end");
      }
      // The batch's own points and the publish's were all killed at.
      expect([...seen].sort()).toEqual(["journal", "record", "rename", "renamed", "reported"]);
    } finally {
      w.close();
    }
  });
});
