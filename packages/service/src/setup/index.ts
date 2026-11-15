// @tasks/service/setup: `tasks setup agents` (A3 3.12, 3.13; M2.14, M4.04, M4.05). The CLI runs it in the
// person's session, with the person's environment, and keeps the agent-home rows through the
// service. Doctor's agent checks (A3 3.14) read through the same functions.
export * from "./agents.ts";
export * from "./block.ts";
export { unifiedDiff } from "./diff.ts";
export {
  claudeDesktopFolders,
  codexAppEngines,
  hasT3,
  t3Folder,
  t3SettingsFile,
  type T3Home,
} from "./hosts.ts";
export { addEntry, removeEntry, type JsonEdit } from "./json-edit.ts";
export { parseStrictJson, type StrictJson } from "./json.ts";
export {
  GIT_MS,
  gitEnv,
  gitOnPath,
  listedAsManaged,
  trackedByAnotherRepository,
  type GitAsk,
} from "./managed.ts";
export * from "./print.ts";
export * from "./run.ts";
export * from "./state.ts";
