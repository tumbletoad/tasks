// Where the other agent apps keep what setup reads (A3 3.13.3, 3.13.5, 3.13.6; M4.05). Every path
// comes from the injected input (the person's environment and home folder), so tests run on
// scratch folders; nothing here writes, and nothing here opens a sign-in file.
//
// - Claude Desktop: its `claude_desktop_config.json` folder. Windows has three layouts (the MSIX
//   app's `%LOCALAPPDATA%\Claude-Data\claude_<package id>\`, older MSIX builds'
//   `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\`, a classic install's
//   `%APPDATA%\Claude\`), Linux `~/.config/Claude/` (XDG_CONFIG_HOME when set), macOS
//   `~/Library/Application Support/Claude/`.
// - The Codex app: it reads the default Codex home, like the CLI, and bundles its own Codex engine
//   (Windows `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, macOS inside `Codex.app`). The
//   engine is a second reader of that home's entry (doctor's `codex.engines`), and the command
//   setup runs there when no Codex CLI is installed.
// - T3 Code: its provider instances, read-only from `<T3CODE_HOME or ~/.t3>/userdata/settings.json`,
//   in the shape T3 writes them (t3ProviderInstances below, A3 3.13.6).
// - A Codex shadow home: a folder whose `config.toml` is a link to the `config.toml` of another
//   Codex home (T3's `shadowHomePath`, or one a person made the same way). Codex run there reads
//   the shared file, so the shared home is the one with the entry (codexSharedHome).
import { lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { envValue, INSTANCE_ID, targetDef, type Env, type Proposal } from "@ttasks/launch";
import type { AgentApp } from "./state.ts";

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** What discovery takes from setup's input. */
export interface HostsInput {
  readonly platform: NodeJS.Platform;
  readonly userHome: string;
  readonly env: Env;
  /** macOS: the system's Applications folder, where the Codex app may be. Default: /Applications. */
  readonly systemApplications?: string;
}

/** Claude Desktop's configuration file in its folder. */
export const DESKTOP_FILE = "claude_desktop_config.json";

const kindOf = (path: string): "dir" | "file" | undefined => {
  try {
    const s = statSync(path);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
};

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

const absolute = (input: HostsInput, name: string): string | undefined => {
  const value = envValue(input.env, name, input.platform);
  return value !== undefined && pathOf(input.platform).isAbsolute(value) ? value : undefined;
};

/** Every folder where Claude Desktop may keep its configuration on this machine, that exists. */
export function claudeDesktopFolders(input: HostsInput): string[] {
  const p = pathOf(input.platform);
  const candidates: string[] = [];
  if (input.platform === "win32") {
    // eslint-disable-next-line no-restricted-syntax -- where Claude Desktop keeps its file, never a path TTasks writes for itself
    const local = absolute(input, "LOCALAPPDATA");
    // eslint-disable-next-line no-restricted-syntax -- where Claude Desktop keeps its file, never a path TTasks writes for itself
    const roaming = absolute(input, "APPDATA");
    if (local !== undefined) {
      const data = p.join(local, "Claude-Data");
      for (const name of names(data)) {
        if (/^claude_/iu.test(name)) candidates.push(p.join(data, name));
      }
      const packages = p.join(local, "Packages");
      for (const name of names(packages)) {
        if (/^claude_/iu.test(name)) {
          candidates.push(p.join(packages, name, "LocalCache", "Roaming", "Claude"));
        }
      }
    }
    if (roaming !== undefined) candidates.push(p.join(roaming, "Claude"));
  } else if (input.platform === "darwin") {
    candidates.push(p.join(input.userHome, "Library", "Application Support", "Claude"));
  } else {
    const config = absolute(input, "XDG_CONFIG_HOME") ?? p.join(input.userHome, ".config");
    candidates.push(p.join(config, "Claude"));
  }
  return candidates.filter((dir) => kindOf(dir) === "dir");
}

/** The Codex app's bundled engines on this machine, newest folder name last. */
export function codexAppEngines(input: HostsInput): string[] {
  const p = pathOf(input.platform);
  const engines: string[] = [];
  if (input.platform === "win32") {
    // eslint-disable-next-line no-restricted-syntax -- where the Codex app keeps its engine, only read
    const local = absolute(input, "LOCALAPPDATA");
    if (local !== undefined) {
      const bin = p.join(local, "OpenAI", "Codex", "bin");
      for (const name of names(bin)) engines.push(p.join(bin, name, "codex.exe"));
    }
  } else if (input.platform === "darwin") {
    const system = input.systemApplications ?? "/Applications";
    for (const apps of [p.join(input.userHome, "Applications"), system]) {
      engines.push(p.join(apps, "Codex.app", "Contents", "Resources", "codex"));
    }
  }
  return engines.filter((file) => kindOf(file) === "file");
}

// ---------------------------------------------------------------------------------------------
// T3 Code's provider instances (A3 3.13.6)
//
// The facts come from T3 Code's own source (MIT; `packages/contracts/src/providerInstance.ts` and
// `settings.ts`, `apps/server/src/serverSettings.ts`, the Codex and Claude drivers; the commit is
// named in A3 3.13.6). Only facts are taken, no code:
// - `providerInstances` is a record keyed by instance ID (`^[a-zA-Z][a-zA-Z0-9_-]*$`, at most 64).
//   Each value is `{driver, displayName?, accentColor?, environment?: [{name, value, sensitive,
//   secret?}], enabled?, config?}`; `config` is the driver's own settings.
// - Every built-in driver has a default instance whose ID is the driver kind, also when the file
//   does not list it. Unlisted, only `codex` and `claudeAgent` are enabled.
// - An instance is off when its own `enabled` or its config's `enabled` is false.
// - A legacy top-level `providers: {<driver>: {...}}` becomes `providerInstances[<driver>] =
//   {driver, enabled?, config}` when the settings load, unless that ID is listed already.
// - The home: `config.homePath` when not blank (`~` and `~/` expanded), else the home variable as
//   the instance's `environment` sets it (`~` expanded; on Windows matched in any case, the last one
//   wins, and an empty value replaces the inherited one too), else the variable T3 inherited (`~`
//   expanded for Codex only), else `~/.codex` or `~/.claude` when the value is blank. Codex keeps a
//   path as written, Claude trims it. A relative path is resolved against T3's working folder,
//   which TTasks cannot know, so its instance is skipped. A Codex instance in `setupMode: "managed"`
//   ignores the variables. A Claude home named by a path is CLAUDE_CONFIG_DIR, so Claude Code reads
//   `.claude.json` inside it. An instance turned off runs nothing, and its home is not worked out.
// - Codex's `config.shadowHomePath` is the folder Codex runs in, whose entries other than the
//   sign-in are links into the home above: its `config.toml` is the home's.
//
// Of an `environment` entry only the name, and the value of a home variable, are read: every other
// value can be a secret and is never read, kept or printed. A value kept in T3's secret store (a
// `secret` reference) is not known here, so its instance is skipped as `secret_home`.

/** The T3 drivers whose agents TTasks registers its tools for and opens tasks in. */
export const T3_AGENT_DRIVERS = { codex: "codex", claudeAgent: "claude-code" } as const;
export type T3AgentDriver = keyof typeof T3_AGENT_DRIVERS;

/** T3's other built-in drivers: their agents are not TTasks's, so they are passed over quietly. */
const T3_OTHER_DRIVERS: ReadonlySet<string> = new Set([
  "cursor",
  "grok",
  "fx",
  "opencode",
  "antigravity",
  "kiro",
  "pi",
  "muse",
  "acpRegistry",
]);

/** T3's pattern for an instance ID and a driver kind. */
const T3_SLUG = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u;

/** One enabled provider instance of a driver TTasks knows, as T3 runs it. */
export interface T3ProviderInstance {
  /** Its key in `providerInstances`, which T3's `--provider` and `instanceId` take. */
  readonly id: string;
  readonly driver: T3AgentDriver;
  readonly app: Extract<AgentApp, "claude-code" | "codex">;
  /** T3's display name, when the settings give one. */
  readonly displayName?: string;
  /** Listed in the settings; false for a built-in default instance the file does not name. */
  readonly listed: boolean;
  /** The home whose file holds the entry its agent reads (a shadow home's shared home). */
  readonly home: string;
  /** Whether no variable selects the home: the app's default home. */
  readonly isDefault: boolean;
  /** Codex: the shadow home T3 runs the agent in, whose `config.toml` is the home's. */
  readonly shadow?: string;
}

/** Why an entry of T3's settings was passed over (named by doctor's `t3.homes`). */
export type T3Skip =
  /** A driver T3 did not have when TTasks was built: never guessed. */
  | "unknown_driver"
  /** The entry is not of the form T3 writes, or its home is no absolute folder. */
  | "invalid_entry"
  /** Its home variable is in T3's secret store: TTasks cannot know the home. */
  | "secret_home";

/** What T3's settings say, for setup and doctor. */
export interface T3Settings {
  /** `read`, or what kept the file from being read: then T3's defaults stand. */
  readonly file: "read" | "missing" | "refused";
  /** The enabled instances of a driver TTasks knows: the only ones that run agents. */
  readonly instances: readonly T3ProviderInstance[];
  /** The keys of instances of those drivers that T3 has turned off, their homes not worked out. */
  readonly off: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: T3Skip }[];
  /** T3's `defaultModelSelection`, when it names a provider instance and a plain model. */
  readonly defaultModel?: { readonly instance: string; readonly model: string };
}

/** One home a T3 provider instance runs its agent in. */
export interface T3Home {
  readonly app: Extract<AgentApp, "claude-code" | "codex">;
  /** The provider instance's key in T3's settings. */
  readonly provider: string;
  readonly home: string;
  /** Whether T3 selects it by no variable: the app's default home. */
  readonly isDefault: boolean;
}

/** T3's own folder: T3CODE_HOME when the environment names an absolute one, else `~/.t3`. */
export function t3Folder(input: HostsInput): string {
  return absolute(input, "T3CODE_HOME") ?? pathOf(input.platform).join(input.userHome, ".t3");
}

export const t3SettingsFile = (input: HostsInput): string =>
  pathOf(input.platform).join(t3Folder(input), "userdata", "settings.json");

/** Whether T3 Code is on this machine: its folder is there (detection's rule, A4 3.2). */
export const hasT3 = (input: HostsInput): boolean => {
  try {
    return lstatSync(t3Folder(input)).isDirectory();
  } catch {
    return false;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class Skip extends Error {
  readonly reason: T3Skip;
  constructor(reason: T3Skip) {
    super(reason);
    this.reason = reason;
  }
}

/** T3's `~` expansion: `~`, `~/…` and `~\…` against the user's home folder, nothing else. */
function expandHome(input: HostsInput, value: string): string {
  const p = pathOf(input.platform);
  if (value === "~") return input.userHome;
  if (value.startsWith("~/") || value.startsWith("~\\"))
    return p.join(input.userHome, value.slice(2));
  return value;
}

/**
 * A path value T3 resolves: absolute after `~` expansion (when T3 expands that value), or the entry
 * is skipped. T3 resolves a relative one against its own working folder, which TTasks cannot know.
 */
function folderOf(input: HostsInput, value: string, expand = true): string {
  const p = pathOf(input.platform);
  const expanded = expand ? expandHome(input, value) : value;
  if (!p.isAbsolute(expanded)) throw new Skip("invalid_entry");
  return p.resolve(expanded);
}

/** An optional string key: undefined when absent, as written otherwise; another type is skipped. */
function optionalRaw(table: Record<string, unknown>, key: string): string | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Skip("invalid_entry");
  return value;
}

/** An optional string key: undefined when absent, trimmed otherwise; another type is skipped. */
function optionalText(table: Record<string, unknown>, key: string): string | undefined {
  return optionalRaw(table, key)?.trim();
}

function optionalFlag(table: Record<string, unknown>, key: string): boolean | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Skip("invalid_entry");
  return value;
}

/**
 * The value the home variable gets from an instance's `environment`, or undefined when no entry
 * names it. An entry sets the variable as it is, an empty value too, and replaces the inherited one.
 * Only entries of that name are looked at; another entry's value is never read.
 */
function environmentHome(
  input: HostsInput,
  environment: unknown,
  variable: string,
): string | undefined {
  if (environment === undefined) return undefined;
  if (!Array.isArray(environment)) throw new Skip("invalid_entry");
  const same = (name: string) =>
    input.platform === "win32" ? name.toUpperCase() === variable : name === variable;
  let found: string | undefined;
  for (const item of environment as unknown[]) {
    if (!isObject(item) || typeof item["name"] !== "string") throw new Skip("invalid_entry");
    if (!same(item["name"])) continue;
    if (item["secret"] !== undefined) throw new Skip("secret_home");
    const value = item["value"];
    if (typeof value !== "string") throw new Skip("invalid_entry");
    found = value;
  }
  return found;
}

/** Whether T3 turns an instance off (`value` an entry of T3's form, `config` its config). */
const isOff = (value: Record<string, unknown>, config: Record<string, unknown>): boolean =>
  optionalFlag(value, "enabled") === false || optionalFlag(config, "enabled") === false;

/**
 * The home an enabled instance of a driver TTasks knows runs its agent in, as T3's drivers resolve
 * it, or undefined for the app's default home. A path names a home when it is not blank: Codex keeps
 * it as written, Claude trimmed. `~` is expanded in `homePath`, in an `environment` entry, and in an
 * inherited CODEX_HOME, but not in an inherited CLAUDE_CONFIG_DIR, which T3 takes literally.
 */
function homeOfInstance(
  input: HostsInput,
  app: T3ProviderInstance["app"],
  value: Record<string, unknown>,
  config: Record<string, unknown>,
): string | undefined {
  const codex = app === "codex";
  const named = (path: string | undefined): string | undefined =>
    path === undefined || path.trim() === "" ? undefined : codex ? path : path.trim();
  const homePath = named(optionalRaw(config, "homePath"));
  if (homePath !== undefined) return folderOf(input, homePath);
  // A Codex instance T3 manages takes no home from a variable.
  if (codex && config["setupMode"] === "managed") return undefined;
  const variable = codex ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  // The instance's entry replaces the inherited variable, also when it is empty.
  const own = environmentHome(input, value["environment"], variable);
  if (own !== undefined) {
    const path = named(own);
    return path === undefined ? undefined : folderOf(input, path);
  }
  const inherited = named(envValue(input.env, variable, input.platform));
  return inherited === undefined ? undefined : folderOf(input, inherited, codex);
}

/** One listed or default instance of a driver TTasks knows, as T3 runs it; undefined when off. */
function instanceOf(
  input: HostsInput,
  id: string,
  driver: T3AgentDriver,
  value: Record<string, unknown>,
  listed: boolean,
): T3ProviderInstance | undefined {
  const p = pathOf(input.platform);
  const app = T3_AGENT_DRIVERS[driver];
  const config = value["config"] ?? {};
  if (!isObject(config)) throw new Skip("invalid_entry");
  // An instance turned off runs nothing: its home is not worked out, so it is never a host.
  if (isOff(value, config)) return undefined;
  const displayName = optionalText(value, "displayName");
  const home = homeOfInstance(input, app, value, config);
  const shadowPath = app === "codex" ? (optionalText(config, "shadowHomePath") ?? "") : "";
  const shadow = shadowPath === "" ? undefined : folderOf(input, shadowPath);
  return {
    id,
    driver,
    app,
    ...(displayName === undefined || displayName === "" ? {} : { displayName }),
    listed,
    home: home ?? p.join(input.userHome, app === "codex" ? ".codex" : ".claude"),
    isDefault: home === undefined,
    ...(shadow === undefined ? {} : { shadow }),
  };
}

/**
 * The enabled provider instances of T3's parsed settings (`doc`) whose driver TTasks knows, with the
 * home each runs in, the keys of those turned off, and the entries passed over with why. T3's default `codex` and
 * `claudeAgent` instances are there when the file does not list them, and a missing or refused
 * file (`file`) means only those. Reads nothing but `doc`.
 */
export function t3ProviderInstances(
  input: HostsInput,
  doc: unknown,
  file: T3Settings["file"] = "read",
): T3Settings {
  const settings = isObject(doc) ? doc : {};
  const instances: T3ProviderInstance[] = [];
  const off: string[] = [];
  const skipped: { id: string; reason: T3Skip }[] = [];
  const listed = new Map<string, unknown>();
  const declared = settings["providerInstances"];
  if (isObject(declared)) {
    for (const [id, value] of Object.entries(declared)) listed.set(id, value);
  } else if (declared !== undefined) {
    skipped.push({ id: "providerInstances", reason: "invalid_entry" });
  }
  // The legacy key, as T3 migrates it when it loads the file.
  const legacy = settings["providers"];
  if (isObject(legacy)) {
    for (const [driver, blob] of Object.entries(legacy)) {
      if (!T3_SLUG.test(driver) || !isObject(blob) || listed.has(driver)) continue;
      const { enabled, ...config } = blob;
      listed.set(driver, {
        driver,
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        config,
      });
    }
  }
  for (const [id, value] of listed) {
    try {
      if (!T3_SLUG.test(id) || !isObject(value)) throw new Skip("invalid_entry");
      const driver = value["driver"];
      if (typeof driver !== "string" || !T3_SLUG.test(driver)) throw new Skip("invalid_entry");
      if (T3_OTHER_DRIVERS.has(driver)) continue;
      if (!Object.hasOwn(T3_AGENT_DRIVERS, driver)) throw new Skip("unknown_driver");
      const instance = instanceOf(input, id, driver as T3AgentDriver, value, true);
      if (instance === undefined) off.push(id);
      else instances.push(instance);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped.push({ id, reason: error.reason });
    }
  }
  // T3's default instances: the ID is the driver kind, and an entry of that ID replaces it, also
  // one that was passed over (T3 would not run the default in its place).
  for (const driver of Object.keys(T3_AGENT_DRIVERS) as T3AgentDriver[]) {
    if (listed.has(driver)) continue;
    try {
      const instance = instanceOf(input, driver, driver, { driver }, false);
      if (instance !== undefined) instances.push(instance);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped.push({ id: driver, reason: error.reason });
    }
  }
  // T3's default model selection (`instanceId`, or the legacy `provider`, and `model`).
  const selection = settings["defaultModelSelection"];
  let defaultModel: T3Settings["defaultModel"];
  if (isObject(selection)) {
    const instance = selection["instanceId"] ?? selection["provider"];
    const model = selection["model"];
    if (typeof instance === "string" && typeof model === "string" && T3_MODEL.test(model)) {
      defaultModel = { instance, model };
    }
  }
  return { file, instances, off, skipped, ...(defaultModel === undefined ? {} : { defaultModel }) };
}

/** A model as T3's `--model` and `t3_model` take it: one word that cannot be read as a flag. */
const T3_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;

/** A home's account word: the suffix of `.codex-<suffix>`, `.claude_<suffix>` and the like. */
function homeAccount(home: string, platform: NodeJS.Platform): string {
  const m = HOME_SUFFIX.exec(pathOf(platform).basename(home).toLowerCase());
  return m?.[2] ?? "default";
}

/** The instance ID a T3 provider instance is proposed under: `t3-codex`, `t3-claude-second`. */
function t3ProposalId(instance: T3ProviderInstance): string {
  if (instance.id === "codex") return "t3-codex";
  if (instance.id === "claudeAgent") return "t3-claude";
  const slug = instance.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `t3-${slug}`.slice(0, 40).replace(/-+$/u, "");
}

/**
 * `ttasks setup instances` for T3 (A4 3.2): one complete proposal per enabled provider instance of a
 * driver TTasks opens through T3, from the detection's T3 proposal (`base`: its command). The label
 * is T3's display name (T3's own name for the driver when the settings give none), the account the
 * home folder's suffix, and the model T3's default selection when it names this provider instance,
 * else the catalogue's default for the driver.
 */
export function t3Proposals(
  settings: T3Settings,
  base: Proposal,
  platform: NodeJS.Platform,
): Proposal[] {
  const models = targetDef("t3").t3Models ?? {};
  const proposals: Proposal[] = [];
  for (const instance of settings.instances) {
    const own = settings.defaultModel?.instance === instance.id ? settings.defaultModel.model : "";
    const model = own !== "" ? own : (models[instance.driver] ?? "");
    const name = instance.displayName ?? (instance.driver === "codex" ? "Codex" : "Claude");
    proposals.push({
      id: t3ProposalId(instance),
      target: "t3",
      // A label holds at most 40 characters (A4 3.2), never half a surrogate pair.
      label: name
        .slice(0, 40)
        .replace(/[\uD800-\uDBFF]$/u, "")
        .trim(),
      account: homeAccount(instance.home, platform),
      source: "app",
      ...(base.exec === undefined ? {} : { exec: base.exec }),
      ...(base.argsPrefix === undefined ? {} : { argsPrefix: base.argsPrefix }),
      t3: { providerInstance: instance.id, model, modelFrom: own !== "" ? "t3" : "catalogue" },
      needs: [],
    });
  }
  return proposals;
}

/** The homes T3's enabled provider instances run their agents in (setup's hosts, doctor's row). */
export function t3Homes(settings: T3Settings): T3Home[] {
  return settings.instances.map((i) => ({
    app: i.app,
    provider: i.id,
    home: i.home,
    isDefault: i.isDefault,
  }));
}

/**
 * The shared home a Codex shadow home reads, or undefined for a home of its own. The sign is two
 * links, as T3 makes a shadow home: its `config.toml` and its `sessions` are symbolic links to the
 * `config.toml` file and the `sessions` folder of one other folder (each target as the link names
 * it: T3 writes the shared home's path, so the spelling matches the home's own). A `config.toml`
 * linked alone (a dotfiles setup) is no shadow: setup refuses that link as a managed file (A3 3.12),
 * since a write would land in the link's target. Only the links are read; nothing is followed to
 * write.
 */
export function codexSharedHome(platform: NodeJS.Platform, home: string): string | undefined {
  const p = pathOf(platform);
  const caseless = platform === "win32" || platform === "darwin";
  const fold = (s: string) => (caseless ? p.resolve(s).toLowerCase() : p.resolve(s));
  /** The folder a link in the home points into, when it is a link to `<folder>/<name>`. */
  const linkedFrom = (name: string, kind: "file" | "dir"): string | undefined => {
    const link = p.join(home, name);
    if (!lstatSync(link).isSymbolicLink()) return undefined;
    const target = p.resolve(home, readlinkSync(link));
    const base = p.basename(target);
    if ((caseless ? base.toLowerCase() : base) !== name || kindOf(target) !== kind) {
      return undefined;
    }
    return p.dirname(target);
  };
  try {
    const shared = linkedFrom("config.toml", "file");
    const sessions = linkedFrom("sessions", "dir");
    if (shared === undefined || sessions === undefined || fold(shared) !== fold(sessions)) {
      return undefined;
    }
    return fold(shared) === fold(home) ? undefined : shared;
  } catch {
    // No such entry, or a link that cannot be read: no shadow.
    return undefined;
  }
}

/** A home folder's suffix after `.codex-`, `.codex_`, `.claude-` or `.claude_`, as an ID part. */
const HOME_SUFFIX = /^\.?(codex|claude)[-_]([a-z0-9][a-z0-9-]{0,31})$/u;

/** An instance ID for a home T3 uses that nothing else names: from its folder, else the key. */
export function t3InstanceId(home: T3Home, platform: NodeJS.Platform): string {
  const base = home.app === "codex" ? "codex" : "claude";
  const folder = pathOf(platform).basename(home.home).toLowerCase();
  if (folder.replace(/^\./u, "") === base) return base;
  const m = HOME_SUFFIX.exec(folder);
  if (m !== null && m[1] === base) {
    const id = `${base}-${m[2] ?? ""}`;
    if (INSTANCE_ID.test(id)) return id;
  }
  // T3's own IDs take `_` (`claude_second`), which instance IDs do not.
  const key = home.provider.toLowerCase().replaceAll("_", "-");
  if (key.startsWith(base) && INSTANCE_ID.test(key)) return key;
  return `${base}-t3`;
}
