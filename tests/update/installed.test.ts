// The updater with real builds, a real install and real processes (A7 3.13 M6.12's Verify line):
// the run's two versions (installed.ts), the older one installed into a temporary TTASKS_HOME of
// this file's own and its service run through the install's stable command. On Windows the two
// versions' launchers differ, so every update here also swaps both stable launchers (A7 3.13
// M6.13). The kills at every journal step are in installed-kill-*.test.ts, the repair's in
// installed-repair.test.ts.
//
//   bridge    A bridge (an agent's session) started before an update keeps running through it and
//             answers after it.
//   command   `ttasks update --from`, `--rollback` and `--repair` through the installed stable
//             command, with no service running (a restart through the OS is the injected seam's,
//             exercised in the kill rounds with its stand-in): a second update waits for the
//             first, and the data folders are byte-identical before and after an update and after
//             a rollback.
//
// Nothing here touches a real install, autostart place, PATH or shell profile, and every process
// it stops is one it started: the services this install's service.json names, the children.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe as suite, expect, test } from "vitest";
import { currentVersion, readInstallRecord } from "../../packages/service/src/version/switch.ts";
import { createSpace, newId } from "../../packages/storage/src/index.ts";
import { checkedDriver } from "../../packages/testkit/src/index.ts";
import { runProgram, runsElevated, snapshot } from "../../scripts/install/test/kit.ts";
import { installedForFile, SLOW } from "./installed.ts";

/**
 * Every test here runs the installed service, which refuses an elevated token (exit 64): skipped
 * in an elevated process, where nothing of the file runs, its install included (kit.ts).
 */
const elevated = runsElevated();
const describe = suite.skipIf(elevated);
const install = installedForFile("update", { distinctLaunchers: true, skip: elevated });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("[A2.3.12.6.update.kill] a kill at each journal step, of the updater or of the service, ends on the complete old or new version after the next start", () => {
  test(
    "a session's bridge started before an update keeps running through the restart and answers after it",
    async () => {
      const w = install();
      await w.ensureService();
      const from = await w.expectComplete("before the session");
      const bridge = spawn(w.stable, ["mcp"], {
        env: w.env(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      w.started.push(bridge);
      const replies: Record<string, unknown>[] = [];
      let pending = "";
      bridge.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        pending += chunk;
        for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
          replies.push(JSON.parse(pending.slice(0, end)) as Record<string, unknown>);
          pending = pending.slice(end + 1);
        }
      });
      const ask = async (message: Record<string, unknown>) => {
        const count = replies.length;
        bridge.stdin.write(`${JSON.stringify(message)}\n`);
        for (let i = 0; i < 300 && replies.length === count; i += 1) await pause(50);
        return replies.at(-1);
      };
      // A tool call the service answers: the bridge's offline answer (tools/list, and a call
      // while it has no connection) starts with `error service_unavailable`. Retried while the
      // bridge reconnects; returns whether the service answered.
      let callId = 100;
      const reachesService = async (): Promise<boolean> => {
        const end = Date.now() + 60_000;
        while (Date.now() < end) {
          callId += 1;
          const reply = await ask({
            jsonrpc: "2.0",
            id: callId,
            method: "tools/call",
            params: { name: "status", arguments: {} },
          });
          const result = reply?.["result"] as { content?: { text?: unknown }[] } | undefined;
          const text = result?.content?.[0]?.text;
          if (typeof text === "string" && !text.startsWith("error service_unavailable")) {
            return true;
          }
          await pause(250);
        }
        return false;
      };
      try {
        await ask({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "fixture-client", version: "1.0.0" },
          },
        });
        bridge.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
        expect(
          (await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" }))?.["result"],
        ).toBeDefined();
        expect(await reachesService(), "the bridge reaches the service before").toBe(true);
        const run = await w.runChild("update", { archive: w.archiveOf(w.other(from)) });
        expect(run.lines.at(-1)).toEqual({ done: "updated" });
        expect(await w.expectComplete("after the update with a session")).toBe(w.other(from));
        expect(bridge.exitCode, "the bridge kept running").toBeNull();
        expect(
          (await ask({ jsonrpc: "2.0", id: 3, method: "tools/list" }))?.["result"],
        ).toBeDefined();
        // The same session reconnected to the restarted service, now the new version.
        expect(await reachesService(), "the bridge reaches the service after").toBe(true);
      } finally {
        bridge.stdin.end();
        bridge.kill("SIGKILL");
      }
    },
    SLOW,
  );
});

describe("[A2.3.12.6.update.installed] ttasks update through the installed stable command", () => {
  test(
    "--from, a second update that waits, --rollback and --repair, with the data folders byte-identical",
    async () => {
      const w = install();
      // A fixture space (creating one through the CLI needs a person at a terminal), and the
      // service's own files in state from a run; then the service stops, so the update restarts
      // nothing through the OS.
      await w.ensureService();
      await w.stopService();
      const spaceDir = join(w.work, "spaces", "demo");
      mkdirSync(join(w.work, "spaces"), { recursive: true });
      createSpace(await checkedDriver(), spaceDir, {
        name: "Demo",
        ownerLabel: "Fixture Owner",
        machineId: newId("m"),
      });
      const own = new Set(["update.lock", "update.json", "install.json"]);
      const data = () => ({
        space: snapshot(spaceDir),
        config: snapshot(join(w.root, "config")),
        state: Object.fromEntries(
          Object.entries(snapshot(w.state)).filter(
            ([path]) => !own.has(path) && path !== "tmp/" && !path.startsWith("tmp/"),
          ),
        ),
      });
      const before = data();
      const from = currentVersion(w.root, process.platform) ?? "";
      const to = w.other(from);

      // A second update waits for the first: a real updater holds update.lock at its self-test
      // while the installed command starts the same update. Once the first is done, the second
      // (which runs the version that was current when it started) finds that version current.
      let out = "";
      let exited: Promise<number | null> | undefined;
      const first = await w.runChild("update", {
        archive: w.archiveOf(to),
        arm: "tested",
        mode: "hold",
        whileHeld: async () => {
          const second = spawn(w.stable, ["update", "--from", w.archiveOf(to), "--yes"], {
            env: w.env(),
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
          w.started.push(second);
          second.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
          second.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
          exited = new Promise<number | null>((resolve) => second.once("exit", resolve));
          for (let i = 0; i < 600 && !/waits for it to finish/.test(out); i += 1) await pause(50);
          expect(out).toMatch(/Another update of this install is running \(PID \d+\)/);
          expect(currentVersion(w.root, process.platform)).toBe(from);
        },
      });
      expect(first.lines.at(-1)).toEqual({ done: "updated" });
      expect(await exited, out).toBe(0);
      expect(out).toMatch(
        new RegExp(`${to.replaceAll(".", "\\.")} is installed and current already`),
      );
      expect(currentVersion(w.root, process.platform)).toBe(to);
      expect(data()).toEqual(before);
      const doctor = runProgram(w.stable, ["doctor", "--json"]);
      const rows = (
        JSON.parse(doctor.stdout) as { checks: { id: string; status: string; detail: string }[] }
      ).checks;
      expect(rows.find((row) => row.id === "update")).toMatchObject({ status: "ok" });
      expect(rows.find((row) => row.id === "integrity")?.status).toBe("ok");

      // The same archive again: nothing to do. --rollback: the previous version is current again.
      const again = runProgram(w.stable, ["update", "--from", w.archiveOf(to), "--yes"]);
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).toMatch(/current already/);
      const back = runProgram(w.stable, ["update", "--rollback", "--yes"]);
      expect(back.status, back.stdout + back.stderr).toBe(0);
      expect(currentVersion(w.root, process.platform)).toBe(from);
      expect(readInstallRecord(w.state)?.["previous"]).toBe(to);
      expect(data()).toEqual(before);
      const repair = runProgram(w.stable, ["update", "--repair"]);
      expect(repair.status, repair.stderr).toBe(0);
      expect(repair.stdout).toMatch(/No update was interrupted/);

      // Without a terminal and without --yes, an update that would restart a running service
      // changes nothing (exit 2); an agent's shell may not update at all (exit 5).
      await w.startService();
      const asked = runProgram(w.stable, ["update", "--from", w.archiveOf(to)]);
      expect(asked.status).toBe(2);
      expect(currentVersion(w.root, process.platform)).toBe(from);
      const agent = runProgram(w.stable, ["update", "--repair"], { CODEX_THREAD_ID: "fixture" });
      expect(agent.status).toBe(5);
      // Both versions are still there: an update never removes a version folder.
      expect(
        readdirSync(join(w.root, "versions"))
          .filter((n) => !n.startsWith("."))
          .sort(),
      ).toEqual([...w.versions].sort());
      rmSync(spaceDir, { recursive: true, force: true });
    },
    SLOW,
  );
});
