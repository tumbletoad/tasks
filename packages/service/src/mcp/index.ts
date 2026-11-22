// The MCP endpoint of the service (A3 3.3, A7 3.9 M2.02): one SDK server per bridge connection,
// both protocol eras, the generated tool list, the server instructions, compact text results
// within their budgets, and the offline file built from the same endpoint.
export {
  claimedVersion,
  LEGACY_VERSIONS,
  MODERN_VERSIONS,
  openingEra,
  unsupportedVersion,
  VERSION_META,
  type Era,
} from "./eras.ts";
export {
  bridgeCaller,
  mcpEndpoint,
  toolCaller,
  TOOL_NAMES,
  type McpEndpointOptions,
  type McpEvent,
} from "./endpoint.ts";
export {
  INSTRUCTIONS,
  MAX_INSTRUCTION_BYTES,
  START_RULE,
  START_RULE_CHARS,
} from "./instructions.ts";
export {
  offlineContent,
  offlineFileText,
  offlineTexts,
  writeOfflineCache,
  type OfflineContent,
} from "./offline.ts";
export { bridgePrincipal, clientOf, instanceOf, spaceOf } from "./principal.ts";
export { DIGEST_TOKENS, ERROR_TOKENS, hasRenderer, renderError, renderResult } from "./render.ts";
export {
  createServer,
  SERVER_INFO,
  type ToolCall,
  type ToolResult,
  type Working,
} from "./server.ts";
export {
  DATA_WORD,
  closeMarker,
  drawMarker,
  fit,
  openMarker,
  type Part,
  type Rendered,
} from "./text.ts";
export { TOOLS, toolEntry, toolOf } from "./tools.ts";
export {
  ChannelTransport,
  TRANSPORT_LIMITS,
  TRANSPORT_REASONS,
  type LineChannel,
  type TransportLimits,
  type TransportReason,
} from "./transport.ts";
