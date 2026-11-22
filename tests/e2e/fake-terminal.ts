// The terminal behind the page's launch tile in the end-to-end tests (A7 3.9 M2.13's Verify line,
// M2.10). It stands where the terminal adapters do (the service's `terminal` seam, after
// Dispatching is durable, the folder resolved and the ticket issued): it records the command line
// a terminal would get, as one JSON line per launch in a file the test reads, and then runs that
// command itself, a real `tasks shim <ticket>` in the resolved folder, with no window. The shim
// claims, verifies the folder and starts the instance's agent: testkit's fake Claude Code, which
// takes the brief as any CLI does, reads the person's request through the product's command and
// runs for a few seconds, so the launch settles as Confirmed. A task listed in the record's
// `.refuse` file has its next launch refused instead, as a terminal that would not start.
//
// The command line is exactly `<cli> shim <ticket>` (A4 3.6.2): no task text, title or folder.
// Fixture data only. Tests only.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLI_NAME } from "../../packages/brand/src/index.ts";
import { startTimes } from "../../packages/launch/src/process.ts";
import type { TerminalStart } from "../../packages/service/src/launch/index.ts";
import { instanceToml } from "../../packages/service/test/harness.ts";
import { FAKE_CLI_AGENT, FAKE_TERMINAL } from "../../packages/testkit/src/index.ts";

/** The CLI's entry from the source tree, as `pnpm tasks` runs it. */
const CLI_BIN = fileURLToPath(new URL("../../packages/cli/src/bin.ts", import.meta.url));

/** The one instance the page offers: the fake agent, as machine.toml's `[[instance]]` has it. */
export const FAKE_INSTANCE = {
  key: "fake-agent",
  label: "Fake agent · test",
  glyph: "Cc",
  ring: 1,
  route: "terminal",
} as const;

/**
 * The instance's table in machine.toml: Claude Code's target, run as the fake, which reads the
 * person's request as its brief says without the tools (`tasks show --launch`) from the install of
 * `home`. On a task `holds` has a file for, the fake runs until that file is removed.
 */
export function fakeInstanceToml(home: string, holds: string): string {
  return instanceToml({
    id: FAKE_INSTANCE.key,
    target: "claude-cli",
    label: FAKE_INSTANCE.label,
    exec: process.execPath,
    args_prefix: [FAKE_CLI_AGENT],
    env: {
      // Long enough to settle (3 s), short enough to end on its own.
      FAKE_CLI_HOLD_MS: "6000",
      FAKE_CLI_TASKS: JSON.stringify({ argv: [process.execPath, CLI_BIN], home }),
      FAKE_CLI_HOLDS: holds,
    },
  });
}

/** One line of the fake terminal's record. */
export interface TerminalCall {
  readonly launch: string;
  readonly argv: readonly string[];
  /** The shim's process, which a test may end as a closed window or a kill would. */
  readonly pid?: number;
  /** Its start time as the OS records it: the PID names this process only while they match. */
  readonly start?: string;
}

/** The file of task IDs whose next launch the fake terminal refuses, one a line. */
export const refuseFile = (record: string): string => `${record}.refuse`;

/** Whether the next launch of `task` is to be refused: once, then the line goes. */
function refused(record: string, task: string | null): boolean {
  const file = refuseFile(record);
  if (task === null || !existsSync(file)) return false;
  const lines = readFileSync(file, "utf8").split("\n");
  const at = lines.indexOf(task);
  if (at === -1) return false;
  lines.splice(at, 1);
  writeFileSync(file, lines.join("\n"));
  return true;
}

/** The service's terminal seam: records `tasks shim <ticket>` and runs it in the folder. */
export function fakeTerminal(record: string): TerminalStart {
  return async ({ intent, ticket, folder }) => {
    if (refused(record, intent.task)) return { kind: "refused" };
    const command = [process.execPath, CLI_BIN, "shim", ticket];
    const pid =
      process.platform === "win32"
        ? await inWindow(command, folder, `${record}.${intent.id}`)
        : inGroup(command, folder);
    const start =
      pid === undefined ? undefined : (await startTimes([pid]).catch(() => undefined))?.get(pid);
    const call: TerminalCall = {
      launch: intent.id,
      argv: [CLI_NAME, "shim", ticket],
      ...(pid === undefined ? {} : { pid }),
      ...(start === undefined ? {} : { start }),
    };
    appendFileSync(record, `${JSON.stringify(call)}\n`);
    // A handoff: the window would open later, and the claim window decides.
    return { kind: "accepted" };
  };
}

/**
 * On POSIX the shim is started detached, as a terminal's window is: it outlives a service that
 * stops, and it is a process group of its own, which a test hangs up as a closed window does.
 */
function inGroup([file = "", ...args]: readonly string[], folder: string): number | undefined {
  const shim = spawn(file, args, {
    cwd: folder,
    env: process.env,
    stdio: "ignore",
    // eslint-disable-next-line no-restricted-syntax -- POSIX only: Windows starts it in inWindow.
    detached: true,
  });
  shim.on("error", () => undefined);
  shim.unref();
  return shim.pid;
}

/**
 * On Windows testkit's fake terminal stands for the window: started detached, it outlives a
 * service that stops, and it starts the shim with a hidden console, which the agent inherits. A
 * shim started detached itself has no console, and its agent would open a visible one. The answer
 * is the shim's PID, from the window's record.
 */
async function inWindow(
  command: readonly string[],
  folder: string,
  log: string,
): Promise<number | undefined> {
  const window = spawn(process.execPath, [FAKE_TERMINAL, ...command], {
    cwd: folder,
    env: {
      ...process.env,
      FAKE_TERMINAL_LOG: log,
      FAKE_TERMINAL_MODE: "direct",
      FAKE_TERMINAL_PRODUCT_LENGTH: "2",
      // A held session may run as long as its test does.
      FAKE_TERMINAL_MAX_MS: String(30 * 60_000),
    },
    stdio: "ignore",
    windowsHide: true,
    // eslint-disable-next-line no-restricted-syntax -- the fake terminal starts the shim with a hidden console.
    detached: true,
  });
  window.on("error", () => undefined);
  window.unref();
  for (let waited = 0; waited < 5_000; waited += 25) {
    const started = existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as { event?: string; child?: number })
          .find((entry) => entry.event === "command" || entry.event === "command_failed")
      : undefined;
    if (started !== undefined) return started.child;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}
