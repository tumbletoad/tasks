// The bundles: the build's edits match the sources exactly once, the guard refuses a
// module URL a bundle could not keep, and a real bundle of this tree runs, turns on the compile
// cache, maps every worker entry to a file it has, imports only Node built-ins, holds no path of
// this machine and is the same bytes when built again elsewhere. In a temporary folder.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testEnv } from "../../packages/testkit/src/env.ts";
import { repoRoot } from "../run.ts";
import {
  BRIDGE_BUILTINS,
  bridgeEdits,
  bundle,
  chunkEdits,
  commonJsPlugin,
  moduleUrlProblems,
  outputLoadProblems,
  SHIM_BUILTINS,
  shimEdits,
  WORKERS,
  type BundleResult,
} from "./bundle.ts";
import { machinePathNeedles } from "./version-folder.ts";

const identity = { version: "0.1.0-dev.42", build: "fixture0b0d1" };

let work: string;
let first: BundleResult;
beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "ttasks-bundle-"));
  first = await bundle({ root: repoRoot, out: join(work, "one"), identity });
}, 120_000);
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const count = (text: string, find: string) => text.split(find).length - 1;

describe("[A2.3.12.2.build.bundle] the esbuild bundles of lib/", () => {
  test("every edit the build makes matches its source file exactly once", () => {
    for (const edit of [
      ...chunkEdits(identity),
      ...bridgeEdits(identity),
      ...shimEdits(identity),
    ]) {
      expect(count(readFileSync(join(repoRoot, edit.file), "utf8"), edit.find), edit.file).toBe(1);
    }
    // Every worker the service starts from a module file is an entry of the bundle.
    for (const worker of WORKERS) expect(existsSync(join(repoRoot, worker.entry))).toBe(true);
  });

  test("the guard refuses a module file the bundle does not have, and other import.meta uses", () => {
    expect(moduleUrlProblems("x.ts", 'new URL("./storage-worker.mjs", import.meta.url)')).toEqual(
      [],
    );
    expect(moduleUrlProblems("x.ts", 'new Worker(new URL("./entry.ts", import.meta.url))')).toEqual(
      ["x.ts: names a module file the bundle does not have: ./entry.ts"],
    );
    expect(moduleUrlProblems("x.ts", "const here = import.meta.dirname;")).toEqual([
      "x.ts: uses import.meta in a way a bundle cannot keep",
    ]);
    expect(moduleUrlProblems("x.ts", "const here = import . meta . dirname;")).toHaveLength(1);
    expect(moduleUrlProblems("x.ts", "readFileSync(join(__dirname, 'a'))")).toHaveLength(1);
    // The entry may read its own location once, and nothing else may.
    expect(
      moduleUrlProblems("packages/cli/src/entry.ts", "fileURLToPath(import.meta.url)"),
    ).toEqual([]);
    expect(
      moduleUrlProblems("packages/cli/src/run.ts", "fileURLToPath(import.meta.url)"),
    ).toHaveLength(1);
  });

  test("the output may load only built-ins and files of lib/, each named by a literal", () => {
    const lib = new Set([
      "lib/ttasks.mjs",
      "lib/chunks/cli.mjs",
      "lib/chunks/x.mjs",
      "lib/bridge.mjs",
    ]);
    const check = (text: string, own = false) =>
      outputLoadProblems("lib/chunks/cli.mjs", text, (path) => lib.has(path), own);
    // What the bundles hold today passes.
    expect(
      check(
        [
          'import { join } from "node:path";',
          'import fs from "fs";',
          'export { a } from "./x.mjs";',
          'const run = await import("./x.mjs");',
          'const bridge = await import("../bridge.mjs");',
          'const sqlite = await import("node:sqlite");',
          'const entry = new URL("./x.mjs", import.meta.url);',
          '// import("./not-shipped.mjs"), require("x"), import.meta.dirname, __dirname',
          'const text = "import(\\"./nothing.mjs\\") import.meta __filename";',
          "const options = { __dirname: 1 }; options.__dirname;",
        ].join("\n"),
      ),
    ).toEqual([]);
    // A load the build cannot see or vouch for fails, however it is spelt.
    for (const text of [
      'const name = "./x.mjs"; await import(name);',
      "await import(`./${'x'}.mjs`);",
      'await import("./missing.mjs");',
      'await import("../../outside.mjs");',
      'await import("zod");',
      'import "./missing.mjs";',
      'import z from "zod";',
      'export * from "./missing.mjs";',
      'import { createRequire } from "node:module";',
      'import module from "node:module"; module.createRequire(process.argv[1])("./x.cjs");',
      'require("./x.cjs");',
      'new URL("./missing.mjs", import.meta.url);',
      "const where = import . meta . dirname;",
      "const r = import.meta.resolve('./x.mjs');",
      "readFileSync(join(__dirname, 'a'));",
      "const f = __filename;",
      // A built-in Node does not have.
      'await import("node:missing_builtin");',
      'import x from "node:missing_builtin";',
      // node:module's loaders, by any spelling, and the ways to node:module or native code
      // without an import.
      'import Module from "node:module"; Module["createRequire"](process.cwd() + "/p.json")("./x.cjs");',
      'import Module from "node:module"; const k = "createRequire"; Module[k](process.argv[1]);',
      'import * as m from "node:module"; m.register("./hook.mjs");',
      'import { register } from "node:module"; register("./hook.mjs");',
      'import { enableCompileCache as e, registerHooks } from "node:module"; e(); registerHooks({});',
      'import module from "node:module"; const { createRequire: c } = module;',
      'import module from "node:module"; use(module);',
      'export { createRequire } from "node:module";',
      'const m = await import("node:module");',
      'import "module";',
      'process.getBuiltinModule("node:module").createRequire(process.argv[1]);',
      'process["getBuiltinModule"]("module");',
      'process.dlopen({ exports: {} }, "./x.node");',
      'globalThis.process["dlopen"]({}, "./x.node");',
    ]) {
      expect(check(text), text).not.toEqual([]);
      expect(check(text, true), `${text} (in the entry)`).not.toEqual([]);
    }
    // The entry may read its own location, once, and turn on the compile cache: no other file may.
    expect(check("const here = import.meta.url;")).not.toEqual([]);
    expect(check("fileURLToPath(import.meta.url);", true)).toEqual([]);
    expect(check("fileURLToPath(import.meta.url); import.meta.url;", true)).toHaveLength(1);
    const cache = 'import module from "node:module"; module.enableCompileCache(dir);';
    expect(check(cache, true)).toEqual([]);
    expect(check(cache)).not.toEqual([]);
    expect(
      check('import { enableCompileCache } from "node:module"; enableCompileCache(dir);', true),
    ).toEqual([]);
  });

  test("lib/ holds the entry, the CLI, the three worker entries, and the bridge and the shim each on its own", () => {
    const chunks = first.files.filter((f) => f.startsWith("lib/chunks/"));
    for (const name of ["cli", ...WORKERS.map((w) => w.name)]) {
      expect(chunks, name).toContain(`lib/chunks/${name}.mjs`);
    }
    for (const file of [
      "lib/ttasks.mjs",
      "lib/bridge.mjs",
      "lib/mcp-offline.json",
      "lib/shim.mjs",
    ]) {
      expect(first.files).toContain(file);
    }
    const read = (file: string) => readFileSync(join(work, "one", file), "utf8");
    // The stamps reached the bundle.
    const all = first.files.map(read).join("\n");
    expect(all).toContain(`version: "${identity.version}", build: "${identity.build}"`);
    expect(all).toContain(`SOURCE_APP_VERSION = "${identity.version}"`);
    expect(all).not.toContain('build: "source"');
    expect(JSON.parse(read("lib/mcp-offline.json"))).toMatchObject({
      format: 1,
      build: identity.build,
    });
    // Every worker URL names a file of lib/chunks/.
    for (const worker of WORKERS) {
      expect(all).toContain(`new URL("./${worker.name}.mjs", import.meta.url)`);
    }
    // The entry imports no chunk statically, so the compile cache is on before any loads; it
    // reaches the CLI and the bridge only through dynamic imports of their own files.
    const entry = read("lib/ttasks.mjs");
    expect(entry).not.toMatch(/^import .* from "\.\.?\//m);
    expect(entry).toContain('import("./chunks/cli.mjs")');
    expect(entry).toContain('import("./bridge.mjs")');
    // The CLI reaches the bridge in its own file too: the bridge is in no chunk.
    expect(chunks.map(read).join("\n")).toContain('import("../bridge.mjs")');
    expect(chunks.map(read).join("\n")).not.toContain("BRIDGE_BUILD");
    // The bridge imports only the built-ins it is allowed.
    const imports = [...read("lib/bridge.mjs").matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(BRIDGE_BUILTINS).toContain(specifier);
    expect(read("lib/bridge.mjs")).not.toMatch(/\bimport\(/);
    // The shim is in no chunk either: the entry reaches it through its own file, it
    // imports only the built-ins it is allowed, loads nothing at run time, and carries its build.
    expect(entry).toContain('import("./shim.mjs")');
    expect(entry).not.toContain("SHIM_BUILD");
    expect(chunks.map(read).join("\n")).not.toContain("SHIM_BUILD");
    const shim = read("lib/shim.mjs");
    const shimImports = [...shim.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(shimImports.length).toBeGreaterThan(0);
    for (const specifier of shimImports) expect(SHIM_BUILTINS).toContain(specifier);
    expect(shim).not.toMatch(/\bimport\(/);
    expect(shim).toContain(
      `SHIM_BUILD = { version: "${identity.version}", build: "${identity.build}" }`,
    );
    expect(shim).toMatch(/export \{[^}]*\brunShim\b/);
  });

  test("THIRD_PARTY.txt names each npm package in the bundles with its licence", () => {
    expect(first.thirdParty).toMatch(/^zod \d+\.\d+\.\d+ \(MIT\)$/m);
    expect(first.thirdParty).toMatch(/^smol-toml \d+\.\d+\.\d+ \(BSD-3-Clause\)$/m);
    // The UI listener's WebSocket server, without its optional native add-ons.
    expect(first.thirdParty).toMatch(/^ws \d+\.\d+\.\d+ \(MIT\)$/m);
    expect(first.thirdParty).not.toMatch(/bufferutil|utf-8-validate/);
    expect(first.thirdParty).not.toMatch(/esbuild/);
  });

  test("the bundles hold no path of this machine and come out the same when built elsewhere", async () => {
    const needles = machinePathNeedles([repoRoot, work]);
    for (const file of first.files) {
      const text = readFileSync(join(work, "one", file), "utf8");
      for (const needle of needles) expect(text.includes(needle), `${file}: ${needle}`).toBe(false);
    }
    const second = await bundle({ root: repoRoot, out: join(work, "two"), identity });
    expect(second.files).toEqual(first.files);
    for (const file of first.files) {
      expect(
        readFileSync(join(work, "two", file)).equals(readFileSync(join(work, "one", file))),
        file,
      ).toBe(true);
    }
    expect(second.thirdParty).toBe(first.thirdParty);
  }, 120_000);

  test("the bundled entry runs the CLI and turns on the compile cache under the install's cache", () => {
    const home = join(work, "home");
    const ran = spawnSync(
      process.execPath,
      ["--report-exclude-env", join(work, "one", "lib", "ttasks.mjs"), "version"],
      { env: testEnv({ TTASKS_HOME: home }), encoding: "utf8", windowsHide: true, timeout: 60_000 },
    );
    expect(ran.stderr).toBe("");
    expect(ran.stdout.replaceAll("\r\n", "\n")).toBe(
      `TTasks ${identity.version} (${identity.build})\n`,
    );
    expect(readdirSync(join(home, "cache", "compile")).length).toBeGreaterThan(0);
  });

  test("ws, a CommonJS package, bundles with static imports of built-ins only and runs without its add-ons", async () => {
    // The UI listener's server and a client, bundled as lib/ bundles them, talk over a WebSocket.
    const dir = join(work, "ws");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "entry.mjs"),
      [
        'import { WebSocket, WebSocketServer } from "ws";',
        'const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });',
        'server.on("connection", (socket) => socket.on("message", (data) => { console.log(String(data)); client.close(); server.close(); }));',
        "let client;",
        'server.on("listening", () => { client = new WebSocket(`ws://127.0.0.1:${server.address().port}`); client.on("open", () => client.send("hello over the bundle")); });',
        "",
      ].join("\n"),
    );
    const result = await esbuild.build({
      entryPoints: [join(dir, "entry.mjs")],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node26",
      outfile: join(dir, "out.mjs"),
      absWorkingDir: join(repoRoot, "packages", "service"),
      // The entry is in a temporary folder: ws is the service package's own dependency.
      nodePaths: [join(repoRoot, "packages", "service", "node_modules")],
      metafile: true,
      logLevel: "silent",
      plugins: [commonJsPlugin()],
    });
    expect(result.warnings).toEqual([]);
    const externals = Object.values(result.metafile.outputs).flatMap((o) =>
      o.imports.filter((i) => i.external).map((i) => i.path),
    );
    expect(externals.every((path) => path.startsWith("node:"))).toBe(true);
    const text = readFileSync(join(dir, "out.mjs"), "utf8");
    expect(outputLoadProblems("out.mjs", text, () => false, false)).toEqual([]);
    expect(text).not.toContain("Dynamic require of");
    const ran = spawnSync(process.execPath, [join(dir, "out.mjs")], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    expect(ran.stderr).toBe("");
    expect(ran.stdout.trim()).toBe("hello over the bundle");
  });

  test("ttasks mcp through the bundled entry is the bridge, answering from lib/mcp-offline.json", () => {
    // No service runs in this TTASKS_HOME, so the bridge answers initialize from its offline file.
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fixture-client", version: "1.0.0" },
      },
    };
    const ran = spawnSync(
      process.execPath,
      ["--report-exclude-env", join(work, "one", "lib", "ttasks.mjs"), "mcp"],
      {
        env: testEnv({ TTASKS_HOME: join(work, "mcp-home") }),
        input: `${JSON.stringify(initialize)}\n`,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      },
    );
    expect(ran.status, ran.stderr).toBe(0);
    const reply = JSON.parse(ran.stdout.split("\n")[0] ?? "") as {
      id?: unknown;
      result?: { protocolVersion?: unknown };
    };
    expect(reply.id).toBe(1);
    expect(reply.result?.protocolVersion).toBe("2025-11-25");
    expect(ran.stderr).toMatch(/^mcp bridge: /m);
  });
});
