// What `pnpm check` runs for a change, and what it leaves to CI. No I/O: every input is passed in.
//
// A test reaches a file through what it imports at run time, and through a path it names in a
// string: a module that spawns `new URL("../src/hub/main.ts", import.meta.url)` or reads
// `here("terminal.ts")` depends on that file as much as an importer does. The walk goes backwards
// from the changed files over both kinds of edge. What neither can see (a test that reads a whole
// folder) is in READS, and a change that can alter every test selects all of them.
import { matchesGlob } from "node:path";

/** Paths are relative to the repository root, with forward slashes. */
export interface Repo {
  /** Every file git tracks or would track. */
  files: readonly string[];
  /** Each module's run-time imports. Type-only imports are left out: they never load. */
  imports: ReadonlyMap<string, readonly string[]>;
  /** A module's source text. */
  read: (path: string) => string;
}

/** The parts of dependency-cruiser's JSON output that the check reads. */
export interface Cruise {
  modules: { source: string; dependencies: { resolved: string; dependencyTypes: string[] }[] }[];
  summary: {
    error: number;
    violations: { from: string; to: string; rule: { name: string; severity: string } }[];
  };
}

/** The repository as the selection sees it, from dependency-cruiser's graph and the file list. */
export function repoFromCruise(
  graph: Cruise,
  files: readonly string[],
  read: (path: string) => string,
): Repo {
  const known = new Set(files);
  const imports = new Map<string, string[]>();
  for (const m of graph.modules) {
    const loaded = m.dependencies.filter(
      (d) =>
        known.has(d.resolved) &&
        !d.dependencyTypes.includes("type-only") &&
        !d.dependencyTypes.includes("type-import"),
    );
    imports.set(
      m.source,
      loaded.map((d) => d.resolved),
    );
  }
  return { files, imports, read };
}

export interface TestSet {
  /** The product test files. */
  tests: readonly string[];
  /** Files every test loads before its own imports: Vitest's setup files. */
  setup: readonly string[];
}

/** A change to one of these can change how every test runs. */
const EVERYTHING = [
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)package\.json$/,
  /^\.node-version$/,
  /^tsconfig[^/]*\.json$/,
  /^vitest\.config\.ts$/,
];

/**
 * Tests that read files no import or path literal names: a folder they scan, or the whole tree.
 * When CI fails on a test the check did not select, the missing edge goes here.
 */
export const READS: readonly { changed: string; tests: readonly string[] }[] = [
  { changed: "**", tests: ["scripts/machine-facts.test.ts"] },
  {
    changed: "packages/web/src/**",
    tests: ["packages/web/test/catalogue.test.ts", "packages/web/test/styles.test.ts"],
  },
  { changed: "packages/contracts/**", tests: ["scripts/generated.test.ts"] },
  { changed: ".dependency-cruiser.cjs", tests: ["scripts/dependency-rules.test.ts"] },
  { changed: "packages/launcher-win/src/**", tests: ["packages/launcher-win/test/*.test.ts"] },
  { changed: "scripts/install/**", tests: ["scripts/install/*.test.ts"] },
  {
    changed: "fixtures/streams/**",
    tests: [
      "tests/stream-content.test.ts",
      "tests/claude-stream/*.test.ts",
      "tests/codex-app-server/*.test.ts",
    ],
  },
];

/**
 * Files that take 40 s or more alone on a quiet desktop, so that any one of them fills the check's
 * minute. They are left to CI unless `--slow` is given, and still run when they changed themselves
 * or when a changed file lies under their `home`: there they are the test of what changed.
 */
export const SLOW: readonly { test: string; home?: string }[] = [
  { test: "tests/update/installed.test.ts", home: "tests/update/" },
  { test: "tests/update/launchers.test.ts", home: "tests/update/" },
  { test: "scripts/install/install.test.ts", home: "scripts/install/" },
  { test: "packages/projection/test/model.test.ts" },
  { test: "packages/cli/test/doctor-agents.test.ts" },
  { test: "packages/storage/test/bundle.test.ts" },
  { test: "packages/launch/test/machine.prop.test.ts" },
  { test: "packages/service/test/launch-shim.test.ts" },
];

export interface Selection {
  /** The change that selects every test, or null. */
  everything: string | null;
  /** Every file that reaches a changed file, the changed files included. */
  reached: ReadonlySet<string>;
  /** Selected test files that run. */
  run: string[];
  /** Selected slow test files left to CI. */
  deferred: string[];
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
/** A string literal without interpolation that could be a path. */
const LITERAL = /(["'`])([\w@.~/+-]{3,200})\1/g;
/** What comes before an import specifier: the graph holds those, with their kind. */
const SPECIFIER = /(?:\bfrom|\bimport|\bexport|\brequire\s*\(|\bimport\s*\()\s*$/;

const parentDir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** `base` joined with a relative path, or null when it climbs out of the repository. */
function resolveIn(base: string, rel: string): string | null {
  const parts = base === "" ? [] : base.split("/");
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

/**
 * Whether a module that names a file by its bare name also names its folder, as in
 * `join(root, "tests", "manifest.json")`. A bare name alone is too common to count: dozens of
 * modules say "manifest.json" about a version folder's manifest, not about the tests' one.
 */
function namesFolder(source: string, file: string): boolean {
  const folder = parentDir(file);
  if (folder === "") return true;
  const last = folder.slice(folder.lastIndexOf("/") + 1);
  return ['"', "'", "`"].some((q) => source.includes(`${q}${last}${q}`));
}

/**
 * For each file, the modules that name it in a string literal: as a path relative to the module,
 * or by a path suffix that only that file has (`"hub/main.ts"`, `"eslint.config.js"`).
 */
export function namers(repo: Repo): Map<string, Set<string>> {
  const files = new Set(repo.files);
  const bySuffix = new Map<string, string[]>();
  for (const file of repo.files) {
    const parts = file.split("/");
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join("/");
      const list = bySuffix.get(suffix);
      if (list === undefined) bySuffix.set(suffix, [file]);
      else list.push(file);
    }
  }
  const named = new Map<string, Set<string>>();
  for (const module of repo.files) {
    if (!SOURCE.test(module)) continue;
    let source: string;
    try {
      source = repo.read(module);
    } catch {
      continue;
    }
    for (const match of source.matchAll(LITERAL)) {
      const literal = match[2] ?? "";
      if (SPECIFIER.test(source.slice(Math.max(0, match.index - 12), match.index))) continue;
      const targets = new Set<string>();
      const relative = resolveIn(parentDir(module), literal);
      if (relative !== null && files.has(relative)) targets.add(relative);
      const suffix = literal.replace(/^(?:\.{1,2}\/)+/, "");
      const owners = bySuffix.get(suffix);
      const owner = owners?.length === 1 ? owners[0] : undefined;
      if (owner !== undefined && (suffix.includes("/") || namesFolder(source, owner))) {
        targets.add(owner);
      }
      for (const target of targets) {
        if (target === module) continue;
        const set = named.get(target);
        if (set === undefined) named.set(target, new Set([module]));
        else set.add(module);
      }
    }
  }
  return named;
}

/** Every file that can reach one of `changed`, the changed files included. */
function reaching(changed: readonly string[], repo: Repo): Set<string> {
  const named = namers(repo);
  const importers = new Map<string, string[]>();
  for (const [module, deps] of repo.imports) {
    for (const dep of deps) {
      const list = importers.get(dep);
      if (list === undefined) importers.set(dep, [module]);
      else list.push(module);
    }
  }
  const seen = new Set(changed);
  const queue = [...changed];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const next of [...(importers.get(file) ?? []), ...(named.get(file) ?? [])]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** The test files a change selects, and which of them run now. */
export function select(
  changed: readonly string[],
  repo: Repo,
  set: TestSet,
  options: { slow: boolean },
): Selection {
  const tests = new Set(set.tests);
  const reached = reaching(changed, repo);
  const trigger = changed.find((p) => EVERYTHING.some((rule) => rule.test(p)));
  const setup = set.setup.find((file) => reached.has(file));
  const everything =
    trigger !== undefined
      ? `${trigger} changed`
      : setup !== undefined
        ? `the setup file ${setup} reaches a changed file`
        : null;

  const selected = new Set<string>();
  if (everything !== null) {
    for (const test of set.tests) selected.add(test);
  } else {
    for (const file of reached) if (tests.has(file)) selected.add(file);
    for (const read of READS) {
      if (!changed.some((p) => matchesGlob(p, read.changed))) continue;
      for (const test of set.tests) {
        if (read.tests.some((pattern) => matchesGlob(test, pattern))) selected.add(test);
      }
    }
  }

  const run: string[] = [];
  const deferred: string[] = [];
  for (const test of [...selected].sort()) {
    const slow = SLOW.find((s) => s.test === test);
    const now =
      options.slow ||
      slow === undefined ||
      changed.includes(test) ||
      (slow.home !== undefined && changed.some((p) => p.startsWith(slow.home ?? "")));
    (now ? run : deferred).push(test);
  }
  return { everything, reached, run, deferred };
}

export const E2E_DIR = "tests/e2e/";
/** Files that are the page or serve it: a change that reaches one reaches the browser. */
export const PAGE_ROOTS = ["packages/web/src/main.tsx", "packages/service/src/http/app.ts"];
/** The end-to-end file that loads the page and checks its frame, for a change no name matches. */
const E2E_FALLBACK = "tests/e2e/skeleton.e2e.ts";
/** At most this many end-to-end files run: about the time of one file with Playwright's 2 workers. */
export const E2E_MAX = 2;

export interface BrowserSelection {
  /** End-to-end files to run in Chromium. */
  run: string[];
  /** End-to-end files the change selects that do not fit in E2E_MAX. */
  over: string[];
  /** Why they run, or why none does. */
  why: string;
}

/**
 * The end-to-end files for a change, in this order: the ones it edits, one named after a changed
 * part of the page (`views/Today.tsx` → `today.e2e.ts`), the skeleton test when neither gives one,
 * then the ones that reach a changed file through their own helpers. The first E2E_MAX of them run.
 */
export function selectBrowser(
  changed: readonly string[],
  reached: ReadonlySet<string>,
  e2eFiles: readonly string[],
): BrowserSelection {
  const edited = changed.filter((p) => e2eFiles.includes(p)).sort();
  const page = PAGE_ROOTS.some((root) => reached.has(root));
  const viaHelpers = e2eFiles.filter((f) => reached.has(f) && !edited.includes(f)).sort();
  const byName = new Map(e2eFiles.map((f) => [f.slice(E2E_DIR.length, -".e2e.ts".length), f]));
  const named: string[] = [];
  for (const p of page ? changed : []) {
    if (!p.startsWith("packages/web/src/") && !p.startsWith("packages/service/src/http/")) continue;
    const parts = p
      .replace(/.[^/.]+$/, "")
      .split("/")
      .reverse();
    const hit = parts.map((part) => byName.get(part.toLowerCase())).find((f) => f !== undefined);
    if (hit !== undefined) named.push(hit);
  }
  const reaches = page || viaHelpers.length > 0;
  const fallback =
    reaches && edited.length + named.length === 0 && e2eFiles.includes(E2E_FALLBACK)
      ? [E2E_FALLBACK]
      : [];
  const wanted = [...new Set([...edited, ...named.sort(), ...fallback, ...viaHelpers])];
  const why = page
    ? "the change reaches the page"
    : viaHelpers.length > 0
      ? "the change reaches the browser tests' helpers"
      : edited.length > 0
        ? "the change edits them"
        : "the change does not reach the page";
  return { run: wanted.slice(0, E2E_MAX), over: wanted.slice(E2E_MAX), why };
}
