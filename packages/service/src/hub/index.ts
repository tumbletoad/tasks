// The service hub (A2 3.1 to 3.4, 3.13): `tasks serve`, its folders and install ID, its locks,
// service.json, exit codes, refusals, log and crash files. The local protocol is `./local` (M1.09)
// and plugs in at endpoint.ts, whose handler table is where rpc methods are registered.
export { EXIT, REFUSALS, ServiceExit, type ExitCode, type Refusal } from "./exit.ts";
export {
  canonicalStatePath,
  hostFacts,
  INSTALL_ID_LENGTH,
  installId,
  isInstallId,
  TASKS_HOME,
  LayoutError,
  MAX_SOCKET_PATH_BYTES,
  pipeName,
  resolveLayout,
  RUN_USER_BASE,
  runtimeNames,
  SOCKET_FILE,
  type HostFacts,
  type Layout,
  type PipeEndpointPlan,
  type RuntimeNames,
  type UnixEndpointPlan,
} from "./paths.ts";
export {
  detectIdentity,
  integrityLevel,
  INTEGRITY,
  TASKS_PACKAGE,
  packageIdentity,
  type Identity,
} from "./identity.ts";
export {
  EVENTS,
  LOG_FILE,
  LOG_FILES_KEPT,
  LOG_MAX_BYTES,
  Logger,
  MANAGERS,
  SPACE_REASONS,
  type EventFields,
  type EventName,
  type Level,
} from "./log.ts";
export {
  crashRecord,
  errorCode,
  errorType,
  refusalRecord,
  sanitizeStack,
  writeCrashFile,
} from "./crash.ts";
export {
  acquireLock,
  LockBusy,
  OWNERSHIP_CHECK_MS,
  watchOwnership,
  type HeldLock,
} from "./lock.ts";
export { decodeKey, KEY_BYTES, KEY_FILE, loadOrCreateKey } from "./key.ts";
export { MACHINE_FILE, loadOrCreateMachine, MachineFileInvalid } from "./machine.ts";
export {
  handlerTable,
  listenEndpoint,
  logLocal,
  PROTOCOLS,
  type EndpointHub,
  type EndpointOptions,
  type EndpointServer,
  type ListenEndpoint,
  type ServiceStatus,
  type SpaceSummary,
} from "./endpoint.ts";
export {
  readHolder,
  SpaceManager,
  WRITER_FILE,
  WRITER_LOCK,
  type SpaceEntry,
  type SpaceView,
  type WriterHolder,
} from "./spaces.ts";
export {
  BUILD,
  DRAIN_MS,
  TASKS_SERVICE_MANAGER,
  SERVICE_FILE,
  SERVICE_LOCK,
  startService,
  type RunningService,
  type StartOptions,
} from "./service.ts";
export { runServe } from "./serve.ts";
