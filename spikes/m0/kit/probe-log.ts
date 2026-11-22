// What the probe (probe.ts) may write, as closed, structured data (review round 2, finding B).
// The probe never writes a free-form string it was handed: every value is either from a closed
// list, matched by a strict pattern, a boolean or number, or a SHA-256 prefix with a length.
// - Environment: every variable's NAME, and VALUES only for the exact allow-list below.
// - Paths (cwd and the home and profile variables): never the path. Whether it is inside the lab's
//   scratch tree, its place in that tree when it is one of the tree's own folders, and the SHA-256
//   of the canonical absolute path, which the lab compares with the folders it knows.
// - Client name, client version, protocol version, method and tool names: known labels only.
// - Package identity: a strict character class and a length cap.
// A last line of defence, `createRedactor`, replaces any environment value outside the allow-list
// wherever it would still appear. With the structured records it should never fire.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { asObject, sha256Hex, type Json, type JsonObject } from "./wire.ts";

/**
 * Identifier variables whose values are logged, each through `identifier` below. A name the lab
 * meets that a row needs shows up in `env_names` and is added here by hand, never by pattern.
 */
export const VALUE_NAMES: ReadonlyMap<string, string> = new Map([
  ["TTASKS_TASK", "A01-A05: A3's binding input (task)"],
  ["TTASKS_SPACE", "A01-A05: A3's binding input (space)"],
  ["CLAUDE_CODE_SESSION_ID", "A01, A03, A04: Claude's session identifier, for the binding"],
  ["CODEX_THREAD_ID", "A02, A05: Codex's thread identifier, for the binding"],
  ["T3CODE_THREAD_ID", "A03: T3 Code's thread identifier, for the binding"],
  ["CLAUDECODE", "A01, A04: set when Claude Code started the probe"],
  ["CLAUDE_CODE_ENTRYPOINT", "A01, A04: which Claude surface (CLI, desktop, SDK)"],
  ["CLAUDE_CODE_MCP_ALLOWLIST_ENV", "A04: whether Claude passes the environment by allow-list"],
  ["CODEX_SANDBOX", "A05: Codex's sandbox marker (an agent marker, A2 3.6.5)"],
]);

/** Path variables: logged as path facts (`pathFacts`), never as their value. */
export const PATH_NAMES: ReadonlyMap<string, string> = new Map([
  ["CLAUDE_CONFIG_DIR", "A01, A04: which scratch home Claude uses"],
  ["CODEX_HOME", "A02, A05: which scratch home Codex uses"],
  ["APPDATA", "S05 P-1, P-2: redirected under a package folder or not"],
  ["LOCALAPPDATA", "S05 P-1, P-2: redirected under a package folder or not"],
  ["USERPROFILE", "S05 P-2, P-3: the real profile or a redirected one"],
  ["TEMP", "S05 P-2: redirected or not"],
  ["TMP", "S05 P-2: redirected or not"],
]);

/** Package identity variables (S05): logged through `packageName`, a strict class and cap. */
export const PACKAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ["TTASKS_PACKAGE", "S05: set by the M0.03 launcher inside a package"],
  ["SNAP_NAME", "S05: the snap the probe runs in"],
  ["FLATPAK_ID", "S05: the flatpak the probe runs in"],
]);

/** Logged as a 12-hex SHA-256 prefix, so a lab run can match it against the ticket it issued. */
export const HASHED_NAMES = new Set(["TTASKS_TICKET"]);

/**
 * Variables the redactor leaves alone: their values are common words or machine facts, not
 * credentials, and matching them would blank out ordinary text. None of them is ever logged.
 */
export const BENIGN_NAMES = new Set([
  "USERNAME",
  "USER",
  "LOGNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "HOSTNAME",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TERM",
  "SHLVL",
  "PATHEXT",
]);

/** The client names the lab expects (clientInfo.name). Any other is logged as `[other:...]`. */
export const KNOWN_CLIENTS = new Set([
  // Claude Code (CLI and IDE), the Claude desktop app
  "claude-code",
  "claude-ai",
  // Codex CLI and the Codex desktop app (rmcp client)
  "codex-mcp-client",
  "codex",
  // T3 Code
  "t3code",
  "t3-code",
  // The official MCP SDK clients' defaults and the Inspector
  "mcp",
  "mcp-inspector",
  "inspector-client",
  // The kit's own clients
  "kit-self-test",
  "kit-bench",
]);

/** The MCP methods of both eras. Any other is logged as `[other:...]`. */
export const KNOWN_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
  "server/discover",
  "subscriptions/listen",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "logging/setLevel",
  "completion/complete",
]);

export const KNOWN_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
]);

/** A value outside the closed lists: a 12-hex SHA-256 prefix and the length, never the value. */
export const other = (value: string): string =>
  `[other:${sha256Hex(value).slice(0, 12)} length ${String(value.length)}]`;

/** `value` when it is on `list`, null when it is absent or not a string, else `other`. */
export function known(value: unknown, list: ReadonlySet<string>): string | null {
  if (typeof value !== "string") return null;
  return list.has(value) ? value : other(value);
}

/** A client version: dotted digits only. Anything else (a pre-release tag too) is `other`. */
export function version(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\d{1,6}(\.\d{1,6}){0,3}$/.test(value) ? value : other(value);
}

/** An identifier value from VALUE_NAMES: an ID-like token, at most 200 characters. */
export function identifier(value: string): string {
  return /^[A-Za-z0-9._:@+,-]{1,200}$/.test(value) ? value : other(value);
}

/** A package family name, snap name or flatpak ID (S05): at most 128 such characters. */
export function packageName(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : other(value);
}

/** An executable's base name (node.exe, claude): a plain file name, else `other`. */
export function exeName(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  return /^[A-Za-z0-9._+-]{1,64}$/.test(value) ? value : other(value);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

const sameCase = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

/** The scratch tree the probe compares paths with: its root and its own named folders. */
export interface ScratchRoot {
  root: string;
  /** Relative paths of the folders the tree's `tree.json` names, by their tree key. */
  folders: Map<string, string>;
}

/**
 * Loads the lab's scratch root (`kit tree`'s container). Its `tree.json` names the tree's own
 * folders, whose relative paths the probe may log. Undefined when no root was given.
 */
export function loadScratchRoot(root: string | undefined): ScratchRoot | undefined {
  if (root === undefined || root === "" || !isAbsolute(root)) return undefined;
  const canonicalRoot = canonicalPath(root);
  const folders = new Map<string, string>();
  const record = join(canonicalRoot, "tree.json");
  if (existsSync(record)) {
    let tree: JsonObject | undefined;
    try {
      tree = asObject(JSON.parse(readFileSync(record, "utf8")) as Json);
    } catch {
      tree = undefined;
    }
    for (const [key, value] of Object.entries(tree ?? {})) {
      if (typeof value !== "string") continue;
      const rel = relative(sameCase(canonicalRoot), sameCase(canonicalPath(value)));
      if (!rel.startsWith("..") && !isAbsolute(rel)) folders.set(rel, key);
    }
  }
  return { root: canonicalRoot, folders };
}

/**
 * What the probe logs about a path, never the path: its SHA-256 (of the canonical absolute path,
 * as the lab computes it for the folders it knows), whether it is inside the scratch root, and
 * then which tree folder it is (`tree`, a key of tree.json) or, for any other folder inside the
 * root, only its depth. `under_packages` is S05's question: inside a `\Packages\` folder.
 */
export function pathFacts(path: string | undefined, scratch: ScratchRoot | undefined): Json {
  if (path === undefined || path === "") return null;
  const canonical = canonicalPath(path);
  const facts: JsonObject = {
    sha256: sha256Hex(canonical),
    inside_scratch: false,
    under_packages: /[\\/]Packages[\\/]/i.test(canonical),
  };
  if (scratch === undefined) return facts;
  const rel = relative(sameCase(scratch.root), sameCase(canonical));
  if (rel.startsWith("..") || isAbsolute(rel)) return facts;
  facts["inside_scratch"] = true;
  facts["tree"] = rel === "" ? "container" : (scratch.folders.get(rel) ?? null);
  facts["depth"] = rel === "" ? 0 : rel.split(/[\\/]/).length;
  return facts;
}

/** Counts its replacements, so the self-test can show it never fires on structured records. */
export interface Redactor {
  json(value: Json): Json;
  readonly fired: number;
}

/**
 * The last line of defence: replaces every value (4 characters or more) of an environment
 * variable that is neither on the value allow-lists (VALUE_NAMES, PACKAGE_NAMES) nor benign by
 * name (BENIGN_NAMES), wherever it appears in a string or key. No exemption for paths, path lists
 * or length beyond that, and a value is replaced even when it equals an allow-listed value.
 */
export function createRedactor(env: NodeJS.ProcessEnv): Redactor {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (value === undefined || value.length < 4) continue;
    if (VALUE_NAMES.has(upper) || PACKAGE_NAMES.has(upper) || BENIGN_NAMES.has(upper)) continue;
    values.add(value);
  }
  const secrets = [...values].sort((a, b) => b.length - a.length);
  let fired = 0;
  const text = (input: string): string => {
    let out = input;
    for (const secret of secrets) {
      if (!out.includes(secret)) continue;
      fired++;
      out = out.split(secret).join("[redacted]");
    }
    return out;
  };
  const json = (value: Json): Json => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(json);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), json(v)]));
    }
    return value;
  };
  return {
    json,
    get fired() {
      return fired;
    },
  };
}

/** The environment as the probe logs it: all names, and allow-listed values only. */
export function environmentFacts(
  env: NodeJS.ProcessEnv,
  scratch: ScratchRoot | undefined,
): { names: string[]; values: JsonObject; paths: JsonObject } {
  const values: JsonObject = {};
  const paths: JsonObject = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (HASHED_NAMES.has(upper)) values[name] = `sha256:${sha256Hex(value).slice(0, 12)}`;
    else if (VALUE_NAMES.has(upper)) values[name] = identifier(value);
    else if (PACKAGE_NAMES.has(upper)) values[name] = packageName(value);
    else if (PATH_NAMES.has(upper)) paths[name] = pathFacts(value, scratch);
  }
  return { names: Object.keys(env).sort(), values, paths };
}
