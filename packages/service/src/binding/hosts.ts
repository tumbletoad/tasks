// Shared hosts (A3 3.7.5, M4.06): an agent app that runs one MCP server for many conversations
// would leak a connection's binding from one conversation into the others, so such a connection is
// shared from its bind frame on, and joins no session (bindings.ts). Two hosts are shared until the
// lab proves otherwise:
// - Claude Desktop's chat: an entry of the app `claude-desktop` whose bind frame carries no
//   `CLAUDE_CODE_SESSION_ID`. Its Code tab sets one per session, so a Code tab is per session.
// - A Codex app-server: the Codex desktop app and T3 Code each run one `codex app-server` for many
//   threads, and its MCP servers are its children. A Codex entry (`codex`, `codex-app`) whose bridge
//   has such a process among its first four ancestors is shared. The Codex CLI runs no app-server,
//   so its sessions are per session.
//
// Every input comes from the authenticated bind frame: the entry's `--app`, its environment, and
// `parent.pid` (the bridge's parent, A3 3.7.2), whose ancestors the service reads only to tell the
// host. An ancestor's command line is compared in memory and never kept or logged. A Codex host
// the service cannot read in time is `unknown`: its ticket binds nothing at the bind frame, since
// an app-server's environment would be every thread's, and the connection binds at its first call,
// which carries its own thread ID; M2.04's guard marks it shared once two conversations show.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { powershellPath } from "@tasks/launch";

/** One ancestor process: its command line as arguments, the program first. */
export interface Ancestor {
  readonly argv: readonly string[];
}

/** Reads up to `depth` ancestors from `pid` itself upwards; an empty list when it cannot tell. */
export type Ancestry = (pid: number, depth: number) => Promise<readonly Ancestor[]>;

/** A3 3.7.2: the service walks up to four ancestors. */
export const ANCESTORS = 4;
/** How long a bind frame waits for the ancestors: its client waits 5 s for the whole bind. */
export const HOST_DEADLINE_MS = 3_000;

/** The entry app words of the hosts above (setup writes `--app`, A3 3.13). */
export const CLAUDE_DESKTOP_APP = "claude-desktop";
export const CODEX_APPS: ReadonlySet<string> = new Set(["codex", "codex-app"]);

/** A program's name without its folder and an `.exe`, `.cmd`, `.js` or `.mjs` ending, lower case. */
export function programName(arg: string): string {
  const base = arg.split(/[\\/]/u).pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|js|mjs|cjs)$/u, "");
}

/**
 * Whether a command line runs a Codex app-server: a Codex program (`codex`, the npm wrapper
 * `codex.js`, or a platform binary such as `codex-x86_64-unknown-linux-musl`) followed by
 * `app-server`. A node wrapper's program is node, so every argument is looked at.
 */
export function runsAppServer(argv: readonly string[]): boolean {
  return argv.some(
    (arg, i) =>
      i + 1 < argv.length && programName(arg).startsWith("codex") && argv[i + 1] === "app-server",
  );
}

/**
 * Which shared host a bind frame shows, if any. `unknown`: a Codex entry whose ancestors could not
 * be read in time, which may be an app-server's.
 */
export type SharedHost = "claude-desktop" | "app-server" | "unknown";

/**
 * The shared host of a connection (A3 3.7.5), from its entry's app word, its bind frame's
 * environment and its ancestors. Undefined: a per-session host, or no reader on this OS.
 */
export async function sharedHost(
  facts: {
    readonly app: unknown;
    readonly env: Readonly<Record<string, unknown>>;
    readonly parent: unknown;
  },
  ancestry: Ancestry | undefined,
): Promise<SharedHost | undefined> {
  if (facts.app === CLAUDE_DESKTOP_APP) {
    return typeof facts.env["CLAUDE_CODE_SESSION_ID"] === "string" ? undefined : "claude-desktop";
  }
  if (typeof facts.app !== "string" || !CODEX_APPS.has(facts.app) || ancestry === undefined) {
    return undefined;
  }
  const pid =
    typeof facts.parent === "object" && facts.parent !== null
      ? (facts.parent as Record<string, unknown>)["pid"]
      : undefined;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
    return "unknown";
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, HOST_DEADLINE_MS);
    timer.unref();
  });
  try {
    const found = await Promise.race([ancestry(pid, ANCESTORS).catch(() => undefined), late]);
    if (found === undefined || found.length === 0) return "unknown";
    return found.some((a) => runsAppServer(a.argv)) ? "app-server" : undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// The ancestors as the OS records them

/** Linux: each process's parent from /proc/<pid>/stat and its arguments from /proc/<pid>/cmdline. */
export function linuxAncestors(pid: number, depth: number, proc = "/proc"): Ancestor[] {
  const out: Ancestor[] = [];
  let at = pid;
  for (let i = 0; i < depth && at > 1; i += 1) {
    let stat: string;
    let cmdline: string;
    try {
      stat = readFileSync(`${proc}/${String(at)}/stat`, "utf8");
      cmdline = readFileSync(`${proc}/${String(at)}/cmdline`, "utf8");
    } catch {
      break;
    }
    out.push({ argv: cmdline.split("\0").filter((arg) => arg !== "") });
    // The command name (field 2) may hold spaces and parentheses: the fields after it follow the
    // last closing parenthesis, and the parent is field 4.
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!Number.isSafeInteger(parent) || parent <= 0) break;
    at = parent;
  }
  return out;
}

/**
 * A Windows command line as arguments, by the rules programs read their own: whitespace separates
 * arguments outside double quotes, and the quotes are dropped. Enough to compare words; backslash
 * escapes before quotes are not needed for that.
 */
export function windowsArgv(commandLine: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let any = false;
  for (const char of commandLine) {
    if (char === '"') {
      quoted = !quoted;
      any = true;
    } else if (!quoted && /\s/u.test(char)) {
      if (any) out.push(current);
      current = "";
      any = false;
    } else {
      current += char;
      any = true;
    }
  }
  if (any) out.push(current);
  return out;
}

/**
 * Windows: one Windows PowerShell call reads the process table through CIM (Win32_Process: the
 * parent and the command line) and walks it from `pid`. The script holds only integers checked
 * here, and each command line comes back base64-encoded, so no output can be misread.
 */
export async function windowsAncestors(
  pid: number,
  depth: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
  // How long the read may take before it is killed: the bind's own deadline.
  timeoutMs = HOST_DEADLINE_MS,
): Promise<Ancestor[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(depth) || depth <= 0) {
    return [];
  }
  const script =
    "$all = @{}; foreach ($x in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine) { $all[[int]$x.ProcessId] = $x }; " +
    `$p = ${String(pid)}; for ($i = 0; $i -lt ${String(depth)} -and $all.ContainsKey($p); $i++) { ` +
    "$x = $all[$p]; $c = [string]$x.CommandLine; " +
    "[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($c))); " +
    "$p = [int]$x.ParentProcessId }";
  const text = await new Promise<string>((resolve) => {
    const child = spawn(
      powershellPath(env),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 1_000_000) output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, timeoutMs);
    timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output : "");
    });
  });
  return text
    .split(/\r?\n/u)
    .filter((line) => /^[A-Za-z0-9+/]*={0,2}$/u.test(line.trim()) && line.trim() !== "")
    .slice(0, depth)
    .map((line) => ({ argv: windowsArgv(Buffer.from(line.trim(), "base64").toString("utf8")) }));
}

/** This OS's ancestry, or none where the service cannot read one (macOS for now). */
export function osAncestry(platform: NodeJS.Platform): Ancestry | undefined {
  if (platform === "linux") return (pid, depth) => Promise.resolve(linuxAncestors(pid, depth));
  if (platform === "win32") return (pid, depth) => windowsAncestors(pid, depth);
  return undefined;
}
