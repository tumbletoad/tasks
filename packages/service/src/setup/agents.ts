// `ttasks setup agents` (A3 3.13; M2.14, M4.05): TTasks's MCP server entry in each agent home of this
// machine, which setup writes itself, one entry spliced into the app's file, and takes back
// exactly. Never through the app's own `mcp add` or `mcp remove`: Codex's rewrites every other
// server's table (losing comments, unknown keys and servers another program added meanwhile), and
// what a command wrote can only be read back, which would make a change the person made at that
// moment TTasks's own.
//
// The agent-home table (APPS below) has one row per app: its catalogue target, its file's format,
// the servers' table, the file's bound, and whether the app's own lock guards the file:
// - Claude Code (A3 3.13.2): `mcpServers.<key>` in `.claude.json` (entry.ts, json-edit.ts). Claude
//   Code rewrites that file while a session runs, under a lock of its own, which setup takes for
//   the last step of its write (app-lock.ts).
// - Codex (A3 3.13.4): one `[mcp_servers.<key>]` table in `config.toml` with the ticket's variable
//   and the cold-start allowance, through machine.toml's format-keeping editor (config/edit.ts).
// - Claude Desktop (A3 3.13.3): `mcpServers.<key>` in `claude_desktop_config.json`. Setup never
//   creates that file: the app makes it the first time its developer settings are opened.
// Every write is a new file written and flushed beside the old one, then the file read again and
// compared just before the new one is renamed over it, with its mode; a file that changed
// meanwhile is left alone, and one that was not there is linked into place exclusively. The Codex
// app and T3 Code have no entry of their own (A3 3.13.5, 3.13.6): they read the homes of the CLIs,
// so they are hosts of those homes (hosts.ts). T3's settings are read, never written.
//
// What setup changes, and only that: the entry named after the product (brand's MCP_SERVER_KEY).
// Never a trust or approval setting, a permission, a hook, another server's entry, a managed file
// or a key setup did not write; never a sign-in file or a token (A3 3.13.1).
//
// - Before anything is written, the home's record is written ("applying"): the app, the home, the
//   entry exactly as setup intends it and what the write makes beside it. It holds no copy of the
//   file and no other key's value (A3 3.13.1: these files hold other servers' secrets). `--remove`
//   takes back only an entry that is still exactly that one; one the person changed is theirs.
// - A home gets its access (its agent-home row, Access) only once its entry is in place, and only
//   from the apply the person asked for. Turning it off asks for the revoke first, before anything
//   else is written; the file is cleaned only after the service confirmed it. A record a run left
//   midway is finished by the next setup as a removal (settleHomes).
// - A home whose file setup does not understand is refused with a reason and nothing is written
//   there: a file that is not UTF-8 JSON or TOML, a duplicate key, a managed file (a link, a file
//   marked as generated, one machine.toml lists, one another git repository tracks), servers
//   written in a layout the editor cannot keep (Codex), or an entry of the same name that setup did
//   not write.
//
// Every path, variable and file read goes through the injected input, so tests run on scratch
// homes.
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MCP_SERVER_KEY } from "@ttasks/brand";
// The bridge's own parser by its own path: the bridge's index would bring its runner into bundles.
import { parseArgs } from "@ttasks/bridge/mcp/args";
import {
  HOME_VARIABLES,
  INSTANCE_ID,
  instanceHome,
  isTable,
  MANUAL_INSTANCE,
  nodeDetectHost,
  onPath,
  proposedAccount,
  proposedInstanceId,
  targetDef,
  type BuiltInTargetId,
  type Detection,
  type Env,
  type Instance,
} from "@ttasks/launch";
import { keyText, valueText, type EditValue } from "../config/edit.ts";
import { scanToml, ScanError } from "../config/scan.ts";
import { BOM, MAX_CONFIG_BYTES, parseToml, readConfigFile } from "../config/toml.ts";
import { stageFile, type StagedFile } from "../hub/files.ts";
import {
  toolsAnswer,
  type FileFacts,
  type FileState,
  type HomeState,
  type Refusal,
  type ToolsAnswer,
} from "./answer.ts";
import { withAppLock } from "./app-lock.ts";
import {
  addOwnEntry,
  holdsNothing,
  intendedEntry,
  removeOwnEntry,
  whoseEntry,
  type EntryFormat,
} from "./entry.ts";
import {
  claudeDesktopFolders,
  codexAppEngines,
  codexSharedHome,
  DESKTOP_FILE,
  hasT3,
  t3Homes,
  t3InstanceId,
  t3ProviderInstances,
  t3SettingsFile,
  type HostsInput,
  type T3Home,
  type T3Settings,
} from "./hosts.ts";
import { markedAsGenerated } from "./generated.ts";
import { parseStrictJson } from "./json.ts";
import { listedAsManaged, trackedByAnotherRepository } from "./managed.ts";
import {
  AGENT_APPS,
  isAgentApp,
  readRecords,
  recordFiles,
  SetupStateInvalid,
  SetupStateTooLarge,
  SetupStateUnsafe,
  writeRecords,
  type AgentApp,
  type HomeRecord,
  type Made,
} from "./state.ts";

export { CODEX_STARTUP_TIMEOUT_SEC } from "./entry.ts";

/** One row of the agent-home table: how setup reads and writes an app's entry. */
interface AppRow {
  /** The app's catalogue target (A4 3.2): its label, its home folders and their variable. */
  readonly target: BuiltInTargetId;
  readonly format: EntryFormat;
  /** The servers' table in the app's file. */
  readonly servers: string;
  /** The file's bound: a larger file is refused unread. */
  readonly maxBytes: number;
  /** The app's own writers take `<file>.lock` (app-lock.ts), and so does setup. */
  readonly locked: boolean;
}

const APPS: Readonly<Record<AgentApp, AppRow>> = {
  "claude-code": {
    target: "claude-cli",
    format: "json",
    servers: "mcpServers",
    // `.claude.json` keeps every project's history, so it can be far larger than a configuration
    // file: machine.toml's 1 MiB bound would refuse it.
    maxBytes: 64 * 1024 * 1024,
    locked: true,
  },
  codex: {
    target: "codex-cli",
    format: "toml",
    servers: "mcp_servers",
    maxBytes: MAX_CONFIG_BYTES,
    locked: false,
  },
  "claude-desktop": {
    target: "claude-desktop",
    format: "json",
    servers: "mcpServers",
    maxBytes: 4 * 1024 * 1024,
    locked: false,
  },
};

/** Claude Code's user-scope file: in the user's home folder for the default home, else in the home. */
const CLAUDE_FILE = ".claude.json";
/** Codex's configuration file in a Codex home. */
const CODEX_FILE = "config.toml";
/** The label of each app, from the catalogue. */
export const appLabel = (app: AgentApp): string => targetDef(APPS[app].target).label;
/** Other apps that read a home's entry (A3 3.13.5, 3.13.6): attribution can say "via T3". */
export const HOSTS = ["codex-app", "t3"] as const;
export type Host = (typeof HOSTS)[number];

/** One agent home: where an app reads its MCP servers (A3 "agent home"). */
export interface AgentHome {
  readonly app: AgentApp;
  /** The home folder: `~/.claude`, `~/.codex`, `~/.codex-work`, one a variable names, or the folder of Claude Desktop's file. */
  readonly home: string;
  /** The settings files a program reads this home's entry from (homeFiles), each holding the same entry. */
  readonly files: readonly string[];
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
  /**
   * Codex shadow homes that read this home's file through a link (hosts.ts `codexSharedHome`):
   * never homes of their own, so Codex run in one of them reads this entry.
   */
  readonly shadows?: readonly string[];
  /** Those of `files` that A3 3.12 rules 3 and 4 make managed: machine.toml lists it, or another git repository tracks it. */
  readonly managed: readonly string[];
}

/** One settings file of a home as setup finds it now. */
export interface FileView {
  readonly file: string;
  /** What the file holds of setup's, judged against the home's record (answer.ts `FileState`). */
  readonly state: FileState;
  readonly refusal?: Refusal;
  /** SHA-256 of the file as read; null when there is no file. */
  readonly sha256: string | null;
  /** What a plan of the file is bound to (boundOf); null when it cannot be read. */
  readonly bound: string | null;
  /** Whether the servers' table (`mcpServers`, `mcp_servers`) exists. */
  readonly parent: boolean;
  /** TTasks's entry as found, when there is one. TTasks's own data: never another key's value. */
  readonly entry?: unknown;
}

/** A home as setup finds it now: the home's state, from each of its files (homeState). */
export interface HomeView {
  readonly home: AgentHome;
  readonly state: HomeState;
  readonly refusal?: Refusal;
  /** Each of `home.files`, in order. */
  readonly files: readonly FileView[];
  readonly record?: HomeRecord;
}

/** What setup writes for one home: the one entry, into each of the files that take it. */
export interface Change {
  /** The entry setup writes, exactly: its keys and values. */
  readonly entry: Readonly<Record<string, EditValue>>;
  /** Each file the entry goes into, with the lines it gains (JSON: its servers' table first when it is new). */
  readonly writes: readonly { readonly file: string; readonly diff: readonly string[] }[];
}

export type OutcomeReason =
  | Refusal
  | "edited"
  | "interrupted"
  | "missing"
  | "not_registered"
  | "changed_meanwhile"
  | "unexpected_entry"
  | "other_space"
  /** Claude Code kept its own lock on the file through every pause: another writer is busy. */
  | "busy"
  /** The service did not give the home its agent-home row, so its entry was taken out again. */
  | "grant_failed"
  /** The service refused the row: another home's live row holds this instance (A3 3.7.8). */
  | "instance_taken"
  /** The service did not confirm that it took the home's access back: nothing else was changed. */
  | "revoke_failed"
  /** The OS refused to write the file: it is read-only, another program holds it, or the disk is full. */
  | "unwritable"
  /** The tools cannot be turned on from here (answer.ts `ToolsWhy`). */
  | "moved"
  | "not_installed"
  | "edited_gone"
  | "access_off"
  | "entry_left"
  /** Setup's own record of the home could not be written, so its file was left as it was. */
  | "state_unwritable"
  /** One of the home's files has no entry while another has (answer.ts `ToolsWhy`). */
  | "file_lacks"
  /** The service did not say whether the home has its access, so none was given back. */
  | "access_unknown";

/** What happened to one home. */
export interface Outcome {
  readonly home: AgentHome;
  readonly result: "applied" | "removed" | "unchanged" | "left" | "failed";
  readonly reason?: OutcomeReason;
  /**
   * The home's access as this action left it, apart from its files, as far as it is known: `on`
   * while its row is live, `off` when it has none, `unknown` when the service was asked and did not
   * confirm, or was not there to ask. Absent when the action did not touch the home.
   */
  readonly access?: "on" | "off" | "unknown";
  /** A removal that left an entry in the file: TTasks's own (`reason` says why), or one the person changed. */
  readonly kept?: "own" | "edited";
  /** The file `reason` or `kept` is about. */
  readonly file?: string;
  /** Facts the person should know: `undo_failed`, `entry_left`, `undone` (its entry was taken out again). */
  readonly notes?: readonly string[];
}

/** The service refused a home's row: `instance_taken`, or `grant_failed` for any other reason. */
export class GrantRefused extends Error {
  override readonly name = "GrantRefused";
  readonly reason: "instance_taken" | "grant_failed";
  constructor(reason: "instance_taken" | "grant_failed") {
    super(`The service refused the agent home's row: ${reason}`);
    this.reason = reason;
  }
}

/**
 * A home's access to TTasks: its agent-home row in the service's grants table, which the grant gate
 * reads at every call (hub/agent-homes.ts). Setup gives it only once the home's entry is in place,
 * and takes it back before it touches the file, so an entry that failed or a file that cannot be
 * written never leaves a home with access it should not have.
 */
export interface Access {
  /** Gives the home its row for `space`, or keeps the one it has: the row's ID. Throws when refused. */
  grant(home: AgentHome, space: string): Promise<string>;
  /** Takes back every live row of the home. Throws when that could not be done. */
  revoke(home: AgentHome): Promise<void>;
}

/** What setup reads, injected so tests use scratch homes (and doctor's probes fake commands). */
export interface SetupInput {
  readonly platform: NodeJS.Platform;
  /** The user's home folder: Claude Code's default `.claude.json` is here. */
  readonly userHome: string;
  /** The person's environment, in which detection and doctor's probes run the apps' commands. */
  readonly env: Env;
  /** `<state>`: setup's record lives in `<state>/setup/`. */
  readonly stateDir: string;
  /** TTasks's stable command, which every entry runs (A2 3.12; never a moving version). */
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
    /** The row's ID, when the caller keeps it (the command line's status shows it). */
    readonly grant?: string;
    /** The space the row grants, when the caller keeps it. */
    readonly space?: string;
  }[];
  /** machine.toml's `[setup.managed] paths` (A3 3.12 rule 4). Default: none. */
  readonly managedPaths?: readonly string[];
  /** git's command for A3 3.12 rule 3, as an argv prefix. Default: `git` on `env`'s PATH. */
  readonly git?: readonly string[];
  /** macOS: the system's Applications folder (the Codex app's engine). Default: /Applications. */
  readonly systemApplications?: string;
  isFolder(path: string): boolean;
  /** Runs `argv` without a shell in `env`; true when it exits 0 within its bound (doctor's probes). */
  run(argv: readonly string[], env: Env): Promise<boolean>;
  /** Waits `ms` while another writer holds an app's lock. Default: a timer. */
  readonly wait?: (ms: number) => Promise<void>;
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

/** How long a click or a run's start waits for a home's folder to say what it really is. */
const PHYSICAL_HOME_MS = 1_000;

/**
 * An agent home with its links resolved, as TTAM reports a home: the folder it really is when it
 * exists and answers in time, else as it is spelled. Asked off the service's thread and bounded,
 * because a home may be on a share that answers slowly or not at all.
 */
export async function physicalHome(
  platform: NodeJS.Platform,
  home: string,
  withinMs: number = PHYSICAL_HOME_MS,
): Promise<string> {
  if (platform !== process.platform) return home;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>((done) => {
    timer = setTimeout(() => {
      done(home);
    }, withinMs);
    timer.unref();
  });
  try {
    return await Promise.race([realpath(home).catch(() => home), late]);
  } finally {
    clearTimeout(timer);
  }
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * An agent home as a launch or a run records it, and as the link to TTAM's homes compares it: a
 * digest of the folder it really is, compared as `samePath` compares paths. `home` is that
 * folder already: `physicalHome` of a home from TTasks' settings, or the path TTAM reports, which
 * it resolves itself. No file is touched here. A space never holds the path.
 */
export function homeDigest(platform: NodeJS.Platform, home: string): string {
  const path = pathOf(platform).resolve(home);
  const folded = platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;
  return createHash("sha256").update(`agent-home\0${folded}`).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// The homes

/**
 * The home an instance runs, and whether it is the app's default: launch's rule (A4 3.2,
 * `instanceHome` in @ttasks/launch), so setup registers the entry in the home the agent uses.
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

/** The app whose entry an agent of this catalogue target reads: Claude Code's or Codex's. */
export const agentAppOf = (target: string): AgentApp | undefined =>
  AGENT_APPS.find((a) => a !== "claude-desktop" && APPS[a].target === target);

/**
 * The app and the home an instance's agent is started on, as setup names that home (agentHomes):
 * launch's rule, and for Codex the shared home a shadow home reads. No home when nothing names
 * one; undefined for an instance whose agent reads no entry of setup's.
 */
export function agentHomeOf(
  instance: Pick<Instance, "target" | "env" | "configHome">,
  userHome: string | undefined,
  platform: NodeJS.Platform,
): { readonly app: AgentApp; readonly home?: string } | undefined {
  const app = agentAppOf(instance.target);
  if (app === undefined) return undefined;
  const path = instanceHome(instance, userHome, platform)?.path;
  if (path === undefined) return { app };
  return { app, home: (app === "codex" ? codexSharedHome(platform, path) : undefined) ?? path };
}

/**
 * The settings file a program reads a home's entry from: for Claude Code's default home started
 * with no variable (`isDefault`) the user's `~/.claude.json`, else the file inside the home.
 */
export function settingsFile(
  platform: NodeJS.Platform,
  userHome: string,
  app: AgentApp,
  home: string,
  isDefault: boolean,
): string {
  const p = pathOf(platform);
  if (app === "codex") return p.join(home, CODEX_FILE);
  if (app === "claude-desktop") return p.join(home, DESKTOP_FILE);
  return isDefault ? p.join(userHome, CLAUDE_FILE) : p.join(home, CLAUDE_FILE);
}

/** Claude Code's default home folder, `~/.claude`. */
const claudeDefault = (input: Pick<SetupInput, "platform" | "userHome">): string =>
  pathOf(input.platform).join(input.userHome, ".claude");

/**
 * The settings files of a home, the one place that says which. The first is the app's file for
 * the home (`isDefault`: Claude Code's default folder started with no variable reads
 * `~/.claude.json`), which setup creates when it is not there. Claude Code's default folder has a
 * second one, read when Claude Code is started with its home set to that folder (as T3 Code may
 * start it): it is a file of the home only while it is there, since the reader makes it and may
 * prefer an older file of its own until then. One that is a link to the other is that file.
 */
function homeFiles(input: SetupInput, app: AgentApp, home: string, isDefault: boolean): string[] {
  const { platform, userHome } = input;
  const first = settingsFile(platform, userHome, app, home, isDefault);
  if (app !== "claude-code" || !samePath(platform, home, claudeDefault(input))) return [first];
  const other = settingsFile(platform, userHome, app, home, !isDefault);
  if (!fileThere(other) || linksTo(platform, other, first)) return [first];
  return linksTo(platform, first, other) ? [other] : [first, other];
}

/** Whether `link` is a link whose target is `file`. */
function linksTo(platform: NodeJS.Platform, link: string, file: string): boolean {
  try {
    return (
      lstatSync(link).isSymbolicLink() && samePath(platform, realpathSync(link), realpathSync(file))
    );
  } catch {
    return false;
  }
}

/**
 * Rules 3 and 4 of A3 3.12, judged once per home and run. Rule 3 asks git (managed.ts). The
 * instruction block judges its file with the same function (block.ts).
 */
export async function managedFile(input: SetupInput, file: string, home: string): Promise<boolean> {
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
    t3: t3HomesOf(input),
  };
}

/**
 * Whether a T3 provider instance reads the entry of a home: the same app and folder. For Claude
 * Code's default folder T3 reads one of its two files (with or without CLAUDE_CONFIG_DIR), and
 * both are files of the home (homeFiles).
 */
export function readsHome(
  platform: NodeJS.Platform,
  t3: T3Home,
  app: AgentApp,
  home: string,
): boolean {
  return t3.app === app && samePath(platform, t3.home, home);
}

/** The other apps that read a home: the Codex app reads the default Codex home, T3 its instances'. */
function hostsOf(
  input: SetupInput,
  found: Discovered,
  app: AgentApp,
  home: string,
): readonly Host[] {
  const hosts: Host[] = [];
  const codexDefault = pathOf(input.platform).join(input.userHome, ".codex");
  if (app === "codex" && found.engines.length > 0 && samePath(input.platform, home, codexDefault)) {
    hosts.push("codex-app");
  }
  if (found.t3.some((t) => readsHome(input.platform, t, app, home))) {
    hosts.push("t3");
  }
  return hosts;
}

/** A home's files and which of them are managed, as discovery and a record's home both make them. */
async function filesOfHome(
  input: SetupInput,
  app: AgentApp,
  home: string,
  isDefault: boolean,
): Promise<{ files: string[]; managed: string[] }> {
  const files = homeFiles(input, app, home, isDefault);
  const managed: string[] = [];
  for (const file of files) if (await managedFile(input, file, home)) managed.push(file);
  return { files, managed };
}

/**
 * Every agent home: the homes detection found (A4 3.2: `.claude`, `.claude-<suffix>` or
 * `.claude_<suffix>`, the same for `.codex`, and the home a variable names), the homes of
 * machine.toml's instances that are folders, the homes T3's enabled provider instances use, and
 * Claude Desktop's configuration folders. A home an instance names takes the instance's ID and
 * account; any other takes detection's proposal (T3's from its folder or provider key, Claude
 * Desktop's from the catalogue).
 *
 * A Codex shadow home (its `config.toml` a link into another home, hosts.ts) is never a home of its
 * own: the home it links to is offered in its place, with the shadow named on it, and its ID comes
 * from that home's folder.
 */
export async function agentHomes(
  input: SetupInput,
  found: Discovered = discover(input),
): Promise<AgentHome[]> {
  const { platform, userHome, instances } = input;
  const p = pathOf(platform);
  const homes: AgentHome[] = [];
  const shadows: { shared: string; shadow: string }[] = [];
  const add = async (
    app: AgentApp,
    given: string,
    givenDefault: boolean,
    givenId: string,
    givenAccount: string,
  ): Promise<void> => {
    let path = given;
    let found_ = givenDefault;
    let id = givenId;
    let account = givenAccount;
    const shared = app === "codex" ? codexSharedHome(platform, given) : undefined;
    if (shared !== undefined) {
      shadows.push({ shared, shadow: p.resolve(given) });
      path = shared;
      found_ = samePath(platform, shared, p.join(userHome, ".codex"));
      id = t3InstanceId(
        { app: "codex", provider: givenId, home: shared, isDefault: found_ },
        platform,
      );
      account = proposedAccount(id === "codex" ? "" : id.replace(/^codex-/u, ""));
    }
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
    // runs Claude Code with `.claude.json` inside that folder, so that file comes first.
    const isDefault =
      owner === undefined || app === "claude-desktop"
        ? found_
        : homeOf(owner, app, userHome, platform).isDefault;
    const home = p.resolve(path);
    homes.push({
      app,
      home,
      ...(await filesOfHome(input, app, home, isDefault)),
      variable: rule?.env ?? "",
      instance: owner?.id ?? id,
      ...(owner === undefined ? { proposed: true } : {}),
      account: owner?.account ?? account,
      hosts: hostsOf(input, found, app, home),
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
    const app = agentAppOf(instance.target);
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
  return homes.map((home) => {
    if (home.app !== "codex") return home;
    const linked = shadows
      .filter((s) => samePath(platform, s.shared, home.home))
      .map((s) => s.shadow)
      .filter((s, i, all) => all.findIndex((o) => samePath(platform, o, s)) === i);
    return linked.length === 0 ? home : { ...home, shadows: linked };
  });
}

/** The app's own command as detection found it, when it can be run. */
export function commandOf(detection: Detection, app: AgentApp): readonly string[] | undefined {
  const found = detection.commands.find((c) => c.target === APPS[app].target);
  return found !== undefined && found.unusable === undefined && found.exec.length > 0
    ? found.exec
    : undefined;
}

/**
 * The app's command that reads a home, which doctor asks (`mcp get`): the app's own as detection
 * found it, else, for the home the Codex app reads, the app's bundled engine (A3 3.13.5).
 * Undefined for Claude Desktop, which has none.
 */
export function commandFor(input: SetupInput, home: AgentHome): readonly string[] | undefined {
  if (home.app === "claude-desktop") return undefined;
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

export type TextRead =
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
      /** JSON: SHA-256 of the servers' table as parsed, of `null` without one. */
      readonly servers?: string;
    };

const refused = (refusal: Refusal) => ({ kind: "refused", refusal }) as const;

const NO_SERVERS = sha256(Buffer.from(JSON.stringify(null), "utf8"));

/**
 * What a plan of a file is bound to, so that apply writes what it showed or shows it again: the
 * file as read, and for Claude Code its servers' table. Claude Code saves its own state into its
 * file while a session runs, often more than once a minute, so a plan bound to the whole file
 * would be stale before the person could apply it; apply splices its entry into the file as it
 * is then, and every other server stays as the preview found it.
 */
function boundOf(app: AgentApp, read: FileRead): string | null {
  if (read.kind === "refused") return null;
  if (app === "claude-code")
    return read.kind === "read" ? (read.servers ?? NO_SERVERS) : NO_SERVERS;
  return read.kind === "read" ? read.sha256 : "missing";
}

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

/** Why the file's place is refused before it is read: a link there, or a folder others can change. */
function placeRefusal(file: string, home: string): "managed" | "unsafe" | undefined {
  const folder = pathOf(process.platform).dirname(file);
  if (isLink(file) || (samePath(process.platform, folder, home) && isLink(folder))) {
    return "managed";
  }
  return folderUnsafe(folder) ? "unsafe" : undefined;
}

/**
 * Reads an agent app's file as text and judges it. Never writes, never opens anything else. The file
 * and the folder that holds it are checked on every read, so apply and remove check them again right
 * before they change anything: a link there (the file, or the folder when it is the home), or on
 * Linux and macOS another user's or a world-writable file or folder, is refused. The folders above
 * the home are the person's own layout (a profile on another drive, `/home` as a link on some
 * systems) and are not. The instruction block reads its file through this too (block.ts).
 */
export function readText(file: string, home: string, maxBytes: number): TextRead {
  const place = placeRefusal(file, home);
  if (place !== undefined) return refused(place);
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

function readJson(
  text: string,
  servers: string,
): { parent: boolean; entry: unknown; servers: string } | Refusal {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return parsed.reason;
  const doc = parsed.value;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return "wrong_type";
  const table = (doc as Record<string, unknown>)[servers];
  const digest = sha256(Buffer.from(JSON.stringify(table ?? null), "utf8"));
  if (table === undefined) return { parent: false, entry: undefined, servers: digest };
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    return "wrong_type";
  }
  return {
    parent: true,
    entry: Object.hasOwn(table, MCP_SERVER_KEY)
      ? (table as Record<string, unknown>)[MCP_SERVER_KEY]
      : undefined,
    servers: digest,
  };
}

function readToml(text: string): { parent: boolean; entry: unknown } | Refusal {
  // A file another tool generates: a comment near its top says so (A3 3.12 rule 2).
  if (markedAsGenerated(text, "toml")) return "managed";
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
  // with dotted keys from above its table is a layout the editor cannot place TTasks's table beside.
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

/** Reads and judges one of a home's files (readText's checks, then the app's format). Never writes. */
function readHomeFile(home: AgentHome, file: string): FileRead {
  if (home.managed.includes(file)) return refused("managed");
  const row = APPS[home.app];
  const read = readText(file, home.home, row.maxBytes);
  if (read.kind !== "text") return read;
  const judged = row.format === "toml" ? readToml(read.text) : readJson(read.text, row.servers);
  if (typeof judged === "string") return refused(judged);
  return { ...read, kind: "read", ...judged };
}

/**
 * T3's settings, read-only through the same reader (A3 3.13.6 step 1): the provider instances of
 * a driver TTasks knows, with their homes, or undefined when T3 is not on this machine. A file that
 * is not there, or that setup does not accept, leaves T3's default instances (`file` says which).
 *
 * A Codex instance whose home is itself a shadow home (hosts.ts `codexSharedHome`) reads the shared
 * home's file, so its home is the shared one and the shadow is named on it: setup's homes, T3's
 * hosts and doctor then all speak of the one home that holds the entry.
 */
export function t3SettingsOf(input: HostsInput): T3Settings | undefined {
  if (!hasT3(input)) return undefined;
  const p = pathOf(input.platform);
  const file = t3SettingsFile(input);
  const read = readText(file, p.dirname(file), 4 * 1024 * 1024);
  const parsed = read.kind === "text" ? parseStrictJson(read.text) : undefined;
  const settings =
    read.kind === "missing"
      ? t3ProviderInstances(input, undefined, "missing")
      : parsed?.ok === true
        ? t3ProviderInstances(input, parsed.value)
        : t3ProviderInstances(input, undefined, "refused");
  return {
    ...settings,
    instances: settings.instances.map((instance) => {
      if (instance.app !== "codex") return instance;
      const shared = codexSharedHome(input.platform, instance.home);
      return shared === undefined
        ? instance
        : { ...instance, home: shared, shadow: instance.shadow ?? instance.home };
    }),
  };
}

const entryOf = (read: FileRead): unknown => (read.kind === "read" ? read.entry : undefined);

/** The argv a record's entry runs: its command and its arguments. */
export function recordArgv(record: HomeRecord): string[] {
  const { command, args } = record.entry;
  return [
    typeof command === "string" ? command : "",
    ...(Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : []),
  ];
}

/** The entries that are TTasks's own in a home: the one it intends, and an earlier build's shapes. */
const ownShapes = (record: HomeRecord): readonly unknown[] => [record.entry, ...record.also];

/**
 * The one rule before every take-back: whether the entry in the file as just read is exactly what
 * TTasks wrote there (entry.ts whoseEntry), compared with what it intended, never with what it read
 * back. An entry the person changed, a comment included, is theirs.
 */
function whoseIn(home: AgentHome, read: FileRead, record: HomeRecord): "own" | "edited" | "absent" {
  if (read.kind !== "read" || read.entry === undefined) return "absent";
  const { format, servers } = APPS[home.app];
  return whoseEntry(format, servers, read.text, ownShapes(record), read.entry);
}

/** Whether the record names `file` as one it wrote its entry into. */
const recordNames = (platform: NodeJS.Platform, record: HomeRecord, file: string): boolean =>
  recordFiles(record).some((f) => samePath(platform, f.file, file));

/** One of a home's files as it is now, judged against setup's record of the home. */
function inspectFile(home: AgentHome, file: string, record: HomeRecord | undefined): FileView {
  const read = readHomeFile(home, file);
  const base = {
    file,
    sha256: read.kind === "read" ? read.sha256 : null,
    bound: boundOf(home.app, read),
    parent: read.kind === "read" && read.parent,
    ...(read.kind === "read" && read.entry !== undefined ? { entry: read.entry } : {}),
  };
  if (read.kind === "refused") return { ...base, state: "refused", refusal: read.refusal };
  if (record === undefined || !recordNames(process.platform, record, file)) {
    return { ...base, state: entryOf(read) === undefined ? "absent" : "foreign" };
  }
  const whose = whoseIn(home, read, record);
  return { ...base, state: whose === "absent" ? "gone" : whose };
}

/**
 * The home's state from its files: refused while none can be read; with no record, an entry setup
 * did not write in any of them refuses the home, and else it is not registered yet; a record that
 * did not finish is interrupted; else registered while one file holds setup's entry, edited while
 * one holds it changed, and missing otherwise.
 */
function homeState(
  files: readonly FileView[],
  record: HomeRecord | undefined,
): { state: HomeState; refusal?: Refusal } {
  const refusal = (f: FileView | undefined) =>
    f?.refusal === undefined ? {} : { refusal: f.refusal };
  if (files.every((f) => f.state === "refused")) return { state: "refused", ...refusal(files[0]) };
  if (record === undefined) {
    return files.some((f) => f.state === "foreign")
      ? { state: "refused", refusal: "foreign_entry" }
      : { state: "not_registered" };
  }
  if (record.state !== "applied") return { state: "interrupted" };
  if (files.some((f) => f.state === "own")) return { state: "registered" };
  if (files.some((f) => f.state === "edited")) return { state: "edited" };
  return { state: "missing" };
}

/** A home as it is now: each of its files, judged against setup's record of it. */
export function inspectHome(home: AgentHome, record: HomeRecord | undefined): HomeView {
  const files = home.files.map((file) => inspectFile(home, file, record));
  return {
    home,
    ...homeState(files, record),
    files,
    ...(record === undefined ? {} : { record }),
  };
}

/**
 * A home with its record: the recorded instance and account, which its entry names and its row
 * carries even when machine.toml now names the home otherwise, and the files a program reads now.
 */
async function homeOfRecord(
  input: SetupInput,
  found: Discovered,
  record: HomeRecord,
): Promise<AgentHome> {
  return {
    app: record.app,
    home: record.home,
    ...(await filesOfHome(input, record.app, record.home, record.is_default)),
    variable: targetDef(APPS[record.app].target).detect.homes?.env ?? "",
    instance: record.instance,
    account: record.account,
    hosts: hostsOf(input, found, record.app, record.home),
  };
}

/** The record of a home, if setup keeps one. */
const recordOf = (records: readonly HomeRecord[], home: AgentHome, platform: NodeJS.Platform) =>
  records.find((r) => r.app === home.app && samePath(platform, r.home, home.home));

/** The row of a home in the service's live rows, if there is one. */
const rowOf = (input: SetupInput, home: Pick<AgentHome, "app" | "home">) =>
  input.rows?.find((r) => r.app === home.app && samePath(input.platform, r.home, home.home));

/**
 * The homes of live rows (`input.rows`) that no home in `homes` is: a folder renamed, or setup's
 * record lost or unreadable. Each is listed with its row's instance, so its access can be turned off.
 */
async function rowHomes(
  input: SetupInput,
  found: Discovered,
  homes: readonly AgentHome[],
): Promise<AgentHome[]> {
  const listed: AgentHome[] = [];
  for (const row of input.rows ?? []) {
    const { app } = row;
    if (!isAgentApp(app)) continue;
    const known = (h: AgentHome) => h.app === app && samePath(input.platform, h.home, row.home);
    if (homes.some(known) || listed.some(known)) continue;
    listed.push({
      app,
      home: row.home,
      ...(await filesOfHome(input, app, row.home, true)),
      variable: targetDef(APPS[app].target).detect.homes?.env ?? "",
      instance: row.instance,
      account: "",
      hosts: hostsOf(input, found, app, row.home),
    });
  }
  return listed;
}

/**
 * Every home setup knows of, inspected now: the homes found, then recorded homes not found, then
 * the homes of live rows neither accounts for. A home with a record is the recorded one (its
 * instance and account): what setup changed there is what it checks, takes back and renews a row
 * for. Remove, then apply, moves an entry to what the machine says now.
 */
export async function survey(input: SetupInput): Promise<HomeView[]> {
  let records: HomeRecord[];
  try {
    records = readRecords(input.stateDir);
  } catch (error) {
    if (!(error instanceof SetupStateInvalid)) throw error;
    return unrecorded(input);
  }
  const found = discover(input);
  const homes = await agentHomes(input, found);
  for (const record of records) {
    if (!homes.some((h) => h.app === record.app && samePath(input.platform, h.home, record.home))) {
      homes.push(await homeOfRecord(input, found, record));
    }
  }
  homes.push(...(await rowHomes(input, found, homes)));
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
 * Every home while setup's own record cannot be read: the homes found, and the homes the service's
 * live rows (`input.rows`) name, each with its row's instance and refused as `record_unreadable`.
 * Turning one off revokes its access and nothing else (removeHome); no app's settings file is
 * opened, and nothing can be turned on.
 */
async function unrecorded(input: SetupInput): Promise<HomeView[]> {
  const found = discover(input);
  const homes = await agentHomes(input, found);
  homes.push(...(await rowHomes(input, found, homes)));
  return homes.map((home) => {
    const row = rowOf(input, home);
    return {
      home: row === undefined ? home : { ...home, instance: row.instance },
      state: "refused",
      refusal: "record_unreadable",
      files: home.files.map((file): FileView => ({
        file,
        state: "refused",
        refusal: "record_unreadable",
        sha256: null,
        bound: null,
        parent: false,
      })),
    };
  });
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
  const args = (entry as { args?: unknown }).args;
  if (!Array.isArray(args) || args[0] !== "mcp" || !args.every((a) => typeof a === "string")) {
    return undefined;
  }
  const parsed = parseArgs(args.slice(1));
  return "problem" in parsed ? undefined : parsed.instance;
}

/**
 * What a person takes out of a home's file by hand to remove an entry of TTasks's name (A3 3.7.8):
 * the one table or member, in the home's own file. Never a command: a pasted command runs in
 * whatever shell and account it is pasted into, which can be another home's.
 */
export function manualRemoval(
  home: AgentHome,
  file: string,
): { readonly file: string; readonly what: string } {
  const servers = APPS[home.app].servers;
  return {
    file,
    what:
      APPS[home.app].format === "toml"
        ? `the [${servers}.${keyText(MCP_SERVER_KEY)}] table`
        : `the ${JSON.stringify(MCP_SERVER_KEY)} member of ${JSON.stringify(servers)}`,
  };
}

/**
 * An entry as the lines a preview shows, each with `sign` (`+` added, `-` taken out): a TOML
 * table's header and its keys, or a JSON member's keys under their path. An entry that is not a
 * table shows as its path alone.
 */
export function entryLines(app: AgentApp, entry: unknown, sign: "+" | "-"): string[] {
  const { servers, format } = APPS[app];
  const fields =
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? Object.entries(entry as Record<string, unknown>)
      : undefined;
  if (format === "toml") {
    const header = `${sign} [${servers}.${keyText(MCP_SERVER_KEY)}]`;
    return [
      header,
      ...(fields ?? []).map(([key, value]) => `${sign} ${keyText(key)} = ${tomlText(value)}`),
    ];
  }
  const at = `${servers}.${MCP_SERVER_KEY}`;
  if (fields === undefined) return [`${sign} ${at}`];
  return fields.map(([key, value]) => `${sign} ${at}.${key} = ${JSON.stringify(value)}`);
}

/** A value of a TOML entry as TOML text, or as JSON for one the editor does not write. */
function tomlText(value: unknown): string {
  try {
    return valueText(value as EditValue);
  } catch {
    return JSON.stringify(value);
  }
}

/** The homes T3's enabled provider instances use (A3 3.13.6), for doctor's `t3.homes`. */
export function t3HomesOf(input: HostsInput): readonly T3Home[] {
  const settings = t3SettingsOf(input);
  return settings === undefined ? [] : t3Homes(settings);
}

// ---------------------------------------------------------------------------------------------
// The change

/**
 * The environment of the app's command that reads `file` of a home (A4 3.8's rule for the home
 * variables): the home's variable set, except for the file Claude Code reads with none.
 */
export function commandEnv(
  input: Pick<SetupInput, "env" | "platform" | "userHome">,
  home: AgentHome,
  file: string = home.files[0] ?? "",
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
  const plain =
    home.app === "claude-code" &&
    samePath(
      input.platform,
      file,
      settingsFile(input.platform, input.userHome, home.app, home.home, true),
    );
  if (home.variable !== "" && !plain) set[home.variable] = home.home;
  return { env: { ...env, ...set }, set, unset: unset.sort() };
}

/** The entry's argv: TTasks's command with the bridge's arguments (A3 3.13.2-3.13.4). */
export function entryArgv(tasks: string, home: AgentHome, space: string): string[] {
  return [tasks, "mcp", "--space", space, "--instance", home.instance, "--app", home.app];
}

/** The lines a home's file gains, as the preview shows them: JSON's servers' table first when new. */
function diffOf(
  app: AgentApp,
  entry: Readonly<Record<string, EditValue>>,
  parent: boolean,
): string[] {
  const { format, servers } = APPS[app];
  return [
    ...(format === "json" && !parent ? [`+ ${servers} = {}`] : []),
    ...entryLines(app, entry, "+"),
  ];
}

/** A home's access as the service's live rows say: unknown when the caller has none. */
export function accessOf(
  input: SetupInput,
  view: Pick<HomeView, "home">,
): "live" | "off" | "unknown" {
  if (input.rows === undefined) return "unknown";
  return rowOf(input, view.home) === undefined ? "off" : "live";
}

/**
 * The one answer for a home's tools (answer.ts), from its facts read now: the access from
 * `input.rows` (unknown when the caller has none), each file's entry and the program it names,
 * and `space`, the one the person is in ("" for the one the record names). The space a home is set
 * up for is its record's, else its live row's. `writable` is the plan's refusal of a new entry
 * when the caller has one (several Claude Desktop files).
 */
export function toolsOf(
  input: SetupInput,
  view: HomeView,
  space: string,
  writable?: Refusal,
): ToolsAnswer {
  const { home, record } = view;
  const named = record?.space ?? rowOf(input, home)?.space;
  return toolsAnswer({
    state: view.state,
    ...(view.refusal === undefined ? {} : { refusal: view.refusal }),
    files: view.files.map((f): FileFacts => {
      const program = programOf(input, view, f);
      return {
        file: f.file,
        state: f.state,
        ...(f.refusal === undefined ? {} : { refusal: f.refusal }),
        ...(program === undefined ? {} : { program }),
        writable:
          writable ??
          (home.app === "claude-desktop" && f.sha256 === null
            ? "not_set_up"
            : // A file whose folder is not there (renamed, or gone) cannot take an entry.
              input.isFolder(pathOf(input.platform).dirname(f.file))
              ? true
              : "unreadable"),
        handMade: f.state === "foreign" && entryInstance(f.entry) === null,
      };
    }),
    access: accessOf(input, view),
    otherSpace: named !== undefined && space !== "" && named !== space,
    installed: isFile(input.tasks),
  });
}

/**
 * Whether the program a file's entry names is there: an absolute path as a file, a name alone on
 * the PATH of the person's environment. A path that is not there is `moved` when setup's own entry
 * of a registered home names it and it is not where TTasks is installed now (writing the entry
 * again mends it), else `gone`.
 */
function programOf(
  input: SetupInput,
  view: HomeView,
  file: FileView,
): "there" | "moved" | "gone" | undefined {
  const command = (file.entry as { command?: unknown } | undefined)?.command;
  if (typeof command !== "string" || command === "") return undefined;
  const { platform } = input;
  if (!pathOf(platform).isAbsolute(command)) {
    const host = nodeDetectHost({ platform, env: input.env, home: input.userHome });
    return onPath(host, command) === undefined ? "gone" : "there";
  }
  if (isFile(command)) return "there";
  return view.state === "registered" &&
    file.state === "own" &&
    !samePath(platform, command, input.tasks)
    ? "moved"
    : "gone";
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The entry for `space` into each of `targets`, with the lines each file gains. Claude Desktop
 * makes its file in its developer settings: setup never creates it, so one that is not there
 * takes nothing. With no file to take it, the reason is the first file's: one setup cannot read,
 * or an entry that is not setup's.
 */
function changeInto(
  input: SetupInput,
  view: HomeView,
  space: string,
  targets: readonly FileView[],
): Change | Refusal {
  const { home } = view;
  const writes = targets.filter((f) => !(home.app === "claude-desktop" && f.sha256 === null));
  if (writes.length === 0) {
    if (targets.length > 0) return "not_set_up";
    return view.files.find((f) => f.state === "refused")?.refusal ?? "foreign_entry";
  }
  const entry = intendedEntry(APPS[home.app].format, entryArgv(input.tasks, home, space));
  return {
    entry,
    writes: writes.map((f) => ({ file: f.file, diff: diffOf(home.app, entry, f.parent) })),
  };
}

/**
 * What applying a home would write, or why it cannot: its entry, into each file that takes one
 * once what an earlier setup left is settled (no entry, or setup's own). Reads nothing more.
 */
export function planChange(input: SetupInput, view: HomeView, space: string): Change | Refusal {
  return changeInto(
    input,
    view,
    space,
    view.files.filter((f) => f.state === "absent" || f.state === "gone" || f.state === "own"),
  );
}

/**
 * What repairs a registered home whose entries are gone or run a program that is gone, when the
 * answer offers it: its entry written again with the present command, in the space it named
 * (rewrite). An entry it replaces shows as taken out.
 */
function repairOf(input: SetupInput, view: HomeView, space: string): Change | undefined {
  const recorded = view.record?.space;
  if (recorded === undefined || toolsOf(input, view, space).on !== "repair") return undefined;
  const change = planChange(input, view, recorded);
  if (typeof change === "string") return undefined;
  return {
    ...change,
    writes: change.writes.map((w) => {
      const found = view.files.find((f) => f.file === w.file);
      return found?.state === "own"
        ? { ...w, diff: [...entryLines(view.home.app, found.entry, "-"), ...w.diff] }
        : w;
    }),
  };
}

/**
 * What completes a registered home one of whose files has no entry, when the answer offers it:
 * the entry its record names, into each file that has none (complete).
 */
function completionOf(input: SetupInput, view: HomeView, space: string): Change | undefined {
  const recorded = view.record?.space;
  if (recorded === undefined || view.state !== "registered") return undefined;
  if (toolsOf(input, view, space).on !== "add") return undefined;
  const change = changeInto(
    input,
    view,
    recorded,
    view.files.filter((f) => f.state === "absent" || f.state === "gone"),
  );
  return typeof change === "string" ? undefined : change;
}

/** One selected home in a plan: as found, and the change apply would make there. */
export interface PlanItem {
  readonly view: HomeView;
  /** The change for a home that gets an entry, or why it cannot get one; undefined otherwise. */
  readonly change: Change | Refusal | undefined;
  /** The home's access as the plan found it, which its apply may give back (accessOf). */
  readonly access: "live" | "off" | "unknown";
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
      v.files.some((f) => f.sha256 !== null || (f.state === "refused" && fileThere(f.file))),
  );
  return views.map((view) => ({
    view,
    change:
      view.state === "registered"
        ? (completionOf(input, view, space) ?? repairOf(input, view, space))
        : view.state !== "not_registered"
          ? repairOf(input, view, space)
          : view.home.app === "claude-desktop" && desktops.length > 1
            ? "ambiguous"
            : planChange(input, view, space),
    access: accessOf(input, view),
  }));
}

/**
 * The plan's token (A3 3.13.1): a digest of what apply would do in the selected homes, which the
 * preview prints and `--apply --plan` checks again under the lock, so apply does exactly what the
 * preview showed or refuses. It covers the space, each home with its instance, account, hosts and
 * state (everything the home's row names), each of its files as read (FileView `bound`: Claude
 * Code's servers' table, every other file whole), the access apply may give back (unknown too)
 * and, for a change, the exact entry and its lines in each file. `blocks` is the instruction
 * block's part of the plan (block.ts `blockCanonical`), when the plan holds that part.
 */
export function planToken(space: string, items: readonly PlanItem[], blocks?: unknown): string {
  const canonical = items.map(({ view, change, access }) => [
    view.home.app,
    view.home.home,
    view.home.instance,
    // The row apply makes names the account and the hosts too.
    view.home.account,
    view.home.hosts,
    view.state,
    view.refusal ?? null,
    view.record?.space ?? null,
    view.files.map((f) => [f.file, f.state, f.refusal ?? null, f.bound]),
    access,
    change === undefined
      ? null
      : typeof change === "string"
        ? change
        : [change.entry, change.writes],
  ]);
  return createHash("sha256")
    .update(JSON.stringify(blocks === undefined ? [space, canonical] : [space, canonical, blocks]))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Apply and remove
//
// A record that is not `applied` is finished by the next setup run as a removal, whatever it was:
// only an apply the person asked for gives a home access, right after its own write, and a later
// run only ever takes access away.

function putRecord(stateDir: string, platform: NodeJS.Platform, record: HomeRecord): void {
  const others = readRecords(stateDir).filter(
    (r) => !(r.app === record.app && samePath(platform, r.home, record.home)),
  );
  writeRecords(stateDir, [...others, record]);
}

/** Drops a home's record. One that cannot be written stays, and the next run finishes it. */
function forget(input: SetupInput, home: AgentHome): void {
  try {
    const records = readRecords(input.stateDir);
    const kept = records.filter(
      (r) => !(r.app === home.app && samePath(input.platform, r.home, home.home)),
    );
    if (kept.length !== records.length) writeRecords(input.stateDir, kept);
  } catch {
    // Kept: a removal the next run finishes.
  }
}

/** Why the service refused a home's row, in setup's words. */
const grantReason = (error: unknown): OutcomeReason =>
  error instanceof GrantRefused ? error.reason : "grant_failed";

/** Whether the service confirmed that the home has no access now. */
const revoked = (access: Access, home: AgentHome): Promise<boolean> =>
  access.revoke(home).then(
    () => true,
    () => false,
  );

const timer = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/**
 * Runs `work` under the app's own lock on one of the home's files (Claude Code's), or at once for
 * an app that has none. `busy` when another writer keeps the lock through every pause,
 * `unwritable` when the lock cannot be made beside the file.
 */
async function underAppLock<T>(
  input: SetupInput,
  home: AgentHome,
  file: string,
  work: () => T,
): Promise<T | "busy" | "unwritable"> {
  if (!APPS[home.app].locked) return work();
  const ran = await withAppLock(file, input.wait ?? timer, work);
  return ran.held ? ran.value : ran.why;
}

/** How often a change is worked out again when another program saved the file in between. */
const TRIES = 3;

type Written = "done" | "too_large" | "changed_meanwhile" | "unwritable" | "busy";

class ChangedMeanwhile extends Error {}

/**
 * Whether one of the home's files is still exactly `before` (undefined: still no file), in a place
 * setup may write. A stat or two and one read: what runs under the app's lock.
 */
function stillAsRead(home: AgentHome, file: string, before: Buffer | undefined): boolean {
  if (placeRefusal(file, home.home) !== undefined) return false;
  const again = readConfigFile(file, APPS[home.app].maxBytes);
  if (again.kind === "missing") return before === undefined;
  return (
    again.kind === "bytes" &&
    before !== undefined &&
    !unsafe(again.stat) &&
    before.equals(again.bytes)
  );
}

/**
 * Puts `whole` in place of the bytes `before` setup read in one of the home's files (undefined: no
 * file yet), with the file's own mode. The new file is written and flushed beside the old one
 * first; under the app's own lock the file is only compared once more and the new one renamed
 * over it, or, where there was no file, put in place only where nothing is (StagedFile.create). A
 * file the OS will not let setup write (read-only, held by another program, a full disk) is
 * `unwritable`.
 */
async function writeHomeFile(
  input: SetupInput,
  home: AgentHome,
  file: string,
  before: Buffer | undefined,
  whole: string,
): Promise<Written> {
  if (Buffer.byteLength(whole, "utf8") > APPS[home.app].maxBytes) return "too_large";
  let mode = 0o600;
  if (before !== undefined) {
    try {
      mode = lstatSync(file).mode & 0o777;
    } catch {
      return "changed_meanwhile";
    }
  }
  let staged: StagedFile;
  try {
    staged = stageFile(file, whole, mode);
  } catch {
    return "unwritable";
  }
  try {
    return await underAppLock(input, home, file, (): Written => {
      if (before === undefined) {
        return placeRefusal(file, home.home) === undefined && staged.create()
          ? "done"
          : "changed_meanwhile";
      }
      staged.replace(() => {
        if (!stillAsRead(home, file, before)) throw new ChangedMeanwhile();
      });
      return "done";
    });
  } catch (error) {
    return error instanceof ChangedMeanwhile ? "changed_meanwhile" : "unwritable";
  } finally {
    // Once in place it has no temporary name left; otherwise it goes.
    staged.discard();
  }
}

/** Deletes a file setup created, when it is still exactly the bytes `before` setup read. */
async function deleteHomeFile(
  input: SetupInput,
  home: AgentHome,
  file: string,
  before: Buffer,
): Promise<Written> {
  try {
    return await underAppLock(input, home, file, (): Written => {
      if (!stillAsRead(home, file, before)) return "changed_meanwhile";
      rmSync(file);
      return "done";
    });
  } catch {
    return "unwritable";
  }
}

/** A JSON file that is not there yet starts as the empty document setup adds its entry to. */
const EMPTY_JSON = "{}\n";

interface NotWritten {
  readonly result: "left" | "failed";
  readonly reason: OutcomeReason;
  readonly file?: string;
}

/** One file's part of an entry being written: the file as read, and as it will be. */
interface Spliced {
  readonly file: string;
  readonly before: Buffer | undefined;
  readonly whole: string;
  readonly made: Made;
}

/**
 * The entry spliced into one of the home's files as it is now. A file that changed since the plan
 * (its `bound`) is left alone; Claude Code's is bound by its servers' table, as its sessions save
 * their own state into it. Only the home's first file is made when it is not there.
 */
function splice(home: AgentHome, view: FileView, entry: Change["entry"]): Spliced | NotWritten {
  const { format, servers } = APPS[home.app];
  const failed = (reason: OutcomeReason): NotWritten => ({
    result: "failed",
    reason,
    file: view.file,
  });
  const now = readHomeFile(home, view.file);
  if (now.kind === "refused" || entryOf(now) !== undefined) return failed("changed_meanwhile");
  if (now.kind === "missing" && view.file !== home.files[0]) return failed("changed_meanwhile");
  if (boundOf(home.app, now) !== view.bound) return failed("changed_meanwhile");
  const text = now.kind === "read" ? now.text : format === "json" ? EMPTY_JSON : "";
  const edited = addOwnEntry(format, servers, text, entry);
  if (!edited.ok)
    return failed(edited.reason === "invalid_file" ? "invalid_file" : "unsupported_layout");
  return {
    file: view.file,
    before: now.kind === "read" ? now.bytes : undefined,
    whole: `${now.kind === "read" && now.bom ? BOM : ""}${edited.text}`,
    made: { file: now.kind === "missing", ...edited.made },
  };
}

/** Puts back files this run wrote, each while it is still exactly what was written: whether all were. */
async function putBack(
  input: SetupInput,
  home: AgentHome,
  written: readonly Spliced[],
): Promise<boolean> {
  let all = true;
  for (const s of written) {
    const now = Buffer.from(s.whole, "utf8");
    const wrote =
      s.before === undefined
        ? await deleteHomeFile(input, home, s.file, now)
        : await writeHomeFile(input, home, s.file, now, s.before.toString("utf8"));
    if (wrote !== "done") all = false;
  }
  return all;
}

/**
 * Writes the home's record, then the entry into each file of `change` as it is now: the record and
 * the splices outside the app's lock, before any file changes. A new install's record says
 * `applying`; a registered home that gains a file (`kept`, its record) stays `applied`, since its
 * access already follows its entry. A file that cannot be written takes back the ones this run
 * wrote, and the record goes back as it was; Claude Code's file, which a running session saves
 * while setup works, is read and worked out again, a few times.
 */
async function writeEntries(
  input: SetupInput,
  view: HomeView,
  space: string,
  change: Change,
  kept?: HomeRecord,
): Promise<HomeRecord | NotWritten> {
  const { home } = view;
  const { locked } = APPS[home.app];
  for (let attempt = 1; ; attempt += 1) {
    const spliced: Spliced[] = [];
    for (const w of change.writes) {
      const found = view.files.find((f) => f.file === w.file);
      if (found === undefined) return { result: "failed", reason: "changed_meanwhile" };
      const s = splice(home, found, change.entry);
      if (!("whole" in s)) return s;
      spliced.push(s);
    }
    const [first] = spliced;
    if (first === undefined) return { result: "failed", reason: "changed_meanwhile" };
    const record = naming(
      input,
      home,
      kept === undefined
        ? {
            app: home.app,
            home: home.home,
            file: first.file,
            is_default: isDefaultFile(input, home, home.files[0] ?? first.file),
            instance: home.instance,
            account: home.account,
            space,
            state: "applying",
            entry: change.entry,
            also: [],
            made: first.made,
            grant: null,
            at: new Date().toISOString(),
          }
        : {
            ...kept,
            // An earlier build's entry has another shape: the new one is setup's own too.
            also: isDeepStrictEqual(kept.entry, change.entry)
              ? kept.also
              : [...kept.also, change.entry],
          },
      spliced,
    );
    try {
      putRecord(input.stateDir, input.platform, record);
    } catch (error) {
      // What setup's reader could not read back (millions of line breaks inside an empty servers
      // object, which the record keeps to give them back) is a layout setup cannot keep.
      if (error instanceof SetupStateTooLarge)
        return { result: "left", reason: "unsupported_layout" };
      if (error instanceof SetupStateInvalid || error instanceof SetupStateUnsafe) throw error;
      return { result: "failed", reason: "state_unwritable" };
    }
    const written: Spliced[] = [];
    let wrote: Written = "done";
    let at = first.file;
    for (const s of spliced) {
      wrote = await writeHomeFile(input, home, s.file, s.before, s.whole);
      if (wrote !== "done") {
        at = s.file;
        break;
      }
      written.push(s);
    }
    if (wrote === "done") return record;
    const back = await putBack(input, home, written);
    try {
      if (!back) putRecord(input.stateDir, input.platform, { ...record, state: "removing" });
      else if (kept === undefined) forget(input, home);
      else putRecord(input.stateDir, input.platform, kept);
    } catch {
      // Kept as it is: a record that did not finish is settled by the next run.
    }
    if (!(back && wrote === "changed_meanwhile" && locked && attempt < TRIES)) {
      return { result: "failed", reason: wrote, file: at };
    }
  }
}

/**
 * `record` naming each of `files` with what the latest write made there, in place of what it said
 * of that path before: each path once, in the home's order, so the only one setup can have made
 * (the home's first) is the record's `file`.
 */
function naming(
  input: SetupInput,
  home: AgentHome,
  record: HomeRecord,
  files: readonly { readonly file: string; readonly made: Made }[],
): HomeRecord {
  const same = (a: string, b: string) => samePath(input.platform, a, b);
  const place = (file: string) => {
    const at = home.files.findIndex((f) => same(f, file));
    return at === -1 ? home.files.length : at;
  };
  const all = [
    ...recordFiles(record).filter((r) => !files.some((f) => same(f.file, r.file))),
    ...files.map(({ file, made }) => ({ file, made })),
  ].sort((a, b) => place(a.file) - place(b.file));
  const [first, ...rest] = all;
  if (first === undefined) return record;
  const named: HomeRecord = {
    app: record.app,
    home: record.home,
    file: first.file,
    is_default: record.is_default,
    instance: record.instance,
    account: record.account,
    space: record.space,
    state: record.state,
    entry: record.entry,
    also: record.also,
    made: first.made,
    grant: record.grant,
    at: record.at,
  };
  if (rest.length === 0) return named;
  return {
    ...named,
    more: rest.map(({ file, made }) => ({
      file,
      made: {
        parent: made.parent,
        spacing: made.spacing,
        ...(made.ended === undefined ? {} : { ended: made.ended }),
      },
    })),
  };
}

/** Whether `file` is the app's default home's, read with no variable (a record's `is_default`). */
function isDefaultFile(input: SetupInput, home: AgentHome, file: string): boolean {
  const { platform, userHome } = input;
  if (home.app === "claude-desktop") return true;
  if (home.app === "codex")
    return samePath(platform, home.home, pathOf(platform).join(userHome, ".codex"));
  return samePath(platform, file, settingsFile(platform, userHome, home.app, home.home, true));
}

/** The files of a home that hold setup's own entry now. */
const ownFiles = (view: HomeView): string[] =>
  view.files.filter((f) => f.state === "own").map((f) => f.file);

/** A home's access as the plan read it, in an outcome's words. */
const knownAccess = (input: SetupInput, view: HomeView): "on" | "off" | "unknown" => {
  const known = accessOf(input, view);
  return known === "live" ? "on" : known;
};

/**
 * Turns a home's tools on as its answer (toolsOf) offers it from `space`, and does nothing it does
 * not offer: a new entry into each of its files, then its access once the entries are in place
 * (giveAccess), the record written before the files (writeEntries); the entry into a registered
 * home's file that has none, then its access; a registered home's access again; or its entries
 * written again (rewrite). A registered home whose tools start gets its row renewed for the space
 * its entry names, only when the service said what its access is. `space` is empty when the apply
 * registers no new home. `planned` is the change the plan holds for it (planOf), when the caller
 * has one.
 */
export async function applyHome(
  input: SetupInput,
  view: HomeView,
  space: string,
  access: Access,
  planned?: Change | Refusal,
): Promise<Outcome> {
  const { home, record } = view;
  const answer = toolsOf(input, view, space, typeof planned === "string" ? planned : undefined);
  const left = (): Outcome => ({
    home,
    result: "left",
    reason: answer.why ?? "not_registered",
    ...(answer.file === undefined ? {} : { file: answer.file }),
  });
  switch (answer.on) {
    case "repair":
      return rewrite(input, view, access);
    case "grant":
      return record === undefined
        ? left()
        : giveAccess(input, home, record, record.space, access, true, ownFiles(view));
    case "add": {
      if (view.state === "registered" && record !== undefined) {
        const change = typeof planned === "object" ? planned : completionOf(input, view, space);
        if (change === undefined) return left();
        const written = await writeEntries(input, view, record.space, change, record);
        if (!("entry" in written)) return { home, ...written };
        const expected = [...ownFiles(view), ...change.writes.map((w) => w.file)];
        return giveAccess(input, home, written, record.space, access, true, expected);
      }
      if (view.state !== "not_registered") return left();
      const change = typeof planned === "object" ? planned : planChange(input, view, space);
      if (typeof change === "string") return { home, result: "left", reason: change };
      const written = await writeEntries(input, view, space, change);
      if (!("entry" in written)) return { home, ...written, access: knownAccess(input, view) };
      const expected = change.writes.map((w) => w.file);
      return giveAccess(input, home, written, space, access, false, expected);
    }
    default:
      if (
        view.state !== "registered" ||
        record === undefined ||
        (answer.why !== undefined && answer.file === undefined)
      ) {
        return left();
      }
      // A renewal gives back only an access the service said is there.
      if (input.rows === undefined) return { home, result: "left", reason: "access_unknown" };
      return giveAccess(input, home, record, record.space, access, true, ownFiles(view));
  }
}

/**
 * Repairs a registered home whose entries are gone or run a program that is gone: the old entries
 * and the access go as a removal does, then the entry is written with the present command, in the
 * space it named, and gets its access as a new install does. A step that fails stops there, and
 * the home is as that step left it: off, or as it was.
 */
async function rewrite(input: SetupInput, view: HomeView, access: Access): Promise<Outcome> {
  const { home, record } = view;
  if (record === undefined) return { home, result: "left", reason: "missing" };
  const removed = await removeHome(input, view, access);
  if (removed.result !== "removed") return { ...removed, result: "failed" };
  const fresh = inspectHome(home, undefined);
  if (fresh.state !== "not_registered") {
    return { home, result: "failed", reason: "changed_meanwhile", access: "off" };
  }
  const change = planChange(input, fresh, record.space);
  if (typeof change === "string") return { home, result: "failed", reason: change, access: "off" };
  const written = await writeEntries(input, fresh, record.space, change);
  if (!("entry" in written)) return { home, ...written, access: "off" };
  const expected = change.writes.map((w) => w.file);
  return giveAccess(input, home, written, record.space, access, false, expected);
}

/**
 * Gives a home whose entries are in its files its access, for a new install and a registered home
 * alike: each file in `expected` is read and must hold the entry setup intended, the access is
 * asked for, the files are read once more after the service's answer, and the record says
 * `applied` with the row. Anything else takes it all back (undo). `registered`: the home was
 * registered before this apply, so it may have access already, and a row the service refuses
 * leaves that as it was.
 */
async function giveAccess(
  input: SetupInput,
  home: AgentHome,
  record: HomeRecord,
  space: string,
  access: Access,
  registered: boolean,
  expected: readonly string[],
): Promise<Outcome> {
  // The entry as setup intended it, read back from its place: anything else there is not its own.
  const placed = entryNow(home, record, expected);
  if (placed.whose !== "own") {
    return undo(input, home, record, access, placed.reason, {
      given: registered,
      readable: placed.whose !== "unchecked",
    });
  }
  let grant: string;
  try {
    grant = await access.grant(home, space);
  } catch (error) {
    if (registered) return { home, result: "failed", reason: grantReason(error) };
    // A row the service made before its answer was lost is taken back too.
    return undo(input, home, record, access, grantReason(error));
  }
  const after = entryNow(home, record, expected);
  if (after.whose !== "own") {
    return undo(input, home, record, access, after.reason, {
      readable: after.whose !== "unchecked",
    });
  }
  if (record.state !== "applied" || record.grant !== grant) {
    try {
      putRecord(input.stateDir, input.platform, { ...record, state: "applied", grant });
    } catch {
      return undo(input, home, record, access, "state_unwritable");
    }
  }
  return { home, result: registered ? "unchanged" : "applied", access: "on" };
}

/**
 * Setup's entry in each of `files` as a read right now finds it: `own` only when every one holds
 * it. A read that fails cannot tell what is there (`unchecked`): only a read that succeeds decides
 * that an entry is gone or not setup's.
 */
function entryNow(
  home: AgentHome,
  record: HomeRecord,
  files: readonly string[],
):
  | { readonly whose: "own" }
  | { readonly whose: "edited" | "absent" | "unchecked"; readonly reason: OutcomeReason } {
  if (files.length === 0) return { whose: "absent", reason: "changed_meanwhile" };
  let found: { whose: "edited" | "absent"; reason: OutcomeReason } | undefined;
  for (const file of files) {
    const read = readHomeFile(home, file);
    if (read.kind === "refused") return { whose: "unchecked", reason: read.refusal };
    const whose = whoseIn(home, read, record);
    if (whose !== "own") found ??= { whose, reason: "changed_meanwhile" };
  }
  return found ?? { whose: "own" };
}

/**
 * Takes back an apply that cannot stand. The decision is recorded first (`removing`), then the
 * access goes (when it may have been given), then the entries that a read shows are still setup's
 * own. After a read that failed (`readable` false), or a revoke the service did not confirm, no
 * file is touched: the record stays `removing`, and the next run takes the access and then the
 * entries out. A record that cannot be written stays as it was: an unfinished one the next run
 * finishes as a removal all the same, a registered home's stays registered with its access off
 * until the person asks again.
 */
async function undo(
  input: SetupInput,
  home: AgentHome,
  record: HomeRecord,
  access: Access,
  reason: OutcomeReason,
  { given = true, readable = true }: { readonly given?: boolean; readonly readable?: boolean } = {},
): Promise<Outcome> {
  const removing = { ...record, state: "removing" as const };
  try {
    putRecord(input.stateDir, input.platform, removing);
  } catch {
    // Left as it was: see above.
  }
  const off = given ? await revoked(access, home) : true;
  if (!readable || !off) {
    return {
      home,
      result: "failed",
      reason,
      access: off ? "off" : "unknown",
      notes: ["undo_failed"],
    };
  }
  const out = await takeOut(input, home, removing);
  const note = out.kept === "own" ? "undo_failed" : out.kept === "edited" ? "entry_left" : "undone";
  return { home, result: "failed", reason, access: "off", notes: [note] };
}

/**
 * Turns a home's access off, then takes TTasks's entry out of each file it wrote it into, where it
 * is still exactly the one setup wrote. The revoke is asked for first and alone: when the service
 * does not confirm it, nothing else changes, and the access is as it was. Once the access is off,
 * the record says `removing` before any file is touched, so a run that ends midway is finished by
 * the next one; a record that cannot be written leaves the entries in their files, and the access
 * off all the same.
 */
export async function removeHome(
  input: SetupInput,
  view: HomeView,
  access: Access,
): Promise<Outcome> {
  const { home, record } = view;
  if (!(await revoked(access, home))) {
    return {
      home,
      result: "failed",
      reason: "revoke_failed",
      access: "unknown",
    };
  }
  if (record === undefined) {
    // Without its record setup changes no file: the access is what turning off reaches.
    if (view.refusal === "record_unreadable") {
      return { home, result: "left", reason: "record_unreadable", access: "off" };
    }
    return { home, result: "unchanged", reason: "not_registered", access: "off" };
  }
  const removing = { ...record, state: "removing" as const };
  if (record.state !== "removing") {
    try {
      putRecord(input.stateDir, input.platform, removing);
    } catch {
      const left = recordFiles(record)
        .map((f) => ({ file: f.file, whose: whoseIn(home, readHomeFile(home, f.file), record) }))
        .sort((a, b) => (a.whose === "own" ? -1 : b.whose === "own" ? 1 : 0))
        .find((f) => f.whose !== "absent");
      return {
        home,
        result: "failed",
        reason: "state_unwritable",
        access: "off",
        ...(left === undefined || left.whose === "absent"
          ? {}
          : { kept: left.whose, file: left.file }),
      };
    }
  }
  return { ...(await takeOut(input, home, removing)), access: "off" };
}

/**
 * One file's part of a removal: TTasks's entry out when it is still its own, with what its add
 * made there (the servers' table, the bytes around it, the file itself when nothing else is left
 * in it). No file is no entry. An entry the person changed stays, and is theirs from then on.
 */
async function takeOutOf(
  input: SetupInput,
  home: AgentHome,
  record: HomeRecord,
  { file, made }: { readonly file: string; readonly made: Made },
): Promise<Pick<Outcome, "result" | "reason" | "kept" | "file">> {
  const { format, servers } = APPS[home.app];
  for (let attempt = 1; ; attempt += 1) {
    const read = readHomeFile(home, file);
    if (read.kind === "refused") return { result: "left", reason: read.refusal, kept: "own", file };
    const whose = whoseIn(home, read, record);
    if (whose === "absent" || read.kind !== "read") return { result: "removed", reason: "missing" };
    if (whose === "edited") return { result: "left", reason: "edited", kept: "edited", file };
    const edited = removeOwnEntry(format, servers, read.text, made);
    if (!edited.ok) {
      const reason = edited.reason === "invalid_file" ? "invalid_file" : "unsupported_layout";
      return { result: "failed", reason, kept: "own", file };
    }
    const wrote =
      made.file && holdsNothing(format, edited.text)
        ? await deleteHomeFile(input, home, file, read.bytes)
        : await writeHomeFile(
            input,
            home,
            file,
            read.bytes,
            `${read.bom ? BOM : ""}${edited.text}`,
          );
    if (wrote === "done") return { result: "removed" };
    if (wrote !== "changed_meanwhile" || attempt >= TRIES) {
      return { result: "failed", reason: wrote, kept: "own", file };
    }
  }
}

/**
 * The files' part of a removal, for each file the record names. A home whose folder is gone is
 * done. The record goes once nothing of TTasks's is left in any of them and its access is off;
 * while an entry of TTasks's could not be taken out the record stays, so the next setup tries
 * again. The outcome is the first file's that kept an entry of TTasks's, else the first's that
 * kept one the person changed.
 */
async function takeOut(input: SetupInput, home: AgentHome, record: HomeRecord): Promise<Outcome> {
  const each = [];
  for (const f of recordFiles(record)) each.push(await takeOutOf(input, home, record, f));
  const own = each.find((o) => o.kept === "own");
  if (own !== undefined) return { home, ...own };
  forget(input, home);
  const edited = each.find((o) => o.kept === "edited");
  if (edited !== undefined) return { home, ...edited };
  return each.every((o) => o.reason === "missing")
    ? { home, result: "removed", reason: "missing" }
    : { home, result: "removed" };
}

/**
 * Settles what a setup run left midway (a crash, a closed terminal, an undo that could not finish):
 * run first by every setup that changes the homes, under the setup lock, so a record that is not
 * `applied` then is no other run's. Each is finished as a removal (removeHome), whatever it was.
 * A record that cannot be read leaves nothing to settle: survey says so for each home.
 */
export async function settleHomes(input: SetupInput, access: Access): Promise<Outcome[]> {
  let records: HomeRecord[];
  try {
    records = readRecords(input.stateDir).filter((r) => r.state !== "applied");
  } catch (error) {
    if (error instanceof SetupStateInvalid) return [];
    throw error;
  }
  if (records.length === 0) return [];
  const found = discover(input);
  const outcomes: Outcome[] = [];
  for (const record of records) {
    const home = await homeOfRecord(input, found, record);
    outcomes.push(await removeHome(input, inspectHome(home, record), access));
  }
  return outcomes;
}
