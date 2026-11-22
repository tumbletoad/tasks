// `ttasks brief <task> [--pack] [--copy]` (A4 3.4.6): Copy from a terminal. The verb is the
// registry's `launch.open` without an instance; `--pack` is its own input (the context pack, A4
// 3.15.5). `--copy` is the CLI's: the text goes to the OS's clipboard tool through its standard
// input (`@ttasks/launch/clipboard`), and the person is told it did. When no tool is here, or the
// tool fails, the CLI says so plainly and prints the text instead: a copy that did not happen is
// never reported.
import { PRODUCT_NAME } from "@ttasks/brand";
import { copyText, type CopyResult } from "@ttasks/launch/clipboard";
import type { Globals, VerbSpec } from "./args.ts";
import type { ConnectOptions } from "./connect.ts";
import type { Io } from "./io.ts";
import { runVerb } from "./verbs.ts";

/** The OS's clipboard, or a test's in its place. */
export type Clipboard = (text: string, io: Io) => Promise<CopyResult>;

export interface BriefOptions extends ConnectOptions {
  /** Default: the OS's clipboard tools. */
  readonly clipboard?: Clipboard;
}

const osClipboard: Clipboard = (text, io) =>
  copyText(text, { platform: io.platform, env: io.env, cwd: io.cwd });

/** Why a copy did not happen, in words a person reads: tool names and codes only. */
export function copyFailure(result: Exclude<CopyResult, { status: "copied" }>): string {
  const tool =
    result.tool === undefined
      ? "The clipboard tool"
      : result.tool === "set-clipboard"
        ? "Set-Clipboard"
        : result.tool;
  switch (result.reason) {
    case "no_session":
      return "There is no desktop session here to hold a clipboard (no WAYLAND_DISPLAY or DISPLAY).";
    case "no_tool":
      return "No clipboard tool was found: install wl-clipboard (Wayland), xclip or xsel.";
    case "timeout":
      return `${tool} did not finish in time.`;
    case "failed":
      return result.code === undefined
        ? `${tool} could not be started.`
        : `${tool} failed (exit code ${String(result.code)}).`;
  }
}

/** `ttasks brief`: the generated verb, with `--copy` taken out before its arguments are read. */
export async function briefCommand(
  io: Io,
  globals: Globals,
  verb: VerbSpec,
  args: readonly string[],
  options: BriefOptions,
): Promise<number> {
  const end = args.indexOf("--");
  const head = end === -1 ? args : args.slice(0, end);
  const copy = head.includes("--copy");
  if (!copy) return runVerb(io, globals, verb, args, options);
  const rest = [...head.filter((a) => a !== "--copy"), ...(end === -1 ? [] : args.slice(end))];
  const clipboard = options.clipboard ?? osClipboard;
  return runVerb(io, globals, verb, rest, options, async (result, printed) => {
    const text = result["copy"];
    if (typeof text !== "string") {
      io.stdout(printed);
      return;
    }
    const pack = text.startsWith(`${PRODUCT_NAME} context pack `);
    const done = await clipboard(text, io).catch((): CopyResult => ({
      status: "failed",
      reason: "failed",
    }));
    if (done.status === "copied") {
      if (globals.json) io.stdout(printed);
      else {
        const launch = (result["launch"] ?? {}) as { reference?: unknown };
        io.stdout(
          `${pack ? "Context pack" : "Brief"} copied to the clipboard (launch ${String(launch.reference)}).\n`,
        );
      }
      return;
    }
    io.stderr(`Not copied: ${copyFailure(done)} The ${pack ? "context pack" : "brief"} follows.\n`);
    io.stdout(printed);
  });
}
