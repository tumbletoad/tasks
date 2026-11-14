// A kill at every act on disk (A7 3.10 M3.10's Verify line, A1 5 "Crash points": the projection
// rename): at the n-th act of a start and a batch, renames, temporary files, the record and the
// journal included, the run stops for good, as a killed process does: that act and every one after
// it never happen, and the writer answers nothing more. A new projector then starts on the same
// folder and state. The tree must be valid at once: complete files only, no temporary file, and a
// watermark that covers no unrendered task. Nothing may be rescued, since nobody changed anything,
// and once it settles the tree equals a fresh render. Fixture text only.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Act } from "../src/index.ts";
import {
  checkWatermark,
  expectClean,
  expectSameTree,
  filesOf,
  killAt,
  Killed,
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

/** The watermark `.projection.json` claims. */
const claimOf = (dir: string): number =>
  (JSON.parse(readFileSync(join(dir, ".projection.json"), "utf8")) as { seq: number }).seq;

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

describe("[A1.5.projection.kill] a kill at any act of a start or a batch, renames included, leaves a valid tree, and the watermark never covers an unrendered task", () => {
  test("every act, one kill each", async () => {
    const folder = join(root, "space");
    mkdirSync(folder);
    const w = await world(folder);
    try {
      const first = w.projector();
      await first.start();
      await settle(first);
      let fresh = 0;
      let kills = 0;
      let lastClaim = claimOf(w.dir);
      const seen = new Set<Act>();
      for (let kill = 1; ; kill += 1) {
        change(w, kill);
        const killer = killAt(kill);
        const refuse = (): Promise<never> => Promise.reject(new Killed());
        const doomed = w.projector({
          at: killer.hook,
          writer: {
            projected: (batch) =>
              killer.dead() ? refuse() : Promise.resolve(w.writer.projected(batch)),
            queueProjection: (keys) =>
              killer.dead() ? refuse() : Promise.resolve(w.writer.queueProjection(keys)),
          },
        });
        try {
          await doomed.start();
          await doomed.step();
        } catch {
          // The kill, or what it made fail: the process is gone either way.
        }
        // A start and a batch with fewer acts than `kill` ran to their end: every act was a kill.
        if (!killer.dead()) break;
        seen.add(killer.act() ?? "record");
        kills += 1;

        const after = w.projector();
        const start = await after.start();
        expectClean(w.dir);
        expectWholeFiles(w.dir);
        checkWatermark(w.dir, w.reader);
        expect(start.rescued, `nothing rescued after a kill at act ${String(kill)}`).toBe(0);
        // Every open task changes again, so each file the killed batch placed is replaced: one the
        // projection could not prove its own would be moved aside.
        for (const row of w.reader
          .prepare("SELECT id FROM tasks WHERE lifecycle = 'active'")
          .all<{ id: string }>()) {
          w.submit([
            { kind: "task.patch", task: row.id, set: { summary: `After kill ${String(kill)}` } },
          ]);
        }
        const reports = await settle(after);
        expect(reports.reduce((sum, r) => sum + r.rescued, 0)).toBe(0);
        // The claim never moves backwards.
        const claimed = claimOf(w.dir);
        expect(claimed).toBeGreaterThanOrEqual(lastClaim);
        lastClaim = claimed;
        expectClean(w.dir);
        checkWatermark(w.dir, w.reader);
        fresh += 1;
        expectSameTree(treeOf(w.dir), await w.fresh(join(root, `fresh-${String(fresh)}`)));
        if (kill > 400) throw new Error("the batch has no end");
      }
      expect(kills).toBeGreaterThan(30);
      // Every kind of act a batch does was killed at, renames and the trusted state included.
      for (const act of [
        "journal",
        "temp",
        "write",
        "rename",
        "unlink",
        "record",
        "journal-drop",
      ]) {
        expect(seen.has(act as Act), act).toBe(true);
      }
    } finally {
      w.close();
    }
  }, 240_000);
});
