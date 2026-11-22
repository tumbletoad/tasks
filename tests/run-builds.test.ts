// The run's shared builds (tests/run-builds.ts): a build in use is never removed or built again.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { builtOnceIn } from "./run-builds.ts";

const runs: string[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) rmSync(run, { recursive: true, force: true });
});

describe("[A7.3.3.run-builds.once] the test run's shared builds", () => {
  test("a caller that takes the lock after the first builder published gets that build, and its folder stays", async () => {
    const run = mkdtempSync(join(tmpdir(), "ttasks-run-builds-test-"));
    runs.push(run);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = builtOnceIn(run, "thing", async (dir) => {
      writeFileSync(join(dir, "made"), "first");
      await held;
      return { by: "first", file: join(dir, "made") };
    });
    let built = 0;
    const second = builtOnceIn(
      run,
      "thing",
      () => {
        built += 1;
        return { by: "second", file: "" };
      },
      {
        // The second looked while the first still built; the first now publishes and lets go of
        // the lock before the second tries it.
        looked: async () => {
          release();
          await first;
        },
      },
    );
    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    expect(built).toBe(0);
    expect(existsSync(a.file)).toBe(true);
  });

  test("a build that failed is built by the next caller", async () => {
    const run = mkdtempSync(join(tmpdir(), "ttasks-run-builds-test-"));
    runs.push(run);
    await expect(
      builtOnceIn(run, "thing", () => {
        throw new Error("no compiler");
      }),
    ).rejects.toThrow("no compiler");
    expect(await builtOnceIn(run, "thing", () => ({ by: "next" }))).toEqual({ by: "next" });
  });
});
