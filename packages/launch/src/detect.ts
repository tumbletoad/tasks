// Instance detection (A4 3.2: "Detection proposes, the user confirms"). Finds the agent commands
// (Claude Code, Codex, T3), their config homes and the user's wrapper scripts, and proposes one
// instance per wrapper or home. Nothing is created: a proposal becomes an `[[instance]]` only when
// the person confirms it, through the service's machine.toml editor.
//
// What detection may read (A4 3.2): a folder's presence, a file's presence and
// executable bit, a link's target, names in a folder, and a command's version from running it
// with `--version`. It never opens a file in an agent home (no sign-in file, token, settings or
// session history), never reads a wrapper script, never runs a wrapper (a wrapper may select a
// home that must not be used on this machine), never runs a `.cmd` shim, and never writes.
//
// Everything goes through DetectHost, so the rules run against a fake file system in tests (one
// golden file per OS) and against the real one through nodeDetectHost().
import { spawn } from "node:child_process";
import { readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  inTestedRange,
  isBuiltInTarget,
  targetDef,
  versionIn,
  type BuiltInTargetId,
  type TargetDef,
} from "./catalogue.ts";
import type { Instance } from "./sections.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export interface FileFacts {
  readonly kind: "file" | "dir" | "other";
  /** POSIX: any execute bit. Windows: always true for a file. */
  readonly executable: boolean;
}

/** What detection may look at. Every path it receives is absolute for `platform`. */
export interface DetectHost {
  readonly platform: NodeJS.Platform;
  /** The agent environment: PATH (and PATHEXT on Windows) and the homes' variables. */
  readonly env: Env;
  /** The user's home folder. */
  readonly home: string;
  /** Facts about the entry at `path`, links followed; undefined when nothing is there. */
  stat(path: string): FileFacts | undefined;
  /** The names in a folder; undefined when it cannot be listed. */
  list(dir: string): readonly string[] | undefined;
  /** The final target of `path`, links resolved; undefined when it does not resolve. */
  realpath(path: string): string | undefined;
  /** Runs `file ...args` without a shell and returns its stdout, or undefined on any failure. */
  output(file: string, args: readonly string[]): Promise<string | undefined>;
}

export type DetectableTarget = Extract<BuiltInTargetId, "claude-cli" | "codex-cli" | "t3">;
export const DETECTED_TARGETS: readonly DetectableTarget[] = ["claude-cli", "codex-cli", "t3"];

export interface FoundCommand {
  readonly target: DetectableTarget;
  /** How it was found: on PATH, as an npm install run by Node, or in the app's own folder. */
  readonly source: "path" | "npm" | "app-folder";
  /** The executable and the arguments before Tasks's (`[node, entry]` for npm). Empty: unusable. */
  readonly exec: readonly string[];
  /**
   * Why it cannot be run directly: a Windows `.cmd` shim with no npm entry beside it (A4 3.2:
   * never through `cmd.exe`; T3's shim is read by its own route step), an npm entry without
   * Node on the PATH, or a name that resolves to one of the user's wrappers (a wrapper is never
   * run by detection and selects its own home, so it is no raw command).
   */
  readonly unusable?: "cmd_shim" | "no_node" | "wrapper";
  readonly version?: string;
  /** Whether the version lies in the catalogue's tested range; absent when unknown. */
  readonly tested?: boolean;
}

export interface FoundHome {
  readonly target: Extract<DetectableTarget, "claude-cli" | "codex-cli">;
  readonly path: string;
  /** The folder name's suffix after `.codex-` or `.claude-`; empty for the default home. */
  readonly suffix: string;
  /** `home`: found in the home folder. `env`: named by CODEX_HOME or CLAUDE_CONFIG_DIR. */
  readonly source: "home" | "env";
}

export interface FoundWrapper {
  readonly target: Extract<DetectableTarget, "claude-cli" | "codex-cli">;
  readonly path: string;
  /** The name's suffix after `codex-` or `claude-`. */
  readonly suffix: string;
}

export type ProposalNeed = "exec" | "config_home" | "t3_provider_instance";

export interface Proposal {
  readonly id: string;
  readonly target: DetectableTarget;
  readonly label: string;
  readonly account: string;
  readonly source: "wrapper" | "home" | "app";
  readonly exec?: string;
  readonly argsPrefix?: readonly string[];
  readonly configHome?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** What the person must still give before the proposal can become an instance. */
  readonly needs: readonly ProposalNeed[];
}

export interface Detection {
  readonly platform: NodeJS.Platform;
  readonly commands: readonly FoundCommand[];
  readonly homes: readonly FoundHome[];
  readonly wrappers: readonly FoundWrapper[];
  /** T3's per-user folder (`~/.t3`) is present. */
  readonly t3Folder: boolean;
  readonly proposals: readonly Proposal[];
  /** Proposals left out because an existing instance already covers them, by proposal ID. */
  readonly configured: readonly string[];
}

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** A suffix Tasks turns into an instance ID: `.codex-<suffix>`, `codex-<suffix>`. */
const SUFFIX = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/** The value of an environment variable, case-insensitively on Windows. */
export function envValue(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower && v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * The config home an instance's agent runs with (A4 3.2): the one rule that launch
 * (the `claude-cli://` link's default home, Codex's `env_vars` check and reference match) and
 * setup (`tasks setup agents`) share.
 * 1. The home variable in the instance's own `env` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`; in any
 *    case on Windows, whose names are case-insensitive): the agent's environment applies exactly
 *    that (shim/environment.ts removes the base's and applies the instance's).
 * 2. Else its `config_home`: a wrapper that selects its own home inside its script.
 * 3. Else the target's folder in the account's home (`~/.claude`, `~/.codex`).
 * `isDefault`: no variable selects it and it is that folder, so an app started without the
 * instance's environment (a link) uses the same home. `path` is undefined only when nothing names
 * a home and the account's home is unknown. Undefined for a target without homes.
 */
export function instanceHome(
  instance: Pick<Instance, "target" | "env" | "configHome">,
  userHome: string | undefined,
  platform: NodeJS.Platform,
): { readonly path: string | undefined; readonly isDefault: boolean } | undefined {
  if (!isBuiltInTarget(instance.target)) return undefined;
  const rule = targetDef(instance.target).detect.homes;
  if (rule === undefined) return undefined;
  const named = envValue(instance.env, rule.env, platform);
  if (named !== undefined) return { path: named, isDefault: false };
  const p = pathOf(platform);
  const fallback = userHome === undefined ? undefined : p.join(userHome, rule.folder);
  const given = instance.configHome;
  if (given === undefined) return { path: fallback, isDefault: true };
  const fold = (s: string): string =>
    platform === "win32" || platform === "darwin" ? p.resolve(s).toLowerCase() : p.resolve(s);
  return { path: given, isDefault: fallback !== undefined && fold(given) === fold(fallback) };
}

/** Folders on the PATH, in order, absolute ones only. */
function pathDirs(host: DetectHost): string[] {
  const p = pathOf(host.platform);
  const value = envValue(host.env, "PATH", host.platform) ?? "";
  return value
    .split(host.platform === "win32" ? ";" : ":")
    .filter((d) => d !== "" && p.isAbsolute(d));
}

/** Windows: the extensions PATHEXT lists, lower case, in order. */
function pathExts(host: DetectHost): string[] {
  const value = envValue(host.env, "PATHEXT", host.platform) ?? ".COM;.EXE;.BAT;.CMD";
  return value
    .split(";")
    .filter((e) => e.startsWith("."))
    .map((e) => e.toLowerCase());
}

/** The first `name` on the PATH, the way the OS would find it: PATHEXT on Windows, +x elsewhere. */
export function onPath(host: DetectHost, name: string): string | undefined {
  const p = pathOf(host.platform);
  for (const dir of pathDirs(host)) {
    const candidates =
      host.platform === "win32"
        ? pathExts(host).map((ext) => p.join(dir, name + ext))
        : [p.join(dir, name)];
    for (const file of candidates) {
      const facts = host.stat(file);
      if (facts?.kind === "file" && facts.executable) return file;
    }
  }
  return undefined;
}

const isShim = (file: string) => /\.(cmd|bat|ps1)$/iu.test(file);

/** Node on the PATH, or beside the command (an nvm folder puts both in one `bin`). */
function nodeFor(host: DetectHost, beside: string | undefined): string | undefined {
  const p = pathOf(host.platform);
  if (beside !== undefined) {
    const candidate = p.join(p.dirname(beside), host.platform === "win32" ? "node.exe" : "node");
    const facts = host.stat(candidate);
    if (facts?.kind === "file" && facts.executable) return candidate;
  }
  const found = onPath(host, "node");
  return found !== undefined && !isShim(found) ? found : undefined;
}

/** The command of one target: native, npm through Node, or a shim Tasks cannot run. */
function findCommand(
  host: DetectHost,
  def: TargetDef,
  wrapperTargets: readonly string[],
): Omit<FoundCommand, "version" | "tested"> | undefined {
  const p = pathOf(host.platform);
  const target = def.id as DetectableTarget;
  for (const name of def.detect.binaries) {
    let file = onPath(host, name);
    let source: FoundCommand["source"] = "path";
    if (file === undefined && def.detect.appBin !== undefined) {
      const dir = p.join(host.home, ...def.detect.appBin.split("/"));
      const names = host.platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
      for (const candidate of names.map((n) => p.join(dir, n))) {
        const facts = host.stat(candidate);
        if (facts?.kind === "file" && facts.executable) {
          file = candidate;
          source = "app-folder";
          break;
        }
      }
    }
    if (file === undefined) continue;
    const npm = def.detect.npm;
    if (host.platform === "win32" && isShim(file)) {
      // npm's global layout: <prefix>\<name>.cmd beside <prefix>\node_modules\<package>\<entry>.
      if (npm !== undefined) {
        const entry = p.join(
          p.dirname(file),
          "node_modules",
          ...npm.package.split("/"),
          ...npm.entry.split("/"),
        );
        if (host.stat(entry)?.kind === "file") {
          const node = nodeFor(host, undefined);
          return node === undefined
            ? { target, source: "npm", exec: [], unusable: "no_node" }
            : { target, source: "npm", exec: [node, entry] };
        }
      }
      return { target, source, exec: [], unusable: "cmd_shim" };
    }
    // A link into node_modules (npm and nvm on Linux and macOS): run the entry with Node, never
    // through its `#!/usr/bin/env node` line (A4 3.2).
    const real = host.realpath(file);
    // A name that is (a link to) one of the user's wrappers: running it, even for `--version`,
    // runs the wrapper, and it selects a home of its own.
    if (
      real !== undefined &&
      wrapperTargets.some((wrapper) => samePath(host.platform, wrapper, real))
    ) {
      return { target, source, exec: [], unusable: "wrapper" };
    }
    if (real !== undefined && /\.(c|m)?js$/u.test(real)) {
      const node = nodeFor(host, file);
      return node === undefined
        ? { target, source: "npm", exec: [], unusable: "no_node" }
        : { target, source: "npm", exec: [node, real] };
    }
    return { target, source, exec: [file] };
  }
  return undefined;
}

function findHomes(host: DetectHost, def: TargetDef): FoundHome[] {
  const rule = def.detect.homes;
  if (rule === undefined) return [];
  const p = pathOf(host.platform);
  const target = def.id as FoundHome["target"];
  const homes: FoundHome[] = [];
  const fold = (s: string) => (host.platform === "win32" ? s.toLowerCase() : s);
  for (const name of [...(host.list(host.home) ?? [])].sort()) {
    const folded = fold(name);
    let suffix: string;
    if (folded === rule.folder) suffix = "";
    else if (folded.startsWith(`${rule.folder}-`)) suffix = folded.slice(rule.folder.length + 1);
    else continue;
    if (suffix !== "" && !SUFFIX.test(suffix)) continue;
    const path = p.join(host.home, name);
    if (host.stat(path)?.kind !== "dir") continue;
    homes.push({ target, path, suffix, source: "home" });
  }
  // A home the agent environment names elsewhere: its folder's name gives the suffix.
  const fromEnv = envValue(host.env, rule.env, host.platform);
  if (fromEnv !== undefined && p.isAbsolute(fromEnv) && host.stat(fromEnv)?.kind === "dir") {
    const same = homes.some((h) => fold(p.resolve(h.path)) === fold(p.resolve(fromEnv)));
    const name = fold(p.basename(p.resolve(fromEnv))).replace(/^\./u, "");
    const suffix = SUFFIX.test(name) && !homes.some((h) => h.suffix === name) ? name : "env";
    if (!same) homes.push({ target, path: p.resolve(fromEnv), suffix, source: "env" });
  }
  return homes;
}

/** Wrapper scripts in `~/.local/bin` (A4 3.2). Linux and macOS only: Windows wrappers are shims. */
function findWrappers(host: DetectHost, def: TargetDef): FoundWrapper[] {
  const prefix = def.detect.wrapperPrefix;
  if (prefix === undefined || host.platform === "win32") return [];
  const dir = posix.join(host.home, ".local", "bin");
  const wrappers: FoundWrapper[] = [];
  for (const name of [...(host.list(dir) ?? [])].sort()) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!SUFFIX.test(suffix)) continue;
    const path = posix.join(dir, name);
    const facts = host.stat(path);
    if (facts?.kind !== "file" || !facts.executable) continue;
    wrappers.push({ target: def.id as FoundWrapper["target"], path, suffix });
  }
  return wrappers;
}

/** The person-facing name of an account suffix: `work` stays `work`. */
export const proposedAccount = (suffix: string): string => (suffix === "" ? "default" : suffix);

function labelOf(def: TargetDef, suffix: string): string {
  return suffix === "" ? def.label : `${def.label} · ${suffix}`;
}

/** The instance ID detection proposes for a home or a wrapper: `claude`, `codex`, `codex-work`. */
export function proposedInstanceId(def: TargetDef, suffix: string): string {
  const base = def.id === "codex-cli" ? "codex" : def.id === "claude-cli" ? "claude" : def.id;
  return suffix === "" ? base : `${base}-${suffix}`;
}

/** Same path, compared the way the OS compares paths. */
function samePath(platform: NodeJS.Platform, a: string, b: string): boolean {
  const p = pathOf(platform);
  const na = p.resolve(a);
  const nb = p.resolve(b);
  return platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function proposalsFor(
  def: TargetDef,
  command: FoundCommand | undefined,
  homes: readonly FoundHome[],
  wrappers: readonly FoundWrapper[],
): Proposal[] {
  const proposals: Proposal[] = [];
  const target = def.id as Extract<DetectableTarget, "claude-cli" | "codex-cli">;
  const envName = def.detect.homes?.env ?? "";
  // Wrappers win (A4 3.2): a wrapper and a home with the same suffix are one account, offered as
  // the wrapper. Which home a wrapper selects is inside the script, which detection never reads,
  // so a wrapper without a home of its suffix asks the person for the home.
  for (const wrapper of wrappers) {
    const home = homes.find((h) => h.suffix === wrapper.suffix && h.source === "home");
    proposals.push({
      id: proposedInstanceId(def, wrapper.suffix),
      target,
      label: labelOf(def, wrapper.suffix),
      account: proposedAccount(wrapper.suffix),
      source: "wrapper",
      exec: wrapper.path,
      ...(home === undefined ? {} : { configHome: home.path }),
      needs: home === undefined ? ["config_home"] : [],
    });
  }
  const exec = command !== undefined && command.exec.length > 0 ? command.exec : undefined;
  for (const home of homes) {
    if (wrappers.some((w) => w.suffix === home.suffix && home.source === "home")) continue;
    const id = proposedInstanceId(def, home.suffix);
    if (proposals.some((other) => other.id === id)) continue;
    // The default home needs no variable: the launch scrubs the inherited home variables
    // (HOME_VARIABLES), so whatever the person's shell exports, an instance without one runs the
    // default home. Any other home is selected by the home's variable.
    const isDefault = home.suffix === "" && home.source === "home";
    proposals.push({
      id,
      target,
      label: labelOf(def, home.suffix),
      account: proposedAccount(home.suffix),
      source: "home",
      ...(exec === undefined ? {} : { exec: exec[0] ?? "", argsPrefix: exec.slice(1) }),
      configHome: home.path,
      ...(isDefault ? {} : { env: { [envName]: home.path } }),
      needs: exec === undefined ? ["exec"] : [],
    });
  }
  return proposals;
}

/**
 * Detects the agent commands, homes and wrappers through `host`, and proposes instances for what
 * `existing` does not already cover (the same ID, wrapper or config home).
 */
export async function detect(
  host: DetectHost,
  existing: readonly Instance[] = [],
): Promise<Detection> {
  const commands: FoundCommand[] = [];
  const homes: FoundHome[] = [];
  const wrappers: FoundWrapper[] = [];
  let proposals: Proposal[] = [];
  // The wrappers first: a command name that resolves to one is never run (findCommand).
  const wrappersOf = new Map(
    DETECTED_TARGETS.map((id) => [id, findWrappers(host, targetDef(id))] as const),
  );
  const wrapperTargets = [...wrappersOf.values()]
    .flat()
    .map((w) => host.realpath(w.path) ?? w.path);
  for (const id of DETECTED_TARGETS) {
    const def = targetDef(id);
    const found = findCommand(host, def, wrapperTargets);
    let command: FoundCommand | undefined;
    if (found !== undefined) {
      let version: string | undefined;
      if (found.exec.length > 0) {
        const [file = "", ...prefix] = found.exec;
        const out = await host.output(file, [...prefix, "--version"]);
        version = out === undefined ? undefined : versionIn(out);
      }
      const tested = version === undefined ? undefined : inTestedRange(version, def.testedVersions);
      command = {
        ...found,
        ...(version === undefined ? {} : { version }),
        ...(tested === undefined ? {} : { tested }),
      };
      commands.push(command);
    }
    if (id === "t3") continue;
    const h = findHomes(host, def);
    const w = wrappersOf.get(id) ?? [];
    homes.push(...h);
    wrappers.push(...w);
    proposals.push(...proposalsFor(def, command, h, w));
  }

  const p = pathOf(host.platform);
  const t3Def = targetDef("t3");
  const t3Folder =
    t3Def.detect.appFolder !== undefined &&
    host.stat(p.join(host.home, t3Def.detect.appFolder))?.kind === "dir";
  const t3 = commands.find((c) => c.target === "t3");
  if (t3 !== undefined || t3Folder) {
    // T3's provider instances live in its settings, which Tasks reads only through T3's own
    // API once paired (A4 3.4.1, M2.09): the person picks one.
    const exec = t3 !== undefined && t3.exec.length > 0 ? t3.exec : undefined;
    proposals.push({
      id: "t3",
      target: "t3",
      label: t3Def.label,
      account: "default",
      source: "app",
      ...(exec === undefined ? {} : { exec: exec[0] ?? "", argsPrefix: exec.slice(1) }),
      needs: ["t3_provider_instance"],
    });
  }

  const configured: string[] = [];
  proposals = proposals.filter((proposal) => {
    const covered = existing.some(
      (instance) =>
        instance.id === proposal.id ||
        (proposal.source === "wrapper" &&
          instance.exec !== undefined &&
          proposal.exec !== undefined &&
          samePath(host.platform, instance.exec, proposal.exec)) ||
        (proposal.target !== "t3" &&
          instance.target === proposal.target &&
          instance.configHome !== undefined &&
          proposal.configHome !== undefined &&
          samePath(host.platform, instance.configHome, proposal.configHome)),
    );
    if (covered) configured.push(proposal.id);
    return !covered;
  });

  return { platform: host.platform, commands, homes, wrappers, t3Folder, proposals, configured };
}

/** A value of an `[[instance]]` entry as the machine.toml editor writes it. */
export type InstanceValue = string | boolean | readonly string[] | Readonly<Record<string, string>>;

/** What the person gives when confirming a proposal that still needs something. */
export interface ProposalChoices {
  readonly exec?: string;
  readonly configHome?: string;
  readonly t3ProviderInstance?: string;
}

/**
 * The `[[instance]]` entry a confirmed proposal becomes, keys in A4 3.2's order, or the needs still
 * open. Only the person's confirmation calls this; detection never writes.
 */
export function instanceEntry(
  proposal: Proposal,
  choices: ProposalChoices = {},
):
  | { readonly ok: true; readonly entry: ReadonlyMap<string, InstanceValue> }
  | { readonly ok: false; readonly needs: readonly ProposalNeed[] } {
  const exec = choices.exec ?? proposal.exec;
  const configHome = choices.configHome ?? proposal.configHome;
  const provider = choices.t3ProviderInstance;
  const needs = proposal.needs.filter(
    (need) =>
      (need === "exec" && exec === undefined) ||
      (need === "config_home" && configHome === undefined) ||
      (need === "t3_provider_instance" && provider === undefined),
  );
  if (needs.length > 0) return { ok: false, needs };
  const entry = new Map<string, InstanceValue>();
  entry.set("id", proposal.id);
  entry.set("target", proposal.target);
  entry.set("label", proposal.label);
  entry.set("account", proposal.account);
  if (exec !== undefined) entry.set("exec", exec);
  if (
    choices.exec === undefined &&
    proposal.argsPrefix !== undefined &&
    proposal.argsPrefix.length > 0
  ) {
    entry.set("args_prefix", proposal.argsPrefix);
  }
  if (configHome !== undefined) entry.set("config_home", configHome);
  // A raw home is selected by its variable: a home the person picks instead is what it selects,
  // never the proposal's (a wrapper selects its own home, so its config_home is only shown).
  const homeVariable = targetDef(proposal.target).detect.homes?.env;
  const env =
    proposal.source === "home" &&
    homeVariable !== undefined &&
    choices.configHome !== undefined &&
    choices.configHome !== proposal.configHome
      ? { ...proposal.env, [homeVariable]: choices.configHome }
      : proposal.env;
  if (env !== undefined) entry.set("env", env);
  if (proposal.target === "t3" && provider !== undefined) {
    entry.set("t3_environment", "local");
    entry.set("t3_provider_instance", provider);
  }
  entry.set("remote_allowed", false);
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------------------------
// The real host

export interface NodeHostOptions {
  readonly platform?: NodeJS.Platform;
  readonly env: Env;
  readonly home: string;
  /** Bound for one `--version` run. Default 5 s. */
  readonly timeoutMs?: number;
}

/** At most this much of a command's `--version` output is read. */
const VERSION_OUTPUT_BYTES = 4096;
/** How long a killed `--version` run may take to exit before the call gives up waiting. */
const KILL_GRACE_MS = 5_000;

/**
 * The real file system and processes. `env` is the agent environment the caller built (A4 3.8):
 * detection never falls back to this process's own. A `--version` run gets only that environment,
 * no stdin, no shell and no window, and is killed at its time bound.
 */
export function nodeDetectHost(options: NodeHostOptions): DetectHost {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    platform,
    env: options.env,
    home: options.home,
    stat(path) {
      try {
        const s = statSync(path);
        const kind = s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
        const executable = platform === "win32" ? kind === "file" : (s.mode & 0o111) !== 0;
        return { kind, executable };
      } catch {
        // A Windows app execution alias (WindowsApps): stat cannot follow it, readlink can.
        if (platform === "win32") {
          try {
            readlinkSync(path);
            return { kind: "file", executable: true };
          } catch {
            return undefined;
          }
        }
        return undefined;
      }
    },
    list(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return undefined;
      }
    },
    realpath(path) {
      try {
        return realpathSync.native(path);
      } catch {
        return undefined;
      }
    },
    output(file, args) {
      if (isShim(file)) return Promise.resolve(undefined);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(options.env)) if (v !== undefined) env[k] = v;
      return new Promise((resolve) => {
        let out = "";
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (value: string | undefined) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        // Linux and macOS: the command leads a process group of its own, so whatever it starts is
        // killed with it. Windows has no such group here: a descendant may outlive the call, and
        // the grace below still ends the call and closes Tasks's end of the pipe.
        const group = platform !== "win32";
        let child;
        try {
          child = spawn(file, [...args], {
            env,
            cwd: options.home,
            stdio: ["ignore", "pipe", "ignore"],
            shell: false,
            windowsHide: true,
            detached: group,
          });
        } catch {
          finish(undefined);
          return;
        }
        const killAll = () => {
          if (group && child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
              return;
            } catch {
              // The group is gone: only the command itself may be left.
            }
          }
          child.kill("SIGKILL");
        };
        // Windows, at the bound: the command is still running, so its tree can be found from it.
        // The system's own taskkill, by its full path, ends it with every descendant.
        const killTree = () => {
          if (platform !== "win32" || child.pid === undefined) {
            killAll();
            return;
          }
          const killer = spawn(
            win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/T", "/F", "/PID", String(child.pid)],
            { stdio: "ignore", shell: false, windowsHide: true },
          );
          killer.once("error", () => {
            child.kill("SIGKILL");
          });
          killer.once("exit", () => {
            child.kill("SIGKILL");
          });
        };
        // At the bound the command and its group are killed, and the answer waits for the pipe to
        // close. A grace bounds even that wait, then the pipe is closed from this end.
        let timedOut = false;
        timer = setTimeout(() => {
          timedOut = true;
          killTree();
          timer = setTimeout(() => {
            child.stdout.destroy();
            finish(undefined);
          }, KILL_GRACE_MS);
        }, timeoutMs);
        // When the command exits, what it left behind in its group is killed, so a descendant
        // holding the pipe cannot keep the answer waiting.
        child.once("exit", () => {
          if (group) killAll();
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (out.length < VERSION_OUTPUT_BYTES)
            out += chunk.slice(0, VERSION_OUTPUT_BYTES - out.length);
        });
        child.once("error", () => {
          finish(undefined);
        });
        child.once("close", (code) => {
          finish(code === 0 && !timedOut ? out : undefined);
        });
      });
    },
  };
}
