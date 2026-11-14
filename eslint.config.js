// ESLint flat config: typescript-eslint with type information, plus the custom rules of A7 3.3,
// through built-in rules where they can express them and local rules in scripts/eslint/ where
// they cannot. In the page (packages/web), eslint-plugin-formatjs refuses a literal UI string in JSX
// (A5 3.23): every word the page shows comes from its message catalogue.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import formatjs from "eslint-plugin-formatjs";
import tseslint from "typescript-eslint";
import noShellExec from "./scripts/eslint/no-shell-exec.js";

// Local rules that no-restricted-syntax cannot express, because they follow bindings.
const tasks = { rules: { "no-shell-exec": noShellExec } };

const TEST_FILES = ["**/*.test.{ts,tsx,js,jsx,mjs}", "**/test/**", "tests/**"];

const SPAWNERS = "/^(spawn|spawnSync|execFile|execFileSync|fork)$/";

// No shell: true and no .cmd spawn (A4). Applies everywhere, tests included.
const noShell = [
  {
    selector: "Property:matches([key.name='shell'], [key.value='shell']):not([value.value=false])",
    message: "Do not spawn through a shell (A4). Pass the executable and an argument array.",
  },
  {
    selector:
      "AssignmentExpression:matches([left.property.name='shell'], [left.property.value='shell']):not([right.value=false])",
    message: "Do not spawn through a shell (A4). Pass the executable and an argument array.",
  },
  {
    selector: `CallExpression[callee.name=${SPAWNERS}] > Literal[value=/\\.(cmd|bat)$/i]`,
    message: "Do not spawn .cmd or .bat files (A4). Run the real executable or node <script>.",
  },
  {
    selector: `CallExpression[callee.property.name=${SPAWNERS}] > Literal[value=/\\.(cmd|bat)$/i]`,
    message: "Do not spawn .cmd or .bat files (A4). Run the real executable or node <script>.",
  },
];

// No os.tmpdir() outside tests (A2 3.2.2 rule 4).
const noTmpdir = [
  {
    selector: "MemberExpression[property.name='tmpdir']",
    message: "Do not use os.tmpdir() outside tests (A2 3.2.2). Use <state>/tmp/.",
  },
];

// No AppData paths in product code (A2 3.2.2 rule 4): MSIX virtualises new files there, so
// nothing another Tasks process must see may live in %APPDATA% or %LOCALAPPDATA%. Machine-local
// files live under %USERPROFILE%\.tasks and the program under %USERPROFILE%\.local. Lab code
// (spikes/) probes AppData on purpose.
const APPDATA_MESSAGE =
  "Do not use AppData paths (A2 3.2.2). Data lives under %USERPROFILE%\\.tasks, the program under %USERPROFILE%\\.local.";
const noAppData = [
  { selector: "Literal[value=/appdata/i]", message: APPDATA_MESSAGE },
  { selector: "TemplateElement[value.raw=/appdata/i]", message: APPDATA_MESSAGE },
  { selector: "MemberExpression[property.name=/appdata/i]", message: APPDATA_MESSAGE },
];

// The umask is never read or set through process.umask() (A2 3.2.2 rule 5): without an argument it
// reads the mask by setting it to 0 and back, and a file another thread creates in between gets
// every bit of its mode; with one it changes the mask the service's agents inherit. hub/umask.ts
// reads it from /proc or a child. Product code only: a test may pin a mask in a child of its own.
const UMASK_MESSAGE =
  "Do not call process.umask() (A2 3.2.2 rule 5): it sets the mask of every thread. Use readUmask() of hub/umask.ts.";
const noUmask = [
  {
    selector:
      "MemberExpression[object.name='process']:matches([property.name='umask'], [property.value='umask'])",
    message: UMASK_MESSAGE,
  },
  {
    selector: "MemberExpression[object.property.name='process'][property.name='umask']",
    message: UMASK_MESSAGE,
  },
  {
    selector:
      "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='umask']",
    message: UMASK_MESSAGE,
  },
];
const umaskImports = ["process", "node:process"].map((name) => ({
  name,
  importNames: ["umask"],
  message: UMASK_MESSAGE,
}));

const tmpdirImports = ["os", "node:os"].map((name) => ({
  name,
  importNames: ["tmpdir"],
  message: "Do not use os.tmpdir() outside tests (A2 3.2.2). Use <state>/tmp/.",
}));

// No stdout writes in the bridge (A7 3.3, A2 3.7.2): its stdout carries MCP frames and nothing
// else, and the forwarder is the one writer, through the stream it is given.
// packages/bridge/src/mcp/io.ts hands it process.stdout and is the one file that may name it. No
// console either: the bridge's diagnostics go to stderr through one content-free function.
const STDOUT_MESSAGE =
  "The bridge writes stdout only through the forwarder (A2 3.7.2): stdout carries MCP frames only.";
const noStdout = [
  {
    selector: "MemberExpression[object.name='process'][property.name='stdout']",
    message: STDOUT_MESSAGE,
  },
  {
    selector: "MemberExpression[object.name='console']",
    message: "No console in the bridge (A2 3.7.2). Diagnostics go to stderr through its warn().",
  },
  {
    selector: "CallExpression[callee.property.name=/^write(Sync)?$/][arguments.0.value=1]",
    message: STDOUT_MESSAGE,
  },
];
// The bridge loads only what a static walk sees (A2 3.7.1, A7 A.3: it can never start a
// process): no dynamic import, require or native binding. packages/bridge/src/mcp/imports.test.ts
// walks the static graph, and dependency-cruiser's bridge-few-builtins rule checks its built-ins.
const LOAD_MESSAGE =
  "The bridge loads modules only through static imports (A2 3.7.1), so a walk of them is all it can load.";
const noDynamicLoad = [
  { selector: "ImportExpression", message: LOAD_MESSAGE },
  { selector: "CallExpression[callee.name='require']", message: LOAD_MESSAGE },
  { selector: "Identifier[name='createRequire']", message: LOAD_MESSAGE },
  {
    selector:
      "MemberExpression[object.name='process'][property.name=/^(dlopen|binding|_linkedBinding)$/]",
    message: LOAD_MESSAGE,
  },
];
// The page's words come from its catalogue (A5 3.23). Prose is two words with a space between, in
// a string or in one stretch of a template string. Errors for developers, class names and React
// Aria's `placement` are not the page's words.
const PROSE = "/[A-Za-z]{2,} +[A-Za-z]{2,}/";
const PROSE_MESSAGE =
  "Words the page shows come from its message catalogue (src/i18n/en.json, A5 3.23).";
const NOT_WORDS =
  ":matches(NewExpression[callee.name='Error'], JSXAttribute[name.name=/^(className|placement)$/])";
const noUiProse = [
  { selector: `Literal[value=${PROSE}]:not(${NOT_WORDS} Literal)`, message: PROSE_MESSAGE },
  {
    selector: `TemplateElement[value.raw=${PROSE}]:not(${NOT_WORDS} TemplateElement)`,
    message: PROSE_MESSAGE,
  },
];
const stdoutImports = ["process", "node:process"].map((name) => ({
  name,
  importNames: ["stdout"],
  message: STDOUT_MESSAGE,
}));

export default defineConfig([
  globalIgnores([
    "planning/",
    "local/",
    ".claude/",
    "**/node_modules/",
    "**/dist/",
    "**/coverage/",
    "packages/contracts/generated/",
    "docs/agents/",
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { tasks },
    rules: {
      "no-restricted-syntax": ["error", ...noShell, ...noTmpdir, ...noUmask],
      "no-restricted-imports": ["error", { paths: [...tmpdirImports, ...umaskImports] }],
      // exec and execSync always run a shell (A4). Applies everywhere, tests included.
      "tasks/no-shell-exec": "error",
    },
  },
  {
    files: ["packages/**"],
    rules: {
      "no-restricted-syntax": ["error", ...noShell, ...noTmpdir, ...noAppData, ...noUmask],
    },
  },
  {
    files: ["packages/bridge/src/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noShell,
        ...noTmpdir,
        ...noAppData,
        ...noUmask,
        ...noStdout,
        ...noDynamicLoad,
      ],
      "no-restricted-imports": [
        "error",
        { paths: [...tmpdirImports, ...umaskImports, ...stdoutImports] },
      ],
    },
  },
  {
    // io.ts hands the forwarder process.stdout: the one file that may name it.
    files: ["packages/bridge/src/mcp/io.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noShell,
        ...noTmpdir,
        ...noAppData,
        ...noUmask,
        ...noDynamicLoad,
      ],
      "no-restricted-imports": ["error", { paths: [...tmpdirImports, ...umaskImports] }],
    },
  },
  {
    files: TEST_FILES,
    rules: {
      "no-restricted-syntax": ["error", ...noShell],
      "no-restricted-imports": "off",
    },
  },
  {
    // The page's words come from its catalogue (A5 3.23): no literal text, aria-label, title,
    // placeholder or alt in JSX. Tests are exempt.
    files: ["packages/web/src/**/*.{tsx,jsx}"],
    ignores: TEST_FILES,
    plugins: { formatjs },
    rules: { "formatjs/no-literal-string-in-jsx": "error" },
  },
  {
    // Words kept in a variable or built in a .ts module reach the page past the JSX rule: prose
    // anywhere in the page's code is refused (noUiProse). The theme modules run only in the build
    // and its tests (build.ts writes their CSS), so their checks' words never reach the page.
    files: ["packages/web/src/**/*.{ts,tsx,js,jsx}"],
    ignores: [
      ...TEST_FILES,
      "packages/web/src/theme/tokens.ts",
      "packages/web/src/theme/themes.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...noShell, ...noTmpdir, ...noAppData, ...noUiProse],
    },
  },
  {
    files: ["**/*.js", "**/*.jsx", "**/*.cjs", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly", __dirname: "readonly" },
    },
  },
]);
