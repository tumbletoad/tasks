// A test's forwarder that names the protocol after this build's: "a bridge newer than the
// service". The real Node bridge, with the protocol it names raised by
// one; its arguments are `ttasks mcp`'s.
// First, as in the product's entries: this script ends through process.exit.
import "../../packages/bridge/src/safe-exit.ts";
import { runMcp } from "../../packages/bridge/src/mcp/run.ts";
import { PROTOCOL } from "../../packages/bridge/src/protocol/index.ts";

process.exit(await runMcp(process.argv.slice(2), { protocol: PROTOCOL + 1 }));
