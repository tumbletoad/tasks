// The clipboard tools of `ttasks brief --copy`: the OS's own program puts the text on the
// person's clipboard, because a CLI has no clipboard of its own. The text goes to the tool through
// its standard input, never as an argument or in a file: a command line is readable by other local
// users, and a script on disk outlives the copy.
//
// - Linux: `wl-copy` in a Wayland session, then `xclip`, then `xsel` in an X11 one (WAYLAND_DISPLAY
//   and DISPLAY say which). Each is found on the PATH by name and started without a shell. macOS:
//   `pbcopy`. Windows: Windows PowerShell 5.1 by its full path under the system folder (as every
//   other PowerShell call of TTasks), running one fixed script that reads standard input as UTF-8
//   and calls `Set-Clipboard`. The script is a plain `-Command` argument with no text of the
//   person's in it, never an encoded command line.
// - A tool is a helper of the runner (helpers.ts), with a deadline, recorded and waited for. On
//   Linux `wl-copy`, `xclip` and `xsel` fork a process that holds the selection and exit: that
//   process is the tool's own and stays until another program takes the clipboard, exactly as when
//   the person runs the tool in a shell (the runner's `serves`). TTasks waits for the tool it started
//   and ends it at the deadline, never what the tool forked.
// - A tool that fails or does not finish makes the next one run; when none copied, the result says
//   why and the caller prints the text instead. A copy is reported only when a tool exited 0.
import { posix } from "node:path";
import { findOnPosixPath } from "./environment/provider.ts";
import { startHelper } from "./helpers.ts";
import { powershellPath } from "./process.ts";

export const CLIPBOARD_TOOLS = ["wl-copy", "xclip", "xsel", "pbcopy", "set-clipboard"] as const;
export type ClipboardTool = (typeof CLIPBOARD_TOOLS)[number];

/** How long one tool may take before it is ended and the next one is tried. */
export const CLIPBOARD_DEADLINE_MS = 15_000;

/**
 * The script Windows PowerShell runs: standard input read whole as UTF-8 bytes (never through the
 * console's code page), then `Set-Clipboard`. `sink` is what takes `$text`; tests pass one that
 * writes a file instead of the clipboard.
 */
export function windowsClipboardScript(sink = "Set-Clipboard -Value $text"): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$in = [Console]::OpenStandardInput()",
    "$buffer = [System.IO.MemoryStream]::new()",
    "$in.CopyTo($buffer)",
    "$text = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())",
    sink,
  ].join("; ");
}

/** Each tool's own arguments after its program: the text always comes on standard input. */
export const CLIPBOARD_ARGS: Readonly<Record<ClipboardTool, readonly string[]>> = {
  "wl-copy": [],
  xclip: ["-selection", "clipboard", "-in"],
  xsel: ["--clipboard", "--input"],
  pbcopy: [],
  "set-clipboard": [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsClipboardScript(),
  ],
};

/** Whether the tool forks a selection holder that outlives it (Linux's three). */
const SERVES: ReadonlySet<ClipboardTool> = new Set(["wl-copy", "xclip", "xsel"]);

type Env = Readonly<Record<string, string | undefined>>;

const set = (env: Env, name: string): boolean => (env[name] ?? "") !== "";

/**
 * The tools to try on this machine, in order, or `no_session` on Linux without a
 * desktop session to hold a clipboard.
 */
export function clipboardTools(
  platform: NodeJS.Platform,
  env: Env,
): readonly ClipboardTool[] | "no_session" {
  if (platform === "win32") return ["set-clipboard"];
  if (platform === "darwin") return ["pbcopy"];
  const tools: ClipboardTool[] = [];
  if (set(env, "WAYLAND_DISPLAY")) tools.push("wl-copy");
  if (set(env, "DISPLAY")) tools.push("xclip", "xsel");
  return tools.length === 0 ? "no_session" : tools;
}

/** The program that runs a tool here: on the PATH by name, PowerShell under the system folder. */
export function clipboardProgram(
  tool: ClipboardTool,
  platform: NodeJS.Platform,
  env: Env,
): readonly string[] | undefined {
  if (tool === "set-clipboard") return platform === "win32" ? [powershellPath(env)] : undefined;
  const found = findOnPosixPath(tool, env["PATH"]);
  return found !== undefined && posix.isAbsolute(found) ? [found] : undefined;
}

export type CopyResult =
  | { readonly status: "copied"; readonly tool: ClipboardTool }
  | {
      readonly status: "failed";
      /**
       * `no_session`: Linux without WAYLAND_DISPLAY or DISPLAY. `no_tool`: none of the tools is
       * installed. `failed`: the last tool tried exited with an error. `timeout`: it did not finish.
       */
      readonly reason: "no_session" | "no_tool" | "failed" | "timeout";
      /** The last tool tried, when one was. */
      readonly tool?: ClipboardTool;
      /** Its exit code, when it exited with one. */
      readonly code?: number;
    };

export interface CopyOptions {
  readonly platform: NodeJS.Platform;
  /** The person's environment: the PATH and the session's display variables, passed on whole. */
  readonly env: Env;
  /** The folder the tool runs in. */
  readonly cwd: string;
  /** The program of a tool (tests: a fake). Default: clipboardProgram. */
  readonly program?: (tool: ClipboardTool) => readonly string[] | undefined;
  readonly deadlineMs?: number;
}

/**
 * Puts `text` on the clipboard with the first tool here that takes it. Never reports a
 * copy that did not happen: only a tool's exit 0 is a copy.
 */
export async function copyText(text: string, options: CopyOptions): Promise<CopyResult> {
  const tools = clipboardTools(options.platform, options.env);
  if (tools === "no_session") return { status: "failed", reason: "no_session" };
  const program =
    options.program ?? ((tool) => clipboardProgram(tool, options.platform, options.env));
  let last: CopyResult = { status: "failed", reason: "no_tool" };
  for (const tool of tools) {
    const argv = program(tool);
    if (argv === undefined) continue;
    const result = await runTool(tool, [...argv, ...CLIPBOARD_ARGS[tool]], text, options);
    if (result.status === "copied") return result;
    last = result;
  }
  return last;
}

async function runTool(
  tool: ClipboardTool,
  argv: readonly string[],
  text: string,
  options: CopyOptions,
): Promise<CopyResult> {
  let helper;
  try {
    helper = startHelper(argv, {
      env: options.env,
      cwd: options.cwd,
      deadlineMs: options.deadlineMs ?? CLIPBOARD_DEADLINE_MS,
      stdin: true,
      serves: SERVES.has(tool),
    });
  } catch {
    return { status: "failed", reason: "failed", tool };
  }
  helper.child.stdin?.end(Buffer.from(text, "utf8"));
  const code = await helper.ended;
  if (code === 0) return { status: "copied", tool };
  if (helper.timedOut()) return { status: "failed", reason: "timeout", tool };
  return { status: "failed", reason: "failed", tool, ...(code === null ? {} : { code }) };
}
