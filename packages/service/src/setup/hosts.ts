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
// - T3 Code: its provider instances, read-only from `<T3CODE_HOME or ~/.t3>/userdata/settings.json`.
//   A Claude instance's non-empty `homePath` becomes CLAUDE_CONFIG_DIR, a Codex instance's
//   CODEX_HOME; without one T3 uses the inherited variable, else the default home. A Codex shadow
//   home links the shared `config.toml` of its instance's home, so the entry lives there.
import { lstatSync, readdirSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { envValue, INSTANCE_ID, type Env } from "@tasks/launch";
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
    // eslint-disable-next-line no-restricted-syntax -- where Claude Desktop keeps its file, never a path Tasks writes for itself
    const local = absolute(input, "LOCALAPPDATA");
    // eslint-disable-next-line no-restricted-syntax -- where Claude Desktop keeps its file, never a path Tasks writes for itself
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

/** The app of a provider instance: its declared kind, else its key's own name. */
function appOfProvider(key: string, value: Record<string, unknown>): T3Home["app"] | undefined {
  const declared = ["provider", "driver", "kind", "type"]
    .map((name) => value[name])
    .find((v): v is string => typeof v === "string");
  const word = (declared ?? key).toLowerCase();
  if (word.includes("codex")) return "codex";
  if (word.includes("claude")) return "claude-code";
  return undefined;
}

/**
 * The homes T3's provider instances use, from its parsed settings (`doc`), or T3's default
 * providers' homes when the settings name none. Only `homePath` is read from an instance (its
 * shadow home links the same `config.toml`); every other value stays where it is.
 */
export function t3Homes(input: HostsInput, doc: unknown): T3Home[] {
  const p = pathOf(input.platform);
  const instances = isObject(doc) ? doc["providerInstances"] : undefined;
  const entries: [string, Record<string, unknown>][] = isObject(instances)
    ? Object.entries(instances).filter((e): e is [string, Record<string, unknown>] =>
        isObject(e[1]),
      )
    : [
        ["codex", {}],
        ["claude", {}],
      ];
  const homes: T3Home[] = [];
  for (const [provider, value] of entries) {
    const app = appOfProvider(provider, value);
    if (app === undefined) continue;
    const variable = app === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const path = value["homePath"];
    const named =
      typeof path === "string" && path !== "" && p.isAbsolute(path)
        ? path
        : absolute(input, variable);
    const home = named ?? p.join(input.userHome, app === "codex" ? ".codex" : ".claude");
    homes.push({ app, provider, home: p.resolve(home), isDefault: named === undefined });
  }
  return homes;
}

/** An instance ID for a home T3 uses that nothing else names: from its folder, else the key. */
export function t3InstanceId(home: T3Home, platform: NodeJS.Platform): string {
  const base = home.app === "codex" ? "codex" : "claude";
  const folder = pathOf(platform).basename(home.home).toLowerCase().replace(/^\./u, "");
  if (folder === base || (folder.startsWith(`${base}-`) && INSTANCE_ID.test(folder))) return folder;
  const key = home.provider.toLowerCase();
  if (key.startsWith(base) && INSTANCE_ID.test(key)) return key;
  return `${base}-t3`;
}
