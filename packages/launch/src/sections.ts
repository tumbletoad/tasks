// The sections of machine.toml that the launch owns: `[terminal]`, `[[instance]]` and
// `[approvals]`. Each is checked strictly into a typed value plus problems (problems.ts). A bad
// entry is dropped, never guessed: an instance with a bad key is not offered, an approval that is
// not `allow` approves nothing.
//
// `[[custom_target]]` and `[override.*]` belong to the launch steps; until they
// read them, this build passes them by without checking (sections RESERVED in the service).
import {
  CUSTOM_TARGET_ID,
  HOME_VARIABLES,
  isBuiltInTarget,
  PERMISSIONS,
  placeholdersIn,
  targetDef,
  TERMINAL_PLACEHOLDERS,
  type Permission,
  type TargetId,
} from "./catalogue.ts";
import {
  entryKey,
  isAbsoluteFor,
  isTable,
  keyPath,
  Problems,
  TableReader,
  type Plain,
} from "./problems.ts";

// ---------------------------------------------------------------------------------------------
// [terminal]

export const TERMINAL_APPS = [
  "auto",
  "wt",
  "console",
  "ghostty",
  "gnome-terminal",
  "kitty",
  "wezterm",
  "konsole",
  "x-terminal-emulator",
  "custom",
] as const;
export type TerminalApp = (typeof TERMINAL_APPS)[number];

export const AFTER_EXIT = ["close", "close-on-success", "pause", "shell"] as const;

export interface TerminalSettings {
  readonly app: TerminalApp;
  /** Resolved by detection when absent. */
  readonly path: string | undefined;
  readonly window: "new" | "tabs";
  readonly fallbacks: readonly TerminalApp[];
  readonly afterExit: (typeof AFTER_EXIT)[number];
  /** `app = "custom"`: the argv, `{terminal}`, `{cwd}`, `{title}` and `{shim}` only. */
  readonly custom: readonly string[] | undefined;
}

export const DEFAULT_TERMINAL: TerminalSettings = {
  app: "auto",
  path: undefined,
  window: "new",
  fallbacks: [],
  afterExit: "close-on-success",
  custom: undefined,
};

/**
 * `[terminal]`. A bad key falls back to its default with a problem: a launch with the default
 * terminal is better than none, and doctor names the key.
 */
export function readTerminal(
  value: unknown,
  platform: NodeJS.Platform,
  problems: Problems,
): TerminalSettings {
  if (value === undefined) return DEFAULT_TERMINAL;
  if (!isTable(value)) {
    problems.error("terminal", "wrong_type");
    return DEFAULT_TERMINAL;
  }
  const r = new TableReader(value, "terminal", problems);
  const app = r.oneOf("app", TERMINAL_APPS, "auto");
  const path = r.path("path", platform, { emptyIsAbsent: true });
  const window = r.oneOf("window", ["new", "tabs"], "new");
  const fallbacks = r.strings("fallbacks") ?? [];
  const known = fallbacks.filter((f): f is TerminalApp =>
    (TERMINAL_APPS as readonly string[]).includes(f),
  );
  if (known.length !== fallbacks.length || known.includes("custom") || known.includes("auto")) {
    r.error("fallbacks", "invalid_value");
  }
  const afterExit = r.oneOf("after_exit", AFTER_EXIT, "close-on-success");
  let custom = r.strings("custom");
  if (custom !== undefined) {
    const allowed = TERMINAL_PLACEHOLDERS as readonly string[];
    if (custom.some((el) => placeholdersIn(el).some((name) => !allowed.includes(name)))) {
      r.error("custom", "unknown_placeholder");
      custom = undefined;
    } else if (!custom.includes("{shim}")) {
      // Every terminal runs the shim and nothing else.
      r.error("custom", "invalid_value");
      custom = undefined;
    }
  }
  if (app === "custom" && custom === undefined && !r.failed) r.error("custom", "missing");
  r.done();
  return {
    app: app === "custom" && custom === undefined ? "auto" : app,
    path,
    window,
    fallbacks: known.filter((f) => f !== "custom" && f !== "auto"),
    afterExit,
    custom,
  };
}

// ---------------------------------------------------------------------------------------------
// [[instance]]

/** An instance ID: a stable slug that space data refers to. */
export const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/**
 * The instance an MCP entry without a usable `--instance` acts as (a hand-made entry,
 * `agent:manual`, in the machine's default space). No configured instance may take the word: its
 * actor, writer scope, sessions and grant rows would be the hand-made entry's.
 */
export const MANUAL_INSTANCE = "manual";

/** The most characters an instance's label holds. */
export const LABEL_MAX = 40;

/**
 * An instance's label within LABEL_MAX: `head`, or `head · tail`. What is too long is shortened in
 * its middle, so its start and its end stay (two homes whose names differ at their ends keep
 * labels apart), and the tail keeps room beside a long head. Never cut inside a surrogate pair.
 * The same head and tail give the same label wherever it is made.
 */
export function instanceLabel(head: string, tail = ""): string {
  const name = head.trim();
  const rest = tail.trim();
  if (rest === "") return shorten(name, LABEL_MAX);
  const room = LABEL_MAX - " · ".length;
  if (name.length + rest.length <= room) return `${name} · ${rest}`;
  // Each part keeps at least half the room, and a short one gives the other what it leaves.
  const half = Math.floor(room / 2);
  const headRoom = Math.max(half, room - rest.length);
  const short = shorten(name, Math.min(name.length, headRoom));
  return `${short} · ${shorten(rest, room - short.length)}`;
}

/** The app an instance belongs to, by name: its target's, or a custom target's own label. */
export const appName = (instance: { readonly target: TargetId; readonly label: string }): string =>
  isBuiltInTarget(instance.target) ? targetDef(instance.target).label : instance.label.trim();

/**
 * The name a person reads for each instance of a list, wherever it is shown: the app's name, and
 * the instance's own name after it only when the list holds more than one of that app ("Codex",
 * "Claude Code · work"). The own name is the label without the app's name and without a folder's
 * name, else the account the person gave it at setup.
 */
export function instanceNames(
  list: readonly { readonly app: string; readonly label: string; readonly account?: string }[],
): string[] {
  return list.map(({ app, label, account }) => {
    if (list.filter((other) => other.app === app).length < 2) return instanceLabel(app);
    const own = label
      .split("·")
      .map((part) => part.trim())
      .filter((part) => part !== "" && part.toLowerCase() !== app.toLowerCase())
      .filter((part) => !part.startsWith("."))
      .join(" · ");
    return instanceLabel(app, own !== "" ? own : (account ?? ""));
  });
}

/** `text` within `max` UTF-16 units: its start and end around `…`, no surrogate pair split. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  let start = text.slice(0, Math.ceil(keep / 2));
  let end = text.slice(text.length - Math.floor(keep / 2));
  start = start.replace(/[\uD800-\uDBFF]$/u, "");
  end = end.replace(/^[\uDC00-\uDFFF]/u, "");
  return `${start.trimEnd()}…${end.trimStart()}`;
}

/** An environment variable name an instance may add. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

export interface Instance {
  readonly id: string;
  readonly target: TargetId;
  readonly label: string;
  /** A free label, checked against spaces and areas. */
  readonly account: string;
  /** Spaces it may open, by ID or name; empty means all. */
  readonly spaces: readonly string[];
  /** The executable: a user wrapper, the native binary, or Node for an npm CLI. */
  readonly exec: string | undefined;
  /** Arguments before TTasks's: the npm entry when `exec` is Node (`{exec}`). */
  readonly argsPrefix: readonly string[];
  /** For display, trust and session lookup. A wrapper sets the home itself. */
  readonly configHome: string | undefined;
  /** Per-child additions to the agent's environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly openPermission: Permission;
  readonly runPermission: Permission;
  readonly extraArgs: readonly string[];
  readonly viaLoginShell: boolean;
  /** Reserved for L1: may a command from another machine use this instance. v1 stores it. */
  readonly remoteAllowed: boolean;
  /** False keeps a written instance out of every launch without deleting it. */
  readonly enabled: boolean;
}

/** Whether an instance is for `space`: its `spaces` name none, or name it by ID or by name. */
export function servesSpace(
  instance: Pick<Instance, "spaces">,
  space: { readonly id: string; readonly name?: string | undefined },
): boolean {
  if (instance.spaces.length === 0) return true;
  const name = space.name?.toLowerCase();
  return instance.spaces.some((s) => s === space.id || s.toLowerCase() === name);
}

/**
 * `[[instance]]`. An entry with any error is dropped (the rest stay), so a half-understood
 * instance is never launched. A second instance with an ID already taken, or of a single-instance
 * target, is dropped as well.
 */
export function readInstances(
  value: unknown,
  platform: NodeJS.Platform,
  problems: Problems,
): Instance[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.error("instance", "wrong_type");
    return [];
  }
  const instances: Instance[] = [];
  for (const [i, entry] of (value as unknown[]).entries()) {
    const key = entryKey("instance", i);
    if (!isTable(entry)) {
      problems.error(key, "wrong_type");
      continue;
    }
    const instance = readInstance(entry, key, platform, problems);
    if (instance === undefined) continue;
    if (instances.some((other) => other.id === instance.id)) {
      problems.error(keyPath(key, "id"), "duplicate");
      continue;
    }
    if (
      isBuiltInTarget(instance.target) &&
      targetDef(instance.target).instances === "single" &&
      instances.some((other) => other.target === instance.target)
    ) {
      problems.error(keyPath(key, "target"), "single_instance");
      continue;
    }
    instances.push(instance);
  }
  return instances;
}

/**
 * What an instance's `env` may hold beyond its names' form, so that the agent's environment and
 * every part of TTasks that reads the agent's home (instanceHome: setup, the link's default home,
 * Codex's `env_vars` check and reference match) agree on it:
 * - on Windows no two names that differ only in case: the agent's environment holds each name
 *   once, folded (shim/environment.ts), so which value it got would depend on their order;
 * - a home variable (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`) names an absolute folder: a relative or
 *   empty one would resolve against the task's folder in the agent and elsewhere in TTasks.
 */
function checkInstanceEnv(
  r: TableReader,
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): void {
  const fold = (name: string): string => (platform === "win32" ? name.toUpperCase() : name);
  const homes = new Set(HOME_VARIABLES.map(fold));
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (seen.has(fold(name))) r.error(`env.${name}`, "duplicate");
    seen.add(fold(name));
    if (homes.has(fold(name)) && !isAbsoluteFor(platform, value)) {
      r.error(`env.${name}`, "not_absolute");
    }
  }
}

function readInstance(
  table: Plain,
  key: string,
  platform: NodeJS.Platform,
  problems: Problems,
): Instance | undefined {
  const r = new TableReader(table, key, problems);
  const id = r.string("id", { required: true, pattern: INSTANCE_ID });
  if (id === MANUAL_INSTANCE) r.error("id", "invalid_value");
  const targetText = r.string("target", { required: true });
  let target: TargetId | undefined;
  if (targetText !== undefined) {
    if (isBuiltInTarget(targetText) || CUSTOM_TARGET_ID.test(targetText)) {
      target = targetText as TargetId;
    } else r.error("target", "unknown_target");
  }
  const label = r.string("label", { required: true, nonEmpty: true, max: LABEL_MAX });
  const account = r.string("account", { max: 40 }) ?? "";
  const spaces = r.strings("spaces", { nonEmpty: true, max: 200 }) ?? [];
  const exec = r.path("exec", platform);
  const argsPrefix = r.strings("args_prefix") ?? [];
  const configHome = r.path("config_home", platform);
  const env = r.stringTable("env", ENV_NAME) ?? {};
  checkInstanceEnv(r, env, platform);
  const openPermission = r.oneOf("open_permission", PERMISSIONS, "inherit");
  const runPermission = r.oneOf("run_permission", PERMISSIONS, "inherit");
  const extraArgs = r.strings("extra_args") ?? [];
  const viaLoginShell = r.bool("via_login_shell", false);
  const remoteAllowed = r.bool("remote_allowed", false);
  const enabled = r.bool("enabled", true);
  if (platform === "win32" && viaLoginShell) r.error("via_login_shell", "not_for_target");
  r.done();
  if (r.failed || id === undefined || target === undefined || label === undefined) {
    return undefined;
  }
  return {
    id,
    target,
    label,
    account,
    spaces,
    exec,
    argsPrefix,
    configHome,
    env,
    openPermission,
    runPermission,
    extraArgs,
    viaLoginShell,
    remoteAllowed,
    enabled,
  };
}

// ---------------------------------------------------------------------------------------------
// [approvals]: `<hash> = "allow" | "deny"`

export type Verdict = "allow" | "deny";

/** An approval key: `sha256-` and the 64 lowercase hex digits of approval.ts's hash. */
export const APPROVAL_KEY = /^sha256-[0-9a-f]{64}$/u;

/**
 * `[approvals]`. A key or value that is not exactly right is dropped with a problem: it approves
 * nothing, so the definition it meant stays disabled.
 */
export function readApprovals(value: unknown, problems: Problems): ReadonlyMap<string, Verdict> {
  const approvals = new Map<string, Verdict>();
  if (value === undefined) return approvals;
  if (!isTable(value)) {
    problems.error("approvals", "wrong_type");
    return approvals;
  }
  for (const [k, v] of Object.entries(value)) {
    const key = keyPath("approvals", k);
    if (!APPROVAL_KEY.test(k)) {
      problems.error(key, "invalid_value");
      continue;
    }
    if (typeof v !== "string") {
      problems.error(key, "wrong_type");
      continue;
    }
    if (v !== "allow" && v !== "deny") {
      problems.error(key, "invalid_value");
      continue;
    }
    approvals.set(k, v);
  }
  return approvals;
}
