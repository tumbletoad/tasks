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
import { accessSync, constants, lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
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
  type BaseKind,
  type BuiltInTargetId,
  type Detection,
  type Env,
  type Instance,
} from "@ttasks/launch";
import { keyText, valueText, type EditValue } from "../config/edit.ts";
import { scanToml, ScanError } from "../config/scan.ts";
import { BOM, MAX_CONFIG_BYTES, parseToml, readConfigFile } from "../config/toml.ts";
import { stageFile, type StagedFile } from "../hub/files.ts";
import { toolsAnswer, type HomeState, type Refusal, type ToolsAnswer } from "./answer.ts";
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
  dropRecord,
  isAgentApp,
  saveRecord,
  setupRecords,
  SetupStateInvalid,
  SetupStateTooLarge,
  SetupStateUnsafe,
  SetupStateUnwritable,
  type AgentApp,
  type HomeRecord,
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
  /**
   * Codex shadow homes that read this home's file through a link (hosts.ts `codexSharedHome`):
   * never homes of their own, so Codex run in one of them reads this entry.
   */
  readonly shadows?: readonly string[];
  /** A3 3.12 rules 3 and 4: machine.toml lists the file, or another git repository tracks it. */
  readonly managed: boolean;
  /**
   * The space of the home's access: its live row's, else the one its `applied` records name. Every
   * entry of the home names it, and a new one does too; undefined for a home set up nowhere yet.
   */
  readonly space?: string;
  /** A further settings file of the home (homeFiles): setup never creates it. */
  readonly further?: true;
  /** Listed only for its live row, which no record and no found home accounts for: Off only. */
  readonly rowOnly?: true;
  /**
   * A record of the home still owes its revoke (owesRevoke): nothing turns on until it is settled,
   * and turning off asks for the revoke again.
   */
  readonly owed?: true;
}

/**
 * One settings file of a home as setup finds it now. A home is the views `survey` gives one after
 * another for the same app and folder, its first file first (homeGroups).
 */
export interface HomeView {
  readonly home: AgentHome;
  readonly state: HomeState;
  readonly refusal?: Refusal;
  /** SHA-256 of the file as read; null when there is no file. */
  readonly sha256: string | null;
  /**
   * What a write into the file is bound to, so it writes what the preview showed: the servers'
   * table for Claude Code, which saves its own state into the rest of the file while a session
   * runs, the whole file for the other apps. Null when there is no file.
   */
  readonly digest: string | null;
  /** Whether the servers' table (`mcpServers`, `mcp_servers`) exists. */
  readonly parent: boolean;
  /** TTasks's entry as found, when there is one. TTasks's own data: never another key's value. */
  readonly entry?: unknown;
  readonly record?: HomeRecord;
}

/** What setup writes for one home. */
export interface Change {
  /** The entry setup writes, exactly: its keys and values. */
  readonly entry: Readonly<Record<string, EditValue>>;
  /** The entry as the lines its file gains: for JSON, its servers' table first when it is new. */
  readonly diff: readonly string[];
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
  /** No service said whether the home's access is live, so nothing that needs it was done. */
  | "access_unknown"
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
  | "older"
  | "no_program"
  | "unbound"
  /** Setup's own record of the home could not be written, so its file was left as it was. */
  | "state_unwritable";

/** What happened to one settings file of a home. */
export interface Outcome {
  readonly home: AgentHome;
  readonly result: "applied" | "removed" | "unchanged" | "left" | "failed";
  readonly reason?: OutcomeReason;
  /**
   * The home's access as the service said it once the home's files were done (homeAccess), the
   * same for each of its files; `unknown` when no service answered.
   */
  readonly access?: "on" | "off" | "unknown";
  /**
   * A removal that left an entry in the file: TTasks's own (`reason` says why), one the person
   * changed, or one of TTasks's name that setup has no record of, which it never takes out.
   */
  readonly kept?: "own" | "edited" | "unrecorded";
  /**
   * Facts the person should know: `undo_failed`, `entry_left`, `undone` (its entry was taken out
   * again), `file_gone` (its file is gone, so only its record was taken out).
   */
  readonly notes?: readonly string[];
  /** `state_unwritable`: the record file setup could not write, by its full path, when known. */
  readonly record?: string;
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
  /** The home's live row, or null when it has none. Throws when the service does not answer. */
  read(home: AgentHome): Promise<{ readonly grant: string } | null>;
}

/** What setup reads, injected so tests use scratch homes (and doctor's probes fake commands). */
export interface SetupInput {
  readonly platform: NodeJS.Platform;
  /** The user's home folder: Claude Code's default `.claude.json` is here. */
  readonly userHome: string;
  /** The person's environment, in which detection and doctor's probes run the apps' commands. */
  readonly env: Env;
  /**
   * What `env` is, as a launch builds an agent's environment from it (shim/environment.ts): the
   * person's own (a terminal's, the default), or the service's.
   */
  readonly envKind?: BaseKind;
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
    /** The row's space and account, when the caller keeps them: a home's own (survey). */
    readonly space?: string;
    readonly account?: string;
    /** The row's ID, when the caller keeps it (the command line's status shows it). */
    readonly grant?: string;
  }[];
  /** The spaces the service serves, when the caller asked: access for another is not offered. */
  readonly served?: readonly string[];
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

/** The file of an app's entry in a home. */
function fileOf(input: SetupInput, app: AgentApp, home: string, isDefault: boolean): string {
  const p = pathOf(input.platform);
  if (app === "codex") return p.join(home, CODEX_FILE);
  if (app === "claude-desktop") return p.join(home, DESKTOP_FILE);
  return isDefault ? p.join(input.userHome, CLAUDE_FILE) : p.join(home, CLAUDE_FILE);
}

/** Whether a home can have a further settings file: Claude Code's default folder. */
const twoFiled = (input: SetupInput, home: Pick<AgentHome, "app" | "home">): boolean =>
  home.app === "claude-code" &&
  samePath(input.platform, home.home, pathOf(input.platform).join(input.userHome, ".claude"));

/**
 * The further settings files of a home whose first file is `first`. Claude Code started with no
 * variable reads `~/.claude.json`, and started with its home set to `~/.claude` (as T3 Code may
 * start it) reads `~/.claude/.claude.json`: the one of these two that is not the first is a file of
 * the home while it is there, since that reader makes it, and one that is a link to the first is
 * that file. Setup never creates it.
 */
function homeFiles(input: SetupInput, first: AgentHome): AgentHome[] {
  if (!twoFiled(input, first)) return [];
  const file = fileOf(input, first.app, first.home, !first.isDefault);
  if (!fileThere(file) || sameFile(file, first.file)) return [];
  return [{ ...first, file, isDefault: !first.isDefault, further: true }];
}

/** Whether two paths are one file: a link to the other, or the other's target. */
function sameFile(a: string, b: string): boolean {
  try {
    return samePath(process.platform, realpathSync(a), realpathSync(b));
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
 * Whether a T3 provider instance reads one settings file of a home (`isDefault` the file's): the
 * same folder, and for Claude Code the same file. T3 sets CLAUDE_CONFIG_DIR from a non-empty
 * `homePath`, and Claude Code then reads `.claude.json` inside that folder, even when the folder
 * is the default one, whose first file is the user's `~/.claude.json`.
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

/**
 * The other apps that read a home: the Codex app reads the default Codex home, T3 its instances',
 * through whichever of the home's settings files it starts the app with (homeFiles).
 */
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
  if (found.t3.some((t) => t.app === app && samePath(input.platform, t.home, home))) {
    hosts.push("t3");
  }
  return hosts;
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
      hosts: hostsOf(input, found, app, home),
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
      /** HomeView `digest`. */
      readonly digest: string;
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
): { parent: boolean; entry: unknown; table?: unknown } | Refusal {
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
    table,
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

/** Reads and judges a home's file (readText's checks, then the app's format). Never writes. */
function readHomeFile(home: AgentHome): FileRead {
  if (home.managed) return refused("managed");
  const row = APPS[home.app];
  const read = readText(home.file, home.home, row.maxBytes);
  if (read.kind !== "text") return read;
  const judged = row.format === "toml" ? readToml(read.text) : readJson(read.text, row.servers);
  if (typeof judged === "string") return refused(judged);
  const { parent, entry } = judged;
  const table = "table" in judged ? judged.table : undefined;
  const digest = home.app === "claude-code" ? tableDigest(table) : read.sha256;
  return { ...read, kind: "read", parent, entry, digest };
}

/** Claude Code's servers' table, as a write into its file is bound to it (HomeView `digest`). */
const tableDigest = (table: unknown): string =>
  sha256(Buffer.from(JSON.stringify(table ?? null), "utf8"));

/** HomeView `digest` of a file as read: Claude Code's file that is not there has no servers yet. */
const digestOf = (home: AgentHome, read: FileRead): string | null =>
  read.kind === "read"
    ? read.digest
    : read.kind === "missing" && home.app === "claude-code"
      ? tableDigest(undefined)
      : null;

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

/**
 * A settings file of a home as it is now, judged against setup's record of it. A record a run left
 * midway is judged by what settling it leaves: an entry the person changed meanwhile is theirs.
 */
export function inspectHome(home: AgentHome, record: HomeRecord | undefined): HomeView {
  const read = readHomeFile(home);
  const base = {
    home,
    sha256: read.kind === "read" ? read.sha256 : null,
    digest: digestOf(home, read),
    parent: read.kind === "read" && read.parent,
    ...(read.kind === "read" && read.entry !== undefined ? { entry: read.entry } : {}),
    ...(record === undefined ? {} : { record }),
  };
  if (read.kind === "refused") return { ...base, state: "refused", refusal: read.refusal };
  if (record === undefined) {
    return entryOf(read) === undefined
      ? { ...base, state: "not_registered" }
      : { ...base, state: "refused", refusal: "foreign_entry" };
  }
  const whose = whoseIn(home, read, record);
  if (record.state !== "applied") {
    return whose === "edited"
      ? { ...base, state: "refused", refusal: "foreign_entry" }
      : { ...base, state: "interrupted" };
  }
  if (whose === "absent") return { ...base, state: "missing" };
  return { ...base, state: whose === "own" ? "registered" : "edited" };
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
    hosts: hostsOf(input, found, record.app, record.home),
    managed: await managedFile(input, record.file, record.home),
  };
}

/** The record of a home, if setup keeps one. */
const recordOf = (records: readonly HomeRecord[], home: AgentHome, platform: NodeJS.Platform) =>
  records.find((r) => r.app === home.app && samePath(platform, r.home, home.home));

/**
 * Every settings file of every home setup knows of, inspected now, a home's first file first: the
 * homes found, recorded homes not found, and the homes of live rows nothing else accounts for. A
 * home with a record in `agents.json` keeps that record's file as its first, as recorded: what
 * setup changed there is what it checks and takes back, even when machine.toml now names the home
 * otherwise. Each file's record is found by its recorded path, and a recorded file that is gone is
 * listed too, for its cleanup. A home's instance, account and space are its live row's, else its
 * `applied` records', else what the machine proposes now.
 */
export async function survey(input: SetupInput): Promise<HomeView[]> {
  const read = setupRecords(input.stateDir);
  if (read.blind) return unrecorded(input);
  const { all, first: records } = read;
  const { platform } = input;
  const ofHome = (h: Pick<AgentHome, "app" | "home">) => (r: { app: string; home: string }) =>
    r.app === h.app && samePath(platform, r.home, h.home);
  const found = discover(input);
  const homes = await agentHomes(input, found);
  // Every record names a home to show, also one whose folder is no longer found.
  for (const record of all) {
    if (!homes.some((h) => ofHome(h)(record))) homes.push(await homeOfRecord(input, found, record));
  }
  for (const row of input.rows ?? []) {
    if (!isAgentApp(row.app) || homes.some((h) => ofHome(h)(row))) continue;
    homes.push({
      ...rowHome(input, found, row.app, row.home, row.instance),
      account: row.account ?? "",
      rowOnly: true,
    });
  }
  const views: HomeView[] = [];
  for (const proposed of freeInstances(input, homes, all)) {
    const legacy = recordOf(records, proposed, platform);
    const first = legacy === undefined ? proposed : await homeOfRecord(input, found, legacy);
    const own = all.filter(ofHome(first));
    const row = (input.rows ?? []).find(ofHome(first));
    const applied = own.find((r) => r.state === "applied");
    const space = row?.space ?? applied?.space;
    const home: AgentHome = {
      ...first,
      instance: row?.instance ?? applied?.instance ?? proposed.instance,
      account: row?.account ?? applied?.account ?? proposed.account,
      ...(space === undefined ? {} : { space }),
      ...(own.some(owesRevoke) ? { owed: true as const } : {}),
    };
    // Without the further files' records, only the file `agents.json` knows is judged.
    const unknown = read.furtherUnknown && twoFiled(input, home);
    const files = [home, ...homeFiles(input, home)];
    for (const record of own) {
      if (!files.some((f) => samePath(platform, f.file, record.file))) {
        files.push({ ...home, file: record.file, isDefault: record.is_default, further: true });
      }
    }
    for (const file of files) {
      const record = own.find((r) => samePath(platform, r.file, file.file));
      const judged =
        file.further === true
          ? { ...file, managed: await managedFile(input, file.file, file.home) }
          : file;
      views.push(
        unknown && (legacy === undefined || record !== legacy)
          ? unread(judged, true)
          : inspectHome(judged, record),
      );
    }
  }
  return views;
}

/**
 * The homes among survey's views or plan items, each the run of its settings files, the first
 * first: what a row, an apply and a removal take as one home.
 */
export function homeGroups<T>(
  platform: NodeJS.Platform,
  items: readonly T[],
  homeOf_: (item: T) => Pick<AgentHome, "app" | "home">,
): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const home = homeOf_(item);
    const group = groups.find((g) => {
      const other = homeOf_(g[0] as T);
      return other.app === home.app && samePath(platform, other.home, home.home);
    });
    if (group === undefined) groups.push([item]);
    else group.push(item);
  }
  return groups;
}

/**
 * A file setup does not judge, its record unreadable: its access can still be turned off. `look`:
 * the file is read to say whether an entry of TTasks's name is there, which then stays.
 */
function unread(home: AgentHome, look = false): HomeView {
  const read = look ? readHomeFile(home) : undefined;
  return {
    home,
    state: "refused",
    refusal: "record_unreadable",
    sha256: null,
    digest: null,
    parent: false,
    ...(read?.kind === "read" && read.entry !== undefined ? { entry: read.entry } : {}),
  };
}

/** A home known only by a live row: the app's file in its folder, the row's instance. */
function rowHome(
  input: SetupInput,
  found: Discovered,
  app: AgentApp,
  home: string,
  instance: string,
): AgentHome {
  return {
    app,
    home,
    file: fileOf(input, app, home, false),
    isDefault: false,
    variable: targetDef(APPS[app].target).detect.homes?.env ?? "",
    instance,
    account: "",
    hosts: hostsOf(input, found, app, home),
    managed: false,
  };
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
  const rows = input.rows ?? [];
  for (const row of rows) {
    if (!isAgentApp(row.app)) continue;
    if (homes.some((h) => h.app === row.app && samePath(input.platform, h.home, row.home))) {
      continue;
    }
    homes.push(rowHome(input, found, row.app, row.home, row.instance));
  }
  return homes.map((home) => {
    const row = rows.find((r) => r.app === home.app && samePath(input.platform, r.home, home.home));
    return unread(row === undefined ? home : { ...home, instance: row.instance });
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
  return entryArgs(entry)?.instance;
}

/** The `--space` and `--instance` an entry names (entryInstance), or undefined. */
function entryArgs(
  entry: unknown,
): { readonly space: string | null; readonly instance: string | null } | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const args = (entry as { args?: unknown }).args;
  if (!Array.isArray(args) || args[0] !== "mcp" || !args.every((a) => typeof a === "string")) {
    return undefined;
  }
  const parsed = parseArgs(args.slice(1));
  return "problem" in parsed ? undefined : parsed;
}

/**
 * What a person takes out of a home's file by hand to remove an entry of TTasks's name (A3 3.7.8):
 * the one table or member, in the home's own file. Never a command: a pasted command runs in
 * whatever shell and account it is pasted into, which can be another home's.
 */
export function manualRemoval(home: AgentHome): { readonly file: string; readonly what: string } {
  const servers = APPS[home.app].servers;
  return {
    file: home.file,
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

/** A home's access as the service's rows say it: live, off, or unknown when no service answered. */
export function accessOf(input: SetupInput, home: AgentHome): "live" | "off" | "unknown" {
  if (input.rows === undefined) return "unknown";
  return input.rows.some((r) => r.app === home.app && samePath(input.platform, r.home, home.home))
    ? "live"
    : "off";
}

/**
 * The one answer for one settings file of a home (answer.ts), from its facts read now: the access
 * (`access`, else from `input.rows`), the program the entry in the file names, and `space`, the one
 * the person is in ("" for the home's own). `writable` is the plan's refusal of a new entry when the
 * caller has one (several Claude Desktop files).
 */
export function toolsOf(
  input: SetupInput,
  view: HomeView,
  space: string,
  writable?: Refusal,
  access: "live" | "off" | "unknown" = accessOf(input, view.home),
): ToolsAnswer {
  const { home, record } = view;
  const program = programOf(input, view);
  const named = entryArgs(view.entry);
  const own = view.state === "registered" || view.state === "interrupted";
  // What the entry names: the record's, for setup's own entry; else the entry's arguments.
  const bound = own && record !== undefined ? record : named;
  const homeSpace = home.space ?? record?.space;
  const planned = planChange(input, view, "");
  return toolsAnswer({
    state: view.state,
    ...(view.refusal === undefined ? {} : { refusal: view.refusal }),
    entry: view.entry !== undefined,
    ...(program === undefined ? {} : { program }),
    binds:
      bound?.instance === home.instance && (home.space === undefined || bound.space === home.space),
    access,
    otherSpace:
      homeSpace !== undefined &&
      ((space !== "" && homeSpace !== space) ||
        (input.served !== undefined && !input.served.includes(homeSpace))),
    writable: writable ?? (typeof planned === "string" ? planned : true),
    installed: isFile(input.tasks),
    handMade: view.refusal === "foreign_entry" && named?.instance === null,
    // Setup's own entry is still there, or the recorded file is gone and its record is all that is.
    owned: record !== undefined && ((own && view.entry !== undefined) || !fileThere(home.file)),
    owed: home.owed === true,
  });
}

/**
 * Whether an apply renews a file's home's row: the file is set up and its tools start, and the
 * service said its access is live. Without the service nothing is offered.
 */
export function renews(input: SetupInput, view: HomeView, space: string): boolean {
  return (
    view.state === "registered" &&
    view.record !== undefined &&
    accessOf(input, view.home) === "live" &&
    toolsOf(input, view, space).why === undefined
  );
}

/**
 * The program an entry in the file runs: an absolute path as a file, a name alone on the PATH of
 * the person's environment. Setup's own entry running an install that is there but is not this one
 * is `older`; one naming a path that is not there, other than where TTasks is installed now, is
 * `moved` (writing the entry again mends both); anything else not there is `gone`.
 */
function programOf(
  input: SetupInput,
  view: HomeView,
): "there" | "older" | "moved" | "gone" | undefined {
  const command = (view.entry as { command?: unknown } | undefined)?.command;
  if (typeof command !== "string" || command === "") return undefined;
  const { platform } = input;
  if (!pathOf(platform).isAbsolute(command)) {
    const host = nodeDetectHost({ platform, env: input.env, home: input.userHome });
    return onPath(host, command) === undefined ? "gone" : "there";
  }
  const current = samePath(platform, command, input.tasks);
  const own = view.state === "registered";
  if (isFile(command)) return own && !current && isFile(input.tasks) ? "older" : "there";
  return own && !current ? "moved" : "gone";
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * What repairs a file whose entry is gone, runs a program that is gone, or runs an older install,
 * when the answer offers it: setup's entry written again with the present command, in the home's
 * space, in place of the one it replaces, which shows as taken out.
 */
function repairOf(input: SetupInput, view: HomeView, space: string): Change | undefined {
  if (toolsOf(input, view, space).on !== "repair") return undefined;
  const change = planChange(input, view, view.record?.space ?? space);
  if (typeof change === "string") return undefined;
  if (view.state === "missing") return change;
  const { app } = view.home;
  return {
    entry: change.entry,
    diff: [...entryLines(app, view.entry, "-"), ...entryLines(app, change.entry, "+")],
  };
}

/**
 * What applying a file would write, or why it cannot: the entry for the home's own space, or for
 * `space` in a home set up nowhere yet. Reads nothing more.
 */
export function planChange(input: SetupInput, view: HomeView, space: string): Change | Refusal {
  const { home } = view;
  // Claude Desktop makes its file in its developer settings, and a further file's reader makes it:
  // setup never creates them. A home known only by its live row has no file to write.
  if ((home.app === "claude-desktop" || home.further === true) && view.sha256 === null) {
    return "not_set_up";
  }
  if (home.rowOnly === true) return "not_set_up";
  if (!writable(input.platform, home.file, view.sha256 !== null)) return "read_only";
  const entry = intendedEntry(
    APPS[home.app].format,
    entryArgv(input.tasks, home, home.space ?? space),
  );
  return { entry, diff: diffOf(home.app, entry, view.parent) };
}

/**
 * Whether the OS lets this account put a new file in place of `file` (`there`) or beside nothing:
 * the file is not read-only, and its folder, where the new one is written first, takes a new file.
 */
function writable(platform: NodeJS.Platform, file: string, there: boolean): boolean {
  const ok = (path: string) => {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  const folder = pathOf(platform).dirname(file);
  // A file gone since it was read is the write's to find (writeEntry).
  return (!there || !fileThere(file) || ok(file)) && (!fileThere(folder) || ok(folder));
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
        ? repairOf(input, view, space)
        : view.home.app === "claude-desktop" && desktops.length > 1
          ? "ambiguous"
          : planChange(input, view, space),
  }));
}

/**
 * The plan's token (A3 3.13.1): a digest of what apply would do in the selected homes, which the
 * preview prints and `--apply --plan` checks again under the lock, so apply does exactly what the
 * preview showed or refuses. It covers the space, each settings file with its home, instance,
 * account, hosts, space and access (everything the home's row names, and whether apply gives it),
 * its state, what a write there is bound to (HomeView `digest`: for Claude Code its servers' table,
 * which its own saves elsewhere in the file leave as it is) and, for a change, the exact entry.
 * `blocks` is the instruction block's part of the plan (block.ts `blockCanonical`), when the plan
 * holds that part.
 */
export function planToken(
  input: SetupInput,
  space: string,
  items: readonly PlanItem[],
  blocks?: unknown,
): string {
  const canonical = items.map(({ view, change }) => [
    view.home.app,
    view.home.home,
    view.home.file,
    view.home.instance,
    // The row apply makes names the account and the hosts too.
    view.home.account,
    view.home.hosts,
    view.home.space ?? null,
    accessOf(input, view.home),
    view.state,
    view.refusal ?? null,
    view.record?.space ?? null,
    view.digest,
    change === undefined ? null : typeof change === "string" ? change : [change.entry, change.diff],
  ]);
  return createHash("sha256")
    .update(JSON.stringify(blocks === undefined ? [space, canonical] : [space, canonical, blocks]))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Apply and remove
//
// Each settings file of a home goes through these by itself, with its own record. Only the apply
// that finds the home's access off asks for it, and only that apply takes it back when its file
// fails: its record says so (`gives_access`) before it asks, and says it no more once that one
// revoke is done (`spent`). An apply that finds the access live writes a file without touching it.
// Nothing grants while a record of the home still owes its revoke (`owesRevoke`). Turning a home
// off takes its access back first, then each file's entry. A record that is not `applied` is
// finished by the next setup run as a removal.

/** Where a file's record goes (state.ts `saveRecord`). */
function placeOf(input: SetupInput, home: AgentHome): Parameters<typeof saveRecord>[2] {
  const { platform } = input;
  const sameHome = (r: HomeRecord) => r.app === home.app && samePath(platform, r.home, home.home);
  return {
    sameHome,
    sameFile: (r) => sameHome(r) && samePath(platform, r.file, home.file),
    further: home.further === true,
    twoFiled: twoFiled(input, home),
  };
}

/** Puts a file's record in place of the one it has. */
function putRecord(input: SetupInput, home: AgentHome, record: HomeRecord): void {
  saveRecord(input.stateDir, record, placeOf(input, home));
}

/** A record write that failed: its record file, when known. */
interface Unwritten {
  readonly record?: string;
}

/** The record file a failed record write names. */
const unwritableAt = (error: unknown): Unwritten =>
  error instanceof SetupStateUnwritable ? { record: error.file } : {};

/**
 * Puts a file's record in place of the one it has, or drops it (`record` undefined). Every record
 * write of an apply, a removal or a settling goes through here, the first of an add aside
 * (writeEntry): one that fails is said for its file, with its record file, and the apply gives the
 * home nothing more. What it leaves is a record the next run settles.
 */
function writeRecord(
  input: SetupInput,
  home: AgentHome,
  record: HomeRecord | undefined,
): Unwritten | undefined {
  try {
    if (record === undefined) dropRecord(input.stateDir, placeOf(input, home));
    else putRecord(input, home, record);
    return undefined;
  } catch (error) {
    return unwritableAt(error);
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

type Live = "live" | "off" | "unknown";

/** The home's access as the service says it now: its row's ID when live. */
async function accessNow(
  access: Access,
  home: AgentHome,
): Promise<{ state: Live; grant?: string }> {
  try {
    const row = await access.read(home);
    return row === null ? { state: "off" } : { state: "live", grant: row.grant };
  } catch {
    return { state: "unknown" };
  }
}

/** Each file's outcome with the home's access as the service says it now, once for all. */
async function withAccess(
  access: Access,
  home: AgentHome,
  outcomes: readonly Outcome[],
): Promise<Outcome[]> {
  const { state } = await accessNow(access, home);
  const said = state === "live" ? "on" : state;
  return outcomes.map((outcome) => ({ ...outcome, access: said }));
}

const timer = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/**
 * Runs `work` under the app's own lock on the file (Claude Code's), or at once for an app that has
 * none. `busy` when another writer keeps the lock through every pause, `unwritable` when the lock
 * cannot be made beside the file.
 */
async function underAppLock<T>(
  input: SetupInput,
  home: AgentHome,
  work: () => T,
): Promise<T | "busy" | "unwritable"> {
  if (!APPS[home.app].locked) return work();
  const ran = await withAppLock(home.file, input.wait ?? timer, work);
  return ran.held ? ran.value : ran.why;
}

/** How often a change is worked out again when another program saved the file in between. */
const TRIES = 3;

type Written = "done" | "too_large" | "changed_meanwhile" | "unwritable" | "busy";

class ChangedMeanwhile extends Error {}

/**
 * Whether the file is still exactly `before` (undefined: still no file), in a place setup may
 * write. A stat or two and one read: what runs under the app's lock.
 */
function stillAsRead(home: AgentHome, before: Buffer | undefined): boolean {
  if (placeRefusal(home.file, home.home) !== undefined) return false;
  const again = readConfigFile(home.file, APPS[home.app].maxBytes);
  if (again.kind === "missing") return before === undefined;
  return (
    again.kind === "bytes" &&
    before !== undefined &&
    !unsafe(again.stat) &&
    before.equals(again.bytes)
  );
}

/**
 * Puts `whole` in place of the bytes `before` setup read (undefined: no file yet), with the file's
 * own mode. The new file is written and flushed beside the old one first; under the app's own lock
 * the file is only compared once more and the new one renamed over it, or, where there was no
 * file, put in place only where nothing is (StagedFile.create). A file the OS will not let setup
 * write (read-only, held by another program, a full disk) is `unwritable`.
 */
async function writeHomeFile(
  input: SetupInput,
  home: AgentHome,
  before: Buffer | undefined,
  whole: string,
): Promise<Written> {
  if (Buffer.byteLength(whole, "utf8") > APPS[home.app].maxBytes) return "too_large";
  let mode = 0o600;
  if (before !== undefined) {
    try {
      mode = lstatSync(home.file).mode & 0o777;
    } catch {
      return "changed_meanwhile";
    }
  }
  let staged: StagedFile;
  try {
    staged = stageFile(home.file, whole, mode);
  } catch {
    return "unwritable";
  }
  try {
    return await underAppLock(input, home, (): Written => {
      if (before === undefined) {
        return placeRefusal(home.file, home.home) === undefined && staged.create()
          ? "done"
          : "changed_meanwhile";
      }
      staged.replace(() => {
        if (!stillAsRead(home, before)) throw new ChangedMeanwhile();
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
  before: Buffer,
): Promise<Written> {
  try {
    return await underAppLock(input, home, (): Written => {
      if (!stillAsRead(home, before)) return "changed_meanwhile";
      rmSync(home.file);
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
  /** A record of the file could not be written. */
  readonly unwritten?: Unwritten;
}

/**
 * Writes the file's record (`applying`, with the entry as setup intends it, and `gives_access` when
 * its apply asks for the home's access), then the entry into the file as it is now: a new one, or
 * setup's own written again in its place (a repair). The file must still be as the preview showed
 * it (HomeView `digest`): Claude Code's own saves elsewhere in its file are read and worked out
 * again, a few times; any other change leaves the file alone. A further file that is gone is never
 * created. When nothing was written, the record is as it was before.
 */
async function writeEntry(
  input: SetupInput,
  view: HomeView,
  space: string,
  change: Change,
  gives: boolean,
): Promise<HomeRecord | NotWritten> {
  const { home } = view;
  const { format, servers, locked } = APPS[home.app];
  const failed = (reason: OutcomeReason): NotWritten => ({ result: "failed", reason });
  // A repair writes setup's entry again where it is; the record it had comes back if nothing is written.
  const before = view.record?.state === "applied" ? view.record : undefined;
  const replacing = view.entry !== undefined ? before : undefined;
  for (let attempt = 1; ; attempt += 1) {
    const now = readHomeFile(home);
    if (now.kind === "refused" || (now.kind === "missing" && home.further === true)) {
      return failed("changed_meanwhile");
    }
    const there =
      replacing === undefined
        ? entryOf(now) === undefined
        : whoseIn(home, now, replacing) === "own";
    if (!there || digestOf(home, now) !== view.digest) {
      return failed("changed_meanwhile");
    }
    let text = now.kind === "read" ? now.text : format === "json" ? EMPTY_JSON : "";
    if (replacing !== undefined) {
      const out = removeOwnEntry(format, servers, text, replacing.made);
      if (!out.ok)
        return failed(out.reason === "invalid_file" ? "invalid_file" : "unsupported_layout");
      text = out.text;
    }
    const edited = addOwnEntry(format, servers, text, change.entry);
    if (!edited.ok) {
      return failed(edited.reason === "invalid_file" ? "invalid_file" : "unsupported_layout");
    }
    const record: HomeRecord = {
      app: home.app,
      home: home.home,
      file: home.file,
      is_default: home.isDefault,
      instance: home.instance,
      account: home.account,
      space,
      state: "applying",
      gives_access: gives,
      entry: change.entry,
      also: replacing === undefined ? [] : [replacing.entry, ...replacing.also],
      made: {
        ...edited.made,
        file: replacing === undefined ? now.kind === "missing" : replacing.made.file,
      },
      grant: before?.grant ?? null,
      at: new Date().toISOString(),
    };
    try {
      putRecord(input, home, record);
    } catch (error) {
      // What setup's reader could not read back (millions of line breaks inside an empty servers
      // object, which the record keeps to give them back) is a layout setup cannot keep.
      if (error instanceof SetupStateTooLarge)
        return { result: "left", reason: "unsupported_layout" };
      if (error instanceof SetupStateInvalid || error instanceof SetupStateUnsafe) throw error;
      return { ...failed("state_unwritable"), unwritten: unwritableAt(error) };
    }
    const bytes = now.kind === "read" ? now.bytes : undefined;
    const bom = now.kind === "read" && now.bom ? BOM : "";
    const wrote = await writeHomeFile(input, home, bytes, `${bom}${edited.text}`);
    if (wrote === "done") return record;
    // Nothing was written: the record goes back to what it was. One that cannot be is left
    // `applying`, which the next run settles as a removal.
    const unwritten = writeRecord(input, home, before);
    if (!(wrote === "changed_meanwhile" && locked && attempt < TRIES)) {
      return { ...failed(wrote), ...(unwritten === undefined ? {} : { unwritten }) };
    }
  }
}

/** What one file's step did, and the home's access as that step leaves it when it changed. */
interface Step {
  readonly outcome: Outcome;
  readonly access?: Live;
  /**
   * A record of the file could not be written (its record file, when known): the apply gives the
   * home nothing more.
   */
  readonly unwritten?: Unwritten;
}

/**
 * Puts setup's entry into one file (writeEntry) and reads it back. `gives`: the home's access was
 * off when this apply began and no file of it got it since, so this file asks for it, then reads
 * its entry back once more. The record says `applied` last. Anything else takes this file back
 * (undo), and only this file.
 */
async function putEntry(
  input: SetupInput,
  view: HomeView,
  space: string,
  change: Change,
  access: Access,
  gives: boolean,
): Promise<Step> {
  const { home } = view;
  const written = await writeEntry(input, view, space, change, gives);
  if (!("entry" in written)) {
    const { unwritten, ...outcome } = written;
    return {
      outcome: { home, ...outcome, ...unwritten },
      ...(unwritten === undefined ? {} : { unwritten }),
    };
  }
  const placed = entryNow(home, written);
  if (placed.whose !== "own") {
    return undo(input, home, written, access, placed.reason, false, placed.whose !== "unchecked");
  }
  let { grant } = written;
  if (gives) {
    try {
      grant = await access.grant(home, space);
    } catch (error) {
      // A row the service made before its answer was lost is taken back too.
      return undo(input, home, written, access, grantReason(error), true);
    }
    const after = entryNow(home, written);
    if (after.whose !== "own") {
      return undo(input, home, written, access, after.reason, true, after.whose !== "unchecked");
    }
  }
  const applied: HomeRecord = {
    app: written.app,
    home: written.home,
    file: written.file,
    is_default: written.is_default,
    instance: written.instance,
    account: written.account,
    space: written.space,
    state: "applied",
    entry: written.entry,
    also: [],
    made: written.made,
    grant,
    at: written.at,
  };
  const unwritten = writeRecord(input, home, applied);
  if (unwritten !== undefined) {
    return undo(input, home, written, access, "state_unwritable", gives, true, unwritten);
  }
  return { outcome: { home, result: "applied" }, ...(gives ? { access: "live" as const } : {}) };
}

/**
 * Setup's entry in the file as a read right now finds it. A read that fails cannot tell what is
 * there (`unchecked`): only a read that succeeds decides that the entry is gone or not setup's.
 */
function entryNow(
  home: AgentHome,
  record: HomeRecord,
):
  | { readonly whose: "own" }
  | { readonly whose: "edited" | "absent" | "unchecked"; readonly reason: OutcomeReason } {
  const read = readHomeFile(home);
  if (read.kind === "refused") return { whose: "unchecked", reason: read.refusal };
  const whose = whoseIn(home, read, record);
  return whose === "own" ? { whose } : { whose, reason: "changed_meanwhile" };
}

/**
 * Takes back one file's entry that cannot stand. The decision is recorded first (`removing`), then
 * the home's access goes when this file's apply asked for it (`asked`), then the entry when a read
 * shows it is still setup's own. After a read that failed, or a revoke the service did not confirm,
 * the file is not touched and the record stays `removing`: the next run takes the access and then
 * the entry out. A record that cannot be written stays as it was, which the next run settles all
 * the same. `unwritten`: the record write that failed before this undo, when one did.
 */
async function undo(
  input: SetupInput,
  home: AgentHome,
  record: HomeRecord,
  access: Access,
  reason: OutcomeReason,
  asked: boolean,
  readable = true,
  unwritten?: Unwritten,
): Promise<Step> {
  // A record that cannot be written is said, with the outcome: the apply then grants nothing more
  // for the home, since the record may still owe a revoke the next run asks for.
  let stuckAt = unwritten;
  const write = (next: HomeRecord | undefined) => {
    const failed = writeRecord(input, home, next);
    stuckAt ??= failed;
  };
  const removing = { ...record, state: "removing" as const };
  write(removing);
  const gave = asked && record.gives_access === true;
  const off = gave ? await revoked(access, home) : true;
  const failed = (note: string): Outcome => ({
    home,
    result: "failed",
    reason,
    notes: [note],
    ...stuckAt,
  });
  const stuck = () => (stuckAt === undefined ? {} : { unwritten: stuckAt });
  if (!off) return { outcome: failed("undo_failed"), access: "unknown", ...stuck() };
  // No revoke is owed any more: what is left is the entry, whenever it can be taken out.
  const done = spent(removing);
  write(done);
  const settled = gave ? { access: "off" as const } : {};
  if (!readable) return { outcome: failed("undo_failed"), ...settled, ...stuck() };
  const out = await takeOut(input, home, done);
  if (out.record !== undefined) stuckAt ??= { record: out.record };
  const note = out.kept === "own" ? "undo_failed" : out.kept === "edited" ? "entry_left" : "undone";
  return { outcome: failed(note), ...settled, ...stuck() };
}

/** A record whose revoke is done, or was never owed: it takes nothing back from now on. */
const spent = (record: HomeRecord): HomeRecord => ({ ...record, gives_access: false });

/**
 * Whether a record may still take its home's access back: one pending with the mark, or an earlier
 * build's pending record, which has none. Nothing grants for the home until it is settled.
 */
const owesRevoke = (record: HomeRecord | undefined): boolean =>
  record !== undefined && record.state !== "applied" && record.gives_access !== false;

/**
 * Gives a file's intact entry its home's access back (the answer's `grant`): complete once the
 * service confirms it. The record stays `applied`; it only takes the row's ID. Not confirmed, the
 * entry stays as it is.
 */
async function grantBack(
  input: SetupInput,
  view: HomeView,
  record: HomeRecord,
  access: Access,
): Promise<Step> {
  const { home } = view;
  let grant: string;
  try {
    grant = await access.grant(home, home.space ?? record.space);
  } catch (error) {
    return { outcome: { home, result: "failed", reason: grantReason(error) }, access: "unknown" };
  }
  // The access is given all the same; a record that does not take the row's ID is said, and the
  // apply gives the home nothing more.
  const unwritten =
    record.grant === grant ? undefined : writeRecord(input, home, { ...record, grant });
  if (unwritten !== undefined) {
    return {
      outcome: { home, result: "unchanged", reason: "state_unwritable", ...unwritten },
      access: "live",
      unwritten,
    };
  }
  return { outcome: { home, result: "unchanged" }, access: "live" };
}

/**
 * Turns a home's tools on as each file's answer (toolsOf) offers it from `space`, one file after
 * another, whatever the one before did, and does nothing an answer does not offer. The home's
 * access is asked for first: off, the first file that turns the tools on asks for it (putEntry);
 * live, each file is added or repaired without touching it; unknown, nothing that needs it is
 * done. Nothing is given to the home (an add, a repair, its access back, the renewal) while a
 * record of it owes its revoke, read from the records each time (what was given would be taken back
 * with it), nor after a record of it could not be written in this apply. An apply that turns
 * nothing on renews the live row once, for the space the home's entries name, so it names the
 * home's account and hosts as they are now. Each file's result is judged by the access as it is
 * when that file's turn comes. `items` are one home's files from planOf, the first first. Each
 * outcome says the home's access as the service says it after the last file.
 */
export async function applyFiles(
  input: SetupInput,
  items: readonly PlanItem[],
  space: string,
  access: Access,
): Promise<Outcome[]> {
  const home = items[0]?.view.home;
  if (home === undefined) return [];
  const start = await accessNow(access, home);
  let state = start.state;
  const outcomes: Outcome[] = [];
  const renewed: number[] = [];
  let turned = false;
  let unwritten: { readonly record?: string } | undefined;
  /** Why nothing may be given to the home now, when it may not: the one check before each grant. */
  const held = (): Pick<Outcome, "reason" | "record"> | undefined => {
    if (unwritten !== undefined) return { reason: "state_unwritable", ...unwritten };
    const owed = setupRecords(input.stateDir).all.some(
      (r) => r.app === home.app && samePath(input.platform, r.home, home.home) && owesRevoke(r),
    );
    return owed ? { reason: "interrupted" } : undefined;
  };
  for (const { view, change } of items) {
    const refusal = typeof change === "string" ? change : undefined;
    const answer = toolsOf(input, view, space, refusal, state);
    const left = (reason?: OutcomeReason): Outcome => ({
      home: view.home,
      result: "left",
      reason: reason ?? answer.why ?? (state === "unknown" ? "access_unknown" : "not_registered"),
    });
    let step: Step;
    if (answer.on !== undefined) turned = true;
    const stop = answer.on === undefined ? undefined : held();
    if (stop !== undefined) {
      step = { outcome: { home: view.home, result: "left", ...stop } };
    } else if (answer.on === "add" || answer.on === "repair") {
      const planned =
        answer.on === "repair"
          ? repairOf(input, view, space)
          : view.state !== "not_registered"
            ? undefined
            : typeof change === "object"
              ? change
              : planChange(input, view, space);
      step =
        typeof planned === "object"
          ? await putEntry(input, view, view.home.space ?? space, planned, access, state === "off")
          : { outcome: left(planned) };
    } else if (answer.on === "grant" && view.record !== undefined) {
      step =
        state === "live"
          ? { outcome: { home: view.home, result: "unchanged" } }
          : await grantBack(input, view, view.record, access);
    } else if (view.state === "registered" && answer.why === undefined && state === "live") {
      // On as it stands: renewed below when the access was live from the start.
      if (start.state === "live" && view.record !== undefined) renewed.push(outcomes.length);
      step = { outcome: { home: view.home, result: "unchanged" } };
    } else {
      step = { outcome: left() };
    }
    outcomes.push(step.outcome);
    if (step.access !== undefined) state = step.access;
    unwritten ??= step.unwritten;
  }
  const first = renewed[0];
  if (first !== undefined && !turned && held() === undefined) {
    const record = items[first]?.view.record;
    try {
      await access.grant(home, home.space ?? record?.space ?? space);
    } catch (error) {
      for (const at of renewed) {
        const outcome = outcomes[at];
        if (outcome !== undefined) {
          outcomes[at] = { home: outcome.home, result: "failed", reason: grantReason(error) };
        }
      }
    }
  }
  return withAccess(access, home, outcomes);
}

/** One file of a home turned on alone: applyFiles for that file. */
export async function applyHome(
  input: SetupInput,
  view: HomeView,
  space: string,
  access: Access,
  planned?: Change | Refusal,
): Promise<Outcome> {
  const [outcome] = await applyFiles(input, [{ view, change: planned }], space, access);
  return outcome ?? { home: view.home, result: "left", reason: "not_registered" };
}

/**
 * Turns a home off: its access first, alone. When the service does not confirm that, nothing else
 * changes. Then each file as takeBack takes it, a recorded file that is gone included.
 * `views` are one home's files, the first first. Each outcome says the home's access as the service
 * says it after the last file.
 */
export async function removeFiles(
  input: SetupInput,
  views: readonly HomeView[],
  access: Access,
): Promise<Outcome[]> {
  const home = views[0]?.home;
  if (home === undefined) return [];
  if (!(await revoked(access, home))) {
    return views.map((view) => ({
      home: view.home,
      result: "failed",
      reason: "revoke_failed",
      access: "unknown",
    }));
  }
  const outcomes: Outcome[] = [];
  for (const view of views) outcomes.push(await takeBack(input, view));
  return withAccess(access, home, outcomes);
}

/** One file of a home turned off: removeFiles for that file. */
export async function removeHome(
  input: SetupInput,
  view: HomeView,
  access: Access,
): Promise<Outcome> {
  const [outcome] = await removeFiles(input, [view], access);
  return outcome ?? { home: view.home, result: "unchanged", reason: "not_registered" };
}

/**
 * One file's part of turning its home off, once the home's access is off or owed no revoke: the
 * record says `removing` and that nothing is left to revoke, then the entry comes out while it is
 * still setup's own (takeOut). Without its record
 * setup changes nothing there, and says what stays: an entry of TTasks's name it has no record of
 * is the person's. A record that cannot be written leaves the entry in its file.
 */
async function takeBack(input: SetupInput, view: HomeView): Promise<Outcome> {
  const { home, record } = view;
  if (record === undefined) {
    if (view.refusal === "record_unreadable") {
      return {
        home,
        result: "left",
        reason: "record_unreadable",
        ...(view.entry === undefined ? {} : { kept: "own" as const }),
      };
    }
    if (view.entry !== undefined) {
      return { home, result: "left", reason: "foreign_entry", kept: "unrecorded" };
    }
    return { home, result: "unchanged", reason: "not_registered" };
  }
  const removing = spent({ ...record, state: "removing" });
  if (record.state !== "removing" || record.gives_access !== false) {
    const unwritten = writeRecord(input, home, removing);
    if (unwritten !== undefined) {
      const whose = whoseIn(home, readHomeFile(home), record);
      return {
        home,
        result: "failed",
        reason: "state_unwritable",
        ...unwritten,
        ...(whose === "absent" ? {} : { kept: whose }),
      };
    }
  }
  return takeOut(input, home, removing);
}

/**
 * The file's part of a removal: TTasks's entry out when it is still its own, with what its add made
 * (the servers' table, the bytes around it, the file itself when nothing else is left in it). No
 * file is no entry, so a home whose folder is gone is done. The record goes once nothing of
 * TTasks's is left there. An entry the person changed stays, and is theirs from then on. An entry of
 * TTasks's that could not be taken out keeps its record, so the next setup tries again.
 */
async function takeOut(input: SetupInput, home: AgentHome, record: HomeRecord): Promise<Outcome> {
  const { format, servers } = APPS[home.app];
  // The record goes; one that cannot be dropped is said, and the next run forgets it.
  const done = (outcome: Outcome): Outcome => ({
    ...outcome,
    ...writeRecord(input, home, undefined),
  });
  for (let attempt = 1; ; attempt += 1) {
    const read = readHomeFile(home);
    if (read.kind === "refused") {
      return { home, result: "left", reason: read.refusal, kept: "own" };
    }
    if (read.kind === "missing") {
      return done({ home, result: "removed", reason: "missing", notes: ["file_gone"] });
    }
    const whose = whoseIn(home, read, record);
    if (whose === "absent") return done({ home, result: "removed", reason: "missing" });
    if (whose === "edited") return done({ home, result: "left", reason: "edited", kept: "edited" });
    const edited = removeOwnEntry(format, servers, read.text, record.made);
    if (!edited.ok) {
      const reason = edited.reason === "invalid_file" ? "invalid_file" : "unsupported_layout";
      return { home, result: "failed", reason, kept: "own" };
    }
    const wrote =
      record.made.file && holdsNothing(format, edited.text)
        ? await deleteHomeFile(input, home, read.bytes)
        : await writeHomeFile(input, home, read.bytes, `${read.bom ? BOM : ""}${edited.text}`);
    if (wrote === "done") return done({ home, result: "removed" });
    if (wrote !== "changed_meanwhile" || attempt >= TRIES) {
      return { home, result: "failed", reason: wrote, kept: "own" };
    }
  }
}

/**
 * Settles what a setup run left midway (a crash, a closed terminal, an undo that could not finish):
 * run first by every apply, under the setup lock, so a record that is not `applied` then is no
 * other run's. Each is finished as a removal of its file's entry (takeBack); the home's access goes
 * first only for a record whose apply asked for it, and when the service does not confirm that,
 * that file stays as it is. A record that cannot be read leaves nothing to settle: survey says so.
 */
export async function settleHomes(input: SetupInput, access: Access): Promise<Outcome[]> {
  const pending = setupRecords(input.stateDir).all.filter((r) => r.state !== "applied");
  if (pending.length === 0) return [];
  const found = discover(input);
  const outcomes: Outcome[] = [];
  for (const record of pending) {
    const home = await homeOfRecord(input, found, record);
    // An earlier build's pending record has no mark: settled as that build does, with the revoke.
    if (owesRevoke(record) && !(await revoked(access, home))) {
      outcomes.push({ home, result: "failed", reason: "revoke_failed", access: "unknown" });
      continue;
    }
    outcomes.push(
      ...(await withAccess(access, home, [await takeBack(input, inspectHome(home, record))])),
    );
  }
  return outcomes;
}
