// `ttasks doctor` on an entry setup did not write, and `ttasks doctor --live` against fake apps,
// through the CLI and a real service (A3 3.14; A7 3.11 M4.05): a headless call through each app
// must reach the service, and a run that hangs or leaves a process behind still gives its row. The
// service, the fakes and the scratch homes are doctor-agents-world.ts's; the other agent checks are
// in doctor-agents.test.ts. No real agent home, app folder or agent command is read or run.
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MCP_SERVER_KEY } from "@ttasks/brand";
import { stateOf } from "@ttasks/service/test/harness";
import {
  SLOW,
  agents,
  applyAll,
  doctor,
  fakes,
  home,
  root,
  row,
  run,
  tasks,
  useDoctorWorld,
  user,
} from "./doctor-agents-world.ts";

useDoctorWorld();

describe("[A3.3.14.doctor.manual] ttasks doctor on an entry setup did not write", () => {
  test(
    "an entry without --instance is named for what it reaches, one with an instance for its refusal, each with how to take it out",
    async () => {
      await applyAll(["--app", "claude-desktop"]);
      const claudeFile = join(user, ".claude.json");
      const before = readFileSync(claudeFile, "utf8");
      const withEntry = (args: string[]) => {
        const doc = JSON.parse(before) as { mcpServers: Record<string, unknown> };
        doc.mcpServers[MCP_SERVER_KEY] = { command: tasks, args };
        writeFileSync(claudeFile, JSON.stringify(doc, null, 2));
      };
      try {
        expect(row(await doctor(), "manual")?.status).toBe("ok");

        // As `print` gives one: a hand-made entry, not a mistake.
        withEntry(["mcp", "--app", "claude-code"]);
        const handMade = row(await doctor(), "manual");
        expect(handMade?.status).toBe("warn");
        expect(handMade?.detail).toContain("without --instance");
        expect(handMade?.detail).toContain("reach only the machine's default space");
        expect(handMade?.detail).toContain(
          `"${MCP_SERVER_KEY}" member of "mcpServers" out of that home's .claude.json`,
        );
        expect(handMade?.detail).not.toContain("mcp remove");
        expect(handMade?.detail).not.toContain(user);

        // One with an instance setup did not register: the grant gate refuses it.
        withEntry(["mcp", "--instance", "claude-x", "--app", "claude-code"]);
        const named = row(await doctor(), "manual");
        expect(named?.status).toBe("warn");
        expect(named?.detail).toContain("as instance claude-x");
        expect(named?.detail).toContain("refuses its calls");
        expect(named?.detail).not.toContain(user);

        // An --instance the service reads as the hand-made entry's (`manual`, or no instance ID
        // at all) reaches the default space like one without: the row says so, not a refusal.
        for (const instance of ["manual", "MANUAL", "codex.foo"]) {
          withEntry(["mcp", "--instance", instance, "--app", "claude-code"]);
          const asManual = row(await doctor(), "manual");
          expect([instance, asManual?.status]).toEqual([instance, "warn"]);
          expect(asManual?.detail).toContain("reach only the machine's default space");
          expect(asManual?.detail).not.toContain("refuses its calls");
        }
        // Arguments the server does not take: no claim about what the entry reaches.
        withEntry(["mcp", "--unknown", "x"]);
        const unread = row(await doctor(), "manual");
        expect(unread?.status).toBe("warn");
        expect(unread?.detail).not.toContain("default space");
        expect(unread?.detail).not.toContain("refuses its calls");
        expect(unread?.detail).toContain(`"${MCP_SERVER_KEY}" member of "mcpServers" out of`);
      } finally {
        writeFileSync(claudeFile, before);
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
      }
    },
    SLOW,
  );
});

describe("[A3.3.14.doctor.live] ttasks doctor --live against fake apps", () => {
  test(
    "a headless call through each app reaches the service from that home; without --live nothing runs",
    async () => {
      await applyAll(["--app", "claude-code,codex"]);
      const headless = () =>
        fakes.calls().filter((c) => c.args[0] === "-p" || c.args[0] === "exec").length;
      const quiet = await doctor();
      expect(row(quiet, "live")?.status).toBe("skip");
      expect(headless()).toBe(0);

      const live = await doctor(agents(), ["--live"]);
      expect(row(live, "live.claude"), JSON.stringify(live.checks)).toMatchObject({ status: "ok" });
      expect(row(live, "live.codex")).toMatchObject({ status: "ok" });
      // One headless run per registered Claude Code and Codex home, each seen by the service.
      const liveRows = live.checks.filter((c) => c.id.startsWith("live."));
      expect(liveRows.map((c) => c.status)).toEqual(liveRows.map(() => "ok"));
      expect(headless()).toBe(liveRows.length);
      // The prompt went on stdin: no argument of a headless run holds it.
      for (const call of fakes.calls().filter((c) => c.args[0] === "-p" || c.args[0] === "exec")) {
        expect(call.args.join(" ")).not.toContain('status" once');
      }

      // An app that cannot start the entry makes no call: the row fails.
      const broken = await doctor(
        agents({ FAKE_AGENT_TASKS: JSON.stringify({ path: "", argv: [] }) }),
        ["--live"],
      );
      expect(row(broken, "live.claude")?.status).toBe("fail");
      expect(row(broken, "live.claude")?.detail).toContain("setup agents --status");

      const removed = await run(["setup", "agents", "--remove", "--json"]);
      expect(removed.code, removed.stdout).toBe(0);
    },
    SLOW,
  );

  test(
    "a headless run that hangs with a process it started: both end at the deadline and the row fails",
    async () => {
      await applyAll(["--app", "claude-code"]);
      const pidFile = join(root, "live-descendant.pid");
      // Starts a descendant and hangs with it. On Windows the descendant leaves Node's kill-on-close
      // job (`detached`), as one an app's native launcher starts would never be in it.
      const hang = [
        "const { spawn } = require('node:child_process');",
        "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
        "setTimeout(() => {}, 60000);",
      ].join("\n");
      const options = agents();
      const report = await doctor(
        {
          ...options,
          liveMs: 4_000,
          resolve: (argv) =>
            argv.includes("-p")
              ? [process.execPath, "-e", hang]
              : (options.resolve?.(argv) ?? argv),
        },
        ["--live"],
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        expect(row(report, "live.claude")).toMatchObject({ status: "fail" });
        expect(row(report, "live.claude")?.detail).toContain("did not finish its headless run");
        const until = Date.now() + 10_000;
        while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
        expect(alive()).toBe(false);
      } finally {
        if (alive()) process.kill(pid, "SIGKILL");
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
      }
    },
    SLOW,
  );

  test(
    "an app that ends and leaves a process in the run's folder: the report still comes, and a later run sweeps old folders",
    async () => {
      await applyAll(["--app", "claude-code"]);
      const tmp = join(stateOf(home), "tmp");
      // A folder an earlier run could not remove, from long ago.
      const old = join(tmp, "doctor-live-0123456789ab");
      mkdirSync(old, { recursive: true });
      const long = new Date(Date.now() - 3_600_000);
      utimesSync(old, long, long);
      const pidFile = join(root, "left-behind.pid");
      // Ends at once and leaves a process working in the run's folder (on Windows it holds it, so
      // the folder cannot be removed); `detached` takes it out of Node's kill-on-close job.
      const leave = [
        "const { spawn } = require('node:child_process');",
        "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: process.cwd(), stdio: 'ignore', windowsHide: true, detached: true });",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
        "c.unref();",
      ].join("\n");
      const options = agents();
      const report = await doctor(
        {
          ...options,
          liveMs: 20_000,
          resolve: (argv) =>
            argv.includes("-p")
              ? [process.execPath, "-e", leave]
              : (options.resolve?.(argv) ?? argv),
        },
        ["--live"],
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      try {
        expect(row(report, "live.claude")).toMatchObject({ status: "fail" });
        expect(row(report, "live.claude")?.detail).toContain("saw no call from this home");
        expect(existsSync(old)).toBe(false);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone already.
        }
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
      }
    },
    SLOW,
  );
});
