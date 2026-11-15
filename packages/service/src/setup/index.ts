// @tasks/service/setup: `tasks setup agents` (A3 3.13; M2.14, M4.05). The CLI runs it in the
// person's session, with the person's environment, and keeps the agent-home rows through the
// service. Doctor's agent checks (A3 3.14) read through the same functions.
export * from "./agents.ts";
export {
  claudeDesktopFolders,
  codexAppEngines,
  codexSharedHome,
  hasT3,
  T3_AGENT_DRIVERS,
  t3Folder,
  t3Homes,
  t3ProviderInstances,
  t3SettingsFile,
  type HostsInput,
  type T3AgentDriver,
  type T3Home,
  type T3ProviderInstance,
  type T3Settings,
  type T3Skip,
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
