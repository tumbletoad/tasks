// The projection model (model.ts) on a fixed seed: 40 runs of seed 20261124, which must reach each
// kind of trouble often. The other fixed seed is in model-seed-a.test.ts, the counterexamples and
// the random runs in model-replay.test.ts.
import { describe, test } from "vitest";
import { fixedSeed, INVARIANTS, SUITE } from "./model.ts";

/**
 * About 0.6 of the fewest this seed reaches on Windows or on Linux, the same margin as the old
 * 80-run seed's: a change that makes a kind of trouble rare in the model fails here. A file can be
 * held open without sharing only on Windows.
 */
const LEAST = {
  kills: 21,
  during: 7,
  hardlinks: 6,
  folders: 7,
  swaps: 7,
  rescued: 64,
  rests: 30,
  leftovers: 3,
  sameSize: 15,
  editorSaves: 16,
  faults: 13,
  shortWrites: 73,
  refused: 6,
  holds: process.platform === "win32" ? 5 : -1,
};

describe(SUITE, () => {
  test(`${INVARIANTS}: seed 20261124`, () => fixedSeed(20261124, 40, LEAST), 600_000);
});
