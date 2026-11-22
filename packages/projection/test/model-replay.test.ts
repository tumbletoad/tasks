// The projection model's counterexamples, and its fresh random runs (model.ts). The fixed seeds
// are in model-seed-*.test.ts.
import fc from "fast-check";
import { describe, test } from "vitest";
import { INVARIANTS, property, run, SUITE, type Action } from "./model.ts";

/**
 * Fresh random runs. A defect seen once in about 800 runs passed 20 runs in most checks: finding
 * such a one is a soak's work, which the nightly deep job does (TTASKS_DEEP=1: 2,000 runs on each
 * system). A pull request that changes the projection gets 50 (scripts/verify.ts), any other
 * none. PROJECTION_MODEL_RUNS sets the number.
 */
const RUNS = Number(
  process.env["PROJECTION_MODEL_RUNS"] ?? (process.env["TTASKS_DEEP"] === "1" ? "2000" : "0"),
);
/** The deep job's soak stops at this, a pass for the runs it made. */
const SOAK_MS = 40 * 60_000;

const quietRun = {
  kind: "run",
  steps: 1,
  killAt: null,
  during: "none",
  leftover: false,
  hold: null,
  fault: null,
} as const;

/** Sequences random runs once failed, kept as they shrank: each runs on every check. */
const COUNTEREXAMPLES: (readonly Action[])[] = [
  // Windows: a task renamed, its old file held open while the batch retires it; once let go, it
  // was left in the folder for good.
  [
    { kind: "rename", pick: 1437316263 },
    { ...quietRun, steps: 2, hold: 1919241737 },
    { kind: "elsewhere", which: 0 },
    { kind: "create", squat: false },
    { kind: "edit", pick: 0, how: "write" },
    { kind: "create", squat: false },
  ],
  // Windows: the same with a completed task reopened, so its file moves to open/.
  [
    { kind: "reopen", pick: 9 },
    { ...quietRun, steps: 2, hold: 786592087 },
    quietRun,
    { kind: "create", squat: false },
    { kind: "rename", pick: 0 },
    { kind: "restart", killAt: null },
  ],
  // Linux: a file where completed/ was, then the person's look at completed/2026 below it.
  [
    { kind: "folder-file", which: 1 },
    { kind: "folder-file", which: 2 },
    { kind: "rest" },
    { kind: "create", squat: false },
  ],
];

describe(SUITE, () => {
  test(
    `${INVARIANTS}: the counterexamples, then fresh random runs`,
    async () => {
      // A counterexample replays alone: PROJECTION_MODEL_SEED and PROJECTION_MODEL_PATH from its
      // report.
      const replay = process.env["PROJECTION_MODEL_SEED"];
      if (replay !== undefined) {
        const path = process.env["PROJECTION_MODEL_PATH"];
        await fc.assert(property, {
          seed: Number(replay),
          numRuns: RUNS > 0 ? RUNS : 50,
          ...(path === undefined ? {} : { path, endOnFailure: true }),
          verbose: fc.VerbosityLevel.VeryVerbose,
        });
        return;
      }
      for (const actions of COUNTEREXAMPLES) await run(actions);
      if (RUNS > 0) {
        await fc.assert(property, {
          numRuns: RUNS,
          interruptAfterTimeLimit: SOAK_MS,
          markInterruptAsFailure: false,
        });
      }
    },
    600_000 + Math.min(RUNS * 2_000, SOAK_MS),
  );
});
