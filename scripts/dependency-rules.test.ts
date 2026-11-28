import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cruise, type ICruiseOptions, type ICruiseResult } from "dependency-cruiser";
import extractDepcruiseOptions from "dependency-cruiser/config-utl/extract-depcruise-options";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { repoRoot } from "./run.ts";

const imports = (...specifiers: string[]) =>
  specifiers.map((s, i) => `import * as m${String(i)} from "${s}";\n`).join("") +
  `export const all = [${specifiers.map((_, i) => `m${String(i)}`).join(", ")}];\n`;

const pkg = (name: string, dependencies: Record<string, string> = {}) =>
  JSON.stringify({ name, version: "0.0.0", type: "module", dependencies });

const npmPackage = (name: string) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({
    name,
    version: "1.0.0",
    main: "index.js",
  }),
  [`node_modules/${name}/index.js`]: "module.exports = {};\n",
});

const CORE = "../../core/src/index.ts";
const CONTRACTS = "../../contracts/src/index.ts";
const STORAGE = "../../storage/src/index.ts";
const TESTKIT = "../../testkit/src/index.ts";

// A fixture tree with the package layout and two fake npm packages. Each production
// file breaks at most one rule, so the expected violations name the rule that must fire. The
// allowed imports, including the test files that use testkit, I/O and other packages, must not.
const files: Record<string, string> = {
  ...npmPackage("better-sqlite3"),
  ...npmPackage("tiny-pkg"),

  // Allowed production imports.
  "packages/contracts/src/index.ts": "export const c = 1;\n",
  "packages/core/src/index.ts": imports(CONTRACTS),
  "packages/storage/package.json": pkg("@fx/storage", { "better-sqlite3": "1.0.0" }),
  "packages/storage/src/index.ts": imports("node:sqlite", "better-sqlite3"),
  "packages/testkit/package.json": pkg("@fx/testkit", { "better-sqlite3": "1.0.0" }),
  "packages/testkit/src/index.ts": imports("better-sqlite3", "node:fs", STORAGE, CORE),
  "packages/bridge/package.json": pkg("@fx/bridge", { "tiny-pkg": "1.0.0" }),
  "packages/web/src/index.ts": imports(CONTRACTS),
  "packages/service/package.json": pkg("@fx/service", {
    "better-sqlite3": "1.0.0",
    "tiny-pkg": "1.0.0",
  }),
  "packages/contracts/src/monitor.ts": "export const m = 1;\n",
  "packages/service/src/monitor/index.ts": imports("../../../contracts/src/monitor.ts"),
  "packages/service/src/http/app.ts": imports("../monitor/index.ts"),
  "packages/web/src/agents.ts": imports("../../contracts/src/monitor.ts"),
  "packages/service/src/compose.ts": imports(CORE, STORAGE, "../../bridge/src/ok.ts", "tiny-pkg"),
  "packages/bridge/src/ok.ts": imports("node:net", CONTRACTS, "./own.ts"),
  "packages/bridge/src/own.ts": "export const o = 1;\n",
  "packages/bridge/src/types.ts":
    'import type { Readable } from "node:stream";\nexport type R = Readable;\n',

  // Allowed test imports: tests are exempt from the layering of brand, contracts, core, web and
  // bridge, and test code may import testkit.
  "packages/brand/src/index.test.tsx": imports(TESTKIT, CORE),
  "packages/contracts/src/index.test.ts": imports(TESTKIT, "node:fs"),
  "packages/core/src/index.test.ts": imports(TESTKIT, "node:fs", STORAGE),
  "packages/core/test/helpers.ts": imports("../../testkit/src/index.ts", "node:fs/promises"),
  "packages/web/src/app.test.tsx": imports(TESTKIT, CORE),
  "packages/bridge/src/index.test.ts": imports(TESTKIT, CORE, "tiny-pkg"),
  "packages/service/src/index.test.ts": imports(TESTKIT),
  "tests/integration/space.test.ts": imports("../../packages/testkit/src/index.ts"),

  // Production violations, one rule each.
  "packages/brand/src/index.ts": imports(CORE),
  "packages/contracts/src/uses-brand.ts": imports("../../brand/src/index.ts"),
  "packages/core/src/uses-storage.ts": imports(STORAGE),
  "packages/core/src/io.ts": imports("node:fs"),
  "packages/launch/src/index.ts": imports(STORAGE),
  "packages/bridge/src/index.ts": imports(CORE, CONTRACTS),
  "packages/bridge/src/npm.ts": imports("tiny-pkg"),
  "packages/bridge/src/spawn.ts": imports("node:child_process"),
  "packages/web/src/index-core.ts": imports(CORE),
  "packages/service/src/kit.ts": imports(TESTKIT),
  "packages/service/src/db.ts": imports("node:sqlite"),
  "packages/service/src/sqlite3.ts": imports("better-sqlite3"),
  "packages/service/src/a.ts": imports("./b.ts"),
  "packages/service/src/b.ts": imports("./a.ts"),
  "packages/service/src/missing.ts": imports("./nowhere.ts"),
  "packages/runs/src/index.ts": imports("tiny-pkg"),
  "packages/cli/src/doctor-agents.ts": imports("node:child_process"),
  "packages/service/src/setup/run.ts": imports("node:child_process"),
  "packages/service/src/mcp/tools.ts": imports("../monitor/index.ts"),
  "packages/cli/src/agents.ts": imports("../../contracts/src/monitor.ts"),

  // Violations that stay strict in tests.
  "packages/launch/src/index.test.ts": imports(STORAGE),
  "packages/runs/test/import.ts": imports(STORAGE),
  "packages/service/src/sqlite.test.ts": imports("node:sqlite"),
};

const TINY = "node_modules/tiny-pkg/index.js";
const SQLITE3 = "node_modules/better-sqlite3/index.js";
const expected = [
  "brand-contracts-standalone: packages/brand/src/index.ts -> packages/core/src/index.ts",
  "brand-contracts-standalone: packages/contracts/src/uses-brand.ts -> packages/brand/src/index.ts",
  `bridge-builtins-and-contracts: packages/bridge/src/index.ts -> packages/core/src/index.ts`,
  `bridge-builtins-and-contracts: packages/bridge/src/npm.ts -> ${TINY}`,
  "bridge-few-builtins: packages/bridge/src/spawn.ts -> child_process",
  "core-no-io: packages/core/src/io.ts -> fs",
  "core-only-contracts: packages/core/src/uses-storage.ts -> packages/storage/src/index.ts",
  "helpers-through-the-runner: packages/cli/src/doctor-agents.ts -> child_process",
  "helpers-through-the-runner: packages/service/src/setup/run.ts -> child_process",
  "monitor-data-stays-with-the-page: packages/cli/src/agents.ts -> packages/contracts/src/monitor.ts",
  "monitor-data-stays-with-the-page: packages/service/src/mcp/tools.ts -> packages/service/src/monitor/index.ts",
  // dependency-cruiser reports a cycle once, at its first edge.
  "no-circular: packages/service/src/a.ts -> packages/service/src/b.ts",
  "no-storage-from-launch-runs: packages/launch/src/index.test.ts -> packages/storage/src/index.ts",
  "no-storage-from-launch-runs: packages/launch/src/index.ts -> packages/storage/src/index.ts",
  "no-storage-from-launch-runs: packages/runs/test/import.ts -> packages/storage/src/index.ts",
  `no-undeclared-dependency: packages/runs/src/index.ts -> ${TINY}`,
  "not-to-unresolvable: packages/service/src/missing.ts -> ./nowhere.ts",
  `only-storage-better-sqlite3: packages/service/src/sqlite3.ts -> ${SQLITE3}`,
  "only-storage-node-sqlite: packages/service/src/db.ts -> node:sqlite",
  "only-storage-node-sqlite: packages/service/src/sqlite.test.ts -> node:sqlite",
  "testkit-only-from-tests: packages/service/src/kit.ts -> packages/testkit/src/index.ts",
  "web-only-contracts: packages/web/src/index-core.ts -> packages/core/src/index.ts",
];

describe("[A7.3.2.dependency-rules] the dependency rules fire on violations", () => {
  let root = "";
  let options: ICruiseOptions;
  let result: ICruiseResult;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ttasks-deps-"));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    options = await extractDepcruiseOptions(join(repoRoot, ".dependency-cruiser.cjs"));
    const output = await cruise(["packages", "tests"], { ...options, baseDir: root });
    result = output.output as ICruiseResult;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("each forbidden import is reported under its rule, and allowed imports are not", () => {
    const found = result.summary.violations
      .map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`)
      .sort();
    expect(found).toEqual(expected);
  });

  test("every rule in the configuration is proven by a fixture case", () => {
    const configured = (options.ruleSet?.forbidden ?? []).map((r) => r.name ?? "").sort();
    const proven = [...new Set(expected.map((line) => line.slice(0, line.indexOf(":"))))].sort();
    expect(configured.length).toBeGreaterThan(0);
    expect(proven).toEqual(configured);
  });
});
