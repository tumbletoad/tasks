// @ttasks/testkit: fixture generators and the sample space. Private, and imported only by
// tests and scripts (the dependency rules). Fixture text only.
export { digestDatabase, digestSchema, digestSpace } from "./digest.ts";
export { FIXED_SAMPLE, FIXED_SAMPLE_0_1, RELEASED_SCHEMAS } from "./known.ts";
export { CAN_HOLD_FILES, holdFile } from "./hold.ts";
export { testEnv } from "./env.ts";
export { NO_MONITOR } from "./no-monitor.ts";
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
  FAKE_TTAM,
  FakeSpawner,
  fakeTtam,
  interactiveAgentArgv,
  readJsonLines,
  TTAM_CONVERSATIONS,
  ttamAgent,
  ttamHome,
  ttamPath,
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
 * Storage's copies of the launch rules, which the launch package's tests compare with its own:
 * launch code never imports storage, and the writer checks the same rules again.
 */
export {
  isLaunchRef as storageIsLaunchRef,
  LAUNCH_EDGES as STORAGE_LAUNCH_EDGES,
  LAUNCH_EVIDENCE_FIELDS as STORAGE_LAUNCH_EVIDENCE_FIELDS,
  LAUNCH_EVIDENCE_ID as STORAGE_LAUNCH_EVIDENCE_ID,
  LAUNCH_FAIL_REASONS as STORAGE_LAUNCH_FAIL_REASONS,
  LAUNCH_STATES as STORAGE_LAUNCH_STATES,
  LAUNCH_UNKNOWN_REASONS as STORAGE_LAUNCH_UNKNOWN_REASONS,
  OPEN_LAUNCH_STATES as STORAGE_OPEN_LAUNCH_STATES,
  OPEN_SETS as STORAGE_OPEN_SETS,
} from "@ttasks/storage";
/** Storage's copies of the run rules, which the launch package's tests compare with contracts'. */
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
} from "@ttasks/storage";
