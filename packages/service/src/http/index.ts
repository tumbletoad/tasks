// HTTP and WebSocket for the browser UI (A2 3.8, 3.9; A7 3.9 M2.12): `@ttasks/service/http`.
export {
  agentLabel,
  BUILD_HEADER,
  HttpApp,
  SPACE_HEADER,
  WELL_KNOWN,
  type AppGrants,
  type AppOptions,
  type UiDefaultSpace,
} from "./app.ts";
export {
  CODE_MS,
  OneTimeSecrets,
  PROBE_PER_MINUTE,
  probeProof,
  RateLimit,
  REDEEM_PER_MINUTE,
  TICKET_MS,
  verifyProbe,
} from "./auth.ts";
export {
  checkRequest,
  hostsOf,
  originsOf,
  PROBE_PATH,
  REDEEM_PATH,
  SPACE_PREFIX,
  WS_PATH,
  WS_TICKET_PATH,
  type RequestFacts,
  type RouteTable,
  type Verdict,
} from "./checks.ts";
export { contentSecurityPolicy, newNonce, securityHeaders } from "./csp.ts";
export {
  ENTRY_NAMES,
  HTTP_CLASSES,
  METHODS,
  PORT_OUTCOMES,
  REFUSALS,
  ROUTES,
  WS_CLOSES,
  type HttpEvent,
  type HttpLog,
} from "./events.ts";
export {
  ALL_VISIBLE,
  BATCH_COMMITS,
  readBatch,
  readSnapshot,
  type BatchMessage,
  type Cursor,
  type FeedEvent,
  type SnapshotMessage,
  type Visibility,
} from "./feed.ts";
export { DurableGrants, UI_TOKEN, UI_TOKEN_PREFIX, uiExpiry } from "./grants.ts";
export {
  HolderCheckFailed,
  linuxForeignHolders,
  linuxPeerUid,
  macForeignHolders,
  macPeerIsMine,
  parseLsof,
  parseNetstat,
  parseProcNetTcp,
  windowsForeignHolders,
  type ForeignHolder,
  type HolderCheck,
  type PeerCheck,
  type RedeemCheck,
} from "./holders.ts";
export { DEFAULT_HTTP_LIMITS, type HttpLimits } from "./limits.ts";
export { HTTP_HOST, listenHttp, type HttpListener } from "./listener.ts";
export {
  checkInstances,
  UiLaunches,
  type UiInstance,
  type UiLaunchPort,
  type UiReceipt,
} from "./launches.ts";
export {
  BUILD_PLACEHOLDER,
  builtinUi,
  indexProblems,
  integrity,
  loadUiFolder,
  NONCE_PLACEHOLDER,
  TOKEN_KEY,
  UiFolderInvalid,
  type UiBundle,
} from "./page.ts";
export { choosePort, PORT_RANGE, PORT_RETRY_MS, retryPort, type PortChoice } from "./port.ts";
export { NewerServiceDb, SERVICE_DB, ServiceDb, type PortObservation } from "./service-db.ts";
export { blockedMessage, movedMessage } from "./messages.ts";
export {
  openGrants,
  startHttp,
  type HttpStart,
  type HttpStatus,
  type RunningHttp,
} from "./start.ts";
export {
  HTTP_TIMER_KINDS,
  nodeHttpTimers,
  type HttpTimerKind,
  type StartHttpTimer,
} from "./timers.ts";
export { FEED_PROTOCOL, FeedHub, WS_CLOSE } from "./ws.ts";
