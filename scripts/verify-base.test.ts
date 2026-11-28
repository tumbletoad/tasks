import { describe, expect, test } from "vitest";
import {
  changedSince,
  findBase,
  findBaseCommit,
  isProjectionPath,
  projectionFolders,
  parseVerifyArgs,
  type Git,
} from "./verify-base.ts";

/** A fake git: answers by the joined argument list, null (failure) for anything else. */
const fakeGit =
  (answers: Record<string, string>): Git =>
  (args) =>
    answers[args.join(" ")] ?? null;

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("[A7.3.3.verify.base] the base pnpm verify judges a change against", () => {
  test("the projection package and the workspace packages its package.json names give the projection model its random runs", () => {
    const folders = projectionFolders();
    expect(folders).toEqual(
      expect.arrayContaining(["packages/projection/", "packages/storage/", "packages/testkit/"]),
    );
    expect(folders).not.toContain("packages/web/");
    expect(isProjectionPath("packages/projection/src/projector.ts", folders)).toBe(true);
    expect(isProjectionPath("packages/projection/test/model.ts", folders)).toBe(true);
    expect(isProjectionPath(String.raw`packages\storage\src\writer.ts`, folders)).toBe(true);
    expect(isProjectionPath("./packages/projection/package.json", folders)).toBe(true);
    expect(isProjectionPath("packages/web/src/app.tsx", folders)).toBe(false);
    expect(isProjectionPath("packages/projection-extra/x.ts", folders)).toBe(false);
  });

  test("verify accepts --part, --shard and a bare --, and refuses any other argument", () => {
    expect(parseVerifyArgs([])).toEqual({ part: null, shard: null });
    expect(parseVerifyArgs(["--", "--part", "checks"])).toEqual({ part: "checks", shard: null });
    expect(parseVerifyArgs(["--part", "product", "--shard", "2/4"])).toEqual({
      part: "product",
      shard: "2/4",
    });
    expect(parseVerifyArgs(["--shard", "3/3", "--part", "product"])).toEqual({
      part: "product",
      shard: "3/3",
    });
    expect(() => parseVerifyArgs(["--lab"])).toThrow(/unknown argument "--lab"/);
    expect(() => parseVerifyArgs(["--part", "lab"])).toThrow(/--part takes one of/);
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
    expect(() =>
      parseVerifyArgs(["--part", "product", "--shard", "1/3", "--shard", "2/3"]),
    ).toThrow(/--shard is given twice: 1\/3 and 2\/3/);
    expect(
      parseVerifyArgs([
        "--part",
        "product",
        "--part",
        "product",
        "--shard",
        "1/3",
        "--shard",
        "1/3",
      ]),
    ).toEqual({ part: "product", shard: "1/3" });
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
    // In CI the override is refused, so a stray or inherited value never narrows what runs.
    for (const ci of [{ GITHUB_ACTIONS: "true" }, { CI: "true" }, { CI: "1" }]) {
      expect(findBaseCommit({ ...ci, TTASKS_VERIFY_BASE: "HEAD~1" }, git)).toEqual({
        why: "TTASKS_VERIFY_BASE is set, and CI does not honour it",
      });
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
    // A, then B and C pushed together: the base is A, not C's parent B.
    expect(findBaseCommit(env, present, () => JSON.stringify({ before: A }))).toEqual({
      sha: A,
      label: `the push's previous commit ${A.slice(0, 12)}`,
    });
    // The previous commit is outside the shallow checkout: no base.
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
      [`diff --name-only --no-renames -z ${A} --`]: "packages/brand/a.ts\0scripts/x.ts\0",
      "ls-files --others --exclude-standard -z": "docs/new.md\0",
    });
    expect(changedSince(git, A)).toEqual(["packages/brand/a.ts", "scripts/x.ts", "docs/new.md"]);
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
});
