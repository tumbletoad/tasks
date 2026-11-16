// The end of an install whose service still runs another version (`tasks install --finish`): a
// person at a terminal is asked once, anyone else reads the restart as the last lines. The service
// here is a stand-in; tests/update/restart.test.ts runs the real one through an install script.
import { describe, expect, test } from "vitest";
import { PRODUCT_NAME } from "@tasks/brand";
import { offerRestart, type InstalledService } from "../src/install.ts";
import type { Io } from "../src/io.ts";

function recorder(answer?: boolean, platform: NodeJS.Platform = "linux") {
  const io = {
    argv: [],
    env: {},
    cwd: "/",
    platform,
    tty: { stdin: answer !== undefined, stdout: answer !== undefined, stderr: false },
    pid: 1,
    out: "",
    asked: [] as string[],
    stdout(text: string) {
      io.out += text;
    },
    stderr() {
      // Not read here.
    },
    readStdin: () => Promise.resolve(""),
    readFile: () => Promise.reject(new Error("no file")),
    ...(answer === undefined
      ? {}
      : {
          ask: (question: string) => {
            io.asked.push(question);
            return Promise.resolve(answer);
          },
        }),
  } satisfies Io & { out: string; asked: string[] };
  return io;
}

function service(
  options: { agentShell?: boolean; restartCode?: number; afterRestart?: string | undefined } = {},
) {
  const calls = { restart: 0 };
  const stand: InstalledService = {
    running: () =>
      Promise.resolve(
        calls.restart > 0 && "afterRestart" in options ? options.afterRestart : "0.1.0",
      ),
    agentShell: options.agentShell ?? false,
    restart: () => {
      calls.restart += 1;
      return Promise.resolve(options.restartCode ?? 0);
    },
  };
  return { stand, calls };
}

const installed = { version: "0.2.0", command: "/home/fixture/tasks test/bin/tasks" };
const lastLines = (text: string) => text.trimEnd().split("\n").slice(-2);

describe("[A2.3.12.4.install.restart-notice] the end of an install names the restart of a service that runs another version", () => {
  test("without a terminal: the last lines say which version runs, and the one command, quoted for the shell", async () => {
    const io = recorder();
    const { stand, calls } = service();
    await offerRestart(io, installed, "0.1.0", stand);
    expect(calls.restart).toBe(0);
    expect(lastLines(io.out)).toEqual([
      `${PRODUCT_NAME}'s service still runs 0.1.0. To run 0.2.0, restart it:`,
      "  '/home/fixture/tasks test/bin/tasks' service restart",
    ]);
    const windows = recorder(undefined, "win32");
    await offerRestart(
      windows,
      { version: "0.2.0", command: "C:\\Fixture Home\\tt\\bin\\tasks.exe" },
      null,
      stand,
    );
    expect(lastLines(windows.out)).toEqual([
      `${PRODUCT_NAME}'s service still runs another version. To run 0.2.0, restart it:`,
      "  & 'C:\\Fixture Home\\tt\\bin\\tasks.exe' service restart",
    ]);
  });

  test("at a terminal: one question that says what a restart ends; yes restarts, no leaves the lines", async () => {
    const yes = recorder(true);
    const first = service();
    await offerRestart(yes, installed, "0.1.0", first.stand);
    expect(first.calls.restart).toBe(1);
    expect(yes.asked).toHaveLength(1);
    expect(yes.asked[0]).toContain("Restart it on 0.2.0 now?");
    expect(yes.asked[0]).toContain("Background runs end");
    expect(yes.asked[0]).toContain("Agent sessions keep running");
    expect(yes.out).toBe("");

    const no = recorder(false);
    const second = service();
    await offerRestart(no, installed, "0.1.0", second.stand);
    expect(second.calls.restart).toBe(0);
    expect(lastLines(no.out)[1]).toContain("service restart");
  });

  test("a restart that fails, and an agent's shell, which is not asked, end with the lines", async () => {
    const failed = recorder(true);
    const broken = service({ restartCode: 6 });
    await offerRestart(failed, installed, "0.1.0", broken.stand);
    expect(broken.calls.restart).toBe(1);
    expect(lastLines(failed.out)).toEqual([
      `${PRODUCT_NAME}'s service still runs 0.1.0. To run 0.2.0, restart it:`,
      "  '/home/fixture/tasks test/bin/tasks' service restart",
    ]);

    // The restart stopped the old service and the start failed: the lines say that none runs.
    const stopped = recorder(true);
    await offerRestart(
      stopped,
      installed,
      "0.1.0",
      service({ restartCode: 6, afterRestart: undefined }).stand,
    );
    expect(lastLines(stopped.out)).toEqual([
      `${PRODUCT_NAME}'s service is not running. To run 0.2.0, start it:`,
      "  '/home/fixture/tasks test/bin/tasks' service start",
    ]);

    // The start only took longer than the restart waited: the new version runs, nothing to add.
    const late = recorder(true);
    await offerRestart(
      late,
      installed,
      "0.1.0",
      service({ restartCode: 6, afterRestart: "0.2.0" }).stand,
    );
    expect(late.out).toBe("");

    const agent = recorder(true);
    const shell = service({ agentShell: true });
    await offerRestart(agent, installed, "0.1.0", shell.stand);
    expect(agent.asked).toEqual([]);
    expect(shell.calls.restart).toBe(0);
    expect(lastLines(agent.out)[1]).toContain("service restart");
  });
});
