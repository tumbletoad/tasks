// A child process for the install tests that are cut off: on `{versionFolder, facts, cut}` it runs
// the switch of `ttasks install --finish` (finishInstall) and ends at once at the step `cut` names,
// as a closed terminal or a power cut ends an install there: `switch` once current and the
// stable command changed, or a number, after that many launchers were put in place. Tests only.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "@ttasks/bridge/safe-exit";
import type { HostFacts } from "../src/hub/paths.ts";
import { finishInstall } from "../src/version/install.ts";

/** The exit code of a cut, which the tests expect: no install ends with it. */
const CUT_EXIT = 9;

interface Task {
  readonly versionFolder: string;
  readonly facts: HostFacts;
  readonly cut: "switch" | number;
}

process.once("message", (task: Task) => {
  const cut = (): never => process.exit(CUT_EXIT);
  let placed = 0;
  finishInstall({
    versionFolder: task.versionFolder,
    facts: task.facts,
    ...(task.cut === "switch"
      ? { afterSwitch: cut }
      : {
          afterStep: () => {
            placed += 1;
            if (placed === task.cut) cut();
          },
        }),
  }).then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
