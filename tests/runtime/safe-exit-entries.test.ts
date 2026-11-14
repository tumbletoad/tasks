// Which scripts load safe-exit.ts, and that they load it first (A2 3.12.1). A script that runs the
// product's code and ends through `process.exit` must evaluate @tasks/bridge/safe-exit before any
// other module of its own, or it can hang in that exit. The check finds such scripts itself, so a
// new one cannot be forgotten:
// - under packages/*/src, a module that calls `process.exit` outside any function (a script entry;
//   the product's modules that exit from inside a function are loaded by such an entry);
// - under tests/ and packages/*/test, every module that calls `process.exit` at all;
// and of those, each that loads the product's code, directly or through its own relative imports:
// a `@tasks/` package other than the test kit, or a module under packages/*/src.
//
// "First" is decided with TypeScript's parser on the module's runtime imports and re-exports, in
// source order: type-only ones are erased and do not count, comments are not imports, and an
// `export … from` loads its module like an import does.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SAFE_EXIT = "@tasks/bridge/safe-exit";
const SAFE_EXIT_FILE = join(ROOT, "packages", "bridge", "src", "safe-exit.ts");
const SOURCE = /\.(ts|mts|mjs)$/u;
const SKIP_DIRS = new Set(["node_modules", "dist", "lib"]);

/** The product's own script entries: the check must find each of them. */
const PRODUCT_ENTRIES = [
  "packages/cli/src/bin.ts",
  "packages/cli/src/entry.ts",
  "packages/bridge/src/mcp/main.ts",
  "packages/service/src/hub/main.ts",
];

const slash = (path: string) => path.split(sep).join("/");
const rel = (file: string) => slash(relative(ROOT, file));

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path, out);
    } else if (SOURCE.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (source === undefined) {
    source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    parsed.set(file, source);
  }
  return source;
}

/** The module's runtime imports and re-exports, in source order. */
function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) found.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || statement.moduleSpecifier === undefined) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) found.push(statement.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      found.push(statement.moduleReference.expression.text);
    }
  }
  return found;
}

const isProcessExit = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "process" &&
  node.expression.name.text === "exit";

/** Where the module calls `process.exit`: outside any function, and anywhere. */
function exits(source: ts.SourceFile): { topLevel: boolean; any: boolean } {
  const found = { topLevel: false, any: false };
  const visit = (node: ts.Node, inFunction: boolean): void => {
    if (isProcessExit(node)) {
      found.any = true;
      if (!inFunction) found.topLevel = true;
    }
    const inner = inFunction || ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
    ts.forEachChild(node, (child) => {
      visit(child, inner);
    });
  };
  visit(source, false);
  return found;
}

const productFolder = (file: string) =>
  /^packages\/(?!testkit\/)[^/]+\/src\//u.test(rel(file)) && file !== SAFE_EXIT_FILE;
const productPackage = (specifier: string) =>
  specifier.startsWith("@tasks/") &&
  !specifier.startsWith("@tasks/testkit") &&
  specifier !== SAFE_EXIT;

/** The file a relative specifier names, when it is one of the repository's source files. */
function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const path = resolve(dirname(from), specifier);
  return SOURCE.test(path) && existsSync(path) ? path : undefined;
}

/** Whether loading `file` loads the product's code, through its own relative imports too. */
function loadsProduct(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  for (const specifier of runtimeSpecifiers(parse(file))) {
    if (productPackage(specifier)) return true;
    const target = resolveRelative(file, specifier);
    if (target === undefined) continue;
    if (productFolder(target) || loadsProduct(target, seen)) return true;
  }
  return false;
}

/** Whether the module's first runtime import is safe-exit, by package name or by path. */
function importsSafeExitFirst(file: string): boolean {
  const first = runtimeSpecifiers(parse(file))[0];
  if (first === undefined) return false;
  return first === SAFE_EXIT || resolveRelative(file, first) === SAFE_EXIT_FILE;
}

/** The scripts that must load safe-exit first. */
function scriptsThatNeedIt(): string[] {
  const files = [
    ...sourceFiles(join(ROOT, "packages")),
    ...sourceFiles(join(ROOT, "tests")),
  ].filter((file) => readFileSync(file, "utf8").includes("process.exit"));
  return files
    .filter((file) => {
      const { topLevel, any } = exits(parse(file));
      const isTest = /^(tests\/|packages\/[^/]+\/test\/)/u.test(rel(file));
      return (isTest ? any : topLevel) && loadsProduct(file);
    })
    .map(rel)
    .sort();
}

describe("[A2.3.12.1.runtime.safe-exit] every script that ends through process.exit loads safe-exit first", () => {
  test("the check reads imports and exits the way the scripts write them", () => {
    const sf = (text: string) =>
      ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(
      runtimeSpecifiers(
        sf(
          '#!/usr/bin/env node\n/* import "./c.ts"; */\n// import "./d.ts";\nimport type { A } from "./a.ts";\nexport { b } from "./b.ts";\nimport "@tasks/bridge/safe-exit";\nexport type { E } from "./e.ts";\nimport { type F } from "./f.ts";\n',
        ),
      ),
    ).toEqual(["./b.ts", "@tasks/bridge/safe-exit", "./f.ts"]);
    expect(exits(sf("if (x) process.exit(await run());"))).toEqual({ topLevel: true, any: true });
    expect(exits(sf("export function f() { process.exit(1); }"))).toEqual({
      topLevel: false,
      any: true,
    });
    expect(exits(sf("setTimeout(() => process.exit(0), 1);"))).toEqual({
      topLevel: false,
      any: true,
    });
    expect(exits(sf('const s = "process.exit(1)";'))).toEqual({ topLevel: false, any: false });
  });

  test("each such script imports it before any other module", () => {
    const scripts = scriptsThatNeedIt();
    // The walk finds the product's own entries, so it sees the scripts that matter.
    for (const entry of PRODUCT_ENTRIES) expect(scripts).toContain(entry);
    const late = scripts.filter((file) => !importsSafeExitFirst(join(ROOT, file)));
    expect(late, "scripts that end through process.exit without loading safe-exit first").toEqual(
      [],
    );
  });
});
