// Opening a URL through the OS: the link routes (`claude-cli://`), and T3's thread link.
// The same openers show a task's folder in the file manager. The URL is one argv element of a program started without a shell, never a command string, and
// never through `cmd /c start`, which mangles `&`. The only text that reaches the URL is the one
// specified for the route, each value percent-encoded once (routes/argv.ts expandUrl), so it holds
// no space or quote that a command line could re-split.
//
// Each outcome is defined, so the launch it opens for ends in a defined state:
// - `opened`: the opener took the URL. The launch is Dispatched.
// - `no_handler`: the opener said no app handles the scheme (`xdg-open` 3 or 4). Failed.
// - `no_session`: Linux without DISPLAY or WAYLAND_DISPLAY: nothing can show a window. Failed.
// - `not_started`: no opener could be started at all (each one missing). Failed.
// - `unknown`: the opener failed in a way that does not say whether anything opened, or did not
//   end in time, and is left running. The launch is Unknown ("it may have opened").
// A fallback opener is tried only when the one before it never started (its program is missing),
// so one launch never opens the URL twice.
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import type { SpawnRequest, Spawner } from "./terminals/accept.ts";

export type OpenResult = "opened" | "no_handler" | "no_session" | "not_started" | "unknown";
export const OPEN_RESULTS: readonly OpenResult[] = [
  "opened",
  "no_handler",
  "no_session",
  "not_started",
  "unknown",
];

/** Which opener answered: a word for the log, never the URL. */
export type OpenerName = "rundll32" | "explorer" | "gio" | "xdg-open" | "open" | "none";

/** How long an opener may take before its answer is unknown. */
export const OPENER_MS = 10_000;

export interface OpenerOptions {
  readonly platform: NodeJS.Platform;
  /**
   * The desktop session's environment on Linux (DISPLAY, WAYLAND_DISPLAY, the
   * bus): the opener runs in it. On Windows, the service's (SystemRoot).
   */
  readonly env: Readonly<Record<string, string>>;
  readonly spawn: Spawner;
  /** Finds a program on the session's PATH (Linux). Default: none found. */
  readonly which?: (name: string) => string | undefined;
  /** The folder the opener runs in: any that exists, never the task's. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  /**
   * The argv an opener starts with, so that it and what it opens outlive the service: on Linux a
   * transient scope of its own (TerminalLauncher.outside). Default: as it is.
   */
  readonly outside?: (argv: readonly string[]) => Promise<readonly string[]>;
}

/** A program the OS opener runs, and what its exit codes say. */
interface Candidate {
  readonly name: OpenerName;
  readonly argv: readonly string[];
  /** Exit code → outcome, for openers whose code means something. Undefined: always `opened`. */
  readonly exit?: (code: number | null) => OpenResult;
}

/** `xdg-open`'s codes: 0 opened, 3 no handler, 4 the handler failed to start. */
const xdgExit = (code: number | null): OpenResult =>
  code === 0 ? "opened" : code === 3 || code === 4 ? "no_handler" : "unknown";

/**
 * `gio open`'s: 0 opened. Any other code is unknown: gio gives the same code for "no handler" and
 * for a handler whose start it gave up waiting for, which may still open.
 */
const gioExit = (code: number | null): OpenResult => (code === 0 ? "opened" : "unknown");

/**
 * The openers of this OS, in order. `url` is what the opener gets; on Windows a folder
 * goes to rundll32 as its file URL (`folder`), which keeps a comma in its name whole, where
 * explorer.exe would split the path there.
 */
function candidates(
  url: string,
  options: OpenerOptions,
  folder?: string,
): Candidate[] | "no_session" {
  switch (options.platform) {
    case "win32": {
      const root = systemRootOf(options.env);
      if (root === undefined) return [];
      const target = folder === undefined ? url : pathToFileURL(folder, { windows: true }).href;
      // Both go through ShellExecute, which activates MSIX handlers. Neither gives a useful code.
      return [
        {
          name: "rundll32",
          argv: [
            win32.join(root, "System32", "rundll32.exe"),
            "url.dll,FileProtocolHandler",
            target,
          ],
        },
        { name: "explorer", argv: [win32.join(root, "explorer.exe"), url] },
      ];
    }
    case "linux": {
      const display = options.env["DISPLAY"] ?? "";
      const wayland = options.env["WAYLAND_DISPLAY"] ?? "";
      if (display === "" && wayland === "") return "no_session";
      const out: Candidate[] = [];
      const gio = options.which?.("gio");
      if (gio !== undefined) out.push({ name: "gio", argv: [gio, "open", url], exit: gioExit });
      const xdg = options.which?.("xdg-open");
      if (xdg !== undefined) out.push({ name: "xdg-open", argv: [xdg, url], exit: xdgExit });
      return out;
    }
    case "darwin":
      return [
        {
          name: "open",
          // A folder is revealed: opened, an application bundle or a document package would
          // start its application.
          argv: folder === undefined ? ["/usr/bin/open", url] : ["/usr/bin/open", "-R", folder],
          exit: (code) => (code === 0 ? "opened" : "unknown"),
        },
      ];
    default:
      return [];
  }
}

/** Windows' own folder, from the service's environment, as an absolute path. */
function systemRootOf(env: Readonly<Record<string, string>>): string | undefined {
  const value = Object.entries(env).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1];
  return value !== undefined && win32.isAbsolute(value) ? value : undefined;
}

/** Opens `url` with the OS's opener. Never throws. */
export function openUrl(
  url: string,
  options: OpenerOptions,
): Promise<{ readonly result: OpenResult; readonly opener: OpenerName }> {
  return run(candidates(url, options), options);
}

/**
 * Shows the absolute folder `folder` in the machine's file manager: Explorer, what the desktop
 * opens a folder with on Linux, Finder with the folder selected. The caller has checked that it is a folder. Never throws.
 */
export function openFolder(
  folder: string,
  options: OpenerOptions,
): Promise<{ readonly result: OpenResult; readonly opener: OpenerName }> {
  return run(candidates(folder, options, folder), options);
}

async function run(
  list: Candidate[] | "no_session",
  options: OpenerOptions,
): Promise<{ readonly result: OpenResult; readonly opener: OpenerName }> {
  if (list === "no_session") return { result: "no_session", opener: "none" };
  for (const candidate of list) {
    const request: SpawnRequest = {
      argv: options.outside === undefined ? candidate.argv : await options.outside(candidate.argv),
      cwd: options.cwd,
      env: { ...options.env },
      // Never tied to the service: in a session of its own on Linux and macOS, and on Windows
      // outside the kill-on-close job that ends a normal child when the service exits.
      detached: true,
      hidden: true,
    };
    let started: Awaited<ReturnType<Spawner>>;
    try {
      started = await options.spawn(request);
    } catch {
      // It never existed: nothing can have opened, so the next opener may try.
      continue;
    }
    const ended = await Promise.race([
      started.exited.then((exit) => exit.code),
      new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => {
          resolve("timeout");
        }, options.timeoutMs ?? OPENER_MS);
        timer.unref();
        void started.exited.then(() => {
          clearTimeout(timer);
        });
      }),
    ]);
    // Only the wait ends: an opener may stay in the foreground with the application it started,
    // in its process group, so stopping it could end that application.
    if (ended === "timeout") return { result: "unknown", opener: candidate.name };
    return { result: candidate.exit?.(ended) ?? "opened", opener: candidate.name };
  }
  return { result: "not_started", opener: "none" };
}
