// A child process for the updater's tests on fixture installs (update.test.ts): on `{archive,
// facts, keys, cut}` it runs `ttasks update --from` in-process, with a stand-in self-test that
// passes and no service, and ends at once at the update step `cut` names, as a closed terminal or
// a power cut ends an update there. Exit 9 says it was cut there; any other code, that it never
// reached it. Tests only.
// First, as in the product's entries: this script ends through process.exit.
import "../../packages/bridge/src/safe-exit.ts";
import type { HostFacts } from "../../packages/service/src/hub/paths.ts";
import { updateFromArchive, type UpdatePoint } from "../../packages/service/src/version/update.ts";

interface Task {
  readonly archive: string;
  readonly facts: HostFacts;
  readonly keys: readonly string[];
  readonly cut: UpdatePoint;
}

process.once("message", (task: Task) => {
  updateFromArchive(task.archive, {
    facts: task.facts,
    keys: task.keys,
    selfTest: () => Promise.resolve({ ok: true, failed: [] }),
    seams: {
      update: (point) => {
        if (point === task.cut) process.exit(9);
      },
    },
  }).then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
