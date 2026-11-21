// The end-to-end tests' `ttasks serve`: the real runServe() in a child process, as
// packages/service/test/serve-entry.ts runs it, with the page's built folder (E2E_UI), a
// terminal that records the command line it is given and runs that shim (E2E_TERMINAL, the file it
// records into), and a file manager that records the folders it is asked to show (E2E_FOLDERS). The page opens through the service's own `launch.open` and launch machines, as
// `ttasks serve` does. The listener takes a port the OS assigns, and machine.toml's port is never
// written. Tests only.
//
// A line `stop` on stdin stops it gracefully, on every OS.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "../../packages/bridge/src/safe-exit.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { packageIdentity } from "../../packages/service/src/hub/identity.ts";
import { runServe } from "../../packages/service/src/hub/serve.ts";
import { twoTerminalsHost } from "../../packages/service/test/harness.ts";
import { fakeTerminal } from "./fake-terminal.ts";

const ui = process.env["E2E_UI"];
const record = process.env["E2E_TERMINAL"];
const folders = process.env["E2E_FOLDERS"];
if (ui === undefined || record === undefined || folders === undefined) {
  process.stderr.write("E2E_UI, E2E_TERMINAL and E2E_FOLDERS must be set\n");
  process.exit(64);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "stop") process.emit("SIGTERM", "SIGTERM");
});

// The agent apps the page finds: a scratch home and the fake agents' environment (first-run.ts),
// else an empty home with nothing on its PATH, so no test ever looks at a real agent app.
const tasksHome = process.env["TTASKS_HOME"];
if (tasksHome === undefined) {
  process.stderr.write("TTASKS_HOME must be set\n");
  process.exit(64);
}
const agentHome = process.env["E2E_AGENT_HOME"] ?? join(tasksHome, "agent-home");
mkdirSync(agentHome, { recursive: true });
const agentEnv = process.env["E2E_AGENT_ENV"];

const code = await runServe({
  identity: () => ({ root: false, elevated: false, package: packageIdentity(process.env) }),
  http: { ports: [0], persist: false, ui },
  // Settings lists the terminals detection finds: the same two on every OS the tests run on.
  launch: {
    terminal: fakeTerminal(record),
    terminals: { host: twoTerminalsHost },
    // The file manager records the folder it is asked to show, one per line, and opens no window.
    showFolder: (folder) => {
      appendFileSync(folders, `${folder}\n`);
      return Promise.resolve("opened");
    },
  },
  agentApps: {
    home: agentHome,
    env: agentEnv === undefined ? { PATH: "" } : (JSON.parse(agentEnv) as Record<string, string>),
  },
});
process.exit(code);
