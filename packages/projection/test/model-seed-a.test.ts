// The projection model (model.ts) on a fixed seed: 40 runs of seed 20261114, which must reach each
// kind of trouble often. The other fixed seed is in model-seed-b.test.ts, the counterexamples and
// the random runs in model-replay.test.ts.
import { describe, test } from "vitest";
import { fixedSeed, INVARIANTS, SUITE } from "./model.ts";

/**
 * About 0.6 of the fewest this seed reaches on Windows or on Linux, the same margin as the old
 * 80-run seed's: a change that makes a kind of trouble rare in the model fails here. A file can be
 * held open without sharing only on Windows.
 */
const LEAST = {
  kills: 19,
  during: 9,
  hardlinks: 7,
  folders: 4,
  swaps: 3,
  rescued: 66,
  rests: 7,
  leftovers: 2,
  sameSize: 13,
  editorSaves: 13,
  faults: 13,
  shortWrites: 67,
  refused: 7,
  holds: process.platform === "win32" ? 5 : -1,
};

describe(SUITE, () => {
  test(`${INVARIANTS}: seed 20261114`, () => fixedSeed(20261114, 40, LEAST), 600_000);
});
