// `ttasks setup agents print --app <name>` (A3 3.13.1, 3.13.7) and the `approve-tools` part: what
// a person adds by hand, and where. Nothing here reads a home or writes anything: a snippet is the
// entry this machine would run, and the file it belongs in.
//
// The apps setup manages (Claude Code, Codex, Claude Desktop) print their entry for a managed target
// that setup leaves to its source (A3 3.12: `delegated`). The others (Cursor, Gemini CLI, OpenCode,
// Zed, VS Code with Copilot) get their own format: each becomes a managed integration when a person
// asks for it (A3 3.13.7).
//
// A printed entry is a hand-made one: no `--instance`. Setup keeps no agent-home row for a file it
// does not write, and the grant gate refuses an instance without a live row, so an entry that named
// one would fail at every call. A hand-made entry may use the machine's default space only, and it
// names that space by ID: an agent app restarted after the default moved is refused and told what
// to change, rather than working in the new default, where the same task reference can name
// another task.
//
// `approve-tools` (A3 3.13.2, 3.13.4) would approve TTasks's tools in the app's settings. Setup never
// changes another app's approval settings (A3 3.13.1), so the part is only ever shown as a change
// to make by hand: it writes nothing.
//
// Every app gets its entry and the file it goes in, never a command: a pasted command runs in
// whatever shell and account it is pasted into, which can select another home than the one named.
import { posix, win32 } from "node:path";
import { CLI_NAME, envVar, MCP_SERVER_KEY } from "@ttasks/brand";
import { envValue, type Env } from "@ttasks/launch";
import { keyText, valueText } from "../config/edit.ts";
import { CODEX_STARTUP_TIMEOUT_SEC } from "./agents.ts";
import { claudeDesktopFolders, DESKTOP_FILE } from "./hosts.ts";

/** The apps `print` knows: setup's own, then the ones it only prints for (A3 3.13.7). */
export const PRINT_APPS = [
  "claude-code",
  "codex",
  "claude-desktop",
  "cursor",
  "gemini",
  "opencode",
  "zed",
  "vscode",
] as const;
export type PrintApp = (typeof PRINT_APPS)[number];

export const isPrintApp = (value: unknown): value is PrintApp =>
  (PRINT_APPS as readonly unknown[]).includes(value);

export const PRINT_LABELS: Readonly<Record<PrintApp, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  zed: "Zed",
  vscode: "VS Code (Copilot)",
};

export interface PrintInput {
  readonly platform: NodeJS.Platform;
  readonly userHome: string;
  readonly env: Env;
  /** TTasks's stable command (A2 3.12). */
  readonly tasks: string;
}

export interface Snippet {
  readonly app: PrintApp;
  /** Where the snippet goes: one file, or the candidates when the app has several. */
  readonly files: readonly string[];
  readonly format: "json" | "toml";
  readonly text: string;
}

/** The apps whose home a person selects for print (`--home`): their file is in that folder. */
export const PRINT_HOMES = ["claude-code", "codex"] as const;

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** The folder for per-user configuration on Linux and macOS (`XDG_CONFIG_HOME`, else `~/.config`). */
function xdgConfig(input: PrintInput): string {
  const p = pathOf(input.platform);
  const set = envValue(input.env, "XDG_CONFIG_HOME", input.platform);
  return set !== undefined && p.isAbsolute(set) ? set : p.join(input.userHome, ".config");
}

/** Windows: the roaming folder where other apps keep their settings (only printed, never written). */
const appData = (input: PrintInput): string => {
  const p = pathOf(input.platform);
  // eslint-disable-next-line no-restricted-syntax -- where other apps keep their settings, printed for the person
  const set = envValue(input.env, "APPDATA", input.platform);
  if (set !== undefined && p.isAbsolute(set)) return set;
  // eslint-disable-next-line no-restricted-syntax -- the same folder's default, printed for the person
  return p.join(input.userHome, "AppData", "Roaming");
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The snippet a person adds by hand for `app` in `space` (an `sp_` ID), with its file. `home` is
 * the Claude Code or Codex home it is for, a folder a variable selects: without it, the app's
 * default home (Claude Code's `~/.claude.json`, Codex's `~/.codex`).
 */
export function snippetFor(
  input: PrintInput,
  app: PrintApp,
  space: string,
  home?: string,
): Snippet {
  const p = pathOf(input.platform);
  const argv = [input.tasks, "mcp", "--space", space, "--app", app];
  const [command = "", ...args] = argv;
  const plain = { command, args };
  switch (app) {
    case "claude-code":
      return {
        app,
        files: [
          home === undefined
            ? p.join(input.userHome, ".claude.json")
            : p.join(p.resolve(home), ".claude.json"),
        ],
        format: "json",
        text: json({ mcpServers: { [MCP_SERVER_KEY]: plain } }),
      };
    case "codex":
      return {
        app,
        files: [p.join(p.resolve(home ?? p.join(input.userHome, ".codex")), "config.toml")],
        format: "toml",
        text: [
          `[mcp_servers.${keyText(MCP_SERVER_KEY)}]`,
          `command = ${valueText(command)}`,
          `args = ${valueText(args)}`,
          `env_vars = ${valueText([envVar("TICKET")])}`,
          `startup_timeout_sec = ${String(CODEX_STARTUP_TIMEOUT_SEC)}`,
          "",
        ].join("\n"),
      };
    case "claude-desktop": {
      const found = claudeDesktopFolders(input).map((dir) => p.join(dir, DESKTOP_FILE));
      return {
        app,
        files: found.length > 0 ? found : [desktopDefault(input)],
        format: "json",
        text: json({ mcpServers: { [MCP_SERVER_KEY]: plain } }),
      };
    }
    case "cursor":
      return {
        app,
        files: [p.join(input.userHome, ".cursor", "mcp.json")],
        format: "json",
        text: json({ mcpServers: { [MCP_SERVER_KEY]: plain } }),
      };
    case "gemini":
      return {
        app,
        files: [p.join(input.userHome, ".gemini", "settings.json")],
        format: "json",
        text: json({ mcpServers: { [MCP_SERVER_KEY]: plain } }),
      };
    case "opencode":
      return {
        app,
        files: [
          p.join(
            input.platform === "win32" ? p.join(input.userHome, ".config") : xdgConfig(input),
            "opencode",
            "opencode.json",
          ),
        ],
        format: "json",
        text: json({ mcp: { [MCP_SERVER_KEY]: { type: "local", command: argv, enabled: true } } }),
      };
    case "zed":
      return {
        app,
        files: [
          input.platform === "win32"
            ? p.join(appData(input), "Zed", "settings.json")
            : p.join(xdgConfig(input), "zed", "settings.json"),
        ],
        format: "json",
        text: json({
          context_servers: { [MCP_SERVER_KEY]: { source: "custom", ...plain, env: {} } },
        }),
      };
    case "vscode":
      return {
        app,
        files: [
          input.platform === "win32"
            ? p.join(appData(input), "Code", "User", "mcp.json")
            : input.platform === "darwin"
              ? p.join(input.userHome, "Library", "Application Support", "Code", "User", "mcp.json")
              : p.join(xdgConfig(input), "Code", "User", "mcp.json"),
        ],
        format: "json",
        text: json({ servers: { [MCP_SERVER_KEY]: { type: "stdio", ...plain } } }),
      };
    default: {
      const never: never = app;
      return never;
    }
  }
}

/** Claude Desktop's documented folder when none is there yet (A3 3.13.3). */
function desktopDefault(input: PrintInput): string {
  const p = pathOf(input.platform);
  if (input.platform === "win32") return p.join(appData(input), "Claude", DESKTOP_FILE);
  if (input.platform === "darwin") {
    return p.join(input.userHome, "Library", "Application Support", "Claude", DESKTOP_FILE);
  }
  return p.join(xdgConfig(input), "Claude", DESKTOP_FILE);
}

/** The approve-tools change for a home's app, to make by hand, or undefined where it has none. */
export function approveToolsHint(
  app: "claude-code" | "codex" | "claude-desktop",
  home: string,
  platform: NodeJS.Platform,
): { readonly file: string; readonly text: string } | undefined {
  const p = pathOf(platform);
  if (app === "claude-code") {
    return {
      file: p.join(home, "settings.json"),
      text: `add "mcp__${MCP_SERVER_KEY}__*" to permissions.allow`,
    };
  }
  if (app === "codex") {
    return {
      file: p.join(home, "config.toml"),
      text: `add default_tools_approval_mode = "approve" under [mcp_servers.${keyText(MCP_SERVER_KEY)}]; ${CLI_NAME} setup agents --remove then turns its tools off and leaves that entry for you to take out`,
    };
  }
  return undefined;
}
