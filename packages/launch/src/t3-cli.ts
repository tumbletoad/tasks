// T3 Code's fallback route, `t3-cli` (A4 3.4.1 "Fallback route", A7 3.13 M6.10): when TTasks is not
// paired with T3, a task opens through T3's own command line. It is off (T3_CLI_ROUTE below): T3's
// command line has no `project list`, which the route needs. It serves exact project roots only:
//
//   t3 project list --json                                   which projects T3 has (assumed, L06)
//   t3 project add <P>                                        Register, after the person said yes
//   t3 thread start <projectId> - --json --title <task reference> [--provider <p> --model <m>]
//                                                             the brief on stdin; prints
//                                                             {threadId, projectId, runId}
//
// `t3 thread start` given a path starts at the deepest project that contains it, so it is only ever
// given a project ID, and only the ID of a project whose root has the task folder's identity
// (t3-binding.ts). A worktree binding needs the paired route (the CLI cannot attach one), and a
// folder that is no project root asks Register, as on the paired route, and is never opened in the
// project that contains it. The CLI sends its message, so it cannot be repeated: a launch whose call
// gives no answer is Unknown, never repeated, and nothing the CLI prints confirms the folder (A4
// 3.9.2 and 3.9.3: the state machine's `t3-cli` rows).
//
// The command line is an argument array spawned without a shell. Only what A4 3.4.1 lists reaches
// it: the subcommand, the project ID or the folder to register, `-`, `--json`, the task reference
// as the thread's title (never the task's own title, A4 3.4.1), the instance's
// provider instance and model. The brief goes on stdin; no brief, task text or token is in argv,
// the environment or a log line. On Windows T3's `t3` is a `.cmd` shim, which runs through cmd.exe
// and so re-parses its arguments: TTasks never runs it. It reads the shim once per use, strictly
// (parseT3Shim), and starts the executable it names directly with the entry and the two variables it
// sets; a shim it cannot read exactly makes the route unusable, never guessed.
import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { posix, win32 } from "node:path";
import { targetDef } from "./catalogue.ts";
import { EVIDENCE_ID } from "./intents.ts";
import type { DispatchOutcome, Observation } from "./machine.ts";
import type { Instance } from "./sections.ts";
import { agentEnvironment, type AgentBase } from "./shim/environment.ts";
import type { LaunchIntent } from "./store.ts";
import { bindFolder, identityAt, type BindFolder, type T3Project } from "./t3-binding.ts";
import { readT3Origin } from "./t3-client.ts";
import {
  T3_TEXT,
  t3ThreadLink,
  type T3Prepared,
  type T3Route,
  type T3Unavailable,
} from "./t3-route.ts";
import { NOT_NOW_MS, notNowUntil, readPairing, rememberNotNow, type T3Files } from "./t3-state.ts";

/** One run of T3's command line may take this long; within the machine's step deadline (30 s). */
export const T3_CLI_MS = 20_000;
/** The dispatch's own `project list` may take this long: with `thread start`, within 30 s. */
export const T3_CLI_LIST_MS = 8_000;
/** At most this much of what the CLI prints is read. */
export const T3_CLI_MAX_BYTES = 1024 * 1024;
/** At most this much of a `.cmd` shim is read. */
const SHIM_MAX_BYTES = 16 * 1024;
/** At most this many launches wait between their stage and their dispatch, or for `observe`. */
const KEPT = 64;

/** The variables a T3 `.cmd` shim may set (A4 3.4.1); the child gets them, nothing else of it. */
export const T3_SHIM_VARIABLES = ["T3CODE_HOME", "ELECTRON_RUN_AS_NODE"] as const;

/** The task reference that titles the thread: an ID, never text (`M-14`). */
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** A provider instance or model as the CLI takes it: one word that cannot be read as a flag. */
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;

/** How TTasks runs T3's command line: an executable, the arguments before TTasks's, its variables. */
export interface T3CliCommand {
  /** Absolute; never a `.cmd`, `.bat` or `.ps1` file. */
  readonly file: string;
  readonly prefix: readonly string[];
  /** What the shim sets (T3_SHIM_VARIABLES), for this child only. */
  readonly env: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------------------------
// T3's `.cmd` shim on Windows (A4 3.4.1)

/** Whether `file` is a Windows command script, which runs through cmd.exe. */
const isScript = (file: string): boolean => /\.(cmd|bat|ps1)$/iu.test(file);

/**
 * Windows programs that read their arguments, or their stdin, as commands: started directly they
 * still re-parse what TTasks passes (cmd.exe splits at `&`), so none of them is ever T3's CLI.
 */
const COMMAND_PROCESSORS = new Set([
  "bash.exe",
  "cmd.exe",
  "conhost.exe",
  "cscript.exe",
  "explorer.exe",
  "forfiles.exe",
  "mshta.exe",
  "powershell.exe",
  "powershell_ise.exe",
  "pwsh.exe",
  "rundll32.exe",
  "sh.exe",
  "wscript.exe",
  "wsl.exe",
  "wt.exe",
]);

/** Whether a Windows executable is a command processor or lies in the Windows folder. */
function commandProcessor(file: string): boolean {
  const normal = win32.normalize(file).replace(/^\\\\[?.]\\/u, "");
  return (
    COMMAND_PROCESSORS.has(win32.basename(normal).toLowerCase()) ||
    /^[A-Za-z]:\\windows\\/iu.test(normal)
  );
}

/** A JavaScript entry Node or Electron runs (Node also runs TypeScript). */
const ENTRY = /\.[cm]?[jt]s$/iu;

/**
 * Whether a shim's command is one of T3's forms (A4 3.4.1: the `.cmd` shim resolved to the T3
 * executable), each a program that reads its arguments with the C runtime's rules and nothing else:
 * - `node.exe <entry>`: npm's shim, Node and the package's entry;
 * - `<app>.exe <entry>` with `ELECTRON_RUN_AS_NODE=1`: the T3 app's Electron, run as Node;
 * - `t3.exe`: a native executable, alone.
 * The entry is one absolute JavaScript file. No command processor, nothing in the Windows folder.
 */
function t3Form(file: string, prefix: readonly string[], electron: boolean): boolean {
  if (!/\.exe$/iu.test(file) || commandProcessor(file)) return false;
  const name = win32.basename(file).toLowerCase();
  if (prefix.length === 0) return name === "t3.exe";
  const [entry] = prefix;
  return (
    prefix.length === 1 &&
    entry !== undefined &&
    (name === "node.exe" || electron) &&
    win32.isAbsolute(entry) &&
    ENTRY.test(entry)
  );
}

/**
 * Reads T3's `.cmd` shim strictly: `@echo off`, `setlocal`, `endlocal`, `rem` and `::` lines, at
 * most the two variables of T3_SHIM_VARIABLES set (`set "NAME=value"` or `set NAME=value`), then
 * exactly one command, `"<executable>" ["<argument>" …] %*`, optionally followed by `exit /b` or
 * `exit /b %errorlevel%`. `%~dp0` (the shim's own folder) may start a value or a word; no other
 * `%`, and none of cmd's operators (`^ & | < > !`), anywhere. ASCII only: cmd reads the file in the
 * console's code page, so another character could mean something else to cmd than to TTasks. The
 * command must be one of T3's forms (t3Form). Undefined when the shim is anything else.
 */
export function parseT3Shim(text: string, shimPath: string): T3CliCommand | undefined {
  if (!/^[\t\n\r\x20-\x7e]*$/u.test(text) || /[\^&|<>!]/u.test(text)) return undefined;
  const own = `${win32.dirname(shimPath)}\\`;
  const expand = (word: string): string | undefined => {
    const value = word.startsWith("%~dp0") ? own + word.slice(5) : word;
    return value.includes("%") || value.includes('"') ? undefined : value;
  };
  const env: Record<string, string> = {};
  let command: string[] | undefined;
  let ended = false;
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim() === "") continue;
    // Trailing blanks are part of an unquoted `set` value to cmd: refused rather than weighed.
    if (/\s$/u.test(raw)) return undefined;
    let line = raw.trimStart();
    if (line.startsWith("@")) line = line.slice(1);
    const lower = line.toLowerCase();
    if (/^rem(\s|$)/u.test(lower) || line.startsWith("::")) continue;
    if (lower === "echo off" || lower === "setlocal" || lower === "endlocal") continue;
    if (ended) return undefined;
    if (command !== undefined) {
      if (lower === "exit /b" || lower === "exit /b %errorlevel%") {
        ended = true;
        continue;
      }
      return undefined;
    }
    const set =
      /^set\s+"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"$/iu.exec(line) ??
      /^set\s+([A-Za-z_][A-Za-z0-9_]*)=([^"\s][^"]*)$/iu.exec(line);
    if (set !== null) {
      const name = (set[1] ?? "").toUpperCase();
      const value = expand(set[2] ?? "");
      if (!(T3_SHIM_VARIABLES as readonly string[]).includes(name) || value === undefined) {
        return undefined;
      }
      env[name] = value;
      continue;
    }
    if (/^set(\s|$)/iu.test(line)) return undefined;
    const words: string[] = [];
    for (const match of line.matchAll(/"([^"]*)"|(\S+)/gu)) {
      if (match[2]?.includes('"') === true) return undefined;
      words.push(match[1] ?? match[2] ?? "");
    }
    if (words.length < 2 || words.at(-1) !== "%*") return undefined;
    const expanded = words.slice(0, -1).map(expand);
    if (expanded.some((w) => w === undefined || w === "")) return undefined;
    command = expanded as string[];
  }
  const [file, ...prefix] = command ?? [];
  if (file === undefined || !win32.isAbsolute(file) || isScript(file)) return undefined;
  const electron = env["ELECTRON_RUN_AS_NODE"];
  if (electron !== undefined && electron !== "1") return undefined;
  if (!t3Form(win32.normalize(file), prefix.map(win32.normalize), electron === "1")) {
    return undefined;
  }
  return { file, prefix, env };
}

/** A small file's text, or undefined: a regular file within SHIM_MAX_BYTES, as UTF-8. */
export function readShimFile(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > SHIM_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, read));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * How TTasks runs this instance's `t3`: its `exec` and `args_prefix`, or, for a Windows `.cmd` or
 * `.bat` shim, what the shim names (parseT3Shim) followed by `args_prefix`. `no_cli` without an
 * `exec`; `cli_unusable` for a PowerShell script or a shim that cannot be read exactly.
 */
export function t3CliCommand(
  instance: Pick<Instance, "exec" | "argsPrefix">,
  platform: NodeJS.Platform,
  readShim: (path: string) => string | undefined = readShimFile,
):
  | { readonly ok: true; readonly command: T3CliCommand }
  | { readonly ok: false; readonly reason: "no_cli" | "cli_unusable" } {
  const exec = instance.exec;
  if (exec === undefined || exec === "") return { ok: false, reason: "no_cli" };
  const P = platform === "win32" ? win32 : posix;
  if (!P.isAbsolute(exec)) return { ok: false, reason: "cli_unusable" };
  if (platform === "win32" && /\.(cmd|bat)$/iu.test(exec)) {
    const text = readShim(exec);
    const shim = text === undefined ? undefined : parseT3Shim(text, exec);
    if (shim === undefined) return { ok: false, reason: "cli_unusable" };
    return { ok: true, command: { ...shim, prefix: [...shim.prefix, ...instance.argsPrefix] } };
  }
  // Windows completes a name without its extension (`cmd` runs `cmd.exe`) and trims trailing dots
  // and blanks, so only an exact `.exe` names the program that runs; never a command processor.
  if (platform === "win32" && (!/\.exe$/iu.test(exec) || commandProcessor(exec))) {
    return { ok: false, reason: "cli_unusable" };
  }
  return { ok: true, command: { file: exec, prefix: [...instance.argsPrefix], env: {} } };
}

// ---------------------------------------------------------------------------------------------
// Running the CLI

export interface T3CliRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Written to the CLI's stdin, which is then closed. Without it stdin is closed at once. */
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/** How one run of the CLI ended. Nothing of it is logged. */
export type T3CliResult =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  /** The process never existed (no such file, not executable): nothing ran. */
  | { readonly kind: "not_started" }
  /** It ran past the time bound and was killed. */
  | { readonly kind: "timeout" }
  /** It printed more than the bound and was killed. */
  | { readonly kind: "too_large" };

/** Runs T3's command line. Tests pass their own around the OS's (a fake CLI, a recorder). */
export type T3CliRun = (request: T3CliRequest) => Promise<T3CliResult>;

/**
 * The OS's run: no shell, no window, the arguments as an array (on Windows the runtime quotes each
 * one for the program's own command-line parser, never cmd.exe's), stdin written and closed, stdout
 * and stderr read within the bound. Linux and macOS: the CLI leads its own process group, which is
 * killed at the bound with what it started. Windows: the CLI itself is killed.
 */
export const runT3Cli: T3CliRun = (request) =>
  new Promise<T3CliResult>((resolve) => {
    const group = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.file, [...request.args], {
        cwd: request.cwd,
        env: { ...request.env },
        stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: group,
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve({ kind: "not_started" });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;
    let started = false;
    const kill = (): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Gone already.
      }
    };
    const finish = (result: T3CliResult, killFirst: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killFirst) kill();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ kind: "timeout" }, true);
    }, request.timeoutMs);
    const take = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > request.maxBytes) finish({ kind: "too_large" }, true);
      else into.push(chunk);
    };
    child.stdout?.on("data", take(out));
    child.stderr?.on("data", take(err));
    child.stdout?.on("error", () => undefined);
    child.stderr?.on("error", () => undefined);
    child.once("spawn", () => {
      started = true;
      const stdin = child.stdin;
      if (stdin !== null && request.stdin !== undefined) {
        // A CLI that ends before it read everything closes its end: that is its answer, not ours.
        stdin.on("error", () => undefined);
        stdin.end(request.stdin, "utf8");
      }
    });
    child.once("error", () => {
      if (!started) finish({ kind: "not_started" }, false);
    });
    child.once("close", (code, signal) => {
      finish(
        {
          kind: "exited",
          code,
          signal,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        },
        false,
      );
    });
  });

// ---------------------------------------------------------------------------------------------
// The route

export interface T3CliRouteOptions {
  /** T3's home folder (`~/.t3`, or T3CODE_HOME), as the paired route reads it; undefined: unknown. */
  readonly home: string | undefined;
  /** T3's machine state (t3-state.ts): the "Not now" answers, the environment ID of a pairing. */
  readonly files: T3Files;
  /** Where the CLI's environment starts (A4 3.8, as an agent's: the person's, scrubbed). */
  readonly environment: { base(): Promise<AgentBase> };
  /** Runs the CLI. Default runT3Cli. */
  readonly run?: T3CliRun;
  /** Opens a URL through the OS (A4 3.6.5): the thread link. */
  readonly open?: (url: string) => Promise<boolean>;
  /** Reads a `.cmd` shim. Default readShimFile. */
  readonly readShim?: (path: string) => string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  /** Each run of the CLI. Default T3_CLI_MS. */
  readonly timeoutMs?: number;
}

/** The instance's T3 keys the CLI route reads. */
export type T3CliInstance = Pick<Instance, "exec" | "argsPrefix" | "env" | "openPermission" | "t3">;

/** Whether the CLI route can be used for an instance now, from its settings and T3's runtime file. */
export type T3CliAvailability =
  { readonly state: "ready"; readonly command: T3CliCommand } | { readonly state: T3Unavailable };

/** What a launch hands the CLI between its click and its dispatch. Memory only. */
interface Staged {
  readonly args: readonly string[];
  /** The command's own arguments before TTasks's (the entry), for the dispatch's `project list`. */
  readonly prefix: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly file: string;
  readonly brief: string;
  readonly projectId: string;
  /** The task's folder, with the identity the project's root must still have at the dispatch. */
  readonly folder: BindFolder;
}

/** What the CLI said about a launch's thread, for `observe` and the link. Memory only. */
interface Started {
  readonly thread: string;
  readonly otherProject: boolean;
  readonly environment?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON object the CLI printed: the whole output, or its last line (a CLI may print more). */
function printedObject(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  const lines = trimmed.split(/\r?\n/u);
  for (const text of [trimmed, lines.at(-1) ?? ""]) {
    try {
      const value = JSON.parse(text) as unknown;
      if (isObject(value)) return value;
      if (Array.isArray(value)) return { projects: value };
    } catch {
      // Next form.
    }
  }
  return undefined;
}

/** `t3 project list --json`'s active projects, or undefined when the output is not a list. */
function projectsFrom(stdout: string): T3Project[] | undefined {
  const list = printedObject(stdout)?.["projects"];
  if (!Array.isArray(list)) return undefined;
  const projects = new Map<string, T3Project>();
  for (const item of list as unknown[]) {
    if (!isObject(item)) continue;
    const { id, workspaceRoot, archivedAt, deletedAt } = item;
    if (typeof id !== "string" || !EVIDENCE_ID.test(id) || typeof workspaceRoot !== "string") {
      continue;
    }
    if ((archivedAt ?? null) !== null || (deletedAt ?? null) !== null) continue;
    projects.set(id, { id, root: workspaceRoot });
  }
  return [...projects.values()];
}

/** Whether a folder's path can reach the CLI as one argument exactly: no control or lone surrogate. */
const passable = (path: string): boolean => path.isWellFormed() && !/\p{Cc}/u.test(path);

export class T3CliRoute {
  readonly #options: T3CliRouteOptions;
  readonly #run: T3CliRun;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #staged = new Map<string, Staged>();
  readonly #started = new Map<string, Started>();
  /** Each active project's root as the CLI last listed it, by project ID. Memory only. */
  #roots = new Map<string, string>();

  constructor(options: T3CliRouteOptions) {
    this.#options = options;
    this.#run = options.run ?? runT3Cli;
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Whether the CLI route can open a task for `instance` now: its command (no_cli, cli_unusable),
   * its settings (the provider instance and model together, a permission the CLI keeps), and T3's
   * server running (`not_running`, "Start T3 Code": the CLI is assumed to need it, L06). No process
   * is started and no request made.
   */
  async availability(instance: T3CliInstance): Promise<T3CliAvailability> {
    const found = t3CliCommand(instance, this.#platform, this.#options.readShim);
    if (!found.ok) return { state: found.reason };
    // The CLI has no runtime-mode flag: the thread gets the project's default mode (A4 3.4.1). That
    // keeps `inherit` and never gives less than full access asks; a narrower mode would be lost.
    const permission = instance.openPermission;
    if (permission !== "inherit" && permission !== "full-access") {
      return { state: "mode_needs_pairing" };
    }
    const provider = instance.t3?.providerInstance;
    const model = instance.t3?.model ?? "";
    if (provider !== undefined && model === "") return { state: "model_required" };
    if (provider === undefined && model !== "") return { state: "provider_required" };
    if (provider !== undefined && (!PROVIDER.test(provider) || !MODEL.test(model))) {
      return { state: "invalid_instance" };
    }
    const home = this.#options.home;
    if (home === undefined) return { state: "not_running" };
    // The CLI must speak to the T3 TTasks reads: a shim that names another home is not used.
    const named = found.command.env["T3CODE_HOME"];
    if (named !== undefined && !this.#sameFolder(named, home)) return { state: "cli_unusable" };
    if ((await readT3Origin(home, this.#platform)).status !== "ok") return { state: "not_running" };
    return { state: "ready", command: found.command };
  }

  #sameFolder(a: string, b: string): boolean {
    const P = this.#platform === "win32" ? win32 : posix;
    const norm = (p: string) => {
      const resolved = P.resolve(p);
      return this.#platform === "win32" || this.#platform === "darwin"
        ? resolved.toLowerCase()
        : resolved;
    };
    return norm(a) === norm(b);
  }

  /** The CLI's environment: the base scrubbed (A4 3.8), the instance's, T3's home, the shim's. */
  async #environment(
    instance: T3CliInstance,
    command: T3CliCommand,
  ): Promise<Record<string, string>> {
    const base = await this.#options.environment.base();
    const env = agentEnvironment({
      platform: this.#platform,
      base: base.env,
      baseKind: base.kind,
      instance: instance.env,
      additions: {},
      executable: command.file,
    });
    // A4 3.4.1: what the shim sets, for this child only (the scrub took every T3CODE_* and
    // ELECTRON_RUN_AS_NODE out of the base); the home is the one the route reads.
    const electron = command.env["ELECTRON_RUN_AS_NODE"];
    if (electron !== undefined) env["ELECTRON_RUN_AS_NODE"] = electron;
    if (this.#options.home !== undefined) env["T3CODE_HOME"] = this.#options.home;
    return env;
  }

  /** One run of the CLI with `args` after the command's own, in T3's home. */
  async #call(
    instance: T3CliInstance,
    command: T3CliCommand,
    args: readonly string[],
  ): Promise<T3CliResult> {
    const home = this.#options.home;
    if (home === undefined) return { kind: "not_started" };
    return this.#run({
      file: command.file,
      args: [...command.prefix, ...args],
      env: await this.#environment(instance, command),
      // T3's home: no project of the person's, so nothing the CLI might resolve against it.
      cwd: home,
      timeoutMs: this.#options.timeoutMs ?? T3_CLI_MS,
      maxBytes: T3_CLI_MAX_BYTES,
    });
  }

  /** Every active project the CLI lists, or why not. */
  async #projects(
    instance: T3CliInstance,
    command: T3CliCommand,
  ): Promise<T3Project[] | T3Unavailable> {
    const ran = await this.#call(instance, command, ["project", "list", "--json"]);
    if (ran.kind !== "exited" || ran.code !== 0) {
      // A T3 that stopped meanwhile says so; anything else does not tell.
      const home = this.#options.home;
      if (home === undefined || (await readT3Origin(home, this.#platform)).status !== "ok") {
        return "not_running";
      }
      return "no_answer";
    }
    const projects = projectsFrom(ran.stdout);
    if (projects === undefined) return "no_answer";
    this.#roots = new Map(projects.map((p) => [p.id, p.root]));
    return projects;
  }

  /**
   * Whether the project's root and the task's folder still have the identity the binding read: a
   * root replaced since (a junction or link retargeted, a folder moved in its place) names another
   * folder, which T3 would open. Checked at the stage and again just before the CLI starts; what is
   * left is the moment between that check and T3's own read of the root (A4 3.3).
   */
  async #stillBound(root: string, folder: BindFolder): Promise<boolean> {
    const [atRoot, atFolder] = await Promise.all([identityAt(root), identityAt(folder.path)]);
    const same = (a: typeof atRoot) =>
      a !== undefined && a.dev === folder.identity.dev && a.ino === folder.identity.ino;
    return same(atRoot) && same(atFolder);
  }

  /**
   * The Prepared step for the CLI route (A4 3.4.1 steps 1 to 4, exact roots only): a project whose
   * root has the folder's identity binds; a folder that is an existing worktree needs the paired
   * route; any other folder asks Register, or after Not now is unavailable for 30 days. Never the
   * project that contains the folder.
   */
  async prepare(input: {
    readonly place: string;
    readonly folder: BindFolder;
    readonly name: string;
    readonly instance: T3CliInstance;
  }): Promise<T3Prepared> {
    const available = await this.availability(input.instance);
    if (available.state !== "ready") return { kind: "unavailable", reason: available.state };
    const projects = await this.#projects(input.instance, available.command);
    if (typeof projects === "string") return { kind: "unavailable", reason: projects };
    const binding = await bindFolder(projects, input.folder, this.#platform);
    if (binding.kind === "bound") {
      return binding.strategy.type === "root"
        ? binding
        : { kind: "unavailable", reason: "worktree_needs_pairing" };
    }
    const until = notNowUntil(this.#options.files, input.place);
    if (until !== undefined && this.#now() < until) {
      return { kind: "unavailable", reason: "not_registered" };
    }
    return { kind: "ask", question: "register", text: T3_TEXT.register(input.name) };
  }

  /**
   * Register (A4 3.4.1 fallback step 1): `t3 project add <P>` for exactly the folder, then the
   * Prepared step again. A folder that still binds no exact root is unavailable. A folder whose path
   * cannot reach the CLI as one exact argument (a control character, a lone surrogate) is refused
   * before anything starts.
   */
  async register(input: {
    readonly place: string;
    readonly folder: BindFolder;
    readonly name: string;
    readonly instance: T3CliInstance;
  }): Promise<T3Prepared> {
    const available = await this.availability(input.instance);
    if (available.state !== "ready") return { kind: "unavailable", reason: available.state };
    const P = this.#platform === "win32" ? win32 : posix;
    if (!passable(input.folder.path) || !P.isAbsolute(input.folder.path)) {
      return { kind: "unavailable", reason: "not_registered" };
    }
    // An absolute path never starts with `-`, so the CLI cannot read it as an option. Its answer
    // is not trusted: the list below says whether the folder is a project root now (a project made
    // meanwhile by another click or T3's own UI included).
    const ran = await this.#call(input.instance, available.command, [
      "project",
      "add",
      input.folder.path,
    ]);
    if (ran.kind === "not_started") return { kind: "unavailable", reason: "no_answer" };
    const again = await this.prepare(input);
    return again.kind === "ask" ? { kind: "unavailable", reason: "not_registered" } : again;
  }

  /** Not now (A4 3.4.1 step 4): the same answer as on the paired route, per place for 30 days. */
  notNow(place: string): void {
    const now = this.#now();
    rememberNotNow(this.#options.files, place, now + NOT_NOW_MS, now);
  }

  /**
   * Readies launch `id` for its dispatch: the command line, its environment and the brief, kept in
   * memory (the brief never leaves it but on the CLI's stdin). Called after the click and before
   * `machine.dispatch(id)`, in the same call: a service that restarts in between keeps nothing, and
   * the intent expires in Prepared. `reference` is the task's reference, the thread's title.
   * `folder` is the folder the Prepared step bound: the project's root (as the CLI last listed it)
   * must still have its identity (`folder_changed` otherwise), and is checked again at dispatch.
   */
  async stage(
    id: string,
    input: {
      readonly projectId: string;
      readonly folder: BindFolder;
      readonly reference: string;
      readonly instance: T3CliInstance;
      readonly brief: string;
    },
  ): Promise<
    { readonly kind: "ready" } | { readonly kind: "unavailable"; readonly reason: T3Unavailable }
  > {
    const available = await this.availability(input.instance);
    if (available.state !== "ready") return { kind: "unavailable", reason: available.state };
    if (!EVIDENCE_ID.test(input.projectId) || !REFERENCE.test(input.reference)) {
      return { kind: "unavailable", reason: "invalid_instance" };
    }
    const limit = targetDef("t3").routes.find((r) => r.kind === "t3-cli")?.maxPrompt ?? 0;
    if (input.brief === "" || input.brief.length > limit || !input.brief.isWellFormed()) {
      return { kind: "unavailable", reason: "too_long" };
    }
    // The root T3 holds for this project must still be the bound folder: never a project the
    // Prepared step did not list, never a root that names another folder now.
    const root = this.#roots.get(input.projectId);
    if (root === undefined || !(await this.#stillBound(root, input.folder))) {
      return { kind: "unavailable", reason: "folder_changed" };
    }
    const provider = input.instance.t3?.providerInstance;
    const model = input.instance.t3?.model ?? "";
    const command = available.command;
    const args = [
      ...command.prefix,
      "thread",
      "start",
      input.projectId,
      "-",
      "--json",
      "--title",
      input.reference,
      ...(provider === undefined ? [] : ["--provider", provider, "--model", model]),
    ];
    const env = await this.#environment(input.instance, command);
    this.#keep(this.#staged, id, {
      file: command.file,
      args,
      env,
      brief: input.brief,
      projectId: input.projectId,
      prefix: command.prefix,
      folder: input.folder,
    });
    return { kind: "ready" };
  }

  #keep<T>(map: Map<string, T>, id: string, value: T): void {
    map.delete(id);
    map.set(id, value);
    while (map.size > KEPT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * The launch machine's `t3-cli` dispatch (A4 3.9.2), once, after Dispatching: `t3 thread
   * start` with the staged command line and the brief on stdin. A4 3.9.2's row, read strictly:
   * - a thread ID printed: `accepted` with the thread (Dispatched), whatever the exit code;
   * - the CLI never started: `refused` (Failed);
   * - first T3's project list is read again (T3 may have changed the project since the stage):
   *   no list is `refused`; a project no longer listed (archived, deleted), or whose root or the
   *   task's folder no longer has the bound identity, is `refused` with `folder_mismatch` (Failed).
   *   `thread start` runs only after that check passed;
   * - anything else, a non-zero exit with a message on stderr included: `unknown` (the machine
   *   records Unknown `no_answer`). A CLI that created the thread and then lost T3's reply exits
   *   the same way as one T3 refused, so an exit without a thread never proves that nothing
   *   started (A4 3.9.2), and the CLI cannot be repeated safely.
   * A launch with nothing staged (another route, a restart since the click) is `refused`: nothing
   * was started.
   */
  async dispatch(intent: LaunchIntent): Promise<DispatchOutcome> {
    if (intent.route !== "t3-cli") return { kind: "refused" };
    const staged = this.#staged.get(intent.id);
    // Taken at once: a launch's CLI runs once, whatever calls this again.
    this.#staged.delete(intent.id);
    const home = this.#options.home;
    if (staged === undefined || home === undefined) return { kind: "refused" };
    const timeoutMs = this.#options.timeoutMs ?? T3_CLI_MS;
    // The project as T3 holds it now, not as the Prepared step or the stage saw it: a root T3
    // changed meanwhile, or a folder replaced on disk, never gets the thread. A list starts nothing.
    const listed = await this.#run({
      file: staged.file,
      args: [...staged.prefix, "project", "list", "--json"],
      env: staged.env,
      cwd: home,
      timeoutMs: Math.min(timeoutMs, T3_CLI_LIST_MS),
      maxBytes: T3_CLI_MAX_BYTES,
    });
    const projects =
      listed.kind === "exited" && listed.code === 0 ? projectsFrom(listed.stdout) : undefined;
    if (projects === undefined) return { kind: "refused" };
    const root = projects.find((p) => p.id === staged.projectId)?.root;
    if (root === undefined || !(await this.#stillBound(root, staged.folder))) {
      return { kind: "refused", reason: "folder_mismatch" };
    }
    const ran = await this.#run({
      file: staged.file,
      args: staged.args,
      env: staged.env,
      cwd: home,
      stdin: staged.brief,
      timeoutMs,
      maxBytes: T3_CLI_MAX_BYTES,
    });
    if (ran.kind === "not_started") return { kind: "refused" };
    if (ran.kind !== "exited") return { kind: "unknown" };
    const printed = printedObject(ran.stdout);
    const thread = printed?.["threadId"];
    if (typeof thread === "string" && EVIDENCE_ID.test(thread)) {
      const project = printed?.["projectId"];
      const environment = printed?.["environmentId"];
      this.#keep(this.#started, intent.id, {
        thread,
        // The CLI says which project the thread went to; another than the one bound is not the
        // task's folder. The same one is no confirmation: nothing the CLI prints checks the folder.
        otherProject: typeof project === "string" && project !== staged.projectId,
        ...(typeof environment === "string" && EVIDENCE_ID.test(environment)
          ? { environment }
          : {}),
      });
      return { kind: "accepted", evidence: { thread } };
    }
    return { kind: "unknown" };
  }

  /**
   * What the CLI's own answer says about a dispatched launch: `failed` with `folder_mismatch` (the
   * thread kept as evidence) when it named another project than the bound one, else `pending`.
   * There is no `confirmed` here: only the paired route's folder check, or the bridge's binding of
   * the launch reference, confirms a T3 CLI launch.
   */
  observe(intent: LaunchIntent): Observation {
    const started = this.#started.get(intent.id);
    if (started === undefined || intent.evidence.thread !== started.thread) {
      return { kind: "pending" };
    }
    return started.otherProject
      ? { kind: "failed", reason: "folder_mismatch", evidence: { thread: started.thread } }
      : { kind: "pending" };
  }

  /**
   * Opens `t3code://threads/<environment>/<thread>` without a prompt (A4 3.4.1 fallback step 3: the
   * brief was sent). The environment ID is what the CLI printed, else a pairing's (one that needs
   * reconnecting keeps it); without one the thread is not linked and T3 shows it in its own list.
   * Opening a link to a known thread is not a launch, so it may be repeated.
   */
  async openThread(intent: LaunchIntent): Promise<boolean> {
    const thread = intent.evidence.thread;
    const open = this.#options.open;
    if (intent.route !== "t3-cli" || thread === undefined || open === undefined) return false;
    const environment =
      this.#started.get(intent.id)?.environment ?? readPairing(this.#options.files)?.environment;
    if (environment === undefined) return false;
    try {
      return await open(t3ThreadLink(environment, thread));
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Which T3 route a click takes (A4 3.4: the primary, or a fallback when the primary is
// unavailable before dispatch, or when the person picks it)

export type T3Choice =
  | { readonly kind: "route"; readonly route: "t3-mcp" | "t3-cli" }
  | { readonly kind: "unavailable"; readonly reason: T3Unavailable };

/**
 * Whether the CLI route is offered (A4 3.4.1 "Fallback route"). Off: T3's command line has no
 * `project list` (checked at T3 commit f82162f), so the route can never bind a folder to a project
 * and would always fail closed. The route's code stays, tested, for a T3 that adds one: turning
 * this on is the change then, after a real-machine check of the command's output.
 */
export const T3_CLI_ROUTE = false;

/**
 * The T3 route for `instance` now, from what both routes already read (machine state, T3's runtime
 * file, the instance; no request, no process, no polling). With the CLI route off (T3_CLI_ROUTE) it
 * is the paired route or why not: `not_paired` says to pair with `ttasks setup t3`. With it on:
 * - `pick: "t3-cli"`, the person's choice: the CLI route, or why it cannot be used;
 * - paired and T3 running: `t3-mcp`;
 * - paired and T3 not running: `not_running`, "Start T3 Code";
 * - "Reconnect T3": `reconnect` (the person may pick the CLI);
 * - not paired: the CLI route when it can be used; `not_running`, "Start T3 Code", when it could once
 *   T3 runs; `not_paired` when the instance names no `t3` command; else why the CLI cannot be used.
 */
export async function chooseT3Route(
  paired: Pick<T3Route, "availability">,
  cli: Pick<T3CliRoute, "availability">,
  instance: T3CliInstance,
  pick?: "t3-cli",
  options: { readonly cliRoute?: boolean } = {},
): Promise<T3Choice> {
  if (!(options.cliRoute ?? T3_CLI_ROUTE)) {
    const primary = await paired.availability();
    return primary.state === "ready"
      ? { kind: "route", route: "t3-mcp" }
      : { kind: "unavailable", reason: primary.state };
  }
  if (pick === "t3-cli") {
    const viaCli = await cli.availability(instance);
    return viaCli.state === "ready"
      ? { kind: "route", route: "t3-cli" }
      : { kind: "unavailable", reason: viaCli.state };
  }
  const primary = await paired.availability();
  if (primary.state === "ready") return { kind: "route", route: "t3-mcp" };
  if (primary.state !== "not_paired") return { kind: "unavailable", reason: primary.state };
  const viaCli = await cli.availability(instance);
  if (viaCli.state === "ready") return { kind: "route", route: "t3-cli" };
  if (viaCli.state === "no_cli") return { kind: "unavailable", reason: "not_paired" };
  return { kind: "unavailable", reason: viaCli.state };
}
