// `ttasks mcp`, the bridge: a thin forwarder between an agent app's stdio and the
// service's mcp mode. Node built-ins and its own package only, so it starts fast and stays small.
export { USAGE, parseArgs, type McpArgs } from "./args.ts";
export {
  MAX_CWD,
  MAX_ENV_VALUE,
  baseContext,
  bindContext,
  contextEnv,
  type BaseContext,
} from "./context.ts";
export {
  hostFacts,
  installFolders,
  readEndpoint,
  readKey,
  type Folders,
  type HostFacts,
} from "./discovery.ts";
export {
  FLUSH_MS,
  Forwarder,
  MAX_HELD_BYTES,
  MAX_INIT_BYTES,
  MAX_PENDING,
  MAX_PENDING_BYTES,
  TIMING,
  type Dial,
  type ForwarderOptions,
  type Timing,
} from "./forwarder.ts";
export type { McpIo } from "./io.ts";
export { VERSION_META, eraOf, idKey, inspect, type Era, type Message } from "./message.ts";
export {
  BRIDGE_BUILD,
  HOME_VAR,
  INSTALL_NAME,
  KEY_FILE,
  OFFLINE_FILE,
  PACKAGE_VAR,
  PRODUCT_NAME,
  SERVICE_FILE,
} from "./names.ts";
export {
  BUSY_TEXT,
  INVALID_PARAMS,
  MAX_OFFLINE_BYTES,
  METHOD_NOT_FOUND,
  NO_OFFLINE_TEXT,
  SERVER_ERROR,
  TEXT_KEYS,
  TEXT_OF,
  UNSUPPORTED_VERSION,
  busyReply,
  loadOffline,
  lostReply,
  offlineReply,
  parseOffline,
  type OfflineContent,
  type TextKey,
} from "./offline.ts";
export {
  CONNECT_MS,
  EXIT_USAGE,
  MAX_DIAGNOSTIC_QUEUE,
  SOURCE_LIB,
  diagnostics,
  runMcp,
  type McpOptions,
} from "./run.ts";
export { Unavailable, unavailableOf, type OfflineReason } from "./unavailable.ts";
