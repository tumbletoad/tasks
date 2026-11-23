// The `ttasks` command's entry when run from source (`pnpm ttasks`): it routes before it loads. A
// built version folder runs entry.ts (`lib/ttasks.mjs`) instead, which routes the same way.
//
// `ttasks mcp` hands over to the bridge first, with nothing of the CLI loaded and no handler of the
// CLI's installed: the bridge starts fast, owns stdout (MCP frames only) and its own signals, and
// exits with its own code (A2 3.7.1). Every other command loads the CLI (run.ts).
//
// safe-exit comes before every other module: the bridge, the shim and `ttasks serve` end through
// `process.exit`, which the pinned Node can otherwise hang in (A2 3.12.1).
import "@ttasks/bridge/safe-exit";
import { fileURLToPath } from "node:url";
import { isBridge, runBridge } from "./mcp.ts";

const argv = process.argv.slice(2);

if (isBridge(argv)) {
  // The bridge's timers keep the loop alive by design, so the process ends here.
  process.exit(await runBridge(argv.slice(1)));
}

// `ttasks shim <ticket>` (A4 3.6.3), a hidden verb: the launch shim, loaded only for it, with
// nothing of the CLI before it, its own signals, and the agent's exit code as its own. The shim
// loads only its own modules, the protocol client and discovery, three leaves of @ttasks/launch and
// @ttasks/brand (packages/cli/test/shim-entry.test.ts); `ttasks mcp` loads nothing of it.
if (argv[0] === "shim") {
  const { runShim } = await import("./shim/run.ts");
  process.exit(await runShim(argv.slice(1)));
}

const { run } = await import("./run.ts");
// From source, `ttasks serve` serves the page that `pnpm build:web` built (packages/web/dist).
process.exitCode = await run({
  uiFolder: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
});
