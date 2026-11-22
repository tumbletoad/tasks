// The fixed values of `ttasks-local/1` (A2 3.6, docs/protocol/ttasks-local-1.md). They are wire
// constants: a native forwarder hard-codes the same values, so a product rename does not change
// them. Every bound the protocol applies is named here.

/** The protocol this build speaks (A2 3.6.6). An integer that changes only for incompatible changes. */
export const PROTOCOL = 1;

/** The modes a hello may name (A2 3.6.4). */
export const MODES = ["rpc", "mcp"] as const;
export type Mode = (typeof MODES)[number];

/** `client.kind` values of the bind frame (A2 3.6.3). */
export const CLIENT_KINDS = ["cli", "bridge", "shim", "forwarder"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** `ipc.key` holds 32 random bytes as base64url (A2 3.2.3). */
export const KEY_BYTES = 32;

/** `Ns` and `Nc`: 32 random bytes, base64url (A2 3.6.3). */
export const NONCE_BYTES = 32;

/** The longest line either side accepts once the handshake is done (A2 3.6.2). */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * The most a service reads from a peer before the peer's proof verifies, and the longest
 * challenge or proof line a client reads before the service's proof verifies. A valid hello is
 * about 170 bytes.
 */
export const HELLO_MAX_BYTES = 1024;

/** The longest bind frame a service accepts. It carries the context, `mcp_init` included. */
export const BIND_MAX_BYTES = 1024 * 1024;

/**
 * rpc requests a connection may have in flight (A2 3.6.4). The service refuses a request beyond
 * it at once and keeps reading, so `$/cancel` always arrives. The client sends no more than this
 * and queues the rest. A cancelled request counts until the service answers it.
 */
export const MAX_IN_FLIGHT = 64;

/** The deepest nesting accepted in a value that canonical JSON covers (bind frame and result). */
export const MAX_JSON_DEPTH = 64;

/** The most protocol versions a challenge may list. The service lists two at most (A2 3.6.6). */
export const MAX_PROTOCOLS = 8;

/** The longest instance ID a challenge may carry. */
export const MAX_INSTANCE_LENGTH = 128;

/**
 * The longest Unix socket path, in bytes. `sun_path` holds 108 bytes on Linux and 104 on macOS,
 * and a longer path fails or is cut, so both sides refuse one before they try.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/** Default time from the connect call to the connection, client side. */
export const CONNECT_TIMEOUT_MS = 5_000;

/** Default time to complete a handshake: client from connect to a verified bind result, service
 * from accept to a verified bind frame. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** A wrong proof or bind closes the connection after this fixed delay (A2 3.6.3). */
export const REFUSAL_DELAY_MS = 200;

/**
 * The service's output deadline. While output waits for a peer, the socket must take some of it
 * within this time, or the peer is treated as not reading and the connection closes. The clock
 * runs only while output waits and starts again whenever the socket takes bytes, so a slow but
 * steady reader of a large burst is never closed by it.
 */
export const OUTPUT_STALL_MS = 30_000;

/** Handshake method names (A2 3.6.3) and rpc mode's cancellation (A2 3.6.2). */
export const METHOD = {
  challenge: "ttasks/challenge",
  hello: "ttasks/hello",
  bind: "ttasks/bind",
  cancel: "$/cancel",
} as const;

/** The fixed JSON-RPC IDs of the hello and the bind. */
export const HELLO_ID = 0;
export const BIND_ID = 1;

/** JSON-RPC error codes the protocol uses. TTasks errors travel as `app` with A3's body in `data`. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  app: -32000,
  cancelled: -32800,
} as const;

/** The error message of a line over the limit, sent once before the service closes (A2 3.6.2). */
export const FRAME_TOO_LARGE = "frame_too_large";

/**
 * Environment names that make the service classify a CLI connection as `cli-agent` (A2 3.6.5).
 * A3 maintains the list. `CODEX_SANDBOX` is a prefix: every name that starts with it counts.
 */
export const AGENT_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "T3CODE_THREAD_ID",
  "TTASKS_TICKET",
  "TTASKS_TASK",
] as const;
export const AGENT_MARKER_PREFIX = "CODEX_SANDBOX";

/** Whether an environment name is an agent marker. */
export function isAgentMarker(name: string): boolean {
  return (
    (AGENT_MARKERS as readonly string[]).includes(name) || name.startsWith(AGENT_MARKER_PREFIX)
  );
}

/** The environment names an rpc client copies into its bind context: the markers and the space. */
export function isContextEnvName(name: string): boolean {
  return isAgentMarker(name) || name === "TTASKS_SPACE";
}

/**
 * The environment names a bridge copies into an mcp mode bind context, and no others (A2 3.6.4,
 * A3 3.7.2): the native session IDs, A4's ticket and A4's two hints. A3 maintains the list.
 */
export const MCP_CONTEXT_ENV = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "T3CODE_THREAD_ID",
  "TTASKS_TICKET",
  "TTASKS_TASK",
  "TTASKS_SPACE",
] as const;
