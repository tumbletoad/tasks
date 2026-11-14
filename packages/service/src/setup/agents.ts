// `tasks setup agents` (A3 3.13; M2.14, M4.05): Tasks's MCP server entry in each agent home of this
// machine, put there with the app's own command or, for an app without one, as one entry spliced
// into its file, and taken back exactly.
//
// The agent-home table (APPS below) has one row per app: its catalogue target, its file's format,
// the servers' table, the file's bound, and how the entry is written:
// - Claude Code (A3 3.13.2): `claude mcp add --scope user <key> -- <tasks> mcp …`, and `claude mcp
//   remove` to undo. `.claude.json` is never edited by Tasks: Claude Code rewrites it while it runs.
// - Codex (A3 3.13.4): `codex mcp add <key> -- <tasks> mcp …`, then two single-key patches in the
//   entry's own table (`env_vars`, `startup_timeout_sec`) through the format-keeping editor of
//   machine.toml (config/edit.ts), and `codex mcp remove` to undo, which drops the table.
// - Claude Desktop (A3 3.13.3): no command of its own, so `mcpServers.<key>` is spliced into
//   `claude_desktop_config.json` as one member (json-edit.ts) and written with machine.toml's
//   editor (commitEdit: atomic, the file's mode, refused when the file changed meanwhile); undo
//   splices it out again. Setup never creates that file: the app makes it the first time its
//   developer settings are opened.
// The Codex app and T3 Code have no entry of their own (A3 3.13.5, 3.13.6): they read the homes of
// the CLIs, so they are hosts of those homes (hosts.ts). T3's settings are read, never written.
//
// What setup changes, and only that: the entry named after the product (brand's MCP_SERVER_KEY).
// Never a trust or approval setting, a permission, a hook, another server's entry, a managed file
// or a key setup did not write; never a sign-in file or a token (A3 3.13.1).
//
// - The app's command runs as an argv array without a shell, in the person's environment with the
//   home variables (CLAUDE_CONFIG_DIR, CODEX_HOME) taken out, and the home's own variable put in
//   for every home but Claude Code's default one (whose `.claude.json` sits in the user's home).
// - Before anything is written, the home's record is written ("applying"): the app, the home, the
//   command and its undo, whether the file and its servers' table existed, and the file's hash. It
//   holds no copy of the file and no other key's value (A3 3.13.1: these files hold other servers'
//   secrets). After the change the record holds the entry as written. `--remove` takes back only an
//   entry that is still exactly that one; an entry the person changed since is left.
// - A home whose file setup does not understand is refused with a reason and nothing runs there:
//   a file that is not UTF-8 JSON or TOML, a duplicate key, a managed file (a link, a file marked
//   as generated, one machine.toml lists, one another git repository tracks), servers written in a
//   layout the patch cannot keep (Codex), an entry of the same name that setup did not write, or
//   no usable command of the app.
//
// Every path, variable and file read goes through the injected input, so tests run on scratch
// homes with fake commands of their own (testkit's fake-agents.ts).
import { createHash } from "node:crypto";
import { lstatSync, rmSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { envVar, MCP_SERVER_KEY } from "@tasks/brand";
// The bridge's own parser by its own path: the bridge's index would bring its runner into bundles.
import { parseArgs } from "@tasks/bridge/mcp/args";
import {
  HOME_VARIABLES,
  INSTANCE_ID,
  instanceHome,
  isTable,
  MANUAL_INSTANCE,
  proposedAccount,
  proposedInstanceId,
  targetDef,
  type BuiltInTargetId,
  type Detection,
  type Env,
  type Instance,
} from "@tasks/launch";
import { applyEdits, commitEdit, keyText, valueText, type EditValue } from "../config/edit.ts";
import { scanToml, ScanError } from "../config/scan.ts";
import { BOM, MAX_CONFIG_BYTES, parseToml, readConfigFile } from "../config/toml.ts";
import {
  claudeDesktopFolders,
  codexAppEngines,
  DESKTOP_FILE,
  hasT3,
  t3Homes,
  t3InstanceId,
  t3SettingsFile,
  type T3Home,
} from "./hosts.ts";
import { addEntry, removeEntry } from "./json-edit.ts";
import { parseStrictJson } from "./json.ts";
import { listedAsManaged, trackedByAnotherRepository } from "./managed.ts";
import { AGENT_APPS, readRecords, writeRecords, type AgentApp, type HomeRecord } from "./state.ts";

/** One row of the agent-home table: how setup reads and writes an app's entry. */
interface AppRow {
  /** The app's catalogue target (A4 3.2): its label, its home folders and their variable. */
  readonly target: BuiltInTargetId;
  readonly format: "json" | "toml";
  /** The servers' table in the app's file. */
  readonly servers: string;
  /** The file's bound: a larger file is refused unread. */
  readonly maxBytes: number;
  /** `command`: the app's own `mcp add` and `mcp remove`. `edit`: one entry spliced in by setup. */
  readonly writer: "command" | "edit";
  /**
   * The keys the app's `mcp add` writes by itself beside `command` and `args`, with their values
   * (lab run A: Claude Code adds `type` and an empty `env`, Codex nothing).
   */
  readonly appKeys: Readonly<Record<string, unknown>>;
}

const APPS: Readonly<Record<AgentApp, AppRow>> = {
  "claude-code": {
    target: "claude-cli",
    format: "json",
    servers: "mcpServers",
    // `.claude.json` keeps every project's history, so it can be far larger than a configuration
    // file: machine.toml's 1 MiB bound would refuse it.
    maxBytes: 64 * 1024 * 1024,
    writer: "command",
    appKeys: { type: "stdio", env: {} },
  },
  codex: {
    target: "codex-cli",
    format: "toml",
    servers: "mcp_servers",
    maxBytes: MAX_CONFIG_BYTES,
    writer: "command",
    appKeys: {},
  },
  "claude-desktop": {
    target: "claude-desktop",
    format: "json",
    servers: "mcpServers",
    maxBytes: 4 * 1024 * 1024,
    writer: "edit",
    appKeys: {},
  },
};

/** Claude Code's user-scope file: in the user's home folder for the default home, else in the home. */
const CLAUDE_FILE = ".claude.json";
/** Codex's configuration file in a Codex home. */
const CODEX_FILE = "config.toml";
/** The servers' table in each app's file. */
export const SERVERS_KEY = Object.fromEntries(
  AGENT_APPS.map((app) => [app, APPS[app].servers]),
) as Readonly<Record<AgentApp, string>>;

/** A3 3.13.4: Codex waits 10 s for a server by default; 20 covers a cold bridge start on Windows. */
export const CODEX_STARTUP_TIMEOUT_SEC = 20;

/** Comment words that mark a file as generated by another tool (A3 3.12's managed sources, rule 2). */
const MANAGED_MARK = /generated|do not edit|managed by/iu;

/** The label of each app, from the catalogue. */
export const appLabel = (app: AgentApp): string => targetDef(APPS[app].target).label;

/** Whether setup writes the app's entry itself (no command of the app's own). */
export const editsFile = (app: AgentApp): boolean => APPS[app].writer === "edit";

/** Other apps that read a home's entry (A3 3.13.5, 3.13.6): attribution can say "via T3". */
export const HOSTS = ["codex-app", "t3"] as const;
export type Host = (typeof HOSTS)[number];

/** One agent home: where an app reads its MCP servers (A3 "agent home"). */
export interface AgentHome {
  readonly app: AgentApp;
  /** The home folder: `~/.claude`, `~/.codex`, `~/.codex-work`, one a variable names, or the folder of Claude Desktop's file. */
  readonly home: string;
  /** The file that holds the entry. */
  readonly file: string;
  /** The app's default home, which no variable selects. */
  readonly isDefault: boolean;
  /** The variable that selects a home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), from the catalogue. */
  readonly variable: string;
  /** The A4 instance the entry names (`--instance`). */
  readonly instance: string;
  /**
   * The instance is setup's proposal (detection's, T3's or Claude Desktop's), not one machine.toml
   * names: setup may give the home a free one instead (A3 3.7.8, `survey`).
   */
  readonly proposed?: boolean;
  readonly account: string;
  /** The other apps that read this home's entry: the Codex app, T3 Code. */
  readonly hosts: readonly Host[];
  /** A3 3.12 rules 3 and 4: machine.toml lists the file, or another git repository tracks it. */
  readonly managed: boolean;
}

/** Why setup leaves a home alone: its file is in a state setup does not understand. */
export type Refusal =
  | "unreadable"
  | "too_large"
  | "encoding"
  | "invalid_file"
  | "duplicate_key"
  | "managed"
  | "wrong_type"
  | "unsupported_layout"
  | "foreign_entry"
  /** Linux and macOS: the file or its folder belongs to another user, or anyone can change it. */
  | "unsafe"
  | "no_command"
  /** Claude Desktop's file is not there yet: the app makes it in its developer settings. */
  | "not_set_up"
  /** Several Claude Desktop configuration files: `--home` names the one the app uses. */
  | "ambiguous";

export type HomeState =
  /** No entry of Tasks's name, and setup can add one. */
  | "not_registered"
  /** The entry is exactly the one setup wrote. */
  | "registered"
  /** The entry setup wrote was changed since: setup leaves it alone. */
  | "edited"
  /** Setup wrote an entry that is gone now. */
  | "missing"
  /** An apply that did not finish (a crash, a failed undo): `--remove` settles it. */
  | "interrupted"
  | "refused";

/** A home as setup finds it now. */
export interface HomeView {
  readonly home: AgentHome;
  readonly state: HomeState;
  readonly refusal?: Refusal;
  /** SHA-256 of the file as read; null when there is no file. */
  readonly sha256: string | null;
  /** Whether the servers' table (`mcpServers`, `mcp_servers`) exists. */
  readonly parent: boolean;
  /** Tasks's entry as found, when there is one. Tasks's own data: never another key's value. */
  readonly entry?: unknown;
  readonly record?: HomeRecord;
}

/** What setup runs and writes for one home. */
export interface Change {
  /** `command`: the app's command below runs. `edit`: setup splices `entry` into the file. */
  readonly writer: "command" | "edit";
  /** The app's command (`[file]`, or `[node, entry]` for an npm install); empty for `edit`. */
  readonly exec: readonly string[];
  /** Its arguments: `mcp add …`. */
  readonly args: readonly string[];
  /** The undo's arguments: `mcp remove …`. */
  readonly undo: readonly string[];
  /** The entry's own argv: Tasks's command and its arguments. */
  readonly entry: readonly string[];
  /** Variables set for the command, and home variables taken out of the person's environment. */
  readonly set: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
  /** Codex: Tasks's single-key patches in the entry's table, in order. */
  readonly patches: readonly { readonly key: string; readonly value: EditValue }[];
  /** The key-level diff, one line per key, as `+ key = value`. */
  readonly diff: readonly string[];
}

export type OutcomeReason =
  | Refusal
  | "edited"
  | "interrupted"
  | "missing"
  | "not_registered"
  | "changed_meanwhile"
  | "command_failed"
  | "unexpected_entry"
  | "other_space"
  /** The service did not keep the home's agent-home row: nothing was changed in the home. */
  | "grant_failed"
  /** The service refused the row: another home's live row holds this instance (A3 3.7.8). */
  | "instance_taken";

/** What happened to one home. */
export interface Outcome {
  readonly home: AgentHome;
  readonly result: "applied" | "removed" | "unchanged" | "left" | "failed";
  readonly reason?: OutcomeReason;
  /** Facts the person should know: `empty_parent_kept` (Claude Code keeps an empty table). */
  readonly notes?: readonly string[];
}

/** What setup reads and runs, injected so tests use scratch homes and fake commands. */
export interface SetupInput {
  readonly platform: NodeJS.Platform;
  /** The user's home folder: Claude Code's default `.claude.json` is here. */
  readonly userHome: string;
  /** The agent environment the apps' commands run in: the person's own. */
  readonly env: Env;
  /** `<state>`: setup's record lives in `<state>/setup/`. */
  readonly stateDir: string;
  /** Tasks's stable command, which every entry runs (A2 3.12; never a moving version). */
  readonly tasks: string;
  readonly detection: Detection;
  /** machine.toml's instances: a home they name gets their ID (A4 3.2). */
  readonly instances: readonly Instance[];
  /**
   * The service's live agent-home rows, when the caller asked for them (`setup/homes`): a home
   * setup proposes an instance for gets one that no other home's row holds (A3 3.7.8).
   */
  readonly rows?: readonly {
    readonly app: string;
    readonly home: string;
    readonly instance: string;
  }[];
  /** machine.toml's `[setup.managed] paths` (A3 3.12 rule 4). Default: none. */
  readonly managedPaths?: readonly string[];
  /** git's command for A3 3.12 rule 3, as an argv prefix. Default: `git` on `env`'s PATH. */
  readonly git?: readonly string[];
  /** macOS: the system's Applications folder (the Codex app's engine). Default: /Applications. */
  readonly systemApplications?: string;
  isFolder(path: string): boolean;
  /** Runs `argv` without a shell in `env`; true when it exits 0 within its bound. */
  run(argv: readonly string[], env: Env): Promise<boolean>;
}

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** Same path, compared the way the OS compares paths. */
export function samePath(platform: NodeJS.Platform, a: string, b: string): boolean {
  const p = pathOf(platform);
  const x = p.resolve(a);
  const y = p.resolve(b);
  return platform === "win32" || platform === "darwin"
    ? x.toLowerCase() === y.toLowerCase()
    : x === y;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------------------------
// The homes

/**
 * The home an instance runs, and whether it is the app's default: launch's rule (A4 3.2,
 * `instanceHome` in @tasks/launch), so setup registers the entry in the home the agent uses.
 */
function homeOf(
  instance: Instance,
  app: AgentApp,
  userHome: string,
  platform: NodeJS.Platform,
): { path: string; isDefault: boolean } {
  // Claude Code and Codex have homes, and with the account's home given the rule always names a
  // path. Claude Desktop has no home of its own (it is never asked here).
  const home = instanceHome({ ...instance, target: APPS[app].target }, userHome, platform);
  return { path: home?.path ?? userHome, isDefault: home?.isDefault ?? false };
}

/** The file of an app's entry in a home. */
function fileOf(input: SetupInput, app: AgentApp, home: string, isDefault: boolean): string {
  const p = pathOf(input.platform);
  if (app === "codex") return p.join(home, CODEX_FILE);
  if (app === "claude-desktop") return p.join(home, DESKTOP_FILE);
  return isDefault ? p.join(input.userHome, CLAUDE_FILE) : p.join(home, CLAUDE_FILE);
}

/** Rules 3 and 4 of A3 3.12, judged once per home and run. Rule 3 asks git (managed.ts). */
async function managedFile(input: SetupInput, file: string, home: string): Promise<boolean> {
  return (
    listedAsManaged(input.platform, file, input.managedPaths ?? []) ||
    (await trackedByAnotherRepository(input.platform, file, home, {
      env: input.env,
      ...(input.git === undefined ? {} : { git: input.git }),
    }))
  );
}

/** What the other apps' discovery found on this machine (hosts.ts), once per survey. */
interface Discovered {
  readonly desktop: readonly string[];
  readonly engines: readonly string[];
  readonly t3: readonly T3Home[];
}

function discover(input: SetupInput): Discovered {
  return {
    desktop: claudeDesktopFolders(input),
    engines: codexAppEngines(input),
    t3: hasT3(input) ? t3Homes(input, readT3Settings(input)) : [],
  };
}

/**
 * Whether a T3 provider instance reads the entry of a home: the same folder, and for Claude Code
 * the same file. T3 sets CLAUDE_CONFIG_DIR from a non-empty `homePath`, and Claude Code then reads
 * `.claude.json` inside that folder, even when the folder is the default one, whose entry setup
 * keeps in the user's `~/.claude.json`.
 */
export function readsHome(
  platform: NodeJS.Platform,
  t3: T3Home,
  app: AgentApp,
  home: string,
  isDefault: boolean,
): boolean {
  return (
    t3.app === app &&
    samePath(platform, t3.home, home) &&
    (app !== "claude-code" || t3.isDefault === isDefault)
  );
}

/** The other apps that read a home: the Codex app reads the default Codex home, T3 its instances'. */
function hostsOf(
  input: SetupInput,
  found: Discovered,
  app: AgentApp,
  home: string,
  isDefault: boolean,
): readonly Host[] {
  const hosts: Host[] = [];
  const codexDefault = pathOf(input.platform).join(input.userHome, ".codex");
  if (app === "codex" && found.engines.length > 0 && samePath(input.platform, home, codexDefault)) {
    hosts.push("codex-app");
  }
  if (found.t3.some((t) => readsHome(input.platform, t, app, home, isDefault))) {
    hosts.push("t3");
  }
  return hosts;
}

/**
 * Every agent home: the homes detection found (A4 3.2: `.claude`, `.claude-<suffix>`, `.codex`,
 * `.codex-<suffix>` and the home a variable names), the homes of machine.toml's instances that are
 * folders, the homes T3's provider instances use, and Claude Desktop's configuration folders. A
 * home an instance names takes the instance's ID and account; any other takes detection's
 * proposal (T3's from its folder or provider key, Claude Desktop's from the catalogue).
 */
export async function agentHomes(
  input: SetupInput,
  found: Discovered = discover(input),
): Promise<AgentHome[]> {
  const { platform, userHome, instances } = input;
  const p = pathOf(platform);
  const homes: AgentHome[] = [];
  const add = async (
    app: AgentApp,
    path: string,
    found_: boolean,
    id: string,
    account: string,
  ): Promise<void> => {
    if (homes.some((h) => h.app === app && samePath(platform, h.home, path))) return;
    const rule = targetDef(APPS[app].target).detect.homes;
    const owner = instances.find(
      (i) =>
        i.enabled &&
        i.target === APPS[app].target &&
        (app === "claude-desktop" ||
          samePath(platform, homeOf(i, app, userHome, platform).path, path)),
    );
    // The instance's own selection wins (A4 3.2): one that names the default folder by its variable
    // runs Claude Code with `.claude.json` inside that folder, so that is the file of its entry.
    const isDefault =
      owner === undefined || app === "claude-desktop"
        ? found_
        : homeOf(owner, app, userHome, platform).isDefault;
    const home = p.resolve(path);
    const file = fileOf(input, app, home, isDefault);
    homes.push({
      app,
      home,
      file,
      isDefault,
      variable: rule?.env ?? "",
      instance: owner?.id ?? id,
      ...(owner === undefined ? { proposed: true } : {}),
      account: owner?.account ?? account,
      hosts: hostsOf(input, found, app, home, isDefault),
      managed: await managedFile(input, file, home),
    });
  };
  for (const home of input.detection.homes) {
    const app: AgentApp = home.target === "codex-cli" ? "codex" : "claude-code";
    const def = targetDef(home.target);
    await add(
      app,
      home.path,
      home.suffix === "" && home.source === "home",
      proposedInstanceId(def, home.suffix),
      proposedAccount(home.suffix),
    );
  }
  for (const instance of instances) {
    if (!instance.enabled) continue;
    const app = AGENT_APPS.find(
      (a) => a !== "claude-desktop" && APPS[a].target === instance.target,
    );
    if (app === undefined) continue;
    const { path, isDefault } = homeOf(instance, app, userHome, platform);
    if (!p.isAbsolute(path) || !input.isFolder(path)) continue;
    await add(app, path, isDefault, instance.id, instance.account);
  }
  // T3's homes (A3 3.13.6 step 2): the same homes as the CLIs on most machines, so usually only
  // their host changes; a home only T3 uses is offered like any other.
  for (const t3 of found.t3) {
    if (!input.isFolder(t3.home)) continue;
    await add(t3.app, t3.home, t3.isDefault, t3InstanceId(t3, platform), proposedAccount(""));
  }
  for (const folder of found.desktop) {
    await add("claude-desktop", folder, true, "claude-desktop", proposedAccount(""));
  }
  return homes;
}

/** The app's own command as detection found it, when it can be run. */
export function commandOf(detection: Detection, app: AgentApp): readonly string[] | undefined {
  const found = detection.commands.find((c) => c.target === APPS[app].target);
  return found !== undefined && found.unusable === undefined && found.exec.length > 0
    ? found.exec
    : undefined;
}

/**
 * The command setup runs in a home: the app's own as detection found it, else, for the home the
 * Codex app reads, the app's bundled engine (A3 3.13.5). Undefined for an app setup edits itself.
 */
export function commandFor(input: SetupInput, home: AgentHome): readonly string[] | undefined {
  if (editsFile(home.app)) return undefined;
  const found = commandOf(input.detection, home.app);
  if (found !== undefined) return found;
  if (home.app !== "codex" || !home.hosts.includes("codex-app")) return undefined;
  const engine = codexAppEngines(input).at(-1);
  return engine === undefined ? undefined : [engine];
}

/** The engines that read a Codex home (doctor's `codex.engines`): the CLI, the app's engines. */
export function codexEngines(
  input: SetupInput,
  home: AgentHome,
): { readonly kind: "cli" | "app"; readonly exec: readonly string[] }[] {
  const engines: { kind: "cli" | "app"; exec: readonly string[] }[] = [];
  const cli = commandOf(input.detection, "codex");
  if (cli !== undefined) engines.push({ kind: "cli", exec: cli });
  if (home.hosts.includes("codex-app")) {
    for (const engine of codexAppEngines(input)) engines.push({ kind: "app", exec: [engine] });
  }
  return engines;
}

// ---------------------------------------------------------------------------------------------
// Reading a home's file

type TextRead =
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | {
      readonly kind: "text";
      readonly bytes: Buffer;
      readonly sha256: string;
      /** The text without a byte order mark. */
      readonly text: string;
      readonly bom: boolean;
    };

type FileRead =
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | {
      readonly kind: "read";
      readonly bytes: Buffer;
      readonly sha256: string;
      /** The text without a byte order mark. */
      readonly text: string;
      readonly bom: boolean;
      readonly parent: boolean;
      readonly entry: unknown;
    };

const refused = (refusal: Refusal) => ({ kind: "refused", refusal }) as const;

/**
 * Whether the path is a link (a junction on Windows too): another tool keeps what it points at, and a
 * change through it would land outside the home.
 */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Linux and macOS: whether a file or folder belongs to another user or anyone can change it. Such a
 * file is another user's or the system's, or anyone may already have rewritten it: setup leaves it.
 * Group write is allowed: with a per-user group and umask 002 it is the norm for files the apps make.
 */
function unsafe(stat: { uid: number; mode: number }): boolean {
  const uid = process.getuid?.();
  if (process.platform === "win32" || uid === undefined) return false;
  return stat.uid !== uid || (stat.mode & 0o002) !== 0;
}

/** The folder that holds the file: the home, or the user's home for Claude Code's default home. */
function folderUnsafe(path: string): boolean {
  try {
    return unsafe(statSync(path));
  } catch {
    return false;
  }
}

/**
 * Reads an agent app's file as text and judges it. Never writes, never opens anything else. The file
 * and the folder that holds it are checked on every read, so apply and remove check them again right
 * before they change anything: a link there (the file, or the folder when it is the home), or on
 * Linux and macOS another user's or a world-writable file or folder, is refused. The folders above
 * the home are the person's own layout (a profile on another drive, `/home` as a link on some
 * systems) and are not.
 */
function readText(file: string, home: string, maxBytes: number): TextRead {
  const folder = pathOf(process.platform).dirname(file);
  if (isLink(file) || (samePath(process.platform, folder, home) && isLink(folder))) {
    return refused("managed");
  }
  if (folderUnsafe(folder)) return refused("unsafe");
  const read = readConfigFile(file, maxBytes);
  if (read.kind === "missing") return { kind: "missing" };
  if (read.kind === "problem") {
    return refused(read.problem.code === "too_large" ? "too_large" : "unreadable");
  }
  if (unsafe(read.stat)) return refused("unsafe");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
  } catch {
    return refused("encoding");
  }
  const bom = text.startsWith(BOM);
  return {
    kind: "text",
    bytes: read.bytes,
    sha256: sha256(read.bytes),
    text: bom ? text.slice(1) : text,
    bom,
  };
}

function readJson(text: string, servers: string): { parent: boolean; entry: unknown } | Refusal {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return parsed.reason;
  const doc = parsed.value;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return "wrong_type";
  const table = (doc as Record<string, unknown>)[servers];
  if (table === undefined) return { parent: false, entry: undefined };
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    return "wrong_type";
  }
  return {
    parent: true,
    entry: Object.hasOwn(table, MCP_SERVER_KEY)
      ? (table as Record<string, unknown>)[MCP_SERVER_KEY]
      : undefined,
  };
}

function readToml(text: string): { parent: boolean; entry: unknown } | Refusal {
  // A file another tool generates: a comment near its top says so (A3 3.12 rule 2).
  for (const line of text.split("\n").slice(0, 20)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") && MANAGED_MARK.test(trimmed)) return "managed";
  }
  const parsed = parseToml(text);
  if (!parsed.ok) return "invalid_file";
  let lines;
  try {
    lines = scanToml(text);
  } catch (error) {
    if (error instanceof ScanError) return "unsupported_layout";
    throw error;
  }
  // Each server must be a table of its own, `[mcp_servers.<name>]`: a server written inline or
  // with dotted keys from above its table is a layout the single-key patch cannot keep, and the
  // app's own command might write Tasks's entry the same way.
  const servers = APPS.codex.servers;
  let table: readonly string[] = [];
  for (const line of lines) {
    if (line.kind === "header") {
      if (line.array && line.path[0] === servers) return "unsupported_layout";
      table = line.path;
    } else if (table.length < 2 && (table[0] ?? line.key[0]) === servers) {
      return "unsupported_layout";
    }
  }
  const value = parsed.doc[servers];
  if (value === undefined) return { parent: false, entry: undefined };
  if (!isTable(value)) return "wrong_type";
  return { parent: true, entry: value[MCP_SERVER_KEY] };
}

/** Reads and judges a home's file (readText's checks, then the app's format). Never writes. */
function readHomeFile(home: AgentHome): FileRead {
  if (home.managed) return refused("managed");
  const row = APPS[home.app];
  const read = readText(home.file, home.home, row.maxBytes);
  if (read.kind !== "text") return read;
  const judged = row.format === "toml" ? readToml(read.text) : readJson(read.text, row.servers);
  if (typeof judged === "string") return refused(judged);
  return { ...read, kind: "read", ...judged };
}

/**
 * T3's settings, read-only through the same reader (A3 3.13.6 step 1), or undefined when they are
 * not there or setup does not accept the file. Only the provider instances' homes are used.
 */
export function readT3Settings(input: SetupInput): unknown {
  const p = pathOf(input.platform);
  const file = t3SettingsFile(input);
  const read = readText(file, p.dirname(file), 4 * 1024 * 1024);
  if (read.kind !== "text") return undefined;
  const parsed = parseStrictJson(read.text);
  return parsed.ok ? parsed.value : undefined;
}

const entryOf = (read: FileRead): unknown => (read.kind === "read" ? read.entry : undefined);

class NotJson extends Error {}

/** `value` as plain JSON data: plain objects and arrays, strings, finite numbers, booleans, null. */
function plain(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NotJson();
    return value;
  }
  if (Array.isArray(value)) return (value as unknown[]).map(plain);
  // A TOML date, a bigint, undefined: JSON cannot hold them exactly.
  if (typeof value !== "object" || value instanceof Date) throw new NotJson();
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
}

/** A plain JSON copy of an entry, or undefined when JSON cannot hold it exactly. */
function jsonCopy(value: unknown): unknown {
  try {
    return value === undefined ? undefined : plain(value);
  } catch (error) {
    if (error instanceof NotJson) return undefined;
    throw error;
  }
}

/** Whether an entry is exactly the one recorded: the same keys, in any order, and values. */
const sameEntry = (entry: unknown, recorded: unknown): boolean => {
  const copy = jsonCopy(entry);
  return copy !== undefined && isDeepStrictEqual(copy, recorded);
};

/** Whether an entry runs exactly `argv`: its command and its arguments. */
export function runs(entry: unknown, argv: readonly string[]): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  return command === argv[0] && isDeepStrictEqual(jsonCopy(args), argv.slice(1));
}

/** The entry with Tasks's patches applied: what apply leaves once its patches are written. */
function patched(entry: unknown, patches: HomeRecord["patches"]): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  return { ...entry, ...Object.fromEntries(patches.map((p) => [p.key, p.after])) };
}

/**
 * Whether an entry is exactly what setup asked for, when no entry was recorded yet (the app's command
 * was running): the asked command and arguments, and besides them only the keys the app adds by
 * itself and Tasks's own patches, each with its fixed value. Any other key or value is the person's.
 */
function asAsked(entry: unknown, app: AgentApp, argv: readonly string[]): boolean {
  const copy = jsonCopy(entry);
  if (!runs(copy, argv)) return false;
  const fixed: Record<string, unknown> = {
    ...APPS[app].appKeys,
    ...(app === "codex" ? Object.fromEntries(codexPatches().map((p) => [p.key, p.value])) : {}),
  };
  return Object.entries(copy as Record<string, unknown>).every(
    ([key, value]) =>
      key === "command" ||
      key === "args" ||
      (Object.hasOwn(fixed, key) && isDeepStrictEqual(value, fixed[key])),
  );
}

/**
 * The one rule before every take-back (the app's own `mcp remove`, or setup's splice for an app it
 * edits itself): the entry as read just now is provably setup's own. Applied: exactly the recorded
 * entry. An apply that did not finish: the entry the command wrote (recorded as soon as it was
 * checked, or before the write when setup writes it), the same with Tasks's patches, or, when the
 * command was still running, exactly what setup asked for. An entry the person changed is never.
 */
export function ownEntry(entry: unknown, record: HomeRecord): boolean {
  if (entry === undefined) return false;
  if (record.state === "applied") return sameEntry(entry, record.entry);
  if (record.entry === null) return asAsked(entry, record.app, record.entry_argv);
  return sameEntry(entry, record.entry) || sameEntry(entry, patched(record.entry, record.patches));
}

/** A home as it is now, judged against setup's record of it. */
export function inspectHome(home: AgentHome, record: HomeRecord | undefined): HomeView {
  const read = readHomeFile(home);
  const base = {
    home,
    sha256: read.kind === "read" ? read.sha256 : null,
    parent: read.kind === "read" && read.parent,
    ...(read.kind === "read" && read.entry !== undefined ? { entry: read.entry } : {}),
    ...(record === undefined ? {} : { record }),
  };
  if (read.kind === "refused") return { ...base, state: "refused", refusal: read.refusal };
  const entry = entryOf(read);
  if (record === undefined) {
    return entry === undefined
      ? { ...base, state: "not_registered" }
      : { ...base, state: "refused", refusal: "foreign_entry" };
  }
  if (record.state === "applying") return { ...base, state: "interrupted" };
  if (entry === undefined) return { ...base, state: "missing" };
  return { ...base, state: sameEntry(entry, record.entry) ? "registered" : "edited" };
}

/** A home rebuilt from its record, for a home that detection no longer finds. */
async function homeOfRecord(
  input: SetupInput,
  found: Discovered,
  record: HomeRecord,
): Promise<AgentHome> {
  return {
    app: record.app,
    home: record.home,
    file: record.file,
    isDefault: record.is_default,
    variable: targetDef(APPS[record.app].target).detect.homes?.env ?? "",
    instance: record.instance,
    account: record.account,
    hosts: hostsOf(input, found, record.app, record.home, record.is_default),
    managed: await managedFile(input, record.file, record.home),
  };
}

/** The record of a home, if setup keeps one. */
const recordOf = (records: readonly HomeRecord[], home: AgentHome, platform: NodeJS.Platform) =>
  records.find((r) => r.app === home.app && samePath(platform, r.home, home.home));

/**
 * Every home setup knows of, inspected now: the homes found, then recorded homes not found. A home
 * with a record is the recorded one, its file, selection, instance and account: what setup changed
 * there is what it checks, takes back and renews a row for, even when machine.toml now names the
 * home otherwise. Remove, then apply, moves an entry to what the machine says now.
 */
export async function survey(input: SetupInput): Promise<HomeView[]> {
  const records = readRecords(input.stateDir);
  const found = discover(input);
  const homes = await agentHomes(input, found);
  for (const record of records) {
    if (!homes.some((h) => h.app === record.app && samePath(input.platform, h.home, record.home))) {
      homes.push(await homeOfRecord(input, found, record));
    }
  }
  const views: HomeView[] = [];
  for (const home of freeInstances(input, homes, records)) {
    const record = recordOf(records, home, input.platform);
    views.push(
      inspectHome(record === undefined ? home : await homeOfRecord(input, found, record), record),
    );
  }
  return views;
}

/**
 * A3 3.7.8 "one home per instance": each home whose instance setup proposes (no record, no
 * machine.toml instance) keeps its proposal when no one else holds it, else gets the first free
 * `<proposal>-2`, `-3`, … An ID is held by `manual` (the hand-made entry's), by any instance
 * machine.toml names, by a home setup registered (its record), by a home a machine.toml instance
 * names, by another home's live row in the service (`input.rows`), and by a home earlier in the
 * survey. Claude Desktop's folders do not hold one against each other: the app uses one of them
 * (A3 3.13.3). The order is the survey's, so the preview and its apply propose the same IDs.
 */
function freeInstances(
  input: SetupInput,
  homes: readonly AgentHome[],
  records: readonly HomeRecord[],
): AgentHome[] {
  const { platform } = input;
  const recorded = (home: AgentHome) => recordOf(records, home, platform) !== undefined;
  const taken = new Set<string>([
    MANUAL_INSTANCE,
    ...input.instances.map((i) => i.id),
    ...records.map((r) => r.instance),
    ...homes.filter((h) => h.proposed !== true && !recorded(h)).map((h) => h.instance),
  ]);
  const heldByRow = (id: string, home: AgentHome) =>
    (input.rows ?? []).some(
      (row) =>
        row.instance === id && !(row.app === home.app && samePath(platform, row.home, home.home)),
    );
  const proposedHere = new Map<string, AgentApp>();
  return homes.map((home) => {
    // A proposal that is no instance ID at all is left as it is: the service refuses it by name.
    if (home.proposed !== true || recorded(home) || !INSTANCE_ID.test(home.instance)) return home;
    const free = (id: string) =>
      !taken.has(id) &&
      !heldByRow(id, home) &&
      !(
        proposedHere.has(id) &&
        !(home.app === "claude-desktop" && proposedHere.get(id) === "claude-desktop")
      );
    // A home whose own live row outlived setup's record (lost state) gets that row's instance
    // back while it is free, so the sessions bound to it go on.
    const own = (input.rows ?? []).find(
      (row) =>
        row.app === home.app &&
        samePath(platform, row.home, home.home) &&
        INSTANCE_ID.test(row.instance) &&
        free(row.instance),
    );
    let id = own?.instance ?? home.instance;
    // Ends: each n gives another ID, and only finitely many are held.
    for (let n = 2; !free(id); n += 1) {
      const suffix = `-${String(n)}`;
      id = `${home.instance.slice(0, 40 - suffix.length).replace(/-+$/u, "")}${suffix}`;
    }
    proposedHere.set(id, home.app);
    return id === home.instance ? home : { ...home, instance: id };
  });
}

/**
 * The `--instance` an entry's arguments name, read with the bridge's own parser: the ID, null for
 * an entry without one (a hand-made entry, A3 3.7.4), or undefined for arguments the bridge would
 * refuse or an entry that is not `<command> mcp …`.
 */
export function entryInstance(entry: unknown): string | null | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const args = jsonCopy((entry as { args?: unknown }).args);
  if (!Array.isArray(args) || args[0] !== "mcp" || !args.every((a) => typeof a === "string")) {
    return undefined;
  }
  const parsed = parseArgs(args.slice(1));
  return "problem" in parsed ? undefined : parsed.instance;
}

/**
 * The app's own command that takes an entry of Tasks's name out of a home, as a person runs it: the
 * app's word on the PATH, its `mcp remove`, and the home's variable for a home that is not the
 * default (A3 3.7.8: how to take out an entry added by hand). Claude Desktop has no command: its
 * entry is a member of its file.
 */
export function handRemoval(
  home: AgentHome,
  platform: NodeJS.Platform,
): { argv: string[]; set: Record<string, string> } | undefined {
  if (home.app === "claude-desktop") return undefined;
  return {
    argv: [home.app === "codex" ? "codex" : "claude", ...removeArgs(home.app)],
    set: commandEnv({ env: {}, platform }, home).set,
  };
}

/** The homes T3's provider instances use (A3 3.13.6), for doctor's `t3.homes`. */
export function t3HomesOf(input: SetupInput): readonly T3Home[] {
  return hasT3(input) ? t3Homes(input, readT3Settings(input)) : [];
}

// ---------------------------------------------------------------------------------------------
// The change

/** The environment of the app's command for a home (A4 3.8's rule for the home variables). */
export function commandEnv(
  input: Pick<SetupInput, "env" | "platform">,
  home: AgentHome,
): { env: Env; set: Record<string, string>; unset: string[] } {
  const fold = (name: string) => (input.platform === "win32" ? name.toUpperCase() : name);
  const scrub = new Set(HOME_VARIABLES.map(fold));
  const env: Record<string, string | undefined> = {};
  const unset: string[] = [];
  for (const [name, value] of Object.entries(input.env)) {
    if (scrub.has(fold(name))) {
      if (value !== undefined && value !== "") unset.push(name);
      continue;
    }
    env[name] = value;
  }
  const set: Record<string, string> = {};
  if (home.variable !== "" && !(home.app === "claude-code" && home.isDefault)) {
    set[home.variable] = home.home;
  }
  return { env: { ...env, ...set }, set, unset: unset.sort() };
}

/** The entry's argv: Tasks's command with the bridge's arguments (A3 3.13.2-3.13.4). */
export function entryArgv(tasks: string, home: AgentHome, space: string): string[] {
  return [tasks, "mcp", "--space", space, "--instance", home.instance, "--app", home.app];
}

/** Claude Desktop's entry as setup writes it (A3 3.13.3): only the command and its arguments. */
export const desktopEntry = (argv: readonly string[]) => ({
  command: argv[0] ?? "",
  args: argv.slice(1),
});

function addArgs(app: AgentApp, entry: readonly string[]): string[] {
  if (app === "claude-code")
    return ["mcp", "add", "--scope", "user", MCP_SERVER_KEY, "--", ...entry];
  if (app === "codex") return ["mcp", "add", MCP_SERVER_KEY, "--", ...entry];
  return [];
}

function removeArgs(app: AgentApp): string[] {
  if (app === "claude-code") return ["mcp", "remove", MCP_SERVER_KEY, "--scope", "user"];
  if (app === "codex") return ["mcp", "remove", MCP_SERVER_KEY];
  return [];
}

/** Codex: the keys Tasks patches into its own table (A3 3.13.4, 3.7.2). */
function codexPatches(): { key: string; value: EditValue }[] {
  return [
    // Codex passes the agent only an allow-list of variables: the ticket must be named (3.7.2).
    { key: "env_vars", value: [envVar("TICKET")] },
    { key: "startup_timeout_sec", value: CODEX_STARTUP_TIMEOUT_SEC },
  ];
}

/** The key-level diff of a change, as the preview shows it. */
function diffOf(app: AgentApp, entry: readonly string[], parent: boolean): string[] {
  if (app !== "codex") {
    const servers = APPS[app].servers;
    const at = `${servers}.${MCP_SERVER_KEY}`;
    return [
      ...(parent ? [] : [`+ ${servers} = {}`]),
      `+ ${at}.command = ${JSON.stringify(entry[0])}`,
      `+ ${at}.args = ${JSON.stringify(entry.slice(1))}`,
    ];
  }
  return [
    `+ [${APPS.codex.servers}.${keyText(MCP_SERVER_KEY)}]`,
    `+ command = ${valueText(entry[0] ?? "")}`,
    `+ args = ${valueText(entry.slice(1))}`,
    ...codexPatches().map((p) => `+ ${keyText(p.key)} = ${valueText(p.value)}`),
  ];
}

/** What applying a home would run and write, or why it cannot. Reads nothing more. */
export function planChange(input: SetupInput, view: HomeView, space: string): Change | Refusal {
  const { home } = view;
  const writer = APPS[home.app].writer;
  // Claude Desktop makes its file in its developer settings; setup never creates it.
  if (writer === "edit" && view.sha256 === null) return "not_set_up";
  const exec = writer === "edit" ? [] : commandFor(input, home);
  if (exec === undefined) return "no_command";
  const entry = entryArgv(input.tasks, home, space);
  const { set, unset } = writer === "edit" ? { set: {}, unset: [] } : commandEnv(input, home);
  return {
    writer,
    exec,
    args: addArgs(home.app, entry),
    undo: removeArgs(home.app),
    entry,
    set,
    unset,
    patches: home.app === "codex" ? codexPatches() : [],
    diff: diffOf(home.app, entry, view.parent),
  };
}

/** One selected home in a plan: as found, and the change apply would make there. */
export interface PlanItem {
  readonly view: HomeView;
  /** The change for a home without an entry, or why it cannot get one; undefined otherwise. */
  readonly change: Change | Refusal | undefined;
}

/** Whether a file is there, a link or one setup refuses to read included. */
function fileThere(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The plan of a preview: each selected home's change, for the space new entries name. Claude
 * Desktop has one configuration file in use: when the selection holds several, none is changed
 * until `--home` names one (A3 3.13.3: "setup shows them and asks"). Every file there counts, one
 * setup refuses to read too: the app may be using it.
 */
export function planOf(input: SetupInput, views: readonly HomeView[], space: string): PlanItem[] {
  const desktops = views.filter(
    (v) =>
      v.home.app === "claude-desktop" &&
      (v.sha256 !== null || (v.state === "refused" && fileThere(v.home.file))),
  );
  return views.map((view) => ({
    view,
    change:
      view.state !== "not_registered"
        ? undefined
        : view.home.app === "claude-desktop" && desktops.length > 1
          ? "ambiguous"
          : planChange(input, view, space),
  }));
}

/**
 * The plan's token (A3 3.13.1): a digest of what apply would do in the selected
 * homes, which the preview prints and `--apply --plan` checks again under the lock, so apply does
 * exactly what the preview showed or refuses. It covers the space, each home with its file,
 * instance, account, hosts and state (everything the home's row names) and, for a change, the
 * exact command, its environment and the diff, and the hash of a file Tasks writes into (a Codex
 * file, which Tasks's patches are spliced into, and Claude Desktop's). Claude Code's `.claude.json`
 * is covered by its state and diff but not its hash: Claude Code rewrites it while it runs, and
 * Tasks never edits it (the app's own command does).
 */
export function planToken(space: string, items: readonly PlanItem[]): string {
  const canonical = items.map(({ view, change }) => [
    view.home.app,
    view.home.home,
    view.home.file,
    view.home.instance,
    // The row apply makes names the account and the hosts too.
    view.home.account,
    view.home.hosts,
    view.state,
    view.refusal ?? null,
    view.record?.space ?? null,
    change === undefined
      ? null
      : typeof change === "string"
        ? change
        : [
            change.exec,
            change.args,
            Object.entries(change.set),
            change.unset,
            change.diff,
            view.home.app === "claude-code" ? null : view.sha256,
          ],
  ]);
  return createHash("sha256")
    .update(JSON.stringify([space, canonical]))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Apply and remove

function putRecord(stateDir: string, platform: NodeJS.Platform, record: HomeRecord): void {
  const others = readRecords(stateDir).filter(
    (r) => !(r.app === record.app && samePath(platform, r.home, record.home)),
  );
  writeRecords(stateDir, [...others, record]);
}

function dropRecord(stateDir: string, platform: NodeJS.Platform, home: AgentHome): void {
  const records = readRecords(stateDir);
  const kept = records.filter(
    (r) => !(r.app === home.app && samePath(platform, r.home, home.home)),
  );
  if (kept.length !== records.length) writeRecords(stateDir, kept);
}

/** A Codex file that apply created and that the undo left empty: removed, as before the apply. */
function removeEmptyFile(home: AgentHome, record: Pick<HomeRecord, "file_existed">): boolean {
  if (home.app !== "codex" || record.file_existed) return false;
  const read = readHomeFile(home);
  if (read.kind !== "read" || read.bytes.length !== 0) return false;
  rmSync(home.file, { force: true });
  return true;
}

/** Writes `text` over the bytes `before` setup read, with the home's own rule for the file. */
function writeHomeFile(home: AgentHome, before: Buffer, bom: boolean, text: string): boolean {
  const whole = `${bom ? BOM : ""}${text}`;
  if (Buffer.byteLength(whole, "utf8") > APPS[home.app].maxBytes) return false;
  // The home's own rule, not machine.toml's: readHomeFile judged the file and its folder just
  // before, and judges them again here.
  return commitEdit(
    { path: home.file, before, text: whole },
    { unsafe: () => readHomeFile(home).kind === "refused", maxBytes: APPS[home.app].maxBytes },
  ).ok;
}

/**
 * Takes setup's entry out of a home whose file `read` was just read and shows an entry that
 * ownEntry accepts: the app's own remove, or for an app setup edits itself the splice that undoes
 * its own (with the servers' table when setup made it and nothing else is left in it). True when
 * the take-back ran; the caller reads the file again to see that the entry is gone.
 */
async function takeBack(
  input: SetupInput,
  home: AgentHome,
  record: HomeRecord,
  read: Extract<FileRead, { kind: "read" }>,
): Promise<boolean> {
  if (editsFile(home.app)) {
    const edited = removeEntry(
      read.text,
      APPS[home.app].servers,
      MCP_SERVER_KEY,
      !record.parent_existed,
    );
    return edited.ok && writeHomeFile(home, read.bytes, read.bom, edited.text);
  }
  const exec = commandFor(input, home);
  if (exec === undefined) return false;
  const { env } = commandEnv(input, home);
  return input.run([...exec, ...record.undo], env);
}

/**
 * Registers Tasks in one home that has no entry yet. The record is written before anything is
 * written to the home; a failure after it takes the entry back when it is provably setup's, so
 * nothing is left half done. `grant` is the agent-home row the service keeps for this home (A2
 * 3.2.5). `planned` is the change the plan holds for it (planOf), when the caller has one.
 */
export async function applyHome(
  input: SetupInput,
  view: HomeView,
  space: string,
  grant: string | null,
  planned?: Change | Refusal,
): Promise<Outcome> {
  const { home } = view;
  if (view.state === "registered") {
    if (view.record !== undefined && view.record.space !== space) {
      return { home, result: "left", reason: "other_space" };
    }
    if (view.record !== undefined && view.record.grant !== grant) {
      putRecord(input.stateDir, input.platform, { ...view.record, grant });
    }
    return { home, result: "unchanged" };
  }
  if (view.state === "refused")
    return { home, result: "left", reason: view.refusal ?? "unreadable" };
  if (view.state !== "not_registered") return { home, result: "left", reason: view.state };
  const change = planned ?? planChange(input, view, space);
  if (typeof change === "string") return { home, result: "left", reason: change };

  // A3 3.13.1: re-read the target and stop when it moved since the plan read it.
  const now = readHomeFile(home);
  const nowHash = now.kind === "read" ? now.sha256 : null;
  if (now.kind === "refused" || nowHash !== view.sha256 || entryOf(now) !== undefined) {
    return { home, result: "failed", reason: "changed_meanwhile" };
  }
  const editing = change.writer === "edit";
  const record: HomeRecord = {
    app: home.app,
    home: home.home,
    file: home.file,
    is_default: home.isDefault,
    instance: home.instance,
    account: home.account,
    space,
    state: "applying",
    file_existed: view.sha256 !== null,
    parent_existed: view.parent,
    sha256_before: view.sha256,
    sha256_after: null,
    args: change.args,
    undo: change.undo,
    entry_argv: change.entry,
    env: change.set,
    // Setup writes this entry itself: it is known, and recorded, before the write.
    entry: editing ? desktopEntry(change.entry) : null,
    patches: [],
    grant,
    at: new Date().toISOString(),
  };
  putRecord(input.stateDir, input.platform, record);
  /** The record as last written: after the command's entry is checked, it holds that entry. */
  let known: HomeRecord = record;

  /**
   * Takes the change back as far as it went, then reports the failure. The take-back removes
   * whatever entry of Tasks's name is there, so it runs only after a fresh read shows a file setup
   * accepts and an entry that is setup's (ownEntry: before the checkpoint one exactly as asked,
   * after it the checkpoint's entry, with or without Tasks's patches). Otherwise nothing runs and
   * the `applying` record stays for `--remove`, with one exception: when the command failed, an
   * entry that is not exactly as asked is not the command's (another one appeared meanwhile and the
   * app refused to overwrite it), so it is left and the record goes.
   */
  const fail = async (reason: OutcomeReason, commandFailed = false): Promise<Outcome> => {
    const current = readHomeFile(home);
    const entry = entryOf(current);
    const kept = (note: string): Outcome => ({ home, result: "failed", reason, notes: [note] });
    if (current.kind === "refused") return kept("undo_failed");
    if (entry !== undefined && !ownEntry(entry, known)) {
      if (!commandFailed) return kept("entry_left");
      dropRecord(input.stateDir, input.platform, home);
      return { home, result: "failed", reason: "changed_meanwhile" };
    }
    if (entry !== undefined && current.kind === "read") {
      const undone = await takeBack(input, home, known, current);
      const again = readHomeFile(home);
      if (!undone || again.kind === "refused" || entryOf(again) !== undefined) {
        // The entry may still be there: the record stays, so `--remove` can take it back.
        return kept("undo_failed");
      }
    }
    removeEmptyFile(home, record);
    dropRecord(input.stateDir, input.platform, home);
    return { home, result: "failed", reason };
  };

  if (editing) {
    // One entry spliced into the file as read just now; the write is refused when the file changed
    // since that read, and then nothing was written.
    if (now.kind !== "read") return fail("changed_meanwhile");
    const edited = addEntry(now.text, APPS[home.app].servers, MCP_SERVER_KEY, record.entry);
    if (!edited.ok)
      return fail(edited.reason === "invalid_file" ? "invalid_file" : "unsupported_layout");
    if (!writeHomeFile(home, now.bytes, now.bom, edited.text)) return fail("changed_meanwhile");
    const written = readHomeFile(home);
    if (written.kind !== "read" || !sameEntry(written.entry, record.entry)) {
      return fail("unexpected_entry");
    }
    putRecord(input.stateDir, input.platform, {
      ...record,
      state: "applied",
      sha256_after: written.sha256,
    });
    return { home, result: "applied" };
  }

  const { env } = commandEnv(input, home);
  if (!(await input.run([...change.exec, ...change.args], env))) {
    return fail("command_failed", true);
  }
  const added = readHomeFile(home);
  const written = added.kind === "read" ? jsonCopy(added.entry) : undefined;
  if (added.kind !== "read" || written === undefined || !runs(written, change.entry)) {
    return fail("unexpected_entry");
  }
  // The checkpoint: the entry as the command wrote it, and the patches about to be written. From
  // here an interrupted apply takes back only these (ownEntry).
  const addedEntry = written as Record<string, unknown>;
  const patches = change.patches.map((patch) => ({
    key: patch.key,
    before: addedEntry[patch.key] ?? null,
    after: patch.value,
  }));
  known = { ...record, entry: written, patches };
  putRecord(input.stateDir, input.platform, known);

  let final = added;
  if (patches.length > 0) {
    const edited = applyEdits(
      added.text,
      change.patches.map((patch) => ({
        op: "set" as const,
        table: [APPS.codex.servers, MCP_SERVER_KEY],
        key: patch.key,
        value: patch.value,
      })),
    );
    if (!edited.ok) {
      return fail(
        edited.reason === "unsupported_layout" ? "unsupported_layout" : "unexpected_entry",
      );
    }
    if (Buffer.byteLength(`${added.bom ? BOM : ""}${edited.text}`, "utf8") > MAX_CONFIG_BYTES) {
      return fail("too_large");
    }
    if (!writeHomeFile(home, added.bytes, added.bom, edited.text)) {
      return fail("changed_meanwhile");
    }
    const reread = readHomeFile(home);
    if (reread.kind !== "read") return fail("unexpected_entry");
    final = reread;
  }
  // What is there now is exactly the command's entry with Tasks's patches, or the apply is undone.
  const entry = jsonCopy(final.entry);
  if (entry === undefined || !isDeepStrictEqual(entry, patched(written, patches))) {
    return fail("unexpected_entry");
  }
  putRecord(input.stateDir, input.platform, {
    ...known,
    state: "applied",
    sha256_after: final.sha256,
    entry,
  });
  return { home, result: "applied" };
}

/**
 * Takes Tasks's entry out of one home, when the entry is still exactly the one setup wrote
 * (ownEntry): with the app's own command, or for an app setup edits itself with the splice that
 * undoes its own. An entry the person changed since is left alone and reported. The home is read
 * again right before: the view may be older than the entry.
 */
export async function removeHome(input: SetupInput, view: HomeView): Promise<Outcome> {
  const { home, record } = view;
  if (record === undefined) return { home, result: "unchanged", reason: "not_registered" };
  const now = inspectHome(home, record);
  if (now.state === "refused") {
    return { home, result: "left", reason: now.refusal ?? "unreadable" };
  }
  if (now.entry === undefined) {
    removeEmptyFile(home, record);
    dropRecord(input.stateDir, input.platform, home);
    return { home, result: "removed", reason: "missing" };
  }
  if (!ownEntry(now.entry, record)) return { home, result: "left", reason: "edited" };
  if (!editsFile(home.app) && commandFor(input, home) === undefined) {
    return { home, result: "left", reason: "no_command" };
  }
  const read = readHomeFile(home);
  if (read.kind !== "read" || !ownEntry(read.entry, record)) {
    return { home, result: "failed", reason: "changed_meanwhile" };
  }
  const ran = await takeBack(input, home, record, read);
  const after = readHomeFile(home);
  if (!ran || after.kind === "refused" || entryOf(after) !== undefined) {
    return {
      home,
      result: "failed",
      reason: editsFile(home.app) ? "changed_meanwhile" : "command_failed",
    };
  }
  const notes: string[] = [];
  removeEmptyFile(home, record);
  if (
    home.app === "claude-code" &&
    !record.parent_existed &&
    after.kind === "read" &&
    after.parent
  ) {
    // `claude mcp remove` keeps the `mcpServers` object it made, empty (lab run A, row A01), and
    // `.claude.json` is never edited by Tasks.
    notes.push("empty_parent_kept");
  }
  dropRecord(input.stateDir, input.platform, home);
  return { home, result: "removed", ...(notes.length === 0 ? {} : { notes }) };
}
