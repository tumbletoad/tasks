// The bridge's direct script entry (A2 3.7): `node packages/bridge/src/mcp/main.ts --space <id> …`,
// which the conformance suite runs. `tasks mcp` comes in through the CLI's entry instead
// (packages/cli/src/bin.ts), which hands over to runMcp() from `@tasks/bridge/mcp` before it loads
// anything else.
import { runMcp } from "./run.ts";

process.exit(await runMcp(process.argv.slice(2)));
