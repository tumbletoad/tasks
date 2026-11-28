// pnpm seed with a fixed seed gives the same space twice.
// Runs the script itself, twice, into fresh folders, and compares the content digests
// with each other and with the known sample's, which CI asserts on Windows and Ubuntu.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FIXED_SAMPLE } from "../packages/testkit/src/known.ts";
import { MAX_TASKS } from "../packages/testkit/src/mira.ts";
import { repoRoot } from "./run.ts";

const made: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "seed-"));
  made.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const seed = (args: string[]) =>
  spawnSync(process.execPath, [join(repoRoot, "scripts", "seed.ts"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });

const digestOf = (stdout: string): string | undefined =>
  /^digest: ([0-9a-f]{64})$/m.exec(stdout)?.[1];

describe("[A7.3.3.seed.deterministic] pnpm seed", () => {
  test("with a fixed seed it gives the same space twice", () => {
    const { seed: fixed, tasks, digest } = FIXED_SAMPLE;
    const digests = [temp(), temp()].map((out) => {
      const result = seed(["--out", out, "--seed", fixed, "--tasks", String(tasks)]);
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(out)).toEqual(["mira"]);
      return digestOf(result.stdout);
    });
    expect(digests).toEqual([digest, digest]);
  });

  test("makes the --out folder when it is not there", () => {
    const out = join(temp(), "new", "folder");
    const result = seed(["--out", out, "--tasks", "1"]);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(out)).toEqual(["mira"]);
  });

  test("builds the largest size it accepts", () => {
    // The reviewer's case: --seed fixed --tasks 2000 failed on a duplicate source key.
    const out = temp();
    const result = seed(["--out", out, "--seed", "fixed", "--tasks", String(MAX_TASKS)]);
    expect(result.status, result.stderr).toBe(0);
    expect(digestOf(result.stdout)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses bad options and an existing space, naming no path", () => {
    const out = temp();
    for (const args of [
      [],
      ["--out", out, "--tasks", "0"],
      ["--out", out, "--tasks", "many"],
      ["--out", out, "--tasks", "2001"],
      ["--out", out, "--colour", "red"],
    ]) {
      expect(seed(args).status, args.join(" ")).toBe(2);
    }
    expect(readdirSync(out)).toEqual([]);
    expect(seed(["--out", out, "--tasks", "1"]).status).toBe(0);
    const again = seed(["--out", out, "--tasks", "1"]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("SPACE_EXISTS");
    expect(again.stderr).not.toContain(out);
  });
});
