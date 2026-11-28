// The stable launchers through an interrupted update, with real builds: a crash
// between the rename and the copy of ttasks.exe and of ttasksw.exe, and the next start
// repairs to a complete version. Windows only: on Linux and macOS the stable command is a link
// to `current/bin/ttasks` that no update replaces, and a journal lists no launcher.
//
// The run's two versions, the second one's launchers made to differ from the first's
// (tests/update/installed.ts), so an update swaps both. One file per stable launcher
// (launchers-*.test.ts), each with its own install, so the two run side by side. Each round:
//   1. the install is one complete version, its service runs under the supervisor (bin\ttasksw.exe,
//      started as the Run value starts it) and an agent's bridge runs from bin\ttasks.exe, so both
//      stable launchers run and Windows refuses to replace either: each swap takes two renames;
//   2. the updater child goes to the other version and stops at one step of one launcher: its copy
//      staged (`staged`), the old one renamed aside with the new one not yet renamed in (`aside`,
//      the stable path missing), or the new one renamed in (`placed`); there the bridge and the
//      service are stopped (so no running service repairs it first), and the updater is killed;
//   3. the next start goes through the stable command (`ttasks.exe serve`) or through the
//      supervisor (`ttasksw.exe`), whichever the round names. When that one is the launcher the
//      kill left missing, it cannot start: the other one runs first, for an ordinary command, and
//      its sibling repair puts it back from the version current names (launcher.c);
//   4. the install must be one complete version: current names it, its folder matches its manifest,
//      both stable launchers are that version's, no journal, staged copy or staging folder is left,
//      the service runs it and the stable command runs. Before the switch that is the old version,
//      from it on the new one. A supervisor that started from the old ttasksw.exe hands over to the
//      new one.
// The candidate's self-test runs in installed*.test.ts; here a stand-in passes it.
//
// Nothing here touches a real install, autostart place, PATH or shell profile, and every process
// it stops is one it started or one this install's service.json names.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { readJournal } from "../../packages/service/src/version/journal.ts";
import { currentVersion } from "../../packages/service/src/version/switch.ts";
import { runProgram, runsElevated } from "../../scripts/install/test/kit.ts";
import { installedForFile, windows, type Installed } from "./installed.ts";

const ROUNDS = 2_400_000;

export const CONSOLE = `${PRODUCT_ID}.exe`;
export const GUI = `${PRODUCT_ID}w.exe`;
const LAUNCHERS = [CONSOLE, GUI] as const;
const POINTS = ["staged", "aside", "placed"] as const;
const ENTRIES = ["stable command", "supervisor"] as const;

/** The rounds of the stable launcher `name`, as one test of a file of their own. */
export function launcherRounds(name: (typeof LAUNCHERS)[number]): void {
  // Its service refuses an elevated token (exit 64): skipped in an elevated process (kit.ts).
  const runs = windows && !runsElevated();
  const install = installedForFile("launchers", { distinctLaunchers: true, skip: !runs });
  describe.runIf(runs)(
    "[A2.3.12.6.update.launchers] an updater killed between the renames and the copy of each stable launcher: the next start repairs to a complete version",
    () => {
      let w: Installed;
      const bin = (name: string) => join(w.root, "bin", name);
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const ended = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
      const waitEnded = async (child: ChildProcess, label: string) => {
        const end = Date.now() + 60_000;
        while (!ended(child)) {
          if (Date.now() > end) throw new Error(`${label} did not end`);
          await pause(50);
        }
      };

      /** An agent's MCP bridge from the stable command: bin\ttasks.exe runs while it lives. */
      const startBridge = (): ChildProcess => {
        const bridge = spawn(w.stable, ["mcp"], {
          env: w.env(),
          stdio: ["pipe", "ignore", "ignore"],
          windowsHide: true,
        });
        w.started.push(bridge);
        return bridge;
      };

      /** Stops the bridge and the service; a supervisor ends with its service's exit 0. */
      const stopAll = async (bridge: ChildProcess | undefined, label: string) => {
        if (bridge !== undefined && !ended(bridge)) {
          bridge.kill("SIGKILL");
          await waitEnded(bridge, `${label}: the bridge`);
        }
        await w.stopService();
      };

      /**
       * The next start through `entry`. When the kill left that launcher missing it cannot start:
       * then the other one runs first, for an ordinary command (`version`), and puts it back from the
       * version current names (its sibling repair, before the service or any repair of Node's has
       * run). Returns the supervisor's process when the start went through the supervisor.
       */
      const nextStart = async (
        entry: (typeof ENTRIES)[number],
        label: string,
      ): Promise<ChildProcess | undefined> => {
        const name = entry === "supervisor" ? GUI : CONSOLE;
        const sibling = name === CONSOLE ? GUI : CONSOLE;
        expect(existsSync(bin(name)) || existsSync(bin(sibling)), `${label}: both missing`).toBe(
          true,
        );
        if (!existsSync(bin(name))) {
          const current = currentVersion(w.root, process.platform) ?? "";
          const ran = runProgram(bin(sibling), ["version"]);
          expect(ran.status, `${label}: ${sibling} version`).toBe(0);
          expect(ran.stderr, `${label}: the sibling repair says so`).toMatch(
            new RegExp(`put .*${name.replace(".", "\\.")} back from versions`),
          );
          expect(
            readFileSync(bin(name)).equals(
              readFileSync(join(w.root, "versions", current, "bin", name)),
            ),
            `${label}: ${name} put back as ${current}'s`,
          ).toBe(true);
        }
        if (entry === "supervisor") return await w.startSupervisor();
        await w.startService();
        return undefined;
      };

      test(
        `${name} killed staged, renamed aside and renamed in, then started again through the stable command and through the supervisor`,
        async () => {
          w = install();
          const outcomes: string[] = [];
          let from = await w.ensureService();
          await w.stopService();
          for (const point of POINTS) {
            for (const entry of ENTRIES) {
              const label = `${point}:${name}, next start through the ${entry}`;
              // 1. Both stable launchers run: the service under the supervisor, and a bridge.
              const supervisor = await w.startSupervisor();
              const bridge = startBridge();
              expect(await w.expectComplete(`before ${label}`)).toBe(from);
              const to = w.other(from);
              // 2. The updater stops at the step; everything else stops; the updater is killed.
              let atKill = "";
              const run = await w.runChild("update", {
                archive: w.archiveOf(to),
                arm: `${point}:${name}`,
                mode: "updater",
                selfTest: "pass",
                whileHeld: async () => {
                  await stopAll(bridge, label);
                  await waitEnded(supervisor, `${label}: the supervisor`);
                  atKill = [
                    currentVersion(w.root, process.platform),
                    ...LAUNCHERS.map((n) => (existsSync(bin(n)) ? n : `no ${n}`)),
                    ...LAUNCHERS.filter((n) => existsSync(`${bin(n)}.new`)).map((n) => `${n}.new`),
                  ].join(" ");
                },
              });
              expect(run.armed, `${label}: reached`).toBe(true);
              expect(readJournal(w.state).kind, `${label}: a journal is left`).toBe("journal");
              // The kill left exactly the state of its step.
              const expected: Record<(typeof POINTS)[number], string> = {
                staged:
                  name === CONSOLE
                    ? `${from} ${CONSOLE} ${GUI} ${CONSOLE}.new`
                    : `${from} ${CONSOLE} ${GUI} ${CONSOLE}.new ${GUI}.new`,
                aside:
                  name === CONSOLE
                    ? `${to} no ${CONSOLE} ${GUI} ${CONSOLE}.new ${GUI}.new`
                    : `${to} ${CONSOLE} no ${GUI} ${GUI}.new`,
                placed:
                  name === CONSOLE
                    ? `${to} ${CONSOLE} ${GUI} ${GUI}.new`
                    : `${to} ${CONSOLE} ${GUI}`,
              };
              expect(atKill, `${label}: the state at the kill`).toBe(expected[point]);
              // 3. The next start.
              const next = await nextStart(entry, label);
              // 4. One complete version: the old one before the switch, the new one from it on.
              const now = await w.expectComplete(label);
              expect(now, label).toBe(point === "staged" ? from : to);
              expect(readFileSync(join(w.root, "current"), "utf8"), `${label}: current`).toBe(now);
              outcomes.push(`${label}: ${now === from ? "old" : "new"}`);
              // A supervisor that started from the old ttasksw.exe (the update was cut off at
              // ttasks.exe's swap, after the switch) is replaced by the service's repair: it hands its
              // service over to the new one and ends. Any other keeps supervising.
              if (next !== undefined) {
                if (name === CONSOLE && point !== "staged") {
                  await waitEnded(next, `${label}: the old supervisor`);
                  expect(await w.serviceVersion(), `${label}: after the hand-over`).toBe(now);
                } else {
                  expect(ended(next), `${label}: the supervisor goes on`).toBe(false);
                }
              }
              await stopAll(undefined, label);
              if (next !== undefined) await waitEnded(next, `${label}: the supervisor`);
              from = now;
            }
          }
          expect(outcomes).toHaveLength(POINTS.length * ENTRIES.length);
        },
        ROUNDS,
      );
    },
  );
}
