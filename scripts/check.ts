// pnpm check: the checks and tests a change can affect, in about a minute, and a list of what it
// did not run. It is not a verify: CI runs everything on the push.
//
//   pnpm check                 the change since the merge base with origin/main, uncommitted and
//                              untracked files included
//   pnpm check --base <rev>    the change since the merge base with <rev>
//   pnpm check <path>...       as if exactly these files had changed (a folder: the files in it)
//   pnpm check --slow          also the slow files, and all of a selection too big for a minute
//   pnpm check --list          say what would run, and run nothing
//
// The static steps run beside the tests. The caches it keeps are in node_modules/.cache/check.
//
// safe-exit comes first: this script loads the product's generators and ends through
// `process.exit`.
import "../packages/bridge/src/safe-exit.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createVitest, type TestModule } from "vitest/node";
import { SETUP_FILES, testFiles } from "../vitest.config.ts";
import {
  browserFilters,
  E2E_DIR,
  E2E_MAX,
  fitBudget,
  select,
  selectBrowser,
  repoFromCruise,
  type BrowserSelection,
  type Cruise,
  type Fit,
  type Selection,
} from "./check-plan.ts";
import { changedSince } from "./verify-base.ts";
import { checkIdsQuickly, E2E_CONFIG, type Change, type CollectedTest } from "./manifest.ts";
import { binPath, repoRoot, runNodeCaptured, type Captured } from "./run.ts";
import { CRUISE_ROOTS, generated, runtime, typecheck } from "./steps.ts";

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
    } else options.paths.push(arg);
  }
  if (options.base !== null && options.paths.length > 0) {
    throw new Error("give --base or paths, not both");
  }
  return options;
}

/** Git's output. A git that fails stops the check: an empty answer would read as "nothing changed". */
function mustGit(args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status === 0) return result.stdout;
  const why = (result.stderr || result.error?.message || `exit ${String(result.status)}`).trim();
  throw new Error(`git ${args.join(" ")} failed: ${why}`);
}

/**
 * The files the given paths name, as git spells them: a path is taken from the folder pnpm was
 * started in, a folder stands for the files under it, and on Windows and macOS any case matches.
 */
function givenFiles(paths: readonly string[], files: readonly string[]): string[] {
  const from = process.env["INIT_CWD"] ?? process.cwd();
  const fold = process.platform === "linux" ? (p: string) => p : (p: string) => p.toLowerCase();
  const spelled = new Map(files.map((f) => [fold(f), f]));
  const out = new Set<string>();
  for (const given of paths) {
    const absolute = resolve(from, given);
    const rel = relative(repoRoot, absolute).replaceAll("\\", "/");
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      throw new Error(`${given} is outside the repository`);
    }
    const tracked = spelled.get(fold(rel));
    if (tracked !== undefined) {
      out.add(tracked);
      continue;
    }
    if (!existsSync(absolute)) throw new Error(`no such file: ${given}`);
    if (statSync(absolute).isDirectory()) {
      const prefix = rel === "" ? "" : `${fold(rel)}/`;
      const inside = files.filter((f) => fold(f).startsWith(prefix));
      if (inside.length === 0) throw new Error(`no files git knows under ${given}`);
      for (const f of inside) out.add(f);
    } else out.add(rel);
  }
  return [...out].sort();
}

/** The changed files and how to name where they come from. */
function findChange(
  options: Options,
  files: readonly string[],
): { changed: string[]; label: string; since: Change } {
  if (options.paths.length > 0) {
    const changed = givenFiles(options.paths, files);
    return { changed, label: "given on the command line", since: { base: "HEAD", paths: changed } };
  }
  const rev = options.base ?? "origin/main";
  let mergeBase: string;
  try {
    mergeBase = mustGit(["merge-base", rev, "HEAD"]).trim();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`no merge base with ${rev} here (${why}). Fetch it, or give --base <rev>.`, {
      cause: error,
    });
  }
  const changed = changedSince(mustGit, mergeBase);
  if (changed === null) throw new Error(`git diff against ${mergeBase} failed`);
  return {
    changed: [...new Set(changed.map((p) => p.replaceAll("\\", "/")))].sort(),
    label: `since ${rev} (merge base ${mergeBase.slice(0, 12)})`,
    since: { base: mergeBase },
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
  !testFiles.exclude.some((g) => matchesGlob(path, g));

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

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? "" : "s"}`;
const platformName = { win32: "Windows", linux: "Linux", darwin: "macOS" }[
  process.platform as string
];

let options: Options;
let change: { changed: string[]; label: string; since: Change };
/** Every file git tracks or would track that is there. */
let files: string[];
try {
  options = parseArgs(process.argv.slice(2));
  const listed = mustGit(["ls-files", "-co", "--exclude-standard", "-z"])
    .split("\0")
    .filter((p) => p !== "");
  files = listed.filter((p) => existsSync(join(repoRoot, p)));
  change = findChange(options, listed);
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
  pending.push(
    timed("typecheck", () =>
      typecheck((project) => [
        "--incremental",
        "--tsBuildInfoFile",
        `${CACHE}/tsc/${project.replaceAll("/", "-")}.tsbuildinfo`,
      ]),
    ),
  );
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
// The changed files that are gone stay in the repository's file list: a module that names one
// still selects its tests.
const repo = repoFromCruise(cruised.graph, [...new Set([...files, ...changed])], (p) =>
  readFileSync(join(repoRoot, p), "utf8"),
);
const tests = files.filter(isProductTest);
const isTest = (p: string) => isProductTest(p) || (p.startsWith(E2E_DIR) && p.endsWith(".e2e.ts"));
const selection: Selection = select(
  changed,
  repo,
  { tests, setup: SETUP_FILES, isTest },
  { slow: options.slow },
);
const e2eFiles = files.filter((p) => p.startsWith(E2E_DIR) && p.endsWith(".e2e.ts"));

const vitest = await createVitest(
  { watch: false, project: ["product"], allowOnly: false, includeTaskLocation: true },
  {},
);
const project = vitest.getProjectByName("product");
const workers = typeof project.config.maxWorkers === "number" ? project.config.maxWorkers : 1;
/** The duration Vitest last recorded for a file, in seconds. */
const recorded = new Map(
  selection.run.map((file) => {
    const ms = vitest.cache.getTestSpecificationResult(
      project.createSpecification(join(repoRoot, file)),
    )?.duration;
    return [file, ms === undefined ? undefined : ms / 1000];
  }),
);
const secondsOf = (file: string) => recorded.get(file) ?? UNKNOWN_FILE_S;
// The tests' wall time: the work spread over the workers, or the longest file when that is longer.
// Only the spread makes a change CI-sized: a long file that runs is the change's own test.
const spreadOf = (run: readonly string[]) =>
  run.reduce((sum, file) => sum + secondsOf(file), 0) / workers;
/** Seconds as the summary shows them: whole above 10, one decimal below. */
const about = (s: number) => s.toFixed(s < 10 ? 1 : 0);
const wallOf = (run: readonly string[]) => Math.max(spreadOf(run), ...run.map(secondsOf));
const unknown = selection.run.filter((file) => recorded.get(file) === undefined).length;
const ciSized = !options.slow && spreadOf(selection.run) > BUDGET_S;
const fit: Fit | null = ciSized
  ? fitBudget(selection, changed, secondsOf, BUDGET_S, workers)
  : null;
const runFiles = fit === null ? selection.run : fit.run.map((r) => r.file);
const browser: BrowserSelection = selectBrowser(changed, selection.reached, e2eFiles, ciSized);
const specs = runFiles.map((file) => project.createSpecification(join(repoRoot, file)));

const why = selection.everything === null ? "" : ` (all: ${selection.everything})`;
console.log(
  `selected ${String(selection.run.length + selection.deferred.length)} of ` +
    `${plural(tests.length, "product test file")}${why}; ` +
    `${String(selection.deferred.length)} slow left to CI; ` +
    `tests about ${about(wallOf(selection.run))} s at ${String(workers)} workers`,
);
if (selection.unseen.length > 0) {
  const shown = selection.unseen.slice(0, 10).join(", ");
  const more =
    selection.unseen.length > 10 ? ` and ${String(selection.unseen.length - 10)} more` : "";
  console.log(
    `the check cannot tell what these affect, so it counts them as affecting every test: ${shown}${more}`,
  );
}
if (unknown > 0) {
  console.log(
    `no recorded duration yet for ${plural(unknown, "file")}: each counted as ${String(UNKNOWN_FILE_S)} s`,
  );
}
if (fit !== null) {
  console.log(
    `this is a CI-sized change: its tests take more than ${String(BUDGET_S)} s here, so the ` +
      `${plural(fit.run.length, "closest test file")} that fit run (about ` +
      `${about(wallOf(runFiles))} s) and CI runs the other ${String(fit.left.length)}`,
  );
}
const browserFiles = options.slow ? [...browser.run, ...browser.over] : browser.run;
if (options.list) {
  const time = (file: string) => (recorded.get(file)?.toFixed(1) ?? "?").padStart(6);
  const reason = new Map(
    fit?.run.map((r) => [
      r.file,
      { edited: "edited", direct: "uses a changed file", "through others": "through other files" }[
        r.why
      ],
    ]),
  );
  for (const file of runFiles) {
    const because = reason.get(file);
    console.log(
      `  run     ${time(file)} s  ${file}${because === undefined ? "" : ` (${because})`}`,
    );
  }
  for (const file of fit?.left ?? []) console.log(`  over    ${time(file)} s  ${file}`);
  for (const file of selection.deferred) console.log(`  slow    left to CI  ${file}`);
  for (const file of [...browser.run, ...browser.over]) {
    console.log(
      browserFiles.includes(file)
        ? `  browser Chromium    ${file} (${browser.why})`
        : `  browser left to CI  ${file}`,
    );
  }
  await vitest.close();
  process.exit(0);
}

let browserRan: string[] = [];
let browserSkipped = "";
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
          ...browserFilters(browserFiles),
        ]),
      ),
    );
  }
}

let ran: TestModule[] = [];
if (specs.length > 0) {
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
    quietly(async () => {
      const collected: CollectedTest[] = ran.flatMap((m) =>
        [...m.children.allTests()].map((t) => ({
          name: t.fullName,
          file: m.relativeModuleId,
          ...(t.location ? { line: t.location.line } : {}),
        })),
      );
      const { errors, tests } = await checkIdsQuickly(collected, change.since);
      for (const e of errors) console.error(e);
      console.log(`${plural(tests, "test")} checked`);
      return errors.length === 0;
    }),
  ),
);

const results = await Promise.all(pending);

// What the check did not run. Never empty: the crash run and the other systems are always CI's.
const notRun: string[] = [];
const selected = selection.run.length + selection.deferred.length;
if (fit !== null && fit.left.length > 0) {
  notRun.push(
    `${String(fit.left.length)} of ${plural(selection.run.length, "selected product test file")}: ` +
      `a CI-sized change (about ${about(wallOf(selection.run))} s). Push, or run pnpm check --slow`,
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
notRun.push(
  "the test manifest's check that every entry the change did not touch has a test, and of IDs " +
    "in titles built as their file runs, in files the check did not run (pnpm verify)",
);
if (browserSkipped !== "") notRun.push(`browser tests: ${browserSkipped}`);
const others = e2eFiles.length - browserRan.length;
const waiting = [...browser.run, ...browser.over].filter((f) => !browserRan.includes(f)).length;
const over = waiting > 0 ? `, ${String(waiting)} of them selected` : "";
notRun.push(
  browserRan.length > 0
    ? `browser tests in Firefox, and ${plural(others, "other end-to-end file")}${over} (pnpm e2e)`
    : `browser tests (pnpm e2e): ${ciSized && browser.over.length > 0 ? "a CI-sized change" : browser.why}`,
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
