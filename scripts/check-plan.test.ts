import { matchesGlob } from "node:path";
import { describe, expect, test } from "vitest";
import {
  E2E_MAX,
  fitBudget,
  READS,
  repoFromCruise,
  select,
  selectBrowser,
  SLOW,
  type Cruise,
} from "./check-plan.ts";
import { git } from "./lab-tests.ts";

const SETUP = "packages/testkit/src/setup.ts";

/** A small repository: each file's source text, and the imports dependency-cruiser would report. */
const sources: Record<string, string> = {
  "packages/a/src/core.ts": "export const core = 1;",
  "packages/a/src/use.ts": 'import { core } from "./core.ts";',
  "packages/a/test/use.test.ts": 'import "../src/use.ts";',
  "packages/a/test/types.test.ts": 'import type { X } from "../src/core.ts";',
  "packages/s/src/hub/main.ts": 'import "./inner.ts";',
  "packages/s/src/hub/inner.ts": "export {};",
  "packages/s/test/harness.ts":
    'export const MAIN = new URL("../src/hub/main.ts", import.meta.url);',
  "packages/s/test/spawn.test.ts": 'import "./harness.ts";',
  "packages/k/src/fakes/index.ts": 'const here = (n) => n; export const T = here("terminal.ts");',
  "packages/k/src/fakes/terminal.ts": "process.stdin.pipe(process.stdout);",
  "packages/k/test/fake.test.ts": 'import "../src/fakes/index.ts";',
  "tests/manifest.json": "{}",
  "scripts/accept.test.ts": 'readFileSync(join(root, "tests", "manifest.json"));',
  "packages/v/test/version.test.ts": 'readFileSync(join(folder, "manifest.json"));',
  "eslint.config.js": "export default [];",
  "scripts/lint-rules.test.ts": 'const config = join(repoRoot, "eslint.config.js");',
  [SETUP]: 'import "./stand-ins.ts";',
  "packages/testkit/src/stand-ins.ts": "export {};",
  "packages/web/src/main.tsx": 'import "./views/Today.tsx";',
  "packages/web/src/views/Today.tsx": "export {};",
  "packages/web/src/views/Upcoming.tsx": "export {};",
  "packages/web/test/catalogue.test.ts": "readdirSync(SRC);",
  "packages/web/test/styles.test.ts": "readdirSync(SRC);",
  "packages/projection/test/model.test.ts": 'import "../../a/src/core.ts";',
  "tests/update/installed.test.ts": 'import "../../packages/a/src/core.ts";',
  "tests/update/fixture.ts": "export {};",
  "tests/e2e/world.ts": 'import "../../packages/k/src/fakes/index.ts";',
  "tests/e2e/search.e2e.ts": 'import "./world.ts";',
  "tests/e2e/skeleton.e2e.ts": 'import "./world.ts";',
  "packages/l/test/detect.test.ts": "toMatchFileSnapshot(`./golden/detect.${os}.json`);",
  "packages/l/test/golden/detect.linux.json": "{}",
  "packages/l/test/golden/detect.darwin.json": "{}",
  "packages/r/test/fake.ts":
    'export const FIXTURES = join(\n  import.meta.dirname,\n  "..",\n  "..",\n  "..",\n  "fixtures",\n  "claude-stream",\n);',
  "packages/r/test/driver.test.ts": 'import "./fake.ts";',
  "fixtures/claude-stream/plain.jsonl": "",
  "packages/n/test/native.ts":
    'const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");',
  "packages/n/test/native.test.ts": 'import "./native.ts";',
  "packages/n/test/fixtures/spy.c": "",
  "packages/n/test/args.test.ts": 'parse(["--part", "build"]); // the `fixtures` folder',
  "packages/n/test/build/out.txt": "",
  "packages/c/src/config.test.ts":
    'const FIXTURES = fileURLToPath(new URL("../test/config/", import.meta.url));',
  "packages/c/test/config/machine.toml": "",
  "packages/c/src/protocol.ts": "export interface Message {}",
  "packages/c/src/client.ts": 'import type { Message } from "./protocol.ts";',
  ".github/workflows/ci.yml": "",
  LICENSE: "",
};
const imports: Record<string, [string, string[]][]> = {
  "packages/a/src/use.ts": [["packages/a/src/core.ts", ["local", "import"]]],
  "packages/a/test/use.test.ts": [["packages/a/src/use.ts", ["local", "import"]]],
  "packages/a/test/types.test.ts": [["packages/a/src/core.ts", ["local", "type-only"]]],
  "packages/s/src/hub/main.ts": [["packages/s/src/hub/inner.ts", ["local", "import"]]],
  "packages/s/test/spawn.test.ts": [["packages/s/test/harness.ts", ["local", "import"]]],
  "packages/k/test/fake.test.ts": [["packages/k/src/fakes/index.ts", ["local", "import"]]],
  [SETUP]: [["packages/testkit/src/stand-ins.ts", ["local", "import"]]],
  "packages/web/src/main.tsx": [["packages/web/src/views/Today.tsx", ["local", "import"]]],
  "packages/projection/test/model.test.ts": [["packages/a/src/core.ts", ["local", "import"]]],
  "tests/update/installed.test.ts": [["packages/a/src/core.ts", ["local", "import"]]],
  "tests/e2e/world.ts": [["packages/k/src/fakes/index.ts", ["local", "import"]]],
  "tests/e2e/search.e2e.ts": [["tests/e2e/world.ts", ["local", "import"]]],
  "tests/e2e/skeleton.e2e.ts": [["tests/e2e/world.ts", ["local", "import"]]],
  "packages/r/test/driver.test.ts": [["packages/r/test/fake.ts", ["local", "import"]]],
  "packages/n/test/native.test.ts": [["packages/n/test/native.ts", ["local", "import"]]],
  "packages/c/src/client.ts": [["packages/c/src/protocol.ts", ["local", "type-only"]]],
};
const graph: Cruise = {
  modules: Object.keys(sources).map((source) => ({
    source,
    dependencies: (imports[source] ?? []).map(([resolved, dependencyTypes]) => ({
      resolved,
      dependencyTypes,
    })),
  })),
  summary: { error: 0, violations: [] },
};
const repo = repoFromCruise(graph, Object.keys(sources), (p) => sources[p] ?? "");
const tests = Object.keys(sources).filter((p) => p.endsWith(".test.ts"));
const set = {
  tests,
  setup: [SETUP],
  isTest: (p: string) => p.endsWith(".test.ts") || p.endsWith(".e2e.ts"),
};
const selected = (changed: string[], slow = false) => {
  const s = select(changed, repo, set, { slow });
  return [...s.run, ...s.deferred].sort();
};

describe("[A7.3.3.check.selection] pnpm check selects the tests a change can reach", () => {
  test("a test that imports a changed module, directly or through others, is selected", () => {
    expect(selected(["packages/a/src/use.ts"])).toEqual(["packages/a/test/use.test.ts"]);
    expect(selected(["packages/a/src/core.ts"])).toContain("packages/a/test/use.test.ts");
  });

  test("a type-only import does not select: the type checker covers it, and nothing loads", () => {
    expect(selected(["packages/a/src/core.ts"])).not.toContain("packages/a/test/types.test.ts");
  });

  test("a test that spawns an entry by its path is selected by what that entry imports", () => {
    expect(selected(["packages/s/src/hub/inner.ts"])).toEqual(["packages/s/test/spawn.test.ts"]);
  });

  test("a module that names a file next to it by its bare name depends on that file", () => {
    expect(selected(["packages/k/src/fakes/terminal.ts"])).toEqual([
      "packages/k/test/fake.test.ts",
    ]);
  });

  test("a bare file name counts only with its folder named too, or for a file at the root", () => {
    expect(selected(["tests/manifest.json"])).toEqual(["scripts/accept.test.ts"]);
    expect(selected(["eslint.config.js"])).toEqual(["scripts/lint-rules.test.ts"]);
  });

  test("a change that can alter every test run selects every test, and says why", () => {
    for (const changed of [
      "pnpm-lock.yaml",
      "packages/a/package.json",
      ".node-version",
      "tsconfig.base.json",
      "packages/web/tsconfig.json",
      "vitest.config.ts",
    ]) {
      const s = select([changed], repo, set, { slow: true });
      expect(s.everything, changed).toContain(changed);
      expect(s.run.sort(), changed).toEqual([...tests].sort());
    }
    const viaSetup = select(["packages/testkit/src/stand-ins.ts"], repo, set, { slow: true });
    expect(viaSetup.everything).toContain(SETUP);
    expect(viaSetup.run).toHaveLength(tests.length);
  });

  test("tests that scan a folder are selected by a change inside it", () => {
    expect(selected(["packages/web/src/views/Upcoming.tsx"])).toEqual([
      "packages/web/test/catalogue.test.ts",
      "packages/web/test/styles.test.ts",
    ]);
  });

  test("a file a test reads under a name it builds is selected, also when it is renamed", () => {
    expect(selected(["packages/l/test/golden/detect.linux.json"])).toEqual([
      "packages/l/test/detect.test.ts",
    ]);
    // The check keeps a gone file in the list, so a rename is the old name and the new one.
    const renamed = [
      "packages/l/test/golden/detect.linux.json",
      "packages/l/test/golden/detect.darwin.json",
    ];
    expect(selected(renamed)).toEqual(["packages/l/test/detect.test.ts"]);
  });

  test("a file in a folder that a test names is selected by its change", () => {
    expect(selected(["fixtures/claude-stream/plain.jsonl"])).toEqual([
      "packages/r/test/driver.test.ts",
    ]);
    expect(selected(["packages/n/test/fixtures/spy.c"])).toEqual([
      "packages/n/test/native.test.ts",
    ]);
    expect(selected(["packages/c/test/config/machine.toml"])).toEqual([
      "packages/c/src/config.test.ts",
    ]);
  });

  test("a changed file no test reaches selects every test, and is named", () => {
    for (const changed of [".github/workflows/ci.yml", "packages/n/test/build/out.txt"]) {
      const s = select([changed], repo, set, { slow: true });
      expect(s.unseen, changed).toEqual([changed]);
      expect(s.everything, changed).toContain(changed);
      expect(s.run, changed).toHaveLength(tests.length);
    }
  });

  test("prose, the licence and a file imported for its types only select nothing", () => {
    for (const changed of [
      "docs/promises-and-limits.md",
      "LICENSE",
      "packages/c/src/protocol.ts",
    ]) {
      const s = select([changed], repo, set, { slow: true });
      expect(s.everything, changed).toBeNull();
      expect(s.run, changed).toEqual([]);
    }
  });

  test("a slow file is selected but left to CI, unless it is the change's own test", () => {
    const changed = ["packages/a/src/core.ts"];
    const s = select(changed, repo, set, { slow: false });
    expect(s.deferred).toEqual([
      "packages/projection/test/model.test.ts",
      "tests/update/installed.test.ts",
    ]);
    expect(s.run).not.toContain("tests/update/installed.test.ts");
    expect(select(changed, repo, set, { slow: true }).deferred).toEqual([]);

    const own = select(["tests/update/installed.test.ts"], repo, set, { slow: false });
    expect(own.run).toEqual(["tests/update/installed.test.ts"]);
    const home = select(["tests/update/fixture.ts", ...changed], repo, set, { slow: false });
    expect(home.run).toContain("tests/update/installed.test.ts");
    expect(home.deferred).toEqual(["packages/projection/test/model.test.ts"]);
  });

  test("the check's own lists name files that exist in this repository", () => {
    const files = (git(["ls-files", "-z"]) ?? "").split("\0");
    for (const slow of SLOW) expect(files, slow.test).toContain(slow.test);
    for (const read of READS) {
      expect(
        files.some((f) => matchesGlob(f, read.changed)),
        read.changed,
      ).toBe(true);
      for (const pattern of read.tests) {
        expect(
          files.some((f) => matchesGlob(f, pattern)),
          pattern,
        ).toBe(true);
      }
    }
  });
});

describe("[A7.3.3.check.budget] pnpm check runs the closest tests when a change is over its budget", () => {
  const changed = ["packages/a/src/core.ts", "packages/a/test/use.test.ts"];
  const selection = select(changed, repo, set, { slow: true });
  const seconds = (file: string) =>
    ({ "packages/a/test/use.test.ts": 30, "tests/update/installed.test.ts": 5 })[file] ?? 10;

  test("the tests the change edits come first, then the ones that use a changed file, shortest first", () => {
    const fit = fitBudget(selection, changed, seconds, 45);
    expect(fit.run).toEqual([
      { file: "packages/a/test/use.test.ts", why: "edited" },
      { file: "tests/update/installed.test.ts", why: "direct" },
      { file: "packages/projection/test/model.test.ts", why: "direct" },
    ]);
    expect(fit.left).toEqual([]);
  });

  test("what does not fit is left", () => {
    const fit = fitBudget(selection, changed, seconds, 36);
    expect(fit.run.map((r) => r.file)).toEqual([
      "packages/a/test/use.test.ts",
      "tests/update/installed.test.ts",
    ]);
    expect(fit.left).toEqual(["packages/projection/test/model.test.ts"]);
  });

  test("the tests that reach a changed file through other files fill what is left of the budget", () => {
    const core = ["packages/a/src/core.ts"];
    const far = (budget: number) =>
      fitBudget(select(core, repo, set, { slow: true }), core, seconds, budget);
    expect(far(1000).run).toEqual([
      { file: "tests/update/installed.test.ts", why: "direct" },
      { file: "packages/projection/test/model.test.ts", why: "direct" },
      { file: "packages/a/test/use.test.ts", why: "through others" },
    ]);
    expect(far(40).left).toEqual(["packages/a/test/use.test.ts"]);
  });
});

describe("[A7.3.3.check.browser] pnpm check runs a browser test when a change reaches the page", () => {
  const e2e = ["skeleton", "today", "sidebar", "search"].map((n) => `tests/e2e/${n}.e2e.ts`);
  const browser = (changed: string[], overBudget = false) =>
    selectBrowser(changed, select(changed, repo, set, { slow: false }).reached, e2e, overBudget);

  test("a change that does not reach the page runs none", () => {
    expect(browser(["packages/a/src/core.ts"]).run).toEqual([]);
  });

  test("a changed part of the page runs the end-to-end file of the same name", () => {
    expect(browser(["packages/web/src/views/Today.tsx"]).run).toEqual(["tests/e2e/today.e2e.ts"]);
  });

  test("a part no end-to-end file is named after runs the skeleton test", () => {
    expect(browser(["packages/web/src/main.tsx"]).run).toEqual(["tests/e2e/skeleton.e2e.ts"]);
  });

  test("a change that reaches the browser tests through their helpers runs the skeleton first", () => {
    const s = browser(["packages/k/src/fakes/terminal.ts"]);
    expect(s.run).toEqual(["tests/e2e/skeleton.e2e.ts", "tests/e2e/search.e2e.ts"]);
    expect(s.why).toContain("helpers");
  });

  test("the end-to-end files a change edits run first, and the rest is reported, not run", () => {
    const edited = ["tests/e2e/search.e2e.ts", "tests/e2e/sidebar.e2e.ts"];
    const s = browser([...edited, "packages/web/src/views/Today.tsx"]);
    expect(s.run).toEqual(edited.slice(0, E2E_MAX));
    expect([...s.run, ...s.over].sort()).toEqual([...edited, "tests/e2e/today.e2e.ts"].sort());
  });

  test("a change over the budget still runs the end-to-end file it edits, and only that", () => {
    const changed = ["tests/e2e/search.e2e.ts", "packages/web/src/views/Today.tsx"];
    const s = browser(changed, true);
    expect(s.run).toEqual(["tests/e2e/search.e2e.ts"]);
    expect(s.over).toEqual(["tests/e2e/today.e2e.ts"]);
    expect(browser(["packages/web/src/views/Today.tsx"], true).run).toEqual([]);
  });
});
