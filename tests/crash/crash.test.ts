// The short deterministic slice of the crash harness that runs in pnpm verify (A7 3.18.1): a few
// rounds whose kills are fixed, one at each kind of named point, then one by timer and one that
// runs to the end, so a regression in a crash window is caught without the long run (pnpm crash).
// Each round starts a real child process, kills it for real and checks every invariant.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../packages/storage/src/manifest.ts";
import { openWriter } from "../../packages/storage/src/open.ts";
import { checkedDriver } from "../../packages/storage/test/space-helpers.ts";
import { runCrash } from "./harness.ts";
import type { Kill } from "./protocol.ts";

/** Each test starts real processes: a slow runner gets room. */
const SLICE_TIMEOUT_MS = 300_000;

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "tasks-crash-slice-"));
  roots.push(dir);
  return dir;
}

const at = (
  where: Extract<Kill, { kind: "point" }>["arm"]["where"],
  point: string,
  nth = 1,
): Kill => ({
  kind: "point",
  arm: { where, point, nth },
});

/**
 * The slice, in order. The space starts at 0.1, so the first rounds kill inside the migration
 * that the writer's open runs (between its two steps, inside the barrier backup, and after its
 * COMMIT); then the write path before and after COMMIT, the backup before and after its data takes
 * its name, and a restore in place before its swap, between its renames and before its backups
 * moved. Then a kill by timer and a round that runs to the end.
 */
const SLICE: readonly Kill[] = [
  at("migrate", "step-applied", 2),
  at("barrier", "data-published"),
  at("migrate", "committed"),
  at("write", "before-commit", 12),
  at("write", "after-commit", 7),
  at("backup", "compressed"),
  at("backup", "data-published"),
  at("restore", "claimed"),
  at("restore", "moved-aside"),
  at("restore", "moved-into-place"),
  at("restore", "backups-carried"),
  { kind: "timer", sends: 25, afterMs: 1 },
  { kind: "none" },
];

describe("[A1.5.crash.slice] a short slice of the crash harness: a kill at each kind of point", () => {
  test(
    "every invariant holds after each kill, and the run leaves no folder behind",
    async () => {
      const parent = root();
      const report = await runCrash({
        seed: "5eed",
        rounds: SLICE.length,
        kills: SLICE,
        roundsPerSpace: [SLICE.length, SLICE.length],
        root: parent,
      });
      expect(report.failure, JSON.stringify(report.failure)).toBeUndefined();
      expect(report.rounds).toBe(SLICE.length);
      // Every armed point was reached and killed at, and the last round ran to the end.
      for (const kill of SLICE) {
        if (kill.kind === "point")
          expect(report.ended[`${kill.arm.where}:${kill.arm.point}`]).toBe(1);
      }
      expect(report.notReached).toBe(0);
      expect(report.ended["none"]).toBe(1);
      expect(report.stats.migrations).toBeGreaterThan(0);
      expect(report.stats.restores).toBeGreaterThan(0);
      expect(report.stats.replays).toBeGreaterThan(0);
      // Agent actors joined through actor.register, as the service's request path adds them, and
      // the checker accounted for each commit.
      expect(report.stats.actors).toBeGreaterThan(0);
      expect(readdirSync(parent)).toEqual([]);
    },
    SLICE_TIMEOUT_MS,
  );
});

describe("[A1.5.crash.reports] a violation stops the run with its seed, round and invariant", () => {
  test(
    "a receipt lost between rounds is reported in that round, and the run still cleans up",
    async () => {
      const parent = root();
      const checked = await checkedDriver();
      const report = await runCrash({
        seed: "bad",
        rounds: 4,
        kills: [{ kind: "none" }, { kind: "none" }, { kind: "none" }, { kind: "none" }],
        roundsPerSpace: [4, 4],
        root: parent,
        afterRound: (round, folder) => {
          if (round !== 2) return;
          const conn = openWriter(checked, join(folder, DATABASE_FILE));
          try {
            conn.exec("DELETE FROM receipts");
          } finally {
            conn.close();
          }
        },
      });
      expect(report.seed).toBe("bad");
      expect(report.failure?.round).toBe(2);
      expect(report.failure?.kill).toBe("none");
      const invariants = new Set(report.failure?.violations.map((v) => v.invariant));
      expect([...invariants]).toEqual(
        expect.arrayContaining(["acked-present", "receipt-per-commit"]),
      );
      expect(report.rounds).toBe(2);
      expect(readdirSync(parent)).toEqual([]);
    },
    SLICE_TIMEOUT_MS,
  );

  test(
    "an error the child reports fails the round even when the kill at another thread's point follows",
    async () => {
      const parent = root();
      const report = await runCrash({
        seed: "e44",
        rounds: 1,
        kills: [at("write", "before-commit")],
        roundsPerSpace: [1, 1],
        root: parent,
        child: new URL("./error-child.ts", import.meta.url),
      });
      expect(report.failure?.round).toBe(1);
      expect(report.failure?.kill).toBe("write:before-commit #1");
      expect(report.failure?.violations).toEqual([
        { invariant: "child-failed", detail: "backup failed (BACKUP_FAILED)" },
      ]);
      expect(report.ended["write:before-commit"]).toBe(1);
      expect(readdirSync(parent)).toEqual([]);
    },
    SLICE_TIMEOUT_MS,
  );
});
