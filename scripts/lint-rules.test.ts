import { join } from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./run.ts";

// Lints snippets as JavaScript files at chosen paths, so the custom rules are checked without
// the type-aware TypeScript setup. The rules are the same for both languages.
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: join(repoRoot, "eslint.config.js"),
});

async function messages(code: string, path: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, path) });
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? "fatal"}: ${m.message}`);
}

const SOURCE = "packages/sample/src/probe.js";
const TEST = "packages/sample/src/probe.test.js";

describe("[A7.3.3.lint.custom-rules] the custom lint rules", () => {
  test("os.tmpdir() is refused in source and allowed in tests", async () => {
    const code = 'import os from "node:os";\nexport const t = os.tmpdir();\n';
    expect(await messages(code, SOURCE)).toEqual([expect.stringMatching(/^no-restricted-syntax/)]);
    expect(await messages(code, TEST)).toEqual([]);
    const named = 'import { tmpdir } from "node:os";\nexport const t = tmpdir;\n';
    expect(await messages(named, SOURCE)).toEqual([
      expect.stringMatching(/^no-restricted-imports/),
    ]);
  });

  test("AppData paths are refused in package source, allowed in tests", async () => {
    const imports = 'import process from "node:process";\n';
    const refused = [
      `${imports}export const p = process.env["LOCALAPPDATA"];\n`,
      `${imports}export const p = process.env.APPDATA;\n`,
      'export const p = "C:\\\\Users\\\\mira\\\\AppData\\\\Roaming\\\\tasks";\n',
      `${imports}export const p = \`\${process.env.USERPROFILE ?? ""}\\\\AppData\\\\Local\`;\n`,
    ];
    for (const code of refused) {
      expect(await messages(code, SOURCE), code).toEqual([
        expect.stringMatching(/^no-restricted-syntax: Do not use AppData/),
      ]);
      expect(await messages(code, TEST), code).toEqual([]);
    }
    expect(
      await messages(`${imports}export const p = process.env["USERPROFILE"];\n`, SOURCE),
    ).toEqual([]);
  });

  test("a test that removes TTasks's variables by hand is refused: testEnv() also names no monitor", async () => {
    const refused = [
      'export const kept = (names) => names.filter((n) => !n.startsWith("TTASKS_"));\n',
      'import { ENV_PREFIX } from "@ttasks/brand";\nexport const kept = (names) => names.filter((n) => !n.startsWith(ENV_PREFIX));\n',
      "export const kept = (names) => names.filter((n) => !/^(TTASKS_|CLAUDE)/i.test(n));\n",
    ];
    for (const code of refused) {
      expect(await messages(code, TEST), code).toEqual([
        expect.stringMatching(/^no-restricted-syntax: Build a child's environment with testEnv/),
      ]);
    }
  });

  test("shell: true is refused everywhere", async () => {
    const code =
      'import { spawn } from "node:child_process";\nspawn("git", ["status"], { shell: true });\n';
    expect(await messages(code, SOURCE)).toEqual([expect.stringMatching(/^no-restricted-syntax/)]);
    expect(await messages(code, TEST)).toEqual([expect.stringMatching(/^no-restricted-syntax/)]);
    const quoted =
      'import { spawn } from "node:child_process";\nspawn("git", [], { "shell": true });\n';
    expect(await messages(quoted, SOURCE)).toEqual([
      expect.stringMatching(/^no-restricted-syntax/),
    ]);
    const assigned =
      'import { spawn } from "node:child_process";\nconst o = {};\no.shell = true;\nspawn("git", [], o);\n';
    expect(await messages(assigned, SOURCE)).toEqual([
      expect.stringMatching(/^no-restricted-syntax/),
    ]);
    const off =
      'import { spawn } from "node:child_process";\nspawn("git", [], { shell: false });\n';
    expect(await messages(off, SOURCE)).toEqual([]);
  });

  test("a test's process may not start without a console on Windows", async () => {
    // The fake terminal that started the shim detached, so its agent opened a window.
    const shim =
      'import process from "node:process";\nimport { spawn } from "node:child_process";\nspawn(process.execPath, ["bin.ts", "shim"], { stdio: "ignore", windowsHide: true, detached: true });\n';
    const helper = "packages/testkit/src/fakes/probe.js";
    for (const path of [TEST, "tests/e2e/probe.js", helper]) {
      expect(await messages(shim, path), path).toEqual([
        expect.stringMatching(/^no-restricted-syntax: A test's process started detached/),
      ]);
    }
    const member =
      'import process from "node:process";\nimport cp from "node:child_process";\ncp.spawn("x", [], { detached: process.platform === "win32" });\n';
    expect(await messages(member, TEST)).toEqual([expect.stringMatching(/^no-restricted-syntax/)]);
    const attached =
      'import process from "node:process";\nimport { spawn } from "node:child_process";\nspawn("x", [], { detached: process.platform !== "win32" });\nspawn("x", [], { detached: false });\n';
    expect(await messages(attached, TEST)).toEqual([]);
    expect(await messages(attached, helper)).toEqual([]);
    expect(await messages(shim, SOURCE)).toEqual([]);
  });

  test("spawning a .cmd or .bat file is refused", async () => {
    const direct = 'import { spawn } from "node:child_process";\nspawn("pnpm.cmd", ["i"]);\n';
    const member = 'import cp from "node:child_process";\ncp.execFileSync("run.BAT", []);\n';
    expect(await messages(direct, SOURCE)).toEqual([expect.stringMatching(/\.cmd or \.bat/)]);
    expect(await messages(member, SOURCE)).toEqual([expect.stringMatching(/\.cmd or \.bat/)]);
  });

  test("a browser test takes its pictures only through the helper that hides this machine", async () => {
    const code = 'export const shoot = (page) => page.screenshot({ path: "x.png" });\n';
    expect(await messages(code, "tests/e2e/probe.e2e.js")).toEqual([
      expect.stringMatching(/^no-restricted-properties: .*picture\(\)/),
    ]);
    expect(await messages(code, "tests/e2e/page.ts")).not.toContainEqual(
      expect.stringMatching(/^no-restricted-properties/),
    );
  });

  test("exec and execSync, which always use a shell, are refused through every binding", async () => {
    const refused = [
      'import { execSync } from "node:child_process";\nexecSync("ls");\n',
      'import { exec as run } from "child_process";\nrun("ls");\n',
      'import cp from "node:child_process";\ncp.execSync("x");\n',
      'import * as cp from "child_process";\ncp.exec("x");\n',
      'import cp from "node:child_process";\ncp["execSync"]("x");\n',
      'import cp from "child_process";\nexport function f() {\n  return cp.execSync("x");\n}\n',
      'import cp from "child_process";\nconst { execSync: run } = cp;\nrun("x");\n',
      'import cp from "child_process";\nconst c = cp;\nconst d = c;\nd.exec("x");\n',
      'const cp = require("child_process");\ncp.execSync("x");\n',
      'const { exec } = require("node:child_process");\nexec("x");\n',
      'require("child_process").execSync("x");\n',
      'const cp = await import("node:child_process");\ncp.exec("x");\n',
      'export { execSync } from "child_process";\n',
      'export * from "node:child_process";\n',
      // The module's default export is the module itself.
      'import { default as cp } from "node:child_process";\ncp.execSync("x");\n',
      'import * as ns from "child_process";\nns.default.execSync("x");\n',
      'import * as ns from "child_process";\nconst { default: cp } = ns;\ncp.exec("x");\n',
      'const { default: cp } = await import("node:child_process");\ncp.exec("x");\n',
      'const { default: { execSync } } = await import("child_process");\nexecSync("x");\n',
      '(await import("node:child_process")).default.exec("x");\n',
      // A require made by createRequire, under any name.
      'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\n' +
        'load("child_process").exec("x");\n',
      'import mod from "node:module";\nconst require = mod.createRequire(import.meta.url);\n' +
        'const cp = require("node:child_process");\ncp.execSync("x");\n',
    ];
    for (const code of refused) {
      expect(await shellExecReports(code, SOURCE), code).toBe(1);
    }
    // Tests may not use them either.
    expect(await shellExecReports(refused[2] ?? "", TEST)).toBe(1);
    // TypeScript's import-equals form, linted without type information.
    const tsCode = 'import cp = require("node:child_process");\ncp.execSync("x");\n';
    expect(await shellExecReports(tsCode, "packages/sample/src/probe.ts", untyped)).toBe(1);
  });

  test("the bridge writes stdout only through its io module and never uses console", async () => {
    const BRIDGE = "packages/bridge/src/mcp/probe.js";
    const refused = [
      'process.stdout.write("x");\n',
      'import process from "node:process";\nprocess.stdout.write("x");\n',
      'console.log("x");\n',
      'console.error("x");\n',
      'import fs from "node:fs";\nfs.writeSync(1, "x");\n',
      'import { stdout } from "node:process";\nexport const s = stdout;\n',
    ];
    // The snippets are linted as JavaScript without Node's globals, so `no-undef` is beside the point.
    const reports = async (code: string, path: string) =>
      (await messages(code, path)).filter((m) => !m.startsWith("no-undef"));
    for (const code of refused) {
      expect(await reports(code, BRIDGE), code).toEqual([
        expect.stringMatching(/^no-restricted-(syntax|imports)/),
      ]);
      // Tests may, and so may other packages (the CLI prints to stdout).
      expect(await reports(code, "packages/bridge/src/mcp/probe.test.js"), code).toEqual([]);
      expect(await reports(code, SOURCE), code).toEqual([]);
    }
    expect(await reports('process.stderr.write("x");\n', BRIDGE)).toEqual([]);
  });

  test("the bridge loads modules only through static imports", async () => {
    const BRIDGE = "packages/bridge/src/mcp/probe.js";
    const reports = async (code: string, path: string) =>
      (await messages(code, path)).filter((m) => !m.startsWith("no-undef"));
    for (const code of [
      'export const m = await import("node:child_process");\n',
      'export const m = await import /* hidden */ ("node:child_process");\n',
      "const name = 'node:child_process';\nexport const m = await import(name);\n",
      'export const m = require("child_process");\n',
      'import { createRequire } from "node:module";\nexport const r = createRequire("x");\n',
      "export const b = process.binding('spawn_sync');\n",
      "export const d = (m, f) => process.dlopen(m, f);\n",
    ]) {
      const restricted = async (path: string) =>
        (await reports(code, path)).filter((m) => m.startsWith("no-restricted-syntax"));
      expect(await restricted(BRIDGE), code).not.toEqual([]);
      // io.ts, which may name stdout, may not load modules dynamically either.
      expect(await restricted("packages/bridge/src/mcp/io.js"), code).not.toEqual([]);
      // Tests may.
      expect(await restricted("packages/bridge/src/mcp/probe.test.js"), code).toEqual([]);
    }
    expect(await reports('import net from "node:net";\nexport const n = net;\n', BRIDGE)).toEqual(
      [],
    );
  });

  test("other exec methods and other child_process functions are allowed", async () => {
    const allowed = [
      '/x/.exec("x");\n',
      'const re = /x/;\nre.exec("x");\n',
      'const db = { exec() { return 1; } };\ndb.exec("select 1");\n',
      'import cp from "node:child_process";\ncp.execFileSync("git", []);\ncp.spawn("git", []);\n',
      'import * as cp from "node:child_process";\ncp.spawnSync("git", []);\n',
      'import cp from "node:child_process";\nexport function f(cp) {\n  return cp.exec("x");\n}\n',
      'import { exec } from "./local.js";\nexec();\n',
      // A local `require` is not Node's loader, whatever it is called with.
      'function require() {\n  return /x/;\n}\nconst cp = require("child_process");\ncp.exec("x");\n',
      'export function f(require) {\n  return require("child_process").exec("x");\n}\n',
      '{\n  const require = () => /x/;\n  require("node:child_process").exec("x");\n}\n',
      'import { require } from "./loader.js";\nrequire("child_process").exec("x");\n',
      // `.default` of something else, and a default import from another module.
      'import cp from "./local.js";\ncp.default.exec("x");\n',
      'import { default as cp } from "./local.js";\ncp.exec("x");\n',
    ];
    for (const code of allowed) {
      expect(await shellExecReports(code, SOURCE), code).toBe(0);
    }
  });
});

// Lints TypeScript without the type-aware setup, for syntax the JavaScript parser does not read.
const untyped = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: join(repoRoot, "eslint.config.js"),
  overrideConfig: [{ files: ["packages/sample/**/*.ts"], ...tseslint.configs.disableTypeChecked }],
});

async function shellExecReports(code: string, path: string, linter = eslint): Promise<number> {
  const [result] = await linter.lintText(code, { filePath: join(repoRoot, path) });
  const fatal = result?.messages.find((m) => m.fatal === true);
  if (fatal) throw new Error(`could not parse ${path}: ${fatal.message}`);
  return (result?.messages ?? []).filter((m) => m.ruleId === "ttasks/no-shell-exec").length;
}

// The umask is read without setting it (hub/umask.ts). process.umask() without an
// argument sets the mask of every thread to 0 for a moment, so product code never calls it; with
// an argument it would change what the service's agents inherit.
describe("[A2.3.2.2.permissions.umask] product code never calls process.umask()", () => {
  test("every way to reach it is refused in product code, the bridge and scripts, and allowed in tests", async () => {
    const imports = 'import process from "node:process";\n';
    const refused = [
      `${imports}export const m = process.umask();\n`,
      `${imports}process.umask(0o22);\n`,
      `${imports}export const m = process["umask"]();\n`,
      "export const m = globalThis.process.umask();\n",
      `${imports}const { umask } = process;\nexport const m = umask();\n`,
    ];
    for (const code of refused) {
      for (const path of [SOURCE, "packages/bridge/src/mcp/probe.js", "scripts/build/probe.js"]) {
        expect(await messages(code, path), `${path}: ${code}`).toEqual([
          expect.stringMatching(/^no-restricted-syntax: Do not call process\.umask\(\)/),
        ]);
      }
      expect(await messages(code, TEST), code).toEqual([]);
    }
    for (const from of ["process", "node:process"]) {
      const named = `import { umask } from "${from}";\nexport const m = umask();\n`;
      expect(await messages(named, SOURCE)).toEqual([
        expect.stringMatching(/^no-restricted-imports: .*Do not call process\.umask\(\)/),
      ]);
      expect(await messages(named, "packages/bridge/src/mcp/probe.js")).toEqual([
        expect.stringMatching(/^no-restricted-imports: .*Do not call process\.umask\(\)/),
      ]);
    }
    // A property of something else named umask is no call of it: install's injected reader.
    expect(await messages("export const f = (ctx) => ctx.umask?.();\n", SOURCE)).toEqual([]);
  });
});

describe("[A2.3.3.hub.system32-workers] product code takes no diagnostic report", () => {
  test("getReport and writeReport are refused in product code, the bridge and scripts, and allowed in tests", async () => {
    const imports = 'import process from "node:process";\n';
    const refused = [
      `${imports}export const r = process.report.getReport();\n`,
      `${imports}export const r = process.report["getReport"]();\n`,
      `${imports}process.report.writeReport("r.json");\n`,
      `${imports}const { getReport } = process.report;\nexport const r = getReport();\n`,
      `${imports}const { "writeReport": w } = process.report;\nw("r.json");\n`,
    ];
    for (const code of refused) {
      for (const path of [SOURCE, "packages/bridge/src/mcp/probe.js", "scripts/build/probe.js"]) {
        expect(await messages(code, path), `${path}: ${code}`).toEqual([
          expect.stringMatching(/^no-restricted-syntax: Do not take Node's diagnostic report/),
        ]);
      }
      expect(await messages(code, TEST), code).toEqual([]);
    }
    expect(
      await messages(`${imports}export const e = process.report.excludeEnv;\n`, SOURCE),
    ).toEqual([]);
  });
});

// The page's components as JSX, linted untyped at a path of the page.
const PAGE = "packages/web/src/app/Probe.jsx";

async function literalReports(code: string, path = PAGE): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, path) });
  const fatal = result?.messages.find((m) => m.fatal === true);
  if (fatal) throw new Error(`could not parse ${path}: ${fatal.message}`);
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "formatjs/no-literal-string-in-jsx")
    .map((m) => m.message);
}

describe("[A5.3.23.lint.literal-strings] lint finds a literal UI string in the page", () => {
  test("text, a name, a title, a placeholder or alt text written in JSX is refused", async () => {
    const refused = [
      "export const A = () => <p>Nothing open.</p>;\n",
      'export const B = () => <button aria-label="Copy">x</button>;\n',
      'export const C = () => <a title="Settings" href="/">x</a>;\n',
      'export const D = () => <input placeholder="New task" />;\n',
      'export const E = () => <img alt="Mira" src="/a.png" />;\n',
      'export const F = () => <p>{"Starting."}</p>;\n',
    ];
    for (const code of refused) {
      expect((await literalReports(code)).length, code).toBeGreaterThan(0);
    }
  });

  test("words from the catalogue and data pass; tests and other packages are not the page", async () => {
    const allowed = [
      'export const A = ({ t }) => <p>{t("view.nothingOpen")}</p>;\n',
      'export const B = ({ t }) => <button aria-label={t("row.copy")}>{t("row.copy")}</button>;\n',
      'export const C = ({ task }) => <p dir="auto">{task.title}</p>;\n',
      'export const D = () => <svg viewBox="0 0 24 24"><path d="M4 7h16" /></svg>;\n',
    ];
    for (const code of allowed) {
      expect(await literalReports(code), code).toEqual([]);
    }
    const literal = "export const A = () => <p>Nothing open.</p>;\n";
    expect(await literalReports(literal, "packages/web/src/app/Probe.test.jsx")).toEqual([]);
    expect(await literalReports(literal, "packages/sample/src/Probe.jsx")).toEqual([]);
  });
});

async function proseReports(code: string, path: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, path) });
  const fatal = result?.messages.find((m) => m.fatal === true);
  if (fatal) throw new Error(`could not parse ${path}: ${fatal.message}`);
  return (result?.messages ?? []).filter(
    (m) => m.ruleId === "no-restricted-syntax" && m.message.includes("catalogue"),
  ).length;
}

// Words kept in a variable or built in a .ts module reach the page past the JSX rule. Prose (two
// words with a space between) anywhere in the page's code is refused. A single word in a variable,
// or words split around a template's placeholders, are left to review.
describe("[A5.3.23.lint.ui-prose] lint finds words kept outside JSX in the page", () => {
  test("words in a variable, a template string or a .ts module of the page are refused", async () => {
    const refused = [
      ["export const label = 'Nothing open';\n", "packages/web/src/app/probe.js"],
      ["const label = 'Copy the link';\nexport const A = () => <p>{label}</p>;\n", PAGE],
      ["export const say = (n) => `${n} tasks were added`;\n", "packages/web/src/app/probe.js"],
      ["export const B = () => <p title={`Open the ${'x'}`}>x</p>;\n", PAGE],
    ] as const;
    for (const [code, path] of refused) {
      expect(await proseReports(code, path), code).toBeGreaterThan(0);
    }
  });

  test("errors for developers, single tokens, tests and other packages pass", async () => {
    const allowed = [
      ["export const f = () => { throw new Error('The service gave no ticket'); };\n", PAGE],
      ["export const f = (s) => { throw new Error(`The service answered ${s}`); };\n", PAGE],
      ["export const k = (e) => e.key === 'Enter';\n", "packages/web/src/app/probe.js"],
      ["export const P = () => <Popover placement='bottom start' />;\n", PAGE],
      ["export const C = (n) => <i className={n ? 'dot' : `dot slot-${n}`} />;\n", PAGE],
      ["export const h = (t) => ({ Authorization: `Bearer ${t}` });\n", PAGE],
    ] as const;
    for (const [code, path] of allowed) {
      expect(await proseReports(code, path), code).toBe(0);
    }
    const prose = "export const label = 'Nothing open';\n";
    expect(await proseReports(prose, "packages/web/src/app/probe.test.js")).toBe(0);
    expect(await proseReports(prose, "packages/sample/src/probe.js")).toBe(0);
  });
});
