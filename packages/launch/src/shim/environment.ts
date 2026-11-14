// The agent's environment (A4 3.8), computed by the service when the shim claims
// and applied by the shim as it is. Built, never passed through:
//
// 1. Base, of one of two kinds (environment/ builds it):
//    - `user`: the person's own environment as their login shell gives it (Linux: the session
//      layer over the login-shell snapshot) or as Windows keeps it (the registry layers). Taken
//      whole: what a profile exports (nvm's PATH, a tool's home) is what the agent needs.
//    - `service`: the service's own environment, when no user base could be read. Only the names
//      of an allow-list are picked from it, so the service's other variables never reach the agent.
// 2. The home variables (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`) are removed (A4 3.8), so only an
//    instance's own `env` selects a home.
// 3. The instance's `env` applies.
// 4. A4 3.8's scrub, after merging (SCRUB_NAMES, SCRUB_PREFIXES, every `TASKS_*` among them), then
//    A4's additions: `TASKS_TICKET` for the bridge's role, `TASKS_TASK` and `TASKS_SPACE` as hints.
// 5. Linux and macOS: PATH gets the executable's own folder in front (nvm keeps `node` beside it).
//
// Windows names are case-insensitive: a later layer replaces an earlier name whatever its case, and
// the result holds each name once. libuv adds a few names to a Windows child's environment from
// the parent when they are missing (LIBUV_REQUIRED: `make_program_env` in libuv's
// win/process.c), so every one of them is on the Windows list, and one the base does not have is
// set empty (6.): the agent gets the base's value or none, never the shim's.
import { posix } from "node:path";
import { ENV_PREFIX, envVar } from "@tasks/brand";
import { HOME_VARIABLES } from "../catalogue.ts";
import { AGENT_ENV_NAME, isBoundedText, REPLY_BOUNDS } from "./wire.ts";

/** The base's share of the names: half, less room for libuv's names and A4's additions. */
const BASE_MAX = REPLY_BOUNDS.env / 2 - 64;

/**
 * A4 3.8's scrub, by exact name: a leftover `CLAUDECODE=1` makes Claude Code refuse a nested
 * session, a leftover session ID would bind to the wrong session, and the last two change how any
 * Node program starts.
 */
export const SCRUB_NAMES = [
  "CLAUDECODE",
  "CLAUDE_PROJECT_DIR",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
] as const;

/** A4 3.8's scrub, by prefix: agent sessions' own variables and every one of the product's. */
export const SCRUB_PREFIXES = ["CLAUDE_CODE_", "CODEX_SANDBOX", "T3CODE_", ENV_PREFIX] as const;

/** Whether A4 3.8's scrub removes `name` (Windows names compared without case). */
export function scrubbed(name: string, platform: NodeJS.Platform): boolean {
  const key = platform === "win32" ? name.toUpperCase() : name;
  return (
    (SCRUB_NAMES as readonly string[]).includes(key) ||
    SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** The names libuv copies into a Windows child from its parent when the child's are missing. */
export const LIBUV_REQUIRED = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
] as const;

/** Names every OS keeps. */
const COMMON = ["PATH", "LANG", "LANGUAGE", "TZ", "NO_COLOR"] as const;

/** Linux and macOS: the account, the locale, the desktop session, the SSH agent and proxies. */
const POSIX = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "EDITOR",
  "VISUAL",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
] as const;

/** Linux and macOS prefixes: the locale's categories and the XDG session variables. */
const POSIX_PREFIXES = ["LC_", "XDG_"] as const;

/**
 * Windows: what a program started from the desktop has. The user's profile folders are named by
 * these variables; Tasks stores nothing in them (A2 3.2.2 rule 4 is about Tasks's own files).
 */
const WIN32 = [
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "LOGONSERVER",
  "COMPUTERNAME",
  // eslint-disable-next-line no-restricted-syntax -- a variable the agent's tools read, not a path Tasks writes
  "APPDATA",
  // eslint-disable-next-line no-restricted-syntax -- a variable the agent's tools read, not a path Tasks writes
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PSModulePath",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

/** The names a base may give the agent on `platform`, and the prefixes. */
export function allowedNames(platform: NodeJS.Platform): {
  names: readonly string[];
  prefixes: readonly string[];
} {
  return platform === "win32"
    ? { names: [...COMMON, ...WIN32], prefixes: [] }
    : { names: [...COMMON, ...POSIX], prefixes: POSIX_PREFIXES };
}

/** The names A4 3.8 adds: the ticket for the bridge's role, the task and the space as hints. */
export const ADDED = {
  ticket: envVar("TICKET"),
  task: envVar("TASK"),
  space: envVar("SPACE"),
} as const;

/**
 * Where the agent's environment starts (layer 1 above): the person's own environment, taken whole
 * and scrubbed, or the service's, through the allow-list.
 */
export type BaseKind = "user" | "service";

/** A base environment and its kind, as environment/ builds it at the claim. */
export interface AgentBase {
  readonly kind: BaseKind;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface EnvironmentInput {
  readonly platform: NodeJS.Platform;
  /** Where the agent's environment starts. */
  readonly base: Readonly<Record<string, string | undefined>>;
  /** `user` takes the base whole, `service` (the default) through the allow-list. */
  readonly baseKind?: BaseKind;
  /** The instance's `env` (machine.toml `[[instance]]`). */
  readonly instance: Readonly<Record<string, string>>;
  /** A4's additions, by the names of ADDED. */
  readonly additions: Readonly<Record<string, string>>;
  /** The agent's absolute executable: its folder goes in front of PATH (Linux and macOS). */
  readonly executable?: string;
}

/** The agent's environment, layer by layer as the head of this file says. */
export function agentEnvironment(input: EnvironmentInput): Record<string, string> {
  const fold = input.platform === "win32";
  const key = (name: string): string => (fold ? name.toUpperCase() : name);
  const out = new Map<string, [name: string, value: string]>();
  const set = (name: string, value: string): void => {
    out.set(key(name), [name, value]);
  };
  const drop = (test: (name: string) => boolean): void => {
    for (const [k, [name]] of out) if (test(name)) out.delete(k);
  };
  // 1. The base: whole for the person's own, through the allow-list for the service's; within the
  // bounds the shim reads the reply with (wire.ts): a name of AGENT_ENV_NAME's form, a value within
  // its bound, and at most half the names, the other half being the instance's (records.ts) with
  // A4's additions.
  const { names, prefixes } = allowedNames(input.platform);
  const allowed = new Set(names.map(key));
  const whole = input.baseKind === "user";
  for (const [name, value] of Object.entries(input.base)) {
    if (value === undefined || !isBoundedText(value, REPLY_BOUNDS.value)) continue;
    if (!AGENT_ENV_NAME.test(name) || out.size >= BASE_MAX) continue;
    const listed = whole || allowed.has(key(name)) || prefixes.some((p) => name.startsWith(p));
    if (listed) set(name, value);
  }
  // 2. The home variables, whatever the list says (A4 3.8).
  const homes = new Set(HOME_VARIABLES.map(key));
  drop((name) => homes.has(key(name)));
  // 3. The instance's own.
  for (const [name, value] of Object.entries(input.instance)) {
    if (!value.includes("\0") && isEnvName(name)) set(name, value);
  }
  // 4. A4 3.8's scrub after merging, every TASKS_* with it, then A4's additions.
  drop((name) => scrubbed(name, input.platform));
  for (const [name, value] of Object.entries(input.additions)) {
    if (value !== "" && !value.includes("\0")) set(name, value);
  }
  // 5. Linux and macOS: the executable's own folder in front of PATH.
  const exe = input.executable;
  if (!fold && exe !== undefined && posix.isAbsolute(exe)) {
    const folder = posix.dirname(exe);
    const path = out.get("PATH")?.[1];
    const entries = path === undefined || path === "" ? [] : path.split(":");
    const joined = [folder, ...entries].join(":");
    // Within the bound the shim reads a value with: past it the reply would not be followed.
    if (entries[0] !== folder && joined.length <= REPLY_BOUNDS.value) set("PATH", joined);
  }
  // 6. Windows: a name libuv would fill from the shim is named, empty when no layer gave it.
  if (fold) for (const name of LIBUV_REQUIRED) if (!out.has(key(name))) set(name, "");
  return Object.fromEntries([...out.values()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * A name an environment can carry to a child: no `=` (it would end the name) and no NUL. Windows'
 * per-drive names (`=C:`) are the shell's own and never part of an agent's environment.
 */
const isEnvName = (name: string): boolean =>
  name !== "" && !name.includes("=") && !name.includes("\0");

/**
 * The environment a terminal starts with (A4 3.6.2): the service's own, scrubbed as an agent's
 * would be (no agent session's variables reach the shim's window), with the session layer on top
 * where there is one (a linger-started service lacks DISPLAY and the bus, and a terminal needs
 * them to open a window), and of the product's own variables only the install's home, by which
 * the shim finds this install's service (A2 3.6.1). The shim passes none of it to the agent but
 * the terminal's own TERM and the like (wire.ts TERMINAL_ENV).
 */
export function terminalEnvironment(
  service: Readonly<Record<string, string | undefined>>,
  session: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const home = envVar("HOME");
  const fold = platform === "win32";
  const key = (name: string): string => (fold ? name.toUpperCase() : name);
  const out = new Map<string, [string, string]>();
  for (const [name, value] of Object.entries(service)) {
    if (value === undefined || value.includes("\0") || !isEnvName(name)) continue;
    if (key(name) !== home && scrubbed(name, platform)) continue;
    out.set(key(name), [name, value]);
  }
  for (const [name, value] of Object.entries(session)) {
    if (isEnvName(name) && !value.includes("\0")) out.set(key(name), [name, value]);
  }
  return Object.fromEntries([...out.values()]);
}
