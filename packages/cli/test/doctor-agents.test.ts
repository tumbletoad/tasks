// `ttasks doctor`'s agent checks and `ttasks setup agents` for the remaining apps, through the CLI
// and a real service (A3 3.13, 3.14; A7 3.11 M4.05): doctor checks pass against fakes, each fault
// gives a row with the command that fixes it, `--live` asks fake apps for a headless call and the
// service must see it, and apply then remove leaves every file as it was.
//
// A real service in this process, the CLI in this process, fake `claude` and `codex` commands
// (testkit) on a scratch PATH, scratch homes and app folders in a temporary folder, named to setup
// through the environment it reads. The entries run a scratch install's command, which stands for
// the CLI from source (the bridge) wherever doctor or a fake app runs it. No real agent home, app
// folder or agent command is read or run. The service, the fakes and the scratch homes are
// doctor-agents-world.ts's; `--live` and an entry setup did not write are in
// doctor-agents-live.test.ts.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { classSession } from "@ttasks/service/test/ops-helpers";
import { MCP_SERVER_KEY } from "@ttasks/brand";
import {
  SLOW,
  agentRows,
  agents,
  applyAll,
  desktopFolder,
  doctor,
  engine,
  fakes,
  home,
  read,
  row,
  run,
  service,
  space,
  tasks,
  useDoctorWorld,
  user,
  setStarted,
} from "./doctor-agents-world.ts";

/** The live processes whose command line holds `mark`. */
function marked(mark: string): number[] {
  if (process.platform === "win32") {
    // The mark goes in by the environment, so this query's own command line does not hold it.
    const listed = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:MARK) } | ForEach-Object { $_.ProcessId }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env, MARK: mark } },
    );
    return listed.stdout
      .split(/\s+/)
      .filter((n) => n !== "")
      .map(Number);
  }
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .filter((entry) => {
      try {
        return readFileSync(join("/proc", entry, "cmdline"), "utf8")
          .split("\0")
          .includes(mark);
      } catch {
        return false;
      }
    })
    .map(Number);
}

useDoctorWorld();

describe("[A3.3.14.doctor.agents] ttasks doctor's agent checks against fakes", () => {
  test(
    "before setup: one row says to run setup, and no agent home is read",
    async () => {
      const report = await doctor();
      expect(agentRows(report)).toEqual([
        ["claude.env", "ok"],
        ["agents", "warn"],
        ["live", "skip"],
      ]);
      expect(row(report, "agents")?.detail).toContain("setup agents");
      // Not even detection ran: no fake was asked for its version.
      expect(fakes.calls()).toEqual([]);
    },
    SLOW,
  );

  test(
    "after setup every agent row passes, and each fault fails or warns with its fix",
    async () => {
      const before = read();
      const text = await run(["setup", "agents"], agents(), false);
      expect(text.stdout).toContain("writes one entry into this file");
      expect(text.stdout).toMatch(/\(instance codex; also read by (the Codex app and )?T3 Code\)/u);
      await applyAll();
      setStarted(Date.now() + 60_000);

      const report = await doctor();
      const expected = [
        ["claude.env", "ok"],
        ["mcp.claude", "ok"],
        ["bridge.claude", "ok"],
        ["mcp.codex", "ok"],
        ["codex.engines.codex", "ok"],
        ["bridge.codex", "ok"],
        ["mcp.claude-desktop", "ok"],
        ["bridge.claude-desktop", "ok"],
        ["desktop.restart", "ok"],
        ["grants", "ok"],
        ["t3.homes", "ok"],
        ["live", "skip"],
      ];
      expect(agentRows(report).sort()).toEqual(expected.sort());
      expect(row(report, "bridge.codex")?.detail).toMatch(/status round trip took \d+ ms/u);
      if (engine !== undefined) {
        expect(row(report, "codex.engines.codex")?.detail).toContain("all 2 Codex engines");
      }
      // No home's path and no entry's content in a row.
      expect(JSON.stringify(agentRows(report))).not.toContain(user);

      // An engine that rejects the file: the app's own get and the engines row fail.
      const rejecting = await doctor(agents({ FAKE_AGENT_FAIL: "codex:get" }));
      expect(row(rejecting, "mcp.codex")?.status).toBe("fail");
      expect(row(rejecting, "codex.engines.codex")).toMatchObject({ status: "fail" });
      expect(row(rejecting, "codex.engines.codex")?.detail).toContain("setup agents --remove");
      if (engine !== undefined) {
        // Only the Codex app's engine rejects it.
        const app = await doctor(agents({}, [process.execPath, "-e", "process.exit(1)"]));
        expect(row(app, "mcp.codex")?.status).toBe("ok");
        expect(row(app, "codex.engines.codex")?.detail).toContain("the Codex app's engine");
      }

      // Claude Desktop started before the change, or doctor cannot tell.
      setStarted(Date.now() - 3_600_000);
      expect(row(await doctor(), "desktop.restart")).toMatchObject({ status: "warn" });
      setStarted(undefined);
      expect(row(await doctor(), "desktop.restart")?.detail).toContain("quit and reopen it");
      setStarted("not_running");
      expect(row(await doctor(), "desktop.restart")?.status).toBe("ok");

      // The allow-list variable where Claude Code starts.
      expect(
        row(await doctor(agents({ CLAUDE_CODE_MCP_ALLOWLIST_ENV: "1" })), "claude.env")?.status,
      ).toBe("warn");

      // An entry changed by hand: a warning, and setup leaves it.
      const desktopFile = join(desktopFolder, "claude_desktop_config.json");
      const applied = readFileSync(desktopFile, "utf8");
      writeFileSync(desktopFile, applied.replace('"--app"', '"--app-x"'));
      expect(row(await doctor(), "mcp.claude-desktop")?.status).toBe("warn");
      writeFileSync(desktopFile, applied);

      // The install's command gone: the entries run nothing.
      renameSync(tasks, `${tasks}.moved`);
      const missing = await doctor();
      expect(row(missing, "mcp.claude")).toMatchObject({ status: "fail" });
      expect(row(missing, "mcp.claude")?.detail).toContain("not there any more");
      renameSync(`${tasks}.moved`, tasks);

      // A row revoked behind setup's back: grants and the home's row fail; apply renews it.
      const person = await classSession(home, service.endpoint.path, "cli-interactive");
      try {
        const rows = (await person.call("setup/homes", {}, { timeoutMs: 30_000 })) as {
          homes: { grant: string; instance: string }[];
        };
        const codexRow = rows.homes.find((r) => r.instance === "codex");
        await person.call(
          "setup/home_revoke",
          { grants: [codexRow?.grant ?? ""] },
          { timeoutMs: 30_000 },
        );
      } finally {
        person.close();
      }
      const revoked = await doctor();
      expect(row(revoked, "grants")?.status).toBe("fail");
      expect(row(revoked, "mcp.codex")?.detail).toContain("no grant row");
      await applyAll();
      expect(row(await doctor(), "grants")?.status).toBe("ok");

      // T3 starts using another Codex home: it lacks the entry until setup adds it there.
      mkdirSync(join(user, ".codex-t3x"));
      const settings = join(user, ".t3", "userdata", "settings.json");
      const t3Before = readFileSync(settings, "utf8");
      writeFileSync(
        settings,
        JSON.stringify({
          providerInstances: {
            codex: { driver: "codex", displayName: "Codex", enabled: true },
            codex_t3x: {
              driver: "codex",
              displayName: "Codex T3x",
              enabled: true,
              config: { homePath: join(user, ".codex-t3x") },
            },
          },
        }),
      );
      const gap = await doctor();
      expect(row(gap, "t3.homes")).toMatchObject({ status: "warn" });
      expect(row(gap, "t3.homes")?.detail).toContain("setup agents --app t3");
      await applyAll(["--app", "t3"]);
      expect(row(await doctor(), "t3.homes")?.status).toBe("ok");
      const t3Rows = await run(["setup", "agents", "--status", "--json"], agents(), false);
      expect(
        (JSON.parse(t3Rows.stdout) as { homes: { instance: string; hosts: string[] }[] }).homes
          .filter((h) => h.hosts.includes("t3"))
          .map((h) => h.instance)
          .sort(),
      ).toEqual(["claude", "codex", "codex-t3x"]);

      // T3 names Claude Code's default folder by its path: its Claude reads `.claude.json` inside
      // that folder, not the user's file where the default home's entry is. Doctor says so, names
      // an instance turned off and the entries it passed over, and checks the rest.
      writeFileSync(
        settings,
        JSON.stringify({
          providerInstances: {
            codex: { driver: "codex", displayName: "Codex", enabled: true },
            codex_t3x: { driver: "codex", config: { homePath: join(user, ".codex-t3x") } },
            claudeAgent: { driver: "claudeAgent", config: { homePath: join(user, ".claude") } },
            claude_off: { driver: "claudeAgent", enabled: false, config: { homePath: "~/off" } },
            future: { driver: "futureAgent", enabled: true },
            // A key that is not a plain name (a path, a control character) never reaches a row.
            [`${join(user, "odd")}\u001b[31m`]: { driver: "codex" },
          },
        }),
      );
      const explicit = row(await doctor(), "t3.homes");
      expect(explicit).toMatchObject({ status: "warn" });
      expect(explicit?.detail).toContain("clear the instance's home path");
      expect(explicit?.detail).toContain("Turned off in T3 Code, so not checked: claude_off.");
      expect(explicit?.detail).toContain("a kind of agent this build does not know: future.");
      expect(explicit?.detail).toContain("(a key that is not a plain name) was passed over");
      expect(explicit?.detail).not.toContain(user);
      expect(explicit?.detail).not.toContain("\u001b");

      // Remove: every entry and row back, every file as it was (T3's file only by this test).
      const removed = await run(["setup", "agents", "--remove", "--json"]);
      expect(removed.code, removed.stdout).toBe(0);
      writeFileSync(settings, t3Before);
      expect(read()).toEqual(before);
      // The file the command made there, emptied by its remove, is gone again.
      expect(existsSync(join(user, ".codex-t3x", "config.toml"))).toBe(false);
    },
    SLOW,
  );

  test(
    "print, print-block and approve-tools write nothing, nor does the block's preview",
    async () => {
      const before = read();
      const printed = await run(
        ["setup", "agents", "print", "--app", "cursor", "--json"],
        agents(),
        false,
      );
      expect(printed.code, printed.stderr).toBe(0);
      const snippet = JSON.parse(printed.stdout) as { files: string[]; text: string };
      expect(snippet.files).toEqual([join(user, ".cursor", "mcp.json")]);
      // A hand-made entry: no row is kept for it, so it names no instance. It names the machine's
      // default space, here the only one, the one the grant gate lets such an entry use.
      expect(JSON.parse(snippet.text)).toEqual({
        mcpServers: {
          [MCP_SERVER_KEY]: { command: tasks, args: ["mcp", "--space", space, "--app", "cursor"] },
        },
      });
      expect(existsSync(join(user, ".cursor"))).toBe(false);
      const named = await run(
        ["setup", "agents", "print", "--app", "cursor", "--space", space],
        agents(),
        false,
      );
      expect(named.code).toBe(2);
      const desktop = await run(
        ["setup", "agents", "print", "--app", "claude-desktop"],
        agents(),
        false,
      );
      expect(desktop.stdout).toContain(join(desktopFolder, "claude_desktop_config.json"));

      const approve = await run(["setup", "agents", "--parts", "approve-tools"], agents(), false);
      expect(approve.code).toBe(0);
      expect(approve.stdout).toContain("never changes another app's approval settings");
      expect(approve.stdout).toContain(`mcp__${MCP_SERVER_KEY}__*`);
      expect(approve.stdout).toContain('default_tools_approval_mode = "approve"');
      expect(read()).toEqual(before);
      expect(existsSync(join(user, ".claude", "settings.json"))).toBe(false);

      // The instruction block's preview and print-block write nothing either (A3 3.12).
      expect((await run(["setup", "agents", "--parts", "block"], agents(), false)).code).toBe(0);
      expect((await run(["setup", "agents", "print-block", "--for", "claude"])).code).toBe(0);
      expect(existsSync(join(user, ".claude", "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(user, ".codex", "AGENTS.md"))).toBe(false);
      expect(read()).toEqual(before);
      expect((await run(["setup", "agents", "print", "--app", "notepad"])).code).toBe(2);
      expect((await run(["doctor", "--bogus"])).code).toBe(2);

      // A remove of only approve-tools (which setup never writes) takes no MCP entry out.
      await applyAll(["--app", "claude-desktop"]);
      const registered = read();
      const approvalsOnly = await run([
        "setup",
        "agents",
        "--remove",
        "--parts",
        "approve-tools",
        "--app",
        "claude-desktop",
      ]);
      expect(approvalsOnly.code).toBe(2);
      expect(approvalsOnly.stdout + approvalsOnly.stderr).toContain("nothing of it to remove");
      expect(read()).toEqual(registered);
      expect((await run(["setup", "agents", "--status", "--parts", "mcp"])).code).toBe(2);
      const removed = await run(["setup", "agents", "--remove", "--parts", "mcp", "--json"]);
      expect(removed.code, removed.stdout).toBe(0);
      expect(read()).toEqual(before);
    },
    SLOW,
  );

  test(
    "an entry's command that starts and never answers: its row fails by the deadline and no process is left",
    async () => {
      await applyAll(["--app", "claude-desktop"]);
      // The entry's command stands for a bridge that reads nothing and never ends by itself. It is
      // found by a mark on its command line, whether or not it got as far as running its code.
      const mark = `ttasks-hung-${randomBytes(6).toString("hex")}`;
      const options = agents();
      const report = await doctor({
        ...options,
        // What is proved is that the deadline ends the probe, not its length.
        bridgeProbeMs: 5_000,
        resolve: (argv) =>
          argv[0] === tasks
            ? [process.execPath, "-e", "setInterval(() => {}, 1000);", mark, ...argv.slice(1)]
            : (options.resolve?.(argv) ?? argv),
      });
      try {
        expect(row(report, "bridge.claude-desktop")).toMatchObject({ status: "fail" });
        expect(row(report, "bridge.claude-desktop")?.detail).toContain("did not answer in time");
        // The probe's process ends with its deadline: doctor leaves nothing running.
        const until = Date.now() + 10_000;
        while (marked(mark).length > 0 && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(marked(mark)).toEqual([]);
        // And the census sees such a process while it runs.
        const control = `${mark}-control`;
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);", control], {
          stdio: "ignore",
          windowsHide: true,
        });
        try {
          // Until its program is running, a child's command line can still be its parent's.
          const seen = Date.now() + 10_000;
          while (marked(control).length === 0 && Date.now() < seen) {
            await new Promise((r) => setTimeout(r, 100));
          }
          expect(marked(control)).toEqual([child.pid]);
        } finally {
          child.kill("SIGKILL");
        }
      } finally {
        for (const pid of marked(mark)) process.kill(pid, "SIGKILL");
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
      }
    },
    SLOW,
  );

  test(
    "an entry's command that prints what is not a JSON object, or a line without end: the row fails and doctor goes on",
    async () => {
      await applyAll(["--app", "claude-desktop"]);
      const options = agents();
      const standIn = (script: string) => ({
        ...options,
        resolve: (argv: readonly string[]) =>
          argv[0] === tasks
            ? [process.execPath, "-e", script, ...argv.slice(1)]
            : (options.resolve?.(argv) ?? argv),
      });
      try {
        // Lines that parse but are no message: null, an array, a number, a string.
        const odd = await doctor(
          standIn(
            `process.stdout.write('null\\n[]\\n5\\n"x"\\n'); setTimeout(() => process.exit(0), 300);`,
          ),
        );
        expect(row(odd, "bridge.claude-desktop")).toMatchObject({ status: "fail" });
        expect(row(odd, "bridge.claude-desktop")?.detail).toContain("did not answer initialize");

        // Output without a line end, past the bound: the probe ends long before its deadline.
        const t0 = Date.now();
        const flood = await doctor(
          standIn(
            `process.stdout.write("x".repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000);`,
          ),
        );
        expect(row(flood, "bridge.claude-desktop")).toMatchObject({ status: "fail" });
        expect(Date.now() - t0).toBeLessThan(15_000);
      } finally {
        const removed = await run(["setup", "agents", "--remove", "--json"]);
        expect(removed.code, removed.stdout).toBe(0);
      }
    },
    SLOW,
  );
});
