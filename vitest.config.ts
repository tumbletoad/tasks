import { availableParallelism } from "node:os";
import { relative } from "node:path";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { SLOW } from "./scripts/check-plan.ts";

/**
 * Every test file in the repository, so none can escape the manifest check. The two projects below
 * split exactly this set: "lab" takes spikes/, "product" takes the rest.
 */
export const testFiles = {
  include: ["**/*.test.{ts,tsx}"],
  exclude: ["**/node_modules/**", "**/dist/**", "planning/**", "local/**", ".claude/**"],
};

/** The M0 lab code (A7 3.7). Its self-tests start services, compile C and install archives. */
export const LAB_DIR = "spikes";

/**
 * At most eight test files at a time. Vitest's default takes every core, and on a development
 * machine several agents may run the suite at once: with all of them at full width, tests that start
 * real processes (the service, the crash harness, fake agents) missed their time limits. Eight
 * leaves room for a few runs side by side and costs a single run little. A small CI runner keeps
 * one core free.
 */
const MAX_WORKERS = Math.max(2, Math.min(8, availableParallelism() - 1));

// Tests never fall back to whatever a developer has in their environment. The setup file puts the
// test stand-ins first on PATH (Linux: systemd-run), so no test reaches the person's user manager.
export const SETUP_FILES = ["packages/testkit/src/setup.ts"];

const shared = {
  unstubEnvs: true,
  restoreMocks: true,
  maxWorkers: MAX_WORKERS,
  setupFiles: SETUP_FILES,
};

/**
 * Vitest starts the files that took longest last time first, and a file it has no time for by its
 * size. A new checkout has no times, and a slow file that starts late ends the run on its own, so
 * the files known to be slow start first until Vitest has their times.
 */
class SlowFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const rank = (spec: TestSpecification) => {
      if (this.ctx.cache.getTestSpecificationResult(spec) !== undefined) return -1;
      const path = relative(spec.project.config.root, spec.moduleId).replaceAll("\\", "/");
      return SLOW.findIndex((s) => s.test === path);
    };
    const slow = sorted.filter((spec) => rank(spec) >= 0).sort((a, b) => rank(a) - rank(b));
    return [...slow, ...sorted.filter((spec) => !slow.includes(spec))];
  }
}

export default defineConfig({
  test: {
    sequence: { sequencer: SlowFirst },
    projects: [
      {
        // Each project states its whole configuration, so nothing depends on how Vitest merges
        // a root include or exclude into an inline project.
        extends: false,
        test: {
          ...shared,
          name: "product",
          include: testFiles.include,
          exclude: [...testFiles.exclude, `${LAB_DIR}/**`],
          globalSetup: ["tests/run-builds-setup.ts"],
          // A time limit only ends a test that hangs: it says nothing about how fast the code is.
          // On a loaded machine, tests that take a second or two alone have taken more than 30 s
          // beside every other file. A test's own explicit timeout still wins: give one only to
          // a test that needs longer than this.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: false,
        test: {
          ...shared,
          name: "lab",
          include: testFiles.include.map((pattern) => `${LAB_DIR}/${pattern}`),
          exclude: testFiles.exclude,
          // One file at a time: the lab tests start processes, and under a parallel run on a
          // loaded CI runner they timed out (A7 3.3).
          fileParallelism: false,
          // A process-heavy default. A test's own explicit timeout still wins.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
