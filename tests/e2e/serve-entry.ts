// The end-to-end tests' `ttasks serve`: the real runServe() in a child process, as
// packages/service/test/serve-entry.ts runs it, with the page's built folder (E2E_UI), the
// world's fake terminal over IPC, a file manager that records the folders it is asked to show (E2E_FOLDERS), an
// app link opener that records the links it is given (E2E_LINKS, for T3 Code), and,
// with E2E_MONITOR, the test kit's fake `ttam` steered by that file: `none` is no TTAM at all,
// another word is the fake's mode (packages/testkit/src/fakes/ttam.ts), and the file beside it
// with `.agents` added holds the homes and agents it reports besides. Without it, as in every
// test, there is no TTAM. The page opens through the service's own `launch.open` and launch
// machines, as `ttasks serve` does. The listener takes a port the OS assigns, and machine.toml's
// port is never written. Tests only.
//
// A line `stop` on stdin stops it gracefully, on every OS.
// First, as in the product's entries: this script ends through process.exit.
import "../../packages/bridge/src/safe-exit.ts";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { packageIdentity } from "../../packages/service/src/hub/identity.ts";
import { runServe } from "../../packages/service/src/hub/serve.ts";
import { twoTerminalsHost } from "../../packages/service/test/harness.ts";
import { fakeTtam } from "../../packages/testkit/src/index.ts";
import type { TerminalReply, TerminalRequest } from "./fake-terminal.ts";

const ui = process.env["E2E_UI"];
const send = process.send?.bind(process);
const folders = process.env["E2E_FOLDERS"];
const links = process.env["E2E_LINKS"];
if (ui === undefined || send === undefined || folders === undefined) {
  process.stderr.write("the test service needs E2E_UI, E2E_FOLDERS and IPC\n");
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

const pending = new Map<string, (reply: TerminalReply) => void>();
process.on("message", (reply: TerminalReply) => {
  pending.get(reply.launch)?.(reply);
  pending.delete(reply.launch);
});

const code = await runServe({
  identity: () => ({ root: false, elevated: false, package: packageIdentity(process.env) }),
  // A worker's tests sign in by code many times a minute. The service's own limit of 10 a minute
  // is proven by packages/service/src/http/listener.test.ts. The phone's link listens on loopback,
  // so a pairing in a test reaches nothing beyond this machine.
  http: {
    ports: [0],
    persist: false,
    ui,
    limits: { redeemPerMinute: 10_000 },
    link: { host: "127.0.0.1", ports: [0], addresses: () => ["127.0.0.1"] },
  },
  // Settings lists the terminals detection finds: the same two on every OS the tests run on.
  launch: {
    terminal: ({ intent, ticket, folder }) =>
      new Promise((resolve) => {
        pending.set(intent.id, resolve);
        send({
          launch: intent.id,
          task: intent.task,
          ticket,
          folder,
        } satisfies TerminalRequest);
      }),
    terminals: { host: twoTerminalsHost },
    // A killed shim is noticed at the next PID check: soon, so its tests do not wait on the clock.
    checkMs: 2_000,
    // The file manager records the folder it is asked to show, one per line, and opens no window.
    showFolder: (folder) => {
      appendFileSync(folders, `${folder}\n`);
      return Promise.resolve("opened");
    },
    // With E2E_LINKS, an app's link (T3 Code's) is recorded there, one per line, and opens nothing.
    ...(links === undefined
      ? {}
      : {
          openLink: (url: string) => {
            appendFileSync(links, `${url}\n`);
            return Promise.resolve(true);
          },
        }),
  },
  agentApps: {
    home: agentHome,
    env: agentEnv === undefined ? { PATH: "" } : (JSON.parse(agentEnv) as Record<string, string>),
  },
  ...(monitor === undefined
    ? {}
    : {
        monitor: {
          // A fake the test holds stays held: no deadline fails it, and an answer held is soon
          // overdue (4 passes of the recording's half a second).
          times: { helloMs: 3_600_000, answerMs: 3_600_000, slowMs: 1_000, retryMs: [1_000] },
          // An agent the test takes out of the monitor's answers is not seen after two of them.
          unseenMs: 0,
          command: () => {
            if (readFileSync(monitor, "utf8").trim() === "none") {
              return Promise.resolve({ ok: false as const, reason: "not_found" as const });
            }
            // It lives as long as the world: a fake that ended by itself would be a failure.
            const fake = fakeTtam({
              control: monitor,
              agents: `${monitor}.agents`,
              maxMs: 3_600_000,
            });
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
