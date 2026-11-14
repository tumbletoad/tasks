// Terminal command lines, the chain and the acceptance rule of each adapter (A4 3.6.1, 3.6.2, 3.7;
// A7 3.9 M2.09; SL-09). Pure functions and a recording spawner: no terminal starts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PRODUCT_ID } from "@tasks/brand";
import {
  acceptTerminal,
  ADAPTER_KIND,
  CONSOLE_ARGUMENTS,
  CONSOLE_PROGRAM,
  CONSOLE_SCRIPT,
  DEFAULT_TERMINAL,
  linkKindOf,
  scopeCommand,
  scopeProbe,
  scopeUnit,
  terminalChain,
  terminalCommand,
  TerminalLauncher,
  windowsCommandLine,
  type AdapterApp,
  type BuiltCommand,
  type ChainEntry,
  type SpawnRequest,
  type TerminalHost,
  type TerminalSettings,
} from "../src/index.ts";

const TICKET = "0123456789ABCDEFGHJKMNPQ";
// The command in the layout's command folder (A2 3.2.1): `~/.local/bin`.
const LINUX_TASKS = `/home/mira/.local/bin/${PRODUCT_ID}`;
const WIN_TASKS = `C:\\Users\\Mira\\.local\\bin\\${PRODUCT_ID}.exe`;
const LAUNCH = "la_00r5mfcw5rfzxb9enb2vg50z3g";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const shimOf = (product: string): string[] => [product, "shim", TICKET];

describe("[A4.5.terminal.command-lines] every terminal runs the product's shim and nothing else", () => {
  test("golden argv per adapter and OS, compared as arrays: fixed flags, then <tasks> shim <ticket>", () => {
    const linux = (app: AdapterApp, program: string, linkKind?: "direct" | "handoff") =>
      terminalCommand({
        app,
        program,
        shim: shimOf(LINUX_TASKS),
        platform: "linux",
        ...(linkKind === undefined ? {} : { linkKind }),
      });
    expect(linux("ghostty", "/home/mira/.local/bin/ghostty")).toEqual({
      app: "ghostty",
      kind: "direct",
      argv: ["/home/mira/.local/bin/ghostty", "-e", LINUX_TASKS, "shim", TICKET],
      detached: true,
    });
    expect(linux("gnome-terminal", "/usr/bin/gnome-terminal")).toEqual({
      app: "gnome-terminal",
      kind: "handoff",
      argv: ["/usr/bin/gnome-terminal", "--", LINUX_TASKS, "shim", TICKET],
      detached: true,
    });
    expect(linux("kitty", "/usr/bin/kitty")).toMatchObject({
      kind: "direct",
      argv: ["/usr/bin/kitty", LINUX_TASKS, "shim", TICKET],
    });
    expect(linux("wezterm", "/usr/bin/wezterm")).toMatchObject({
      kind: "direct",
      argv: [
        "/usr/bin/wezterm",
        "start",
        "--always-new-process",
        "--",
        LINUX_TASKS,
        "shim",
        TICKET,
      ],
    });
    expect(linux("konsole", "/usr/bin/konsole")).toMatchObject({
      kind: "direct",
      argv: ["/usr/bin/konsole", "--separate", "-e", LINUX_TASKS, "shim", TICKET],
    });
    expect(linux("x-terminal-emulator", "/usr/bin/x-terminal-emulator")).toMatchObject({
      kind: "handoff",
      argv: ["/usr/bin/x-terminal-emulator", "-e", LINUX_TASKS, "shim", TICKET],
    });
    expect(linux("x-terminal-emulator", "/usr/bin/x-terminal-emulator", "direct")).toMatchObject({
      kind: "direct",
    });

    const win = (app: AdapterApp, program: string | undefined, window?: "new" | "tabs") =>
      terminalCommand({
        app,
        program,
        shim: shimOf(WIN_TASKS),
        platform: "win32",
        ...(window === undefined ? {} : { window }),
      });
    const wt = "C:\\Users\\Mira\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    expect(win("wt", wt)).toEqual({
      app: "wt",
      kind: "handoff",
      argv: [wt, "-w", "new", "new-tab", "--", WIN_TASKS, "shim", TICKET],
      detached: false,
    });
    expect(win("wt", wt, "tabs")).toMatchObject({
      argv: [wt, "-w", PRODUCT_ID, "new-tab", "--", WIN_TASKS, "shim", TICKET],
    });
    // The console: a hidden Windows PowerShell with a fixed script starts the shim through
    // ShellExecute, which gives it a console of its own; the product's command travels in the
    // starter's two variables, never in its argv or its script.
    expect(win("console", POWERSHELL)).toEqual({
      app: "console",
      kind: "shim",
      argv: [
        POWERSHELL,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        CONSOLE_SCRIPT,
      ],
      detached: false,
      env: { [CONSOLE_PROGRAM]: WIN_TASKS, [CONSOLE_ARGUMENTS]: `shim ${TICKET}` },
      hidden: true,
    });
    expect(CONSOLE_SCRIPT).toBe(
      "$ErrorActionPreference='Stop';" +
        "$s=New-Object System.Diagnostics.ProcessStartInfo;" +
        `$s.FileName=$env:${CONSOLE_PROGRAM};` +
        `$s.Arguments=$env:${CONSOLE_ARGUMENTS};` +
        "$s.UseShellExecute=$true;" +
        "[void][System.Diagnostics.Process]::Start($s)",
    );
    expect(win("console", undefined)).toEqual({ refused: "no_program" });
    // A product run from source: Node and its entry come first, as elements.
    expect(
      terminalCommand({
        app: "gnome-terminal",
        program: "/usr/bin/gnome-terminal",
        shim: ["/opt/node/bin/node", "/src/packages/cli/src/bin.ts", "shim", TICKET],
        platform: "linux",
      }),
    ).toMatchObject({
      argv: [
        "/usr/bin/gnome-terminal",
        "--",
        "/opt/node/bin/node",
        "/src/packages/cli/src/bin.ts",
        "shim",
        TICKET,
      ],
    });
  });

  test("no title, folder or task text is ever an element: the argv is the adapter's fixed flags and the shim", () => {
    const fixed: Readonly<Record<string, readonly string[]>> = {
      ghostty: ["-e"],
      "gnome-terminal": ["--"],
      kitty: [],
      wezterm: ["start", "--always-new-process", "--"],
      konsole: ["--separate", "-e"],
      "x-terminal-emulator": ["-e"],
    };
    for (const [app, flags] of Object.entries(fixed)) {
      const built = terminalCommand({
        app: app as AdapterApp,
        program: `/usr/bin/${app}`,
        shim: shimOf(LINUX_TASKS),
        platform: "linux",
      });
      expect("argv" in built && built.argv, app).toEqual([
        `/usr/bin/${app}`,
        ...flags,
        LINUX_TASKS,
        "shim",
        TICKET,
      ]);
      expect(ADAPTER_KIND[app as AdapterApp]).toBeDefined();
    }
  });

  test("an adapter that cannot carry an element exactly refuses before anything starts", () => {
    // Windows Terminal re-splits its argv on `;`: a product path with one cannot be passed.
    const semicolon = `C:\\Users\\Mira\\fixture;test\\bin\\${PRODUCT_ID}.exe`;
    expect(
      terminalCommand({
        app: "wt",
        program: "C:\\wt.exe",
        shim: shimOf(semicolon),
        platform: "win32",
      }),
    ).toEqual({ refused: "unquotable" });
    // The console's starter takes the product's path whole, in a variable, and the rest of the
    // command line quoted as every Windows runtime parses it: nothing re-split.
    const spaced = `C:\\Users\\Mira Smit\\src\\${PRODUCT_ID}\\bin.ts`;
    expect(
      terminalCommand({
        app: "console",
        program: POWERSHELL,
        shim: ["C:\\Program Files\\nodejs\\node.exe", spaced, "shim", TICKET],
        platform: "win32",
      }),
    ).toMatchObject({
      env: {
        [CONSOLE_PROGRAM]: "C:\\Program Files\\nodejs\\node.exe",
        [CONSOLE_ARGUMENTS]: `"${spaced}" shim ${TICKET}`,
      },
    });
    expect(
      terminalCommand({
        app: "console",
        program: POWERSHELL,
        shim: shimOf(semicolon),
        platform: "win32",
      }),
    ).toMatchObject({ env: { [CONSOLE_PROGRAM]: semicolon } });
    // A product that is not an absolute path never reaches ShellExecute, which would search for it.
    expect(
      terminalCommand({
        app: "console",
        program: POWERSHELL,
        shim: shimOf(`${PRODUCT_ID}.exe`),
        platform: "win32",
      }),
    ).toEqual({ refused: "template" });
    // An adapter of another OS, or without a program.
    expect(
      terminalCommand({
        app: "ghostty",
        program: "/x",
        shim: shimOf(LINUX_TASKS),
        platform: "win32",
      }),
    ).toEqual({ refused: "not_on_this_os" });
    expect(
      terminalCommand({
        app: "wt",
        program: "C:\\wt.exe",
        shim: shimOf(WIN_TASKS),
        platform: "linux",
      }),
    ).toEqual({ refused: "not_on_this_os" });
    expect(
      terminalCommand({
        app: "ghostty",
        program: undefined,
        shim: shimOf(LINUX_TASKS),
        platform: "linux",
      }),
    ).toEqual({ refused: "no_program" });
    expect(
      terminalCommand({
        app: "ghostty",
        program: "/x",
        shim: shimOf(LINUX_TASKS),
        platform: "darwin",
      }),
    ).toEqual({ refused: "not_on_this_os" });
  });

  test("the console's command line: what every Windows runtime parses back to the very elements", () => {
    const values = [
      "plain",
      "with space",
      'a "quote"',
      "trailing backslash\\",
      "trailing backslashes \\\\",
      'backslash before quote \\"',
      "C:\\Program Files\\x\\",
      "%PATH% ^caret & amp | pipe < > !bang!",
      "non-ASCII é 漢字 🙂",
      "",
      "tab\there",
      "-leading",
    ];
    expect(windowsCommandLine(["shim", TICKET])).toBe(`shim ${TICKET}`);
    expect(windowsCommandLine(["a b", ""])).toBe('"a b" ""');
    expect(windowsCommandLine(['x\\"y'])).toBe('"x\\\\\\"y"');
    expect(windowsCommandLine(["end\\"])).toBe("end\\");
    expect(windowsCommandLine(["end \\"])).toBe('"end \\\\"');
    if (process.platform !== "win32") return;
    // A real process parses the line back: Node's own runtime, as the shim's would.
    const dir = mkdtempSync(join(tmpdir(), "tasks-cmdline-"));
    try {
      const script = join(dir, "argv.cjs");
      writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const run = spawnSync(process.execPath, [windowsCommandLine([script, ...values])], {
        argv0: `"${process.execPath}"`,
        windowsVerbatimArguments: true,
        encoding: "utf8",
      });
      expect(JSON.parse(run.stdout)).toEqual(values);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a custom command line: {terminal} and one whole {shim}; {cwd} and {title} are refused; it is a handoff", () => {
    const custom = (template: readonly string[], program: string | undefined = "/usr/bin/foot") =>
      terminalCommand({
        app: "custom",
        program,
        shim: shimOf(LINUX_TASKS),
        platform: "linux",
        custom: template,
      });
    expect(custom(["{terminal}", "--app-id=x", "{shim}"])).toEqual({
      app: "custom",
      kind: "handoff",
      argv: ["/usr/bin/foot", "--app-id=x", LINUX_TASKS, "shim", TICKET],
      detached: true,
    });
    expect(custom(["{terminal}", "--working-directory={cwd}", "-e", "{shim}"])).toEqual({
      refused: "placeholder",
    });
    expect(custom(["{terminal}", "--title={title}", "{shim}"])).toEqual({ refused: "placeholder" });
    expect(custom(["{terminal}", "-e"])).toEqual({ refused: "template" });
    expect(custom(["{terminal}", "{shim}", "{shim}"])).toEqual({ refused: "template" });
    expect(custom(["{terminal}", "-e={shim}"])).toEqual({ refused: "template" });
    expect(
      terminalCommand({
        app: "custom",
        program: undefined,
        shim: shimOf(LINUX_TASKS),
        platform: "linux",
        custom: ["{terminal}", "{shim}"],
      }),
    ).toEqual({ refused: "no_program" });
    expect(custom(["relative-term", "{shim}"])).toEqual({ refused: "template" });
  });

  test("x-terminal-emulator takes the kind of the terminal its link resolves to, handoff when unknown", () => {
    expect(linkKindOf("/usr/bin/gnome-terminal.wrapper")).toBe("handoff");
    expect(linkKindOf("/usr/bin/konsole")).toBe("handoff");
    expect(linkKindOf("/usr/bin/kitty")).toBe("direct");
    expect(linkKindOf("/usr/bin/xterm")).toBe("direct");
    expect(linkKindOf("/opt/ghostty/bin/ghostty")).toBe("direct");
    expect(linkKindOf("/usr/bin/some-new-terminal")).toBe("handoff");
  });

  test("Linux: the terminal's argv inside a transient scope of the user manager, named by install and launch", () => {
    const unit = scopeUnit("0123456789", LAUNCH, 1);
    expect(unit).toBe(`${PRODUCT_ID}-0123456789-launch-${LAUNCH}-1`);
    expect(scopeCommand("/usr/bin/systemd-run", unit, ["/usr/bin/ghostty", "-e", "x"])).toEqual([
      "/usr/bin/systemd-run",
      "--user",
      "--scope",
      "--collect",
      "--slice=app.slice",
      `--unit=${unit}`,
      "--",
      "/usr/bin/ghostty",
      "-e",
      "x",
    ]);
    expect(() => scopeCommand("/usr/bin/systemd-run", "bad unit;", [])).toThrow();
    expect(scopeProbe("/usr/bin/systemd-run", "/usr/bin/true")).toEqual([
      "/usr/bin/systemd-run",
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      "--",
      "/usr/bin/true",
    ]);
  });
});

/** A fake machine: these programs exist, these list files and links say this. */
function fakeHost(
  platform: NodeJS.Platform,
  programs: readonly string[],
  extra: Partial<Omit<TerminalHost, "executable" | "readText" | "realpath">> & {
    files?: Record<string, string>;
    links?: Record<string, string>;
  } = {},
): TerminalHost {
  return {
    platform,
    path:
      extra.path ??
      (platform === "win32" ? ["C:\\Windows\\System32"] : ["/usr/local/bin", "/usr/bin"]),
    terminalVar: extra.terminalVar,
    home: extra.home ?? (platform === "win32" ? "C:\\Users\\Mira" : "/home/mira"),
    windowsApps: extra.windowsApps,
    powershell: extra.powershell,
    executable: (path) => programs.includes(path),
    readText: (path) => extra.files?.[path],
    realpath: (path) => extra.links?.[path] ?? path,
  };
}

const settings = (over: Partial<TerminalSettings> = {}): TerminalSettings => ({
  ...DEFAULT_TERMINAL,
  ...over,
});
const apps = (chain: readonly ChainEntry[]): string[] => chain.map((e) => e.app);

describe("[A4.5.terminal.chain] which terminal, and which after it", () => {
  test("auto on Linux: the session's TERMINAL, the xdg-terminals lists, then A4's order; only installed ones", () => {
    const host = fakeHost(
      "linux",
      [
        "/usr/bin/gnome-terminal",
        "/usr/bin/kitty",
        "/home/mira/.local/bin/ghostty",
        "/usr/bin/x-terminal-emulator",
      ],
      {
        path: ["/home/mira/.local/bin", "/usr/bin"],
        links: { "/usr/bin/x-terminal-emulator": "/usr/bin/gnome-terminal.wrapper" },
      },
    );
    const chain = terminalChain(settings(), host);
    expect(apps(chain)).toEqual(["ghostty", "kitty", "gnome-terminal", "x-terminal-emulator"]);
    expect(chain[0]).toEqual({ app: "ghostty", program: "/home/mira/.local/bin/ghostty" });
    expect(chain[3]).toMatchObject({ linkKind: "handoff" });

    const withVar = fakeHost("linux", ["/usr/bin/gnome-terminal", "/usr/bin/kitty"], {
      terminalVar: "gnome-terminal",
    });
    expect(apps(terminalChain(settings(), withVar))).toEqual(["gnome-terminal", "kitty"]);

    const listed = fakeHost(
      "linux",
      ["/usr/bin/gnome-terminal", "/usr/bin/kitty", "/usr/bin/konsole"],
      {
        files: {
          "/home/mira/.config/ubuntu-xdg-terminals.list":
            "# fixture\n-kitty.desktop\n+org.kde.konsole.desktop\norg.gnome.Terminal.desktop\n",
        },
      },
    );
    expect(apps(terminalChain(settings(), listed))).toEqual(["konsole", "gnome-terminal", "kitty"]);
  });

  test("a chosen terminal with its configured fallbacks; with none configured, the other installed ones", () => {
    const host = fakeHost("linux", ["/usr/bin/gnome-terminal", "/usr/bin/kitty"]);
    expect(
      terminalChain(
        settings({ app: "ghostty", path: "/opt/ghostty/ghostty", fallbacks: ["gnome-terminal"] }),
        host,
      ),
    ).toEqual([
      { app: "ghostty", program: "/opt/ghostty/ghostty" },
      { app: "gnome-terminal", program: "/usr/bin/gnome-terminal" },
    ]);
    expect(apps(terminalChain(settings({ app: "kitty" }), host))).toEqual([
      "kitty",
      "gnome-terminal",
    ]);
    // A chosen terminal that is not installed stays first: its start then fails before anything.
    expect(terminalChain(settings({ app: "wezterm" }), host)[0]).toEqual({
      app: "wezterm",
      program: undefined,
    });
  });

  test("Windows: Windows Terminal when its app execution alias exists, the console always last", () => {
    const windowsApps = "C:\\Users\\Mira\\Local\\Microsoft\\WindowsApps";
    const alias = `${windowsApps}\\wt.exe`;
    expect(
      terminalChain(
        settings(),
        fakeHost("win32", [alias], { windowsApps, powershell: POWERSHELL }),
      ),
    ).toEqual([
      { app: "wt", program: alias },
      { app: "console", program: POWERSHELL },
    ]);
    expect(terminalChain(settings(), fakeHost("win32", [], { windowsApps }))).toEqual([
      { app: "console", program: undefined },
    ]);
    expect(
      apps(
        terminalChain(settings({ app: "console" }), fakeHost("win32", [alias], { windowsApps })),
      ),
    ).toEqual(["console", "wt"]);
  });
});

/** A recording spawner: each program behaves as the test says. */
function recorder(
  behave: Record<string, "missing" | { exit?: number | null; afterMs?: number; never?: true }>,
) {
  const requests: SpawnRequest[] = [];
  /** Programs the code under test stopped: acceptance never stops a terminal. */
  const stopped: string[] = [];
  const spawn = (request: SpawnRequest) => {
    requests.push(request);
    const program = request.argv[0] ?? "";
    const how = behave[program] ?? { never: true as const };
    if (how === "missing") {
      return Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    }
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      if (how.never === true) return;
      setTimeout(() => {
        resolve({
          code: how.exit === undefined ? 0 : how.exit,
          signal: how.exit === null ? "SIGHUP" : null,
        });
      }, how.afterMs ?? 0);
    });
    return Promise.resolve({
      pid: 4242,
      exited,
      stop: () => {
        stopped.push(program);
      },
    });
  };
  return { requests, spawn, stopped };
}

/** Ticket control over a fake record: `spent` says a claim spent the current ticket. */
function tickets(start = TICKET) {
  const state = { current: start, spent: false, revoked: [] as string[], issued: 0 };
  return {
    state,
    control: {
      current: () => state.current,
      claimed: () => state.spent,
      replace: () => {
        if (state.spent) return undefined;
        state.revoked.push(state.current);
        state.issued += 1;
        state.current = `${"N".repeat(23)}${String(state.issued)}`;
        return state.current;
      },
    },
  };
}

const build =
  (platform: NodeJS.Platform, product = LINUX_TASKS) =>
  (entry: ChainEntry, ticket: string): BuiltCommand | { refused: "no_program" } => {
    const made = terminalCommand({
      app: entry.app,
      program: entry.program,
      shim: [product, "shim", ticket],
      platform,
    });
    if ("refused" in made) return { refused: "no_program" };
    return { ...made, program: made.argv[0] ?? "" };
  };

const instant = () => Promise.resolve();

describe("[A4.5.terminal.acceptance] acceptance per adapter: Dispatched, or the next terminal only on a definite error before activation", () => {
  const chain = (...entries: [AdapterApp, string | undefined][]): ChainEntry[] =>
    entries.map(([app, program]) => ({ app, program }));

  test("a handoff client is Dispatched once spawned, whatever its exit code: one window, never a fallback", async () => {
    for (const exit of [0, 1, 255, null]) {
      const r = recorder({ "/usr/bin/gnome-terminal": { exit }, "/usr/bin/kitty": {} });
      const t = tickets();
      const result = await acceptTerminal({
        chain: chain(["gnome-terminal", "/usr/bin/gnome-terminal"], ["kitty", "/usr/bin/kitty"]),
        build: build("linux"),
        ready: () => true,
        spawn: r.spawn,
        tickets: t.control,
        cwd: "/home/mira/work/portal",
        env: {},
        sleep: instant,
      });
      expect(result.outcome).toEqual({ kind: "accepted" });
      expect(r.requests).toHaveLength(1);
      expect(t.state.revoked).toEqual([]);
      // A terminal is never stopped by the service, whatever it did.
      expect(r.stopped).toEqual([]);
    }
  });

  test("a direct terminal: running after 2 s, exited 0, or claimed is Dispatched; a non-zero exit before any claim revokes the ticket and tries the next", async () => {
    const run = async (
      ghostty: { exit?: number | null; afterMs?: number; never?: true },
      spent = false,
    ) => {
      const r = recorder({ "/usr/bin/ghostty": ghostty, "/usr/bin/gnome-terminal": { exit: 0 } });
      const t = tickets();
      t.state.spent = spent;
      const result = await acceptTerminal({
        chain: chain(
          ["ghostty", "/usr/bin/ghostty"],
          ["gnome-terminal", "/usr/bin/gnome-terminal"],
        ),
        build: build("linux"),
        ready: () => true,
        spawn: r.spawn,
        tickets: t.control,
        cwd: "/home/mira/work/portal",
        env: {},
        watchMs: 200,
      });
      return { result, r, t };
    };
    // Still running after the watch: Dispatched, nothing else tried.
    const running = await run({ never: true });
    expect(running.result.outcome.kind).toBe("accepted");
    expect(running.r.requests).toHaveLength(1);
    // Exited 0 at once: Dispatched.
    const zero = await run({ exit: 0 });
    expect(zero.result.outcome.kind).toBe("accepted");
    expect(zero.r.requests).toHaveLength(1);
    // Exited non-zero after a claim: Dispatched, the ticket stays.
    const claimed = await run({ exit: 1 }, true);
    expect(claimed.result.outcome.kind).toBe("accepted");
    expect(claimed.t.state.revoked).toEqual([]);
    expect(claimed.r.requests).toHaveLength(1);
    // Exited non-zero, or by a signal, before any claim: the ticket is revoked first, and the next
    // terminal carries a new one.
    for (const exit of [1, null]) {
      const early = await run({ exit });
      expect(early.result.outcome.kind).toBe("accepted");
      expect(early.r.requests).toHaveLength(2);
      expect(early.t.state.revoked).toEqual([TICKET]);
      expect(early.r.requests[0]?.argv.at(-1)).toBe(TICKET);
      expect(early.r.requests[1]?.argv.at(-1)).toBe(early.t.state.current);
      expect(early.t.state.current).not.toBe(TICKET);
      expect(early.result.attempts.map((a) => a.result)).toEqual(["exited_early", "dispatched"]);
    }
    // Exited non-zero after the watch ended: it ran, so Dispatched.
    const late = await run({ exit: 1, afterMs: 600 });
    expect(late.result.outcome.kind).toBe("accepted");
    expect(late.r.requests).toHaveLength(1);
  });

  test("a revoke that finds the ticket spent means a claim came: Dispatched, nothing else tried", async () => {
    const r = recorder({ "/usr/bin/ghostty": { exit: 1 }, "/usr/bin/gnome-terminal": { exit: 0 } });
    const t = tickets();
    let asked = 0;
    const result = await acceptTerminal({
      chain: chain(["ghostty", "/usr/bin/ghostty"], ["gnome-terminal", "/usr/bin/gnome-terminal"]),
      build: build("linux"),
      ready: () => true,
      spawn: r.spawn,
      // The claim spends the ticket between the check and the revoke.
      tickets: {
        ...t.control,
        claimed: () => {
          asked += 1;
          return false;
        },
        replace: () => undefined,
      },
      cwd: "/w",
      env: {},
      sleep: () => new Promise(() => undefined),
    });
    expect(asked).toBe(1);
    expect(result.outcome.kind).toBe("accepted");
    expect(result.attempts.map((a) => a.result)).toEqual(["claimed_meanwhile"]);
    expect(r.requests).toHaveLength(1);
  });

  test("a spawn error, a missing program or a refused line starts nothing, keeps the ticket and tries the next; none left is Failed refused", async () => {
    const r = recorder({ "/usr/bin/ghostty": "missing", "/usr/bin/gnome-terminal": { exit: 0 } });
    const t = tickets();
    const result = await acceptTerminal({
      chain: chain(
        ["wezterm", undefined],
        ["kitty", "/usr/bin/kitty"],
        ["ghostty", "/usr/bin/ghostty"],
        ["gnome-terminal", "/usr/bin/gnome-terminal"],
      ),
      build: build("linux"),
      ready: (program) => program !== "/usr/bin/kitty",
      spawn: r.spawn,
      tickets: t.control,
      cwd: "/w",
      env: {},
      sleep: instant,
    });
    expect(result.outcome.kind).toBe("accepted");
    expect(result.attempts.map((a) => [a.app, a.result, a.error])).toEqual([
      ["wezterm", "no_program", undefined],
      ["kitty", "no_program", undefined],
      ["ghostty", "spawn_error", "ENOENT"],
      ["gnome-terminal", "dispatched", undefined],
    ]);
    // Nothing that started carried a ticket away: the same ticket throughout.
    expect(t.state.revoked).toEqual([]);
    expect(r.requests.map((q) => q.argv.at(-1))).toEqual([TICKET, TICKET]);

    const none = await acceptTerminal({
      chain: chain(["ghostty", "/usr/bin/ghostty"]),
      build: build("linux"),
      ready: () => true,
      spawn: recorder({ "/usr/bin/ghostty": "missing" }).spawn,
      tickets: tickets().control,
      cwd: "/w",
      env: {},
    });
    expect(none.outcome).toEqual({ kind: "refused", reason: "refused" });
  });

  test(
    "the scope probe: a systemd-run that never answers is ended and counts as no scopes after 5 s, once per start, and terminals start detached",
    { timeout: 30_000 },
    async () => {
      const probes: SpawnRequest[] = [];
      const stopped: string[] = [];
      const launcher = new TerminalLauncher({
        platform: "linux",
        settings: settings({ app: "gnome-terminal" }),
        install: "0123456789",
        shimCommand: [LINUX_TASKS],
        host: () => fakeHost("linux", ["/usr/bin/gnome-terminal"]),
        systemdRun: "/usr/bin/systemd-run",
        trueProgram: "/usr/bin/true",
        spawn: (request) => {
          probes.push(request);
          // systemd-run hangs (a user manager that does not answer); a terminal exits 0.
          const program = request.argv[0] ?? "";
          const hangs = program === "/usr/bin/systemd-run";
          return Promise.resolve({
            pid: 4242,
            exited: hangs
              ? new Promise(() => undefined)
              : Promise.resolve({ code: 0, signal: null }),
            stop: () => {
              stopped.push(program);
            },
          });
        },
      });
      const t0 = performance.now();
      expect(await launcher.scopes({})).toBe(false);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(4_900);
      // The probe that did not answer was ended; nothing else ever is.
      expect(stopped).toEqual(["/usr/bin/systemd-run"]);
      const started = await launcher.start({
        launch: LAUNCH,
        folder: "/home/mira/work/portal",
        tickets: tickets().control,
        env: {},
        session: {},
      });
      expect(started.scoped).toBe(false);
      expect(started.outcome.kind).toBe("accepted");
      // One probe per start, then the terminal on its own, detached, outside any scope.
      expect(probes.map((p) => [p.argv[0], p.detached])).toEqual([
        ["/usr/bin/systemd-run", true],
        ["/usr/bin/gnome-terminal", true],
      ]);
      expect(stopped).toEqual(["/usr/bin/systemd-run"]);
    },
  );

  test("Windows: Windows Terminal is a handoff; the console's starter, hidden, carries the shim in its variables and is judged like a direct terminal", async () => {
    const wt = "C:\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const run = async (starter: { exit?: number | null; afterMs?: number; never?: true }) => {
      const r = recorder({ [wt]: "missing", [POWERSHELL]: starter });
      const t = tickets();
      const result = await acceptTerminal({
        chain: chain(["wt", wt], ["console", POWERSHELL]),
        build: build("win32", WIN_TASKS),
        ready: () => true,
        spawn: r.spawn,
        tickets: t.control,
        cwd: "C:\\work\\portal",
        env: { PATH: "C:\\Windows" },
        watchMs: 200,
      });
      return { result, r, t };
    };
    // The starter started the shim and exited 0: Dispatched, with the same ticket wt never used.
    const ok = await run({ exit: 0 });
    expect(ok.result.outcome.kind).toBe("accepted");
    expect(ok.r.requests.map((q) => [q.argv[0], q.detached, q.hidden === true, q.cwd])).toEqual([
      [wt, false, false, "C:\\work\\portal"],
      [POWERSHELL, false, true, "C:\\work\\portal"],
    ]);
    expect(ok.r.requests[0]?.argv).toEqual([
      wt,
      "-w",
      "new",
      "new-tab",
      "--",
      WIN_TASKS,
      "shim",
      TICKET,
    ]);
    expect(ok.r.requests[1]?.argv.join("\u0000")).not.toContain(TICKET);
    expect(ok.r.requests[1]?.env).toEqual({
      PATH: "C:\\Windows",
      [CONSOLE_PROGRAM]: WIN_TASKS,
      [CONSOLE_ARGUMENTS]: `shim ${TICKET}`,
    });
    // Still running after the watch: Dispatched, the claim window decides.
    expect((await run({ never: true })).result.outcome.kind).toBe("accepted");
    // A non-zero exit: the start failed and nothing started; its ticket is revoked, and with no
    // terminal left the launch is refused.
    const failed = await run({ exit: 1 });
    expect(failed.result.outcome).toEqual({ kind: "refused", reason: "refused" });
    expect(failed.t.state.revoked).toEqual([TICKET]);
    expect(failed.result.attempts.map((a) => [a.app, a.kind, a.result, a.code])).toEqual([
      ["wt", "handoff", "spawn_error", undefined],
      ["console", "shim", "exited_early", 1],
    ]);
  });
});
