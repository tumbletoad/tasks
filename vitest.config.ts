import { availableParallelism } from "node:os";
import { relative } from "node:path";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { SLOW } from "./scripts/check-plan.ts";

/** Every test file in the repository, so none can escape the manifest check. */
export const testFiles = {
  include: ["**/*.test.{ts,tsx}"],
  exclude: ["**/node_modules/**", "**/dist/**", "local/**", ".claude/**"],
};

/**
 * Half the threads, at most sixteen, and never fewer than the older cap of eight (or every core
 * but one, on a smaller machine). Vitest's default takes every core, and on a development machine
 * several agents may run the suite at once: at full width, tests that start real processes (the
 * service, the crash harness, fake agents) missed their time limits. Measured on a 32-thread
 * desktop: 16 passed alone and with three full runs side by side. A machine of 9 to 17 threads
 * keeps the eight of before, which nobody ran wider; a 4-core CI runner gets 3.
 */
const threads = availableParallelism();
const MAX_WORKERS = Math.max(2, Math.min(8, threads - 1), Math.min(16, Math.floor(threads / 2)));

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
          exclude: testFiles.exclude,
          globalSetup: ["tests/run-builds-setup.ts"],
          // A time limit only ends a test that hangs: it says nothing about how fast the code is.
          // On a loaded machine, tests that take a second or two alone have taken more than 30 s
          // beside every other file. A test's own explicit timeout still wins: give one only to
          // a test that needs longer than this.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
