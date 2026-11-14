// Which terminal a launch uses, and which after it (A4 3.6.1): machine.toml's `[terminal]` over what
// this machine has. Detection reads names on PATH, two small list files and a link's target; it
// starts nothing.
//
// `auto` on Linux: the session's `TERMINAL`, then the first installed entry of
// `~/.config/ubuntu-xdg-terminals.list` or `xdg-terminals.list`, then Ghostty, kitty, WezTerm,
// GNOME Terminal, Konsole, then x-terminal-emulator. On Windows: Windows Terminal when its app
// execution alias exists, else a new console.
//
// The chain: the chosen terminal, then the configured fallbacks; with none configured, the other
// installed terminals in the auto order. On Windows the console is always last: its starter,
// Windows PowerShell, is part of every Windows. Once one terminal counts as Dispatched no other is tried (accept.ts), so a
// longer chain only matters for errors before activation.
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, posix, win32 } from "node:path";
import type { TerminalSettings } from "../sections.ts";
import { linkKindOf, type AdapterApp, type TerminalKind } from "./commands.ts";

/** One terminal of the chain: the adapter and its program (absolute), when one was found. */
export interface ChainEntry {
  readonly app: AdapterApp;
  readonly program: string | undefined;
  /** x-terminal-emulator: the kind of the terminal its link resolves to. */
  readonly linkKind?: TerminalKind;
}

/** What detection reads. Tests pass a fake. */
export interface TerminalHost {
  readonly platform: NodeJS.Platform;
  /** PATH entries to search, in order: the person's own PATH first, then the service's. */
  readonly path: readonly string[];
  /** The session's TERMINAL, when it has one (A4 3.8 layer 1). */
  readonly terminalVar: string | undefined;
  /** The account's home folder (Linux: `~/.config`'s lists). */
  readonly home: string;
  /** Windows: the folder of the account's app execution aliases (`…\Microsoft\WindowsApps`). */
  readonly windowsApps: string | undefined;
  /** Windows: Windows PowerShell, which starts the console fallback (commands.ts). */
  readonly powershell?: string | undefined;
  /** A file the account may run (Windows: one that exists, an app execution alias included). */
  executable(path: string): boolean;
  /** A small text file, or undefined. */
  readText(path: string): string | undefined;
  /** A link's final target, or undefined. */
  realpath(path: string): string | undefined;
}

/** The program name each Linux adapter is found by. */
const PROGRAMS: Readonly<Partial<Record<AdapterApp, string>>> = {
  ghostty: "ghostty",
  "gnome-terminal": "gnome-terminal",
  kitty: "kitty",
  wezterm: "wezterm",
  konsole: "konsole",
  "x-terminal-emulator": "x-terminal-emulator",
};

/** Desktop entry IDs of the xdg-terminals lists, by adapter. */
const DESKTOP_IDS: Readonly<Record<string, AdapterApp>> = {
  "com.mitchellh.ghostty.desktop": "ghostty",
  "org.gnome.Terminal.desktop": "gnome-terminal",
  "gnome-terminal.desktop": "gnome-terminal",
  "kitty.desktop": "kitty",
  "org.wezfurlong.wezterm.desktop": "wezterm",
  "org.kde.konsole.desktop": "konsole",
  "konsole.desktop": "konsole",
};

const LINUX_ORDER: readonly AdapterApp[] = [
  "ghostty",
  "kitty",
  "wezterm",
  "gnome-terminal",
  "konsole",
  "x-terminal-emulator",
];

/** The adapter a program name stands for (`$TERMINAL`), or undefined. */
function appOfName(name: string): AdapterApp | undefined {
  const base = basename(name);
  for (const [app, program] of Object.entries(PROGRAMS)) {
    if (program === base) return app as AdapterApp;
  }
  return undefined;
}

/** The first executable called `name` on the host's PATH. */
function find(host: TerminalHost, name: string): string | undefined {
  const path = host.platform === "win32" ? win32 : posix;
  for (const dir of host.path) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    if (host.executable(file)) return file;
  }
  return undefined;
}

/** Windows Terminal's app execution alias, when it exists (A4 3.6.2 detection). */
export function windowsTerminalAlias(host: TerminalHost): string | undefined {
  if (host.windowsApps === undefined || !win32.isAbsolute(host.windowsApps)) return undefined;
  const alias = win32.join(host.windowsApps, "wt.exe");
  return host.executable(alias) ? alias : undefined;
}

/** The entry for an adapter, with the program a configured path names or detection found. */
function entryFor(host: TerminalHost, app: AdapterApp, configured?: string): ChainEntry {
  if (app === "console") return consoleEntry(host);
  if (app === "wt") return { app, program: configured ?? windowsTerminalAlias(host) };
  if (app === "custom") return { app, program: configured };
  const name = PROGRAMS[app];
  const program = configured ?? (name === undefined ? undefined : find(host, name));
  if (app === "x-terminal-emulator") {
    const target = program === undefined ? undefined : host.realpath(program);
    return { app, program, linkKind: target === undefined ? "handoff" : linkKindOf(target) };
  }
  return { app, program };
}

/** The xdg-terminals lists' installed entries, in order (Linux). */
function listed(host: TerminalHost): AdapterApp[] {
  const out: AdapterApp[] = [];
  for (const file of ["ubuntu-xdg-terminals.list", "xdg-terminals.list"]) {
    const text = host.readText(posix.join(host.home, ".config", file));
    if (text === undefined) continue;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("-")) continue;
      const id = line.replace(/^\+/, "").replace(/:.*$/, "");
      const app = DESKTOP_IDS[id];
      if (app !== undefined) out.push(app);
    }
  }
  return out;
}

/** The terminals `auto` would pick, best first, that are installed here. */
export function autoOrder(host: TerminalHost): ChainEntry[] {
  if (host.platform === "win32") {
    const wt = windowsTerminalAlias(host);
    return [...(wt === undefined ? [] : [{ app: "wt" as const, program: wt }]), consoleEntry(host)];
  }
  if (host.platform !== "linux") return [];
  const candidates: ChainEntry[] = [];
  const named = host.terminalVar;
  if (named !== undefined && named !== "") {
    const app = appOfName(named);
    if (app !== undefined) {
      const own = posix.isAbsolute(named) && host.executable(named) ? named : undefined;
      candidates.push(entryFor(host, app, own));
    }
  }
  for (const app of [...listed(host), ...LINUX_ORDER]) candidates.push(entryFor(host, app));
  return dedupe(candidates.filter((c) => c.program !== undefined));
}

/** The console fallback: its program is the starter, Windows PowerShell (commands.ts). */
const consoleEntry = (host: TerminalHost): ChainEntry => ({
  app: "console",
  program: host.powershell,
});

function dedupe(entries: readonly ChainEntry[]): ChainEntry[] {
  const seen = new Set<AdapterApp>();
  return entries.filter((e) => {
    if (seen.has(e.app)) return false;
    seen.add(e.app);
    return true;
  });
}

/** The chain of terminals a launch tries, in order (head of this file). */
export function terminalChain(settings: TerminalSettings, host: TerminalHost): ChainEntry[] {
  const auto = autoOrder(host);
  const chosen =
    settings.app === "auto" ? auto.slice(0, 1) : [entryFor(host, settings.app, settings.path)];
  const rest =
    settings.fallbacks.length > 0
      ? settings.fallbacks
          .filter((app): app is AdapterApp => app !== "auto")
          .map((app) => entryFor(host, app))
      : auto.filter((e) => !chosen.some((c) => c.app === e.app));
  const chain = dedupe([...chosen, ...rest]);
  if (host.platform === "win32" && !chain.some((e) => e.app === "console"))
    chain.push(consoleEntry(host));
  return chain;
}

/** The host of this machine: the file system, PATH entries and variables as given. */
export function osTerminalHost(input: {
  platform: NodeJS.Platform;
  path: readonly string[];
  terminalVar: string | undefined;
  home: string;
  windowsApps: string | undefined;
  powershell?: string | undefined;
}): TerminalHost {
  return {
    ...input,
    executable: (path) => {
      try {
        if (input.platform === "win32") {
          // An app execution alias is a reparse point that stat cannot follow: lstat finds it.
          const found = lstatSync(path);
          return found.isFile() || found.isSymbolicLink();
        }
        const found = statSync(path);
        return found.isFile() && (found.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    },
    readText: (path) => {
      try {
        if (statSync(path).size > 64 * 1024) return undefined;
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return undefined;
      }
    },
  };
}
