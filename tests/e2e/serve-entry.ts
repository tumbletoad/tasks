// The end-to-end tests' `ttasks serve`: the real runServe() in a child process, as
// packages/service/test/serve-entry.ts runs it, with the page's built folder (E2E_UI), a
// terminal that records the command line it is given and runs that shim (E2E_TERMINAL, the file it
// records into), a file manager that records the folders it is asked to show (E2E_FOLDERS), and,
// with E2E_MONITOR, the test kit's fake `ttam` steered by that file: `none` is no TTAM at all,
// another word is the fake's mode (packages/testkit/src/fakes/ttam.ts). Without it, as in every
// test, there is no TTAM. The page opens through the service's own `launch.open` and launch
// machines, as `ttasks serve` does. The listener takes a port the OS assigns, and machine.toml's
// port is never written. Tests only.
//
// A line `stop` on stdin stops it gracefully, on every OS.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "../../packages/bridge/src/safe-exit.ts";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { packageIdentity } from "../../packages/service/src/hub/identity.ts";
import { runServe } from "../../packages/service/src/hub/serve.ts";
import { twoTerminalsHost } from "../../packages/service/test/harness.ts";
import { fakeTtam } from "../../packages/testkit/src/index.ts";
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
const monitor = process.env["E2E_MONITOR"];

const code = await runServe({
  identity: () => ({ root: false, elevated: false, package: packageIdentity(process.env) }),
  // A worker's tests sign in by code many times a minute. The service's own limit of 10 a minute
  // is proven by packages/service/src/http/listener.test.ts.
  http: { ports: [0], persist: false, ui, limits: { redeemPerMinute: 10_000 } },
  // Settings lists the terminals detection finds: the same two on every OS the tests run on.
  launch: {
    terminal: fakeTerminal(record),
    terminals: { host: twoTerminalsHost },
    // A killed shim is noticed at the next PID check: soon, so its tests do not wait on the clock.
    checkMs: 2_000,
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
  ...(monitor === undefined
    ? {}
    : {
        monitor: {
          command: () => {
            if (readFileSync(monitor, "utf8").trim() === "none") {
              return Promise.resolve({ ok: false as const, reason: "not_found" as const });
            }
            // It lives as long as the world: a fake that ended by itself would be a failure.
            const fake = fakeTtam({ control: monitor, maxMs: 3_600_000 });
            return Promise.resolve({
              ok: true as const,
              file: fake.file,
              args: fake.args,
              env: process.env,
              cwd: tasksHome,
            });
          },
        },
      }),
});
process.exit(code);
