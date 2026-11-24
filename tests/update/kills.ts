// The updater's kill rounds with real builds (A7 3.13 M6.12's Verify line), one file per mode and
// side of the switch so the rounds run side by side: installed-kill-*.test.ts. An updater child
// (child.ts, the updater from source with one step armed) is stopped at a journal step; then either
// it is killed, or the service is killed and the updater goes on. Then the service starts again
// through the stable command, and the install must be the complete old or the complete new
// version: current names one, its folder matches its manifest, no journal or staging folder is
// left, the Windows launchers are that version's, and the service names that version. Then the
// update is run again, as a person runs it after a cut: it ends on the new version, and the
// version the round started from is still the one --rollback goes back to. On Windows
// the two versions' launchers differ, so every update here also swaps both stable launchers (A7
// 3.13 M6.13). Each file has its own install (installed.ts); every round reads the version it
// starts from.
import { describe as suite, expect, test } from "vitest";
import { readInstallRecord } from "../../packages/service/src/version/switch.ts";
import { runsElevated } from "../../scripts/install/test/kit.ts";
import { installedForFile } from "./installed.ts";

const ROUNDS = 2_400_000;

/** The update's journal steps a kill is tested at (the launcher swap only when launchers change). */
export const POINTS = [
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
type Point = (typeof POINTS)[number];

/** The steps before the switch, where nothing is done yet, and from it on. */
export const BEFORE_SWITCH = POINTS.slice(0, POINTS.indexOf("current"));
export const FROM_SWITCH = POINTS.slice(POINTS.indexOf("current"));

/**
 * At 'restarted' the service the updater just restarted on the new version is killed, so it
 * never comes back and the updater rolls back once this wait runs out: it cannot succeed, and its
 * length is not what the round proves (the product's 30 s is configuration).
 */
const RESTART_WAIT_MS = 5_000;

/**
 * The rounds of `mode` at `points`, as one test of a file of their own. From 'tested' on the
 * candidate's self-test has passed before the armed step, so a stand-in passes it. The real one
 * runs where the updater goes on past an earlier kill (the service-killed rounds before
 * 'tested'), in installed.test.ts's bridge and command tests, in installed-repair.test.ts, and in
 * every install. An updater killed before 'tested' never reaches it.
 */
export function killRounds(mode: "updater" | "service", points: readonly Point[]): void {
  // The installed service refuses an elevated token (exit 64): skipped in an elevated process,
  // where nothing of the file runs, its install included (kit.ts).
  const elevated = runsElevated();
  const install = installedForFile(`kill-${mode}`, { distinctLaunchers: true, skip: elevated });
  const side = points[0] === "current" ? "from the switch on" : "before the switch";
  suite.skipIf(elevated)(
    "[A2.3.12.6.update.kill] a kill at each journal step, of the updater or of the service, ends on the complete old or new version after the next start",
    () => {
      test(
        mode === "updater"
          ? `the updater killed at each step ${side}, then the service started again`
          : `the service killed at each step ${side} while the updater goes on`,
        async () => {
          const w = install();
          await w.ensureService();
          for (const point of points) {
            const from = await w.expectComplete(`before ${point}`);
            const run = await w.runChild("update", {
              archive: w.archiveOf(w.other(from)),
              arm: point,
              mode,
              ...(POINTS.indexOf(point) >= POINTS.indexOf("tested")
                ? { selfTest: "pass" as const }
                : {}),
              ...(point === "restarted" ? { restartWaitMs: RESTART_WAIT_MS } : {}),
            });
            expect(run.armed, `${point}: reached`).toBe(true);
            let ended: string;
            if (mode === "updater") {
              // The next start: the service is stopped (if the kill left it running) and started
              // again, and its start-up repair finishes or rolls back what the updater left.
              await w.stopService();
              await w.startService();
              ended = await w.expectComplete(`updater killed at ${point}`);
              // Before the switch nothing is done; from it on, the new version is complete.
              const switched = POINTS.indexOf(point) >= POINTS.indexOf("current");
              expect(ended, point).toBe(switched ? w.other(from) : from);
            } else {
              await w.ensureService();
              ended = await w.expectComplete(`service killed at ${point}`);
              // The updater lived and finished, bringing back the service it found running;
              // except when the service it had just restarted on the new version died before its
              // handshake: then it rolled back (A2 3.12.6 step 13). A supervisor would have
              // restarted it.
              expect(ended, `${point}: ${JSON.stringify(run.lines.at(-1))}`).toBe(
                point === "restarted" ? from : w.other(from),
              );
            }
            const again = await w.runChild("update", {
              archive: w.archiveOf(w.other(from)),
              selfTest: "pass",
            });
            expect(again.lines.at(-1), `${point}: run again`).toMatchObject({
              done: expect.stringMatching(/^(updated|current)$/) as unknown,
            });
            expect(await w.expectComplete(`${point}: run again`)).toBe(w.other(from));
            expect(readInstallRecord(w.state)?.["previous"], `${point}: the way back`).toBe(from);
          }
        },
        ROUNDS,
      );
    },
  );
}
