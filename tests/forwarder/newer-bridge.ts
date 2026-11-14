// A test's forwarder that names the protocol after this build's: "a bridge newer than the
// service" (A2 3.6.6, A7 3.9 M2.02). The real Node bridge, with the protocol it names raised by
// one; its arguments are `tasks mcp`'s.
import { runMcp } from "../../packages/bridge/src/mcp/run.ts";
import { PROTOCOL } from "../../packages/bridge/src/protocol/index.ts";

process.exit(await runMcp(process.argv.slice(2), { protocol: PROTOCOL + 1 }));
