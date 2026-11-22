// The updater with real builds, a real install and real processes (A7 3.13 M6.12's Verify line):
// two versions built offline as the install scripts' tests build them (the real bundles and
// launchers, the Node that runs the tests as the runtime), both trusting a throwaway key made
// here, released and signed with it; the older one installed by its install script into a
// temporary TTASKS_HOME of this file's own; its service run through the install's stable command
// (tests/update/installed.ts). On Windows the two versions' launchers differ, so every update
// here also swaps both stable launchers (A7 3.13 M6.13).
//
//   kill      An updater child (tests/update/child.ts, the updater from source with one step armed)
//             is stopped at every journal step; then either it is killed, or the service is killed
//             and the updater goes on. Then the service starts again through the stable command,
//             and the install must be the complete old or the complete new version: current names
//             one, its folder matches its manifest, no journal or staging folder is left, the
//             Windows launchers are that version's, and the service names that version. A repair
//             killed at each of its own steps is finished by the next start; a running service
//             finishes an update whose updater died within its 10 s check. A bridge (an agent's
//             session) started before an update keeps running through it and answers after it.
//   command   `ttasks update --from`, `--rollback` and `--repair` through the installed stable
//             command, with no service running (a restart through the OS is the injected seam's,
//             exercised above with its stand-in): a second update waits for the first, and the
//             data folders are byte-identical before and after an update and after a rollback.
//
// Nothing here touches a real install, autostart place, PATH or shell profile, and every process
// it stops is one it started: the services this install's service.json names, the children.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe as suite, expect, test } from "vitest";
import { readServiceRecord } from "../../packages/service/src/install/context.ts";
import { currentVersion, readInstallRecord } from "../../packages/service/src/version/switch.ts";
import { createSpace, newId } from "../../packages/storage/src/index.ts";
import { checkedDriver } from "../../packages/testkit/src/index.ts";
import { runProgram, runsElevated, snapshot } from "../../scripts/install/test/kit.ts";
import { openInstalled, type Installed } from "./installed.ts";

/**
 * Every test here runs the installed service, which refuses an elevated token (exit 64): skipped
 * in an elevated process, where nothing of the file runs, its builds included (kit.ts).
 */
const describe = suite.skipIf(runsElevated());
/** Builds, an install script run and many service starts: a slow runner gets room. */
const SLOW = 900_000;
const ROUNDS = 2_400_000;

let w: Installed;

beforeAll(async () => {
  w = await openInstalled("update", { distinctLaunchers: true });
}, SLOW);

afterAll(async () => {
  await w.close();
}, SLOW);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The update's journal steps a kill is tested at (the launcher swap only when launchers change). */
const POINTS = [
  "locked",
  "prepared",
  "unpacked",
  "placed",
  "tested",
  "staged",
  "current",
  "switched",
  "launchers_done",
  "recorded",
  "restarted",
  "done",
] as const;

describe("[A2.3.12.6.update.kill] a kill at each journal step, of the updater or of the service, ends on the complete old or new version after the next start", () => {
  test(
    "the updater killed at each step, then the service started again",
    async () => {
      await w.ensureService();
      const outcomes: string[] = [];
      for (const point of POINTS) {
        const from = await w.expectComplete(`before ${point}`);
        const run = await w.runChild("update", {
          archive: w.archiveOf(w.other(from)),
          arm: point,
          mode: "updater",
        });
        expect(run.armed, `${point}: reached`).toBe(true);
        // The next start: the service is stopped (if the kill left it running) and started again,
        // and its start-up repair finishes or rolls back what the updater left.
        await w.stopService();
        await w.startService();
        const ended = await w.expectComplete(`updater killed at ${point}`);
        outcomes.push(`${point}: ${from === ended ? "old" : "new"}`);
      }
      // Before the switch nothing is done; from it on, the new version is complete.
      expect(outcomes).toEqual(
        POINTS.map((p) => `${p}: ${POINTS.indexOf(p) < POINTS.indexOf("current") ? "old" : "new"}`),
      );
    },
    ROUNDS,
  );

  test(
    "the service killed at each step while the updater goes on",
    async () => {
      await w.ensureService();
      for (const point of POINTS) {
        const from = await w.expectComplete(`before ${point}`);
        const run = await w.runChild("update", {
          archive: w.archiveOf(w.other(from)),
          arm: point,
          mode: "service",
        });
        expect(run.armed, `${point}: reached`).toBe(true);
        await w.ensureService();
        const ended = await w.expectComplete(`service killed at ${point}`);
        // The updater lived and finished, bringing back the service it found running; except when
        // the service it had just restarted on the new version died before its handshake: then it
        // waited its 30 s and rolled back (A2 3.12.6 step 13). A supervisor would have restarted it.
        expect(ended, `${point}: ${JSON.stringify(run.lines.at(-1))}`).toBe(
          point === "restarted" ? from : w.other(from),
        );
      }
    },
    ROUNDS,
  );

  test(
    "a repair killed at each of its steps is finished by the next start; a running service finishes an update whose updater died",
    async () => {
      await w.ensureService();
      for (const point of [
        "repair:decided",
        "repair:current",
        "repair:launchers",
        "repair:record",
      ]) {
        const from = await w.expectComplete(`before ${point}`);
        // An update cut off after its switch, with no service to repair it...
        await w.stopService();
        await w.runChild("update", {
          archive: w.archiveOf(w.other(from)),
          arm: "switched",
          mode: "updater",
        });
        // ...a repair killed at `point`...
        const run = await w.runChild("repair", { arm: point, mode: "updater" });
        expect(run.armed, `${point}: reached`).toBe(true);
        // ...and the next start.
        await w.startService();
        expect(await w.expectComplete(`repair killed at ${point}`)).toBe(w.other(from));
      }
      // The updater dies after the switch while the old service runs: within its 10 s check the
      // service finishes the update, then exits 75 for its manager to start the new version.
      const from = await w.expectComplete("before the running service's repair");
      const before = readServiceRecord(w.state)?.pid ?? 0;
      await w.runChild("update", {
        archive: w.archiveOf(w.other(from)),
        arm: "switched",
        mode: "updater",
      });
      await w.waitGone(before, 30_000);
      expect(existsSync(join(w.state, "update.json"))).toBe(false);
      expect(currentVersion(w.root, process.platform)).toBe(w.other(from));
      const log = readFileSync(join(w.state, "logs", "service.log"), "utf8");
      expect(log).toMatch(/"update\.repaired"/);
      await w.startService();
      expect(await w.expectComplete("after the running service's repair")).toBe(w.other(from));
    },
    ROUNDS,
  );

  test(
    "a session's bridge started before an update keeps running through the restart and answers after it",
    async () => {
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
