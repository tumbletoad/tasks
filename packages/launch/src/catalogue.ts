// The built-in target catalogue (A4 3.2, L1): reviewed code, shipped in the binary. A target is
// what TTasks can open a task in; an instance (instances.ts) binds a target to one account or
// config home on this machine. Space data never carries a command: a target defined by a space is
// a `custom:` definition that stays disabled until approved on each machine (approval.ts).
//
// The facts come from A4 3.4 (routes), 3.11.6 (permission flags) and 3.15.3 (budgets). The launch
// steps (M2.08 to M2.11) build the routes on these entries; this step owns the data, its
// invariants and what detection needs.

export const BUILT_IN_TARGETS = [
  "t3",
  "claude-cli",
  "codex-cli",
  "claude-desktop",
  "codex-app",
  "clipboard",
] as const;

export type BuiltInTargetId = (typeof BUILT_IN_TARGETS)[number];
export type TargetId = BuiltInTargetId | `custom:${string}`;

/** A `custom:` target ID: `custom:` and a slug (A4 3.4.7). */
export const CUSTOM_TARGET_ID = /^custom:[a-z0-9][a-z0-9-]{0,39}$/u;

export const isBuiltInTarget = (value: string): value is BuiltInTargetId =>
  (BUILT_IN_TARGETS as readonly string[]).includes(value);

export const PERMISSIONS = ["inherit", "full-access", "auto-edit", "read-only"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type RouteKind = "terminal" | "link" | "t3-mcp" | "clipboard";

/**
 * What an instance can set beyond its app's own settings: its open permission, its extra
 * arguments, its environment, and a home of its own (another account). Each reaches the agent
 * only through a route that carries it.
 */
export const SETTINGS = ["permission", "arguments", "environment", "home"] as const;
export type Setting = (typeof SETTINGS)[number];

/** A template element: literal text and placeholders (A4 3.6.4). */
export type Template = string;

export interface RouteDef {
  readonly kind: RouteKind;
  readonly folder: "cwd" | "param" | "project-exact" | "none";
  readonly prompt: "sent" | "prefilled" | "clipboard";
  readonly nativeId: "preset" | "returned" | "bridge" | "reference-match" | "none";
  /** The app's hard limit in characters; null when there is none (A4 3.15.3). */
  readonly maxPrompt: number | null;
  /** TTasks's cap for the brief; for Copy, the brief with the person's words. */
  readonly budget: number;
  readonly trust: "once-per-root" | "every-launch" | "project" | "none" | "unknown";
  readonly needsGui: boolean;
  /** Also copy the brief, for apps that may drop a prefill. */
  readonly copyBriefToo: boolean;
  /**
   * What of an instance's settings the route gives its agent. A route that does not carry what an
   * instance sets is never taken for it: the agent would work with less than the person chose.
   */
  readonly carries: readonly Setting[];
  /**
   * Link routes of the best-effort apps (A4 3.4.4, 3.4.5): the bridge's binding confirms the launch
   * only when the bridge's working folder is the folder the link named. Otherwise a binding through
   * the launch reference confirms it (A4 3.9.2).
   */
  readonly confirmFolder?: boolean;
  /** Terminal routes: whole-element placeholders only for {exec}, {permission}, {extra_args}. */
  readonly argv?: readonly Template[];
  /** Link routes: each value percent-encoded once when the route runs. */
  readonly url?: string;
}

/** How detection finds a target's command and homes (A4 3.2). Data only: detect.ts reads it. */
export interface DetectRule {
  /** Command names looked up on the agent environment's PATH. */
  readonly binaries: readonly string[];
  /** An npm install: run as `node <entry>`, never through a `.cmd` shim or `env node` (A4 3.2). */
  readonly npm?: { readonly package: string; readonly entry: string };
  /** User wrapper scripts in `~/.local/bin`: names that start with this prefix (Linux, macOS). */
  readonly wrapperPrefix?: string;
  /**
   * Config homes in the user's home folder: the default folder, and `<default>-<suffix>`.
   * `account`: the prefixes of the variables that say which account or endpoint the app uses over
   * its home's sign-in. An instance with a home of its own does not inherit them (accountVariable).
   */
  readonly homes?: {
    readonly folder: string;
    readonly env: string;
    readonly account: readonly string[];
  };
  /** A folder in the home whose presence shows the app is installed (T3's `~/.t3`). */
  readonly appFolder?: string;
  /** A variable that names that folder instead when it holds an absolute path (`T3CODE_HOME`). */
  readonly appFolderEnv?: string;
  /** A per-user command folder of the app, relative to the home (T3's `.t3/bin`). */
  readonly appBin?: string;
  /** URL scheme of the app's handler. Detected by a later step (A4 3.4.4, 3.4.5). */
  readonly urlScheme?: string;
}

export interface TargetDef {
  readonly id: BuiltInTargetId;
  readonly label: string;
  /** Neutral monogram; no vendor logos. */
  readonly glyph: string;
  /** Primary first, then fallbacks. */
  readonly routes: readonly RouteDef[];
  readonly instances: "per-home" | "single" | "per-provider-instance";
  readonly detect: DetectRule;
  /** Semver range. Outside it doctor warns; launches still work. Empty: not checked. */
  readonly testedVersions: string;
  /**
   * T3 only: the model a proposed T3 instance opens with, per T3 driver, when T3's own default
   * selection does not name its provider instance (A4 3.2 `ttasks setup instances`). These are T3's
   * own defaults per driver at the T3 commit A4 names.
   */
  readonly t3Models?: Readonly<Record<string, string>>;
  readonly permissionArgs: Readonly<
    Record<Permission, { readonly open: readonly string[]; readonly run: readonly string[] | null }>
  >;
  readonly run?: "claude-print" | "codex";
}

/** No flags for any mode: targets whose permission TTasks cannot set. */
const NO_ARGS = {
  inherit: { open: [], run: null },
  "full-access": { open: [], run: null },
  "auto-edit": { open: [], run: null },
  "read-only": { open: [], run: null },
} as const;

const TERMINAL_BUDGET = 8_000;
/** Windows' command line limit, the lower of the two OSes' bounds (A4 3.15.3). */
const COMMAND_LINE_LIMIT = 32_767;

export const CATALOGUE: readonly TargetDef[] = [
  {
    id: "t3",
    label: "T3 Code",
    glyph: "T3",
    routes: [
      {
        kind: "t3-mcp",
        folder: "project-exact",
        prompt: "prefilled",
        nativeId: "returned",
        maxPrompt: 8_000,
        budget: 7_500,
        trust: "project",
        needsGui: true,
        copyBriefToo: false,
        // The permission as the thread's runtime mode (t3-route.ts).
        carries: ["permission"],
      },
    ],
    instances: "per-provider-instance",
    detect: {
      binaries: ["t3"],
      appFolder: ".t3",
      appFolderEnv: "T3CODE_HOME",
      appBin: ".t3/bin",
      urlScheme: "t3code",
    },
    testedVersions: ">=0.1.7 <0.2.0",
    t3Models: { codex: "gpt-6-astra", claudeAgent: "claude-opus-5-5" },
    // A4 3.11.6: T3 takes a runtime mode per thread, not flags. M2.09 maps the permission.
    permissionArgs: NO_ARGS,
  },
  {
    id: "claude-cli",
    label: "Claude Code",
    glyph: "Cc",
    routes: [
      {
        kind: "terminal",
        folder: "cwd",
        prompt: "sent",
        nativeId: "preset",
        maxPrompt: COMMAND_LINE_LIMIT,
        budget: TERMINAL_BUDGET,
        trust: "once-per-root",
        needsGui: true,
        copyBriefToo: false,
        carries: SETTINGS,
        argv: [
          "{exec}",
          "--session-id",
          "{session}",
          "-n",
          "{task.id} {task.title}",
          "{permission}",
          "{extra_args}",
          "--",
          "{brief}",
        ],
      },
      {
        kind: "link",
        folder: "param",
        prompt: "prefilled",
        nativeId: "bridge",
        maxPrompt: 5_000,
        budget: 1_000,
        trust: "once-per-root",
        needsGui: true,
        copyBriefToo: false,
        carries: [],
        url: "claude-cli://open?cwd={cwd}&q={brief}",
      },
      {
        // The assisted open, as Codex's: no prompt in argv, the brief on the clipboard to paste.
        // A prefill instance takes it when the link cannot carry what the instance sets.
        kind: "terminal",
        folder: "cwd",
        prompt: "clipboard",
        nativeId: "preset",
        maxPrompt: null,
        budget: TERMINAL_BUDGET,
        trust: "once-per-root",
        needsGui: true,
        copyBriefToo: true,
        carries: SETTINGS,
        argv: [
          "{exec}",
          "--session-id",
          "{session}",
          "-n",
          "{task.id} {task.title}",
          "{permission}",
          "{extra_args}",
        ],
      },
    ],
    instances: "per-home",
    detect: {
      binaries: ["claude"],
      npm: { package: "@anthropic-ai/claude-code", entry: "cli.js" },
      wrapperPrefix: "claude-",
      homes: {
        folder: ".claude",
        env: "CLAUDE_CONFIG_DIR",
        // Claude Code's documented authentication precedence puts each of these families above the
        // home's own sign-in: the provider switches (`CLAUDE_CODE_USE_BEDROCK` and the rest), the
        // OAuth token, and the `ANTHROPIC_` key, token, profile and federation selectors; its
        // environment variables add the endpoint and headers (`ANTHROPIC_BASE_URL`,
        // `ANTHROPIC_CUSTOM_HEADERS`) and the models of that account.
        account: ["ANTHROPIC_", "CLAUDE_CODE_USE_", "CLAUDE_CODE_OAUTH_"],
      },
      urlScheme: "claude-cli",
    },
    testedVersions: ">=2.1.0 <3.0.0",
    permissionArgs: {
      // A4 3.11.6: Claude runs with `inherit` are refused, like Codex's.
      inherit: { open: [], run: null },
      "full-access": {
        open: ["--permission-mode", "bypassPermissions"],
        run: ["--permission-mode", "bypassPermissions", "--permission-prompts", "none"],
      },
      "auto-edit": {
        open: ["--permission-mode", "acceptEdits"],
        run: ["--permission-mode", "acceptEdits", "--permission-prompts", "none"],
      },
      "read-only": {
        open: ["--permission-mode", "plan"],
        run: ["--permission-mode", "plan", "--permission-prompts", "none"],
      },
    },
    run: "claude-print",
  },
  {
    id: "codex-cli",
    label: "Codex",
    glyph: "Cx",
    routes: [
      {
        kind: "terminal",
        folder: "cwd",
        prompt: "sent",
        nativeId: "reference-match",
        maxPrompt: COMMAND_LINE_LIMIT,
        budget: TERMINAL_BUDGET,
        trust: "once-per-root",
        needsGui: true,
        copyBriefToo: false,
        carries: SETTINGS,
        argv: [
          "{exec}",
          "-C",
          "{cwd}",
          "--no-daemon",
          "{tool_env}",
          "{permission}",
          "{extra_args}",
          "--",
          "{brief}",
        ],
      },
      {
        // The assisted open (A4 3.4.3): no prompt in argv, the UI copies the brief.
        kind: "terminal",
        folder: "cwd",
        prompt: "clipboard",
        nativeId: "reference-match",
        maxPrompt: null,
        budget: TERMINAL_BUDGET,
        trust: "once-per-root",
        needsGui: true,
        copyBriefToo: true,
        carries: SETTINGS,
        argv: [
          "{exec}",
          "-C",
          "{cwd}",
          "--no-daemon",
          "{tool_env}",
          "{permission}",
          "{extra_args}",
        ],
      },
    ],
    instances: "per-home",
    detect: {
      binaries: ["codex"],
      npm: { package: "@openai/codex", entry: "bin/codex.js" },
      wrapperPrefix: "codex-",
      // Codex keeps its sign-in and its provider in the home (auth.json, config.toml) and reads a
      // variable for a provider's key only where that config names it: none is taken away.
      homes: { folder: ".codex", env: "CODEX_HOME", account: [] },
      urlScheme: "codex",
    },
    testedVersions: ">=0.166.0 <0.200.0",
    // A run speaks Codex's app server, whose thread takes the mode itself (the codex driver):
    // no run needs flags.
    permissionArgs: {
      inherit: { open: [], run: null },
      "full-access": { open: ["--dangerously-bypass-approvals-and-sandbox"], run: null },
      "auto-edit": { open: ["-s", "workspace-write", "-a", "on-request"], run: null },
      "read-only": { open: ["-s", "read-only", "-a", "on-request"], run: null },
    },
    run: "codex",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    glyph: "Cd",
    routes: [
      {
        kind: "link",
        folder: "param",
        prompt: "prefilled",
        nativeId: "none",
        maxPrompt: 14_000,
        budget: 2_000,
        trust: "every-launch",
        needsGui: true,
        copyBriefToo: true,
        confirmFolder: true,
        carries: [],
        url: "claude://code/new?folder={cwd}&q={brief}",
      },
    ],
    instances: "single",
    detect: { binaries: [], urlScheme: "claude" },
    testedVersions: "",
    permissionArgs: NO_ARGS,
  },
  {
    id: "codex-app",
    label: "Codex app",
    glyph: "Ca",
    routes: [
      {
        kind: "link",
        folder: "param",
        prompt: "prefilled",
        nativeId: "bridge",
        // Undocumented (A4 3.15.3): the budget is the bound until M0 measures one.
        maxPrompt: null,
        budget: 2_000,
        trust: "unknown",
        needsGui: true,
        copyBriefToo: true,
        confirmFolder: true,
        carries: [],
        url: "codex://threads/new?path={cwd}&prompt={brief}",
      },
    ],
    instances: "single",
    detect: { binaries: [], urlScheme: "codex" },
    testedVersions: "",
    permissionArgs: NO_ARGS,
  },
  {
    id: "clipboard",
    label: "Copy",
    glyph: "Cp",
    routes: [
      {
        kind: "clipboard",
        folder: "none",
        prompt: "clipboard",
        nativeId: "none",
        maxPrompt: null,
        budget: 20_000,
        trust: "none",
        needsGui: false,
        copyBriefToo: false,
        carries: [],
      },
    ],
    instances: "single",
    detect: { binaries: [] },
    testedVersions: "",
    permissionArgs: NO_ARGS,
  },
];

export function targetDef(id: BuiltInTargetId): TargetDef {
  const def = CATALOGUE.find((t) => t.id === id);
  if (def === undefined) throw new Error("unknown built-in target");
  return def;
}

/**
 * Whether `name` says which account or endpoint `target`'s app uses (its `account` prefixes), or
 * any target's when none is given (Windows names compared without case). The scrub of the
 * person's environment (A4 3.8) leaves these, so the default home keeps the person's setup whole.
 */
export function accountVariable(
  name: string,
  platform: NodeJS.Platform,
  target?: BuiltInTargetId,
): boolean {
  const key = platform === "win32" ? name.toUpperCase() : name;
  const defs = target === undefined ? CATALOGUE : [targetDef(target)];
  return defs.some((def) => def.detect.homes?.account.some((p) => key.startsWith(p)) === true);
}

/**
 * The variables that select an agent's config home (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`). A home is
 * the instance's choice and nothing else's: the launch removes these from the inherited agent
 * environment (A4 3.8's scrub) before the instance's `env` applies, so an instance without one
 * runs its target's default home whatever the person's shell exports. Pinning the default home
 * instead would not be the same for Claude Code, whose `.claude.json` moves into a named folder.
 */
export const HOME_VARIABLES: readonly string[] = [
  ...new Set(
    CATALOGUE.flatMap((def) => (def.detect.homes === undefined ? [] : [def.detect.homes.env])),
  ),
].sort();

// ---------------------------------------------------------------------------------------------
// Placeholders (A4 3.6.4)

/**
 * Placeholders that stand for whole argv elements (zero or more of them). `{tool_env}` is Codex's
 * declaration that TTasks's MCP entry takes the ticket from the environment (A4 3.4.3), given only
 * when the home's own entry lacks it.
 */
export const WHOLE_ELEMENT_PLACEHOLDERS = ["exec", "permission", "extra_args", "tool_env"] as const;

/**
 * Every placeholder of an argv or URL template, and where it may appear. The task's title is the
 * one piece of task text offered, and on a command line only: the agent app's session history
 * holds it anyway. Nothing stands for the person's words.
 */
export const PLACEHOLDERS: Readonly<Record<string, { argv: boolean; url: boolean }>> = {
  exec: { argv: true, url: false },
  permission: { argv: true, url: false },
  extra_args: { argv: true, url: false },
  tool_env: { argv: true, url: false },
  cwd: { argv: true, url: true },
  brief: { argv: true, url: true },
  session: { argv: true, url: true },
  "task.id": { argv: true, url: true },
  "task.title": { argv: true, url: false },
  "launch.ref": { argv: true, url: true },
};

/** The placeholders of a terminal's own command line (A4 3.6.1): `{shim}` is three elements. */
export const TERMINAL_PLACEHOLDERS = ["terminal", "cwd", "title", "shim"] as const;

/** The names in `{…}` within `text`, in order. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{([^{}]*)\}/gu)].map((m) => m[1] ?? "");
}

export type TemplateProblem = "unknown_placeholder" | "split_element" | "brief_before_separator";

/**
 * Checks an argv template against A4 3.6.4: known placeholders only, whole-element placeholders
 * alone in their element, and `{brief}` only after `--`. Returns the problems found, empty when
 * the template is good.
 */
export function checkArgvTemplate(argv: readonly Template[]): TemplateProblem[] {
  const problems = new Set<TemplateProblem>();
  const separator = argv.indexOf("--");
  for (const [i, element] of argv.entries()) {
    const names = placeholdersIn(element);
    for (const name of names) {
      if (PLACEHOLDERS[name]?.argv !== true) problems.add("unknown_placeholder");
      if ((WHOLE_ELEMENT_PLACEHOLDERS as readonly string[]).includes(name)) {
        if (element !== `{${name}}`) problems.add("split_element");
      }
      if (name === "brief" && (separator === -1 || i < separator)) {
        problems.add("brief_before_separator");
      }
    }
  }
  return [...problems];
}

/** Checks a URL template: known placeholders that are allowed in URLs. */
export function checkUrlTemplate(url: string): TemplateProblem[] {
  return placeholdersIn(url).some((name) => PLACEHOLDERS[name]?.url !== true)
    ? ["unknown_placeholder"]
    : [];
}

// ---------------------------------------------------------------------------------------------
// Tested versions: a range of `>=a.b.c` and `<a.b.c` bounds, all of which must hold

const VERSION = /(\d+)\.(\d+)\.(\d+)/u;

/** The first `a.b.c` in `text`, or undefined. */
export function versionIn(text: string): string | undefined {
  const m = VERSION.exec(text);
  return m === null ? undefined : `${m[1] ?? ""}.${m[2] ?? ""}.${m[3] ?? ""}`;
}

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether `version` lies in `range` (space-separated `>=x.y.z`, `>x.y.z`, `<x.y.z`, `<=x.y.z`).
 * Undefined when the range is empty (not checked) or a bound cannot be read.
 */
export function inTestedRange(version: string, range: string): boolean | undefined {
  if (range.trim() === "") return undefined;
  for (const bound of range.trim().split(/\s+/u)) {
    const m = /^(>=|>|<=|<)(\d+\.\d+\.\d+)$/u.exec(bound);
    if (m === null) return undefined;
    const c = compare(version, m[2] ?? "");
    const ok = { ">=": c >= 0, ">": c > 0, "<=": c <= 0, "<": c < 0 }[
      m[1] as ">=" | ">" | "<=" | "<"
    ];
    if (!ok) return false;
  }
  return true;
}
