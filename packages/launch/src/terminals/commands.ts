// Terminal command lines (A4 3.6.2, 3.7). Every line runs the
// shim and nothing else: the terminal's own fixed flags, then `<abs tasks> shim <ticket>`. No
// title, folder, brief or task text ever goes into a terminal's argv or a shell string:
// - the folder reaches the shim in the claim's reply, and the shim enters it itself before its
//   check (A4 3.3's check, unchanged), so no terminal's working-directory flag, quoting
//   rule or start-folder setting decides where the agent starts;
// - the title reaches the shim in the claim's reply too, and the shim sets it (OSC 0, sanitised),
//   so no terminal's title flag is used and none suppresses the shim's title.
// The terminal process still gets the folder as its spawn's working directory (an option of the
// OS call, not argv), which is where a terminal that honours it opens.
//
// Every command is an argument array, spawned without a shell; the console's starter is Windows
// PowerShell with a fixed script, its values in variables. Windows Terminal is the one terminal
// that re-reads its own argv as text: it splits on `;` even inside an argument, so an element with
// `;` (the product's path, in a test install) cannot be passed and the adapter refuses before
// anything starts. The ticket is 24 symbols of A1's alphabet.
//
// Kinds (A4 3.6.2 "Acceptance per terminal"):
// - `handoff`: the client hands the request to a running terminal server and exits, whatever its
//   code means; Dispatched once spawned.
// - `direct`: the process owns the window. Dispatched when the shim claimed, the process still
//   runs after 2 s, or it exited 0. A non-zero exit within 2 s and before any claim took its window
//   with it: the next terminal may be tried.
// - `shim`: the console fallback on Windows. Node cannot give a child a console window of its own
//   (a detached child gets none at all, and the stable launcher then keeps Node windowless), so a
//   hidden Windows PowerShell runs a fixed script that starts the shim through ShellExecute, which
//   gives it a new, visible console outside the service's job. The product's command reaches the
//   script in two variables, never in the script's text. Judged like a direct terminal: the
//   starter exits 0 at once, a non-zero exit means the start failed and nothing started.
import { randomBytes } from "node:crypto";
import { basename, win32 } from "node:path";
import { envVar, PRODUCT_ID } from "@ttasks/brand";
import type { TerminalApp } from "../sections.ts";

/** A terminal adapter's app: machine.toml's names without `auto`. */
export type AdapterApp = Exclude<TerminalApp, "auto">;

export type TerminalKind = "handoff" | "direct" | "shim";

/** A terminal adapter's command line, ready to spawn: argv[0] is the program. */
export interface TerminalCommand {
  readonly app: AdapterApp;
  readonly kind: TerminalKind;
  readonly argv: readonly string[];
  /**
   * Spawned outside the service's own process group, job or session: every terminal on Linux (its
   * own session, so a signal to the service's group never reaches it).
   */
  readonly detached: boolean;
  /** Variables the command needs on top of the terminal's environment (the console's starter). */
  readonly env?: Readonly<Record<string, string>>;
  /** Started without a window of its own (Windows: the console's starter, a helper). */
  readonly hidden?: boolean;
}

/** The console starter's variables: the product's program, and the rest of its command line. */
export const CONSOLE_PROGRAM = envVar("CONSOLE_PROGRAM");
export const CONSOLE_ARGUMENTS = envVar("CONSOLE_ARGUMENTS");

/**
 * The console starter (Windows PowerShell 5.1): starts the program its variable names with the
 * command line in the other, through ShellExecute (`UseShellExecute`), in its own working folder.
 * ShellExecute gives a console program a new console window, visible, and the new process is not
 * in the service's job. Fixed text: nothing variable is ever part of it. .NET calls only, no
 * cmdlet: a cmdlet makes Windows PowerShell search its module path first, which takes seconds on a
 * slow machine.
 */
export const CONSOLE_SCRIPT =
  "$ErrorActionPreference='Stop';" +
  "$s=[System.Diagnostics.ProcessStartInfo]::new();" +
  `$s.FileName=$env:${CONSOLE_PROGRAM};` +
  `$s.Arguments=$env:${CONSOLE_ARGUMENTS};` +
  "$s.UseShellExecute=$true;" +
  "[void][System.Diagnostics.Process]::Start($s)";

/** Windows PowerShell's options for the console starter: no profile, no prompt, no policy. */
const CONSOLE_FLAGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
] as const;

/**
 * One command line from argv elements by the rules every Windows C runtime and Node parse it
 * with (CommandLineToArgvW): an element with a space, a tab or a quote, or an empty one, is quoted;
 * inside quotes, a quote is escaped and the backslashes before it or before the closing quote are
 * doubled. The same rules Node's own spawn uses.
 */
export function windowsCommandLine(args: readonly string[]): string {
  return args.map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    out += ch === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${ch}`;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/** Why an adapter built no command: each is before anything started. */
export const COMMAND_REFUSALS = [
  /** An element the terminal would read as more than one (Windows Terminal's `;`). */
  "unquotable",
  /** A custom command line that asks for the folder or the title in argv. */
  "placeholder",
  /** A custom command line without exactly one whole `{shim}`, or without its program. */
  "template",
  /** This adapter does not exist on this OS. */
  "not_on_this_os",
  /** No program for this terminal was found. */
  "no_program",
] as const;
export type CommandRefusal = (typeof COMMAND_REFUSALS)[number];

export interface CommandInput {
  readonly app: AdapterApp;
  /** The terminal's program: an absolute path, or undefined when none was found. */
  readonly program: string | undefined;
  /** `<abs tasks> shim <ticket>`: the product's command, `shim` and the ticket, as elements. */
  readonly shim: readonly string[];
  readonly platform: NodeJS.Platform;
  /** Windows Terminal: a new window, or tabs in the product's named window. */
  readonly window?: "new" | "tabs";
  /** `app = "custom"`: machine.toml's `[terminal] custom`. */
  readonly custom?: readonly string[];
  /** x-terminal-emulator: the kind of the terminal its link resolves to (default handoff). */
  readonly linkKind?: TerminalKind;
}

/** The OS each adapter exists on. macOS is not built (no Mac yet). */
const ON: Readonly<Record<AdapterApp, readonly NodeJS.Platform[]>> = {
  wt: ["win32"],
  console: ["win32"],
  ghostty: ["linux"],
  "gnome-terminal": ["linux"],
  kitty: ["linux"],
  wezterm: ["linux"],
  konsole: ["linux"],
  "x-terminal-emulator": ["linux"],
  custom: ["linux", "win32"],
};

/** The kind of each built-in adapter (x-terminal-emulator and custom are decided per command). */
export const ADAPTER_KIND: Readonly<Record<AdapterApp, TerminalKind>> = {
  wt: "handoff",
  console: "shim",
  ghostty: "direct",
  "gnome-terminal": "handoff",
  kitty: "direct",
  wezterm: "direct",
  konsole: "direct",
  "x-terminal-emulator": "handoff",
  custom: "handoff",
};

/**
 * The terminals x-terminal-emulator may resolve to that run `-e`'s command in a process of their
 * own that owns the window. Every other one, and any unknown one, is a handoff (A4 3.6.2).
 */
const DIRECT_LINKS = /^(ghostty|kitty|xterm|uxterm|lxterm|koi8rxterm|alacritty|foot|st|u?rxvt.*)$/;

/** The kind of the terminal an x-terminal-emulator link resolves to, by the program's name. */
export function linkKindOf(target: string): TerminalKind {
  const name = basename(target).replace(/\.(wrapper|real)$/, "");
  return DIRECT_LINKS.test(name) ? "direct" : "handoff";
}

type Built = TerminalCommand | { readonly refused: CommandRefusal };

/** A4 3.6.2's command line for one terminal, or why there is none. */
export function terminalCommand(input: CommandInput): Built {
  const { app, program, shim, platform } = input;
  if (!ON[app].includes(platform)) return { refused: "not_on_this_os" };
  const detached = platform !== "win32";
  const made = (kind: TerminalKind, argv: readonly string[], own = detached): Built => ({
    app,
    kind,
    argv,
    detached: own,
  });
  if (app === "custom") return customCommand(input);
  if (program === undefined || program === "") return { refused: "no_program" };
  if (app === "console") {
    // `program` is Windows PowerShell; the product's command travels in the starter's variables.
    const [product, ...rest] = shim;
    if (product === undefined || !isAbsoluteOn(product, platform)) return { refused: "template" };
    return {
      app,
      kind: "shim",
      argv: [program, ...CONSOLE_FLAGS, CONSOLE_SCRIPT],
      detached: false,
      env: { [CONSOLE_PROGRAM]: product, [CONSOLE_ARGUMENTS]: windowsCommandLine(rest) },
      hidden: true,
    };
  }
  switch (app) {
    case "wt": {
      // wt re-splits its own command line on `;`, inside arguments too.
      if (shim.some((element) => element.includes(";") || element.includes('"'))) {
        return { refused: "unquotable" };
      }
      const window = input.window === "tabs" ? PRODUCT_ID : "new";
      return made("handoff", [program, "-w", window, "new-tab", "--", ...shim], false);
    }
    case "ghostty":
      // `-e` comes last and forces a new Ghostty process (A4 3.6.2).
      return made("direct", [program, "-e", ...shim]);
    case "gnome-terminal":
      return made("handoff", [program, "--", ...shim]);
    case "kitty":
      return made("direct", [program, ...shim]);
    case "wezterm":
      return made("direct", [program, "start", "--always-new-process", "--", ...shim]);
    case "konsole":
      return made("direct", [program, "--separate", "-e", ...shim]);
    case "x-terminal-emulator":
      return made(input.linkKind ?? "handoff", [program, "-e", ...shim]);
  }
}

/**
 * `[terminal] custom`: `{terminal}` is the configured program (a whole element), `{shim}` the
 * product's command (a whole element, exactly once), and every other element is the person's own
 * fixed text. `{cwd}` and `{title}` are refused: the folder and the title never go into argv.
 * Its kind is unknown, so it is a handoff: never a second window for one launch.
 */
function customCommand(input: CommandInput): Built {
  const template = input.custom;
  if (template === undefined) return { refused: "template" };
  if (template.some((el) => el.includes("{cwd}") || el.includes("{title}"))) {
    return { refused: "placeholder" };
  }
  if (template.filter((el) => el === "{shim}").length !== 1) return { refused: "template" };
  if (template.some((el) => el.includes("{shim}") && el !== "{shim}"))
    return { refused: "template" };
  if (template.some((el) => el.includes("{terminal}") && el !== "{terminal}")) {
    return { refused: "template" };
  }
  const argv: string[] = [];
  for (const element of template) {
    if (element === "{shim}") argv.push(...input.shim);
    else if (element === "{terminal}") {
      if (input.program === undefined || input.program === "") return { refused: "no_program" };
      argv.push(input.program);
    } else argv.push(element);
  }
  const first = argv[0];
  if (first === undefined || !isAbsoluteOn(first, input.platform)) return { refused: "template" };
  return { app: "custom", kind: "handoff", argv, detached: input.platform !== "win32" };
}

const isAbsoluteOn = (path: string, platform: NodeJS.Platform): boolean =>
  platform === "win32"
    ? win32.isAbsolute(path) && /^([A-Za-z]:\\|\\\\)/.test(path)
    : path.startsWith("/");

// ---------------------------------------------------------------------------------------------
// Process scopes (A4 3.7)

/** The systemd slice launched terminals go into (A4 3.7). */
export const SCOPE_SLICE = "app.slice";

/**
 * A terminal's scope unit: `<product>-<install>-launch-<launch ID>-<attempt>`. The launch ID, not
 * the reference, which is unique within one space only; the attempt, because a fallback terminal
 * of the same launch must not meet the first one's unit while systemd still collects it.
 */
export function scopeUnit(install: string, launch: string, attempt: number): string {
  return `${PRODUCT_ID}-${install}-launch-${launch}-${String(attempt)}`;
}

/** An OS opener's scope unit: `<product>-<install>-open-<random>`, one per opener started. */
export const openerUnit = (install: string): string =>
  `${PRODUCT_ID}-${install}-open-${randomBytes(8).toString("hex")}`;

/** A unit name systemd accepts and this module makes: nothing a person typed reaches it. */
export const SCOPE_UNIT =
  /^[a-z0-9]+-[0-9a-z]{1,32}-(?:launch-la_[0-9a-z]{26}-[0-9]{1,3}|open-[0-9a-f]{16})$/;

/**
 * Linux: the terminal's argv inside a transient scope of the user manager, outside the service's
 * unit, so a restart or stop of the service never ends it (A4 3.7). `--scope` runs the command as
 * the caller's child and passes its exit status through, so the acceptance rule still applies.
 * No `--setenv`: a value would show in argv and in the unit's properties.
 */
export function scopeCommand(
  systemdRun: string,
  unit: string,
  argv: readonly string[],
): readonly string[] {
  if (!SCOPE_UNIT.test(unit)) throw new Error("Not a scope unit name");
  return [
    systemdRun,
    "--user",
    "--scope",
    "--collect",
    `--slice=${SCOPE_SLICE}`,
    `--unit=${unit}`,
    "--",
    ...argv,
  ];
}

/** The probe doctor and the first launch after a start run (A4 3.6.2): a scope around `true`. */
export function scopeProbe(systemdRun: string, trueProgram: string): readonly string[] {
  return [systemdRun, "--user", "--scope", "--collect", "--quiet", "--", trueProgram];
}
