// `lib/ttasks.mjs`, the entry of a built version folder (A2 3.12.2). The launchers run it as
// `runtime/node --report-exclude-env lib/ttasks.mjs <args>`. From source, bin.ts is the entry.
//
// 1. It turns on Node's on-disk compile cache in `<cache>/compile/` before anything else loads, so
//    later starts skip most parsing (A2 3.12.2). The build bundles this file on its own, without
//    code splitting, so it imports no chunk before the cache is on.
// 2. It routes before it loads, as bin.ts does: `ttasks mcp` hands over to the bridge, which the
//    build ships as its own `lib/bridge.mjs` of Node built-ins only (A2 3.7.1); `ttasks shim` hands
//    over to the launch shim, which the build ships as its own `lib/shim.mjs` (A4 3.6.3); every
//    other command loads the CLI, which the build ships as `lib/chunks/cli.mjs`.
// 3. It tells the CLI which version folder it runs from: its own parent, whose manifest.json
//    doctor's integrity and runtime rows check, and whose `ui/` the service serves (M2.13).
// Before all of these, safe-exit: the bridge, the shim and `ttasks serve` end through
// `process.exit`, which the pinned Node can otherwise hang in (A2 3.12.1).
import "@ttasks/bridge/safe-exit";
import module from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostFacts, resolveLayout } from "@ttasks/service/paths";
import { MCP_VERB, runBridge } from "./mcp.ts";

try {
  module.enableCompileCache(join(resolveLayout(hostFacts()).cache, "compile"));
} catch {
  // No home folder or a relative TTASKS_HOME: the command itself reports that. Nothing is cached.
}

const argv = process.argv.slice(2);
if (argv[0] === MCP_VERB) {
  // The bridge's timers keep the loop alive by design, so the process ends here.
  process.exit(await runBridge(argv.slice(1)));
}
if (argv[0] === "shim") {
  // The launch shim (A4 3.6.3): the agent's exit code is its own.
  const { runShim } = await import("./shim/run.ts");
  process.exit(await runShim(argv.slice(1)));
}
const { run } = await import("./run.ts");
const versionFolder = dirname(dirname(fileURLToPath(import.meta.url)));
process.exitCode = await run({ versionFolder, uiFolder: join(versionFolder, "ui") });
