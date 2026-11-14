// The `tasks` command's entry when run from source (`pnpm tasks`): it routes before it loads. A
// built version folder runs entry.ts (`lib/tasks.mjs`) instead, which routes the same way.
//
// `tasks mcp` hands over to the bridge first, with nothing of the CLI loaded and no handler of the
// CLI's installed: the bridge starts fast, owns stdout (MCP frames only) and its own signals, and
// exits with its own code (A2 3.7.1). Every other command loads the CLI (run.ts).
import { fileURLToPath } from "node:url";
import { MCP_VERB, runBridge } from "./mcp.ts";

const argv = process.argv.slice(2);

if (argv[0] === MCP_VERB) {
  // The bridge's timers keep the loop alive by design, so the process ends here.
  process.exit(await runBridge(argv.slice(1)));
}

// `tasks shim <ticket>` (A4 3.6.3), a hidden verb: the launch shim, loaded only for it, with
// nothing of the CLI before it, its own signals, and the agent's exit code as its own. The shim
// loads only its own modules, the protocol client and discovery, three leaves of @tasks/launch and
// @tasks/brand (packages/cli/test/shim-entry.test.ts); `tasks mcp` loads nothing of it.
if (argv[0] === "shim") {
  const { runShim } = await import("./shim/run.ts");
  process.exit(await runShim(argv.slice(1)));
}

const { run } = await import("./run.ts");
// From source, `tasks serve` serves the page that `pnpm build:web` built (packages/web/dist).
process.exitCode = await run({
  uiFolder: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
});
