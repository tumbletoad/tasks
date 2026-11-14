// The bundles of a version folder's lib/ (A2 3.12.2), made with esbuild. Four builds:
//
//   lib/tasks.mjs       packages/cli/src/entry.ts on its own, no code splitting: it turns on the
//                       compile cache before it imports a chunk. Its import of ./run.ts becomes
//                       ./chunks/cli.mjs, of @tasks/bridge/mcp ./bridge.mjs, and of the shim's
//                       ./shim/run.ts ./shim.mjs.
//   lib/chunks/*.mjs    the CLI (cli.mjs, from packages/cli/src/run.ts) and the three worker threads
//                       the service starts from their own module files, each an entry of its own
//                       (A2 3.12.2): storage-worker.mjs, maintenance-worker.mjs and
//                       space-admin-worker.mjs, with the code they share in chunk-<hash>.mjs. Every
//                       file of the split build sits in this one folder, so a module's URL relative
//                       to import.meta.url resolves the same from whichever chunk holds its code.
//                       The CLI's own route to the bridge (mcp.ts) imports ../bridge.mjs.
//   lib/bridge.mjs      the bridge (A2 3.7.1): one file of the Node built-ins it is
//                       allowed, shared with no chunk, with lib/mcp-offline.json beside it.
//   lib/shim.mjs        the launch shim (A4 3.6.3): `tasks shim <ticket>`, one file
//                       of the built-ins it is allowed, shared with no chunk, so the shim loads
//                       nothing of the CLI or the service.
//
// esbuild runs from the repository root, never writes a source map, and keeps no absolute path:
// the comments it writes name repository-relative files. The source files are bundled as they are,
// except for the edits below, made while esbuild loads them (no file in the tree changes), each
// found exactly once in a file the build loads, or the build fails:
//   - the build identity: CLI_BUILD, the service's BUILD, storage's app version, BRIDGE_BUILD and
//     SHIM_BUILD (A2 3.12.2);
//   - the worker entries: `new URL("./entry.ts", import.meta.url)` and its kind become the worker's
//     bundle file; the bridge's offline file becomes the one beside lib/bridge.mjs.
// A guard then refuses any other use of import.meta (a module URL, dirname, filename, main) or of
// __dirname in a bundled source file: a bundle that starts but cannot find a module file of its
// own is the classic failure here. That guard is the early, friendly one; the rule itself is
// checked on what ships: the syntax tree of every built file, dependencies included, may load
// only Node's built-ins and files of lib/, each named by a literal (outputLoadProblems). esbuild is
// a build tool only: the build fails if any input of the bundles comes from it.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// The build runs on the pinned Node (pnpm's), so its list of built-ins is the shipped runtime's.
import { isBuiltin } from "node:module";
import { join, posix, relative } from "node:path";
import * as esbuild from "esbuild";
import ts from "typescript";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";

export interface BuildIdentity {
  readonly version: string;
  readonly build: string;
}

/** An edit made to one source file as esbuild loads it. `find` must occur exactly once. */
export interface SourceEdit {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

/** The entry of lib/tasks.mjs. */
export const ENTRY_SOURCE = "packages/cli/src/entry.ts";
/** The CLI, as the chunk lib/chunks/cli.mjs that the entry imports. */
export const CLI_SOURCE = "packages/cli/src/run.ts";

/** The bridge (M2.01) and its offline answers, which `pnpm gen` writes. */
export const BRIDGE_MODULE = "@tasks/bridge/mcp";
export const BRIDGE_RUN = "packages/bridge/src/mcp/run.ts";
export const BRIDGE_NAMES = "packages/bridge/src/mcp/names.ts";
export const BRIDGE_OFFLINE = "packages/bridge/lib/mcp-offline.json";

/** The bridge's only allowed imports (A2 3.7.1; packages/bridge/src/mcp/imports.test.ts). */
export const BRIDGE_BUILTINS: readonly string[] = [
  "node:crypto",
  "node:fs",
  "node:net",
  "node:os",
  "node:path",
  "node:process",
  "node:url",
];

/** The launch shim (M2.08): its entry, and the file that names its build. */
export const SHIM_RUN = "packages/cli/src/shim/run.ts";
export const SHIM_LINK = "packages/cli/src/shim/link.ts";
/** How the entry names the shim: a dynamic import, which becomes lib/shim.mjs. */
export const SHIM_SPECIFIER = "./shim/run.ts";

/**
 * The shim's only allowed imports: the bridge's, a child process for the agent, the terminal's
 * tty, and fs/promises for the in-folder check (places.ts, git-remote.ts). The source's own list
 * is packages/cli/test/shim-entry.test.ts.
 */
export const SHIM_BUILTINS: readonly string[] = [
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:net",
  "node:os",
  "node:path",
  "node:process",
  "node:tty",
  "node:url",
];

/** The worker threads the service starts from a module file of their own. */
export const WORKERS = [
  {
    name: "storage-worker",
    entry: "packages/storage/src/worker/entry.ts",
    from: "packages/storage/src/worker/client.ts",
    find: 'new URL("./entry.ts", import.meta.url)',
  },
  {
    name: "maintenance-worker",
    entry: "packages/service/src/hub/maintenance-entry.ts",
    from: "packages/service/src/hub/maintenance.ts",
    find: 'new URL("./maintenance-entry.ts", import.meta.url)',
  },
  {
    name: "space-admin-worker",
    entry: "packages/service/src/hub/space-admin-entry.ts",
    from: "packages/service/src/hub/space-admin.ts",
    find: 'new URL("./space-admin-entry.ts", import.meta.url)',
  },
] as const;

const literal = (value: string): string => JSON.stringify(value);

/** The line of the keys the updater trusts (packages/service/src/version/release-keys.ts). */
export const UPDATE_KEYS_SOURCE = "packages/service/src/version/release-keys.ts";
export const UPDATE_KEYS_LINE =
  "export const UPDATE_KEYS: readonly string[] = RELEASE_PUBLIC_KEYS;";

/**
 * The edit that makes a test build's updater trust `keys` instead of the pinned release keys. Only
 * the install scripts' test kit asks for it (scripts/install/test/kit.ts), so a test install can be
 * updated with a throwaway key; `pnpm build` has no way to.
 */
export function trustEdit(keys: readonly string[]): SourceEdit {
  const line = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/;
  if (keys.length === 0 || keys.some((key) => !line.test(key))) {
    throw new Error("a test build trusts one or more OpenSSH Ed25519 key lines");
  }
  return {
    file: UPDATE_KEYS_SOURCE,
    find: UPDATE_KEYS_LINE,
    replace: `export const UPDATE_KEYS: readonly string[] = ${JSON.stringify(keys)};`,
  };
}

/** The edits of the split build (lib/chunks/): the build identity and the worker entries. */
export function chunkEdits(id: BuildIdentity): SourceEdit[] {
  return [
    {
      file: "packages/cli/src/connect.ts",
      find: 'export const CLI_BUILD = { version: "0.0.0", build: "source" } as const;',
      replace: `export const CLI_BUILD = { version: ${literal(id.version)}, build: ${literal(id.build)} } as const;`,
    },
    {
      // Apart from the hub's lifecycle, so the MCP endpoint and its offline file can name it (M2.02).
      file: "packages/service/src/hub/build.ts",
      find: 'export const BUILD = { version: SOURCE_APP_VERSION, build: "source" } as const;',
      replace: `export const BUILD = { version: SOURCE_APP_VERSION, build: ${literal(id.build)} } as const;`,
    },
    {
      file: "packages/storage/src/space.ts",
      find: 'export const SOURCE_APP_VERSION = "0.0.0";',
      replace: `export const SOURCE_APP_VERSION = ${literal(id.version)};`,
    },
    ...WORKERS.map((w) => ({
      file: w.from,
      find: w.find,
      replace: `new URL(${literal(`./${w.name}.mjs`)}, import.meta.url)`,
    })),
  ];
}

/** The edits of the bridge's build: its identity, and its offline file beside it. */
export function bridgeEdits(id: BuildIdentity): SourceEdit[] {
  return [
    {
      file: BRIDGE_NAMES,
      find: 'export const BRIDGE_BUILD = { version: "0.0.0", build: "source" } as const;',
      replace: `export const BRIDGE_BUILD = { version: ${literal(id.version)}, build: ${literal(id.build)} } as const;`,
    },
    {
      file: BRIDGE_RUN,
      find: 'new URL("../../lib/mcp-offline.json", import.meta.url)',
      replace: 'new URL("./mcp-offline.json", import.meta.url)',
    },
  ];
}

/** The edit of the shim's build: its identity, which it names in its handshake. */
export function shimEdits(id: BuildIdentity): SourceEdit[] {
  return [
    {
      file: SHIM_LINK,
      find: 'export const SHIM_BUILD = { version: "0.0.0", build: "source" } as const;',
      replace: `export const SHIM_BUILD = { version: ${literal(id.version)}, build: ${literal(id.build)} } as const;`,
    },
  ];
}

/** The files a bundled module may name relative to import.meta.url: files beside it in lib/. */
const MODULE_URLS = new Set([...WORKERS.map((w) => `./${w.name}.mjs`), "./mcp-offline.json"]);

const MODULE_URL = /new URL\(\s*(["'`])([^"'`]*)\1\s*,\s*import\.meta\.url\s*\)/g;

/** `import.meta`, also with white space around the dot, which JavaScript allows. */
const IMPORT_META = /\bimport\s*\.\s*meta\b/g;

/**
 * What a bundled source file does with its own location that the bundle could not keep. Every
 * `new URL(<literal>, import.meta.url)` must name a file the build places beside the bundle, and
 * import.meta is used for nothing else, except the entry's own location (entry.ts).
 */
export function moduleUrlProblems(file: string, text: string): string[] {
  const problems: string[] = [];
  const urls = [...text.matchAll(MODULE_URL)].map((match) => match[2] ?? "");
  for (const target of urls) {
    if (!MODULE_URLS.has(target)) {
      problems.push(`${file}: names a module file the bundle does not have: ${target}`);
    }
  }
  // Each module URL holds one import.meta; the entry may also read its own location once.
  const uses = text.match(IMPORT_META)?.length ?? 0;
  if (uses > urls.length + (file === ENTRY_SOURCE ? 1 : 0)) {
    problems.push(`${file}: uses import.meta in a way a bundle cannot keep`);
  }
  if (/\b__(dirname|filename)\b/.test(text)) {
    problems.push(`${file}: uses __dirname or __filename, which an ES module bundle has not`);
  }
  return problems;
}

/** `node:module`, whose loaders (createRequire, register, ...) load what no bundle check sees. */
const MODULE_BUILTINS = new Set(["module", "node:module"]);
/** The one thing of node:module that lib/ uses: the entry turns on the compile cache. */
const MODULE_ALLOWED = "enableCompileCache";
/** Property names that reach a loader without an import: node:module itself, or native code. */
const LOADER_PROPERTIES = new Set(["createRequire", "getBuiltinModule", "dlopen"]);

/**
 * What a built file of lib/ loads at run time that the build cannot vouch for, read from its syntax
 * tree, so comments and strings never count and no spelling slips past:
 *   - every static import, re-export and dynamic import names, by a string literal, a Node built-in
 *     (as node:module's isBuiltin knows them) or a file of lib/ (`isLibFile` gets the path relative
 *     to the version folder);
 *   - `import.meta` appears only as the base of `new URL("<a file of lib/>", import.meta.url)`, and
 *     once more as the entry's own location;
 *   - node:module, the loaders' module, is imported by the entry only, and used there only for
 *     `enableCompileCache`; no file reaches a loader by name either (`createRequire`,
 *     `getBuiltinModule`, `dlopen`, by dot or by a literal in brackets);
 *   - nothing calls require, or reads __dirname or __filename.
 * esbuild keeps a load it cannot analyse as it stands (a computed import(), a require through
 * createRequire) and its metafile does not list it, so this check reads what ships, dependencies
 * included. `entry` marks lib/tasks.mjs.
 */
export function outputLoadProblems(
  file: string,
  text: string,
  isLibFile: (path: string) => boolean,
  entry = false,
): string[] {
  const problems: string[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const at = (node: ts.Node) =>
    `${file}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`;
  /** The local names the entry gave node:module, each to be used for MODULE_ALLOWED only. */
  const moduleNames = new Set<string>();
  const names = (node: ts.Node, what: string, specifier: ts.Node | undefined): void => {
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) {
      problems.push(`${at(node)}: ${what} of a name the build cannot read`);
      return;
    }
    const name = specifier.text;
    const relativeName = name.startsWith("./") || name.startsWith("../");
    const ok = relativeName
      ? isLibFile(posix.normalize(posix.join(posix.dirname(file), name)))
      : isBuiltin(name);
    if (!ok) problems.push(`${at(node)}: ${what} of ${name}, which is no file of lib/`);
    if (!MODULE_BUILTINS.has(name)) return;
    const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
    if (!entry || clause === undefined) {
      problems.push(`${at(node)}: ${what} of ${name}, which only the entry may import`);
      return;
    }
    if (clause.name !== undefined) moduleNames.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      moduleNames.add(bindings.name.text);
    } else if (bindings !== undefined) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text !== MODULE_ALLOWED) {
          problems.push(`${at(element)}: ${name}'s ${element.name.text}, a loader`);
        }
      }
    }
  };
  // Imports first, so every use of node:module's names below is known.
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) names(statement, "an import", statement.moduleSpecifier);
  }
  const propertyText = (node: ts.Node): string | undefined =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
  let ownUses = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      names(node, "a re-export", node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        names(node, "an import()", node.arguments[0]);
      } else if (ts.isIdentifier(callee) && ["require", "__require"].includes(callee.text)) {
        problems.push(`${at(node)}: a require, which an ES module bundle cannot keep`);
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = propertyText(node);
      if (property !== undefined && LOADER_PROPERTIES.has(property)) {
        problems.push(`${at(node)}: ${property}, which loads what the bundle does not hold`);
      }
    } else if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const propertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      const declaration = ts.isImportClause(parent) || ts.isNamespaceImport(parent);
      if (node.text === "createRequire" && !propertyName) {
        problems.push(`${at(node)}: createRequire, which loads what the bundle does not hold`);
      } else if (["__dirname", "__filename"].includes(node.text) && !propertyName) {
        problems.push(`${at(node)}: ${node.text}, which an ES module has not`);
      } else if (moduleNames.has(node.text) && !propertyName && !declaration) {
        const use = ts.isPropertyAccessExpression(parent) && parent.expression === node;
        if (!use || parent.name.text !== MODULE_ALLOWED) {
          problems.push(`${at(node)}: node:module used for more than ${MODULE_ALLOWED}`);
        }
      }
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const url = node.parent;
      const call = url.parent;
      const isUrl = ts.isPropertyAccessExpression(url) && url.name.text === "url";
      if (
        isUrl &&
        ts.isNewExpression(call) &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === "URL" &&
        call.arguments?.length === 2 &&
        call.arguments[1] === url
      ) {
        names(call, "a module URL", call.arguments[0]);
      } else if (isUrl && entry && ownUses === 0) {
        ownUses += 1;
      } else {
        problems.push(`${at(node)}: import.meta used in a way a bundle cannot keep`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

type Applied = Map<SourceEdit, number>;

/** esbuild's loader for the repository's TypeScript: the edits, then the guard. */
function sourcePlugin(
  root: string,
  edits: readonly SourceEdit[],
  applied: Applied,
): esbuild.Plugin {
  return {
    name: `${PRODUCT_ID}-sources`,
    setup(build) {
      build.onLoad({ filter: /\.[cm]?ts$/ }, (args) => {
        const file = relative(root, args.path).replaceAll("\\", "/");
        if (file.startsWith("../") || file.includes("node_modules/")) return undefined;
        let text = readFileSync(args.path, "utf8");
        for (const edit of edits) {
          if (edit.file !== file) continue;
          const count = text.split(edit.find).length - 1;
          if (count !== 1) {
            return {
              errors: [
                {
                  text: `${file}: the build expects ${edit.find} exactly once, found ${String(count)}`,
                },
              ],
            };
          }
          text = text.replace(edit.find, () => edit.replace);
          applied.set(edit, (applied.get(edit) ?? 0) + 1);
        }
        const problems = moduleUrlProblems(file, text);
        if (problems.length > 0) return { errors: problems.map((p) => ({ text: p })) };
        return { contents: text, loader: "ts" };
      });
    },
  };
}

/**
 * Imports that become other files of lib/ instead of being bundled: `specifier` from `importer`
 * (repository-relative) becomes the external path `to`.
 */
function externalPlugin(
  root: string,
  links: readonly { importer: string; specifier: string; to: string }[],
): esbuild.Plugin {
  return {
    name: `${PRODUCT_ID}-externals`,
    setup(build) {
      for (const link of links) {
        const importer = join(root, link.importer);
        const filter = new RegExp(`^${link.specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);
        build.onResolve({ filter }, (args) =>
          args.importer === importer ? { path: link.to, external: true } : undefined,
        );
      }
    },
  };
}

/**
 * `ws`'s optional native add-ons (A2 3.8.1: "pure JavaScript, without its optional native
 * add-ons"). ws loads each inside a try/catch and falls back to its own JavaScript when the load
 * throws. They are not installed, so esbuild would leave each as an import from outside lib/.
 */
const ABSENT_ADDONS = /^(?:bufferutil|utf-8-validate)$/;
const IN_PACKAGE = /[\\/]node_modules[\\/]/;

/**
 * The CommonJS packages in the bundle (`ws`, the UI listener's WebSocket server, A2 3.8.1).
 * esbuild keeps a CommonJS `require()` of a Node built-in as a call of require(), which an ES
 * module does not have. Each such require gets a CommonJS module of the bundle instead, which takes
 * the built-in from an ES module of the bundle that imports it statically: lib/ still loads
 * built-ins by static imports only (outputLoadProblems). ws's optional add-ons become modules that
 * throw, so ws takes its JavaScript fallback.
 */
export function commonJsPlugin(): esbuild.Plugin {
  return {
    name: `${PRODUCT_ID}-commonjs`,
    setup(build) {
      build.onResolve({ filter: ABSENT_ADDONS }, (args) =>
        /[\\/]node_modules[\\/]ws[\\/]/.test(args.importer)
          ? { path: args.path, namespace: "absent-addon" }
          : undefined,
      );
      build.onLoad({ filter: /.*/, namespace: "absent-addon" }, (args) => ({
        contents: `throw new Error(${JSON.stringify(`${args.path} is not part of this build`)});\n`,
        loader: "js",
      }));
      build.onResolve({ filter: /^(?:node:)?[a-z_][a-z0-9_/]*$/ }, (args) =>
        args.kind === "require-call" && IN_PACKAGE.test(args.importer) && isBuiltin(args.path)
          ? { path: args.path.replace(/^node:/, ""), namespace: "builtin-require" }
          : undefined,
      );
      build.onLoad({ filter: /.*/, namespace: "builtin-require" }, (args) => ({
        contents: `module.exports = require(${JSON.stringify(`builtin-import:${args.path}`)}).value;\n`,
        loader: "js",
      }));
      build.onResolve({ filter: /^builtin-import:/ }, (args) => ({
        path: args.path.slice("builtin-import:".length),
        namespace: "builtin-import",
      }));
      build.onLoad({ filter: /.*/, namespace: "builtin-import" }, (args) => ({
        contents: `import * as m from ${JSON.stringify(`node:${args.path}`)};\nexport const value = m.default ?? m;\n`,
        loader: "js",
      }));
    },
  };
}

const BRIDGE_ROUTE = "packages/cli/src/mcp.ts";

const COMMON: esbuild.BuildOptions = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node26",
  outExtension: { ".js": ".mjs" },
  legalComments: "none",
  sourcemap: false,
  metafile: true,
  write: true,
  logLevel: "silent",
};

export interface BundleResult {
  /** The lib/ folder written, with every file the version folder takes from it. */
  readonly lib: string;
  readonly files: readonly string[];
  /** THIRD_PARTY.txt: the npm packages in the bundles, each with its licence text. */
  readonly thirdParty: string;
}

export interface BundleOptions {
  readonly root: string;
  /** An empty or missing folder: lib/ is written into it. */
  readonly out: string;
  readonly identity: BuildIdentity;
  /**
   * The npm modules another build of the version folder ships (the page's, packages/web), as
   * paths relative to the root: THIRD_PARTY.txt names their packages too.
   */
  readonly extraInputs?: readonly string[];
  /** Tests only (trustEdit): the keys the build's updater trusts instead of the release keys. */
  readonly trustKeys?: readonly string[];
}

function fail(what: string, problems: readonly string[]): never {
  throw new Error(`${what}:\n  ${problems.join("\n  ")}`);
}

/** Every external import of a build's outputs, by output file. */
function externals(meta: esbuild.Metafile): { file: string; path: string }[] {
  return Object.entries(meta.outputs).flatMap(([file, output]) =>
    output.imports.filter((i) => i.external === true).map((i) => ({ file, path: i.path })),
  );
}

async function run(
  what: string,
  root: string,
  options: esbuild.BuildOptions,
  edits: readonly SourceEdit[],
): Promise<esbuild.Metafile> {
  const applied: Applied = new Map();
  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      ...COMMON,
      ...options,
      absWorkingDir: root,
      plugins: [...(options.plugins ?? []), sourcePlugin(root, edits, applied)],
    });
  } catch (error) {
    const failure = error as Partial<esbuild.BuildFailure>;
    const messages = (failure.errors ?? []).map((e) =>
      e.location === null ? e.text : `${e.location.file}:${String(e.location.line)}: ${e.text}`,
    );
    fail(`${what} failed`, messages.length > 0 ? messages : [String(error)]);
  }
  const missed = edits.filter((e) => applied.get(e) !== 1);
  if (missed.length > 0) {
    fail(
      `${what}: the bundle never loaded a file the build edits`,
      missed.map((e) => `${e.file}: ${e.find}`),
    );
  }
  const warnings = result.warnings.map((w) => w.text);
  if (warnings.length > 0) fail(`${what} warned`, warnings);
  const meta = result.metafile;
  if (meta === undefined) fail(what, ["esbuild wrote no metafile"]);
  const tooling = Object.keys(meta.inputs).filter((i) =>
    /node_modules\/(?:\.pnpm\/)?@?esbuild/.test(i),
  );
  if (tooling.length > 0) fail(`${what} bundled the build tool`, tooling);
  return meta;
}

/** The npm package that holds a bundled input, as its folder relative to the root. */
function packageFolder(input: string): string | undefined {
  const at = input.lastIndexOf("node_modules/");
  if (at === -1) return undefined;
  const rest = input.slice(at + "node_modules/".length).split("/");
  const name = rest[0]?.startsWith("@") === true ? rest.slice(0, 2) : rest.slice(0, 1);
  return input.slice(0, at + "node_modules/".length) + name.join("/");
}

const LICENCE_FILE = /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i;

/**
 * THIRD_PARTY.txt from the inputs of every build, the esbuild bundles' and `extra` (the page's):
 * each npm package once, with its licence.
 */
export function thirdPartyText(
  root: string,
  metas: readonly esbuild.Metafile[],
  extra: readonly string[] = [],
): string {
  const folders = new Set<string>();
  for (const input of [...metas.flatMap((meta) => Object.keys(meta.inputs)), ...extra]) {
    const folder = packageFolder(input);
    if (folder !== undefined) folders.add(folder);
  }
  const packages = [...folders].map((folder) => {
    const manifest = JSON.parse(readFileSync(join(root, folder, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
      license?: string;
    };
    const licenceFile = readdirSync(join(root, folder))
      .filter((name) => LICENCE_FILE.test(name))
      .sort()[0];
    if (licenceFile === undefined) {
      throw new Error(`${String(manifest.name)} has no licence file to ship with it`);
    }
    const text = readFileSync(join(root, folder, licenceFile), "utf8").replaceAll("\r\n", "\n");
    return {
      title: `${String(manifest.name)} ${String(manifest.version)} (${String(manifest.license)})`,
      text: text.trimEnd(),
    };
  });
  packages.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  const rule = "=".repeat(78);
  return [
    `Third-party software in this build's lib/ and ui/ folders, each with its licence.`,
    `Node.js and the libraries it bundles are in licenses/node.txt.`,
    "",
    ...packages.flatMap((p) => [rule, p.title, rule, "", p.text, ""]),
  ].join("\n");
}

/**
 * lib/bridge.mjs's own entry: the bridge's runMcp, with the offline answers beside it (A2 3.7.3).
 * The entry and the CLI call it as they call @tasks/bridge/mcp's runMcp from source.
 */
const BRIDGE_GLUE = `import { fileURLToPath } from "node:url";
import { runMcp as run } from "./${BRIDGE_RUN}";
// \`${PRODUCT_ID} mcp\` in a built version folder: the bridge with lib/mcp-offline.json.
export function runMcp(argv, options = {}) {
  return run(argv, { libFile: fileURLToPath(new URL("./mcp-offline.json", import.meta.url)), ...options });
}
`;

/** Every file below `dir`, as sorted forward-slash relative paths. */
function filesBelow(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesBelow(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Writes `<out>/lib/` and returns what is in it. */
export async function bundle(options: BundleOptions): Promise<BundleResult> {
  const { root, identity } = options;
  const lib = join(options.out, "lib");
  rmSync(lib, { recursive: true, force: true });
  mkdirSync(join(lib, "chunks"), { recursive: true });

  const entry = await run(
    "the entry's build",
    root,
    {
      entryPoints: { [PRODUCT_ID]: ENTRY_SOURCE },
      outdir: lib,
      splitting: false,
      plugins: [
        externalPlugin(root, [
          { importer: ENTRY_SOURCE, specifier: "./run.ts", to: "./chunks/cli.mjs" },
          { importer: ENTRY_SOURCE, specifier: SHIM_SPECIFIER, to: "./shim.mjs" },
          { importer: BRIDGE_ROUTE, specifier: BRIDGE_MODULE, to: "./bridge.mjs" },
        ]),
      ],
    },
    [],
  );
  const chunks = await run(
    "the CLI and worker build",
    root,
    {
      entryPoints: {
        cli: CLI_SOURCE,
        ...Object.fromEntries(WORKERS.map((w) => [w.name, w.entry])),
      },
      outdir: join(lib, "chunks"),
      splitting: true,
      entryNames: "[name]",
      chunkNames: "[name]-[hash]",
      plugins: [
        externalPlugin(root, [
          { importer: BRIDGE_ROUTE, specifier: BRIDGE_MODULE, to: "../bridge.mjs" },
        ]),
        commonJsPlugin(),
      ],
    },
    [
      ...chunkEdits(identity),
      ...(options.trustKeys === undefined ? [] : [trustEdit(options.trustKeys)]),
    ],
  );
  const bridge = await run(
    "the bridge's build",
    root,
    {
      stdin: {
        contents: BRIDGE_GLUE,
        resolveDir: root,
        sourcefile: "bridge-entry.mjs",
        loader: "js",
      },
      outfile: join(lib, "bridge.mjs"),
      splitting: false,
    },
    bridgeEdits(identity),
  );
  // The shim on its own: the entry's `tasks shim` route imports it, nothing else does.
  const shim = await run(
    "the shim's build",
    root,
    {
      entryPoints: { shim: SHIM_RUN },
      outdir: lib,
      splitting: false,
    },
    shimEdits(identity),
  );
  const offline = JSON.parse(readFileSync(join(root, BRIDGE_OFFLINE), "utf8")) as Record<
    string,
    unknown
  >;
  if (offline["format"] !== 1) throw new Error(`${BRIDGE_OFFLINE} has an unknown format`);
  offline["build"] = identity.build;
  writeFileSync(join(lib, "mcp-offline.json"), `${JSON.stringify(offline, null, 2)}\n`);

  // Only Node's built-ins stay outside the bundles, and the files of lib/ they name on purpose;
  // the bridge's and the shim's bundles import only the built-ins each is allowed (A2 3.7.1,
  // A4 3.6.3).
  const linked = new Set(["./chunks/cli.mjs", "./bridge.mjs", "../bridge.mjs", "./shim.mjs"]);
  const outside = [
    ...externals(entry).filter((e) => !linked.has(e.path) && !isBuiltin(e.path)),
    ...externals(chunks).filter((e) => !linked.has(e.path) && !isBuiltin(e.path)),
    ...externals(bridge).filter((e) => !BRIDGE_BUILTINS.includes(e.path)),
    ...externals(shim).filter((e) => !SHIM_BUILTINS.includes(e.path)),
  ];
  if (outside.length > 0) {
    fail(
      "a bundle imports what the version folder does not have",
      outside.map((e) => `${e.file}: ${e.path}`),
    );
  }

  const files = filesBelow(lib).map((f) => `lib/${f}`);
  // Everything the output loads at run time is a built-in or a file of lib/, named so the build
  // can see it (outputLoadProblems).
  const isLibFile = (path: string) => files.includes(path);
  const unresolved: string[] = [];
  for (const file of files.filter((f) => f.endsWith(".mjs"))) {
    const text = readFileSync(join(options.out, file), "utf8");
    if (text.includes("Dynamic require of")) {
      unresolved.push(`${file}: needs require(), which an ES module does not have`);
    }
    unresolved.push(...outputLoadProblems(file, text, isLibFile, file === `lib/${PRODUCT_ID}.mjs`));
  }
  if (unresolved.length > 0) {
    fail("a bundle loads at run time what the build cannot vouch for", unresolved);
  }
  return {
    lib,
    files,
    thirdParty: thirdPartyText(root, [entry, chunks, bridge, shim], options.extraInputs),
  };
}
