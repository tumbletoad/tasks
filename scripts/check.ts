// pnpm check: the checks and tests a change can affect, in about a minute, and a list of what it
// did not run. It is not a verify: CI runs everything on the push.
//
//   pnpm check                 the change since the merge base with origin/main, uncommitted and
//                              untracked files included
//   pnpm check --base <rev>    the change since the merge base with <rev>
//   pnpm check <path>...       as if exactly these files had changed
//   pnpm check --slow          also the slow files, and a selection too big for a minute
//   pnpm check --list          say what would run, and run nothing
//
// The static steps run beside the tests. The caches it keeps are in node_modules/.cache/check.
//
// safe-exit comes first: this script loads the product's generators and ends through
// `process.exit`.
import "../packages/bridge/src/safe-exit.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { chromium } from "@playwright/test";
import { createVitest, type TestModule } from "vitest/node";
import { LAB_DIR, SETUP_FILES, testFiles } from "../vitest.config.ts";
import {
  E2E_DIR,
  E2E_MAX,
  select,
  selectBrowser,
  repoFromCruise,
  type BrowserSelection,
  type Cruise,
  type Selection,
} from "./check-plan.ts";
import { changedSince, git, isLabPath } from "./lab-tests.ts";
import { checkIds, collectE2e, E2E_CONFIG, parseManifest, type CollectedTest } from "./manifest.ts";
import { binPath, repoRoot, runNodeCaptured, type Captured } from "./run.ts";
import { CRUISE_ROOTS, generated, runtime, TS_PROJECTS } from "./steps.ts";

/** Above this estimate of the tests' wall time, the change is left to CI unless --slow is given. */
const BUDGET_S = 60;
/** The time a test file with no recorded duration is counted as: about the mean of the fast files. */
const UNKNOWN_FILE_S = 3;
const CACHE = "node_modules/.cache/check";
const LINTABLE = /\.[cm]?[jt]sx?$/;

interface Options {
  base: string | null;
  paths: string[];
  slow: boolean;
  list: boolean;
}

function parseArgs(args: readonly string[]): Options {
  const options: Options = { base: null, paths: [], slow: false, list: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") continue;
    if (arg === "--slow") options.slow = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--base") {
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) throw new Error("--base takes a revision");
      options.base = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown argument ${arg}. Use --base <rev>, --slow, --list or paths.`);
    } else options.paths.push(arg.replaceAll("\\", "/").replace(/^\.\//, ""));
  }
  if (options.base !== null && options.paths.length > 0) {
    throw new Error("give --base or paths, not both");
  }
  return options;
}

/** The changed files and how to name where they come from. */
function findChange(options: Options): { changed: string[]; label: string } {
  if (options.paths.length > 0) {
    const missing = options.paths.filter((p) => !existsSync(join(repoRoot, p)));
    if (missing.length > 0) throw new Error(`no such file: ${missing.join(", ")}`);
    return { changed: options.paths, label: "given on the command line" };
  }
  const rev = options.base ?? "origin/main";
  const mergeBase = git(["merge-base", rev, "HEAD"])?.trim();
  if (mergeBase === undefined || mergeBase === "") {
    throw new Error(`no merge base with ${rev} here. Fetch it, or give --base <rev>.`);
  }
  const changed = changedSince(git, mergeBase);
  if (changed === null) throw new Error(`git diff against ${mergeBase} failed`);
  return {
    changed: [...new Set(changed.map((p) => p.replaceAll("\\", "/")))].sort(),
    label: `since ${rev} (merge base ${mergeBase.slice(0, 12)})`,
  };
}

/** dependency-cruiser's rules and its import graph, from one run over the repository. */
async function cruise(): Promise<{ ok: boolean; output: string; graph: Cruise | null }> {
  const run = await runNodeCaptured(binPath("dependency-cruiser", "depcruise"), [
    "--config",
    ".dependency-cruiser.cjs",
    "--output-type",
    "json",
    ...CRUISE_ROOTS,
  ]);
  let graph: Cruise;
  try {
    graph = JSON.parse(run.output) as Cruise;
  } catch {
    return { ok: false, output: run.output, graph: null };
  }
  const errors = graph.summary.violations.filter((v) => v.rule.severity === "error");
  const output = errors.map((v) => `${v.rule.name}: ${v.from} → ${v.to}`).join("\n");
  return { ok: graph.summary.error === 0, output, graph };
}

const isProductTest = (path: string) =>
  testFiles.include.some((g) => matchesGlob(path, g)) &&
  !testFiles.exclude.some((g) => matchesGlob(path, g)) &&
  !path.startsWith(`${LAB_DIR}/`);

/** One line of the summary: a step, what it covered and how it went. */
interface Result {
  name: string;
  ok: boolean;
  seconds: number;
  /** Shown only when the step failed. */
  output: string;
}

async function timed(name: string, work: () => Promise<Captured | boolean>): Promise<Result> {
  const t0 = performance.now();
  let ok: boolean;
  let output = "";
  try {
    const result = await work();
    if (typeof result === "boolean") ok = result;
    else {
      ok = result.status === 0;
      output = result.output;
    }
  } catch (error) {
    ok = false;
    output = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  return { name, ok, seconds: (performance.now() - t0) / 1000, output };
}

/** Runs the in-process steps with their console output captured, so it does not mix in. */
async function quietly(step: () => boolean | Promise<boolean>): Promise<Captured> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = console.log;
  try {
    return { status: (await step()) ? 0 : 1, output: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function typecheck(): Promise<Captured> {
  return Promise.all(
    TS_PROJECTS.map((project) =>
      runNodeCaptured(binPath("typescript", "tsc"), [
        "-p",
        project,
        "--incremental",
        "--tsBuildInfoFile",
        `${CACHE}/tsc/${project.replaceAll("/", "-")}.tsbuildinfo`,
      ]),
    ),
  ).then((runs) => ({
    status: runs.every((r) => r.status === 0) ? 0 : 1,
    output: runs.map((r) => r.output).join(""),
  }));
}

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? "" : "s"}`;
const platformName = { win32: "Windows", linux: "Linux", darwin: "macOS" }[
  process.platform as string
];

let options: Options;
let change: { changed: string[]; label: string };
try {
  options = parseArgs(process.argv.slice(2));
  change = findChange(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
const { changed } = change;
const started = performance.now();
console.log(`pnpm check: ${plural(changed.length, "changed file")} ${change.label}`);

// The steps that need nothing from the selection start at once.
const existing = changed.filter((p) => existsSync(join(repoRoot, p)));
const pending: Promise<Result>[] = [];
if (!options.list) {
  pending.push(timed("typecheck", typecheck));
  const formatAll = changed.some((p) => /^\.prettier(rc|ignore)/.test(p));
  const formatFiles = formatAll ? ["."] : existing;
  if (formatFiles.length > 0) {
    pending.push(
      timed(`format (${formatAll ? "every file" : plural(formatFiles.length, "file")})`, () =>
        runNodeCaptured(binPath("prettier", "prettier"), [
          "--check",
          "--ignore-unknown",
          "--log-level",
          "warn",
          ...formatFiles,
        ]),
      ),
    );
  }
  const lintFiles = existing.filter((p) => LINTABLE.test(p));
  if (lintFiles.length > 0) {
    pending.push(
      timed(`lint (${plural(lintFiles.length, "file")})`, () =>
        runNodeCaptured(binPath("eslint", "eslint"), [
          "--max-warnings",
          "0",
          "--no-warn-ignored",
          ...lintFiles,
        ]),
      ),
    );
  }
}

if (!options.list) {
  // In process, and awaited here: their console output is captured while they run.
  pending.push(Promise.resolve(await timed("runtime", () => quietly(runtime))));
  pending.push(Promise.resolve(await timed("generated files", () => quietly(generated))));
}
const t0 = performance.now();
const cruised = await cruise();
if (cruised.graph === null) {
  console.error(`dependency-cruiser gave no graph:\n${cruised.output}`);
  process.exit(1);
}
pending.push(
  Promise.resolve({
    name: "dependency rules",
    ok: cruised.ok,
    seconds: (performance.now() - t0) / 1000,
    output: cruised.output,
  }),
);
const listed = git(["ls-files", "-co", "--exclude-standard", "-z"]) ?? "";
const repo = repoFromCruise(
  cruised.graph,
  listed.split("\0").filter((p) => p !== "" && existsSync(join(repoRoot, p))),
  (p) => readFileSync(join(repoRoot, p), "utf8"),
);
const tests = repo.files.filter(isProductTest);
const selection: Selection = select(
  changed,
  repo,
  { tests, setup: SETUP_FILES },
  { slow: options.slow },
);
const e2eFiles = repo.files.filter((p) => p.startsWith(E2E_DIR) && p.endsWith(".e2e.ts"));
const browser: BrowserSelection = selectBrowser(changed, selection.reached, e2eFiles);

const vitest = await createVitest(
  { watch: false, project: ["product"], allowOnly: false, includeTaskLocation: true },
  {},
);
const project = vitest.getProjectByName("product");
const specs = selection.run.map((file) => project.createSpecification(join(repoRoot, file)));
const workers = typeof project.config.maxWorkers === "number" ? project.config.maxWorkers : 1;
// The tests' wall time from the durations Vitest last recorded: the work spread over the workers,
// or the longest file when that is longer. Only the spread makes a change CI-sized: a long file
// that runs is the change's own test.
const durations = specs.map((s) => vitest.cache.getTestSpecificationResult(s)?.duration);
const unknown = durations.filter((d) => d === undefined).length;
const known = durations.map((d) => (d ?? UNKNOWN_FILE_S * 1000) / 1000);
const spread = known.reduce((sum, d) => sum + d, 0) / workers;
const seconds = Math.max(spread, ...known);
const ciSized = !options.slow && spread > BUDGET_S;

const why = selection.everything === null ? "" : ` (all: ${selection.everything})`;
console.log(
  `selected ${String(selection.run.length + selection.deferred.length)} of ` +
    `${plural(tests.length, "product test file")}${why}; ` +
    `${String(selection.deferred.length)} slow left to CI; tests about ${seconds.toFixed(0)} s ` +
    `at ${String(workers)} workers`,
);
if (unknown > 0) {
  console.log(
    `no recorded duration yet for ${plural(unknown, "file")}: each counted as ${String(UNKNOWN_FILE_S)} s`,
  );
}
if (ciSized) {
  console.log(
    `this is a CI-sized change: its tests take more than ${String(BUDGET_S)} s here, so none run`,
  );
}
if (options.list) {
  const time = (d: number | undefined) =>
    (d === undefined ? "?" : (d / 1000).toFixed(1)).padStart(6);
  selection.run.forEach((file, i) => {
    console.log(`  run     ${time(durations[i])} s  ${file}`);
  });
  for (const file of selection.deferred) console.log(`  slow    left to CI  ${file}`);
  for (const file of browser.run) console.log(`  browser Chromium    ${file} (${browser.why})`);
  for (const file of browser.over) console.log(`  browser left to CI  ${file}`);
  await vitest.close();
  process.exit(0);
}

let browserRan: string[] = [];
let browserSkipped = "";
const browserFiles = ciSized ? [] : options.slow ? [...browser.run, ...browser.over] : browser.run;
if (browserFiles.length > 0) {
  if (!existsSync(chromium.executablePath())) {
    browserSkipped = "Chromium is not installed: pnpm exec playwright install chromium";
  } else {
    browserRan = browserFiles;
    const label =
      browserFiles.length > E2E_MAX
        ? plural(browserFiles.length, "file")
        : browserFiles.map((f) => f.slice(E2E_DIR.length)).join(", ");
    pending.push(
      timed(`browser tests (${label}, Chromium)`, () =>
        runNodeCaptured(binPath("@playwright/test", "playwright"), [
          "test",
          "--config",
          E2E_CONFIG,
          "--project=chromium",
          ...browserFiles.map((f) => f.slice(E2E_DIR.length)),
        ]),
      ),
    );
  }
}

let ran: TestModule[] = [];
if (specs.length > 0 && !ciSized) {
  const result = await timed(`product tests (${plural(specs.length, "file")})`, async () => {
    await vitest.standalone();
    const run = await vitest.runTestSpecifications(specs);
    ran = [...run.testModules];
    const ok = run.unhandledErrors.length === 0 && ran.every((m) => m.ok());
    return { status: ok ? 0 : 1, output: "Vitest's report above names the failures." };
  });
  pending.push(Promise.resolve(result));
}
await vitest.close();

pending.push(
  timed("test IDs", () =>
    quietly(() => {
      const manifest = parseManifest(
        JSON.parse(readFileSync(join(repoRoot, "tests", "manifest.json"), "utf8")),
      );
      const collected: CollectedTest[] = ran.flatMap((m) =>
        [...m.children.allTests()].map((t) => ({
          name: t.fullName,
          file: m.relativeModuleId,
          ...(t.location ? { line: t.location.line } : {}),
        })),
      );
      const e2eChanged = changed.some((p) => p === "tests/manifest.json" || p.startsWith(E2E_DIR));
      const e2e = e2eChanged ? collectE2e(repoRoot) : { tests: [], errors: [] };
      const errors = [
        ...(changed.includes("tests/manifest.json") ? manifest.errors : []),
        ...e2e.errors,
        ...checkIds(manifest.entries, [...collected, ...e2e.tests]),
      ];
      for (const e of errors) console.error(e);
      console.log(`${plural(collected.length + e2e.tests.length, "test")} carry known IDs`);
      return errors.length === 0;
    }),
  ),
);

const results = await Promise.all(pending);

// What the check did not run. Never empty: the lab tests, the crash run and the other systems are
// always CI's.
const notRun: string[] = [];
const selected = selection.run.length + selection.deferred.length;
if (ciSized) {
  notRun.push(
    `all ${plural(selection.run.length, "selected product test file")}: a CI-sized change ` +
      `(about ${seconds.toFixed(0)} s). Push, or run pnpm check --slow`,
  );
}
if (tests.length > selected) {
  notRun.push(
    `${String(tests.length - selected)} of ${plural(tests.length, "product test file")}: ` +
      "the change does not reach them",
  );
}
for (const file of selection.deferred) {
  notRun.push(`${file}: selected, but slow (pnpm check --slow runs it)`);
}
notRun.push(
  changed.some((p) => p === "eslint.config.js" || p.startsWith("scripts/eslint/"))
    ? "lint of the files the change did not edit, under its changed lint rules"
    : "lint of the files the change did not edit, which may use what it changed",
);
notRun.push("the test manifest's check that every entry has a test (pnpm verify)");
if (browserSkipped !== "") notRun.push(`browser tests: ${browserSkipped}`);
const others = e2eFiles.length - browserRan.length;
const over = browser.over.length > 0 ? `, ${String(browser.over.length)} of them selected` : "";
notRun.push(
  browserRan.length > 0
    ? `browser tests in Firefox, and ${plural(others, "other end-to-end file")}${over} (pnpm e2e)`
    : `browser tests (pnpm e2e): ${ciSized && browser.run.length > 0 ? "a CI-sized change" : browser.why}`,
);
const lab = changed.filter(isLabPath);
notRun.push(
  lab.length > 0 ? `lab tests: ${plural(lab.length, "lab file")} changed` : "lab tests (spikes/)",
);
notRun.push("the crash run (pnpm crash)");
notRun.push(`other operating systems: this ran on ${platformName ?? process.platform} only`);

console.log("");
for (const r of results.filter((r) => !r.ok)) {
  console.log(`--- ${r.name} FAILED ---\n${r.output.trimEnd()}\n`);
}
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.name.padEnd(width)}  ${r.ok ? "ok    " : "FAILED"}  ${r.seconds.toFixed(1)} s`);
}
console.log("\nNOT RUN");
for (const line of notRun) console.log(`  - ${line}`);
const total = ((performance.now() - started) / 1000).toFixed(1);
const failed = results.filter((r) => !r.ok).map((r) => r.name);
if (failed.length > 0) {
  console.log(`\ncheck FAILED in ${total} s: ${failed.join(", ")}`);
  process.exit(1);
}
const scope = ran.length + browserRan.length === 0 ? " (no tests ran)" : "";
console.log(
  `\ncheck passed in ${total} s${scope}. It is not a verify: push, and CI runs everything.`,
);
process.exit(0);
