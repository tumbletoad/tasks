// `tasks setup` (A2 3.10, A3 3.13, A4 3.4.1): connecting this machine's agent apps. M2.11 brought
// `tasks setup t3`, the pairing with T3 Code; M2.14 `tasks setup agents` (setup-agents.ts, loaded
// only for that command), Tasks's MCP server entry in each Claude Code and Codex home.
//
//   tasks setup agents [--preview|--apply --plan <token>|--remove|--status]   the agent homes' MCP entries
//   tasks setup t3 [--no-browser]   pair with T3 Code: approve on T3's page in the browser
//   tasks setup t3 --status         whether T3 can be used: paired, running, Reconnect T3
//
// The service runs the pairing (hub/t3.ts) and keeps the token in its machine state; the CLI only
// hands T3's approval page to the person's browser, because the CLI runs in their desktop session
// and the service may not (a user unit started at boot). The page is opened with the OS's own
// opener (A4 3.6.5's primary per OS), the URL as one argument and no shell, and is printed too, so
// it can be opened by hand (over SSH, or when no browser starts). The page's URL holds the
// attempt's state and PKCE challenge, never a secret: the verifier and the token stay in the
// service. Only the user pairs, from an interactive terminal; the status works everywhere.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { CLI_NAME } from "@tasks/brand";
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage } from "./output.ts";
import type { AgentsSetupOptions } from "./setup-agents.ts";
import { asAppError } from "./verbs.ts";

/** `tasks setup --help` and `tasks help setup`. */
export const SETUP_HELP = `Usage: ${CLI_NAME} setup <app> [options] [--json]

  agents [--preview]  What registering ${CLI_NAME} in each Claude Code and Codex home would change:
                      the exact command and diff per home, and the apply command. Writes nothing
  agents --apply --plan <token>
                      Carry out that preview: register ${CLI_NAME}'s MCP server in each home that
                      has no entry yet, or change nothing when the homes changed since
  agents --remove     Take out every entry setup wrote that is still exactly as it wrote it
  agents --status     Each home: registered or not, and its grant row
    [--app claude-code,codex] [--instance <id>] [--space <id or name>]
  t3 [--no-browser]   Pair with T3 Code: approve ${CLI_NAME} on T3's page in your browser
  t3 --status         Whether T3 Code can be used: paired, running, or Reconnect T3

Setup changes only ${CLI_NAME}'s own entry, never trust, approval or other servers' settings.
--apply, --remove and pairing run only from an interactive terminal. --no-browser prints the page
to open instead of opening it. Pairing again replaces the earlier pairing: a T3 launch still
waiting on the earlier one is then shown as unknown, never repeated.
`;

/** How long the CLI waits beyond the attempt's own deadline for the service's answer. */
const WAIT_MARGIN_MS = 30_000;

export interface SetupOptions extends ConnectOptions {
  /** Opens an http(s) URL in the person's browser. The default is the OS's opener (A4 3.6.5). */
  readonly openUrl?: (url: string, io: Io) => Promise<boolean>;
  /** Tests only: the agent environment and home `tasks setup agents` works in. */
  readonly agents?: AgentsSetupOptions;
}

/**
 * Opens `url` with the OS's opener, detached, the URL as one argument, no shell: Windows
 * `rundll32.exe url.dll,FileProtocolHandler`, Linux `xdg-open`, macOS `open`. True when it started.
 */
export function openInBrowser(url: string, io: Io): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return Promise.resolve(false);
  const root = io.env["SystemRoot"] ?? "C:\\Windows";
  const [file, ...args] =
    io.platform === "win32"
      ? [join(root, "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", parsed.href]
      : io.platform === "darwin"
        ? ["open", parsed.href]
        : ["xdg-open", parsed.href];
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => {
        resolve(false);
      });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function setupCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  options: SetupOptions,
): Promise<number> {
  const [app, ...rest] = args;
  if (app === "agents") {
    return await (await import("./setup-agents.ts")).agentsCommand(io, globals, rest, options);
  }
  let session: Session | undefined;
  const call = async (
    method: string,
    params: Record<string, unknown>,
    timeoutMs = globals.timeoutS * 1000,
  ): Promise<Record<string, unknown>> => {
    session ??= await connectService(io, options);
    return (await session.call(method, params, { timeoutMs })) as Record<string, unknown>;
  };
  // Text for people: stdout, or stderr when stdout carries the JSON result.
  const say = (text: string) => {
    if (globals.json) io.stderr(text);
    else io.stdout(text);
  };
  try {
    if (app !== "t3") throw new UsageError(`${CLI_NAME} setup has agents and t3`);
    let status = false;
    let browser = true;
    for (const token of rest) {
      if (token === "--status") status = true;
      else if (token === "--no-browser") browser = false;
      else {
        throw new UsageError(
          `${CLI_NAME} setup t3 has no option ${/^--[a-z-]{1,30}$/.test(token) ? token : "like that"}`,
        );
      }
    }
    if (status) {
      const result = await call("t3/status", {});
      if (globals.json) io.stdout(`${JSON.stringify(result)}\n`);
      else io.stdout(`${String(result["message"])}\n`);
      return 0;
    }
    const started = await call("t3/pair", {});
    const url = String(started["url"]);
    const until = Date.parse(String(started["expires_at"]));
    say(`Approve ${CLI_NAME} in T3 Code on this page:\n  ${url}\n`);
    const opened = browser && (await (options.openUrl ?? openInBrowser)(url, io));
    say(
      opened
        ? "Opened it in your browser. Waiting for your approval…\n"
        : "Open it in your browser. Waiting for your approval…\n",
    );
    const waitMs = Number.isFinite(until)
      ? Math.max(until - Date.now(), 0) + WAIT_MARGIN_MS
      : globals.timeoutS * 1000;
    const result = await call("t3/pair_wait", { attempt: started["attempt"] }, waitMs);
    if (globals.json) io.stdout(`${JSON.stringify(result)}\n`);
    else {
      io.stdout("Paired with T3 Code.\n");
      if (result["replaced"] === true) {
        io.stdout(
          "This replaced the earlier pairing. A T3 launch still waiting on it shows as unknown.\n",
        );
      }
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(error)));
  } finally {
    session?.close();
  }
}
