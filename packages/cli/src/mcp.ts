// `ttasks mcp` (A2 3.7): the bridge, on this process's stdio. The entry (bin.ts) hands over here
// before it loads anything else of the CLI, so the bridge starts as fast as on its own and nothing
// the CLI prints can reach stdout, which carries MCP frames only. This file imports nothing: the
// bridge itself loads only its own modules and the built-ins A2 3.7.1 allows. The build (M1.13)
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
