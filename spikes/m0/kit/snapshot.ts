// Row E01 (A4 3.8, M0.07): the environment the service builds for a launched agent, at spike
// level. The stand-in service answers `spike.env_snapshot` with it.
//
// Linux and macOS: layer 1 is the session (`systemctl --user show-environment`, a fixed list of
// names), layer 2 the login-shell snapshot (`$SHELL -lic` printing `env -0` between two random
// markers, detached, stdin ignored, home as cwd, TERM=dumb, TTASKS_RESOLVING_ENVIRONMENT=1, 10 s hard
// timeout). Session variables win, except that SSH_AUTH_SOCK from the snapshot wins when the
// session has none and its socket exists. PATH comes from the snapshot.
// Windows: the user and system environment re-read from the registry (`reg query`, REG_EXPAND_SZ
// expanded), system first, then user, with the two Path values joined. No shell snapshot.
//
// The result holds counts, times and found or not found per tool, never a value or a path.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, win32 } from "node:path";

/** The tools row E01 looks for. The local chat tool's name is passed in by the lab. */
export const E01_TOOLS = ["node", "claude", "codex", "codex-work", "codex-personal", "t3", "rg"];

/** Tool names are short labels, never paths or shell text. */
export const TOOL_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** The session variables layer 1 takes (A4 3.8). */
const SESSION_NAMES =
  /^(DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_[A-Z_]+|XAUTHORITY|SSH_AUTH_SOCK|TERMINAL)$/;

/** The Windows OpenSSH agent's pipe. */
const WINDOWS_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

export interface ToolFinding {
  found: boolean;
  /** Linux: the tool resolved inside an nvm folder. Not a path. */
  nvm?: boolean;
  /** Windows: the extension it resolved with, such as ".exe" or ".cmd". */
  ext?: string;
}

export interface EnvSnapshot {
  platform: NodeJS.Platform;
  method: "login-shell" | "registry" | "inherited";
  ok: boolean;
  /** Why the snapshot failed, as a short code. */
  reason?: string;
  ms: number;
  variables: number;
  path_entries: number;
  tools: Record<string, ToolFinding>;
  ssh_agent: { found: boolean; via: "SSH_AUTH_SOCK" | "pipe" | "none" };
  /** Linux: whether `systemctl --user show-environment` answered, and how many names it gave. */
  session?: { ok: boolean; variables: number };
}

type Env = Record<string, string>;

/**
 * Row E01: the tools, and `ssh_agent`, whose found flag differs between the service's snapshot
 * and a hand-opened shell. A missing snapshot finds nothing.
 */
export function snapshotDifferences(
  tools: readonly string[],
  built:
    { tools?: Record<string, { found?: unknown }>; ssh_agent?: { found?: unknown } } | undefined,
  hand: { tools: Record<string, boolean>; ssh_agent: boolean },
): string[] {
  const found = built?.tools ?? {};
  const differences = tools.filter((t) => (found[t]?.found === true) !== (hand.tools[t] === true));
  if ((built?.ssh_agent?.found === true) !== hand.ssh_agent) differences.push("ssh_agent");
  return differences;
}

/** Finds `name` on `path` the way the OS would: PATHEXT on Windows, the exec bit elsewhere. */
export function resolveTool(
  name: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const windows = platform === "win32";
  const pathValue = windows ? (env["Path"] ?? env["PATH"] ?? "") : (env["PATH"] ?? "");
  const dirs = pathValue.split(windows ? ";" : ":").filter((d) => d !== "");
  const exts = windows
    ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = windows ? win32.join(dir, name + ext.toLowerCase()) : join(dir, name);
      try {
        if (!statSync(file).isFile()) continue;
        if (!windows) accessSync(file, constants.X_OK);
        return file;
      } catch {
        // Not here, unless it is a Windows app execution alias (WindowsApps\wt.exe and the
        // like): stat cannot follow one, lstat sees a link and readlink resolves it.
        if (windows && isAppAlias(file)) return file;
      }
    }
  }
  return undefined;
}

function isAppAlias(file: string): boolean {
  try {
    if (!lstatSync(file).isSymbolicLink()) return false;
    readlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function findTools(tools: readonly string[], env: Env, platform: NodeJS.Platform) {
  const found: Record<string, ToolFinding> = {};
  for (const name of tools) {
    const file = resolveTool(name, env, platform);
    const finding: ToolFinding = { found: file !== undefined };
    if (file !== undefined && platform === "win32") {
      finding.ext = win32.extname(file).toLowerCase();
    }
    if (file !== undefined && platform !== "win32") finding.nvm = file.includes("/.nvm/");
    found[name] = finding;
  }
  return found;
}

function pathEntries(env: Env, platform: NodeJS.Platform): number {
  const value = platform === "win32" ? (env["Path"] ?? env["PATH"] ?? "") : (env["PATH"] ?? "");
  return value.split(platform === "win32" ? ";" : ":").filter((d) => d !== "").length;
}

function isSocket(path: string | undefined): boolean {
  if (path === undefined || path === "") return false;
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

/** The values between the two markers of `env -0` output. */
export function parseEnvBlock(output: Buffer, marker: string): Env | undefined {
  const fence = Buffer.from(`\0${marker}\0`);
  const start = output.indexOf(fence);
  if (start === -1) return undefined;
  const end = output.indexOf(fence, start + fence.length);
  if (end === -1) return undefined;
  const env: Env = {};
  for (const entry of output
    .subarray(start + fence.length, end)
    .toString("utf8")
    .split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** `systemctl --user show-environment` lines, filtered to the session names of A4 3.8. */
export function parseSessionEnvironment(text: string): Env {
  const env: Env = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    if (!SESSION_NAMES.test(name)) continue;
    let value = line.slice(eq + 1);
    // systemd quotes values with special characters as $'...'.
    if (value.startsWith("$'") && value.endsWith("'")) value = value.slice(2, -1);
    env[name] = value;
  }
  return env;
}

/** A4 3.8's merge: session beats snapshot, SSH_AUTH_SOCK from the snapshot only if it exists. */
export function mergeLayers(session: Env, snapshot: Env): Env {
  const merged: Env = { ...snapshot };
  for (const [name, value] of Object.entries(session)) {
    if (name === "SSH_AUTH_SOCK") continue;
    merged[name] = value;
  }
  const fromSession = session["SSH_AUTH_SOCK"];
  const fromSnapshot = snapshot["SSH_AUTH_SOCK"];
  if (fromSession !== undefined && fromSession !== "") merged["SSH_AUTH_SOCK"] = fromSession;
  else if (fromSnapshot !== undefined && isSocket(fromSnapshot)) {
    merged["SSH_AUTH_SOCK"] = fromSnapshot;
  } else delete merged["SSH_AUTH_SOCK"];
  return merged;
}

/** Runs `$SHELL -lic` and returns the environment between the markers (A4 3.8 layer 2). */
function loginShell(
  shell: string,
  timeoutMs: number,
): Promise<{ ok: true; env: Env } | { ok: false; reason: string }> {
  const marker = randomBytes(12).toString("hex");
  const script = `printf '\\0%s\\0' ${marker}; env -0; printf '\\0%s\\0' ${marker}`;
  return new Promise((resolve) => {
    const child = spawn(shell, ["-lic", script], {
      cwd: homedir(),
      env: { ...process.env, TERM: "dumb", TTASKS_RESOLVING_ENVIRONMENT: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
      shell: false,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "shell_failed" });
    });
    child.once("close", (_code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") {
        resolve({ ok: false, reason: "timeout" });
        return;
      }
      const env = parseEnvBlock(Buffer.concat(chunks), marker);
      resolve(env === undefined ? { ok: false, reason: "no_markers" } : { ok: true, env });
    });
  });
}

/** One `reg query` key: name to [type, value]. */
export function parseRegQuery(text: string): Map<string, { type: string; value: string }> {
  const values = new Map<string, { type: string; value: string }>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+) {4}(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      values.set(m[1], { type: m[2], value: m[3] ?? "" });
    }
  }
  return values;
}

/** Expands `%NAME%` against `env`, case-insensitively, leaving unknown names as they are. */
export function expandWindows(value: string, env: Env): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%]+)%/g, (all, name: string) => lower.get(name.toLowerCase()) ?? all);
}

function regKey(key: string): Map<string, { type: string; value: string }> | undefined {
  const reg = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "reg.exe");
  const result = spawnSync(reg, ["query", key], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 10_000,
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  return parseRegQuery(result.stdout);
}

/** The variables Windows derives for the user rather than storing under Environment. */
const PROFILE_NAMES = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "COMPUTERNAME",
];

/** The registry layers of A4 3.8 (Windows): system, then user, Path values joined. */
export function windowsRegistryEnvironment(
  system: Map<string, { type: string; value: string }>,
  user: Map<string, { type: string; value: string }>,
  base: Env,
): Env {
  // By lower-case name, keeping the spelling that set it last (Windows names ignore case).
  const vars = new Map<string, { name: string; value: string }>();
  const flat = (): Env => Object.fromEntries([...vars.values()].map((v) => [v.name, v.value]));
  for (const name of PROFILE_NAMES) {
    const value = base[name];
    if (value !== undefined) vars.set(name.toLowerCase(), { name, value });
  }
  const apply = (values: Map<string, { type: string; value: string }>, joinPath: boolean) => {
    for (const [name, { type, value }] of values) {
      const expanded = type === "REG_EXPAND_SZ" ? expandWindows(value, flat()) : value;
      const existing = vars.get(name.toLowerCase());
      if (joinPath && name.toLowerCase() === "path" && existing !== undefined) {
        existing.value = `${existing.value};${expanded}`;
      } else vars.set(name.toLowerCase(), { name, value: expanded });
    }
  };
  apply(system, false);
  apply(user, true);
  return flat();
}

function envOf(source: NodeJS.ProcessEnv): Env {
  const env: Env = {};
  for (const [name, value] of Object.entries(source)) if (value !== undefined) env[name] = value;
  return env;
}

function windowsAgent(): boolean {
  try {
    return existsSync(WINDOWS_AGENT_PIPE);
  } catch {
    return false;
  }
}

function finish(
  method: EnvSnapshot["method"],
  started: number,
  env: Env,
  tools: readonly string[],
  extra: Partial<EnvSnapshot> = {},
): EnvSnapshot {
  const platform = process.platform;
  const sock = env["SSH_AUTH_SOCK"];
  const pipe = platform === "win32" && windowsAgent();
  const agent: EnvSnapshot["ssh_agent"] =
    platform === "win32"
      ? { found: pipe, via: pipe ? "pipe" : "none" }
      : isSocket(sock)
        ? { found: true, via: "SSH_AUTH_SOCK" }
        : { found: false, via: "none" };
  return {
    platform,
    method,
    ok: true,
    ms: Math.round((performance.now() - started) * 10) / 10,
    variables: Object.keys(env).length,
    path_entries: pathEntries(env, platform),
    tools: findTools(tools, env, platform),
    ssh_agent: agent,
    ...extra,
  };
}

/** What the process's own inherited environment finds: the service without any snapshot. */
export function inheritedSnapshot(tools: readonly string[]): EnvSnapshot {
  return finish("inherited", performance.now(), envOf(process.env), tools);
}

export interface SnapshotOptions {
  tools: readonly string[];
  /** Linux and macOS: the login shell. Default $SHELL, else the account's shell. */
  loginShell?: string;
  timeoutMs?: number;
}

/** Builds the agent environment as A4 3.8 says, and reports what it finds. */
export async function buildSnapshot(options: SnapshotOptions): Promise<EnvSnapshot> {
  const started = performance.now();
  const { tools } = options;
  if (process.platform === "win32") {
    const system = regKey("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
    const user = regKey("HKCU\\Environment");
    if (system === undefined || user === undefined) {
      return {
        ...finish("registry", started, {}, tools),
        ok: false,
        reason: "registry_unreadable",
      };
    }
    return finish(
      "registry",
      started,
      windowsRegistryEnvironment(system, user, envOf(process.env)),
      tools,
    );
  }
  const shell = options.loginShell ?? process.env["SHELL"] ?? userInfo().shell ?? "/bin/sh";
  const show = spawnSync("systemctl", ["--user", "show-environment"], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
  });
  const sessionOk = show.error === undefined && show.status === 0;
  const session = sessionOk ? parseSessionEnvironment(show.stdout) : {};
  const snapshot = await loginShell(shell, options.timeoutMs ?? 10_000);
  const sessionInfo = { ok: sessionOk, variables: Object.keys(session).length };
  if (!snapshot.ok) {
    return {
      ...finish("login-shell", started, mergeLayers(session, {}), tools, { session: sessionInfo }),
      ok: false,
      reason: snapshot.reason,
    };
  }
  return finish("login-shell", started, mergeLayers(session, snapshot.env), tools, {
    session: sessionInfo,
  });
}
