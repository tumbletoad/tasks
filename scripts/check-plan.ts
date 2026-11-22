// What `pnpm check` runs for a change, and what it leaves to CI. No I/O: every input is passed in.
//
// A test reaches a file through what it imports at run time, and through a path it names in
// strings: a module that spawns `new URL("../src/hub/main.ts", import.meta.url)`, reads
// `join(here, "..", "fixtures", "claude-stream")` or compares with `./golden/detect.${os}.json`
// depends on those files as much as an importer does. The walk goes backwards from the changed
// files over both kinds of edge. What neither can see is in READS. A changed file the walk connects
// to no test selects every test: the check cannot tell that it affects none.
import { matchesGlob } from "node:path";

/** Paths are relative to the repository root, with forward slashes. */
export interface Repo {
  /** Every file git tracks or would track, and changed files that are gone. */
  files: readonly string[];
  /** For each file, the modules that import it at run time or name it in a string. */
  usedBy: ReadonlyMap<string, readonly string[]>;
  /** Files a module imports for their types only: the type checker covers a change to them. */
  typed: ReadonlySet<string>;
}

/** The parts of dependency-cruiser's JSON output that the check reads. */
export interface Cruise {
  modules: { source: string; dependencies: { resolved: string; dependencyTypes: string[] }[] }[];
  summary: {
    error: number;
    violations: { from: string; to: string; rule: { name: string; severity: string } }[];
  };
}

/** The repository as the selection sees it: dependency-cruiser's graph, the files and their text. */
export function repoFromCruise(
  graph: Cruise,
  files: readonly string[],
  read: (path: string) => string,
): Repo {
  const known = new Set(files);
  const usedBy = new Map<string, Set<string>>();
  const use = (file: string, module: string) => {
    if (file === module) return;
    const set = usedBy.get(file);
    if (set === undefined) usedBy.set(file, new Set([module]));
    else set.add(module);
  };
  const typed = new Set<string>();
  for (const m of graph.modules) {
    for (const d of m.dependencies) {
      if (!known.has(d.resolved)) continue;
      const typeOnly =
        d.dependencyTypes.includes("type-only") || d.dependencyTypes.includes("type-import");
      if (typeOnly) typed.add(d.resolved);
      else use(d.resolved, m.source);
    }
  }
  for (const [file, modules] of namers(files, read)) for (const m of modules) use(file, m);
  return {
    files,
    usedBy: new Map([...usedBy].map(([file, set]) => [file, [...set]])),
    typed,
  };
}

export interface TestSet {
  /** The product test files that exist. */
  tests: readonly string[];
  /** Files every test loads before its own imports: Vitest's setup files. */
  setup: readonly string[];
  /** Whether a path is a test of any kind, the check's or one it leaves to CI, there or gone. */
  isTest: (path: string) => boolean;
}

/** A change to one of these can change how every test runs. */
const EVERYTHING = [
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)package\.json$/,
  /^\.node-version$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^vitest\.config\.ts$/,
];

/**
 * Kinds of file that no test reads, or that a step of the check covers in full: a change to one
 * that no test reaches affects nothing the check leaves out.
 */
const INERT = [/\.md$/i, /(^|\/)LICENSE[^/]*$/, /^\.prettier(rc[^/]*|ignore)$/];

/** A READS entry for every file: it does not connect a file to a test of what it does. */
const ANY = "**";

/**
 * Tests that read files no import or path string names: a folder they scan, or the whole tree.
 * When CI fails on a test the check did not select, the missing edge goes here.
 */
export const READS: readonly { changed: string; tests: readonly string[] }[] = [
  { changed: ANY, tests: ["scripts/machine-facts.test.ts"] },
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
  { test: "packages/service/test/launch-shim.test.ts" },
];

export interface Selection {
  /** The change that selects every test, or null. */
  everything: string | null;
  /** Changed files that reach no test and are not INERT: the check cannot tell what they affect. */
  unseen: string[];
  /** Every file that reaches a changed file, the changed files included. */
  reached: ReadonlySet<string>;
  /** Selected test files that are changed themselves, or import or name a changed file. */
  direct: ReadonlySet<string>;
  /** Selected test files that run. */
  run: string[];
  /** Selected slow test files left to CI. */
  deferred: string[];
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
/** A string that could be a path or a part of one. In a template, each `${…}` stands for a name. */
const PART = /"[\w@.~/+-]+"|'[\w@.~/+-]+'|`(?:[\w@.~/+-]|\$\{[^`}]*\})+`/;
/** One such string, or several in a row as a call's arguments: `join(here, "..", "fixtures")`. */
const PARTS = new RegExp(`(?:${PART.source})(?:\\s*,\\s*(?:${PART.source}))*`, "g");
const EACH_PART = new RegExp(PART.source, "g");
/** What comes before a call's second argument: `join(here, ` or `join(dirname(x), `. */
const AFTER_PATH = /[\w)]\s*,\s*$/;
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

/** A string as a path pattern: quotes off, each `${…}` as `*`. */
const pattern = (part: string) => part.slice(1, -1).replace(/\$\{[^}]*\}/g, "*");

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
 * For each file, the modules that name it in strings: as a path relative to the module or to the
 * repository, by a path suffix that only it has (`"hub/main.ts"`, `"eslint.config.js"`), inside a
 * folder named the same ways, or as a match of a name built at run time (`golden/detect.${os}.json`).
 */
function namers(
  files: readonly string[],
  read: (path: string) => string,
): Map<string, Set<string>> {
  const known = new Set(files);
  /** Each folder's files, at any depth. */
  const under = new Map<string, string[]>();
  const bySuffix = new Map<string, string[]>();
  const index = (map: Map<string, string[]>, key: string, file: string) => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [file]);
    else list.push(file);
  };
  for (const file of known) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) index(under, parts.slice(0, i).join("/"), file);
    for (let i = 0; i < parts.length; i++) index(bySuffix, parts.slice(i).join("/"), file);
  }
  /** Folders by each of their path suffixes. */
  const dirsBySuffix = new Map<string, string[]>();
  for (const dir of under.keys()) {
    const parts = dir.split("/");
    for (let i = 0; i < parts.length; i++) index(dirsBySuffix, parts.slice(i).join("/"), dir);
  }
  /** The files a path names: the file, the files in the folder, or the matches of a built name. */
  const at = (path: string, folders: boolean): readonly string[] => {
    if (!path.includes("*")) {
      if (known.has(path)) return [path];
      return folders ? (under.get(path) ?? []) : [];
    }
    const parts = path.split("/");
    const fixed = parts
      .slice(
        0,
        parts.findIndex((p) => p.includes("*")),
      )
      .join("/");
    return fixed === "" ? [] : (under.get(fixed) ?? []).filter((f) => matchesGlob(f, path));
  };

  const result = new Map<string, Set<string>>();
  for (const module of known) {
    if (!SOURCE.test(module)) continue;
    let source: string;
    try {
      source = read(module);
    } catch {
      continue;
    }
    const targets = new Set<string>();
    /**
     * `bare`: a single name without a folder. It names a folder next to the module only as the
     * one name after a path, as in `join(here, "fixtures")`: elsewhere a word like "build" is an
     * argument or a word in a comment.
     */
    const consider = (path: string, bare: false | "name" | "folder") => {
      if (!/\w/.test(path)) return;
      const relative = resolveIn(parentDir(module), path);
      if (relative !== null && relative !== "") {
        for (const f of at(relative, bare !== "name")) targets.add(f);
      }
      const plain = path.replace(/^(?:\.{1,2}\/)+/, "");
      if (plain.includes("/")) for (const f of at(plain, true)) targets.add(f);
      if (plain.includes("*")) return;
      const owners = bySuffix.get(plain);
      const owner = owners?.length === 1 ? owners[0] : undefined;
      if (owner !== undefined && (!bare || namesFolder(source, owner))) targets.add(owner);
      const dirs = plain.includes("/") ? dirsBySuffix.get(plain) : undefined;
      const dir = dirs?.length === 1 ? dirs[0] : undefined;
      if (dir !== undefined) for (const f of under.get(dir) ?? []) targets.add(f);
    };
    for (const run of source.matchAll(PARTS)) {
      if (SPECIFIER.test(source.slice(Math.max(0, run.index - 12), run.index))) continue;
      const raw = [...run[0].matchAll(EACH_PART)].map((m) => m[0]);
      const parts = raw.map(pattern);
      if (parts.length > 1) consider(parts.join("/"), false);
      const afterPath =
        parts.length === 1 &&
        !run[0].startsWith("`") &&
        AFTER_PATH.test(source.slice(Math.max(0, run.index - 40), run.index));
      for (const part of parts) {
        if (part.length < 3) continue;
        consider(part, part.includes("/") ? false : afterPath ? "folder" : "name");
      }
    }
    for (const target of targets) {
      if (target === module) continue;
      const set = result.get(target);
      if (set === undefined) result.set(target, new Set([module]));
      else set.add(module);
    }
  }
  return result;
}

/** Every file that can reach `file`, `file` included. */
function reaching(file: string, usedBy: Repo["usedBy"]): Set<string> {
  const seen = new Set([file]);
  const queue = [file];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const user of usedBy.get(next) ?? []) {
      if (!seen.has(user)) {
        seen.add(user);
        queue.push(user);
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
  options: { slow: boolean; slowFiles?: typeof SLOW },
): Selection {
  const tests = new Set(set.tests);
  const reached = new Set<string>();
  const unseen: string[] = [];
  for (const file of changed) {
    const mine = reaching(file, repo.usedBy);
    for (const f of mine) reached.add(f);
    const seen =
      [...mine].some((f) => set.isTest(f)) ||
      repo.typed.has(file) ||
      INERT.some((rule) => rule.test(file)) ||
      EVERYTHING.some((rule) => rule.test(file)) ||
      READS.some((read) => read.changed !== ANY && matchesGlob(file, read.changed));
    if (!seen) unseen.push(file);
  }
  const trigger = changed.find((p) => EVERYTHING.some((rule) => rule.test(p)));
  const setup = set.setup.find((file) => reached.has(file));
  const more = unseen.length > 1 ? ` (and ${String(unseen.length - 1)} more)` : "";
  const everything =
    trigger !== undefined
      ? `${trigger} changed`
      : setup !== undefined
        ? `the setup file ${setup} reaches a changed file`
        : unseen[0] !== undefined
          ? `${unseen[0]}${more} reaches no test the check can see`
          : null;

  const selected = new Set<string>();
  if (everything !== null) {
    for (const test of set.tests) selected.add(test);
  } else {
    for (const file of reached) if (tests.has(file)) selected.add(file);
    for (const read of READS) {
      if (!changed.some((p) => matchesGlob(p, read.changed))) continue;
      for (const test of set.tests) {
        if (read.tests.some((glob) => matchesGlob(test, glob))) selected.add(test);
      }
    }
  }
  const direct = new Set(
    changed.flatMap((p) => [p, ...(repo.usedBy.get(p) ?? [])]).filter((f) => tests.has(f)),
  );

  const run: string[] = [];
  const deferred: string[] = [];
  for (const test of [...selected].sort()) {
    const slow = (options.slowFiles ?? SLOW).find((s) => s.test === test);
    const now =
      options.slow ||
      slow === undefined ||
      changed.includes(test) ||
      (slow.home !== undefined && changed.some((p) => p.startsWith(slow.home ?? "")));
    (now ? run : deferred).push(test);
  }
  return { everything, unseen, reached, direct, run, deferred };
}

export interface Fit {
  /** The tests that run, in the order they were chosen, and why each one. */
  run: { file: string; why: "edited" | "direct" }[];
  /** The selected tests that do not run. */
  left: string[];
}

/**
 * For a selection over the budget, the closest tests that fit in it: the test files the change
 * edits, then the tests that import or name a changed file, each group shortest first. `budget`
 * is in file-seconds: the wall time it allows times the workers.
 */
export function fitBudget(
  selection: Selection,
  changed: readonly string[],
  seconds: (file: string) => number,
  budget: number,
): Fit {
  const shortestFirst = (files: string[]) =>
    files.sort((a, b) => seconds(a) - seconds(b) || a.localeCompare(b));
  const edited = shortestFirst(selection.run.filter((f) => changed.includes(f)));
  const direct = shortestFirst(
    selection.run.filter((f) => selection.direct.has(f) && !changed.includes(f)),
  );
  const run: Fit["run"] = [];
  let used = 0;
  for (const [files, why] of [
    [edited, "edited"],
    [direct, "direct"],
  ] as const) {
    for (const file of files) {
      if (used + seconds(file) > budget) continue;
      used += seconds(file);
      run.push({ file, why });
    }
  }
  const chosen = new Set(run.map((r) => r.file));
  return { run, left: selection.run.filter((f) => !chosen.has(f)) };
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
