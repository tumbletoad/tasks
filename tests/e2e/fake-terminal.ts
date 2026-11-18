// The terminal behind the page's launch tile in the end-to-end tests (A7 3.9 M2.13's Verify line,
// M2.10). It stands where the terminal adapters do (the service's `terminal` seam, after
// Dispatching is durable, the folder resolved and the ticket issued): it records the command line
// a terminal would get, as one JSON line per launch in a file the test reads, and then runs that
// command itself, a real `tasks shim <ticket>` in the resolved folder, with no window. The shim
// claims, verifies the folder and starts the instance's agent: testkit's fake Claude Code, which
// takes the brief as any CLI does, reads the person's request through the product's command and
// runs for a few seconds, so the launch settles as Confirmed.
//
// The command line is exactly `<cli> shim <ticket>` (A4 3.6.2): no task text, title or folder.
// Fixture data only. Tests only.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLI_NAME } from "../../packages/brand/src/index.ts";
import type { TerminalStart } from "../../packages/service/src/launch/index.ts";
import { instanceToml } from "../../packages/service/test/harness.ts";
import { FAKE_CLI_AGENT } from "../../packages/testkit/src/index.ts";

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
 * `home`, except on the tasks the file `unread` lists. On a task `holds` has a file for, the fake
 * runs until that file is removed.
 */
export function fakeInstanceToml(home: string, unread: string, holds: string): string {
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
      FAKE_CLI_UNREAD: unread,
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
}

/** The service's terminal seam: records `tasks shim <ticket>` and runs it in the folder. */
export function fakeTerminal(record: string): TerminalStart {
  return ({ intent, ticket, folder }) => {
    // Its own process group on POSIX, as in a terminal's window: a test hangs the group up as a
    // closed window does.
    const shim = spawn(process.execPath, [CLI_BIN, "shim", ticket], {
      cwd: folder,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const call: TerminalCall = {
      launch: intent.id,
      argv: [CLI_NAME, "shim", ticket],
      ...(shim.pid === undefined ? {} : { pid: shim.pid }),
    };
    appendFileSync(record, `${JSON.stringify(call)}\n`);
    shim.on("error", () => undefined);
    shim.unref();
    // A handoff: the window would open later, and the claim window decides.
    return Promise.resolve({ kind: "accepted" });
  };
}
