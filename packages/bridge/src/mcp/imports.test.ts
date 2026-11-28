// The bridge loads fast and stays small because its bundle imports only a few Node built-ins,
// and it never starts the service:
// nothing it loads can spawn a process. This walks the runtime imports from the script
// entry; type-only imports are erased and do not count. Two parser-based checks back it in
// `pnpm verify`: lint refuses every dynamic load in the bridge (eslint.config.js), and
// dependency-cruiser's bridge-few-builtins rule refuses any other built-in.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));

/**
 * The bridge needs net, fs, crypto and process. path, os and url are small parts of Node's core, and
 * v8 sets the flag of safe-exit.ts.
 */
const ALLOWED = [
  "node:crypto",
  "node:fs",
  "node:net",
  "node:os",
  "node:path",
  "node:process",
  "node:url",
  "node:v8",
];

/** Runtime import and re-export specifiers of one module, with or without import attributes. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*(["'])([^"']+)\4/gms;
  for (const match of source.matchAll(statement)) {
    if (match[2] !== undefined) continue; // import type / export type
    found.push(match[5] ?? "");
  }
  for (const match of source.matchAll(/^\s*import\s*(["'])([^"']+)\1/gm))
    found.push(match[2] ?? "");
  return found;
}

/**
 * Ways to load code that a static walk cannot follow: a dynamic import (with any argument or
 * options), require, createRequire, process.dlopen or process.binding. The bridge uses none, so
 * the static graph is everything it can load.
 */
function dynamicLoads(source: string): string[] {
  // Space between the keyword and its parenthesis may hold comments: `import /* x */ (…)`.
  const gap = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
  const loader = new RegExp(
    String.raw`\b(?:import|require)${gap}\(|\bcreateRequire\b|\bprocess${gap}\.${gap}(?:dlopen|binding|_linkedBinding)\b`,
    "g",
  );
  return [...source.matchAll(loader)].map((match) => match[0]);
}

function graph(): { modules: string[]; builtins: Set<string>; dynamic: string[] } {
  const seen = new Set<string>();
  const builtins = new Set<string>();
  const dynamic: string[] = [];
  const queue = [ENTRY];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const load of dynamicLoads(source)) dynamic.push(`${file}: ${load}`);
    for (const spec of specifiers(source)) {
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
      else builtins.add(spec);
    }
  }
  return { modules: [...seen], builtins, dynamic };
}

describe("[A2.3.7.bridge.hygiene] what the bridge loads", () => {
  test("only its own modules and the allowed built-ins, so nothing can start a process", () => {
    const { modules, builtins, dynamic } = graph();
    expect(dynamic).toEqual([]);
    const root = join(fileURLToPath(new URL("../", import.meta.url)));
    for (const module of modules) expect(module.startsWith(root), module).toBe(true);
    expect([...builtins].sort()).toEqual(ALLOWED.filter((name) => builtins.has(name)));
    for (const name of builtins) expect(ALLOWED).toContain(name);
    expect(builtins.has("node:child_process")).toBe(false);
    // The walk sees the forwarder and the protocol client, so it is the whole bridge.
    expect(modules.some((m) => m.endsWith("forwarder.ts"))).toBe(true);
    expect(modules.some((m) => m.endsWith("client.ts"))).toBe(true);
  });

  test("the walk reads imports the way the bridge writes them", () => {
    expect(
      specifiers(
        'import a from "node:fs";\nimport type { B } from "node:stream";\nimport {\n  c,\n  type D,\n} from "./x.ts";\nexport { e } from "./y.ts";\nexport type { F } from "./z.ts";\n',
      ),
    ).toEqual(["node:fs", "./x.ts", "./y.ts"]);
    expect(
      specifiers(
        "import data from './d.json' with { type: \"json\" };\nexport * from \"./all.ts\";\nimport 'node:net';\n",
      ),
    ).toEqual(["./d.json", "./all.ts", "node:net"]);
  });

  test("the walk refuses every load it cannot follow", () => {
    for (const source of [
      'const m = await import("node:child_process");',
      'const m = await import("node:child_process", { with: {} });',
      'const m = await import /* hidden */ ("node:child_process");',
      'const m = await import // hidden\n  ("node:child_process");',
      "const name = 'node:child_process';\nconst m = await import(name);",
      'const cp = require("child_process");',
      'import { createRequire } from "node:module";',
      "process.dlopen(module, file);",
      'process.binding("spawn_sync");',
    ]) {
      expect(dynamicLoads(source), source).not.toEqual([]);
    }
    expect(dynamicLoads('const url = new URL("./x", import.meta.url);')).toEqual([]);
  });
});
