// Dependency rules of A7 3.2, checked by `pnpm verify`. They are written against the package
// layout, so each binds as soon as its package exists. scripts/dependency-rules.test.ts proves
// they fire on a fixture tree.

// Repository code outside node_modules. A package may always import its own files.
const REPO = "^(packages|spikes|scripts|tests|fixtures)/";

// Node built-ins that do I/O. `core` is pure domain logic and imports none of them (A7 3.2).
const IO_BUILTINS =
  "^(node:)?(fs|fs/promises|net|http|https|http2|child_process|cluster|dgram|dns|dns/promises|" +
  "tls|os|readline|readline/promises|worker_threads|sqlite|inspector|process|v8|vm|repl|tty)$";

// Test files: *.test.ts and *.test.tsx (the only test file names, see vitest.config.ts), package
// test/ folders and tests/. The layering rules of brand, contracts, core, web and bridge keep
// shipped code small and pure, so they do not bind tests, which may use testkit, fixtures and I/O.
const TEST_FILE = "(\\.test\\.tsx?$|/test/|^tests/)";

// Code that may use testkit (A7 3.2: "Nothing outside tests imports testkit"): test files,
// testkit itself, and scripts/ (accept, seed, bench), which is tooling that is never shipped.
const TEST_CODE = `(${TEST_FILE}|^scripts/|^packages/testkit/)`;

// Rules that stay strict for tests too: testkit-only-from-tests (it binds production code only),
// spikes-never-imported, the two SQLite rules, and no-storage-from-launch-runs. Tests of launch
// and runs reach a space through testkit or the service, as the packages themselves do (A7 3.2,
// 3.18.1).

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "brand-contracts-standalone",
      comment:
        "brand and contracts depend on nothing in the repository (A7 3.2), and nor does files, " +
        "the one implementation of exact-mode creation that every package may use (A2 3.2.2 rule 5).",
      severity: "error",
      from: { path: "^packages/(brand|contracts|files)/", pathNot: TEST_FILE },
      to: { path: REPO, pathNot: "^packages/$1/" },
    },
    {
      name: "core-only-contracts",
      comment: "core depends on contracts only (A7 3.2).",
      severity: "error",
      from: { path: "^packages/core/", pathNot: TEST_FILE },
      to: { path: REPO, pathNot: "^packages/(core|contracts)/" },
    },
    {
      name: "core-no-io",
      comment: "core does no I/O, so it imports no I/O built-ins (A7 3.2).",
      severity: "error",
      from: { path: "^packages/core/", pathNot: TEST_FILE },
      to: { dependencyTypes: ["core"], path: IO_BUILTINS },
    },
    {
      name: "only-storage-node-sqlite",
      comment:
        "Only storage imports node:sqlite (A7 3.2). spikes/ is lab code that is never shipped.",
      severity: "error",
      from: { pathNot: "^(packages/storage|spikes)/" },
      to: { dependencyTypes: ["core"], path: "^(node:)?sqlite$" },
    },
    {
      name: "only-storage-better-sqlite3",
      comment:
        "Only storage imports better-sqlite3 (A7 3.2). testkit holds it for the fallback-driver " +
        "suite (A7 3.3). spikes/ is lab code that is never shipped.",
      severity: "error",
      from: { pathNot: "^(packages/(storage|testkit)|spikes)/" },
      to: { path: "(^|/)better-sqlite3(/|$)" },
    },
    {
      name: "no-storage-from-launch-runs",
      comment:
        "launch and runs change state only through operations sent to the space worker. They " +
        "never import storage (A7 3.2).",
      severity: "error",
      from: { path: "^packages/(launch|runs)/" },
      to: { path: "^packages/storage/" },
    },
    {
      name: "bridge-builtins-and-contracts",
      comment:
        "bridge uses only Node built-ins and protocol constants from contracts, so its bundle " +
        "stays small (A7 3.2, A2 3.7).",
      severity: "error",
      from: { path: "^packages/bridge/", pathNot: TEST_FILE },
      to: { dependencyTypesNot: ["core"], pathNot: "^packages/(bridge|contracts)/" },
    },
    {
      name: "bridge-few-builtins",
      comment:
        "At run time the bridge loads only the built-ins it needs: net, fs, crypto, process, " +
        "path, os and url, and v8 for safe-exit.ts's flags (A2 3.12.1). It starts fast, stays " +
        "small and cannot start a process (A2 3.7.1, A7 A.3). Type-only imports are erased and " +
        "do not count.",
      severity: "error",
      from: { path: "^packages/bridge/", pathNot: TEST_FILE },
      to: {
        dependencyTypes: ["core"],
        dependencyTypesNot: ["type-only"],
        pathNot: "^(node:)?(crypto|fs|net|os|path|process|url|v8)$",
      },
    },
    {
      name: "helpers-through-the-runner",
      comment:
        "setup, detection and doctor start a program only as a helper of the runner in " +
        "@ttasks/launch (helpers.ts), which ends it with what it started at its deadline and when " +
        "the process exits (A3 3.14). Their modules import no child_process; type-only imports " +
        "are erased and do not count.",
      severity: "error",
      from: {
        path:
          "^packages/(cli/src/(doctor[^/]*|accounts|setup-agents)\\.ts$|" +
          "launch/src/detect\\.ts$|service/src/(setup/|version/candidate\\.ts$))",
        pathNot: TEST_FILE,
      },
      to: {
        dependencyTypes: ["core"],
        dependencyTypesNot: ["type-only"],
        path: "^(node:)?child_process$",
      },
    },
    {
      name: "web-only-contracts",
      comment:
        "web imports contracts, and brand for the product's names, and nothing else from the " +
        "repository (A7 3.2; brand has no dependency).",
      severity: "error",
      from: { path: "^packages/web/", pathNot: TEST_FILE },
      to: { path: REPO, pathNot: "^packages/(web|contracts|brand)/" },
    },
    {
      name: "monitor-data-stays-with-the-page",
      comment:
        "What the Agent Monitor reports about every agent on this computer reaches only the " +
        "service's monitor module, the page's connection and the hub that wires them, and the " +
        "page: never an agent's tools, a space, the CLI or another package.",
      severity: "error",
      from: {
        path: "^packages/",
        pathNot: [
          TEST_FILE,
          "^packages/(web|contracts)/",
          "^packages/service/src/(monitor|http|hub)/",
        ],
      },
      to: { path: "^packages/(contracts/src/monitor\\.ts|service/src/monitor/)" },
    },
    {
      name: "testkit-only-from-tests",
      comment: "Nothing outside tests imports testkit (A7 3.2).",
      severity: "error",
      from: { pathNot: TEST_CODE },
      to: { path: "^packages/testkit/" },
    },
    {
      name: "spikes-never-imported",
      comment: "Nothing outside spikes/ imports spikes/ (A7 3.2).",
      severity: "error",
      from: { pathNot: "^spikes/" },
      to: { path: "^spikes/" },
    },
    {
      name: "no-circular",
      comment: "Circular imports hide layering mistakes.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment:
        "Every import resolves to a file on disk, but a build's virtual module (`virtual:…`), " +
        "which its own plugin writes: the page's theme tokens (packages/web/build.ts).",
      severity: "error",
      from: {},
      to: { couldNotResolve: true, pathNot: "^virtual:" },
    },
    {
      name: "no-undeclared-dependency",
      comment: "Every npm import is declared in the importing package's package.json.",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
  ],
  options: {
    // npm packages stay in the graph as leaves: their edges are needed for the npm rules above,
    // but their own imports are not followed. Excluding node_modules, or a dist/ folder inside it
    // (where most packages resolve), would hide those edges and silence the npm rules.
    doNotFollow: { path: "(^|/)node_modules/" },
    exclude: { path: "^(?!.*node_modules/).*(^|/)(dist|coverage)/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".mts", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types"],
    },
  },
};
