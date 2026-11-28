// The test-manifest check (A7 3.18.6, AGENTS.md "Every new test carries its ID").
//
// How a test carries its ID: put the manifest ID in square brackets in the test title or in the
// title of an enclosing `describe`, for example
//
//   describe("[A7.3.18.6.manifest-check] the test-manifest check", () => { test("…", …) })
//   test("[A2.3.2.brand.names] names derive from one constant", …)
//
// A test may carry more than one ID. An ID has a capitalised first segment followed by lowercase
// segments separated by dots: `A1.5.receipts.noop-retry`.
//
// The check collects every test through Vitest's own collection (the API behind `vitest list`), so
// it sees exactly the tests Vitest runs, including nested suites, generated titles, and skipped and
// todo tests, which `vitest list` leaves out. It fails when
//   - a test carries no ID, skipped and todo tests included,
//   - a test carries an ID that is not in tests/manifest.json,
//   - an entry of kind `ci` or `installed` has no test carrying its ID (`manual` entries have none),
//   - the manifest is malformed or holds an ID twice,
//   - a test file cannot be collected, or a test or suite is marked `.only`, which silently skips
//     the rest of its file,
//   - the repository holds a test-like file that Vitest does not collect, such as `*.spec.ts`,
//     `*.test.js` or a file under `__tests__/`. The only test file names are *.test.ts and
//     *.test.tsx (vitest.config.ts), so such a file would never run and never be checked.
// A skipped test still covers its entry, because a platform-specific test is skipped on the other OS.
//
// The end-to-end tests (`pnpm e2e`, tests/e2e/*.e2e.ts) are Playwright's, not Vitest's: they are
// collected through Playwright's own listing (`playwright test --list`) and checked the same way.
//
// Run directly: node scripts/manifest.ts [root]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createVitest } from "vitest/node";
import { binPath, repoRoot, runNode } from "./run.ts";

export const KINDS = ["ci", "installed", "manual"] as const;
export type Kind = (typeof KINDS)[number];

/** The scope profiles of A7 3.18.6. */
export const PROFILES = [
  "v1",
  "v1-cut-1",
  "v1-cut-2",
  "v1-cut-3",
  "v1-cut-4",
  "v1-cut-5",
  "v1-cut-6",
] as const;

const ID_SOURCE = "[A-Z][A-Z0-9]*(?:\\.[a-z0-9]+(?:-[a-z0-9]+)*)+";
const ID = new RegExp(`^${ID_SOURCE}$`);
const ID_TAG = new RegExp(`\\[(${ID_SOURCE})\\]`, "g");
const OWNER = /^M(?:0|[1-9][0-9]?)$/;

export interface ManifestEntry {
  id: string;
  title: string;
  /**
   * Where the test came from, as free text. Optional and read by nothing: the planning sections it
   * named are cut down and renamed, so it is not required and not checked beyond being text.
   */
  source?: string;
  /** The milestone that first owns the test, for example "M1". */
  owner: string;
  kind: Kind;
  profiles: string[];
}

export interface CollectedTest {
  /** Full name, with enclosing suite titles joined by " > ". */
  name: string;
  file: string;
  line?: number;
}

export function idsInTitle(name: string): string[] {
  return [...name.matchAll(ID_TAG)].map((m) => m[1] ?? "");
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Validates the manifest's shape. Returns the valid entries and one message per problem. */
export function parseManifest(json: unknown): { entries: ManifestEntry[]; errors: string[] } {
  const errors: string[] = [];
  const entries: ManifestEntry[] = [];
  if (!isRecord(json) || json["version"] !== 1 || !Array.isArray(json["entries"])) {
    return { entries, errors: ['manifest: expected {"version": 1, "entries": [...]}'] };
  }
  const seen = new Set<string>();
  for (const [index, raw] of (json["entries"] as unknown[]).entries()) {
    const at = `manifest entry ${String(index)}`;
    if (!isRecord(raw)) {
      errors.push(`${at}: not an object`);
      continue;
    }
    const { id, title, source, owner, kind, profiles } = raw;
    if (typeof id !== "string" || !ID.test(id)) {
      errors.push(`${at}: invalid ID ${JSON.stringify(id)}`);
      continue;
    }
    const where = `manifest entry "${id}"`;
    if (seen.has(id)) {
      errors.push(`${where}: duplicate ID "${id}"`);
      continue;
    }
    seen.add(id);
    const problems: string[] = [];
    if (!isText(title)) problems.push("title must be a non-empty string");
    if (source !== undefined && typeof source !== "string") problems.push("source must be text");
    if (typeof owner !== "string" || !OWNER.test(owner)) problems.push("owner must be M0 to M99");
    if (!KINDS.includes(kind as Kind)) problems.push(`kind must be one of ${KINDS.join(", ")}`);
    if (
      !Array.isArray(profiles) ||
      profiles.length === 0 ||
      !profiles.every((p) => PROFILES.includes(p as (typeof PROFILES)[number]))
    ) {
      problems.push(`profiles must be a non-empty list from ${PROFILES.join(", ")}`);
    }
    if (problems.length > 0) {
      errors.push(`${where}: ${problems.join("; ")}`);
      continue;
    }
    entries.push({
      id,
      title: title as string,
      ...(typeof source === "string" ? { source } : {}),
      owner: owner as string,
      kind: kind as Kind,
      profiles: profiles as string[],
    });
  }
  return { entries, errors };
}

/** One message per test that carries no manifest ID or an ID the manifest does not hold. */
export function checkIds(entries: readonly ManifestEntry[], tests: readonly CollectedTest[]) {
  const errors: string[] = [];
  const known = new Set(entries.map((e) => e.id));
  for (const t of tests) {
    const where = `${t.file}${t.line === undefined ? "" : `:${String(t.line)}`} "${t.name}"`;
    const ids = idsInTitle(t.name);
    if (ids.length === 0) errors.push(`${where} carries no manifest ID`);
    for (const id of ids) {
      if (!known.has(id)) errors.push(`${where} carries unknown manifest ID "${id}"`);
    }
  }
  return errors;
}

/** Checks the collected tests against the manifest entries. Returns one message per problem. */
export function checkManifest(entries: readonly ManifestEntry[], tests: readonly CollectedTest[]) {
  const errors = checkIds(entries, tests);
  const covered = new Set(tests.flatMap((t) => idsInTitle(t.name)));
  for (const e of entries) {
    if (e.kind !== "manual" && !covered.has(e.id)) {
      errors.push(`manifest entry "${e.id}" (${e.kind}) has no test carrying its ID`);
    }
  }
  return errors;
}

/** A name that marks a file as a test in some runner: *.test.* or *.spec.*, or code in __tests__/. */
const TEST_LIKE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/.*\.[cm]?[jt]sx?$/;
/** Folders never searched for tests. The first three at any depth, the rest at the root only. */
const SKIP_ANYWHERE = new Set(["node_modules", "dist", "coverage"]);
const SKIP_AT_ROOT = new Set(["local", ".claude", ".git"]);

/** Every file in the repository whose name marks it as a test, as a path relative to `root`. */
export function testLikeFiles(root: string = repoRoot): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_ANYWHERE.has(entry.name) || (dir === "" && SKIP_AT_ROOT.has(entry.name))) continue;
        walk(path);
      } else if (entry.isFile() && TEST_LIKE.test(path)) {
        found.push(path);
      }
    }
  };
  walk("");
  return found.sort();
}

/** One message per test-like file that Vitest does not collect, so it would never run. */
export function checkTestFiles(testLike: readonly string[], collected: readonly string[]) {
  const runs = new Set(collected);
  return testLike
    .filter((file) => !runs.has(file))
    .map(
      (file) =>
        `${file} looks like a test file, but Vitest does not run it. ` +
        "Test files are named *.test.ts or *.test.tsx.",
    );
}

export interface Collection {
  tests: CollectedTest[];
  /** Every file Vitest collects, including files whose tests are all skipped. */
  files: string[];
  /** Files that failed to load, `.only` marks and other collection errors. */
  errors: string[];
}

/**
 * Renders an error for a one-line report and never throws. Vitest hands over serialized errors:
 * plain objects, sometimes without a prototype, so String() can throw on them. The message comes
 * first, then the first line of the stack, then String() and JSON, then a fixed fallback.
 */
export function describeError(error: unknown): string {
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : "");
  try {
    if (typeof error === "string") return text(error) || "empty error";
    if (typeof error === "object" && error !== null) {
      const fields = error as { message?: unknown; stack?: unknown };
      const message = text(fields.message);
      if (message !== "") return message;
      const stack = text(fields.stack).split(/\r?\n/)[0] ?? "";
      if (stack !== "") return stack;
    }
  } catch {
    // A throwing getter. Fall through to the plainer renderings.
  }
  for (const render of [(e: unknown) => String(e), (e: unknown) => JSON.stringify(e)]) {
    try {
      const rendered = text(render(error));
      if (rendered !== "" && rendered !== "[object Object]" && rendered !== "{}") return rendered;
    } catch {
      // Try the next rendering.
    }
  }
  return "unknown error (it could not be rendered)";
}

/** Collects every test Vitest would run, skipped and todo tests included, without running them. */
export async function collectTests(root: string = repoRoot): Promise<Collection> {
  const rel = (file: string) => relative(root, file).replaceAll("\\", "/");
  // allowOnly: false makes Vitest itself fail every test and suite marked .only, as it does in CI.
  const vitest = await createVitest({
    root,
    watch: false,
    reporters: [],
    allowOnly: false,
    includeTaskLocation: true,
  });
  try {
    const specs = await vitest.globTestSpecifications();
    // staticParse: false loads each file for real, so generated titles (test.each, template
    // strings) are seen as Vitest runs them. The default static parser only reads source text.
    const { testModules, unhandledErrors } = await vitest.collect(undefined, {
      staticParse: false,
    });
    const tests: CollectedTest[] = [];
    const errors: string[] = unhandledErrors.map(
      (e) => `vitest: unhandled error during collection: ${describeError(e)}`,
    );
    for (const module of testModules) {
      const file = rel(module.moduleId);
      const at = (name: string, line?: number) =>
        `${file}${line === undefined ? "" : `:${String(line)}`} "${name}"`;
      for (const e of module.errors()) {
        errors.push(`${file} could not be collected: ${describeError(e)}`);
      }
      for (const suite of module.children.allSuites()) {
        for (const e of suite.errors()) {
          errors.push(`${at(suite.fullName, suite.location?.line)}: ${describeError(e)}`);
        }
      }
      for (const test of module.children.allTests()) {
        for (const e of test.result().errors ?? []) {
          errors.push(`${at(test.fullName, test.location?.line)}: ${describeError(e)}`);
        }
        tests.push({
          name: test.fullName,
          file,
          ...(test.location ? { line: test.location.line } : {}),
        });
      }
    }
    return { tests, files: [...new Set(specs.map((s) => rel(s.moduleId)))].sort(), errors };
  } finally {
    await vitest.close();
  }
}

/** The end-to-end tests' Playwright config (`pnpm e2e`), relative to the root. */
export const E2E_CONFIG = "tests/e2e/playwright.config.ts";

interface PlaywrightSuite {
  readonly title?: string;
  readonly specs?: readonly { title: string; file: string; line?: number }[];
  readonly suites?: readonly PlaywrightSuite[];
}

/** The tests of a Playwright JSON listing, with their describe titles joined as Vitest does. */
export function playwrightTests(listing: { suites?: readonly PlaywrightSuite[] }): CollectedTest[] {
  const tests: CollectedTest[] = [];
  const walk = (suite: PlaywrightSuite, path: readonly string[]) => {
    for (const spec of suite.specs ?? []) {
      tests.push({
        name: [...path, spec.title].join(" > "),
        file: `tests/e2e/${spec.file.replaceAll("\\", "/")}`,
        ...(spec.line === undefined ? {} : { line: spec.line }),
      });
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title ?? ""]);
  };
  // The top-level suites are the files: their titles are paths, not part of a test's name.
  for (const file of listing.suites ?? []) walk(file, []);
  return tests;
}

/**
 * Collects the end-to-end tests the way Playwright itself sees them (`playwright test --list`),
 * without a browser or the global setup. A tree without the config has none.
 */
export function collectE2e(root: string = repoRoot): Collection {
  if (!existsSync(join(root, E2E_CONFIG))) return { tests: [], files: [], errors: [] };
  const listed = runNode(
    binPath("@playwright/test", "playwright"),
    ["test", "--config", E2E_CONFIG, "--list", "--reporter=json"],
    { cwd: root, capture: true },
  );
  let listing: { suites?: PlaywrightSuite[]; errors?: { message?: string }[] };
  try {
    listing = JSON.parse(listed.stdout) as typeof listing;
  } catch {
    return { tests: [], files: [], errors: [`playwright could not list ${E2E_CONFIG}`] };
  }
  const errors = (listing.errors ?? []).map((e) => `playwright: ${describeError(e.message ?? e)}`);
  if (listed.status !== 0 && errors.length === 0) {
    errors.push(`playwright could not list ${E2E_CONFIG} (exit ${String(listed.status)})`);
  }
  const tests = playwrightTests(listing);
  return { tests, files: [...new Set(tests.map((t) => t.file))].sort(), errors };
}

/**
 * The tests whose titles carry an ID in their source text, listed without loading any file:
 * Vitest's static listing reads the repository in seconds, where loading every file to collect it
 * takes minutes on CI. A title built as its file runs is not seen here.
 */
export async function taggedTestsInSource(root: string = repoRoot): Promise<CollectedTest[]> {
  const vitest = await createVitest({
    root,
    watch: false,
    reporters: [],
    includeTaskLocation: true,
  });
  try {
    const { testModules } = await vitest.collect(undefined, { staticParse: true });
    return testModules.flatMap((module) =>
      [...module.children.allTests()]
        .filter((test) => idsInTitle(test.fullName).length > 0)
        .map((test) => ({
          name: test.fullName,
          file: relative(root, module.moduleId).replaceAll("\\", "/"),
          ...(test.location ? { line: test.location.line } : {}),
        })),
    );
  } finally {
    await vitest.close();
  }
}

/**
 * The ID check `pnpm check` can make in a few seconds: every test it ran, and every other test
 * whose ID is in its source and every end-to-end test, carries IDs the manifest holds. A merge can
 * keep a test whose entry the branch took out, in a file the change does not reach.
 */
export async function checkIdsQuickly(
  ran: readonly CollectedTest[],
  root: string = repoRoot,
): Promise<{ errors: string[]; tests: number }> {
  const manifest = parseManifest(
    JSON.parse(readFileSync(join(root, "tests", "manifest.json"), "utf8")),
  );
  const ranFiles = new Set(ran.map((t) => t.file));
  const others = (await taggedTestsInSource(root)).filter((t) => !ranFiles.has(t.file));
  const e2e = collectE2e(root);
  const tests = [...ran, ...others, ...e2e.tests];
  return {
    errors: [...manifest.errors, ...e2e.errors, ...checkIds(manifest.entries, tests)],
    tests: tests.length,
  };
}

/** Reads tests/manifest.json and checks every test and test file against it. */
export async function verifyManifest(
  root: string = repoRoot,
): Promise<{ errors: string[]; tests: number }> {
  const parsed = parseManifest(
    JSON.parse(readFileSync(join(root, "tests", "manifest.json"), "utf8")),
  );
  const collection = await collectTests(root);
  const e2e = collectE2e(root);
  return {
    errors: [
      ...parsed.errors,
      ...collection.errors,
      ...e2e.errors,
      ...checkTestFiles(testLikeFiles(root), collection.files),
      ...checkManifest(parsed.entries, [...collection.tests, ...e2e.tests]),
    ],
    tests: collection.tests.length + e2e.tests.length,
  };
}

if (import.meta.main) {
  // An optional argument checks another tree, which the regression test uses for its fixture.
  const { errors, tests } = await verifyManifest(process.argv[2] ?? repoRoot);
  for (const e of errors) console.error(e);
  console.log(`manifest: ${String(tests)} tests checked, ${String(errors.length)} problems`);
  process.exitCode = errors.length > 0 ? 1 : 0;
}
