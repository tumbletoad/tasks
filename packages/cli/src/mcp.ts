// `ttasks mcp`: the bridge, on this process's stdio. The entry (bin.ts) hands over here
// before it loads anything else of the CLI, so the bridge starts as fast as on its own and nothing
// the CLI prints can reach stdout, which carries MCP frames only. This file imports nothing: the
// bridge itself loads only its own modules and a few Node built-ins. The build
// bundles `@ttasks/bridge/mcp` as its own `lib/bridge.mjs`, shared with no chunk of the CLI.

/** The verb. bin.ts compares the first argument with it before it loads the router. */
export const MCP_VERB = "mcp";

/**
 * Runs the bridge with the arguments after `mcp`, as they are: they are the bridge's
 * (`--space`, `--instance`, `--app`), never the CLI's options. Resolves with its exit code once
 * stdout took what was queued: 0, or 2 for a usage problem. An error nothing caught ends the
 * process with 1 (the bridge's own handler).
 */
export async function runBridge(argv: readonly string[]): Promise<number> {
  const { runMcp } = await import("@ttasks/bridge/mcp");
  return runMcp(argv);
}

/**
 * Whether a command line goes to the bridge: `ttasks mcp`, unless it asks for help, which the CLI
 * prints as for every other command. The bridge itself takes no help option: setup writes its line.
 */
export function isBridge(argv: readonly string[]): boolean {
  return argv[0] === MCP_VERB && !argv.slice(1).some((arg) => arg === "--help" || arg === "-h");
}
