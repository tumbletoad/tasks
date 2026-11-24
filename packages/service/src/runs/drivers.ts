// Which instances a background run can drive, and the adapter each gets: read by the runs and by
// the launch service's tiles, so it imports neither.
import type { RunAdapterId } from "@ttasks/contracts/runs";
import type { Instance } from "@ttasks/launch";

/** The targets a run can drive, and the adapter, which names the driver, each gets. */
const DRIVERS: Readonly<Record<string, RunAdapterId>> = {
  "codex-cli": "codex",
  "claude-cli": "claude-print",
};

/** Whether an instance can run tasks in the background. */
export const runsWith = (instance: Instance): boolean =>
  instance.enabled && Object.hasOwn(DRIVERS, instance.target) && instance.exec !== undefined;

/** The adapter a run of `instance` records: which program's protocol its driver speaks. */
export const runAdapter = (instance: Instance): RunAdapterId => DRIVERS[instance.target] ?? "codex";
