// The sections of machine.toml that A4 owns, alone or with A1 (A2 3.2.4): `[roots]`, `[terminal]`,
// `[[instance]]` and `[approvals]`. Each is checked strictly into a typed value plus problems
// (problems.ts). A bad entry is dropped, never guessed: an instance with a bad key is not offered,
// a root with a bad path resolves nothing, an approval that is not `allow` approves nothing.
//
// `[[custom_target]]` and `[override.*]` (A4 3.2, 3.4.7) belong to the launch steps; until they
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
// [roots] (A1 3.15)

/** A root ID: lower case, at most 32 characters, never changed (A1 3.15). */
export const ROOT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

export interface Root {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  /** A4 3.11.7: background runs allowed under this root. */
  readonly runs: boolean;
}

export function readRoots(value: unknown, platform: NodeJS.Platform, problems: Problems): Root[] {
  if (value === undefined) return [];
  if (!isTable(value)) {
    problems.error("roots", "wrong_type");
    return [];
  }
  const roots: Root[] = [];
  for (const [id, entry] of Object.entries(value)) {
    const key = keyPath("roots", id);
    if (!ROOT_ID.test(id)) {
      problems.error(key, "invalid_value");
      continue;
    }
    if (!isTable(entry)) {
      problems.error(key, "wrong_type");
      continue;
    }
    const r = new TableReader(entry, key, problems);
    const label = r.string("label", { max: 80 }) ?? id;
    const path = r.path("path", platform, { required: true });
    const runs = r.bool("runs", false);
    r.done();
    if (r.failed || path === undefined) continue;
    roots.push({ id, label, path, runs });
  }
  return roots;
}

// ---------------------------------------------------------------------------------------------
// [terminal] (A4 3.6.1)

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
      // Every terminal runs the shim and nothing else (A4 3.6.2).
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
// [[instance]] (A4 3.2)

/** An instance ID: a stable slug that space data refers to. */
export const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/**
 * The instance an MCP entry without a usable `--instance` acts as (A3 3.7.4: a hand-made entry,
 * `agent:manual`, in the machine's default space). No configured instance may take the word: its
 * actor, writer scope, sessions and grant rows would be the hand-made entry's.
 */
export const MANUAL_INSTANCE = "manual";
/** An environment variable name an instance may add. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

export interface Instance {
  readonly id: string;
  readonly target: TargetId;
  readonly label: string;
  /** A free label, checked against spaces and areas (A4 3.2 "Account check"). */
  readonly account: string;
  /** Spaces it may open, by ID or name; empty means all. */
  readonly spaces: readonly string[];
  /** The executable: a user wrapper, the native binary, or Node for an npm CLI. */
  readonly exec: string | undefined;
  /** Arguments before Tasks's: the npm entry when `exec` is Node (A4 3.6.4 `{exec}`). */
  readonly argsPrefix: readonly string[];
  /** For display, trust and session lookup. A wrapper sets the home itself. */
  readonly configHome: string | undefined;
  /** Per-child additions to the agent's environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly openPermission: Permission;
  readonly runPermission: Permission;
  readonly extraArgs: readonly string[];
  /**
   * A4 L7: `sent` opens with the brief sent ("Read the task, then wait for my instructions");
   * `prefill` uses the target's prefill route instead (Claude Code's link, Codex's assisted open),
   * so the person sends the first message. Default `sent`.
   */
  readonly prompt: "sent" | "prefill";
  readonly viaLoginShell: boolean;
  /** Reserved for L1 (A6): may a command from another machine use this instance. v1 stores it. */
  readonly remoteAllowed: boolean;
  /** False keeps a written instance out of every launch without deleting it. */
  readonly enabled: boolean;
  /** T3 only (A4 3.4.1). */
  readonly t3?: {
    readonly environment: string;
    readonly providerInstance: string | undefined;
    readonly model: string;
  };
}

const T3_KEYS = ["t3_environment", "t3_provider_instance", "t3_model"] as const;

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
 * every part of Tasks that reads the agent's home (instanceHome: setup, the link's default home,
 * Codex's `env_vars` check and reference match) agree on it:
 * - on Windows no two names that differ only in case: the agent's environment holds each name
 *   once, folded (shim/environment.ts), so which value it got would depend on their order;
 * - a home variable (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`) names an absolute folder: a relative or
 *   empty one would resolve against the task's folder in the agent and elsewhere in Tasks.
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
  const label = r.string("label", { required: true, nonEmpty: true, max: 40 });
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
  const prompt = r.oneOf("prompt", ["sent", "prefill"], "sent");
  const viaLoginShell = r.bool("via_login_shell", false);
  const remoteAllowed = r.bool("remote_allowed", false);
  const enabled = r.bool("enabled", true);

  let t3: Instance["t3"];
  if (target === "t3") {
    const environment = r.string("t3_environment", { nonEmpty: true, max: 64 }) ?? "local";
    // Remote T3 environments are not targets in v1 (A4 3.2).
    if (environment !== "local") r.error("t3_environment", "invalid_value");
    const providerInstance = r.string("t3_provider_instance", { nonEmpty: true, max: 64 });
    const model = r.string("t3_model", { max: 128 }) ?? "";
    t3 = { environment, providerInstance, model };
  } else {
    for (const name of T3_KEYS) {
      if (r.has(name)) {
        r.raw(name);
        r.error(name, "not_for_target");
      }
    }
  }
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
    prompt,
    viaLoginShell,
    remoteAllowed,
    enabled,
    ...(t3 === undefined ? {} : { t3 }),
  };
}

// ---------------------------------------------------------------------------------------------
// [approvals] (A4 3.2): `<hash> = "allow" | "deny"`

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
