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
const ttasks = { rules: { "no-shell-exec": noShellExec } };

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
// nothing another TTasks process must see may live in %APPDATA% or %LOCALAPPDATA%. Machine-local
// files live under %USERPROFILE%\.ttasks and the program under %USERPROFILE%\.local.
const APPDATA_MESSAGE =
  "Do not use AppData paths (A2 3.2.2). Data lives under %USERPROFILE%\\.ttasks, the program under %USERPROFILE%\\.local.";
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
// No diagnostic report in product code: on Windows, Node 26 takes one while any worker thread runs
// only at the cost of a corrupt heap (exit 0xC0000374), and every open space has workers. Tests may
// take one in a process of their own.
const REPORT_MESSAGE =
  "Do not take Node's diagnostic report in product code: one taken while a worker thread runs corrupts the heap and ends the process.";
const REPORT_NAME = "/^(getReport|writeReport)$/";
const noReport = [
  {
    selector: `MemberExpression:matches([property.name=${REPORT_NAME}], [property.value=${REPORT_NAME}])`,
    message: REPORT_MESSAGE,
  },
  {
    selector: `ObjectPattern > Property:matches([key.name=${REPORT_NAME}], [key.value=${REPORT_NAME}])`,
    message: REPORT_MESSAGE,
  },
];
// On Windows a process started `detached` has no console, so each console program it starts
// without windowsHide opens a window on the person's screen, a launched agent included. A test's
// process stays attached there, or its disable comment says why nothing it starts can show one.
const noConsoleless = [
  {
    selector: `CallExpression:matches([callee.name=${SPAWNERS}], [callee.property.name=${SPAWNERS}]) > ObjectExpression > Property[key.name='detached']:not([value.value=false]):not([value.operator='!=='][value.right.value='win32'])`,
    message:
      'A test\'s process started detached has no console on Windows, and each console program it starts opens a window. Use detached: process.platform !== "win32", or say in a disable comment why it starts none.',
  },
];
// A test's child gets its clean environment from testEnv() of the test kit, the one place that also
// names an Agent Monitor that does not exist: a launcher that removes TTasks's variables by hand
// would let its service run the machine's `ttam`.
const ENV_MESSAGE =
  "Build a child's environment with testEnv() of the test kit: it removes every TTasks variable and names no real Agent Monitor.";
const noHandEnv = [
  {
    selector: "CallExpression[callee.property.name='startsWith'] > Literal[value=/^TTASKS_$/i]",
    message: ENV_MESSAGE,
  },
  {
    selector: "CallExpression[callee.property.name='startsWith'] > Identifier[name='ENV_PREFIX']",
    message: ENV_MESSAGE,
  },
  {
    selector: "CallExpression[callee.property.name='test'][callee.object.regex.pattern=/TTASKS_/]",
    message: ENV_MESSAGE,
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
// A button in the page does something: a click, or a submit in its form. One without is a control a
// person presses in vain. A spread may carry the handler, so it passes.
const noDeadButton = [
  {
    selector:
      "JSXOpeningElement[name.name='button']:not(:has(JSXAttribute[name.name=/^on(Click|PointerDown|MouseDown)$/])):not(:has(JSXAttribute[name.name='type'][value.value='submit'])):not(:has(JSXSpreadAttribute))",
    message: 'A button needs an action: onClick, or type="submit" in a form.',
  },
];
// The page has one clock (row/useClock.ts), so everything that depends on the day moves to the next
// one together; a reading of today or of the time zone anywhere else would stay on yesterday. The
// rule sees the usual ways to read them; it cannot see `Date.now()` compared with a due date.
const DAY_MESSAGE = "Read the day from useClock (row/useClock.ts), the page's one clock.";
const noOwnDay = [
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: DAY_MESSAGE },
  { selector: "CallExpression[callee.property.name='toDateString']", message: DAY_MESSAGE },
  { selector: "MemberExpression[property.name='resolvedOptions']", message: DAY_MESSAGE },
  {
    selector:
      "CallExpression[callee.name='localDate'] > CallExpression.arguments[callee.object.name='Date'][callee.property.name='now']",
    message: DAY_MESSAGE,
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(toLocaleDateString|toLocaleTimeString|getDate|getDay|getMonth|getFullYear|getHours|getMinutes|setDate|setHours)$/]",
    message: "A date in the browser's default zone: read it with the clock's zone (row/dates.ts).",
  },
];
// Formatting in the default zone shows another day than the clock: dates.ts formats with its zone.
const FORMAT_MESSAGE =
  "Format a date with the clock's zone: formatInstant or formatDay (row/dates.ts).";
const noOwnFormat = [
  {
    selector: "NewExpression[callee.object.name='Intl'][callee.property.name='DateTimeFormat']",
    message: FORMAT_MESSAGE,
  },
  {
    selector: "CallExpression[callee.property.name=/^format(Date|Time)(ToParts)?$/]",
    message: FORMAT_MESSAGE,
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
    "tests/e2e/results/",
    "tests/e2e/report/",
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { ttasks },
    rules: {
      "no-restricted-syntax": ["error", ...noShell, ...noTmpdir, ...noUmask, ...noReport],
      "no-restricted-imports": ["error", { paths: [...tmpdirImports, ...umaskImports] }],
      // exec and execSync always run a shell (A4). Applies everywhere, tests included.
      "ttasks/no-shell-exec": "error",
    },
  },
  {
    files: ["packages/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noShell,
        ...noTmpdir,
        ...noAppData,
        ...noUmask,
        ...noReport,
      ],
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
        ...noReport,
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
        ...noReport,
      ],
      "no-restricted-imports": ["error", { paths: [...tmpdirImports, ...umaskImports] }],
    },
  },
  {
    files: ["packages/testkit/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noShell,
        ...noTmpdir,
        ...noAppData,
        ...noUmask,
        ...noReport,
        ...noConsoleless,
      ],
    },
  },
  {
    files: TEST_FILES,
    rules: {
      "no-restricted-syntax": ["error", ...noShell, ...noConsoleless, ...noHandEnv],
      "no-restricted-imports": "off",
    },
  },
  {
    // The browser tests' pictures go to public pull requests: only `picture` hides this machine.
    files: ["tests/e2e/**"],
    ignores: ["tests/e2e/page.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          property: "screenshot",
          message: "Take a picture with picture() from page.ts: it hides this machine's folders.",
        },
      ],
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
      "no-restricted-syntax": [
        "error",
        ...noShell,
        ...noTmpdir,
        ...noAppData,
        ...noUiProse,
        ...noDeadButton,
        ...noOwnDay,
        ...noOwnFormat,
      ],
    },
  },
  {
    // The formatters, each with the clock's zone.
    files: ["packages/web/src/row/dates.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noShell,
        ...noTmpdir,
        ...noAppData,
        ...noUiProse,
        ...noDeadButton,
        ...noOwnDay,
      ],
    },
  },
  {
    // The day rules the page shares with the service take their clock from the caller.
    files: ["packages/contracts/src/day.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noShell,
        ...noTmpdir,
        ...noAppData,
        ...noUmask,
        ...noReport,
        ...noOwnDay,
      ],
    },
  },
  {
    // The clock itself reads the day.
    files: ["packages/web/src/row/useClock.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noShell,
        ...noTmpdir,
        ...noAppData,
        ...noUiProse,
        ...noDeadButton,
        ...noOwnFormat,
      ],
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
