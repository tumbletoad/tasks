// Which scripts load safe-exit.ts, and that they load it first (A2 3.12.1). A script that runs the
// product's code and ends through `process.exit` must evaluate @tasks/bridge/safe-exit before any
// other module of its own, or it can hang in that exit. The check finds such scripts itself, so a
// new one cannot be forgotten. It reads every source module under packages/, tests/ and scripts/
// with TypeScript's parser and builds the graph of their imports: static imports, re-exports and
// dynamic `import()` of a literal, relative or through a `@tasks/` package's exports. Then:
// - a module that exits is one that calls `process.exit` or `process.reallyExit`, written any way;
// - under packages/*/src, an exiting module that no module imports is a script entry (one that is
//   imported is a part of the product that such an entry loads);
// - under tests/, scripts/ and packages/*/test, every exiting module counts, imported or not;
// - of those, each that loads the product's code, through any chain of imports, must import
//   safe-exit first. The product's code is every module under packages/*/src except the test kit's.
//
// "First" is the first runtime import or re-export in source order: type-only ones are erased and
// do not count, comments are not imports, and an `export … from` loads its module like an import.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SAFE_EXIT_FILE = join(ROOT, "packages", "bridge", "src", "safe-exit.ts");
const SOURCE = /\.(ts|mts|cts|js|mjs|cjs)$/u;
const SKIP_DIRS = new Set(["node_modules", "dist"]);

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

function parseText(file: string, text: string): ts.SourceFile {
  const kind = /\.[mc]?js$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

const literal = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;

/** The module's static runtime imports and re-exports, in source order. */
function staticSpecifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  for (const statement of source.statements) {
    let specifier: string | undefined;
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      specifier = literal(statement.moduleSpecifier);
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      specifier = literal(statement.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      specifier = literal(statement.moduleReference.expression);
    }
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

/** The expression inside parentheses, type assertions and non-null assertions. */
function bare(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

const isProcess = (node: ts.Expression): boolean => {
  const inner = bare(node);
  return ts.isIdentifier(inner) && inner.text === "process";
};
const EXITS = new Set(["exit", "reallyExit"]);

/** Whether the module calls `process.exit` or `process.reallyExit`, and its dynamic imports. */
function scan(source: ts.SourceFile): { exits: boolean; dynamic: string[] } {
  const found = { exits: false, dynamic: [] as string[] };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = bare(node.expression);
      if (
        (ts.isPropertyAccessExpression(callee) &&
          isProcess(callee.expression) &&
          EXITS.has(callee.name.text)) ||
        (ts.isElementAccessExpression(callee) &&
          isProcess(callee.expression) &&
          EXITS.has(literal(callee.argumentExpression) ?? ""))
      ) {
        found.exits = true;
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = literal(node.arguments[0]);
        if (specifier !== undefined) found.dynamic.push(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

interface Module {
  readonly file: string;
  readonly first: string | undefined;
  readonly exits: boolean;
  readonly imports: string[];
}

/** The `@tasks/` packages: their folder and the files their exports name. */
function workspacePackages(): Map<string, { dir: string; exports: Record<string, string> }> {
  const packages = new Map<string, { dir: string; exports: Record<string, string> }>();
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    const manifest = join(ROOT, "packages", entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: string;
      exports?: string | Record<string, string>;
    };
    if (json.name === undefined) continue;
    const exports = typeof json.exports === "string" ? { ".": json.exports } : (json.exports ?? {});
    packages.set(json.name, { dir: join(ROOT, "packages", entry.name), exports });
  }
  return packages;
}

function resolver(packages: ReturnType<typeof workspacePackages>) {
  return (from: string, specifier: string): string | undefined => {
    if (specifier.startsWith(".")) {
      const path = resolve(dirname(from), specifier);
      return SOURCE.test(path) && existsSync(path) ? path : undefined;
    }
    const match = /^(@tasks\/[^/]+)(\/.*)?$/u.exec(specifier);
    const pkg = match?.[1] === undefined ? undefined : packages.get(match[1]);
    if (pkg === undefined) return undefined;
    const target = pkg.exports[`.${match?.[2] ?? ""}`];
    return target === undefined ? undefined : resolve(pkg.dir, target);
  };
}

function modulesOf(files: readonly string[]): Map<string, Module> {
  const resolveSpecifier = resolver(workspacePackages());
  const modules = new Map<string, Module>();
  for (const file of files) {
    const source = parseText(file, readFileSync(file, "utf8"));
    const specifiers = staticSpecifiers(source);
    const { exits, dynamic } = scan(source);
    const first = specifiers[0] === undefined ? undefined : resolveSpecifier(file, specifiers[0]);
    const imports = [...specifiers, ...dynamic]
      .map((specifier) => resolveSpecifier(file, specifier))
      .filter((target): target is string => target !== undefined);
    modules.set(file, { file, first, exits, imports });
  }
  return modules;
}

const isProduct = (file: string) =>
  /^packages\/(?!testkit\/)[^/]+\/src\//u.test(rel(file)) && file !== SAFE_EXIT_FILE;

/** The scripts that must load safe-exit first, by their path in the repository. */
function scriptsThatNeedIt(modules: ReadonlyMap<string, Module>): string[] {
  const imported = new Set<string>();
  for (const module of modules.values()) for (const target of module.imports) imported.add(target);
  const loadsProduct = (file: string, seen = new Set<string>()): boolean => {
    if (seen.has(file)) return false;
    seen.add(file);
    for (const target of modules.get(file)?.imports ?? []) {
      if (isProduct(target) || loadsProduct(target, seen)) return true;
    }
    return false;
  };
  return [...modules.values()]
    .filter((module) => {
      if (!module.exits) return false;
      const product = /^packages\/[^/]+\/src\//u.test(rel(module.file));
      return (!product || !imported.has(module.file)) && loadsProduct(module.file);
    })
    .map((module) => rel(module.file))
    .sort();
}

function inMemory(sources: Record<string, string>): Map<string, Module> {
  const modules = new Map<string, Module>();
  for (const [name, text] of Object.entries(sources)) {
    const file = join(ROOT, name);
    const source = parseText(file, text);
    const specifiers = staticSpecifiers(source);
    const { exits, dynamic } = scan(source);
    const resolveIn = (specifier: string) => {
      const path = specifier.startsWith(".") ? resolve(dirname(file), specifier) : undefined;
      return path !== undefined && rel(path) in sources ? path : undefined;
    };
    modules.set(file, {
      file,
      first: specifiers[0] === undefined ? undefined : resolveIn(specifiers[0]),
      exits,
      imports: [...specifiers, ...dynamic]
        .map(resolveIn)
        .filter((target): target is string => target !== undefined),
    });
  }
  return modules;
}

describe("[A2.3.12.1.runtime.safe-exit] every script that ends through process.exit loads safe-exit first", () => {
  test("the check reads imports and exits the way the scripts write them", () => {
    expect(
      staticSpecifiers(
        parseText(
          "x.ts",
          '#!/usr/bin/env node\n/* import "./c.ts"; */\n// import "./d.ts";\nimport type { A } from "./a.ts";\nexport { b } from "./b.ts";\nimport "@tasks/bridge/safe-exit";\nexport type { E } from "./e.ts";\nimport { type F } from "./f.ts";\n',
        ),
      ),
    ).toEqual(["./b.ts", "@tasks/bridge/safe-exit", "./f.ts"]);
    for (const text of [
      "process.exit(1);",
      "if (x) process.exit(await run());",
      "export function f() { process.exit(1); }",
      "setTimeout(() => process.exit(0), 1);",
      "process /* c */ .exit(1);",
      'process["exit"](1);',
      "(process).exit(1);",
      "process.reallyExit(1);",
    ]) {
      expect(scan(parseText("x.ts", text)).exits, text).toBe(true);
    }
    expect(scan(parseText("x.ts", 'const s = "process.exit(1)";')).exits).toBe(false);
    expect(scan(parseText("x.ts", 'await import("./p.ts");')).dynamic).toEqual(["./p.ts"]);
  });

  test("it finds the scripts that need it, and only those", () => {
    const found = scriptsThatNeedIt(
      inMemory({
        "packages/p/src/lib.ts": "export const x = 1;",
        "packages/p/src/exits.ts": "export function quit() { process.exit(1); }",
        "packages/p/src/entry.ts": 'import "./exits.ts";\nsetTimeout(() => process.exit(0), 1);',
        "tests/t/dynamic.ts": 'await import("../../packages/p/src/lib.ts");\nprocess.exit(0);',
        "tests/t/through.ts": 'import "./helper.ts";\nprocess.reallyExit(0);',
        "tests/t/helper.ts": 'export * from "../../packages/p/src/lib.ts";',
        "tests/t/plain.ts": 'import "./plain-helper.ts";\nprocess.exit(0);',
        "tests/t/plain-helper.ts": "export const y = 2;",
        "packages/testkit/src/fake.ts": "process.exit(0);",
      }),
    );
    expect(found).toEqual(["packages/p/src/entry.ts", "tests/t/dynamic.ts", "tests/t/through.ts"]);
  });

  test("each such script in the repository imports it before any other module", () => {
    const files = ["packages", "tests", "scripts"].flatMap((dir) => sourceFiles(join(ROOT, dir)));
    const modules = modulesOf(files);
    const scripts = scriptsThatNeedIt(modules);
    // The walk finds the product's own entries, so it sees the scripts that matter.
    for (const entry of PRODUCT_ENTRIES) expect(scripts).toContain(entry);
    const late = scripts.filter((file) => modules.get(join(ROOT, file))?.first !== SAFE_EXIT_FILE);
    expect(late, "scripts that end through process.exit without loading safe-exit first").toEqual(
      [],
    );
  }, 120_000);
});
