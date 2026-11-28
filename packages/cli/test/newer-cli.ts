// A test's ttasks command that names the protocol after this build's: "a CLI newer than the running
// service". The real CLI, with the protocol it names raised by one.
import { PROTOCOL } from "@ttasks/bridge/protocol";
import { main } from "../src/main.ts";
import { processIo } from "../src/process-io.ts";

process.exitCode = await main(processIo(), { protocol: PROTOCOL + 1 });
