// Launching in the service (A4 3.6.3, 3.9): the launch machines of the open spaces, the shim's rpc
// methods and the shim host's checks, the terminal adapters and the agent's environment (M2.09),
// and Open and Copy for a task (`launch.open`): the routes, the brief and the opener (M2.10).
export {
  CHECK_MS,
  defaultShimCommand,
  LaunchService,
  type BusyLaunch,
  type LaunchInstance,
  type LaunchOptions,
  type LaunchServiceOptions,
  type RunFolderFound,
  type TerminalSeams,
  type TerminalStart,
  type TerminalView,
} from "./service.ts";
export {
  LaunchFolderUnavailable,
  LaunchFolderUnmarked,
  LaunchUnavailable,
  UNAVAILABLE_REASONS,
  type LaunchTask,
  type OpenTaskRequest,
  type OpenTaskResult,
  type UnavailableReason,
} from "./open.ts";
