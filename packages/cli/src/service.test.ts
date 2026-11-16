// `tasks service` through the CLI (A2 3.10.1, M1.12's entries). Only routes that end
// before anything is read are run here: a usage error, and an agent's shell, which install,
// uninstall and stop refuse first. No test of the CLI reaches the real Run key, a unit folder or a
// service manager; the commands themselves are tested in packages/service with stand-ins.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main, SLOTS, type Io } from "./main.ts";

function recorder(argv: readonly string[], env: Record<string, string>) {
  const io = {
    argv,
    env,
    cwd: process.cwd(),
    platform: process.platform,
    tty: { stdin: false, stdout: false, stderr: false },
    pid: process.pid,
    out: "",
    err: "",
    stdout(text: string) {
      io.out += text;
    },
    stderr(text: string) {
      io.err += text;
    },
    readStdin: () => Promise.resolve(""),
    readFile: () => Promise.reject(new Error("no file")),
  } satisfies Io & { out: string; err: string };
  return io;
}

describe("[A2.3.3.5.service-install.commands] tasks service through the CLI", () => {
  test("tasks service is routed to the service install: its verbs and flags, usage errors that quote nothing, an agent's shell refused", async () => {
    expect(SLOTS.service).toBeDefined();
    const home = mkdtempSync(join(tmpdir(), "kc-svc-"));
    try {
      for (const argv of [
        ["service"],
        ["service", "reload"],
        ["service", "install", "--force-me"],
        ["service", "status", "secret-value"],
      ]) {
        const io = recorder(argv, { TASKS_HOME: home });
        expect(await main(io)).toBe(2);
        expect(io.err).toContain(
          "tasks service takes one of install, uninstall, start, stop, restart, status",
        );
        expect(io.err).not.toMatch(/force-me|secret-value/);
      }
      // An agent's shell may not install, uninstall, stop or restart: refused before anything is
      // read.
      const agent = { TASKS_HOME: home, CODEX_THREAD_ID: "t1" };
      for (const verb of ["stop", "restart"]) {
        const refused = recorder(["service", verb], agent);
        expect(await main(refused)).toBe(5);
        expect(refused.err).toContain(`tasks service ${verb} is not run from an agent's shell`);
      }
      // --json is the CLI's global flag, and the entry prints one JSON document.
      const install = recorder(["--json", "service", "install", "--yes"], agent);
      expect(await main(install)).toBe(5);
      expect(JSON.parse(install.out)).toMatchObject({
        error: { code: "agent_shell", class: "forbidden" },
      });
      // Help names the command.
      const help = recorder(["help"], { TASKS_HOME: home });
      expect(await main(help)).toBe(0);
      expect(help.out).toMatch(
        /\n {2}service +Install, uninstall, start, stop, restart or show the service/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
