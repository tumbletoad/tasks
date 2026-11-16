import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

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
const shared = {
  unstubEnvs: true,
  restoreMocks: true,
  maxWorkers: MAX_WORKERS,
  setupFiles: ["packages/testkit/src/setup.ts"],
};

export default defineConfig({
  test: {
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
