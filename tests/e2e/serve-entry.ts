// The end-to-end tests' `tasks serve`: the real runServe() in a child process, as
// packages/service/test/serve-entry.ts runs it, with the page's built folder (E2E_UI) and a
// terminal that records the command line it is given and runs that shim (E2E_TERMINAL, the file it
// records into). The page opens through the service's own `launch.open` and launch machines, as
// `tasks serve` does. The listener takes a port the OS assigns, and machine.toml's port is never
// written. Tests only.
//
// A line `stop` on stdin stops it gracefully, on every OS.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "../../packages/bridge/src/safe-exit.ts";
import { createInterface } from "node:readline";
import { packageIdentity } from "../../packages/service/src/hub/identity.ts";
import { runServe } from "../../packages/service/src/hub/serve.ts";
import { twoTerminalsHost } from "../../packages/service/test/harness.ts";
import { fakeTerminal } from "./fake-terminal.ts";

const ui = process.env["E2E_UI"];
const record = process.env["E2E_TERMINAL"];
if (ui === undefined || record === undefined) {
  process.stderr.write("E2E_UI and E2E_TERMINAL must be set\n");
  process.exit(64);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "stop") process.emit("SIGTERM", "SIGTERM");
});

const code = await runServe({
  identity: () => ({ root: false, elevated: false, package: packageIdentity(process.env) }),
  http: { ports: [0], persist: false, ui },
  // Settings lists the terminals detection finds: the same two on every OS the tests run on.
  launch: { terminal: fakeTerminal(record), terminals: { host: twoTerminalsHost } },
});
process.exit(code);
