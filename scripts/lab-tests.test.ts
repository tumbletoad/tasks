import { describe, expect, test } from "vitest";
import vitestConfig, { LAB_DIR, testFiles } from "../vitest.config.ts";
import {
  changedSince,
  decideLab,
  findBase,
  findBaseCommit,
  isLabPath,
  parseVerifyArgs,
  type Base,
  type Git,
} from "./lab-tests.ts";

const base =
  (changed: string[], label = "origin/main (merge base abc)") =>
  (): Base => ({
    found: true,
    label,
    changed,
  });
const noGit = (): Base => {
  throw new Error("the base must not be looked up");
};

/** A fake git: answers by the joined argument list, null (failure) for anything else. */
const fakeGit =
  (answers: Record<string, string>): Git =>
  (args) =>
    answers[args.join(" ")] ?? null;

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("[A7.3.3.verify.lab-selection] pnpm verify's choice to run the lab tests", () => {
  test("lab paths: spikes/ and the shared files the lab tests depend on", () => {
    for (const p of [
      "spikes/m0/kit/kit.ts",
      "spikes/m0/README.md",
      "vitest.config.ts",
      "packages/testkit/src/setup.ts",
      "packages/testkit/stand-ins/systemd-run",
      "scripts/verify.ts",
      "scripts/lab-tests.ts",
      "scripts/run.ts",
      "scripts/manifest.ts",
      "scripts/generated.ts",
      "tsconfig.json",
      "tsconfig.base.json",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".node-version",
      "LICENSE",
      "NOTICE",
      ".github/workflows/check.yml",
      ".github/workflows/m0-packaging.yml",
      "tests/stream-content.ts",
      "tests/stream-schema.ts",
      "spikes\\m0\\kit\\kit.ts",
    ]) {
      expect(isLabPath(p), p).toBe(true);
    }
    for (const p of [
      "packages/brand/src/index.ts",
      "packages/brand/package.json",
      "packages/brand/LICENSE",
      "packages/testkit/src/mira.ts",
      "packages/storage/tsconfig.json",
      "scripts/lab-tests.test.ts",
      "scripts/eslint/no-shell-exec.js",
      "docs/vision.md",
      "docs/laboratory.md",
      "docs/protocol/ttasks-local-1.md",
      "planning/STATUS.md",
      "tests/manifest.json",
      "README.md",
      "spikes-notes.md",
      ".github/workflows/e2e.yml",
      ".github/workflows/build.yml",
    ]) {
      expect(isLabPath(p), p).toBe(false);
    }
  });

  test("--lab and TTASKS_VERIFY_LAB=1 run the lab tests without looking at git", () => {
    expect(decideLab({ lab: true }, {}, noGit)).toEqual({
      run: true,
      reason: "lab tests run: --lab was given",
    });
    expect(decideLab({ lab: false }, { TTASKS_VERIFY_LAB: "1" }, noGit)).toEqual({
      run: true,
      reason: "lab tests run: TTASKS_VERIFY_LAB=1 is set",
    });
  });

  test("only TTASKS_VERIFY_LAB=1 forces them, other values leave the rule to the changes", () => {
    for (const value of ["0", "", "true", "yes"]) {
      expect(decideLab({ lab: false }, { TTASKS_VERIFY_LAB: value }, base([])).run, value).toBe(
        false,
      );
    }
  });

  test("a product-only change skips them and says so in one line naming the base", () => {
    const d = decideLab(
      { lab: false },
      {},
      base(["packages/brand/src/index.ts", "planning/STATUS.md"]),
    );
    expect(d).toEqual({
      run: false,
      reason: "lab tests skipped: no lab files changed since origin/main (merge base abc)",
    });
    expect(decideLab({ lab: false }, {}, base([])).run).toBe(false);
  });

  test("a lab or shared-file change runs them and names the files", () => {
    const d = decideLab(
      { lab: false },
      {},
      base(["packages/brand/src/index.ts", "spikes/m0/kit/kit.ts", "package.json"]),
    );
    expect(d.run).toBe(true);
    expect(d.reason).toBe(
      "lab tests run: 2 lab file(s) changed since origin/main (merge base abc): " +
        "package.json, spikes/m0/kit/kit.ts",
    );
    const many = Array.from({ length: 8 }, (_, i) => `spikes/f${String(i)}.ts`);
    expect(decideLab({ lab: false }, {}, base(many)).reason).toMatch(/: 8 lab file.* and 3 more$/);
  });

  test("an unknown base runs them (fail safe) and says why", () => {
    expect(
      decideLab({ lab: false }, {}, () => ({ found: false, why: "there is no origin/main" })),
    ).toEqual({
      run: true,
      reason: "lab tests run: the base could not be determined (there is no origin/main)",
    });
  });

  test("verify accepts --lab, --part, --shard and a bare --, and refuses any other argument", () => {
    expect(parseVerifyArgs([])).toEqual({ lab: false, part: null, shard: null });
    expect(parseVerifyArgs(["--", "--lab"])).toEqual({ lab: true, part: null, shard: null });
    expect(parseVerifyArgs(["--part", "checks"])).toEqual({
      lab: false,
      part: "checks",
      shard: null,
    });
    expect(parseVerifyArgs(["--part", "product", "--shard", "2/4"])).toEqual({
      lab: false,
      part: "product",
      shard: "2/4",
    });
    expect(parseVerifyArgs(["--shard", "3/3", "--part", "lab"])).toEqual({
      lab: false,
      part: "lab",
      shard: "3/3",
    });
    expect(() => parseVerifyArgs(["--lba"])).toThrow(/unknown argument "--lba"/);
    expect(() => parseVerifyArgs(["--part", "tests"])).toThrow(/--part takes one of/);
    expect(() => parseVerifyArgs(["--part"])).toThrow(/--part takes one of/);
    for (const shard of ["0/4", "5/4", "1", "1/4x"]) {
      expect(() => parseVerifyArgs(["--part", "product", "--shard", shard])).toThrow(
        /--shard takes/,
      );
    }
    expect(() => parseVerifyArgs(["--shard", "1/2"])).toThrow(/--shard needs --part product/);
    expect(() => parseVerifyArgs(["--part", "checks", "--shard", "1/2"])).toThrow(/--shard needs/);
    // A wrapper that appends its own option must not silently replace the one it was given.
    expect(() => parseVerifyArgs(["--part", "product", "--part", "checks"])).toThrow(
      /--part is given twice: product and checks/,
    );
    expect(() => parseVerifyArgs(["--part", "lab", "--shard", "1/3", "--shard", "2/3"])).toThrow(
      /--shard is given twice: 1\/3 and 2\/3/,
    );
    expect(
      parseVerifyArgs(["--part", "lab", "--part", "lab", "--shard", "1/3", "--shard", "1/3"]),
    ).toEqual({ lab: false, part: "lab", shard: "1/3" });
  });

  test("locally the base is the merge base with origin/main", () => {
    const git = fakeGit({
      "rev-parse --verify --quiet origin/main^{commit}": `${A}\n`,
      "merge-base origin/main HEAD": `${B}\n`,
    });
    expect(findBaseCommit({}, git)).toEqual({
      sha: B,
      label: `origin/main (merge base ${B.slice(0, 12)})`,
    });
    expect(findBaseCommit({}, fakeGit({}))).toEqual({ why: "there is no origin/main" });
  });

  test("TTASKS_VERIFY_BASE names the base, and a bad one is an unknown base", () => {
    const git = fakeGit({ "rev-parse --verify --quiet HEAD~1^{commit}": `${C}\n` });
    expect(findBaseCommit({ TTASKS_VERIFY_BASE: "HEAD~1" }, git)).toEqual({
      sha: C,
      label: `HEAD~1 (${C.slice(0, 12)}, from TTASKS_VERIFY_BASE)`,
    });
    expect(findBaseCommit({ TTASKS_VERIFY_BASE: "nope" }, git)).toEqual({
      why: "TTASKS_VERIFY_BASE=nope names no commit here",
    });
    // In CI the override is refused, so a stray or inherited value can never skip the lab tests.
    for (const ci of [{ GITHUB_ACTIONS: "true" }, { CI: "true" }, { CI: "1" }]) {
      const base = findBaseCommit({ ...ci, TTASKS_VERIFY_BASE: "HEAD~1" }, git);
      expect(base).toEqual({ why: "TTASKS_VERIFY_BASE is set, and CI does not honour it" });
      const why = "why" in base ? base.why : "";
      expect(decideLab({ lab: false }, {}, () => ({ found: false, why })).run).toBe(true);
    }
  });

  test("in a pull request the base is the merge commit's first parent", () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request" };
    const merge = fakeGit({ "rev-list --parents -n 1 HEAD": `${C} ${A} ${B}\n` });
    expect(findBaseCommit(env, merge)).toEqual({
      sha: A,
      label: `the pull request's base ${A.slice(0, 12)}`,
    });
    // Not a merge commit: the event's base SHA, when that commit is present.
    const event = JSON.stringify({ pull_request: { base: { sha: B } } });
    const withEvent = { ...env, GITHUB_EVENT_PATH: "event.json" };
    const single = fakeGit({
      "rev-list --parents -n 1 HEAD": `${C} ${A}\n`,
      [`rev-parse --verify --quiet ${B}^{commit}`]: `${B}\n`,
    });
    expect(findBaseCommit(withEvent, single, () => event)).toEqual({
      sha: B,
      label: `the pull request's base ${B.slice(0, 12)}`,
    });
    const shallow = fakeGit({ "rev-list --parents -n 1 HEAD": `${C}\n` });
    expect(findBaseCommit(withEvent, shallow, () => event)).toEqual({
      why: "HEAD is not a merge commit and the event's base commit is not fetched",
    });
  });

  test("on a push the base is the event's previous commit, and other events have no base", () => {
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: "event.json",
    };
    const present = fakeGit({
      "rev-list --parents -n 1 HEAD": `${C} ${B}\n`,
      [`rev-parse --verify --quiet ${A}^{commit}`]: `${A}\n`,
    });
    // A, then B (a lab change) and C pushed together: the base is A, not C's parent B.
    expect(findBaseCommit(env, present, () => JSON.stringify({ before: A }))).toEqual({
      sha: A,
      label: `the push's previous commit ${A.slice(0, 12)}`,
    });
    // The previous commit is outside the shallow checkout: unknown, so the lab tests run.
    const shallow = fakeGit({ "rev-list --parents -n 1 HEAD": `${C} ${B}\n` });
    expect(findBaseCommit(env, shallow, () => JSON.stringify({ before: A }))).toEqual({
      why: `the push's previous commit ${A.slice(0, 12)} is not in this checkout`,
    });
    // A new ref (all zeros), a missing field, a malformed event and no event file.
    for (const event of [JSON.stringify({ before: "0".repeat(40) }), "{}", "not json"]) {
      expect(findBaseCommit(env, present, () => event)).toEqual({
        why: "the push event names no previous commit",
      });
    }
    expect(findBaseCommit({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" }, present)).toEqual({
      why: "the push event names no previous commit",
    });
    expect(
      findBaseCommit({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "schedule" }, fakeGit({})),
    ).toEqual({ why: 'GitHub event "schedule" has no rule' });
  });

  test("changes are the diff against the base plus untracked files", () => {
    const git = fakeGit({
      [`diff --name-only --no-renames -z ${A} --`]: "packages/brand/a.ts\0spikes/x.ts\0",
      "ls-files --others --exclude-standard -z": "docs/new.md\0",
    });
    expect(changedSince(git, A)).toEqual(["packages/brand/a.ts", "spikes/x.ts", "docs/new.md"]);
    expect(changedSince(fakeGit({}), A)).toBeNull();
    const env = { TTASKS_VERIFY_BASE: "x" };
    expect(
      findBase(env, (args) =>
        args[0] === "rev-parse" ? `${A}\n` : args[0] === "diff" ? null : "",
      ),
    ).toEqual({
      found: false,
      why: `git diff against x (${A.slice(0, 12)}, from TTASKS_VERIFY_BASE) failed`,
    });
  });

  test("the lab project holds spikes/ and runs one file at a time, the product project the rest", () => {
    const projects = (vitestConfig.test?.projects ?? []) as {
      test?: {
        name?: string;
        include?: string[];
        exclude?: string[];
        fileParallelism?: boolean;
        testTimeout?: number;
      };
    }[];
    const byName = new Map(projects.map((p) => [p.test?.name, p.test]));
    expect([...byName.keys()]).toEqual(["product", "lab"]);
    expect(byName.get("product")?.include).toEqual(testFiles.include);
    expect(byName.get("product")?.exclude).toEqual([...testFiles.exclude, `${LAB_DIR}/**`]);
    expect(byName.get("lab")?.include).toEqual(testFiles.include.map((p) => `${LAB_DIR}/${p}`));
    expect(byName.get("lab")?.fileParallelism).toBe(false);
    expect(byName.get("lab")?.testTimeout).toBeGreaterThanOrEqual(120_000);
    expect(isLabPath(`${LAB_DIR}/any.test.ts`)).toBe(true);
  });
});
