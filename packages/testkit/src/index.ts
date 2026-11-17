// @tasks/testkit: fixture generators and the sample space (A7 3.2). Private, and imported only by
// tests and scripts (the dependency rules). Fixture text only.
export { digestDatabase, digestSchema, digestSpace } from "./digest.ts";
export { FIXED_SAMPLE, FIXED_SAMPLE_0_1, RELEASED_SCHEMAS } from "./known.ts";
export { layoutTestInstall, type TestInstall } from "./install.ts";
export {
  checkedDriver,
  DEFAULT_SEED,
  DEFAULT_TASKS,
  MAX_TASKS,
  MIRA,
  seedMira,
  type MiraOptions,
  type SeededSpace,
} from "./mira.ts";
export { Rng } from "./rng.ts";
export {
  FAKE_AGENT,
  FAKE_CLI_AGENT,
  FAKE_CLIPBOARD,
  FAKE_SHELL,
  FAKE_SYSTEMD_RUN,
  FAKE_TERMINAL,
  FakeSpawner,
  interactiveAgentArgv,
  readJsonLines,
  type FakeSpawnerOptions,
  type FakeSpawnRequest,
  type CliAgentReport,
  type InteractiveAgentReport,
  type SpawnRecord,
} from "./fakes/index.ts";
export {
  createLaunchSpace,
  LAUNCH_MACHINE,
  openLaunchSpace,
  openLaunchSpaceAt,
  openLaunchSpaceInWorker,
  type LaunchSpace,
  type LaunchSpaceFolder,
  type WorkerLaunchSpace,
} from "./launch-space.ts";
/**
 * Storage's copies of A4's launch rules, which the launch package's tests compare with its own:
 * launch code never imports storage (A7 3.2), and the writer checks the same rules again.
 */
export {
  FOCUS_MS as STORAGE_FOCUS_MS,
  isLaunchRef as storageIsLaunchRef,
  LAUNCH_EDGES as STORAGE_LAUNCH_EDGES,
  LAUNCH_EVIDENCE_FIELDS as STORAGE_LAUNCH_EVIDENCE_FIELDS,
  LAUNCH_EVIDENCE_ID as STORAGE_LAUNCH_EVIDENCE_ID,
  LAUNCH_FAIL_REASONS as STORAGE_LAUNCH_FAIL_REASONS,
  LAUNCH_STATES as STORAGE_LAUNCH_STATES,
  LAUNCH_UNKNOWN_REASONS as STORAGE_LAUNCH_UNKNOWN_REASONS,
  OPEN_LAUNCH_STATES as STORAGE_OPEN_LAUNCH_STATES,
  OPEN_SETS as STORAGE_OPEN_SETS,
  REFERENCE_WINDOW_MS as STORAGE_REFERENCE_WINDOW_MS,
} from "@tasks/storage";
/** Storage's copies of A4's run rules, which the launch package's tests compare with contracts'. */
export {
  normaliseStored as storageNormaliseText,
  FINAL_RUN_STATES as STORAGE_FINAL_RUN_STATES,
  OPEN_RUN_STATES as STORAGE_OPEN_RUN_STATES,
  RUN_APP_TOOLS as STORAGE_RUN_APP_TOOLS,
  RUN_EDGES as STORAGE_RUN_EDGES,
  RUN_EVIDENCE_FIELDS as STORAGE_RUN_EVIDENCE_FIELDS,
  RUN_EVIDENCE_ID as STORAGE_RUN_EVIDENCE_ID,
  RUN_LIMIT_BOUNDS as STORAGE_RUN_LIMIT_BOUNDS,
  RUN_OUTCOMES as STORAGE_RUN_OUTCOMES,
  RUN_PERMISSIONS as STORAGE_RUN_PERMISSIONS,
  RUN_REASONS as STORAGE_RUN_REASONS,
  RUN_REQUEST_MAX_BYTES as STORAGE_RUN_REQUEST_MAX_BYTES,
  RUN_STATES as STORAGE_RUN_STATES,
  RUN_RESULT_TEXT_MAX_BYTES as STORAGE_RUN_RESULT_TEXT_MAX_BYTES,
  RUN_TEXT_MAX_BYTES as STORAGE_RUN_TEXT_MAX_BYTES,
} from "@tasks/storage";
