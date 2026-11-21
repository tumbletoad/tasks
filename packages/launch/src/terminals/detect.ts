// Which terminal a launch uses, and which after it: machine.toml's `[terminal]` over the
// operating system's default terminal. Detection reads names on PATH, a link's target, the desktop's
// small text files the service read before (readDesktopTexts) and, on Windows, the values it read
// from the registry before (windows-default.ts); it starts nothing. The choice is a pure function of
// what was found: tests pass a fake host. When `[terminal]` names the terminal and its fallbacks,
// no default is looked up.
//
// `auto`, Linux: the first of these that names an installed terminal TTasks has an adapter for.
//   1. `$TERMINAL`.
//   2. The desktop's default: on KDE Plasma its own setting (kdeglobals' TerminalService, then
//      TerminalApplication), which KDE's own apps use; then the xdg-terminals lists in the order of
//      the Default Terminal Execution Specification (xdgListFiles).
//   3. The distribution's default: `x-terminal-emulator` (Debian's alternatives).
//   4. Only then the first installed of Ghostty, kitty, WezTerm, GNOME Terminal, Konsole.
// `auto`, Windows: the person's "Default terminal application" setting. Windows Terminal, or "Let
// Windows decide" (which means Windows Terminal when it is installed): Windows Terminal through its
// app execution alias, else a console. Windows Console Host: a console. Another terminal: TTasks has
// no adapter for it, so Windows Terminal when installed, else a console, and doctor says so.
// `auto`, macOS: no adapter exists yet, so the chain is empty.
//
// The chain: the chosen terminal, then the configured fallbacks; with none configured, the other
// installed terminals in the auto order. On Windows the console is always last: its starter,
// Windows PowerShell, is part of every Windows. Once one terminal counts as Dispatched no other is
// tried (accept.ts), so a longer chain only matters for errors before activation.
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, posix, win32 } from "node:path";
import type { TerminalSettings } from "../sections.ts";
import { linkKindOf, type AdapterApp, type TerminalKind } from "./commands.ts";
import { delegationChoice, type WindowsDelegation } from "./windows-default.ts";

/**
 * Why a terminal is in the chain, in a word the receipt and doctor turn into a few.
 * Stored as launch evidence (`terminal_source`), so a value is never renamed or reused.
 */
export const TERMINAL_SOURCES = [
  /** `[terminal] app` in machine.toml. */
  "configured",
  /** After the first: a configured fallback, or another installed terminal. */
  "fallback",
  /** Linux: the session's `$TERMINAL`. */
  "terminal_var",
  /** Linux: the desktop's default (KDE's setting, the xdg-terminals lists). */
  "desktop",
  /** Linux: `x-terminal-emulator`, the distribution's default. */
  "distribution",
  /** Windows: the "Default terminal application" setting. */
  "windows",
  /** No default named a terminal TTasks can open: the first installed one. */
  "installed",
] as const;
export type TerminalSource = (typeof TERMINAL_SOURCES)[number];

/** One terminal of the chain: the adapter and its program (absolute), when one was found. */
export interface ChainEntry {
  readonly app: AdapterApp;
  readonly program: string | undefined;
  /** x-terminal-emulator: the kind of the terminal its link resolves to. */
  readonly linkKind?: TerminalKind;
  readonly source: TerminalSource;
}

/** The chain, and the operating system's default when TTasks has no adapter for it. */
export interface TerminalChoice {
  readonly chain: ChainEntry[];
  /**
   * The default the person set that TTasks cannot open, when one came before the choice: a desktop
   * entry ID or a program's name (checked: letters, digits and `._+-` only), or `other` for a
   * Windows terminal TTasks does not know.
   */
  readonly unsupported?: string;
  /**
   * The operating system's setting could not be read (Windows' registry did not answer, the
   * desktop's files not in time), so the chain is TTasks' own order.
   */
  readonly unread?: "windows" | "desktop";
}

/** The session's XDG variables (Linux), as the session layer or the service has them. */
export interface XdgVars {
  readonly configHome?: string | undefined;
  readonly configDirs?: string | undefined;
  readonly dataHome?: string | undefined;
  readonly dataDirs?: string | undefined;
  readonly currentDesktop?: string | undefined;
}

/** What detection reads. Tests pass a fake. */
export interface TerminalHost {
  readonly platform: NodeJS.Platform;
  /** PATH entries to search, in order: the person's own PATH first, then the service's. */
  readonly path: readonly string[];
  /** The session's TERMINAL, when it has one (A4 3.8 layer 1). */
  readonly terminalVar: string | undefined;
  /** Linux: the session's XDG variables, for the desktop's default. */
  readonly xdg?: XdgVars | undefined;
  /** The account's home folder (Linux: the XDG folders' defaults). */
  readonly home: string;
  /** Windows: the folder of the account's app execution aliases (`…\Microsoft\WindowsApps`). */
  readonly windowsApps: string | undefined;
  /** Windows: Windows PowerShell, which starts the console fallback (commands.ts). */
  readonly powershell?: string | undefined;
  /** Windows: the "Default terminal application" values, as read; undefined when none could be. */
  readonly delegation?: WindowsDelegation | undefined;
  /** Linux: the desktop's files could not all be read in time, so none are used. */
  readonly desktopUnread?: boolean | undefined;
  /** A file the account may run (Windows: one that exists, an app execution alias included). */
  executable(path: string): boolean;
  /** A small text file of the desktop's, as read before; undefined when there is none. */
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

/** Desktop entry IDs, by adapter: the xdg-terminals lists and KDE's TerminalService name these. */
const DESKTOP_IDS: Readonly<Record<string, AdapterApp>> = {
  "com.mitchellh.ghostty.desktop": "ghostty",
  "org.gnome.Terminal.desktop": "gnome-terminal",
  "gnome-terminal.desktop": "gnome-terminal",
  "kitty.desktop": "kitty",
  "org.wezfurlong.wezterm.desktop": "wezterm",
  "org.kde.konsole.desktop": "konsole",
  "konsole.desktop": "konsole",
};

/** The fixed order of step 4, when no default named a terminal TTasks can open. */
const LINUX_ORDER: readonly AdapterApp[] = [
  "ghostty",
  "kitty",
  "wezterm",
  "gnome-terminal",
  "konsole",
];

/** A desktop entry ID (Desktop Entry Specification): no folder, no space, ends in `.desktop`. */
const DESKTOP_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,200}\.desktop$/;
/** A name doctor may show for a default TTasks cannot open. */
const SHOWN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
/** A desktop's name in `XDG_CURRENT_DESKTOP`, lowercased: it becomes part of a file name. */
const DESKTOP_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The adapter a program name stands for (`$TERMINAL`, KDE's TerminalApplication), or undefined. */
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
function entryFor(
  host: TerminalHost,
  app: AdapterApp,
  source: TerminalSource,
  configured?: string,
): ChainEntry {
  if (app === "console") return { app, program: host.powershell, source };
  if (app === "wt") return { app, program: configured ?? windowsTerminalAlias(host), source };
  if (app === "custom") return { app, program: configured, source };
  const name = PROGRAMS[app];
  const program = configured ?? (name === undefined ? undefined : find(host, name));
  if (app === "x-terminal-emulator") {
    const target = program === undefined ? undefined : host.realpath(program);
    return {
      app,
      program,
      linkKind: target === undefined ? "handoff" : linkKindOf(target),
      source,
    };
  }
  return { app, program, source };
}

/** A colon-separated list of absolute folders (XDG Base Directory: a relative one is ignored). */
function folders(value: string | undefined, fallback: readonly string[]): string[] {
  if (value === undefined || value === "") return [...fallback];
  return value.split(":").filter((dir) => posix.isAbsolute(dir));
}

/** One absolute folder, or its default. */
const folder = (value: string | undefined, fallback: string): string =>
  value !== undefined && posix.isAbsolute(value) ? value : fallback;

/** The desktops of `XDG_CURRENT_DESKTOP`, lowercased, in order of decreasing priority. */
function desktopsOf(host: TerminalHost): string[] {
  const out: string[] = [];
  for (const raw of (host.xdg?.currentDesktop ?? "").split(":")) {
    const name = raw.trim().toLowerCase();
    if (DESKTOP_NAME.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The xdg-terminals list files in the specification's order of decreasing priority: in each of
 * `$XDG_CONFIG_HOME`, `$XDG_CONFIG_DIRS` (default `/etc/xdg`), then `xdg-terminal-exec` under each
 * of `$XDG_DATA_DIRS` (default `/usr/local/share:/usr/share`), `<desktop>-xdg-terminals.list` for
 * each desktop of `$XDG_CURRENT_DESKTOP`, then `xdg-terminals.list`.
 */
export function xdgListFiles(host: TerminalHost): string[] {
  const xdg = host.xdg ?? {};
  const dirs = [
    folder(xdg.configHome, posix.join(host.home, ".config")),
    ...folders(xdg.configDirs, ["/etc/xdg"]),
    ...folders(xdg.dataDirs, ["/usr/local/share", "/usr/share"]).map((dir) =>
      posix.join(dir, "xdg-terminal-exec"),
    ),
  ];
  const desktops = desktopsOf(host);
  return dirs.flatMap((dir) => [
    ...desktops.map((desktop) => posix.join(dir, `${desktop}-xdg-terminals.list`)),
    posix.join(dir, "xdg-terminals.list"),
  ]);
}

/**
 * The entries the lists select explicitly, in order, each once: `id.desktop` or
 * `id.desktop:action`. A `-` or `+` line only excludes or protects an entry for the
 * specification's own fallback, and a directive (`/…`) is for the tool: neither selects.
 */
export function listedIds(host: TerminalHost): string[] {
  const out: string[] = [];
  for (const file of xdgListFiles(host)) {
    const text = host.readText(file);
    if (text === undefined) continue;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || /^[#+/-]/.test(line)) continue;
      const id = line.replace(/:.*$/, "");
      if (DESKTOP_ID.test(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * Whether the desktop entry with this ID is installed and not hidden. The first one found in the
 * XDG data folders' `applications` is the one that counts: the person's own overrides the
 * system's, and `Hidden=true` in its `[Desktop Entry]` group means it is deleted.
 */
function desktopEntryShown(host: TerminalHost, id: string): boolean {
  const xdg = host.xdg ?? {};
  const dirs = [
    folder(xdg.dataHome, posix.join(host.home, ".local", "share")),
    ...folders(xdg.dataDirs, ["/usr/local/share", "/usr/share"]),
  ];
  for (const dir of dirs) {
    const text = host.readText(posix.join(dir, "applications", id));
    if (text === undefined) continue;
    let main = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) main = line === "[Desktop Entry]";
      else if (main && /^Hidden\s*=\s*true$/.test(line)) return false;
    }
    return true;
  }
  return false;
}

/**
 * KDE Plasma's own default terminal: `[General]` of the first kdeglobals in the XDG config folders
 * that sets it. `TerminalService` (a desktop entry ID) wins over `TerminalApplication` (a command
 * line), as in KDE's own launcher.
 */
function kdeDefault(host: TerminalHost): { id?: string; command?: string } | undefined {
  const xdg = host.xdg ?? {};
  const dirs = [
    folder(xdg.configHome, posix.join(host.home, ".config")),
    ...folders(xdg.configDirs, ["/etc/xdg"]),
  ];
  for (const dir of dirs) {
    const text = host.readText(posix.join(dir, "kdeglobals"));
    if (text === undefined) continue;
    let general = false;
    let service: string | undefined;
    let command: string | undefined;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) {
        general = line === "[General]";
        continue;
      }
      if (!general) continue;
      const match = /^(TerminalService|TerminalApplication)\s*=\s*(.*)$/.exec(line);
      if (match === null || match[2] === undefined || match[2] === "") continue;
      if (match[1] === "TerminalService") service = match[2];
      else command = match[2];
    }
    if (service !== undefined) return { id: service };
    if (command !== undefined) return { command };
  }
  return undefined;
}

/** A Linux candidate default: a terminal TTasks can open, or the name of one it cannot. */
type Candidate = { readonly app: AdapterApp } | { readonly unsupported: string };

/** The defaults of steps 1 to 3 on Linux, in order (head of this file). */
function linuxDefaults(host: TerminalHost): { source: TerminalSource; candidate: Candidate }[] {
  const out: { source: TerminalSource; candidate: Candidate }[] = [];
  /** A name doctor may show, or a word for one it may not. */
  const shown = (name: string): string => (SHOWN_NAME.test(name) ? name : "unnamed");
  const named = host.terminalVar?.trim();
  if (named !== undefined && named !== "") {
    const app = appOfName(named);
    out.push({
      source: "terminal_var",
      candidate: app === undefined ? { unsupported: shown(basename(named)) } : { app },
    });
  }
  if (desktopsOf(host).includes("kde")) {
    const kde = kdeDefault(host);
    if (kde?.id !== undefined) {
      // KDE accepts the ID with or without its `.desktop`.
      const id = kde.id.endsWith(".desktop") ? kde.id : `${kde.id}.desktop`;
      const app = DESKTOP_IDS[id];
      out.push({
        source: "desktop",
        candidate: app === undefined ? { unsupported: shown(id) } : { app },
      });
    } else if (kde?.command !== undefined) {
      const program = kde.command.split(/\s+/)[0] ?? "";
      const app = appOfName(program);
      out.push({
        source: "desktop",
        candidate: app === undefined ? { unsupported: shown(basename(program)) } : { app },
      });
    }
  }
  for (const id of listedIds(host)) {
    // An entry that is missing or hidden is skipped, as the specification discards it, even when
    // a program of that name exists: a stale line must not beat a terminal that is installed.
    if (!desktopEntryShown(host, id)) continue;
    const app = DESKTOP_IDS[id];
    out.push({ source: "desktop", candidate: app === undefined ? { unsupported: id } : { app } });
  }
  out.push({ source: "distribution", candidate: { app: "x-terminal-emulator" } });
  return out;
}

/** The terminals `auto` picks, best first, that are installed here, and a default it skipped. */
export function autoChoice(host: TerminalHost): TerminalChoice {
  if (host.platform === "win32") {
    const wt = windowsTerminalAlias(host);
    // Unread, the order is what "Let Windows decide" would give, but it is TTasks' choice.
    const unread = host.delegation === undefined;
    const decided = delegationChoice(host.delegation);
    const source: TerminalSource = decided === "other" || unread ? "installed" : "windows";
    const first: ChainEntry =
      decided === "console" || wt === undefined
        ? { app: "console", program: host.powershell, source }
        : { app: "wt", program: wt, source };
    const chain = [first];
    if (first.app === "console" && wt !== undefined)
      chain.push({ app: "wt", program: wt, source: "fallback" });
    if (first.app === "wt")
      chain.push({ app: "console", program: host.powershell, source: "fallback" });
    if (unread) return { chain, unread: "windows" };
    return decided === "other" ? { chain, unsupported: "other" } : { chain };
  }
  if (host.platform !== "linux") return { chain: [] };
  const found: ChainEntry[] = [];
  /** The first default TTasks cannot open, when it came before every one it can. */
  let unsupported: string | undefined;
  for (const { source, candidate } of linuxDefaults(host)) {
    if (!("app" in candidate)) {
      if (found.length === 0) unsupported ??= candidate.unsupported;
      continue;
    }
    const own =
      source === "terminal_var" &&
      host.terminalVar !== undefined &&
      posix.isAbsolute(host.terminalVar.trim()) &&
      host.executable(host.terminalVar.trim())
        ? host.terminalVar.trim()
        : undefined;
    const entry = entryFor(host, candidate.app, source, own);
    if (entry.program !== undefined) found.push(entry);
  }
  for (const app of LINUX_ORDER) {
    const entry = entryFor(host, app, "installed");
    if (entry.program !== undefined) found.push(entry);
  }
  const chain = dedupe(found).map((entry, i) =>
    i === 0 ? entry : { ...entry, source: "fallback" as const },
  );
  return {
    chain,
    ...(unsupported === undefined ? {} : { unsupported }),
    ...(host.desktopUnread === true ? { unread: "desktop" as const } : {}),
  };
}

/**
 * Whether machine.toml's custom command has its program: written in the command, or the `path`
 * that its `{terminal}` stands for.
 */
export function customReady(settings: TerminalSettings): boolean {
  if (settings.custom === undefined) return false;
  return !settings.custom.includes("{terminal}") || (settings.path ?? "") !== "";
}

/**
 * The terminals a person can choose here: each adapter whose program is found, in the order
 * `auto` tries them when no default names one, and the custom command when it has its program.
 */
export function installedTerminals(settings: TerminalSettings, host: TerminalHost): AdapterApp[] {
  const apps: AdapterApp[] =
    host.platform === "win32"
      ? ["wt", "console"]
      : host.platform === "linux"
        ? [...LINUX_ORDER, "x-terminal-emulator"]
        : [];
  const found = apps.filter((app) => entryFor(host, app, "installed").program !== undefined);
  return customReady(settings) ? [...found, "custom"] : found;
}

/** The terminals `auto` would pick, best first, that are installed here. */
export function autoOrder(host: TerminalHost): ChainEntry[] {
  return autoChoice(host).chain;
}

function dedupe(entries: readonly ChainEntry[]): ChainEntry[] {
  const seen = new Set<AdapterApp>();
  return entries.filter((e) => {
    if (seen.has(e.app)) return false;
    seen.add(e.app);
    return true;
  });
}

/** Whether the operating system's default matters: `[terminal]` leaves the terminal or its fallbacks to it. */
export function needsDefault(settings: TerminalSettings): boolean {
  return settings.app === "auto" || settings.fallbacks.length === 0;
}

/** The chain of terminals a launch tries, in order, and a default it could not use (head). */
export function terminalChoice(settings: TerminalSettings, host: TerminalHost): TerminalChoice {
  const auto: TerminalChoice = needsDefault(settings) ? autoChoice(host) : { chain: [] };
  const chosen =
    settings.app === "auto"
      ? auto.chain.slice(0, 1)
      : [entryFor(host, settings.app, "configured", settings.path)];
  const rest =
    settings.fallbacks.length > 0
      ? settings.fallbacks
          .filter((app): app is AdapterApp => app !== "auto")
          .map((app) => entryFor(host, app, "fallback"))
      : auto.chain
          .filter((e) => !chosen.some((c) => c.app === e.app))
          .map((e) => ({ ...e, source: "fallback" as const }));
  const chain = dedupe([...chosen, ...rest]);
  if (host.platform === "win32" && !chain.some((e) => e.app === "console"))
    chain.push({ app: "console", program: host.powershell, source: "fallback" });
  // A default TTasks cannot open or read matters only when `auto` decided.
  if (settings.app !== "auto") return { chain };
  return {
    chain,
    ...(auto.unsupported === undefined ? {} : { unsupported: auto.unsupported }),
    ...(auto.unread === undefined ? {} : { unread: auto.unread }),
  };
}

/** The chain of terminals a launch tries, in order (head of this file). */
export function terminalChain(settings: TerminalSettings, host: TerminalHost): ChainEntry[] {
  return terminalChoice(settings, host).chain;
}

/** The desktop's files as read before a choice: all of them, or none when time ran out. */
export interface DesktopTexts {
  readonly texts: ReadonlyMap<string, string>;
  readonly complete: boolean;
}

/** How long the desktop's files may take to read before Open goes on without them. */
export const DESKTOP_READ_MS = 1_000;

/**
 * Reads the desktop's files the choice for `settings` would look at, without blocking the
 * service: a home folder on a stalled network share must not hold up an Open. It runs the choice
 * against what was read so far, reads the files it asked for, and repeats until it asks for no new
 * one (the lists name the desktop entries to read next). When the deadline passes first, nothing
 * read is used, so the choice is TTasks' own order and says so.
 */
export async function readDesktopTexts(
  settings: TerminalSettings,
  host: TerminalHost,
  read: (path: string) => Promise<string | undefined>,
  deadlineMs: number,
): Promise<DesktopTexts> {
  const texts = new Map<string, string>();
  if (host.platform !== "linux" || !needsDefault(settings)) return { texts, complete: true };
  const seen = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => {
      resolve("late");
    }, deadlineMs);
    timer.unref();
  });
  try {
    for (;;) {
      const asked: string[] = [];
      terminalChoice(settings, {
        ...host,
        readText: (path) => {
          if (!seen.has(path)) asked.push(path);
          return texts.get(path);
        },
      });
      if (asked.length === 0) return { texts, complete: true };
      // One at a time: a stalled share then holds one of Node's file threads, not all of them.
      for (const path of asked) {
        if (seen.has(path)) continue;
        seen.add(path);
        const text = await Promise.race([read(path).catch(() => undefined), late]);
        if (text === "late") return { texts: new Map(), complete: false };
        if (text !== undefined) texts.set(path, text);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** A regular file of at most 64 KiB, as UTF-8 text; undefined for anything else. */
export async function readSmallText(path: string): Promise<string | undefined> {
  const limit = 64 * 1024;
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const found = await file.stat();
    if (!found.isFile() || found.size > limit) return undefined;
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead > limit ? undefined : buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/**
 * A reader for readDesktopTexts that shares a read still under way: when a share stalls, every
 * later Open waits on the same read instead of starting another that stalls too.
 */
export function desktopReader(
  read: (path: string) => Promise<string | undefined> = readSmallText,
): (path: string) => Promise<string | undefined> {
  const pending = new Map<string, Promise<string | undefined>>();
  return (path) => {
    let reading = pending.get(path);
    if (reading === undefined) {
      reading = read(path)
        .catch(() => undefined)
        .finally(() => pending.delete(path));
      pending.set(path, reading);
    }
    return reading;
  };
}

/** How long one look at a program or a link may take before its folder counts as stalled. */
export const PROBE_MS = 250;

/** Looks at programs and links without blocking the service. */
export interface FileProbe {
  /** A file the account may run (Windows: one that exists, an app execution alias included). */
  executable(path: string): Promise<boolean>;
  /** A link's final target, or undefined. */
  realpath(path: string): Promise<string | undefined>;
}

/** The file system's own answers for `platform`, unbounded. */
export function osProbeFiles(platform: NodeJS.Platform): FileProbe {
  return {
    executable: async (path) => {
      try {
        if (platform === "win32") {
          // An app execution alias is a reparse point that stat cannot follow: lstat finds it.
          const found = await lstat(path);
          return found.isFile() || found.isSymbolicLink();
        }
        const found = await stat(path);
        return found.isFile() && (found.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    },
    realpath: async (path) => {
      try {
        return await realpath(path);
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * A probe that answers within `ms` per look. A folder on PATH whose look did not answer in time (a
 * stalled network share) counts as empty until that look ends, so later looks there, by this Open
 * or the next, cost nothing and hold no more of Node's file threads. A look still under way is
 * shared, never started twice.
 */
export function fileProbe(
  platform: NodeJS.Platform,
  files: FileProbe = osProbeFiles(platform),
  ms: number = PROBE_MS,
): FileProbe {
  const folderOf = platform === "win32" ? win32.dirname : posix.dirname;
  const pending = new Map<string, Promise<unknown>>();
  const stalled = new Map<string, number>();
  const look = <T>(key: string, path: string, run: () => Promise<T>, none: T): Promise<T> => {
    const folder = folderOf(path);
    if ((stalled.get(folder) ?? 0) > 0) return Promise.resolve(none);
    let running = pending.get(key) as Promise<T> | undefined;
    if (running === undefined) {
      const started = run()
        .catch(() => none)
        .finally(() => pending.delete(key));
      running = started;
      pending.set(key, started);
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        stalled.set(folder, (stalled.get(folder) ?? 0) + 1);
      }, ms);
      timer.unref();
      void started.finally(() => {
        clearTimeout(timer);
        if (!late) return;
        const left = (stalled.get(folder) ?? 1) - 1;
        if (left > 0) stalled.set(folder, left);
        else stalled.delete(folder);
      });
    }
    const answer = running;
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        resolve(none);
      }, ms);
      timer.unref();
      void answer.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };
  return {
    executable: (path) => look(`x\n${path}`, path, () => files.executable(path), false),
    realpath: (path) =>
      look<string | undefined>(`r\n${path}`, path, () => files.realpath(path), undefined),
  };
}

/** What a choice found out about programs and links, read before it through a probe. */
export interface ProgramFacts {
  readonly executable: ReadonlyMap<string, boolean>;
  readonly realpath: ReadonlyMap<string, string | undefined>;
}

/**
 * Looks at every program and link the choice for `settings` asks about, through `probe`, without
 * blocking the service: a stalled folder on PATH must not hold up an Open, or anything else the
 * service does meanwhile. It runs the choice against what was found so far, looks at the first thing
 * it asked for and did not know, and repeats until it asks for nothing new: the same looks, in the
 * same order, as a choice that waited for each answer. With `offered`, then also the terminals a
 * person can choose, which an Open does not need.
 */
export async function readProgramFacts(
  settings: TerminalSettings,
  host: TerminalHost,
  probe: FileProbe,
  { offered = false }: { offered?: boolean } = {},
): Promise<ProgramFacts> {
  const executable = new Map<string, boolean>();
  const real = new Map<string, string | undefined>();
  for (;;) {
    const ask: { next?: { path: string; kind: "x" | "r" } } = {};
    const asking: TerminalHost = {
      ...host,
      executable: (path) => {
        if (!executable.has(path)) ask.next ??= { path, kind: "x" };
        return executable.get(path) ?? false;
      },
      realpath: (path) => {
        if (!real.has(path)) ask.next ??= { path, kind: "r" };
        return real.get(path);
      },
    };
    terminalChoice(settings, asking);
    if (offered && ask.next === undefined) installedTerminals(settings, asking);
    const next = ask.next;
    if (next === undefined) return { executable, realpath: real };
    // Only the first unknown: what the choice asks after it depends on its answer, so a folder
    // later on PATH is looked at only when the earlier ones do not have the program.
    if (next.kind === "x") executable.set(next.path, await probe.executable(next.path));
    else real.set(next.path, await probe.realpath(next.path));
  }
}

/**
 * The host of this machine: PATH entries and variables as given, and the desktop's files, programs
 * and links only as `desktop` and `programs` hold them: it reads nothing itself.
 */
export function osTerminalHost(input: {
  platform: NodeJS.Platform;
  path: readonly string[];
  terminalVar: string | undefined;
  xdg?: XdgVars | undefined;
  home: string;
  windowsApps: string | undefined;
  powershell?: string | undefined;
  delegation?: WindowsDelegation | undefined;
  desktop?: DesktopTexts | undefined;
  programs?: ProgramFacts | undefined;
}): TerminalHost {
  const { desktop, programs, ...rest } = input;
  return {
    ...rest,
    desktopUnread: desktop?.complete === false,
    readText: (path) => desktop?.texts.get(path),
    executable: (path) => programs?.executable.get(path) ?? false,
    realpath: (path) => programs?.realpath.get(path),
  };
}
