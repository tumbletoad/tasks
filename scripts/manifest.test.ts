import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { testFiles } from "../vitest.config.ts";
import {
  checkIdsQuickly,
  checkManifest,
  checkTestFiles,
  describeError,
  idsInTitle,
  parseManifest,
  testLikeFiles,
  type CollectedTest,
} from "./manifest.ts";
import { repoRoot } from "./run.ts";

async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ttasks-manifest-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const entry = (id: string, kind = "ci") => ({
  id,
  title: "An entry",
  source: "A7 3.18.6",
  owner: "M0",
  kind,
  profiles: ["v1"],
});

const run = (entries: unknown[], tests: CollectedTest[]) => {
  const parsed = parseManifest({ version: 1, entries });
  return [...parsed.errors, ...checkManifest(parsed.entries, tests)];
};

describe("[A7.3.18.6.manifest-check] the test-manifest check", () => {
  test("reads IDs from bracketed tags anywhere in the full test name", () => {
    expect(idsInTitle("[A1.5.receipts.noop-retry] replays the receipt")).toEqual([
      "A1.5.receipts.noop-retry",
    ]);
    expect(idsInTitle("[A7.suite] suite > [A7.suite.case] case")).toEqual([
      "A7.suite",
      "A7.suite.case",
    ]);
    expect(idsInTitle("no tag here")).toEqual([]);
    expect(idsInTitle("[not an id] text")).toEqual([]);
  });

  test("passes when every test carries a known ID and every ci entry has a test", () => {
    const errors = run(
      [entry("A7.one"), entry("A7.two", "manual")],
      [{ name: "[A7.one] does a thing", file: "a.test.ts" }],
    );
    expect(errors).toEqual([]);
  });

  test("accepts an ID carried by an enclosing suite", () => {
    const errors = run(
      [entry("A7.suite")],
      [
        { name: "[A7.suite] suite > first", file: "a.test.ts" },
        { name: "[A7.suite] suite > second", file: "a.test.ts" },
      ],
    );
    expect(errors).toEqual([]);
  });

  test("fails on a test without an ID", () => {
    const errors = run(
      [entry("A7.one")],
      [
        { name: "[A7.one] tagged", file: "a.test.ts" },
        { name: "untagged", file: "b.test.ts", line: 3 },
      ],
    );
    expect(errors).toEqual([
      expect.stringContaining('b.test.ts:3 "untagged" carries no manifest ID'),
    ]);
  });

  test("fails on an ID that is not in the manifest", () => {
    const errors = run(
      [entry("A7.one")],
      [
        { name: "[A7.one] tagged", file: "a.test.ts" },
        { name: "[A7.ghost] unknown", file: "a.test.ts" },
      ],
    );
    expect(errors).toEqual([expect.stringContaining('unknown manifest ID "A7.ghost"')]);
  });

  test("fails on a ci or installed entry without a test, but not on a manual one", () => {
    const errors = run(
      [entry("A7.ci"), entry("A7.installed", "installed"), entry("A7.manual", "manual")],
      [],
    );
    expect(errors).toEqual([
      expect.stringContaining('"A7.ci" (ci) has no test'),
      expect.stringContaining('"A7.installed" (installed) has no test'),
    ]);
  });

  test("fails on duplicate IDs", () => {
    const errors = run([entry("A7.one"), entry("A7.one")], [{ name: "[A7.one] x", file: "a" }]);
    expect(errors).toEqual([expect.stringContaining('duplicate ID "A7.one"')]);
  });

  test("fails on malformed entries", () => {
    const errors = run(
      [
        { ...entry("lower.case") },
        { ...entry("A7.kind"), kind: "sometimes" },
        { ...entry("A7.owner"), owner: "later" },
        { ...entry("A7.profile"), profiles: ["v2"] },
        { ...entry("A7.source"), source: 3 },
      ],
      [],
    );
    expect(errors).toHaveLength(5);
    expect(errors.join("\n")).toMatch(/invalid ID "lower\.case"/);
    expect(errors.join("\n")).toMatch(/A7\.kind.*kind/);
    expect(errors.join("\n")).toMatch(/A7\.owner.*owner/);
    expect(errors.join("\n")).toMatch(/A7\.profile.*profile/);
    expect(errors.join("\n")).toMatch(/A7\.source.*source/);
  });

  test("takes an entry without a source, or with any text there", () => {
    const bare: Record<string, unknown> = { ...entry("A7.bare") };
    delete bare["source"];
    const errors = run(
      [bare, { ...entry("A7.free"), source: "" }],
      [{ name: "[A7.bare] [A7.free] x", file: "a.test.ts" }],
    );
    expect(errors).toEqual([]);
  });

  test("fails on a manifest that is not the expected shape", () => {
    expect(parseManifest([]).errors).not.toEqual([]);
    expect(parseManifest({ version: 2, entries: [] }).errors).not.toEqual([]);
  });

  test("renders any error without throwing", () => {
    // A serialized error as Vitest hands it over: no prototype, so no toString.
    const bare: unknown = Object.assign(Object.create(null) as object, { message: "bare message" });
    expect(() => String(bare)).toThrow(TypeError);
    expect(describeError(bare)).toBe("bare message");
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError({ stack: "Error: from stack\n    at x" })).toBe("Error: from stack");
    expect(describeError("text")).toBe("text");
    expect(describeError({ code: 7 })).toBe('{"code":7}');
    const hostile = {
      get message(): string {
        throw new Error("getter");
      },
      toString(): string {
        throw new Error("toString");
      },
      toJSON(): string {
        throw new Error("toJSON");
      },
    };
    expect(describeError(hostile)).toBe("unknown error (it could not be rendered)");
    expect(describeError(Object.create(null))).toBe("unknown error (it could not be rendered)");
    expect(describeError(undefined)).toBe("undefined");
  });

  test("finds test-like file names outside the ignored folders", async () => {
    const root = await writeTree({
      "a/ok.test.ts": "",
      "a/ok.test.tsx": "",
      "a/b.spec.ts": "",
      "a/c.test.js": "",
      "a/d.test.mjs": "",
      "a/e.spec.cts": "",
      "a/f.test.jsx": "",
      "a/__tests__/g.ts": "",
      "a/__tests__/data.json": "",
      "a/__snapshots__/ok.test.ts.snap": "",
      "a/plain.ts": "",
      "a/latest.ts": "",
      "node_modules/x/h.spec.ts": "",
      "a/node_modules/x/h.test.js": "",
      "a/dist/h.test.js": "",
      "coverage/h.spec.ts": "",
      "local/notes/h.spec.ts": "",
      ".claude/worktrees/x/h.spec.ts": "",
    });
    try {
      const found = testLikeFiles(root);
      expect(found).toEqual([
        "a/__tests__/g.ts",
        "a/b.spec.ts",
        "a/c.test.js",
        "a/d.test.mjs",
        "a/e.spec.cts",
        "a/f.test.jsx",
        "a/ok.test.ts",
        "a/ok.test.tsx",
      ]);
      const problems = checkTestFiles(found, ["a/ok.test.ts", "a/ok.test.tsx"]);
      expect(problems.map((p) => p.slice(0, p.indexOf(" ")))).toEqual([
        "a/__tests__/g.ts",
        "a/b.spec.ts",
        "a/c.test.js",
        "a/d.test.mjs",
        "a/e.spec.cts",
        "a/f.test.jsx",
      ]);
      for (const p of problems) {
        expect(p).toMatch(/ looks like a test file, but Vitest does not run it\. /);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the quick check names a test it did not run whose ID the manifest no longer holds", async () => {
    // The state a merge of main can leave: main's test file stays, and the branch took its entry
    // out. The change does not reach the file, so pnpm check does not run it.
    const { include, exclude } = testFiles;
    const root = await writeTree({
      "vitest.config.mjs": `export default ${JSON.stringify({ test: { include, exclude, globals: true } })};\n`,
      "tests/manifest.json": JSON.stringify({ version: 1, entries: [entry("A7.one")] }),
      "a/kept.test.ts":
        'describe("[A7.gone] kept by the merge", () => {\n  test("still here", () => {});\n});\n',
      "a/ran.test.ts": 'test("[A7.one] ran", () => {});\n',
      // A title built as its file runs: the source shows no ID, which is not a problem here.
      "a/built.test.ts": 'const n = "[A7.one]";\ntest(`${n} built`, () => {});\n',
    });
    try {
      const ran = [{ name: "[A7.one] ran", file: "a/ran.test.ts", line: 1 }];
      const { errors } = await checkIdsQuickly(ran, root);
      expect(errors).toEqual([
        'a/kept.test.ts:2 "[A7.gone] kept by the merge > still here" carries unknown manifest ID "A7.gone"',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("the check fails on stray test files, untagged skipped and todo tests, and .only", async () => {
    // A small tree checked by the real script with the repository's include and exclude (the union
    // of the product and lab projects).
    // Test files use Vitest globals, so they need no vitest package next to them.
    // The script exits 1, and its stderr holds exactly the problems, one per line.
    const { include, exclude } = testFiles;
    const root = await writeTree({
      "vitest.config.mjs": `export default ${JSON.stringify({ test: { include, exclude, globals: true } })};\n`,
      "tests/manifest.json": JSON.stringify({
        version: 1,
        entries: [{ ...entry("A7.one"), title: "One" }],
      }),
      "a/good.test.ts": 'describe("[A7.one] suite", () => {\n  test("runs", () => {});\n});\n',
      "a/skipped.test.ts":
        'test.skip("skipped untagged", () => {});\ntest.todo("todo untagged");\n' +
        'test.skipIf(true)("[A7.one] skipped but tagged", () => {});\n',
      "a/focus.test.ts":
        'test.only("[A7.one] focused", () => {});\ntest("[A7.one] other", () => {});\n',
      // A title built at run time, and a call that a static parser would mistake for a test.
      "a/generated.test.ts":
        'const n = "built";\nconst testHelper = (x) => x;\ntestHelper(n);\n' +
        'test(`title ${n}`, () => {});\ntest.each([1])("[A7.one] case %i", () => {});\n',
      "a/stray.spec.ts": 'test("fails but never runs", () => {\n  throw new Error("x");\n});\n',
      // Vitest reports this as a serialized error, which String() cannot render.
      "a/unhandled.test.ts":
        'void Promise.reject(Error("fixture unhandled"));\ntest("[A7.one] still collected", () => {});\n',
      "a/old.test.js": 'test("never runs", () => {});\n',
      "a/__tests__/helper.ts": "export const h = 1;\n",
      "dist/built.test.js": "",
    });
    try {
      const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "manifest.ts"), root], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
        timeout: 120_000,
      });
      const lines = result.stderr
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "")
        .sort();
      // Vitest may add its own follow-up to an unhandled error ("Closing rpc while ... was
      // pending"), depending on timing. The fixture's message must come through intact.
      const unhandled = lines.filter((l) => l.startsWith("vitest: unhandled error"));
      expect(unhandled).toContain("vitest: unhandled error during collection: fixture unhandled");
      const problems = lines.filter((l) => !l.startsWith("vitest: unhandled error"));
      expect(problems).toEqual([
        expect.stringContaining("a/__tests__/helper.ts looks like a test file"),
        expect.stringMatching(/^a\/focus\.test\.ts:1 "\[A7\.one\] focused": .*Unexpected \.only/),
        'a/generated.test.ts:4 "title built" carries no manifest ID',
        expect.stringContaining("a/old.test.js looks like a test file"),
        'a/skipped.test.ts:1 "skipped untagged" carries no manifest ID',
        'a/skipped.test.ts:2 "todo untagged" carries no manifest ID',
        expect.stringContaining("a/stray.spec.ts looks like a test file"),
      ]);
      expect(result.status).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
